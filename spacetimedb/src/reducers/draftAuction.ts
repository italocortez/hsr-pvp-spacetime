import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureLobbyMember, ensureStageIs, slotTeam, slotIsCoach, slotToTeamSide } from '../helpers/lobbyHelpers';
import { ensureMatchAlive } from '../helpers/disconnectHelpers';
import type { NominatePayload } from '../module_bindings/types';

// ─── Helper: Get set of characters already won via AuctionSold ──────────────
// Auction characters are ALWAYS exclusive (D-42).
// Returns a Set of characterNames that have already been awarded via AuctionSold.

function getAuctionWonCharacters(ctx: any, lobbyId: number): Set<string> {
    const steps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
    const wonSet = new Set<string>();
    for (const step of steps) {
        if (
            step.action.tag === 'AuctionSold' &&
            step.payload.tag === 'AuctionSold'
        ) {
            wonSet.add(step.payload.value.characterName);
        }
    }
    return wonSet;
}

// ─── Helper: Get set of banned characters ───────────────────────────────────
function getBannedCharacters(ctx: any, lobbyId: number): Set<string> {
    const steps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
    const bannedSet = new Set<string>();
    for (const step of steps) {
        if (
            step.action.tag === 'Ban' &&
            step.payload.tag === 'Ban'
        ) {
            bannedSet.add(step.payload.value.characterName);
        }
    }
    return bannedSet;
}

// ─── Helper: Look up base cost from cost table ──────────────────────────────
// Per D-53: base cost from HsrCharacterCost using (characterName, eidolon, costSetId, gameMode).
// Returns 0 if not found (0-cost characters per D-54).

function getCharacterBaseCost(
    ctx: any,
    characterName: string,
    eidolon: number,
    costSetId: number,
    gameMode: any
): number {
    if (characterName === 'EMPTY') return 0;
    // 15.4 D-10/D-11: filter draftMode='Auction' and read unified costs struct.
    const costRows = [...ctx.db.HsrCharacterCost.cost_set_id.filter(costSetId)];
    const costRow = costRows.find(
        (r: any) =>
            r.characterName === characterName &&
            r.gameMode.tag === gameMode.tag &&
            r.draftMode.tag === 'Auction'
    );
    if (!costRow) return 0;
    const eidolonKey = `e${eidolon}` as keyof typeof costRow.costs;
    return costRow.costs[eidolonKey] ?? 0;
}

// ─── Helper: Determine next sequence number ─────────────────────────────────
function getNextSequence(ctx: any, lobbyId: number): number {
    const steps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
    if (steps.length === 0) return 0;
    return Math.max(...steps.map((s: any) => s.sequence)) + 1;
}

// ─── Helper: Check auction end condition ────────────────────────────────────
// Per D-48: each team drafts 8 characters (fixed). The number of characters
// is determined by the game mode (2 bosses × 4 chars = 8), not teamSize.
// teamSize only controls how many human players share the draft.

function isAuctionComplete(session: any): boolean {
    const targetCount = 8;
    return (
        session.blueCharactersWon >= targetCount &&
        session.redCharactersWon >= targetCount
    );
}

// ─── nominate_character ──────────────────────────────────────────────────────
// Per D-47/D-48/D-53: Nomination sets the character at base cost from cost table.
// The nominating team is automatically the first bidder at base cost.

