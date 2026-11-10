import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureNotInLobby, generateJoinCode } from '@module/helpers/lobby/lobbyHelpers';
import { ensureTournamentPermission, hasTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import { findSystemLobbyPreset, SYSTEM_PRESET_VALUES } from '@module/helpers/lobby/systemPreset';
import { autoSeatSlot } from '@module/helpers/tournament/tournamentLobbySides';
import { findLobbyResult } from '@module/helpers/results/scoringHelpers';
import { matchGames } from '@module/helpers/tournament/bracketResults';
import { LOBBY_NAME_MAX, winsNeededFor } from '@module/helpers/tournament/seriesSettings';
import { ensureEntryRequirements } from '@module/helpers/tournament/tournamentHelpers';
import {
    OPEN_MATCH_STATES, STILL_IN_TEAM_STATUSES, inviteStandInToMatchEvents, participateAsStandIn, removeStandIn,
} from '@module/helpers/tournament/standIns';
import { MAX_INVITEES_PER_EVENT } from '@module/reducers/calendar/calendarEvents';
import type { Lobby } from '@bindings/types';

/**
 * A34: the creator is a member of team1 / team2 of the match. A140 (S10v): an approved stand-in no longer qualifies
 * through the approval (it creates only through a role that allows it by itself, see create_tournament_lobby).
 */
function isMatchMember(ctx: any, bracketMatch: any, userId: number): boolean {
    const teams = [bracketMatch.team1Id, bracketMatch.team2Id].filter((id) => id !== undefined);
    const membership = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([bracketMatch.tournamentId, userId])][0];
    return !!membership && teams.includes(membership.teamId);
}

// ─── create_tournament_lobby ─────────────────────────────────────────────────
// A33, A33a, A34, A35, D-45, A67(5) (S8d, S8e). Creates the lobby of one game of a bracket match.
// Caller (A34, A140): a member of team1 / team2 of the match, or staff with the `bracket` permission (organizer,
// Moderator+, assistant with canManageBracket, A25). A140 (S10v): a stand-in approval alone does not allow it ("A
// stand-in cannot create the match lobby: a team member or tournament staff creates it."); a stand-in who holds such a
// role (a Moderator or Admin approved by someone else; tournament staff cannot be stand-ins, A135(2)) creates through
// the role and is seated like any staff creator, as a Spectator referee. The match must be Ready (not decided), the
// tournament InProgress; D-45 (A67(5)): every lobby of the match (Lobby.bracket_match_id) must be settled (its record
// Validated, parked in AwaitingResult), so one game is in play at a time; and the Validated games of the match must
// not already reach BracketMatch.bestOf (the game cap).
// Settings: the integrity set (A33) from the tournament, locked by update_lobby_settings (D-65): teamSize, gameMode,
// matchType (countTowardsMmr), both anonymity flags, rosterVisibility, requireOwnership, costSetId, disconnectPolicy +
// disconnectForfeitSeconds, allowMirrorPicks (false when ranked, D-42), lineupFormat. A67(2): no series settings on
// the lobby (the bracket match carries bestOf and the A27 head start). The free set
// from the preset at Tournament.lobbyPresetId, the system preset when that row is gone (A33a). name = the tournament
// name + the match key (D-A8, truncated to 50 characters).
// A68(4): `abandonCurrentMatch` lets an away creator give up that match (ensureNotInLobby).
// The creator is host and referee (A34): a participant is seated as a player on its team's side (A26 / A35; the colour from the match's mapping, A70(1)); staff
// are seated as a spectator referee and become a member like anyone else (the one-lobby-at-a-time rule applies, D-22).
// isCaptain stays false, as in create_lobby (start_draft assigns captains, D-30). A114(2) (S10n): no joinCode
// argument; the server generates the code.

