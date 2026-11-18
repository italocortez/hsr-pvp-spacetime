// S14.4c: the lobby settings form's model, pure TypeScript shared by the web app's form (the landing page's create
// dialog now; the lobbies page and the lobby room's settings later) and its tests. No `spacetimedb` or `react` import.
// The module does not use this file: it keeps its own checks. It is not in the folder's barrel (`index.ts`, which the
// module bundles), so the module's build is unchanged; the web app imports `@shared/lobby-rules/lobbySettings`
// (Vite resolves the nested path; only the module's CLI bundler needs the one-segment barrel). Every limit below mirrors a module rule and is pinned to
// the module's source by `lobbySettings.test.ts` (the "module pins" block):
//
//   name                   spacetimedb/src/helpers/tournament/seriesSettings.ts   normalizeLobbyName (trimmed, 0 to 50)
//   password               spacetimedb/src/helpers/lobby/lobbyPassword.ts          A to Z, a to z, 0 to 9, at most 20
//   private needs password spacetimedb/src/helpers/lobby/lobbyHelpers.ts           PRIVATE_LOBBY_PASSWORD_TEXT (A99)
//   numbers                spacetimedb/src/helpers/lobby/lobbyConfigBounds.ts      ensureLobbyConfigInRange and friends
//   confirm window         spacetimedb/src/helpers/lobby/lobbyConfigBounds.ts      resolveConfirmWindowSeconds (0 to 300, 60)
//   one-lobby rule         spacetimedb/src/helpers/lobby/lobbyHelpers.ts           LIVE_STAGES and membershipHold
//   disconnect             spacetimedb/src/helpers/lobby/disconnectHelpers.ts      Deferred, NoAction, 30 to 600 s
//   spectators             spacetimedb/src/helpers/lobby/lobbyHelpers.ts           resolveMaxSpectators (0 to 12)
//
// The handicap values are kept in the module's unit, hundredths of a point (A21), so a preset round-trips exactly;
// a field that shows points converts with `pointsToHundredths` / `hundredthsToPoints`.

// ─── The module's enums, as their tags ───────────────────────────────────────────────────────────────────────────

export const LOBBY_DRAFT_MODES = ['Classic', 'Auction'] as const;
export type LobbyDraftMode = (typeof LOBBY_DRAFT_MODES)[number];

export const LOBBY_GAME_MODES = [
    'MemoryOfChaos',
    'ApocalypticShadow',
    'AnomalyArbitration',
] as const;
export type LobbyGameMode = (typeof LOBBY_GAME_MODES)[number];

export const LOBBY_BAN_MODES = ['None', 'Four', 'Six'] as const;
export type LobbyBanMode = (typeof LOBBY_BAN_MODES)[number];

export const LOBBY_MATCH_TYPES = ['Casual', 'Ranked'] as const;
export type LobbyMatchType = (typeof LOBBY_MATCH_TYPES)[number];

export const LOBBY_ROSTER_VISIBILITIES = [
    'OpenRoster',
    'ClosedWithRating',
    'ClosedNoRating',
] as const;
export type LobbyRosterVisibility = (typeof LOBBY_ROSTER_VISIBILITIES)[number];

export const LOBBY_DISCONNECT_POLICIES = ['Standard', 'Deferred', 'NoAction'] as const;
export type LobbyDisconnectPolicy = (typeof LOBBY_DISCONNECT_POLICIES)[number];

/** A45(2) and A221(4): six options; the last two were appended by S14.4r. */
export const LOBBY_BAN_RESTRICTIONS = [
    'NoRestriction',
    'MaxOneDps',
    'MaxTwoDps',
    'MaxOnePerRole',
    'MaxOneSupport',
    'MaxOneSustain',
] as const;
export type LobbyBanRestriction = (typeof LOBBY_BAN_RESTRICTIONS)[number];

export const LOBBY_LINEUP_FORMATS = ['Halves', 'Thirds'] as const;
export type LobbyLineupFormat = (typeof LOBBY_LINEUP_FORMATS)[number];

export const LOBBY_TEAM_SIZES = [1, 2, 3] as const;
export type LobbyTeamSize = (typeof LOBBY_TEAM_SIZES)[number];

// ─── Labels (the mockup's words) ─────────────────────────────────────────────────────────────────────────────────

