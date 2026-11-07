// ─── Scoring glue (A21, A39, A56; backlog #3, #11) ────────────────────────────────────────────────────────
// Reads the module's tables and feeds the pure shared scoring module (`@shared/scoring`). The formula lives
// only there, so the web live preview and the official result cannot disagree. Everything stored is integer
// hundredths; the f32 cost tables and step payload costs are converted once with toHundredths.

import { SenderError } from 'spacetimedb/server';
import {
    groupCount,
    rosterCost,
    scoreGame,
    synergySurcharge,
    toHundredths,
    advantageToDelta,
    lowerWins,
    TIE_BREAK_UNRESOLVED,
    type GameModeTag,
    type HandicapSettings,
    type LineupFormatTag,
    type SynergyPair,
} from '@shared/scoring';
import { auditUpdate } from './auditColumns';
import { insertWithAudit, updateWithAudit } from './auditHelpers';
import { slotIsCoach, slotTeam } from './lobbyHelpers';

export type TeamTag = 'Blue' | 'Red';

/**
 * Every game number a lobby's match can have rows for: 1 .. max(Lobby.bestOf, MatchSession.currentGameNumber,
 * highest MatchResultGame of its records). The (id, gameNumber) indexes are scanned per full key because the
 * 2.14.1 in-memory test datastore rejects a bare-scalar prefix scan and returns nothing for a prefix + Range scan.
 */
export function lobbyGameNumbers(ctx: any, lobbyId: number): number[] {
    let max = Math.max(ctx.db.Lobby.id.find(lobbyId)?.bestOf ?? 1, ctx.db.MatchSession.lobbyId.find(lobbyId)?.currentGameNumber ?? 1);
    for (const r of ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)) {
        for (const g of ctx.db.MatchResultGame.match_result_id.filter(r.id)) max = Math.max(max, g.gameNumber);
    }
    return Array.from({ length: max }, (_, i) => i + 1);
}

/** MatchLineup rows of every game of the lobby. */
export function lobbyLineups(ctx: any, lobbyId: number): any[] {
    return lobbyGameNumbers(ctx, lobbyId).flatMap((g) => [...ctx.db.MatchLineup.by_lobby_game.filter([lobbyId, g])]);
}

export const teamSideValue = <T extends 'Blue' | 'Red' | 'Spectator'>(tag: T) => ({ tag });

/** The lobby's A21 handicap columns as the shared module's settings (already hundredths since S3). */
export function handicapSettings(lobby: any): HandicapSettings {
    return {
        rosterDiffAdvantage: lobby.rosterDiffAdvantage,
        rosterThreshold: lobby.rosterThreshold,
        underThresholdAdvantage: lobby.underThresholdAdvantage,
        aboveThresholdPenalty: lobby.aboveThresholdPenalty,
        deathPenalty: lobby.deathPenalty,
    };
}

/** Rejects anything but Blue / Red. */
export function ensureTeamTag(teamSide: any): TeamTag {
    const tag = teamSide?.tag;
    if (tag !== 'Blue' && tag !== 'Red') throw new SenderError('teamSide must be Blue or Red.');
    return tag;
}

/**
 * Backlog #3 / #11: the captain of that team (a player seat, not a coach) or any lobby referee (either team,
 * seated or not; A34a keeps referee powers unconditional). Returns the caller's LobbyMember row.
 */
export function ensureCaptainOrReferee(ctx: any, lobbyId: number, userId: number, side: TeamTag, what: string): any {
    const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])][0];
    const isCaptain = member && member.isCaptain && !slotIsCoach(member.lobbySlot) && slotTeam(member.lobbySlot) === side;
    if (!member || !(member.isReferee || isCaptain)) {
        throw new SenderError(`Only the ${side} captain or a referee can ${what}.`);
    }
    return member;
}

/** The lobby's result record that still takes scores (Pending). S8 (A54) consolidates to one record per lobby. */
export function findPendingResult(ctx: any, lobbyId: number): any {
    const record = [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)].find((r: any) => r.status.tag === 'Pending');
    if (!record) throw new SenderError('No pending match result for this lobby.');
    return record;
}

export interface TeamDraft {
    characters: string[];
    /** Hundredths: Classic Pick.costPaid (cost at the eidolon) or Auction AuctionSold.winningAmount. */
    characterCosts: number[];
    lightconeCosts: number[];
    /** CH-S6 / D.8.7: the eidolon recorded in the Pick / AuctionSold payload (the scoring input). */
    eidolons: Array<{ name: string; eidolon: number }>;
}

