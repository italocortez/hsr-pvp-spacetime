// T-S10 (batch A2): in-memory port of the live MMR / stats suites (test/backend/match-results/mmr-stats, the per-field
// `it`s merged; rating-admin). Contract: docs/mmr/contract.md (processMatchMmr, the Acceptance Scenarios, the three
// rating-admin reducers), docs/player-stats/contract.md (PlayerStat, PlayerCharacterStat, GlobalCharacterStat,
// spectated count), docs/match-results/contract.md (MMR-RACE-02). The D-G roster guards of mmr-stats belong to batch C2;
// PlayerRelationship is out of scope (Q9). Standalone Ranked matches: playRanked → override Validated → the referee's
// finalize_match_result. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, expectReject, newHarness, setupLobby, tx, type Actor, type Harness, type Lobby } from './s4-fixtures';
import { blueNames, draftClassic, finishGame, insertCharacter, redNames } from './s7-fixtures';
import { insertHsrAccount, moderator, setUserRole, verified } from './s8-fixtures';
import { seedElo } from './s8d-fixtures';
import { ownedAccount, playRanked, seedRatingChars, seedRatingData, validateAndFinalize } from './s10-a2-fixtures';
import { computeAccountRating } from '@module/helpers/stats/accountRating';

const ratingOf = (test: Harness, userId: number) => [...test.db.MmrRating.user_id.filter(userId)][0];
const historyOf = (test: Harness, userId: number) => [...test.db.MmrHistory.user_id.filter(userId)].sort((a, b) => a.id - b.id);
const playerStat = (test: Harness, userId: number) => [...test.db.PlayerStat.by_user.filter(userId)][0];
const charStat = (test: Harness, userId: number, characterName: string) =>
    [...test.db.PlayerCharacterStat.by_user.filter(userId)].find((r) => r.characterName === characterName);
const globalStat = (test: Harness, characterName: string) =>
    [...test.db.GlobalCharacterStat.iter()].find((r) => r.characterName === characterName);
const board = (test: Harness, category: string) =>
    [...test.db.Leaderboard.iter()].filter((r) => r.category === category).sort((a, b) => a.rank - b.rank);

/**
 * A harness with EloConfig and a Moderator, plus one finalized Ranked match won by Blue (b1, b2 over r1, r2).
 * T-S10k (A110(1)): before the finalization b1 gets an extra account owning blue-1 and r1 one owning red-1, so the
 * played stat of those two picks has an owner to credit (a 2v2 side with no owner credits nobody, A110(3)).
 */
function firstMatch() {
    const test = newHarness();
    seedElo(test);
    const mod = moderator(test);
    const { s, recId } = playRanked(test, 'Blue');
    ownedAccount(test, s.a.b1.userId, 'own-b1', [blueNames()[0]]);
    ownedAccount(test, s.a.r1.userId, 'own-r1', [redNames()[0]]);
    validateAndFinalize(test, s, recId, mod, 'Blue');
    return { test, mod, s, recId };
}

/** The same four players and host play a second Ranked match, won by Blue again. */
function secondMatch(test: Harness, mod: Actor, a: Record<string, Actor>) {
    const { s, recId } = playRanked(test, 'Blue', { actors: a });
    validateAndFinalize(test, s, recId, mod, 'Blue');
    return { s, recId };
}

const players = (s: Lobby) => ({ winners: [s.a.b1, s.a.b2], losers: [s.a.r1, s.a.r2] });

// ─── Elo, MmrHistory, composite (one match) ───────────────────────────────────