export const DRAFT_MODE_LABEL: Record<LobbyDraftMode, string> = {
    Classic: 'Classic',
    Auction: 'Auction',
};
export const GAME_MODE_LABEL: Record<LobbyGameMode, string> = {
    MemoryOfChaos: 'Memory of Chaos',
    ApocalypticShadow: 'Apocalyptic Shadow',
    AnomalyArbitration: 'Anomaly Arbitration',
};
export const BAN_MODE_LABEL: Record<LobbyBanMode, string> = {
    None: 'None',
    Four: 'Four',
    Six: 'Six',
};
export const MATCH_TYPE_LABEL: Record<LobbyMatchType, string> = {
    Casual: 'Casual',
    Ranked: 'Ranked',
};
export const ROSTER_VISIBILITY_LABEL: Record<LobbyRosterVisibility, string> = {
    OpenRoster: 'Open Roster',
    ClosedWithRating: 'Closed with Rating',
    ClosedNoRating: 'Closed No Rating',
};
export const TEAM_SIZE_LABEL: Record<LobbyTeamSize, string> = {
    1: '1v1 · 2 players',
    2: '2v2 · 4 players',
    3: '3v3 · 6 players',
};

// ─── Limits (the module's) ───────────────────────────────────────────────────────────────────────────────────────

export const LOBBY_NAME_MAX_LENGTH = 50;
export const LOBBY_PASSWORD_MAX = 20;
export const LOBBY_PASSWORD_CHARS = /^[A-Za-z0-9]*$/;
export const LOBBY_TURN_SECONDS_MIN = 10;
export const LOBBY_TURN_SECONDS_MAX = 600;
export const LOBBY_RESERVE_SECONDS_MAX = 1800;
export const LOBBY_CONFIRM_WINDOW_SECONDS_MAX = 300;
export const LOBBY_CONFIRM_WINDOW_SECONDS_DEFAULT = 60;
export const LOBBY_BUDGET_MAX = 100_000;
export const LOBBY_HANDICAP_MAX_HUNDREDTHS = 1_000_000;
export const LOBBY_FORFEIT_SECONDS_MIN = 30;
export const LOBBY_FORFEIT_SECONDS_MAX = 600;
/** What `disconnectForfeitSeconds = 0` stands for (the module's default grace). */
export const LOBBY_FORFEIT_SECONDS_DEFAULT = 60;
export const LOBBY_MAX_SPECTATORS_MAX = 12;
export const LOBBY_TEAM_ALIAS_MAX_LENGTH = 30;
/** The default cost set: the sentinel id 0, no `cost_set` row (A185 item 1). */
export const DEFAULT_COST_SET = 0;

/** The form's sentences for an Auction lobby that cannot work (user ruling, S14.4c-fix). */
export const AUCTION_CHARACTER_BUDGET_TEXT = 'An Auction lobby needs a character budget above 0.';
export const AUCTION_MINIMUM_RAISE_TEXT = 'An Auction lobby needs a minimum bid raise above 0.';

/** The module's refusal sentences the form reacts to (lobbyHelpers.ts), pinned by the test. */
export const PRIVATE_LOBBY_NEEDS_PASSWORD_TEXT = 'A private lobby needs a password.';
export const ALREADY_IN_LOBBY_TEXT =
    'You are already in a lobby. Leave it before creating or joining another.';
const AWAY_PROMPT =
    /^You left lobby (\S+) mid-match\. Joining here means you cannot return to it\.$/;

/** The join code named by the module's A68(4) prompt ("You left lobby X mid-match. …"), else undefined. */
export function awayPromptCode(refusal: string): string | undefined {
    return AWAY_PROMPT.exec(refusal.trim())?.[1];
}

// ─── The value ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Every setting `create_lobby` takes, in the form's terms. */
export interface LobbySettings {
    // The main dialog (design/mockups/index.html Create Lobby).
    /** Optional; trimmed on send. */
    name: string;
    /** Empty: a public lobby. Not empty: a private one (A99). */
    password: string;
    draftMode: LobbyDraftMode;
    gameMode: LobbyGameMode;
    /** 0: the default set; otherwise a published, unlocked `cost_set` id. */
    costSetId: number;
    banMode: LobbyBanMode;
    matchType: LobbyMatchType;
    isAnonymousPlayers: boolean;
    rosterVisibility: LobbyRosterVisibility;
    teamSize: LobbyTeamSize;
    // Advanced Settings (S14.4d builds their fields; a preset sets them now).
    banRestriction: LobbyBanRestriction;
    lineupFormat: LobbyLineupFormat;
    standardTurnSeconds: number;
    reserveBankSeconds: number;
    confirmWindowSeconds: number;
    characterBudget: number;
    lightconeBudget: number;
    minimumBidRaise: number;
    /** Hundredths of a point (A21), as the module stores them. */
    rosterDiffAdvantage: number;
    rosterThreshold: number;
    underThresholdAdvantage: number;
    aboveThresholdPenalty: number;
    deathPenalty: number;
    requireOwnership: boolean;
    isAnonymousSpectators: boolean;
    hideMmr: boolean;
    disconnectPolicy: LobbyDisconnectPolicy;
    /** 0: the module's default grace (60 s); otherwise 30 to 600. */
    disconnectForfeitSeconds: number;
    allowMirrorPicks: boolean;
    autoRandomPick: boolean;
    refereeCanUndo: boolean;
    refereeCanPause: boolean;
    refereeCanSetCaptain: boolean;
    refereeCanKick: boolean;
    allowPlayerPause: boolean;
    refereeExclusiveConcede: boolean;
    maxSpectators: number;
    teamBlueAlias: string;
    teamRedAlias: string;
}

