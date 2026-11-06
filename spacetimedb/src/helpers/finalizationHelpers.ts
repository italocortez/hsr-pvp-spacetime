// ─── Finalization Pipeline Helpers ────────────────────────────────────────────
// Shared 19-step finalization logic callable by both finalize_match_result
// (ranked/tournament) and submit_match_result (casual auto-finalize per D-37).

import { SenderError } from 'spacetimedb/server';
import { auditInsert, auditUpdate } from './auditColumns';
import { insertWithAudit, updateWithAudit } from './auditHelpers';
import type { MmrRating } from '../module_bindings/types';
import { getKFactor, calculateExpectedScore, calculateRatingChange, calculateTeamEffective, calculateAccountModifier } from './eloCalculation';
import type { EloConfigValues } from './eloCalculation';
import { incrementPlayerStat, incrementPlayerRelationship } from './statsIncrement';
import { incrementPlayerCharacterStat, incrementBanStat, incrementFacedStat } from './characterStatsIncrement';
import { incrementGlobalCharacterStat } from './globalCharacterStatsIncrement';
import { rebuildLeaderboard } from './leaderboardRebuild';
import { advanceBracketMatch } from './bracketHelpers';
import { checkAndAwardAchievements } from './achievementChecker';
import { slotIsCoach, slotIsSpectator, slotToTeamSide } from './lobbyHelpers';
import { resolveUserLabel } from './userLabel';
import { hardDeleteLobby } from '../reducers/lobbyGc';

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
    // D-readpath-02: both runFinalization step 11 (standalone-ranked) and
    // process_tournament_mmr (tournament batch) call this helper — one edit fixes
    // both paths by construction.
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
// 18-step pipeline: reads ephemeral data, archives to history, increments all
// stats, processes MMR (if applicable), advances bracket, deletes ephemeral.

