import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { insertWithAudit } from '../helpers/auditHelpers';
import { ensureNotInLobby, generateJoinCode } from '../helpers/lobbyHelpers';
import type { Lobby } from '../module_bindings/types';

// ─── create_tournament_lobby ─────────────────────────────────────────────────
// Creates a lobby linked to a bracket match.
// Per D-64: authorized callers — match participants (via TournamentTeam), TO, assistant, admin, moderator.
// Per D-65: ALL settings inherited from Tournament and locked (isTournamentControlled=true).
// Per D-45: duplicate prevention — no non-Finished lobby may exist for the same bracketMatchId.
// Per D-22: enforces one lobby per user.
// Per D-67: matchType derived from tournament.countTowardsMmr.

export const create_tournament_lobby = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
        joinCode: t.string(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);

        // Resolve bracket match
        const bracketMatch = ctx.db.BracketMatch.id.find(args.bracketMatchId);
        if (!bracketMatch) {
            throw new SenderError('Bracket match not found.');
        }

        // Resolve tournament
        const tournament = ctx.db.Tournament.id.find(bracketMatch.tournamentId);
        if (!tournament) {
            throw new SenderError('Tournament not found.');
        }

        // D-64: Authorization check — one of:
        //   a. Match participant (team member in team1 or team2)
        //   b. Tournament organizer
        //   c. Tournament assistant
        //   d. Admin or Moderator
        let isAuthorized = false;

        if (isRoleAtLeast(user.role, 'Moderator')) {
            // Admin/Moderator always authorized
            isAuthorized = true;
        } else if (tournament.organizerId === user.id) {
            // Tournament organizer
            isAuthorized = true;
        } else {
            // Check tournament assistant
            const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([bracketMatch.tournamentId, user.id])][0];
            if (assistant) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            // Check if user is a member of one of the bracket match's teams via TournamentTeamMember (D-20)
            const team1Id = bracketMatch.team1Id;
            const team2Id = bracketMatch.team2Id;

            const userTtm = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([bracketMatch.tournamentId, user.id])][0];
            if (userTtm) {
                if ((team1Id !== undefined && team1Id !== null && userTtm.teamId === team1Id) ||
                    (team2Id !== undefined && team2Id !== null && userTtm.teamId === team2Id)) {
                    isAuthorized = true;
                }
            }
        }

        if (!isAuthorized) {
            throw new SenderError('You are not authorized to create a lobby for this bracket match.');
        }

        // D-45: Duplicate prevention — check no non-Finished lobby exists for this bracketMatchId
        for (const existingLobby of ctx.db.Lobby.iter()) {
            if (
                existingLobby.bracketMatchId !== undefined &&
                existingLobby.bracketMatchId !== null &&
                existingLobby.bracketMatchId === args.bracketMatchId &&
                existingLobby.stage.tag !== 'Finished'
            ) {
                throw new SenderError('A lobby already exists for this bracket match.');
            }
        }

        // D-22: one lobby at a time per user
        ensureNotInLobby(ctx, user.id);

        // D-67: Derive matchType from tournament.countTowardsMmr
        const matchType = tournament.countTowardsMmr
            ? { tag: 'Ranked', value: {} }
            : { tag: 'Casual', value: {} };

        // D-65: Inherit ALL settings from Tournament, locked.
        // For fields not present on Tournament (draftMode, banMode, timers, budgets),
        // use sensible tournament defaults.
        const joinCode = generateJoinCode(ctx, user.id);
        const lobby = ctx.db.Lobby.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            joinCode,
            hostUserId: user.id,
            teamBlueAlias: 'Blue',
            teamRedAlias: 'Red',

            // Team size inherited from tournament
            teamSize: tournament.teamSize,

            // Draft/ban mode — tournament defaults (Standard Classic with 4 bans)
            draftMode: { tag: 'Classic', value: {} } as any,
            banMode: { tag: 'Four', value: {} } as any,

            // Timers — tournament standard defaults
            standardTurnSeconds: 60,
            reserveBankSeconds: 120,

            // Handicap/scoring — tournament standard defaults
            rosterDiffAdvantage: 0,
            rosterThreshold: 0,
            underThresholdAdvantage: 0,
            aboveThresholdPenalty: 0,
            deathPenalty: 0,

            // Match type derived from tournament
            matchType: matchType as Lobby['matchType'],

            // Player count (just the creator for now)
            currentPlayerCount: 1,

            // Budgets — tournament standard defaults (f32)
            characterBudget: 0,
            lightconeBudget: 0,
            minimumBidRaise: 20,

            // Draft options — tournament standard defaults
            allowMirrorPicks: false,  // Ranked forces false per D-42
            autoRandomPick: false,

            // Referee powers — tournament defaults (permissive)
            refereeCanUndo: true,
            refereeCanPause: true,
            refereeCanSetCaptain: true,
            refereeCanKick: false,

            // Player pause
            allowPlayerPause: true,

            // Tournament linkage (D-65)
            tournamentId: tournament.id,
            bracketMatchId: args.bracketMatchId,
            isTournamentControlled: true,

            // Anonymous play inherited from tournament
            isAnonymousPlayers: tournament.isAnonymousDefault,
            isAnonymousSpectators: tournament.isAnonymousSpectators,

            // Roster visibility inherited from tournament
            rosterVisibility: tournament.rosterVisibility,

            // Ownership — inherited from tournament (Phase 12.3 follow-up)
            requireOwnership: tournament.requireOwnership,

            // Cost set inherited from tournament
            costSetId: tournament.costSetId,

            // Tournament lobbies are public within the tournament
            isPublic: true,

            // Disconnect behavior inherited from tournament
            disconnectPolicy: tournament.disconnectPolicy,
            disconnectForfeitSeconds: tournament.autoForfeitEnabled ? tournament.autoForfeitMinutes * 60 : undefined,

            // Game mode from tournament
            gameMode: tournament.defaultGameMode,

            // Referee exclusive concede (D-92)
            refereeExclusiveConcede: true,

            // D-11: Copy bestOf from BracketMatch (tournament match series length)
            bestOf: bracketMatch.bestOf > 0 ? bracketMatch.bestOf : 1,

            // D-06: Referee controls shelving for tournament lobbies (default true)
            refereeControlsShelving: true,

            // Lifecycle
            lastActivityAt: ctx.timestamp,
            stage: { tag: 'Waiting', value: {} } as any,
        }, user.id));

        // D-24: host joins as referee, D-27: starts as Spectator
        ctx.db.LobbyMember.insert(insertWithAudit(ctx, {
            lobbyId: lobby.id,
            userId: user.id,
            isOnline: true,
            lobbySlot: { tag: 'Spectator', value: {} } as any,
            isReferee: true,
            isConfirmed: false,
            isCaptain: false,
            voluntarilyLeft: false,
            disconnectedAt: undefined,
            disconnectPoolRemainingMs: 0,
        }, user.id));

        console.log(`[TOURNAMENT_LOBBY] Lobby #${lobby.id} created for bracket match #${args.bracketMatchId} by user #${user.id}`);
    }
);

