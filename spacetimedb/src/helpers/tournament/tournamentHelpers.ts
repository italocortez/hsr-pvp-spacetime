import { SenderError } from 'spacetimedb/server';
import { canStartInProgress, isEligibleTeam } from '@shared/bracket';
import { fairShuffle, SHUFFLE_DOMAIN, shuffleKeyAt } from '@shared/lobby-rules';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { deleteCalendarEventsForTournament, deleteUserInvitesForTournament } from '@module/helpers/calendar/calendarCascade';
import { findLobbyResult } from '@module/helpers/results/scoringHelpers';
import { voidTournamentLobby } from './tournamentResults';
import { startTournamentFinalization } from './tournamentFinalization';

// Forward-only stage order (Cancelled is handled separately as a terminal transition)
// CheckIn is included between Registration and Seeding (D-35, D-37).
// Note: CheckIn is optional — if tournament.checkInEnabled=false, the advance_tournament_stage
// caller should pass 'Seeding' directly (skipping CheckIn). The stage machine still validates
// forward-only, so going Registration->Seeding is valid if CheckIn has not been entered yet.
const STAGE_ORDER = ['Draft', 'Registration', 'CheckIn', 'Seeding', 'InProgress', 'Completed'];

/**
 * Validates a tournament stage transition.
 * Transitions must be forward-only and cannot skip stages.
 * Cancellation is always allowed from any non-terminal state.
 */
export function validateStageTransition(currentTag: string, nextTag: string): void {
    // Cancellation is always allowed from any non-terminal state
    if (nextTag === 'Cancelled') {
        if (currentTag === 'Completed' || currentTag === 'Cancelled') {
            throw new SenderError(`Cannot cancel a tournament that is already ${currentTag}.`);
        }
        return;
    }
    const currentIdx = STAGE_ORDER.indexOf(currentTag);
    const nextIdx = STAGE_ORDER.indexOf(nextTag);
    if (currentIdx === -1 || nextIdx === -1) {
        throw new SenderError(`Invalid stage: ${currentTag} or ${nextTag}`);
    }
    if (nextIdx <= currentIdx) {
        throw new SenderError(`Cannot transition from ${currentTag} to ${nextTag} (forward-only).`);
    }
    // D-37: Allow Registration -> Seeding (skipping CheckIn when checkInEnabled=false).
    // Also allow Registration -> CheckIn (when checkInEnabled=true).
    // All other skips are invalid.
    if (nextIdx > currentIdx + 1) {
        // Allow skipping CheckIn only: Registration -> Seeding
        const isSkipCheckIn = currentTag === 'Registration' && nextTag === 'Seeding';
        if (!isSkipCheckIn) {
            throw new SenderError(`Cannot skip stages: must go from ${currentTag} to ${STAGE_ORDER[currentIdx + 1]}.`);
        }
    }
}

/**
 * Deletes all pending TournamentTeamRequest rows for a tournament.
 * Iterates teams → deletes each team's requests. Called during stage transitions
 * (Registration → Seeding) and cancellation to prevent orphaned request rows.
 */
export function cleanupTeamRequests(ctx: any, tournamentId: number): void {
    const teams = [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)];
    for (const team of teams) {
        for (const req of [...ctx.db.TournamentTeamRequest.team_id.filter(team.id)]) {
            ctx.db.TournamentTeamRequest.delete(req);
        }
    }
}

/**
 * Transfers captain role within a TournamentTeam to the next lowest userId member
 * (excluding the leaving/DQ'd user). Deterministic: lowest userId wins.
 *
 * Returns true if captain was transferred, false if no other members exist.
 * When false, the caller is responsible for destroying the team if appropriate.
 */
export function transferTournamentCaptain(ctx: any, teamId: number, leavingUserId: number, actingUserId: number): boolean {
    const team = ctx.db.TournamentTeam.id.find(teamId);
    if (!team || team.captainUserId !== leavingUserId) return false; // not captain

    const otherMembers = [...ctx.db.TournamentTeamMember.team_id.filter(teamId)]
        .filter((m: any) => m.userId !== leavingUserId)
        .sort((a: any, b: any) => a.userId - b.userId); // deterministic: lowest userId

    if (otherMembers.length > 0) {
        ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, {
            captainUserId: otherMembers[0].userId,
        }, actingUserId));
        return true; // captain transferred
    }
    return false; // no one to transfer to
}

