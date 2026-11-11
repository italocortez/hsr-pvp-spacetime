// Lobby: select / deselect the match account in casual and tournament lobbies.
// Contracts: docs/lobby/contract.md
// From S10 (s10-account-selection.test.ts).
//
// T-S10 batch A1: in-memory port of test/backend/lobby/account-selection.test.ts (select / deselect_match_account and
// the LobbyMemberAccount rows join_lobby / leave_lobby write) and of the no-LMA case of
// match-results/mmr-snapshot.test.ts, plus the D-08 Ranked start gate and the per-tournament account limit (orchestrator
// ruling Q3: docs/tournament/contract.md "Account Selection Exceeds maxAccountsPerPlayer"). LobbyMemberAccount,
// HsrAccount and TournamentPlayerAccount are private: read with `test.db` outside the transactions. Selection is
// Waiting-only (D-06, A67(1)). Seats by `seatOf` (A74). In-memory datastore; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, expectReject, lobbyRow, newHarness, seatOf, setupLobby, tx, type Actor, type Harness } from '../fixtures/harness';
import { insertHsrAccount, liveField, verified } from '../fixtures/tournament-builders';
import { byKey, createTournamentLobby, join, sidesOf } from '../fixtures/tournament-match-builders';
import { createLobby, joinLobby, lmaOf, lockAccount, setActive } from '../fixtures/preset-and-account-builders';

const select = (test: Harness, who: Actor, lobbyId: number, hsrAccountId: number) =>
    tx(test, who, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId }));
const deselect = (test: Harness, who: Actor, lobbyId: number, hsrAccountId: number) =>
    tx(test, who, (ctx) => M.deselect_match_account(ctx, { lobbyId, hsrAccountId }));
const hostMoves = (test: Harness, host: Actor, lobbyId: number, who: Actor, slot: string) =>
    tx(test, host, (ctx) => M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, who.userId), lobbySlot: { tag: slot } as any }));

/** A casual Waiting lobby (teamSize 3) and a verified joiner owning `main` (active) and `alt` (inactive), already joined. */
function casualWithJoiner() {
    const test = newHarness();
    const host = verified(test, 'host');
    const joiner = verified(test, 'joiner');
    const main = insertHsrAccount(test, joiner.userId, '800100001');
    const alt = insertHsrAccount(test, joiner.userId, '800100002');
    setActive(test, alt, false);
    const lobbyId = createLobby(test, host, { teamSize: 3 });
    joinLobby(test, joiner, lobbyId);
    return { test, host, joiner, main, alt, lobbyId };
}

// ─── Casual lobbies (D-07: replace, one account) ─────────────────────────────

describe('casual lobby: select / deselect_match_account', () => {
    it('LobbyMemberAccount Auto-Created at Join: join_lobby inserts one row with the active account (D-04, D-09)', () => {
        const { test, joiner, main, lobbyId } = casualWithJoiner();
        expect(lmaOf(test, lobbyId, joiner.userId)).toEqual([main]);
    });

    it('Account Selection Non-Tournament (Replace Behavior): selecting the other account leaves exactly one row (D-07)', () => {
        const { test, host, joiner, alt, lobbyId } = casualWithJoiner();
        hostMoves(test, host, lobbyId, joiner, 'BluePlayer');
        select(test, joiner, lobbyId, alt);
        expect(lmaOf(test, lobbyId, joiner.userId)).toEqual([alt]);
    });

    it('a Spectator and a coach cannot select a match account (select_match_account guards)', () => {
        const { test, host, joiner, alt, main, lobbyId } = casualWithJoiner();
        expectReject(test, joiner, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: alt }), 'Spectators cannot select match accounts.');
        hostMoves(test, host, lobbyId, joiner, 'BlueCoach');
        expectReject(test, joiner, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: alt }), 'Coaches cannot select match accounts.');
        expect(lmaOf(test, lobbyId, joiner.userId)).toEqual([main]);
    });

    it('an account the caller does not own is rejected (D-07: ownership)', () => {
        const { test, host, joiner, main, lobbyId } = casualWithJoiner();
        hostMoves(test, host, lobbyId, joiner, 'BluePlayer');
        const foreign = insertHsrAccount(test, host.userId, '800100009');
        expectReject(test, joiner, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: foreign }), 'This is not your account.');
        expect(lmaOf(test, lobbyId, joiner.userId)).toEqual([main]);
    });

    it('deselect_match_account removes the named row; deselecting an unselected account is rejected', () => {
        const { test, joiner, main, lobbyId } = casualWithJoiner();
        deselect(test, joiner, lobbyId, main);
        expect(lmaOf(test, lobbyId, joiner.userId)).toEqual([]);
        expectReject(test, joiner, (ctx) => M.deselect_match_account(ctx, { lobbyId, hsrAccountId: main }), 'This account is not selected for this match.');
    });

    it('LobbyMemberAccount Cascade Delete at Leave: a Waiting leave deletes the user\'s rows (D-29)', () => {
        const { test, joiner, lobbyId } = casualWithJoiner();
        expect(lmaOf(test, lobbyId, joiner.userId)).toHaveLength(1);
        tx(test, joiner, (ctx) => M.leave_lobby(ctx, { lobbyId }));
        expect(lmaOf(test, lobbyId, joiner.userId)).toEqual([]);
    });

    it('selection is Waiting-only: select and deselect in Drafting are rejected and the rows stay (D-06, A67(1))', () => {
        const test = newHarness();
        const b1 = verified(test, 'b1');
        const own = insertHsrAccount(test, b1.userId, '800100011');
        const other = insertHsrAccount(test, b1.userId, '800100012');
        setActive(test, other, false);
        const s = setupLobby(test, { actors: { b1 } });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expectReject(test, b1, (ctx) => M.select_match_account(ctx, { lobbyId: s.lobbyId, hsrAccountId: other }),
            'Account selection is only allowed during the Waiting stage.');
        expectReject(test, b1, (ctx) => M.deselect_match_account(ctx, { lobbyId: s.lobbyId, hsrAccountId: own }),
            'Account deselection is only allowed during the Waiting stage.');
        expect(lmaOf(test, s.lobbyId, b1.userId)).toEqual([own]);
    });
});

