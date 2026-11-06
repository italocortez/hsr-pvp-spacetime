import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { auditUpdate } from '../helpers/auditColumns';
import { insertWithAudit } from '../helpers/auditHelpers';
import { ensureMatchAlive } from '../helpers/disconnectHelpers';

// ─── record_game_scores ─────────────────────────────────────────────────────
// Records or updates per-game scores for a match result.
// Two authority paths:
// 1. Participant captain: can set scores for their OWN side only.
// 2. Spectator referee (refereeFullControl=true): can set scores for BOTH sides.

export const record_game_scores = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
        gameNumber: t.u8(),
        winnerTeamSide: t.string(),
        teamBlueCyclesUsed: t.u32().optional(),
        teamRedCyclesUsed: t.u32().optional(),
        teamBlueScore: t.u64().optional(),
        teamRedScore: t.u64().optional(),
        teamBlueBoss1Score: t.u64().optional(),
        teamBlueBoss2Score: t.u64().optional(),
        teamRedBoss1Score: t.u64().optional(),
        teamRedBoss2Score: t.u64().optional(),
        teamBlueScreenshotUrl: t.string().optional(),
        teamRedScreenshotUrl: t.string().optional(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);

        // Find the MatchResultRecord
        const matchResult = ctx.db.MatchResultRecord.id.find(args.matchResultId);
        if (!matchResult) {
            throw new SenderError('Match result not found.');
        }

        // Validate status is Pending
        if (matchResult.status.tag !== 'Pending') {
            throw new SenderError('Scores can only be recorded when the match is in Pending status.');
        }

        // D-12: Liveness guard — block scoring after concede
        const scoreEntryLobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
        if (scoreEntryLobby) {
            ensureMatchAlive(ctx, scoreEntryLobby);
        }

        // Validate winnerTeamSide
        if (args.winnerTeamSide !== 'Blue' && args.winnerTeamSide !== 'Red') {
            throw new SenderError('winnerTeamSide must be "Blue" or "Red".');
        }

        // Determine caller authority
        const participant = [...ctx.db.MatchResultParticipant.by_result_and_user.filter([args.matchResultId, user.id])][0];

        if (participant) {
            // Participant path: must be a captain
            if (!participant.isCaptain) {
                throw new SenderError('Only the team captain can record game scores.');
            }

            // Captain can only set scores for their OWN side
            const side = participant.teamSide.tag;
            if (side === 'Blue') {
                // Reject if any Red-side fields are provided
                if (args.teamRedCyclesUsed !== undefined || args.teamRedScore !== undefined ||
                    args.teamRedBoss1Score !== undefined || args.teamRedBoss2Score !== undefined ||
                    args.teamRedScreenshotUrl !== undefined) {
                    throw new SenderError('Captains can only enter scores for their own side.');
                }
            } else if (side === 'Red') {
                // Reject if any Blue-side fields are provided
                if (args.teamBlueCyclesUsed !== undefined || args.teamBlueScore !== undefined ||
                    args.teamBlueBoss1Score !== undefined || args.teamBlueBoss2Score !== undefined ||
                    args.teamBlueScreenshotUrl !== undefined) {
                    throw new SenderError('Captains can only enter scores for their own side.');
                }
            }
        } else {
            // Non-participant path: must be spectator referee with refereeFullControl
            const lobbyMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([matchResult.lobbyId, user.id])][0];
            if (!lobbyMember || !lobbyMember.isReferee) {
                throw new SenderError('You are not a participant or authorized referee of this match.');
            }
            if (!matchResult.refereeFullControl) {
                throw new SenderError('You are not a participant or authorized referee of this match.');
            }
        }

        // Read the Lobby to get gameMode
        const lobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
        if (!lobby) {
            throw new SenderError('Associated lobby not found.');
        }

        // Check for existing MatchResultGame row (upsert pattern)
        const existing = [...ctx.db.MatchResultGame.by_result_and_game.filter([args.matchResultId, args.gameNumber])][0];

        if (existing) {
            // Update: delete + insert (composite PK). Preserve existing values for fields not provided.
            ctx.db.MatchResultGame.delete(existing);
            ctx.db.MatchResultGame.insert({
                matchResultId: args.matchResultId,
                gameNumber: args.gameNumber,
                gameMode: lobby.gameMode,
                teamBlueScreenshotUrl: args.teamBlueScreenshotUrl !== undefined ? args.teamBlueScreenshotUrl : existing.teamBlueScreenshotUrl,
                teamRedScreenshotUrl: args.teamRedScreenshotUrl !== undefined ? args.teamRedScreenshotUrl : existing.teamRedScreenshotUrl,
                teamBlueCyclesUsed: args.teamBlueCyclesUsed !== undefined ? args.teamBlueCyclesUsed : existing.teamBlueCyclesUsed,
                teamRedCyclesUsed: args.teamRedCyclesUsed !== undefined ? args.teamRedCyclesUsed : existing.teamRedCyclesUsed,
                teamBlueScore: args.teamBlueScore !== undefined ? args.teamBlueScore : existing.teamBlueScore,
                teamRedScore: args.teamRedScore !== undefined ? args.teamRedScore : existing.teamRedScore,
                teamBlueBoss1Score: args.teamBlueBoss1Score !== undefined ? args.teamBlueBoss1Score : existing.teamBlueBoss1Score,
                teamBlueBoss2Score: args.teamBlueBoss2Score !== undefined ? args.teamBlueBoss2Score : existing.teamBlueBoss2Score,
                teamRedBoss1Score: args.teamRedBoss1Score !== undefined ? args.teamRedBoss1Score : existing.teamRedBoss1Score,
                teamRedBoss2Score: args.teamRedBoss2Score !== undefined ? args.teamRedBoss2Score : existing.teamRedBoss2Score,
                winnerTeamSide: { tag: args.winnerTeamSide, value: {} } as any,
                validationStatus: { tag: 'Pending', value: {} } as any,
                validatedByUserId: undefined,
                ...auditUpdate(ctx, existing, user.id),
            } as any);
        } else {
            // Insert new row
            ctx.db.MatchResultGame.insert(insertWithAudit(ctx, {
                matchResultId: args.matchResultId,
                gameNumber: args.gameNumber,
                gameMode: lobby.gameMode,
                teamBlueScreenshotUrl: args.teamBlueScreenshotUrl,
                teamRedScreenshotUrl: args.teamRedScreenshotUrl,
                teamBlueCyclesUsed: args.teamBlueCyclesUsed,
                teamRedCyclesUsed: args.teamRedCyclesUsed,
                teamBlueScore: args.teamBlueScore,
                teamRedScore: args.teamRedScore,
                teamBlueBoss1Score: args.teamBlueBoss1Score,
                teamBlueBoss2Score: args.teamBlueBoss2Score,
                teamRedBoss1Score: args.teamRedBoss1Score,
                teamRedBoss2Score: args.teamRedBoss2Score,
                winnerTeamSide: { tag: args.winnerTeamSide, value: {} } as any,
                validationStatus: { tag: 'Pending', value: {} } as any,
                validatedByUserId: undefined,
            }, user.id));
        }

        console.log(`[MATCH] Game ${args.gameNumber} scores recorded for match result #${args.matchResultId} by user #${user.id}`);
    }
);
