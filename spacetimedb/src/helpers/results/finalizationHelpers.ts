// ─── Finalization Pipeline Helpers ────────────────────────────────────────────
// Shared 19-step finalization logic callable by finalize_match_result and admin_force_finalize (standalone ranked),
// submitGameResult and performConcede (casual auto-finalize per D-37; S7b replaced submit_match_result) and, for
// tournament records, only the run_tournament_finalize job (A24(4)(7), S8d).

import { SenderError } from 'spacetimedb/server';
import { auditInsert, auditUpdate } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import type { MmrRating } from '@bindings/types';
import { getKFactor, calculateExpectedScore, calculateRatingChange, calculateTeamEffective, calculateAccountModifier } from '@module/helpers/stats/eloCalculation';
import type { EloConfigValues } from '@module/helpers/stats/eloCalculation';
import { incrementPlayerStat, incrementPlayerRelationship } from '@module/helpers/stats/statsIncrement';
import { incrementPlayerCharacterStat, incrementBanStat, incrementFacedStat } from '@module/helpers/stats/characterStatsIncrement';
import { incrementGlobalCharacterStat } from '@module/helpers/stats/globalCharacterStatsIncrement';
import { rebuildLeaderboard } from '@module/helpers/stats/leaderboardRebuild';
import { checkAndAwardAchievements } from '@module/helpers/stats/achievementChecker';
import { slotIsCoach, slotIsSpectator, slotToTeamSide } from '@module/helpers/lobby/lobbyHelpers';
import { resolveUserLabel } from '@module/helpers/identity/userLabel';
import { hardDeleteLobby } from '@module/reducers/lobby/lobbyGc';
import { deleteScoringRows, lobbyLineups, netHandicapApplied } from './scoringHelpers';

// ─── Internal: getOrCreateRating ─────────────────────────────────────────────
// Returns existing MmrRating row for user+mode+season, or creates a new one.

function getOrCreateRating(ctx: any, userId: number, gameMode: any, seasonId: number, initialRating: number, actingUserId: number): any {
    const existing = [...ctx.db.MmrRating.by_user_mode_season.filter([userId, gameMode, seasonId])][0];
    if (existing) return existing;

    const newRow: MmrRating = insertWithAudit(ctx, {
        userId,
        gameMode,
        rating: initialRating,
        matchesPlayed: 0,
        globalCompositeRating: undefined,
        seasonId,
    }, actingUserId);
    ctx.db.MmrRating.insert(newRow);
    return { ...newRow };
}

// ─── Internal: processMatchMmr ───────────────────────────────────────────────
// Pure MMR processing for a single match.

