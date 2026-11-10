import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { anySeatedPlayerAway, ensureLobbyMember, ensureRefereeOrAbove, ensureStageIs, slotTeam, slotIsCoach, slotToTeamSide } from '@module/helpers/lobby/lobbyHelpers';
import { resolveOwnedEidolon, validateCharacterOwnership } from '@module/helpers/draft/ownershipValidation';
import { buildAuctionBanSequence, buildClassicSequence } from '@module/helpers/draft/draftSequences';
import { computeLobbyMemberRating } from '@module/helpers/stats/accountRating';
import { banRestrictionError, isBanLegal } from '@module/helpers/lobby/banRestriction';
import { ensureMatchAlive, scheduleChecksForOfflineStaff } from '@module/helpers/lobby/disconnectHelpers';
import { lobbySteps, getNextSequence } from '@module/helpers/draft/stepSequence';
import { turnRemainingMs } from '@module/helpers/draft/turnClock';
import { classicCostAt } from '@module/helpers/draft/costSetGuards';
import { trimChatForInsert } from '@module/helpers/lobby/chatWindow';

/**
 * A87: the picked characters a team may not pick again. Without allowMirrorPicks every pick of either team; with it,
 * only the team's own picks (the other team's picks stay available, but no team picks the same character twice).
 * The team of a Pick step is its actorSlot (Blue / Red on the manual and the timer path alike).
 * EMPTY is the no-pick placeholder, not a character: it never blocks, mirror on or off, so a team may hold any number
 * of EMPTY picks (manual or by timer).
 */
function picksBlockingTeam(steps: any[], lobby: any, team: string): Set<string> {
    const names = new Set<string>();
    for (const s of steps) {
        if (s.action.tag !== 'Pick' || s.payload.tag !== 'Pick') continue;
        if (s.payload.value.characterName === 'EMPTY') continue;
        if (lobby.allowMirrorPicks && s.actorSlot.tag !== team) continue;
        names.add(s.payload.value.characterName);
    }
    return names;
}

/** The Classic cost of a pick at an eidolon level (0 for EMPTY or no row; classicCostAt, 15.4 D-01 unified costs). */
function classicPickCost(ctx: any, lobby: any, characterName: string, eidolon: number): number {
    if (characterName === 'EMPTY') return 0;
    return classicCostAt(ctx, lobby, characterName, eidolon);
}

// ─── start_draft ──────────────────────────────────────────────────────────────
// Initializes the draft for a lobby.
// Per D-29: All Blue+Red non-coach players must be confirmed before starting.
// Per D-30: Assigns captains to first non-coach player per team if none set.
// Per D-43b: If autoRandomPick=true, validates all players have characters.
// Creates MatchSession, MatchResultRecord, MatchResultParticipant rows.
// Transitions lobby stage to Drafting.

