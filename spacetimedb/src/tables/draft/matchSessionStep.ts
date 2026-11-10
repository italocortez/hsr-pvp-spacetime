import { table, t } from 'spacetimedb/server';
import { ActionType, TeamSide } from '@module/types/enums';
import { StepPayload } from '@module/types/structs';

export const matchSessionStepColumns = {
    id: t.u32().primaryKey().autoInc(),

    lobbyId: t.u32(),      // FK to Lobby/MatchSession
    sequence: t.u32(),     // 0, 1, 2... (getNextSequence; strict ordering within the lobby's one game, A67(3))

    actorUserId: t.u32(), // Who performed the action (persistent User ID)
    anonymousLabel: t.string().optional(),
    actorSlot: TeamSide,  // Blue/Red/Spectator

    action: ActionType,    // Pick, Ban, Bid...

    payload: StepPayload,
    timestamp: t.timestamp(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchSessionStep = table({
    name: 'match_session_step',
    public: false, // S3 (A37): private, read through views (S9)
    indexes: [
        // Fast lookup: "Get full history for Lobby 123"
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
        // Phase 15 WR-07: Replaces admin_delete_row's full-table scan when guarding
        // user-deletion against active match involvement.
        { accessor: 'by_actor_user', algorithm: 'btree', columns: ['actorUserId'] },
    ]
}, matchSessionStepColumns);
