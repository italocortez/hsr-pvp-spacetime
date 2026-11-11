// ─── Stand-in lifecycle (S10v: DECISIONS.md A135, A136; notes/audit-2026-11-09/standin-audit.md SI1-SI16) ─────────
// One TournamentStandIn row = "this user may sit on this team's side in the lobbies of this one bracket match" (A35).
// This file holds what happens around the row: the account-lock snapshot (SI2), its removal by any path (revoke,
// disqualification, a slot that changes team, a conflicting placement) with the seat and invite clean-up (SI1, SI4,
// SI5, SI14, SI16), the lock release (SI12), the captain's stand-in move (A135(4) as read by A138: no automatic
// seat moves) and the start gate (SI11).

import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { allowedSlotsFor } from './tournamentLobbySides';
import { matchSides } from './matchSides';
import { hasPlayedTournamentGame, lockPlayerAccounts } from './accountLocks';

// Local index reads (the same as tournamentHelpers' findMembership / isActingCaptain): this file is
// imported by the bracket writers (bracketStore, bracketResults), which tournamentHelpers reaches through
// tournamentResults, so importing tournamentHelpers here would close an import cycle.
const findMembership = (ctx: any, tournamentId: number, userId: number): any =>
    [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([tournamentId, userId])][0];
const isActingCaptain = (ctx: any, team: any, userId: number): boolean =>
    team.captainUserId === userId && findMembership(ctx, team.tournamentId, userId)?.teamId === team.id;

/** A135 (SI13): an approval is for a match that is still open: Pending (an opponent may still come) or Ready. */
export const OPEN_MATCH_STATES = new Set(['Pending', 'Ready']);

/** A135(3) (SI8): a team is still in the tournament while Forming, Ready or Active (not Eliminated / Withdrawn / Disqualified). */
export const STILL_IN_TEAM_STATUSES = new Set(['Forming', 'Ready', 'Active']);

const isMatchOpen = (match: any): boolean => !!match && OPEN_MATCH_STATES.has(match.state.tag);

/** True when `userId` holds a stand-in row on an open match (Pending / Ready) of the tournament. */
export function hasOpenStandInApproval(ctx: any, tournamentId: number, userId: number): boolean {
    for (const row of ctx.db.TournamentStandIn.user_id.filter(userId)) {
        const match = ctx.db.BracketMatch.id.find(row.bracketMatchId);
        if (match && match.tournamentId === tournamentId && isMatchOpen(match)) return true;
    }
    return false;
}

/**
 * SI2, review F7 / F11 (D-26): a stand-in with no locks in the tournament gets locks on every game account they own, as
 * at registration, at their own first participation in a lobby of the match (participateAsStandIn: creating it,
 * joining it (join_lobby), taking a player seat themself, confirming ready in a player seat (review G1)), never at
 * approval, and never once the user has played a game of the tournament (A104, review G1). Users with locks already (an
 * entrant's own locks, an earlier participation) keep theirs; a user with no account gets none (they lock one later
 * through lock_tournament_accounts, A135(8)).
 */
export function snapshotStandInLocks(ctx: any, tournamentId: number, userId: number, actorId: number): void {
    if ([...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, userId])].length > 0) return;
    // Review G1 (A104): once the user has played a game of the tournament no account is locked any more.
    if (hasPlayedTournamentGame(ctx, tournamentId, userId)) return;
    lockPlayerAccounts(ctx, tournamentId, userId, undefined, actorId, 'StandIn'); // A143
}

/**
 * Review F7 / F11 / G1: the stand-in's own participation in a lobby of their match. Entry points: create_tournament_lobby
 * (a stand-in creator), join_lobby (D-26, any seat), set_team_slot (a stand-in taking a player seat themself) and
 * confirm_ready (in a player seat; a host move resets the confirmation and start_draft needs every player confirmed,
 * so no seated stand-in starts without passing here). No-op for anyone who is not an approved stand-in of the lobby's
 * match. Takes the lock snapshot (snapshotStandInLocks: skipped once the user has played, A104), then, when nothing is
 * selected in this lobby, selects the active account if locked, else the first locked one (review G8, as join_lobby's
 * D-04 fallback).
 */