/**
 * The cancellation cleanup (A24(5), review §5.1 "teams/bracket kept for display"; S8d).
 *
 * Preserves: TournamentEnrolled (audit trail), BracketMatch, TournamentTeam, TournamentTeamMember and
 *            TournamentAssistant (display, and the bracket order the finalize job reads), and every settled match:
 *            a lobby parked in AwaitingResult with a Validated record stays for the job, which counts its stats
 *            without MMR (A24(5)).
 * Voids:     every other tournament lobby (Waiting, playing, or parked with a Pending /
 *            Submitted / Disputed record): the record (if any) is marked Voided and the lobby hard-deleted
 *            (voidTournamentLobby); the job deletes the Voided records without effect.
 * Deletes:   TournamentTeamRequest, the calendar events of the bracket matches (D-21), TournamentPlayerAccount,
 *            TournamentWaitlistAccount (A104, S10g).
 */
export function cascadeCleanupTournament(ctx: any, tournamentId: number, actorId: number): void {
    // 1. Team requests (via teams — no tournamentId on request table)
    cleanupTeamRequests(ctx, tournamentId);

    // 1b. A24(5) (S8d): void every live tournament lobby; keep the settled ones for the finalize job.
    //     Lobby.bracket_match_id btree index (NOT a full table scan).
    for (const bracketMatch of [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)]) {
        for (const linkedLobby of [...ctx.db.Lobby.bracket_match_id.filter(bracketMatch.id)]) {
            const record = findLobbyResult(ctx, linkedLobby.id);
            const settled = linkedLobby.stage.tag === 'AwaitingResult' && record?.status.tag === 'Validated';
            if (!settled) {
                console.log(`[TOURNAMENT] Voiding ${linkedLobby.stage.tag} lobby #${linkedLobby.id} linked to bracket match #${bracketMatch.id}`);
                voidTournamentLobby(ctx, linkedLobby.id, actorId);
            }
        }
    }

    // 2. (group_phase_record dropped in S3, A23: standings are computed; nothing to delete)

    // 3. Calendar events linked to tournament bracket matches (D-21)
    deleteCalendarEventsForTournament(ctx, tournamentId);

    // 4. (S8d) Bracket matches are kept (display, finalize-job order).

    // 5. Tournament player accounts (locked roster snapshots)
    const enrolledRows = [...ctx.db.TournamentEnrolled.tournament_id.filter(tournamentId)];
    for (const e of enrolledRows) {
        for (const tpa of [...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, e.userId])]) {
            ctx.db.TournamentPlayerAccount.delete(tpa);
        }
    }
    deleteTournamentWaitlistAccounts(ctx, tournamentId); // A104 (S10g): no promotion is left

    // 6-8. (S8d) Team members, teams and assistants are kept (display).
}

// ─── S8b: registration, teams and the stage machine (A26, A26a, A36a, A36b, review §5.1) ─────────────────────

const unit = (tag: string) => ({ tag, value: {} }) as any;

const GROUP_FORMATS = new Set(['GroupOnly', 'GroupIntoSingleElim', 'GroupIntoDoubleElim']);
const HYBRID_FORMATS = new Set(['GroupIntoSingleElim', 'GroupIntoDoubleElim']);
export const isGroupFormat = (formatTag: string): boolean => GROUP_FORMATS.has(formatTag);

/** Throws `reason` as a SenderError when a shared guard fails (the pure module cannot import SenderError). */
export function ensureGuard(result: { ok: true } | { ok: false; reason: string }): void {
    if (!result.ok) throw new SenderError(result.reason);
}

/** Composite-PK update of a TournamentEnrolled row (delete + re-insert with audit). */
export function updateEnrolled(ctx: any, row: any, changes: Record<string, unknown>, actorId: number): any {
    ctx.db.TournamentEnrolled.delete(row);
    return ctx.db.TournamentEnrolled.insert(updateWithAudit(ctx, row, changes as any, actorId));
}

export function findEnrolled(ctx: any, tournamentId: number, userId: number): any {
    return [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, userId])][0];
}

export function findMembership(ctx: any, tournamentId: number, userId: number): any {
    return [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([tournamentId, userId])][0];
}

/**
 * Tournament audit #15 (S10g; review F4 for every captain-only reducer): the captain check also needs the caller's
 * membership of the team. After a DQ the team row may keep the disqualified user as captainUserId; that user is no
 * longer a member and cannot act as captain.
 */
