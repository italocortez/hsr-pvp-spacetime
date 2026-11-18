import { readFileSync } from 'node:fs';
import CreateLobbyReducer from '@bindings/create_lobby_reducer';
import {
    CONFIRM_WINDOW_SECONDS_DEFAULT,
    ensureAuctionAmounts,
    ensureLobbyConfigInRange,
    resolveConfirmWindowSeconds,
    TEAM_ALIAS_MAX_LENGTH,
} from '@module/helpers/lobby/lobbyConfigBounds';
import { LIVE_STAGES as MODULE_LIVE_STAGES } from '@module/helpers/lobby/lobbyHelpers';
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
    applyLobbyPreset,
    awayLobbyOf,
    awayPromptCode,
    BUILT_IN_PRESETS,
    DEFAULT_LOBBY_SETTINGS,
    heldLobbyOf,
    hundredthsToPoints,
    initialLobbySettings,
    LOBBY_BAN_MODES,
    LOBBY_BAN_RESTRICTIONS,
    LOBBY_CONFIRM_WINDOW_SECONDS_DEFAULT,
    LOBBY_DISCONNECT_POLICIES,
    LOBBY_DRAFT_MODES,
    LOBBY_FORFEIT_SECONDS_MAX,
    LOBBY_FORFEIT_SECONDS_MIN,
    LOBBY_GAME_MODES,
    LOBBY_LINEUP_FORMATS,
    LOBBY_LIVE_STAGES,
    LOBBY_MATCH_TYPES,
    LOBBY_MAX_SPECTATORS_MAX,
    LOBBY_NAME_MAX_LENGTH,
    LOBBY_PASSWORD_MAX,
    LOBBY_ROSTER_VISIBILITIES,
    LOBBY_TEAM_ALIAS_MAX_LENGTH,
    type LobbyCostSetOption,
    type LobbyFormRules,
    type LobbyPresetChoice,
    type LobbySettings,
    lobbyHoldOf,
    lobbyLabel,
    lobbyPasswordError,
    lobbyPresetChoices,
    lobbyPresetMatches,
    lobbySettingsChanged,
    type ModuleLobbyPreset,
    modulePresetKey,
    numberDraftText,
    numberFromDraft,
    PRIVATE_LOBBY_NEEDS_PASSWORD_TEXT,
    pointsToHundredths,
    presetFromModule,
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
            teamBlueAlias: '',
            teamRedAlias: '',
        });
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
            'The character budget is 0 to 100,000.',
        ],
        [
            'an infinite budget',
            { lightconeBudget: Number.POSITIVE_INFINITY },
            MEMBER,
            'lightconeBudget',
            'The light cone budget is 0 to 100,000.',
        ],
        [
            'a raise over the cap',
            { minimumBidRaise: 100_001 },
            MEMBER,
            'minimumBidRaise',
            'The minimum bid raise is 0 to 100,000.',
        ],
        [
            'a handicap over the cap',
            { deathPenalty: 1_000_001 },
            MEMBER,
            'deathPenalty',
            'The death penalty is -10,000 to 10,000 points, in steps of 0.01.',
        ],
        [
            'a fractional hundredth',
            { rosterDiffAdvantage: 1.5 },
            MEMBER,
            'rosterDiffAdvantage',
            'The roster diff advantage is -10,000 to 10,000 points, in steps of 0.01.',
        ],
        [
            'a negative threshold',
            { rosterThreshold: -1 },
            MEMBER,
            'rosterThreshold',
            'The roster threshold is 0 to 10,000 points, in steps of 0.01.',
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
        [-1, 5, 'characterBudget', 'The character budget is 0 to 100,000.'],
        [30, 0, 'minimumBidRaise', AUCTION_MINIMUM_RAISE_TEXT],
        [30, -0.5, 'minimumBidRaise', 'The minimum bid raise is 0 to 100,000.'],
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
        expect(create).toContain(
            `const allowMirrorPicks = args.matchType.tag === 'Ranked' ? false : args.allowMirrorPicks;`,
        );
        expect(create).toContain(
            'const maxSpectators = resolveMaxSpectators(args.maxSpectators, 12);',
        );
    });
});
