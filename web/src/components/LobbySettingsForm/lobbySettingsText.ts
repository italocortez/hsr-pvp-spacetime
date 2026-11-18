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
    /** Bullets after the body (the mockup's `ul` in the disconnect policy panel). */
    list?: readonly ReactNode[];
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

/*
 * Advanced Settings (S14.4d): the mockup's labels and section titles (design/mockups/index.html `#advBackdrop`); the
 * seven settings the mockup lacks (A221 R5) in the builder's words. Units sit in the field's box, so a label loses the
 * mockup's "(s)". Tabled in docs/frontend/pages.md "Advanced Settings (S14.4d)".
 */
export const ADVANCED_TEXT = {
    title: 'Advanced Settings',
    close: 'Close Advanced Settings',
    done: 'Done',
    presetNote: (preset: string) =>
        `A preset seeds these settings; adjust any of them individually. Settings Preset: ${preset}.`,
    match: 'Match',
    banRestriction: 'Ban Restriction',
    lineupFormat: 'Lineup Format',
    classicOnly: 'Classic draft only',
    allowMirrorPicks: 'Mirror Picks',
    autoRandomPick: 'Random Auto-Pick',
    auction: 'Auction Economy',
    auctionOnly: 'Auction draft only',
    characterBudget: 'Character Budget',
    lightconeBudget: 'Light Cone Budget',
    minimumBidRaise: 'Minimum Bid Raise',
    handicap: 'Handicap / Scoring',
    handicapNote: 'optional · 0 = no effect',
    deathPenalty: 'Death Penalty',
    rosterDiffAdvantage: 'Roster Diff Advantage',
    rosterThreshold: 'Roster Threshold',
    underThresholdAdvantage: 'Under-Threshold Advantage',
    aboveThresholdPenalty: 'Above-Threshold Penalty',
    ownership: 'Ownership',
    requireOwnership: 'Require Ownership',
    timers: 'Timers',
    standardTurnSeconds: 'Standard Turn',
    reserveBankSeconds: 'Reserve Bank',
    confirmWindowSeconds: 'Confirm Window',
    referee: 'Referee Powers & Pausing',
    refereeCanUndo: 'Referee Can Undo',
    refereeCanPause: 'Referee Can Pause',
    refereeCanSetCaptain: 'Referee Can Set Captain',
    refereeCanKick: 'Referee Can Kick',
    allowPlayerPause: 'Players Can Pause',
    refereeExclusiveConcede: 'Referee-Only Concede',
    privacy: 'Privacy & Access',
    isAnonymousSpectators: 'Anonymous Spectators',
    hideMmr: 'Hide MMR',
    maxSpectators: 'Spectators',
    teamBlueAlias: 'Blue Team Name',
    teamRedAlias: 'Red Team Name',
    teamAliasPlaceholder: (side: string) => `${side} (default)`,
    disconnect: 'Disconnect Handling',
    disconnectPolicy: 'Disconnect Policy',
    disconnectForfeitSeconds: 'Auto-Forfeit',
    noActionRanked: 'No Action (Casual only)',
    // Units in the box (shown) and with the label (read).
    secondsUnit: 's',
    secondsSpoken: ' (seconds)',
    unitWord: { cycles: 'cycles', points: 'points' },
    perCostUnit: 'per cost',
    perCostSpoken: (unit: string) => ` (${unit} per point of roster-cost difference)`,
    costUnit: 'cost',
    costSpoken: ' (roster cost)',
    maxUnit: 'max',
    maxSpoken: ' (at most)',
    // Why a control does not apply (shown under it, and its description).
    auctionLocked: 'Auction draft only: a Classic lobby does not use these.',
    classicLocked: 'Classic draft only: an Auction lobby does not use it.',
    rankedMirror: 'Ranked lobbies never allow mirror picks.',
    // The footer button's mark: how many advanced settings need a fix (read with the button's name).
    errorMark: (n: number) => `, ${n} ${n === 1 ? 'setting needs' : 'settings need'} a fix`,
} as const;

