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
//   team names             spacetimedb/src/helpers/lobby/lobbyConfigBounds.ts      ensureTeamAliases (at most 30)
//
// S14.4d: Advanced Settings edits the same value (`LOBBY_ADVANCED_FIELDS`); its number fields keep a text draft each
// and read it with `readLobbyNumber` (handicap points to hundredths by digit arithmetic, amounts as AmountField reads
// them).
//
// The handicap values are kept in the module's unit, hundredths of a point (A21), so a preset round-trips exactly;
// a field that shows points converts with `pointsToHundredths` / `hundredthsToPoints`.

import { amountText, readAmount } from '@shared/teambuilder/amount';

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
/** The mockup's six options, in its order (`#inpBanRestrict`). */
export const BAN_RESTRICTION_OPTIONS: readonly LobbyBanRestriction[] = [
    'NoRestriction',
    'MaxOnePerRole',
    'MaxOneDps',
    'MaxTwoDps',
    'MaxOneSupport',
    'MaxOneSustain',
];
export const BAN_RESTRICTION_LABEL: Record<LobbyBanRestriction, string> = {
    NoRestriction: 'No restriction',
    MaxOneDps: 'Max 1 DPS',
    MaxTwoDps: 'Max 2 DPS',
    MaxOnePerRole: 'Max 1 per role',
    MaxOneSupport: 'Max 1 support',
    MaxOneSustain: 'Max 1 sustain',
};
/** A21: the format is the character count (groups of 4). */
export const LINEUP_FORMAT_LABEL: Record<LobbyLineupFormat, string> = {
    Halves: 'Halves · 8 characters',
    Thirds: 'Thirds · 12 characters',
};
export const DISCONNECT_POLICY_LABEL: Record<LobbyDisconnectPolicy, string> = {
    Standard: 'Standard',
    Deferred: 'Deferred',
    NoAction: 'No Action',
};
/** The policies `create_lobby` takes (A91(2): Deferred is for tournament lobbies only, so it is not offered). */
export const LOBBY_CREATE_DISCONNECT_POLICIES: readonly LobbyDisconnectPolicy[] = [
    'Standard',
    'NoAction',
];

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

/**
 * The fields of Advanced Settings (S14.4d), in the order they are shown (the mockup's groups: match with the team names,
 * Auction economy, handicaps, ownership, timers, referee powers, privacy and spectators, disconnect handling); the first invalid one
 * takes focus after a failed submit when no main field is invalid.
 */
export const LOBBY_ADVANCED_FIELDS = [
    'banRestriction',
    'lineupFormat',
    'teamBlueAlias',
    'teamRedAlias',
    'allowMirrorPicks',
    'autoRandomPick',
    'characterBudget',
    'lightconeBudget',
    'minimumBidRaise',
    'deathPenalty',
    'rosterDiffAdvantage',
    'rosterThreshold',
    'underThresholdAdvantage',
    'aboveThresholdPenalty',
    'requireOwnership',
    'standardTurnSeconds',
    'reserveBankSeconds',
    'confirmWindowSeconds',
    'refereeCanUndo',
    'refereeCanPause',
    'refereeCanSetCaptain',
    'refereeCanKick',
    'allowPlayerPause',
    'refereeExclusiveConcede',
    'isAnonymousSpectators',
    'hideMmr',
    'maxSpectators',
    'disconnectPolicy',
    'disconnectForfeitSeconds',
] as const satisfies readonly LobbySettingKey[];

export type LobbyAdvancedField = (typeof LOBBY_ADVANCED_FIELDS)[number];

/** The keys of `errors` that belong to Advanced Settings (for the button's mark and the focus rule). */
export function advancedErrorKeys(errors: LobbySettingsErrors): LobbyAdvancedField[] {
    return LOBBY_ADVANCED_FIELDS.filter((k) => errors[k] !== undefined);
}

/**
 * The settings a preset never holds: the lobby's own name and password, and (S14.4d-fix, review D S2) its two team
 * names, which `LobbyPreset` has no column for. Picking a preset keeps them; editing them never makes the form "Custom".
 */
export const LOBBY_OWN_FIELDS = ['name', 'password', 'teamBlueAlias', 'teamRedAlias'] as const;
type LobbyOwnField = (typeof LOBBY_OWN_FIELDS)[number];

