import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { DraftMode, BanMode, GameMode, MatchType, RosterVisibility, DisconnectPolicy } from '../types/enums';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import {
    ensureNotInLobby,
    ensureGuestRestrictions,
    ensureLobbyMember,
    ensureHostOrAbove,
    ensureNotBanned,
    ensureStageIs,
    canKickOrBan,
    generateJoinCode,
    slotTeam,
    slotIsCoach,
    slotIsSpectator,
} from '../helpers/lobbyHelpers';
import { hardDeleteLobby } from './lobbyGc';
import { transferCaptain, transferReferee, transferHost } from '../helpers/flagTransferHelpers';
import { resolveUserLabel } from '../helpers/userLabel';
import { isThirdPartyReferee } from '../helpers/disconnectHelpers';
import { performConcede } from './concede';

// ─── create_lobby ─────────────────────────────────────────────────────────────
// Creates a new lobby and inserts the creator as the host/referee.
// Per D-22: enforces one lobby per user.
// Per D-23: guests cannot create Ranked lobbies.
// Per D-24: host gets isReferee=true.
// Per D-27: host joins as Spectator initially.
// Per D-42: Ranked forces allowMirrorPicks=false.

export const create_lobby = spacetimedb.reducer(
    {
        joinCode: t.string(),
        presetId: t.u32(),
        teamSize: t.u8(),
        draftMode: DraftMode,
        banMode: BanMode,
        gameMode: GameMode,
        matchType: MatchType,
        isPublic: t.bool(),
        password: t.string(),
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
        teamBlueAlias: t.string(),
        teamRedAlias: t.string(),
        bestOf: t.u8(),                  // D-11: best-of-N series. 0 = sentinel for default (1).
        refereeControlsShelving: t.bool(), // D-06: when true + 3rd party referee present, only referee controls shelve/continue.
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);

        // Per D-31b: validate presetId when provided (> 0 sentinel)
        if (args.presetId > 0) {
            const preset = ctx.db.LobbyPreset.id.find(args.presetId);
            if (!preset) {
                throw new SenderError('Preset not found.');
            }
        }

        // D-22: one lobby at a time
        ensureNotInLobby(ctx, user.id);

        // Server-generated join code (Jackbox-style, 5 chars, deterministic hash)
        const joinCode = generateJoinCode(ctx, user.id);

        // D-23: guest restrictions
        ensureGuestRestrictions(user, args.matchType);

        // D-23: force ClosedNoRating for guests
        let rosterVisibility = args.rosterVisibility;
        if (user.isGuest) {
            rosterVisibility = { tag: 'ClosedNoRating', value: {} } as any;
        }

        // D-42: Ranked forces no mirror picks
        const allowMirrorPicks = args.matchType.tag === 'Ranked' ? false : args.allowMirrorPicks;

        // Resolve disconnectForfeitSeconds — 0 is sentinel for "not set"
        const disconnectForfeitSeconds = args.disconnectForfeitSeconds > 0
            ? args.disconnectForfeitSeconds
            : undefined;

        // Insert Lobby row
        const lobby = ctx.db.Lobby.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            joinCode,
            hostUserId: user.id,
            teamBlueAlias: args.teamBlueAlias,
            teamRedAlias: args.teamRedAlias,
            teamSize: args.teamSize,
            draftMode: args.draftMode,
            banMode: args.banMode,
            standardTurnSeconds: args.standardTurnSeconds,
            reserveBankSeconds: args.reserveBankSeconds,
            rosterDiffAdvantage: args.rosterDiffAdvantage,
            rosterThreshold: args.rosterThreshold,
            underThresholdAdvantage: args.underThresholdAdvantage,
            aboveThresholdPenalty: args.aboveThresholdPenalty,
            deathPenalty: args.deathPenalty,
            matchType: args.matchType,
            currentPlayerCount: 1,
            characterBudget: args.characterBudget,
            lightconeBudget: args.lightconeBudget,
            minimumBidRaise: args.minimumBidRaise,
            allowMirrorPicks,
            autoRandomPick: args.autoRandomPick,
            refereeCanUndo: args.refereeCanUndo,
            refereeCanPause: args.refereeCanPause,
            refereeCanSetCaptain: args.refereeCanSetCaptain,
            refereeCanKick: args.refereeCanKick,
            allowPlayerPause: args.allowPlayerPause,
            refereeExclusiveConcede: true,
            tournamentId: undefined,
            bracketMatchId: undefined,
            isTournamentControlled: false,
            isAnonymousPlayers: args.isAnonymousPlayers,
            isAnonymousSpectators: args.isAnonymousSpectators,
            rosterVisibility,
            requireOwnership: args.requireOwnership,
            costSetId: args.costSetId,
            isPublic: args.isPublic,
            disconnectPolicy: args.disconnectPolicy,
            disconnectForfeitSeconds,
            gameMode: args.gameMode,
            // D-11: bestOf 0 is sentinel for default (1)
            bestOf: args.bestOf > 0 ? args.bestOf : 1,
            // D-06: refereeControlsShelving default true per plan
            refereeControlsShelving: args.refereeControlsShelving,
            lastActivityAt: ctx.timestamp,
            stage: { tag: 'Waiting', value: {} },
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

        // D-02: store password for private lobbies
        if (!args.isPublic && args.password.length > 0) {
            ctx.db.LobbyPassword.insert(insertWithAudit(ctx, {
                lobbyId: lobby.id,
                passwordHash: args.password,
            }, user.id));
        }

        console.log(`[LOBBY] Lobby #${lobby.id} created by user #${user.id} (${args.joinCode})`);
    }
);

