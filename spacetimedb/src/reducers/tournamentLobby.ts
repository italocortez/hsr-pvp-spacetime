import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { insertWithAudit } from '../helpers/auditHelpers';
import { ensureNotInLobby, generateJoinCode, nextJoinSeq } from '../helpers/lobbyHelpers';
import { ensureTournamentPermission, hasTournamentPermission } from '../helpers/tournamentPermissions';
import { findSystemLobbyPreset, SYSTEM_PRESET_VALUES } from '../helpers/systemPreset';
import { autoSeatSlot } from '../helpers/tournamentLobbySides';
import { findLobbyResult } from '../helpers/scoringHelpers';
import { matchGames } from '../helpers/bracketResults';
import { winsNeededFor } from '../helpers/seriesSettings';
import type { Lobby } from '@bindings/types';

const LOBBY_NAME_MAX = 50; // D-A8 (helpers/seriesSettings.ts normalizeLobbyName)

/** A34 / A35: the creator is a member of team1 / team2 of the match or one of its approved stand-ins. */
function isMatchParticipant(ctx: any, bracketMatch: any, userId: number): boolean {
    const teams = [bracketMatch.team1Id, bracketMatch.team2Id].filter((id) => id !== undefined);
    const membership = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([bracketMatch.tournamentId, userId])][0];
    if (membership && teams.includes(membership.teamId)) return true;
    const standIn = [...ctx.db.TournamentStandIn.by_match_and_user.filter([bracketMatch.id, userId])][0];
    return !!standIn && teams.includes(standIn.teamId);
}

// ─── create_tournament_lobby ─────────────────────────────────────────────────
// A33, A33a, A34, A35, D-45, A67(5) (S8d, S8e). Creates the lobby of one game of a bracket match.
// Caller (A34): a member of team1 / team2 of the match or an approved stand-in of either, or staff with the `bracket`
// permission (organizer, Moderator+, assistant with canManageBracket, A25). The match must be Ready (not decided), the
// tournament InProgress; D-45 (A67(5)): every lobby of the match (Lobby.bracket_match_id) must be settled (its record
// Validated, parked in AwaitingResult), so one game is in play at a time; and the Validated games of the match must
// not already reach BracketMatch.bestOf (the game cap).
// Settings: the integrity set (A33) from the tournament, locked by update_lobby_settings (D-65): teamSize, gameMode,
// matchType (countTowardsMmr), both anonymity flags, rosterVisibility, requireOwnership, costSetId, disconnectPolicy +
// disconnectForfeitSeconds, allowMirrorPicks (false when ranked, D-42), lineupFormat. A67(2): no series settings on
// the lobby (the bracket match carries bestOf and the A27 head start). The free set
// from the preset at Tournament.lobbyPresetId, the system preset when that row is gone (A33a). name = the tournament
// name + the match key (D-A8, truncated to 50 characters).
// The creator is host and referee (A34): a participant is seated as a player on its team's side (A26 / A35); staff
// are seated as a spectator referee and become a member like anyone else (the one-lobby-at-a-time rule applies, D-22).
// isCaptain stays false, as in create_lobby (start_draft assigns captains, D-30). `joinCode` is ignored (the server
// generates the code, as before).

