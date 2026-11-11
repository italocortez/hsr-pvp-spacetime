// ─── Leaderboard Rebuild Helper ─────────────────────────────────────────────
// Rebuilds the materialized Leaderboard table from MmrRating and PlayerStat data.
// Called inline after MMR processing (runFinalization for standalone Ranked) and once at the end of the
// run_tournament_finalize job of an MMR tournament (S8d).
//
// S9b (A40 mitigation (1), A44(2), A45(1)): the public table holds only the top 20 rows per category (three modes +
// Global), ordered by rating, then wins, then user id (a total order: equal rating and wins never swap between
// rebuilds). A37: every row's audit actor is SYSTEM_USER_ID; the finalizing player's id never reaches this public
// aggregate (it may be a player of an anonymous lobby).

import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';

/** Minimum matches required to appear on a leaderboard (D-46). */
const MIN_MATCHES = 2;

/** Maximum entries per leaderboard category (S9b: top 20, A40 / A44(2) / A45(1)). */
export const LEADERBOARD_MAX_ENTRIES = 20;

/** Per-mode category definitions mapping category name to GameMode tag. */
const MODE_CATEGORIES = [
    { category: 'MemoryOfChaos', gameModeTag: 'MemoryOfChaos' },
    { category: 'ApocalypticShadow', gameModeTag: 'ApocalypticShadow' },
    { category: 'AnomalyArbitration', gameModeTag: 'AnomalyArbitration' },
];

type Entry = { userId: number; rating: number; matchesPlayed: number; wins: number };

/**
 * Returns the active season's id, or 0 if no active season exists.
 */
function getActiveSeasonId(ctx: any): number {
    const active = [...ctx.db.Season.is_active.filter(true)][0];
    return active ? active.id : 0;
}

/** S9b total order: rating descending, then wins descending, then user id ascending. */
function compareEntries(a: Entry, b: Entry): number {
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.userId - b.userId;
}

/** Sums the user's PlayerStat wins of one season, optionally restricted to one game mode. */
function sumWins(ctx: any, userId: number, seasonId: number, gameModeTag?: string): number {
    let wins = 0;
    for (const s of ctx.db.PlayerStat.by_user.filter(userId)) {
        if (s.seasonId !== seasonId) continue;
        if (gameModeTag !== undefined && s.gameMode.tag !== gameModeTag) continue;
        wins += s.wins;
    }
    return wins;
}

function insertCategory(ctx: any, category: string, seasonId: number, entries: Entry[]): void {
    entries.sort(compareEntries);
    const top = entries.slice(0, LEADERBOARD_MAX_ENTRIES);
    for (let i = 0; i < top.length; i++) {
        const entry = top[i];
        const user = ctx.db.User.id.find(entry.userId); // a live user (isLive filtered the candidates)
        ctx.db.Leaderboard.insert(insertWithAudit(ctx, {
            category,
            rank: i + 1,
            userId: entry.userId,
            displayName: user?.displayName ?? '',
            avatarCharacterName: user?.avatarCharacterName ?? '',
            rating: entry.rating,
            matchesPlayed: entry.matchesPlayed,
            wins: entry.wins,
            seasonId,
        }, SYSTEM_USER_ID));
    }
}

/**
 * A77(1) (S11a): the leaderboard's denormalized card follows the user's display name and avatar. Called after
 * update_display_name, update_avatar and admin_update_user; rewrites the user's rows (Leaderboard.by_user, at most one
 * per category and season) when the card changed. SYSTEM audit actor, as the rebuild (A37).
 */
export function syncLeaderboardCard(ctx: any, userId: number): void {
    const user = ctx.db.User.id.find(userId);
    if (!user) return;
    for (const row of [...ctx.db.Leaderboard.by_user.filter(userId)]) {
        if (row.displayName === user.displayName && row.avatarCharacterName === user.avatarCharacterName) continue;
        ctx.db.Leaderboard.delete(row);
        ctx.db.Leaderboard.insert(updateWithAudit(ctx, row, {
            displayName: user.displayName,
            avatarCharacterName: user.avatarCharacterName,
        }, SYSTEM_USER_ID));
    }
}

/**
 * Deletes the season's Leaderboard rows (every category) and writes the top 20 per category from MmrRating +
 * PlayerStat data. If seasonId is not provided, uses the active season (or 0 for pre-season). The audit actor is
 * always SYSTEM_USER_ID (S9b, A37): callers no longer pass one.
 */
export function rebuildLeaderboard(ctx: any, seasonId?: number): void {
    const effectiveSeasonId = seasonId !== undefined ? seasonId : getActiveSeasonId(ctx);

    // 1. Delete the season's rows of every category (at most 4 × 20 per season, all rewritten below)
    // S11a (S10j review F3): the season_id index, not a scan of every season's rows
    for (const row of [...ctx.db.Leaderboard.season_id.filter(effectiveSeasonId)]) {
        ctx.db.Leaderboard.delete(row);
    }

    // 2. One pass over the season's ratings: per-mode candidates and the Global candidates' user ids
    const byMode = new Map<string, Entry[]>();
    for (const { gameModeTag } of MODE_CATEGORIES) byMode.set(gameModeTag, []);
    const globalUserIds = new Set<number>();
    // Results audit #9 (S10f): user deletion keeps MmrRating / PlayerStat, so a user with no live User row (hard-deleted,
    // or soft-deleted and waiting for the job) is skipped: the public table never ranks a deleted account.
    const liveUser = new Map<number, boolean>();
    const isLive = (userId: number): boolean => {
        let live = liveUser.get(userId);
        if (live === undefined) {
            const user = ctx.db.User.id.find(userId);
            live = !!user && user.deletedAt == null;
            liveUser.set(userId, live);
        }
        return live;
    };
    for (const r of ctx.db.MmrRating.season_id.filter(effectiveSeasonId)) { // S11a (S10j review F3): index read
        if (r.matchesPlayed < MIN_MATCHES) continue;
        if (!isLive(r.userId)) continue;
        globalUserIds.add(r.userId);
        const list = byMode.get(r.gameMode.tag);
        if (!list) continue;
        list.push({
            userId: r.userId,
            rating: r.rating,
            matchesPlayed: r.matchesPlayed,
            wins: sumWins(ctx, r.userId, effectiveSeasonId, r.gameMode.tag),
        });
    }

    for (const { category, gameModeTag } of MODE_CATEGORIES) {
        insertCategory(ctx, category, effectiveSeasonId, byMode.get(gameModeTag) ?? []);
    }

    // 3. Global category: the stored globalCompositeRating of users with >= MIN_MATCHES in any mode this season
    const globalEntries: Entry[] = [];
    for (const userId of globalUserIds) {
        const userRatings = [...ctx.db.MmrRating.user_id.filter(userId)]
            .filter((r: any) => r.seasonId === effectiveSeasonId);
        const globalRating = userRatings[0]?.globalCompositeRating ?? 0;
        if (globalRating <= 0) continue;
        globalEntries.push({
            userId,
            rating: globalRating,
            matchesPlayed: userRatings.reduce((sum: number, r: any) => sum + r.matchesPlayed, 0),
            wins: sumWins(ctx, userId, effectiveSeasonId),
        });
    }
    insertCategory(ctx, 'Global', effectiveSeasonId, globalEntries);
}