// ─── join_lobby ───────────────────────────────────────────────────────────────
// Joins an existing lobby by lobbyId or joinCode.
// Per D-03: accepts either lobbyId or joinCode.
// Per D-22: enforces one lobby at a time.
// Per D-23: guest restrictions.
// Per D-21: ban check.
// Per D-04: reconnect during Drafting, new spectators allowed.
// Per D-02: password check for private lobbies.
// Per D-27: join as Spectator.

export const join_lobby = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        joinCode: t.string(),
        password: t.string(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);

        // D-03: resolve lobby by lobbyId or joinCode
        let lobby: any;
        if (args.lobbyId > 0) {
            lobby = ctx.db.Lobby.id.find(args.lobbyId);
        } else if (args.joinCode.length > 0) {
            lobby = ctx.db.Lobby.joinCode.find(args.joinCode);
        }
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        const lobbyId = lobby.id;

        // D-22: one lobby at a time
        ensureNotInLobby(ctx, user.id);

        // D-23: guest restrictions
        ensureGuestRestrictions(user, lobby.matchType);

        // D-21: ban check
        ensureNotBanned(ctx, lobbyId, user.id);

        // D-04, D-37, D-38, D-39, D-40: stage-specific join logic with extended reconnect
        const existingMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])][0];
        if (existingMember) {
            const reconnectStages = ['Drafting', 'Equipping', 'Scoring', 'BetweenGames', 'Shelved', 'AwaitingResult'];
            if (!reconnectStages.includes(lobby.stage.tag)) {
                throw new SenderError('Cannot rejoin this lobby in its current stage.');
            }
            // Block reconnect if voluntarilyLeft (D-38)
            if (existingMember.voluntarilyLeft) {
                throw new SenderError('You voluntarily left this match and cannot rejoin.');
            }
            // Reconnect: set isOnline=true, clear disconnectedAt (D-39)
            // Compute pool decrement if disconnectedAt was set
            let newPool = existingMember.disconnectPoolRemainingMs;
            if (existingMember.disconnectedAt && lobby.disconnectPolicy.tag !== 'NoAction') {
                const diffMicros: bigint = BigInt(ctx.timestamp.microsSinceUnixEpoch) - BigInt(existingMember.disconnectedAt.microsSinceUnixEpoch);
                const elapsed = Number(diffMicros / BigInt(1000));
                newPool = Math.max(0, existingMember.disconnectPoolRemainingMs - elapsed);
            }
            ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, user.id]);
            ctx.db.LobbyMember.insert(updateWithAudit(ctx, existingMember, {
                isOnline: true,
                disconnectedAt: undefined,
                disconnectPoolRemainingMs: newPool,
            }, user.id));
            // Auto-resume if draft was auto-paused (D-11, D-39)
            if (lobby.stage.tag === 'Drafting') {
                const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
                if (session && session.timerState.isPaused) {
                    // Check if the last step was an auto-pause
                    const lastStep = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)]
                        .sort((a: any, b: any) => b.sequence - a.sequence)[0];
                    if (lastStep?.payload?.tag === 'Pause' && lastStep.payload.value?.isAutoPause) {
                        // Auto-resume
                        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                            timerState: {
                                ...session.timerState,
                                isPaused: false,
                                turnStartAt: ctx.timestamp,
                            },
                        }, user.id));
                    }
                }
            }
            // Update activity
            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, user.id));
            console.log(`[LOBBY] User #${user.id} reconnected to lobby #${lobbyId} (stage: ${lobby.stage.tag})`);
            return;
        }
        // New join: only allowed during Waiting or Drafting (as Spectator)
        if (lobby.stage.tag !== 'Waiting' && lobby.stage.tag !== 'Drafting') {
            throw new SenderError('Cannot join a lobby in stage: ' + lobby.stage.tag);
        }

        // D-02: password check for private lobbies
        if (!lobby.isPublic) {
            const passwordRow = ctx.db.LobbyPassword.lobbyId.find(lobbyId);
            if (!passwordRow || passwordRow.passwordHash !== args.password) {
                throw new SenderError('Incorrect lobby password.');
            }
        }

        // Cap enforcement: max 20 members total, max 12 spectators
        const allMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        if (allMembers.length >= 20) {
            throw new SenderError('Lobby is full (max 20 members).');
        }
        const spectatorCount = allMembers.filter((m: any) => m.lobbySlot.tag === 'Spectator').length;
        if (spectatorCount >= 12) {
            throw new SenderError('Spectator slots are full (max 12).');
        }

        // D-27: join as Spectator
        ctx.db.LobbyMember.insert(insertWithAudit(ctx, {
            lobbyId,
            userId: user.id,
            isOnline: true,
            lobbySlot: { tag: 'Spectator', value: {} } as any,
            isReferee: false,
            isConfirmed: false,
            isCaptain: false,
            voluntarilyLeft: false,
            disconnectedAt: undefined,
            disconnectPoolRemainingMs: 0,
        }, user.id));

        // D-04, D-09: Auto-create LobbyMemberAccount row with player's active account
        {
            const activeAcct = [...ctx.db.HsrAccount.user_id.filter(user.id)].find((a: any) => a.isActive);
            if (activeAcct) {
                if (lobby.isTournamentControlled && lobby.tournamentId) {
                    // Tournament path: validate against TournamentPlayerAccount
                    const tpaEntries = [...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([lobby.tournamentId, user.id])];
                    const lockedEntry = tpaEntries.find((e: any) => e.hsrAccountId === activeAcct.id);
                    if (lockedEntry) {
                        ctx.db.LobbyMemberAccount.insert({ lobbyId, userId: user.id, hsrAccountId: activeAcct.id });
                    } else if (tpaEntries.length > 0) {
                        // D-04: Fallback to first locked account
                        ctx.db.LobbyMemberAccount.insert({ lobbyId, userId: user.id, hsrAccountId: tpaEntries[0].hsrAccountId });
                    }
                    // If no TPA entries at all (stand-in not yet approved), skip — they'll select later
                } else {
                    // Non-tournament: use active account directly
                    ctx.db.LobbyMemberAccount.insert({ lobbyId, userId: user.id, hsrAccountId: activeAcct.id });
                }
            }

            // D-26: If this is a stand-in joining a tournament lobby, snapshot their accounts into TPA
            if (lobby.isTournamentControlled && lobby.tournamentId && lobby.bracketMatchId) {
                const standIn = [...ctx.db.TournamentStandIn.by_match_and_user.filter([lobby.bracketMatchId, user.id])][0];
                if (standIn) {
                    // Check if they already have TPA entries for this tournament
                    const existingTpa = [...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([lobby.tournamentId, user.id])];
                    if (existingTpa.length === 0) {
                        // Snapshot active accounts into TPA (same locking as registration)
                        const userAccounts = [...ctx.db.HsrAccount.user_id.filter(user.id)];
                        for (const acct of userAccounts) {
                            ctx.db.TournamentPlayerAccount.insert(insertWithAudit(ctx, {
                                tournamentId: lobby.tournamentId,
                                userId: user.id,
                                hsrAccountId: acct.id,
                            }, user.id));
                        }
                        // Now create LobbyMemberAccount for their active account (first locked)
                        if (activeAcct && userAccounts.length > 0) {
                            // Active account was just locked, create/update LMA row
                            const existingLma = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, user.id])];
                            if (existingLma.length === 0) {
                                ctx.db.LobbyMemberAccount.insert({ lobbyId, userId: user.id, hsrAccountId: activeAcct.id });
                            }
                        }
                    }
                }
            }
        }

        // Increment currentPlayerCount
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            currentPlayerCount: lobby.currentPlayerCount + 1,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        // D-11: system message
        ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            senderUserId: 0,
            senderType: { tag: 'System', value: {} } as any,
            content: user.displayName + ' joined the lobby.',
            metadata: undefined,
            anonymousLabel: undefined,
        }, user.id));

        console.log(`[LOBBY] User #${user.id} joined lobby #${lobbyId}`);
    }
);