/** A preset's values: everything but the lobby's own name, password and team names. */
export type LobbyPresetValues = Omit<LobbySettings, LobbyOwnField>;

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
    const {
        name: _name,
        password: _password,
        teamBlueAlias: _blue,
        teamRedAlias: _red,
        ...values
    } = settings;
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

/** The form after picking a preset: its values, the name, password and team names kept, settled for the person. */
export function applyLobbyPreset(
    current: LobbySettings,
    preset: LobbyPresetChoice,
    rules: LobbyFormRules,
): LobbySettings {
    return settleLobbySettings(
        {
            ...preset.values,
            name: current.name,
            password: current.password,
            teamBlueAlias: current.teamBlueAlias,
            teamRedAlias: current.teamRedAlias,
        },
        rules,
    );
}

/**
 * True while the form still holds what `preset` sets (every value but the name, password and team names, as the
 * person would get it): the preset select names it; once a field it set is edited, the select says "Custom".
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

/**
 * A number field's text as a number: NaN for an empty or unreadable text (validation refuses NaN). "-0" reads as 0,
 * never -0 (review D M2: -0 would differ from 0 under `Object.is`).
 */
export function numberFromDraft(text: string): number {
    const trimmed = text.trim();
    if (trimmed === '' || !/^-?\d*(\.\d*)?$/.test(trimmed) || /^-?\.?$/.test(trimmed))
        return Number.NaN;
    return Number(trimmed) + 0;
}

/** What a number field shows: its draft while one exists, else the value. */
export function numberDraftText(
    drafts: LobbyNumberDrafts,
    key: LobbyNumberKey,
    value: number,
): string {
    return drafts[key] ?? (Number.isNaN(value) ? '' : String(value));
}

/**
 * How Advanced Settings reads and writes each number field (S14.4d):
 * - `whole`: a whole number as typed (seconds, spectators); a decimal reads but validation refuses it.
 * - `amount`: an Auction amount as the team builder's AmountField reads it (`readAmount`: a dot or a comma as the
 *   decimal mark, a currency sign at either end dropped), except that a third decimal is refused, as in the points
 *   fields (S14.4d-fix, review D M6: one rule in one dialog; the module's f32 cannot hold 0.01 steps exactly either, so
 *   rounding would only change what was typed, not make it exact); the value is the amount itself (the module takes an
 *   f32).
 *
 * One rule for separators in every number field (review D M1): no thousands separator. A comma is a decimal mark in the
 * amount and points fields ("1,5"); a comma followed by exactly three digits ("1,000") is refused as unclear, and the
 * range sentences write their bounds without a separator ("0 to 100000") and say so.
 * - `signedPoints` / `points`: points entered whole or with up to two decimals (a dot or a comma), stored in
 *   hundredths (A21) by exact digit arithmetic, never by multiplying a float; `points` refuses a sign (the roster
 *   threshold is a u32).
 */
export type LobbyNumberFieldKind = 'whole' | 'amount' | 'signedPoints' | 'points';

export const LOBBY_NUMBER_FIELD_KIND = {
    standardTurnSeconds: 'whole',
    reserveBankSeconds: 'whole',
    confirmWindowSeconds: 'whole',
    disconnectForfeitSeconds: 'whole',
    maxSpectators: 'whole',
    characterBudget: 'amount',
    lightconeBudget: 'amount',
    minimumBidRaise: 'amount',
    deathPenalty: 'signedPoints',
    rosterDiffAdvantage: 'signedPoints',
    underThresholdAdvantage: 'signedPoints',
    aboveThresholdPenalty: 'signedPoints',
    rosterThreshold: 'points',
} as const satisfies Partial<Record<LobbyNumberKey, LobbyNumberFieldKind>>;

export type LobbyNumberFieldKey = keyof typeof LOBBY_NUMBER_FIELD_KIND;

/** Larger than any bound the form checks: `readAmount` caps at its `max`, the form wants the range error instead. */
const AMOUNT_READ_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Points as typed ("1", "-2.5", "0,25", ".5") to hundredths, exactly: digits only, no float multiplication, so "1.15"
 * is 115 and "10000.01" is 1000001. NaN for an empty text, a third decimal, a sign where `signed` is false, or
 * anything else.
 */
