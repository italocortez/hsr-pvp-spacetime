import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { ensureTournamentAccess } from '../helpers/tournamentHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { placeParticipantInNextMatch, updateGroupPhaseRecords, sortGroupPhaseRecords } from '../helpers/bracketHelpers';
import { deleteCalendarEventForBracketMatch } from '../helpers/calendarCascade';
import { foldSeeding } from '../helpers/bracketGeneration';
import type { BracketMatch, GroupPhaseRecord } from '../module_bindings/types';

// ─── Group standings points ────────────────────────────────────────────────────
// Win=2, Draw=1, Loss=0 (per CONTEXT.md)
const WIN_POINTS = 2;
const DRAW_POINTS = 1;
// const LOSS_POINTS = 0;  // implied

// ─── Internal helper: removeParticipantFromMatch ──────────────────────────────
// Removes the slot containing teamId from a BracketMatch. Also clears winnerTeamId if it was that team.

function removeParticipantFromMatch(ctx: any, matchId: number, teamId: number, userId: number): void {
    const match = ctx.db.BracketMatch.id.find(matchId);
    if (!match) return;

    const updatedMatch: BracketMatch = updateWithAudit(ctx, match, {}, userId);

    // Clear the slot containing this teamId
    if (match.team1Id === teamId) {
        updatedMatch.team1Id = undefined;
    } else if (match.team2Id === teamId) {
        updatedMatch.team2Id = undefined;
    }

    // Also clear winnerTeamId if it was this team
    if (match.winnerTeamId === teamId) {
        updatedMatch.winnerTeamId = undefined;
    }

    ctx.db.BracketMatch.id.update(updatedMatch);
}

// ─── Internal helper: reverseGroupPhaseRecords ───────────────────────────────────
// Reverses GroupPhaseRecord changes for a group match (used during rollback).

function reverseGroupPhaseRecords(ctx: any, bracketMatch: any, userId: number): void {
    const groupId = bracketMatch.groupId;
    const tournamentId = bracketMatch.tournamentId;

    const tournamentStandings = [...ctx.db.GroupPhaseRecord.tournament_id.filter(tournamentId)];
    const standing1 = tournamentStandings
        .find((row: any) => row.groupId === groupId && row.teamId === bracketMatch.team1Id);
    const standing2 = tournamentStandings
        .find((row: any) => row.groupId === groupId && row.teamId === bracketMatch.team2Id);

    if (!standing1 || !standing2) return;

    let updated1: GroupPhaseRecord;
    let updated2: GroupPhaseRecord;

    if (bracketMatch.winnerTeamId === undefined) {
        // Was a draw: reverse draws+1 and points+1 for both
        updated1 = updateWithAudit(ctx, standing1, {
            draws: Math.max(0, standing1.draws - 1),
            points: Math.max(0, standing1.points - DRAW_POINTS),
        }, userId);
        updated2 = updateWithAudit(ctx, standing2, {
            draws: Math.max(0, standing2.draws - 1),
            points: Math.max(0, standing2.points - DRAW_POINTS),
        }, userId);
    } else if (bracketMatch.winnerTeamId === bracketMatch.team1Id) {
        // Was team1 win: reverse
        updated1 = updateWithAudit(ctx, standing1, {
            wins: Math.max(0, standing1.wins - 1),
            points: Math.max(0, standing1.points - WIN_POINTS),
        }, userId);
        updated2 = updateWithAudit(ctx, standing2, {
            losses: Math.max(0, standing2.losses - 1),
        }, userId);
    } else {
        // Was team2 win: reverse
        updated1 = updateWithAudit(ctx, standing1, {
            losses: Math.max(0, standing1.losses - 1),
        }, userId);
        updated2 = updateWithAudit(ctx, standing2, {
            wins: Math.max(0, standing2.wins - 1),
            points: Math.max(0, standing2.points - WIN_POINTS),
        }, userId);
    }

    // Delete + insert pattern for composite PK tables
    ctx.db.GroupPhaseRecord.delete(standing1);
    ctx.db.GroupPhaseRecord.insert(updated1);

    ctx.db.GroupPhaseRecord.delete(standing2);
    ctx.db.GroupPhaseRecord.insert(updated2);
}

// ─── Internal helper: setEliminatedStatus ─────────────────────────────────────
// Sets Eliminated status on a loser's TournamentEnrolled rows (per D-40).
// Single elim: any loss = Eliminated.
// Double elim: only eliminated when losing in Losers bracket with no nextLoserMatchId.

