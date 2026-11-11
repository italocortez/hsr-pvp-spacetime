// Views: the roster views (visibility, my roster, public accounts); view_my_roster_visibility grants the referee
//   exemption to the spectator referee only.
// Decisions: A75
// Contracts: docs/views/contract.md
// From S9b, S9c (s9b-views.test.ts, s9c-rulings.test.ts); merged by T-REORG2.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    type MyRosterAccountRow,
    type PublicHsrAccountRow,
    type RosterVisibilityRow,
    type LobbyMemberViewRow,
} from '@bindings/types';
import {
    guest,
    lobbyRow,
    member,
    newHarness,
    setupLobby,
    type Actor,
    type SetupOpts,
    M,
    refereeIds,
    seatOf,
    tx,
    type Harness,
    AUDIT,
} from '../fixtures/harness';
import { verified } from '../fixtures/identity';
import { insertHsrAccount } from '../fixtures/roster';
import { ANON, addAccount, keysOf, selectRatedAccount, shared, sorted, view, type Reader } from '../fixtures/views';

// ════════════════════════════════════════════════════════════════════════════
// Roster visibility (S9b-V6, S9b-A3; A37, A40, D-14, D-71)
// ════════════════════════════════════════════════════════════════════════════

describe('view_my_roster_visibility (S9b-V6, S9b-A3)', () => {
    /** An anonymous-players Waiting lobby (verified host = the spectator referee; D-23 would force ClosedNoRating on a guest host). */
    function world(rosterVisibility: 'OpenRoster' | 'ClosedWithRating' | 'ClosedNoRating', opts: SetupOpts = {}) {
        const test = newHarness();
        const s = setupLobby(test, {
            lobby: { ...ANON, rosterVisibility: { tag: rosterVisibility } },
            noStart: true,
            actors: { host: verified(test, 'rvhost') },
            ...opts,
        });
        expect(lobbyRow(test, s.lobbyId).rosterVisibility.tag).toBe(rosterVisibility);
        const acc: Record<string, number> = {};
        for (const n of ['b1', 'b2', 'r1', 'r2']) acc[n] = selectRatedAccount(test, s.lobbyId, s.a[n], `${n}-acc`, 1000 + n.charCodeAt(1), [`${n}-c1`, `${n}-c2`]);
        const rows = (who: Reader) => view<RosterVisibilityRow>(test, 'view_my_roster_visibility', who);
        const joinSeq = (who: Actor) => member(test, s.lobbyId, who.userId).joinSeq;
        return { test, s, acc, rows, joinSeq };
    }

    it('OpenRoster: an anonymized opponent\'s characters, eidolons and rating arrive with memberUserId 0, hsrAccountId 0 and the joinSeq; own and teammate rows carry real ids', () => {
        const { test, s, acc, rows, joinSeq } = world('OpenRoster');
        const r = rows(s.a.r1);
        for (const row of r) expect(keysOf(row)).toEqual(sorted('rosterVisibility'));
        for (const opp of ['b1', 'b2']) {
            const oppRows = r.filter((x) => x.joinSeq === joinSeq(s.a[opp]));
            expect(oppRows.map((x) => x.characterName).sort(), opp).toEqual([`${opp}-c1`, `${opp}-c2`]);
            for (const x of oppRows) {
                expect(x).toMatchObject({ lobbyId: s.lobbyId, memberUserId: 0, hsrAccountId: 0, accountRating: test.db.HsrAccount.id.find(acc[opp])!.accountRating });
            }
        }
        expect(r.filter((x) => x.memberUserId === s.a.r1.userId && x.hsrAccountId === acc.r1)).toHaveLength(2);
        expect(r.filter((x) => x.memberUserId === s.a.r2.userId && x.hsrAccountId === acc.r2)).toHaveLength(2);
        expect(r.filter((x) => [s.a.b1.userId, s.a.b2.userId].includes(x.memberUserId))).toEqual([]);
        expect(r.filter((x) => [acc.b1, acc.b2].includes(x.hsrAccountId))).toEqual([]);
    });

    it('ClosedWithRating: one rating-only row per selected account of an anonymized opponent (characterName \'\', eidolonLevel 0, ids 0)', () => {
        const { s, rows, joinSeq } = world('ClosedWithRating');
        const r = rows(s.a.r1);
        const b1 = r.filter((x) => x.joinSeq === joinSeq(s.a.b1));
        expect(b1).toEqual([{ lobbyId: s.lobbyId, joinSeq: joinSeq(s.a.b1), memberUserId: 0, hsrAccountId: 0, characterName: '', eidolonLevel: 0, accountRating: 1000 + 'b1'.charCodeAt(1) }]);
        expect(r.filter((x) => x.memberUserId === s.a.r2.userId)).toHaveLength(2); // teammate: full roster (D-70)
    });

    it('ClosedNoRating: nothing of the opponents; the teammate\'s roster stays', () => {
        const { s, rows, joinSeq } = world('ClosedNoRating');
        const r = rows(s.a.r1);
        expect(r.filter((x) => x.joinSeq === joinSeq(s.a.b1) || x.joinSeq === joinSeq(s.a.b2))).toEqual([]);
        expect(r.filter((x) => x.memberUserId === s.a.r2.userId)).toHaveLength(2);
    });

    it('the spectator referee (D-14, D-71) sees every roster with real ids, even under ClosedNoRating', () => {
        const { s, acc, rows } = world('ClosedNoRating');
        const r = rows(s.host);
        for (const n of ['b1', 'b2', 'r1', 'r2']) {
            expect(r.filter((x) => x.memberUserId === s.a[n].userId && x.hsrAccountId === acc[n]), n).toHaveLength(2);
        }
        expect(r.some((x) => x.memberUserId === 0)).toBe(false);
    });

    // T-S9c: D-14's "any referee" is narrowed by A75(1): a referee seated on a team reads opponents per rosterVisibility.
    it('a seated player-referee under ClosedNoRating reads nothing of the opponents (A75(1), was D-14 "every roster")', () => {
        const test = newHarness();
        const host = verified(test, 'seatref');
        const s = setupLobby(test, {
            lobby: { ...ANON, rosterVisibility: { tag: 'ClosedNoRating' } }, noStart: true, hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']], actors: { host },
        });
        const accR1 = selectRatedAccount(test, s.lobbyId, s.a.r1, 'r1-acc', 1200, ['r1-c1']);
        const r = view<RosterVisibilityRow>(test, 'view_my_roster_visibility', host);
        const r1 = r.filter((x) => x.joinSeq === member(test, s.lobbyId, s.a.r1.userId).joinSeq);
        expect(r1).toEqual([]);
        expect(r.some((x) => x.memberUserId === s.a.r1.userId || x.hsrAccountId === accR1)).toBe(false);
    });
});

