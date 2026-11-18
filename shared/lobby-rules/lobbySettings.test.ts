import { readFileSync } from 'node:fs';
import CreateLobbyReducer from '@bindings/create_lobby_reducer';
import {
    ensureForfeitSecondsInRange,
    ensureNoActionAllowed,
    ensureNotDeferredOutsideTournament,
} from '@module/helpers/lobby/disconnectHelpers';
import {
    CONFIRM_WINDOW_SECONDS_DEFAULT,
    ensureAuctionAmounts,
    ensureLobbyConfigInRange,
    ensureTeamAliases,
    resolveConfirmWindowSeconds,
    TEAM_ALIAS_MAX_LENGTH,
} from '@module/helpers/lobby/lobbyConfigBounds';
import {
    ensureGuestHostOwnership,
    GUEST_OWNERSHIP_TEXT as MODULE_GUEST_OWNERSHIP_TEXT,
    LIVE_STAGES as MODULE_LIVE_STAGES,
    resolveMaxSpectators,
} from '@module/helpers/lobby/lobbyHelpers';
import {
    LOBBY_PASSWORD_MAX_LENGTH,
    lobbyPasswordRuleError,
} from '@module/helpers/lobby/lobbyPassword';
import { LOBBY_NAME_MAX, normalizeLobbyName } from '@module/helpers/tournament/seriesSettings';
import { describe, expect, it } from 'vitest';
import {
    ALREADY_IN_LOBBY_TEXT,
    AUCTION_CHARACTER_BUDGET_TEXT,
    AUCTION_MINIMUM_RAISE_TEXT,
    advancedErrorKeys,
    applyLobbyPreset,
    awayLobbyOf,
    awayPromptCode,
    BAN_RESTRICTION_OPTIONS,
    BUILT_IN_PRESETS,
    DEFAULT_LOBBY_SETTINGS,
    GUEST_OWNERSHIP_TEXT,
    heldLobbyOf,
    hundredthsToPoints,
    hundredthsToPointsText,
    initialLobbySettings,
    LOBBY_ADVANCED_FIELDS,
    LOBBY_BAN_MODES,
    LOBBY_BAN_RESTRICTIONS,
    LOBBY_CONFIRM_WINDOW_SECONDS_DEFAULT,
    LOBBY_CREATE_DISCONNECT_POLICIES,
    LOBBY_DISCONNECT_POLICIES,
    LOBBY_DRAFT_MODES,
    LOBBY_FORFEIT_SECONDS_MAX,
    LOBBY_FORFEIT_SECONDS_MIN,
    LOBBY_GAME_MODES,
    LOBBY_LINEUP_FORMATS,
    LOBBY_LIVE_STAGES,
    LOBBY_MAIN_FIELDS,
    LOBBY_MATCH_TYPES,
    LOBBY_MAX_SPECTATORS_MAX,
    LOBBY_NAME_MAX_LENGTH,
    LOBBY_NUMBER_FIELD_KIND,
    LOBBY_PASSWORD_MAX,
    LOBBY_ROSTER_VISIBILITIES,
    LOBBY_TEAM_ALIAS_MAX_LENGTH,
    type LobbyCostSetOption,
    type LobbyFormRules,
    type LobbyNumberFieldKey,
    type LobbyPresetChoice,
    type LobbySettings,
    lobbyAmountErrors,
    lobbyHoldOf,
    lobbyLabel,
    lobbyNumberFieldText,
    lobbyNumberLeaveText,
    lobbyNumberText,
    lobbyPasswordError,
    lobbyPresetChoices,
    lobbyPresetMatches,
    lobbySettingsChanged,
    type ModuleLobbyPreset,
    modulePresetKey,
    numberDraftText,
    numberFromDraft,
    PRIVATE_LOBBY_NEEDS_PASSWORD_TEXT,
    pointsTextToHundredths,
    pointsToHundredths,
    presetFromModule,
    readLobbyNumber,
    selectableCostSets,
    settleLobbySettings,
    toCreateLobbyArgs,
    validateLobbySettings,
} from './lobbySettings';

// T-S14.4c: the lobby settings form's model: defaults, presets, validation to the module's limits, the reducer
// arguments, the one-lobby rule; and the pins that tie each mirrored limit and sentence to the module's source.

const MEMBER: LobbyFormRules = { isGuest: false, costSets: [] };
const GUEST: LobbyFormRules = { isGuest: true, costSets: [] };
const MOC_SET: LobbyCostSetOption = {
    id: 7,
    name: 'Yuji Open',
    gameMode: { tag: 'MemoryOfChaos' },
    isLocked: false,
};
const LOCKED_SET: LobbyCostSetOption = {
    id: 8,
    name: 'Old Patch',
    gameMode: { tag: 'AnomalyArbitration' },
    isLocked: true,
};
const WITH_SETS: LobbyFormRules = { isGuest: false, costSets: [MOC_SET, LOCKED_SET] };

const settings = (over: Partial<LobbySettings> = {}): LobbySettings => ({
    ...DEFAULT_LOBBY_SETTINGS,
    ...over,
});

function modulePreset(over: Partial<ModuleLobbyPreset> = {}): ModuleLobbyPreset {
    return {
        id: 1,
        name: 'Tournament default',
        isSystemPreset: true,
        teamSize: 1,
        draftMode: { tag: 'Classic' },
        banMode: { tag: 'Four' },
        banRestriction: { tag: 'NoRestriction' },
        lineupFormat: { tag: 'Halves' },
        gameMode: { tag: 'MemoryOfChaos' },
        matchType: { tag: 'Casual' },
        standardTurnSeconds: 60,
        reserveBankSeconds: 120,
        confirmWindowSeconds: 60,
        characterBudget: 0,
        lightconeBudget: 0,
        minimumBidRaise: 20,
        rosterDiffAdvantage: 0,
        rosterThreshold: 0,
        underThresholdAdvantage: 0,
        aboveThresholdPenalty: 0,
        deathPenalty: 0,
        isAnonymousPlayers: false,
        isAnonymousSpectators: false,
        hideMmr: false,
        rosterVisibility: { tag: 'OpenRoster' },
        requireOwnership: false,
        costSetId: 0,
        disconnectPolicy: { tag: 'Standard' },
        disconnectForfeitSeconds: undefined,
        allowMirrorPicks: false,
        autoRandomPick: false,
        refereeCanUndo: true,
        refereeCanPause: true,
        refereeCanSetCaptain: true,
        refereeCanKick: false,
        allowPlayerPause: true,
        refereeExclusiveConcede: true,
        maxSpectators: 12,
        ...over,
    };
}

describe('defaults (A221 R8)', () => {
    it('Apocalyptic Shadow, Auction budgets 30 and 15; the rest as the mockup', () => {
        expect(DEFAULT_LOBBY_SETTINGS).toMatchObject({
            name: '',
            password: '',
            draftMode: 'Classic',
            gameMode: 'ApocalypticShadow',
            costSetId: 0,
            banMode: 'Six',
            matchType: 'Casual',
            isAnonymousPlayers: false,
            rosterVisibility: 'OpenRoster',
            teamSize: 3,
            characterBudget: 30,
            lightconeBudget: 15,
            // User ruling, S14.4c-fix: 5 (was 20).
            minimumBidRaise: 5,
            standardTurnSeconds: 60,
            reserveBankSeconds: 120,
            banRestriction: 'NoRestriction',
            disconnectPolicy: 'Standard',
            disconnectForfeitSeconds: 0,
            refereeCanKick: false,
            refereeExclusiveConcede: true,
        });
        expect(Object.isFrozen(DEFAULT_LOBBY_SETTINGS)).toBe(true);
    });

    it('the defaults pass validation for a member and, settled, for a guest', () => {
        expect(validateLobbySettings(initialLobbySettings(MEMBER), MEMBER)).toEqual({});
        const guest = initialLobbySettings(GUEST);
        expect(guest.rosterVisibility).toBe('ClosedNoRating');
        expect(validateLobbySettings(guest, GUEST)).toEqual({});
    });
});

