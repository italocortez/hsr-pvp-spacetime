import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { anySeatedPlayerAway, ensurePresentMember, ensureRefereeOrAbove, ensureStageIs, slotTeam, slotIsCoach, slotToTeamSide } from '@module/helpers/lobby/lobbyHelpers';
import { resolveOwnedEidolon, validateCharacterOwnership } from '@module/helpers/draft/ownershipValidation';
import { buildAuctionBanSequence, buildClassicSequence } from '@module/helpers/draft/draftSequences';
import { computeLobbyMemberRating } from '@module/helpers/stats/accountRating';
import { banRestrictionError, isBanLegal } from '@module/helpers/lobby/banRestriction';
import { ensureMatchAlive, scheduleChecksForOfflineStaff } from '@module/helpers/lobby/disconnectHelpers';
import { lobbySteps, getNextSequence } from '@module/helpers/draft/stepSequence';
import { ensureTurnTimeLeft, readClock, turnEndTimerState } from '@module/helpers/draft/turnClock';
import { confirmWindowOpenText, draftCompleteText, finishDraft, finishDraftWithoutWindow, isDraftComplete } from '@module/helpers/draft/draftComplete';
import { characterCostAt, characterCostRow, costMissingText, pricedCharacterNames } from '@module/helpers/draft/costSetGuards';
import { trimChatForInsert } from '@module/helpers/lobby/chatWindow';
import { microsWords, timerDrawIndex as drawPoolIndex } from '@shared/lobby-rules';
import { sideHasTeamMember } from '@module/helpers/tournament/standIns';

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

/**
 * The cost of a pick at an eidolon level: the lobby's own cost row (A107(1): cost set, game mode, draft mode). EMPTY
 * costs 0; a character without a row is rejected (A107(5), characterCostAt).
 */
function classicPickCost(ctx: any, lobby: any, characterName: string, eidolon: number): number {
    return characterCostAt(ctx, lobby, characterName, eidolon);
}

/**
 * A117(3) (S10o, fix pass F1): the index a timer auto-pick or auto-ban draws from a pool of `poolLength` (> 0) entries.
 * It does not use ctx.random (its host seed is skewed, review F1). shared/lobby-rules/timerDraw.ts hashes the transaction
 * timestamp (microseconds, both 32-bit words), the lobby id, the turn index and nextSequence (the MatchSessionStep.sequence
 * the auto step is about to take) with MurmurHash3 x86_32 (fmix32 finalizer) and reduces the hash by multiply-high,
 * floor(h * n / 2^32): uniform up to a relative bias of n / 2^32. Deterministic for a given transaction and state.
 * After undo_last_step the same turn expires again in a later transaction (new timestamp) with a higher nextSequence (the
 * Undo row takes one), so the re-rolled turn can land on another entry. A pool of one entry always gives index 0.
 * The expiry is client-triggered (any present member may fire an expired turn, once: the accepted call advances the
 * turn); the draw depends on the host's microsecond commit time, which a client cannot aim, and nothing after the draw
 * lets a caller reject it and retry.
 */
function timerDrawIndex(ctx: any, lobbyId: number, turnIndex: number, poolLength: number, nextSequence: number): number {
    const { lo, hi } = microsWords(ctx.timestamp.microsSinceUnixEpoch);
    return drawPoolIndex({ timestampLo: lo, timestampHi: hi, lobbyId, turnIndex, nextSequence }, poolLength);
}

