// Fixtures: lobby presets and settings, lobby members and their selected accounts, lobby actions (create, join, leave,
//   chat, abandon, slot moves), cursor events, seat labels and the lobby refusal texts.
// From S10 (s10-a1-fixtures.ts: presets, settings, selected accounts), S10 A2 (settingsFrom), S10e (members, chat
// and account rows, slot moves), S10h (s10h-lobby-rulings.test.ts: lobby actions, cursor events; s10h-fixtures.ts:
// seat labels), S10w (a live Classic lobby); gathered by T-REORG2.
//
// Not a test file. State is built through the module's reducers; `test.db` is read only outside `tx` bodies.
// Nothing reaches maincloud.
import { DEFAULT_LOBBY_ARGS, M, ONE_V_ONE, lobbyRow, member, newHarness, setupLobby, tx, type Actor, type Harness, type Lobby, type SlotTag } from './harness';

// ─── Texts ───────────────────────────────────────────────────────────────────

/** The start of the claim_forfeit refusal while the opposing team is not eligible (a substring check). */
export const NOT_ELIGIBLE_START = 'Opposing team is not eligible for forfeit';
/** The full claim_forfeit refusal while the opposing team is not eligible. */
export const NOT_ELIGIBLE = `${NOT_ELIGIBLE_START}. At least one player is still connected or grace period has not expired.`;
export const NO_PLAYER_REMOVAL = 'Players cannot be removed once the draft has started; the match ends by result, concede or forfeit.';
export const stageMsg = (stage: string) => `This action is not allowed in the current lobby stage (${stage}).`;

// ─── Presets and settings ────────────────────────────────────────────────────

/** create_lobby_preset arguments (as s6-series-presets / s8f-membership build them locally), with a name. */
export const PRESET_ARGS = {
    teamSize: 2,
    draftMode: { tag: 'Classic' },
    banMode: { tag: 'None' },
    gameMode: { tag: 'MemoryOfChaos' },
    matchType: { tag: 'Casual' },
    standardTurnSeconds: 30,
    // T-S10aa (A148): 0 = no reserve (the turn-only clock the tournament-lobby timer tests expect), as DEFAULT_LOBBY_ARGS.
    reserveBankSeconds: 0,
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

export const members = (test: Harness, lobbyId: number) => [...test.db.LobbyMember.lobby_id.filter(lobbyId)];
export const lobbyMembers = members;

/** The HSR account ids `userId` has selected for the lobby (LobbyMemberAccount, private), ascending. */
export const lmaOf = (test: Harness, lobbyId: number, userId: number) =>
    [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])].map((r) => r.hsrAccountId).sort((a, b) => a - b);
export const lmaRows = (test: Harness, lobbyId: number, userId: number) =>
    [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])];

/** update_lobby_settings arguments built from the lobby row itself (so only the overridden keys change). */
export function settingsFrom(test: Harness, lobbyId: number, over: Record<string, unknown> = {}) {
    const l = lobbyRow(test, lobbyId);
    return {
        lobbyId,
        teamSize: l.teamSize, draftMode: l.draftMode, banMode: l.banMode, gameMode: l.gameMode, matchType: l.matchType,
        standardTurnSeconds: l.standardTurnSeconds, reserveBankSeconds: l.reserveBankSeconds,
        characterBudget: l.characterBudget, lightconeBudget: l.lightconeBudget, minimumBidRaise: l.minimumBidRaise,
        rosterDiffAdvantage: l.rosterDiffAdvantage, rosterThreshold: l.rosterThreshold,
        underThresholdAdvantage: l.underThresholdAdvantage, aboveThresholdPenalty: l.aboveThresholdPenalty,
        deathPenalty: l.deathPenalty, isAnonymousPlayers: l.isAnonymousPlayers, isAnonymousSpectators: l.isAnonymousSpectators,
        rosterVisibility: l.rosterVisibility, requireOwnership: l.requireOwnership, costSetId: l.costSetId,
        disconnectPolicy: l.disconnectPolicy, disconnectForfeitSeconds: l.disconnectForfeitSeconds ?? 0,
        allowMirrorPicks: l.allowMirrorPicks, autoRandomPick: l.autoRandomPick, refereeCanUndo: l.refereeCanUndo,
        refereeCanPause: l.refereeCanPause, refereeCanSetCaptain: l.refereeCanSetCaptain, refereeCanKick: l.refereeCanKick,
        allowPlayerPause: l.allowPlayerPause, refereeExclusiveConcede: l.refereeExclusiveConcede,
        teamBlueAlias: l.teamBlueAlias, teamRedAlias: l.teamRedAlias, isPublic: l.isPublic, password: '',
        ...over,
    } as any;
}

