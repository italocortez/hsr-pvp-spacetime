// ─── Character Stat Increment Helpers ────────────────────────────────────────
// Composite PK delete+insert upsert pattern for PlayerCharacterStat.
// Three functions for different stat dimensions:
//   - incrementPlayerCharacterStat: pick stats (matchesPlayed, wins, losses)
//   - incrementBanStat: timesBannedInMatch (for ALL participants per banned character)
//   - incrementFacedStat: timesFaced, winsAgainst, lossesAgainst (opponent characters)

import { auditUpdate } from './auditColumns';
import { insertWithAudit } from './auditHelpers';

/**
 * Finds an existing PlayerCharacterStat row by full composite PK.
 * Returns the row or undefined.
 */
function findExisting(
    ctx: any,
    userId: number,
    characterName: string,
    gameMode: any,
    draftMode: any,
    seasonId: number,
    matchType: any,
    teamSize: number
): any | undefined {
    return [...ctx.db.PlayerCharacterStat.by_user_char_mode_draft_season_type_size
        .filter([userId, characterName, gameMode, draftMode, seasonId, matchType, teamSize])][0];
}

/**
 * Creates default column values for a new PlayerCharacterStat row.
 */
function defaultCounters() {
    return {
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        timesBannedInMatch: 0,
        timesFaced: 0,
        winsAgainst: 0,
        lossesAgainst: 0,
    };
}

/**
 * Increments PlayerCharacterStat for a picked character after finalization.
 * Called once per participant per picked character.
 * Only touches matchesPlayed, wins, losses — ban/faced columns left unchanged.
 */
export function incrementPlayerCharacterStat(
    ctx: any,
    userId: number,
    characterName: string,
    gameMode: any,
    draftMode: any,
    seasonId: number,
    matchType: any,
    teamSize: number,
    isWin: boolean,
    actingUserId: number
): void {
    const existing = findExisting(ctx, userId, characterName, gameMode, draftMode, seasonId, matchType, teamSize);

    if (existing) {
        ctx.db.PlayerCharacterStat.delete(existing);
        ctx.db.PlayerCharacterStat.insert({
            userId,
            characterName,
            gameMode,
            draftMode,
            seasonId,
            matchType,
            teamSize,
            matchesPlayed: existing.matchesPlayed + 1,
            wins: existing.wins + (isWin ? 1 : 0),
            losses: existing.losses + (!isWin ? 1 : 0),
            timesBannedInMatch: existing.timesBannedInMatch,
            timesFaced: existing.timesFaced,
            winsAgainst: existing.winsAgainst,
            lossesAgainst: existing.lossesAgainst,
            ...auditUpdate(ctx, existing, actingUserId),
        } as any);
    } else {
        ctx.db.PlayerCharacterStat.insert(insertWithAudit(ctx, {
            userId,
            characterName,
            gameMode,
            draftMode,
            seasonId,
            matchType,
            teamSize,
            ...defaultCounters(),
            matchesPlayed: 1,
            wins: isWin ? 1 : 0,
            losses: !isWin ? 1 : 0,
        }, actingUserId));
    }
}

/**
 * Increments timesBannedInMatch for a participant when a character is banned.
 * Per D-23: called for ALL participants in the match per banned character,
 * answering "how available is this character in my matches?"
 */
export function incrementBanStat(
    ctx: any,
    userId: number,
    characterName: string,
    gameMode: any,
    draftMode: any,
    seasonId: number,
    matchType: any,
    teamSize: number,
    actingUserId: number
): void {
    const existing = findExisting(ctx, userId, characterName, gameMode, draftMode, seasonId, matchType, teamSize);

    if (existing) {
        ctx.db.PlayerCharacterStat.delete(existing);
        ctx.db.PlayerCharacterStat.insert({
            userId,
            characterName,
            gameMode,
            draftMode,
            seasonId,
            matchType,
            teamSize,
            matchesPlayed: existing.matchesPlayed,
            wins: existing.wins,
            losses: existing.losses,
            timesBannedInMatch: existing.timesBannedInMatch + 1,
            timesFaced: existing.timesFaced,
            winsAgainst: existing.winsAgainst,
            lossesAgainst: existing.lossesAgainst,
            ...auditUpdate(ctx, existing, actingUserId),
        } as any);
    } else {
        ctx.db.PlayerCharacterStat.insert(insertWithAudit(ctx, {
            userId,
            characterName,
            gameMode,
            draftMode,
            seasonId,
            matchType,
            teamSize,
            ...defaultCounters(),
            timesBannedInMatch: 1,
        }, actingUserId));
    }
}

/**
 * Increments timesFaced, winsAgainst, lossesAgainst for a character the OPPONENT picked.
 * Per D-24: answers "which characters do I struggle against most?"
 */
export function incrementFacedStat(
    ctx: any,
    userId: number,
    opponentCharacterName: string,
    gameMode: any,
    draftMode: any,
    seasonId: number,
    matchType: any,
    teamSize: number,
    didWin: boolean,
    actingUserId: number
): void {
    const existing = findExisting(ctx, userId, opponentCharacterName, gameMode, draftMode, seasonId, matchType, teamSize);

    if (existing) {
        ctx.db.PlayerCharacterStat.delete(existing);
        ctx.db.PlayerCharacterStat.insert({
            userId,
            characterName: opponentCharacterName,
            gameMode,
            draftMode,
            seasonId,
            matchType,
            teamSize,
            matchesPlayed: existing.matchesPlayed,
            wins: existing.wins,
            losses: existing.losses,
            timesBannedInMatch: existing.timesBannedInMatch,
            timesFaced: existing.timesFaced + 1,
            winsAgainst: existing.winsAgainst + (didWin ? 1 : 0),
            lossesAgainst: existing.lossesAgainst + (!didWin ? 1 : 0),
            ...auditUpdate(ctx, existing, actingUserId),
        } as any);
    } else {
        ctx.db.PlayerCharacterStat.insert(insertWithAudit(ctx, {
            userId,
            characterName: opponentCharacterName,
            gameMode,
            draftMode,
            seasonId,
            matchType,
            teamSize,
            ...defaultCounters(),
            timesFaced: 1,
            winsAgainst: didWin ? 1 : 0,
            lossesAgainst: !didWin ? 1 : 0,
        }, actingUserId));
    }
}
