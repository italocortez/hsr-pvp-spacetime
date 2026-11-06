// Frontend mirror of spacetimedb/src/types/structs.ts
// Keep in sync when server struct shapes change.

export const EIDOLON_KEYS = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'] as const;

export const SUPERIMPOSITION_KEYS = ['s1', 's2', 's3', 's4', 's5'] as const;

export const LOBBY_CONFIG_KEYS = [
    'teamSize', 'draftMode', 'banMode',
    'standardTurnSeconds', 'reserveBankSeconds', 'auctionBudget',
    'rosterDiffAdvantage', 'rosterThreshold',
    'underThresholdAdvantage', 'aboveThresholdPenalty', 'deathPenalty',
] as const;
