import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { ensureTournamentAccess } from '../helpers/tournamentHelpers';
import { updateWithAudit } from '../helpers/auditHelpers';
import { runFinalization, processMatchMmr } from '../helpers/finalizationHelpers';
import { rebuildLeaderboard } from '../helpers/leaderboardRebuild';

// ─── finalize_match_result ──────────────────────────────────────────────────
// Simplified: auth check, validate, authority check, delegate to runFinalization.
// Permission: Admin/Mod, match referee, or tournament TO/assistant.

export const finalize_match_result = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
    },
    (ctx, { matchResultId }) => {
        // 1. Auth
        const user = getAuthenticatedUser(ctx);

        // 2. Find and validate MatchResultRecord
        const matchResult = ctx.db.MatchResultRecord.id.find(matchResultId);
        if (!matchResult) {
            throw new SenderError('Match result not found.');
        }
        if (matchResult.status.tag !== 'Validated') {
            throw new SenderError('Match result must be Validated before finalization.');
        }

        // ── D-H-01 (Phase 12.3, narrowed post-UAT): MMR tournament guard ────
        // Block per-match finalize for MMR tournament rows only. The guard's
        // sole purpose is protecting MatchResultRecord + MatchResultParticipant
        // rows that `process_tournament_mmr` (the batch reducer) needs to read
        // later. Calling `finalize_match_result` on an MMR tournament match
        // would (a) skip step 11 MMR processing because `runFinalization`
        // gates it on `!isTournamentControlled`, and (b) delete the ephemeral
        // rows at step 18 — silently losing MMR input for the entire match.
        //
        // Casual tournament matches are NOT guarded: they have no MMR input
        // to protect, runFinalization step 17 advances the bracket normally,
        // and `rollback_bracket_match` still works after step 18's cleanup
        // (it filters surviving MRRs and passes vacuously when none exist).
        // In practice, casual tournament matches never reach this reducer
        // anyway because `submit_match_result` auto-finalizes them inline.
        //
        // Pitfall 4 (broken derivation chain): if the bracketMatch or
        // tournament lookup fails, default to rejection. A broken chain
        // cannot be proved non-MMR, so we fall back to the safer path.
        if (matchResult.isTournamentControlled) {
            const bracketMatch = matchResult.bracketMatchId !== undefined
                ? ctx.db.BracketMatch.id.find(matchResult.bracketMatchId)
                : undefined;
            const derivedTournamentId = bracketMatch?.tournamentId;
            const tournament = derivedTournamentId !== undefined
                ? ctx.db.Tournament.id.find(derivedTournamentId)
                : undefined;
            const isCasualTournament = tournament != null && !tournament.countTowardsMmr;
            if (!isCasualTournament) {
                throw new SenderError(
                    'MMR tournament matches cannot be finalized individually. ' +
                    'MMR is processed in batch via process_tournament_mmr after the tournament reaches Completed. ' +
                    'Cancelled MMR tournaments do not generate MMR.'
                );
            }
        }
        // ── END D-H-01 ───────────────────────────────────────────────────────

        // 3. Authority check (Mod+, referee, tournament access)
        let hasAuthority = false;
        if (isRoleAtLeast(user.role, 'Moderator')) {
            hasAuthority = true;
        }
        if (!hasAuthority && matchResult.refereeUserId === user.id) {
            hasAuthority = true;
        }
        // Derive tournamentId from bracketMatch since tournamentId was removed from MatchResultRecord (D-42)
        if (!hasAuthority && matchResult.isTournamentControlled && matchResult.bracketMatchId !== undefined) {
            const bracketMatch = ctx.db.BracketMatch.id.find(matchResult.bracketMatchId);
            const derivedTournamentId = bracketMatch?.tournamentId;
            if (derivedTournamentId) {
                try {
                    ensureTournamentAccess(ctx, derivedTournamentId);
                    hasAuthority = true;
                } catch (_e) {
                    // Not authorized via tournament access
                }
            }
        }
        if (!hasAuthority) {
            throw new SenderError('You do not have authority to finalize this match result.');
        }

        // 4. Run the 19-step finalization pipeline
        runFinalization(ctx, matchResult, user.id);
    }
);

// ─── process_tournament_mmr ─────────────────────────────────────────────────
// Batch-processes MMR for all Validated, unprocessed matches in a completed
// tournament. Uses matchHistoryId=0 as sentinel (back-filled by runFinalization).
// Permission: TO/assistant/Moderator/Admin.

export const process_tournament_mmr = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        // 1. Verify tournament access
        const { user, tournament } = ensureTournamentAccess(ctx, tournamentId);

        // 2. Verify tournament is Completed or Cancelled
        if (tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled') {
            throw new SenderError('Tournament must be Completed or Cancelled to process MMR.');
        }

        // 3. Verify tournament counts toward MMR
        if (!tournament.countTowardsMmr) {
            throw new SenderError('This tournament does not count toward MMR (countTowardsMmr=false).');
        }

        // 4. Find all Validated, unprocessed MatchResultRecords for this tournament
        // New query path (D-42): tournament_id removed from MatchResultRecord;
        // derive via BracketMatch.tournament_id -> MatchResultRecord.bracket_match_id
        const bracketMatches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)];
        const matchResults = bracketMatches
            .map((bm: any) => [...ctx.db.MatchResultRecord.bracket_match_id.filter(bm.id)][0])
            .filter(Boolean)
            .filter((mr: any) => mr.status.tag === 'Validated' && mr.mmrProcessedAt === undefined);

        // 5. If no matches found, log and return
        if (matchResults.length === 0) {
            console.log('[MMR] No unprocessed matches for tournament #' + tournamentId);
            return;
        }

        // 6. Read EloConfig once
        const config = ctx.db.EloConfigTable.id.find(1);
        if (!config) {
            throw new SenderError('ELO config not initialized. Call admin_seed_elo_config first.');
        }

        // Read active season
        const activeSeason = [...ctx.db.Season.is_active.filter(true)][0];
        const tournamentSeasonId = activeSeason ? activeSeason.id : 0;

        // 7. For each match result, process MMR
        for (const mr of matchResults) {
            const participants = [...ctx.db.MatchResultParticipant.match_result_id.filter(mr.id)];
            const games = [...ctx.db.MatchResultGame.match_result_id.filter(mr.id)];
            const lobby = ctx.db.Lobby.id.find(mr.lobbyId);
            const gameMode = lobby?.gameMode ?? games[0]?.gameMode ?? { tag: 'MemoryOfChaos', value: {} };

            // MmrHistory rows inserted with matchHistoryId=0 as sentinel
            processMatchMmr(ctx, mr, participants, gameMode, tournamentSeasonId, 0, user.id);

            // Stamp mmrProcessedAt
            const freshMr = ctx.db.MatchResultRecord.id.find(mr.id);
            if (freshMr) {
                ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, freshMr, {
                    mmrProcessedAt: ctx.timestamp,
                }, user.id));
            }
        }

        // 8. Rebuild leaderboard once after all matches processed (with seasonId)
        rebuildLeaderboard(ctx, user.id, tournamentSeasonId);

        // 9. Log
        console.log(`[MMR] Processed ${matchResults.length} tournament matches for tournament #${tournamentId}`);
    }
);
