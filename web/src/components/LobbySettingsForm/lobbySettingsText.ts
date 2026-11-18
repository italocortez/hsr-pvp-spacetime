import type { ReactNode } from 'react';

/*
 * The lobby settings form's wording (S14.4c): labels and placeholders from design/mockups/index.html (Create Lobby),
 * "Cost Set" for the mockup's "Rule Set" (A185 item 6), and the info texts of the main dialog's `infoDot`s. An info
 * text is the mockup's except where it describes something the module does differently; those are listed in
 * docs/frontend/pages.md "Create lobby (S14.4c)".
 */

export const FORM_TEXT = {
    name: 'Lobby Name',
    namePlaceholder: 'e.g. Sunday Ranked Scrims',
    privateBadge: 'Private',
    password: 'Lobby Password',
    passwordPlaceholder: 'A password makes the lobby private',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    draftMode: 'Draft Mode',
    gameMode: 'Game Mode',
    costSet: 'Cost Set',
    defaultCostSet: 'Default',
    unknownCostSet: (id: number) => `Cost set ${id}`,
    banMode: 'Ban Mode',
    type: 'Type',
    anonymousPlayers: 'Anonymous Players',
    off: 'Off',
    on: 'On',
    roster: 'Roster',
    teamSize: 'Team Size',
    preset: 'Settings Preset',
    /** The preset select's value once a field the preset set was edited (not a choice). */
    presetCustom: 'Custom',
    presetApplied: (label: string) => `${label} applied.`,
    guestRanked: 'Guests can only create Casual lobbies. Sign in with Discord to play Ranked.',
    guestRoster: 'Guests always play Closed No Rating.',
} as const;

export type InfoText = {
    /** The trigger's accessible name. */
    label: string;
    heading: string;
    body: readonly ReactNode[];
    foot?: string;
};

export const INFO = {
    draftMode: {
        label: 'About Draft Mode',
        heading: 'Draft Mode',
        body: [
            'Selects the drafting system once the match starts. Classic is a turn-based alternating pick/ban sequence where sides take characters in order; Auction gives each team a spending budget and characters are won by the highest bidder on each nomination.',
            'This choice decides which other settings are live: Auction activates the character/light-cone budgets and minimum bid raise, while Classic ignores them entirely.',
        ],
        foot: 'Stays freely editable, even inside tournament lobbies.',
    },
    gameMode: {
        label: 'About Game Mode',
        heading: 'Game Mode',
        body: [
            'The Honkai: Star Rail end-game mode the drafted teams are scored against. It determines the encounter/enemy set and the scoring rules used to evaluate each side.',
        ],
        foot: "In tournament lobbies it's inherited from and locked to the tournament's default game mode.",
    },
    costSet: {
        label: 'About Cost Set',
        heading: 'Cost Set',
        body: [
            'The cost table the lobby uses: the character and light-cone point values for budgets and handicap calculations. Default is the standard table; a published custom set runs an alternate balance patch and fixes the game mode to its own.',
            'The set must have costs for the chosen game mode and draft mode, or the lobby is not created.',
        ],
        foot: 'In tournament lobbies this is inherited from and locked to the tournament.',
    },
    banMode: {
        label: 'About Ban Mode',
        heading: 'Ban Mode',
        body: [
            'Controls how many characters are removed from the draftable pool. None disables bans, Four removes four characters (split across both sides), and Six removes six.',
            'More bans generally lengthen the draft and shift the meta.',
        ],
        foot: 'Freely adjustable, including in tournament-controlled lobbies.',
    },
    type: {
        label: 'About Type',
        heading: 'Type',
        body: [
            'Whether the match is Casual (unrated, permissive) or Ranked (counts toward player MMR and enforces stricter rules, such as automatically disabling mirror picks).',
            'Guests can only create Casual lobbies.',
        ],
        foot: 'In tournament lobbies this is derived from and locked to the tournament’s “counts toward MMR” flag rather than being chosen directly.',
    },
    anonymousPlayers: {
        label: 'About Anonymous Players',
        heading: 'Anonymous Players',
        body: [
            "Hides player identities during the match by hiding real user IDs on broadcast events (cursor moves, chat and UI) and showing anonymized labels instead. It's used to reduce bias or prevent bracket-scouting of who is playing.",
        ],
        foot: "Inherited from and locked to the tournament's anonymous-players default in tournament lobbies.",
    },
    roster: {
        label: 'About Roster',
        heading: 'Roster',
        body: [
            "Controls how much of each team's account roster is exposed and whether ratings are shown: Open Roster reveals everything, Closed with Rating hides owned characters but shows account rating, and Closed No Rating hides both.",
            'A lobby a guest creates is always Closed No Rating.',
        ],
        foot: 'Inherited from and locked to the tournament in tournament lobbies.',
    },
    teamSize: {
        label: 'About Team Size',
        heading: 'Team Size',
        body: [
            'Number of players fielded per side (Blue vs Red): 1v1, 2v2, or 3v3. It governs how many maximum player slots each team exposes and how many characters ultimately get drafted per side.',
            "Coaches and spectators are counted and capped separately, and aren't affected by this value.",
        ],
        foot: "In tournament-controlled lobbies it's inherited from and locked to the tournament's configured team size, and cannot be changed after creation.",
    },
} as const satisfies Record<string, InfoText>;
