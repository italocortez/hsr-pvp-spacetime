// T-S7(b): builders for the S7 scoring / lineup in-memory tests. Not a test file: imported by s7-*.test.ts.
// Reuses the S4 builders; reference rows (characters, costs, synergies, roster accounts) are inserted straight into
// the in-memory datastore, outside any reducer, like the S4 tests' direct row edits. Nothing reaches maincloud.
// T-S7b: confirm_lineup / confirm_match_scores are gone (A60). A63: confirmGame only sets a side's ready flag;
// submitGame / closeGame (close_game) is the explicit submit; confirmAndClose = both ready + a captain's submit;
// finishGame closes the current game through the host referee's staff close (S4 / S6 / S7b suites).
import { expect } from 'vitest';
import { charactersPerTeam, groupCount, type LineupFormatTag } from '@shared/scoring';
import { teamDraft } from '@module/helpers/results/scoringHelpers';
import { M, advance, captainOf, lobbyRow, session, setupLobby, tx, type Actor, type Harness, type Lobby, type SetupOpts } from './s4-fixtures';

/** Hundredths of a value (scores, costs and handicaps are fixed-point hundredths). */
export const H = (n: number) => Math.round(n * 100);

const AUDIT = (test: Harness) => {
    const ts = test.clock.now();
    return { createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts };
};

export const blueNames = (n = 8) => Array.from({ length: n }, (_, i) => `blue-${i + 1}`);
export const redNames = (n = 8) => Array.from({ length: n }, (_, i) => `red-${i + 1}`);

export function insertCharacter(test: Harness, name: string, rarity: 4 | 5) {
    test.db.HsrCharacter.insert({
        name,
        displayName: name,
        aliases: [],
        rarity,
        path: { tag: 'Hunt' },
        element: { tag: 'Fire' },
        role: { tag: 'Dps' },
        imageUrl: '',
        versionReleased: 1,
        treatAsVersion: 1,
        posX: 0,
        posY: 0,
        width: 0,
        ...AUDIT(test),
    });
}

/** Every name as a 5-star unless listed in `fourStars`. */
export function insertRoster(test: Harness, names: string[], fourStars: string[] = []) {
    for (const n of names) insertCharacter(test, n, fourStars.includes(n) ? 4 : 5);
}

export function insertCharacterCost(test: Harness, characterName: string, draftMode: 'Classic' | 'Auction', cost: number) {
    insertCharacterCostLadder(test, characterName, draftMode, [cost, cost, cost, cost, cost, cost, cost]);
}

/** T-S7b: a cost row with a distinct cost per eidolon level (`ladder[e]` = the cost at E`e`; cost set 0, MoC). */
export function insertCharacterCostLadder(test: Harness, characterName: string, draftMode: 'Classic' | 'Auction', ladder: number[]) {
    const [e0, e1, e2, e3, e4, e5, e6] = ladder;
    test.db.HsrCharacterCost.insert({
        characterName,
        gameMode: { tag: 'MemoryOfChaos' },
        draftMode: { tag: draftMode },
        costs: { e0, e1, e2, e3, e4, e5, e6 },
        costSetId: 0,
        ...AUDIT(test),
    });
}

/** T-S7b: an Auction cost ladder (shorthand for insertCharacterCostLadder(..., 'Auction', ladder)). */
export const insertAuctionCost = (test: Harness, characterName: string, ladder: number[]) =>
    insertCharacterCostLadder(test, characterName, 'Auction', ladder);

export function insertSynergy(test: Harness, a: string, b: string, costModifier: number, draftMode: 'Classic' | 'Auction') {
    test.db.HsrSynergyCost.insert({
        id: 0,
        characterA: a < b ? a : b,
        characterB: a < b ? b : a,
        gameMode: { tag: 'MemoryOfChaos' },
        draftMode: { tag: draftMode },
        costModifier,
        costSetId: 0,
        ...AUDIT(test),
    });
}

/** An HSR account (id) owning characters at the given eidolons, selected by `userId` for the lobby. */
export function selectAccount(test: Harness, lobbyId: number, userId: number, hsrAccountId: number, owned: Record<string, number>) {
    test.db.LobbyMemberAccount.insert({ lobbyId, userId, hsrAccountId });
    for (const [characterName, eidolonLevel] of Object.entries(owned)) {
        test.db.HsrAccountCharacter.insert({ hsrAccountId, characterName, eidolonLevel, ...AUDIT(test) });
    }
}

const actorOf = (s: Lobby, userId: number): Actor => Object.values(s.a).find((x) => x.userId === userId)!;
export const captain = (s: Lobby, side: 'Blue' | 'Red') =>
    actorOf(s, captainOf(s.test, s.lobbyId, side === 'Blue' ? 'BluePlayer' : 'RedPlayer')!.userId);
