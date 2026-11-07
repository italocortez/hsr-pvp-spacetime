// A35 seat enforcement core (`allowedSlotsFor`, D.8.5), moved from the prototype in S8a. Pure; the module glue
// `spacetimedb/src/helpers/tournamentLobbySides.ts` resolves the bracket match, team memberships and stand-ins, then calls this.

import type { Slot } from './refereeTransfer';

export interface SeatContext {
    /** false for casual lobbies: every slot is allowed (today's rules apply). */
    isTournamentControlled: boolean;
    team1MemberIds: readonly number[];
    team2MemberIds: readonly number[];
    /** Approved stand-ins carry the team they stand in for (TournamentStandIn.teamId, new column). */
    team1StandInIds: readonly number[];
    team2StandInIds: readonly number[];
}

export const ALL_SLOTS: readonly Slot[] = ['BluePlayer', 'BlueCoach', 'RedPlayer', 'RedCoach', 'Spectator'];

/**
 * Decision recorded in ACCESS-SECURITY-OPS.md (delegated by the user): coaches COUNT as team
 * members for seat enforcement. A member or stand-in of team1 may take BluePlayer or BlueCoach;
 * of team2, RedPlayer or RedCoach. Everyone else, staff included, may only be a Spectator.
 * Spectator is always allowed (a player may step back to watch).
 */
export function allowedSlotsFor(ctx: SeatContext, userId: number): ReadonlySet<Slot> {
    if (!ctx.isTournamentControlled) return new Set(ALL_SLOTS);
    const onTeam1 = ctx.team1MemberIds.includes(userId) || ctx.team1StandInIds.includes(userId);
    const onTeam2 = ctx.team2MemberIds.includes(userId) || ctx.team2StandInIds.includes(userId);
    const allowed = new Set<Slot>(['Spectator']);
    if (onTeam1) { allowed.add('BluePlayer'); allowed.add('BlueCoach'); }
    if (onTeam2) { allowed.add('RedPlayer'); allowed.add('RedCoach'); }
    return allowed;
}

/** A26: the auto-seat on join. Team members land on their side as players; others spectate. */
export function autoSeatFor(ctx: SeatContext, userId: number): Slot {
    const allowed = allowedSlotsFor(ctx, userId);
    if (allowed.has('BluePlayer')) return 'BluePlayer';
    if (allowed.has('RedPlayer')) return 'RedPlayer';
    return 'Spectator';
}
