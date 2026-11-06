import spacetimedb from '../schema';
import { RefereeTransferCheck } from '../tables/refereeTransferCheck';

// ─── run_referee_transfer_check ───────────────────────────────────────────────
// A22a scheduled check, bound to RefereeTransferCheck through `onSchedule` (SDK 2.7+ form, no table→reducer
// cycle). S3 only registers the table and this binding so the schema is valid.
// S4: the real implementation runs ACCESS-SECURITY-OPS D.8.2: re-read the lobby and the member; if the user
// still has no live UserPresence row, move the referee flag along host → Blue players → Red players →
// spectators → coaches (skipping the leaver, offline members and voluntarilyLeft), transfer captain/host the
// same way, and insert the auto-pause step only for an offline team player in Drafting under Standard/Deferred.
export const run_referee_transfer_check = spacetimedb.reducer(
    { onSchedule: RefereeTransferCheck },
    { arg: RefereeTransferCheck.rowType },
    (_ctx, { arg }) => {
        // S4: decideRefereeTransfer / decideAutoPause from the lobby-rules prototype.
        console.log(`[REFEREE_CHECK] S3 stub: lobby #${arg.lobbyId}, user #${arg.userId} (no-op until S4)`);
    },
);