// ─── leave_lobby ─────────────────────────────────────────────────────────────
// Removes the caller from a lobby, decrementing currentPlayerCount.
// If lobby empties in Waiting stage, auto-closes the lobby.

export const leave_lobby = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);
        const lobbyId = args.lobbyId;

        // Validate membership
        const member = ensureLobbyMember(ctx, lobbyId, user.id);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // D-29, D-30, D-31, D-32, D-33: Active match leave handling
        // D-10: BetweenGames treated as active (leaving between games triggers same logic)
        const activeStages = ['Drafting', 'Equipping', 'Scoring', 'BetweenGames'];
        if (activeStages.includes(lobby.stage.tag)) {
            // D-29: Spectators/Coaches get clean deletion even during active stages
            if (slotIsSpectator(member.lobbySlot) || slotIsCoach(member.lobbySlot)) {
                // D-29: Delete LobbyMemberAccount rows for departing member
                for (const lma of [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, user.id])]) {
                    ctx.db.LobbyMemberAccount.delete(lma);
                }
                ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, user.id]);
                ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                    currentPlayerCount: lobby.currentPlayerCount - 1,
                    lastActivityAt: ctx.timestamp,
                }, user.id));
                console.log(`[LOBBY] Spectator/Coach #${user.id} cleanly left active lobby #${lobbyId}`);
                return;
            }

            // D-31: Players — set voluntarilyLeft=true, keep row for finalization
            // D-29: Delete LobbyMemberAccount rows for departing player (ephemeral, no preservation)
            for (const lma of [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, user.id])]) {
                ctx.db.LobbyMemberAccount.delete(lma);
            }
            ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, user.id]);
            ctx.db.LobbyMember.insert(updateWithAudit(ctx, member, {
                voluntarilyLeft: true,
                isOnline: false,
            }, user.id));

            // Transfer flags (D-34, D-35, D-36)
            transferCaptain(ctx, lobbyId, user.id);
            transferReferee(ctx, lobbyId, user.id);
            transferHost(ctx, lobbyId, lobby, user.id);

            // Check if last player on team — auto-concede (D-31)
            // But NOT if refereeExclusiveConcede + 3rd party referee present (D-82)
            let autoConcedeFired = false;
            const teamMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)]
                .filter((m: any) => slotTeam(m.lobbySlot) === slotTeam(member.lobbySlot)
                    && !slotIsCoach(m.lobbySlot)
                    && !m.voluntarilyLeft
                    && m.userId !== user.id);
            if (teamMembers.length === 0) {
                const thirdPartyRef = isThirdPartyReferee(ctx, lobbyId);
                if (lobby.refereeExclusiveConcede && thirdPartyRef) {
                    // D-82: Blocked — referee decides
                    console.log(`[LOBBY] Last player on team left lobby #${lobbyId}, but referee exclusive concede active. Referee decides.`);
                } else {
                    // D-31: Auto-concede — conceding team = leaving player's team
                    const losingTeam = slotTeam(member.lobbySlot)!;
                    performConcede(ctx, lobby, losingTeam, user.id, { tag: 'VoluntaryLeave', value: {} });
                    autoConcedeFired = true;
                }
            }

            // D-11: system message
            ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                senderUserId: 0,
                senderType: { tag: 'System', value: {} } as any,
                content: user.displayName + ' left the match.',
                metadata: undefined,
                anonymousLabel: undefined,
            }, user.id));

            // Update activity (do NOT decrement currentPlayerCount — row is kept)
            // Skip if auto-concede fired — performConcede already updated the lobby
            // (spreading the stale `lobby` object here would overwrite AwaitingResult back to Drafting)
            if (!autoConcedeFired) {
                ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                    lastActivityAt: ctx.timestamp,
                }, user.id));
            }

            console.log(`[LOBBY] User #${user.id} voluntarily left active match in lobby #${lobbyId}`);
            return;
        }

        // Waiting/AwaitingResult/Finished: normal leave path
        // D-29: Delete LobbyMemberAccount rows for departing member
        for (const lma of [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, user.id])]) {
            ctx.db.LobbyMemberAccount.delete(lma);
        }
        // Remove from lobby
        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, user.id]);

        const newCount = lobby.currentPlayerCount > 0 ? lobby.currentPlayerCount - 1 : 0;

        // Auto-close empty Waiting lobby
        if (newCount === 0 && lobby.stage.tag === 'Waiting') {
            hardDeleteLobby(ctx, lobby.id);
            console.log(`[LOBBY] Lobby #${lobbyId} auto-closed after last member left`);
            return;
        }

        // D-19: Shelved lobby exemption — do NOT auto-close even if all members leave.
        // Players are expected to return. GC handles 72h TTL for casual Shelved lobbies.
        if (newCount === 0 && lobby.stage.tag === 'Shelved') {
            // Update count but do NOT delete
            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                currentPlayerCount: 0,
                lastActivityAt: ctx.timestamp,
            }, user.id));
            console.log(`[LOBBY] Shelved lobby #${lobbyId} now empty — preserved for player return`);
            return;
        }

        // Update player count and activity
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            currentPlayerCount: newCount,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        // D-11: system message
        ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            senderUserId: 0,
            senderType: { tag: 'System', value: {} } as any,
            content: user.displayName + ' left the lobby.',
            metadata: undefined,
            anonymousLabel: undefined,
        }, user.id));

        console.log(`[LOBBY] User #${user.id} left lobby #${lobbyId}`);
    }
);

