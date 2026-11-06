import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureTournamentAccess } from '../helpers/tournamentHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import {
    type BracketMatchDescriptor,
    generateSingleElimBracket,
    generateDoubleElimBracket,
    generateGroupPhaseBracket,
    generateHybridBracket,
} from '../helpers/bracketGeneration';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Two-pass FK wiring helper.
 * Pass 1: Insert all matches with null FKs, build positionKey -> insertedId map.
 * Pass 2: Update FK links using the positionKey -> id map.
 * Pass 3: Auto-advance BYE matches (place winner in next match slot).
 */
function insertBracketMatches(
    ctx: any,
    tournament: any,
    userId: number,
    descriptors: BracketMatchDescriptor[],
): void {
    // Pass 1: Insert all matches with null FKs, build positionKey -> insertedId map
    const idMap = new Map<string, number>();
    for (const desc of descriptors) {
        const row = ctx.db.BracketMatch.insert(insertWithAudit(ctx, {
            id: 0,
            tournamentId: tournament.id,
            roundNumber: desc.roundNumber,
            matchNumber: desc.matchNumber,
            bracketSide: { tag: desc.bracketSide, value: {} } as any,
            groupId: desc.groupId,
            team1Id: desc.team1Id,
            team2Id: desc.team2Id,
            nextWinnerMatchId: undefined,
            nextLoserMatchId: undefined,
            bestOf: desc.bestOf,
            gameMode: tournament.defaultGameMode,
            winnerAdvantage: desc.winnerAdvantage,
            scheduledAt: undefined,
            lobbyId: undefined,
            checkInRequired: tournament.checkInEnabled,
            winnerTeamId: desc.winnerTeamId,
            resultStatus: desc.winnerTeamId
                ? { tag: 'Validated', value: {} } as any
                : { tag: 'Pending', value: {} } as any,
        }, userId));
        idMap.set(desc.positionKey, row.id);
    }

    // Pass 2: Update FK links using the positionKey -> id map
    for (const desc of descriptors) {
        if (desc.nextWinnerRef || desc.nextLoserRef) {
            const matchId = idMap.get(desc.positionKey);
            if (!matchId) continue;
            const row = ctx.db.BracketMatch.id.find(matchId);
            if (!row) continue;

            const nextWinnerId = desc.nextWinnerRef ? idMap.get(desc.nextWinnerRef) : undefined;
            const nextLoserId = desc.nextLoserRef ? idMap.get(desc.nextLoserRef) : undefined;

            if (nextWinnerId !== undefined || nextLoserId !== undefined) {
                ctx.db.BracketMatch.id.update(updateWithAudit(ctx, row, {
                    nextWinnerMatchId: nextWinnerId ?? row.nextWinnerMatchId,
                    nextLoserMatchId: nextLoserId ?? row.nextLoserMatchId,
                }, userId));
            }
        }
    }

    // Pass 3: Auto-advance BYE matches
    // BYE matches have winnerId set but need to place the winner in the next match
    for (const desc of descriptors) {
        if (desc.winnerTeamId && desc.nextWinnerRef) {
            const matchId = idMap.get(desc.positionKey);
            const nextMatchId = idMap.get(desc.nextWinnerRef);
            if (!matchId || !nextMatchId) continue;

            const nextMatch = ctx.db.BracketMatch.id.find(nextMatchId);
            if (!nextMatch) continue;

            // Place BYE winner in the appropriate slot of the next match
            if (!nextMatch.team1Id) {
                ctx.db.BracketMatch.id.update(updateWithAudit(ctx, nextMatch, {
                    team1Id: desc.winnerTeamId,
                }, userId));
            } else if (!nextMatch.team2Id) {
                ctx.db.BracketMatch.id.update(updateWithAudit(ctx, nextMatch, {
                    team2Id: desc.winnerTeamId,
                }, userId));
            }
        }
    }
}

/**
 * Creates GroupPhaseRecord rows for all teams assigned to each group.
 */
function insertGroupPhaseRecords(
    ctx: any,
    tournamentId: number,
    userId: number,
    groupAssignments: Map<number, number[]>,
): void {
    for (const [groupId, teamIds] of groupAssignments) {
        for (const teamId of teamIds) {
            ctx.db.GroupPhaseRecord.insert(insertWithAudit(ctx, {
                tournamentId,
                groupId,
                teamId: teamId,
                wins: 0,
                losses: 0,
                draws: 0,
                points: 0,
            }, userId));
        }
    }
}