export function isActingCaptain(ctx: any, team: any, userId: number): boolean {
    return team.captainUserId === userId && findMembership(ctx, team.tournamentId, userId)?.teamId === team.id;
}

/** A26a / C-a11: capacity counts the rows that are neither waitlisted nor Disqualified. */
export function capacityCount(ctx: any, tournamentId: number): number {
    return [...ctx.db.TournamentEnrolled.tournament_id.filter(tournamentId)]
        .filter((e: any) => !e.isWaitlisted && e.status.tag !== 'Disqualified').length;
}

/** A26a(2): a Disqualified row blocks re-registration; any other row means already registered. */
export function ensureNotEnrolled(existing: any, self: boolean): void {
    if (!existing) return;
    if (existing.status.tag === 'Disqualified') {
        throw new SenderError(self ? 'You were disqualified from this tournament.' : 'This player was disqualified from this tournament.');
    }
    throw new SenderError(self ? 'You are already registered for this tournament.' : 'This player is already registered for this tournament.');
}

/** D.8.6 / A26a: staff may still shape the field (promote, add) from Registration through Seeding until generation. */
export function ensureBeforeGeneration(tournament: any): void {
    const stage = tournament.stage.tag;
    if (stage !== 'Registration' && stage !== 'CheckIn' && stage !== 'Seeding') {
        throw new SenderError(`Tournament is in ${stage}; the field can change from Registration through Seeding only.`);
    }
    if (tournament.bracketGeneratedAt !== undefined) {
        throw new SenderError('Bracket generated; use stand-ins.');
    }
}

/** Review §5.1 footnote 1 through the shared `isEligibleTeam` (S8a). */
export function teamEligibility(ctx: any, tournament: any, team: any) {
    const members = [...ctx.db.TournamentTeamMember.team_id.filter(team.id)]
        .map((m: any) => findEnrolled(ctx, tournament.id, m.userId));
    return isEligibleTeam(team, members, { teamSize: tournament.teamSize, requireApproval: tournament.requireApproval });
}

/**
 * A26: participants never set the team status. Forming → Ready when the team has `teamSize` eligible members,
 * Ready → Forming when it drops below. Any other status (Active, Eliminated, Withdrawn, Disqualified) is left alone.
 */
export function refreshTeamStatus(ctx: any, tournament: any, teamId: number, actorId: number): void {
    const team = ctx.db.TournamentTeam.id.find(teamId);
    if (!team || (team.status.tag !== 'Forming' && team.status.tag !== 'Ready')) return;
    const next = teamEligibility(ctx, tournament, team).ok ? 'Ready' : 'Forming';
    if (team.status.tag !== next) {
        ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { status: unit(next) }, actorId));
    }
}

/** Refreshes the status of the team `userId` belongs to, if any (after an approval or a promotion). */
export function refreshTeamOf(ctx: any, tournament: any, userId: number, actorId: number): void {
    const ttm = findMembership(ctx, tournament.id, userId);
    if (ttm) refreshTeamStatus(ctx, tournament, ttm.teamId, actorId);
}

/** Deletes a team with its members and its pending requests (review T24: requests never outlive their team). */
export function deleteTeam(ctx: any, teamId: number): void {
    for (const member of [...ctx.db.TournamentTeamMember.team_id.filter(teamId)]) {
        ctx.db.TournamentTeamMember.delete(member);
    }
    for (const req of [...ctx.db.TournamentTeamRequest.team_id.filter(teamId)]) {
        ctx.db.TournamentTeamRequest.delete(req);
    }
    ctx.db.TournamentTeam.id.delete(teamId);
}

/**
 * Removes one membership (leave, withdrawal, rejection). The captain hands the captaincy on through
 * `transferTournamentCaptain`; the member row is deleted first and the team is handled only when no member is left
 * (review T2: the overloaded `false` of the transfer helper is never read as "team empty"): deleted in
 * Registration, marked Withdrawn from CheckIn on (TD-18: a team is never deleted after registration closes).
 */