export const start_draft = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // A80: only the referee (flag holder) or a moderator/admin can start
        ensureRefereeOrAbove(ctx, lobby, user);

        // Must be in Waiting stage
        ensureStageIs(lobby, 'Waiting');

        // Gather all Blue+Red members
        const allMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        const teamMembers = allMembers.filter(
            (m: any) => slotTeam(m.lobbySlot) !== null
        );
        const playersOnly = teamMembers.filter((m: any) => !slotIsCoach(m.lobbySlot));

        // D-29: All non-coach Blue+Red players must be confirmed
        const unconfirmed = playersOnly.filter((m: any) => !m.isConfirmed);
        if (unconfirmed.length > 0) {
            throw new SenderError('All Blue and Red players must be confirmed before starting.');
        }

        // A92(1): no start while a seated player (not a coach) is offline or away (the A85(1) presence test); a player
        // offline since Waiting would otherwise carry no disconnect stamp and could never be forfeited (policy review G1).
        // Residual (S10d review F3, kept as is): this gate counts a row with isOnline = false as present when its user
        // has a live presence on another identity; such a row passes, loses its stamp below and enters Drafting offline
        // and unstamped until its next real disconnect (the room page calls join_lobby on load, which closes it).
        if (anySeatedPlayerAway(ctx, lobbyId)) {
            throw new SenderError('All Blue and Red players must be online before starting.');
        }

        // Validate team composition: at least 1 non-coach player per team
        const bluePlayers = playersOnly.filter((m: any) => slotTeam(m.lobbySlot) === 'Blue');
        const redPlayers = playersOnly.filter((m: any) => slotTeam(m.lobbySlot) === 'Red');
        if (bluePlayers.length === 0) {
            throw new SenderError('Blue team must have at least one non-coach player.');
        }
        if (redPlayers.length === 0) {
            throw new SenderError('Red team must have at least one non-coach player.');
        }
        // S10e (lobby audit #10): update_lobby_settings may have lowered teamSize under the seated count.
        for (const [team, players] of [['Blue', bluePlayers], ['Red', redPlayers]] as const) {
            if (players.length > lobby.teamSize) {
                throw new SenderError(`${team} team has ${players.length} players; the team size is ${lobby.teamSize}.`);
            }
        }

        // D-08: Ranked/MMR-tournament gate — all players must have at least one LobbyMemberAccount row
        const needsAccountEnforcement = lobby.matchType.tag === 'Ranked' ||
            (lobby.isTournamentControlled && lobby.tournamentId &&
             (() => { const t = ctx.db.Tournament.id.find(lobby.tournamentId); return t?.countTowardsMmr; })());

        if (needsAccountEnforcement) {
            for (const member of playersOnly) {
                const accountRows = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, member.userId])];
                if (accountRows.length === 0) {
                    throw new SenderError(
                        `The player at seat ${member.joinSeq} has no account selected for this match. All players must select an account before starting a ranked or MMR-counted match.`
                    );
                }
            }
        }

        // D-43b: If autoRandomPick=true, validate ALL Blue+Red players have characters (D-12: check selected accounts)
        if (lobby.autoRandomPick) {
            for (const member of playersOnly) {
                const selectedAccounts = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, member.userId])];
                if (selectedAccounts.length === 0) {
                    throw new SenderError(
                        `The player at seat ${member.joinSeq} has no account selected. autoRandomPick requires all players to have characters.`
                    );
                }
                // D-12: Check union of characters across all selected accounts
                let totalChars = 0;
                for (const lma of selectedAccounts) {
                    const chars = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(lma.hsrAccountId)];
                    totalChars += chars.length;
                }
                if (totalChars === 0) {
                    throw new SenderError(
                        `The player at seat ${member.joinSeq} has no characters on their selected account(s). autoRandomPick requires all players to have characters.`
                    );
                }
            }
        }

        // D-30: Assign captains — for each team, if no player has isCaptain=true,
        // set the first non-coach player on that team as captain.
        const blueHasCaptain = bluePlayers.some((m: any) => m.isCaptain);
        if (!blueHasCaptain && bluePlayers.length > 0) {
            const first = bluePlayers[0];
            ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, first.userId]);
            ctx.db.LobbyMember.insert(updateWithAudit(ctx, first, { isCaptain: true }, user.id));
        }

        const redHasCaptain = redPlayers.some((m: any) => m.isCaptain);
        if (!redHasCaptain && redPlayers.length > 0) {
            const first = redPlayers[0];
            ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, first.userId]);
            ctx.db.LobbyMember.insert(updateWithAudit(ctx, first, { isCaptain: true }, user.id));
        }

        // Create MatchSession: the draft sequence (Classic picks + bans, or the Auction ban-only prefix, D-48), timer,
        // auction state, budgets and pause counters. A67(3): one session per lobby, created once (the S6 per-game
        // initializer is folded in here; no series columns, no A27 head-start seeding: the head start lives on the
        // bracket match).
        const sequence = lobby.draftMode.tag === 'Classic'
            ? buildClassicSequence(lobby.banMode.tag, lobby.lineupFormat.tag) // A21: Thirds = 12 picks per team
            : buildAuctionBanSequence(lobby.banMode.tag); // bans only; the Auction count is isAuctionComplete's (draftAuction.ts)
        ctx.db.MatchSession.insert(insertWithAudit(ctx, {
            lobbyId: lobby.id,
            turnIndex: 0,
            draftSequence: sequence,
            timerState: {
                turnStartAt: ctx.timestamp,
                teamBlueReserveMs: lobby.reserveBankSeconds * 1000,
                teamRedReserveMs: lobby.reserveBankSeconds * 1000,
                isPaused: false,
                accumulatedPauseMs: 0,
            },
            // Auction with no bans opens the auction phase immediately (D-48).
            isAuctionPhase: lobby.draftMode.tag === 'Auction' && sequence.length === 0,
            nextNominatorTeam: { tag: 'Blue' },
            blueCharactersWon: 0,
            redCharactersWon: 0,
            currentNomination: undefined,
            currentBidAmount: undefined,
            currentBidTeam: { tag: 'Spectator' },
            teamBlueCharBudget: lobby.characterBudget,
            teamRedCharBudget: lobby.characterBudget,
            teamBlueLcBudget: lobby.lightconeBudget,
            teamRedLcBudget: lobby.lightconeBudget,
            pausesUsedBlue: 0,
            pausesUsedRed: 0,
        } as any, user.id));

        // S9a (user 2026-11-07): no referee full-control snapshot on the record; since A63 no reducer reads it, the live seat decides.
        // Find referee userId (optional)
        const refereeRow = allMembers.find((m: any) => m.isReferee);
        const refereeUserId = refereeRow ? refereeRow.userId : undefined;

        // Create MatchResultRecord
        const matchResultRow = ctx.db.MatchResultRecord.insert(insertWithAudit(ctx, {
            id: 0,
            bracketMatchId: lobby.bracketMatchId ?? undefined,
            lobbyId,
            isTournamentControlled: lobby.isTournamentControlled,
            status: { tag: 'Pending', value: {} } as any,
            winnerTeamSide: undefined,
            mmrProcessedAt: undefined,
            refereeUserId,
            disputedByUserId: undefined,
            disputeReason: undefined,
            matchType: lobby.matchType,
            matchEndReason: undefined,
            concedeTrigger: undefined,
            concedeSummary: undefined,
            concedeAtStage: undefined,
            winnerOverride: undefined,
            winnerOverrideById: undefined,
            winnerOverrideReason: undefined,
            settledAt: undefined,
        }, user.id));

        // Create MatchResultParticipant rows for each Blue+Red non-coach member
        // Re-read members to get updated isCaptain values
        const updatedMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        const participantMembers = updatedMembers.filter(
            (m: any) => !slotIsCoach(m.lobbySlot) && slotTeam(m.lobbySlot) !== null
        );
        for (const member of participantMembers) {
            // Backlog #10 (replaces the D-A-01 / D-B-01 MAX rule): the merged account rating over the union of the
            // member's selected rosters (per character the max eidolon across the accounts, same formula and
            // maxPossible denominator), captured at Waiting -> Drafting. One account gives that account's own
            // rating. A66, A69(3): taken once here; selection is Waiting-only, so nothing moves it later.
            // D-B-02: 0 when no LMA rows exist (casual only; ranked/MMR-tournament matches reject that above).
            const accountRatingSnapshot = computeLobbyMemberRating(ctx, lobbyId, member.userId);
            ctx.db.MatchResultParticipant.insert(insertWithAudit(ctx, {
                matchResultId: matchResultRow.id,
                userId: member.userId,
                teamSide: slotToTeamSide(member.lobbySlot),
                isCaptain: member.isCaptain,
                accountRatingSnapshot,
            }, user.id));
        }

        // D-10: Initialize disconnect pool for all members at match start
        const allMembersForPool = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        for (const m of allMembersForPool) {
            ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, m.userId]);
            ctx.db.LobbyMember.insert(updateWithAudit(ctx, m, {
                disconnectPoolRemainingMs: 300000,
                disconnectedAt: undefined,
            }, user.id));
        }

        // Transition lobby stage to Drafting
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            stage: { tag: 'Drafting', value: {} } as any,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        // S10e review F2 (A93(4)): an offline host or referee gets the 15 s check now, so the roles move in the live
        // stages as for a disconnect after the start (a host who dropped in Waiting scheduled nothing, A93(1)).
        scheduleChecksForOfflineStaff(ctx, lobby);

        // System chat message (D-13 rolling window, S10e)
        trimChatForInsert(ctx, lobbyId);
        ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            senderUserId: 0,
            senderType: { tag: 'System', value: {} } as any,
            content: 'Draft has started!',
            metadata: undefined,
            anonymousLabel: undefined,
        }));

        console.log(`[DRAFT] start_draft: Lobby #${lobbyId} entered Drafting. Sequence length=${sequence.length}`);
    }
);