// ─── generate_bracket ─────────────────────────────────────────────────────────

export const generate_bracket = spacetimedb.reducer(
    { tournamentId: t.u32() },
    (ctx, { tournamentId }) => {
        const { user, tournament } = ensureTournamentAccess(ctx, tournamentId);

        // Tournament must be in Seeding stage
        if (tournament.stage.tag !== 'Seeding') {
            throw new SenderError('generate_bracket can only be called during the Seeding stage.');
        }

        // Delete all existing BracketMatch rows for this tournament (regeneration)
        for (const match of [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)]) {
            ctx.db.BracketMatch.id.delete(match.id);
        }

        // Delete all existing GroupPhaseRecord rows for this tournament
        for (const gpr of [...ctx.db.GroupPhaseRecord.tournament_id.filter(tournamentId)]) {
            ctx.db.GroupPhaseRecord.delete(gpr);
        }

        // Get all active teams for this tournament (teams with at least one TournamentTeamMember)
        const teams = [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)]
            .filter((team: any) => {
                // Only include teams that have at least one member
                const members = [...ctx.db.TournamentTeamMember.team_id.filter(team.id)];
                return members.length > 0;
            })
            .sort((a: any, b: any) => {
                // Sort by seedNumber (lower = better seed). Unseeded teams go last.
                const seedA = a.seedNumber ?? 999999;
                const seedB = b.seedNumber ?? 999999;
                return seedA - seedB;
            });

        if (teams.length < 2) {
            throw new SenderError('At least 2 active teams are required to generate a bracket.');
        }

        const teamIds = teams.map((team: any) => team.id);
        const formatTag = tournament.format.tag as string;

        let descriptorCount = 0;

        if (formatTag === 'SingleElimination') {
            const descriptors = generateSingleElimBracket(
                teamIds,
                tournament.defaultBestOf,
                tournament.has3rdPlaceMatch,
            );
            insertBracketMatches(ctx, tournament, user.id, descriptors);
            descriptorCount = descriptors.length;

        } else if (formatTag === 'DoubleElimination') {
            const descriptors = generateDoubleElimBracket(
                teamIds,
                tournament.defaultBestOf,
                tournament.winnerAdvantage,
                tournament.has3rdPlaceMatch,
            );
            insertBracketMatches(ctx, tournament, user.id, descriptors);
            descriptorCount = descriptors.length;

        } else if (formatTag === 'GroupOnly') {
            const { matches, groupAssignments } = generateGroupPhaseBracket(
                teamIds,
                tournament.groupSize,
                tournament.defaultBestOf,
                tournament.groupAssignmentMode.tag,
            );
            insertBracketMatches(ctx, tournament, user.id, matches);
            insertGroupPhaseRecords(ctx, tournamentId, user.id, groupAssignments);
            descriptorCount = matches.length;

        } else if (formatTag === 'GroupIntoSingleElim') {
            const { groupMatches, elimMatches, groupAssignments } = generateHybridBracket(
                teamIds,
                tournament.groupSize,
                tournament.defaultBestOf,
                tournament.groupAssignmentMode.tag,
                'single',
                0,
                tournament.has3rdPlaceMatch,
                tournament.groupAdvanceCount,
            );
            insertBracketMatches(ctx, tournament, user.id, groupMatches);
            insertBracketMatches(ctx, tournament, user.id, elimMatches);
            insertGroupPhaseRecords(ctx, tournamentId, user.id, groupAssignments);
            descriptorCount = groupMatches.length + elimMatches.length;

        } else if (formatTag === 'GroupIntoDoubleElim') {
            const { groupMatches, elimMatches, groupAssignments } = generateHybridBracket(
                teamIds,
                tournament.groupSize,
                tournament.defaultBestOf,
                tournament.groupAssignmentMode.tag,
                'double',
                tournament.winnerAdvantage,
                tournament.has3rdPlaceMatch,
                tournament.groupAdvanceCount,
            );
            insertBracketMatches(ctx, tournament, user.id, groupMatches);
            insertBracketMatches(ctx, tournament, user.id, elimMatches);
            insertGroupPhaseRecords(ctx, tournamentId, user.id, groupAssignments);
            descriptorCount = groupMatches.length + elimMatches.length;

        } else {
            throw new SenderError(`Unknown tournament format: ${formatTag}`);
        }

        console.log(`[BRACKET] Generated bracket for tournament #${tournamentId}: ${descriptorCount} matches`);
    }
);

