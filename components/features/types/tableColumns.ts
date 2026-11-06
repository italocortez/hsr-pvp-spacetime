// Frontend mirror of table metadata from spacetimedb/src/tables/*.ts.
// Keep in sync when tables change.

// Tables with event: true — ephemeral, auto-deleted after insert.
// Add any new event tables here. Absence from this set means event: false (the default).
export const EVENT_TABLES: ReadonlySet<string> = new Set([
    'LobbyCursorEvent',
]);

// All public, non-event tables (browsable in admin Table Explorer).
// Derived by listing all tables where public: true and event is not true.
export const PUBLIC_TABLES = [
    'User',
    'HsrCharacter',
    'HsrLightcone',
    'HsrCharacterCost',
    'HsrLightconeCost',
    'HsrSynergyCost',
    'Lobby',
    'LobbyMember',
    'MatchSession',
    'MatchSessionStep',
    'MatchSessionHistory',
    'MatchSessionStepHistory',
] as const;

export type PublicTableName = typeof PUBLIC_TABLES[number];

// Auto-inc columns (e.g. HsrSynergyCost.id) are excluded since upsert payloads don't include them.

export const UPSERT_TABLE_COLUMNS = {
    HsrCharacter: ['name', 'displayName', 'aliases', 'rarity', 'path', 'element', 'role', 'imageUrl'],
    HsrLightcone: ['name', 'displayName', 'aliases', 'path', 'rarity', 'imageUrl', 'posX', 'posY', 'width'],
    HsrCharacterCost: ['characterName', 'gameMode', 'draftMode', 'costs'],
    HsrLightconeCost: ['lightconeName', 'gameMode', 'draftMode', 'costs'],
    HsrSynergyCost: ['sourceName', 'targetName', 'gameMode', 'draftMode', 'costModifier'],
} as const;

export type UpsertTableName = keyof typeof UPSERT_TABLE_COLUMNS;

// Which columns hold enum values, per upsert table (column name → enum key in ENUM_VALUES)
export const TABLE_ENUM_COLUMNS: Record<UpsertTableName, Record<string, string>> = {
    HsrCharacter: { path: 'path', element: 'element', role: 'role' },
    HsrLightcone: { path: 'path' },
    HsrCharacterCost: { gameMode: 'gameMode', draftMode: 'draftMode' },
    HsrLightconeCost: { gameMode: 'gameMode', draftMode: 'draftMode' },
    HsrSynergyCost: { gameMode: 'gameMode', draftMode: 'draftMode' },
};
