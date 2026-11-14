// Stats: a deleted user leaves the public leaderboard at once, on every deletion path.
// Decisions: A163(1), A77(1), A40, A44(2)
// Contracts: docs/mmr/contract.md (Leaderboard), docs/auth/contract.md (user deletion)
// From S11a (rulings pass).
//
// T-S11a rulings pass (A163(1), review M3): performUserDeletion deletes the user's Leaderboard rows of every season and,
// when one of them was in the active season (pre-season 0 when no season is active), rebuilds that season so the
// next-ranked players fill the freed places. A user with no Leaderboard row causes no rebuild. Ratings are written
// straight into MmrRating / PlayerStat (outside any reducer) and ranked with rebuildLeaderboard, as the other leaderboard
// tests do. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { rebuildLeaderboard, LEADERBOARD_MAX_ENTRIES } from '@module/helpers/stats/leaderboardRebuild';
import { performUserDeletion } from '@module/helpers/identity/userDeletionHelper';
import { AUDIT, M, advance, guest, newHarness, snap, tx, type Actor, type Harness } from '../fixtures/harness';
import { admin, fireDeletionJob, providerOf, verified } from '../fixtures/identity';

const MOC = { tag: 'MemoryOfChaos' } as any;

function seedRated(test: Harness, userId: number, rating: number, seasonId: number) {
    test.db.MmrRating.insert({ userId, gameMode: MOC, rating, matchesPlayed: 5, globalCompositeRating: rating, seasonId, ...AUDIT(test) } as any);
    test.db.PlayerStat.insert({
        userId, gameMode: MOC, draftMode: { tag: 'Classic' }, matchesPlayed: 5, wins: 3, losses: 2, matchesSpectated: 0,
        seasonId, matchType: { tag: 'Ranked' }, teamSize: 2, ...AUDIT(test),
    } as any);
}

const board = (test: Harness, category: string, seasonId: number) =>
    [...test.db.Leaderboard.iter()].filter((r) => r.category === category && r.seasonId === seasonId)
        .sort((a, b) => a.rank - b.rank).map((r) => [r.rank, r.userId]);
const rowsOf = (test: Harness, userId: number) => [...test.db.Leaderboard.by_user.filter(userId)];
const namesOnBoard = (test: Harness) => [...test.db.Leaderboard.iter()].map((r) => r.displayName);
/** A season's rows in a fixed order (category, then rank), as a JSON snapshot. */
const seasonSnap = (rows: any[]) => snap(rows.sort((x, y) => x.category.localeCompare(y.category) || x.rank - y.rank));

/** Three ranked players in pre-season 0 (no active season): a 1500, b 1400, c 1300. */
function world() {
    const test = newHarness();
    const boss = admin(test, 'lbdboss');
    const [a, b, c] = ['lbda', 'lbdb', 'lbdc'].map((n) => verified(test, n));
    seedRated(test, a.userId, 1500, 0);
    seedRated(test, b.userId, 1400, 0);
    seedRated(test, c.userId, 1300, 0);
    tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
    for (const cat of ['MemoryOfChaos', 'Global']) expect(board(test, cat, 0)).toEqual([[1, a.userId], [2, b.userId], [3, c.userId]]);
    advance(test, 1000); // a rebuild after this point writes new audit times
    return { test, boss, a, b, c };
}

type Path = (test: Harness, boss: Actor, victim: Actor) => void;
const PATHS: Array<[string, Path]> = [
    ['delete_my_account (own request)', (test, _boss, v) => tx(test, v, (ctx) => M.delete_my_account(ctx, {}))],
    ['admin_ban_user + run_user_deletion (ban)', (test, boss, v) => {
        const providerId = providerOf(test, v)!; // read outside the transaction
        tx(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId, reason: 'abuse' }));
        fireDeletionJob(test, v.userId);
    }],
    ['admin_delete_row(User) + run_user_deletion (staff deletion)', (test, boss, v) => {
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(v.userId) }));
        fireDeletionJob(test, v.userId);
    }],
    ['server_delete_user (server deletion)', (test, _boss, v) => {
        const username = test.db.User.id.find(v.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
    }],
];