export function removeTeamMember(ctx: any, tournament: any, ttm: any, actorId: number): void {
    const team = ctx.db.TournamentTeam.id.find(ttm.teamId);
    if (team && team.captainUserId === ttm.userId) {
        transferTournamentCaptain(ctx, ttm.teamId, ttm.userId, actorId);
    }
    ctx.db.TournamentTeamMember.delete(ttm);
    if (!team) return;
    if ([...ctx.db.TournamentTeamMember.team_id.filter(ttm.teamId)].length === 0) {
        if (tournament.stage.tag === 'Registration') {
            deleteTeam(ctx, ttm.teamId);
        } else {
            for (const req of [...ctx.db.TournamentTeamRequest.team_id.filter(ttm.teamId)]) {
                ctx.db.TournamentTeamRequest.delete(req);
            }
            const empty = ctx.db.TournamentTeam.id.find(ttm.teamId);
            if (empty.status.tag === 'Forming' || empty.status.tag === 'Ready') {
                ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, empty, { status: unit('Withdrawn') }, actorId));
            }
        }
    } else {
        refreshTeamStatus(ctx, tournament, ttm.teamId, actorId);
    }
}

/** Deletes every pending join request of `userId` in this tournament (requests carry no tournament id). */
export function deleteUserTeamRequests(ctx: any, tournamentId: number, userId: number): void {
    for (const req of [...ctx.db.TournamentTeamRequest.user_id.filter(userId)]) {
        const team = ctx.db.TournamentTeam.id.find(req.teamId);
        // A request whose team is gone is an orphan (T24) and goes too.
        if (!team || team.tournamentId === tournamentId) ctx.db.TournamentTeamRequest.delete(req);
    }
}

/**
 * A26a(1): a withdrawal (or a staff rejection) before registration closes deletes the enrolment with its team
 * membership, account locks, pending requests and calendar invites, so the spot frees and the player may
 * register again.
 */
export function removeEnrolment(ctx: any, tournament: any, enrolled: any, actorId: number): void {
    const ttm = findMembership(ctx, tournament.id, enrolled.userId);
    if (ttm) removeTeamMember(ctx, tournament, ttm, actorId);
    deleteUserTeamRequests(ctx, tournament.id, enrolled.userId);
    deleteUserInvitesForTournament(ctx, enrolled.userId, tournament.id);
    for (const tpa of [...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournament.id, enrolled.userId])]) {
        ctx.db.TournamentPlayerAccount.delete(tpa);
    }
    deleteWaitlistAccounts(ctx, tournament.id, enrolled.userId);
    ctx.db.TournamentEnrolled.delete(enrolled);
}

/**
 * A26a(4) / D-21: locks the player's HSR accounts for the tournament (at registration for non-waitlisted players,
 * at promotion for waitlisted ones). `accountIds` omitted = every account the player owns (the pre-S8b behaviour);
 * given = those accounts, which must be the player's own. Existing locks are kept (idempotent).
 */
export function lockPlayerAccounts(ctx: any, tournamentId: number, userId: number, accountIds: number[] | undefined, actorId: number): void {
    const owned = [...ctx.db.HsrAccount.user_id.filter(userId)];
    let ids: number[];
    if (accountIds === undefined) {
        ids = owned.map((a: any) => a.id);
    } else {
        const ownedIds = new Set(owned.map((a: any) => a.id));
        ids = [...new Set(accountIds)];
        for (const id of ids) {
            if (!ownedIds.has(id)) throw new SenderError(`HSR account #${id} is not one of your accounts.`);
        }
    }
    const locked = new Set([...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, userId])]
        .map((tpa: any) => tpa.hsrAccountId));
    for (const id of ids) {
        if (locked.has(id)) continue;
        ctx.db.TournamentPlayerAccount.insert(insertWithAudit(ctx, { tournamentId, userId, hsrAccountId: id }, actorId));
    }
}

// ─── A104 (S10g): waitlisted registrants' chosen accounts and late locking ───────────────────────────────────

/** Deletes the remembered account choice of one waitlisted registrant (TournamentWaitlistAccount). */
export function deleteWaitlistAccounts(ctx: any, tournamentId: number, userId: number): void {
    for (const row of [...ctx.db.TournamentWaitlistAccount.by_tournament_and_user.filter([tournamentId, userId])]) {
        ctx.db.TournamentWaitlistAccount.delete(row);
    }
}

/** Deletes every remembered account choice of a tournament (bracket activation, cancellation: no promotion is left). */
export function deleteTournamentWaitlistAccounts(ctx: any, tournamentId: number): void {
    for (const row of [...ctx.db.TournamentWaitlistAccount.tournament_id.filter(tournamentId)]) {
        ctx.db.TournamentWaitlistAccount.delete(row);
    }
}

