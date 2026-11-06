// Frontend mirror of spacetimedb/src/types/enums.ts
// Keep in sync when server enum variants change.

// export type Team = "Blue" | "Red" | "test";
// export type Action = "Pick" | "Ban" | "test";

// -- Eidolons and Impositions are declared here AGAIN because the db fields are lowercased, which looks bad on UI.
export const Eidolons = ["E0", "E1", "E2", "E3", "E4", "E5", "E6"] as const;
export type CharacterRank = typeof Eidolons[number];

export const SuperImpositions = ["S1", "S2", "S3", "S4", "S5"] as const;
export type LightconeRank = typeof SuperImpositions[number];
// ------------------------------

export type Team = typeof TEAM_LABEL_VARIANTS[number];
export type Action = typeof ACTION_TYPE_VARIANTS[number];
export type Turn = { team: Team; action: Action };
export type RuleSet = typeof GAME_MODE_VARIANTS[number];
export type DraftMode = typeof DRAFT_MODE_VARIANTS[number];

export type Path = typeof PATH_VARIANTS[number];
export type Element = typeof ELEMENT_VARIANTS[number];
export type Role = typeof CHAR_ROLE_VARIANTS[number];
export type Rarity = 3 | 4 | 5;

export interface LightconeAnchor { width: number, x: number, y: number }
export const DEFAULT_LIGHTCONE_ANCHOR: LightconeAnchor = { width: 100, x: -48, y: -32 };

export interface SelectedCharacter {
  characterName: string; // ruanmei
  action: Action;
}

//  Constructs as so:
// {
//     Classic: {
//         MemoryOfChaos: { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number },
//         ApocalypticShadow: { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number },
//         AnomalyArbitration: { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number },
//     },
//     Auction: {
//         MemoryOfChaos: { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number },
//         ApocalypticShadow: { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number }
//         AnomalyArbitration: { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number },
//     }
// }
export type CharacterCost = Record<DraftMode, Record<RuleSet, { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number }>>;

//  Constructs as so:
// {
//     Classic: { S1: number, S2: number, S3: number, S4: number, S5: number },
//     Auction: { S1: number, S2: number, S3: number, S4: number, S5: number },
// }
export type LightconeCost = Record<DraftMode, { S1: number, S2: number, S3: number, S4: number, S5: number }>;

export interface Character {
    name: string; // ruanmei
    displayName: string; // Ruan Mei
    aliases: string[];
    element: Element;
    path: Path;
    rarity: Rarity;
    role: Role;
    imageUrl?: string;

    cost: CharacterCost;
}

export interface Lightcone {
    name: string; // agroundedascent
    displayName: string; // A Grounded Ascent
    aliases: string[];
    path: Path;
    rarity: number;
    imageUrl?: string;

    // For centering lc's image
    anchor: LightconeAnchor;

    cost: LightconeCost;
}

export interface Synergy {
    id: number;
    sourceName: string; // ruanmei
    targetName: string; // ruanmei
    ruleSet: RuleSet;
    costModifier: number;
}

export const PATH_VARIANTS = [ 'Abundance', 'Destruction', 'Erudition', 'Harmony', 'Hunt', 'Nihility', 'Preservation', 'Remembrance', 'Elation' ] as const;

export const ELEMENT_VARIANTS = [ 'Fire', 'Ice', 'Imaginary', 'Lightning', 'Physical', 'Quantum', 'Wind' ] as const;

export const CHAR_ROLE_VARIANTS = [ 'Dps', 'Support', 'Sustain' ] as const;

export const GAME_MODE_VARIANTS = [ 'MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration' ] as const;

export const USER_ROLE_VARIANTS = ['Admin', 'TournamentHost', 'User'] as const;

export const DRAFT_MODE_VARIANTS = ['Classic', 'Auction'] as const;

export const BAN_MODE_VARIANTS = ['None', 'Two', 'Four', 'Six'] as const;

export const LOBBY_STAGE_VARIANTS = ['Waiting', 'Drafting', 'Equipping', 'Scoring', 'Finished'] as const;

export const PARTICIPATION_ROLE_VARIANTS = ['Player', 'Coach'] as const;

export const TEAM_LABEL_VARIANTS = ['Spectator', 'Blue', 'Red'] as const;

export const MATCH_RESULT_VARIANTS = ['BlueWins', 'RedWins', 'Draw', 'Aborted'] as const;

export const ACTION_TYPE_VARIANTS = [ 'Pick', 'Ban', 'Nominate', 'Bid', 'AuctionSold', 'Pause', 'Undo' ] as const;

// Lookup map for validation (keyed by column name convention)
export const ENUM_VALUES: Record<string, readonly string[]> = {
    path: PATH_VARIANTS,
    element: ELEMENT_VARIANTS,
    role: CHAR_ROLE_VARIANTS,
    gameMode: GAME_MODE_VARIANTS,
    userRole: USER_ROLE_VARIANTS,
    draftMode: DRAFT_MODE_VARIANTS,
    banMode: BAN_MODE_VARIANTS,
    lobbyStage: LOBBY_STAGE_VARIANTS,
    participationRole: PARTICIPATION_ROLE_VARIANTS,
    teamLabel: TEAM_LABEL_VARIANTS,
    matchResult: MATCH_RESULT_VARIANTS,
    actionType: ACTION_TYPE_VARIANTS,
};