describe('presets (A116, A221 R7)', () => {
    it('two built-in presets: Default Classic and Default Auction, the defaults with that draft mode', () => {
        expect(BUILT_IN_PRESETS.map((p) => p.label)).toEqual([
            'Default Classic',
            'Default Auction',
        ]);
        const [classic, auction] = BUILT_IN_PRESETS;
        expect(classic?.values.draftMode).toBe('Classic');
        expect(auction?.values.draftMode).toBe('Auction');
        expect({ ...auction?.values, draftMode: 'Classic' }).toEqual(classic?.values);
        expect(classic?.values).not.toHaveProperty('name');
        expect(classic?.values).not.toHaveProperty('password');
    });

    it('a module preset maps field by field; Deferred becomes Standard; an unset forfeit is 0; an unknown tag the default', () => {
        const p = presetFromModule(
            modulePreset({
                id: 42,
                name: 'Mine',
                isSystemPreset: false,
                teamSize: 2,
                draftMode: { tag: 'Auction' },
                banRestriction: { tag: 'MaxOneSustain' },
                disconnectPolicy: { tag: 'Deferred' },
                disconnectForfeitSeconds: undefined,
                rosterVisibility: { tag: 'Unknown' },
                characterBudget: 25.5,
                deathPenalty: -150,
            }),
        );
        expect(p.key).toBe(modulePresetKey(42));
        expect(p.label).toBe('Mine');
        expect(p.values).toMatchObject({
            teamSize: 2,
            draftMode: 'Auction',
            banRestriction: 'MaxOneSustain',
            disconnectPolicy: 'Standard',
            disconnectForfeitSeconds: 0,
            rosterVisibility: 'OpenRoster',
            characterBudget: 25.5,
            deathPenalty: -150,
        });
        // T-S14.4d-fix (review D S2): a preset holds no team names (was: both ''), like the name and password.
        expect(p.values).not.toHaveProperty('teamBlueAlias');
        expect(p.values).not.toHaveProperty('teamRedAlias');
        expect(
            presetFromModule(modulePreset({ disconnectForfeitSeconds: 90 })).values
                .disconnectForfeitSeconds,
        ).toBe(90);
        expect(presetFromModule(modulePreset({ teamSize: 9 })).values.teamSize).toBe(3);
    });

    it('the list: built-ins, the system preset, then own presets by name', () => {
        const list = lobbyPresetChoices([
            modulePreset({ id: 5, name: 'Zeta', isSystemPreset: false }),
            modulePreset({ id: 1, name: 'Tournament default', isSystemPreset: true }),
            modulePreset({ id: 9, name: 'Alpha', isSystemPreset: false }),
        ]);
        expect(list.map((p) => p.label)).toEqual([
            'Default Classic',
            'Default Auction',
            'Tournament default',
            'Alpha',
            'Zeta',
        ]);
        expect(lobbyPresetChoices([]).map((p) => p.label)).toEqual([
            'Default Classic',
            'Default Auction',
        ]);
    });

    it('applying a preset keeps the name and password and settles for the person', () => {
        const current = settings({ name: 'Scrims', password: 'abc123', draftMode: 'Auction' });
        const system = presetFromModule(
            modulePreset({ matchType: { tag: 'Ranked' }, rosterVisibility: { tag: 'OpenRoster' } }),
        );
        const forMember = applyLobbyPreset(current, system, MEMBER);
        expect(forMember).toMatchObject({
            name: 'Scrims',
            password: 'abc123',
            draftMode: 'Classic',
            teamSize: 1,
            gameMode: 'MemoryOfChaos',
            matchType: 'Ranked',
        });
        const forGuest = applyLobbyPreset(current, system, GUEST);
        expect(forGuest).toMatchObject({ matchType: 'Casual', rosterVisibility: 'ClosedNoRating' });
        const withSet = presetFromModule(
            modulePreset({ costSetId: 7, gameMode: { tag: 'ApocalypticShadow' } }),
        );
        expect(applyLobbyPreset(current, withSet, WITH_SETS).gameMode).toBe('MemoryOfChaos');
    });

    // T-S14.4d-fix (review D S2): the team names are the lobby's own, like the name and password.
    it('a preset picked after a team name keeps both team names; typing a team name keeps the preset matched', () => {
        const [classic, auction] = BUILT_IN_PRESETS;
        if (!classic || !auction) throw new Error('built-ins');
        const named = {
            ...initialLobbySettings(MEMBER),
            teamBlueAlias: 'Sharks',
            teamRedAlias: 'Jets',
        };
        const picked = applyLobbyPreset(named, auction, MEMBER);
        expect(picked).toMatchObject({
            draftMode: 'Auction',
            teamBlueAlias: 'Sharks',
            teamRedAlias: 'Jets',
        });
        expect(lobbyPresetMatches(named, classic, MEMBER)).toBe(true);
        expect(lobbyPresetMatches(picked, auction, MEMBER)).toBe(true);
        expect(lobbyPresetMatches(picked, classic, MEMBER)).toBe(false);
    });
});

describe('the person and the cost set', () => {
    it('a guest is kept Casual with Closed No Rating (D-23)', () => {
        expect(settleLobbySettings(settings({ matchType: 'Ranked' }), GUEST)).toMatchObject({
            matchType: 'Casual',
            rosterVisibility: 'ClosedNoRating',
        });
        const member = settings({ matchType: 'Ranked', rosterVisibility: 'ClosedWithRating' });
        expect(settleLobbySettings(member, MEMBER)).toBe(member);
    });

    // T-S14.4u: a guest's lobby cannot require ownership (user ruling, option A).
    it('a guest is kept with Require Ownership Off; a member keeps it on', () => {
        expect(
            settleLobbySettings(
                settings({
                    matchType: 'Casual',
                    rosterVisibility: 'ClosedNoRating',
                    requireOwnership: true,
                }),
                GUEST,
            ).requireOwnership,
        ).toBe(false);
        expect(initialLobbySettings(GUEST).requireOwnership).toBe(false);
        const member = settings({ requireOwnership: true });
        expect(settleLobbySettings(member, MEMBER)).toBe(member);
    });

    it('a guest: a preset with Require Ownership on is applied Off, and the preset still matches (no "Custom")', () => {
        const owned = presetFromModule(
            modulePreset({ requireOwnership: true, rosterVisibility: { tag: 'ClosedNoRating' } }),
        );
        const forGuest = applyLobbyPreset(initialLobbySettings(GUEST), owned, GUEST);
        expect(forGuest.requireOwnership).toBe(false);
        expect(lobbyPresetMatches(forGuest, owned, GUEST)).toBe(true);
        const forMember = applyLobbyPreset(initialLobbySettings(MEMBER), owned, MEMBER);
        expect(forMember.requireOwnership).toBe(true);
        expect(lobbyPresetMatches(forMember, owned, MEMBER)).toBe(true);
    });

    it('a custom cost set fixes the game mode to its own (A185 item 1); the default set does not', () => {
        expect(settleLobbySettings(settings({ costSetId: 7 }), WITH_SETS).gameMode).toBe(
            'MemoryOfChaos',
        );
        expect(
            settleLobbySettings(
                settings({ costSetId: 0, gameMode: 'AnomalyArbitration' }),
                WITH_SETS,
            ).gameMode,
        ).toBe('AnomalyArbitration');
    });

    it('the picker offers published, unlocked sets by name', () => {
        const b: LobbyCostSetOption = {
            id: 3,
            name: 'Beta',
            gameMode: { tag: 'MemoryOfChaos' },
            isLocked: false,
        };
        expect(selectableCostSets([MOC_SET, LOCKED_SET, b]).map((s) => s.id)).toEqual([3, 7]);
    });

    it('changed: any field away from the starting value', () => {
        const start = initialLobbySettings(MEMBER);
        expect(lobbySettingsChanged({ ...start }, start)).toBe(false);
        expect(lobbySettingsChanged({ ...start, name: 'x' }, start)).toBe(true);
        expect(lobbySettingsChanged({ ...start, teamSize: 1 }, start)).toBe(true);
    });
});