/**
 * A104: remembers the accounts a waitlisted registrant chose (they must be the player's own); kept rows stay
 * (idempotent). Applied by lockAccountsAtPromotion.
 */
export function rememberWaitlistAccounts(ctx: any, tournamentId: number, userId: number, accountIds: number[], actorId: number): void {
    const ownedIds = new Set([...ctx.db.HsrAccount.user_id.filter(userId)].map((a: any) => a.id));
    const ids = [...new Set(accountIds)];
    for (const id of ids) {
        if (!ownedIds.has(id)) throw new SenderError(`HSR account #${id} is not one of your accounts.`);
    }
    const kept = new Set([...ctx.db.TournamentWaitlistAccount.by_tournament_and_user.filter([tournamentId, userId])]
        .map((r: any) => r.hsrAccountId));
    for (const id of ids) {
        if (kept.has(id)) continue;
        ctx.db.TournamentWaitlistAccount.insert(insertWithAudit(ctx, { tournamentId, userId, hsrAccountId: id }, actorId));
    }
}

/**
 * A104 / A26a(4): the locks of a promoted waitlisted player. The remembered choice when there is one (only the
 * accounts the player still owns; an account deleted since is skipped), else every account the player owns (no
 * choice remembered = the registration named none). The remembered rows are deleted.
 */
export function lockAccountsAtPromotion(ctx: any, tournamentId: number, userId: number, actorId: number): void {
    const remembered = [...ctx.db.TournamentWaitlistAccount.by_tournament_and_user.filter([tournamentId, userId])];
    if (remembered.length === 0) {
        lockPlayerAccounts(ctx, tournamentId, userId, undefined, actorId);
        return;
    }
    const ownedIds = new Set([...ctx.db.HsrAccount.user_id.filter(userId)].map((a: any) => a.id));
    const ids = remembered.map((r: any) => r.hsrAccountId as number).filter((id: number) => ownedIds.has(id));
    lockPlayerAccounts(ctx, tournamentId, userId, ids, actorId);
    deleteWaitlistAccounts(ctx, tournamentId, userId);
}

/** True when the bracket match exists and belongs to the tournament. */
function isMatchOfTournament(ctx: any, bracketMatchId: number | undefined, tournamentId: number): boolean {
    if (bracketMatchId === undefined) return false;
    const match = ctx.db.BracketMatch.id.find(bracketMatchId);
    return !!match && match.tournamentId === tournamentId;
}

/**
 * A104: "their first game of the tournament has started" is the player's own game (S10g review F3), not the team's.
 * True when:
 * 1. the player is a participant of a result record of one of the tournament's bracket matches (start_draft writes a
 *    MatchResultParticipant row for every non-coach Blue / Red member and creates the record, A54), or
 * 2. the player sits in a player seat (non-coach Blue / Red) of a lobby of such a match that is past Waiting, or
 * 3. a Voided record of a bracket match on which the player's team played (slot 1 or 2, or its recorded winner /
 *    loser) has no participant rows left. Voiding (voidTournamentLobby → hardDeleteLobby) keeps the record for audit
 *    until the finalize job but deletes its participant and member rows, so who sat in that game is no longer known:
 *    a voided or rolled-back game counts for every member of the team (conservative; a member who sat out only a
 *    voided game is treated as having played it).
 * A team member who sat out the team's games otherwise has played nothing.
 */
export function hasPlayedTournamentGame(ctx: any, tournamentId: number, userId: number): boolean {
    for (const participant of ctx.db.MatchResultParticipant.user_id.filter(userId)) {
        const record = ctx.db.MatchResultRecord.id.find(participant.matchResultId);
        if (record && isMatchOfTournament(ctx, record.bracketMatchId, tournamentId)) return true;
    }
    for (const member of ctx.db.LobbyMember.user_id.filter(userId)) {
        const tag: string = member.lobbySlot.tag;
        if (tag !== 'BluePlayer' && tag !== 'RedPlayer') continue;
        const lobby = ctx.db.Lobby.id.find(member.lobbyId);
        if (!lobby || lobby.stage.tag === 'Waiting') continue;
        if (isMatchOfTournament(ctx, lobby.bracketMatchId, tournamentId)) return true;
    }
    const teamId = findMembership(ctx, tournamentId, userId)?.teamId;
    if (teamId === undefined) return false;
    for (const match of ctx.db.BracketMatch.tournament_id.filter(tournamentId)) {
        if (match.team1Id !== teamId && match.team2Id !== teamId && match.winnerTeamId !== teamId && match.loserTeamId !== teamId) continue;
        for (const record of ctx.db.MatchResultRecord.bracket_match_id.filter(match.id)) {
            if (record.status.tag !== 'Voided') continue;
            let hasParticipants = false;
            for (const _ of ctx.db.MatchResultParticipant.match_result_id.filter(record.id)) { hasParticipants = true; break; }
            if (!hasParticipants) return true;
        }
    }
    return false;
}

