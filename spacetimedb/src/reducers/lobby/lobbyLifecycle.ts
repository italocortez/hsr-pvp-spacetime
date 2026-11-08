import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { DraftMode, BanMode, GameMode, MatchType, RosterVisibility, DisconnectPolicy, BanRestriction, LineupFormat } from '@module/types/enums';
import { getAuthenticatedUser, isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import {
    ensureNotInLobby,
    ensureGuestRestrictions,
    ensureLobbyMember,
    ensureHostOrAbove,
    ensureNotBanned,
    ensureStageIs,
    canKickOrBan,
    generateJoinCode,
    nextJoinSeq,
    slotIsCoach,
    slotIsSpectator,
    LIVE_STAGES,
    memberHasLeft,
    resolveMaxSpectators,
} from '@module/helpers/lobby/lobbyHelpers';
import { hardDeleteLobby } from './lobbyGc';
import { removeMemberRow } from '@module/helpers/lobby/memberRemoval';
import { resolveUserLabel } from '@module/helpers/identity/userLabel';
import { markMemberOffline } from '@module/helpers/lobby/disconnectHelpers';
import { consumeLobbyCreateAllowance, readAbuseConfig, recordGuestLobbyCreation } from '@module/helpers/lobby/abuseControls';
import { normalizeLobbyName } from '@module/helpers/tournament/seriesSettings';
import { ensureCostSetUsable } from '@module/helpers/draft/costSetGuards';
import { lobbySteps } from '@module/helpers/draft/stepSequence';
import { autoSeatSlot } from '@module/helpers/tournament/tournamentLobbySides';

// ─── create_lobby ─────────────────────────────────────────────────────────────
// Creates a new lobby and inserts the creator as the host/referee.
// Per D-22 / A68(4): enforces one lobby per user; an away membership is given up with abandonCurrentMatch.
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
        teamBlueAlias: t.string(),
        teamRedAlias: t.string(),
        // A67(2): the series arguments are removed (one game per lobby).
        // A45 / D-A8 / A21 / A40 arguments. Optional so an omitted key takes the documented default:
        name: t.string().optional(),                   // D-A8: 0-50 chars after trim; default '' (S9's view_lobby_browser labels it)
        banRestriction: BanRestriction.optional(),     // A45(2): default NoRestriction
        lineupFormat: LineupFormat.optional(),         // A21: default Halves
        hideMmr: t.bool().optional(),                  // A40 mitigation (2): default false
        refereeExclusiveConcede: t.bool().optional(),  // A45(5): default true
        maxSpectators: t.u8().optional(),              // A68(8): 0-12, default 12
        abandonCurrentMatch: t.bool().optional(),      // A68(4): give up an away membership; default false
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

        // D-22 / A68(4): one lobby at a time
        ensureNotInLobby(ctx, user.id, args.abandonCurrentMatch ?? false);

        // A68(8): spectator count
        const maxSpectators = resolveMaxSpectators(args.maxSpectators, 12);

        // Server-generated join code (Jackbox-style, 5 chars, deterministic hash)
        const joinCode = generateJoinCode(ctx, user.id);

        // D-23: guest restrictions
        ensureGuestRestrictions(user, args.matchType);

        // A42(1) kill switch: guests cannot create while AbuseConfig.guestLobbyCreationEnabled is off;
        // guests already in lobbies are unaffected (join_lobby has no such check).
        if (user.isGuest && !readAbuseConfig(ctx).guestLobbyCreationEnabled) {
            throw new SenderError('Guest lobby creation is temporarily disabled');
        }

        // A57 / A58: inline circuit breaker. Counts this guest creation; the creation that crosses the threshold
        // still succeeds and turns the switch off in this transaction (a later throw rolls the count back too).
        if (user.isGuest) recordGuestLobbyCreation(ctx);

        // B-7 (D-B5, A43): AbuseConfig.lobbyCreatesPerHour per user (guests included), UserRateState window.
        consumeLobbyCreateAllowance(ctx, user.id);

        // D-23: force ClosedNoRating for guests
        let rosterVisibility = args.rosterVisibility;
        if (user.isGuest) {
            rosterVisibility = { tag: 'ClosedNoRating', value: {} } as any;
        }

        // D-42: Ranked forces no mirror picks
        const allowMirrorPicks = args.matchType.tag === 'Ranked' ? false : args.allowMirrorPicks;

        // D-A8 name.
        const name = normalizeLobbyName(args.name);

        // Backlog #2 (R2, D-D6): the cost set must be selectable and cover gameMode × draftMode.
        ensureCostSetUsable(ctx, args.costSetId, args.gameMode.tag, args.draftMode.tag);

        // Resolve disconnectForfeitSeconds — 0 is sentinel for "not set"
        const disconnectForfeitSeconds = args.disconnectForfeitSeconds > 0
            ? args.disconnectForfeitSeconds
            : undefined;

        // Insert Lobby row
        const lobby = ctx.db.Lobby.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            joinCode,
            name,
            hostUserId: user.id,
            teamBlueAlias: args.teamBlueAlias,
            teamRedAlias: args.teamRedAlias,
            teamSize: args.teamSize,
            draftMode: args.draftMode,
            banMode: args.banMode,
            banRestriction: args.banRestriction ?? { tag: 'NoRestriction' },
            lineupFormat: args.lineupFormat ?? { tag: 'Halves' },
            standardTurnSeconds: args.standardTurnSeconds,
            reserveBankSeconds: args.reserveBankSeconds,
            rosterDiffAdvantage: args.rosterDiffAdvantage,
            rosterThreshold: args.rosterThreshold,
            underThresholdAdvantage: args.underThresholdAdvantage,
            aboveThresholdPenalty: args.aboveThresholdPenalty,
            deathPenalty: args.deathPenalty,
            matchType: args.matchType,
            currentPlayerCount: 1,
            maxSpectators,
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
            refereeExclusiveConcede: args.refereeExclusiveConcede ?? true,
            tournamentId: undefined,
            bracketMatchId: undefined,
            isTournamentControlled: false,
            isAnonymousPlayers: args.isAnonymousPlayers,
            isAnonymousSpectators: args.isAnonymousSpectators,
            hideMmr: args.hideMmr ?? false,
            rosterVisibility,
            requireOwnership: args.requireOwnership,
            costSetId: args.costSetId,
            isPublic: args.isPublic,
            disconnectPolicy: args.disconnectPolicy,
            disconnectForfeitSeconds,
            gameMode: args.gameMode,
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
            leftAt: undefined,
            abandonedAt: undefined,
            disconnectedAt: undefined,
            disconnectPoolRemainingMs: 0,
            joinSeq: nextJoinSeq(ctx, lobby.id), // R4: per-lobby join counter; A22(5) order and the S9 labels derive from it
            lastCursorAt: undefined,
            lastLineupAt: undefined,
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
// Per D-22 / A68(4): enforces one lobby at a time (new joins; abandonCurrentMatch gives up an away membership).
// Per D-23: guest restrictions.
// Per D-21: ban check.
// Per D-04 / A68(8): reconnect in every stage; new joins in Waiting and, as Spectator, in Drafting / Equipping /
// Scoring, up to lobby.maxSpectators.
// Per A68(1)(2)(4): an away member returns through the reconnect branch; an abandoned one cannot.
// Per D-02: password check for private lobbies.
// Per D-27: join as Spectator.

export const join_lobby = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        joinCode: t.string(),
        password: t.string(),
        abandonCurrentMatch: t.bool().optional(), // A68(4): new joins only; the reconnect branch ignores it
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

        // F1: the reconnect branch runs BEFORE ensureNotInLobby, which counts the row of the lobby being
        // rejoined and would reject every reconnect. The guest and ban checks are not needed for an existing
        // member: they passed them at join time, and ban_member deletes the membership row.
        // D-04, D-37, D-39, D-40: stage-specific join logic with extended reconnect (A68(1): D-38's rejoin ban is gone)
        const existingMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])][0];
        if (existingMember) {
            // F1: Waiting included — a refresh in the waiting room is a reconnect too.
            const reconnectStages = ['Waiting', 'Drafting', 'Equipping', 'Scoring', 'AwaitingResult']; // A67(1)
            if (!reconnectStages.includes(lobby.stage.tag)) {
                throw new SenderError('Cannot rejoin this lobby in its current stage.');
            }
            // A68(4): an abandoned row (the player took another lobby) never returns.
            if (existingMember.abandonedAt !== undefined) {
                throw new SenderError('You left this match for another lobby and cannot return.');
            }
            // A68(1)(2): an away row (leftAt) returns here, the only path that clears leftAt.
            const isReturn = existingMember.leftAt !== undefined;
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
                leftAt: undefined,
                disconnectedAt: undefined,
                disconnectPoolRemainingMs: newPool,
            }, user.id));
            if (isReturn) {
                ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
                    id: 0,
                    lobbyId,
                    senderUserId: 0,
                    senderType: { tag: 'System', value: {} } as any,
                    content: user.displayName + ' is back.',
                    metadata: undefined,
                    anonymousLabel: undefined,
                }, user.id));
            }
            // Auto-resume if draft was auto-paused (D-11, D-39)
            if (lobby.stage.tag === 'Drafting') {
                const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
                if (session && session.timerState.isPaused) {
                    // Check if the latest Pause step was an auto-pause (S7b hand-off: a SetEidolon or other step
                    // logged after the pause no longer hides it)
                    const lastStep = lobbySteps(ctx, lobbyId)
                        .filter((s: any) => s.payload?.tag === 'Pause')
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

        // D-22 / A68(4): one lobby at a time (genuinely new joins only, F1)
        ensureNotInLobby(ctx, user.id, args.abandonCurrentMatch ?? false);

        // D-23: guest restrictions
        ensureGuestRestrictions(user, lobby.matchType);

        // D-21: ban check
        ensureNotBanned(ctx, lobbyId, user.id);

        // D-04 extended (A68(8)): new joins in Waiting and, as Spectator, in the live stages; AwaitingResult stays closed
        if (lobby.stage.tag !== 'Waiting' && !LIVE_STAGES.includes(lobby.stage.tag)) {
            throw new SenderError('Cannot join a lobby in stage: ' + lobby.stage.tag);
        }

        // D-02: password check for private lobbies
        if (!lobby.isPublic) {
            const passwordRow = ctx.db.LobbyPassword.lobbyId.find(lobbyId);
            if (!passwordRow || passwordRow.passwordHash !== args.password) {
                throw new SenderError('Incorrect lobby password.');
            }
        }

        // Cap enforcement: max 20 members total; new Spectator joins capped by lobby.maxSpectators (A68(8))
        const allMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        if (allMembers.length >= 20) {
            throw new SenderError('Lobby is full (max 20 members).');
        }
        // A26 / A35 (S8d): in a tournament lobby in Waiting a member of either team (or an approved stand-in) is
        // auto-seated on its team's first free player seat; everyone else, staff included, joins as Spectator.
        // join_lobby takes no slot argument; set_team_slot enforces allowedSlotsFor for every later move.
        const joinSlot = lobby.stage.tag === 'Waiting' ? autoSeatSlot(ctx, lobby, user.id) : 'Spectator';
        // A68(8): maxSpectators caps watchers, not seat candidates. A join that can only be watching is counted: every
        // live-stage join, and a Waiting join of a tournament lobby that auto-seated to Spectator. A casual Waiting
        // joiner lands on Spectator as a seat candidate (D-27) and is not counted (the 20-member cap still applies).
        const joinOnlyWatches = joinSlot === 'Spectator' && (lobby.stage.tag !== 'Waiting' || lobby.isTournamentControlled);
        const spectatorCount = allMembers.filter((m: any) => m.lobbySlot.tag === 'Spectator').length;
        if (joinOnlyWatches && spectatorCount >= lobby.maxSpectators) {
            throw new SenderError(`Spectator slots are full (max ${lobby.maxSpectators}).`);
        }

        // D-27: join as Spectator (casual lobbies; tournament lobbies: the auto-seat above)
        ctx.db.LobbyMember.insert(insertWithAudit(ctx, {
            lobbyId,
            userId: user.id,
            isOnline: true,
            lobbySlot: { tag: joinSlot, value: {} } as any,
            isReferee: false,
            isConfirmed: false,
            isCaptain: false,
            leftAt: undefined,
            abandonedAt: undefined,
            disconnectedAt: undefined,
            disconnectPoolRemainingMs: 0,
            joinSeq: nextJoinSeq(ctx, lobby.id), // R4: per-lobby join counter; A22(5) order and the S9 labels derive from it
            lastCursorAt: undefined,
            lastLineupAt: undefined,
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
// A68(1): a player's Leave in Drafting / Equipping / Scoring is a disconnect (markMemberOffline, as
// client_disconnected): isOnline = false, disconnectedAt under Standard / Deferred, the 15 s RefereeTransferCheck, plus
// leftAt (A68(2), away). The row, its LobbyMemberAccount rows and currentPlayerCount are kept; the player may return
// through join_lobby. No automatic concede (A68(3), D-31 / D-82 branch removed); the flags move only through the 15 s
// check (A68(7)).
// A68(5)(7): every other Leave (a player in Waiting / AwaitingResult, a spectator or coach in any stage) deletes the
// row through removeMemberRow (flags transferred). An empty Waiting lobby is hard-deleted.

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

        const isLiveStage = LIVE_STAGES.includes(lobby.stage.tag);
        const isPlayer = !slotIsSpectator(member.lobbySlot) && !slotIsCoach(member.lobbySlot);

        if (isLiveStage && isPlayer) {
            // A68(2): already away (or abandoned): a second Leave changes nothing, so the clock keeps its first stamp.
            if (memberHasLeft(member)) return;

            markMemberOffline(ctx, lobby, member, user.id, { leftAt: ctx.timestamp });

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
            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, user.id));

            console.log(`[LOBBY] User #${user.id} left the live match in lobby #${lobbyId} (away, A68(1))`);
            return;
        }

        if (!removeMemberRow(ctx, lobbyId, user.id, user.id)) return; // empty Waiting lobby deleted

        // D-11: system message (a spectator's or coach's leave during the match stays silent, as before)
        if (!isLiveStage) {
            ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                senderUserId: 0,
                senderType: { tag: 'System', value: {} } as any,
                content: user.displayName + ' left the lobby.',
                metadata: undefined,
                anonymousLabel: undefined,
            }, user.id));
        }

        console.log(`[LOBBY] User #${user.id} left lobby #${lobbyId}`);
    }
);

