// ─── Leaderboard Rebuild Helper ─────────────────────────────────────────────
// Rebuilds the materialized Leaderboard table from MmrRating and PlayerStat data.
// Called inline after MMR processing (finalize_match_result for standalone Ranked,
// process_tournament_mmr for tournament batch).

import { insertWithAudit } from './auditHelpers';

/** Minimum matches required to appear on a leaderboard (D-46). */
const MIN_MATCHES = 2;

/** Maximum entries per leaderboard category. */
const MAX_ENTRIES = 100;

/** Per-mode category definitions mapping category name to GameMode tag. */
const MODE_CATEGORIES = [
    { category: 'MemoryOfChaos', gameModeTag: 'MemoryOfChaos' },
    { category: 'ApocalypticShadow', gameModeTag: 'ApocalypticShadow' },
    { category: 'AnomalyArbitration', gameModeTag: 'AnomalyArbitration' },
];

/**
 * Returns the active season's id, or 0 if no active season exists.
 */
function getActiveSeasonId(ctx: any): number {
    const active = [...ctx.db.Season.is_active.filter(true)][0];
    return active ? active.id : 0;
}

/**
 * Deletes all existing Leaderboard rows for the given seasonId and rebuilds
 * top 100 per category from MmrRating + PlayerStat data.
 * If seasonId is not provided, uses the active season (or 0 for pre-season).
 */
export function rebuildLeaderboard(ctx: any, actingUserId: number, seasonId?: number): void {
    const effectiveSeasonId = seasonId !== undefined ? seasonId : getActiveSeasonId(ctx);

    // 1. Delete existing Leaderboard rows for this season
    for (const row of [...ctx.db.Leaderboard.iter()]) {
        if (row.seasonId === effectiveSeasonId) {
            ctx.db.Leaderboard.delete(row);
        }
    }

    // 2. Per-mode categories
    for (const { category, gameModeTag } of MODE_CATEGORIES) {
        const entries = [...ctx.db.MmrRating.iter()]
            .filter((r: any) =>
                r.gameMode.tag === gameModeTag &&
                r.matchesPlayed >= MIN_MATCHES &&
                r.seasonId === effectiveSeasonId
            );

        // Sort by rating descending
        entries.sort((a: any, b: any) => b.rating - a.rating);

        // Take top 100
        const top = entries.slice(0, MAX_ENTRIES);

        for (let i = 0; i < top.length; i++) {
            const entry = top[i];
            // Sum wins across all draftModes for this userId, gameMode, and season
            const wins = [...ctx.db.PlayerStat.by_user.filter(entry.userId)]
                .filter((s: any) => s.gameMode.tag === gameModeTag && s.seasonId === effectiveSeasonId)
                .reduce((sum: number, s: any) => sum + s.wins, 0);

            ctx.db.Leaderboard.insert(insertWithAudit(ctx, {
                category,
                rank: i + 1,
                userId: entry.userId,
                rating: entry.rating,
                matchesPlayed: entry.matchesPlayed,
                wins,
                seasonId: effectiveSeasonId,
            }, actingUserId));
        }
    }

    // 3. Global category
    // Collect all unique userIds with >= MIN_MATCHES in any mode for this season
    const allRatings = [...ctx.db.MmrRating.iter()]
        .filter((r: any) => r.matchesPlayed >= MIN_MATCHES && r.seasonId === effectiveSeasonId);
    const userIds = new Set<number>();
    for (const r of allRatings) {
        userIds.add(r.userId);
    }

    const globalEntries: Array<{ userId: number; globalRating: number; totalMatches: number; totalWins: number }> = [];
    for (const userId of userIds) {
        const userRatings = [...ctx.db.MmrRating.user_id.filter(userId)]
            .filter((r: any) => r.seasonId === effectiveSeasonId);
        const globalRating = userRatings[0]?.globalCompositeRating ?? 0;
        if (globalRating <= 0) continue;

        const totalMatches = userRatings.reduce((sum: number, r: any) => sum + r.matchesPlayed, 0);
        const totalWins = [...ctx.db.PlayerStat.by_user.filter(userId)]
            .filter((s: any) => s.seasonId === effectiveSeasonId)
            .reduce((sum: number, s: any) => sum + s.wins, 0);

        globalEntries.push({ userId, globalRating, totalMatches, totalWins });
    }

    // Sort by globalCompositeRating descending
    globalEntries.sort((a, b) => b.globalRating - a.globalRating);

    // Take top 100
    const topGlobal = globalEntries.slice(0, MAX_ENTRIES);

    for (let i = 0; i < topGlobal.length; i++) {
        const entry = topGlobal[i];
        ctx.db.Leaderboard.insert(insertWithAudit(ctx, {
            category: 'Global',
            rank: i + 1,
            userId: entry.userId,
            rating: entry.globalRating,
            matchesPlayed: entry.totalMatches,
            wins: entry.totalWins,
            seasonId: effectiveSeasonId,
        }, actingUserId));
    }
}
