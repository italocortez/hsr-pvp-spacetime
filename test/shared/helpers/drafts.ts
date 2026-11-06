/**
 * Shared draft-completion helpers.
 *
 * Exports:
 *   - startDraftAndSync: host calls start_draft, all harnesses sync
 *   - completeDraft: 16-pick Classic BanMode=None draft with snake order,
 *     distinct characters per team (safe for any roster config)
 *   - completeTournamentDraft: 4-ban + 16-pick Classic BanMode=Four draft
 *     for tournament lobbies
 *   - advanceToScoring: Drafting(confirmLineup x2) → Equipping(advanceStage) →
 *     Scoring (5 calls)
 */

import type { TestHarness } from '../connection';

/** Default blue-side pick order for BanMode=None Classic (8 unique characters) */
const DEFAULT_BLUE_CHARS = ['acheron', 'aglaea', 'anaxa', 'archer', 'argenti', 'arlan', 'asta', 'aventurine'];

/** Default red-side pick order (disjoint from blue for no-mirror-pick configs) */
const DEFAULT_RED_CHARS = ['bailu', 'blackswan', 'blade', 'boothill', 'bronya', 'castorice', 'cerydra', 'cipher'];

/** BanMode=None Classic snake order (16 picks): B R R B R B B R R B B R R B B R */
const CLASSIC_NONE_ORDER = [
    'blue', 'red', 'red', 'blue',
    'red', 'blue', 'blue', 'red',
    'red', 'blue', 'blue', 'red',
    'red', 'blue', 'blue', 'red',
] as const;

/** Host calls start_draft then all three harnesses sync (1500ms each) */
export async function startDraftAndSync(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    lobbyId: number,
): Promise<void> {
    await host.call.startDraft({ lobbyId });
    await host.sync(1500);
    await blue.sync(1500);
    await red.sync(1500);
}

/**
 * Complete a Classic BanMode=None draft (16 picks). Each team picks distinct
 * characters by default so this works with allowMirrorPicks=false.
 */
export async function completeDraft(
    blue: TestHarness,
    red: TestHarness,
    lobbyId: number,
    opts: { blueChars?: string[]; redChars?: string[] } = {},
): Promise<void> {
    const blueChars = opts.blueChars ?? DEFAULT_BLUE_CHARS;
    const redChars = opts.redChars ?? DEFAULT_RED_CHARS;
    let blueIdx = 0;
    let redIdx = 0;
    for (const team of CLASSIC_NONE_ORDER) {
        const h = team === 'blue' ? blue : red;
        const charName = team === 'blue' ? blueChars[blueIdx++] : redChars[redIdx++];
        await h.call.pickCharacter({ lobbyId, characterName: charName, eidolon: 0 });
        await h.sync(300);
    }
    await blue.sync(1500);
    await red.sync(1500);
}

/**
 * Complete a Classic BanMode=Four draft (20 steps: 4 bans + 16 picks) for
 * tournament lobbies. Sequence from draftSequences.ts.
 */
export async function completeTournamentDraft(
    blue: TestHarness,
    red: TestHarness,
    lobbyId: number,
): Promise<void> {
    const banChars = ['clara', 'dan_heng', 'feixiao', 'fugue'];
    const blueChars = DEFAULT_BLUE_CHARS;
    const redChars = DEFAULT_RED_CHARS;
    let blueIdx = 0;
    let redIdx = 0;

    // Ban phase 1: Blue, Red
    await blue.call.banCharacter({ lobbyId, characterName: banChars[0] });
    await blue.sync(300);
    await red.call.banCharacter({ lobbyId, characterName: banChars[1] });
    await red.sync(300);

    // Picks: Blue, Red, Red, Blue
    await blue.call.pickCharacter({ lobbyId, characterName: blueChars[blueIdx++], eidolon: 0 });
    await blue.sync(300);
    await red.call.pickCharacter({ lobbyId, characterName: redChars[redIdx++], eidolon: 0 });
    await red.sync(300);
    await red.call.pickCharacter({ lobbyId, characterName: redChars[redIdx++], eidolon: 0 });
    await red.sync(300);
    await blue.call.pickCharacter({ lobbyId, characterName: blueChars[blueIdx++], eidolon: 0 });
    await blue.sync(300);

    // Ban phase 2: Red, Blue
    await red.call.banCharacter({ lobbyId, characterName: banChars[2] });
    await red.sync(300);
    await blue.call.banCharacter({ lobbyId, characterName: banChars[3] });
    await blue.sync(300);

    // Remaining 12 picks: Red, Blue, Blue, Red, Red, Blue, Blue, Red, Red, Blue, Blue, Red
    const pickOrder = ['red', 'blue', 'blue', 'red', 'red', 'blue', 'blue', 'red', 'red', 'blue', 'blue', 'red'] as const;
    for (const team of pickOrder) {
        const h = team === 'blue' ? blue : red;
        const charName = team === 'blue' ? blueChars[blueIdx++] : redChars[redIdx++];
        await h.call.pickCharacter({ lobbyId, characterName: charName, eidolon: 0 });
        await h.sync(300);
    }
    await blue.sync(1500);
    await red.sync(1500);
}

/**
 * Advance a lobby from Drafting → Equipping → Scoring:
 * both players confirmLineup, host advanceStage, all three sync.
 */
export async function advanceToScoring(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    lobbyId: number,
): Promise<void> {
    await blue.call.confirmLineup({ lobbyId });
    await blue.sync();
    await red.call.confirmLineup({ lobbyId });
    await red.sync();
    await host.call.advanceStage({ lobbyId });
    await host.sync(1500);
    await blue.sync(1500);
    await red.sync(1500);
}