// ─── pick_character ───────────────────────────────────────────────────────────
// Records a character pick on the current turn.
// Per D-39 (MOUS-03): Coaches cannot perform draft actions.
// Per D-42: allowMirrorPicks lets the other team pick a character again; A87: never the same team twice.
// Per D-40: requireOwnership triggers validateCharacterOwnership.
// Captain or sole-player restriction: only team captain can pick (unless no captain assigned).

export const pick_character = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        characterName: t.string(),
        eidolon: t.u8(),
    },
    (ctx, { lobbyId, characterName, eidolon: requestedEidolon }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) {
            throw new SenderError('Draft session not found.');
        }

        ensureStageIs(lobby, 'Drafting');
        ensureMatchAlive(ctx, lobby);

        const member = ensureLobbyMember(ctx, lobbyId, user.id);

        // A22(3): no draft action while the draft is paused
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is paused.');
        }

        // D-39 Coach guard (MOUS-03)
        if (slotIsCoach(member.lobbySlot)) {
            throw new SenderError('Coaches cannot perform draft actions.');
        }

        // Turn validation
        const currentStep = session.draftSequence[session.turnIndex];
        if (!currentStep) {
            throw new SenderError('No more steps in draft sequence.');
        }
        if (currentStep.actionRequired.tag !== 'Pick') {
            throw new SenderError('Current turn is not a Pick.');
        }
        if (currentStep.teamTurn.tag !== slotTeam(member.lobbySlot)) {
            throw new SenderError('It is not your team\'s turn to pick.');
        }

        // Captain check: only captain may pick (or sole player if no captain)
        if (!member.isCaptain) {
            const teamMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)].filter(
                (m: any) => slotTeam(m.lobbySlot) === slotTeam(member.lobbySlot) && !slotIsCoach(m.lobbySlot)
            );
            const hasCaptain = teamMembers.some((m: any) => m.isCaptain);
            if (hasCaptain) {
                throw new SenderError('Only the team captain can pick characters.');
            }
        }

        // Character availability: check not already picked or banned. A87: with allowMirrorPicks the other team's
        // picks stay available, but a team never picks the same character twice.
        const existingSteps = lobbySteps(ctx, lobbyId); // A67(3): the lobby's one game
        const pickedByThisTeam = picksBlockingTeam(existingSteps, lobby, slotTeam(member.lobbySlot) ?? '');
        if (pickedByThisTeam.has(characterName)) {
            throw new SenderError(lobby.allowMirrorPicks
                ? 'Your team already picked this character.'
                : 'Character already picked.');
        }
        // Always check bans (mirror picks don't bypass bans)
        const alreadyBanned = existingSteps.some(
            (s: any) =>
                s.action.tag === 'Ban' &&
                s.payload.tag === 'Ban' &&
                s.payload.value.characterName === characterName
        );
        if (alreadyBanned) {
            throw new SenderError('Character is banned and cannot be picked.');
        }

        // D-40 Ownership validation
        if (lobby.requireOwnership) {
            const ownershipResult = validateCharacterOwnership(ctx, user.id, characterName, lobbyId);
            if (!ownershipResult.valid) {
                throw new SenderError(ownershipResult.reason ?? 'You do not own this character.');
            }
        }

        // CH-S6 / D.8.7: under requireOwnership the server resolves the eidolon from the selected accounts
        // and ignores the argument; otherwise the argument stands. Cost and payload use the resolved value.
        if (!lobby.requireOwnership && requestedEidolon > 6) {
            throw new SenderError('eidolon must be between 0 and 6.');
        }
        const eidolon = lobby.requireOwnership
            ? resolveOwnedEidolon(ctx, lobbyId, user.id, characterName)
            : requestedEidolon;

        // Determine cost from HsrCharacterCost table (15.4 D-10/D-11: filter draftMode='Classic').
        const cost = classicPickCost(ctx, lobby, characterName, eidolon);

        // Record the step
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId), // F9: never collides with Pause/Undo audit rows
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'Pick', value: {} } as any,
            payload: {
                tag: 'Pick',
                value: { characterName, eidolon, costPaid: cost },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // Advance turn and update MatchSession
        const newTurnIndex = session.turnIndex + 1;
        const isClassicComplete =
            lobby.draftMode.tag === 'Classic' &&
            newTurnIndex >= session.draftSequence.length;
        const isAuctionBansComplete =
            lobby.draftMode.tag === 'Auction' &&
            newTurnIndex >= session.draftSequence.length;

        if (isClassicComplete) {
            // Classic draft complete — transition to Equipping
            // D-50: Budget rollover — carry leftover charBudget into lcBudget
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                teamBlueLcBudget: session.teamBlueLcBudget + session.teamBlueCharBudget,
                teamRedLcBudget: session.teamRedLcBudget + session.teamRedCharBudget,
                teamBlueCharBudget: 0,
                teamRedCharBudget: 0,
                timerState: {
                    ...session.timerState,
                    turnStartAt: ctx.timestamp,
                    accumulatedPauseMs: 0,
                },
            }, user.id));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                stage: { tag: 'Equipping', value: {} } as any,
                lastActivityAt: ctx.timestamp,
            }, user.id));
        } else if (isAuctionBansComplete) {
            // Auction ban phase complete — transition to auction phase
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                isAuctionPhase: true,
                timerState: {
                    ...session.timerState,
                    turnStartAt: ctx.timestamp,
                    accumulatedPauseMs: 0,
                },
            }, user.id));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, user.id));
        } else {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                timerState: {
                    ...session.timerState,
                    turnStartAt: ctx.timestamp,
                    accumulatedPauseMs: 0,
                },
            }, user.id));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, user.id));
        }

        console.log(`[DRAFT] pick_character: User #${user.id} picked '${characterName}' (E${eidolon}) in lobby #${lobbyId}, turn ${session.turnIndex}`);
    }
);

