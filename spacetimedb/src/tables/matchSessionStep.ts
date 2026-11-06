import { table, t } from 'spacetimedb/server';
import { ActionType, TeamSide } from '../types/enums';
import { StepPayload } from '../types/structs';

export const matchSessionStepColumns = {
    id: t.u32().primaryKey().autoInc(),

    lobbyId: t.u32(),      // FK to Lobby/MatchSession
    gameNumber: t.u8(),    // 1-indexed game number within the series (per D-13); game 1 = 1
    sequence: t.u32(),     // 1, 2, 3... (Strict ordering within the game)

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
    public: true,
    indexes: [
        // Fast lookup: "Get full history for Lobby 123"
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
        // Phase 15 WR-07: Replaces admin_delete_row's full-table scan when guarding
        // user-deletion against active match involvement.
        { accessor: 'by_actor_user', algorithm: 'btree', columns: ['actorUserId'] },
    ]
}, matchSessionStepColumns);
