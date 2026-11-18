// Stats: the profile's Best Ally and Nemesis cards (view_my_player_cards).
// Decisions: A226 (items 5, 6, 7), A102, A195
// Contracts: docs/player-stats/contract.md, docs/views/contract.md
// From S14.5s (T-task of the step). In-memory datastore only; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import type { PlayerCardRow } from '@bindings/types';
import { AUDIT, M, guest, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import { verified } from '../fixtures/identity';
import { insertHsrAccount, setActive } from '../fixtures/roster';
import { profileGhost as ghost, view } from '../fixtures/views';
import { seedElo } from '../fixtures/tournament-matches';

const MODES = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'] as const;
type Mode = (typeof MODES)[number];

interface RelOpts { ally?: [matches: number, wins: number]; opp?: [matches: number, wins: number]; season?: number; mode?: Mode; teamSize?: number }

/** One PlayerRelationship row of `me` about `other` (private table, written directly as finalization would). */
function rel(test: Harness, me: Actor, other: Actor, o: RelOpts) {
    const [matchesAsAlly, winsAsAlly] = o.ally ?? [0, 0];
    const [matchesAsOpponent, winsAsOpponent] = o.opp ?? [0, 0];
    test.db.PlayerRelationship.insert({
        userId: me.userId, otherUserId: other.userId,
        gameMode: { tag: o.mode ?? 'MemoryOfChaos' }, draftMode: { tag: 'Classic' },
        matchesAsAlly, winsAsAlly, matchesAsOpponent, winsAsOpponent,
        seasonId: o.season ?? 0, matchType: { tag: 'Ranked' }, teamSize: o.teamSize ?? 1, ...AUDIT(test),
    } as any);
}

function activeSeason(test: Harness): number {
    return test.db.Season.insert({ id: 0, name: 'S1', startDate: test.clock.now(), endDate: undefined, isActive: true, ...AUDIT(test) } as any).id;
}

function rating(test: Harness, who: Actor, mode: Mode, value: number, seasonId: number, global?: number) {
    const existing = [...test.db.MmrRating.by_user_mode_season.filter([who.userId, { tag: mode } as any, seasonId])][0];
    if (existing) test.db.MmrRating.delete(existing);
    test.db.MmrRating.insert({
        userId: who.userId, gameMode: { tag: mode }, rating: value, matchesPlayed: 3, globalCompositeRating: global, seasonId, ...AUDIT(test),
    } as any);
}

const cards = (test: Harness, who: Actor | ReturnType<typeof ghost>) => view<PlayerCardRow>(test, 'view_my_player_cards', who);
const cardOf = (test: Harness, who: Actor, relation: 'BestAlly' | 'Nemesis') => cards(test, who).find((r) => r.relation === relation);
const initialRating = (test: Harness) => test.db.EloConfigTable.id.find(1)?.initialRating ?? 0;

describe('A226 item 6: thresholds, sums and ties', () => {
    it('no shared matches: no rows', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        expect(cards(test, me)).toEqual([]);
    });

    it('two matches together or against are not enough; three are', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const ally = verified(test, 'ally');
        const foe = verified(test, 'foe');
        rel(test, me, ally, { ally: [2, 2] });
        rel(test, me, foe, { opp: [2, 0] });
        expect(cards(test, me)).toEqual([]);
        rel(test, me, ally, { ally: [1, 0], mode: 'ApocalypticShadow' }); // summed over modes: 3 together, 2 wins
        rel(test, me, foe, { opp: [1, 1], teamSize: 2 }); // summed over team sizes: 3 against, 2 losses
        expect(cardOf(test, me, 'BestAlly')).toMatchObject({ userId: ally.userId, matches: 3, wins: 2, losses: 1 });
        expect(cardOf(test, me, 'Nemesis')).toMatchObject({ userId: foe.userId, matches: 3, wins: 1, losses: 2 });
    });

    it('a count of 0 never qualifies (no win together / no loss against)', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'p');
        rel(test, me, p, { ally: [5, 0], opp: [5, 5] });
        expect(cards(test, me)).toEqual([]);
    });

    it('only the active season counts (season 0 when none is active)', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const old = verified(test, 'old');
        const now = verified(test, 'now');
        rel(test, me, old, { ally: [9, 9], season: 0 });
        expect(cardOf(test, me, 'BestAlly')!.userId).toBe(old.userId);
        const season = activeSeason(test);
        rel(test, me, now, { ally: [3, 1], season });
        expect(cardOf(test, me, 'BestAlly')).toMatchObject({ userId: now.userId, matches: 3, wins: 1 });
    });

    it('best ally: the most wins; a tie goes to fewer matches, then the lower user id', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const a = verified(test, 'a');
        const b = verified(test, 'b');
        const c = verified(test, 'c');
        rel(test, me, a, { ally: [10, 4] });
        rel(test, me, b, { ally: [6, 4] });
        expect(cardOf(test, me, 'BestAlly')!.userId).toBe(b.userId);
        rel(test, me, c, { ally: [6, 4] });
        expect(cardOf(test, me, 'BestAlly')!.userId).toBe(Math.min(b.userId, c.userId));
        rel(test, me, a, { ally: [1, 1], mode: 'AnomalyArbitration' }); // a: 5 wins in 11
        expect(cardOf(test, me, 'BestAlly')).toMatchObject({ userId: a.userId, matches: 11, wins: 5, losses: 6 });
    });

    it('nemesis: the most losses against; a tie goes to fewer matches, then the lower user id', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const a = verified(test, 'a');
        const b = verified(test, 'b');
        const c = verified(test, 'c');
        rel(test, me, a, { opp: [8, 5] }); // 3 losses in 8
        rel(test, me, b, { opp: [4, 1] }); // 3 losses in 4
        expect(cardOf(test, me, 'Nemesis')).toMatchObject({ userId: b.userId, matches: 4, wins: 1, losses: 3 });
        rel(test, me, c, { opp: [4, 1] });
        expect(cardOf(test, me, 'Nemesis')!.userId).toBe(Math.min(b.userId, c.userId));
    });

    it('one player can be both the best ally and the nemesis: two rows', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'p');
        rel(test, me, p, { ally: [3, 3], opp: [3, 0] });
        expect(cards(test, me).map((r) => [r.relation, r.userId]).sort()).toEqual([['BestAlly', p.userId], ['Nemesis', p.userId]]);
    });
});