// ─── approve_stand_in ─────────────────────────────────────────────────────────
// Approves a stand-in player for a bracket match.
// Per D-68: TO/admin/moderator/assistant can approve anyone as a stand-in.
// Inserts a TournamentStandIn row (bracketMatchId + userId composite PK).
// Approval can happen before or during the lobby.

export const approve_stand_in = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
        userId: t.u32(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);

        // Resolve bracket match and tournament
        const bracketMatch = ctx.db.BracketMatch.id.find(args.bracketMatchId);
        if (!bracketMatch) {
            throw new SenderError('Bracket match not found.');
        }

        const tournament = ctx.db.Tournament.id.find(bracketMatch.tournamentId);
        if (!tournament) {
            throw new SenderError('Tournament not found.');
        }

        // Permission: TO, Admin, Moderator, or tournament assistant
        let isAuthorized = false;
        if (isRoleAtLeast(user.role, 'Moderator')) {
            isAuthorized = true;
        } else if (tournament.organizerId === user.id) {
            isAuthorized = true;
        } else {
            const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([bracketMatch.tournamentId, user.id])][0];
            if (assistant) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            throw new SenderError('Only a tournament organizer, assistant, moderator, or admin can approve stand-ins.');
        }

        // Validate target user exists
        const targetUser = ctx.db.User.id.find(args.userId);
        if (!targetUser) {
            throw new SenderError('Target user not found.');
        }

        // Check not already approved for this match
        const existing = [...ctx.db.TournamentStandIn.by_match_and_user.filter([args.bracketMatchId, args.userId])][0];
        if (existing) {
            throw new SenderError('Stand-in already approved for this bracket match.');
        }

        // Insert TournamentStandIn row
        ctx.db.TournamentStandIn.insert(insertWithAudit(ctx, {
            bracketMatchId: args.bracketMatchId,
            userId: args.userId,
            approvedByUserId: user.id,
        }, user.id));

        console.log(`[TOURNAMENT_LOBBY] Stand-in user #${args.userId} approved for bracket match #${args.bracketMatchId} by user #${user.id}`);
    }
);