export function processMatchMmr(
    ctx: any,
    matchResult: any,
    participants: any[],
    gameMode: any,
    seasonId: number,
    matchHistoryId: number,
    actingUserId: number
): void {
    // 1. Read EloConfig
    const config = ctx.db.EloConfigTable.id.find(1);
    if (!config) {
        throw new SenderError('ELO config not initialized. Call admin_seed_elo_config first.');
    }

    const cv: EloConfigValues = {
        kFactorNew: config.kFactorNew,
        kFactorMid: config.kFactorMid,
        kFactorVet: config.kFactorVet,
        newThreshold: config.newThreshold,
        midThreshold: config.midThreshold,
        initialRating: config.initialRating,
        sizeBonus: config.sizeBonus,
        spreadDivisor: config.spreadDivisor,
        maxAccountBonus: config.maxAccountBonus,
    };

    // 2. Separate participants by team
    const blueParticipants = participants.filter((p: any) => p.teamSide.tag === 'Blue');
    const redParticipants = participants.filter((p: any) => p.teamSide.tag === 'Red');

    // 3. Get or create MmrRating for each participant
    const blueRatings = blueParticipants.map((p: any) =>
        getOrCreateRating(ctx, p.userId, gameMode, seasonId, cv.initialRating, actingUserId).rating
    );
    const redRatings = redParticipants.map((p: any) =>
        getOrCreateRating(ctx, p.userId, gameMode, seasonId, cv.initialRating, actingUserId).rating
    );

    // 4. Calculate team effective ratings
    let blueEffective = calculateTeamEffective(blueRatings, cv.sizeBonus, cv.spreadDivisor);
    let redEffective = calculateTeamEffective(redRatings, cv.sizeBonus, cv.spreadDivisor);

    // 5. Apply account rating modifier (Fair MMR always in Phase 5)
    // D-readpath-01 (Phase 12.3): read the persisted snapshot from MRP instead of
    // re-querying HsrAccount.isActive. The snapshot was captured at start_draft
    // (draftClassic.ts line ~204) with the max-across-LMA rule, so post-capture
    // mutations to isActive or accountRating cannot affect the ELO delta here.
    // D-readpath-02: runFinalization step 11 is the only caller, for standalone Ranked matches and (S8d) for
    // tournament records inside the run_tournament_finalize job.
    const blueAccountRatings = blueParticipants.map((p: any) => p.accountRatingSnapshot);
    const redAccountRatings = redParticipants.map((p: any) => p.accountRatingSnapshot);

    const blueAvgAccount = blueAccountRatings.length > 0
        ? blueAccountRatings.reduce((a: number, b: number) => a + b, 0) / blueAccountRatings.length
        : 0;
    const redAvgAccount = redAccountRatings.length > 0
        ? redAccountRatings.reduce((a: number, b: number) => a + b, 0) / redAccountRatings.length
        : 0;

    if (blueAvgAccount > redAvgAccount) {
        blueEffective += calculateAccountModifier(blueAvgAccount, redAvgAccount, cv.maxAccountBonus);
    } else if (redAvgAccount > blueAvgAccount) {
        redEffective += calculateAccountModifier(redAvgAccount, blueAvgAccount, cv.maxAccountBonus);
    }

    // 6. Determine actual result (per D-30/D-33 — compare teamSide tags to winnerTeamSide)
    let blueActualResult: number;
    let redActualResult: number;

    if (matchResult.winnerTeamSide === undefined) {
        blueActualResult = 0.5;
        redActualResult = 0.5;
    } else if (matchResult.winnerTeamSide.tag === 'Blue') {
        blueActualResult = 1;
        redActualResult = 0;
    } else {
        blueActualResult = 0;
        redActualResult = 1;
    }

    // 7. For each participant, calculate and apply rating change
    for (const participant of participants) {
        const playerRating = getOrCreateRating(ctx, participant.userId, gameMode, seasonId, cv.initialRating, actingUserId);
        const isBlue = participant.teamSide.tag === 'Blue';
        const playerEffective = isBlue ? blueEffective : redEffective;
        const opponentEffective = isBlue ? redEffective : blueEffective;
        const expected = calculateExpectedScore(playerEffective, opponentEffective);
        const k = getKFactor(playerRating.matchesPlayed, cv);
        const actualResult = isBlue ? blueActualResult : redActualResult;
        const delta = calculateRatingChange(k, actualResult, expected);
        const newRating = Math.max(0, playerRating.rating + delta);

        // Update MmrRating (delete + insert for composite PK)
        const currentRating = [...ctx.db.MmrRating.by_user_mode_season.filter([participant.userId, gameMode, seasonId])][0];
        if (currentRating) {
            ctx.db.MmrRating.delete(currentRating);
        }
        ctx.db.MmrRating.insert({
            userId: participant.userId,
            gameMode,
            rating: newRating,
            matchesPlayed: (currentRating?.matchesPlayed ?? 0) + 1,
            globalCompositeRating: currentRating?.globalCompositeRating,
            seasonId,
            ...(currentRating ? auditUpdate(ctx, currentRating, actingUserId) : auditInsert(ctx, actingUserId)),
        } as any);

        // Update globalCompositeRating
        const allRatings = [...ctx.db.MmrRating.user_id.filter(participant.userId)];
        if (allRatings.length > 0) {
            const avgRating = Math.round(allRatings.reduce((sum: number, r: any) => sum + r.rating, 0) / allRatings.length);
            for (const r of allRatings) {
                ctx.db.MmrRating.delete(r);
                ctx.db.MmrRating.insert({
                    ...r,
                    globalCompositeRating: avgRating,
                    ...auditUpdate(ctx, r, actingUserId),
                } as any);
            }
        }

        // Insert MmrHistory row
        ctx.db.MmrHistory.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            userId: participant.userId,
            gameMode,
            matchHistoryId,
            previousRating: playerRating.rating,
            newRating,
            delta,
            seasonId,
        }, actingUserId));
    }
}