export const side = (tag: 'Blue' | 'Red') => ({ tag }) as { tag: 'Blue' | 'Red' };

/** Plays the Classic draft sequence: each Pick turn's captain picks the next name of its list (eidolon per name). */
export function draftClassic(s: Lobby, blue: string[], red: string[], eidolons: Record<string, number> = {}) {
    const queue = { Blue: [...blue], Red: [...red] };
    for (;;) {
        const sess = session(s.test, s.lobbyId);
        const step = sess.draftSequence[sess.turnIndex];
        if (!step) break;
        expect(step.actionRequired.tag).toBe('Pick');
        const team = step.teamTurn.tag as 'Blue' | 'Red';
        const characterName = queue[team].shift()!;
        tx(s.test, captain(s, team), (ctx) =>
            M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: eidolons[characterName] ?? 0 }));
    }
    expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
}

/**
 * Plays an Auction draft with no bans: the nominator's captain nominates (A61: no eidolon), the other captain passes.
 * T-S10c (A81(2)): a nomination made while the other team is full sells at once, so no pass_bid follows it.
 */
export function draftAuction(s: Lobby, blue: string[], red: string[]) {
    const queue = { Blue: [...blue], Red: [...red] };
    const perTeam = charactersPerTeam(lobbyRow(s.test, s.lobbyId).lineupFormat.tag as LineupFormatTag);
    while (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting') {
        const sess = session(s.test, s.lobbyId);
        const team = sess.nextNominatorTeam.tag as 'Blue' | 'Red';
        const other = team === 'Blue' ? 'Red' : 'Blue';
        const otherFull = (other === 'Blue' ? sess.blueCharactersWon : sess.redCharactersWon) >= perTeam;
        tx(s.test, captain(s, team), (ctx) =>
            M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: queue[team].shift()! }));
        if (!otherFull) tx(s.test, captain(s, other), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
    }
    expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
}

export function arrange(s: Lobby, who: Actor, team: 'Blue' | 'Red', groups: string[][]) {
    tx(s.test, who, (ctx) => M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: side(team), groups: JSON.stringify(groups) }));
}

/** A63(1): confirm_game for `team` by its captain: sets that side's ready flag, never closes. */
export function confirmGame(s: Lobby, who: Actor, team: 'Blue' | 'Red') {
    tx(s.test, who, (ctx) => M.confirm_game(ctx, { lobbyId: s.lobbyId, teamSide: side(team) }));
}

/** A63(2): close_game (the submit): a captain once both sides are ready, or staff at any time; override = staff, tie only. */
export function closeGame(s: Lobby, who: Actor, override?: 'Blue' | 'Red', reason?: string) {
    tx(s.test, who, (ctx) => M.close_game(ctx, {
        lobbyId: s.lobbyId,
        winnerOverride: override ? side(override) : undefined,
        winnerOverrideReason: reason,
    }));
}

/** Same as closeGame, under the A63 name: the explicit submit of the current game. */
export const submitGame = closeGame;

/** Both captains confirm the current game (A63: both flags set, the game stays open). */
export function confirmBoth(s: Lobby) {
    confirmGame(s, captain(s, 'Blue'), 'Blue');
    confirmGame(s, captain(s, 'Red'), 'Red');
}

/** A63: both captains ready, then the Blue captain submits (closes) the game. */
export function confirmAndClose(s: Lobby) {
    confirmBoth(s);
    submitGame(s, captain(s, 'Blue'));
}

/** Halves groups: the first four names, then the next four. */
export const halves = (names: string[]) => [names.slice(0, 4), names.slice(4, 8)];

/** T-S8e (A67(3)): the lobby's lineup row of `team` (one game per lobby, index by_lobby). */
export function lineup(test: Harness, lobbyId: number, team: 'Blue' | 'Red') {
    return [...test.db.MatchLineup.by_lobby.filter(lobbyId)].find((l) => l.teamSide.tag === team)!;
}

export const record = (test: Harness, lobbyId: number) => [...test.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];
/**
 * The game row, re-read (MatchResultGame rows are replaced on every edit: never keep one across reducer calls).
 * T-S8e (A67(3)): one row per record, keyed by matchResultId.
 */
export const gameRow = (test: Harness, matchResultId: number) =>
    [...test.db.MatchResultGame.match_result_id.filter(matchResultId)][0];
export const game = (test: Harness, matchResultId: number) => gameRow(test, matchResultId);

export interface ScoringLobbyOpts extends SetupOpts {
    blue?: string[];
    red?: string[];
    fourStars?: string[];
    costs?: Record<string, number>;
    eidolons?: Record<string, number>;
}