describe('validation', () => {
    it.each<[string, Partial<LobbySettings>, LobbyFormRules, string, string]>([
        [
            'a 51-character name',
            { name: 'n'.repeat(51) },
            MEMBER,
            'name',
            'Use at most 50 characters.',
        ],
        [
            'a password with a symbol',
            { password: 'abc!' },
            MEMBER,
            'password',
            // A word joiner (U+2060) after each dash keeps a range on one line.
            'Use letters and numbers only (A–⁠Z, a–⁠z, 0–⁠9).',
        ],
        [
            'a 21-character password',
            { password: 'a'.repeat(21) },
            MEMBER,
            'password',
            'Use at most 20 characters.',
        ],
        [
            'a locked cost set',
            { costSetId: 8, gameMode: 'AnomalyArbitration' },
            WITH_SETS,
            'costSetId',
            'This cost set is not available. Pick another one.',
        ],
        [
            'an unknown cost set',
            { costSetId: 99 },
            WITH_SETS,
            'costSetId',
            'This cost set is not available. Pick another one.',
        ],
        [
            "a game mode other than the set's",
            { costSetId: 7, gameMode: 'ApocalypticShadow' },
            WITH_SETS,
            'gameMode',
            'The cost set Yuji Open is for Memory of Chaos only. Pick Default to change the game mode.',
        ],
        [
            'Ranked for a guest',
            { matchType: 'Ranked', rosterVisibility: 'ClosedNoRating' },
            GUEST,
            'matchType',
            'Guests can only create Casual lobbies.',
        ],
        [
            // T-S14.4u: the module's refusal, pinned below.
            'Require Ownership for a guest',
            { requireOwnership: true, rosterVisibility: 'ClosedNoRating' },
            GUEST,
            'requireOwnership',
            'Guests cannot host a lobby that requires ownership.',
        ],
        ['team size 4', { teamSize: 4 as never }, MEMBER, 'teamSize', 'Pick 1v1, 2v2 or 3v3.'],
        [
            'a 9 s turn',
            { standardTurnSeconds: 9 },
            MEMBER,
            'standardTurnSeconds',
            'The standard turn is 10 to 600 seconds.',
        ],
        [
            'a 601 s turn',
            { standardTurnSeconds: 601 },
            MEMBER,
            'standardTurnSeconds',
            'The standard turn is 10 to 600 seconds.',
        ],
        [
            'a 1801 s reserve',
            { reserveBankSeconds: 1801 },
            MEMBER,
            'reserveBankSeconds',
            'The reserve bank is 0 to 1800 seconds.',
        ],
        [
            'a 301 s confirm window',
            { confirmWindowSeconds: 301 },
            MEMBER,
            'confirmWindowSeconds',
            'The confirm window is 0 to 300 seconds.',
        ],
        [
            'a negative budget',
            { characterBudget: -1 },
            MEMBER,
            'characterBudget',
            'The character budget is 0 to 100000, in steps of 0.01, with no thousands separator.',
        ],
        [
            'an infinite budget',
            { lightconeBudget: Number.POSITIVE_INFINITY },
            MEMBER,
            'lightconeBudget',
            'The light cone budget is 0 to 100000, in steps of 0.01, with no thousands separator.',
        ],
        [
            'a raise over the cap',
            { minimumBidRaise: 100_001 },
            MEMBER,
            'minimumBidRaise',
            'The minimum bid raise is 0 to 100000, in steps of 0.01, with no thousands separator.',
        ],
        [
            'a handicap over the cap',
            { deathPenalty: 1_000_001 },
            MEMBER,
            'deathPenalty',
            'The death penalty is -10000 to 10000, in steps of 0.01, with no thousands separator.',
        ],
        [
            'a fractional hundredth',
            { rosterDiffAdvantage: 1.5 },
            MEMBER,
            'rosterDiffAdvantage',
            'The roster diff advantage is -10000 to 10000, in steps of 0.01, with no thousands separator.',
        ],
        [
            'a negative threshold',
            { rosterThreshold: -1 },
            MEMBER,
            'rosterThreshold',
            'The roster threshold is 0 to 10000, in steps of 0.01, with no thousands separator.',
        ],
        [
            'Deferred',
            { disconnectPolicy: 'Deferred' },
            MEMBER,
            'disconnectPolicy',
            'Deferred is only for tournament lobbies.',
        ],
        [
            'No Action in Ranked',
            { disconnectPolicy: 'NoAction', matchType: 'Ranked' },
            MEMBER,
            'disconnectPolicy',
            'No Action is only for Casual lobbies.',
        ],
        [
            'a 29 s forfeit',
            { disconnectForfeitSeconds: 29 },
            MEMBER,
            'disconnectForfeitSeconds',
            'Auto-forfeit is 0 (the default, 60 s) or 30 to 600 seconds.',
        ],
        [
            '13 spectators',
            { maxSpectators: 13 },
            MEMBER,
            'maxSpectators',
            'Spectators are 0 to 12.',
        ],
        [
            'a 31-character alias',
            { teamRedAlias: 'r'.repeat(31) },
            MEMBER,
            'teamRedAlias',
            'Use at most 30 characters.',
        ],
    ])('%s', (_name, over, rules, key, text) => {
        expect(validateLobbySettings(settings(over), rules)).toEqual({ [key]: text });
    });

    it.each<[string, Partial<LobbySettings>]>([
        ['an empty name (optional, D-A8)', { name: '' }],
        ['50 characters after trimming', { name: `  ${'n'.repeat(50)}  ` }],
        ['a 20-character password', { password: 'aZ09'.repeat(5) }],
        ['the turn bounds', { standardTurnSeconds: 10, reserveBankSeconds: 1800 }],
        ['No Action in Casual', { disconnectPolicy: 'NoAction' }],
        ['forfeit 0, 30 and 600', { disconnectForfeitSeconds: 30 }],
        ['negative handicaps', { deathPenalty: -1_000_000, aboveThresholdPenalty: -5 }],
        [
            'zero spectators and a zero confirm window',
            { maxSpectators: 0, confirmWindowSeconds: 0 },
        ],
        ['a picked custom set in its own mode', { costSetId: 7, gameMode: 'MemoryOfChaos' }],
        ['Require Ownership for a member (T-S14.4u)', { requireOwnership: true }],
    ])('accepted: %s', (_name, over) => {
        expect(validateLobbySettings(settings(over), WITH_SETS)).toEqual({});
    });

    it('lobbyPasswordError: empty is fine (a public lobby)', () => {
        expect(lobbyPasswordError('')).toBeUndefined();
    });
});

