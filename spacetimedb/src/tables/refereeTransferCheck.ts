import { table, t } from 'spacetimedb/server';

/**
 * A22a (S3, ACCESS-SECURITY-OPS D.8.2): the 15-second grace check scheduled by client_disconnected for a
 * lobby member in an active stage. When it fires (run_referee_transfer_check, S4), the referee / captain /
 * host flags move only if that user still has no live UserPresence row, and the player auto-pause decision
 * is made there too, so a page refresh neither moves flags nor pauses the draft.
 * Scheduled table: like IdentityGcJob / LobbyGcJob it carries no audit columns (transient module-internal rows).
 * The reducer binds through `spacetimedb.reducer({ onSchedule: RefereeTransferCheck }, ...)` (2.7+ form).
 */
export const refereeTransferCheckColumns = {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    lobbyId: t.u32(),
    userId: t.u32(),
};

export const RefereeTransferCheck = table({
    name: 'referee_transfer_check',
    indexes: [
        { accessor: 'by_lobby_and_user', algorithm: 'btree', columns: ['lobbyId', 'userId'] },
    ],
}, refereeTransferCheckColumns);
