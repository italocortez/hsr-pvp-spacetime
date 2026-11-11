import { table, t } from 'spacetimedb/server';

/**
 * Private table storing lobby password hashes.
 * Extracted from Lobby table to prevent passwordHash from being broadcast to clients.
 * This table is NOT public — it is never sent to any client.
 */
export const lobbyPasswordColumns = {
    lobbyId: t.u32().primaryKey(), // FK to Lobby.id, 1:1 relationship
    passwordHash: t.string(), // S11a (L24): hashLobbyPassword(lobbyId, password), SHA-256 hex (helpers/lobby/lobbyPassword.ts)
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const LobbyPassword = table({
    name: 'lobby_password',
    public: false, // Intentionally NOT public — never broadcast to clients
}, lobbyPasswordColumns);
