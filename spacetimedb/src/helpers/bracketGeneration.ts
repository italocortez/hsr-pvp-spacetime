/**
 * Pure bracket generation helper functions.
 * These functions compute match descriptors but do NOT touch the database.
 * The reducer (bracketGeneration.ts) handles all DB operations.
 */

// ─── BracketMatchDescriptor ───────────────────────────────────────────────────

export interface BracketMatchDescriptor {
    roundNumber: number;
    matchNumber: number;
    bracketSide: string;        // 'Winners' | 'Losers' | 'GrandFinals' | 'ThirdPlace' | 'Group'
    groupId?: number;
    team1Id?: number;           // TournamentTeam.id
    team2Id?: number;           // TournamentTeam.id
    bestOf: number;
    winnerAdvantage: number;
    winnerTeamId?: number;      // Pre-set for BYE matches
    // Position-based references for FK wiring (resolved to real IDs by reducer):
    positionKey: string;        // Unique key like "W-R1-M1" (bracket side initial + round + match)
    nextWinnerRef?: string;     // positionKey of match winner advances to
    nextLoserRef?: string;      // positionKey of match loser goes to (double elim only)
    isParticipant1Slot?: boolean; // true = place in slot 1 of next match, false = slot 2
}

// ─── Helper: nextPowerOf2 ─────────────────────────────────────────────────────

function nextPowerOf2(n: number): number {
    let p = 1;
    while (p < n) p *= 2;
    return p;
}

// ─── Function 1: foldSeeding ──────────────────────────────────────────────────

/**
 * Standard fold/mirror seeding algorithm.
 * Input: bracketSize (must be a power of 2).
 * Output: array of [seed1, seed2] matchups in round-1 order.
 * Example: bracketSize=8 produces [[1,8],[4,5],[2,7],[3,6]].
 */
export function foldSeeding(bracketSize: number): number[][] {
    // Start with a 2-slot bracket
    let matchups: number[][] = [[1, 2]];
    let currentSize = 2;

    while (currentSize < bracketSize) {
        const newMatchups: number[][] = [];
        const nextSize = currentSize * 2;
        for (const [a, b] of matchups) {
            // Each existing match splits into two:
            // seed a vs (nextSize + 1 - a), seed b vs (nextSize + 1 - b)
            newMatchups.push([a, nextSize + 1 - a]);
            newMatchups.push([b, nextSize + 1 - b]);
        }
        matchups = newMatchups;
        currentSize = nextSize;
    }
    return matchups;
}

// ─── Function 2: generateSingleElimBracket ───────────────────────────────────

/**
 * Generates match descriptors for a single elimination bracket.
 * teamIds: sorted by seed (index 0 = seed 1). Length can be any number >= 2.
 * BYE matches have winnerTeamId pre-set to the non-BYE participant.
 */
