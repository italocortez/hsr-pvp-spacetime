// Stats: the profile's Best Ally and Nemesis cards (view_my_player_cards).
// Decisions: A226 (items 5, 6, 7), A102, A195, A228 (item 6)
// Contracts: docs/player-stats/contract.md, docs/views/contract.md
// From S14.5s (T-task of the step). In-memory datastore only; nothing reaches maincloud.
// T-S14.5s fix pass (A228 item 6): the card carries the active account rating only; `mmrByMode` and `globalRating`
// are gone. Most cards are identified by the carded player's username (unique). T-S14.5s second fix pass (review M3):
// `userId` is back on the row (the join key to view_my_relationships.otherUserId) and is pinned below.
import { describe, expect, it } from 'vitest';
import type { PlayerCardRow } from '@bindings/types';
import { AUDIT, M, guest, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import { verified } from '../fixtures/identity';
import { insertHsrAccount, setActive } from '../fixtures/roster';
import { profileGhost as ghost, view } from '../fixtures/views';

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
/** The username of an actor: the card's identifying field since the fix pass. */
const nameOf = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.username;
const lowerIdOf = (x: Actor, y: Actor) => (x.userId < y.userId ? x : y);

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
        expect(cardOf(test, me, 'BestAlly')).toMatchObject({ username: 'ally', matches: 3, wins: 2, losses: 1 });
        expect(cardOf(test, me, 'Nemesis')).toMatchObject({ username: 'foe', matches: 3, wins: 1, losses: 2 });
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
        expect(cardOf(test, me, 'BestAlly')!.username).toBe('old');
        const season = activeSeason(test);
        rel(test, me, now, { ally: [3, 1], season });
        expect(cardOf(test, me, 'BestAlly')).toMatchObject({ username: 'now', matches: 3, wins: 1 });
    });

    it('best ally: the most wins; a tie goes to fewer matches, then the lower user id', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const a = verified(test, 'aa');
        const b = verified(test, 'bb');
        const c = verified(test, 'cc');
        rel(test, me, a, { ally: [10, 4] });
        rel(test, me, b, { ally: [6, 4] });
        expect(cardOf(test, me, 'BestAlly')!.username).toBe('bb');
        rel(test, me, c, { ally: [6, 4] });
        expect(cardOf(test, me, 'BestAlly')!.username).toBe(nameOf(test, lowerIdOf(b, c)));
        rel(test, me, a, { ally: [1, 1], mode: 'AnomalyArbitration' }); // a: 5 wins in 11
        expect(cardOf(test, me, 'BestAlly')).toMatchObject({ username: 'aa', matches: 11, wins: 5, losses: 6 });
    });

    it('nemesis: the most losses against; a tie goes to fewer matches, then the lower user id', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const a = verified(test, 'aa');
        const b = verified(test, 'bb');
        const c = verified(test, 'cc');
        rel(test, me, a, { opp: [8, 5] }); // 3 losses in 8
        rel(test, me, b, { opp: [4, 1] }); // 3 losses in 4
        expect(cardOf(test, me, 'Nemesis')).toMatchObject({ username: 'bb', matches: 4, wins: 1, losses: 3 });
        rel(test, me, c, { opp: [4, 1] });
        expect(cardOf(test, me, 'Nemesis')!.username).toBe(nameOf(test, lowerIdOf(b, c)));
    });

    it('one player can be both the best ally and the nemesis: two rows', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'pp');
        rel(test, me, p, { ally: [3, 3], opp: [3, 0] });
        expect(cards(test, me).map((r) => [r.relation, r.username]).sort()).toEqual([['BestAlly', 'pp'], ['Nemesis', 'pp']]);
    });
});

