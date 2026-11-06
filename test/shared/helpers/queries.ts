/**
 * Shared query helpers — idiomatic iter() + filter patterns used across
 * many test files.
 */

import type { TestHarness } from '../connection';

/** All Lobby rows whose host is this harness's user */
export function myLobbies(h: TestHarness) {
    return [...h.conn.db.Lobby.iter()].filter(l => l.hostUserId === h.userId);
}

/** The most recently created Lobby row hosted by this harness's user */
export function latestLobby(h: TestHarness) {
    const lobby = [...h.conn.db.Lobby.iter()].filter(l => l.hostUserId === h.userId).pop();
    if (!lobby) throw new Error(`latestLobby: no Lobby row for userId=${h.userId}`);
    return lobby;
}

/** All LobbyMember rows for a lobby */
export function lobbyMembers(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.LobbyMember.iter()].filter(m => m.lobbyId === lobbyId);
}

/** All LobbyBan rows for a lobby */
export function lobbyBans(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.LobbyBan.iter()].filter(b => b.lobbyId === lobbyId);
}