describe('toCreateLobbyArgs', () => {
    it('the password decides privacy; the name is trimmed; tags for the enums', () => {
        const pub = toCreateLobbyArgs(settings({ name: '  Sunday  ' }));
        expect(pub).toMatchObject({
            isPublic: true,
            password: '',
            name: 'Sunday',
            teamSize: 3,
            draftMode: { tag: 'Classic' },
            gameMode: { tag: 'ApocalypticShadow' },
            banMode: { tag: 'Six' },
            matchType: { tag: 'Casual' },
            rosterVisibility: { tag: 'OpenRoster' },
            banRestriction: { tag: 'NoRestriction' },
            lineupFormat: { tag: 'Halves' },
            disconnectPolicy: { tag: 'Standard' },
            disconnectForfeitSeconds: 0,
            characterBudget: 30,
            lightconeBudget: 15,
            maxSpectators: 12,
            confirmWindowSeconds: 60,
        });
        expect(pub).not.toHaveProperty('abandonCurrentMatch');
        expect(toCreateLobbyArgs(settings({ password: 'abc' }))).toMatchObject({
            isPublic: false,
            password: 'abc',
        });
    });

    it('Ranked sends no mirror picks (D-42); abandonCurrentMatch only when confirmed', () => {
        expect(
            toCreateLobbyArgs(settings({ matchType: 'Ranked', allowMirrorPicks: true }))
                .allowMirrorPicks,
        ).toBe(false);
        expect(toCreateLobbyArgs(settings({ allowMirrorPicks: true })).allowMirrorPicks).toBe(true);
        expect(
            toCreateLobbyArgs(settings(), { abandonCurrentMatch: true }).abandonCurrentMatch,
        ).toBe(true);
    });

    // T-S14.4u: the last guard; the settled value is already Off for a guest.
    it('a guest never sends Require Ownership; a member sends what the form holds', () => {
        const on = settings({ requireOwnership: true });
        expect(toCreateLobbyArgs(on, { isGuest: true }).requireOwnership).toBe(false);
        expect(toCreateLobbyArgs(on, { isGuest: false }).requireOwnership).toBe(true);
        expect(toCreateLobbyArgs(on).requireOwnership).toBe(true);
        expect(Object.keys(toCreateLobbyArgs(on, { isGuest: true }))).not.toContain('isGuest');
    });

    it('sends every argument create_lobby takes, and nothing else', () => {
        const sent = Object.keys(
            toCreateLobbyArgs(settings(), { abandonCurrentMatch: true }),
        ).sort();
        expect(sent).toEqual(Object.keys(CreateLobbyReducer).sort());
    });
});

describe('the one-lobby rule (D-22, A68(4))', () => {
    const row = (stage: string, isAway = false) => ({ id: 1, stage: { tag: stage }, isAway });
    it.each([
        ['Waiting', false, 'held'],
        ['Drafting', false, 'held'],
        ['Drafting', true, 'away'],
        ['Scoring', true, 'away'],
        ['Waiting', true, 'held'],
        ['AwaitingResult', false, 'free'],
        ['AwaitingResult', true, 'free'],
    ] as const)('%s, away %s: %s', (stage, away, hold) => {
        expect(lobbyHoldOf(row(stage, away))).toBe(hold);
    });

    it('heldLobbyOf finds the held row', () => {
        const held = { ...row('Waiting'), id: 4 };
        expect(heldLobbyOf([row('AwaitingResult'), row('Drafting', true), held])).toBe(held);
        expect(heldLobbyOf([row('AwaitingResult')])).toBeUndefined();
    });

    it('awayLobbyOf finds the row the person is away from; lobbyLabel names it', () => {
        const away = { ...row('Equipping', true), id: 6, name: ' Cup ', joinCode: 'ZZ99YY' };
        expect(awayLobbyOf([row('Waiting'), row('AwaitingResult', true), away])).toBe(away);
        expect(awayLobbyOf([row('Waiting', true)])).toBeUndefined();
        expect(lobbyLabel(away)).toBe('Cup (ZZ99YY)');
        expect(lobbyLabel({ name: '  ', joinCode: 'ZZ99YY' })).toBe('ZZ99YY');
    });

    it('awayPromptCode reads the code from the module prompt', () => {
        expect(
            awayPromptCode(
                'You left lobby AB12CD mid-match. Joining here means you cannot return to it.',
            ),
        ).toBe('AB12CD');
        expect(awayPromptCode(ALREADY_IN_LOBBY_TEXT)).toBeUndefined();
    });
});

describe('an Auction lobby that cannot work (user ruling, S14.4c-fix)', () => {
    it.each([
        [0, 5, 'characterBudget', AUCTION_CHARACTER_BUDGET_TEXT],
        [
            -1,
            5,
            'characterBudget',
            'The character budget is 0 to 100000, in steps of 0.01, with no thousands separator.',
        ],
        [30, 0, 'minimumBidRaise', AUCTION_MINIMUM_RAISE_TEXT],
        [
            30,
            -0.5,
            'minimumBidRaise',
            'The minimum bid raise is 0 to 100000, in steps of 0.01, with no thousands separator.',
        ],
    ] as const)(
        'Auction, budget %s, raise %s: %s refused',
        (characterBudget, minimumBidRaise, key, text) => {
            const e = validateLobbySettings(
                settings({ draftMode: 'Auction', characterBudget, minimumBidRaise }),
                MEMBER,
            );
            expect(e[key]).toBe(text);
        },
    );

    it('the sentences; the smallest working values pass; Classic ignores both', () => {
        expect(AUCTION_CHARACTER_BUDGET_TEXT).toBe(
            'An Auction lobby needs a character budget above 0.',
        );
        expect(AUCTION_MINIMUM_RAISE_TEXT).toBe(
            'An Auction lobby needs a minimum bid raise above 0.',
        );
        expect(
            validateLobbySettings(
                settings({ draftMode: 'Auction', characterBudget: 0.5, minimumBidRaise: 0.01 }),
                MEMBER,
            ),
        ).toEqual({});
        expect(
            validateLobbySettings(
                settings({ draftMode: 'Classic', characterBudget: 0, minimumBidRaise: 0 }),
                MEMBER,
            ),
        ).toEqual({});
    });

    it('both built-in presets raise by 5 and work as Auction lobbies', () => {
        for (const preset of BUILT_IN_PRESETS) {
            expect(preset.values.minimumBidRaise).toBe(5);
            const s = applyLobbyPreset(settings(), preset, MEMBER);
            expect(validateLobbySettings({ ...s, draftMode: 'Auction' }, MEMBER)).toEqual({});
        }
    });
});

describe('lobbyPresetMatches (the preset select names a preset only while the form holds it)', () => {
    const [classic, auction] = BUILT_IN_PRESETS as [LobbyPresetChoice, LobbyPresetChoice];
    it('the defaults are Default Classic; the name and password never count', () => {
        const start = initialLobbySettings(MEMBER);
        expect(lobbyPresetMatches(start, classic, MEMBER)).toBe(true);
        expect(lobbyPresetMatches({ ...start, name: 'x', password: 'abc' }, classic, MEMBER)).toBe(
            true,
        );
        expect(lobbyPresetMatches(start, auction, MEMBER)).toBe(false);
    });

    it('an edit of a field the preset sets is no longer the preset; a guest is compared as settled', () => {
        const start = initialLobbySettings(MEMBER);
        expect(lobbyPresetMatches({ ...start, teamSize: 1 }, classic, MEMBER)).toBe(false);
        expect(lobbyPresetMatches(initialLobbySettings(GUEST), classic, GUEST)).toBe(true);
    });
});