describe('A226 item 5: what a card shows', () => {
    it('the row carries exactly the card fields', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'p');
        rel(test, me, p, { ally: [3, 2] });
        expect(Object.keys(cardOf(test, me, 'BestAlly')!).sort()).toEqual([
            'accountCount', 'activeAccountRating', 'avatarCharacterName', 'displayName', 'displayedAchievementId',
            'globalRating', 'losses', 'matches', 'mmrByMode', 'relation', 'userId', 'username', 'wins',
        ]);
    });

    it('names, title, the three active-season mode ratings, the global rating, the active account rating and the account count', () => {
        const test = newHarness();
        seedElo(test);
        const season = activeSeason(test);
        const me = verified(test, 'me');
        const p = verified(test, 'pat_handle');
        test.db.User.id.update({ ...test.db.User.id.find(p.userId)!, displayName: 'Pat Shown', avatarCharacterName: 'Kafka', displayedAchievementId: 7 });
        rating(test, p, 'MemoryOfChaos', 1300, season, 1250);
        rating(test, p, 'AnomalyArbitration', 1200, season, 1250);
        rating(test, p, 'ApocalypticShadow', 1900, 0, 1900); // another season: not shown
        const inactive = insertHsrAccount(test, p.userId, '700000001');
        setActive(test, inactive, false);
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(inactive)!, accountRating: 999 });
        const active = insertHsrAccount(test, p.userId, '800000002');
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(active)!, accountRating: 4321 });
        rel(test, me, p, { ally: [3, 2], season });
        expect(cardOf(test, me, 'BestAlly')).toEqual({
            relation: 'BestAlly', userId: p.userId, displayName: 'Pat Shown', username: 'pat_handle',
            avatarCharacterName: 'Kafka', displayedAchievementId: 7,
            mmrByMode: [1300, initialRating(test), 1200], globalRating: 1250,
            activeAccountRating: 4321, accountCount: 2, matches: 3, wins: 2, losses: 1,
        });
    });

    it('no rating this season: the initial rating per mode and no global rating; no game account: no rating and 0 accounts', () => {
        const test = newHarness();
        seedElo(test);
        const me = verified(test, 'me');
        const p = verified(test, 'p');
        rel(test, me, p, { opp: [3, 0] });
        expect(cardOf(test, me, 'Nemesis')).toMatchObject({
            mmrByMode: [initialRating(test), initialRating(test), initialRating(test)],
            globalRating: undefined, activeAccountRating: undefined, accountCount: 0,
        });
    });

    it('accounts but none active: no active account rating, the count still shows', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'p');
        setActive(test, insertHsrAccount(test, p.userId, '700000001'), false);
        rel(test, me, p, { opp: [3, 0] });
        expect(cardOf(test, me, 'Nemesis')).toMatchObject({ activeAccountRating: undefined, accountCount: 1 });
    });
});

