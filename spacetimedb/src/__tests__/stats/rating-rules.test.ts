// Stats: the merged account rating, the season's composite rating, the leaderboard rebuild and the elo config
//   checks.
// Decisions: A102, A122
// Contracts: docs/mmr/contract.md, docs/player-stats/contract.md
// From S6, S10f, S10i, S10r (s6-rules.test.ts, s10f-draft-results.test.ts, s10i-draft-cost.test.ts,
//   s10r-triage-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import {
    computeAccountRating,
    computeMergedAccountRating,
} from '@module/helpers/stats/accountRating';
import { rebuildLeaderboard } from '@module/helpers/stats/leaderboardRebuild';
import { M, expectReject, lobbyRow, newHarness, setupLobby, tx, type Harness, AUDIT, snap } from '../fixtures/harness';
import { moderator, setUserRole, verified, seedUserRow } from '../fixtures/identity';
import { seedElo } from '../fixtures/tournament-matches';
import { playRanked, validateAndFinalize, seedRatingData, twoAccountPlayer } from '../fixtures/ranked';

// ─── Backlog #10: merged account rating ───────────────────────────────────────────────────────────────────

const snapshotOf = (test: Harness, lobbyId: number, userId: number) => {
    const record = [...test.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];
    return [...test.db.MatchResultParticipant.by_result_and_user.filter([record.id, userId])][0].accountRatingSnapshot;
};

describe('Backlog #10: merged account rating', () => {
    it('two equally rated accounts with disjoint rosters merge to a different (higher) rating; one account is unchanged', () => {
        const test = newHarness();
        seedRatingData(test);
        const { acct1, acct2 } = twoAccountPlayer(test, 'multi', 'Multi');
        const r1 = test.db.HsrAccount.id.find(acct1)!.accountRating;
        const r2 = test.db.HsrAccount.id.find(acct2)!.accountRating;
        expect(r1).toBeGreaterThan(0);
        expect(r2).toBe(r1);

        const merged = tx(test, 'internal', (ctx) => computeMergedAccountRating(ctx, [acct1, acct2]));
        expect(merged).not.toBe(r1);
        expect(merged).toBeGreaterThan(r1);

        // Single account: the wrapper and the merged path over one account equal the stored number exactly.
        const single = tx(test, 'internal', (ctx) => [computeAccountRating(ctx, acct1), computeMergedAccountRating(ctx, [acct1])]);
        expect(single).toEqual([r1, r1]);
    });

    it('start_draft snapshots the merged rating; selection is Waiting-only after A67, so the snapshot holds; a single-account snapshot is the stored rating', () => {
        const test = newHarness();
        seedRatingData(test);
        const { who, acct1, acct2 } = twoAccountPlayer(test, 'multi', 'Multi');
        const r1 = test.db.HsrAccount.id.find(acct1)!.accountRating;
        const merged = tx(test, 'internal', (ctx) => computeMergedAccountRating(ctx, [acct1, acct2]));

        const s = setupLobby(test, {
            actors: { b1: who },
            // Two selected accounts, as the tournament path (D-05, additive) allows.
            beforeStart: (l) => tx(test, 'internal', (ctx) => {
                ctx.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: who.userId, hsrAccountId: acct1 });
                ctx.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: who.userId, hsrAccountId: acct2 });
            }),
        });
        expect(snapshotOf(test, s.lobbyId, who.userId)).toBe(merged);

        // T-S8e (A67(1)): the between-games account swap is gone (D-06: selection in Waiting only). After start_draft
        // a deselect / reselect is rejected and the snapshot stays the merged rating.
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expectReject(test, who, (ctx) => M.deselect_match_account(ctx, { lobbyId: s.lobbyId, hsrAccountId: acct2 }),
            'Account deselection is only allowed during the Waiting stage.');
        expectReject(test, who, (ctx) => M.select_match_account(ctx, { lobbyId: s.lobbyId, hsrAccountId: acct1 }),
            'Account selection is only allowed during the Waiting stage.');
        expect(snapshotOf(test, s.lobbyId, who.userId)).toBe(merged);
        expect(r1).toBeLessThan(merged);

        // A single selected account snapshots exactly its stored rating.
        const t2 = newHarness();
        seedRatingData(t2);
        const p2 = twoAccountPlayer(t2, 'multi', 'Multi');
        const s2 = setupLobby(t2, {
            actors: { b1: p2.who },
            beforeStart: (l) => tx(t2, p2.who, (ctx) => M.select_match_account(ctx, { lobbyId: l.lobbyId, hsrAccountId: p2.acct1 })),
        });
        expect(snapshotOf(t2, s2.lobbyId, p2.who.userId)).toBe(t2.db.HsrAccount.id.find(p2.acct1)!.accountRating);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Results #9: the leaderboard skips deleted users
// ════════════════════════════════════════════════════════════════════════════

