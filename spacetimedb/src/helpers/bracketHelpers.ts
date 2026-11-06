// ─── Bracket Advancement Helpers ─────────────────────────────────────────────
// Extracted from bracketAdvancement.ts for cross-reducer use. Called by both
// bracketAdvancement.ts reducers and matchFinalization.ts.

import { SenderError } from 'spacetimedb/server';
import { updateWithAudit } from './auditHelpers';
import type { GroupPhaseRecord } from '../module_bindings/types';

// ─── Group standings points ────────────────────────────────────────────────────
const WIN_POINTS = 2;
const DRAW_POINTS = 1;

/**
 * Places a teamId into the next available slot of a given BracketMatch.
 * If no next match ID resolves, does nothing (this was the final match).
 */
export function placeParticipantInNextMatch(ctx: any, nextMatchId: number, teamId: number, userId: number): void {
    const nextMatch = ctx.db.BracketMatch.id.find(nextMatchId);
    if (!nextMatch) {
        // Could be the final match with no next -- silently return
        return;
    }

    if (!nextMatch.team1Id) {
        ctx.db.BracketMatch.id.update(
            updateWithAudit(ctx, nextMatch, { team1Id: teamId }, userId),
        );
    } else if (!nextMatch.team2Id) {
        ctx.db.BracketMatch.id.update(
            updateWithAudit(ctx, nextMatch, { team2Id: teamId }, userId),
        );
    } else {
        throw new SenderError('Next match already has both participants assigned.');
    }
}

/**
 * Updates GroupPhaseRecord rows for both participants after a group match resolves.
 * Win=2, Draw=1, Loss=0.
 */
export function updateGroupPhaseRecords(ctx: any, bracketMatch: any, userId: number): void {
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
        // Draw: both get draws+1, points+1
        updated1 = updateWithAudit(ctx, standing1, {
            draws: standing1.draws + 1,
            points: standing1.points + DRAW_POINTS,
        }, userId);
        updated2 = updateWithAudit(ctx, standing2, {
            draws: standing2.draws + 1,
            points: standing2.points + DRAW_POINTS,
        }, userId);
    } else if (bracketMatch.winnerTeamId === bracketMatch.team1Id) {
        // Team1 wins
        updated1 = updateWithAudit(ctx, standing1, {
            wins: standing1.wins + 1,
            points: standing1.points + WIN_POINTS,
        }, userId);
        updated2 = updateWithAudit(ctx, standing2, {
            losses: standing2.losses + 1,
        }, userId);
    } else {
        // Team2 wins
        updated1 = updateWithAudit(ctx, standing1, {
            losses: standing1.losses + 1,
        }, userId);
        updated2 = updateWithAudit(ctx, standing2, {
            wins: standing2.wins + 1,
            points: standing2.points + WIN_POINTS,
        }, userId);
    }

    // Delete + insert pattern for composite PK tables
    ctx.db.GroupPhaseRecord.delete(standing1);
    ctx.db.GroupPhaseRecord.insert(updated1);

    ctx.db.GroupPhaseRecord.delete(standing2);
    ctx.db.GroupPhaseRecord.insert(updated2);
}

/**
 * Sorts GroupPhaseRecord rows for a single group using tiebreaker rules:
 * 1. Head-to-head result (did A beat B in their direct match?)
 * 2. Total points (higher = better)
 * 3. Seed number (lower = better)
 *
 * Returns standings sorted best-first (index 0 = group winner).
 */
export function sortGroupPhaseRecords(
    ctx: any,
    standings: any[],
    tournamentId: number,
): any[] {
    // Pre-load bracket matches for head-to-head lookups (group matches only)
    const groupMatches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)]
        .filter((m: any) => m.bracketSide.tag === 'Group');

    // Pre-load teams for seed number tiebreaker
    const teams = [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)];
    const teamSeed = new Map<number, number>();
    for (const t of teams) {
        teamSeed.set(t.id, t.seedNumber ?? 9999);
    }

    // Head-to-head cache: key "teamA-teamB" → 1 if A beat B, -1 if B beat A, 0 if draw/no match
    const h2hCache = new Map<string, number>();
    function headToHead(a: number, b: number): number {
        const key = `${a}-${b}`;
        if (h2hCache.has(key)) return h2hCache.get(key)!;

        const match = groupMatches.find((m: any) =>
            ((m.team1Id === a && m.team2Id === b) || (m.team1Id === b && m.team2Id === a)) &&
            m.resultStatus.tag === 'Validated'
        );

        let result = 0;
        if (match && match.winnerTeamId === a) result = 1;
        else if (match && match.winnerTeamId === b) result = -1;
        // draw or no match = 0

        h2hCache.set(key, result);
        h2hCache.set(`${b}-${a}`, -result);
        return result;
    }

    return [...standings].sort((a, b) => {
        // 1. Head-to-head
        const h2h = headToHead(a.teamId, b.teamId);
        if (h2h !== 0) return -h2h; // negative because sort is ascending, we want winner first

        // 2. Total points (higher = better)
        if (a.points !== b.points) return b.points - a.points;

        // 3. Seed number (lower = better)
        const seedA = teamSeed.get(a.teamId) ?? 9999;
        const seedB = teamSeed.get(b.teamId) ?? 9999;
        return seedA - seedB;
    });
}

/**
 * Advances a bracket match: sets winnerTeamId, places winner/loser in next matches,
 * and updates group standings. Called from matchFinalization.ts for tournament bracket
 * matches that need advancement during finalization.
 */
export function advanceBracketMatch(ctx: any, bracketMatchId: number, winnerTeamId: number, userId: number): void {
    const bracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
    if (!bracketMatch) {
        throw new SenderError('Bracket match not found.');
    }

    const tournament = ctx.db.Tournament.id.find(bracketMatch.tournamentId);
    if (!tournament || tournament.stage.tag !== 'InProgress') {
        throw new SenderError('Tournament must be InProgress for bracket advancement.');
    }

    // Set winnerTeamId and resultStatus
    ctx.db.BracketMatch.id.update(
        updateWithAudit(ctx, bracketMatch, {
            winnerTeamId,
            resultStatus: { tag: 'Validated', value: {} } as any,
        }, userId),
    );

    // Re-read for downstream logic
    const updatedBracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
    if (!updatedBracketMatch) return;

    if (tournament.autoAdvanceBracket) {
        // Place winner in nextWinnerMatchId
        if (updatedBracketMatch.nextWinnerMatchId) {
            placeParticipantInNextMatch(ctx, updatedBracketMatch.nextWinnerMatchId, winnerTeamId, userId);
        }

        // Route loser to nextLoserMatchId
        if (updatedBracketMatch.nextLoserMatchId) {
            const loserId = updatedBracketMatch.team1Id === winnerTeamId
                ? updatedBracketMatch.team2Id
                : updatedBracketMatch.team1Id;
            if (loserId) {
                placeParticipantInNextMatch(ctx, updatedBracketMatch.nextLoserMatchId, loserId, userId);
            }
        }

        // Update group phase records if group match with both teams
        if (updatedBracketMatch.bracketSide.tag === 'Group' &&
            updatedBracketMatch.team1Id &&
            updatedBracketMatch.team2Id) {
            updateGroupPhaseRecords(ctx, updatedBracketMatch, userId);
        }
    }
}