export function generateSingleElimBracket(
    teamIds: number[],
    bestOf: number,
    has3rdPlaceMatch: boolean,
): BracketMatchDescriptor[] {
    const teamCount = teamIds.length;
    const bracketSize = nextPowerOf2(teamCount);
    const totalRounds = Math.log2(bracketSize);

    // Generate fold seeding matchups
    const matchups = foldSeeding(bracketSize);

    const descriptors: BracketMatchDescriptor[] = [];

    // Round 1: one match per matchup from fold seeding
    for (let m = 0; m < matchups.length; m++) {
        const [seed1, seed2] = matchups[m];
        const matchNumber = m + 1;
        const positionKey = `W-R1-M${matchNumber}`;

        // Map seed numbers to teamIds (1-indexed seeds)
        const team1 = seed1 <= teamCount ? teamIds[seed1 - 1] : undefined;
        const team2 = seed2 <= teamCount ? teamIds[seed2 - 1] : undefined;

        // Determine next winner ref: R1-M1 and R1-M2 both point to R2-M1, etc.
        const nextMatchNumber = Math.ceil(matchNumber / 2);
        const nextWinnerRef = totalRounds >= 2 ? `W-R2-M${nextMatchNumber}` : undefined;
        const isParticipant1Slot = matchNumber % 2 === 1; // odd -> slot 1, even -> slot 2

        let winnerTeamId: number | undefined;
        // If exactly one participant (the other is BYE), pre-set winner
        if (team1 !== undefined && team2 === undefined) {
            winnerTeamId = team1;
        } else if (team1 === undefined && team2 !== undefined) {
            winnerTeamId = team2;
        }

        descriptors.push({
            roundNumber: 1,
            matchNumber,
            bracketSide: 'Winners',
            team1Id: team1,
            team2Id: team2,
            bestOf,
            winnerAdvantage: 0,
            winnerTeamId,
            positionKey,
            nextWinnerRef,
            isParticipant1Slot,
        });
    }

    // Rounds 2 through totalRounds (inner rounds)
    for (let round = 2; round <= totalRounds; round++) {
        const matchesInRound = bracketSize / Math.pow(2, round);
        for (let m = 1; m <= matchesInRound; m++) {
            const positionKey = `W-R${round}-M${m}`;
            const nextMatchNumber = Math.ceil(m / 2);
            const nextWinnerRef = round < totalRounds ? `W-R${round + 1}-M${nextMatchNumber}` : undefined;
            const isParticipant1Slot = m % 2 === 1;

            descriptors.push({
                roundNumber: round,
                matchNumber: m,
                bracketSide: 'Winners',
                team1Id: undefined,
                team2Id: undefined,
                bestOf,
                winnerAdvantage: 0,
                positionKey,
                nextWinnerRef,
                isParticipant1Slot,
            });
        }
    }

    // Optional 3rd place match
    if (has3rdPlaceMatch && totalRounds >= 2) {
        const semifinalRound = totalRounds - 1;
        const thirdPlaceKey = `TP-R${totalRounds}-M1`;

        // The two semifinal matches lose to the 3rd place match
        // Semifinal = round (totalRounds - 1), matches 1 and 2
        for (let m = 1; m <= 2; m++) {
            const semifinalKey = `W-R${semifinalRound}-M${m}`;
            const semifinal = descriptors.find(d => d.positionKey === semifinalKey);
            if (semifinal) {
                semifinal.nextLoserRef = thirdPlaceKey;
            }
        }

        descriptors.push({
            roundNumber: totalRounds,
            matchNumber: 1,
            bracketSide: 'ThirdPlace',
            team1Id: undefined,
            team2Id: undefined,
            bestOf,
            winnerAdvantage: 0,
            positionKey: thirdPlaceKey,
        });
    }

    return descriptors;
}

// ─── Function 3: generateDoubleElimBracket ────────────────────────────────────

/**
 * Generates match descriptors for a double elimination bracket.
 * Includes winners bracket, losers bracket (alternating minor/major rounds),
 * Grand Finals, and optional 3rd place match.
 */
