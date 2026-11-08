// ─── Stats Views ──────────────────────────────────────────────────────────────
// Per-user views over the private PlayerStat, PlayerCharacterStat and MmrRating tables.
//
// 1. view_my_player_stats    — caller's own PlayerStat rows (D-33)
// 2. view_my_character_stats — caller's own PlayerCharacterStat rows (D-33)
// 3. view_my_mmr_ratings     — caller's own MmrRating rows, one per mode and season (S9b; A40, A44(1) D1)
//
// S9b (A37): no audit columns and no userId in these rows. The stat writers stamp the finalizing user as the audit
// actor, who may be an anonymized opponent or referee of the match. Index-only (`by_user`, `user_id`).
// The public aggregates (Leaderboard top 20, GlobalCharacterStat, UserAchievement) are tables, not views (A44(2)).

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { GameMode, DraftMode, MatchType } from '@module/types/enums';
import { callerUserId } from '@module/helpers/identity/viewAnonymity';

// ---------------------------------------------------------------------------
// 1. My Player Stats (per-user view) — the caller's PlayerStat rows (the profile's stats dashboard: filters by
//    mode / draft / match type / team size / season). PlayerStat is private (D-33).
// ---------------------------------------------------------------------------
const MyPlayerStatRow = t.row('MyPlayerStatRow', {
    gameMode: GameMode,
    draftMode: DraftMode,
    matchType: MatchType,
    teamSize: t.u8(),
    seasonId: t.u32(),
    matchesPlayed: t.u32(),
    wins: t.u32(),
    losses: t.u32(),
    matchesSpectated: t.u32(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_player_stats = spacetimedb.view(
    { name: 'view_my_player_stats', public: true },
    t.array(MyPlayerStatRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const rows: any[] = [];
        for (const s of ctx.db.PlayerStat.by_user.filter(me)) {
            rows.push({
                gameMode: s.gameMode,
                draftMode: s.draftMode,
                matchType: s.matchType,
                teamSize: s.teamSize,
                seasonId: s.seasonId,
                matchesPlayed: s.matchesPlayed,
                wins: s.wins,
                losses: s.losses,
                matchesSpectated: s.matchesSpectated,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 2. My Character Stats (per-user view) — the caller's PlayerCharacterStat rows (played / wins, most-banned,
//    most-faced). Private table accessible via this view (D-33).
// ---------------------------------------------------------------------------
const MyCharacterStatRow = t.row('MyCharacterStatRow', {
    characterName: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    matchType: MatchType,
    teamSize: t.u8(),
    seasonId: t.u32(),
    matchesPlayed: t.u32(),
    wins: t.u32(),
    losses: t.u32(),
    timesBannedInMatch: t.u32(),
    timesFaced: t.u32(),
    winsAgainst: t.u32(),
    lossesAgainst: t.u32(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_character_stats = spacetimedb.view(
    { name: 'view_my_character_stats', public: true },
    t.array(MyCharacterStatRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const rows: any[] = [];
        for (const s of ctx.db.PlayerCharacterStat.by_user.filter(me)) {
            rows.push({
                characterName: s.characterName,
                gameMode: s.gameMode,
                draftMode: s.draftMode,
                matchType: s.matchType,
                teamSize: s.teamSize,
                seasonId: s.seasonId,
                matchesPlayed: s.matchesPlayed,
                wins: s.wins,
                losses: s.losses,
                timesBannedInMatch: s.timesBannedInMatch,
                timesFaced: s.timesFaced,
                winsAgainst: s.winsAgainst,
                lossesAgainst: s.lossesAgainst,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 3. view_my_mmr_ratings (S9b; A40, A44(1), PAGE-MAP D1): the profile's MMR rail. MmrRating stays private; the
//    caller reads their own rows, one per (mode, season): rating, matchesPlayed, the season's wins in that mode
//    (summed over the caller's PlayerStat rows, as the leaderboard does; MmrRating has no wins column) and
//    `lastUpdatedAt` (the row's lastModifiedDate). The profile's Global value is computed client-side (mean of the
//    modes). Index-only: MmrRating.user_id, PlayerStat.by_user.
// ---------------------------------------------------------------------------
const MyMmrRatingRow = t.row('MyMmrRatingRow', {
    gameMode: GameMode,
    seasonId: t.u32(),
    rating: t.u32(),
    matchesPlayed: t.u32(),
    wins: t.u32(),
    lastUpdatedAt: t.timestamp(),
});

export const view_my_mmr_ratings = spacetimedb.view(
    { name: 'view_my_mmr_ratings', public: true },
    t.array(MyMmrRatingRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const stats = [...ctx.db.PlayerStat.by_user.filter(me)];
        const rows: any[] = [];
        for (const r of ctx.db.MmrRating.user_id.filter(me)) {
            let wins = 0;
            for (const s of stats) {
                if (s.seasonId === r.seasonId && s.gameMode.tag === r.gameMode.tag) wins += s.wins;
            }
            rows.push({
                gameMode: r.gameMode,
                seasonId: r.seasonId,
                rating: r.rating,
                matchesPlayed: r.matchesPlayed,
                wins,
                lastUpdatedAt: r.lastModifiedDate,
            });
        }
        return rows;
    }
);