export const create_tournament_lobby = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
        abandonCurrentMatch: t.bool().optional(), // A68(4): give up an away membership; default false
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

        // A34: a member of the match's teams or `bracket` staff (A25). A140: a plain stand-in is refused.
        const isParticipant = isMatchMember(ctx, bracketMatch, user.id);
        if (!isParticipant && !hasTournamentPermission(ctx, user, tournament, 'bracket')) {
            if ([...ctx.db.TournamentStandIn.by_match_and_user.filter([bracketMatch.id, user.id])].length > 0) {
                throw new SenderError('A stand-in cannot create the match lobby: a team member or tournament staff creates it.');
            }
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

        // D-22 / A68(4): one lobby at a time per user (staff creators included, A34)
        ensureNotInLobby(ctx, user.id, args.abandonCurrentMatch ?? false);

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
            confirmWindowSeconds: preset.confirmWindowSeconds, // S10t (A131): free set, from the preset
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
            maxSpectators: preset.maxSpectators, // A68(8): free set

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
            lastJoinSeq: 1, // A74(3): the host's seat
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
            leftAt: undefined,
            abandonedAt: undefined,
            disconnectedAt: undefined,
            disconnectPoolRemainingMs: 0,
            joinSeq: 1, // R4 / A74(3): the host's seat; lobby.lastJoinSeq starts at 1
            lastCursorAt: undefined,
            lastLineupAt: undefined,
        }, user.id));

        // S10v review F11 (SI2), narrowed by A140: only a stand-in creating through a role (Moderator / Admin) reaches
        // this; seated as a Spectator like any staff creator, the creation is their own act, as a Spectator join is.
        participateAsStandIn(ctx, lobby, user.id, user.id);

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
// match) for one bracket match (every game of it, not the next match). The row carries teamId, which allowedSlotsFor
// reads (the team's colour in this match, A70(1); default team1 -> Blue). Approval can happen before or during the
// lobby. S10s (A122(19), L66): the team must not be Disqualified; approvals and the stand-ins' account locks are
// deleted when the tournament completes or is cancelled (deleteTournamentStandIns).
// S10v (A135, A136; audit SI6-SI8, SI11, SI13, SI17), checks in this order:
//   - A136: the bracket exists: Seeding with bracketGeneratedAt set, or InProgress (not before generation, not in
//     Completed / Cancelled);
//   - A135(5): not in a solo tournament (teamSize 1: the one member must play every game);
//   - SI13: the match is open (Pending or Ready) and neither slot is a BYE; the team plays it and is not Disqualified;
//   - the user exists and is not deleted / banned (deletedAt), is verified (no guest);
//   - A135(2): not the organizer, not an assistant of the tournament (whatever the assistant's permissions);
//   - A137(1): not the caller (no self-approval, whatever the role);
//   - A128: not Disqualified in the tournament;
//   - A135(3): not a member of a team of the tournament that is still in (Forming, Ready, Active); a member of an
//     Eliminated / Withdrawn team and a user with no team are accepted; never a member of the match's other team;
//   - A135(1): the tournament's entry requirements (ensureEntryRequirements, shared with registration; for a stand-in
//     requireOwnership also needs an active game account);
//   - one approval per user and match.
// Then: SI16 an invite to the match's calendar event. No account lock here (review F7): the snapshot comes with the
// stand-in's own first participation (create_tournament_lobby, join_lobby, a self seat move; participateAsStandIn).