function setEliminatedStatus(ctx: any, loserTeamId: number, bracketMatch: any, userId: number): void {
    const isSingleElim = bracketMatch.bracketSide.tag === 'Winners' || bracketMatch.bracketSide.tag === 'ThirdPlace';
    const isLosersAndFinal = bracketMatch.bracketSide.tag === 'Losers' && !bracketMatch.nextLoserMatchId;
    const isGrandFinals = bracketMatch.bracketSide.tag === 'GrandFinals';

    // Only eliminate in these cases:
    // - Single elim: any loss in Winners or ThirdPlace bracket
    // - Double elim: loss in Losers bracket with no nextLoserMatchId (2nd loss, truly out)
    // - Grand Finals loser is not eliminated (runner-up)
    const shouldEliminate = isSingleElim || isLosersAndFinal;
    if (!shouldEliminate) return;

    // Get the tournament ID from the bracket match
    const tournamentId = bracketMatch.tournamentId;

    // Find all team members for the losing team and set their status to Eliminated
    const teamMembers = [...ctx.db.TournamentTeamMember.team_id.filter(loserTeamId)];
    for (const member of teamMembers) {
        // Only update members enrolled in this tournament
        const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user
            .filter([tournamentId, member.userId])][0];
        if (!enrolled) continue;

        // Delete + re-insert pattern for composite PK
        ctx.db.TournamentEnrolled.delete(enrolled);
        ctx.db.TournamentEnrolled.insert(insertWithAudit(ctx, {
            ...enrolled,
            status: { tag: 'Eliminated', value: {} } as any,
        }, userId));
    }
}

// ─── advance_bracket_match ────────────────────────────────────────────────────
// Places winner in nextWinnerMatchId slot. Routes loser to nextLoserMatchId (double elim).
// Updates GroupPhaseRecord for group matches.
// Permission: Tournament Access (TO/assistant/mod/admin).

export const advance_bracket_match = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
    },
    (ctx, { bracketMatchId }) => {
        const bracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
        if (!bracketMatch) {
            throw new SenderError('Bracket match not found.');
        }

        const { user, tournament } = ensureTournamentAccess(ctx, bracketMatch.tournamentId);

        // Verify tournament is InProgress
        if (tournament.stage.tag !== 'InProgress') {
            throw new SenderError('Bracket advancement is only allowed during InProgress stage.');
        }

        // For group matches, allow draws (winnerTeamId undefined) — only update standings.
        // For elimination matches, a winner is required to advance.
        const isGroupMatch = bracketMatch.bracketSide.tag === 'Group';

        if (!isGroupMatch && bracketMatch.winnerTeamId === undefined) {
            throw new SenderError('No winner set on this bracket match. Submit a result first.');
        }

        // Place winner in nextWinnerMatchId slot (if exists and winner is set)
        if (bracketMatch.winnerTeamId !== undefined && bracketMatch.nextWinnerMatchId) {
            placeParticipantInNextMatch(ctx, bracketMatch.nextWinnerMatchId, bracketMatch.winnerTeamId, user.id);
        }

        // Route loser to nextLoserMatchId (for double elim, 3rd place)
        if (bracketMatch.winnerTeamId !== undefined && bracketMatch.nextLoserMatchId) {
            const loserId = bracketMatch.team1Id === bracketMatch.winnerTeamId
                ? bracketMatch.team2Id
                : bracketMatch.team1Id;
            if (loserId) {
                placeParticipantInNextMatch(ctx, bracketMatch.nextLoserMatchId, loserId, user.id);
            }
        }

        // Set Eliminated status on loser if applicable (D-40)
        if (!isGroupMatch && bracketMatch.winnerTeamId !== undefined) {
            const loserId = bracketMatch.team1Id === bracketMatch.winnerTeamId
                ? bracketMatch.team2Id
                : bracketMatch.team1Id;
            if (loserId !== undefined) {
                setEliminatedStatus(ctx, loserId, bracketMatch, user.id);
            }
        }

        // Update group standings if this is a group match (handles wins, losses, AND draws)
        if (isGroupMatch && bracketMatch.team1Id && bracketMatch.team2Id) {
            updateGroupPhaseRecords(ctx, bracketMatch, user.id);

            // Mark group draw as resolved (resultStatus → Validated) so TO knows it's processed
            if (bracketMatch.winnerTeamId === undefined && bracketMatch.resultStatus.tag !== 'Validated') {
                ctx.db.BracketMatch.id.update(updateWithAudit(ctx, bracketMatch, {
                    resultStatus: { tag: 'Validated', value: {} } as any,
                }, user.id));
            }
        }

        console.log(`[BRACKET] Bracket match #${bracketMatchId} advanced: winner team #${bracketMatch.winnerTeamId ?? 'draw'}`);
    }
);

