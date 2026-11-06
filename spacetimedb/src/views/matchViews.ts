// ─── Match Views (live) ───────────────────────────────────────────────────────
// Per-user views over in-progress match session data, anonymized when the
// hosting lobby requires it.
//
// 1. view_my_match_steps        — anonymized MatchSessionStep rows (D-92)
// 2. view_my_match_participants — anonymized MatchResultParticipant rows (D-92)

import spacetimedb from '../schema';
import { t } from 'spacetimedb/server';
import { TeamSide, ActionType } from '../types/enums';
import { StepPayload } from '../types/structs';
import { shouldAnonymize } from '../helpers/anonymousHelpers';
import { computeAnonymousLabel } from '../helpers/anonymousLabels';

// ---------------------------------------------------------------------------
// 1. view_my_match_steps (per D-92)
//    Returns MatchSessionStep rows for the caller's active lobbies.
//    Anonymizes actorUserId for opponent actors when anonymous mode is on.
// ---------------------------------------------------------------------------

const AnonymousMatchStepRow = t.object('AnonymousMatchStepRow', {
    id: t.u32(),
    lobbyId: t.u32(),
    sequence: t.u32(),
    actorUserId: t.u32(),
    anonymousLabel: t.string().optional(),
    actorSlot: TeamSide,
    action: ActionType,
    payload: StepPayload,
    timestamp: t.timestamp(),
});

// Phase 15 D-01/D-02: moved from anonymousViews.ts
export const view_my_match_steps = spacetimedb.view(
    { name: 'view_my_match_steps', public: true },
    t.array(AnonymousMatchStepRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const callerUserId = mapping.userId;

        // Get all lobbies the caller is in
        const memberships = [...ctx.db.LobbyMember.user_id.filter(callerUserId)];

        const results: any[] = [];

        for (const membership of memberships) {
            const lobbyId = membership.lobbyId;
            const lobby = ctx.db.Lobby.id.find(lobbyId);

            // Get all steps for this lobby via lobby_id index
            for (const step of ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)) {
                const anonymize = shouldAnonymize(ctx, lobbyId, step.actorUserId, lobby ?? undefined);

                results.push({
                    id: step.id,
                    lobbyId: step.lobbyId,
                    sequence: step.sequence,
                    actorUserId: anonymize ? 0 : step.actorUserId,
                    anonymousLabel: anonymize ? step.anonymousLabel : undefined,
                    actorSlot: step.actorSlot,
                    action: step.action,
                    payload: step.payload,
                    timestamp: step.timestamp,
                });
            }
        }

        return results;
    }
);

// ---------------------------------------------------------------------------
// 2. view_my_match_participants (per D-92)
//    Returns MatchResultParticipant rows for the caller's active lobby matches.
//    Anonymizes userId for opponent participants when anonymous mode is on.
// ---------------------------------------------------------------------------

const AnonymousMatchParticipantRow = t.object('AnonymousMatchParticipantRow', {
    matchResultId: t.u32(),
    userId: t.u32(),
    teamSide: TeamSide,
    isCaptain: t.bool(),
    anonymousLabel: t.string().optional(),
});

// Phase 15 D-01/D-02: moved from anonymousViews.ts
export const view_my_match_participants = spacetimedb.view(
    { name: 'view_my_match_participants', public: true },
    t.array(AnonymousMatchParticipantRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const callerUserId = mapping.userId;

        // Get all lobbies the caller is in
        const memberships = [...ctx.db.LobbyMember.user_id.filter(callerUserId)];

        const results: any[] = [];

        for (const membership of memberships) {
            const lobbyId = membership.lobbyId;
            const lobby = ctx.db.Lobby.id.find(lobbyId);

            // Find MatchResultRecord for this lobby
            const matchResult = [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];
            if (!matchResult) continue;

            // Get all participants for this match via match_result_id index
            for (const participant of ctx.db.MatchResultParticipant.match_result_id.filter(matchResult.id)) {
                const anonymize = shouldAnonymize(ctx, lobbyId, participant.userId, lobby ?? undefined);

                // Compute anonymous label for anonymized participants
                const anonLabel = anonymize
                    ? computeAnonymousLabel(ctx, lobbyId, participant.userId)
                    : undefined;

                results.push({
                    matchResultId: participant.matchResultId,
                    userId: anonymize ? 0 : participant.userId,
                    teamSide: participant.teamSide,
                    isCaptain: participant.isCaptain,
                    anonymousLabel: anonLabel,
                });
            }
        }

        return results;
    }
);