export function participateAsStandIn(ctx: any, lobby: any, userId: number, actorId: number): void {
    if (!lobby.isTournamentControlled || lobby.bracketMatchId === undefined || lobby.tournamentId === undefined) return;
    if ([...ctx.db.TournamentStandIn.by_match_and_user.filter([lobby.bracketMatchId, userId])].length === 0) return;
    snapshotStandInLocks(ctx, lobby.tournamentId, userId, actorId);
    if ([...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobby.id, userId])].length > 0) return;
    const locked = new Set([...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([lobby.tournamentId, userId])]
        .map((tpa: any) => tpa.hsrAccountId));
    const active = [...ctx.db.HsrAccount.user_id.filter(userId)].find((a: any) => a.isActive && locked.has(a.id));
    // Review G8: as join_lobby (D-04): the active account when locked, else the first locked one.
    const pick = active ? active.id : [...locked][0];
    if (pick !== undefined) ctx.db.LobbyMemberAccount.insert({ lobbyId: lobby.id, userId, hsrAccountId: pick });
}

/**
 * SI12, review F10: releases a stand-in's locks in the tournament when the user holds no approval on an open match of
 * it and has not played a game of it (hasPlayedTournamentGame, A104: a result-record participant of a bracket match of
 * the tournament, or a player seat in such a lobby past Waiting). Otherwise the locks stay until the tournament ends
 * (deleteTournamentStandIns sweeps them).
 * A143 (S11a): only the locks whose origin is StandIn are released; Entry locks (the player's own entry: registration,
 * promotion, lock_tournament_accounts while enrolled, an entry transfer) are never released here. This replaces the
 * S10v rule that compared each lock's createdDate with the user's first approval time.
 */
export function releaseStandInLocksIfUnused(ctx: any, tournamentId: number, userId: number): void {
    if (hasOpenStandInApproval(ctx, tournamentId, userId)) return;
    if (hasPlayedTournamentGame(ctx, tournamentId, userId)) return;
    const released = [...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, userId])]
        .filter((tpa: any) => tpa.origin.tag === 'StandIn');
    if (released.length === 0) return;
    for (const tpa of released) ctx.db.TournamentPlayerAccount.delete(tpa);
    // Review G1: a selection never outlives its lock: the user's selections of the released accounts in Waiting lobbies
    // of the tournament go (LobbyMember.user_id -> Lobby; a live lobby is not Waiting, so a game in play is never
    // touched). A143: a selection of an account still locked by the entry stays.
    const releasedIds = new Set(released.map((tpa: any) => tpa.hsrAccountId));
    for (const m of [...ctx.db.LobbyMember.user_id.filter(userId)]) {
        const lobby = ctx.db.Lobby.id.find(m.lobbyId);
        if (!lobby || lobby.tournamentId !== tournamentId || lobby.stage.tag !== 'Waiting') continue;
        for (const lma of [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobby.id, userId])]) {
            if (releasedIds.has(lma.hsrAccountId)) ctx.db.LobbyMemberAccount.delete(lma);
        }
    }
}

/** Moves a lobby member to Spectator (not confirmed, not captain). No spectator cap: the move is not the user's choice. */
function moveToSpectator(ctx: any, row: any, actorId: number): void {
    ctx.db.LobbyMember.by_lobby_and_user.delete([row.lobbyId, row.userId]);
    ctx.db.LobbyMember.insert(updateWithAudit(ctx, row, {
        lobbySlot: { tag: 'Spectator', value: {} } as any,
        isConfirmed: false,
        isCaptain: false,
    }, actorId));
}

/**
 * SI4 / SI5: in every Waiting lobby of the bracket match, `userId` is moved to Spectator when their seat (player or
 * coach) is no longer one allowedSlotsFor gives them. A lobby past Waiting is not touched: the game plays on.
 */
export function unseatDisallowed(ctx: any, bracketMatchId: number, userId: number, actorId: number): void {
    for (const lobby of [...ctx.db.Lobby.bracket_match_id.filter(bracketMatchId)]) {
        if (lobby.stage.tag !== 'Waiting') continue;
        const row = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobby.id, userId])][0];
        if (!row || row.lobbySlot.tag === 'Spectator') continue;
        if (allowedSlotsFor(ctx, lobby, userId).includes(row.lobbySlot.tag)) continue;
        moveToSpectator(ctx, row, actorId);
    }
}