export function pointsTextToHundredths(text: string, signed = true): number {
    const m = /^(-?)(\d*)(?:[.,](\d{0,2}))?$/.exec(text.trim());
    if (!m) return Number.NaN;
    const [, sign = '', whole = '', fraction = ''] = m;
    if (whole === '' && fraction === '') return Number.NaN;
    if (sign && !signed) return Number.NaN;
    // Longer than any bound: the range check refuses it without reading it exactly.
    if (whole.length > 12) return sign ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    const hundredths = Number(whole || '0') * 100 + Number(`${fraction}00`.slice(0, 2));
    return sign && hundredths !== 0 ? -hundredths : hundredths;
}

/** Hundredths as points text ("115" is "1.15", "-50" is "-0.5", "300" is "3"), by integer arithmetic. */
export function hundredthsToPointsText(hundredths: number): string {
    if (!Number.isInteger(hundredths))
        return Number.isNaN(hundredths) ? '' : String(hundredths / 100);
    const sign = hundredths < 0 ? '-' : '';
    const abs = Math.abs(hundredths);
    const whole = Math.floor(abs / 100);
    const cents = abs % 100;
    if (cents === 0) return `${sign}${whole}`;
    return `${sign}${whole}.${String(cents).padStart(2, '0').replace(/0$/, '')}`;
}

/** A number field's text as the value the form keeps for `key` (NaN when it does not read; validation refuses NaN). */
export function readLobbyNumber(key: LobbyNumberFieldKey, text: string): number {
    switch (LOBBY_NUMBER_FIELD_KIND[key]) {
        case 'whole':
            return numberFromDraft(text);
        case 'amount': {
            // A third decimal is refused (see LobbyNumberFieldKind), never rounded.
            if (/[.,]\d{3,}/.test(text)) return Number.NaN;
            const read = readAmount(text, AMOUNT_READ_MAX);
            return read.kind === 'amount' ? read.value / 100 : Number.NaN;
        }
        case 'signedPoints':
            return pointsTextToHundredths(text, true);
        case 'points':
            return pointsTextToHundredths(text, false);
    }
}

/** The text a number field shows for a value of `key` (empty for NaN). */
export function lobbyNumberText(key: LobbyNumberFieldKey, value: number): string {
    if (Number.isNaN(value)) return '';
    switch (LOBBY_NUMBER_FIELD_KIND[key]) {
        case 'whole':
            return String(value);
        case 'amount':
            // An f32 from a module preset (30.1 is 30.100000381…) shows as the amount it stands for.
            return Number.isFinite(value) ? amountText(Math.round(value * 100)) : String(value);
        case 'signedPoints':
        case 'points':
            return hundredthsToPointsText(value);
    }
}

/**
 * What a number field shows: the person's draft while it still reads as the current value (so "1." or "abc" stay as
 * typed), else the value's own text (a preset picked meanwhile replaced it).
 */
export function lobbyNumberFieldText(
    key: LobbyNumberFieldKey,
    draft: string | undefined,
    value: number,
): string {
    if (draft !== undefined && Object.is(readLobbyNumber(key, draft), value)) return draft;
    return lobbyNumberText(key, value);
}

/**
 * A number field's text once the person leaves it (S14.4d-fix, review D S4): a text that reads becomes the text of the
 * value it sends (" 60 " is "60", "1." is "1", "$5" is "5", "2,5" is "2.5", "-0" is "0"), so the field never shows
 * something other than what Create sends; a text that does not read stays as typed, beside its error, and so does one
 * far beyond every bound (at least 1e12, which the readers cap or round), which can never be sent.
 */