describe('view_my_roster (unchanged in S9b)', () => {
    it('the caller\'s accounts and characters only, the documented columns', () => {
        const test = newHarness();
        const a = guest(test, 'ra');
        const b = guest(test, 'rb');
        addAccount(test, a.userId, 'ra-acc', { chars: ['x', 'y'] });
        addAccount(test, b.userId, 'rb-acc', { chars: ['z'] });
        const rows = view<MyRosterAccountRow>(test, 'view_my_roster', a);
        expect(rows.map((r) => r.characterName).sort()).toEqual(['x', 'y']);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('myRoster'));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Public rosters (S9b-V7; S3 hand-off, A40 residual risk)
// ════════════════════════════════════════════════════════════════════════════

describe('view_public_hsr_accounts (S9b-V7)', () => {
    it('with accounts of mixed visibility: only public rosters, one row per character, the owner identified, the rating only when isRatingPublic; a private roster is absent', () => {
        const test = newHarness();
        const ann = guest(test, 'ann');
        const bob = guest(test, 'bob');
        const cid = guest(test, 'cid');
        const pub = addAccount(test, ann.userId, 'ann-pub', { rating: 1500, chars: ['Kafka', 'Seele'] });
        const bare = addAccount(test, bob.userId, 'bob-bare', { rating: 900, isRatingPublic: false });
        const priv = addAccount(test, cid.userId, 'cid-priv', { rating: 1700, chars: ['Acheron'], isRosterPublic: false });
        addAccount(test, ann.userId, 'ann-priv', { rating: 1100, chars: ['Bronya'], isRosterPublic: false, isRatingPublic: true });
        const rows = shared<PublicHsrAccountRow>(test, 'view_public_hsr_accounts');
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('publicAccount'));
        expect(rows.filter((r) => r.accountId === pub).map((r) => [r.userId, r.characterName, r.eidolonLevel, r.accountRating]).sort())
            .toEqual([[ann.userId, 'Kafka', 0, 1500], [ann.userId, 'Seele', 1, 1500]]);
        expect(rows.filter((r) => r.accountId === bare)).toEqual([{
            accountId: bare, userId: bob.userId, uid: 'bob-bare', region: 'eu', displayLabel: 'bob-bare', accountRating: undefined,
            characterName: undefined, eidolonLevel: undefined,
        }]);
        expect(rows.map((r) => r.accountId).sort((x, y) => x - y)).toEqual([pub, pub, bare].sort((x, y) => x - y));
        expect(rows.some((r) => r.userId === cid.userId)).toBe(false);

        // the owner opts in: the row appears (the index follows the update)
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(priv)!, isRosterPublic: true });
        expect(shared<PublicHsrAccountRow>(test, 'view_public_hsr_accounts').filter((r) => r.accountId === priv).map((r) => r.characterName)).toEqual(['Acheron']);
    });

    it('the HsrAccount.is_roster_public index exists (the view reads it; that no scan runs is the review / grep gate)', () => {
        const test = newHarness();
        expectTypeOf(test.db.HsrAccount).toHaveProperty('is_roster_public');
        expect(typeof (test.db.HsrAccount as any).is_roster_public.filter).toBe('function');
    });
});

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