// ─── submit_and_advance_bracket ───────────────────────────────────────────────
// Wrapper reducer for tournament bracket matches. Maps winnerTeamSide (Blue/Red) to
// team1Id/team2Id and auto-advances in one transaction. Frontend calls this for
// tournament matches instead of submit_match_result directly.
// Permission: Authenticated user (referee/TO authority validated inline).

export const submit_and_advance_bracket = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
    },
    (ctx, { matchResultId }) => {
        const user = getAuthenticatedUser(ctx);

        // Find MatchResultRecord by id
        const matchResult = ctx.db.MatchResultRecord.id.find(matchResultId);
        if (!matchResult) {
            throw new SenderError('Match result not found.');
        }

        // Verify it has bracketMatchId set
        if (matchResult.bracketMatchId === undefined) {
            throw new SenderError('Not a bracket match -- use submit_match_result for non-tournament matches.');
        }

        // Verify it has winnerTeamSide set
        if (matchResult.winnerTeamSide === undefined) {
            throw new SenderError('No winner on match result. Submit scores first.');
        }

        // Find the BracketMatch (required to derive tournamentId per D-42)
        const bracketMatch = ctx.db.BracketMatch.id.find(matchResult.bracketMatchId);
        if (!bracketMatch) throw new SenderError('Bracket match not found.');

        // Derive tournamentId from bracketMatch (D-42: tournamentId removed from MatchResultRecord)
        const tournamentId = bracketMatch.tournamentId;
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) {
            throw new SenderError('Tournament not found.');
        }

        // Verify tournament is InProgress
        if (tournament.stage.tag !== 'InProgress') {
            throw new SenderError('Bracket advancement is only allowed during InProgress stage.');
        }

        // D-30: Map winnerTeamSide directly to team1Id/team2Id — no TournamentTeamMember lookup needed
        const winnerTeamId = matchResult.winnerTeamSide.tag === 'Blue'
            ? bracketMatch.team1Id
            : bracketMatch.team2Id;
        if (winnerTeamId === undefined) {
            throw new SenderError('Winner team slot is empty on bracket match.');
        }

        // Set winnerTeamId on BracketMatch
        ctx.db.BracketMatch.id.update(updateWithAudit(ctx, bracketMatch, {
            winnerTeamId: winnerTeamId,
            resultStatus: { tag: 'Validated', value: {} } as any,
        }, user.id));

        // Re-read the updated bracketMatch for downstream logic
        const updatedBracketMatch = ctx.db.BracketMatch.id.find(matchResult.bracketMatchId);
        if (!updatedBracketMatch) throw new SenderError('Bracket match not found after update.');

        // Set Eliminated status on loser (D-40)
        const isGroupMatch = updatedBracketMatch.bracketSide.tag === 'Group';
        if (!isGroupMatch) {
            const loserId = updatedBracketMatch.team1Id === winnerTeamId
                ? updatedBracketMatch.team2Id
                : updatedBracketMatch.team1Id;
            if (loserId !== undefined) {
                setEliminatedStatus(ctx, loserId, updatedBracketMatch, user.id);
            }
        }

        // If autoAdvanceBracket is true, run advancement inline
        if (tournament.autoAdvanceBracket) {
            // Place winner in nextWinnerMatchId
            if (updatedBracketMatch.nextWinnerMatchId) {
                placeParticipantInNextMatch(ctx, updatedBracketMatch.nextWinnerMatchId, winnerTeamId, user.id);
            }

            // Route loser to nextLoserMatchId
            if (updatedBracketMatch.nextLoserMatchId) {
                const loserId = updatedBracketMatch.team1Id === winnerTeamId
                    ? updatedBracketMatch.team2Id
                    : updatedBracketMatch.team1Id;
                if (loserId) {
                    placeParticipantInNextMatch(ctx, updatedBracketMatch.nextLoserMatchId, loserId, user.id);
                }
            }

            // Update group standings if group match
            if (isGroupMatch &&
                updatedBracketMatch.team1Id &&
                updatedBracketMatch.team2Id) {
                updateGroupPhaseRecords(ctx, updatedBracketMatch, user.id);
            }
        }

        console.log(`[BRACKET] submit_and_advance_bracket: match result #${matchResultId}, winner team #${winnerTeamId}, auto-advance: ${tournament.autoAdvanceBracket}`);
    }
);

