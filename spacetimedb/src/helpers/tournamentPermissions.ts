import { SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from './ensurePermissions';

// ─── A25 / review §5.3: the one tournament permission helper ────────────────────────────────────────────────
// Replaces the pre-S8b access helper, which granted everything to any assistant row (review C-a5 / T5).
// Moderator+ and the organizer hold every permission. An assistant holds `participants` through
// canManageParticipants, `bracket` through canManageBracket and `results` through canResolveResults;
// `owner` (settings, stages, cancel, assistants) is never granted to an assistant.

export type TournamentPerm = 'owner' | 'participants' | 'bracket' | 'results';

export const TOURNAMENT_PERM_MESSAGES: Record<TournamentPerm, string> = {
    owner: 'Only the organizer or a Moderator can change this tournament\'s settings, stages or staff.',
    participants: 'This action needs the participants permission.',
    bracket: 'This action needs the bracket permission.',
    results: 'This action needs the results permission.',
};

const ASSISTANT_FLAG: Record<Exclude<TournamentPerm, 'owner'>, string> = {
    participants: 'canManageParticipants',
    bracket: 'canManageBracket',
    results: 'canResolveResults',
};

/** True when `user` holds `perm` on `tournament` (no throw). */
export function hasTournamentPermission(ctx: any, user: any, tournament: any, perm: TournamentPerm): boolean {
    if (isRoleAtLeast(user.role, 'Moderator')) return true;
    if (tournament.organizerId === user.id) return true;
    if (perm === 'owner') return false;
    const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([tournament.id, user.id])][0];
    return !!assistant && assistant[ASSISTANT_FLAG[perm]] === true;
}

/** A25: resolves the caller and the tournament, and throws unless the caller holds `perm`. */
export function ensureTournamentPermission(
    ctx: any,
    tournamentId: number,
    perm: TournamentPerm,
): { user: any; tournament: any } {
    const user = getAuthenticatedUser(ctx);
    const tournament = ctx.db.Tournament.id.find(tournamentId);
    if (!tournament) throw new SenderError('Tournament not found.');
    if (!hasTournamentPermission(ctx, user, tournament, perm)) {
        throw new SenderError(TOURNAMENT_PERM_MESSAGES[perm]);
    }
    return { user, tournament };
}
