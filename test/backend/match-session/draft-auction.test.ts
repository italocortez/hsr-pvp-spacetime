/**
 * Integration tests for the Auction draft system.
 *
 * Covers:
 * - Auction start: BanMode=None (immediate auction), BanMode=Four (ban phase first)
 * - nominate_character: turn enforcement, banned char guard, double-nomination guard
 * - place_bid: opposing bid, same-team rejection, minimum raise, budget cap
 * - pass_bid: concession / AuctionSold, same-team rejection, steal-skip logic
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Known flaky: "banned character cannot be nominated" can timeout (60s) under
 * full-suite load due to heavy lobby+draft setup on maincloud. Passes in isolation.
 *
 * Contract: docs/match-session/contract.md — Match Session (Draft System)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs } from '../../shared/helpers/lobbies';
import { startDraftAndSync } from '../../shared/helpers/drafts';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get MatchSession for a lobby */
function getSession(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.MatchSession.iter()].find(s => s.lobbyId === lobbyId);
}

/** Get MatchSessionSteps for a lobby, sorted by sequence */
function getSteps(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.MatchSessionStep.iter()]
        .filter(s => s.lobbyId === lobbyId)
        .sort((a, b) => a.sequence - b.sequence);
}

/** Set up a lobby ready for draft: host + blue + red, all confirmed */
async function setupDraftLobby(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    lobbyOverrides: Record<string, unknown> = {},
) {
    await host.call.createLobby(defaultLobbyArgs(lobbyOverrides));
    await host.sync(1500);
    const lobbies = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId);
    const lobby = lobbies[lobbies.length - 1];

    await blue.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await blue.sync();
    await blue.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
    await blue.sync();

    await red.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await red.sync();
    await red.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
    await red.sync();

    await blue.call.confirmReady({ lobbyId: lobby.id });
    await blue.sync();
    await red.call.confirmReady({ lobbyId: lobby.id });
    await red.sync();
    await host.sync();

    return lobby.id;
}


// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Auction Draft', () => {

    // ─── auction start with bans ───────────────────────────────────────

    describe('auction start with bans', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();
        }, 30000);

        afterAll(async () => {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('starts auction draft with BanMode=None — no ban phase', async () => {
            const lobbyId = await setupDraftLobby(host, blue, red, {
                draftMode: { tag: 'Auction' as const, value: {} },
                banMode: { tag: 'None' as const, value: {} },
            });
            await startDraftAndSync(host, blue, red, lobbyId);

            // MatchSession should exist
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();

            // With BanMode=None the draft sequence is empty → isAuctionPhase immediately true
            expect(session!.isAuctionPhase).toBe(true);
            expect(session!.draftSequence.length).toBe(0);

            // Lobby stage should be Drafting
            const lobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
            expect(lobby).toBeDefined();
            expect(lobby!.stage.tag).toBe('Drafting');

            // First nominator is Blue
            expect(session!.nextNominatorTeam.tag).toBe('Blue');

            // Cleanup: leave lobby so next test can create a new one
            for (const h of [blue, red, host]) {
                try { await h.call.leaveLobby({ lobbyId }); await h.sync(1000); } catch { /* ok */ }
            }
        }, 45000);

        it('starts auction draft with BanMode=Four — ban phase first', async () => {
            const lobbyId = await setupDraftLobby(host, blue, red, {
                draftMode: { tag: 'Auction' as const, value: {} },
                banMode: { tag: 'Four' as const, value: {} },
            });
            await startDraftAndSync(host, blue, red, lobbyId);

            // MatchSession should exist with ban sequence
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            expect(session!.draftSequence.length).toBe(4);

            // Auction phase NOT active yet (ban phase first)
            expect(session!.isAuctionPhase).toBe(false);

            // First step is Ban for Blue
            expect(session!.draftSequence[0].actionRequired.tag).toBe('Ban');
            expect(session!.draftSequence[0].teamTurn.tag).toBe('Blue');

            // Execute 4 bans: Blue, Red, Red, Blue
            await blue.call.banCharacter({ lobbyId, characterName: 'acheron' });
            await blue.sync(1500);
            await host.sync(1500);
            await red.sync(1500);

            await red.call.banCharacter({ lobbyId, characterName: 'aglaea' });
            await red.sync(1500);
            await host.sync(1500);
            await blue.sync(1500);

            await red.call.banCharacter({ lobbyId, characterName: 'anaxa' });
            await red.sync(1500);
            await host.sync(1500);
            await blue.sync(1500);

            await blue.call.banCharacter({ lobbyId, characterName: 'archer' });
            await blue.sync(1500);
            await host.sync(1500);
            await red.sync(1500);

            // After 4 bans, auction phase should activate
            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.isAuctionPhase).toBe(true);
            expect(sessionAfter!.turnIndex).toBe(4);
        }, 60000);
    });

    // ─── nominate_character ────────────────────────────────────────────

    describe('nominate_character', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let lobbyId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            // Create Auction lobby with BanMode=None (immediate auction phase)
            lobbyId = await setupDraftLobby(host, blue, red, {
                draftMode: { tag: 'Auction' as const, value: {} },
                banMode: { tag: 'None' as const, value: {} },
            });
            await startDraftAndSync(host, blue, red, lobbyId);
        }, 45000);

        afterAll(async () => {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('nominates a character', async () => {
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            expect(session!.isAuctionPhase).toBe(true);
            expect(session!.nextNominatorTeam.tag).toBe('Blue');

            // Blue nominates
            await blue.call.nominateCharacter({ lobbyId, characterName: 'argenti', eidolon: 0 });
            await blue.sync(1500);
            await host.sync(1500);

            // Verify a Nominate step was recorded
            const steps = getSteps(host, lobbyId);
            const nominateStep = steps.find(
                s => s.action.tag === 'Nominate' &&
                     s.payload.tag === 'Nominate' &&
                     s.payload.value.characterName === 'argenti'
            );
            expect(nominateStep).toBeDefined();
            expect(nominateStep!.actorUserId).toBe(blue.userId);
            expect(nominateStep!.actorSlot.tag).toBe('Blue');

            // MatchSession should have currentNomination set
            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.currentNomination).toBe('argenti');
            expect(sessionAfter!.currentBidTeam.tag).toBe('Blue');
        }, 15000);

        it("wrong team's turn rejected", async () => {
            // Blue is the nominator; Red tries to nominate
            // Note: there's an active auction from the previous test, so we need to
            // resolve it first. Red passes to concede to Blue's nomination.
            await red.call.passBid({ lobbyId });
            await red.sync(1500);
            await blue.sync(1500);
            await host.sync(1500);

            // After Blue wins argenti, next nominator rotates to Red
            const session = getSession(host, lobbyId);
            expect(session!.nextNominatorTeam.tag).toBe('Red');

            // Blue tries to nominate when it's Red's turn
            const err = await expectReducerError(
                blue.call.nominateCharacter({ lobbyId, characterName: 'aglaea', eidolon: 0 })
            );
            expect(err).toContain('It is not your team\'s turn to nominate.');
        }, 15000);

        it('banned character cannot be nominated', async () => {
            // Need a separate lobby with BanMode=Four so we have banned characters
            const h2 = await createVerifiedTestHarness();
            const b2 = await createVerifiedTestHarness();
            const r2 = await createVerifiedTestHarness();
            await h2.sync(); await b2.sync(); await r2.sync();

            const lid = await setupDraftLobby(h2, b2, r2, {
                draftMode: { tag: 'Auction' as const, value: {} },
                banMode: { tag: 'Four' as const, value: {} },
            });
            await startDraftAndSync(h2, b2, r2, lid);

            // Execute 4 bans: Blue, Red, Red, Blue
            await b2.call.banCharacter({ lobbyId: lid, characterName: 'acheron' });
            await b2.sync(1500); await h2.sync(1500); await r2.sync(1500);

            await r2.call.banCharacter({ lobbyId: lid, characterName: 'aglaea' });
            await r2.sync(1500); await h2.sync(1500); await b2.sync(1500);

            await r2.call.banCharacter({ lobbyId: lid, characterName: 'anaxa' });
            await r2.sync(1500); await h2.sync(1500); await b2.sync(1500);

            await b2.call.banCharacter({ lobbyId: lid, characterName: 'archer' });
            await b2.sync(1500); await h2.sync(1500); await r2.sync(1500);

            // Auction phase should be active
            const session = getSession(h2, lid);
            expect(session!.isAuctionPhase).toBe(true);

            // Blue (first nominator) tries to nominate banned character 'acheron'
            const err = await expectReducerError(
                b2.call.nominateCharacter({ lobbyId: lid, characterName: 'acheron', eidolon: 0 })
            );
            expect(err).toContain('Character is banned and cannot be nominated.');

            await h2.disconnect(); await b2.disconnect(); await r2.disconnect();
        }, 60000);

        it('auction already in progress rejected', async () => {
            // Back in the main lobby: Red is the current nominator (after Blue won argenti).
            // Red nominates a character.
            await red.call.nominateCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 });
            await red.sync(1500);
            await blue.sync(1500);
            await host.sync(1500);

            // Red tries to nominate again while acheron auction is in progress
            const err = await expectReducerError(
                red.call.nominateCharacter({ lobbyId, characterName: 'aglaea', eidolon: 0 })
            );
            expect(err).toContain('An auction is already in progress.');

            // Resolve the auction so state is clean for other test groups
            await blue.call.passBid({ lobbyId });
            await blue.sync(1500);
            await red.sync(1500);
            await host.sync(1500);
        }, 15000);
    });

    // ─── place_bid ─────────────────────────────────────────────────────

    describe('place_bid', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let lobbyId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            lobbyId = await setupDraftLobby(host, blue, red, {
                draftMode: { tag: 'Auction' as const, value: {} },
                banMode: { tag: 'None' as const, value: {} },
                minimumBidRaise: 0.5,
                characterBudget: 100,
            });
            await startDraftAndSync(host, blue, red, lobbyId);
        }, 45000);

        afterAll(async () => {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('opposing team places valid bid', async () => {
            // Blue nominates
            await blue.call.nominateCharacter({ lobbyId, characterName: 'argenti', eidolon: 0 });
            await blue.sync(1500);
            await host.sync(1500);
            await red.sync(1500);

            // Get the current bid amount (base cost from nomination)
            const sessionBefore = getSession(host, lobbyId);
            const baseCost = sessionBefore!.currentBidAmount ?? 0;

            // Red bids: base + minimumBidRaise
            const bidAmount = baseCost + 0.5;
            await red.call.placeBid({ lobbyId, bidAmount });
            await red.sync(1500);
            await host.sync(1500);
            await blue.sync(1500);

            // Verify a Bid step was recorded
            const steps = getSteps(host, lobbyId);
            const bidStep = steps.find(
                s => s.action.tag === 'Bid' &&
                     s.payload.tag === 'Bid'
            );
            expect(bidStep).toBeDefined();
            expect(bidStep!.actorSlot.tag).toBe('Red');

            // Session should reflect the new bid
            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.currentBidAmount).toBeCloseTo(bidAmount, 1);
            expect(sessionAfter!.currentBidTeam.tag).toBe('Red');

            // Resolve: Blue passes, Red wins
            await blue.call.passBid({ lobbyId });
            await blue.sync(1500);
            await red.sync(1500);
            await host.sync(1500);
        }, 20000);

        it('same team bid rejected', async () => {
            // Determine who nominates next
            const session = getSession(host, lobbyId);
            const nominator = session!.nextNominatorTeam.tag;

            // The team that nominates also holds the first bid.
            if (nominator === 'Blue') {
                await blue.call.nominateCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 });
                await blue.sync(1500);
                await host.sync(1500);

                // Blue holds the bid; Blue tries to bid again
                const err = await expectReducerError(
                    blue.call.placeBid({ lobbyId, bidAmount: 50 })
                );
                expect(err).toContain('Your team already holds the current bid.');

                // Resolve
                await red.call.passBid({ lobbyId });
                await red.sync(1500); await blue.sync(1500); await host.sync(1500);
            } else {
                await red.call.nominateCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 });
                await red.sync(1500);
                await host.sync(1500);

                // Red holds the bid; Red tries to bid again
                const err = await expectReducerError(
                    red.call.placeBid({ lobbyId, bidAmount: 50 })
                );
                expect(err).toContain('Your team already holds the current bid.');

                // Resolve
                await blue.call.passBid({ lobbyId });
                await blue.sync(1500); await red.sync(1500); await host.sync(1500);
            }
        }, 20000);

        it('bid below minimum raise rejected', async () => {
            // Determine who nominates next
            const session = getSession(host, lobbyId);
            const nominator = session!.nextNominatorTeam.tag;
            const [nominatorH, opposingH] = nominator === 'Blue' ? [blue, red] : [red, blue];

            await nominatorH.call.nominateCharacter({ lobbyId, characterName: 'aglaea', eidolon: 0 });
            await nominatorH.sync(1500);
            await host.sync(1500);
            await opposingH.sync(1500);

            const sessionNow = getSession(host, lobbyId);
            const currentBid = sessionNow!.currentBidAmount ?? 0;

            // Bid less than current + minimumBidRaise (0.5)
            const lowBid = currentBid + 0.1;
            const err = await expectReducerError(
                opposingH.call.placeBid({ lobbyId, bidAmount: lowBid })
            );
            expect(err).toContain('Bid must be at least');

            // Resolve: opposing passes
            await opposingH.call.passBid({ lobbyId });
            await opposingH.sync(1500); await nominatorH.sync(1500); await host.sync(1500);
        }, 20000);

        it('bid exceeding budget rejected', async () => {
            // Create a low-budget lobby to test budget cap
            const h2 = await createVerifiedTestHarness();
            const b2 = await createVerifiedTestHarness();
            const r2 = await createVerifiedTestHarness();
            await h2.sync(); await b2.sync(); await r2.sync();

            const lid = await setupDraftLobby(h2, b2, r2, {
                draftMode: { tag: 'Auction' as const, value: {} },
                banMode: { tag: 'None' as const, value: {} },
                characterBudget: 10,
                minimumBidRaise: 0.5,
            });
            await startDraftAndSync(h2, b2, r2, lid);

            // Blue nominates
            await b2.call.nominateCharacter({ lobbyId: lid, characterName: 'argenti', eidolon: 0 });
            await b2.sync(1500);
            await h2.sync(1500);
            await r2.sync(1500);

            // Red tries to bid 20 (exceeds budget of 10)
            const err = await expectReducerError(
                r2.call.placeBid({ lobbyId: lid, bidAmount: 20 })
            );
            expect(err).toContain('Bid exceeds your remaining character budget.');

            await h2.disconnect(); await b2.disconnect(); await r2.disconnect();
        }, 45000);
    });

    // ─── pass_bid ──────────────────────────────────────────────────────

    describe('pass_bid', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let lobbyId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            lobbyId = await setupDraftLobby(host, blue, red, {
                draftMode: { tag: 'Auction' as const, value: {} },
                banMode: { tag: 'None' as const, value: {} },
                minimumBidRaise: 0.5,
                characterBudget: 100,
            });
            await startDraftAndSync(host, blue, red, lobbyId);
        }, 45000);

        afterAll(async () => {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('pass concedes to current bidder', async () => {
            // Blue nominates argenti
            await blue.call.nominateCharacter({ lobbyId, characterName: 'argenti', eidolon: 0 });
            await blue.sync(1500);
            await host.sync(1500);
            await red.sync(1500);

            const sessionBefore = getSession(host, lobbyId);
            const blueBudgetBefore = sessionBefore!.teamBlueCharBudget;
            const bidAmount = sessionBefore!.currentBidAmount ?? 0;

            // Red passes — Blue wins the character at bidAmount
            await red.call.passBid({ lobbyId });
            await red.sync(1500);
            await blue.sync(1500);
            await host.sync(1500);

            // AuctionSold step should exist
            const steps = getSteps(host, lobbyId);
            const soldStep = steps.find(
                s => s.action.tag === 'AuctionSold' &&
                     s.payload.tag === 'AuctionSold' &&
                     s.payload.value.characterName === 'argenti'
            );
            expect(soldStep).toBeDefined();
            expect((soldStep!.payload.value as any).winningTeam.tag).toBe('Blue');

            // Budget should be deducted from Blue
            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.teamBlueCharBudget).toBeCloseTo(blueBudgetBefore - bidAmount, 1);
            expect(sessionAfter!.blueCharactersWon).toBe(1);

            // Auction state cleared
            expect(sessionAfter!.currentNomination).toBeUndefined();
        }, 20000);

        it('passing team holds the bid rejected', async () => {
            // Blue nominated and won argenti in the previous test.
            // Next nominator should be Red (normal rotation).
            const session = getSession(host, lobbyId);
            const nominator = session!.nextNominatorTeam.tag;
            const [nominatorH, bidHolderH] = nominator === 'Blue' ? [blue, red] : [red, blue];

            // Nominator nominates — they hold the initial bid
            await nominatorH.call.nominateCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 });
            await nominatorH.sync(1500);
            await host.sync(1500);
            await bidHolderH.sync(1500);

            // The nominating team holds the bid; they try to pass
            const err = await expectReducerError(
                nominatorH.call.passBid({ lobbyId })
            );
            expect(err).toContain('Your team holds the current bid.');

            // Resolve: opposing team passes to concede
            await bidHolderH.call.passBid({ lobbyId });
            await bidHolderH.sync(1500); await nominatorH.sync(1500); await host.sync(1500);
        }, 20000);

        it('steal-skip: opponent wins, nominator keeps turn', async () => {
            // Steal-skip: when the opponent outbids and wins, the original
            // nominator keeps the next nomination turn.
            const session = getSession(host, lobbyId);
            const nominatorTag = session!.nextNominatorTeam.tag;
            const [nominatorH, opponentH] = nominatorTag === 'Blue' ? [blue, red] : [red, blue];

            // Nominator nominates aglaea
            await nominatorH.call.nominateCharacter({ lobbyId, characterName: 'aglaea', eidolon: 0 });
            await nominatorH.sync(1500);
            await host.sync(1500);
            await opponentH.sync(1500);

            // Opponent outbids
            const sessionNow = getSession(host, lobbyId);
            const currentBid = sessionNow!.currentBidAmount ?? 0;
            await opponentH.call.placeBid({ lobbyId, bidAmount: currentBid + 1 });
            await opponentH.sync(1500);
            await nominatorH.sync(1500);
            await host.sync(1500);

            // Nominator passes — opponent wins the character (steal)
            await nominatorH.call.passBid({ lobbyId });
            await nominatorH.sync(1500);
            await opponentH.sync(1500);
            await host.sync(1500);

            // Steal-skip: nominator should keep their turn
            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.nextNominatorTeam.tag).toBe(nominatorTag);
        }, 20000);
    });
});
