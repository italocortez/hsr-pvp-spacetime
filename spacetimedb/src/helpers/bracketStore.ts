// ─── Bracket store (A23, A27, A29, review §5.5; S8a) ──────────────────────────────────────────────────────
// Persists the pure shared engine (`@shared/bracket`) as BracketMatch rows and keeps the exact-slot / BYE rules
// of `BracketEngine` against the rows: every slot has one explicit source, an entrant is written into that slot
// only (never "the first empty slot"), a one-BYE match is a Walkover and a two-BYE match is Void.
// S8a: exported, not wired; the legacy `helpers/bracketGeneration.ts` + `reducers/bracketGeneration.ts` keep
// running until S8c replaces them with these helpers.

import { SenderError } from 'spacetimedb/server';
import { groupSpec, type BracketSpec, type SlotSource } from '@shared/bracket';
import { insertWithAudit, updateWithAudit } from './auditHelpers';
import { deleteCalendarEventForBracketMatch } from './calendarCascade';

export type Entrant = number | 'BYE';
export type BracketSlot = 1 | 2;

const tag = (t: string) => ({ tag: t, value: {} }) as any;

/** The entrant a slot holds: a team id, 'BYE', or undefined (empty). */
export function slotEntrant(row: any, slot: BracketSlot): Entrant | undefined {
    if (slot === 1) return row.team1IsBye ? 'BYE' : row.team1Id;
    return row.team2IsBye ? 'BYE' : row.team2Id;
}

const isSettledTag = (t: string) => t === 'Decided' || t === 'Walkover' || t === 'Void';

/**
 * Inserts one BracketMatch per MatchSpec of an elimination spec (single / double, A27 / A29 shapes from the
 * engine), wires the next-match ids through the positionKey → id map (autoInc ids are unknown before the
 * insert), then settles the BYE walkovers / voids. `teamIdsBySeed[i]` is seed i + 1; seeds above
 * `spec.teamCount` are BYEs. bestOf = `tournament.defaultBestOf`, the grand final `grandFinalBestOf` (A28).
 */
export function insertBracket(ctx: any, tournament: any, spec: BracketSpec, teamIdsBySeed: number[], actorId: number): Map<string, number> {
    if (teamIdsBySeed.length !== spec.teamCount) {
        throw new SenderError(`Bracket needs ${spec.teamCount} seeded teams, got ${teamIdsBySeed.length}.`);
    }
    const seedTeam = (src: SlotSource): { id: number | undefined; bye: boolean } => {
        if (src.kind !== 'seed') return { id: undefined, bye: false };
        return src.seed <= spec.teamCount ? { id: teamIdsBySeed[src.seed - 1], bye: false } : { id: undefined, bye: true };
    };
    const ids = new Map<string, number>();
    for (const m of spec.matches) {
        const s1 = seedTeam(m.sources[0]);
        const s2 = seedTeam(m.sources[1]);
        const row = ctx.db.BracketMatch.insert(insertWithAudit(ctx, {
            id: 0,
            tournamentId: tournament.id,
            positionKey: m.key,
            bracketSide: tag(m.side),
            roundNumber: m.round,
            matchNumber: m.number,
            groupId: undefined,
            team1Id: s1.id,
            team2Id: s2.id,
            team1IsBye: s1.bye,
            team2IsBye: s2.bye,
            nextWinnerMatchId: undefined,
            nextWinnerSlot: m.winnerTo?.slot ?? 0,
            nextLoserMatchId: undefined,
            nextLoserSlot: m.loserTo?.slot ?? 0,
            bestOf: m.side === 'GrandFinals' ? tournament.grandFinalBestOf : tournament.defaultBestOf,
            winnerAdvantage: m.winnerAdvantage,
            scheduledAt: undefined,
            state: tag(s1.id !== undefined && s2.id !== undefined ? 'Ready' : 'Pending'),
            winnerTeamId: undefined,
            loserTeamId: undefined,
            decidedBy: undefined,
            team1Games: 0,
            team2Games: 0,
        }, actorId));
        ids.set(m.key, row.id);
    }
    for (const m of spec.matches) {
        if (!m.winnerTo && !m.loserTo) continue;
        const row = ctx.db.BracketMatch.id.find(ids.get(m.key)!);
        ctx.db.BracketMatch.id.update(updateWithAudit(ctx, row, {
            nextWinnerMatchId: m.winnerTo ? ids.get(m.winnerTo.key) : undefined,
            nextLoserMatchId: m.loserTo ? ids.get(m.loserTo.key) : undefined,
        }, actorId));
    }
    settle(ctx, tournament.id, actorId);
    return ids;
}

/**
 * Inserts the round-robin matches of the given groups (team ids; group index = `groupId`, 0-based) as
 * `BracketSide.Group` rows (Ready: both teams known; no next-match routes, standings decide advancement, A23)
 * and writes `TournamentTeam.groupId` for every team.
 */