describe('A163(1): a ranked user deleted on each path leaves the leaderboard; the next-ranked players move up', () => {
    for (const [name, del] of PATHS) {
        it(name, () => {
            const { test, boss, a, b, c } = world();
            const aName = test.db.User.id.find(a.userId)!.displayName;
            del(test, boss, a);
            expect(test.db.User.id.find(a.userId)).toBeNull();
            expect(rowsOf(test, a.userId)).toEqual([]);
            expect(namesOnBoard(test)).not.toContain(aName);
            for (const cat of ['MemoryOfChaos', 'Global']) expect(board(test, cat, 0), cat).toEqual([[1, b.userId], [2, c.userId]]);
        });
    }

    it('identity GC and the sign-in re-point (confirm_link) delete through the same performUserDeletion call: a ranked guest leaves the board too', () => {
        // The identity GC never deletes a guest that holds a Leaderboard row (hasHistoryReferences checks it), so the
        // cascade is driven directly with the GC's arguments (actor SYSTEM_USER_ID 0, no options).
        const { test, a, b, c } = world();
        const g = guest(test, 'lbdguest');
        seedRated(test, g.userId, 1600, 0);
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
        expect(board(test, 'MemoryOfChaos', 0)[0]).toEqual([1, g.userId]);
        tx(test, 'internal', (ctx) => performUserDeletion(ctx, g.userId, 0));
        expect(test.db.User.id.find(g.userId)).toBeNull();
        expect(rowsOf(test, g.userId)).toEqual([]);
        expect(board(test, 'MemoryOfChaos', 0)).toEqual([[1, a.userId], [2, b.userId], [3, c.userId]]);
    });

    it(`a player below the top ${LEADERBOARD_MAX_ENTRIES} enters the board when a ranked player is deleted`, () => {
        const test = newHarness();
        const players = Array.from({ length: LEADERBOARD_MAX_ENTRIES + 1 }, (_, i) => verified(test, `lbdtop${i}`));
        players.forEach((p, i) => seedRated(test, p.userId, 2000 - i * 10, 0));
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
        const last = players[LEADERBOARD_MAX_ENTRIES];
        expect(rowsOf(test, last.userId)).toEqual([]); // 21st: not shown
        tx(test, players[0], (ctx) => M.delete_my_account(ctx, {}));
        const moc = board(test, 'MemoryOfChaos', 0);
        expect(moc).toHaveLength(LEADERBOARD_MAX_ENTRIES);
        expect(moc[0]).toEqual([1, players[1].userId]);
        expect(moc[LEADERBOARD_MAX_ENTRIES - 1]).toEqual([LEADERBOARD_MAX_ENTRIES, last.userId]);
    });
});

describe('A163(1): past seasons and unranked users', () => {
    it('a user ranked only in a past season: their past rows go, the other past rows stay as they were (no rebuild there), the active season is untouched', () => {
        const { test, boss, a, b, c } = world();
        // Season S1 becomes active; season 0 is now a past season. b and c are ranked in S1, a is not.
        tx(test, boss, (ctx) => M.create_season(ctx, { name: 'S1', startDate: test.clock.now(), endDate: undefined }));
        const s1 = [...test.db.Season.iter()].find((s) => s.name === 'S1')!.id;
        tx(test, boss, (ctx) => M.set_active_season(ctx, { seasonId: s1 }));
        seedRated(test, b.userId, 1400, s1);
        seedRated(test, c.userId, 1300, s1);
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, s1));
        advance(test, 1000);
        const activeBefore = seasonSnap([...test.db.Leaderboard.season_id.filter(s1)]);
        const pastOthersBefore = seasonSnap([...test.db.Leaderboard.season_id.filter(0)].filter((r) => r.userId !== a.userId));

        tx(test, a, (ctx) => M.delete_my_account(ctx, {}));
        expect(rowsOf(test, a.userId)).toEqual([]);
        // past season: no rebuild, so b and c keep ranks 2 and 3 (rank 1 is missing there)
        expect(seasonSnap([...test.db.Leaderboard.season_id.filter(0)])).toBe(pastOthersBefore);
        expect(board(test, 'MemoryOfChaos', 0)).toEqual([[2, b.userId], [3, c.userId]]);
        // active season: a held no row there, so it is not rebuilt (same rows, same audit times)
        expect(seasonSnap([...test.db.Leaderboard.season_id.filter(s1)])).toBe(activeBefore);
    });

    it('a user ranked in the active and a past season loses both; only the active season is rebuilt', () => {
        const { test, boss, a, b } = world();
        tx(test, boss, (ctx) => M.create_season(ctx, { name: 'S1', startDate: test.clock.now(), endDate: undefined }));
        const s1 = [...test.db.Season.iter()].find((s) => s.name === 'S1')!.id;
        tx(test, boss, (ctx) => M.set_active_season(ctx, { seasonId: s1 }));
        seedRated(test, a.userId, 1500, s1);
        seedRated(test, b.userId, 1400, s1);
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, s1));
        tx(test, a, (ctx) => M.delete_my_account(ctx, {}));
        expect(rowsOf(test, a.userId)).toEqual([]);
        expect(board(test, 'MemoryOfChaos', s1)).toEqual([[1, b.userId]]);
        expect(board(test, 'MemoryOfChaos', 0).map(([rank]) => rank)).toEqual([2, 3]);
    });

    it('an unranked user\'s deletion causes no rebuild: every Leaderboard row is unchanged, audit times included', () => {
        const { test } = world();
        const nobody = verified(test, 'lbdnobody');
        seedRated(test, nobody.userId, 900, 0); // a rating, but no Leaderboard row (no rebuild since)
        expect(rowsOf(test, nobody.userId)).toEqual([]);
        advance(test, 1000); // a rebuild now would rewrite every row with a new audit time
        const before = seasonSnap([...test.db.Leaderboard.iter()]);
        tx(test, nobody, (ctx) => M.delete_my_account(ctx, {}));
        expect(seasonSnap([...test.db.Leaderboard.iter()])).toBe(before);
    });
});
