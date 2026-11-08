import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { DraftMode, BanMode, GameMode, MatchType, RosterVisibility, DisconnectPolicy, LobbySlot, BanRestriction, LineupFormat, ShuffleMode } from '@module/types/enums';
import { getAuthenticatedUser, isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureLobbyMember, ensureHostOrAbove, ensureStageIs, slotTeam, slotIsCoach, slotIsSpectator, slotToTeamSide, resolveMaxSpectators } from '@module/helpers/lobby/lobbyHelpers';
import { normalizeLobbyName } from '@module/helpers/tournament/seriesSettings';
import { ensureCostSetCovers, ensureSelectableCostSet } from '@module/helpers/draft/costSetGuards';
import { ensureSeatAllowed } from '@module/helpers/tournament/tournamentLobbySides';

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
// Resets all members' isConfirmed to false on settings change (A38(4)).
// Backlog #9 (A33 tiering): lineupFormat joins the tournament lock list; banRestriction, hideMmr,
//   refereeExclusiveConcede, name and maxSpectators (A68(8)) are free-set fields, editable in tournament lobbies too.
//   The new arguments are optional: an omitted key keeps the lobby's current value.
//   A67(2): the series settings are gone (one game per lobby; the bracket match carries bestOf and the head start).
// Backlog #2 (R2, D-D6): a changed costSetId must be selectable; a change of costSetId, gameMode or draftMode
//   must leave the set covering gameMode × draftMode.

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
        // A21 (S3): handicap arguments are fixed-point hundredths (i32 / u32), matching the columns.
        rosterDiffAdvantage: t.i32(),
        rosterThreshold: t.u32(),
        underThresholdAdvantage: t.i32(),
        aboveThresholdPenalty: t.i32(),
        deathPenalty: t.i32(),
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
        // Free-set / integrity additions (optional: omitted = unchanged):
        lineupFormat: LineupFormat.optional(),
        banRestriction: BanRestriction.optional(),
        hideMmr: t.bool().optional(),
        name: t.string().optional(),
        maxSpectators: t.u8().optional(), // A68(8): 0-12, free set (tournament lobbies too); omitted = unchanged
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

        // Integrity set: locked in tournament lobbies (D-65 + A33: lineupFormat). Unlike the D-65 fields,
        // which silently keep the tournament's value, an explicit change of lineupFormat is rejected
        // (backlog #9 done-when); passing the current value is accepted.
        if (isTournamentLocked) {
            if (args.lineupFormat !== undefined && args.lineupFormat.tag !== lobby.lineupFormat.tag) {
                throw new SenderError('lineupFormat is set by the tournament and cannot be changed in a tournament lobby.');
            }
        }
        const gameMode = isTournamentLocked ? lobby.gameMode : args.gameMode;
        const costSetId = isTournamentLocked ? lobby.costSetId : args.costSetId;
        const lineupFormat = isTournamentLocked || args.lineupFormat === undefined ? lobby.lineupFormat : args.lineupFormat;
        // Free set
        const name = args.name === undefined ? lobby.name : normalizeLobbyName(args.name);

        // Backlog #2: cost-set guards on a change of set, game mode or draft mode
        if (costSetId !== lobby.costSetId) ensureSelectableCostSet(ctx, costSetId);
        if (costSetId !== lobby.costSetId || gameMode.tag !== lobby.gameMode.tag || args.draftMode.tag !== lobby.draftMode.tag) {
            ensureCostSetCovers(ctx, costSetId, gameMode.tag, args.draftMode.tag);
        }

        // Update Lobby row
        // Tournament-locked fields use existing lobby values (from tournament)
        // Free fields accept caller input
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            // ── Locked fields (tournament integrity) ──
            teamSize: isTournamentLocked ? lobby.teamSize : args.teamSize,
            gameMode,
            matchType,
            isAnonymousPlayers: isTournamentLocked ? lobby.isAnonymousPlayers : args.isAnonymousPlayers,
            isAnonymousSpectators: isTournamentLocked ? lobby.isAnonymousSpectators : args.isAnonymousSpectators,
            rosterVisibility,
            requireOwnership: isTournamentLocked ? lobby.requireOwnership : args.requireOwnership,
            costSetId,
            disconnectPolicy: isTournamentLocked ? lobby.disconnectPolicy : args.disconnectPolicy,
            disconnectForfeitSeconds,
            allowMirrorPicks,
            lineupFormat,
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
            banRestriction: args.banRestriction ?? lobby.banRestriction,
            hideMmr: args.hideMmr ?? lobby.hideMmr,
            maxSpectators: resolveMaxSpectators(args.maxSpectators, lobby.maxSpectators), // A68(8)
            name,
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

        // A35 / D.8.5 (S8d): in a tournament lobby the target may only take a slot of allowedSlotsFor (its team's
        // player / coach slots, Spectator always); casual lobbies allow every slot.
        ensureSeatAllowed(ctx, lobby, targetUserId, args.lobbySlot.tag);

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
            } else if (newSlotTag === 'Spectator' && (lobby.stage.tag !== 'Waiting' || lobby.isTournamentControlled)) {
                // A68(8): maxSpectators caps watchers, not seat candidates, as in join_lobby: a casual Waiting lobby's
                // Spectator slot holds seat candidates (D-27) and is not capped; live stages and tournament lobbies are.
                const spectatorCount = allMembers.filter((m: any) => slotIsSpectator(m.lobbySlot) && m.userId !== targetUserId).length;
                if (spectatorCount >= lobby.maxSpectators) {
                    throw new SenderError(`Spectator slots are full (max ${lobby.maxSpectators}).`);
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

// ─── shuffle_teams ────────────────────────────────────────────────────────────
// A45(3): the lobby room's Random Swap / Team Swap (lobbyroom.html #randomSwap / #teamSwap) as one reducer, so the
// client does not fire N set_team_slot calls (racy, N confirmation resets).
//   TeamSwap:   every Blue seat moves to Red and every Red seat to Blue (players and coaches); captains keep their
//               flag, since each captain stays with their own team.
//   RandomSwap: the non-coach Blue + Red players are shuffled with ctx.random (deterministic per transaction) and
//               dealt alternately Blue, Red, Blue, ... ; coaches and spectators stay; captain flags are cleared
//               (start_draft assigns one per team, D-30).
// Host or Moderator+ (ensureHostOrAbove); Waiting only; one confirmation reset for everyone (A38(4)).

export const shuffle_teams = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        mode: ShuffleMode,
    },
    (ctx, { lobbyId, mode }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }
        ensureHostOrAbove(ctx, lobby, user);
        ensureStageIs(lobby, 'Waiting');
        // A35 / A70(1) (S8d review): a shuffle would break the match's colour mapping the bracket credits by.
        if (lobby.isTournamentControlled) {
            throw new SenderError("Seats in a tournament lobby follow the bracket's sides (A35 / A70); shuffling is not available.");
        }

        const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        const newSlot = new Map<number, { tag: string }>();
        let clearCaptains = false;

        if (mode.tag === 'TeamSwap') {
            const swap: Record<string, string> = {
                BluePlayer: 'RedPlayer', RedPlayer: 'BluePlayer', BlueCoach: 'RedCoach', RedCoach: 'BlueCoach',
            };
            for (const m of members) {
                const target = swap[m.lobbySlot.tag];
                if (target) newSlot.set(m.userId, { tag: target });
            }
        } else {
            // Players only, in join order before the shuffle so the result depends on ctx.random alone.
            const players = members
                .filter((m: any) => slotTeam(m.lobbySlot) !== null && !slotIsCoach(m.lobbySlot))
                .sort((a: any, b: any) => a.joinSeq - b.joinSeq);
            const pool = ctx.random.shuffle(players.map((m: any) => m.userId));
            pool.forEach((userId: number, i: number) => {
                newSlot.set(userId, { tag: i % 2 === 0 ? 'BluePlayer' : 'RedPlayer' });
            });
            clearCaptains = true;
        }

        // One pass: new seats and the confirmation reset for every member.
        for (const m of members) {
            const slot = newSlot.get(m.userId);
            const changes: Record<string, unknown> = {};
            if (slot && slot.tag !== m.lobbySlot.tag) changes.lobbySlot = slot;
            if (m.isConfirmed) changes.isConfirmed = false;
            if (clearCaptains && m.isCaptain) changes.isCaptain = false;
            if (Object.keys(changes).length === 0) continue;
            ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, m.userId]);
            ctx.db.LobbyMember.insert(updateWithAudit(ctx, m, changes, user.id));
        }

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[LOBBY] Teams shuffled (${mode.tag}) in lobby #${lobbyId} by user #${user.id}`);
    }
);