// ─── start_draft ──────────────────────────────────────────────────────────────
// Initializes the draft for a lobby.
// Per D-29: All Blue+Red non-coach players must be confirmed before starting.
// Per D-30: Assigns captains to first non-coach player per team if none set.
// Per A135(5) (S10v): in a tournament lobby each side seats at least one member of its team (no side of stand-ins only).
// Per D-43b / A117(1): If autoRandomPick=true and requireOwnership, validates all players have characters.
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
            // S10v (A135(5), audit SI11): in a tournament lobby each side seats at least one member of the team that
            // plays it; a side of stand-ins only does not start.
            if (!sideHasTeamMember(ctx, lobby, team, players)) {
                throw new SenderError(`${team} team needs at least one of its own members seated as a player; stand-ins cannot play without one.`);
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

        // S10v review N1: in a tournament lobby whose tournament requires ownership every seated Blue / Red player
        // (members and stand-ins alike) has a selected match account, else picks would be impossible (a stand-in who
        // deleted the account after approval, a player who deselected after confirming). Named by seat, as D-08 does.
        // Not applied to casual lobbies or to tournaments without requireOwnership.
        const tournamentRequiresOwnership = lobby.isTournamentControlled && lobby.tournamentId
            && ctx.db.Tournament.id.find(lobby.tournamentId)?.requireOwnership === true;
        if (tournamentRequiresOwnership) {
            for (const member of playersOnly) {
                if ([...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, member.userId])].length === 0) {
                    throw new SenderError(
                        `The player at seat ${member.joinSeq} has no account selected for this match. All players must select an account before starting a match that requires ownership.`
                    );
                }
            }
        }

        // D-43b: If autoRandomPick=true, validate ALL Blue+Red players have characters (D-12: check selected accounts).
        // A117(1) (S10o): only when the lobby requires ownership (the timer then draws from owned characters); without
        // it the pool is the lobby's priced characters and the draft starts without accounts, guests included.
        if (lobby.autoRandomPick && lobby.requireOwnership) {
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
                reserveUsedMs: 0, // S10aa (A148)
                inReserve: false,
                reserveMarks: [],
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

        const member = ensurePresentMember(ctx, lobbyId, user.id); // A98: present, not away or abandoned

        // A22(3): no draft action while the draft is paused
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is paused.');
        }

        // D-39 Coach guard (MOUS-03)
        if (slotIsCoach(member.lobbySlot)) {
            throw new SenderError('Coaches cannot perform draft actions.');
        }

        // S10t (A129): a complete draft waits for advance_stage; no turn runs.
        if (isDraftComplete(lobby, session)) throw new SenderError(draftCompleteText);

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

        // S10aa (A150): no pick more than 1 s after the turn time and the team's reserve ran out.
        ensureTurnTimeLeft(ctx, lobby, session);

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

        // A107(1)(5): the lobby's cost row (cost set, game mode, draft mode); no row → "<name> has no cost in this lobby's cost set."
        const cost = classicPickCost(ctx, lobby, characterName, eidolon);

        // Record the step
        const stepSequence = getNextSequence(ctx, lobbyId); // F9: never collides with Pause/Undo audit rows
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            sequence: stepSequence,
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
        // S10t (A129): the last Classic pick no longer moves the lobby to Equipping nor rolls the budgets over: the
        // turn index reaches the end of the sequence (the draft is complete, isDraftComplete) and the referee's
        // advance_stage makes the move with the D-50 roll-over. The last pick takes the plain branch below.
        const newTurnIndex = session.turnIndex + 1;
        const isAuctionBansComplete =
            lobby.draftMode.tag === 'Auction' &&
            newTurnIndex >= session.draftSequence.length;

        if (isAuctionBansComplete) {
            // Auction ban phase complete — transition to auction phase
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                isAuctionPhase: true,
                timerState: turnEndTimerState(ctx, lobby, session, stepSequence), // S10aa (A148)
            }, user.id));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, user.id));
        } else {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                timerState: turnEndTimerState(ctx, lobby, session, stepSequence), // S10aa (A148)
            }, user.id));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, user.id));
        }

        // A131: with confirmWindowSeconds 0 the pick that completes the draft moves the lobby to Equipping now.
        finishDraftWithoutWindow(ctx, lobbyId, user.id);

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

        const member = ensurePresentMember(ctx, lobbyId, user.id); // A98: present, not away or abandoned

        // A22(3): no draft action while the draft is paused
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is paused.');
        }

        // D-39 Coach guard (MOUS-03)
        if (slotIsCoach(member.lobbySlot)) {
            throw new SenderError('Coaches cannot perform draft actions.');
        }

        // S10t (A129): a complete draft waits for advance_stage; no turn runs.
        if (isDraftComplete(lobby, session)) throw new SenderError(draftCompleteText);

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

        // S10aa (A150): no ban more than 1 s after the turn time and the team's reserve ran out.
        ensureTurnTimeLeft(ctx, lobby, session);

        // S10r (A122(7), L32): a ban names a real character of the lobby's pool, the check picks make (the lobby's
        // cost row: cost set, game mode, draft mode; the pool the timer draws from). EMPTY is the no-pick placeholder,
        // never a manual ban. The timer's empty ban is the SKIP sentinel (timer_expiry_classic), not EMPTY.
        if (characterName === 'EMPTY') {
            throw new SenderError('EMPTY is not a character and cannot be banned.');
        }
        if (!characterCostRow(ctx, lobby, characterName)) {
            throw new SenderError(costMissingText(characterName));
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
        const stepSequence = getNextSequence(ctx, lobbyId); // F9: never collides with Pause/Undo audit rows
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            sequence: stepSequence,
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
                timerState: turnEndTimerState(ctx, lobby, session, stepSequence), // S10aa (A148)
            }, user.id));
        } else {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                timerState: turnEndTimerState(ctx, lobby, session, stepSequence), // S10aa (A148)
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
// Per D-43b: If autoRandomPick=true, picks from the available pool at timerDrawIndex (A117(3), S10o: a hash of the
//            transaction timestamp, lobby, turn and step sequence, so a turn re-rolled after an undo can land elsewhere);
//            A86: the pool holds what the acting team may legally pick, and the pick is priced like pick_character
//            (cost row, owned eidolon).
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
        ensurePresentMember(ctx, lobbyId, user.id); // A98: present, not away or abandoned
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is paused.');
        }

        // S10t (A129, A130, A131): a complete draft runs no turn but the lobby's confirm window, on the same clock fields
        // (turnFullMs). Before it has elapsed the call is refused; once it has, the lobby moves to Equipping (finishDraft,
        // the same write as advance_stage). Never an auto-pick, auto-ban, nomination or sale.
        // S10aa: the window has no reserve (readClock: no team on the clock), so expiryDue is the window's own end.
        const clock = readClock(lobby, session, ctx.timestamp.microsSinceUnixEpoch);
        if (isDraftComplete(lobby, session)) {
            if (!clock.expiryDue) {
                throw new SenderError(confirmWindowOpenText);
            }
            finishDraft(ctx, lobby, session, 0);
            return;
        }

        // Server-side timer validation (S10f, F10; S10aa, A148): the turn time and the on-clock team's reserve
        // (helpers/draft/turnClock.ts) must both be 0; the write below then sets that reserve to 0.
        if (!clock.expiryDue) {
            throw new SenderError('Turn timer has not yet expired.');
        }

        const currentStep = session.draftSequence[session.turnIndex];
        if (!currentStep) {
            throw new SenderError('No more steps in draft sequence.');
        }

        // The auto step's sequence (F9), also an input of the timer draw (A117(3)).
        const stepSequence = getNextSequence(ctx, lobbyId);

        if (currentStep.actionRequired.tag === 'Pick') {
            let characterName = 'EMPTY';
            let eidolon = 0;
            let costPaid = 0;

            // D-43b: autoRandomPick — a draw from the available pool (A117(3): timerDrawIndex)
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
                // Gather available pool: owned if requireOwnership, not banned/picked, priced by the lobby's cost set
                const priced = pricedCharacterNames(ctx, lobby);
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
                    // A107(5): an owned character without a row in the lobby's cost set is never drawn.
                    availablePool = [...ownedSet].filter(
                        (name) => priced.has(name) && !bannedChars.has(name) && !pickedChars.has(name)
                    );
                } else {
                    // A107(1): every character the lobby's cost set prices in its game mode and draft mode (not banned/picked).
                    const allChars = [...priced];
                    availablePool = allChars.filter(
                        (name) => !bannedChars.has(name) && !pickedChars.has(name)
                    );
                }

                if (availablePool.length > 0) {
                    characterName = availablePool[timerDrawIndex(ctx, lobbyId, session.turnIndex, availablePool.length, stepSequence)]; // A117(3)
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
                sequence: stepSequence, // F9: never collides with Pause/Undo audit rows
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

            // D-43b: autoRandomPick — a draw from the unbanned/unpicked pool (A117(3): timerDrawIndex)
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

                // A107(1): the characters the lobby's cost set prices in its game mode and the lobby's draft mode (the
                // Auction ban phase runs through this reducer and draws from the Auction rows, A101; no Classic-only
                // filter, no default-set fallback).
                const allChars = [...pricedCharacterNames(ctx, lobby)];
                // A45(2): only characters the acting team may still ban under the lobby's Ban Restriction;
                // none left → the SKIP sentinel, as without autoRandomPick.
                const availablePool = allChars.filter(
                    (name) => !bannedChars.has(name) && !pickedChars.has(name)
                        && isBanLegal(ctx, lobby, currentStep.teamTurn.tag, name)
                );

                if (availablePool.length > 0) {
                    characterName = availablePool[timerDrawIndex(ctx, lobbyId, session.turnIndex, availablePool.length, stepSequence)]; // A117(3)
                }
            }

            // Record the auto-ban step
            ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                sequence: stepSequence, // F9: never collides with Pause/Undo audit rows
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
        // S10t (A129): as in pick_character, the last timer pick leaves the lobby in Drafting with the draft complete;
        // the move to Equipping and the D-50 roll-over are advance_stage's.
        const newTurnIndex = session.turnIndex + 1;
        const isAuctionBansComplete =
            lobby.draftMode.tag === 'Auction' &&
            newTurnIndex >= session.draftSequence.length;

        if (isAuctionBansComplete) {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                isAuctionPhase: true,
                timerState: turnEndTimerState(ctx, lobby, session, stepSequence), // S10aa (A148)
            }, 0));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, 0));
        } else {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                turnIndex: newTurnIndex,
                timerState: turnEndTimerState(ctx, lobby, session, stepSequence), // S10aa (A148)
            }, 0));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, 0));
        }

        // A131: with confirmWindowSeconds 0 the timer pick that completes the draft moves the lobby to Equipping now.
        finishDraftWithoutWindow(ctx, lobbyId, 0);

        console.log(`[DRAFT] timer_expiry_classic: Auto-action at turn ${session.turnIndex} in lobby #${lobbyId}`);
    }
);