// ─── seed_bracket ─────────────────────────────────────────────────────────────

export const seed_bracket = spacetimedb.reducer(
    { tournamentId: t.u32(), mode: t.string() },
    (ctx, { tournamentId, mode }) => {
        const { user, tournament } = ensureTournamentAccess(ctx, tournamentId);

        // Tournament must be in Seeding stage
        if (tournament.stage.tag !== 'Seeding') {
            throw new SenderError('seed_bracket can only be called during the Seeding stage.');
        }

        // Validate mode
        if (mode !== 'mmr' && mode !== 'random') {
            throw new SenderError('Invalid seeding mode. Must be "mmr" or "random".');
        }

        // Get all active teams (teams with at least one TournamentTeamMember)
        const teams = [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)]
            .filter((team: any) => {
                const members = [...ctx.db.TournamentTeamMember.team_id.filter(team.id)];
                return members.length > 0;
            });

        if (teams.length === 0) {
            throw new SenderError('No active teams found for this tournament.');
        }

        let sortedTeams: any[];

        if (mode === 'mmr') {
            // Use captain's MMR for the tournament's defaultGameMode as the team's seeding MMR
            const ratings = new Map<number, number>();
            for (const team of teams) {
                const mmrRows = [...ctx.db.MmrRating.user_id.filter(team.captainUserId)];
                const modeRating = mmrRows.find((r: any) => r.gameMode.tag === tournament.defaultGameMode.tag);
                ratings.set(team.id, modeRating ? modeRating.rating : 0);
            }

            // Sort by rating descending (highest = seed 1). Ties broken by lower team.id (earlier registration = higher seed).
            sortedTeams = [...teams].sort((a: any, b: any) => {
                const ratingA = ratings.get(a.id) ?? 0;
                const ratingB = ratings.get(b.id) ?? 0;
                if (ratingB !== ratingA) return ratingB - ratingA;
                return a.id - b.id;
            });

        } else {
            // Deterministic "random" based on tournament ID and team ID (reducers must be deterministic -- no Math.random())
            // Simple hash: (tournamentId * 31 + teamId) % large prime, gives consistent but shuffled ordering
            const LARGE_PRIME = 2147483647;
            sortedTeams = [...teams].sort((a: any, b: any) => {
                const hashA = (tournamentId * 31 + a.id) % LARGE_PRIME;
                const hashB = (tournamentId * 31 + b.id) % LARGE_PRIME;
                return hashA - hashB;
            });
        }

        // Assign seedNumber 1..N
        for (const [index, team] of sortedTeams.entries()) {
            ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, {
                seedNumber: index + 1,
            }, user.id));
        }

        console.log(`[BRACKET] Seeded ${teams.length} teams for tournament #${tournamentId} (mode: ${mode})`);
    }
);

// ─── swap_seeds ───────────────────────────────────────────────────────────────

export const swap_seeds = spacetimedb.reducer(
    { tournamentId: t.u32(), teamId1: t.u32(), teamId2: t.u32() },
    (ctx, { tournamentId, teamId1, teamId2 }) => {
        const { user, tournament } = ensureTournamentAccess(ctx, tournamentId);

        // Tournament must be in Seeding stage
        if (tournament.stage.tag !== 'Seeding') {
            throw new SenderError('swap_seeds can only be called during the Seeding stage.');
        }

        // Find both TournamentTeam rows
        const team1 = ctx.db.TournamentTeam.id.find(teamId1);
        if (!team1) throw new SenderError(`Team #${teamId1} not found.`);
        if (team1.tournamentId !== tournamentId) {
            throw new SenderError(`Team #${teamId1} does not belong to tournament #${tournamentId}.`);
        }

        const team2 = ctx.db.TournamentTeam.id.find(teamId2);
        if (!team2) throw new SenderError(`Team #${teamId2} not found.`);
        if (team2.tournamentId !== tournamentId) {
            throw new SenderError(`Team #${teamId2} does not belong to tournament #${tournamentId}.`);
        }

        // Swap their seedNumber values
        const seed1 = team1.seedNumber;
        const seed2 = team2.seedNumber;

        ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team1, {
            seedNumber: seed2,
        }, user.id));

        ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team2, {
            seedNumber: seed1,
        }, user.id));

        console.log(`[BRACKET] Swapped seeds for teams #${teamId1} (was ${seed1}) and #${teamId2} (was ${seed2}) in tournament #${tournamentId}`);
    }
);
