/*
 * The create dialog's two subscriptions (S14.4c), held only while it is open (`useRouteSubscriptions` drops them on
 * close): the published cost sets (the "Cost Set" picker; the same text as the reference set's query, so a session
 * that already holds it shares the rows) and the presets (`view_lobby_presets`: the system preset plus the viewer's
 * own). Plain SQL text, so the dialog's chunk needs no SDK; `createLobbyQueries.test.ts` pins it to `toSql`.
 */

export const PUBLISHED_COST_SETS_QUERY = 'SELECT * FROM "view_published_cost_sets"';
export const LOBBY_PRESETS_QUERY = 'SELECT * FROM "view_lobby_presets"';
export const CREATE_LOBBY_QUERIES: readonly string[] = [
    PUBLISHED_COST_SETS_QUERY,
    LOBBY_PRESETS_QUERY,
];