export const approve_stand_in = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
        teamId: t.u32(),
        userId: t.u32(),
    },
    (ctx, args) => {
        const { user, bracketMatch } = standInMatch(ctx, args.bracketMatchId);

        // A136 (S10v): from bracket generation on, until the tournament ends.
        const tournament = ctx.db.Tournament.id.find(bracketMatch.tournamentId);
        const stage = tournament?.stage.tag;
        const bracketExists = stage === 'InProgress' || (stage === 'Seeding' && tournament?.bracketGeneratedAt !== undefined);
        if (!tournament || !bracketExists) {
            throw new SenderError('Stand-ins can be approved once the bracket is generated, until the tournament ends.');
        }
        // A135(5) (S10v): a solo tournament cannot field a stand-in (no member would be left to play).
        if (tournament.teamSize === 1) {
            throw new SenderError('A solo tournament cannot field a stand-in: a team member must play every game.');
        }
        // SI13 (S10v): an open match that will be played.
        if (!OPEN_MATCH_STATES.has(bracketMatch.state.tag) || bracketMatch.team1IsBye || bracketMatch.team2IsBye) {
            throw new SenderError('Stand-ins can only be approved for a match that is still open (Pending or Ready).');
        }
        if (args.teamId !== bracketMatch.team1Id && args.teamId !== bracketMatch.team2Id) {
            throw new SenderError('The team does not play this bracket match.');
        }
        if (ctx.db.TournamentTeam.id.find(args.teamId)?.status.tag === 'Disqualified') {
            throw new SenderError('A disqualified team cannot get a stand-in.');
        }
        const targetUser = ctx.db.User.id.find(args.userId);
        if (!targetUser || targetUser.deletedAt) {
            throw new SenderError('Target user not found.');
        }
        if (targetUser.isGuest) {
            throw new SenderError('A stand-in must be a verified user.');
        }
        // A135(2) (S10v, SI7): staff of this tournament (organizer, any assistant row) never stand in, whoever approves.
        if (tournament.organizerId === args.userId
            || [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([tournament.id, args.userId])].length > 0) {
            throw new SenderError('Tournament staff (the organizer and the assistants) cannot be a stand-in.');
        }
        // A137(1) (S10v review F8): nobody approves themself, whatever the role.
        if (args.userId === user.id) {
            throw new SenderError('You cannot approve yourself as a stand-in.');
        }
        // S10t (A128): a player disqualified from this tournament cannot stand in for any team.
        const enrolment = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([bracketMatch.tournamentId, args.userId])][0];
        if (enrolment?.status.tag === 'Disqualified') {
            throw new SenderError('A disqualified player cannot be a stand-in.');
        }
        const otherTeamId = args.teamId === bracketMatch.team1Id ? bracketMatch.team2Id : bracketMatch.team1Id;
        const membership = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([bracketMatch.tournamentId, args.userId])][0];
        if (membership && otherTeamId !== undefined && membership.teamId === otherTeamId) {
            throw new SenderError('A stand-in cannot be enrolled on the other team of the match.');
        }
        // A135(3) (S10v, SI8): the user's own team is still in the tournament.
        if (membership && STILL_IN_TEAM_STATUSES.has(ctx.db.TournamentTeam.id.find(membership.teamId)?.status.tag ?? '')) {
            throw new SenderError('A player whose team is still in the tournament cannot be a stand-in.');
        }
        // A135(1) (S10v, SI6): the registration checks of this tournament.
        ensureEntryRequirements(ctx, tournament, targetUser, 'standIn');
        const existing = [...ctx.db.TournamentStandIn.by_match_and_user.filter([args.bracketMatchId, args.userId])][0];
        if (existing) {
            throw new SenderError('Stand-in already approved for this bracket match.');
        }

        ctx.db.TournamentStandIn.insert(insertWithAudit(ctx, {
            id: 0,
            bracketMatchId: args.bracketMatchId,
            teamId: args.teamId, // A35 / A70(1): seated on the colour this team plays in the match
            userId: args.userId,
            approvedByUserId: user.id,
        }, user.id));
        // Review F7: no lock at approval (the user has agreed to nothing yet); the snapshot comes with the stand-in's own
        // first participation in a lobby of the match (participateAsStandIn / join_lobby).
        inviteStandInToMatchEvents(ctx, bracketMatch, args.userId, user.id, MAX_INVITEES_PER_EVENT); // SI16

        console.log(`[TOURNAMENT_LOBBY] Stand-in user #${args.userId} approved for team #${args.teamId} in bracket match #${args.bracketMatchId} by user #${user.id}`);
    }
);

// ─── revoke_stand_in ──────────────────────────────────────────────────────────
// A25 `participants` (S8d). Deletes the stand-in approval of `userId` for the bracket match, at any stage.
// S10v (SI4, SI12, SI16; removeStandIn): in every Waiting lobby of the match the user is moved to Spectator; a game
// already running keeps the seat (its result is recorded with whoever sat). The user's invite to the match's calendar
// event goes; the locks are released when the user is not enrolled, holds no other open approval and has not played.

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
        removeStandIn(ctx, existing, user.id);

        console.log(`[TOURNAMENT_LOBBY] Stand-in user #${args.userId} revoked for bracket match #${args.bracketMatchId} by user #${user.id}`);
    }
);