// ─── runFinalization ─────────────────────────────────────────────────────────
// The numbered pipeline (steps 1-18, with 16.5; header line 2 counts it as 19): reads ephemeral data, archives to history, increments all
// stats, processes MMR (if applicable), deletes ephemeral.
// A24 (S8d): a tournament record reaches this only through run_tournament_finalize, which passes
// options.tournamentMmr (true when the tournament counts toward MMR and is Completed, false when Cancelled, A24(5)).
// The bracket was settled when the record was validated or conceded (A24(1)); nothing here touches it.

export interface FinalizationOptions {
    /** S8d job: process MMR for this tournament record (Ranked record of a Completed countTowardsMmr tournament). */
    tournamentMmr?: boolean;
}

export function runFinalization(
    ctx: any,
    matchResult: any,
    actingUserId: number,
    options: FinalizationOptions = {},
): void {
    // ── Reads (1-6) ──────────────────────────────────────────────────────────

    // 1. Read participants
    const participants = [...ctx.db.MatchResultParticipant.match_result_id.filter(matchResult.id)];

    // 2. Read games (A67(3): at most one row, the record's game)
    const games = [...ctx.db.MatchResultGame.match_result_id.filter(matchResult.id)];

    // 3. Read lobby
    const lobby = ctx.db.Lobby.id.find(matchResult.lobbyId);

    // 3b. Read match session (for budget analysis in step 7, D-88)
    const session = ctx.db.MatchSession.lobbyId.find(matchResult.lobbyId);

    // 3c. A56: the match's lineups (MatchLineup is keyed by lobby; A67(3): one game)
    const lineups = lobbyLineups(ctx, matchResult.lobbyId);

    // 4. Read steps (A67(3): the lobby's one game), sorted by sequence
    const steps = [...ctx.db.MatchSessionStep.lobby_id.filter(matchResult.lobbyId)]
        .sort((a: any, b: any) => a.sequence - b.sequence);

    // 5. Read active season
    const activeSeason = [...ctx.db.Season.is_active.filter(true)][0];
    const seasonId = activeSeason ? activeSeason.id : 0;

    // 6. Determine match metadata
    const gameMode = lobby?.gameMode ?? games[0]?.gameMode ?? { tag: 'MemoryOfChaos', value: {} };
    const draftMode = lobby?.draftMode ?? { tag: 'Classic', value: {} };
    const matchType = matchResult.matchType;
    const teamSize = lobby ? lobby.teamSize : 1;

    // Determine match end reason (per D-31/D-32/D-33):
    // winnerTeamSide answers WHO won, matchEndReason answers HOW it ended
    // A31: no draws — MatchEndReason.Draw was removed and every path that reaches finalization sets a winner
    // (submitGameResult computes it at the close of the game, concede derives it, admin_force_finalize / override_match_result require one).
    if (matchResult.winnerTeamSide === undefined) {
        throw new SenderError('A result without a winner cannot be finalized (A31: no draws).');
    }
    let matchEndReason: any = { tag: 'Completed', value: {} } as any;

    // ── Concede Detection (D-74) ────────────────────────────────────────────
    const isConcede = matchResult.matchEndReason?.tag === 'Concede';
    if (isConcede) {
        // Override matchEndReason to use what's stored on the record
        matchEndReason = matchResult.matchEndReason;
    }

    // For concede: determine tier and stage flags per finalization matrix (D-77, D-78, D-79)
    // Tier 1: Casual non-tournament (no archive, only Scoring gets win/loss)
    // Tier 2: Casual tournament (archive + win/loss + relationships at all stages, no MMR/char stats)
    // Tier 3: Ranked (archive + win/loss + relationships + MMR + leaderboard + spectated; char stats at Equipping+)
    let concedeFlags: any = null;
    if (isConcede) {
        const isRanked = matchResult.matchType?.tag === 'Ranked';
        const isTournament = matchResult.isTournamentControlled;
        const concedeStage = matchResult.concedeAtStage ?? 'Scoring'; // fallback
        const isCasualNonTournament = !isRanked && !isTournament;
        const isDrafting = concedeStage === 'Drafting';

        concedeFlags = {
            doArchiveSteps: !isCasualNonTournament,           // T2/T3: archive what exists
            doArchiveSession: isRanked,                        // T3 only
            doArchiveParticipants: !isCasualNonTournament,     // T2/T3: always
            doArchiveGames: !isCasualNonTournament,            // T2/T3: archive what exists
            doWinLoss: isCasualNonTournament ? (concedeStage === 'Scoring') : true,  // T1: scoring only, T2/T3: always
            doRelationships: !isCasualNonTournament,           // T2/T3: always
            doCharStats: isRanked && !isDrafting,              // T3: equipping+ only
            doGlobalCharStats: isRanked && !isDrafting,        // T3: equipping+ only
            doMmr: isRanked && (!isTournament || options.tournamentMmr === true), // T3; tournament: the S8d job at Completed
            doLeaderboard: isRanked && !isTournament,          // T3 non-tournament only
            doSpectated: isRanked,                             // T3 only
            doAchievements: false,                             // D-76: ALWAYS skipped for concede
        };
    }

    // D-75: For concede, derive participants from LobbyMember as fallback
    let concedeParticipants = participants;
    if (isConcede && participants.length === 0) {
        const lobbyMembers = [...ctx.db.LobbyMember.lobby_id.filter(matchResult.lobbyId)]
            .filter((m: any) => !slotIsSpectator(m.lobbySlot) && !slotIsCoach(m.lobbySlot));
        concedeParticipants = lobbyMembers.map((m: any) => ({
            userId: m.userId,
            teamSide: slotToTeamSide(m.lobbySlot),
            isCaptain: m.isCaptain,
        }));
    }

    // ── Writes (7-18) ────────────────────────────────────────────────────────

    // 7. Write MatchSessionHistory row (no rosterBlue/rosterRed per D-52/D-57)
    // For concede: only create if archival is needed (T2/T3), skip for T1 casual non-tournament
    let historyRow: any = null;
    if (!isConcede || concedeFlags.doArchiveSteps || concedeFlags.doArchiveSession) {
    historyRow = ctx.db.MatchSessionHistory.insert(insertWithAudit(ctx, {
        id: 0, // autoInc
        lobbyCode: lobby ? lobby.joinCode : 'UNKNOWN',
        playedAt: matchResult.createdDate,
        draftMode: lobby ? lobby.draftMode : { tag: 'Classic', value: {} } as any,
        gameMode,
        teamBlueAlias: lobby ? lobby.teamBlueAlias : 'Blue',
        teamRedAlias: lobby ? lobby.teamRedAlias : 'Red',
        snapshotConfig: lobby ? {
            teamSize: lobby.teamSize,
            draftMode: lobby.draftMode,
            banMode: lobby.banMode,
            lineupFormat: lobby.lineupFormat,
            standardTurnSeconds: lobby.standardTurnSeconds,
            reserveBankSeconds: lobby.reserveBankSeconds,
            characterBudget: lobby.characterBudget,
            lightconeBudget: lobby.lightconeBudget,
            rosterDiffAdvantage: lobby.rosterDiffAdvantage,
            rosterThreshold: lobby.rosterThreshold,
            underThresholdAdvantage: lobby.underThresholdAdvantage,
            aboveThresholdPenalty: lobby.aboveThresholdPenalty,
            deathPenalty: lobby.deathPenalty,
        } : {
            teamSize: 1,
            draftMode: { tag: 'Classic', value: {} } as any,
            banMode: { tag: 'None', value: {} } as any,
            lineupFormat: { tag: 'Halves', value: {} } as any,
            standardTurnSeconds: 60,
            reserveBankSeconds: 120,
            characterBudget: 0,
            lightconeBudget: 0,
            rosterDiffAdvantage: 0,
            rosterThreshold: 0,
            underThresholdAdvantage: 0,
            aboveThresholdPenalty: 0,
            deathPenalty: 0,
        },
        outcome: matchEndReason,
        // D-88: Budget analysis (after carryover: charBudget=0, lcBudget = original LC + leftover char)
        // totalSpent = characterBudget + lightconeBudget - remainingLcBudget (correct carryover math)
        teamBlueSpent: session && lobby ? (lobby.characterBudget + lobby.lightconeBudget - session.teamBlueLcBudget) : 0,
        teamRedSpent: session && lobby ? (lobby.characterBudget + lobby.lightconeBudget - session.teamRedLcBudget) : 0,
        // A21: net handicap advantage Blue received over Red, hundredths, summed over the games (scoringHelpers).
        handicapApplied: netHandicapApplied(ctx, matchResult.id, games, gameMode.tag),
        // A24/A37: tournament linkage instead of the D-84 public-visibility flag (history is never public)
        tournamentId: lobby?.tournamentId,
        bracketMatchId: lobby?.bracketMatchId,
        voidedAt: undefined,
        // A21 / A39: the tie override survives finalization for audit and replay.
        winnerOverride: matchResult.winnerOverride,
        winnerOverrideById: matchResult.winnerOverrideById,
        winnerOverrideReason: matchResult.winnerOverrideReason,
    }, actingUserId));
    } // end step 7 concede gate

    // Select participant list: use concedeParticipants for concede paths (D-75 fallback)
    const effectiveParticipants = isConcede ? concedeParticipants : participants;

    // 8. Write MatchSessionStepHistory rows (per D-50/D-54/D-86/D-90)
    if (!isConcede || concedeFlags.doArchiveSteps) {
        if (historyRow) {
            for (const step of steps) {
                let targetName: string | undefined;
                if (step.payload) {
                    const tag = step.payload.tag;
                    if (tag === 'Pick' || tag === 'Ban' || tag === 'AuctionSold' || tag === 'Nominate' || tag === 'SetEidolon') {
                        targetName = step.payload.value?.characterName;
                    } else if (tag === 'Bid') {
                        targetName = step.payload.value?.targetCharacter;
                    } else if (tag === 'EquipLightcone' || tag === 'UnequipLightcone') {
                        targetName = step.payload.value?.lightconeName;
                    }
                }
                ctx.db.MatchSessionStepHistory.insert(insertWithAudit(ctx, {
                    matchHistoryId: historyRow.id,
                    sequence: step.sequence, // PK [matchHistoryId, sequence] (A67(3))
                    actorUserId: step.actorUserId,
                    actorDisplayName: resolveUserLabel(ctx, step.actorUserId).displayName,
                    teamSide: step.actorSlot,
                    action: step.action,
                    targetName,
                    payload: step.payload ? JSON.stringify(step.payload) : undefined,
                }, actingUserId));
            }
        }
    }

    // 9. Write MatchResultGameHistory rows (per D-51)
    if (!isConcede || concedeFlags.doArchiveGames) {
        if (historyRow) {
            for (const game of games) {
                ctx.db.MatchResultGameHistory.insert(insertWithAudit(ctx, {
                    matchHistoryId: historyRow.id, // PK (A67(3): one game per match)
                    gameMode: game.gameMode,
                    teamBlueScreenshotUrl: game.teamBlueScreenshotUrl,
                    teamRedScreenshotUrl: game.teamRedScreenshotUrl,
                    teamBlueCyclesUsed: game.teamBlueCyclesUsed,
                    teamRedCyclesUsed: game.teamRedCyclesUsed,
                    teamBlueScore: game.teamBlueScore,
                    teamRedScore: game.teamRedScore,
                    teamBlueDeaths: game.teamBlueDeaths,
                    teamRedDeaths: game.teamRedDeaths,
                    teamBlueAdjustedResult: game.teamBlueAdjustedResult,
                    teamRedAdjustedResult: game.teamRedAdjustedResult,
                    tieBreakLevel: game.tieBreakLevel,
                    winnerTeamSide: game.winnerTeamSide,
                }, actingUserId));
            }
        }
    }

    // 9b. A56(1): write MatchLineupHistory rows (every lineup of the match), next to the game row.
    if (!isConcede || concedeFlags.doArchiveGames) {
        if (historyRow) {
            for (const lineup of lineups) {
                ctx.db.MatchLineupHistory.insert(insertWithAudit(ctx, {
                    id: 0,
                    matchHistoryId: historyRow.id,
                    teamSide: lineup.teamSide,
                    groups: lineup.groups,
                    synergySurcharge: lineup.synergySurcharge,
                    rosterCost: lineup.rosterCost,
                }, actingUserId));
            }
        }
    }

    // 10. Write MatchParticipantHistory per participant (per D-53/D-87)
    if (!isConcede || concedeFlags.doArchiveParticipants) {
        if (historyRow) {
            for (const p of effectiveParticipants) {
                const memberRow = [...ctx.db.LobbyMember.by_lobby_and_user.filter([matchResult.lobbyId, p.userId])][0];
                ctx.db.MatchParticipantHistory.insert(insertWithAudit(ctx, {
                    userId: p.userId,
                    matchHistoryId: historyRow.id,
                    teamSide: p.teamSide,
                    displayName: resolveUserLabel(ctx, p.userId).displayName,
                    isReferee: memberRow ? memberRow.isReferee : false,
                    isCoach: memberRow ? slotIsCoach(memberRow.lobbySlot) : false,
                    isCaptain: p.isCaptain,
                }, actingUserId));
            }
        }
    }

    // 11. Process MMR — standalone Ranked, or a tournament record when the S8d job asks for it (A24(4)(5)); the
    //     history row exists by now, so MmrHistory gets the real matchHistoryId (the old sentinel back-fill is gone)
    if (!isConcede || concedeFlags.doMmr) {
        if (matchResult.matchType.tag === 'Ranked' && (!matchResult.isTournamentControlled || options.tournamentMmr === true)) {
            processMatchMmr(ctx, matchResult, effectiveParticipants, gameMode, seasonId, historyRow ? historyRow.id : 0, actingUserId);
            // Stamp mmrProcessedAt
            const freshResult = ctx.db.MatchResultRecord.id.find(matchResult.id)!;
            ctx.db.MatchResultRecord.id.update(
                updateWithAudit(ctx, freshResult, { mmrProcessedAt: ctx.timestamp }, actingUserId),
            );
        }
    }

    // 12. (removed in S8d: the tournament MMR batch and its matchHistoryId = 0 sentinel back-fill are gone; step 11
    //     runs inside the job with the history row in hand)

    // 13. Increment PlayerStat per participant (per D-30: compare teamSide tags to winnerTeamSide)
    if (!isConcede || concedeFlags.doWinLoss) {
        for (const p of effectiveParticipants) {
            const participantWon = matchResult.winnerTeamSide.tag === p.teamSide.tag; // A31: always a winner
            incrementPlayerStat(ctx, p.userId, gameMode, draftMode, seasonId, matchType, teamSize, participantWon, actingUserId);
        }
    }

    // S9b (R2(3), A37): rebuildLeaderboard stamps SYSTEM_USER_ID on the public Leaderboard rows itself (actingUserId
    // may be a player in an anonymous lobby) and keeps the top 20 per category (A40, A44(2)).
    // 13b. Rebuild leaderboard after PlayerStat increments (reads PlayerStat.wins); tournament records: the S8d job
    //      rebuilds it once when the tournament is done
    if (!isConcede || concedeFlags.doLeaderboard) {
        if (matchResult.matchType.tag === 'Ranked' && !matchResult.isTournamentControlled) {
            rebuildLeaderboard(ctx, seasonId);
        }
    }

    // 14. Increment matchesSpectated for spectators
    if (!isConcede || concedeFlags.doSpectated) {
        const spectators = [...ctx.db.LobbyMember.lobby_id.filter(matchResult.lobbyId)]
            .filter((m: any) => slotIsSpectator(m.lobbySlot) && !slotIsCoach(m.lobbySlot) && !m.isReferee);
        for (const spec of spectators) {
            incrementSpectatedCount(ctx, spec.userId, gameMode, draftMode, seasonId, matchType, teamSize, actingUserId);
        }
    }

    // 15. Increment PlayerRelationship per participant pair (per D-30: compare teamSide tags)
    if (!isConcede || concedeFlags.doRelationships) {
        for (let i = 0; i < effectiveParticipants.length; i++) {
            for (let j = i + 1; j < effectiveParticipants.length; j++) {
                const a = effectiveParticipants[i];
                const b = effectiveParticipants[j];
                const isAlly = a.teamSide.tag === b.teamSide.tag;
                const aWon = matchResult.winnerTeamSide.tag === a.teamSide.tag;
                const bWon = matchResult.winnerTeamSide.tag === b.teamSide.tag;
                incrementPlayerRelationship(ctx, a.userId, b.userId, gameMode, draftMode, seasonId, matchType, teamSize, isAlly, aWon, actingUserId);
                incrementPlayerRelationship(ctx, b.userId, a.userId, gameMode, draftMode, seasonId, matchType, teamSize, isAlly, bWon, actingUserId);
            }
        }
    }

    // 16. Increment character stats (per D-54, D-30: compare teamSide tags to winnerTeamSide)
    if (!isConcede || concedeFlags.doCharStats) {
        let winnerTeamSideTag: string | undefined = matchResult.winnerTeamSide?.tag;

        for (const step of steps) {
            const actionTag = step.action.tag;
            // Only Pick, AuctionSold and Ban steps are counted below (the Nominate / Bid extraction was dead, S10f).
            let charName: string | undefined;
            if (step.payload) {
                const payloadTag = step.payload.tag;
                if (payloadTag === 'Pick' || payloadTag === 'Ban' || payloadTag === 'AuctionSold') {
                    charName = step.payload.value?.characterName;
                }
            }
            if (!charName) continue;
            // Results audit #3 (S10f): the EMPTY pick / nomination and SKIP ban sentinels are not characters; no stat
            // row of any kind (player, faced, ban, global) is written for them.
            if (charName === 'EMPTY' || charName === 'SKIP') continue;

            const actorTeamSide = step.actorSlot?.tag;

            // A82: an AuctionSold step's actor is the passer or the system (timer sale); the owning side is the sale's
            // winningTeam. Every player of that side (the non-coach participants) gets "played", every player of the
            // other side "faced", the global stat is written once; no row for the system user or a spectator side.
            if (actionTag === 'AuctionSold') {
                const ownerSide = step.payload?.tag === 'AuctionSold' ? step.payload.value?.winningTeam?.tag : undefined;
                if (ownerSide !== 'Blue' && ownerSide !== 'Red') continue;
                const didOwnerWin = winnerTeamSideTag !== undefined && ownerSide === winnerTeamSideTag;
                for (const p of effectiveParticipants) {
                    if (p.teamSide.tag === ownerSide) {
                        incrementPlayerCharacterStat(ctx, p.userId, charName, gameMode, draftMode, seasonId, matchType, teamSize, didOwnerWin, actingUserId);
                    } else if (p.teamSide.tag === 'Blue' || p.teamSide.tag === 'Red') {
                        const didOpponentWin = winnerTeamSideTag !== undefined && p.teamSide.tag === winnerTeamSideTag;
                        incrementFacedStat(ctx, p.userId, charName, gameMode, draftMode, seasonId, matchType, teamSize, didOpponentWin, actingUserId);
                    }
                }
                // S9b (R2(3), A37): the helper stamps SYSTEM_USER_ID on the public GlobalCharacterStat rows.
                incrementGlobalCharacterStat(ctx, charName, gameMode, draftMode, seasonId, matchType, teamSize, true, didOwnerWin);
            }

            if (actionTag === 'Pick') {
                const didActorWin = winnerTeamSideTag !== undefined && actorTeamSide === winnerTeamSideTag;
                // Results audit #3 (S10f): a Classic timer pick (A86 autoRandomPick) is logged with the system actor
                // (actorUserId 0) and actorSlot = the acting team. No player row is written for the system user; the
                // faced rows and the global row are kept, and the global row takes the side from actorSlot exactly as
                // for a manual pick (whose actorSlot is the picker's team).
                if (step.actorUserId !== 0) {
                    incrementPlayerCharacterStat(ctx, step.actorUserId, charName, gameMode, draftMode, seasonId, matchType, teamSize, didActorWin, actingUserId);
                }
                for (const p of effectiveParticipants) {
                    if (p.teamSide.tag !== actorTeamSide) {
                        const didOpponentWin = winnerTeamSideTag !== undefined && p.teamSide.tag === winnerTeamSideTag;
                        incrementFacedStat(ctx, p.userId, charName, gameMode, draftMode, seasonId, matchType, teamSize, didOpponentWin, actingUserId);
                    }
                }
                // S9b (R2(3), A37): the helper stamps SYSTEM_USER_ID on the public GlobalCharacterStat rows.
                incrementGlobalCharacterStat(ctx, charName, gameMode, draftMode, seasonId, matchType, teamSize, true, didActorWin);
            }

            if (actionTag === 'Ban') {
                for (const p of effectiveParticipants) {
                    incrementBanStat(ctx, p.userId, charName, gameMode, draftMode, seasonId, matchType, teamSize, actingUserId);
                }
                // S9b (R2(3), A37): the helper stamps SYSTEM_USER_ID on the public GlobalCharacterStat rows.
                incrementGlobalCharacterStat(ctx, charName, gameMode, draftMode, seasonId, matchType, teamSize, false, false);
            }
        }
    }

    // 16.5. Check and award achievements per participant (D-14, D-76: ALWAYS skipped for concede)
    if (!isConcede || concedeFlags.doAchievements) {
        for (const p of effectiveParticipants) {
            checkAndAwardAchievements(ctx, p.userId); // S9b: SYSTEM award actor (A37)
        }
    }

    // 17. (removed in S8d) Bracket advancement: a tournament record advanced its bracket match when it was validated
    //     or conceded (handOffToBracket, A24(1), A38(1)); finalization of tournament records runs only in the
    //     Completed / Cancelled job, after the bracket is final.

    // 18. Delete ephemeral records (children first, then steps, then record) — always runs
    // A56(3): the scoring inputs and the live lineups never outlive their result record (before the game rows,
    // whose numbers bound the per-game scans).
    deleteScoringRows(ctx, matchResult.id, matchResult.lobbyId);
    for (const g of games) { ctx.db.MatchResultGame.delete(g); }
    for (const p of participants) { ctx.db.MatchResultParticipant.delete(p); }
    // Delete MatchSessionStep rows (archived to history in step 8)
    for (const step of steps) { ctx.db.MatchSessionStep.delete(step); }
    const finalResult = ctx.db.MatchResultRecord.id.find(matchResult.id);
    if (finalResult) { ctx.db.MatchResultRecord.delete(finalResult); }

    // 19. Cascade-delete lobby — always runs
    hardDeleteLobby(ctx, matchResult.lobbyId);

    console.log(`[MATCH] Match result #${matchResult.id} finalized by user #${actingUserId}. History ID: ${historyRow?.id ?? 'none'}`);
}

