import { table, t } from 'spacetimedb/server';
import { TeamSide, ActionType } from '@module/types/enums';

export const matchSessionStepHistoryColumns = {
    matchHistoryId: t.u32(),     // FK to MatchSessionHistory.id
    sequence: t.u32(),           // Step number within the game (1, 2, 3...); A67(3): one game per match
    actorUserId: t.u32(),        // Who performed the action
    actorDisplayName: t.string(), // Denormalized for replay (per D-53/D-64)
    teamSide: TeamSide,         // Blue/Red/Spectator
    action: ActionType,          // Pick, Ban, Bid, etc.
    targetName: t.string().optional(), // Character or LC name; SetEidolon = the character (A60); null for Pause/Undo/ArrangeLineup/ConfirmGame
    payload: t.string().optional(),       // JSON for action-specific data (bid amount, etc.)
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchSessionStepHistory = table({
    name: 'match_session_step_history',
    public: false, // S3 (A37): private, read through views (S9)
    primaryKey: ['matchHistoryId', 'sequence'],
    indexes: [
        { accessor: 'by_match_history', algorithm: 'btree', columns: ['matchHistoryId'] },
    ],
}, matchSessionStepHistoryColumns);