export function runFinalization(
    ctx: any,
    matchResult: any,
    actingUserId: number
): void {
    // ── Reads (1-6) ──────────────────────────────────────────────────────────

    // 1. Read participants
    const participants = [...ctx.db.MatchResultParticipant.match_result_id.filter(matchResult.id)];

    // 2. Read games
    const games = [...ctx.db.MatchResultGame.match_result_id.filter(matchResult.id)];

    // 3. Read lobby
    const lobby = ctx.db.Lobby.id.find(matchResult.lobbyId);

    // 3b. Read match session (for budget analysis in step 7, D-88)
    const session = ctx.db.MatchSession.lobbyId.find(matchResult.lobbyId);

    // 4. Read steps (sorted by sequence)
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
    let matchEndReason: any;
    if (matchResult.winnerTeamSide === undefined) {
        matchEndReason = { tag: 'Draw', value: {} } as any;
    } else {
        matchEndReason = { tag: 'Completed', value: {} } as any;
    }

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
            doMmr: isRanked && !isTournament,                 // T3 non-tournament only (tournament defers to batch)
            doLeaderboard: isRanked && !isTournament,          // T3 non-tournament only
            doSpectated: isRanked,                             // T3 only
            doAchievements: false,                             // D-76: ALWAYS skipped for concede
            doBracketAdvance: false,                           // D-80: NEVER auto-advance for concede
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
        handicapApplied: 0,
        // D-84/D-91: Tournament matches hidden until tournament completes; standalone matches always visible
        isPubliclyVisible: lobby?.isTournamentControlled ? false : true,
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
                    if (tag === 'Pick' || tag === 'Ban' || tag === 'AuctionSold' || tag === 'Nominate') {
                        targetName = step.payload.value?.characterName;
                    } else if (tag === 'Bid') {
                        targetName = step.payload.value?.targetCharacter;
                    } else if (tag === 'EquipLightcone') {
                        targetName = step.payload.value?.lightconeName;
                    }
                }
                ctx.db.MatchSessionStepHistory.insert(insertWithAudit(ctx, {
                    matchHistoryId: historyRow.id,
                    // PK is [matchHistoryId, gameNumber, sequence] — gameNumber required (D-13)
                    // By finalization time only the last game's steps remain (advance_to_next_game deletes
                    // inter-game steps). For bestOf=1 all steps have gameNumber=1.
                    gameNumber: step.gameNumber ?? 1,
                    sequence: step.sequence,
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
                    matchHistoryId: historyRow.id,
                    gameNumber: game.gameNumber,
                    gameMode: game.gameMode,
                    teamBlueScreenshotUrl: game.teamBlueScreenshotUrl,
                    teamRedScreenshotUrl: game.teamRedScreenshotUrl,
                    teamBlueCyclesUsed: game.teamBlueCyclesUsed,
                    teamRedCyclesUsed: game.teamRedCyclesUsed,
                    teamBlueScore: game.teamBlueScore,
                    teamRedScore: game.teamRedScore,
                    teamBlueBoss1Score: game.teamBlueBoss1Score,
                    teamBlueBoss2Score: game.teamBlueBoss2Score,
                    teamRedBoss1Score: game.teamRedBoss1Score,
                    teamRedBoss2Score: game.teamRedBoss2Score,
                    winnerTeamSide: game.winnerTeamSide,
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

    // 11. Process MMR — standalone Ranked only (not tournament-controlled)
    if (!isConcede || concedeFlags.doMmr) {
        if (matchResult.matchType.tag === 'Ranked' && !matchResult.isTournamentControlled) {
            processMatchMmr(ctx, matchResult, effectiveParticipants, gameMode, seasonId, historyRow ? historyRow.id : 0, actingUserId);
            // Stamp mmrProcessedAt
            const freshResult = ctx.db.MatchResultRecord.id.find(matchResult.id)!;
            ctx.db.MatchResultRecord.id.update(
                updateWithAudit(ctx, freshResult, { mmrProcessedAt: ctx.timestamp }, actingUserId),
            );
        }
    }

    // 12. Tournament batch back-fill MmrHistory sentinel matchHistoryId
    if (!isConcede || concedeFlags.doMmr) {
        if (matchResult.isTournamentControlled && matchResult.mmrProcessedAt !== undefined && historyRow) {
            const participantUserIds = new Set(effectiveParticipants.map((p: any) => p.userId));
            for (const uid of participantUserIds) {
                const mmrRows = [...ctx.db.MmrHistory.user_id.filter(uid)]
                    .filter((h: any) => h.matchHistoryId === 0);
                if (mmrRows.length > 0) {
                    const latest = mmrRows.sort((a: any, b: any) => b.id - a.id)[0];
                    ctx.db.MmrHistory.id.update(
                        updateWithAudit(ctx, latest, { matchHistoryId: historyRow.id }, actingUserId),
                    );
                }
            }
        }
    }

    // 13. Increment PlayerStat per participant (per D-30: compare teamSide tags to winnerTeamSide)
    if (!isConcede || concedeFlags.doWinLoss) {
        for (const p of effectiveParticipants) {
            const isDraw = matchResult.winnerTeamSide === undefined;
            const participantWon = !isDraw && matchResult.winnerTeamSide?.tag === p.teamSide.tag;
            incrementPlayerStat(ctx, p.userId, gameMode, draftMode, seasonId, matchType, teamSize, participantWon, isDraw, actingUserId);
        }
    }

    // 13b. Rebuild leaderboard after PlayerStat increments (reads PlayerStat.wins)
    if (!isConcede || concedeFlags.doLeaderboard) {
        if (matchResult.matchType.tag === 'Ranked' && !matchResult.isTournamentControlled) {
            rebuildLeaderboard(ctx, actingUserId, seasonId);
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
                const isDraw = matchResult.winnerTeamSide === undefined;
                const aWon = !isDraw && matchResult.winnerTeamSide?.tag === a.teamSide.tag;
                const bWon = !isDraw && matchResult.winnerTeamSide?.tag === b.teamSide.tag;
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
            let charName: string | undefined;
            if (step.payload) {
                const payloadTag = step.payload.tag;
                if (payloadTag === 'Pick' || payloadTag === 'Ban' || payloadTag === 'AuctionSold' || payloadTag === 'Nominate') {
                    charName = step.payload.value?.characterName;
                } else if (payloadTag === 'Bid') {
                    charName = step.payload.value?.targetCharacter;
                }
            }
            if (!charName) continue;

            const actorTeamSide = step.actorSlot?.tag;

            if (actionTag === 'Pick' || actionTag === 'AuctionSold') {
                const didActorWin = winnerTeamSideTag !== undefined && actorTeamSide === winnerTeamSideTag;
                incrementPlayerCharacterStat(ctx, step.actorUserId, charName, gameMode, draftMode, seasonId, matchType, teamSize, didActorWin, actingUserId);
                for (const p of effectiveParticipants) {
                    if (p.teamSide.tag !== actorTeamSide) {
                        const didOpponentWin = winnerTeamSideTag !== undefined && p.teamSide.tag === winnerTeamSideTag;
                        incrementFacedStat(ctx, p.userId, charName, gameMode, draftMode, seasonId, matchType, teamSize, didOpponentWin, actingUserId);
                    }
                }
                incrementGlobalCharacterStat(ctx, charName, gameMode, draftMode, seasonId, matchType, teamSize, true, didActorWin, actingUserId);
            }

            if (actionTag === 'Ban') {
                for (const p of effectiveParticipants) {
                    incrementBanStat(ctx, p.userId, charName, gameMode, draftMode, seasonId, matchType, teamSize, actingUserId);
                }
                incrementGlobalCharacterStat(ctx, charName, gameMode, draftMode, seasonId, matchType, teamSize, false, false, actingUserId);
            }
        }
    }

    // 16.5. Check and award achievements per participant (D-14, D-76: ALWAYS skipped for concede)
    if (!isConcede || concedeFlags.doAchievements) {
        for (const p of effectiveParticipants) {
            checkAndAwardAchievements(ctx, p.userId, actingUserId);
        }
    }

    // 17. Bracket advancement (D-80: NEVER auto-advance for concede; D-42: derive tournamentId from bracketMatch)
    if (!isConcede || concedeFlags.doBracketAdvance) {
        if (matchResult.isTournamentControlled && matchResult.bracketMatchId !== undefined && matchResult.winnerTeamSide !== undefined) {
            const bracketMatch = ctx.db.BracketMatch.id.find(matchResult.bracketMatchId);
            if (bracketMatch && bracketMatch.winnerTeamId === undefined) {
                // D-42: derive tournamentId from bracketMatch (not from matchResult.tournamentId which was removed)
                const tournamentId = bracketMatch.tournamentId;
                // D-30: map winnerTeamSide directly to team1Id/team2Id — no participant lookup needed
                const winnerTeamId = matchResult.winnerTeamSide.tag === 'Blue'
                    ? bracketMatch.team1Id
                    : bracketMatch.team2Id;
                if (winnerTeamId !== undefined) {
                    advanceBracketMatch(ctx, matchResult.bracketMatchId, winnerTeamId, actingUserId);
                }
                // tournamentId used for logging context only
                console.log(`[MATCH] Bracket match #${matchResult.bracketMatchId} advanced for tournament #${tournamentId}`);
            }
        }
    }

    // 18. Delete ephemeral records (children first, then steps, then record) — always runs
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

// ─── revealTournamentHistory ──────────────────────────────────────────────────
// Batch-updates all MatchSessionHistory rows associated with a tournament to
// isPubliclyVisible=true. Called when tournament stage transitions to
// Completed or Cancelled per D-91.

export function revealTournamentHistory(ctx: any, tournamentId: number): void {
    // D-42: tournamentId removed from MatchResultRecord; derive via BracketMatch.tournamentId
    // Find all bracket matches for this tournament, then find match results via bracket_match_id index
    const bracketMatches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)];

    // Build a set of lobby join codes from match results linked to these bracket matches
    const lobbyCodes = new Set<string>();
    for (const bracketMatch of bracketMatches) {
        const matchResults = [...ctx.db.MatchResultRecord.bracket_match_id.filter(bracketMatch.id)];
        for (const mr of matchResults) {
            const lobby = ctx.db.Lobby.id.find(mr.lobbyId);
            if (lobby) {
                lobbyCodes.add(lobby.joinCode);
            }
        }
    }

    if (lobbyCodes.size === 0) return;

    // Iterate MatchSessionHistory and reveal any row whose lobbyCode matches
    // a lobby belonging to this tournament.
    // Note: MatchSessionHistory has no lobbyId column or tournamentId column,
    // so we use iter() to scan. Acceptable for tournament completion
    // (infrequent batch operation, not a hot path).
    for (const history of ctx.db.MatchSessionHistory.iter()) {
        if (!history.isPubliclyVisible && lobbyCodes.has(history.lobbyCode)) {
            ctx.db.MatchSessionHistory.id.update(
                updateWithAudit(ctx, history, { isPubliclyVisible: true }, 0),
            );
        }
    }
}

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
            draws: existing.draws,
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
            draws: 0,
            matchesSpectated: 1,
            seasonId,
            matchType,
            teamSize,
        }, actingUserId));
    }
}
