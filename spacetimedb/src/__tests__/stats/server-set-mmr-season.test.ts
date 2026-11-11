// Stats: server_set_mmr (test database only) writes the rating of the active season; the leaderboard rebuild reads
// and replaces one season's rows by index.
// Decisions: A40 (active season), A36b
// Contracts: docs/mmr/contract.md
// From S11a.
//
// T-S11a (triage L5): server_set_mmr picked the row by game mode only and inserted `seasonId: undefined`, so a rating
// set during an active season was not the one the views read. It now writes (userId, mode, active season or 0).
// The reducer is gated by requireTestDatabase (ctx.env.STDB_TARGET), which the harness cannot set (harness smoke (f));
// the calls here go through a context whose `env` reads 'test' and whose every other member is the real reducer
// context (a Proxy), so the reducer body and requireServer run unchanged.
// T-S11a (S10j review F3): rebuildLeaderboard reads MmrRating and deletes Leaderboard rows through the new season_id
// indexes; the rows of other seasons are untouched.
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import { M, newHarness, tx, type Ctx, type Harness, AUDIT } from '../fixtures/harness';
import { verified, seedUserRow } from '../fixtures/identity';
import { mmrByModeOf } from '@module/helpers/identity/viewAnonymity';
import { rebuildLeaderboard } from '@module/helpers/stats/leaderboardRebuild';

/** The reducer context with `env.STDB_TARGET = 'test'` (requireTestDatabase passes); everything else is the real ctx. */
function onTestDatabase(ctx: Ctx): Ctx {
    return new Proxy(ctx as object, {
        get(target, prop) {
            if (prop === 'env') return { STDB_TARGET: 'test' };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as Ctx;
}

const setMmr = (test: Harness, userId: number, gameMode: string, rating: number) =>
    tx(test, 'internal', (ctx) => M.server_set_mmr(onTestDatabase(ctx), { userId, gameMode, rating }));

function activateSeason(test: Harness, name: string): number {
    tx(test, 'internal', (ctx) => M.create_season(ctx, { name, startDate: test.clock.now(), endDate: undefined }));
    const id = [...test.db.Season.iter()].find((s) => s.name === name)!.id;
    tx(test, 'internal', (ctx) => M.set_active_season(ctx, { seasonId: id }));
    return id;
}

const ratingRows = (test: Harness, userId: number) =>
    [...test.db.MmrRating.user_id.filter(userId)].map((r) => ({ mode: r.gameMode.tag, seasonId: r.seasonId, rating: r.rating }));

describe('L5: server_set_mmr writes the active season', () => {
    it('pre-season: the row of season 0; with a season active, a new row of that season, which the views read', () => {
        const test = newHarness();
        const p = verified(test, 'rated');
        setMmr(test, p.userId, 'MemoryOfChaos', 1300);
        expect(ratingRows(test, p.userId)).toEqual([{ mode: 'MemoryOfChaos', seasonId: 0, rating: 1300 }]);

        const season = activateSeason(test, 'S1');
        setMmr(test, p.userId, 'MemoryOfChaos', 1450);
        expect(ratingRows(test, p.userId).sort((a, b) => a.seasonId - b.seasonId)).toEqual([
            { mode: 'MemoryOfChaos', seasonId: 0, rating: 1300 },        // the pre-season row is left as it was
            { mode: 'MemoryOfChaos', seasonId: season, rating: 1450 },
        ]);
        expect(tx(test, 'internal', (ctx) => mmrByModeOf(ctx, p.userId))[0]).toBe(1450);

        setMmr(test, p.userId, 'MemoryOfChaos', 1500); // an update of the season row, no third row
        expect(ratingRows(test, p.userId).filter((r) => r.seasonId === season)).toEqual([{ mode: 'MemoryOfChaos', seasonId: season, rating: 1500 }]);
        expect(ratingRows(test, p.userId)).toHaveLength(2);
    });

    it('an unknown game mode and a missing user are still refused', () => {
        const test = newHarness();
        const p = verified(test, 'rated');
        expect(() => setMmr(test, p.userId, 'Chess', 1000)).toThrow(/Invalid gameMode "Chess"/);
        expect(() => setMmr(test, 999_999, 'MemoryOfChaos', 1000)).toThrow('User #999999 not found');
    });
});

describe('S10j review F3: rebuildLeaderboard touches one season only (season_id indexes)', () => {
    it('rebuilding season 2 rewrites its rows from season-2 ratings; the season-1 rows and ratings are untouched', () => {
        const test = newHarness();
        const audit = AUDIT(test);
        for (const userId of [501, 502]) seedUserRow(test, userId);
        const rating = (userId: number, seasonId: number, value: number) => test.db.MmrRating.insert({
            userId, gameMode: { tag: 'MemoryOfChaos' } as any, rating: value, matchesPlayed: 10, globalCompositeRating: undefined, seasonId, ...audit,
        });
        rating(501, 1, 1600);
        rating(502, 2, 1700);
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 1));
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 2));
        const bySeason = (seasonId: number) => [...test.db.Leaderboard.iter()].filter((r) => r.seasonId === seasonId)
            .map((r) => ({ category: r.category, userId: r.userId, rating: r.rating }));
        const season1 = bySeason(1);
        expect(season1.map((r) => r.userId)).toEqual(expect.arrayContaining([501]));
        expect(season1.some((r) => r.userId === 502)).toBe(false);
        expect(bySeason(2).some((r) => r.userId === 502)).toBe(true);
        expect(bySeason(2).some((r) => r.userId === 501)).toBe(false);

        // A second rebuild of season 2 replaces its rows (no duplicates) and leaves season 1 as it was.
        test.clock.set(new Timestamp(test.clock.now().microsSinceUnixEpoch + 1_000_000n));
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 2));
        expect(bySeason(1)).toEqual(season1);
        expect(bySeason(2).filter((r) => r.userId === 502).length).toBe(bySeason(2).length > 0 ? new Set(bySeason(2).map((r) => r.category)).size : 0);
    });
});
