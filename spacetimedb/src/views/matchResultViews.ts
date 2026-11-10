// ─── Match Result Views (live) ────────────────────────────────────────────────
// S9a (A37, A54, A56, A60, A63, A67(3)): the result record of each of the caller's lobbies (live or parked in
// AwaitingResult), its one game with the group scores and adjustments nested (PAGE-MAP "_result(+games)"), and the
// staff-only stuck-games list. Per-sender; the room subscribes them only past Waiting (PAGE-MAP D3).
//
// 1. view_my_match_result        — MatchResultRecord projection, user ids anonymized (A37)
// 2. view_my_match_result_games  — MatchResultGame + nested MatchResultGroupScore / MatchResultAdjustment (A56, A60)
// 3. view_admin_stuck_games      — ranked lobbies stuck in Scoring (A60(9), A63), Moderator+ only
//
// Index-only: no table scan in any view body.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import {
    TeamSide, MatchResultStatus, MatchType, MatchEndReason, ConcedeTrigger, GameMode, ValidationStatus, LobbyStage,
} from '@module/types/enums';
import { callerMemberships, maskUserId } from '@module/helpers/identity/viewAnonymity';
import { findLobbyResult, findGame, isUnresolvedTie } from '@module/helpers/results/scoringHelpers';
import { isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';

// ---------------------------------------------------------------------------
// 1. view_my_match_result (§A.4 P1): status, winner, settlement, concede and override fields of the lobby's one
//    record (A54). refereeUserId is not emitted (the live seat decides, A63); disputedByUserId / winnerOverrideById
//    are 0 when that user is anonymized for the caller; concedeSummary (stored with user ids, D-71) is emitted only
//    to a Moderator or Admin caller (A83); no audit columns.
// ---------------------------------------------------------------------------
const MatchResultViewRow = t.row('MatchResultViewRow', {
    id: t.u32().primaryKey(),
    lobbyId: t.u32(),
    bracketMatchId: t.u32().optional(),
    isTournamentControlled: t.bool(),
    status: MatchResultStatus,
    winnerTeamSide: TeamSide.optional(),
    matchType: MatchType,
    matchEndReason: MatchEndReason.optional(),
    concedeTrigger: ConcedeTrigger.optional(),
    concedeSummary: t.string().optional(),
    concedeAtStage: t.string().optional(),
    disputedByUserId: t.u32().optional(),
    disputeReason: t.string().optional(),
    winnerOverride: TeamSide.optional(),
    winnerOverrideById: t.u32().optional(),
    winnerOverrideReason: t.string().optional(),
    settledAt: t.timestamp().optional(),
});

export const view_my_match_result = spacetimedb.view(
    { name: 'view_my_match_result', public: true },
    t.array(MatchResultViewRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const caller = ctx.db.User.id.find(me.userId);
        const isStaff = !!caller && isRoleAtLeast(caller.role, 'Moderator');
        const rows: any[] = [];
        for (const membership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
            if (!lobby) continue;
            const record = findLobbyResult(ctx, lobby.id);
            if (!record) continue;
            rows.push({
                id: record.id,
                lobbyId: record.lobbyId,
                bracketMatchId: record.bracketMatchId,
                isTournamentControlled: record.isTournamentControlled,
                status: record.status,
                winnerTeamSide: record.winnerTeamSide,
                matchType: record.matchType,
                matchEndReason: record.matchEndReason,
                concedeTrigger: record.concedeTrigger,
                concedeSummary: isStaff ? record.concedeSummary : undefined, // A83
                concedeAtStage: record.concedeAtStage,
                disputedByUserId: maskUserId(ctx, lobby, membership, record.disputedByUserId),
                disputeReason: record.disputeReason,
                winnerOverride: record.winnerOverride,
                winnerOverrideById: maskUserId(ctx, lobby, membership, record.winnerOverrideById),
                winnerOverrideReason: record.winnerOverrideReason,
                settledAt: record.settledAt,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 2. view_my_match_result_games (A56(2)(3), A60(2)(3), A63, A67(3)): the record's one MatchResultGame row with its
//    group scores and itemized adjustments nested (one subscription, one row per lobby; every score edit rewrites
//    the game row anyway, A60(2)). validatedByUserId, closedById and each adjustment's setById are 0 when that user
//    is anonymized for the caller (A37); no audit columns.
// ---------------------------------------------------------------------------
const GroupScoreItem = t.object('GroupScoreItem', {
    teamSide: TeamSide,
    groupIndex: t.u8(),
    value: t.u32(),
});

const AdjustmentItem = t.object('AdjustmentItem', {
    id: t.u32(),
    teamSide: TeamSide,
    value: t.i32(),
    reason: t.string().optional(),
    setById: t.u32(),
});

const MatchResultGameViewRow = t.row('MatchResultGameViewRow', {
    matchResultId: t.u32().primaryKey(),
    lobbyId: t.u32(),
    gameMode: GameMode,
    teamBlueScreenshotUrl: t.string().optional(),
    teamRedScreenshotUrl: t.string().optional(),
    teamBlueCyclesUsed: t.u32().optional(),
    teamRedCyclesUsed: t.u32().optional(),
    teamBlueScore: t.u64().optional(),
    teamRedScore: t.u64().optional(),
    teamBlueDeaths: t.u8(),
    teamRedDeaths: t.u8(),
    teamBlueAdjustedResult: t.i32().optional(),
    teamRedAdjustedResult: t.i32().optional(),
    tieBreakLevel: t.u8().optional(),
    winnerTeamSide: TeamSide,
    validationStatus: ValidationStatus,
    validatedByUserId: t.u32().optional(),
    blueConfirmed: t.bool(),
    redConfirmed: t.bool(),
    closedAt: t.timestamp().optional(),
    closedById: t.u32().optional(),
    groupScores: t.array(GroupScoreItem),
    adjustments: t.array(AdjustmentItem),
});

export const view_my_match_result_games = spacetimedb.view(
    { name: 'view_my_match_result_games', public: true },
    t.array(MatchResultGameViewRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const rows: any[] = [];
        for (const membership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
            if (!lobby) continue;
            const record = findLobbyResult(ctx, lobby.id);
            if (!record) continue;
            const game = findGame(ctx, record.id);
            if (!game) continue;
            const groupScores = [...ctx.db.MatchResultGroupScore.by_result.filter(record.id)].map((s: any) => ({
                teamSide: s.teamSide,
                groupIndex: s.groupIndex,
                value: s.value,
            }));
            const adjustments = [...ctx.db.MatchResultAdjustment.by_result.filter(record.id)].map((a: any) => ({
                id: a.id,
                teamSide: a.teamSide,
                value: a.value,
                reason: a.reason,
                setById: maskUserId(ctx, lobby, membership, a.setById) ?? 0,
            }));
            rows.push({
                matchResultId: game.matchResultId,
                lobbyId: lobby.id,
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
                validationStatus: game.validationStatus,
                validatedByUserId: maskUserId(ctx, lobby, membership, game.validatedByUserId),
                blueConfirmed: game.blueConfirmed,
                redConfirmed: game.redConfirmed,
                closedAt: game.closedAt,
                closedById: maskUserId(ctx, lobby, membership, game.closedById),
                groupScores,
                adjustments,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 3. view_admin_stuck_games (A60(9), A63; ROADMAP S9a): ranked lobbies in Scoring whose open game (closedAt unset)
//    has exactly one ready flag, or both flags on an unresolved level-4 tie (isUnresolvedTie, the scoring helper's
//    tie test: tieBreakLevel = TIE_BREAK_UNRESOLVED) awaiting a staff override close. `sinceAt` = the game row's
//    last change (the latest confirmation or edit). Returns [] unless the caller's role is Moderator or above.
//    Index-only: Lobby.stage, MatchResultRecord.lobby_id, MatchResultGame.match_result_id.
// ---------------------------------------------------------------------------
const StuckGameRow = t.row('StuckGameRow', {
    lobbyId: t.u32().primaryKey(),
    joinCode: t.string(),
    stage: LobbyStage,
    blueConfirmed: t.bool(),
    redConfirmed: t.bool(),
    isTie: t.bool(),
    sinceAt: t.timestamp(),
});

export const view_admin_stuck_games = spacetimedb.view(
    { name: 'view_admin_stuck_games', public: true },
    t.array(StuckGameRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const user = ctx.db.User.id.find(mapping.userId);
        if (!user || !isRoleAtLeast(user.role, 'Moderator')) return [];
        const rows: any[] = [];
        for (const lobby of ctx.db.Lobby.stage.filter({ tag: 'Scoring', value: {} } as any)) {
            if (lobby.matchType.tag !== 'Ranked') continue;
            const record = findLobbyResult(ctx, lobby.id);
            if (!record) continue;
            const game = findGame(ctx, record.id);
            if (!game || game.closedAt !== undefined) continue;
            const isTie = isUnresolvedTie(game);
            const oneSided = game.blueConfirmed !== game.redConfirmed;
            const tieWaiting = game.blueConfirmed && game.redConfirmed && isTie;
            if (!oneSided && !tieWaiting) continue;
            rows.push({
                lobbyId: lobby.id,
                joinCode: lobby.joinCode,
                stage: lobby.stage,
                blueConfirmed: game.blueConfirmed,
                redConfirmed: game.redConfirmed,
                isTie,
                sinceAt: game.lastModifiedDate,
            });
        }
        return rows;
    }
);