// ─── rollback_bracket_match ───────────────────────────────────────────────────
// Reverses one step of bracket advancement. Clears winnerTeamId, removes winner/loser
// from next matches. Blocks if mmrProcessedAt is set on MatchResultRecord.
// Permission: Tournament Access (TO/assistant/mod/admin).

export const rollback_bracket_match = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
    },
    (ctx, { bracketMatchId }) => {
        const bracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
        if (!bracketMatch) {
            throw new SenderError('Bracket match not found.');
        }

        const { user, tournament } = ensureTournamentAccess(ctx, bracketMatch.tournamentId);

        // Verify tournament is InProgress
        if (tournament.stage.tag !== 'InProgress') {
            throw new SenderError('Bracket rollback is only allowed during InProgress stage.');
        }

        // Verify there is a winner to rollback
        if (bracketMatch.winnerTeamId === undefined) {
            throw new SenderError('No winner to rollback.');
        }

        // Delete any calendar event linked to this bracket match (D-22)
        deleteCalendarEventForBracketMatch(ctx, bracketMatchId);

        // Check if MMR has been processed for any match result linked to this bracket match
        // D-42: use bracket_match_id index (tournament_id removed from MatchResultRecord)
        const matchResults = [...ctx.db.MatchResultRecord.bracket_match_id.filter(bracketMatchId)];
        for (const mr of matchResults) {
            if (mr.mmrProcessedAt) {
                throw new SenderError('Cannot rollback: MMR has already been processed for this match. MMR reversal is deferred to Phase 5.');
            }
        }

        const winnerId = bracketMatch.winnerTeamId;

        // Reverse advancement — remove winner from next winner match
        if (bracketMatch.nextWinnerMatchId) {
            removeParticipantFromMatch(ctx, bracketMatch.nextWinnerMatchId, winnerId, user.id);
        }

        // Reverse loser routing — remove loser from losers bracket next match
        if (bracketMatch.nextLoserMatchId) {
            const loserId = bracketMatch.team1Id === winnerId
                ? bracketMatch.team2Id
                : bracketMatch.team1Id;
            if (loserId) {
                removeParticipantFromMatch(ctx, bracketMatch.nextLoserMatchId, loserId, user.id);
            }
        }

        // Reverse group standings if group match
        if (bracketMatch.bracketSide.tag === 'Group' && bracketMatch.team1Id && bracketMatch.team2Id) {
            reverseGroupPhaseRecords(ctx, bracketMatch, user.id);
        }

        // Re-read bracketMatch in case it was updated by removeParticipantFromMatch above
        const currentBracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
        if (!currentBracketMatch) throw new SenderError('Bracket match not found after reversal.');

        // Clear winnerTeamId and reset resultStatus to Pending
        ctx.db.BracketMatch.id.update(updateWithAudit(ctx, currentBracketMatch, {
            winnerTeamId: undefined,
            resultStatus: { tag: 'Pending', value: {} } as any,
        }, user.id));

        console.log(`[BRACKET] rollback_bracket_match: bracket match #${bracketMatchId} rolled back by user #${user.id}`);
    }
);

// ─── advance_group_to_elimination ────────────────────────────────────────────
// After all group matches are resolved, places top N teams from each group
// into the elimination bracket slots using cross-seeded fold placement.
// Permission: Tournament Access (TO/assistant/mod/admin).