export const nominate_character = spacetimedb.reducer(
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

        // Must be in auction phase
        if (!session.isAuctionPhase) {
            throw new SenderError('Auction phase not active.');
        }

        // No active auction in progress
        if (session.currentNomination) {
            throw new SenderError('An auction is already in progress.');
        }

        // Member must be on a team (Blue or Red)
        if (slotTeam(member.lobbySlot) === null) {
            throw new SenderError('Spectators cannot nominate characters.');
        }

        // Turn check: only the nominating team can nominate
        if (session.nextNominatorTeam.tag !== slotTeam(member.lobbySlot)) {
            throw new SenderError('It is not your team\'s turn to nominate.');
        }

        // Captain check: only captain can nominate (or sole player if no captain)
        if (!member.isCaptain) {
            const teamMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)].filter(
                (m: any) => slotTeam(m.lobbySlot) === slotTeam(member.lobbySlot) && !slotIsCoach(m.lobbySlot)
            );
            const hasCaptain = teamMembers.some((m: any) => m.isCaptain);
            if (hasCaptain) {
                throw new SenderError('Only the team captain can nominate characters.');
            }
        }

        // Character availability: not already won in auction, not banned
        if (characterName !== 'EMPTY') {
            const wonChars = getAuctionWonCharacters(ctx, lobbyId);
            if (wonChars.has(characterName)) {
                throw new SenderError('Character has already been won in this auction.');
            }
            const bannedChars = getBannedCharacters(ctx, lobbyId);
            if (bannedChars.has(characterName)) {
                throw new SenderError('Character is banned and cannot be nominated.');
            }
        }

        // Per D-53: Look up base cost from cost table
        const baseCost = getCharacterBaseCost(ctx, characterName, eidolon, lobby.costSetId, lobby.gameMode);

        // Budget check: nominating team must have enough budget for at least the base cost
        // Per D-53: nomination rejected if base cost > remaining budget
        if (slotTeam(member.lobbySlot) === 'Blue') {
            if (baseCost > session.teamBlueCharBudget) {
                throw new SenderError('Not enough budget to nominate this character.');
            }
        } else {
            if (baseCost > session.teamRedCharBudget) {
                throw new SenderError('Not enough budget to nominate this character.');
            }
        }

        const nextSeq = getNextSequence(ctx, lobbyId);

        // Insert Nominate step (per D-47: nomination = automatic first bid at base cost)
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            gameNumber: session.currentGameNumber,
            sequence: nextSeq,
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'Nominate', value: {} } as any,
            payload: {
                tag: 'Nominate',
                value: { characterName, eidolon },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // Set auction state: nomination = first bid by nominating team at base cost
        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            currentNomination: characterName,
            currentBidAmount: baseCost,
            currentBidTeam: slotToTeamSide(member.lobbySlot),
            timerState: {
                ...session.timerState,
                turnStartAt: ctx.timestamp,
                accumulatedPauseMs: 0,
            },
        }, user.id));

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(
            `[AUCTION] nominate_character: User #${user.id} (${slotTeam(member.lobbySlot)}) nominated '${characterName}' (E${eidolon}) at base cost ${baseCost} in lobby #${lobbyId}`
        );
    }
);

// ─── place_bid ────────────────────────────────────────────────────────────────
// Per D-48/D-53: Alternating bids with minimum raise enforcement.
// Bidder must be on the OPPOSITE team from the current bid holder.

export const place_bid = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        bidAmount: t.f32(),
    },
    (ctx, { lobbyId, bidAmount }) => {
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

        // Must be in auction phase with an active nomination
        if (!session.isAuctionPhase) {
            throw new SenderError('Auction phase not active.');
        }

        if (!session.currentNomination) {
            throw new SenderError('No auction in progress.');
        }

        // Member must be on a team
        if (slotTeam(member.lobbySlot) === null) {
            throw new SenderError('Spectators cannot bid.');
        }

        // Bidder must be on the OPPOSITE team from the current bid holder (alternating bids per D-48)
        if (slotTeam(member.lobbySlot) === session.currentBidTeam.tag) {
            throw new SenderError('Your team already holds the current bid. Wait for the other team to respond.');
        }

        // Captain check: only captain can bid (or sole player if no captain)
        if (!member.isCaptain) {
            const teamMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)].filter(
                (m: any) => slotTeam(m.lobbySlot) === slotTeam(member.lobbySlot) && !slotIsCoach(m.lobbySlot)
            );
            const hasCaptain = teamMembers.some((m: any) => m.isCaptain);
            if (hasCaptain) {
                throw new SenderError('Only the team captain can place bids.');
            }
        }

        // Per D-53: Minimum raise check
        const currentBid = session.currentBidAmount ?? 0;
        const minimumBid = currentBid + lobby.minimumBidRaise;
        if (bidAmount < minimumBid) {
            throw new SenderError(
                `Bid must be at least ${minimumBid} (current bid ${currentBid} + minimum raise ${lobby.minimumBidRaise}).`
            );
        }

        // Budget check: cannot bid more than remaining budget
        if (slotTeam(member.lobbySlot) === 'Blue') {
            if (bidAmount > session.teamBlueCharBudget) {
                throw new SenderError('Bid exceeds your remaining character budget.');
            }
        } else {
            if (bidAmount > session.teamRedCharBudget) {
                throw new SenderError('Bid exceeds your remaining character budget.');
            }
        }

        const nextSeq = getNextSequence(ctx, lobbyId);

        // Insert Bid step
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            gameNumber: session.currentGameNumber,
            sequence: nextSeq,
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'Bid', value: {} } as any,
            payload: {
                tag: 'Bid',
                value: { amount: bidAmount, targetCharacter: session.currentNomination },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // Update session: new bid amount + bidding team
        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            currentBidAmount: bidAmount,
            currentBidTeam: slotToTeamSide(member.lobbySlot),
            timerState: {
                ...session.timerState,
                turnStartAt: ctx.timestamp,
                accumulatedPauseMs: 0,
            },
        }, user.id));

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(
            `[AUCTION] place_bid: User #${user.id} (${slotTeam(member.lobbySlot)}) bid ${bidAmount} on '${session.currentNomination}' in lobby #${lobbyId}`
        );
    }
);