// ─── start_draft: the snapshot and the Ranked gate ────────────────────────────

describe('start_draft and the selected accounts', () => {
    it('casual participants with zero LobbyMemberAccount rows get accountRatingSnapshot 0 (match-results contract, Phase 12.3 Capture)', () => {
        const test = newHarness();
        const s = setupLobby(test); // guests: no HsrAccount, so join_lobby seeds no LobbyMemberAccount row
        for (const n of ['b1', 'b2', 'r1', 'r2']) expect(lmaOf(test, s.lobbyId, s.a[n].userId)).toEqual([]);
        const record = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0];
        const participants = [...test.db.MatchResultParticipant.iter()].filter((p) => p.matchResultId === record.id);
        expect(participants).toHaveLength(4);
        for (const p of participants) expect(p.accountRatingSnapshot).toBe(0);
    });

    it('D-08: a Ranked start_draft is rejected while a player has no selected account; it starts once every player has one', () => {
        const test = newHarness();
        const actors: Record<string, Actor> = { host: verified(test, 'host') };
        for (const n of ['b1', 'b2', 'r1', 'r2']) actors[n] = verified(test, n);
        const s = setupLobby(test, { actors, lobby: { matchType: { tag: 'Ranked' } }, noStart: true });
        for (const n of ['b1', 'b2', 'r1']) select(test, s.a[n], s.lobbyId, insertHsrAccount(test, s.a[n].userId, `uid-${n}`));

        expectReject(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }),
            /has no account selected for this match\. All players must select an account before starting a ranked or MMR-counted match\./);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');

        select(test, s.a.r2, s.lobbyId, insertHsrAccount(test, s.a.r2.userId, 'uid-r2'));
        tx(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });
});

// ─── Tournament lobbies (D-05: locked accounts, additive up to the limit) ────

/**
 * A live 2-team bracket (teamSize 2) with `maxAccountsPerPlayer`; the Blue captain owns `first` (active) and `second`
 * (inactive), both locked for the tournament (TournamentPlayerAccount, written as registration would), plus `loose`
 * (owned, not locked). The organizer created the match lobby; the captain has not joined yet.
 */
function tournamentLobby(maxAccountsPerPlayer: number) {
    const f = liveField(2, { maxAccountsPerPlayer });
    const { test } = f;
    const m = byKey(test, f.id, 'W-R1-M1');
    const p = sidesOf(f, m.id).blue.captain;
    const first = insertHsrAccount(test, p.userId, '800200001');
    const second = insertHsrAccount(test, p.userId, '800200002');
    const loose = insertHsrAccount(test, p.userId, '800200099');
    setActive(test, second, false);
    setActive(test, loose, false);
    lockAccount(test, f.id, p.userId, first);
    lockAccount(test, f.id, p.userId, second);
    const lobbyId = createTournamentLobby(test, f.org, m.id);
    return { test, p, first, second, loose, lobbyId };
}

describe('tournament lobby: select_match_account', () => {
    it('LobbyMemberAccount Tournament Path at Join: the row uses the active account, which is locked (D-04)', () => {
        const { test, p, first, lobbyId } = tournamentLobby(2);
        join(test, p, lobbyId);
        expect(lmaOf(test, lobbyId, p.userId)).toEqual([first]);
    });

    it('Account Selection in Tournament Lobby: with maxAccountsPerPlayer 2 a second locked account is added, not swapped (D-05)', () => {
        const { test, p, first, second, lobbyId } = tournamentLobby(2);
        join(test, p, lobbyId);
        select(test, p, lobbyId, second);
        expect(lmaOf(test, lobbyId, p.userId)).toEqual([first, second].sort((a, b) => a - b));
    });

    it('an account not locked for the tournament is rejected (D-05)', () => {
        const { test, p, first, loose, lobbyId } = tournamentLobby(2);
        join(test, p, lobbyId);
        expectReject(test, p, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: loose }),
            'This account is not locked for this tournament. Use a registered tournament account.');
        expect(lmaOf(test, lobbyId, p.userId)).toEqual([first]);
    });

    it('selecting an already selected account is rejected (D-05)', () => {
        const { test, p, first, lobbyId } = tournamentLobby(2);
        join(test, p, lobbyId);
        expectReject(test, p, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: first }), 'This account is already selected for this match.');
        expect(lmaOf(test, lobbyId, p.userId)).toEqual([first]);
    });

    it('Account Selection Exceeds maxAccountsPerPlayer: limit 1, one row held, another locked account is rejected (D-11)', () => {
        const { test, p, first, second, lobbyId } = tournamentLobby(1);
        join(test, p, lobbyId);
        expect(lmaOf(test, lobbyId, p.userId)).toEqual([first]);
        expectReject(test, p, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: second }),
            'Maximum accounts per player reached for this tournament.');
        expect(lmaOf(test, lobbyId, p.userId)).toEqual([first]);
    });
});
