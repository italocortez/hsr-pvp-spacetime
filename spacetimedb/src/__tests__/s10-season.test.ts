// T-S10 (batch B): in-memory port of test/backend/season/season-admin.test.ts (docs/mmr/contract.md create_season,
// set_active_season, "Season Single-Active Guarantee"). Admin comes from setUserRole (a `User.role` write through
// `test.db`), never server_set_role. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import { M, expectReject, newHarness, tx, type Actor, type Harness } from './s4-fixtures';
import { setUserRole, verified } from './s8-fixtures';

function admin(test: Harness): Actor {
    const a = verified(test, 'admin');
    setUserRole(test, a.userId, 'Admin');
    return a;
}
const createSeason = (test: Harness, who: Actor, name: string) =>
    tx(test, who, (ctx) => M.create_season(ctx, { name, startDate: Timestamp.fromDate(new Date('2026-02-01T00:00:00Z')), endDate: undefined }));
const seasons = (test: Harness) => [...test.db.Season.iter()];
const seasonNamed = (test: Harness, name: string) => seasons(test).find((s) => s.name === name)!;
const activeIds = (test: Harness) => seasons(test).filter((s) => s.isActive).map((s) => s.id);

describe('Season admin (docs/mmr/contract.md)', () => {
    it('create_season ("Defaults to isActive=false"): an Admin creates an inactive season stamped with their id', () => {
        const test = newHarness();
        const a = admin(test);
        const before = seasons(test).length;
        createSeason(test, a, 'Season A');
        expect(seasons(test)).toHaveLength(before + 1);
        const row = seasonNamed(test, 'Season A');
        expect(row.isActive).toBe(false);
        expect(row.createdById).toBe(a.userId);
    });

    it('create_season error "Caller is not Admin": a verified User and a Moderator are rejected; nothing inserted', () => {
        const test = newHarness();
        const user = verified(test, 'u');
        const mod = verified(test, 'm');
        setUserRole(test, mod.userId, 'Moderator');
        const before = seasons(test).length;
        expectReject(test, user, (ctx) => M.create_season(ctx, { name: 'Nope', startDate: test.clock.now(), endDate: undefined }), 'Requires Admin privileges');
        expectReject(test, mod, (ctx) => M.create_season(ctx, { name: 'Nope', startDate: test.clock.now(), endDate: undefined }), 'Requires Admin privileges');
        expect(seasons(test)).toHaveLength(before);
    });

    it('"Season Single-Active Guarantee": set_active_season activates the target and deactivates every other season', () => {
        const test = newHarness();
        const a = admin(test);
        createSeason(test, a, 'Season A');
        createSeason(test, a, 'Season B');
        const s1 = seasonNamed(test, 'Season A').id;
        const s2 = seasonNamed(test, 'Season B').id;

        tx(test, a, (ctx) => M.set_active_season(ctx, { seasonId: s1 }));
        expect(activeIds(test)).toEqual([s1]);

        tx(test, a, (ctx) => M.set_active_season(ctx, { seasonId: s2 }));
        expect(activeIds(test)).toEqual([s2]);
        expect(test.db.Season.id.find(s1)!.isActive).toBe(false);

        // Re-activating the active season keeps exactly one active (the re-read in the flow, step 4).
        tx(test, a, (ctx) => M.set_active_season(ctx, { seasonId: s2 }));
        expect(activeIds(test)).toEqual([s2]);
    });

    it('set_active_season error "Season not found": "Season #{seasonId} not found."; the active season is unchanged', () => {
        const test = newHarness();
        const a = admin(test);
        createSeason(test, a, 'Season A');
        const s1 = seasonNamed(test, 'Season A').id;
        tx(test, a, (ctx) => M.set_active_season(ctx, { seasonId: s1 }));
        expectReject(test, a, (ctx) => M.set_active_season(ctx, { seasonId: 99999 }), 'Season #99999 not found.');
        expect(activeIds(test)).toEqual([s1]);
    });
});
