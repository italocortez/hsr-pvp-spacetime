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
import { isRoleAtLeast } from './ensurePermissions';
import { slotIsCoach, slotTeam } from './lobbyHelpers';
import { currentGameSteps } from './stepSequence';

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

/**
 * A54 (S8d): a lobby has one MatchResultRecord, created by start_draft; concede and defer update it in place. Returns
 * that record, or undefined before start_draft. (A rolled-back tournament record is Voided and its lobby deleted, so
 * it never shares a lobby id with a live record.)
 */
export function findLobbyResult(ctx: any, lobbyId: number): any {
    return [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];
}

/** The lobby's result record when it still takes scores (Pending; A54: the one record of the lobby). */
export function findPendingResult(ctx: any, lobbyId: number): any {
    const record = findLobbyResult(ctx, lobbyId);
    if (!record || record.status.tag !== 'Pending') throw new SenderError('No pending match result for this lobby.');
    return record;
}

/**
 * A60(7): the record an edit reducer works on (A54: the lobby's one record). Pending always; with allowSubmitted (the
 * caller is an Admin) a Submitted record too, so an Admin can still correct a closed game of a ranked series awaiting
 * force-finalize.
 */
export function findEditableResult(ctx: any, lobbyId: number, allowSubmitted: boolean): any {
    const record = findLobbyResult(ctx, lobbyId);
    const editable = record && (record.status.tag === 'Pending' || (allowSubmitted && record.status.tag === 'Submitted'));
    if (!editable) throw new SenderError('No pending match result for this lobby.');
    return record;
}

/** A60(7): role Admin exactly (not Moderator). */
export const isAdminRole = (user: any) => user?.role?.tag === 'Admin';

/**
 * A60(3)/(7): the open-game rule shared by every edit reducer. 'open' when the game row does not exist yet or is
 * not closed (closedAt unset); 'admin' when the game is closed, the caller's role is Admin and the record is
 * Pending or Submitted (the edit then keeps the game closed, does not reset confirmations and ends with
 * recomputeSeriesAfterAdminEdit). Anyone else is rejected on a closed game, Moderators included.
 */
export function ensureOpenGame(ctx: any, lobby: any, record: any, gameNumber: number, user: any): 'open' | 'admin' {
    const game = findGame(ctx, record.id, gameNumber);
    const editable = record.status.tag === 'Pending' || record.status.tag === 'Submitted';
    if (!game || game.closedAt === undefined) {
        if (record.status.tag !== 'Pending') throw new SenderError('No pending match result for this lobby.');
        return 'open';
    }
    if (editable && isAdminRole(user)) return 'admin';
    if (editable) throw new SenderError('This game is closed.');
    throw new SenderError('This match is finalized.');
}

/**
 * A39 staff set (A60(4)): a lobby referee (seated or spectator), Moderator+ anywhere, or in a tournament lobby the
 * organizer or an assistant with canResolveResults. Returns the caller's member row (if any) and whether the caller
 * is staff beyond the referee seat (isStaff); throws with `message` otherwise. Shared by set_score_adjustment and
 * close_game.
 */
export function ensureResultAuthority(ctx: any, lobby: any, user: any, message: string): { member: any; isReferee: boolean; isStaff: boolean } {
    const authority = resultAuthority(ctx, lobby, user);
    if (!authority.isReferee && !authority.isStaff) throw new SenderError(message);
    return authority;
}

/** The non-throwing lookup behind ensureResultAuthority (close_game also admits captains, A63). */
export function resultAuthority(ctx: any, lobby: any, user: any): { member: any; isReferee: boolean; isStaff: boolean } {
    const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobby.id, user.id])][0];
    const isReferee = !!member?.isReferee;
    let isStaff = isRoleAtLeast(user.role, 'Moderator');
    if (!isStaff && lobby.isTournamentControlled && lobby.tournamentId !== undefined) {
        const tournament = ctx.db.Tournament.id.find(lobby.tournamentId);
        if (tournament && tournament.organizerId === user.id) isStaff = true;
        const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([lobby.tournamentId, user.id])][0];
        if (assistant?.canResolveResults) isStaff = true; // A25
    }
    return { member, isReferee, isStaff };
}