describe('MMR after one standalone Ranked match (MMR contract: First Ranked Match, MmrHistory Records Created, GlobalCompositeRating -- Single Mode)', () => {
    it('MmrRating per participant: winners above 1000, losers below, symmetric deltas, matchesPlayed 1, composite = mode rating', () => {
        const { test, s } = firstMatch();
        const { winners, losers } = players(s);
        expect([...test.db.MmrRating.iter()]).toHaveLength(4);
        expect(ratingOf(test, s.host.userId)).toBeUndefined(); // the Spectator referee is not rated
        let sum = 0;
        for (const w of winners) {
            const r = ratingOf(test, w.userId);
            expect(r.rating).toBeGreaterThan(1000);
            expect(r.matchesPlayed).toBe(1);
            expect(r.globalCompositeRating).toBe(r.rating);
            expect(r.gameMode.tag).toBe('MemoryOfChaos');
            sum += r.rating - 1000;
        }
        for (const l of losers) {
            const r = ratingOf(test, l.userId);
            expect(r.rating).toBeLessThan(1000);
            expect(r.matchesPlayed).toBe(1);
            expect(r.globalCompositeRating).toBe(r.rating);
            sum += r.rating - 1000;
        }
        expect(Math.abs(sum)).toBeLessThanOrEqual(2); // winner gains + loser losses = 0 within rounding
    });

    it('MmrHistory: one row per participant, previousRating 1000, newRating = the rating, delta = new − previous, linked to the history row', () => {
        const { test, s } = firstMatch();
        const [history] = [...test.db.MatchSessionHistory.iter()];
        for (const p of [s.a.b1, s.a.b2, s.a.r1, s.a.r2]) {
            const rows = historyOf(test, p.userId);
            expect(rows).toHaveLength(1);
            expect(rows[0].previousRating).toBe(1000);
            expect(rows[0].newRating).toBe(ratingOf(test, p.userId).rating);
            expect(rows[0].delta).toBe(rows[0].newRating - rows[0].previousRating);
            expect(rows[0].matchHistoryId).toBe(history.id);
        }
        expect(historyOf(test, s.a.b1.userId)[0].delta).toBeGreaterThan(0);
        expect(historyOf(test, s.a.r1.userId)[0].delta).toBeLessThan(0);
    });

    it('one match is below the leaderboard threshold (MIN_MATCHES 2): no MemoryOfChaos or Global row yet', () => {
        const { test } = firstMatch();
        expect(board(test, 'MemoryOfChaos')).toHaveLength(0);
        expect(board(test, 'Global')).toHaveLength(0);
    });
});

// ─── Player and character stats (one match) ───────────────────────────────────

describe('stats after one Ranked match (player-stats contract: Player Win/Loss Tracking, Character Pick / Faced / Global Stats)', () => {
    it('PlayerStat: winners wins 1 / losses 0, losers the reverse, matchesPlayed 1 each', () => {
        const { test, s } = firstMatch();
        for (const w of players(s).winners) expect(playerStat(test, w.userId)).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0, matchesSpectated: 0 });
        for (const l of players(s).losers) expect(playerStat(test, l.userId)).toMatchObject({ matchesPlayed: 1, wins: 0, losses: 1, matchesSpectated: 0 });
        expect(playerStat(test, s.host.userId)).toBeUndefined(); // the referee neither plays nor counts as a spectator (D-30)
    });

    it('GlobalCharacterStat: each picked character timesPicked 1, matchesPlayed 1; Blue picks won, Red picks lost; nothing banned', () => {
        const { test } = firstMatch();
        for (const name of blueNames()) expect(globalStat(test, name)).toMatchObject({ timesPicked: 1, matchesPlayed: 1, wins: 1, losses: 0, timesBanned: 0 });
        for (const name of redNames()) expect(globalStat(test, name)).toMatchObject({ timesPicked: 1, matchesPlayed: 1, wins: 0, losses: 1, timesBanned: 0 });
        expect(globalStat(test, blueNames()[0])).toMatchObject({ gameMode: { tag: 'MemoryOfChaos' }, matchType: { tag: 'Ranked' }, teamSize: 2, seasonId: 0 });
    });

    it('PlayerCharacterStat: the owner on the picking side has the pick (matchesPlayed 1, wins 1), the non-owner teammate not; opponents have it as faced (timesFaced 1, winsAgainst / lossesAgainst) (A110(1)(4))', () => {
        const { test, s } = firstMatch();
        const blue1 = blueNames()[0];
        const red1 = redNames()[0];
        // T-S10k re-alignment: the played stat follows ownership (A110), not the picking captain (was A82(4)).
        expect(charStat(test, s.a.b1.userId, blue1)).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0, timesFaced: 0 });
        expect(charStat(test, s.a.r1.userId, red1)).toMatchObject({ matchesPlayed: 1, wins: 0, losses: 1 });
        expect(charStat(test, s.a.b2.userId, blue1)).toBeUndefined();
        expect(charStat(test, s.a.r2.userId, red1)).toBeUndefined();
        for (const l of players(s).losers) expect(charStat(test, l.userId, blue1)).toMatchObject({ timesFaced: 1, winsAgainst: 0, lossesAgainst: 1 });
        for (const w of players(s).winners) expect(charStat(test, w.userId, red1)).toMatchObject({ timesFaced: 1, winsAgainst: 1, lossesAgainst: 0 });
    });
});

