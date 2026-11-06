import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureLobbyMember, ensureHostOrAbove, ensureStageIs, slotTeam, slotIsCoach, slotToTeamSide } from '../helpers/lobbyHelpers';
import { validateCharacterOwnership } from '../helpers/ownershipValidation';
import { buildClassicSequence, buildAuctionBanSequence } from '../helpers/draftSequences';
import { ensureMatchAlive } from '../helpers/disconnectHelpers';

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

        // Only host/admin/moderator can start
        ensureHostOrAbove(ctx, lobby, user);

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

        // Validate team composition: at least 1 non-coach player per team
        const bluePlayers = playersOnly.filter((m: any) => slotTeam(m.lobbySlot) === 'Blue');
        const redPlayers = playersOnly.filter((m: any) => slotTeam(m.lobbySlot) === 'Red');
        if (bluePlayers.length === 0) {
            throw new SenderError('Blue team must have at least one non-coach player.');
        }
        if (redPlayers.length === 0) {
            throw new SenderError('Red team must have at least one non-coach player.');
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
                        `Player #${member.userId} has no account selected for this match. All players must select an account before starting a ranked or MMR-counted match.`
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
                        `Player #${member.userId} has no account selected. autoRandomPick requires all players to have characters.`
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
                        `Player #${member.userId} has no characters on their selected account(s). autoRandomPick requires all players to have characters.`
                    );
                }
            }
        }

        // Build draft sequence
        let sequence: any[];
        if (lobby.draftMode.tag === 'Classic') {
            sequence = buildClassicSequence(lobby.banMode.tag);
        } else {
            // Auction mode: ban steps only
            sequence = buildAuctionBanSequence(lobby.banMode.tag);
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

        // Create MatchSession
        const timerState = {
            turnStartAt: ctx.timestamp,
            teamBlueReserveMs: lobby.reserveBankSeconds * 1000,
            teamRedReserveMs: lobby.reserveBankSeconds * 1000,
            isPaused: false,
            accumulatedPauseMs: 0,
        };

        ctx.db.MatchSession.insert(insertWithAudit(ctx, {
            lobbyId,
            turnIndex: 0,
            draftSequence: sequence,
            timerState,
            isAuctionPhase: lobby.draftMode.tag === 'Auction' && sequence.length === 0,
            nextNominatorTeam: { tag: 'Blue', value: {} } as any,
            blueCharactersWon: 0,
            redCharactersWon: 0,
            currentNomination: undefined,
            currentBidAmount: undefined,
            currentBidTeam: { tag: 'Spectator', value: {} } as any,
            teamBlueCharBudget: lobby.characterBudget,
            teamRedCharBudget: lobby.characterBudget,
            teamBlueLcBudget: lobby.lightconeBudget,
            teamRedLcBudget: lobby.lightconeBudget,
            pausesUsedBlue: 0,
            pausesUsedRed: 0,
            currentGameNumber: 1,
            gamesWonBlue: 0,
            gamesWonRed: 0,
            seriesBestOf: lobby.bestOf || 1,
        }, user.id));

        // Determine refereeFullControl from referee's team slot (D-44):
        // spectator referee = full control; player-side referee = false
        const refereeFullControl = (() => {
            const referee = allMembers.find((m: any) => m.isReferee);
            if (!referee) return false;
            return slotTeam(referee.lobbySlot) === null;
        })();

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
            blueConfirmed: false,
            redConfirmed: false,
            refereeFullControl,
            matchType: lobby.matchType,
            matchEndReason: undefined,
            concedeTrigger: undefined,
            concedeSummary: undefined,
            concedeAtStage: undefined,
        }, user.id));

        // Create MatchResultParticipant rows for each Blue+Red non-coach member
        // Re-read members to get updated isCaptain values
        const updatedMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        const participantMembers = updatedMembers.filter(
            (m: any) => !slotIsCoach(m.lobbySlot) && slotTeam(m.lobbySlot) !== null
        );
        for (const member of participantMembers) {
            // D-A-01 / D-B-01 (Phase 12.3): capture max HsrAccount.accountRating across
            // the member's LobbyMemberAccount rows at the instant the lobby transitions
            // Waiting -> Drafting. max() is the anti-gaming rule: swapping to a lower
            // account later cannot reduce the MMR input for this match.
            // D-B-02: default 0 when no LMA rows exist (only possible for casual matches
            // — ranked/MMR-tournament matches are rejected at lines 59-73 if any player
            // has zero LMA rows). Zero matches the pre-phase `?? 0` fallback at
            // finalizationHelpers.ts:87,91 and produces zero account-modifier contribution.
            const selectedAccounts = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, member.userId])];
            let accountRatingSnapshot = 0;
            for (const lma of selectedAccounts) {
                const acct = ctx.db.HsrAccount.id.find(lma.hsrAccountId);
                if (acct && acct.accountRating > accountRatingSnapshot) {
                    accountRatingSnapshot = acct.accountRating;
                }
            }
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
                voluntarilyLeft: false,
                disconnectedAt: undefined,
            }, user.id));
        }

        // Transition lobby stage to Drafting
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            stage: { tag: 'Drafting', value: {} } as any,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        // System chat message
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
// Per D-42: allowMirrorPicks controls whether the same character can be picked twice.
// Per D-40: requireOwnership triggers validateCharacterOwnership.
// Captain or sole-player restriction: only team captain can pick (unless no captain assigned).

