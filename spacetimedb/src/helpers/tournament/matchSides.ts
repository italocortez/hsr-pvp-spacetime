// ─── Bracket match colours (A70(1), A71, A35; S8g) ──────────────────────────────────────────────────────────
// The one place that maps a bracket match's teams to lobby colours. Blue = `blueTeamId` when it is one of the
// match's two teams; unset, or stale (a slot replaced after a DQ or a rollback), falls back to A35's default
// (team1 = Blue, team2 = Red). Every colour <-> team question (seating, result credit, tally, DQ side) goes
// through these helpers; the head start is not one (A71(1): always team1); no other code compares team1Id with a colour.

export type SideTag = 'Blue' | 'Red';
export type MatchSlot = 1 | 2;

/** A70(1): the slot (1 = team1, 2 = team2) that plays `side`; undefined for any other tag. */
export function sideSlot(match: any, side: string | undefined): MatchSlot | undefined {
    if (side !== 'Blue' && side !== 'Red') return undefined;
    const blueId = match.blueTeamId;
    const blueSlot: MatchSlot = blueId !== undefined && blueId === match.team2Id ? 2 : 1; // default / stale: team1 = Blue
    return side === 'Blue' ? blueSlot : blueSlot === 1 ? 2 : 1;
}

/** A70(1): the team that plays `side` in this match's lobbies, or undefined. */
export function sideTeamId(match: any, side: string | undefined): number | undefined {
    const slot = sideSlot(match, side);
    return slot === 1 ? match.team1Id : slot === 2 ? match.team2Id : undefined;
}

/** A70(1): the colour `teamId` plays in this match's lobbies, or undefined when it does not play the match. */
export function teamSideOf(match: any, teamId: number | undefined): SideTag | undefined {
    if (teamId === undefined) return undefined;
    if (sideTeamId(match, 'Blue') === teamId) return 'Blue';
    if (sideTeamId(match, 'Red') === teamId) return 'Red';
    return undefined;
}

/** A70(1): both teams by colour. */
export function matchSides(match: any): { blueTeamId: number | undefined; redTeamId: number | undefined } {
    return { blueTeamId: sideTeamId(match, 'Blue'), redTeamId: sideTeamId(match, 'Red') };
}

/**
 * A71(3): the columns written with every slot change of a match: the colour choice is voided (made for the old
 * pairing) and the stored tally is set to the derived one, which has no counted game on a match whose slot changes:
 * team1 = winnerAdvantage (A27, A69(1)), team2 = 0.
 */
export function slotChangeReset(match: any): { blueTeamId: undefined; team1Games: number; team2Games: number } {
    return { blueTeamId: undefined, team1Games: match.winnerAdvantage, team2Games: 0 };
}
