// T-S10 batch A1: shared builders for s10-lobby, s10-account-selection and s10-post-draft (the in-memory ports of the
// live lobby / account-selection / post-draft suites). Not a test file: imported by those three files only. Reuses the
// S4 / S7 / S8 builders; reference and private rows (accounts, account locks, cost rows) are written straight into the
// in-memory datastore outside any reducer, like the earlier suites. `test.db` is read only outside `tx` bodies.
// Nothing reaches maincloud.
import { DEFAULT_LOBBY_ARGS, M, tx, type Actor, type Harness } from './s4-fixtures';
import { AUDIT } from './s8-fixtures';

/** create_lobby_preset arguments (as s6-series-presets / s8f-membership build them locally), with a name. */
export const PRESET_ARGS = {
    teamSize: 2,
    draftMode: { tag: 'Classic' },
    banMode: { tag: 'None' },
    gameMode: { tag: 'MemoryOfChaos' },
    matchType: { tag: 'Casual' },
    standardTurnSeconds: 30,
    reserveBankSeconds: 60,
    characterBudget: 100,
    lightconeBudget: 50,
    minimumBidRaise: 1,
    rosterDiffAdvantage: 0,
    rosterThreshold: 0,
    underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0,
    deathPenalty: 0,
    isPublic: true,
    isAnonymousPlayers: false,
    isAnonymousSpectators: false,
    rosterVisibility: { tag: 'OpenRoster' },
    requireOwnership: false,
    costSetId: 0,
    disconnectPolicy: { tag: 'Standard' },
    disconnectForfeitSeconds: 60,
    allowMirrorPicks: false,
    autoRandomPick: false,
    refereeCanUndo: true,
    refereeCanPause: true,
    refereeCanSetCaptain: true,
    refereeCanKick: true,
    allowPlayerPause: true,
    refereeExclusiveConcede: true,
};

export const presetArgs = (name: string, over: Record<string, unknown> = {}) => ({ ...PRESET_ARGS, name, ...over }) as any;
export const updatePresetArgs = (presetId: number, name: string, over: Record<string, unknown> = {}) =>
    ({ ...PRESET_ARGS, presetId, name, ...over }) as any;

export const presetsOf = (test: Harness, userId: number) =>
    [...test.db.LobbyPreset.iter()].filter((p) => p.creatorUserId === userId);
export const presetNamed = (test: Harness, name: string) => [...test.db.LobbyPreset.iter()].find((p) => p.name === name);
export const systemPreset = (test: Harness) => [...test.db.LobbyPreset.iter()].find((p) => p.isSystemPreset)!;

/** update_lobby_settings arguments mirroring the create defaults, with overrides (as s6-series-presets). */
export const settingsArgs = (lobbyId: number, over: Record<string, unknown> = {}) => {
    const rest = DEFAULT_LOBBY_ARGS; // A114 / A116 (S10n): no joinCode / presetId to strip
    return { lobbyId, ...rest, refereeExclusiveConcede: true, ...over } as any;
};

/** create_lobby as `who` with overrides; returns the id of the lobby `who` hosts. */
export function createLobby(test: Harness, who: Actor, over: Record<string, unknown> = {}): number {
    tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...over } as any));
    return [...test.db.Lobby.iter()].find((l) => l.hostUserId === who.userId)!.id;
}

export const joinLobby = (test: Harness, who: Actor, lobbyId: number, password = '', joinCode = '') =>
    tx(test, who, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode, password }));

export const lobbyMembers = (test: Harness, lobbyId: number) => [...test.db.LobbyMember.lobby_id.filter(lobbyId)];

/** The HSR account ids `userId` has selected for the lobby (LobbyMemberAccount, private), ascending. */
export const lmaOf = (test: Harness, lobbyId: number, userId: number) =>
    [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])].map((r) => r.hsrAccountId).sort((a, b) => a - b);

/** Flips HsrAccount.isActive on a row inserted by insertHsrAccount (which inserts active accounts). */
export function setActive(test: Harness, hsrAccountId: number, isActive: boolean) {
    test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(hsrAccountId)!, isActive });
}

/** A TournamentPlayerAccount lock row (what registration writes), inserted directly. */
export function lockAccount(test: Harness, tournamentId: number, userId: number, hsrAccountId: number) {
    test.db.TournamentPlayerAccount.insert({ tournamentId, userId, hsrAccountId, ...AUDIT(test) });
}

/** A light-cone cost row of the given draft mode (cost set 0, Memory of Chaos); s7's insertLightconeCost is Classic only. */
export function insertLightconeCostFor(test: Harness, lightconeName: string, draftMode: 'Classic' | 'Auction', cost: number) {
    test.db.HsrLightconeCost.insert({
        lightconeName,
        gameMode: { tag: 'MemoryOfChaos' },
        draftMode: { tag: draftMode },
        costs: { s1: cost, s2: cost, s3: cost, s4: cost, s5: cost },
        costSetId: 0,
        ...AUDIT(test),
    });
}