export type LobbySettingKey = keyof LobbySettings;

/** The fields of the main dialog, in the mockup's order (the first invalid one takes focus after a failed submit). */
export const LOBBY_MAIN_FIELDS = [
    'name',
    'password',
    'draftMode',
    'gameMode',
    'costSetId',
    'banMode',
    'matchType',
    'isAnonymousPlayers',
    'rosterVisibility',
    'teamSize',
] as const satisfies readonly LobbySettingKey[];

/** A preset's values: everything but the lobby's own name and password. */
export type LobbyPresetValues = Omit<LobbySettings, 'name' | 'password'>;

/**
 * The defaults (A221 R8): Apocalyptic Shadow and Auction budgets 30 and 15 as the other pages (A190 items 5 and 9);
 * the rest as the mockup (Classic, Six bans, 3v3, Casual, Open Roster, 60 s turn, 120 s reserve,
 * handicaps 0, the referee powers on except kick, player pause on, exclusive concede on); the settings the mockup
 * lacks take the module's defaults (A221 R5: Halves, 12 spectators, 60 s confirm window, no MMR hiding, no team
 * names) and the system preset's values where the module has none (no mirror picks, no random auto-pick). The
 * minimum bid raise is 5 (user ruling, S14.4c-fix).
 */
export const DEFAULT_LOBBY_SETTINGS: Readonly<LobbySettings> = Object.freeze({
    name: '',
    password: '',
    draftMode: 'Classic',
    gameMode: 'ApocalypticShadow',
    costSetId: DEFAULT_COST_SET,
    banMode: 'Six',
    matchType: 'Casual',
    isAnonymousPlayers: false,
    rosterVisibility: 'OpenRoster',
    teamSize: 3,
    banRestriction: 'NoRestriction',
    lineupFormat: 'Halves',
    standardTurnSeconds: 60,
    reserveBankSeconds: 120,
    confirmWindowSeconds: LOBBY_CONFIRM_WINDOW_SECONDS_DEFAULT,
    characterBudget: 30,
    lightconeBudget: 15,
    // User ruling, S14.4c-fix: 5 (was the mockup's 20).
    minimumBidRaise: 5,
    rosterDiffAdvantage: 0,
    rosterThreshold: 0,
    underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0,
    deathPenalty: 0,
    requireOwnership: false,
    isAnonymousSpectators: false,
    hideMmr: false,
    disconnectPolicy: 'Standard',
    disconnectForfeitSeconds: 0,
    allowMirrorPicks: false,
    autoRandomPick: false,
    refereeCanUndo: true,
    refereeCanPause: true,
    refereeCanSetCaptain: true,
    refereeCanKick: false,
    allowPlayerPause: true,
    refereeExclusiveConcede: true,
    maxSpectators: LOBBY_MAX_SPECTATORS_MAX,
    teamBlueAlias: '',
    teamRedAlias: '',
});

function presetValuesOf(settings: Readonly<LobbySettings>): LobbyPresetValues {
    const { name: _name, password: _password, ...values } = settings;
    return values;
}

// ─── Presets (A116, A221 R7) ─────────────────────────────────────────────────────────────────────────────────────

/** One entry of the preset list: a key for the select, the name shown and the values it copies into the form. */
export interface LobbyPresetChoice {
    key: string;
    label: string;
    values: LobbyPresetValues;
}

export const BUILT_IN_CLASSIC_KEY = 'builtin:classic';
export const BUILT_IN_AUCTION_KEY = 'builtin:auction';

/** "Default Classic" and "Default Auction", built into the page (A221 R7): the defaults with that draft mode. */
export const BUILT_IN_PRESETS: readonly LobbyPresetChoice[] = [
    {
        key: BUILT_IN_CLASSIC_KEY,
        label: 'Default Classic',
        values: presetValuesOf({ ...DEFAULT_LOBBY_SETTINGS, draftMode: 'Classic' }),
    },
    {
        key: BUILT_IN_AUCTION_KEY,
        label: 'Default Auction',
        values: presetValuesOf({ ...DEFAULT_LOBBY_SETTINGS, draftMode: 'Auction' }),
    },
];

type Tag = { tag: string };