export function generateDoubleElimBracket(
    teamIds: number[],
    bestOf: number,
    winnerAdvantage: number,
    has3rdPlaceMatch: boolean,
): BracketMatchDescriptor[] {
    const teamCount = teamIds.length;
    const bracketSize = nextPowerOf2(teamCount);
    const wbRounds = Math.log2(bracketSize);

    // Generate fold seeding
    const matchups = foldSeeding(bracketSize);
    const descriptors: BracketMatchDescriptor[] = [];

    // ── Winners Bracket ──────────────────────────────────────────────────────

    // Round 1
    for (let m = 0; m < matchups.length; m++) {
        const [seed1, seed2] = matchups[m];
        const matchNumber = m + 1;
        const positionKey = `W-R1-M${matchNumber}`;

        const team1 = seed1 <= teamCount ? teamIds[seed1 - 1] : undefined;
        const team2 = seed2 <= teamCount ? teamIds[seed2 - 1] : undefined;

        const nextMatchNumber = Math.ceil(matchNumber / 2);
        const nextWinnerRef = wbRounds >= 2 ? `W-R2-M${nextMatchNumber}` : undefined;
        const isParticipant1Slot = matchNumber % 2 === 1;

        // WR1 losers -> LR1 (crossed order)
        // matchNumber 1 -> the "opposite side" in LB round 1
        const lbMatchesR1 = bracketSize / 4;
        const nextLoserRef = lbMatchesR1 > 0
            ? `L-R1-M${crossedLosersPosition(matchNumber, bracketSize / 2, lbMatchesR1)}`
            : undefined;

        let winnerTeamId: number | undefined;
        if (team1 !== undefined && team2 === undefined) winnerTeamId = team1;
        else if (team1 === undefined && team2 !== undefined) winnerTeamId = team2;

        descriptors.push({
            roundNumber: 1,
            matchNumber,
            bracketSide: 'Winners',
            team1Id: team1,
            team2Id: team2,
            bestOf,
            winnerAdvantage: 0,
            winnerTeamId,
            positionKey,
            nextWinnerRef,
            nextLoserRef,
            isParticipant1Slot,
        });
    }

    // Winners bracket rounds 2 through wbRounds
    for (let round = 2; round <= wbRounds; round++) {
        const matchesInRound = bracketSize / Math.pow(2, round);
        for (let m = 1; m <= matchesInRound; m++) {
            const positionKey = `W-R${round}-M${m}`;
            const nextMatchNumber = Math.ceil(m / 2);
            const nextWinnerRef = round < wbRounds ? `W-R${round + 1}-M${nextMatchNumber}` : undefined;
            const isParticipant1Slot = m % 2 === 1;

            // WR{round} losers feed into LR{2*(round-1)} (major rounds), crossed
            const lbFeedRound = 2 * (round - 1);
            const lbMatchesInFeedRound = Math.max(1, bracketSize / Math.pow(2, round + 1));
            const nextLoserRef = `L-R${lbFeedRound}-M${crossedLosersPosition(m, matchesInRound, lbMatchesInFeedRound)}`;

            // Grand finals: WB final winner goes to GF
            const gfRef = round === wbRounds ? 'GF-R1-M1' : undefined;
            const actualNextWinnerRef = round === wbRounds ? gfRef : nextWinnerRef;

            descriptors.push({
                roundNumber: round,
                matchNumber: m,
                bracketSide: 'Winners',
                team1Id: undefined,
                team2Id: undefined,
                bestOf,
                winnerAdvantage: 0,
                positionKey,
                nextWinnerRef: actualNextWinnerRef,
                nextLoserRef: round < wbRounds ? nextLoserRef : undefined,
                isParticipant1Slot,
            });
        }
    }

    // ── Losers Bracket ───────────────────────────────────────────────────────
    // Losers bracket has (wbRounds - 1) * 2 rounds total
    const lbTotalRounds = (wbRounds - 1) * 2;

    for (let lbRound = 1; lbRound <= lbTotalRounds; lbRound++) {
        const isMinorRound = lbRound % 2 === 1; // odd = minor (internal), even = major (WB feed-in)
        const matchesInLbRound = lbMatchCount(lbRound, bracketSize);

        for (let m = 1; m <= matchesInLbRound; m++) {
            const positionKey = `L-R${lbRound}-M${m}`;
            const nextMatchNumber = Math.ceil(m / 2);

            let nextWinnerRef: string | undefined;
            if (lbRound < lbTotalRounds) {
                nextWinnerRef = `L-R${lbRound + 1}-M${isMinorRound ? nextMatchNumber : m}`;
            } else {
                // LB final winner goes to GF as participant 2
                nextWinnerRef = 'GF-R1-M1';
            }

            descriptors.push({
                roundNumber: lbRound,
                matchNumber: m,
                bracketSide: 'Losers',
                team1Id: undefined,
                team2Id: undefined,
                bestOf,
                winnerAdvantage: 0,
                positionKey,
                nextWinnerRef,
                isParticipant1Slot: isMinorRound ? (m % 2 === 1) : true, // major rounds: WB losers go in slot 2
            });
        }
    }

    // ── Grand Finals ─────────────────────────────────────────────────────────
    descriptors.push({
        roundNumber: 1,
        matchNumber: 1,
        bracketSide: 'GrandFinals',
        team1Id: undefined,
        team2Id: undefined,
        bestOf,
        winnerAdvantage,
        positionKey: 'GF-R1-M1',
    });

    // ── Optional 3rd Place Match ──────────────────────────────────────────────
    if (has3rdPlaceMatch && wbRounds >= 2) {
        const semifinalRound = wbRounds - 1;
        const thirdPlaceKey = 'TP-R1-M1';

        // WB semifinal losers go to 3rd place
        for (let m = 1; m <= 2; m++) {
            const semifinalKey = `W-R${semifinalRound}-M${m}`;
            const semifinal = descriptors.find(d => d.positionKey === semifinalKey);
            if (semifinal) {
                semifinal.nextLoserRef = thirdPlaceKey;
            }
        }

        descriptors.push({
            roundNumber: 1,
            matchNumber: 1,
            bracketSide: 'ThirdPlace',
            team1Id: undefined,
            team2Id: undefined,
            bestOf,
            winnerAdvantage: 0,
            positionKey: thirdPlaceKey,
        });
    }

    return descriptors;
}