describe('number field drafts (S14.4d seam)', () => {
    it.each([
        ['', Number.NaN],
        ['  ', Number.NaN],
        ['-', Number.NaN],
        ['.', Number.NaN],
        ['1e3', Number.NaN],
        ['abc', Number.NaN],
        ['60', 60],
        [' 60 ', 60],
        ['-2.25', -2.25],
        ['1.', 1],
        ['0', 0],
    ] as const)('%j reads as %s', (text, value) => {
        expect(numberFromDraft(text)).toBe(value);
    });

    it('a field shows its draft while one exists, else the value (NaN as empty)', () => {
        expect(numberDraftText({ standardTurnSeconds: '6' }, 'standardTurnSeconds', 60)).toBe('6');
        expect(numberDraftText({}, 'standardTurnSeconds', 60)).toBe('60');
        expect(numberDraftText({}, 'standardTurnSeconds', Number.NaN)).toBe('');
    });

    it('a NaN left in a number field is not a change against itself', () => {
        const nan = settings({ standardTurnSeconds: Number.NaN });
        expect(lobbySettingsChanged(nan, nan)).toBe(false);
        expect(lobbySettingsChanged(nan, settings())).toBe(true);
    });
});

describe('points and hundredths', () => {
    it.each([
        [0, 0],
        [1.5, 150],
        [-2.25, -225],
        [0.01, 1],
    ])('%s points = %s hundredths', (points, hundredths) => {
        expect(pointsToHundredths(points)).toBe(hundredths);
        expect(hundredthsToPoints(hundredths)).toBe(points);
    });

    it('a third decimal is not a hundredth', () => {
        expect(pointsToHundredths(0.005)).toBeNaN();
        expect(pointsToHundredths(Number.NaN)).toBeNaN();
    });
});

// ─── Module pins: each mirrored limit and sentence against the module's own code or source ───────────────────────

const moduleSource = (path: string) =>
    readFileSync(new URL(`../../spacetimedb/src/${path}`, import.meta.url), 'utf8');

/** The variant names of `export const <name> = t.enum('<name>', { ... })` in the module's enums.ts. */
function moduleEnum(name: string): string[] {
    const source = moduleSource('types/enums.ts');
    const block = new RegExp(
        `export const ${name} = t\\.enum\\('${name}', \\{([\\s\\S]*?)\\}\\);`,
    ).exec(source);
    if (!block?.[1]) throw new Error(`enum ${name} not found`);
    return [...block[1].matchAll(/^\s*(\w+): t\.unit\(\)/gm)].map((m) => m[1] as string);
}