/** The mockup's info panels for Advanced Settings; reworded where the module differs (listed in pages.md). */
export const ADVANCED_INFO = {
    banRestriction: {
        label: 'About Ban Restriction',
        heading: 'Ban Restriction',
        body: [
            'Caps how many characters of a given role each team may ban. For example, "Max 1 DPS" stops a team from banning more than one DPS character.',
        ],
        foot: 'Works alongside Ban Mode, which sets how many bans there are. "No restriction" lets teams ban freely within that count.',
    },
    lineupFormat: {
        label: 'About Lineup Format',
        heading: 'Lineup Format',
        body: [
            'How many characters each team drafts and how they are arranged for scoring: Halves is 8 characters in two groups of 4, Thirds is 12 characters in three groups of 4. Results are entered per group.',
        ],
        foot: 'Thirds makes the draft longer: 12 picks per team instead of 8.',
    },
    allowMirrorPicks: {
        label: 'About Mirror Picks',
        heading: 'Mirror Picks',
        body: [
            'When on, a team may pick a character the other team already picked. No team picks the same character twice. When off, a picked character is gone for both teams.',
        ],
        foot: 'Ranked lobbies never allow mirror picks.',
    },
    autoRandomPick: {
        label: 'About Random Auto-Pick',
        heading: 'Random Auto-Pick',
        body: [
            "When a turn's time runs out, a random character is picked (or banned) for that team instead of the turn being skipped.",
            'With Require Ownership on, the pick comes from the characters the team owns, and every seated player needs a game account with characters before the draft can start. Without it, any priced character can come up; a player who gets one they do not have asks the referee to undo it.',
        ],
        foot: 'Off by default.',
    },
    characterBudget: {
        label: 'About Character Budget',
        heading: 'Character Budget',
        body: [
            'In Auction draft mode, the spending allowance each team has for bidding on characters. Teams draw from this pool as they win nominations, so a smaller budget forces sharper prioritization and trade-offs.',
            'An Auction lobby needs a budget above 0.',
        ],
        foot: 'Ignored entirely in Classic mode.',
    },
    lightconeBudget: {
        label: 'About Light Cone Budget',
        heading: 'Light Cone Budget',
        body: [
            'In an Auction lobby, what each team has for its light cones. Light cones are not auctioned: after the draft each team equips them at their listed cost, paid from this budget.',
            'It also covers what the character budget cannot: an eidolon extra larger than the character budget left spills into it, and when the draft ends any character budget left over is added to it.',
        ],
        foot: 'Ignored in Classic mode.',
    },
    minimumBidRaise: {
        label: 'About Minimum Bid Raise',
        heading: 'Minimum Bid Raise',
        body: [
            'The smallest amount by which a new bid must exceed the current high bid in an auction. It prevents trivial single-unit overbidding wars and sets the granularity of auction competition.',
            'An Auction lobby needs a raise above 0.',
        ],
        foot: 'Only relevant in Auction mode.',
    },
    deathPenalty: {
        label: 'About Death Penalty',
        heading: 'Death Penalty',
        body: [
            'A scoring penalty assessed per character death during the match, letting organizers factor how cleanly a team clears the mode into the final result.',
        ],
        foot: 'Applies to both draft modes. Set to 0 to disable death-based scoring adjustments.',
    },
    rosterDiffAdvantage: {
        label: 'About Roster Diff Advantage',
        heading: 'Roster Diff Advantage',
        body: [
            'A handicap knob tied to the roster-cost difference between the two teams. It scales how much scoring advantage is granted to the side that drafted the lower-valued roster, helping balance intentionally uneven matchups.',
        ],
        foot: 'Part of the optional handicap system; 0 disables its effect.',
    },
    rosterThreshold: {
        label: 'About Roster Threshold',
        heading: 'Roster Threshold',
        body: [
            'A roster-cost cutoff the handicap system uses to decide whether the under- or above-threshold modifiers apply. Rosters valued below this line can earn a bonus, while those above it can incur a penalty.',
        ],
        foot: 'Works with Under-Threshold Advantage and Above-Threshold Penalty; 0 turns threshold-based handicapping off.',
    },
    underThresholdAdvantage: {
        label: 'About Under-Threshold Advantage',
        heading: 'Under-Threshold Advantage',
        body: [
            "The scoring bonus applied when a team's roster cost falls below the roster threshold, rewarding sides that draft cheaper compositions.",
        ],
        foot: 'Only matters when the handicap system is active; 0 means no bonus is granted.',
    },
    aboveThresholdPenalty: {
        label: 'About Above-Threshold Penalty',
        heading: 'Above-Threshold Penalty',
        body: [
            "The scoring penalty applied when a team's roster cost rises above the roster threshold, discouraging or offsetting expensive, stacked compositions. It's the counterpart to Under-Threshold Advantage.",
        ],
        foot: '0 means no penalty is applied.',
    },
    requireOwnership: {
        label: 'About Require Ownership',
        heading: 'Require Ownership',
        body: [
            'When enabled, players may only pick characters they actually own on their linked Honkai: Star Rail account, enforcing a "play what you have" ruleset. When off, the full roster is draftable regardless of ownership.',
        ],
        foot: 'In tournament lobbies this is inherited from and locked to the tournament.',
    },
    standardTurnSeconds: {
        label: 'About Standard Turn time',
        heading: 'Standard Turn (seconds)',
        body: [
            "The base per-turn thinking time, in seconds, granted to the acting side during the draft. When a side's standard turn time is used up, its reserve bank begins draining, so this and the reserve bank together form a chess-clock-style timing system.",
        ],
        foot: '10 to 600 seconds; the default is 60.',
    },
    reserveBankSeconds: {
        label: 'About Reserve Bank time',
        heading: 'Reserve Bank (seconds)',
        body: [
            "A per-team reserve time pool, in seconds, consumed only after the side's standard turn time runs out. It acts as a shared safety buffer across the whole match, so a team can occasionally take longer on a hard decision without immediately timing out.",
        ],
        foot: '0 to 1800 seconds; the default is 120.',
    },
    confirmWindowSeconds: {
        label: 'About Confirm Window time',
        heading: 'Confirm Window (seconds)',
        body: [
            'After the last pick or sale, the draft waits this long before equipping starts by itself. In that window a referee can undo the last step (with Referee Can Undo on) or move on to equipping at once. A pause holds the window.',
            '0 means no window: equipping starts with the last step, which then cannot be undone.',
        ],
        foot: '0 to 300 seconds; the default is 60.',
    },
    refereeCanUndo: {
        label: 'About Referee Can Undo',
        heading: 'Referee Can Undo',
        body: [
            'Grants the lobby referee the power to undo the last draft action (a pick, ban, or bid), used to correct misclicks or resolve disputed steps. Only a referee can undo, so with this off nobody can.',
        ],
        foot: 'Freely set per lobby.',
    },
    refereeCanPause: {
        label: 'About Referee Can Pause',
        heading: 'Referee Can Pause',
        body: [
            "Allows the referee to pause the match and draft timers, for example to handle a dispute or a technical issue. It is independent of the players' own pause allowance.",
        ],
        foot: 'Freely configurable per lobby.',
    },
    refereeCanSetCaptain: {
        label: 'About Referee Can Set Captain',
        heading: 'Referee Can Set Captain',
        body: [
            'Permits the referee, not just the host or an admin, to assign the team captain, who makes the binding draft decisions for a side. When off, only the host or an admin can assign captains.',
        ],
        foot: 'Freely set.',
    },
    refereeCanKick: {
        label: 'About Referee Can Kick',
        heading: 'Referee Can Kick',
        body: [
            'Lets the referee remove members from the lobby. When enabled, the referee gains the kick and ban ability that is otherwise limited to the host, moderators, and admins.',
        ],
        foot: 'Off by default, so refereeing does not imply moderation power.',
    },
    allowPlayerPause: {
        label: 'About Players Can Pause',
        heading: 'Players Can Pause',
        body: [
            'Whether players themselves may pause the match, typically a small fixed number of pauses per team (three), separate from referee pausing. It gives teams limited self-service breaks for real-life interruptions.',
        ],
        foot: 'Freely toggled.',
    },
    refereeExclusiveConcede: {
        label: 'About Referee-Only Concede',
        heading: 'Referee-Only Concede',
        body: [
            'When on, and a referee who sits in the Spectator seat is in the lobby, only that referee can concede, claim a forfeit or defer the match; the players cannot. With this off, or without such a referee, players concede for their own team.',
            'No setting ends a match by itself: a match is never conceded automatically.',
        ],
        foot: 'On by default. The host can change it later in the lobby settings.',
    },
    isAnonymousSpectators: {
        label: 'About Anonymous Spectators',
        heading: 'Anonymous Spectators',
        body: [
            'When on, the people in the Spectator seat are shown to everyone else in the lobby under an anonymous label instead of their name. A referee in the Spectator seat still sees every name.',
            'It is independent of Anonymous Players, so you can hide the crowd without hiding the competitors, or the other way round.',
        ],
        foot: 'Inherited from and locked to the tournament setting in tournament lobbies.',
    },
    hideMmr: {
        label: 'About Hide MMR',
        heading: 'Hide MMR',
        body: ["When on, the lobby's member list does not show anyone's MMR."],
        foot: 'Off by default.',
    },
    maxSpectators: {
        label: 'About Spectators',
        heading: 'Spectators',
        body: [
            'How many people can join only to watch, from 0 to 12: everyone who joins once the match has started, and in a tournament lobby everyone who joins without a team seat.',
            'Before the start of a casual lobby, people who join wait in the Spectator seat for a place on a team and are not counted. A lobby holds at most 20 members in all.',
        ],
        foot: 'The default is 12.',
    },
    teamAliases: {
        label: 'About Team Names',
        heading: 'Team Names',
        body: [
            'Optional names for the two sides, up to 30 characters each. Left empty, the sides are Blue and Red.',
        ],
    },
    disconnectPolicy: {
        label: 'About Disconnect Policy',
        heading: 'Disconnect Policy',
        body: ['Governs how the match reacts when a player drops during an active stage.'],
        list: [
            "Standard: protects the match. A player still offline 15 seconds after dropping pauses the draft (during drafting). After those 15 seconds the captain role moves to a teammate, and the host and referee roles move to another member who is online. The player's disconnect pool drains while they are away. Nothing ends the match by itself: once every player of a side has been offline past the grace (or their pool is spent), the other team or the referee can claim a forfeit.",
            'No Action: the draft is not paused, nothing is counted against the player, and no forfeit can be claimed; the timer keeps running. The captain, host and referee roles still move after 15 seconds offline. Casual lobbies only.',
        ],
        foot: 'Only matters during active stages (drafting, equipping, scoring). Deferred is for tournament lobbies only. In tournament lobbies it is inherited from and locked to the tournament.',
    },
    disconnectForfeitSeconds: {
        label: 'About Auto-Forfeit time',
        heading: 'Auto-Forfeit (seconds)',
        body: [
            'The grace period, in seconds, before the other team can claim a forfeit once every player of a side is offline. 0 keeps the default of 60 seconds; otherwise 30 to 600.',
        ],
        foot: "In tournament lobbies this is derived from the tournament's auto-forfeit time (when enabled) and locked.",
    },
} as const satisfies Record<string, InfoText>;