// ─── close_lobby ─────────────────────────────────────────────────────────────
// Hard-deletes a lobby and all associated data.
// Per D-19: cascades ChatMessage, LobbyMember, LobbyBan, LobbyPassword,
//            LobbyCursorEvent, MatchSession, MatchSessionStep, Lobby.
// Per D-20: allowed only in Waiting or Finished stage.
// Permission: host, moderator, or admin (D-21).

export const close_lobby = spacetimedb.reducer(
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

        // D-21: permission check
        ensureHostOrAbove(ctx, lobby, user);

        // D-20: only Waiting or Finished
        ensureStageIs(lobby, 'Waiting', 'Finished');

        // D-19: hard delete cascade
        hardDeleteLobby(ctx, lobby.id);

        console.log(`[LOBBY] Lobby #${lobbyId} closed by user #${user.id}`);
    }
);

// ─── kick_member ──────────────────────────────────────────────────────────────
// Removes a member from a lobby without banning them.
// Permission: host, admin, moderator, or referee (if refereeCanKick=true).

export const kick_member = spacetimedb.reducer(
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

        // Get caller's LobbyMember row for permission check
        const callerMember = ensureLobbyMember(ctx, lobbyId, user.id);

        // Permission check
        if (!canKickOrBan(ctx, lobby, user, callerMember)) {
            throw new SenderError('Only the host, moderators, admins, or an authorized referee can kick members.');
        }

        // Cannot kick self
        if (targetUserId === user.id) {
            throw new SenderError('Cannot kick yourself.');
        }

        // Cannot kick the host
        if (targetUserId === lobby.hostUserId) {
            throw new SenderError('Cannot kick the host.');
        }

        // Validate target is a member
        const targetMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, targetUserId])][0];
        if (!targetMember) {
            throw new SenderError('Target user is not a member of this lobby.');
        }

        // Resolve target's display name for system message (D-12: falls back to DeletedUser archive)
        const { displayName: targetName } = resolveUserLabel(ctx, targetUserId);

        // Remove target from lobby
        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, targetUserId]);

        // Decrement currentPlayerCount
        const currentLobby = ctx.db.Lobby.id.find(lobbyId);
        if (currentLobby) {
            const newCount = currentLobby.currentPlayerCount > 0 ? currentLobby.currentPlayerCount - 1 : 0;
            ctx.db.Lobby.id.update(updateWithAudit(ctx, currentLobby, {
                currentPlayerCount: newCount,
                lastActivityAt: ctx.timestamp,
            }, user.id));
        }

        // D-11: system message
        ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            senderUserId: 0,
            senderType: { tag: 'System', value: {} } as any,
            content: targetName + ' was kicked from the lobby.',
            metadata: undefined,
            anonymousLabel: undefined,
        }, user.id));

        console.log(`[LOBBY] User #${targetUserId} was kicked from lobby #${lobbyId} by user #${user.id}`);
    }
);

