import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { hasTournamentPermission } from '../helpers/tournamentPermissions';
import { updateWithAudit } from '../helpers/auditHelpers';
import { writeMatchGames } from '../helpers/bracketResults';

// ─── set_match_sides ──────────────────────────────────────────────────────────
// A70(1)(3), A71(2) (S8g), A25 `bracket`. Chooses which team plays Blue in every lobby of a bracket match (the other
// plays Red), until the first game of the match is played. Any Ready match of the tournament, group-stage matches
// included. The colour choice never moves the head start (A71(1): winnerAdvantage stays on team1, A27). Guard order
// (A71 fix pass): once any record of the match is Pending / Submitted / Disputed / Validated the sides are final
// (Voided and Rejected do not block); otherwise a lobby of the match that still exists (its members are seated by
// colour) must be closed first. The tally is rewritten through writeMatchGames (A67(4)); audited with the caller's id
// (staff, A37). Setting the current value writes nothing.

const BLOCKING_RECORD_STATUSES = new Set(['Pending', 'Submitted', 'Disputed', 'Validated']);

export const set_match_sides = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
        blueTeamId: t.u32(),
    },
    (ctx, { bracketMatchId, blueTeamId }) => {
        const user = getAuthenticatedUser(ctx);
        const match = ctx.db.BracketMatch.id.find(bracketMatchId);
        if (!match) throw new SenderError('Bracket match not found.');
        const tournament = ctx.db.Tournament.id.find(match.tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (!hasTournamentPermission(ctx, user, tournament, 'bracket')) {
            throw new SenderError('You are not authorized to set the sides of this match.');
        }

        if (tournament.stage.tag === 'Completed' || tournament.stage.tag === 'Cancelled') {
            throw new SenderError('Tournament is over.');
        }
        if (match.state.tag !== 'Ready') {
            throw new SenderError(`${match.positionKey} is ${match.state.tag}; sides are set on a Ready match.`);
        }

        if (blueTeamId !== match.team1Id && blueTeamId !== match.team2Id) {
            throw new SenderError("blueTeamId must be one of the match's two teams.");
        }

        // A70(3) guard order: a started game first, then an open lobby (now only a Waiting lobby, or one whose
        // records are all Voided / Rejected).
        for (const record of ctx.db.MatchResultRecord.bracket_match_id.filter(match.id)) {
            if (BLOCKING_RECORD_STATUSES.has(record.status.tag)) {
                throw new SenderError('The sides can no longer be changed: a game of this match has started.');
            }
        }
        if ([...ctx.db.Lobby.bracket_match_id.filter(match.id)].length > 0) {
            throw new SenderError('Close the open lobby of this match before changing its sides.');
        }

        if (match.blueTeamId !== blueTeamId) {
            ctx.db.BracketMatch.id.update(updateWithAudit(ctx, match, { blueTeamId }, user.id));
        }
        writeMatchGames(ctx, match.id, user.id);
    }
);
