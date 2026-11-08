import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureLobbyMember, ensureStageIs, slotTeam, slotIsCoach, slotToTeamSide } from '../helpers/lobbyHelpers';
import { ensureMatchAlive } from '../helpers/disconnectHelpers';
import { currentGameSteps, getNextSequence } from '../helpers/stepSequence';
import { teamOwnedEidolons } from '../helpers/ownershipValidation';
import { charactersPerTeam, type LineupFormatTag } from '@shared/scoring';

/** A65(2): the steps of the lobby's current game (the earlier games' steps stay until finalization). */
function gameSteps(ctx: any, lobbyId: number): any[] {
    return currentGameSteps(ctx, lobbyId, ctx.db.MatchSession.lobbyId.find(lobbyId)?.currentGameNumber ?? 1);
}

// ─── Helper: Get set of characters already won via AuctionSold ──────────────
// Auction characters are ALWAYS exclusive (D-42).
// Returns a Set of characterNames that have already been awarded via AuctionSold.

function getAuctionWonCharacters(ctx: any, lobbyId: number): Set<string> {
    const steps = gameSteps(ctx, lobbyId);
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
    const steps = gameSteps(ctx, lobbyId);
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

// ─── Helper: Look up costs from the cost table ──────────────────────────────
// Per D-53, amended by A61(1): the base cost of a nomination is the Auction cost row's e0 (characterName,
// costSetId, gameMode). Returns 0 if not found (0-cost characters per D-54) and for EMPTY.

function auctionCostRow(ctx: any, characterName: string, costSetId: number, gameMode: any): any {
    if (characterName === 'EMPTY') return undefined;
    // 15.4 D-10/D-11: filter draftMode='Auction' and read unified costs struct.
    return [...ctx.db.HsrCharacterCost.cost_set_id.filter(costSetId)].find(
        (r: any) =>
            r.characterName === characterName &&
            r.gameMode.tag === gameMode.tag &&
            r.draftMode.tag === 'Auction'
    );
}

/** The Auction cost of a character at an eidolon level in the lobby's cost set (0 for EMPTY / no row). */
export function auctionCostAt(ctx: any, lobby: any, characterName: string, eidolon: number): number {
    const costRow = auctionCostRow(ctx, characterName, lobby.costSetId, lobby.gameMode);
    if (!costRow) return 0;
    return costRow.costs[`e${eidolon}`] ?? 0;
}

function getCharacterBaseCost(ctx: any, characterName: string, costSetId: number, gameMode: any): number {
    return auctionCostRow(ctx, characterName, costSetId, gameMode)?.costs.e0 ?? 0;
}

/** A61(3): the eidolon extra = max(0, cost[eidolon] - cost[e0]) from the lobby's cost set (f32 like the budgets). */
export function auctionEidolonExtra(ctx: any, lobby: any, characterName: string, eidolon: number): number {
    return Math.max(0, auctionCostAt(ctx, lobby, characterName, eidolon) - auctionCostAt(ctx, lobby, characterName, 0));
}

/**
 * A61(3) as amended by A64(1): a team's default eidolon for a character = the lowest level its player seats own on
 * their selected accounts when the lobby requires ownership (0 when none does); always 0 (extra 0) without ownership.
 * Used by the sale (resolveSale), the bid-time guard (ensureTotalBudgetFits) and the set_eidolon bid reservation.
 * Higher owned levels are bought afterwards through set_eidolon (A64(2)). Classic keeps the highest (resolveOwnedEidolon).
 */
export function teamDefaultEidolon(ctx: any, lobby: any, side: string, characterName: string): number {
    if (!lobby.requireOwnership || characterName === 'EMPTY') return 0;
    const owned = teamOwnedEidolons(ctx, lobby.id, side, characterName);
    return owned.length > 0 ? owned[0] : 0; // ascending list: the lowest owned level (A64)
}

/**
 * A61(5)/(6): charges an eidolon extra to a team: the character budget first (floored at 0, so EMPTY nominations at
 * cost 0 stay possible), the remainder from the light-cone budget. Returns the new budgets. Callers guard
 * extra ≤ character + light-cone budget first; the light-cone clamp is defensive and logs a warning.
 */
export function chargeExtra(session: any, side: string, extra: number): { charBudget: number; lcBudget: number } {
    const charBudget = side === 'Blue' ? session.teamBlueCharBudget : session.teamRedCharBudget;
    const lcBudget = side === 'Blue' ? session.teamBlueLcBudget : session.teamRedLcBudget;
    const fromChar = Math.min(Math.max(charBudget, 0), Math.max(extra, 0));
    let newLc = lcBudget - (Math.max(extra, 0) - fromChar);
    if (newLc < 0) {
        console.log(`[AUCTION] chargeExtra: ${side} light-cone budget would go negative (${newLc}); clamped to 0`);
        newLc = 0;
    }
    return { charBudget: Math.max(0, charBudget - fromChar), lcBudget: newLc };
}

/** A61(2): under requireOwnership a team may nominate or bid only on a character one of its selected accounts owns (EMPTY exempt). */
function ensureTeamOwnsCharacter(ctx: any, lobby: any, side: string, characterName: string): void {
    if (!lobby.requireOwnership || characterName === 'EMPTY') return;
    if (teamOwnedEidolons(ctx, lobby.id, side, characterName).length === 0) {
        throw new SenderError('Your team does not own this character on any selected account.');
    }
}

/** A61(4): amount + the team's eidolon extra must fit the total remaining budget (character + light cones). */
function ensureTotalBudgetFits(ctx: any, lobby: any, session: any, side: string, characterName: string, amount: number): void {
    const extra = auctionEidolonExtra(ctx, lobby, characterName, teamDefaultEidolon(ctx, lobby, side, characterName));
    const total = side === 'Blue'
        ? session.teamBlueCharBudget + session.teamBlueLcBudget
        : session.teamRedCharBudget + session.teamRedLcBudget;
    if (amount + extra > total) {
        throw new SenderError('Not enough total budget: the eidolon extra for this character would exceed it.');
    }
}

/**
 * A61(3)(5): the sale. The winning team's default eidolon and its extra are resolved now (never from the Nominate
 * step); the winning amount comes out of the character budget (bids are capped by it), then the extra through
 * chargeExtra. Returns the AuctionSold payload values and the winner's new budgets.
 */
function resolveSale(ctx: any, lobby: any, session: any, winningSide: string, characterName: string, winningAmount: number) {
    const eidolon = winningSide === 'Blue' || winningSide === 'Red' ? teamDefaultEidolon(ctx, lobby, winningSide, characterName) : 0;
    const eidolonCost = auctionEidolonExtra(ctx, lobby, characterName, eidolon);
    // A61(4)/(5): bids are capped by the character budget, so the winning amount always fits; a winning amount above
    // it means the budget backing the bid was spent elsewhere: reject instead of clamping.
    if (winningSide === 'Blue' || winningSide === 'Red') {
        const charBudget = winningSide === 'Blue' ? session.teamBlueCharBudget : session.teamRedCharBudget;
        if (winningAmount > charBudget) throw new SenderError(`Winning amount exceeds the ${winningSide} character budget.`);
    }
    const afterBid = {
        ...session,
        teamBlueCharBudget: winningSide === 'Blue' ? session.teamBlueCharBudget - winningAmount : session.teamBlueCharBudget,
        teamRedCharBudget: winningSide === 'Red' ? session.teamRedCharBudget - winningAmount : session.teamRedCharBudget,
    };
    const budgets = winningSide === 'Blue' || winningSide === 'Red'
        ? chargeExtra(afterBid, winningSide, eidolonCost)
        : undefined;
    return {
        eidolon,
        eidolonCost,
        teamBlueCharBudget: winningSide === 'Blue' ? budgets!.charBudget : afterBid.teamBlueCharBudget,
        teamRedCharBudget: winningSide === 'Red' ? budgets!.charBudget : afterBid.teamRedCharBudget,
        teamBlueLcBudget: winningSide === 'Blue' ? budgets!.lcBudget : session.teamBlueLcBudget,
        teamRedLcBudget: winningSide === 'Red' ? budgets!.lcBudget : session.teamRedLcBudget,
    };
}

// ─── Helper: Check auction end condition ────────────────────────────────────
// Per D-48, as amended by A21: each team drafts charactersPerTeam(lineupFormat) characters, 8 for Halves
// and 12 for Thirds ("the character count is the format"), not teamSize.
// teamSize only controls how many human players share the draft.

function isAuctionComplete(session: any, lobby: any): boolean {
    const targetCount = charactersPerTeam(lobby.lineupFormat.tag as LineupFormatTag);
    return (
        session.blueCharactersWon >= targetCount &&
        session.redCharactersWon >= targetCount
    );
}

// ─── nominate_character ──────────────────────────────────────────────────────
// Per D-47/D-48/D-53: Nomination sets the character at base cost from cost table.
// The nominating team is automatically the first bidder at base cost.
// A61(1): the base cost is the E0 cost (no eidolon argument); A61(2) under requireOwnership the nominating team
// must own the character; A61(4) base cost + the team's eidolon extra must fit its total remaining budget.

export const nominate_character = spacetimedb.reducer(
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

        // A61(2): ownership on nominations (the nominating team's selected accounts; EMPTY exempt).
        const side = slotTeam(member.lobbySlot)!;
        ensureTeamOwnsCharacter(ctx, lobby, side, characterName);

        // Per D-53 / A61(1): base cost = the E0 cost from the cost table
        const baseCost = getCharacterBaseCost(ctx, characterName, lobby.costSetId, lobby.gameMode);

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
        // A61(4): base cost + the team's eidolon extra within the total remaining budget.
        ensureTotalBudgetFits(ctx, lobby, session, side, characterName, baseCost);

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
                value: { characterName },
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
            `[AUCTION] nominate_character: User #${user.id} (${slotTeam(member.lobbySlot)}) nominated '${characterName}' at base cost ${baseCost} in lobby #${lobbyId}`
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

        // A22(3): no draft action while the draft is paused
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is paused.');
        }

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

        // A61(2): ownership on bids (the bidding team's selected accounts; EMPTY exempt).
        const side = slotTeam(member.lobbySlot)!;
        ensureTeamOwnsCharacter(ctx, lobby, side, session.currentNomination);

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
        // A61(4): bid + the bidding team's eidolon extra within the total remaining budget.
        ensureTotalBudgetFits(ctx, lobby, session, side, session.currentNomination, bidAmount);

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

        // A22(3): no draft action while the draft is paused
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is paused.');
        }

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

        // Find the most recent Nominate step for this character (the active nomination): its team only (A61: the
        // eidolon is no longer read from it).
        const allSteps = gameSteps(ctx, lobbyId);
        const nominateStep = allSteps
            .filter(
                (s: any) =>
                    s.action.tag === 'Nominate' &&
                    s.payload.tag === 'Nominate' &&
                    s.payload.value.characterName === nominatedChar
            )
            .sort((a: any, b: any) => b.sequence - a.sequence)[0];

        // Find the nominating team from the Nominate step
        const nominatingTeam = nominateStep ? nominateStep.actorSlot : session.nextNominatorTeam;

        // A61(3)(5), A64: the winning team's default (lowest owned) eidolon and extra, charged now (character budget first).
        const sale = resolveSale(ctx, lobby, session, winningTeam.tag, nominatedChar, winningAmount);

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
                    eidolon: sale.eidolon,
                    eidolonCost: sale.eidolonCost,
                },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // Deduct budget from winning team (winning amount + A61 eidolon extra, see resolveSale)
        const newBlueCharBudget = sale.teamBlueCharBudget;
        const newRedCharBudget = sale.teamRedCharBudget;
        let newBlueCharactersWon = session.blueCharactersWon;
        let newRedCharactersWon = session.redCharactersWon;

        if (winningTeam.tag === 'Blue') {
            newBlueCharactersWon += 1;
        } else {
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
        const auctionComplete = isAuctionComplete(updatedSessionForCheck, lobby);

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
                teamBlueLcBudget: sale.teamBlueLcBudget + finalBlueCharBudget,
                teamRedLcBudget: sale.teamRedLcBudget + finalRedCharBudget,
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
                teamBlueLcBudget: sale.teamBlueLcBudget,
                teamRedLcBudget: sale.teamRedLcBudget,
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

        // F3: only a lobby member may fire the expiry (contract :162), and never while the draft is paused
        ensureLobbyMember(ctx, lobbyId, user.id);
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is paused.');
        }

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
                    value: { characterName: 'EMPTY' },
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

            // The nominating team from the Nominate step (A61: the eidolon is no longer read from it)
            const allSteps = gameSteps(ctx, lobbyId);
            const nominateStep = allSteps
                .filter(
                    (s: any) =>
                        s.action.tag === 'Nominate' &&
                        s.payload.tag === 'Nominate' &&
                        s.payload.value.characterName === nominatedChar
                )
                .sort((a: any, b: any) => b.sequence - a.sequence)[0];

            const nominatingTeam = nominateStep ? nominateStep.actorSlot : session.nextNominatorTeam;

            // A61(3)(5), A64: the winning team's default (lowest owned) eidolon and extra, charged now (character budget first).
            const sale = resolveSale(ctx, lobby, session, winningTeam.tag, nominatedChar, winningAmount);

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
                        eidolon: sale.eidolon,
                        eidolonCost: sale.eidolonCost,
                    },
                } as any,
                timestamp: ctx.timestamp,
            }));

            // Deduct budget (winning amount + A61 eidolon extra, see resolveSale) and increment won count
            const newBlueCharBudget = sale.teamBlueCharBudget;
            const newRedCharBudget = sale.teamRedCharBudget;
            let newBlueCharactersWon = session.blueCharactersWon;
            let newRedCharactersWon = session.redCharactersWon;

            if (winningTeam.tag === 'Blue') {
                newBlueCharactersWon += 1;
            } else if (winningTeam.tag === 'Red') {
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
            const auctionComplete = isAuctionComplete(updatedSessionForCheck, lobby);

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
                    teamBlueLcBudget: sale.teamBlueLcBudget + finalBlueChar,
                    teamRedLcBudget: sale.teamRedLcBudget + finalRedChar,
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
                    teamBlueLcBudget: sale.teamBlueLcBudget,
                    teamRedLcBudget: sale.teamRedLcBudget,
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