describe('Results #9: rebuildLeaderboard skips users with no live User row (mmr architecture S10f)', () => {
    const MOC = { tag: 'MemoryOfChaos' } as any;
    function seedRated(test: Harness, userId: number, rating: number) {
        test.db.MmrRating.insert({ userId, gameMode: MOC, rating, matchesPlayed: 5, globalCompositeRating: rating, seasonId: 0, ...AUDIT(test) } as any);
        test.db.PlayerStat.insert({
            userId, gameMode: MOC, draftMode: { tag: 'Classic' }, matchesPlayed: 5, wins: 3, losses: 2, matchesSpectated: 0,
            seasonId: 0, matchType: { tag: 'Ranked' }, teamSize: 2, ...AUDIT(test),
        } as any);
    }
    const board = (test: Harness, category: string) =>
        [...test.db.Leaderboard.iter()].filter((r) => r.category === category && r.seasonId === 0).sort((a, b) => a.rank - b.rank).map((r) => [r.rank, r.userId]);

    it('a soft-deleted user and a user with no row drop out at the next rebuild; the others keep their order with ranks 1..n (results audit #9)', () => {
        const test = newHarness();
        const users = [[8001, 1500], [8002, 1400], [8003, 1300], [8004, 1200], [8005, 1100]] as const;
        for (const [id, rating] of users) {
            seedUserRow(test, id);
            seedRated(test, id, rating);
        }
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
        expect(board(test, 'MemoryOfChaos')).toEqual([[1, 8001], [2, 8002], [3, 8003], [4, 8004], [5, 8005]]);

        test.db.User.id.update({ ...test.db.User.id.find(8002)!, deletedAt: test.clock.now() }); // soft-deleted, job pending
        test.db.User.id.delete(8004); // hard-deleted: MmrRating / PlayerStat kept as history
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
        for (const c of ['MemoryOfChaos', 'Global']) {
            expect(board(test, c), c).toEqual([[1, 8001], [2, 8003], [3, 8005]]);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B.7 A102: the global rating is per season
// ════════════════════════════════════════════════════════════════════════════

describe('A102: globalCompositeRating is computed from and written to the current season\'s rows only', () => {
    it('season 1 rows keep their stored value; the season 2 rows hold the mean of the season 2 rows only (A102)', () => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const admin = verified(test, 'admin');
        setUserRole(test, admin.userId, 'Admin');
        for (const name of ['S1', 'S2']) {
            tx(test, admin, (ctx) => M.create_season(ctx, { name, startDate: test.clock.now(), endDate: undefined }));
        }
        const seasonId = (name: string) => [...test.db.Season.iter()].find((x) => x.name === name)!.id;
        const activate = (name: string) => {
            const id = seasonId(name); // read outside the transaction
            tx(test, admin, (ctx) => M.set_active_season(ctx, { seasonId: id }));
        };
        const ratings = (userId: number, season: string) =>
            [...test.db.MmrRating.user_id.filter(userId)].filter((r) => r.seasonId === seasonId(season));

        activate('S1');
        const first = playRanked(test, 'Blue');
        validateAndFinalize(test, first.s, first.recId, mod, 'Blue');
        const a = first.s.a;
        const second = playRanked(test, 'Blue', { actors: a, lobby: { gameMode: { tag: 'ApocalypticShadow' } } });
        validateAndFinalize(test, second.s, second.recId, mod, 'Blue');
        const b1 = a.b1.userId;
        const s1 = ratings(b1, 'S1');
        expect(s1.map((r) => r.gameMode.tag).sort()).toEqual(['ApocalypticShadow', 'MemoryOfChaos']);
        const s1Mean = Math.round(s1.reduce((x, r) => x + r.rating, 0) / s1.length);
        for (const r of s1) expect(r.globalCompositeRating).toBe(s1Mean);
        const s1Before = snap(s1);

        activate('S2');
        const third = playRanked(test, 'Red', { actors: a }); // b1 loses in season 2
        validateAndFinalize(test, third.s, third.recId, mod, 'Red');
        const s2 = ratings(b1, 'S2');
        expect(s2).toHaveLength(1);
        expect(s2[0].rating).toBeLessThan(1000);
        expect(s2[0].globalCompositeRating).toBe(s2[0].rating); // the mean of the season 2 rows only
        const allMean = Math.round([...s1, ...s2].reduce((x, r) => x + r.rating, 0) / 3);
        expect(s2[0].globalCompositeRating).not.toBe(allMean);
        expect(snap(ratings(b1, 'S1'))).toBe(s1Before);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L44: the rating config
// ════════════════════════════════════════════════════════════════════════════

describe('A122(12), L44: admin_update_elo_config rejects a divisor of 0 and inverted thresholds', () => {
    it('A122(12) L44: spreadDivisor 0 and newThreshold above midThreshold (alone or after a merge) are rejected; the row is unchanged', () => {
        const test = newHarness();
        seedElo(test);
        const before = test.db.EloConfigTable.id.find(1)!;
        expectReject(test, 'internal', (ctx) => M.admin_update_elo_config(ctx, { spreadDivisor: 0 } as any), 'spreadDivisor must be greater than 0.');
        expectReject(test, 'internal', (ctx) => M.admin_update_elo_config(ctx, { newThreshold: 101 } as any),
            'newThreshold must not be greater than midThreshold.');
        expectReject(test, 'internal', (ctx) => M.admin_update_elo_config(ctx, { newThreshold: 50, midThreshold: 40 } as any),
            'newThreshold must not be greater than midThreshold.');
        const after = test.db.EloConfigTable.id.find(1)!;
        expect([after.spreadDivisor, after.newThreshold, after.midThreshold]).toEqual([before.spreadDivisor, before.newThreshold, before.midThreshold]);
    });

    it('A122(12) L44: a positive divisor and equal thresholds are accepted', () => {
        const test = newHarness();
        seedElo(test);
        tx(test, 'internal', (ctx) => M.admin_update_elo_config(ctx, { spreadDivisor: 3, newThreshold: 100 } as any));
        const row = test.db.EloConfigTable.id.find(1)!;
        expect([row.spreadDivisor, row.newThreshold, row.midThreshold]).toEqual([3, 100, 100]);
    });
});
