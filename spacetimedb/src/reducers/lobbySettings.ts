import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { DraftMode, BanMode, GameMode, MatchType, RosterVisibility, DisconnectPolicy, LobbySlot } from '../types/enums';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureLobbyMember, ensureHostOrAbove, ensureStageIs, slotTeam, slotIsCoach, slotIsSpectator, slotToTeamSide } from '../helpers/lobbyHelpers';

// ─── update_lobby_settings ────────────────────────────────────────────────────
// Updates all mutable lobby configuration fields.
// Per D-28: settings mutable only during Waiting stage.
// Per D-65: tournament-controlled lobbies lock tournament-integrity fields
//   (teamSize, gameMode, matchType, anonymity, rosterVisibility, costSetId,
//    disconnectPolicy, disconnectForfeitSeconds, requireOwnership, allowMirrorPicks)
//   but allow referee/match QoL fields to change (draftMode, banMode, timers,
//   budgets, handicaps, referee powers, aliases, pause settings, visibility).
// Per D-42: Ranked forces allowMirrorPicks=false.
// Per D-23: guests forced to ClosedNoRating and Casual.
// Resets all members' isConfirmed to false on settings change.

export const update_lobby_settings = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        teamSize: t.u8(),
        draftMode: DraftMode,
        banMode: BanMode,
        gameMode: GameMode,
        matchType: MatchType,
        standardTurnSeconds: t.u32(),
        reserveBankSeconds: t.u32(),
        characterBudget: t.f32(),
        lightconeBudget: t.f32(),
        minimumBidRaise: t.f32(),
        rosterDiffAdvantage: t.f32(),
        rosterThreshold: t.f32(),
        underThresholdAdvantage: t.f32(),
        aboveThresholdPenalty: t.f32(),
        deathPenalty: t.f32(),
        isAnonymousPlayers: t.bool(),
        isAnonymousSpectators: t.bool(),
        rosterVisibility: RosterVisibility,
        requireOwnership: t.bool(),
        costSetId: t.u32(),
        disconnectPolicy: DisconnectPolicy,
        disconnectForfeitSeconds: t.u32(),
        allowMirrorPicks: t.bool(),
        autoRandomPick: t.bool(),
        refereeCanUndo: t.bool(),
        refereeCanPause: t.bool(),
        refereeCanSetCaptain: t.bool(),
        refereeCanKick: t.bool(),
        allowPlayerPause: t.bool(),
        refereeExclusiveConcede: t.bool(),
        teamBlueAlias: t.string(),
        teamRedAlias: t.string(),
        isPublic: t.bool(),
        password: t.string(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);
        const lobbyId = args.lobbyId;

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // D-21: only host, moderator, or admin can update settings
        ensureHostOrAbove(ctx, lobby, user);

        // D-28: settings locked once Drafting begins
        ensureStageIs(lobby, 'Waiting');

        // D-65: tournament-controlled lobbies lock integrity fields,
        // but allow referee/match QoL fields to change
        const isTournamentLocked = lobby.isTournamentControlled;

        // D-23: guests forced to Casual + ClosedNoRating
        let matchType = isTournamentLocked ? lobby.matchType : args.matchType;
        let rosterVisibility = isTournamentLocked ? lobby.rosterVisibility : args.rosterVisibility;
        if (!isTournamentLocked && user.isGuest) {
            matchType = { tag: 'Casual', value: {} } as any;
            rosterVisibility = { tag: 'ClosedNoRating', value: {} } as any;
        }

        // D-42: Ranked forces no mirror picks
        const allowMirrorPicks = isTournamentLocked
            ? lobby.allowMirrorPicks
            : (matchType.tag === 'Ranked' ? false : args.allowMirrorPicks);

        // Resolve disconnectForfeitSeconds — locked fields use lobby value
        const disconnectForfeitSeconds = isTournamentLocked
            ? lobby.disconnectForfeitSeconds
            : (args.disconnectForfeitSeconds > 0 ? args.disconnectForfeitSeconds : undefined);

        // Update Lobby row
        // Tournament-locked fields use existing lobby values (from tournament)
        // Free fields accept caller input
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            // ── Locked fields (tournament integrity) ──
            teamSize: isTournamentLocked ? lobby.teamSize : args.teamSize,
            gameMode: isTournamentLocked ? lobby.gameMode : args.gameMode,
            matchType,
            isAnonymousPlayers: isTournamentLocked ? lobby.isAnonymousPlayers : args.isAnonymousPlayers,
            isAnonymousSpectators: isTournamentLocked ? lobby.isAnonymousSpectators : args.isAnonymousSpectators,
            rosterVisibility,
            requireOwnership: isTournamentLocked ? lobby.requireOwnership : args.requireOwnership,
            costSetId: isTournamentLocked ? lobby.costSetId : args.costSetId,
            disconnectPolicy: isTournamentLocked ? lobby.disconnectPolicy : args.disconnectPolicy,
            disconnectForfeitSeconds,
            allowMirrorPicks,
            // ── Free fields (referee/match QoL) ──
            draftMode: args.draftMode,
            banMode: args.banMode,
            standardTurnSeconds: args.standardTurnSeconds,
            reserveBankSeconds: args.reserveBankSeconds,
            characterBudget: args.characterBudget,
            lightconeBudget: args.lightconeBudget,
            minimumBidRaise: args.minimumBidRaise,
            rosterDiffAdvantage: args.rosterDiffAdvantage,
            rosterThreshold: args.rosterThreshold,
            underThresholdAdvantage: args.underThresholdAdvantage,
            aboveThresholdPenalty: args.aboveThresholdPenalty,
            deathPenalty: args.deathPenalty,
            autoRandomPick: args.autoRandomPick,
            refereeCanUndo: args.refereeCanUndo,
            refereeCanPause: args.refereeCanPause,
            refereeCanSetCaptain: args.refereeCanSetCaptain,
            refereeCanKick: args.refereeCanKick,
            allowPlayerPause: args.allowPlayerPause,
            refereeExclusiveConcede: args.refereeExclusiveConcede,
            teamBlueAlias: args.teamBlueAlias,
            teamRedAlias: args.teamRedAlias,
            isPublic: args.isPublic,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        // Handle password change
        if (!args.isPublic && args.password.length > 0) {
            // Upsert LobbyPassword row
            const existing = ctx.db.LobbyPassword.lobbyId.find(lobbyId);
            if (existing) {
                ctx.db.LobbyPassword.lobbyId.delete(lobbyId);
                ctx.db.LobbyPassword.insert(updateWithAudit(ctx, existing, {
                    passwordHash: args.password,
                }, user.id));
            } else {
                ctx.db.LobbyPassword.insert(insertWithAudit(ctx, {
                    lobbyId,
                    passwordHash: args.password,
                }, user.id));
            }
        } else if (args.isPublic) {
            // Changed to public — remove password if exists
            const existing = ctx.db.LobbyPassword.lobbyId.find(lobbyId);
            if (existing) {
                ctx.db.LobbyPassword.lobbyId.delete(lobbyId);
            }
        }

        // Settings changed — reset all members' isConfirmed to false
        const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        for (const member of members) {
            if (member.isConfirmed) {
                ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, member.userId]);
                ctx.db.LobbyMember.insert(updateWithAudit(ctx, member, {
                    isConfirmed: false,
                }, user.id));
            }
        }

        console.log(`[LOBBY] Lobby #${lobbyId} settings updated by user #${user.id}`);
    }
);

