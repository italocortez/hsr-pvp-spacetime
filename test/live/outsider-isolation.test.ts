/**
 * Live residue placeholder (T-S10): outsider isolation over a real subscription. T-S11 writes these after the S11
 * clear-publish (ACCESS-SECURITY-OPS §D.5: subscription isolation is live-only; the in-memory suites check the view
 * bodies, not what the wire delivers). Helpers to reuse: test/shared/two-identity-harness.ts, test/live/_helpers.ts.
 *
 * S10n (A115): the five unbounded history views are gone; the history set is view_my_match_history(page, filters),
 * view_my_match_history_count(filters), view_my_match_history_participants / _steps / _games / _lineups
 * (matchHistoryId) and view_my_mmr_history(page, gameMode). Views with arguments are not delivered by
 * subscribeToAllTables (the SDK skips them): T-S11 must subscribe each one explicitly with its argument literals.
 *
 * Estimated runtime: 0 s today (todo only).
 */

import { describe, it } from 'vitest';

describe('Outsider isolation over the wire (S11 placeholder, §D.5)', () => {
    it.todo('view_my_mmr_history(page, gameMode): an outsider subscribed over a real connection receives none of another user\'s rows');
    it.todo('view_my_match_history(page, filters) / view_my_match_history_count(filters): an outsider receives none of another user\'s matches');
    it.todo('view_my_match_history_participants(matchHistoryId): an outsider receives none of that match\'s rows');
    it.todo('view_my_match_history_steps(matchHistoryId): an outsider receives none of that match\'s rows');
    it.todo('view_my_match_history_games(matchHistoryId) / view_my_match_history_lineups(matchHistoryId): an outsider receives none of that match\'s rows');
    it.todo('view_my_lobby_members: a user outside the lobby receives none of its member rows');
    it.todo('view_my_match_* (session, steps, participants, result, result games): a user outside the match receives nothing');
    it.todo('an unmapped identity (connected, no login_as_guest) receives nothing from any per-sender view');
    it.todo('anonymized seats (isAnonymousPlayers / isAnonymousSpectators) carry userId 0 on the wire, not only in the view body (A37)');
});