export function insertGroupBracket(ctx: any, tournament: any, groups: number[][], actorId: number): Map<string, number> {
    const ids = new Map<string, number>();
    for (const g of groupSpec(groups)) {
        const row = ctx.db.BracketMatch.insert(insertWithAudit(ctx, {
            id: 0,
            tournamentId: tournament.id,
            positionKey: g.key,
            bracketSide: tag('Group'),
            roundNumber: g.round,
            matchNumber: g.number,
            groupId: g.groupIndex,
            team1Id: g.team1,
            team2Id: g.team2,
            team1IsBye: false,
            team2IsBye: false,
            nextWinnerMatchId: undefined,
            nextWinnerSlot: 0,
            nextLoserMatchId: undefined,
            nextLoserSlot: 0,
            bestOf: tournament.defaultBestOf,
            winnerAdvantage: 0,
            scheduledAt: undefined,
            state: tag('Ready'),
            winnerTeamId: undefined,
            loserTeamId: undefined,
            decidedBy: undefined,
            team1Games: 0,
            team2Games: 0,
        }, actorId));
        ids.set(g.key, row.id);
    }
    groups.forEach((teamIds, groupIndex) => {
        for (const teamId of teamIds) {
            const team = ctx.db.TournamentTeam.id.find(teamId);
            if (!team) throw new SenderError(`Team ${teamId} not found.`);
            if (team.groupId !== groupIndex) {
                ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { groupId: groupIndex }, actorId));
            }
        }
    });
    return ids;
}

/**
 * Writes an entrant into its exact slot. The same entrant already there → no-op; a different one → throws.
 * Pending → Ready once both slots hold real teams (BYE slots are resolved by `settle`).
 */
export function placeEntrant(ctx: any, matchId: number, slot: BracketSlot, teamId: Entrant, actorId: number): void {
    const row = ctx.db.BracketMatch.id.find(matchId);
    if (!row) throw new SenderError(`Bracket match ${matchId} not found.`);
    const current = slotEntrant(row, slot);
    if (current === teamId) return;
    if (current !== undefined) {
        throw new SenderError(`${row.positionKey} slot ${slot} already holds ${current === 'BYE' ? 'BYE' : `team ${current}`}.`);
    }
    const changes: any = slot === 1
        ? { team1Id: teamId === 'BYE' ? undefined : teamId, team1IsBye: teamId === 'BYE' }
        : { team2Id: teamId === 'BYE' ? undefined : teamId, team2IsBye: teamId === 'BYE' };
    const other = slotEntrant(row, slot === 1 ? 2 : 1);
    if (row.state.tag === 'Pending' && typeof teamId === 'number' && typeof other === 'number') changes.state = tag('Ready');
    ctx.db.BracketMatch.id.update(updateWithAudit(ctx, row, changes, actorId));
}

/**
 * Resolves BYEs until stable: a match holding one BYE and one real team becomes a Walkover with that team as
 * winner (no loser; the BYE goes down the loser route), a match holding two BYEs becomes Void and sends a BYE
 * down both routes. Decided / Walkover / Void matches are never touched. Walkovers are structural (no result),
 * which is why this is the one place besides `applyBracketResult` that stamps `winnerTeamId`.
 */
export function settle(ctx: any, tournamentId: number, actorId: number): void {
    let changed = true;
    while (changed) {
        changed = false;
        for (const snapshot of [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)]) {
            const row = ctx.db.BracketMatch.id.find(snapshot.id); // re-read: earlier routes of this pass may have filled it
            if (isSettledTag(row.state.tag)) continue;
            const a = slotEntrant(row, 1);
            const b = slotEntrant(row, 2);
            if (a === undefined || b === undefined) continue;
            if (a !== 'BYE' && b !== 'BYE') continue;
            const winner: Entrant = a === 'BYE' ? b : a;
            ctx.db.BracketMatch.id.update(updateWithAudit(ctx, row, {
                state: tag(winner === 'BYE' ? 'Void' : 'Walkover'),
                winnerTeamId: winner === 'BYE' ? undefined : winner,
                loserTeamId: undefined,
            }, actorId));
            if (row.nextWinnerMatchId !== undefined) placeEntrant(ctx, row.nextWinnerMatchId, row.nextWinnerSlot, winner, actorId);
            if (row.nextLoserMatchId !== undefined) placeEntrant(ctx, row.nextLoserMatchId, row.nextLoserSlot, 'BYE', actorId);
            changed = true;
        }
    }
}

/**
 * Deletes every BracketMatch of the tournament with its TournamentStandIn rows and its calendar events
 * (CalendarEvent.bracketMatchId, with their invites), and clears `TournamentTeam.groupId`. `seedNumber` stays:
 * seeding is separate from generation (review T20: regeneration no longer orphans events). `actorId` stamps the
 * team audit columns (system user when omitted).
 */
export function deleteBracket(ctx: any, tournamentId: number, actorId?: number): void {
    for (const row of [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)]) {
        for (const standIn of [...ctx.db.TournamentStandIn.bracket_match_id.filter(row.id)]) {
            ctx.db.TournamentStandIn.id.delete(standIn.id);
        }
        deleteCalendarEventForBracketMatch(ctx, row.id);
        ctx.db.BracketMatch.id.delete(row.id);
    }
    for (const team of [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)]) {
        if (team.groupId !== undefined) {
            ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { groupId: undefined }, actorId));
        }
    }
}
