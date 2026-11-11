// Views: the roster views (visibility, my roster, public accounts).
// Contracts: docs/views/contract.md
// From S9b (s9b-views.test.ts).
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MyRosterAccountRow, PublicHsrAccountRow, RosterVisibilityRow } from '@bindings/types';
import {
    guest,
    lobbyRow,
    member,
    newHarness,
    setupLobby,
    type Actor,
    type SetupOpts,
} from '../fixtures/harness';
import { verified } from '../fixtures/tournament-builders';
import {
    ANON,
    addAccount,
    keysOf,
    selectAccount,
    shared,
    sorted,
    view,
    type Reader,
} from '../fixtures/profile-view-builders';

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
        for (const n of ['b1', 'b2', 'r1', 'r2']) acc[n] = selectAccount(test, s.lobbyId, s.a[n], `${n}-acc`, 1000 + n.charCodeAt(1), [`${n}-c1`, `${n}-c2`]);
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
        const accR1 = selectAccount(test, s.lobbyId, s.a.r1, 'r1-acc', 1200, ['r1-c1']);
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