/**
 * A Classic Memory of Chaos Bo1 (Halves, teamSize 2, host = spectator referee unless overridden) played to Scoring:
 * reference rows inserted, both teams drafted, lineups arranged by the captains (no lineup confirmation since A60),
 * host advances Equipping → Scoring (a signal, A60(5)).
 */
export function playToScoring(test: Harness, opts: ScoringLobbyOpts = {}): Lobby {
    const blue = opts.blue ?? blueNames();
    const red = opts.red ?? redNames();
    insertRoster(test, [...blue, ...red], opts.fourStars);
    for (const [name, cost] of Object.entries(opts.costs ?? {})) insertCharacterCost(test, name, 'Classic', cost);
    const s = setupLobby(test, opts);
    draftClassic(s, blue, red, opts.eidolons);
    arrange(s, captain(s, 'Blue'), 'Blue', halves(blue));
    arrange(s, captain(s, 'Red'), 'Red', halves(red));
    tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
    expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Scoring');
    advance(test, 1_000);
    return s;
}

/** record_group_scores for the lobby's game (T-S8e, A67(3): no game number). */
export function recordScores(s: Lobby, who: Actor, team: 'Blue' | 'Red', values: number[], deaths = 0) {
    tx(s.test, who, (ctx) =>
        M.record_group_scores(ctx, { lobbyId: s.lobbyId, teamSide: side(team), values, deaths }));
}

/** Splits drafted names into groups of four (Halves → 2 groups, Thirds → 3). */
const groupsOf4 = (names: string[]) => Array.from({ length: Math.ceil(names.length / 4) }, (_, i) => names.slice(i * 4, i * 4 + 4));

/**
 * T-S7b / T-S8e: closes the lobby's game through the host (a lobby referee): the host arranges any missing lineup from the
 * game's draft, advances Equipping → Scoring if needed, records both sides' group scores (distinct: `winner` gets
 * 10 cycles per group, the other 20) and closes the game directly (A63: staff close, no ready flags needed).
 * The draft must be complete (stage Equipping or Scoring).
 */
export function finishGame(s: Lobby, winner: 'Blue' | 'Red' = 'Blue') {
    const { test, lobbyId } = s;
    for (const team of ['Blue', 'Red'] as const) {
        if (lineup(test, lobbyId, team)) continue;
        const names = tx(test, 'internal', (ctx) => teamDraft(ctx, lobbyId, team).characters);
        advance(test, 300); // lineup throttle (AbuseConfig.lineupMinIntervalMs) on the host
        arrange(s, s.host, team, groupsOf4(names));
    }
    if (lobbyRow(test, lobbyId).stage.tag === 'Equipping') tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId }));
    const groups = groupCount(lobbyRow(test, lobbyId).lineupFormat.tag as LineupFormatTag);
    const values = (team: 'Blue' | 'Red') => Array.from({ length: groups }, () => H(team === winner ? 10 : 20));
    recordScores(s, s.host, 'Blue', values('Blue'));
    recordScores(s, s.host, 'Red', values('Red'));
    closeGame(s, s.host);
}

/** A light-cone cost row (cost set 0, Memory of Chaos); equip_lightcone reads the Classic row in both draft modes. */
export function insertLightconeCost(test: Harness, lightconeName: string, cost: number) {
    test.db.HsrLightconeCost.insert({
        lightconeName,
        gameMode: { tag: 'MemoryOfChaos' },
        draftMode: { tag: 'Classic' },
        costs: { s1: cost, s2: cost, s3: cost, s4: cost, s5: cost },
        costSetId: 0,
        ...AUDIT(test),
    });
}

/** T-S10b (A78(2)): equip_lightcone by `who` for `team`'s copy of the character (the caller names the side). */
export function equip(s: Lobby, who: Actor, team: 'Blue' | 'Red', characterName: string, lightconeName: string) {
    tx(s.test, who, (ctx) =>
        M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side(team), characterName, lightconeName, superimposition: 1 }));
}

/** T-S10b (A78(2)): unequip_lightcone by `who` for `team`'s copy of the character. */
export function unequip(s: Lobby, who: Actor, team: 'Blue' | 'Red', characterName: string) {
    tx(s.test, who, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side(team), characterName }));
}

/** T-S7b: set_eidolon (A60(1)) by `who` for a character of `team`'s draft of the current game. */
export function setEidolon(s: Lobby, who: Actor, team: 'Blue' | 'Red', characterName: string, eidolon: number) {
    tx(s.test, who, (ctx) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side(team), characterName, eidolon }));
}

/** T-S7b: sets a user's role directly on the row (as the S7 tests set Moderator). */
export function setRole(test: Harness, userId: number, role: 'Moderator' | 'Admin') {
    test.db.User.id.update({ ...test.db.User.id.find(userId)!, role: { tag: role } });
}