export interface TeamDraft {
    characters: string[];
    /**
     * Hundredths, the character's roster cost at its current eidolon. Classic: the latest SetEidolon.costPaid, else
     * Pick.costPaid (the cost-set price at the level). Auction (A61(7)): AuctionSold.winningAmount plus the eidolon
     * extra (the latest SetEidolon.costPaid, else AuctionSold.eidolonCost).
     */
    characterCosts: number[];
    /** Hundredths, the light cones still equipped (A60; S8d: an UnequipLightcone step removes the latest one of its character). */
    lightconeCosts: number[];
    /**
     * CH-S6 / D.8.7, A60(1): the eidolon the scoring uses (tie-break 3): the latest SetEidolon step of the character
     * for that side in that game, else the level recorded in the Pick / AuctionSold payload.
     */
    eidolons: Array<{ name: string; eidolon: number }>;
}

export interface EquippedLightcone { characterName: string; lightconeName: string; costPaid: number; sequence: number }

/**
 * The light cones a side still has equipped in a game, in equip order, from sorted steps: every EquipLightcone step of
 * the side, minus, per UnequipLightcone step, the latest earlier equip of that character (S7b hand-off, S8d).
 */
function equippedFromSteps(steps: any[], side: TeamTag): EquippedLightcone[] {
    const equipped: EquippedLightcone[] = [];
    for (const step of steps) {
        if (step.actorSlot.tag !== side) continue;
        if (step.payload.tag === 'EquipLightcone') {
            const v = step.payload.value;
            equipped.push({ characterName: v.characterName, lightconeName: v.lightconeName, costPaid: v.costPaid, sequence: step.sequence });
        } else if (step.payload.tag === 'UnequipLightcone') {
            for (let i = equipped.length - 1; i >= 0; i--) {
                if (equipped[i].characterName === step.payload.value.characterName) { equipped.splice(i, 1); break; }
            }
        }
    }
    return equipped;
}

/** The light cones `side` still has equipped in game `gameNumber` of the lobby (unequip_lightcone's input). */
export function equippedLightcones(ctx: any, lobbyId: number, gameNumber: number, side: TeamTag): EquippedLightcone[] {
    const steps = currentGameSteps(ctx, lobbyId, gameNumber).sort((a: any, b: any) => a.sequence - b.sequence);
    return equippedFromSteps(steps, side);
}

/**
 * The team's draft for one game, read from that game's steps (the step payloads are the snapshot, D.8.7). A60:
 * eidolon edits are SetEidolon steps (actorSlot = the team); the latest one per character wins (highest sequence).
 * A65(2): the read filters by gameNumber (every game's steps stay until finalization).
 */
export function teamDraft(ctx: any, lobbyId: number, gameNumber: number, side: TeamTag): TeamDraft {
    const draft: TeamDraft = { characters: [], characterCosts: [], lightconeCosts: [], eidolons: [] };
    const steps = currentGameSteps(ctx, lobbyId, gameNumber)
        .sort((a: any, b: any) => a.sequence - b.sequence);
    const latestEdit = new Map<string, { eidolon: number; costPaid: number; sequence: number }>();
    for (const step of steps) {
        if (step.payload.tag === 'SetEidolon' && step.actorSlot.tag === side) {
            latestEdit.set(step.payload.value.characterName, { ...step.payload.value, sequence: step.sequence });
        }
    }
    for (const step of steps) {
        const p = step.payload;
        if (p.tag === 'Pick' && step.action.tag === 'Pick' && step.actorSlot.tag === side) {
            // Only an edit after this pick counts (an undone pick leaves its edits behind; a re-pick starts fresh).
            const found = latestEdit.get(p.value.characterName);
            const edit = found && found.sequence > step.sequence ? found : undefined;
            draft.characters.push(p.value.characterName);
            draft.characterCosts.push(toHundredths(edit ? edit.costPaid : p.value.costPaid));
            draft.eidolons.push({ name: p.value.characterName, eidolon: edit ? edit.eidolon : p.value.eidolon });
        } else if (p.tag === 'AuctionSold' && p.value.winningTeam.tag === side) {
            const edit = latestEdit.get(p.value.characterName);
            draft.characters.push(p.value.characterName);
            draft.characterCosts.push(toHundredths(p.value.winningAmount) + toHundredths(edit ? edit.costPaid : p.value.eidolonCost));
            draft.eidolons.push({ name: p.value.characterName, eidolon: edit ? edit.eidolon : p.value.eidolon });
        }
    }
    draft.lightconeCosts = equippedFromSteps(steps, side).map((e) => toHundredths(e.costPaid));
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
 * Tie-break 1 / handicap input: always live, from the game's steps (picks, sold characters, eidolon edits, equipped
 * light cones) plus the surcharge of the current arrangement (none without a lineup row).
 */