/** The team's draft for one game, read from that game's steps (the step payloads are the snapshot, D.8.7). */
export function teamDraft(ctx: any, lobbyId: number, gameNumber: number, side: TeamTag): TeamDraft {
    const draft: TeamDraft = { characters: [], characterCosts: [], lightconeCosts: [], eidolons: [] };
    for (const step of ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)) {
        if (step.gameNumber !== gameNumber) continue;
        const p = step.payload;
        if (p.tag === 'Pick' && step.action.tag === 'Pick' && step.actorSlot.tag === side) {
            draft.characters.push(p.value.characterName);
            draft.characterCosts.push(toHundredths(p.value.costPaid));
            draft.eidolons.push({ name: p.value.characterName, eidolon: p.value.eidolon });
        } else if (p.tag === 'AuctionSold' && p.value.winningTeam.tag === side) {
            draft.characters.push(p.value.characterName);
            draft.characterCosts.push(toHundredths(p.value.winningAmount));
            draft.eidolons.push({ name: p.value.characterName, eidolon: p.value.eidolon });
        } else if (p.tag === 'EquipLightcone' && step.actorSlot.tag === side) {
            draft.lightconeCosts.push(toHundredths(p.value.costPaid));
        }
    }
    return draft;
}

/** The lobby's synergy pairs (cost set × game mode × draft mode), costModifier in hundredths. */
export function synergyPairs(ctx: any, lobby: any): SynergyPair[] {
    const pairs: SynergyPair[] = [];
    for (const row of ctx.db.HsrSynergyCost.cost_set_id.filter(lobby.costSetId)) {
        if (row.gameMode.tag !== lobby.gameMode.tag || row.draftMode.tag !== lobby.draftMode.tag) continue;
        pairs.push({ characterA: row.characterA, characterB: row.characterB, costModifier: toHundredths(row.costModifier) });
    }
    return pairs;
}

/**
 * Surcharge and roster cost of a lineup (hundredths). The surcharge is clamped at 0 **before** it is summed (the
 * u32 column cannot hold a negative value, so a net-negative pair modifier is ignored, not subtracted), which keeps
 * the stored surcharge and roster cost consistent; the roster cost is clamped at 0 too.
 */
export function lineupCosts(ctx: any, lobby: any, draft: TeamDraft, groups: string[][] | null): { surcharge: number; rosterCost: number } {
    const surcharge = Math.max(0, groups ? synergySurcharge(groups, synergyPairs(ctx, lobby)) : 0);
    const cost = rosterCost({ characterCosts: draft.characterCosts, lightconeCosts: draft.lightconeCosts, surcharge });
    return { surcharge, rosterCost: Math.max(0, cost) };
}

export function findLineup(ctx: any, lobbyId: number, gameNumber: number, side: TeamTag): any {
    return [...ctx.db.MatchLineup.by_lobby_game.filter([lobbyId, gameNumber])].find((l: any) => l.teamSide.tag === side);
}

/**
 * Tie-break 1 / handicap input: always live, from the game's steps (picks, sold characters, equipped light cones)
 * plus the surcharge of the current arrangement (none without a lineup row), confirmed or not, so a light cone
 * equipped after confirm_lineup still counts.
 */
export function teamRosterCost(ctx: any, lobby: any, gameNumber: number, side: TeamTag, draft: TeamDraft): number {
    const lineup = findLineup(ctx, lobby.id, gameNumber, side);
    return lineupCosts(ctx, lobby, draft, lineup ? JSON.parse(lineup.groups) : null).rosterCost;
}

/**
 * equip_lightcone hook: after a light cone is equipped, the side's lineup row (if any) gets the new roster cost
 * and surcharge; isConfirmed is left as it is.
 */
export function refreshLineupCosts(ctx: any, lobby: any, gameNumber: number, side: TeamTag, actorId: number): void {
    const lineup = findLineup(ctx, lobby.id, gameNumber, side);
    if (!lineup) return;
    const { surcharge, rosterCost: cost } = lineupCosts(ctx, lobby, teamDraft(ctx, lobby.id, gameNumber, side), JSON.parse(lineup.groups));
    ctx.db.MatchLineup.id.update(updateWithAudit(ctx, lineup, { synergySurcharge: surcharge, rosterCost: cost }, actorId));
}

