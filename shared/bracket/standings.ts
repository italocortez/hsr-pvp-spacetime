// Group standings (A23: computed, never stored; A30 ranking rule; A31 no draws). Pure: no `spacetimedb` / `react`.
// Runs on the server when advancing out of groups (`helpers/tournament/tournamentStandings.ts`) and in the web app for the
// live standings table, so the two cannot disagree.

/** A decided group match; the games are the stored series score of `BracketMatch` (team1Games / team2Games). */
export interface DecidedGroupMatch {
    team1Id: number;
    team2Id: number;
    winnerTeamId: number;
    team1Games: number;
    team2Games: number;
}

export interface GroupTeam {
    teamId: number;
    seedNumber: number;   // lower = better; the glue passes +Infinity-like values for unseeded teams
}

export interface RankedTeam {
    teamId: number;
    rank: number;         // 1-based, unique (the A30 order is total)
    wins: number;
    gameDiff: number;
}

/** Per-team totals of one group, the input of the comparator. */
export interface GroupTeamStats {
    teamId: number;
    seedNumber: number;
    wins: number;
    gameDiff: number;     // own games minus opponents' games over the group's decided matches
}

/** Wins and game differential per team (matches with a team outside `teams` are ignored). */
export function groupTeamStats(matches: readonly DecidedGroupMatch[], teams: readonly GroupTeam[]): GroupTeamStats[] {
    const stats = new Map<number, GroupTeamStats>(teams.map((t) => [t.teamId, { teamId: t.teamId, seedNumber: t.seedNumber, wins: 0, gameDiff: 0 }]));
    for (const m of matches) {
        const a = stats.get(m.team1Id);
        const b = stats.get(m.team2Id);
        if (!a || !b) continue;
        if (m.winnerTeamId === a.teamId) a.wins++;
        else if (m.winnerTeamId === b.teamId) b.wins++;
        a.gameDiff += m.team1Games - m.team2Games;
        b.gameDiff += m.team2Games - m.team1Games;
    }
    return [...stats.values()];
}

/** The winner of the decided match between two teams, if they have played. */
function headToHeadWinner(matches: readonly DecidedGroupMatch[], x: number, y: number): number | undefined {
    const m = matches.find((r) => (r.team1Id === x && r.team2Id === y) || (r.team1Id === y && r.team2Id === x));
    return m?.winnerTeamId;
}

/**
 * The A30 comparator (negative = `a` ranks above `b`): points (wins; A31 no draws) → head-to-head, **only when
 * exactly two teams of the group are tied on wins** → game differential across the group → seed (lower seed
 * number first) → team id (only so the order is total). `all` is the whole group, used to size the tie.
 */
export function compareGroupTeams(
    a: GroupTeamStats,
    b: GroupTeamStats,
    matches: readonly DecidedGroupMatch[],
    all: readonly GroupTeamStats[],
): number {
    if (a.wins !== b.wins) return b.wins - a.wins;
    if (all.filter((t) => t.wins === a.wins).length === 2) {
        const h2h = headToHeadWinner(matches, a.teamId, b.teamId);
        if (h2h === a.teamId) return -1;
        if (h2h === b.teamId) return 1;
    }
    if (a.gameDiff !== b.gameDiff) return b.gameDiff - a.gameDiff;
    if (a.seedNumber !== b.seedNumber) return a.seedNumber - b.seedNumber;
    return a.teamId - b.teamId;
}

/** A30: ranks one group from its decided matches. */
export function rankGroup(matches: readonly DecidedGroupMatch[], teams: readonly GroupTeam[]): RankedTeam[] {
    const stats = groupTeamStats(matches, teams);
    return [...stats]
        .sort((a, b) => compareGroupTeams(a, b, matches, stats))
        .map((s, i) => ({ teamId: s.teamId, rank: i + 1, wins: s.wins, gameDiff: s.gameDiff }));
}