export const advance_group_to_elimination = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        const { user, tournament } = ensureTournamentAccess(ctx, tournamentId);

        // Verify tournament is InProgress
        if (tournament.stage.tag !== 'InProgress') {
            throw new SenderError('Group-to-elimination advancement is only allowed during InProgress stage.');
        }

        // Verify tournament is a hybrid format
        const formatTag = tournament.format.tag;
        if (formatTag !== 'GroupIntoSingleElim' && formatTag !== 'GroupIntoDoubleElim') {
            throw new SenderError('This reducer is only for hybrid (group-into-elimination) tournament formats.');
        }

        const groupAdvanceCount = tournament.groupAdvanceCount;
        if (!groupAdvanceCount || groupAdvanceCount < 1) {
            throw new SenderError('Tournament groupAdvanceCount must be at least 1.');
        }

        // Load all bracket matches for this tournament
        const allMatches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)];
        const groupMatches = allMatches.filter((m: any) => m.bracketSide.tag === 'Group');
        const elimMatches = allMatches.filter((m: any) => m.bracketSide.tag !== 'Group');

        // Verify all group matches are resolved (resultStatus = Validated)
        const unresolvedGroup = groupMatches.find((m: any) => m.resultStatus.tag !== 'Validated');
        if (unresolvedGroup) {
            throw new SenderError(
                `Not all group matches are resolved. Match #${unresolvedGroup.id} is still ${unresolvedGroup.resultStatus.tag}.`
            );
        }

        // Verify elimination bracket has empty slots (not already populated)
        const elimR1 = elimMatches.filter((m: any) => m.roundNumber === 1);
        const alreadyPopulated = elimR1.find((m: any) => m.team1Id !== undefined || m.team2Id !== undefined);
        if (alreadyPopulated) {
            throw new SenderError('Elimination bracket already has teams placed. Rollback first if re-advancing.');
        }

        // Load group phase records and sort each group
        const allStandings = [...ctx.db.GroupPhaseRecord.tournament_id.filter(tournamentId)];
        const groupIds = [...new Set(allStandings.map(s => s.groupId))].sort((a, b) => a - b);

        // Collect advancing teams: cross-seed across groups
        // Pattern: rank 1 from each group first, then rank 2 from each, etc.
        // This ensures cross-seeding (group winners face group runners-up)
        const advancingTeams: number[] = [];
        const groupRankings = new Map<number, any[]>();

        for (const groupId of groupIds) {
            const groupStandings = allStandings.filter(s => s.groupId === groupId);
            const sorted = sortGroupPhaseRecords(ctx, groupStandings, tournamentId);
            groupRankings.set(groupId, sorted);

            // Validate enough teams in group
            const advanceFromThis = Math.min(groupAdvanceCount, sorted.length);
            if (advanceFromThis === 0) {
                throw new SenderError(`Group ${groupId} has no teams to advance.`);
            }
        }

        // Snake-seed across groups: rank 1 from all groups, then rank 2 from all groups, etc.
        for (let rank = 0; rank < groupAdvanceCount; rank++) {
            for (const groupId of groupIds) {
                const sorted = groupRankings.get(groupId)!;
                if (rank < sorted.length) {
                    advancingTeams.push(sorted[rank].teamId);
                }
            }
        }

        if (advancingTeams.length < 2) {
            throw new SenderError('At least 2 teams must advance to form an elimination bracket.');
        }

        // Use fold seeding to determine matchups
        const bracketSize = Math.pow(2, Math.ceil(Math.log2(advancingTeams.length)));
        const matchups = foldSeeding(bracketSize);

        // Sort R1 elimination matches by matchNumber for deterministic placement
        const sortedElimR1 = [...elimR1].sort((a: any, b: any) => a.matchNumber - b.matchNumber);

        // Place teams into R1 slots
        for (let i = 0; i < matchups.length && i < sortedElimR1.length; i++) {
            const [seed1, seed2] = matchups[i];
            const t1 = seed1 <= advancingTeams.length ? advancingTeams[seed1 - 1] : undefined;
            const t2 = seed2 <= advancingTeams.length ? advancingTeams[seed2 - 1] : undefined;

            const match = sortedElimR1[i];
            // Writable BracketMatch shape -- tagged-enum getters in the inferred type
            // (resultStatus, bracketSide, gameMode) are read-only, so strip readonly
            // locally to allow post-construction field mutations.
            const updates: { -readonly [K in keyof BracketMatch]: BracketMatch[K] } =
                updateWithAudit(ctx, match, {}, user.id);

            if (t1 !== undefined) updates.team1Id = t1;
            if (t2 !== undefined) updates.team2Id = t2;

            // If one team is a BYE (undefined), auto-advance the other
            if (t1 !== undefined && t2 === undefined) {
                updates.winnerTeamId = t1;
                updates.resultStatus = { tag: 'Validated', value: {} } as any;
            } else if (t2 !== undefined && t1 === undefined) {
                updates.winnerTeamId = t2;
                updates.resultStatus = { tag: 'Validated', value: {} } as any;
            }

            ctx.db.BracketMatch.id.update(updates);

            // Auto-advance BYE winners to next round
            if (updates.winnerTeamId !== undefined && match.nextWinnerMatchId) {
                placeParticipantInNextMatch(ctx, match.nextWinnerMatchId, updates.winnerTeamId, user.id);
            }
        }

        console.log(`[BRACKET] advance_group_to_elimination: ${advancingTeams.length} teams placed in elimination bracket for tournament #${tournamentId}`);
    }
);
