import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { ensureTournamentPermission } from '../helpers/tournamentPermissions';
import { updateWithAudit } from '../helpers/auditHelpers';
import { runFinalization } from '../helpers/finalizationHelpers';
import { handOffToBracket } from '../helpers/tournamentResults';

// ─── finalize_match_result ──────────────────────────────────────────────────
// Simplified: auth check, validate, authority check, delegate to runFinalization.
// Permission: Admin/Mod or the match referee. A24(4) (S8d): tournament records are rejected outright: they finalize
// in the run_tournament_finalize job when the tournament reaches Completed or Cancelled (the D-H-01 guard and the
// process_tournament_mmr batch it protected are gone).

export const finalize_match_result = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
    },
    (ctx, { matchResultId }) => {
        // 1. Auth
        const user = getAuthenticatedUser(ctx);

        // 2. Find and validate MatchResultRecord
        const matchResult = ctx.db.MatchResultRecord.id.find(matchResultId);
        if (!matchResult) {
            throw new SenderError('Match result not found.');
        }
        // A24(4): removed from the reducer surface for tournament records, so the guard cannot drift again.
        if (matchResult.isTournamentControlled) {
            throw new SenderError('Tournament matches finalize when the tournament completes (A24).');
        }
        if (matchResult.status.tag !== 'Validated') {
            throw new SenderError('Match result must be Validated before finalization.');
        }

        // 3. Authority check (Mod+ or the match referee)
        const hasAuthority = isRoleAtLeast(user.role, 'Moderator') || matchResult.refereeUserId === user.id;
        if (!hasAuthority) {
            throw new SenderError('You do not have authority to finalize this match result.');
        }

        // 4. Run the 19-step finalization pipeline
        runFinalization(ctx, matchResult, user.id);
    }
);

// ─── validate_match_result ──────────────────────────────────────────────────
// A24(1), A36, ACCESS-SECURITY-OPS §D.8.3 (S8d): staff validation of a tournament record waiting in Submitted (Ranked
// tournaments and requireResultValidation) or Disputed (a captain's dispute blocks validation until staff review it;
// validating is the review's outcome). Permission: `results` (A25); the tournament InProgress. The record becomes
// Validated with settledAt, then the bracket hand-off (handOffToBracket, decidedBy Played, A35 Blue = team1). The lobby
// stays parked in AwaitingResult; nothing derived runs until the tournament completes (A24(4)). Standalone records
// are rejected (their staff tool is admin_force_finalize).

export const validate_match_result = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
    },
    (ctx, { matchResultId }) => {
        const record = ctx.db.MatchResultRecord.id.find(matchResultId);
        if (!record) throw new SenderError('Match result not found.');
        if (!record.isTournamentControlled || record.bracketMatchId === undefined) {
            throw new SenderError('Only tournament results are validated by staff; use admin_force_finalize for a standalone match.');
        }
        const bracketMatch = ctx.db.BracketMatch.id.find(record.bracketMatchId);
        if (!bracketMatch) throw new SenderError('Bracket match not found.');
        const { user, tournament } = ensureTournamentPermission(ctx, bracketMatch.tournamentId, 'results');
        if (tournament.stage.tag !== 'InProgress') throw new SenderError('Tournament is not in progress.');
        if (record.status.tag !== 'Submitted' && record.status.tag !== 'Disputed') {
            throw new SenderError(`Only a Submitted or Disputed result can be validated (this one is ${record.status.tag}).`);
        }
        if (record.winnerTeamSide === undefined) throw new SenderError('A result without a winner cannot be validated (A31).');

        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, record, {
            status: { tag: 'Validated', value: {} } as any,
            settledAt: ctx.timestamp,
        }, user.id));
        handOffToBracket(ctx, ctx.db.MatchResultRecord.id.find(record.id), 'Played');

        console.log(`[MATCH] Match result #${matchResultId} validated by user #${user.id} (bracket match #${record.bracketMatchId})`);
    }
);