// ─── Two matches: accumulation and the leaderboard ────────────────────────────

describe('two Ranked matches won by Blue (MMR contract: Leaderboard Threshold / Rank Ordering / Wins from PlayerStat / Global Leaderboard)', () => {
    it('ratings, history, PlayerStat and PlayerCharacterStat accumulate; composite still = mode rating', () => {
        const { test, mod, s } = firstMatch();
        const after1 = ratingOf(test, s.a.b1.userId).rating;
        secondMatch(test, mod, s.a);
        const b1 = ratingOf(test, s.a.b1.userId);
        expect(b1.matchesPlayed).toBe(2);
        expect(b1.rating).toBeGreaterThan(after1);
        expect(b1.globalCompositeRating).toBe(b1.rating);
        const hist = historyOf(test, s.a.b1.userId);
        expect(hist).toHaveLength(2);
        expect(hist[1].previousRating).toBe(hist[0].newRating);
        expect([...test.db.MmrRating.iter()]).toHaveLength(4); // one row per user, mode and season (upsert)
        for (const w of players(s).winners) expect(playerStat(test, w.userId)).toMatchObject({ matchesPlayed: 2, wins: 2, losses: 0 });
        for (const l of players(s).losers) expect(playerStat(test, l.userId)).toMatchObject({ matchesPlayed: 2, wins: 0, losses: 2 });
        expect(charStat(test, s.a.b1.userId, blueNames()[0])).toMatchObject({ matchesPlayed: 2, wins: 2 });
        expect(globalStat(test, blueNames()[0])).toMatchObject({ timesPicked: 2, wins: 2 });
    });

    it('the leaderboard holds all four in MemoryOfChaos and Global: the 2-0 side ranks above the 0-2 side; wins and matchesPlayed from the stats', () => {
        const { test, mod, s } = firstMatch();
        secondMatch(test, mod, s.a);
        const { winners, losers } = players(s);
        for (const category of ['MemoryOfChaos', 'Global']) {
            const rows = board(test, category);
            expect(rows.map((r) => r.userId).sort()).toEqual([...winners, ...losers].map((a) => a.userId).sort());
            const entry = (a: Actor) => rows.find((r) => r.userId === a.userId)!;
            for (const w of winners) {
                for (const l of losers) expect(entry(w).rank).toBeLessThan(entry(l).rank);
                expect(entry(w)).toMatchObject({ wins: 2, matchesPlayed: 2 });
            }
            for (const l of losers) expect(entry(l)).toMatchObject({ wins: 0, matchesPlayed: 2 });
        }
    });

    it('finalizing a finalized (deleted) record again is "Match result not found." and changes no rating (Double-Processing Guard)', () => {
        const { test, s, recId } = firstMatch();
        const before = ratingOf(test, s.a.b1.userId);
        expectReject(test, s.host, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }), 'Match result not found.');
        expect(ratingOf(test, s.a.b1.userId)).toMatchObject({ rating: before.rating, matchesPlayed: 1 });
        expect(historyOf(test, s.a.b1.userId)).toHaveLength(1);
    });
});

// ─── Bans and spectators ──────────────────────────────────────────────────────

describe('ban stats and the spectated count (player-stats contract: Character Ban Stats (D-23), Spectated Count (D-30), D-27)', () => {
    function bannedMatch() {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const spec = verified(test, 'spec'); // a Ranked lobby admits no guest (D-23)
        const { s, recId } = playRanked(test, 'Blue', {
            lobby: { banMode: { tag: 'Four' } },
            bans: ['ban-1', 'ban-2', 'ban-3', 'ban-4'],
            // A68(8): a new join in Drafting lands on Spectator.
            afterStart: (l) => tx(test, spec, (ctx) => M.join_lobby(ctx, { lobbyId: l.lobbyId, joinCode: '', password: '' })),
        });
        validateAndFinalize(test, s, recId, mod, 'Blue');
        return { test, s, spec };
    }

    it('a (non-referee) spectator gets matchesSpectated 1 and matchesPlayed 0', () => {
        const { test, spec } = bannedMatch();
        expect(playerStat(test, spec.userId)).toMatchObject({ matchesSpectated: 1, matchesPlayed: 0, wins: 0, losses: 0 });
    });

    it('a banned character: timesBannedInMatch 1 for all four participants, never a pick (D-27); GlobalCharacterStat timesBanned 1, timesPicked 0', () => {
        const { test, s } = bannedMatch();
        for (const name of ['ban-1', 'ban-2', 'ban-3', 'ban-4']) {
            for (const p of [s.a.b1, s.a.b2, s.a.r1, s.a.r2]) {
                expect(charStat(test, p.userId, name)).toMatchObject({ timesBannedInMatch: 1, matchesPlayed: 0, wins: 0, losses: 0 });
            }
            expect(globalStat(test, name)).toMatchObject({ timesBanned: 1, timesPicked: 0, matchesPlayed: 0 });
        }
    });
});