export const create_tournament_lobby = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
        joinCode: t.string(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);

        const bracketMatch = ctx.db.BracketMatch.id.find(args.bracketMatchId);
        if (!bracketMatch) {
            throw new SenderError('Bracket match not found.');
        }
        const tournament = ctx.db.Tournament.id.find(bracketMatch.tournamentId);
        if (!tournament) {
            throw new SenderError('Tournament not found.');
        }

        // A34: a participant of the match or `bracket` staff (A25)
        const isParticipant = isMatchParticipant(ctx, bracketMatch, user.id);
        if (!isParticipant && !hasTournamentPermission(ctx, user, tournament, 'bracket')) {
            throw new SenderError('You are not authorized to create a lobby for this bracket match.');
        }

        if (tournament.stage.tag !== 'InProgress') {
            throw new SenderError('Tournament is not in progress.');
        }
        if (bracketMatch.state.tag !== 'Ready') {
            throw new SenderError(`${bracketMatch.positionKey} is ${bracketMatch.state.tag}; a lobby needs a Ready match.`);
        }

        // D-45, A67(5): one game in play per bracket match. A lobby is settled when its record is Validated (it then
        // parks in AwaitingResult until the finalize job, A24(2)); any other lobby (Waiting, playing, or parked with a
        // Pending / Submitted / Disputed record) blocks a new one.
        let validatedGames = 0;
        for (const existingLobby of ctx.db.Lobby.bracket_match_id.filter(args.bracketMatchId)) {
            if (findLobbyResult(ctx, existingLobby.id)?.status.tag !== 'Validated') {
                throw new SenderError('A lobby for this bracket match is still in play.');
            }
        }
        // A67(5): the game cap (Validated records of the match; the head start is not a game played).
        for (const record of ctx.db.MatchResultRecord.bracket_match_id.filter(args.bracketMatchId)) {
            if (record.status.tag === 'Validated') validatedGames++;
        }
        if (validatedGames >= bracketMatch.bestOf) {
            throw new SenderError(`This bracket match has no games left (best of ${bracketMatch.bestOf}).`);
        }
        // A67(4) (S8e review): a Ready match whose derived tally already gives a side ceil(bestOf / 2) games takes no
        // further game (defensive: rollbackBracketResult re-decides such a match).
        const tally = matchGames(ctx, bracketMatch);
        if (Math.max(tally.team1, tally.team2) >= winsNeededFor(bracketMatch.bestOf)) {
            throw new SenderError('This bracket match is decided by its games.');
        }

        // D-22: one lobby at a time per user (staff creators included, A34)
        ensureNotInLobby(ctx, user.id);

        // D-67: matchType from tournament.countTowardsMmr
        const isRanked = tournament.countTowardsMmr;
        const matchType = isRanked ? { tag: 'Ranked', value: {} } : { tag: 'Casual', value: {} };

        // A33a: the free set from the tournament's preset, or the system preset when that row no longer exists
        const preset = ctx.db.LobbyPreset.id.find(tournament.lobbyPresetId) ?? findSystemLobbyPreset(ctx) ?? SYSTEM_PRESET_VALUES;

        const key = bracketMatch.positionKey;
        const name = `${tournament.name.slice(0, Math.max(0, LOBBY_NAME_MAX - key.length - 1))} ${key}`.trim();

        const joinCode = generateJoinCode(ctx, user.id);
        const lobby = ctx.db.Lobby.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            joinCode,
            name, // D-A8
            hostUserId: user.id,
            teamBlueAlias: 'Blue',
            teamRedAlias: 'Red',

            // ── Integrity set (A33), from the tournament and the bracket ──
            teamSize: tournament.teamSize,
            lineupFormat: tournament.lineupFormat,
            matchType: matchType as Lobby['matchType'],
            allowMirrorPicks: isRanked ? false : tournament.allowMirrorPicks, // D-42: Ranked forces false
            isAnonymousPlayers: tournament.isAnonymousDefault,
            isAnonymousSpectators: tournament.isAnonymousSpectators,
            rosterVisibility: tournament.rosterVisibility,
            requireOwnership: tournament.requireOwnership,
            costSetId: tournament.costSetId,
            disconnectPolicy: tournament.disconnectPolicy,
            disconnectForfeitSeconds: tournament.disconnectForfeitSeconds, // A36: one optional timer
            gameMode: tournament.defaultGameMode,

            // ── Free set (A33, A33a), from the preset ──
            draftMode: preset.draftMode,
            banMode: preset.banMode,
            banRestriction: preset.banRestriction,
            standardTurnSeconds: preset.standardTurnSeconds,
            reserveBankSeconds: preset.reserveBankSeconds,
            rosterDiffAdvantage: preset.rosterDiffAdvantage,
            rosterThreshold: preset.rosterThreshold,
            underThresholdAdvantage: preset.underThresholdAdvantage,
            aboveThresholdPenalty: preset.aboveThresholdPenalty,
            deathPenalty: preset.deathPenalty,
            characterBudget: preset.characterBudget,
            lightconeBudget: preset.lightconeBudget,
            minimumBidRaise: preset.minimumBidRaise,
            autoRandomPick: preset.autoRandomPick,
            refereeCanUndo: preset.refereeCanUndo,
            refereeCanPause: preset.refereeCanPause,
            refereeCanSetCaptain: preset.refereeCanSetCaptain,
            refereeCanKick: preset.refereeCanKick,
            allowPlayerPause: preset.allowPlayerPause,
            refereeExclusiveConcede: preset.refereeExclusiveConcede,
            hideMmr: preset.hideMmr, // A40

            // Player count (just the creator for now)
            currentPlayerCount: 1,

            // Tournament linkage (D-65)
            tournamentId: tournament.id,
            bracketMatchId: args.bracketMatchId,
            isTournamentControlled: true,

            // Tournament lobbies are public within the tournament
            isPublic: true,

            // Lifecycle
            lastActivityAt: ctx.timestamp,
            stage: { tag: 'Waiting', value: {} } as any,
        }, user.id));

        // A34: the creator is host and referee; a participant sits on its team's player seat (A26 / A35), staff on
        // the Spectator seat (D-27).
        const slot = isParticipant ? autoSeatSlot(ctx, lobby, user.id) : 'Spectator';
        ctx.db.LobbyMember.insert(insertWithAudit(ctx, {
            lobbyId: lobby.id,
            userId: user.id,
            isOnline: true,
            lobbySlot: { tag: slot, value: {} } as any,
            isReferee: true,
            isConfirmed: false,
            isCaptain: false,
            voluntarilyLeft: false,
            disconnectedAt: undefined,
            disconnectPoolRemainingMs: 0,
            joinSeq: nextJoinSeq(ctx, lobby.id), // R4: per-lobby join counter; A22(5) order and the S9 labels derive from it
            lastCursorAt: undefined,
            lastLineupAt: undefined,
        }, user.id));

        console.log(`[TOURNAMENT_LOBBY] Lobby #${lobby.id} created for bracket match #${args.bracketMatchId} by user #${user.id} (${slot})`);
    }
);

