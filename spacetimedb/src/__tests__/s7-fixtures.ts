// T-S7(b): builders for the S7 scoring / lineup in-memory tests. Not a test file: imported by s7-*.test.ts.
// Reuses the S4 builders; reference rows (characters, costs, synergies, roster accounts) are inserted straight into
// the in-memory datastore, outside any reducer, like the S4 tests' direct row edits. Nothing reaches maincloud.
import { expect } from 'vitest';
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
    test.db.HsrCharacterCost.insert({
        characterName,
        gameMode: { tag: 'MemoryOfChaos' },
        draftMode: { tag: draftMode },
        costs: { e0: cost, e1: cost, e2: cost, e3: cost, e4: cost, e5: cost, e6: cost },
        costSetId: 0,
        ...AUDIT(test),
    });
}

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

/** Plays an Auction draft with no bans: the nominator's captain nominates, the other captain passes. */
export function draftAuction(s: Lobby, blue: string[], red: string[]) {
    const queue = { Blue: [...blue], Red: [...red] };
    while (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting') {
        const team = session(s.test, s.lobbyId).nextNominatorTeam.tag as 'Blue' | 'Red';
        const other = team === 'Blue' ? 'Red' : 'Blue';
        tx(s.test, captain(s, team), (ctx) =>
            M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: queue[team].shift()!, eidolon: 0 }));
        tx(s.test, captain(s, other), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
    }
    expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
}

export function arrange(s: Lobby, who: Actor, team: 'Blue' | 'Red', groups: string[][]) {
    tx(s.test, who, (ctx) => M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: side(team), groups: JSON.stringify(groups) }));
}

export function confirm(s: Lobby, who: Actor, team: 'Blue' | 'Red') {
    tx(s.test, who, (ctx) => M.confirm_lineup(ctx, { lobbyId: s.lobbyId, teamSide: side(team) }));
}

/** Halves groups: the first four names, then the next four. */
export const halves = (names: string[]) => [names.slice(0, 4), names.slice(4, 8)];

export function lineup(test: Harness, lobbyId: number, team: 'Blue' | 'Red') {
    return [...test.db.MatchLineup.by_lobby_game.filter([lobbyId, 1])].find((l) => l.teamSide.tag === team)!;
}

export const record = (test: Harness, lobbyId: number) => [...test.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];
export const game = (test: Harness, matchResultId: number) =>
    [...test.db.MatchResultGame.by_result_and_game.filter([matchResultId, 1])][0];

export interface ScoringLobbyOpts extends SetupOpts {
    blue?: string[];
    red?: string[];
    fourStars?: string[];
    costs?: Record<string, number>;
    eidolons?: Record<string, number>;
}

/**
 * A Classic Memory of Chaos Bo1 (Halves, teamSize 2, host = spectator referee unless overridden) played to Scoring:
 * reference rows inserted, both teams drafted, lineups arranged and confirmed by the captains, host advances.
 */
export function playToScoring(test: Harness, opts: ScoringLobbyOpts = {}): Lobby {
    const blue = opts.blue ?? blueNames();
    const red = opts.red ?? redNames();
    insertRoster(test, [...blue, ...red], opts.fourStars);
    for (const [name, cost] of Object.entries(opts.costs ?? {})) insertCharacterCost(test, name, 'Classic', cost);
    const s = setupLobby(test, opts);
    draftClassic(s, blue, red, opts.eidolons);
    arrange(s, captain(s, 'Blue'), 'Blue', halves(blue));
    confirm(s, captain(s, 'Blue'), 'Blue');
    arrange(s, captain(s, 'Red'), 'Red', halves(red));
    confirm(s, captain(s, 'Red'), 'Red');
    tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
    expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Scoring');
    advance(test, 1_000);
    return s;
}

export function recordScores(s: Lobby, who: Actor, team: 'Blue' | 'Red', values: number[], deaths = 0) {
    tx(s.test, who, (ctx) =>
        M.record_group_scores(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side(team), values, deaths }));
}

export function confirmBoth(s: Lobby, matchResultId: number) {
    tx(s.test, captain(s, 'Blue'), (ctx) => M.confirm_match_scores(ctx, { matchResultId }));
    tx(s.test, captain(s, 'Red'), (ctx) => M.confirm_match_scores(ctx, { matchResultId }));
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

export function equip(s: Lobby, who: Actor, characterName: string, lightconeName: string) {
    tx(s.test, who, (ctx) => M.equip_lightcone(ctx, { lobbyId: s.lobbyId, characterName, lightconeName, superimposition: 1 }));
}
