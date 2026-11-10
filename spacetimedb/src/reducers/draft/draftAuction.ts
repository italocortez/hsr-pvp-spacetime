import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureLobbyMember, ensureStageIs, slotTeam, slotIsCoach, slotToTeamSide } from '@module/helpers/lobby/lobbyHelpers';
import { ensureMatchAlive } from '@module/helpers/lobby/disconnectHelpers';
import { lobbySteps, getNextSequence } from '@module/helpers/draft/stepSequence';
import { teamOwnedEidolons } from '@module/helpers/draft/ownershipValidation';
import { charactersPerTeam, type LineupFormatTag } from '@shared/scoring';


// ─── Helper: Get set of characters already won via AuctionSold ──────────────
// Auction characters are ALWAYS exclusive (D-42).
// Returns a Set of characterNames that have already been awarded via AuctionSold.

function getAuctionWonCharacters(ctx: any, lobbyId: number): Set<string> {
    const steps = lobbySteps(ctx, lobbyId);
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
    const steps = lobbySteps(ctx, lobbyId);
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

/** A81(1): a team is full once it holds charactersPerTeam characters in the current game. */
function teamIsFull(session: any, lobby: any, side: string): boolean {
    const targetCount = charactersPerTeam(lobby.lineupFormat.tag as LineupFormatTag);
    const won = side === 'Blue' ? session.blueCharactersWon : side === 'Red' ? session.redCharactersWon : 0;
    return won >= targetCount;
}

function otherTeamTag(side: string): 'Blue' | 'Red' {
    return side === 'Blue' ? 'Red' : 'Blue';
}

/** A81(3): the auction ends when both teams are full (unchanged). */
function isAuctionComplete(session: any, lobby: any): boolean {
    return teamIsFull(session, lobby, 'Blue') && teamIsFull(session, lobby, 'Red');
}

/**
 * The sale of the active nomination, shared by pass_bid, the timer sale and the A81(2) immediate sale: the AuctionSold
 * step, the winner's budgets (resolveSale), the won counts, the D-46 rotation (A81(1): a full team is skipped), the end
 * check with the D-50 rollover, and the session / lobby writes. Returns the next nominator and whether the auction ended.
 */
function completeSale(
    ctx: any,
    lobby: any,
    session: any,
    sale: {
        characterName: string;
        winningTeam: any;
        winningAmount: number;
        nominatingTeamTag: string;
        actorUserId: number;
        actorSlot: any;
        auditUserId: number;
    },
): { nextNominatorTeam: any; auctionComplete: boolean } {
    const { characterName, winningTeam, winningAmount, nominatingTeamTag, actorUserId, actorSlot, auditUserId } = sale;
    const lobbyId = lobby.id;

    // A61(3)(5), A64: the winning team's default (lowest owned) eidolon and extra, charged now (character budget first).
    const budgets = resolveSale(ctx, lobby, session, winningTeam.tag, characterName, winningAmount);

    ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
        id: 0,
        lobbyId,
        sequence: getNextSequence(ctx, lobbyId),
        actorUserId,
        anonymousLabel: undefined,
        actorSlot,
        action: { tag: 'AuctionSold', value: {} } as any,
        payload: {
            tag: 'AuctionSold',
            value: {
                characterName,
                winningAmount,
                winningTeam,
                eidolon: budgets.eidolon,
                eidolonCost: budgets.eidolonCost,
            },
        } as any,
        timestamp: ctx.timestamp,
    }, auditUserId));

    let blueCharactersWon = session.blueCharactersWon;
    let redCharactersWon = session.redCharactersWon;
    if (winningTeam.tag === 'Blue') blueCharactersWon += 1;
    else if (winningTeam.tag === 'Red') redCharactersWon += 1;
    const counts = { ...session, blueCharactersWon, redCharactersWon };
    const auctionComplete = isAuctionComplete(counts, lobby);

    // ─── Steal-skip logic (D-46) ──────────────────────────────────────────
    // Normal: if nominating team === winning team → other team nominates next.
    // Steal:  if nominating team !== winning team → nominating team nominates again.
    // A81(1): a full team never takes the nomination; it passes to the other team.
    let nextTag = nominatingTeamTag === winningTeam.tag ? otherTeamTag(nominatingTeamTag) : nominatingTeamTag;
    if (!auctionComplete && teamIsFull(counts, lobby, nextTag)) nextTag = otherTeamTag(nextTag);
    const nextNominatorTeam = { tag: nextTag, value: {} } as any;

    // D-50: on completion the leftover character budget rolls over into the light-cone budget.
    ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
        currentNomination: undefined,
        currentBidAmount: undefined,
        currentBidTeam: { tag: 'Spectator', value: {} } as any,
        teamBlueCharBudget: auctionComplete ? 0 : budgets.teamBlueCharBudget,
        teamRedCharBudget: auctionComplete ? 0 : budgets.teamRedCharBudget,
        teamBlueLcBudget: budgets.teamBlueLcBudget + (auctionComplete ? budgets.teamBlueCharBudget : 0),
        teamRedLcBudget: budgets.teamRedLcBudget + (auctionComplete ? budgets.teamRedCharBudget : 0),
        blueCharactersWon,
        redCharactersWon,
        nextNominatorTeam,
        timerState: {
            ...session.timerState,
            turnStartAt: ctx.timestamp,
            accumulatedPauseMs: 0,
        },
    }, auditUserId));

    ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, auctionComplete
        ? { stage: { tag: 'Equipping', value: {} } as any, lastActivityAt: ctx.timestamp }
        : { lastActivityAt: ctx.timestamp }, auditUserId));

    if (auctionComplete) {
        console.log(`[AUCTION] Auction complete! Both teams reached target count. Lobby #${lobbyId} → Equipping.`);
    }
    return { nextNominatorTeam, auctionComplete };
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

        // A81(1): a full team sits out of the auction.
        if (teamIsFull(session, lobby, slotTeam(member.lobbySlot)!)) {
            throw new SenderError('Your team already has all its characters.');
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

        // A81(2): while the other team is full, the nomination sells to the nominating team at once at base cost
        // (no bidding round); the budget checks above apply unchanged.
        if (teamIsFull(session, lobby, otherTeamTag(side))) {
            completeSale(ctx, lobby, session, {
                characterName,
                winningTeam: slotToTeamSide(member.lobbySlot),
                winningAmount: baseCost,
                nominatingTeamTag: side,
                actorUserId: user.id,
                actorSlot: slotToTeamSide(member.lobbySlot),
                auditUserId: user.id,
            });
            console.log(
                `[AUCTION] nominate_character: User #${user.id} (${side}) nominated '${characterName}'; sold at once at base cost ${baseCost} (the other team is full) in lobby #${lobbyId}`
            );
            return;
        }

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
        // NaN fails every < / > guard below, so reject it (and negatives) before any other use.
        if (!Number.isFinite(bidAmount) || bidAmount < 0) {
            throw new SenderError('bidAmount must be a finite, non-negative number.');
        }
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

        // A81(1): a full team sits out of the auction.
        if (teamIsFull(session, lobby, slotTeam(member.lobbySlot)!)) {
            throw new SenderError('Your team already has all its characters.');
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
        const allSteps = lobbySteps(ctx, lobbyId);
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

        const { nextNominatorTeam } = completeSale(ctx, lobby, session, {
            characterName: nominatedChar,
            winningTeam,
            winningAmount,
            nominatingTeamTag: nominatingTeam.tag,
            actorUserId: user.id,
            actorSlot: slotToTeamSide(member.lobbySlot),
            auditUserId: user.id,
        });

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

        if (!session.currentNomination) {
            // ─── Nomination phase: auto-nominate EMPTY CHARACTER (D-43/D-54) ───
            const nextSeq = getNextSequence(ctx, lobbyId);
            // A81(1): a full team never nominates; the turn falls to the other team.
            // Defensive: unreachable through the reducers today (the rotation never leaves a full nominator).
            const nominatingTeam = teamIsFull(session, lobby, session.nextNominatorTeam.tag)
                ? { tag: otherTeamTag(session.nextNominatorTeam.tag), value: {} } as any
                : session.nextNominatorTeam;
            const baseCost = 0; // EMPTY CHARACTER always 0-cost

            // Insert Nominate step for EMPTY CHARACTER
            ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
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

            // A81(2): while the other team is full, the nomination sells to the nominating team at once at base cost.
            if (teamIsFull(session, lobby, otherTeamTag(nominatingTeam.tag))) {
                completeSale(ctx, lobby, session, {
                    characterName: 'EMPTY',
                    winningTeam: nominatingTeam,
                    winningAmount: baseCost,
                    nominatingTeamTag: nominatingTeam.tag,
                    actorUserId: 0, // System actor
                    actorSlot: { tag: 'Spectator', value: {} } as any, // System resolution
                    auditUserId: 0,
                });
                console.log(
                    `[AUCTION] timer_expiry_auction: Auto-nominated EMPTY CHARACTER for ${nominatingTeam.tag}; sold at once (the other team is full) in lobby #${lobbyId}`
                );
                return;
            }

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
            const allSteps = lobbySteps(ctx, lobbyId);
            const nominateStep = allSteps
                .filter(
                    (s: any) =>
                        s.action.tag === 'Nominate' &&
                        s.payload.tag === 'Nominate' &&
                        s.payload.value.characterName === nominatedChar
                )
                .sort((a: any, b: any) => b.sequence - a.sequence)[0];

            const nominatingTeam = nominateStep ? nominateStep.actorSlot : session.nextNominatorTeam;

            completeSale(ctx, lobby, session, {
                characterName: nominatedChar,
                winningTeam,
                winningAmount,
                nominatingTeamTag: nominatingTeam.tag,
                actorUserId: 0, // System actor
                actorSlot: { tag: 'Spectator', value: {} } as any, // System resolution
                auditUserId: 0,
            });

            console.log(
                `[AUCTION] timer_expiry_auction: Auto-passed bid. '${nominatedChar}' sold to ${winningTeam.tag} for ${winningAmount} in lobby #${lobbyId}.`
            );
        }
    }
);