/** True when `userId` is a member of team1 or team2 of the match. */
function isMemberOfMatch(ctx: any, match: any, userId: number): boolean {
    const teamId = findMembership(ctx, match.tournamentId, userId)?.teamId;
    return teamId !== undefined && (teamId === match.team1Id || teamId === match.team2Id);
}

/**
 * SI16: the stand-in's invite to the match's calendar event (CalendarEvent.bracket_match_id), as the members get one at
 * event creation. Added on approval when the event exists (skipped when the event is at MAX_INVITEES_PER_EVENT; the
 * event still shows in view_my_calendar_events through the approval). Never for a member of the match's teams.
 */
export function inviteStandInToMatchEvents(ctx: any, match: any, userId: number, actorId: number, maxInvitees: number): void {
    for (const event of ctx.db.CalendarEvent.bracket_match_id.filter(match.id)) {
        if ([...ctx.db.CalendarEventInvite.by_event_and_invitee.filter([event.id, userId])].length > 0) continue;
        if ([...ctx.db.CalendarEventInvite.event_id.filter(event.id)].length >= maxInvitees) continue;
        ctx.db.CalendarEventInvite.insert(insertWithAudit(ctx, {
            eventId: event.id,
            inviteeUserId: userId,
            inviteStatus: { tag: 'Pending', value: {} } as any,
            respondedAt: undefined,
        }, actorId));
    }
}

/**
 * Removes one stand-in approval and what hangs on it (SI4, SI5, SI12, SI14, SI16): the row; the user's seat in the
 * Waiting lobbies of the match when no longer allowed; the user's invite to the match's calendar event unless the user
 * is a member of one of the match's teams; then the locks when unused (releaseStandInLocksIfUnused).
 */
export function removeStandIn(ctx: any, row: any, actorId: number): void {
    ctx.db.TournamentStandIn.id.delete(row.id);
    const match = ctx.db.BracketMatch.id.find(row.bracketMatchId);
    if (!match) return;
    unseatDisallowed(ctx, match.id, row.userId, actorId);
    if (!isMemberOfMatch(ctx, match, row.userId)) {
        for (const event of ctx.db.CalendarEvent.bracket_match_id.filter(match.id)) {
            for (const invite of [...ctx.db.CalendarEventInvite.by_event_and_invitee.filter([event.id, row.userId])]) {
                ctx.db.CalendarEventInvite.delete(invite);
            }
        }
    }
    releaseStandInLocksIfUnused(ctx, match.tournamentId, row.userId);
}

/** SI5: every approval of `userId` in the tournament (disqualification). */
export function removeUserStandIns(ctx: any, tournamentId: number, userId: number, actorId: number): void {
    for (const row of [...ctx.db.TournamentStandIn.user_id.filter(userId)]) {
        const match = ctx.db.BracketMatch.id.find(row.bracketMatchId);
        if (match && match.tournamentId === tournamentId) removeStandIn(ctx, row, actorId);
    }
}

/**
 * Review F1 / F2 (A135(3)): the team of these users is (again) still in the tournament: a roll-back un-eliminated it,
 * or an A112 entry transfer made the user a member of it. Their approvals in the tournament go (removeStandIn each).
 */
export function removeTeamMembersStandIns(ctx: any, tournamentId: number, teamId: number, actorId: number): void {
    for (const m of [...ctx.db.TournamentTeamMember.team_id.filter(teamId)]) removeUserStandIns(ctx, tournamentId, m.userId, actorId);
}

/**
 * Review F6: a disqualified member leaves the player and coach seats of every Waiting lobby of the tournament they sit
 * in (LobbyMember.user_id), once the seat is no longer allowed (allowedSlotsFor). Live lobbies keep the seat (A68(6)).
 */
