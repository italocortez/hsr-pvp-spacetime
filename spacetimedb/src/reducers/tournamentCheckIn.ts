// ─── Tournament Check-In Reducer ──────────────────────────────────────────────
// Per D-35, D-36: Players check in to a tournament during the CheckIn stage.

import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { updateWithAudit } from '../helpers/auditHelpers';

// ─── check_in_tournament ─────────────────────────────────────────────────────
// Marks the calling player as checked in for a tournament.
// Per D-35, D-36:
//   - Tournament must be in CheckIn stage.
//   - Caller must be enrolled with status = Registered.
//   - Updates status to CheckedIn (delete + re-insert for composite PK).

export const check_in_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        const user = getAuthenticatedUser(ctx);

        // Validate tournament exists and is in CheckIn stage
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');

        if (tournament.stage.tag !== 'CheckIn') {
            throw new SenderError('Tournament is not in the CheckIn stage.');
        }

        // Find enrollment row
        const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, user.id])][0];
        if (!enrolled) {
            throw new SenderError('You are not enrolled in this tournament.');
        }

        // Must be in Registered status to check in (idempotent check)
        if (enrolled.status.tag === 'CheckedIn') {
            throw new SenderError('You have already checked in.');
        }
        if (enrolled.status.tag !== 'Registered') {
            throw new SenderError('Cannot check in: enrollment status is not Registered.');
        }

        // Update status to CheckedIn (delete + re-insert for composite PK)
        ctx.db.TournamentEnrolled.by_tournament_and_user.delete([tournamentId, user.id]);
        ctx.db.TournamentEnrolled.insert(updateWithAudit(ctx, enrolled, {
            status: { tag: 'CheckedIn', value: {} } as any,
        }, user.id));

        console.log(`[CHECK_IN] User #${user.id} checked into tournament #${tournamentId}`);
    }
);
