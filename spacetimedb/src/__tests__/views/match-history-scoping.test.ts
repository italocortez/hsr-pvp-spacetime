// Views: the match history views are scoped per sender.
// Decisions: A37, A115
// Contracts: docs/views/contract.md
// From S10 (s10-history-views.test.ts).
//
// T-S10 (batch B): in-memory port of test/backend/views/matchHistoryViews/isolation.test.ts (A37; docs/views/contract.md
// overview layer 1 "per-user data scoping" and S9a-V9 "a participant reads their matches through the view_my_*_history
// set"). The over-the-wire half (two connected clients each receiving only their rows) stays with the S11
// outsider-isolation residue.
// T-S10n (A115): re-aligned to the paged history set. view_my_match_session_history / view_my_match_participant_history
// → view_my_match_history (the list row carries the session fields and the caller's own participant fields);
// view_my_match_result_game_history → view_my_match_history_games(matchHistoryId); view_my_match_history_participants
// (matchHistoryId) is probed too; view_my_mmr_history takes (page, gameMode). Same assertions: own rows only.
// Two finished matches in one harness: match A is Ranked and finalized with admin_force_finalize by the internal owner
// (the SYSTEM Admin) after seedElo, which writes MmrHistory; match B is Casual and finalizes inline at the close of its
// game (no MmrHistory). Views are called as `(M as any).view_x(test.viewContext(auth), args)` (s9a method). Nothing
// reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, guest, lobbyRow, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import { finishGame } from '../fixtures/draft-and-scoring';
import { makeGhost, makeRanked, view, ANY, scoringOf } from '../fixtures/views';
import { seedElo } from '../fixtures/tournament-matches';

/** An identity that never logged in (no UserIdentity mapping). */
const ghost = makeGhost('s10-ghost-', 9_000n);

/** Each probe: the view and its arguments; the per-match views get the id of the match the probe is about. */
const HISTORY_VIEWS = [
    ['view_my_mmr_history', () => ({ page: 0, gameMode: '' })],
    ['view_my_match_history', () => ({ page: 0, ...ANY })],
    ['view_my_match_history_participants', (matchHistoryId: number) => ({ matchHistoryId })],
    ['view_my_match_history_games', (matchHistoryId: number) => ({ matchHistoryId })],
] as const;
type HistoryView = (typeof HISTORY_VIEWS)[number][0];
const NAMES = HISTORY_VIEWS.map(([n]) => n);
const argsOf = (name: HistoryView, matchHistoryId: number) => HISTORY_VIEWS.find(([n]) => n === name)![1](matchHistoryId);

/** The match-history ids a user played in (the private MatchParticipantHistory, read module-side). */
const playedIn = (test: Harness, who: Actor) => new Set([...test.db.MatchParticipantHistory.by_user.filter(who.userId)].map((p) => p.matchHistoryId));

/** I1: every row belongs to the reader: its userId (rating rows), or its match id among the reader's matches. */
function expectOwnRows(test: Harness, name: HistoryView, who: Actor, rows: any[]) {
    const mine = playedIn(test, who);
    for (const r of rows) {
        if (name === 'view_my_mmr_history') expect(r.userId).toBe(who.userId);
        expect(mine.has(r.matchHistoryId)).toBe(true);
    }
}

function world() {
    const test = newHarness();
    seedElo(test);
    const ranked = scoringOf(test, 'A', { beforeStart: makeRanked(test, 700) });
    finishGame(ranked, 'Blue');
    expect(lobbyRow(test, ranked.lobbyId).stage.tag).toBe('AwaitingResult');
    tx(test, 'internal', (ctx) => M.admin_force_finalize(ctx, { lobbyId: ranked.lobbyId, winnerTeamId: 1 }));
    expect(test.db.Lobby.id.find(ranked.lobbyId)).toBeNull(); // finalized: the lobby is gone

    const casual = scoringOf(test, 'B');
    finishGame(casual, 'Red');
    expect(test.db.Lobby.id.find(casual.lobbyId)).toBeNull(); // casual: finalized inline

    return { test, ranked, casual, outsider: guest(test, 'outsider') };
}

describe('A37 history views: per-sender scoping of the view_my_*_history set (T-S10n: paged list, per-match detail, A115)', () => {
    it.each(NAMES)('%s: a Ranked participant reads only their own rows; an outsider, a player of the other match and an unmapped identity read none of them', (name) => {
        const { test, ranked, casual, outsider } = world();
        const rankedIds = playedIn(test, ranked.a.Ab1);
        expect(rankedIds.size).toBe(1);
        const aId = [...rankedIds][0];
        const args = argsOf(name, aId);

        for (const who of [ranked.a.Ab1, ranked.a.Ar2]) {
            const rows = view(test, name, who, args);
            expect(rows.length).toBeGreaterThan(0);
            expectOwnRows(test, name, who, rows);
        }
        if (name === 'view_my_match_history' || name === 'view_my_mmr_history') {
            expect(view(test, name, ranked.a.Ab1, args)).toHaveLength(1); // one match, one row of their own (not the team's four)
        }

        expect(view(test, name, outsider, args)).toEqual([]);
        expect(view(test, name, ghost(), args)).toEqual([]);
        // The other match's player sees nothing of match A (their own rows only).
        const other = view(test, name, casual.a.Bb1, args);
        expectOwnRows(test, name, casual.a.Bb1, other);
        for (const r of other) {
            expect(r.matchHistoryId).not.toBe(aId);
        }
    });

    it.each(NAMES)('%s: a Casual participant reads their match rows (no MmrHistory: Casual skips MMR); outsider and unmapped identity read []', (name) => {
        const { test, casual, outsider } = world();
        const args = argsOf(name, [...playedIn(test, casual.a.Br1)][0]);
        const rows = view(test, name, casual.a.Br1, args);
        if (name === 'view_my_mmr_history') {
            expect(rows).toEqual([]);
        } else {
            expect(rows.length).toBeGreaterThan(0);
            expectOwnRows(test, name, casual.a.Br1, rows);
        }
        expect(view(test, name, outsider, args)).toEqual([]);
        expect(view(test, name, ghost(), args)).toEqual([]);
    });
});