/** Shared checks of the stand-in reducers: the match, `participants` permission (A25). */
function standInMatch(ctx: any, bracketMatchId: number): { user: any; bracketMatch: any } {
    const bracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
    if (!bracketMatch) {
        throw new SenderError('Bracket match not found.');
    }
    const { user } = ensureTournamentPermission(ctx, bracketMatch.tournamentId, 'participants');
    return { user, bracketMatch };
}

// ─── approve_stand_in ─────────────────────────────────────────────────────────
// A25 `participants`; A35 / review §5.4 (S8d). Approves `userId` as a stand-in of `teamId` (team1 or team2 of the
// match) for one bracket match: any verified user who is not enrolled on the other team of the match. The row
// carries teamId, which allowedSlotsFor reads (team1 -> Blue, team2 -> Red). Approval can happen before or during
// the lobby.

export const approve_stand_in = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
        teamId: t.u32(),
        userId: t.u32(),
    },
    (ctx, args) => {
        const { user, bracketMatch } = standInMatch(ctx, args.bracketMatchId);

        if (args.teamId !== bracketMatch.team1Id && args.teamId !== bracketMatch.team2Id) {
            throw new SenderError('The team does not play this bracket match.');
        }
        const targetUser = ctx.db.User.id.find(args.userId);
        if (!targetUser) {
            throw new SenderError('Target user not found.');
        }
        if (targetUser.isGuest) {
            throw new SenderError('A stand-in must be a verified user.');
        }
        const otherTeamId = args.teamId === bracketMatch.team1Id ? bracketMatch.team2Id : bracketMatch.team1Id;
        const membership = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([bracketMatch.tournamentId, args.userId])][0];
        if (membership && otherTeamId !== undefined && membership.teamId === otherTeamId) {
            throw new SenderError('A stand-in cannot be enrolled on the other team of the match.');
        }
        const existing = [...ctx.db.TournamentStandIn.by_match_and_user.filter([args.bracketMatchId, args.userId])][0];
        if (existing) {
            throw new SenderError('Stand-in already approved for this bracket match.');
        }

        ctx.db.TournamentStandIn.insert(insertWithAudit(ctx, {
            id: 0,
            bracketMatchId: args.bracketMatchId,
            teamId: args.teamId, // A35: team1 -> Blue, team2 -> Red
            userId: args.userId,
            approvedByUserId: user.id,
        }, user.id));

        console.log(`[TOURNAMENT_LOBBY] Stand-in user #${args.userId} approved for team #${args.teamId} in bracket match #${args.bracketMatchId} by user #${user.id}`);
    }
);

// ─── revoke_stand_in ──────────────────────────────────────────────────────────
// A25 `participants` (S8d). Deletes the stand-in approval of `userId` for the bracket match. A seat the stand-in
// already holds in a lobby is not changed (seat rules apply to the next join or move).

export const revoke_stand_in = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
        userId: t.u32(),
    },
    (ctx, args) => {
        const { user } = standInMatch(ctx, args.bracketMatchId);
        const existing = [...ctx.db.TournamentStandIn.by_match_and_user.filter([args.bracketMatchId, args.userId])][0];
        if (!existing) {
            throw new SenderError('No stand-in approval for this user in this bracket match.');
        }
        ctx.db.TournamentStandIn.id.delete(existing.id);

        console.log(`[TOURNAMENT_LOBBY] Stand-in user #${args.userId} revoked for bracket match #${args.bracketMatchId} by user #${user.id}`);
    }
);
