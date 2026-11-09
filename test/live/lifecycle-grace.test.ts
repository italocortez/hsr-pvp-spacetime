/**
 * Live residue (T-S10, ACCESS-SECURITY-OPS §D.5): the A22a grace period and the A68 away rule driven by the real
 * lifecycle hooks over the wire. The in-memory suites (s4-referee-transfer, s8f-membership) call
 * client_connected / client_disconnected and run_referee_transfer_check by hand; here the WebSocket closes, the
 * engine fires the hook, and the scheduler fires the 15 s RefereeTransferCheck on its own.
 *
 * Setup per test: two fresh verified users (test/shared/two-identity-harness.ts); A creates a casual 1v1 lobby
 * (host, referee, Blue), B joins Red, A starts the draft (Drafting, disconnect policy Standard). Everything is
 * read through B's or A's `view_my_lobby_members` (`presence`, `isReferee`, `isHost`).
 *
 * Disconnect detection on maincloud can lag (test/README "Maincloud disconnect detection delay"), so each test waits
 * for the hook's visible effect (the member turns Offline) instead of sleeping a fixed time, and measures the grace
 * from there.
 *
 * Estimated runtime: ~35 s per test (two verified harnesses ~6 s, setup ~3 s, grace waits 17–20 s), ~2 min total;
 * up to ~3.5 min if maincloud detects the drop late (60 s ceiling per detection).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { queryPrivateTable } from '../shared/connection';
import { createTwoVerifiedHarnesses, disconnectBoth, hasServerToken, type TwoIdentities } from '../shared/two-identity-harness';
import { type LiveConn, closeAll, memberAs, openConnection, setupOneVsOne, sleep, waitFor } from './_helpers';

const GRACE_MS = 15_000;
const DETECT_MS = 60_000;

describe('A22a / A68 lifecycle over the wire (§D.5)', () => {
    const pairs: TwoIdentities[] = [];
    const reconnects: LiveConn[] = [];

    afterAll(async () => {
        closeAll(reconnects);
        for (const p of pairs) await disconnectBoth(p);
    });

    async function draftingPair() {
        const pair = await createTwoVerifiedHarnesses();
        pairs.push(pair);
        const { userA: a, userB: b } = pair;
        const lobbyId = await setupOneVsOne(a.conn, b.conn, { start: true });
        await waitFor(() => memberAs(b.conn, lobbyId, a.userId)?.isReferee, 'B sees A as the referee');
        await waitFor(() => memberAs(b.conn, lobbyId, b.userId)?.presence.tag === 'Online', 'B sees itself online');
        return { a, b, lobbyId };
    }

    it.skipIf(!hasServerToken())(
        '(a) A22a + A22(2): the referee drops and reconnects inside the 15 s window → nothing moves, flags kept, the pending check deleted',
        async () => {
            const { a, b, lobbyId } = await draftingPair();
            const token = a.conn.token;
            expect(token).toBeTruthy();

            a.conn.disconnect();
            await waitFor(
                () => memberAs(b.conn, lobbyId, a.userId)?.presence.tag === 'Offline',
                'client_disconnected marks A offline',
                DETECT_MS,
            );
            // Inside the grace: no flag has moved.
            const offline = memberAs(b.conn, lobbyId, a.userId)!;
            expect(offline.isReferee).toBe(true);
            expect(offline.isHost).toBe(true);
            expect(offline.isCaptain).toBe(true);

            // Page refresh: same token, same identity.
            const back = await openConnection({ token: token! });
            reconnects.push(back);
            await waitFor(
                () => memberAs(b.conn, lobbyId, a.userId)?.presence.tag === 'Online',
                'client_connected restores A',
                10_000,
            );
            // A22(2) refresh rule: client_connected deleted the pending check before it could fire.
            const pending = await queryPrivateTable(
                `SELECT COUNT(*) AS n FROM referee_transfer_check WHERE lobby_id = ${lobbyId}`,
            );
            expect(Number(pending[0]?.n)).toBe(0);

            // Past the original 15 s deadline: still nothing has moved.
            await sleep(GRACE_MS + 2_000);
            const kept = memberAs(b.conn, lobbyId, a.userId)!;
            expect(kept.isReferee).toBe(true);
            expect(kept.isHost).toBe(true);
            expect(kept.isCaptain).toBe(true);
            expect(memberAs(b.conn, lobbyId, b.userId)!.isReferee).toBe(false);
        },
        150_000,
    );

    it.skipIf(!hasServerToken())(
        '(b) A22a + A22(5): a drop that outlasts the grace moves the referee (and host) flag to the first online candidate; the member stays offline',
        async () => {
            const { a, b, lobbyId } = await draftingPair();

            a.conn.disconnect();
            await waitFor(
                () => memberAs(b.conn, lobbyId, a.userId)?.presence.tag === 'Offline',
                'client_disconnected marks A offline',
                DETECT_MS,
            );
            const seenOfflineAt = Date.now();
            expect(memberAs(b.conn, lobbyId, a.userId)!.isReferee).toBe(true);

            // A22(5) order: host (A, offline) → Blue players (A) → Red players: B.
            await waitFor(
                () => memberAs(b.conn, lobbyId, b.userId)?.isReferee,
                'run_referee_transfer_check moves the referee flag to B',
                GRACE_MS + 15_000,
            );
            expect(Date.now() - seenOfflineAt).toBeGreaterThanOrEqual(GRACE_MS - 5_000);

            const gone = memberAs(b.conn, lobbyId, a.userId)!;
            expect(gone.isReferee).toBe(false);
            expect(gone.presence.tag).toBe('Offline');
            // D.8.2: the host flag moves with the same grace, to an online candidate.
            await waitFor(() => memberAs(b.conn, lobbyId, b.userId)?.isHost, 'host flag moves to B', 5_000);
        },
        150_000,
    );

    it.skipIf(!hasServerToken())(
        '(c) A68(1)(2): a player\'s leave_lobby during Drafting keeps the row as away, and the grace check runs for them although they stay connected',
        async () => {
            const { a, b, lobbyId } = await draftingPair();

            // B (Red) takes the referee flag, so the check's effect on B is visible (A74: by seat number).
            const seatB = memberAs(a.conn, lobbyId, b.userId)!.joinSeq;
            await a.conn.reducers.transferReferee({ lobbyId, targetJoinSeq: seatB });
            await waitFor(() => memberAs(a.conn, lobbyId, b.userId)?.isReferee, 'B is the referee');

            await b.conn.reducers.leaveLobby({ lobbyId });
            await waitFor(
                () => memberAs(a.conn, lobbyId, b.userId)?.presence.tag === 'Away',
                'leave_lobby in Drafting sets leftAt (away); the row is kept',
                10_000,
            );
            const leftAt = Date.now();
            expect(memberAs(a.conn, lobbyId, b.userId)!.isReferee).toBe(true);

            // A68(2): an away row counts as offline although B's connection is live; the check moves the flag to
            // the first online candidate, the host A.
            await waitFor(
                () => memberAs(a.conn, lobbyId, a.userId)?.isReferee,
                'run_referee_transfer_check moves the referee flag from the away B to A',
                GRACE_MS + 15_000,
            );
            expect(Date.now() - leftAt).toBeGreaterThanOrEqual(GRACE_MS - 5_000);
            const away = memberAs(a.conn, lobbyId, b.userId)!;
            expect(away.isReferee).toBe(false);
            expect(away.presence.tag).toBe('Away');
        },
        150_000,
    );
});