/** A 1v1 Classic lobby on set 0; `noStart` keeps it in Waiting. */
export function classic(noStart = false): Lobby {
    return setupLobby(newHarness(), { seats: ONE_V_ONE, noStart });
}

// ─── Lobby actions ───────────────────────────────────────────────────────────

export const lobbyOfHost = (test: Harness, who: Actor) => [...test.db.Lobby.iter()].find((l) => l.hostUserId === who.userId)?.id;
export const join = (test: Harness, who: Actor, lobbyId: number, password = '') =>
    tx(test, who, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password }));
export const leave = (test: Harness, who: Actor, lobbyId: number) => tx(test, who, (ctx) => M.leave_lobby(ctx, { lobbyId }));
export const chat = (test: Harness, who: Actor, lobbyId: number, content = 'hi') =>
    tx(test, who, (ctx) => M.send_chat_message(ctx, { lobbyId, content, metadata: '' }));
export const chatRows = (test: Harness, lobbyId: number) => [...test.db.ChatMessage.lobby_id.filter(lobbyId)];
export const abandon = (test: Harness, who: Actor) =>
    tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
export const selfSlot = (lobbyId: number, tag: SlotTag) => (ctx: any) => M.set_team_slot(ctx, { lobbyId, lobbySlot: { tag } as any });
export const moveSlot = (lobbyId: number, seat: number, tag: SlotTag) => (ctx: any) =>
    M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seat, lobbySlot: { tag } as any });

/** broadcast_cursor as `who`; returns the LobbyCursorEvent rows the call inserted (event rows live only in the transaction). */
export function cursorEvents(test: Harness, who: Actor, lobbyId: number): any[] {
    return tx(test, who, (ctx) => {
        M.broadcast_cursor(ctx, { lobbyId, x: 0.5, y: 0.5 });
        return [...ctx.db.LobbyCursorEvent.iter()].map((r: any) => ({ ...r }));
    });
}

// ─── Seat labels (A97) ───────────────────────────────────────────────────────
// T-S10h: the A97 seat label as the decision row states it, derived on the test side from the member row (never from
// the module's helper): "<seat kind> #<joinSeq>", seat kind one of Blue Player, Red Player, Blue Coach, Red Coach,
// Spectator.

const SEAT_KIND: Record<string, string> = {
    BluePlayer: 'Blue Player',
    RedPlayer: 'Red Player',
    BlueCoach: 'Blue Coach',
    RedCoach: 'Red Coach',
    Spectator: 'Spectator',
};

/** A97: the label of a member row (slot tag + joinSeq). */
export function labelOfRow(row: { lobbySlot: { tag: string }; joinSeq: number }): string {
    return `${SEAT_KIND[row.lobbySlot.tag]} #${row.joinSeq}`;
}

/** A97: the label of `userId`'s current row in the lobby; throws when the user holds no row (capture it before a leave). */
export function seatLabel(test: Harness, lobbyId: number, userId: number): string {
    const row = member(test, lobbyId, userId);
    if (!row) throw new Error(`seatLabel: user ${userId} holds no row in lobby ${lobbyId}`);
    return labelOfRow(row);
}