/** Tie-break 2 / 3 inputs from HsrCharacter.rarity: 4★ count, and the eidolon total of the 5★ characters. */
export function rarityInputs(ctx: any, draft: TeamDraft): { fourStarCount: number; fiveStarEidolons: number } {
    let fourStarCount = 0;
    let fiveStarEidolons = 0;
    for (const { name, eidolon } of draft.eidolons) {
        const rarity = ctx.db.HsrCharacter.name.find(name)?.rarity;
        if (rarity === 4) fourStarCount++;
        else if (rarity === 5) fiveStarEidolons += eidolon;
    }
    return { fourStarCount, fiveStarEidolons };
}

export function findGame(ctx: any, matchResultId: number, gameNumber: number): any {
    return [...ctx.db.MatchResultGame.by_result_and_game.filter([matchResultId, gameNumber])][0];
}

/** MatchResultGame has a decorative composite key: replace the row (delete + insert), keeping its audit. */
export function replaceGame(ctx: any, existing: any, changes: Record<string, unknown>, actorId: number): void {
    ctx.db.MatchResultGame.delete(existing);
    ctx.db.MatchResultGame.insert({ ...existing, ...changes, ...auditUpdate(ctx, existing, actorId) });
}

/** Creates the game row (no scores, winner undecided = Spectator) when it does not exist yet. */
export function ensureGame(ctx: any, record: any, lobby: any, gameNumber: number, actorId: number): any {
    const existing = findGame(ctx, record.id, gameNumber);
    if (existing) return existing;
    return ctx.db.MatchResultGame.insert(insertWithAudit(ctx, {
        matchResultId: record.id,
        gameNumber,
        gameMode: lobby.gameMode,
        teamBlueScreenshotUrl: undefined,
        teamRedScreenshotUrl: undefined,
        teamBlueCyclesUsed: undefined,
        teamRedCyclesUsed: undefined,
        teamBlueScore: undefined,
        teamRedScore: undefined,
        teamBlueDeaths: 0,
        teamRedDeaths: 0,
        teamBlueAdjustedResult: undefined,
        teamRedAdjustedResult: undefined,
        tieBreakLevel: undefined,
        winnerTeamSide: teamSideValue('Spectator'),
        validationStatus: { tag: 'Pending', value: {} },
        validatedByUserId: undefined,
    }, actorId));
}

/** Group values of one side, by groupIndex, or null until every group of the format has a row. */
function sideValues(rows: any[], side: TeamTag, groups: number): number[] | null {
    const values: Array<number | undefined> = new Array(groups).fill(undefined);
    for (const r of rows) if (r.teamSide.tag === side && r.groupIndex < groups) values[r.groupIndex] = r.value;
    return values.every((v) => v !== undefined) ? (values as number[]) : null;
}

/**
 * Recomputes one game from its inputs and stores the result on the MatchResultGame row (A21 "stored
 * computation"): the raw team totals in the mode's per-team column (cycles → team*CyclesUsed, points →
 * team*Score, hundredths; A56(2)), the adjusted results, the tie-break level and the winner. A side whose groups
 * are incomplete keeps undefined totals; until both are complete the outcome stays undecided (Spectator).
 * Needs the game's steps (tie-breaks 2 and 3), so callers only recompute the game being played.
 * Returns the shared module's result, or null while the scores are incomplete.
 */