// ─── pass_bid ─────────────────────────────────────────────────────────────────
// Per D-48: The team that declines to outbid causes the other team to win at their last bid.
// Implements steal-skip logic (D-46) and auction end check.

export const pass_bid = spacetimedb.reducer(
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

        const member = ensureLobbyMember(ctx, lobbyId, user.id);

        // D-39 Coach guard (MOUS-03)
        if (slotIsCoach(member.lobbySlot)) {
            throw new SenderError('Coaches cannot perform draft actions.');
        }

        // Must be in auction phase with an active nomination
        if (!session.isAuctionPhase) {
            throw new SenderError('Auction phase not active.');
        }

        if (!session.currentNomination) {
            throw new SenderError('No auction in progress.');
        }

        // Member must be on a team
        if (slotTeam(member.lobbySlot) === null) {
            throw new SenderError('Spectators cannot pass bids.');
        }

        // Passer must be on the OPPOSITE team from the current bid holder
        // (i.e., the team that would be expected to bid next)
        if (slotTeam(member.lobbySlot) === session.currentBidTeam.tag) {
            throw new SenderError('Your team holds the current bid. The other team must respond.');
        }

        // Captain check: only captain can pass (or sole player if no captain)
        if (!member.isCaptain) {
            const teamMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)].filter(
                (m: any) => slotTeam(m.lobbySlot) === slotTeam(member.lobbySlot) && !slotIsCoach(m.lobbySlot)
            );
            const hasCaptain = teamMembers.some((m: any) => m.isCaptain);
            if (hasCaptain) {
                throw new SenderError('Only the team captain can pass the bid.');
            }
        }

        // Resolution: currentBidTeam wins the character at currentBidAmount
        const winningTeam = session.currentBidTeam;
        const winningAmount = session.currentBidAmount ?? 0;
        const nominatedChar = session.currentNomination!;

        // Look up the eidolon from the original Nominate step for this nomination
        const allSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
        // Find the most recent Nominate step for this character (the active nomination)
        const nominateStep = allSteps
            .filter(
                (s: any) =>
                    s.action.tag === 'Nominate' &&
                    s.payload.tag === 'Nominate' &&
                    s.payload.value.characterName === nominatedChar
            )
            .sort((a: any, b: any) => b.sequence - a.sequence)[0];

        const eidolon: number = nominateStep ? (nominateStep.payload.value as NominatePayload).eidolon : 0;

        // Find the nominating team from the Nominate step
        const nominatingTeam = nominateStep ? nominateStep.actorSlot : session.nextNominatorTeam;

        const nextSeq = getNextSequence(ctx, lobbyId);

        // Insert AuctionSold step
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            gameNumber: session.currentGameNumber,
            sequence: nextSeq,
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'AuctionSold', value: {} } as any,
            payload: {
                tag: 'AuctionSold',
                value: {
                    characterName: nominatedChar,
                    winningAmount,
                    winningTeam,
                    eidolon,
                },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // Deduct budget from winning team
        let newBlueCharBudget = session.teamBlueCharBudget;
        let newRedCharBudget = session.teamRedCharBudget;
        let newBlueCharactersWon = session.blueCharactersWon;
        let newRedCharactersWon = session.redCharactersWon;

        if (winningTeam.tag === 'Blue') {
            newBlueCharBudget -= winningAmount;
            newBlueCharactersWon += 1;
        } else {
            newRedCharBudget -= winningAmount;
            newRedCharactersWon += 1;
        }

        // ─── Steal-skip logic (D-46) ──────────────────────────────────────────
        // Normal: if nominating team === winning team → other team nominates next.
        // Steal:  if nominating team !== winning team → nominating team nominates again.
        // (The opponent "spent" the nominating team's turn by winning, so nominator keeps their turn.)

        let nextNominatorTeam: any;
        if (nominatingTeam.tag === winningTeam.tag) {
            // Normal result — rotate to the other team
            nextNominatorTeam =
                nominatingTeam.tag === 'Blue'
                    ? { tag: 'Red', value: {} }
                    : { tag: 'Blue', value: {} };
        } else {
            // Steal — nominating team nominates again
            nextNominatorTeam = { tag: nominatingTeam.tag, value: {} };
        }

        // Check if auction is complete (both teams have target character count)
        const updatedSessionForCheck = {
            ...session,
            blueCharactersWon: newBlueCharactersWon,
            redCharactersWon: newRedCharactersWon,
        };
        const auctionComplete = isAuctionComplete(updatedSessionForCheck);

        if (auctionComplete) {
            // Clear auction state and transition to Equipping
            // D-50: Budget rollover — carry leftover charBudget into lcBudget
            const finalBlueCharBudget = newBlueCharBudget;
            const finalRedCharBudget = newRedCharBudget;
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                currentNomination: undefined,
                currentBidAmount: undefined,
                currentBidTeam: { tag: 'Spectator', value: {} } as any,
                teamBlueCharBudget: 0,
                teamRedCharBudget: 0,
                teamBlueLcBudget: session.teamBlueLcBudget + finalBlueCharBudget,
                teamRedLcBudget: session.teamRedLcBudget + finalRedCharBudget,
                blueCharactersWon: newBlueCharactersWon,
                redCharactersWon: newRedCharactersWon,
                nextNominatorTeam,
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

            console.log(
                `[AUCTION] Auction complete! Both teams reached target count. Lobby #${lobbyId} → Equipping.`
            );
        } else {
            // ─── Budget exhaustion check ─────────────────────────────────────
            // Per D-54: if the next nominator cannot afford any character,
            // skip to the other team. (0-cost characters are always available as fallback.)
            // Since EMPTY CHARACTER costs 0, a team with 0 budget can still nominate EMPTY.
            // Therefore, budget exhaustion = budget < 0 is impossible due to validation.
            // The team nominates EMPTY CHARACTER as per D-43/D-54 (auto-handled by timer expiry or client UI).
            // We do NOT auto-skip here; we just set the next nominator and let the timer handle it.

            // Clear auction state and set next nominator
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                currentNomination: undefined,
                currentBidAmount: undefined,
                currentBidTeam: { tag: 'Spectator', value: {} } as any,
                teamBlueCharBudget: newBlueCharBudget,
                teamRedCharBudget: newRedCharBudget,
                blueCharactersWon: newBlueCharactersWon,
                redCharactersWon: newRedCharactersWon,
                nextNominatorTeam,
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

        console.log(
            `[AUCTION] pass_bid: '${nominatedChar}' sold to ${winningTeam.tag} for ${winningAmount} in lobby #${lobbyId}. ` +
            `Next nominator: ${nextNominatorTeam.tag} (steal=${nominatingTeam.tag !== winningTeam.tag})`
        );
    }
);

