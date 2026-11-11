// Views: view_my_roster_visibility grants the referee exemption to the spectator referee only.
// Decisions: A75
// Contracts: docs/views/contract.md
// From S9c (s9c-rulings.test.ts).
import { describe, expect, it } from 'vitest';
import type { LobbyMemberViewRow, RosterVisibilityRow } from '@bindings/types';
import {
    M,
    lobbyRow,
    newHarness,
    refereeIds,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Harness,
} from '../fixtures/harness';
import { AUDIT, insertHsrAccount, verified } from '../fixtures/tournament-builders';
import { view } from '../fixtures/seat-view-readers';

// ════════════════════════════════════════════════════════════════════════════
// A75: only the spectator referee sees every roster
// ════════════════════════════════════════════════════════════════════════════

describe('A75(1): view_my_roster_visibility grants the referee exemption to the spectator referee only', () => {
    function addAccount(test: Harness, lobbyId: number, who: Actor, uid: string, rating: number, chars: string[]): number {
        const id = insertHsrAccount(test, who.userId, uid);
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(id)!, accountRating: rating, isRosterPublic: true, isRatingPublic: true });
        for (const [i, characterName] of chars.entries()) {
            test.db.HsrAccountCharacter.insert({ hsrAccountId: id, characterName, eidolonLevel: i, ...AUDIT(test) });
        }
        test.db.LobbyMemberAccount.insert({ lobbyId, userId: who.userId, hsrAccountId: id });
        return id;
    }
    /** Anonymous-players Waiting lobby; verified host (the referee) on `hostSlot`; b1 Blue, r1 / r2 Red, each with one account. */
    function world(rv: 'OpenRoster' | 'ClosedWithRating' | 'ClosedNoRating', hostSlot: 'BluePlayer' | 'Spectator') {
        const test = newHarness();
        const host = verified(test, 'rhost');
        const seats: Array<[string, 'BluePlayer' | 'RedPlayer']> = hostSlot === 'BluePlayer'
            ? [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']]
            : [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
        const s = setupLobby(test, { lobby: { isAnonymousPlayers: true, rosterVisibility: { tag: rv } }, noStart: true, hostSlot, seats, actors: { host } });
        expect(lobbyRow(test, s.lobbyId).rosterVisibility.tag).toBe(rv);
        expect(refereeIds(test, s.lobbyId)).toEqual([host.userId]);
        const acc: Record<string, number> = {};
        const names = ['host', ...seats.map(([n]) => n)];
        for (const [i, n] of names.entries()) acc[n] = addAccount(test, s.lobbyId, s.a[n], `${n}-acc`, 1100 + i, [`${n}-c1`, `${n}-c2`]);
        const rows = view<RosterVisibilityRow>(test, 'view_my_roster_visibility', host);
        const seatOfName = (n: string) => seatOf(test, s.lobbyId, s.a[n].userId);
        const of = (n: string) => rows.filter((r) => r.joinSeq === seatOfName(n));
        return { test, s, acc, rows, of, seatOfName };
    }

    it('A75(1) a Blue-seated referee under ClosedNoRating reads nothing of Red; the member row withholds the rating (S9a)', () => {
        const { test, s, of, seatOfName } = world('ClosedNoRating', 'BluePlayer');
        expect(of('r1')).toEqual([]);
        expect(of('r2')).toEqual([]);
        const memberRows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.host);
        for (const n of ['r1', 'r2']) {
            const row = memberRows.find((r) => r.joinSeq === seatOfName(n))!;
            expect(row.accountRating, n).toBeUndefined();
            expect(row.userId, n).toBe(0);
        }
    });

    it('A75(1) a Blue-seated referee under ClosedWithRating reads the rating-only rows of Red (ids 0)', () => {
        const { s, of, seatOfName } = world('ClosedWithRating', 'BluePlayer');
        for (const n of ['r1', 'r2']) {
            expect(of(n), n).toEqual([{ lobbyId: s.lobbyId, joinSeq: seatOfName(n), memberUserId: 0, hsrAccountId: 0, characterName: '', eidolonLevel: 0, accountRating: expect.any(Number) }]);
            expect(of(n)[0].accountRating).toBeGreaterThan(0);
        }
    });

    it('A75(1) a Blue-seated referee under OpenRoster reads Red\'s rosters and ratings with ids masked', () => {
        const { s, acc, rows, of } = world('OpenRoster', 'BluePlayer');
        for (const n of ['r1', 'r2']) {
            expect(of(n).map((r) => r.characterName).sort(), n).toEqual([`${n}-c1`, `${n}-c2`]);
            for (const r of of(n)) expect(r).toMatchObject({ memberUserId: 0, hsrAccountId: 0 });
        }
        expect(rows.some((r) => r.memberUserId === s.a.r1.userId || r.hsrAccountId === acc.r1)).toBe(false);
    });

    it('A75(1) a seated referee reads self and teammates in full (real ids)', () => {
        const { s, acc, of } = world('ClosedNoRating', 'BluePlayer');
        expect(of('host').filter((r) => r.memberUserId === s.host.userId && r.hsrAccountId === acc.host)).toHaveLength(2);
        expect(of('b1').filter((r) => r.memberUserId === s.a.b1.userId && r.hsrAccountId === acc.b1)).toHaveLength(2);
    });

    it('A75(1) the spectator referee reads every roster and rating with real ids, under ClosedNoRating', () => {
        const { s, acc, rows, of } = world('ClosedNoRating', 'Spectator');
        for (const n of ['b1', 'b2', 'r1', 'r2']) {
            const r = of(n);
            expect(r.filter((x) => x.memberUserId === s.a[n].userId && x.hsrAccountId === acc[n]), n).toHaveLength(2);
            for (const x of r) expect(x.accountRating, n).toBeGreaterThan(0);
        }
        expect(rows.some((x) => x.memberUserId === 0)).toBe(false);
    });

    it('A75(1) the referee flag moved to a Red player: that player reads Blue per rosterVisibility (ClosedNoRating: nothing)', () => {
        const { test, s, seatOfName } = world('ClosedNoRating', 'BluePlayer');
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        const r = view<RosterVisibilityRow>(test, 'view_my_roster_visibility', s.a.r1);
        expect(r.filter((x) => x.joinSeq === seatOfName('host') || x.joinSeq === seatOfName('b1'))).toEqual([]);
        expect(r.filter((x) => x.memberUserId === s.a.r2.userId)).toHaveLength(2);
    });
});
