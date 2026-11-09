/**
 * Live residue placeholder (T-S10): outsider isolation over a real subscription. T-S11 writes these after the S11
 * clear-publish (ACCESS-SECURITY-OPS §D.5: subscription isolation is live-only; the in-memory suites check the view
 * bodies, not what the wire delivers). Helpers to reuse: test/shared/two-identity-harness.ts, test/live/_helpers.ts.
 *
 * Estimated runtime: 0 s today (todo only).
 */

import { describe, it } from 'vitest';

describe('Outsider isolation over the wire (S11 placeholder, §D.5)', () => {
    it.todo('view_my_mmr_history: an outsider subscribed over a real connection receives none of another user\'s rows');
    it.todo('view_my_match_participant_history: an outsider receives none of another user\'s rows');
    it.todo('view_my_match_session_history: an outsider receives none of another user\'s rows');
    it.todo('view_my_match_session_step_history: an outsider receives none of another user\'s rows');
    it.todo('view_my_match_result_game_history: an outsider receives none of another user\'s rows');
    it.todo('view_my_lobby_members: a user outside the lobby receives none of its member rows');
    it.todo('view_my_match_* (session, steps, participants, result, result games): a user outside the match receives nothing');
    it.todo('an unmapped identity (connected, no login_as_guest) receives nothing from any per-sender view');
    it.todo('anonymized seats (isAnonymousPlayers / isAnonymousSpectators) carry userId 0 on the wire, not only in the view body (A37)');
});