export function recomputeGame(ctx: any, record: any, lobby: any, gameNumber: number, actorId: number) {
    const game = findGame(ctx, record.id, gameNumber);
    if (!game) return null;
    const mode = lobby.gameMode.tag as GameModeTag;
    const groups = groupCount(lobby.lineupFormat.tag as LineupFormatTag);
    const rows = [...ctx.db.MatchResultGroupScore.by_result_game.filter([record.id, gameNumber])];
    const adjustments = [...ctx.db.MatchResultAdjustment.by_result_game.filter([record.id, gameNumber])];
    const blueValues = sideValues(rows, 'Blue', groups);
    const redValues = sideValues(rows, 'Red', groups);
    const total = (v: number[] | null) => (v ? v.reduce((a, b) => a + b, 0) : undefined);
    const cycles = lowerWins(mode);
    const rawColumns = {
        teamBlueCyclesUsed: cycles ? total(blueValues) : undefined,
        teamRedCyclesUsed: cycles ? total(redValues) : undefined,
        teamBlueScore: !cycles && blueValues ? BigInt(total(blueValues)!) : undefined,
        teamRedScore: !cycles && redValues ? BigInt(total(redValues)!) : undefined,
    };

    let result: ReturnType<typeof scoreGame> | null = null;
    if (blueValues && redValues) {
        const team = (side: TeamTag, values: number[], deaths: number) => {
            const draft = teamDraft(ctx, lobby.id, gameNumber, side);
            return {
                groupValues: values,
                modifiers: adjustments.filter((a: any) => a.teamSide.tag === side).map((a: any) => a.value),
                deaths,
                rosterCost: teamRosterCost(ctx, lobby, gameNumber, side, draft),
                ...rarityInputs(ctx, draft),
            };
        };
        result = scoreGame(
            mode,
            handicapSettings(lobby),
            team('Blue', blueValues, game.teamBlueDeaths),
            team('Red', redValues, game.teamRedDeaths),
        );
    }
    replaceGame(ctx, game, {
        ...rawColumns,
        teamBlueAdjustedResult: result?.blue.adjusted,
        teamRedAdjustedResult: result?.red.adjusted,
        tieBreakLevel: result?.tieBreakLevel,
        winnerTeamSide: teamSideValue(result?.winner ?? 'Spectator'),
    }, actorId);
    return result;
}

/** Any change to scores or adjustments resets both captains' confirmations (A21). */
export function resetConfirmations(ctx: any, record: any, actorId: number): void {
    if (!record.blueConfirmed && !record.redConfirmed) return;
    ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, record, { blueConfirmed: false, redConfirmed: false }, actorId));
}

/** True when the stored outcome of the game is an unresolved tie (level 4). */
export const isUnresolvedTie = (game: any) => game.tieBreakLevel === TIE_BREAK_UNRESOLVED;

/**
 * MatchSessionHistory.handicapApplied (A21, hundredths): the net handicap advantage Blue received over Red,
 * summed over the scored games. Per team, the handicap is adjusted − (raw + modifiers), turned back into an
 * advantage (fewer cycles / more points is positive). Positive favours Blue. Modifiers are not handicaps.
 */
export function netHandicapApplied(ctx: any, matchResultId: number, games: any[], mode: GameModeTag): number {
    let net = 0;
    for (const g of games) {
        if (g.teamBlueAdjustedResult === undefined || g.teamRedAdjustedResult === undefined) continue;
        const adjustments = [...ctx.db.MatchResultAdjustment.by_result_game.filter([matchResultId, g.gameNumber])];
        const mods = (side: TeamTag) => adjustments.filter((a: any) => a.teamSide.tag === side).reduce((s: number, a: any) => s + a.value, 0);
        const raw = (side: TeamTag) => Number(lowerWins(mode)
            ? (side === 'Blue' ? g.teamBlueCyclesUsed : g.teamRedCyclesUsed) ?? 0
            : (side === 'Blue' ? g.teamBlueScore : g.teamRedScore) ?? 0n);
        // advantageToDelta is its own inverse (a sign flip in cycle modes).
        const advantage = (side: TeamTag, adjusted: number) => advantageToDelta(mode, adjusted - raw(side) - mods(side));
        net += advantage('Blue', g.teamBlueAdjustedResult) - advantage('Red', g.teamRedAdjustedResult);
    }
    return net;
}

/**
 * A56(3): deletes the scoring inputs of a result record (MatchResultGroupScore, MatchResultAdjustment) and the
 * lobby's live lineups (MatchLineup, every game). Called on both exits of a match: runFinalization's cleanup and
 * hardDeleteLobby (lobby GC / close).
 */
export function deleteScoringRows(ctx: any, matchResultId: number, lobbyId: number): void {
    for (const g of lobbyGameNumbers(ctx, lobbyId)) {
        for (const r of [...ctx.db.MatchResultGroupScore.by_result_game.filter([matchResultId, g])]) ctx.db.MatchResultGroupScore.id.delete(r.id);
        for (const a of [...ctx.db.MatchResultAdjustment.by_result_game.filter([matchResultId, g])]) ctx.db.MatchResultAdjustment.id.delete(a.id);
        for (const l of [...ctx.db.MatchLineup.by_lobby_game.filter([lobbyId, g])]) ctx.db.MatchLineup.id.delete(l.id);
    }
}