// ─── set_team_slot ────────────────────────────────────────────────────────────
// Moves a member to a different team slot (Blue/Red/Spectator).
// Per D-27/D-28: free movement during Waiting. Moving resets isConfirmed for the mover.
// Self-move: any member can move themselves.
// Moving others: requires host/moderator/admin.

export const set_team_slot = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        targetUserId: t.u32(),
        lobbySlot: LobbySlot,
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);
        const lobbyId = args.lobbyId;
        const targetUserId = args.targetUserId;

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // D-28: free movement only during Waiting
        ensureStageIs(lobby, 'Waiting');

        // If moving someone else, require host or above
        if (targetUserId !== user.id) {
            ensureHostOrAbove(ctx, lobby, user);
        } else {
            // Self-move: user must be a member
            ensureLobbyMember(ctx, lobbyId, user.id);
        }

        // Find target member
        const targetMember = ensureLobbyMember(ctx, lobbyId, targetUserId);

        const newSlotTag = args.lobbySlot.tag;
        const newTeam = slotTeam(args.lobbySlot);
        const currentTeam = slotTeam(targetMember.lobbySlot);

        // Coach assignment requires host/referee (not self-assignable)
        if (slotIsCoach(args.lobbySlot) && !slotIsCoach(targetMember.lobbySlot)) {
            const callerMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])][0];
            const isHost = lobby.hostUserId === user.id;
            const isRef = callerMember && callerMember.isReferee === true;
            if (!isHost && !isRef) {
                throw new SenderError('Only the lobby host or referee can assign the coach role.');
            }
        }

        // Cap enforcement: check target slot capacity
        if (newTeam !== currentTeam || slotIsCoach(args.lobbySlot) !== slotIsCoach(targetMember.lobbySlot)) {
            const allMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
            const isCoach = slotIsCoach(args.lobbySlot);

            if (newTeam === 'Blue' || newTeam === 'Red') {
                const sameTeamMembers = allMembers.filter((m: any) => slotTeam(m.lobbySlot) === newTeam && m.userId !== targetUserId);
                if (isCoach) {
                    const coachCount = sameTeamMembers.filter((m: any) => slotIsCoach(m.lobbySlot)).length;
                    if (coachCount >= 1) {
                        throw new SenderError(`${newTeam} team already has a coach.`);
                    }
                } else {
                    const playerCount = sameTeamMembers.filter((m: any) => !slotIsCoach(m.lobbySlot)).length;
                    if (playerCount >= lobby.teamSize) {
                        throw new SenderError(`${newTeam} team is full (max ${lobby.teamSize} players).`);
                    }
                }
            } else if (newSlotTag === 'Spectator') {
                const spectatorCount = allMembers.filter((m: any) => slotIsSpectator(m.lobbySlot) && m.userId !== targetUserId).length;
                if (spectatorCount >= 12) {
                    throw new SenderError('Spectator slots are full (max 12).');
                }
            }
        }

        // Delete + reinsert with new lobbySlot and isConfirmed reset
        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, targetUserId]);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, targetMember, {
            lobbySlot: args.lobbySlot,
            isConfirmed: false,
        }, user.id));

        // Update lobby activity timestamp
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[LOBBY] User #${targetUserId} moved to ${args.lobbySlot.tag} in lobby #${lobbyId} by user #${user.id}`);
    }
);