/** The fields of a `view_lobby_presets` row the form reads (the generated `LobbyPresetViewRow` fits it). */
export interface ModuleLobbyPreset {
    id: number;
    name: string;
    isSystemPreset: boolean;
    teamSize: number;
    draftMode: Tag;
    banMode: Tag;
    banRestriction: Tag;
    lineupFormat: Tag;
    gameMode: Tag;
    matchType: Tag;
    standardTurnSeconds: number;
    reserveBankSeconds: number;
    confirmWindowSeconds: number;
    characterBudget: number;
    lightconeBudget: number;
    minimumBidRaise: number;
    rosterDiffAdvantage: number;
    rosterThreshold: number;
    underThresholdAdvantage: number;
    aboveThresholdPenalty: number;
    deathPenalty: number;
    isAnonymousPlayers: boolean;
    isAnonymousSpectators: boolean;
    hideMmr: boolean;
    rosterVisibility: Tag;
    requireOwnership: boolean;
    costSetId: number;
    disconnectPolicy: Tag;
    disconnectForfeitSeconds: number | undefined;
    allowMirrorPicks: boolean;
    autoRandomPick: boolean;
    refereeCanUndo: boolean;
    refereeCanPause: boolean;
    refereeCanSetCaptain: boolean;
    refereeCanKick: boolean;
    allowPlayerPause: boolean;
    refereeExclusiveConcede: boolean;
    maxSpectators: number;
}

function oneOf<T extends string>(list: readonly T[], tag: string, fallback: T): T {
    return (list as readonly string[]).includes(tag) ? (tag as T) : fallback;
}

/** The select key of a module preset. */
export const modulePresetKey = (id: number) => `preset:${id}`;

/**
 * A module preset as form values (A116: the form copies them). The preset's own `name` and `isPublic` are not copied
 * (the lobby's name and password stay what the person typed). A tag the form does not know takes the default; the
 * Deferred policy, which `create_lobby` refuses outside tournaments (A91(2)), becomes Standard; an unset forfeit
 * time is 0 (the default).
 */
export function presetFromModule(row: ModuleLobbyPreset): LobbyPresetChoice {
    const d = DEFAULT_LOBBY_SETTINGS;
    const teamSize = (LOBBY_TEAM_SIZES as readonly number[]).includes(row.teamSize)
        ? (row.teamSize as LobbyTeamSize)
        : d.teamSize;
    const policy = oneOf(LOBBY_DISCONNECT_POLICIES, row.disconnectPolicy.tag, d.disconnectPolicy);
    return {
        key: modulePresetKey(row.id),
        label: row.name,
        values: {
            draftMode: oneOf(LOBBY_DRAFT_MODES, row.draftMode.tag, d.draftMode),
            gameMode: oneOf(LOBBY_GAME_MODES, row.gameMode.tag, d.gameMode),
            costSetId: row.costSetId,
            banMode: oneOf(LOBBY_BAN_MODES, row.banMode.tag, d.banMode),
            matchType: oneOf(LOBBY_MATCH_TYPES, row.matchType.tag, d.matchType),
            isAnonymousPlayers: row.isAnonymousPlayers,
            rosterVisibility: oneOf(
                LOBBY_ROSTER_VISIBILITIES,
                row.rosterVisibility.tag,
                d.rosterVisibility,
            ),
            teamSize,
            banRestriction: oneOf(LOBBY_BAN_RESTRICTIONS, row.banRestriction.tag, d.banRestriction),
            lineupFormat: oneOf(LOBBY_LINEUP_FORMATS, row.lineupFormat.tag, d.lineupFormat),
            standardTurnSeconds: row.standardTurnSeconds,
            reserveBankSeconds: row.reserveBankSeconds,
            confirmWindowSeconds: row.confirmWindowSeconds,
            characterBudget: row.characterBudget,
            lightconeBudget: row.lightconeBudget,
            minimumBidRaise: row.minimumBidRaise,
            rosterDiffAdvantage: row.rosterDiffAdvantage,
            rosterThreshold: row.rosterThreshold,
            underThresholdAdvantage: row.underThresholdAdvantage,
            aboveThresholdPenalty: row.aboveThresholdPenalty,
            deathPenalty: row.deathPenalty,
            requireOwnership: row.requireOwnership,
            isAnonymousSpectators: row.isAnonymousSpectators,
            hideMmr: row.hideMmr,
            disconnectPolicy: policy === 'Deferred' ? 'Standard' : policy,
            disconnectForfeitSeconds: row.disconnectForfeitSeconds ?? 0,
            allowMirrorPicks: row.allowMirrorPicks,
            autoRandomPick: row.autoRandomPick,
            refereeCanUndo: row.refereeCanUndo,
            refereeCanPause: row.refereeCanPause,
            refereeCanSetCaptain: row.refereeCanSetCaptain,
            refereeCanKick: row.refereeCanKick,
            allowPlayerPause: row.allowPlayerPause,
            refereeExclusiveConcede: row.refereeExclusiveConcede,
            maxSpectators: row.maxSpectators,
            teamBlueAlias: '',
            teamRedAlias: '',
        },
    };
}