// ─── ban_character ────────────────────────────────────────────────────────────
// Records a character ban on the current turn.
// Per D-39 (MOUS-03): Coaches cannot perform draft actions.
// Character must not already be banned or picked.

export const ban_character = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        characterName: t.string(),
    },
    (ctx, { lobbyId, characterName }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) {
            throw new SenderError('Draft session not found.');
        }

        ensureStageIs(lobby, 'Drafting');
        ensureMatchAlive(ctx, lobby);

        const member = ensureLobbyMember(ctx, lobbyId, user.id);

        // A22(3): no draft action while the draft is paused
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is paused.');
        }

        // D-39 Coach guard (MOUS-03)
        if (slotIsCoach(member.lobbySlot)) {
            throw new SenderError('Coaches cannot perform draft actions.');
        }

        // Turn validation
        const currentStep = session.draftSequence[session.turnIndex];
        if (!currentStep) {
            throw new SenderError('No more steps in draft sequence.');
        }
        if (currentStep.actionRequired.tag !== 'Ban') {
            throw new SenderError('Current turn is not a Ban.');
        }
        if (currentStep.teamTurn.tag !== slotTeam(member.lobbySlot)) {
            throw new SenderError('It is not your team\'s turn to ban.');
        }

        // Captain check: only captain may ban (or sole player if no captain)
        if (!member.isCaptain) {
            const teamMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)].filter(
                (m: any) => slotTeam(m.lobbySlot) === slotTeam(member.lobbySlot) && !slotIsCoach(m.lobbySlot)
            );
            const hasCaptain = teamMembers.some((m: any) => m.isCaptain);
            if (hasCaptain) {
                throw new SenderError('Only the team captain can ban characters.');
            }
        }

        // Character availability: not already banned or picked
        const existingSteps = lobbySteps(ctx, lobbyId); // A67(3): the lobby's one game
        const alreadyBanned = existingSteps.some(
            (s: any) =>
                s.action.tag === 'Ban' &&
                s.payload.tag === 'Ban' &&
                s.payload.value.characterName === characterName
        );
        if (alreadyBanned) {
            throw new SenderError('Character already banned.');
        }
        const alreadyPicked = existingSteps.some(
            (s: any) =>
                s.action.tag === 'Pick' &&
                s.payload.tag === 'Pick' &&
                s.payload.value.characterName === characterName
        );
        if (alreadyPicked) {
            throw new SenderError('Character already picked and cannot be banned.');
        }

        // A45(2): the lobby's Ban Restriction, counted per team over this game's bans
        const restrictionError = banRestrictionError(ctx, lobby, slotTeam(member.lobbySlot) ?? '', characterName);
        if (restrictionError) {
            throw new SenderError(restrictionError);
        }

        // Record the step
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId), // F9: never collides with Pause/Undo audit rows
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'Ban', value: {} } as any,
            payload: {
                tag: 'Ban',
                value: { characterName },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // Advance turn and update MatchSession
        const newTurnIndex = session.turnIndex + 1;
        const isAuctionBansComplete =
            lobby.draftMode.tag === 'Auction' &&
            newTurnIndex >= session.draftSequence.length;

        if (isAuctionBansComplete) {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                isAuctionPhase: true,
                timerState: {
                    ...session.timerState,
                    turnStartAt: ctx.timestamp,
                    accumulatedPauseMs: 0,
                },
            }, user.id));
        } else {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                timerState: {
                    ...session.timerState,
                    turnStartAt: ctx.timestamp,
                    accumulatedPauseMs: 0,
                },
            }, user.id));
        }

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[DRAFT] ban_character: User #${user.id} banned '${characterName}' in lobby #${lobbyId}, turn ${session.turnIndex}`);
    }
);