export function lobbyNumberLeaveText(key: LobbyNumberFieldKey, text: string): string {
    const value = readLobbyNumber(key, text);
    return Number.isNaN(value) || Math.abs(value) >= 1e12 ? text : lobbyNumberText(key, value);
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
 * The three amounts as the module checks them, one sentence per field: each 0 to 100000 (ensureLobbyConfigInRange),
 * and in Auction a character budget and a minimum bid raise above 0 (ensureAuctionAmounts; user ruling, S14.4c-fix).
 * The module applies the same two checks when a lobby is created or updated and, since S14.4t, when a preset is saved
 * (create_lobby_preset, update_lobby_preset), so a preset save form can call this on its values.
 */
export function lobbyAmountErrors(
    s: Pick<LobbySettings, 'draftMode' | 'characterBudget' | 'lightconeBudget' | 'minimumBidRaise'>,
): LobbySettingsErrors {
    const e: LobbySettingsErrors = {};
    for (const [key, label] of [
        ['characterBudget', 'The character budget'],
        ['lightconeBudget', 'The light cone budget'],
        ['minimumBidRaise', 'The minimum bid raise'],
    ] as const) {
        if (!amountOk(s[key]))
            e[key] =
                `${label} is 0 to ${LOBBY_BUDGET_MAX}, in steps of 0.01, with no thousands separator.`;
    }
    // An Auction lobby needs something to bid with and a raise that moves.
    if (s.draftMode === 'Auction') {
        if (e.characterBudget === undefined && !(s.characterBudget > 0))
            e.characterBudget = AUCTION_CHARACTER_BUDGET_TEXT;
        if (e.minimumBidRaise === undefined && !(s.minimumBidRaise > 0))
            e.minimumBidRaise = AUCTION_MINIMUM_RAISE_TEXT;
    }
    return e;
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
    Object.assign(e, lobbyAmountErrors(s));
    for (const [key, label] of [
        ['rosterDiffAdvantage', 'The roster diff advantage'],
        ['underThresholdAdvantage', 'The under-threshold advantage'],
        ['aboveThresholdPenalty', 'The above-threshold penalty'],
        ['deathPenalty', 'The death penalty'],
    ] as const) {
        if (!inRange(s[key], -LOBBY_HANDICAP_MAX_HUNDREDTHS, LOBBY_HANDICAP_MAX_HUNDREDTHS))
            e[key] = `${label} is -10000 to 10000, in steps of 0.01, with no thousands separator.`;
    }
    if (!inRange(s.rosterThreshold, 0, LOBBY_HANDICAP_MAX_HUNDREDTHS))
        e.rosterThreshold =
            'The roster threshold is 0 to 10000, in steps of 0.01, with no thousands separator.';

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
    if (s.teamBlueAlias.trim().length > LOBBY_TEAM_ALIAS_MAX_LENGTH)
        e.teamBlueAlias = `Use at most ${LOBBY_TEAM_ALIAS_MAX_LENGTH} characters.`;
    if (s.teamRedAlias.trim().length > LOBBY_TEAM_ALIAS_MAX_LENGTH)
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
 * so "private without a password" cannot be sent); the name and the team names are trimmed (an all-space team name is
 * sent empty, so the sides keep Blue and Red; review D M3); Ranked sends no mirror picks (the module forces it, D-42);
 * an Auction lobby sends neither mirror picks nor random auto-pick, which the module reads in the Classic draft only
 * (review D M4; the form shows both Off there). `abandonCurrentMatch` only after the person confirmed the A68(4) prompt.
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
        allowMirrorPicks:
            s.matchType === 'Ranked' || s.draftMode === 'Auction' ? false : s.allowMirrorPicks,
        autoRandomPick: s.draftMode === 'Auction' ? false : s.autoRandomPick,
        refereeCanUndo: s.refereeCanUndo,
        refereeCanPause: s.refereeCanPause,
        refereeCanSetCaptain: s.refereeCanSetCaptain,
        refereeCanKick: s.refereeCanKick,
        allowPlayerPause: s.allowPlayerPause,
        teamBlueAlias: s.teamBlueAlias.trim(),
        teamRedAlias: s.teamRedAlias.trim(),
        name: s.name.trim(),
        banRestriction: { tag: s.banRestriction },
        lineupFormat: { tag: s.lineupFormat },
        hideMmr: s.hideMmr,
        refereeExclusiveConcede: s.refereeExclusiveConcede,
        maxSpectators: s.maxSpectators,
        confirmWindowSeconds: s.confirmWindowSeconds,
    };
    if (options.abandonCurrentMatch) args.abandonCurrentMatch = true;
    // The form validates first; this is the last guard: a NaN or an infinity is never sent (an f32 would carry it).
    for (const [key, v] of Object.entries(args)) {
        if (typeof v === 'number' && !Number.isFinite(v))
            throw new RangeError(`create_lobby argument ${key} is not a finite number.`);
    }
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
