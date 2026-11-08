// ─── Tournament lobby seat enforcement glue (A35, ACCESS-SECURITY-OPS §D.8.5; S8a) ─────────────────────────
// Resolves the bracket match's teams and stand-ins and calls the pure core `allowedSlotsFor` of
// `@shared/lobby-rules`. S8a: exported; S8d wires it into `join_lobby` (auto-seat) and `set_team_slot` (A35, A26).

import { SenderError } from 'spacetimedb/server';
import { allowedSlotsFor as allowedSlotsCore, ALL_SLOTS, type Slot } from '@shared/lobby-rules';
import { slotIsCoach, slotTeam } from './lobbyHelpers';

export type LobbySlotTag = Slot;

/** Team member user ids plus the approved stand-ins of that team for this bracket match. */
function sideUserIds(ctx: any, bracketMatchId: number, teamId: number | undefined): { members: number[]; standIns: number[] } {
    if (teamId === undefined) return { members: [], standIns: [] };
    const members = [...ctx.db.TournamentTeamMember.team_id.filter(teamId)].map((m: any) => m.userId);
    const standIns = [...ctx.db.TournamentStandIn.bracket_match_id.filter(bracketMatchId)]
        .filter((s: any) => s.teamId === teamId)
        .map((s: any) => s.userId);
    return { members, standIns };
}

/**
 * A35: in a tournament lobby, members of `BracketMatch.team1Id` and its approved stand-ins (TournamentStandIn
 * rows exist only once approved) may take BluePlayer / BlueCoach, team2 RedPlayer / RedCoach (coaches follow the
 * team rule, D.8.5); everyone else, staff included, Spectator only. Spectator is always allowed. A casual lobby
 * (or one without a bracket match) allows every slot.
 */
export function allowedSlotsFor(ctx: any, lobby: any, userId: number): LobbySlotTag[] {
    if (!lobby.isTournamentControlled || lobby.bracketMatchId === undefined) return [...ALL_SLOTS];
    const match = ctx.db.BracketMatch.id.find(lobby.bracketMatchId);
    if (!match) return ['Spectator'];
    const team1 = sideUserIds(ctx, match.id, match.team1Id);
    const team2 = sideUserIds(ctx, match.id, match.team2Id);
    const allowed = allowedSlotsCore({
        isTournamentControlled: true,
        team1MemberIds: team1.members,
        team2MemberIds: team2.members,
        team1StandInIds: team1.standIns,
        team2StandInIds: team2.standIns,
    }, userId);
    return ALL_SLOTS.filter((s) => allowed.has(s));
}

/** A35 (S8d): rejects a slot outside allowedSlotsFor in a tournament lobby; a casual lobby allows every slot. */
export function ensureSeatAllowed(ctx: any, lobby: any, userId: number, slotTag: string): void {
    if (!allowedSlotsFor(ctx, lobby, userId).includes(slotTag as LobbySlotTag)) {
        throw new SenderError('This seat is not available to you in this tournament lobby.');
    }
}

/**
 * A26 / A35 (S8d): the seat a member gets on joining (or creating) a tournament lobby: the player slot of the team
 * the user belongs to (member or approved stand-in) while that team has a free player seat (fewer than teamSize
 * non-coach members on that side); coaches are never auto-seated; everyone else, and a player whose side is full,
 * Spectator. A casual lobby: Spectator (D-27, unchanged).
 */
export function autoSeatSlot(ctx: any, lobby: any, userId: number): LobbySlotTag {
    if (!lobby.isTournamentControlled) return 'Spectator';
    const allowed = allowedSlotsFor(ctx, lobby, userId);
    const playerSlot = allowed.find((s) => s === 'BluePlayer' || s === 'RedPlayer');
    if (!playerSlot) return 'Spectator';
    const side = playerSlot === 'BluePlayer' ? 'Blue' : 'Red';
    const seated = [...ctx.db.LobbyMember.lobby_id.filter(lobby.id)]
        .filter((m: any) => m.userId !== userId && slotTeam(m.lobbySlot) === side && !slotIsCoach(m.lobbySlot)).length;
    return seated < lobby.teamSize ? playerSlot : 'Spectator';
}