// ─── Naming (A36a, phase 4 04-CONTEXT.md:59-63) ─────────────────────────────────────────────────────────────

export const TEAM_NAME_MAX = 40;
export const ALIAS_MAX = 32;

/** A captain-chosen team name: trimmed, 1–40 characters, unique within the tournament (case-insensitive). */
export function normalizeTeamName(ctx: any, tournamentId: number, name: string, exceptTeamId?: number): string {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > TEAM_NAME_MAX) {
        throw new SenderError(`Team name must be 1-${TEAM_NAME_MAX} characters.`);
    }
    const lower = trimmed.toLowerCase();
    for (const team of ctx.db.TournamentTeam.tournament_id.filter(tournamentId)) {
        if (team.id !== exceptTeamId && team.name.toLowerCase() === lower) {
            throw new SenderError('Another team in this tournament already uses that name.');
        }
    }
    return trimmed;
}

/** An anonymous alias: trimmed, 1–32 characters. */
export function normalizeAlias(alias: string): string {
    const trimmed = alias.trim();
    if (trimmed.length < 1 || trimmed.length > ALIAS_MAX) {
        throw new SenderError(`Alias must be 1-${ALIAS_MAX} characters.`);
    }
    return trimmed;
}

/**
 * A36a / A37: a solo team is named after its player (display name) in a non-anonymous tournament. In an anonymous
 * one it carries the alias, or a neutral "Player <n>" (n from the enrolment count, the first free number) until
 * set_anonymous_alias renames it: the display name never reaches the team name. Auto names are unique within the
 * tournament (case-insensitive): a collision appends " (2)", " (3)", … (`exceptTeamId` = the team being renamed).
 */
export function soloTeamName(ctx: any, tournament: any, displayName: string, alias: string | undefined, exceptTeamId?: number): string {
    const taken = new Set([...ctx.db.TournamentTeam.tournament_id.filter(tournament.id)]
        .filter((t: any) => t.id !== exceptTeamId)
        .map((t: any) => t.name.toLowerCase()));
    if (tournament.isAnonymousDefault && !alias) {
        let n = [...ctx.db.TournamentEnrolled.tournament_id.filter(tournament.id)].length;
        while (taken.has('player ' + n)) n++;
        return 'Player ' + n;
    }
    const base: string = tournament.isAnonymousDefault ? alias! : displayName;
    if (!taken.has(base.toLowerCase())) return base;
    let k = 2;
    while (taken.has((base + ' (' + k + ')').toLowerCase())) k++;
    return base + ' (' + k + ')';
}

/**
 * Lazy sync of solo team names after a display-name change (update_display_name; S10r, A122(1): admin_update_user
 * too). A solo player's team in an active (not Completed / Cancelled), solo, non-anonymous tournament takes the new
 * name through soloTeamName's uniqueness pass (tournament audit #16).
 */
export function syncSoloTeamNames(ctx: any, userId: number, displayName: string, actorId: number): void {
    for (const team of [...ctx.db.TournamentTeam.captain_user_id.filter(userId)]) {
        const tournament = ctx.db.Tournament.id.find(team.tournamentId);
        if (!tournament) continue;
        const isActive = tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled';
        if (!isActive || tournament.teamSize !== 1 || tournament.isAnonymousDefault) continue;
        const name = soloTeamName(ctx, tournament, displayName, undefined, team.id);
        if (name !== team.name) {
            ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { name }, actorId));
        }
    }
}