/**
 * Returns the number of matches in a losers bracket round for a given bracket size.
 * LR1 (minor): bracketSize/4 matches
 * LR2 (major): bracketSize/4 matches
 * LR3 (minor): bracketSize/8 matches
 * LR4 (major): bracketSize/8 matches
 * Pattern: rounds 2k-1 and 2k share the same match count = bracketSize / 2^(k+1)
 */
function lbMatchCount(lbRound: number, bracketSize: number): number {
    const k = Math.ceil(lbRound / 2);
    return Math.max(1, bracketSize / Math.pow(2, k + 1));
}

/**
 * Computes crossed loser position to minimize rematches.
 * Mirrors position: within `totalMatches` matches, position m maps to (totalMatches + 1 - m).
 * Example: WR1-M1 -> LR1-M(last), WR1-M2 -> LR1-M(last-1), etc.
 */
function crossedLosersPosition(matchNumber: number, totalWbMatches: number, totalLbMatches: number): number {
    // Cross by reversing position relative to LB match count
    const normalizedPos = Math.ceil((matchNumber / totalWbMatches) * totalLbMatches);
    return Math.max(1, totalLbMatches + 1 - normalizedPos);
}

// ─── Function 4: circleSchedule ──────────────────────────────────────────────

/**
 * Round-robin circle method scheduling.
 * Input: array of teamIds.
 * Output: array of rounds, each containing [teamId1, teamId2] matchups.
 * Skips pairs where either team is the BYE sentinel (-1).
 */
export function circleSchedule(teamIds: number[]): [number, number][][] {
    const teams = [...teamIds];
    // If odd count, add BYE sentinel
    if (teams.length % 2 !== 0) teams.push(-1);

    const n = teams.length;
    const rounds: [number, number][][] = [];

    for (let round = 0; round < n - 1; round++) {
        const matches: [number, number][] = [];
        for (let i = 0; i < n / 2; i++) {
            const home = teams[i];
            const away = teams[n - 1 - i];
            // Skip BYE pairs
            if (home !== -1 && away !== -1) {
                matches.push([home, away]);
            }
        }
        rounds.push(matches);

        // Rotate: fix teams[0], rotate the rest
        const last = teams.pop()!;
        teams.splice(1, 0, last);
    }

    return rounds;
}

// ─── Function 5: snakeSeedIntoGroups ─────────────────────────────────────────

/**
 * Snake/serpentine distribution of teams into groups.
 * Input: sortedTeamIds (index 0 = seed 1), groupCount.
 * Output: Map of groupId (0-based) -> teamId arrays.
 * Example: 8 teams, 2 groups -> Group 0: [1,4,5,8], Group 1: [2,3,6,7]
 */
export function snakeSeedIntoGroups(sortedTeamIds: number[], groupCount: number): Map<number, number[]> {
    const groups = new Map<number, number[]>();
    for (let g = 0; g < groupCount; g++) groups.set(g, []);

    let forward = true;
    let groupIdx = 0;

    for (const teamId of sortedTeamIds) {
        groups.get(groupIdx)!.push(teamId);

        if (forward) {
            if (groupIdx === groupCount - 1) {
                forward = false; // Reached the end, reverse direction next
            } else {
                groupIdx++;
            }
        } else {
            if (groupIdx === 0) {
                forward = true; // Reached the start, go forward next
            } else {
                groupIdx--;
            }
        }
    }

    return groups;
}

// ─── Function 6: generateGroupPhaseBracket ───────────────────────────────────

/**
 * Generates match descriptors and group assignments for a round-robin group phase.
 * Returns both match descriptors and group assignments (for GroupPhaseRecord row creation).
 */