// ─── ban_member ───────────────────────────────────────────────────────────────
// Bans a user from a lobby. Creates a LobbyBan row and removes current membership.
// Per D-21: banned users cannot rejoin.

export const ban_member = spacetimedb.reducer(
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

        // Get caller's LobbyMember row for permission check
        const callerMember = ensureLobbyMember(ctx, lobbyId, user.id);

        // Permission check
        if (!canKickOrBan(ctx, lobby, user, callerMember)) {
            throw new SenderError('Only the host, moderators, admins, or an authorized referee can ban members.');
        }

        // Cannot ban self
        if (targetUserId === user.id) {
            throw new SenderError('Cannot ban yourself.');
        }

        // Cannot ban the host
        if (targetUserId === lobby.hostUserId) {
            throw new SenderError('Cannot ban the host.');
        }

        // Resolve target's display name for system message (D-12: falls back to DeletedUser archive)
        const { displayName: targetName } = resolveUserLabel(ctx, targetUserId);

        // Insert ban record
        ctx.db.LobbyBan.insert(insertWithAudit(ctx, {
            lobbyId,
            bannedUserId: targetUserId,
            bannedByUserId: user.id,
        }, user.id));

        // Remove from lobby if currently a member
        const targetMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, targetUserId])][0];
        if (targetMember) {
            ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, targetUserId]);

            // Decrement currentPlayerCount
            const currentLobby = ctx.db.Lobby.id.find(lobbyId);
            if (currentLobby) {
                const newCount = currentLobby.currentPlayerCount > 0 ? currentLobby.currentPlayerCount - 1 : 0;
                ctx.db.Lobby.id.update(updateWithAudit(ctx, currentLobby, {
                    currentPlayerCount: newCount,
                    lastActivityAt: ctx.timestamp,
                }, user.id));
            }
        }

        // D-11: system message
        ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            senderUserId: 0,
            senderType: { tag: 'System', value: {} } as any,
            content: targetName + ' was banned from the lobby.',
            metadata: undefined,
            anonymousLabel: undefined,
        }, user.id));

        console.log(`[LOBBY] User #${targetUserId} was banned from lobby #${lobbyId} by user #${user.id}`);
    }
);

// ─── Internal helper ──────────────────────────────────────────────────────────
// Hard-delete consolidated in lobbyGc.ts → hardDeleteLobby(ctx, lobbyId).
// Used by close_lobby, leave_lobby (empty auto-close), and runFinalization.