describe('module pins', () => {
    it('the enum tags are the module enums, in order', () => {
        expect([...LOBBY_DRAFT_MODES]).toEqual(moduleEnum('DraftMode'));
        expect([...LOBBY_GAME_MODES]).toEqual(moduleEnum('GameMode'));
        expect([...LOBBY_BAN_MODES]).toEqual(moduleEnum('BanMode'));
        expect([...LOBBY_MATCH_TYPES]).toEqual(moduleEnum('MatchType'));
        expect([...LOBBY_ROSTER_VISIBILITIES]).toEqual(moduleEnum('RosterVisibility'));
        expect([...LOBBY_DISCONNECT_POLICIES]).toEqual(moduleEnum('DisconnectPolicy'));
        expect([...LOBBY_BAN_RESTRICTIONS]).toEqual(moduleEnum('BanRestriction'));
        expect([...LOBBY_LINEUP_FORMATS]).toEqual(moduleEnum('LineupFormat'));
    });

    it('name: 50 characters after trimming, empty allowed (normalizeLobbyName)', () => {
        expect(LOBBY_NAME_MAX_LENGTH).toBe(LOBBY_NAME_MAX);
        for (const name of ['', '   ', 'n'.repeat(50), ` ${'n'.repeat(50)} `, 'n'.repeat(51)]) {
            const moduleOk = (() => {
                try {
                    normalizeLobbyName(name);
                    return true;
                } catch {
                    return false;
                }
            })();
            expect(validateLobbySettings(settings({ name }), MEMBER).name === undefined, name).toBe(
                moduleOk,
            );
        }
    });

    it('password: the same rule as lobbyPasswordRuleError (A163(4))', () => {
        expect(LOBBY_PASSWORD_MAX).toBe(LOBBY_PASSWORD_MAX_LENGTH);
        for (const pw of [
            '',
            'abc',
            'ABCxyz019',
            'a'.repeat(20),
            'a'.repeat(21),
            'ab c',
            'é',
            'a-b',
            'ab😀',
            'Ａ',
        ]) {
            expect(lobbyPasswordError(pw) === undefined, pw).toBe(
                lobbyPasswordRuleError(pw) === undefined,
            );
        }
    });

    it('numbers: the form refuses exactly what ensureLobbyConfigInRange refuses, at every bound', () => {
        const numeric = {
            teamSize: [0, 1, 3, 4],
            standardTurnSeconds: [9, 10, 600, 601, 60.5],
            reserveBankSeconds: [-1, 0, 1800, 1801],
            characterBudget: [-0.01, 0, 100_000, 100_000.5, Number.NaN, Number.POSITIVE_INFINITY],
            lightconeBudget: [-1, 0, 12.5, 100_001],
            minimumBidRaise: [-1, 0, 100_000, 100_001],
            rosterDiffAdvantage: [-1_000_001, -1_000_000, 1_000_000, 1_000_001, 0.5],
            rosterThreshold: [-1, 0, 1_000_000, 1_000_001],
            underThresholdAdvantage: [-1_000_001, 1_000_000],
            aboveThresholdPenalty: [-1_000_000, 1_000_001],
            deathPenalty: [-1_000_001, 0, 1_000_000],
        } as const;
        for (const [key, values] of Object.entries(numeric)) {
            for (const value of values) {
                const s = settings({ [key]: value } as Partial<LobbySettings>);
                const moduleOk = (() => {
                    try {
                        ensureLobbyConfigInRange(s);
                        return true;
                    } catch {
                        return false;
                    }
                })();
                const errors = validateLobbySettings(s, MEMBER);
                expect(errors[key as keyof LobbySettings] === undefined, `${key} ${value}`).toBe(
                    moduleOk,
                );
            }
        }
    });

    it('confirm window: the form refuses exactly what resolveConfirmWindowSeconds refuses, and the same default', () => {
        expect(LOBBY_CONFIRM_WINDOW_SECONDS_DEFAULT).toBe(CONFIRM_WINDOW_SECONDS_DEFAULT);
        expect(DEFAULT_LOBBY_SETTINGS.confirmWindowSeconds).toBe(CONFIRM_WINDOW_SECONDS_DEFAULT);
        for (const value of [-1, 0, 1, 299, 300, 301, 60.5, Number.NaN]) {
            const moduleOk = (() => {
                try {
                    resolveConfirmWindowSeconds(value, CONFIRM_WINDOW_SECONDS_DEFAULT);
                    return true;
                } catch {
                    return false;
                }
            })();
            const errors = validateLobbySettings(settings({ confirmWindowSeconds: value }), MEMBER);
            expect(errors.confirmWindowSeconds === undefined, `confirmWindowSeconds ${value}`).toBe(
                moduleOk,
            );
        }
    });

    it('Auction amounts: the form refuses exactly what ensureLobbyConfigInRange and ensureAuctionAmounts refuse', () => {
        for (const draftMode of LOBBY_DRAFT_MODES) {
            for (const characterBudget of [-1, 0, 0.01, 30, 100_000, 100_001]) {
                for (const minimumBidRaise of [-0.5, 0, 0.01, 5, 100_001]) {
                    const s = settings({ draftMode, characterBudget, minimumBidRaise });
                    const moduleOk = (() => {
                        try {
                            ensureLobbyConfigInRange(s);
                            ensureAuctionAmounts(s.draftMode, s);
                            return true;
                        } catch {
                            return false;
                        }
                    })();
                    const e = validateLobbySettings(s, MEMBER);
                    expect(
                        e.characterBudget === undefined && e.minimumBidRaise === undefined,
                        `${draftMode} ${characterBudget} ${minimumBidRaise}`,
                    ).toBe(moduleOk);
                }
            }
        }
    });

    it('T-S14.4t: a preset save: lobbyAmountErrors refuses exactly what the module refuses, and both preset reducers apply the check', () => {
        for (const draftMode of LOBBY_DRAFT_MODES) {
            for (const characterBudget of [-1, 0, 0.01, 30, 100_000, 100_001, Number.NaN]) {
                for (const minimumBidRaise of [-0.5, 0, 0.01, 5, 100_001]) {
                    for (const lightconeBudget of [-1, 0, 15, 100_001]) {
                        const values = {
                            draftMode,
                            characterBudget,
                            lightconeBudget,
                            minimumBidRaise,
                        };
                        const moduleOk = (() => {
                            try {
                                ensureLobbyConfigInRange(settings(values));
                                ensureAuctionAmounts(draftMode, values);
                                return true;
                            } catch {
                                return false;
                            }
                        })();
                        const e = lobbyAmountErrors(values);
                        expect(Object.keys(e).length === 0, JSON.stringify(values)).toBe(moduleOk);
                        // The lobby form gives the same sentences.
                        const full = validateLobbySettings(settings(values), MEMBER);
                        expect({
                            characterBudget: full.characterBudget,
                            lightconeBudget: full.lightconeBudget,
                            minimumBidRaise: full.minimumBidRaise,
                        }).toEqual({
                            characterBudget: e.characterBudget,
                            lightconeBudget: e.lightconeBudget,
                            minimumBidRaise: e.minimumBidRaise,
                        });
                    }
                }
            }
        }
        // create_lobby_preset and update_lobby_preset call the same check on the values they store (S14.4t).
        const presets = moduleSource('reducers/lobby/lobbyPresets.ts');
        expect(
            presets.match(
                /ensureLobbyConfigInRange\(args\);\s*ensureAuctionAmounts\(args\.draftMode\.tag, args\);/g,
            ),
        ).toHaveLength(2);
    });

    it('the one-lobby rule: the live stages are the module LIVE_STAGES, and membershipHold decides as lobbyHoldOf', () => {
        expect([...LOBBY_LIVE_STAGES]).toEqual([...MODULE_LIVE_STAGES]);
        const helpers = moduleSource('helpers/lobby/lobbyHelpers.ts');
        // The two decisions of membershipHold that lobbyHoldOf mirrors (the view drops abandoned rows and lost lobbies).
        expect(helpers).toContain(
            "if (!lobby || lobby.stage.tag === 'AwaitingResult' || member.abandonedAt !== undefined) return { kind: 'free', lobby };",
        );
        expect(helpers).toContain(
            "if (member.leftAt !== undefined && LIVE_STAGES.includes(lobby.stage.tag)) return { kind: 'away', lobby };",
        );
        expect(helpers).toContain("return { kind: 'held', lobby };");
    });

    it('team aliases: the module cap', () => {
        expect(LOBBY_TEAM_ALIAS_MAX_LENGTH).toBe(TEAM_ALIAS_MAX_LENGTH);
    });

    it('the source of the checks the test cannot call: forfeit range, spectator range, Deferred and NoAction', () => {
        const disconnect = moduleSource('helpers/lobby/disconnectHelpers.ts');
        expect(disconnect).toContain(
            `const MIN_DISCONNECT_FORFEIT_SECONDS = ${LOBBY_FORFEIT_SECONDS_MIN};`,
        );
        expect(disconnect).toContain(
            `const MAX_DISCONNECT_FORFEIT_SECONDS = ${LOBBY_FORFEIT_SECONDS_MAX};`,
        );
        expect(disconnect).toContain(`export const DEFAULT_DISCONNECT_FORFEIT_SECONDS = 60;`);
        expect(disconnect).toContain(`if (policyTag === 'Deferred') {`);
        expect(disconnect).toContain(`if (policyTag === 'NoAction' && isRankedOrTournament) {`);
        const helpers = moduleSource('helpers/lobby/lobbyHelpers.ts');
        expect(helpers).toContain(`if (resolved < 0 || resolved > ${LOBBY_MAX_SPECTATORS_MAX}) {`);
        expect(helpers).toContain(
            `export const PRIVATE_LOBBY_PASSWORD_TEXT = '${PRIVATE_LOBBY_NEEDS_PASSWORD_TEXT}';`,
        );
        expect(helpers).toContain(`throw new SenderError('${ALREADY_IN_LOBBY_TEXT}');`);
        expect(helpers).toContain(
            // The module's template literal, written without a placeholder in this file.
            [
                'throw new SenderError(`You left lobby ',
                '$',
                '{away[0].lobby.joinCode} mid-match.',
            ].join('') + ' Joining here means you cannot return to it.`);',
        );
        // Guests: Ranked refused, the roster forced to Closed No Rating (create_lobby).
        const create = moduleSource('reducers/lobby/lobbyLifecycle.ts');
        expect(helpers).toContain(`if (user.isGuest === true && matchType.tag === 'Ranked') {`);
        expect(create).toContain(`rosterVisibility = { tag: 'ClosedNoRating', value: {} } as any;`);
        // T-S14.4u: a guest host's Require Ownership is refused with the sentence the form mirrors, by both reducers.
        expect(GUEST_OWNERSHIP_TEXT).toBe(MODULE_GUEST_OWNERSHIP_TEXT);
        expect(() => ensureGuestHostOwnership({ isGuest: true }, true)).toThrow(
            GUEST_OWNERSHIP_TEXT,
        );
        expect(() => ensureGuestHostOwnership({ isGuest: true }, false)).not.toThrow();
        expect(() => ensureGuestHostOwnership({ isGuest: false }, true)).not.toThrow();
        expect(create).toContain('ensureGuestHostOwnership(user, args.requireOwnership);');
        expect(moduleSource('reducers/lobby/lobbySettings.ts')).toContain(
            'ensureGuestHostOwnership(ctx.db.User.id.find(lobby.hostUserId), args.requireOwnership);',
        );
        expect(create).toContain(
            `const allowMirrorPicks = args.matchType.tag === 'Ranked' ? false : args.allowMirrorPicks;`,
        );
        expect(create).toContain(
            'const maxSpectators = resolveMaxSpectators(args.maxSpectators, 12);',
        );
    });

    // T-S14.4d: the Advanced Settings bounds, by calling the module's own checks at each bound.
    const accepts = (check: () => unknown) => {
        try {
            check();
            return true;
        } catch {
            return false;
        }
    };

    it('T-S14.4d: auto-forfeit: the form refuses exactly what ensureForfeitSecondsInRange refuses', () => {
        for (const value of [0, 1, 29, 30, 31, 599, 600, 601]) {
            const errors = validateLobbySettings(
                settings({ disconnectForfeitSeconds: value }),
                MEMBER,
            );
            expect(errors.disconnectForfeitSeconds === undefined, `forfeit ${value}`).toBe(
                accepts(() => ensureForfeitSecondsInRange(value)),
            );
        }
    });

    it('T-S14.4d: spectators: the form refuses exactly what resolveMaxSpectators refuses (a whole u8)', () => {
        for (const value of [0, 1, 12, 13]) {
            const errors = validateLobbySettings(settings({ maxSpectators: value }), MEMBER);
            expect(errors.maxSpectators === undefined, `spectators ${value}`).toBe(
                accepts(() => resolveMaxSpectators(value, 12)),
            );
        }
        // Below the module's range the u8 argument cannot even be sent; the form refuses it and a fraction too.
        expect(validateLobbySettings(settings({ maxSpectators: -1 }), MEMBER).maxSpectators).toBe(
            'Spectators are 0 to 12.',
        );
        expect(
            validateLobbySettings(settings({ maxSpectators: 2.5 }), MEMBER).maxSpectators,
        ).toBeDefined();
    });

    it('T-S14.4d: disconnect policy: the form refuses exactly what the module refuses, for Casual and Ranked', () => {
        for (const policy of LOBBY_DISCONNECT_POLICIES) {
            for (const matchType of LOBBY_MATCH_TYPES) {
                const moduleOk = accepts(() => {
                    ensureNotDeferredOutsideTournament(policy);
                    ensureNoActionAllowed(policy, matchType === 'Ranked');
                });
                const errors = validateLobbySettings(
                    settings({ disconnectPolicy: policy, matchType }),
                    MEMBER,
                );
                expect(errors.disconnectPolicy === undefined, `${policy} ${matchType}`).toBe(
                    moduleOk,
                );
            }
        }
        // The select offers what create_lobby can take: no Deferred (A91(2)).
        expect([...LOBBY_CREATE_DISCONNECT_POLICIES]).toEqual(['Standard', 'NoAction']);
    });

    it('T-S14.4d: team names: the form refuses exactly what ensureTeamAliases refuses', () => {
        for (const length of [0, 1, 30, 31]) {
            const name = 'n'.repeat(length);
            for (const side of ['teamBlueAlias', 'teamRedAlias'] as const) {
                const s = settings({ [side]: name });
                const errors = validateLobbySettings(s, MEMBER);
                expect(errors[side] === undefined, `${side} ${length}`).toBe(
                    accepts(() => ensureTeamAliases(s.teamBlueAlias, s.teamRedAlias)),
                );
            }
        }
    });

    it('T-S14.4d: handicap points typed at the bounds: the form and ensureLobbyConfigInRange agree on the hundredths', () => {
        const cases: [LobbyNumberFieldKey, string][] = [
            ['deathPenalty', '10000'],
            ['deathPenalty', '10000.01'],
            ['deathPenalty', '-10000'],
            ['deathPenalty', '-10000,01'],
            ['rosterDiffAdvantage', '0.01'],
            ['underThresholdAdvantage', '-0,5'],
            ['aboveThresholdPenalty', '9999.99'],
            ['rosterThreshold', '0'],
            ['rosterThreshold', '10000'],
            ['rosterThreshold', '10000.01'],
        ];
        for (const [key, text] of cases) {
            const s = settings({ [key]: readLobbyNumber(key, text) });
            expect(validateLobbySettings(s, MEMBER)[key] === undefined, `${key} ${text}`).toBe(
                accepts(() => ensureLobbyConfigInRange(s)),
            );
        }
    });
});