// ─── The snapshot drives the delta (MMR-RACE-02) ──────────────────────────────

describe('processMatchMmr reads the start_draft snapshot (match-results contract MMR-RACE-01/02; MMR contract: Account Rating Modifier)', () => {
    /** One Ranked match won by Blue; b1 and b2 hold accounts rated `blueRating`, Red 0; `afterStart` may move the live rating. */
    function blueDelta(blueRating: number, afterStart?: (test: Harness, s: Lobby) => void): number {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Blue', {
            ratings: { b1: blueRating, b2: blueRating, r1: 0, r2: 0 },
            afterStart: afterStart ? (l) => afterStart(test, l) : undefined,
        });
        validateAndFinalize(test, s, recId, mod, 'Blue');
        return historyOf(test, s.a.b1.userId)[0].delta;
    }

    it('a live accountRating change after start_draft leaves the delta unchanged; a different rating at start_draft changes it', () => {
        const baseline = blueDelta(0);
        const moved = blueDelta(0, (test, s) => {
            for (const name of ['b1', 'b2']) {
                for (const acct of [...test.db.HsrAccount.user_id.filter(s.a[name].userId)]) {
                    test.db.HsrAccount.id.update({ ...acct, accountRating: 900 });
                }
            }
        });
        expect(moved).toBe(baseline); // the snapshot (0), not the live 900, fed the modifier
        const stronger = blueDelta(900);
        expect(stronger).not.toBe(baseline);
        expect(stronger).toBeLessThan(baseline); // the higher-account side is the favourite: it gains less (Fair MMR)
    });
});

// ─── Casual matches skip MMR ──────────────────────────────────────────────────

describe('a casual match skips MMR (MMR contract: Casual Match Skips MMR)', () => {
    it('finalized inline: PlayerStat written, no MmrRating, no MmrHistory, no leaderboard row', () => {
        const test = newHarness();
        seedElo(test);
        const s = setupLobby(test);
        draftClassic(s, blueNames(), redNames());
        finishGame(s, 'Blue');
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(playerStat(test, s.a.b1.userId)).toMatchObject({ wins: 1, matchesPlayed: 1 });
        expect([...test.db.MmrRating.iter()]).toHaveLength(0);
        expect([...test.db.MmrHistory.iter()]).toHaveLength(0);
        expect([...test.db.Leaderboard.iter()]).toHaveLength(0);
    });
});

// ─── Rating admin (admin_seed_rating_config / admin_update_rating_config / admin_recalculate_all_ratings) ─

const FORBIDDEN = 'Forbidden: Requires Admin privileges.';
const NOT_SEEDED = 'Rating config not initialized. Call admin_seed_rating_config first.';
const config = (test: Harness) => test.db.AccountRatingConfig.id.find(1);

/** A verified Admin and a verified plain User. */
function staff(test: Harness) {
    const admin = verified(test, 'admin');
    setUserRole(test, admin.userId, 'Admin');
    const user = verified(test, 'user');
    setUserRole(test, user.userId, 'User');
    return { admin, user };
}
const seedCfg = (ctx: any) => M.admin_seed_rating_config(ctx, {});
const updateCfg = (args: Record<string, number>) => (ctx: any) => M.admin_update_rating_config(ctx, args as any);
const recalc = (ctx: any) => M.admin_recalculate_all_ratings(ctx, {});