describe('A226 items 5, 6: deleted, pending deletion and suspended players; the caller', () => {
    it('a deleted player is skipped and the next qualifying player takes the card', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const gone = verified(test, 'gone');
        const next = verified(test, 'next');
        rel(test, me, gone, { ally: [5, 5] });
        rel(test, me, next, { ally: [3, 1] });
        expect(cardOf(test, me, 'BestAlly')!.userId).toBe(gone.userId);
        tx(test, gone, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(gone.userId)).toBeNull();
        expect(cardOf(test, me, 'BestAlly')!.userId).toBe(next.userId);
    });

    it('a player pending deletion (an admin deletion or a ban sets deletedAt) is skipped; with no other candidate there is no card', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'p');
        rel(test, me, p, { opp: [3, 0] });
        test.db.User.id.update({ ...test.db.User.id.find(p.userId)!, deletedAt: test.clock.now() });
        expect(cards(test, me)).toEqual([]);
    });

    it('a suspended player is still shown to others (as on the leaderboard)', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'p');
        rel(test, me, p, { ally: [3, 3] });
        tx(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: 'p', reason: '' }));
        expect(cardOf(test, me, 'BestAlly')!.userId).toBe(p.userId);
    });

    it('a suspended caller, an identity with no account and another user get nothing of the caller\'s', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'p');
        const other = verified(test, 'other');
        rel(test, me, p, { ally: [3, 3] });
        expect(cards(test, other)).toEqual([]);
        expect(cards(test, ghost())).toEqual([]);
        tx(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: 'me', reason: '' }));
        expect(cards(test, me)).toEqual([]);
    });

    it('a guest partner shows with the guest name and no accounts', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const g = guest(test, 'g1');
        rel(test, me, g, { ally: [3, 1] });
        expect(cardOf(test, me, 'BestAlly')).toMatchObject({ userId: g.userId, username: test.db.User.id.find(g.userId)!.username, accountCount: 0 });
    });
});

describe('A226 item 6: egress: the rows change only with the caller\'s relations or a carded player\'s shown values', () => {
    it('a rating change of a player who is not carded leaves the rows equal (view_my_relationships would change)', () => {
        const test = newHarness();
        const season = activeSeason(test);
        const me = verified(test, 'me');
        const carded = verified(test, 'carded');
        const other = verified(test, 'other');
        rel(test, me, carded, { ally: [3, 3], season });
        rel(test, me, other, { ally: [3, 1], season });
        const before = cards(test, me);
        const relBefore = view(test, 'view_my_relationships', me);
        rating(test, other, 'MemoryOfChaos', 1555, season, 1555);
        expect(cards(test, me)).toEqual(before);
        expect(view(test, 'view_my_relationships', me)).not.toEqual(relBefore);
        rating(test, carded, 'MemoryOfChaos', 1444, season, 1444);
        expect(cards(test, me)).not.toEqual(before);
    });
});