// ─── T-S14.4d: Advanced Settings ─────────────────────────────────────────────────────────────────────────────────

describe('Advanced Settings fields (S14.4d)', () => {
    it('the main and advanced fields together are every setting, each once', () => {
        const all = [...LOBBY_MAIN_FIELDS, ...LOBBY_ADVANCED_FIELDS];
        expect(new Set(all).size).toBe(all.length);
        expect([...all].sort()).toEqual(Object.keys(DEFAULT_LOBBY_SETTINGS).sort());
    });

    it('every number field of Advanced Settings has a reading rule', () => {
        const numbers = LOBBY_ADVANCED_FIELDS.filter(
            (k) => typeof DEFAULT_LOBBY_SETTINGS[k] === 'number',
        );
        expect([...numbers].sort()).toEqual(Object.keys(LOBBY_NUMBER_FIELD_KIND).sort());
    });

    it('the ban restriction select offers the six options of the module (A221 R4), in the mockup order', () => {
        expect([...BAN_RESTRICTION_OPTIONS].sort()).toEqual([...LOBBY_BAN_RESTRICTIONS].sort());
        expect(BAN_RESTRICTION_OPTIONS).toEqual([
            'NoRestriction',
            'MaxOnePerRole',
            'MaxOneDps',
            'MaxTwoDps',
            'MaxOneSupport',
            'MaxOneSustain',
        ]);
    });

    it('advancedErrorKeys lists only the advanced fields with an error, in field order', () => {
        const errors = validateLobbySettings(
            settings({
                name: 'n'.repeat(51),
                disconnectForfeitSeconds: 5,
                standardTurnSeconds: 5,
            }),
            MEMBER,
        );
        expect(advancedErrorKeys(errors)).toEqual([
            'standardTurnSeconds',
            'disconnectForfeitSeconds',
        ]);
        expect(advancedErrorKeys(validateLobbySettings(settings(), MEMBER))).toEqual([]);
    });
});

describe('points to hundredths from the typed text (S14.4d: exact, no float drift)', () => {
    it.each([
        ['0', 0],
        ['1', 100],
        ['1.5', 150],
        ['1,5', 150],
        ['1.15', 115],
        ['0.29', 29],
        ['0,07', 7],
        ['.5', 50],
        ['2.', 200],
        ['-0.29', -29],
        ['-2,25', -225],
        ['10000.01', 1_000_001],
        [' 3 ', 300],
        ['-0', 0],
    ] as const)('%j is %s hundredths', (text, hundredths) => {
        expect(pointsTextToHundredths(text)).toBe(hundredths);
    });

    it.each(['', '-', '.', '1.234', '1,000', '1e3', 'abc', '1.2.3', '+1', '1 000'])(
        '%j does not read',
        (text) => {
            expect(pointsTextToHundredths(text)).toBeNaN();
        },
    );

    it('the roster threshold takes no sign', () => {
        expect(pointsTextToHundredths('-1', false)).toBeNaN();
        expect(pointsTextToHundredths('1.25', false)).toBe(125);
    });

    it('where a float multiplication drifts, the digit reading does not', () => {
        // The trap: 0.29 * 100 is 28.999999999999996, 1.15 * 100 is 114.99999999999999.
        expect(0.29 * 100).not.toBe(29);
        expect(pointsTextToHundredths('0.29')).toBe(29);
        expect(pointsTextToHundredths('1.15')).toBe(115);
    });

    it('every hundredth from -10,000.00 to 10,000.00 round-trips through its text', () => {
        for (let h = -1_000_000; h <= 1_000_000; h += 1) {
            const text = hundredthsToPointsText(h);
            if (pointsTextToHundredths(text) !== h) throw new Error(`${h} -> ${text}`);
        }
    });

    it('hundredths as text: no trailing zeros, the sign kept', () => {
        expect(hundredthsToPointsText(115)).toBe('1.15');
        expect(hundredthsToPointsText(-50)).toBe('-0.5');
        expect(hundredthsToPointsText(300)).toBe('3');
        expect(hundredthsToPointsText(-7)).toBe('-0.07');
        expect(hundredthsToPointsText(Number.NaN)).toBe('');
    });
});