export const pick_character = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        characterName: t.string(),
        eidolon: t.u8(),
    },
    (ctx, { lobbyId, characterName, eidolon }) => {
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

        // Character availability: check not already picked or banned (unless allowMirrorPicks)
        const existingSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
        if (!lobby.allowMirrorPicks) {
            const alreadyPicked = existingSteps.some(
                (s: any) =>
                    s.action.tag === 'Pick' &&
                    s.payload.tag === 'Pick' &&
                    s.payload.value.characterName === characterName
            );
            if (alreadyPicked) {
                throw new SenderError('Character already picked.');
            }
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

        // Determine cost from HsrCharacterCost table (15.4 D-10/D-11: filter draftMode='Classic').
        let cost = 0;
        if (characterName !== 'EMPTY') {
            const costRows = [...ctx.db.HsrCharacterCost.cost_set_id.filter(lobby.costSetId)];
            const costRow = costRows.find(
                (r: any) =>
                    r.characterName === characterName &&
                    r.gameMode.tag === lobby.gameMode.tag &&
                    r.draftMode.tag === 'Classic'
            );
            if (costRow) {
                // Get cost for the specific eidolon level (15.4 D-01: unified costs struct).
                const eidolonKey = `e${eidolon}` as keyof typeof costRow.costs;
                cost = costRow.costs[eidolonKey] ?? 0;
            }
        }

        // Record the step
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            gameNumber: session.currentGameNumber,
            sequence: session.turnIndex,
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
        const existingSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
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

        // Record the step
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            gameNumber: session.currentGameNumber,
            sequence: session.turnIndex,
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
//            using hash (turnIndex * 31 + lobbyId) % availablePool.length.
//            Otherwise auto-picks EMPTY CHARACTER (characterName="EMPTY", eidolon=0).
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

        // Server-side timer validation: check that enough time has actually elapsed
        const elapsedMicros =
            ctx.timestamp.microsSinceUnixEpoch -
            session.timerState.turnStartAt.microsSinceUnixEpoch;
        const elapsedMs = Number(elapsedMicros) / 1000;
        const turnLimitMs = lobby.standardTurnSeconds * 1000;
        if (elapsedMs < turnLimitMs) {
            throw new SenderError('Turn timer has not yet expired.');
        }

        const currentStep = session.draftSequence[session.turnIndex];
        if (!currentStep) {
            throw new SenderError('No more steps in draft sequence.');
        }

        if (currentStep.actionRequired.tag === 'Pick') {
            let characterName = 'EMPTY';
            let eidolon = 0;

            // D-43b: autoRandomPick — deterministic selection from available pool
            if (lobby.autoRandomPick) {
                const existingSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
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

                // Determine who is acting (team with the current turn)
                const actingTeam = currentStep.teamTurn.tag;
                const teamMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)].filter(
                    (m: any) => slotTeam(m.lobbySlot) === actingTeam && !slotIsCoach(m.lobbySlot)
                );

                // Gather available pool: owned if requireOwnership, not banned/picked
                let availablePool: string[] = [];
                if (lobby.requireOwnership && teamMembers.length > 0) {
                    // Union of all team members' owned characters across their selected LMA accounts.
                    // D-I-01/02 (Phase 12.3): migrated from HsrAccount.isActive to LobbyMemberAccount —
                    // closes the last in-gameplay runtime read of isActive (Phase 10.4 migration gap).
                    // Matches the pattern at draftClassic.ts:76-96 (start_draft autoRandomPick validation)
                    // and ownershipValidation.ts:21-36 (validateCharacterOwnership).
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
                    // eidolon stays 0 for auto-pick
                }
                // If no available pool, fall back to EMPTY
            }

            // Record the auto-pick step
            ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                gameNumber: session.currentGameNumber,
                sequence: session.turnIndex,
                actorUserId: 0,  // System actor
                anonymousLabel: undefined,
                actorSlot: currentStep.teamTurn,
                action: { tag: 'Pick', value: {} } as any,
                payload: {
                    tag: 'Pick',
                    value: { characterName, eidolon, costPaid: 0 },
                } as any,
                timestamp: ctx.timestamp,
            }));

        } else if (currentStep.actionRequired.tag === 'Ban') {
            let characterName = 'SKIP';

            // D-43b: autoRandomPick — deterministic selection from unban/unpicked pool
            if (lobby.autoRandomPick) {
                const existingSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
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
                const availablePool = allChars.filter(
                    (name) => !bannedChars.has(name) && !pickedChars.has(name)
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
                gameNumber: session.currentGameNumber,
                sequence: session.turnIndex,
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