// ─── close_lobby ─────────────────────────────────────────────────────────────
// Hard-deletes a lobby and all associated data.
// Per D-19: cascades ChatMessage, LobbyMember, LobbyBan, LobbyPassword,
//            LobbyCursorEvent, MatchSession, MatchSessionStep, Lobby.
// Per D-20: allowed only in Waiting stage (A67(1)).
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

        // D-20: only Waiting (A67(1))
        ensureStageIs(lobby, 'Waiting');

        // D-19: hard delete cascade
        hardDeleteLobby(ctx, lobby.id);

        console.log(`[LOBBY] Lobby #${lobbyId} closed by user #${user.id}`);
    }
);

// A68(6): once the draft has started (Drafting / Equipping / Scoring) players are never removed; only spectators
// and coaches may be kicked or banned. Waiting and AwaitingResult: any member (the host excepted).
function ensureRemovableMember(lobby: any, targetMember: any): void {
    if (!targetMember || !LIVE_STAGES.includes(lobby.stage.tag)) return;
    if (!slotIsSpectator(targetMember.lobbySlot) && !slotIsCoach(targetMember.lobbySlot)) {
        throw new SenderError('Players cannot be removed once the draft has started; the match ends by result, concede or forfeit.');
    }
}

// ─── kick_member ──────────────────────────────────────────────────────────────
// Removes a member from a lobby without banning them.
// Permission: host, admin, moderator, or referee (if refereeCanKick=true).
// A68(6)(7): stage rule above; the row and its LobbyMemberAccount rows are deleted and the flags transferred
// (removeMemberRow).

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

        // A68(6): no player removal after the draft starts
        ensureRemovableMember(lobby, targetMember);

        // Resolve target's display name for system message (D-12: falls back to DeletedUser archive)
        const { displayName: targetName } = resolveUserLabel(ctx, targetUserId);

        // Remove target from lobby (A68(7): flags transferred; LobbyMemberAccount rows deleted; count decremented)
        removeMemberRow(ctx, lobbyId, targetUserId, user.id);

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
// A68(6)(7): a member target follows kick_member's stage rule and removal (removeMemberRow).

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

        // A68(6): no player removal after the draft starts
        const targetMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, targetUserId])][0];
        ensureRemovableMember(lobby, targetMember);

        // Resolve target's display name for system message (D-12: falls back to DeletedUser archive)
        const { displayName: targetName } = resolveUserLabel(ctx, targetUserId);

        // Insert ban record
        ctx.db.LobbyBan.insert(insertWithAudit(ctx, {
            lobbyId,
            bannedUserId: targetUserId,
            bannedByUserId: user.id,
        }, user.id));

        // Remove from lobby if currently a member (A68(7): flags transferred; LobbyMemberAccount rows deleted)
        if (targetMember) {
            removeMemberRow(ctx, lobbyId, targetUserId, user.id);
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

// ─── unban_member ─────────────────────────────────────────────────────────────
// A45(3): lifts a lobby ban (deletes the LobbyBan row) so the user can rejoin. Allowed for the host, a referee
// while lobby.refereeCanKick is on (the same power that lets a referee ban, D-32), or Moderator+ (who need not be
// a member). Any stage. The admin In-Cell Edit exposes the same reducer.

export const unban_member = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        userId: t.u32(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);
        const lobbyId = args.lobbyId;

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        const callerMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])][0];
        const allowed = lobby.hostUserId === user.id
            || isRoleAtLeast(user.role, 'Moderator')
            || (callerMember !== undefined && callerMember.isReferee && lobby.refereeCanKick);
        if (!allowed) {
            throw new SenderError('Only the host, moderators, admins, or an authorized referee can lift a lobby ban.');
        }

        const ban = [...ctx.db.LobbyBan.by_lobby_and_user.filter([lobbyId, args.userId])][0];
        if (!ban) {
            throw new SenderError('This user is not banned from the lobby.');
        }
        ctx.db.LobbyBan.by_lobby_and_user.delete([lobbyId, args.userId]);

        console.log(`[LOBBY] User #${args.userId} unbanned from lobby #${lobbyId} by user #${user.id}`);
    }
);
