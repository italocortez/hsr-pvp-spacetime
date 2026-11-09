/**
 * Live residue (T-S10, ACCESS-SECURITY-OPS §D.5): a smoke pass over the freshly published and bootstrapped test1.
 *
 *   1. Bootstrap invariants through the public reference set (the tables a real client subscribes, frontend rule §4):
 *      the default cost set (costSetId 0) has Classic and Auction rows in all three cost tables
 *      (HsrCharacterCost, HsrLightconeCost, HsrSynergyCost; old seed/round-trip D-22 / 15.4 D-14 / D-25).
 *   2. HsrCharacter rows exist and the starter achievements are seeded.
 *   3. Lobby round trip: a host creates a lobby, a second identity joins, both read the same lobby through
 *      view_my_lobby and both members, with seat numbers 1 and 2 (A74(3)), through view_my_lobby_members.
 *   4. Cursor events: a player's broadcast_cursor reaches the other member through onInsert on the
 *      lobby_cursor_event event table (frontend rule §4: cursor events are consumed via onInsert).
 *
 * Estimated runtime: ~30 s (the cost subscriptions pull the default cost set once, a few thousand rows).
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
    type LiveConn,
    type LiveUser,
    LOBBY_QUERIES,
    casualLobbyArgs,
    closeAll,
    connectGuest,
    lobbyMembers,
    openConnection,
    subscribe,
    waitFor,
} from './_helpers';

describe('Smoke: bootstrap invariants and a lobby round trip (§D.5)', () => {
    const open: Array<LiveConn | LiveUser> = [];

    afterAll(() => closeAll(open));

    it('costSetId 0 has Classic and Auction rows in hsr_character_cost, hsr_lightcone_cost and hsr_synergy_cost', async () => {
        const c = await openConnection();
        open.push(c);
        const handle = await subscribe(c.conn, [
            'SELECT * FROM hsr_character_cost WHERE cost_set_id = 0',
            'SELECT * FROM hsr_lightcone_cost WHERE cost_set_id = 0',
            'SELECT * FROM hsr_synergy_cost WHERE cost_set_id = 0',
        ], 45_000);

        const modes = (rows: Iterable<{ draftMode: { tag: string } }>) => new Set([...rows].map((r) => r.draftMode.tag));
        for (const [table, rows] of [
            ['hsr_character_cost', c.conn.db.hsrCharacterCost.iter()],
            ['hsr_lightcone_cost', c.conn.db.hsrLightconeCost.iter()],
            ['hsr_synergy_cost', c.conn.db.hsrSynergyCost.iter()],
        ] as const) {
            const tags = modes(rows);
            expect(tags.has('Classic'), `${table} has Classic rows`).toBe(true);
            expect(tags.has('Auction'), `${table} has Auction rows`).toBe(true);
        }
        handle.unsubscribe();
    }, 60_000);

    it('HsrCharacter rows exist and the starter achievements are seeded', async () => {
        const c = await openConnection();
        open.push(c);
        await subscribe(c.conn, ['SELECT * FROM hsr_character', 'SELECT * FROM achievement']);
        expect(c.conn.db.hsrCharacter.count()).toBeGreaterThan(0n);
        expect(c.conn.db.achievement.count()).toBeGreaterThan(0n);
    }, 45_000);

    it('lobby round trip: create → a second identity joins → both read the lobby and both seats through the views (A74(3))', async () => {
        const host = await connectGuest(LOBBY_QUERIES);
        const joiner = await connectGuest(LOBBY_QUERIES);
        open.push(host, joiner);

        await host.conn.reducers.createLobby(casualLobbyArgs());
        const lobbyId = await waitFor(() => [...host.conn.db.viewMyLobby.iter()][0]?.id, 'host sees its lobby');
        await joiner.conn.reducers.joinLobby({ lobbyId, joinCode: '', password: '' });

        await waitFor(() => [...joiner.conn.db.viewMyLobby.iter()].find((l) => l.id === lobbyId), 'joiner sees the lobby');
        for (const viewer of [host, joiner]) {
            const rows = await waitFor(
                () => (lobbyMembers(viewer.conn, lobbyId).length === 2 ? lobbyMembers(viewer.conn, lobbyId) : undefined),
                `${viewer === host ? 'host' : 'joiner'} sees both members`,
            );
            expect(rows.map((m) => m.joinSeq)).toEqual([1, 2]);
            expect(rows.map((m) => m.userId)).toEqual([host.userId, joiner.userId]);
            expect(rows[0].isHost).toBe(true);
            expect(rows[0].isReferee).toBe(true);
        }

        await host.conn.reducers.closeLobby({ lobbyId });
    }, 60_000);

    it('broadcast_cursor from a player reaches the other member through onInsert on lobby_cursor_event (frontend rule §4)', async () => {
        const host = await connectGuest(LOBBY_QUERIES);
        const watcher = await connectGuest(LOBBY_QUERIES);
        open.push(host, watcher);

        await host.conn.reducers.createLobby(casualLobbyArgs());
        const lobbyId = await waitFor(() => [...host.conn.db.viewMyLobby.iter()][0]?.id, 'host sees its lobby');
        // D-34: spectators do not broadcast; the host takes a player seat.
        await host.conn.reducers.setTeamSlot({ lobbyId, lobbySlot: { tag: 'BluePlayer' } });
        await watcher.conn.reducers.joinLobby({ lobbyId, joinCode: '', password: '' });

        const received: Array<{ senderUserId: number; x: number; y: number }> = [];
        watcher.conn.db.lobbyCursorEvent.onInsert((_ctx, row) => {
            if (row.lobbyId === lobbyId) received.push(row);
        });
        await subscribe(watcher.conn, [`SELECT * FROM lobby_cursor_event WHERE lobby_id = ${lobbyId}`]);

        await host.conn.reducers.broadcastCursor({ lobbyId, x: 0.25, y: 0.75 });
        const event = await waitFor(() => received[0], 'cursor event delivered to the other member', 10_000);
        expect(event.senderUserId).toBe(host.userId);
        expect(event.x).toBeCloseTo(0.25);
        expect(event.y).toBeCloseTo(0.75);

        await host.conn.reducers.closeLobby({ lobbyId });
    }, 60_000);
});