describe('A226 item 5, A228 item 6: what a card shows', () => {
    it('the row carries exactly the card fields: the user id, no mode ratings, no composite rating', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'pp');
        rel(test, me, p, { ally: [3, 2] });
        expect(Object.keys(cardOf(test, me, 'BestAlly')!).sort()).toEqual([
            'accountCount', 'activeAccountRating', 'avatarCharacterName', 'displayName', 'displayedAchievementId',
            'losses', 'matches', 'relation', 'userId', 'username', 'wins',
        ]);
    });

    it("the card's userId is the relationship row's otherUserId (the join key)", () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'pp');
        rel(test, me, p, { ally: [3, 2], opp: [3, 0] });
        expect(cardOf(test, me, 'BestAlly')!.userId).toBe(p.userId);
        expect(cardOf(test, me, 'Nemesis')!.userId).toBe(p.userId);
        const relationships = view<{ otherUserId: number }>(test, 'view_my_relationships', me);
        expect(new Set(relationships.map((r) => r.otherUserId))).toEqual(new Set([p.userId]));
    });

    it('names, title, the active account rating (the only rating, whatever the mode ratings) and the account count', () => {
        const test = newHarness();
        const season = activeSeason(test);
        const me = verified(test, 'me');
        const p = verified(test, 'pat_handle');
        test.db.User.id.update({ ...test.db.User.id.find(p.userId)!, displayName: 'Pat Shown', avatarCharacterName: 'Kafka', displayedAchievementId: 7 });
        rating(test, p, 'MemoryOfChaos', 1300, season, 1250); // review S5: a composite that disagrees is not sent
        const inactive = insertHsrAccount(test, p.userId, '700000001');
        setActive(test, inactive, false);
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(inactive)!, accountRating: 999 });
        const active = insertHsrAccount(test, p.userId, '800000002');
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(active)!, accountRating: 4321 });
        rel(test, me, p, { ally: [3, 2], season });
        expect(cardOf(test, me, 'BestAlly')).toEqual({
            relation: 'BestAlly', userId: p.userId, displayName: 'Pat Shown', username: 'pat_handle',
            avatarCharacterName: 'Kafka', displayedAchievementId: 7,
            activeAccountRating: 4321, accountCount: 2, matches: 3, wins: 2, losses: 1,
        });
    });

    it('no game account: no rating and 0 accounts', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'pp');
        rel(test, me, p, { opp: [3, 0] });
        expect(cardOf(test, me, 'Nemesis')).toMatchObject({ activeAccountRating: undefined, accountCount: 0 });
    });

    it('accounts but none active: no active account rating, the count still shows', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'pp');
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
        expect(cardOf(test, me, 'BestAlly')!.username).toBe('gone');
        tx(test, gone, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(gone.userId)).toBeNull();
        expect(cardOf(test, me, 'BestAlly')!.username).toBe('next');
    });

    it('a player pending deletion (an admin deletion or a ban sets deletedAt) is skipped; with no other candidate there is no card', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'pp');
        rel(test, me, p, { opp: [3, 0] });
        test.db.User.id.update({ ...test.db.User.id.find(p.userId)!, deletedAt: test.clock.now() });
        expect(cards(test, me)).toEqual([]);
    });

    it('a suspended player is still shown to others (as on the leaderboard)', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'pp');
        rel(test, me, p, { ally: [3, 3] });
        tx(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: 'pp', reason: '' }));
        expect(cardOf(test, me, 'BestAlly')!.username).toBe('pp');
    });

    it('a suspended caller, an identity with no account and another user get nothing of the caller\'s', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'pp');
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
        expect(cardOf(test, me, 'BestAlly')).toMatchObject({ username: test.db.User.id.find(g.userId)!.username, accountCount: 0 });
    });

    // T-S14.5s fix pass: review test gap 7 (a guest caller; an ended season with no matches yet in the new one).
    it('a guest caller with shared matches gets their cards like anyone', () => {
        const test = newHarness();
        const g = guest(test, 'g1');
        const p = verified(test, 'pp');
        rel(test, g, p, { ally: [3, 2] });
        expect(cardOf(test, g, 'BestAlly')).toMatchObject({ username: 'pp', matches: 3, wins: 2 });
    });

    it('after a new season starts with no matches yet, the cards of the old season are gone', () => {
        const test = newHarness();
        const me = verified(test, 'me');
        const p = verified(test, 'pp');
        rel(test, me, p, { ally: [5, 5], season: 0 });
        expect(cards(test, me)).toHaveLength(1);
        activeSeason(test);
        expect(cards(test, me)).toEqual([]);
    });
});

describe('A226 item 6: egress: the rows change only with the caller\'s relations or a carded player\'s shown values', () => {
    it('a mode rating change changes no card; an active account rating change changes only the carded player\'s', () => {
        const test = newHarness();
        const season = activeSeason(test);
        const me = verified(test, 'me');
        const carded = verified(test, 'carded');
        const other = verified(test, 'other');
        const cardedAccount = insertHsrAccount(test, carded.userId, '700000001');
        const otherAccount = insertHsrAccount(test, other.userId, '700000002');
        rel(test, me, carded, { ally: [3, 3], season });
        rel(test, me, other, { ally: [3, 1], season });
        const before = cards(test, me);
        rating(test, carded, 'MemoryOfChaos', 1444, season, 1444);
        expect(cards(test, me)).toEqual(before); // A228 item 6: the mode ratings are not on the card
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(otherAccount)!, accountRating: 1555 });
        expect(cards(test, me)).toEqual(before);
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(cardedAccount)!, accountRating: 1666 });
        expect(cardOf(test, me, 'BestAlly')!.activeAccountRating).toBe(1666);
    });
});