describe('number field texts (S14.4d)', () => {
    it('each kind reads its text into the value the form keeps', () => {
        expect(readLobbyNumber('standardTurnSeconds', '45')).toBe(45);
        expect(readLobbyNumber('standardTurnSeconds', '45.5')).toBe(45.5); // read, then refused by validation
        expect(readLobbyNumber('standardTurnSeconds', 'abc')).toBeNaN();
        // Amounts as the team builder's AmountField reads them: a comma or a dot, "1,000" refused as unclear.
        expect(readLobbyNumber('minimumBidRaise', '2,5')).toBe(2.5);
        expect(readLobbyNumber('characterBudget', '30')).toBe(30);
        // T-S14.4d-fix (review D M6): a third decimal is refused, as in the points fields (was: '1.005' read as 1.01).
        expect(readLobbyNumber('lightconeBudget', '1.005')).toBeNaN();
        expect(readLobbyNumber('lightconeBudget', '1.000')).toBeNaN();
        expect(readLobbyNumber('deathPenalty', '1.005')).toBeNaN();
        expect(readLobbyNumber('lightconeBudget', '1.01')).toBe(1.01);
        expect(readLobbyNumber('characterBudget', '1,000')).toBeNaN();
        expect(readLobbyNumber('characterBudget', '-5')).toBeNaN();
        expect(readLobbyNumber('characterBudget', '')).toBeNaN();
        // Points: hundredths.
        expect(readLobbyNumber('deathPenalty', '1,5')).toBe(150);
        expect(readLobbyNumber('rosterThreshold', '-1')).toBeNaN();
    });

    it('a value shows as its text: hundredths as points, an f32 amount as the amount it stands for', () => {
        expect(lobbyNumberText('deathPenalty', 150)).toBe('1.5');
        expect(lobbyNumberText('characterBudget', Math.fround(30.1))).toBe('30.1');
        expect(lobbyNumberText('standardTurnSeconds', 60)).toBe('60');
        expect(lobbyNumberText('standardTurnSeconds', Number.NaN)).toBe('');
    });

    it('a draft shows while it reads as the value; a preset that replaced the value replaces the text', () => {
        expect(lobbyNumberFieldText('deathPenalty', '1.', 100)).toBe('1.');
        expect(lobbyNumberFieldText('standardTurnSeconds', 'abc', Number.NaN)).toBe('abc');
        expect(lobbyNumberFieldText('standardTurnSeconds', 'abc', 60)).toBe('60');
        expect(lobbyNumberFieldText('minimumBidRaise', '2,5', 2.5)).toBe('2,5');
        expect(lobbyNumberFieldText('minimumBidRaise', undefined, 5)).toBe('5');
    });

    // T-S14.4d-fix (review D S4): on leaving, a field shows the text of the value it sends.
    it.each<[LobbyNumberFieldKey, string, string]>([
        ['characterBudget', '$5', '5'],
        ['characterBudget', ' 2,5 ', '2.5'],
        ['characterBudget', '1.50', '1.5'],
        ['characterBudget', '1.005', '1.005'], // refused: stays as typed, beside its error
        ['characterBudget', 'abc', 'abc'],
        ['reserveBankSeconds', ' 60 ', '60'],
        ['reserveBankSeconds', '1.', '1'],
        ['reserveBankSeconds', '-0', '0'],
        ['reserveBankSeconds', '9999999999999999', '9999999999999999'], // far beyond every bound: kept
        ['deathPenalty', '-0.50', '-0.5'],
        ['deathPenalty', '5.', '5'],
    ])('on leaving %s, %j shows as %j', (key, typed, shown) => {
        expect(lobbyNumberLeaveText(key, typed)).toBe(shown);
        // What it shows reads as what it sent.
        const sent = readLobbyNumber(key, typed);
        if (!Number.isNaN(sent) && Math.abs(sent) < 1e12)
            expect(readLobbyNumber(key, shown)).toBe(sent);
    });

    // T-S14.4d-fix (review D M2): "-0" in a whole-number field is 0, not -0 (no "Custom", no discard question).
    it('"-0" reads as 0 in a whole-number field', () => {
        expect(Object.is(numberFromDraft('-0'), 0)).toBe(true);
        const start = initialLobbySettings(MEMBER);
        const typed = {
            ...start,
            disconnectForfeitSeconds: readLobbyNumber('disconnectForfeitSeconds', '-0'),
        };
        expect(lobbySettingsChanged(typed, start)).toBe(false);
        expect(lobbyPresetMatches(typed, BUILT_IN_PRESETS[0] as LobbyPresetChoice, MEMBER)).toBe(
            true,
        );
        expect(Object.is(toCreateLobbyArgs(typed).disconnectForfeitSeconds, 0)).toBe(true);
    });

    // T-S14.4d-fix (review D M3, M4).
    it('team names are trimmed (all spaces is empty); Auction sends no mirror picks and no random auto-pick', () => {
        const trimmed = toCreateLobbyArgs(
            settings({ teamBlueAlias: '   ', teamRedAlias: ' Red Fox ' }),
        );
        expect(trimmed).toMatchObject({ teamBlueAlias: '', teamRedAlias: 'Red Fox' });
        expect(
            validateLobbySettings(settings({ teamRedAlias: ` ${'r'.repeat(30)} ` }), MEMBER),
        ).toEqual({});
        const auction = toCreateLobbyArgs(
            settings({ draftMode: 'Auction', allowMirrorPicks: true, autoRandomPick: true }),
        );
        expect(auction).toMatchObject({ allowMirrorPicks: false, autoRandomPick: false });
        const classic = toCreateLobbyArgs(
            settings({ allowMirrorPicks: true, autoRandomPick: true }),
        );
        expect(classic).toMatchObject({ allowMirrorPicks: true, autoRandomPick: true });
    });

    it('toCreateLobbyArgs never sends NaN: an unread number field throws instead', () => {
        expect(() => toCreateLobbyArgs(settings({ reserveBankSeconds: Number.NaN }))).toThrow(
            /reserveBankSeconds/,
        );
        expect(() => toCreateLobbyArgs(settings())).not.toThrow();
    });

    it('advanced values reach the arguments: handicaps in hundredths, amounts as typed', () => {
        const args = toCreateLobbyArgs(
            settings({
                draftMode: 'Auction',
                banRestriction: 'MaxOneSupport',
                lineupFormat: 'Thirds',
                deathPenalty: readLobbyNumber('deathPenalty', '1,5'),
                rosterThreshold: readLobbyNumber('rosterThreshold', '25.5'),
                minimumBidRaise: readLobbyNumber('minimumBidRaise', '2,5'),
                maxSpectators: 4,
                confirmWindowSeconds: 0,
                teamBlueAlias: 'Trailblazers',
            }),
        );
        expect(args).toMatchObject({
            banRestriction: { tag: 'MaxOneSupport' },
            lineupFormat: { tag: 'Thirds' },
            deathPenalty: 150,
            rosterThreshold: 2550,
            minimumBidRaise: 2.5,
            maxSpectators: 4,
            confirmWindowSeconds: 0,
            teamBlueAlias: 'Trailblazers',
        });
    });
});