export function generateGroupPhaseBracket(
    teamIds: number[],
    groupSize: number,
    bestOf: number,
    groupAssignmentMode: string,
): { matches: BracketMatchDescriptor[], groupAssignments: Map<number, number[]> } {
    const teamCount = teamIds.length;
    const groupCount = Math.ceil(teamCount / groupSize);

    let groupAssignments: Map<number, number[]>;

    if (groupAssignmentMode === 'Auto') {
        groupAssignments = snakeSeedIntoGroups(teamIds, groupCount);
    } else {
        // Manual mode: sequential assignment (TO can later swap seeds to change groups)
        groupAssignments = new Map<number, number[]>();
        for (let g = 0; g < groupCount; g++) groupAssignments.set(g, []);
        for (let i = 0; i < teamIds.length; i++) {
            const g = i % groupCount;
            groupAssignments.get(g)!.push(teamIds[i]);
        }
    }

    const matches: BracketMatchDescriptor[] = [];
    let globalMatchCounter = 0; // For globally unique match numbering per group

    for (const [groupId, groupTeamIds] of groupAssignments) {
        if (groupTeamIds.length === 0) continue;

        const rounds = circleSchedule(groupTeamIds);
        let groupMatchNumber = 0;

        for (let roundIdx = 0; roundIdx < rounds.length; roundIdx++) {
            const roundMatches = rounds[roundIdx];
            for (const [team1, team2] of roundMatches) {
                groupMatchNumber++;
                globalMatchCounter++;
                const positionKey = `G${groupId}-R${roundIdx + 1}-M${groupMatchNumber}`;

                matches.push({
                    roundNumber: roundIdx + 1,
                    matchNumber: globalMatchCounter,
                    bracketSide: 'Group',
                    groupId,
                    team1Id: team1,
                    team2Id: team2,
                    bestOf,
                    winnerAdvantage: 0,
                    positionKey,
                    // No nextWinnerRef/nextLoserRef for group matches
                    // Standings determine advancement, not FK wiring
                });
            }
        }
    }

    return { matches, groupAssignments };
}

// ─── Function 7: generateHybridBracket ───────────────────────────────────────

/**
 * Generates match descriptors for hybrid formats (GroupIntoSingleElim, GroupIntoDoubleElim).
 * Returns group matches, elimination matches (with empty slots), and group assignments.
 * Elimination bracket participant slots are all undefined at generation time.
 * They get filled when groups complete via the bracket advancement reducer.
 */
export function generateHybridBracket(
    teamIds: number[],
    groupSize: number,
    bestOf: number,
    groupAssignmentMode: string,
    elimFormat: 'single' | 'double',
    winnerAdvantage: number,
    has3rdPlaceMatch: boolean,
    groupAdvanceCount: number,
): { groupMatches: BracketMatchDescriptor[], elimMatches: BracketMatchDescriptor[], groupAssignments: Map<number, number[]> } {
    // Generate group phase
    const { matches: groupMatches, groupAssignments } = generateGroupPhaseBracket(
        teamIds,
        groupSize,
        bestOf,
        groupAssignmentMode,
    );

    // Calculate how many teams advance to the elimination bracket
    const groupCount = groupAssignments.size;
    const advancingCount = groupCount * groupAdvanceCount;

    // Generate elimination bracket structure with empty placeholder team IDs
    // We use an array of placeholder IDs (advancingCount zeros) to size the bracket correctly
    const placeholderTeamIds = Array.from({ length: advancingCount }, (_, i) => i + 1);

    let rawElimMatches: BracketMatchDescriptor[];
    if (elimFormat === 'single') {
        rawElimMatches = generateSingleElimBracket(placeholderTeamIds, bestOf, has3rdPlaceMatch);
    } else {
        rawElimMatches = generateDoubleElimBracket(placeholderTeamIds, bestOf, winnerAdvantage, has3rdPlaceMatch);
    }

    // Prefix elimination match position keys with "E-" to avoid collisions with group match keys
    // Also clear out the placeholder participant IDs (all slots should be empty at generation)
    const elimMatches: BracketMatchDescriptor[] = rawElimMatches.map(desc => ({
        ...desc,
        positionKey: `E-${desc.positionKey}`,
        nextWinnerRef: desc.nextWinnerRef ? `E-${desc.nextWinnerRef}` : undefined,
        nextLoserRef: desc.nextLoserRef ? `E-${desc.nextLoserRef}` : undefined,
        team1Id: undefined,
        team2Id: undefined,
        winnerTeamId: undefined,
    }));

    return { groupMatches, elimMatches, groupAssignments };
}