// revealTournamentHistory (D-91) was removed in S3: A37 makes history private for good and A24 replaces
// the per-match reveal by finalize-at-Completed; MatchSessionHistory.tournamentId (indexed) is the link.

// ─── Internal: incrementSpectatedCount ───────────────────────────────────────
// Increments matchesSpectated on PlayerStat for a spectator (per D-30/D-31/D-32).

function incrementSpectatedCount(
    ctx: any,
    userId: number,
    gameMode: any,
    draftMode: any,
    seasonId: number,
    matchType: any,
    teamSize: number,
    actingUserId: number
): void {
    const existing = [...ctx.db.PlayerStat.by_user_mode_draft_season_type_size
        .filter([userId, gameMode, draftMode, seasonId, matchType, teamSize])][0];

    if (existing) {
        ctx.db.PlayerStat.delete(existing);
        ctx.db.PlayerStat.insert({
            userId,
            gameMode,
            draftMode,
            matchesPlayed: existing.matchesPlayed,
            wins: existing.wins,
            losses: existing.losses,
            matchesSpectated: existing.matchesSpectated + 1,
            seasonId,
            matchType,
            teamSize,
            ...auditUpdate(ctx, existing, actingUserId),
        } as any);
    } else {
        ctx.db.PlayerStat.insert(insertWithAudit(ctx, {
            userId,
            gameMode,
            draftMode,
            matchesPlayed: 0,
            wins: 0,
            losses: 0,
            matchesSpectated: 1,
            seasonId,
            matchType,
            teamSize,
        }, actingUserId));
    }
}