// ─── timer_expiry_classic ─────────────────────────────────────────────────────
// Called by the frontend when the turn timer expires.
// Per D-43: Validates server-side that timer actually expired.
// Per D-43b: If autoRandomPick=true, deterministically picks from available pool
//            using hash (turnIndex * 31 + lobbyId) % availablePool.length; A86: the pool holds what the acting
//            team may legally pick, and the pick is priced like pick_character (cost row, owned eidolon).
//            Otherwise auto-picks EMPTY CHARACTER (characterName="EMPTY", eidolon=0, costPaid=0).
// For ban expiry: auto-bans a random character if autoRandomPick, else skips (empty ban).

export const timer_expiry_classic = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) {
            throw new SenderError('Draft session not found.');
        }

        ensureStageIs(lobby, 'Drafting');
        ensureMatchAlive(ctx, lobby);

        // F3: only a lobby member may fire the expiry (contract :162), and never while the draft is paused
        ensureLobbyMember(ctx, lobbyId, user.id);
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is paused.');
        }

        // Server-side timer validation (S10f, F10): the turn's remaining time (helpers/draft/turnClock.ts) must be 0
        if (turnRemainingMs(lobby, session.timerState, ctx.timestamp.microsSinceUnixEpoch) > 0) {
            throw new SenderError('Turn timer has not yet expired.');
        }

        const currentStep = session.draftSequence[session.turnIndex];
        if (!currentStep) {
            throw new SenderError('No more steps in draft sequence.');
        }

        if (currentStep.actionRequired.tag === 'Pick') {
            let characterName = 'EMPTY';
            let eidolon = 0;
            let costPaid = 0;

            // D-43b: autoRandomPick — deterministic selection from available pool
            if (lobby.autoRandomPick) {
                const existingSteps = lobbySteps(ctx, lobbyId); // A67(3): the lobby's one game
                const bannedChars = new Set(
                    existingSteps
                        .filter((s: any) => s.action.tag === 'Ban' && s.payload.tag === 'Ban')
                        .map((s: any) => s.payload.value.characterName)
                );
                // Determine who is acting (team with the current turn)
                const actingTeam = currentStep.teamTurn.tag;
                // A87: under allowMirrorPicks only the acting team's own picks are excluded.
                const pickedChars = picksBlockingTeam(existingSteps, lobby, actingTeam);
                const teamMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)].filter(
                    (m: any) => slotTeam(m.lobbySlot) === actingTeam && !slotIsCoach(m.lobbySlot)
                );
                // Gather available pool: owned if requireOwnership, not banned/picked
                let availablePool: string[] = [];
                if (lobby.requireOwnership) {
                    // Union of the acting team's players' owned characters across their selected LMA accounts
                    // (D-I-01/02: LobbyMemberAccount, never HsrAccount.isActive). Nothing owned → empty pool → EMPTY.
                    const ownedSet = new Set<string>();
                    for (const member of teamMembers) {
                        const selectedAccounts = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, member.userId])];
                        for (const lma of selectedAccounts) {
                            const chars = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(lma.hsrAccountId)];
                            for (const c of chars) {
                                ownedSet.add(c.characterName);
                            }
                        }
                    }
                    availablePool = [...ownedSet].filter(
                        (name) => !bannedChars.has(name) && !pickedChars.has(name)
                    );
                } else {
                    // All characters in the cost table for this game mode (not banned/picked).
                    // 15.4 D-10/D-11: filter draftMode='Classic' so Auction-only rows don't
                    // leak into the Classic auto-pool (WR-02 Phase 15.4).
                    const costRows = [...ctx.db.HsrCharacterCost.cost_set_id.filter(lobby.costSetId)];
                    const allChars = [...new Set(
                        costRows
                            .filter((r: any) =>
                                r.gameMode.tag === lobby.gameMode.tag &&
                                r.draftMode.tag === 'Classic'
                            )
                            .map((r: any) => r.characterName)
                    )];
                    availablePool = allChars.filter(
                        (name) => !bannedChars.has(name) && !pickedChars.has(name)
                    );
                }

                if (availablePool.length > 0) {
                    // Deterministic hash: (turnIndex * 31 + lobbyId) % availablePool.length
                    const hashIndex = (session.turnIndex * 31 + lobbyId) % availablePool.length;
                    characterName = availablePool[hashIndex];
                    // A86: priced like pick_character: E0 without ownership, else the highest level the acting team
                    // owns on its selected accounts (resolveOwnedEidolon per player, the maximum over the team).
                    if (lobby.requireOwnership) {
                        for (const member of teamMembers) {
                            eidolon = Math.max(eidolon, resolveOwnedEidolon(ctx, lobbyId, member.userId, characterName));
                        }
                    }
                    costPaid = classicPickCost(ctx, lobby, characterName, eidolon);
                }
                // If no available pool, fall back to EMPTY (cost 0)
            }

            // Record the auto-pick step
            ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                sequence: getNextSequence(ctx, lobbyId), // F9: never collides with Pause/Undo audit rows
                actorUserId: 0,  // System actor
                anonymousLabel: undefined,
                actorSlot: currentStep.teamTurn,
                action: { tag: 'Pick', value: {} } as any,
                payload: {
                    tag: 'Pick',
                    value: { characterName, eidolon, costPaid },
                } as any,
                timestamp: ctx.timestamp,
            }));

        } else if (currentStep.actionRequired.tag === 'Ban') {
            let characterName = 'SKIP';

            // D-43b: autoRandomPick — deterministic selection from unban/unpicked pool
            if (lobby.autoRandomPick) {
                const existingSteps = lobbySteps(ctx, lobbyId); // A67(3): the lobby's one game
                const bannedChars = new Set(
                    existingSteps
                        .filter((s: any) => s.action.tag === 'Ban' && s.payload.tag === 'Ban')
                        .map((s: any) => s.payload.value.characterName)
                );
                const pickedChars = new Set(
                    existingSteps
                        .filter((s: any) => s.action.tag === 'Pick' && s.payload.tag === 'Pick')
                        .map((s: any) => s.payload.value.characterName)
                );

                // 15.4 D-10/D-11: filter draftMode='Classic' so Auction-only rows don't
                // leak into the Classic auto-ban pool (WR-02 Phase 15.4).
                const costRows = [...ctx.db.HsrCharacterCost.cost_set_id.filter(lobby.costSetId)];
                const allChars = [...new Set(
                    costRows
                        .filter((r: any) =>
                            r.gameMode.tag === lobby.gameMode.tag &&
                            r.draftMode.tag === 'Classic'
                        )
                        .map((r: any) => r.characterName)
                )];
                // A45(2): only characters the acting team may still ban under the lobby's Ban Restriction;
                // none left → the SKIP sentinel, as without autoRandomPick.
                const availablePool = allChars.filter(
                    (name) => !bannedChars.has(name) && !pickedChars.has(name)
                        && isBanLegal(ctx, lobby, currentStep.teamTurn.tag, name)
                );

                if (availablePool.length > 0) {
                    const hashIndex = (session.turnIndex * 31 + lobbyId) % availablePool.length;
                    characterName = availablePool[hashIndex];
                }
            }

            // Record the auto-ban step
            ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                sequence: getNextSequence(ctx, lobbyId), // F9: never collides with Pause/Undo audit rows
                actorUserId: 0,  // System actor
                anonymousLabel: undefined,
                actorSlot: currentStep.teamTurn,
                action: { tag: 'Ban', value: {} } as any,
                payload: {
                    tag: 'Ban',
                    value: { characterName },
                } as any,
                timestamp: ctx.timestamp,
            }));
        }

        // Advance turn
        const newTurnIndex = session.turnIndex + 1;
        const isClassicComplete =
            lobby.draftMode.tag === 'Classic' &&
            newTurnIndex >= session.draftSequence.length;
        const isAuctionBansComplete =
            lobby.draftMode.tag === 'Auction' &&
            newTurnIndex >= session.draftSequence.length;

        if (isClassicComplete) {
            // D-50: Budget rollover — carry leftover charBudget into lcBudget
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                teamBlueLcBudget: session.teamBlueLcBudget + session.teamBlueCharBudget,
                teamRedLcBudget: session.teamRedLcBudget + session.teamRedCharBudget,
                teamBlueCharBudget: 0,
                teamRedCharBudget: 0,
                timerState: {
                    ...session.timerState,
                    turnStartAt: ctx.timestamp,
                    accumulatedPauseMs: 0,
                },
            }, 0));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                stage: { tag: 'Equipping', value: {} } as any,
                lastActivityAt: ctx.timestamp,
            }, 0));
        } else if (isAuctionBansComplete) {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                isAuctionPhase: true,
                timerState: {
                    ...session.timerState,
                    turnStartAt: ctx.timestamp,
                    accumulatedPauseMs: 0,
                },
            }, 0));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, 0));
        } else {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                timerState: {
                    ...session.timerState,
                    turnStartAt: ctx.timestamp,
                    accumulatedPauseMs: 0,
                },
            }, 0));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, 0));
        }

        console.log(`[DRAFT] timer_expiry_classic: Auto-action at turn ${session.turnIndex} in lobby #${lobbyId}`);
    }
);