/**
 * The preset list: the two built-in ones, then the module's system preset, then the person's own presets by name
 * (`view_lobby_presets` sends the system preset plus the caller's own; a visitor gets none).
 */
export function lobbyPresetChoices(rows: readonly ModuleLobbyPreset[]): LobbyPresetChoice[] {
    const system = rows.filter((r) => r.isSystemPreset);
    const own = rows
        .filter((r) => !r.isSystemPreset)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    return [...BUILT_IN_PRESETS, ...[...system, ...own].map(presetFromModule)];
}

// ─── Who is filling it in, and what they may pick ────────────────────────────────────────────────────────────────

/** A cost set the person may pick (a `view_published_cost_sets` row; the generated `CostSet` fits it). */
export interface LobbyCostSetOption {
    id: number;
    name: string;
    gameMode: Tag;
    isLocked: boolean;
}

export interface LobbyFormRules {
    /** A guest: Ranked is refused and the roster is Closed No Rating (D-23). */
    isGuest: boolean;
    /** The published cost sets (the default set, id 0, is always available and not listed). */
    costSets: readonly LobbyCostSetOption[];
}

/** The sets the cost set picker offers: published and not locked (lock_cost_set stops new selections). */
export function selectableCostSets(costSets: readonly LobbyCostSetOption[]): LobbyCostSetOption[] {
    return costSets
        .filter((s) => !s.isLocked)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/** The game mode a custom cost set fixes (A185 item 1), or undefined for the default set or an unknown one. */
export function costSetGameMode(
    costSetId: number,
    costSets: readonly LobbyCostSetOption[],
): LobbyGameMode | undefined {
    if (costSetId === DEFAULT_COST_SET) return undefined;
    const set = costSets.find((s) => s.id === costSetId);
    return set
        ? oneOf(LOBBY_GAME_MODES, set.gameMode.tag, DEFAULT_LOBBY_SETTINGS.gameMode)
        : undefined;
}

/** Why the game mode cannot change while a custom cost set is picked (the team builder's sentence, S14.3a). */
export const costSetLockedText = (setName: string, mode: LobbyGameMode) =>
    `The cost set ${setName} is for ${GAME_MODE_LABEL[mode]} only. Pick Default to change the game mode.`;

/**
 * The form's value after a change, made consistent with what the module will do and the page shows: a guest's match
 * type stays Casual and their roster Closed No Rating (the module forces the roster, D-23, and refuses Ranked); a
 * custom cost set fixes the game mode to its own (A185 item 1).
 */
export function settleLobbySettings(settings: LobbySettings, rules: LobbyFormRules): LobbySettings {
    let next = settings;
    if (
        rules.isGuest &&
        (next.matchType !== 'Casual' || next.rosterVisibility !== 'ClosedNoRating')
    ) {
        next = { ...next, matchType: 'Casual', rosterVisibility: 'ClosedNoRating' };
    }
    const fixed = costSetGameMode(next.costSetId, rules.costSets);
    if (fixed !== undefined && fixed !== next.gameMode) next = { ...next, gameMode: fixed };
    return next;
}

/** The form after picking a preset: its values, the name and password kept, settled for the person. */
export function applyLobbyPreset(
    current: LobbySettings,
    preset: LobbyPresetChoice,
    rules: LobbyFormRules,
): LobbySettings {
    return settleLobbySettings(
        { ...preset.values, name: current.name, password: current.password },
        rules,
    );
}

/**
 * True while the form still holds what `preset` sets (every value but the name and password, as the person would get
 * it): the preset select names it; once a field it set is edited, the select says "Custom".
 */
export function lobbyPresetMatches(
    current: LobbySettings,
    preset: LobbyPresetChoice,
    rules: LobbyFormRules,
): boolean {
    return !lobbySettingsChanged(current, applyLobbyPreset(current, preset, rules));
}

/** The starting value for a person: the defaults, settled (a guest starts with Closed No Rating). */
export function initialLobbySettings(rules: LobbyFormRules): LobbySettings {
    return settleLobbySettings({ ...DEFAULT_LOBBY_SETTINGS }, rules);
}

/** True when the person changed anything from `initial` (closing then asks before discarding). */
export function lobbySettingsChanged(current: LobbySettings, initial: LobbySettings): boolean {
    // `Object.is`: a number field left empty or half typed (NaN) is not a change against itself.
    return (Object.keys(initial) as LobbySettingKey[]).some(
        (k) => !Object.is(current[k], initial[k]),
    );
}

/** The settings a number field edits (S14.4d's Advanced Settings). */
export type LobbyNumberKey = {
    [K in LobbySettingKey]: LobbySettings[K] extends number ? K : never;
}[LobbySettingKey];

/**
 * The text of each number field as the person typed it, apart from the value (which holds numbers only): an empty
 * or half typed field ("", "-", "1.") keeps its text while the value holds NaN, which validation refuses.
 */
export type LobbyNumberDrafts = Partial<Record<LobbyNumberKey, string>>;

/** A number field's text as a number: NaN for an empty or unreadable text (validation refuses NaN). */
export function numberFromDraft(text: string): number {
    const trimmed = text.trim();
    if (trimmed === '' || !/^-?\d*(\.\d*)?$/.test(trimmed) || /^-?\.?$/.test(trimmed))
        return Number.NaN;
    return Number(trimmed);
}

/** What a number field shows: its draft while one exists, else the value. */
export function numberDraftText(
    drafts: LobbyNumberDrafts,
    key: LobbyNumberKey,
    value: number,
): string {
    return drafts[key] ?? (Number.isNaN(value) ? '' : String(value));
}

// ─── Validation ──────────────────────────────────────────────────────────────────────────────────────────────────

export type LobbySettingsErrors = Partial<Record<LobbySettingKey, string>>;

const isInt = (n: number) => Number.isInteger(n);
const inRange = (n: number, min: number, max: number) => isInt(n) && n >= min && n <= max;
const amountOk = (n: number) => Number.isFinite(n) && n >= 0 && n <= LOBBY_BUDGET_MAX;

/** The field's error sentence for a password, or undefined when it follows the module's rule (A163(4)). */
export function lobbyPasswordError(password: string): string | undefined {
    if (password.length > LOBBY_PASSWORD_MAX)
        return `Use at most ${LOBBY_PASSWORD_MAX} characters.`;
    if (!LOBBY_PASSWORD_CHARS.test(password))
        // U+2060 (word joiner) after each dash: a narrow screen never breaks a range as "0–" / "9)".
        return 'Use letters and numbers only (A–⁠Z, a–⁠z, 0–⁠9).';
    return undefined;
}

/**
 * Every setting the module would refuse, as one sentence per field (the form's wording; the module's own sentences
 * name arguments such as `standardTurnSeconds`). Empty when `create_lobby` accepts the values, apart from what only
 * the module knows: whether the cost set covers the game mode and draft mode, the one-lobby rule, the creation limit
 * and the guest switch.
 */
export function validateLobbySettings(
    s: LobbySettings,
    rules: LobbyFormRules,
): LobbySettingsErrors {
    const e: LobbySettingsErrors = {};
    if (s.name.trim().length > LOBBY_NAME_MAX_LENGTH)
        e.name = `Use at most ${LOBBY_NAME_MAX_LENGTH} characters.`;
    const password = lobbyPasswordError(s.password);
    if (password) e.password = password;

    if (s.costSetId !== DEFAULT_COST_SET) {
        const set = rules.costSets.find((c) => c.id === s.costSetId);
        const fixed = costSetGameMode(s.costSetId, rules.costSets);
        if (!set || set.isLocked) e.costSetId = 'This cost set is not available. Pick another one.';
        else if (fixed !== undefined && fixed !== s.gameMode)
            e.gameMode = costSetLockedText(set.name, fixed);
    }
    if (rules.isGuest && s.matchType === 'Ranked')
        e.matchType = 'Guests can only create Casual lobbies.';
    if (!(LOBBY_TEAM_SIZES as readonly number[]).includes(s.teamSize))
        e.teamSize = 'Pick 1v1, 2v2 or 3v3.';

    if (!inRange(s.standardTurnSeconds, LOBBY_TURN_SECONDS_MIN, LOBBY_TURN_SECONDS_MAX))
        e.standardTurnSeconds = `The standard turn is ${LOBBY_TURN_SECONDS_MIN} to ${LOBBY_TURN_SECONDS_MAX} seconds.`;
    if (!inRange(s.reserveBankSeconds, 0, LOBBY_RESERVE_SECONDS_MAX))
        e.reserveBankSeconds = `The reserve bank is 0 to ${LOBBY_RESERVE_SECONDS_MAX} seconds.`;
    if (!inRange(s.confirmWindowSeconds, 0, LOBBY_CONFIRM_WINDOW_SECONDS_MAX))
        e.confirmWindowSeconds = `The confirm window is 0 to ${LOBBY_CONFIRM_WINDOW_SECONDS_MAX} seconds.`;
    for (const [key, label] of [
        ['characterBudget', 'The character budget'],
        ['lightconeBudget', 'The light cone budget'],
        ['minimumBidRaise', 'The minimum bid raise'],
    ] as const) {
        if (!amountOk(s[key]))
            e[key] = `${label} is 0 to ${LOBBY_BUDGET_MAX.toLocaleString('en-US')}.`;
    }
    // An Auction lobby needs something to bid with and a raise that moves (user ruling, S14.4c-fix; the module's
    // bounds helper refuses the same).
    if (s.draftMode === 'Auction') {
        if (e.characterBudget === undefined && !(s.characterBudget > 0))
            e.characterBudget = AUCTION_CHARACTER_BUDGET_TEXT;
        if (e.minimumBidRaise === undefined && !(s.minimumBidRaise > 0))
            e.minimumBidRaise = AUCTION_MINIMUM_RAISE_TEXT;
    }
    for (const [key, label] of [
        ['rosterDiffAdvantage', 'The roster diff advantage'],
        ['underThresholdAdvantage', 'The under-threshold advantage'],
        ['aboveThresholdPenalty', 'The above-threshold penalty'],
        ['deathPenalty', 'The death penalty'],
    ] as const) {
        if (!inRange(s[key], -LOBBY_HANDICAP_MAX_HUNDREDTHS, LOBBY_HANDICAP_MAX_HUNDREDTHS))
            e[key] = `${label} is -10,000 to 10,000 points, in steps of 0.01.`;
    }
    if (!inRange(s.rosterThreshold, 0, LOBBY_HANDICAP_MAX_HUNDREDTHS))
        e.rosterThreshold = 'The roster threshold is 0 to 10,000 points, in steps of 0.01.';

    if (s.disconnectPolicy === 'Deferred')
        e.disconnectPolicy = 'Deferred is only for tournament lobbies.';
    else if (s.disconnectPolicy === 'NoAction' && s.matchType === 'Ranked')
        e.disconnectPolicy = 'No Action is only for Casual lobbies.';
    if (
        s.disconnectForfeitSeconds !== 0 &&
        !inRange(s.disconnectForfeitSeconds, LOBBY_FORFEIT_SECONDS_MIN, LOBBY_FORFEIT_SECONDS_MAX)
    )
        e.disconnectForfeitSeconds = `Auto-forfeit is 0 (the default, ${LOBBY_FORFEIT_SECONDS_DEFAULT} s) or ${LOBBY_FORFEIT_SECONDS_MIN} to ${LOBBY_FORFEIT_SECONDS_MAX} seconds.`;
    if (!inRange(s.maxSpectators, 0, LOBBY_MAX_SPECTATORS_MAX))
        e.maxSpectators = `Spectators are 0 to ${LOBBY_MAX_SPECTATORS_MAX}.`;
    if (s.teamBlueAlias.length > LOBBY_TEAM_ALIAS_MAX_LENGTH)
        e.teamBlueAlias = `Use at most ${LOBBY_TEAM_ALIAS_MAX_LENGTH} characters.`;
    if (s.teamRedAlias.length > LOBBY_TEAM_ALIAS_MAX_LENGTH)
        e.teamRedAlias = `Use at most ${LOBBY_TEAM_ALIAS_MAX_LENGTH} characters.`;
    return e;
}

// ─── Points and hundredths (A21) ─────────────────────────────────────────────────────────────────────────────────

/** Points as typed (2 decimals at most) to the module's hundredths; NaN for anything else. */
export function pointsToHundredths(points: number): number {
    const h = Math.round(points * 100);
    return Number.isFinite(points) && Math.abs(points * 100 - h) < 1e-6 ? h : Number.NaN;
}

export const hundredthsToPoints = (hundredths: number) => hundredths / 100;

// ─── The reducer call ────────────────────────────────────────────────────────────────────────────────────────────

/** `create_lobby`'s arguments (the generated `CreateLobbyParams` accepts this shape). */
export interface CreateLobbyArgs {
    teamSize: number;
    draftMode: { tag: LobbyDraftMode };
    banMode: { tag: LobbyBanMode };
    gameMode: { tag: LobbyGameMode };
    matchType: { tag: LobbyMatchType };
    isPublic: boolean;
    password: string;
    standardTurnSeconds: number;
    reserveBankSeconds: number;
    characterBudget: number;
    lightconeBudget: number;
    minimumBidRaise: number;
    rosterDiffAdvantage: number;
    rosterThreshold: number;
    underThresholdAdvantage: number;
    aboveThresholdPenalty: number;
    deathPenalty: number;
    isAnonymousPlayers: boolean;
    isAnonymousSpectators: boolean;
    rosterVisibility: { tag: LobbyRosterVisibility };
    requireOwnership: boolean;
    costSetId: number;
    disconnectPolicy: { tag: LobbyDisconnectPolicy };
    disconnectForfeitSeconds: number;
    allowMirrorPicks: boolean;
    autoRandomPick: boolean;
    refereeCanUndo: boolean;
    refereeCanPause: boolean;
    refereeCanSetCaptain: boolean;
    refereeCanKick: boolean;
    allowPlayerPause: boolean;
    teamBlueAlias: string;
    teamRedAlias: string;
    name?: string;
    banRestriction?: { tag: LobbyBanRestriction };
    lineupFormat?: { tag: LobbyLineupFormat };
    hideMmr?: boolean;
    refereeExclusiveConcede?: boolean;
    maxSpectators?: number;
    confirmWindowSeconds?: number;
    abandonCurrentMatch?: boolean;
}

/**
 * The form's value as `create_lobby`'s arguments. The password decides privacy (A99: an empty one is a public lobby,
 * so "private without a password" cannot be sent); the name is trimmed; Ranked sends no mirror picks (the module
 * forces it, D-42). `abandonCurrentMatch` only after the person confirmed the A68(4) prompt.
 */
export function toCreateLobbyArgs(
    s: LobbySettings,
    options: { abandonCurrentMatch?: boolean } = {},
): CreateLobbyArgs {
    const args: CreateLobbyArgs = {
        teamSize: s.teamSize,
        draftMode: { tag: s.draftMode },
        banMode: { tag: s.banMode },
        gameMode: { tag: s.gameMode },
        matchType: { tag: s.matchType },
        isPublic: s.password === '',
        password: s.password,
        standardTurnSeconds: s.standardTurnSeconds,
        reserveBankSeconds: s.reserveBankSeconds,
        characterBudget: s.characterBudget,
        lightconeBudget: s.lightconeBudget,
        minimumBidRaise: s.minimumBidRaise,
        rosterDiffAdvantage: s.rosterDiffAdvantage,
        rosterThreshold: s.rosterThreshold,
        underThresholdAdvantage: s.underThresholdAdvantage,
        aboveThresholdPenalty: s.aboveThresholdPenalty,
        deathPenalty: s.deathPenalty,
        isAnonymousPlayers: s.isAnonymousPlayers,
        isAnonymousSpectators: s.isAnonymousSpectators,
        rosterVisibility: { tag: s.rosterVisibility },
        requireOwnership: s.requireOwnership,
        costSetId: s.costSetId,
        disconnectPolicy: { tag: s.disconnectPolicy },
        disconnectForfeitSeconds: s.disconnectForfeitSeconds,
        allowMirrorPicks: s.matchType === 'Ranked' ? false : s.allowMirrorPicks,
        autoRandomPick: s.autoRandomPick,
        refereeCanUndo: s.refereeCanUndo,
        refereeCanPause: s.refereeCanPause,
        refereeCanSetCaptain: s.refereeCanSetCaptain,
        refereeCanKick: s.refereeCanKick,
        allowPlayerPause: s.allowPlayerPause,
        teamBlueAlias: s.teamBlueAlias,
        teamRedAlias: s.teamRedAlias,
        name: s.name.trim(),
        banRestriction: { tag: s.banRestriction },
        lineupFormat: { tag: s.lineupFormat },
        hideMmr: s.hideMmr,
        refereeExclusiveConcede: s.refereeExclusiveConcede,
        maxSpectators: s.maxSpectators,
        confirmWindowSeconds: s.confirmWindowSeconds,
    };
    if (options.abandonCurrentMatch) args.abandonCurrentMatch = true;
    return args;
}

// ─── The one-lobby rule (D-22, A68(4)) ───────────────────────────────────────────────────────────────────────────

/** The live stages of a lobby's one game (the module's `LIVE_STAGES`, A67(1); pinned by the test). */
export const LOBBY_LIVE_STAGES = ['Drafting', 'Equipping', 'Scoring'] as const;

/**
 * How a `view_my_lobbies` row counts for the one-lobby rule, as the module's `membershipHold` decides it: `free` in
 * AwaitingResult (the view drops abandoned rows); `away` for a left player in a live stage (they may give it up with
 * `abandonCurrentMatch`); `held` otherwise (the creator must leave it first).
 */
export function lobbyHoldOf(row: { stage: Tag; isAway: boolean }): 'free' | 'away' | 'held' {
    if (row.stage.tag === 'AwaitingResult') return 'free';
    if (row.isAway && (LOBBY_LIVE_STAGES as readonly string[]).includes(row.stage.tag))
        return 'away';
    return 'held';
}

/** The first row the person is away from (a live match they left), if any: creating gives it up (A68(4)). */
export function awayLobbyOf<R extends { stage: Tag; isAway: boolean }>(
    rows: readonly R[],
): R | undefined {
    return rows.find((r) => lobbyHoldOf(r) === 'away');
}

/** How a lobby is named to its member in a sentence: its name, else its join code. */
export function lobbyLabel(row: { name: string; joinCode: string }): string {
    const name = row.name.trim();
    return name ? `${name} (${row.joinCode})` : row.joinCode;
}

/** The lobby that keeps the person from creating another (the first `held` row), if any. */
export function heldLobbyOf<R extends { stage: Tag; isAway: boolean }>(
    rows: readonly R[],
): R | undefined {
    return rows.find((r) => lobbyHoldOf(r) === 'held');
}
