// ─── Global Character Stat Increment Helper ─────────────────────────────────
// Community-wide character aggregates (pick rate, ban rate, win rate).
// Per D-34: GlobalCharacterStat is public, incremented during finalization.

import { auditUpdate } from './auditColumns';
import { insertWithAudit } from './auditHelpers';

/**
 * Increments GlobalCharacterStat for a character action (pick or ban).
 *
 * If isPick=true: increments timesPicked, matchesPlayed, and wins/losses based on isWin.
 * If isPick=false (ban): increments timesBanned only (per D-29 — community ban count).
 */
export function incrementGlobalCharacterStat(
    ctx: any,
    characterName: string,
    gameMode: any,
    draftMode: any,
    seasonId: number,
    matchType: any,
    teamSize: number,
    isPick: boolean,
    isWin: boolean,
    actingUserId: number
): void {
    // GlobalCharacterStat has no composite PK btree index with all 6 columns.
    // Use by_char_mode (2-col) + post-filter for the remaining columns.
    const candidates = [...ctx.db.GlobalCharacterStat.by_char_mode.filter([characterName, gameMode])];
    const existing = candidates.find((r: any) =>
        r.draftMode.tag === draftMode.tag &&
        r.seasonId === seasonId &&
        r.matchType.tag === matchType.tag &&
        r.teamSize === teamSize
    );

    if (existing) {
        ctx.db.GlobalCharacterStat.delete(existing);
        ctx.db.GlobalCharacterStat.insert({
            characterName,
            gameMode,
            draftMode,
            seasonId,
            matchType,
            teamSize,
            timesPicked: existing.timesPicked + (isPick ? 1 : 0),
            timesBanned: existing.timesBanned + (!isPick ? 1 : 0),
            wins: existing.wins + (isPick && isWin ? 1 : 0),
            losses: existing.losses + (isPick && !isWin ? 1 : 0),
            matchesPlayed: existing.matchesPlayed + (isPick ? 1 : 0),
            ...auditUpdate(ctx, existing, actingUserId),
        } as any);
    } else {
        ctx.db.GlobalCharacterStat.insert(insertWithAudit(ctx, {
            characterName,
            gameMode,
            draftMode,
            seasonId,
            matchType,
            teamSize,
            timesPicked: isPick ? 1 : 0,
            timesBanned: !isPick ? 1 : 0,
            wins: isPick && isWin ? 1 : 0,
            losses: isPick && !isWin ? 1 : 0,
            matchesPlayed: isPick ? 1 : 0,
        }, actingUserId));
    }
}
