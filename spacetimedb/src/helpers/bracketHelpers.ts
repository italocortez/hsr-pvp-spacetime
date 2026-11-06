// ─── Bracket Advancement Helpers ─────────────────────────────────────────────
// Extracted from bracketAdvancement.ts for cross-reducer use. Called by both
// bracketAdvancement.ts reducers and matchFinalization.ts.

import { SenderError } from 'spacetimedb/server';
import { updateWithAudit } from './auditHelpers';

// S3: the group_phase_record table was dropped (A23) and the W2/D1/L0 scheme with it (A30/A31). The two
// group-standings helpers below are stubs so the legacy advancement reducers compile; S8 deletes them with
// those reducers and replaces them by the shared pure rankGroup(decidedGroupMatches, teams, rule) over
// BracketMatch.team1Games/team2Games.

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
 * S3 stub (was: the W2/D1/L0 stored-standings update). S8: group standings are computed, not stored (A23/A30).
 */
export function updateGroupStandingsStub(_ctx: any, _bracketMatch: any, _userId: number): void {
    // S8: no stored standings; rankGroup reads decided group BracketMatch rows.
}

/**
 * Sorts stored-standings rows for a single group using tiebreaker rules (S3 stub input: always []):
 * 1. Head-to-head result (did A beat B in their direct match?)
 * 2. Total points (higher = better)
 * 3. Seed number (lower = better)
 *
 * Returns standings sorted best-first (index 0 = group winner).
 */
export function sortGroupStandingsStub(
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

    // Head-to-head cache: key "teamA-teamB" → 1 if A beat B, -1 if B beat A, 0 if no match
    // S8: replaced by the shared rankGroup (A30: points → head-to-head → game differential → seed); the
    // `standings` argument used to be group_phase_record rows and is now always [] from the stubbed callers.
    const h2hCache = new Map<string, number>();
    function headToHead(a: number, b: number): number {
        const key = `${a}-${b}`;
        if (h2hCache.has(key)) return h2hCache.get(key)!;

        const match = groupMatches.find((m: any) =>
            ((m.team1Id === a && m.team2Id === b) || (m.team1Id === b && m.team2Id === a)) &&
            m.state.tag === 'Decided'
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

    // Set winnerTeamId and state (S8: applyBracketResult is the single writer; it also sets loserTeamId,
    // decidedBy, team1Games/team2Games and audits with SYSTEM_USER_ID so no player id lands on the public row, A37)
    ctx.db.BracketMatch.id.update(
        updateWithAudit(ctx, bracketMatch, {
            winnerTeamId,
            state: { tag: 'Decided', value: {} } as any,
        }, userId),
    );

    // Re-read for downstream logic
    const updatedBracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
    if (!updatedBracketMatch) return;

    // S8: the tournament's auto-advance flag was dropped (A24/A36: every settled result advances); this
    // legacy path always advances until applyBracketResult replaces it.
    {
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
            updateGroupStandingsStub(ctx, updatedBracketMatch, userId);
        }
    }
}