/** Creates the auto team of a solo tournament (teamSize = 1) for an enrolled player; status from refreshTeamStatus. */
export function createSoloTeam(ctx: any, tournament: any, userId: number, name: string, actorId: number): void {
    const team = ctx.db.TournamentTeam.insert(insertWithAudit(ctx, {
        id: 0,
        tournamentId: tournament.id,
        name,
        captainUserId: userId,
        status: unit('Forming'),
        seedNumber: undefined,
        groupId: undefined,
        finalPlacement: undefined,
    }, actorId));
    ctx.db.TournamentTeamMember.insert(insertWithAudit(ctx, { teamId: team.id, userId, tournamentId: tournament.id }, actorId));
    refreshTeamStatus(ctx, tournament, team.id, actorId);
}

// ─── Registration closes (A26, A26a, A36a; review §5.1) ─────────────────────────────────────────────────────

/** A team counts as checked in once its captain (or staff) checked it in: a member is CheckedIn (A26). */
export function isTeamCheckedIn(ctx: any, tournamentId: number, teamId: number): boolean {
    return [...ctx.db.TournamentTeamMember.team_id.filter(teamId)]
        .some((m: any) => findEnrolled(ctx, tournamentId, m.userId)?.status.tag === 'CheckedIn');
}

/**
 * A36a: random team formation for opted-in solo players at registration close. Eligible = approved (when
 * required), not waitlisted, Registered or CheckedIn, on no team, `allowRandomTeamAssignment`. The pool is sorted
 * by user id and shuffled with fairShuffle (A120, shared/lobby-rules/timerDraw.ts; keyed by the transaction time,
 * SHUFFLE_DOMAIN.TeamFormation and the tournament id, so it never correlates with seeding); full teams of `teamSize` are formed,
 * named "Team <n>" (the first free number), captained by their first member; leftovers stay enrolled without a team.
 */
export function formRandomTeams(ctx: any, tournament: any, actorId: number): number {
    if (tournament.teamSize < 2) return 0; // solo players always have their auto team
    const sorted = [...ctx.db.TournamentEnrolled.tournament_id.filter(tournament.id)]
        .filter((e: any) =>
            e.allowRandomTeamAssignment &&
            !e.isWaitlisted &&
            (e.status.tag === 'Registered' || e.status.tag === 'CheckedIn') &&
            (!tournament.requireApproval || e.approvedByToAt !== undefined) &&
            !findMembership(ctx, tournament.id, e.userId))
        .map((e: any) => e.userId as number)
        .sort((a: number, b: number) => a - b);
    const pool = fairShuffle(sorted, shuffleKeyAt(ctx.timestamp.microsSinceUnixEpoch, [SHUFFLE_DOMAIN.TeamFormation, tournament.id]));
    const taken = new Set([...ctx.db.TournamentTeam.tournament_id.filter(tournament.id)].map((t: any) => t.name.toLowerCase()));
    let n = 1;
    let formed = 0;
    for (let i = 0; i + tournament.teamSize <= pool.length; i += tournament.teamSize) {
        while (taken.has(`team ${n}`)) n++;
        const name = `Team ${n}`;
        taken.add(name.toLowerCase());
        const members = pool.slice(i, i + tournament.teamSize);
        const team = ctx.db.TournamentTeam.insert(insertWithAudit(ctx, {
            id: 0,
            tournamentId: tournament.id,
            name,
            captainUserId: members[0],
            status: unit('Forming'),
            seedNumber: undefined,
            groupId: undefined,
            finalPlacement: undefined,
        }, actorId));
        for (const userId of members) {
            ctx.db.TournamentTeamMember.insert(insertWithAudit(ctx, { teamId: team.id, userId, tournamentId: tournament.id }, actorId));
        }
        formed++;
    }
    return formed;
}

/**
 * Registration closes = the transition out of Registration, to CheckIn or to Seeding (A26a definitions; review
 * §5.1): pending team requests are deleted and random teams are formed for the opted-in solo players (A36a), so
 * random teams exist before check-in and check in like any team; team statuses are refreshed (A26).
 */
export function closeRegistration(ctx: any, tournament: any, actorId: number): void {
    cleanupTeamRequests(ctx, tournament.id);
    formRandomTeams(ctx, tournament, actorId);
    for (const team of [...ctx.db.TournamentTeam.tournament_id.filter(tournament.id)]) {
        refreshTeamStatus(ctx, tournament, team.id, actorId);
    }
}