export function unseatInTournamentLobbies(ctx: any, tournamentId: number, userId: number, actorId: number): void {
    for (const m of [...ctx.db.LobbyMember.user_id.filter(userId)]) {
        const lobby = ctx.db.Lobby.id.find(m.lobbyId);
        if (!lobby || lobby.tournamentId !== tournamentId || lobby.bracketMatchId === undefined) continue;
        unseatDisallowed(ctx, lobby.bracketMatchId, userId, actorId);
    }
}

/** SI14: a team left the match (un-placed by a roll-back or re-resolve, or its slot became a BYE): its approvals go. */
export function removeTeamStandIns(ctx: any, bracketMatchId: number, teamId: number, actorId: number): void {
    for (const row of [...ctx.db.TournamentStandIn.bracket_match_id.filter(bracketMatchId)]) {
        if (row.teamId === teamId) removeStandIn(ctx, row, actorId);
    }
}

/**
 * SI1: a team was placed into the match: an approval of one of its members for the other team of the match conflicts
 * and goes (a member never sits on the opposing side, allowedSlotsFor).
 */
export function removeConflictingStandIns(ctx: any, bracketMatchId: number, placedTeamId: number, actorId: number): void {
    for (const row of [...ctx.db.TournamentStandIn.bracket_match_id.filter(bracketMatchId)]) {
        if (row.teamId === placedTeamId) continue;
        const match = ctx.db.BracketMatch.id.find(bracketMatchId);
        if (findMembership(ctx, match.tournamentId, row.userId)?.teamId === placedTeamId) removeStandIn(ctx, row, actorId);
    }
}

/** SI12: the match was decided: release the locks of its stand-ins who did not play (rows stay; a roll-back reopens). */
export function releaseDecidedMatchStandIns(ctx: any, match: any): void {
    for (const row of [...ctx.db.TournamentStandIn.bracket_match_id.filter(match.id)]) {
        releaseStandInLocksIfUnused(ctx, match.tournamentId, row.userId);
    }
}

// ─── Seats: the captain's move and the start gate (A135(4) / A138, A135(5)) ───────────────────────────────────────────────────────────────────

/** The team that plays `side` ('Blue' / 'Red') in the lobby's bracket match, or undefined (casual lobby). */
function sideTeamId(ctx: any, lobby: any, side: string): { match: any; teamId: number | undefined } | undefined {
    if (!lobby.isTournamentControlled || lobby.bracketMatchId === undefined) return undefined;
    const match = ctx.db.BracketMatch.id.find(lobby.bracketMatchId);
    if (!match) return undefined;
    const sides = matchSides(match);
    return { match, teamId: side === 'Blue' ? sides.blueTeamId : sides.redTeamId };
}

/** True when `userId` is a member (TournamentTeamMember) of `teamId`. */
function isTeamMember(ctx: any, tournamentId: number, teamId: number | undefined, userId: number): boolean {
    return teamId !== undefined && findMembership(ctx, tournamentId, userId)?.teamId === teamId;
}

/**
 * A135(4) (SI10), kept by A138: the team captain (TournamentTeam.captainUserId, still a member: isActingCaptain) may move an
 * approved stand-in of their own team in this match to Spectator.
 */
export function isCaptainMovingOwnStandIn(ctx: any, lobby: any, callerId: number, targetUserId: number, slotTag: string): boolean {
    if (slotTag !== 'Spectator' || !lobby.isTournamentControlled || lobby.bracketMatchId === undefined) return false;
    const row = [...ctx.db.TournamentStandIn.by_match_and_user.filter([lobby.bracketMatchId, targetUserId])][0];
    if (!row) return false;
    const team = ctx.db.TournamentTeam.id.find(row.teamId);
    return !!team && isActingCaptain(ctx, team, callerId);
}

/**
 * A135(5) (SI11): the side's seated players include at least one member of the team that plays it. Casual lobbies
 * and lobbies without a bracket match pass. `players` = the non-coach Blue or Red rows.
 */
export function sideHasTeamMember(ctx: any, lobby: any, side: string, players: any[]): boolean {
    const resolved = sideTeamId(ctx, lobby, side);
    if (!resolved) return true;
    return players.some((m: any) => isTeamMember(ctx, resolved.match.tournamentId, resolved.teamId, m.userId));
}