// ─── confirm_ready ────────────────────────────────────────────────────────────
// Marks the calling player as confirmed/ready.
// Per D-29: can only confirm during Waiting stage.

export const confirm_ready = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);
        const lobbyId = args.lobbyId;

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // Can only confirm during Waiting
        ensureStageIs(lobby, 'Waiting');

        const member = ensureLobbyMember(ctx, lobbyId, user.id);

        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, user.id]);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, member, {
            isConfirmed: true,
        }, user.id));

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[LOBBY] User #${user.id} confirmed ready in lobby #${lobbyId}`);
    }
);

// ─── unconfirm_ready ──────────────────────────────────────────────────────────
// Removes the calling player's ready confirmation.
// Per D-28: unconfirm allowed during Waiting only.

export const unconfirm_ready = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);
        const lobbyId = args.lobbyId;

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // D-28: unconfirm blocked during the 3-second countdown after start_draft is called
        // If the stage is still Waiting, start_draft hasn't fired yet — stage check suffices.
        ensureStageIs(lobby, 'Waiting');

        const member = ensureLobbyMember(ctx, lobbyId, user.id);

        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, user.id]);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, member, {
            isConfirmed: false,
        }, user.id));

        console.log(`[LOBBY] User #${user.id} unconfirmed ready in lobby #${lobbyId}`);
    }
);

// ─── set_captain ──────────────────────────────────────────────────────────────
// Assigns the captain designation on a team member.
// Per D-30: host, referee (when refereeCanSetCaptain=true), or admin can assign captains.
// Target must be on a team (Blue or Red) and not a coach.
// Existing captain on same team is demoted.

export const set_captain = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        targetUserId: t.u32(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);
        const lobbyId = args.lobbyId;
        const targetUserId = args.targetUserId;

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // Permission: host OR (referee with refereeCanSetCaptain) OR admin
        const callerMember = ensureLobbyMember(ctx, lobbyId, user.id);
        const isHost = lobby.hostUserId === user.id;
        const isRefereeWithPower = callerMember.isReferee && lobby.refereeCanSetCaptain;
        const isAdmin = isRoleAtLeast(user.role, 'Admin');
        if (!isHost && !isRefereeWithPower && !isAdmin) {
            throw new SenderError('Only the host, an authorized referee, or an admin can assign captains.');
        }

        // Find target member
        const targetMember = ensureLobbyMember(ctx, lobbyId, targetUserId);

        // Target must be on a team (Blue or Red), not Spectator, and not a coach
        if (slotIsSpectator(targetMember.lobbySlot)) {
            throw new SenderError('Captain must be a team member (Blue or Red), not a spectator.');
        }
        if (slotIsCoach(targetMember.lobbySlot)) {
            throw new SenderError('A coach cannot be assigned as captain.');
        }

        const targetTeam = slotTeam(targetMember.lobbySlot);

        // Demote existing captain on the same team
        const allMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        for (const m of allMembers) {
            if (m.isCaptain && slotTeam(m.lobbySlot) === targetTeam && m.userId !== targetUserId) {
                ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, m.userId]);
                ctx.db.LobbyMember.insert(updateWithAudit(ctx, m, {
                    isCaptain: false,
                }, user.id));
            }
        }

        // Promote target to captain
        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, targetUserId]);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, targetMember, {
            isCaptain: true,
        }, user.id));

        console.log(`[LOBBY] User #${targetUserId} set as ${targetTeam} captain in lobby #${lobbyId} by user #${user.id}`);
    }
);