export function teamRosterCost(ctx: any, lobby: any, gameNumber: number, side: TeamTag, draft: TeamDraft): number {
    const lineup = findLineup(ctx, lobby.id, gameNumber, side);
    return lineupCosts(ctx, lobby, draft, lineup ? JSON.parse(lineup.groups) : null).rosterCost;
}

/**
 * equip_lightcone / set_eidolon hook: after a light cone or an eidolon changes, the side's lineup row (if any) gets
 * the new roster cost and surcharge.
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
        blueConfirmed: false,
        redConfirmed: false,
        closedAt: undefined,
        closedById: undefined,
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

/**
 * A60(2): every edit of an open game (scores, adjustments, eidolons, light cones, lineup) resets both captains'
 * confirmations of that game. Works on the game row; a no-op when neither flag is set.
 */
export function resetConfirmations(ctx: any, game: any, actorId: number): void {
    if (!game || (!game.blueConfirmed && !game.redConfirmed)) return;
    replaceGame(ctx, game, { blueConfirmed: false, redConfirmed: false }, actorId);
}

/** True when the stored outcome of the game is an unresolved tie (level 4). */
export const isUnresolvedTie = (game: any) => game.tieBreakLevel === TIE_BREAK_UNRESOLVED;

/** A closed game (A60(3)): closedAt set by close_game (a captain once both flags are set, or staff; A63). */
export const isClosedGame = (game: any) => game?.closedAt !== undefined;

/**
 * A60(4) Auction gate: a team's synergy surcharge (its lineup row, hundredths) must fit its remaining budget
 * (character + light-cone budget; after the D-50 rollover the character budget is 0). Replaces the S7 surcharge
 * reservation in equip_lightcone. No-op in Classic.
 */
export function ensureAuctionSurchargeFits(ctx: any, lobby: any, session: any, gameNumber: number, side: TeamTag): void {
    if (lobby.draftMode.tag !== 'Auction') return;
    const lineup = findLineup(ctx, lobby.id, gameNumber, side);
    const remaining = side === 'Blue'
        ? session.teamBlueCharBudget + session.teamBlueLcBudget
        : session.teamRedCharBudget + session.teamRedLcBudget;
    if (lineup && lineup.synergySurcharge > toHundredths(remaining)) {
        throw new SenderError('The synergy surcharge exceeds the remaining budget; rearrange the lineup.');
    }
}

/** System chat line in the lobby (D-11), keeping the 50-message rolling window. */
export function postSystemChat(ctx: any, lobbyId: number, content: string, actorId: number): void {
    const existing = [...ctx.db.ChatMessage.lobby_id.filter(lobbyId)];
    if (existing.length >= 50) {
        const oldest = [...existing].sort((a: any, b: any) => a.id - b.id)[0];
        ctx.db.ChatMessage.id.delete(oldest.id);
    }
    ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
        id: 0, // autoInc
        lobbyId,
        senderUserId: 0,
        senderType: { tag: 'System', value: {} } as any,
        content,
        metadata: undefined,
        anonymousLabel: undefined,
    }, actorId));
}

/**
 * A60(3)/(6), A27: the series tally = wins over the record's **closed** games plus the lobby's head start
 * (Lobby.bestOfNAdvantage). decided = a side reached ceil(seriesBestOf / 2).
 */
export function seriesTally(ctx: any, record: any, lobby: any, seriesBestOf: number): { blue: number; red: number; decided: boolean } {
    let blue = lobby.bestOfNAdvantage?.tag === 'Blue' ? 1 : 0;
    let red = lobby.bestOfNAdvantage?.tag === 'Red' ? 1 : 0;
    for (const g of ctx.db.MatchResultGame.match_result_id.filter(record.id)) {
        if (!isClosedGame(g)) continue;
        if (g.winnerTeamSide.tag === 'Blue') blue++;
        else if (g.winnerTeamSide.tag === 'Red') red++;
    }
    const winsNeeded = Math.ceil(seriesBestOf / 2);
    return { blue, red, decided: blue >= winsNeeded || red >= winsNeeded };
}

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