/**
 * Entering Seeding (from Registration with check-in off, or from CheckIn). From Registration the close effects run
 * first (closeRegistration). From CheckIn every Forming / Ready team that was not checked in becomes Withdrawn (A26
 * team-level check-in; members stay enrolled; replaces the per-member prune, review T2). Then the eligibility pass:
 * eligible teams become Ready and the others stay Forming (A26a: staff may still promote, add or move players until
 * the bracket is generated; generate_bracket withdraws the teams still Forming, S8c). Returns the eligible team
 * count; the caller applies `canCloseRegistration` (at least two) and the transaction rolls back when it fails.
 */
export function enterSeeding(ctx: any, tournament: any, actorId: number): number {
    if (tournament.stage.tag === 'Registration') {
        closeRegistration(ctx, tournament, actorId);
    } else if (tournament.stage.tag === 'CheckIn') {
        for (const team of [...ctx.db.TournamentTeam.tournament_id.filter(tournament.id)]) {
            if (team.status.tag !== 'Forming' && team.status.tag !== 'Ready') continue;
            if (!isTeamCheckedIn(ctx, tournament.id, team.id)) {
                ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { status: unit('Withdrawn') }, actorId));
                console.log(`[CHECK_IN] Team #${team.id} withdrawn from tournament #${tournament.id} (not checked in)`);
            }
        }
    }
    let eligible = 0;
    for (const team of [...ctx.db.TournamentTeam.tournament_id.filter(tournament.id)]) {
        if (team.status.tag !== 'Forming' && team.status.tag !== 'Ready') continue;
        refreshTeamStatus(ctx, tournament, team.id, actorId);
        if (teamEligibility(ctx, tournament, team).ok) eligible++;
    }
    return eligible;
}

/**
 * Seeding → InProgress guard (review §5.1) through the shared `canStartInProgress`: the bracket was generated after
 * the last seed change and every round-1 match holds a team. For the GroupInto* formats only the group rows are
 * checked (the elimination slots are filled by the group → elimination advancement, as before), and for every group
 * format each Ready team must have a group (`TournamentTeam.groupId`, A23 / A32).
 */
export function validateSeedingToInProgress(ctx: any, tournament: any): void {
    const formatTag = tournament.format.tag as string;
    const rows = [...ctx.db.BracketMatch.tournament_id.filter(tournament.id)]
        .filter((m: any) => !HYBRID_FORMATS.has(formatTag) || m.bracketSide.tag === 'Group');
    ensureGuard(canStartInProgress(tournament, rows));
    if (isGroupFormat(formatTag)) {
        const ungrouped = [...ctx.db.TournamentTeam.tournament_id.filter(tournament.id)]
            .filter((t: any) => t.status.tag === 'Ready' && t.groupId === undefined);
        if (ungrouped.length > 0) {
            throw new SenderError(`${ungrouped.length} Ready team(s) have no group; assign groups and regenerate the bracket.`);
        }
    }
}

/**
 * Seeding → InProgress effects: Ready teams → Active, their members' enrolments Registered / CheckedIn → Active.
 * A104 (S10g): the remembered account choices of players still waitlisted are deleted (promotion ends at generation).
 */
export function activateTeams(ctx: any, tournament: any, actorId: number): void {
    deleteTournamentWaitlistAccounts(ctx, tournament.id);
    for (const team of [...ctx.db.TournamentTeam.tournament_id.filter(tournament.id)]) {
        if (team.status.tag !== 'Ready') continue;
        ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { status: unit('Active') }, actorId));
        for (const m of [...ctx.db.TournamentTeamMember.team_id.filter(team.id)]) {
            const e = findEnrolled(ctx, tournament.id, m.userId);
            if (e && !e.isWaitlisted && (e.status.tag === 'Registered' || e.status.tag === 'CheckedIn')) {
                updateEnrolled(ctx, e, { status: unit('Active') }, actorId);
            }
        }
    }
}

/**
 * The one cancel path (cancel_tournament, advance_tournament_stage → Cancelled, admin_cancel_idle_tournaments):
 * not from a terminal stage, cascade cleanup, then the A24(5) finalization (S8d).
 */
export function cancelTournament(ctx: any, tournament: any, actorId: number): void {
    validateStageTransition(tournament.stage.tag, 'Cancelled');
    cascadeCleanupTournament(ctx, tournament.id, actorId);
    ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, { stage: unit('Cancelled') }, actorId));
    // A24(5) (S8d): the same chunked finalization as Completed; the job counts stats and skips MMR.
    startTournamentFinalization(ctx, tournament.id, actorId);
}