describe('admin_seed_rating_config (MMR contract)', () => {
    it('a non-Admin is rejected; an Admin seeds the defaults with maxPossible > 0 over the character pool; a second seed is rejected', () => {
        const test = newHarness();
        const { admin, user } = staff(test);
        seedRatingChars(test);
        expectReject(test, user, seedCfg, FORBIDDEN);
        expect(config(test)).toBeFalsy();
        tx(test, admin, seedCfg);
        expect(config(test)).toMatchObject({
            verticalWeight: 0.4, horizontalWeight: 0.6, compression: 0.2, roleExponentDps: 2.0, roleExponentSupport: 1.3,
            roleExponentSustain: 1.0, archetypeThreshold: 3.0, scale: 1000.0,
        });
        expect(config(test)!.maxPossible).toBeGreaterThan(0);
        expectReject(test, admin, seedCfg, 'Rating config already seeded. Use admin_update_rating_config to modify.');
    });

    it('with an empty character pool the seeded maxPossible is 0', () => {
        const test = newHarness();
        const { admin } = staff(test);
        tx(test, admin, seedCfg);
        expect(config(test)!.maxPossible).toBe(0);
    });
});

describe('admin_update_rating_config (MMR contract; Acceptance: AccountRatingConfig -- maxPossible Recomputation, D-11b)', () => {
    it('a single field (scale) changes, the others stay', () => {
        const test = newHarness();
        const { admin } = staff(test);
        seedRatingData(test);
        const before = config(test)!;
        tx(test, admin, updateCfg({ scale: 500 }));
        const after = config(test)!;
        expect(after.scale).toBe(500);
        expect(after).toMatchObject({ verticalWeight: before.verticalWeight, horizontalWeight: before.horizontalWeight, compression: before.compression });
    });

    it('a weight change (verticalWeight 0.4 → 0.7) recomputes maxPossible', () => {
        const test = newHarness();
        const { admin } = staff(test);
        seedRatingData(test);
        const before = config(test)!.maxPossible;
        tx(test, admin, updateCfg({ verticalWeight: 0.7 }));
        expect(config(test)!.verticalWeight).toBe(0.7);
        expect(config(test)!.maxPossible).not.toBe(before);
    });

    it('rejected: a negative or non-finite value, no field at all, a non-Admin, an unseeded config', () => {
        const test = newHarness();
        const { admin, user } = staff(test);
        expectReject(test, admin, updateCfg({ scale: 2 }), NOT_SEEDED);
        seedRatingData(test);
        expectReject(test, admin, updateCfg({ verticalWeight: -0.1 }), 'Invalid value for verticalWeight: must be a finite positive number');
        expectReject(test, admin, updateCfg({ scale: Number.POSITIVE_INFINITY }), 'Invalid value for scale: must be a finite positive number');
        expectReject(test, admin, updateCfg({}), 'No fields provided to update.');
        expectReject(test, user, updateCfg({ scale: 2 }), FORBIDDEN);
        expect(config(test)!.scale).toBe(1000);
    });
});

describe('admin_recalculate_all_ratings (MMR contract, D-32; Acceptance: AccountRating -- Empty Roster Returns Zero)', () => {
    it('recomputes every account: a stale roster account gets its computed rating (> 0); an empty-roster account stays 0', () => {
        const test = newHarness();
        const { admin } = staff(test);
        seedRatingData(test);
        // Characters inserted directly: the stored rating is stale (0) until the recalculation.
        const rostered = ownedAccount(test, admin.userId, '700000001', { c1: 0, c5: 2, c9: 6 });
        const empty = insertHsrAccount(test, admin.userId, '700000002');
        expect(test.db.HsrAccount.id.find(rostered)!.accountRating).toBe(0);
        tx(test, admin, recalc);
        const expected = tx(test, 'internal', (ctx) => computeAccountRating(ctx, rostered));
        expect(expected).toBeGreaterThan(0);
        expect(test.db.HsrAccount.id.find(rostered)!.accountRating).toBe(expected);
        expect(test.db.HsrAccount.id.find(empty)!.accountRating).toBe(0);
    });

    it('a character added after the seed moves maxPossible on the recalculation', () => {
        const test = newHarness();
        const { admin } = staff(test);
        seedRatingData(test);
        const before = config(test)!.maxPossible;
        insertCharacter(test, 'c-new', 5);
        tx(test, admin, recalc);
        expect(config(test)!.maxPossible).not.toBe(before);
    });

    it('rejected for a non-Admin and before the config is seeded', () => {
        const test = newHarness();
        const { admin, user } = staff(test);
        expectReject(test, admin, recalc, NOT_SEEDED);
        seedRatingData(test);
        expectReject(test, user, recalc, FORBIDDEN);
    });
});