// ─── timer_expiry_auction ─────────────────────────────────────────────────────
// Per D-43: Called by the frontend when the turn timer expires during auction phase.
// If in nomination phase (no currentNomination): auto-nominates EMPTY CHARACTER.
// If in bidding phase (currentNomination exists): auto-passes for the expected bidding team.

export const timer_expiry_auction = spacetimedb.reducer(
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

        if (!session.isAuctionPhase) {
            throw new SenderError('Auction phase not active.');
        }

        // Server-side timer validation: check that enough time has actually elapsed
        const elapsedMicros =
            ctx.timestamp.microsSinceUnixEpoch -
            session.timerState.turnStartAt.microsSinceUnixEpoch;
        const elapsedMs = Number(elapsedMicros) / 1000;
        const turnLimitMs = lobby.standardTurnSeconds * 1000;
        if (elapsedMs < turnLimitMs) {
            throw new SenderError('Turn timer has not yet expired.');
        }

        const nextSeq = getNextSequence(ctx, lobbyId);

        if (!session.currentNomination) {
            // ─── Nomination phase: auto-nominate EMPTY CHARACTER (D-43/D-54) ───
            const nominatingTeam = session.nextNominatorTeam;
            const baseCost = 0; // EMPTY CHARACTER always 0-cost

            // Insert Nominate step for EMPTY CHARACTER
            ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                gameNumber: session.currentGameNumber,
                sequence: nextSeq,
                actorUserId: 0, // System actor
                anonymousLabel: undefined,
                actorSlot: nominatingTeam,
                action: { tag: 'Nominate', value: {} } as any,
                payload: {
                    tag: 'Nominate',
                    value: { characterName: 'EMPTY', eidolon: 0 },
                } as any,
                timestamp: ctx.timestamp,
            }));

            // Set auction state: EMPTY nomination, auto-bid by nominating team at 0
            // The other team must now bid or pass
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                currentNomination: 'EMPTY',
                currentBidAmount: baseCost,
                currentBidTeam: nominatingTeam,
                timerState: {
                    ...session.timerState,
                    turnStartAt: ctx.timestamp,
                    accumulatedPauseMs: 0,
                },
            }, 0));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                lastActivityAt: ctx.timestamp,
            }, 0));

            console.log(
                `[AUCTION] timer_expiry_auction: Auto-nominated EMPTY CHARACTER for ${nominatingTeam.tag} in lobby #${lobbyId}`
            );
        } else {
            // ─── Bidding phase: auto-pass for the expected bidding team (D-43) ──
            // The expected bidder is the OPPOSITE team from currentBidTeam
            const nominatedChar = session.currentNomination;
            const winningTeam = session.currentBidTeam;
            const winningAmount = session.currentBidAmount ?? 0;

            // Look up eidolon from the Nominate step
            const allSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
            const nominateStep = allSteps
                .filter(
                    (s: any) =>
                        s.action.tag === 'Nominate' &&
                        s.payload.tag === 'Nominate' &&
                        s.payload.value.characterName === nominatedChar
                )
                .sort((a: any, b: any) => b.sequence - a.sequence)[0];

            const eidolon: number = nominateStep ? (nominateStep.payload.value as NominatePayload).eidolon : 0;
            const nominatingTeam = nominateStep ? nominateStep.actorSlot : session.nextNominatorTeam;

            // Insert AuctionSold step (system resolves the auction)
            ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                gameNumber: session.currentGameNumber,
                sequence: nextSeq,
                actorUserId: 0, // System actor
                anonymousLabel: undefined,
                actorSlot: { tag: 'Spectator', value: {} } as any, // System resolution
                action: { tag: 'AuctionSold', value: {} } as any,
                payload: {
                    tag: 'AuctionSold',
                    value: {
                        characterName: nominatedChar,
                        winningAmount,
                        winningTeam,
                        eidolon,
                    },
                } as any,
                timestamp: ctx.timestamp,
            }));

            // Deduct budget and increment won count
            let newBlueCharBudget = session.teamBlueCharBudget;
            let newRedCharBudget = session.teamRedCharBudget;
            let newBlueCharactersWon = session.blueCharactersWon;
            let newRedCharactersWon = session.redCharactersWon;

            if (winningTeam.tag === 'Blue') {
                newBlueCharBudget -= winningAmount;
                newBlueCharactersWon += 1;
            } else if (winningTeam.tag === 'Red') {
                newRedCharBudget -= winningAmount;
                newRedCharactersWon += 1;
            }

            // Steal-skip logic (D-46): same as pass_bid
            let nextNominatorTeam: any;
            if (nominatingTeam.tag === winningTeam.tag) {
                nextNominatorTeam =
                    nominatingTeam.tag === 'Blue'
                        ? { tag: 'Red', value: {} }
                        : { tag: 'Blue', value: {} };
            } else {
                nextNominatorTeam = { tag: nominatingTeam.tag, value: {} };
            }

            // Check auction completion
            const updatedSessionForCheck = {
                ...session,
                blueCharactersWon: newBlueCharactersWon,
                redCharactersWon: newRedCharactersWon,
            };
            const auctionComplete = isAuctionComplete(updatedSessionForCheck);

            if (auctionComplete) {
                // D-50: Budget rollover — carry leftover charBudget into lcBudget
                const finalBlueChar = newBlueCharBudget;
                const finalRedChar = newRedCharBudget;
                ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                    currentNomination: undefined,
                    currentBidAmount: undefined,
                    currentBidTeam: { tag: 'Spectator', value: {} } as any,
                    teamBlueCharBudget: 0,
                    teamRedCharBudget: 0,
                    teamBlueLcBudget: session.teamBlueLcBudget + finalBlueChar,
                    teamRedLcBudget: session.teamRedLcBudget + finalRedChar,
                    blueCharactersWon: newBlueCharactersWon,
                    redCharactersWon: newRedCharactersWon,
                    nextNominatorTeam,
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

                console.log(
                    `[AUCTION] timer_expiry_auction: Auction complete (timer expiry). Lobby #${lobbyId} → Equipping.`
                );
            } else {
                ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                    currentNomination: undefined,
                    currentBidAmount: undefined,
                    currentBidTeam: { tag: 'Spectator', value: {} } as any,
                    teamBlueCharBudget: newBlueCharBudget,
                    teamRedCharBudget: newRedCharBudget,
                    blueCharactersWon: newBlueCharactersWon,
                    redCharactersWon: newRedCharactersWon,
                    nextNominatorTeam,
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

            console.log(
                `[AUCTION] timer_expiry_auction: Auto-passed bid. '${nominatedChar}' sold to ${winningTeam.tag} for ${winningAmount} in lobby #${lobbyId}.`
            );
        }
    }
);
