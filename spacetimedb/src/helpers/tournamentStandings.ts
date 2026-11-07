// ─── Group standings glue (A23, A30, A31, A32; S8a) ───────────────────────────────────────────────────────
// Reads the rows and feeds the pure `rankGroup` / `placeQualifiers` of `@shared/bracket`, so the server and the
// web standings table use one comparator. Standings are computed, never stored (GroupPhaseRecord was dropped).

import { placeQualifiers, rankGroup, type DecidedGroupMatch, type RankedTeam } from '@shared/bracket';

/** Unseeded teams rank after every seeded one on the last tie-break. */
const UNSEEDED = Number.MAX_SAFE_INTEGER;
/** A26: statuses that can never be placed in the elimination bracket. */
const EXCLUDED_STATUSES = new Set(['Withdrawn', 'Disqualified', 'Eliminated']);

/** A30 ranking of one group from its Decided group matches (`TournamentTeam.groupId` = `groupId`). */
export function groupStandings(ctx: any, tournamentId: number, groupId: number): RankedTeam[] {
    const teams = [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)]
        .filter((t: any) => t.groupId === groupId)
        .map((t: any) => ({ teamId: t.id, seedNumber: t.seedNumber ?? UNSEEDED }));
    const matches: DecidedGroupMatch[] = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)]
        .filter((m: any) => m.bracketSide.tag === 'Group' && m.groupId === groupId && m.state.tag === 'Decided'
            && m.team1Id !== undefined && m.team2Id !== undefined && m.winnerTeamId !== undefined)
        .map((m: any) => ({
            team1Id: m.team1Id,
            team2Id: m.team2Id,
            winnerTeamId: m.winnerTeamId,
            team1Games: m.team1Games,
            team2Games: m.team2Games,
        }));
    return rankGroup(matches, teams);
}

/**
 * The elimination `teamIdsBySeed` after the group stage: every group (0 .. highest `TournamentTeam.groupId`)
 * ranked by `groupStandings`, then `placeQualifiers` (top `groupAdvanceCount` per group, review T7). A26: the team
 * status is the single gate for bracket placement, so Withdrawn, Disqualified and Eliminated teams are dropped from
 * each ranked list before placement (`groupStandings` itself stays complete for display).
 */
export function qualifiersFor(ctx: any, tournamentId: number, groupAdvanceCount: number): number[] {
    let maxGroup = -1;
    for (const t of ctx.db.TournamentTeam.tournament_id.filter(tournamentId)) {
        if (t.groupId !== undefined && t.groupId > maxGroup) maxGroup = t.groupId;
    }
    const excluded = new Set<number>();
    for (const t of ctx.db.TournamentTeam.tournament_id.filter(tournamentId)) {
        if (EXCLUDED_STATUSES.has(t.status.tag)) excluded.add(t.id);
    }
    const ranked: number[][] = [];
    for (let g = 0; g <= maxGroup; g++) {
        ranked.push(groupStandings(ctx, tournamentId, g).map((r) => r.teamId).filter((id) => !excluded.has(id)));
    }
    return placeQualifiers(ranked, groupAdvanceCount);
}
