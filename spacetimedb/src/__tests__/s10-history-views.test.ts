// T-S10 (batch B): in-memory port of test/backend/views/matchHistoryViews/isolation.test.ts (A37; docs/views/contract.md
// overview layer 1 "per-user data scoping" and S9a-V9 "a participant reads their matches through the view_my_*_history
// set"). The over-the-wire half (two connected clients each receiving only their rows) stays with the S11
// outsider-isolation residue.
// Two finished matches in one harness: match A is Ranked and finalized with admin_force_finalize by the internal owner
// (the SYSTEM Admin) after seedElo, which writes MmrHistory; match B is Casual and finalizes inline at the close of its
// game (no MmrHistory). Views are called as `(M as any).view_x(test.viewContext(auth), {})` (s9a method). Nothing
// reaches maincloud.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { M, TestAuth, guest, lobbyRow, newHarness, tx, type Actor, type Harness, type Lobby, type SlotTag } from './s4-fixtures';
import { blueNames, finishGame, playToScoring, redNames, type ScoringLobbyOpts } from './s7-fixtures';
import { seedElo } from './s8d-fixtures';

type Reader = Actor | TestAuth;
const authOf = (r: Reader): TestAuth => ('auth' in r ? r.auth : r);
const view = <T = any>(test: Harness, name: string, who: Reader): T[] => (M as any)[name](test.viewContext(authOf(who)), {}) as T[];

let ghostSeq = 9_000n;
/** An identity that never logged in (no UserIdentity mapping). */
const ghost = () => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub: `s10-ghost-${ghostSeq}` }), new ConnectionId(ghostSeq++));

const seatsOf = (p: string): Array<[string, SlotTag]> =>
    [[`${p}b1`, 'BluePlayer'], [`${p}b2`, 'BluePlayer'], [`${p}r1`, 'RedPlayer'], [`${p}r2`, 'RedPlayer']];

/** playToScoring with prefixed actors and character names (HsrCharacter names are unique per harness). */
function scoringOf(test: Harness, p: string, opts: ScoringLobbyOpts = {}): Lobby {
    return playToScoring(test, {
        seats: seatsOf(p),
        actors: { host: guest(test, `${p}host`) },
        blue: blueNames().map((n) => `${p}${n}`),
        red: redNames().map((n) => `${p}${n}`),
        ...opts,
    });
}

/** beforeStart hook: the lobby becomes Ranked (direct row edit, as s7b / s9a / s9b) and every player gets an HSR account. */
const makeRanked = (test: Harness) => (l: Lobby) => {
    test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
    let accountId = 700 + l.lobbyId * 10;
    for (const m of test.db.LobbyMember.lobby_id.filter(l.lobbyId)) {
        if (m.lobbySlot.tag === 'BluePlayer' || m.lobbySlot.tag === 'RedPlayer') {
            test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: m.userId, hsrAccountId: accountId++ });
        }
    }
};

const HISTORY_VIEWS = [
    'view_my_mmr_history',
    'view_my_match_participant_history',
    'view_my_match_session_history',
    'view_my_match_result_game_history',
] as const;
type HistoryView = (typeof HISTORY_VIEWS)[number];

/** The match-history ids a user played in (the private MatchParticipantHistory, read module-side). */
const playedIn = (test: Harness, who: Actor) => new Set([...test.db.MatchParticipantHistory.by_user.filter(who.userId)].map((p) => p.matchHistoryId));

/** I1: every row belongs to the reader: its userId, or for the user-less tables its match id among the reader's matches. */
function expectOwnRows(test: Harness, name: HistoryView, who: Actor, rows: any[]) {
    const mine = playedIn(test, who);
    for (const r of rows) {
        if (name === 'view_my_mmr_history' || name === 'view_my_match_participant_history') expect(r.userId).toBe(who.userId);
        if (name === 'view_my_match_session_history') expect(mine.has(r.id)).toBe(true);
        if (name === 'view_my_match_result_game_history') expect(mine.has(r.matchHistoryId)).toBe(true);
        if (name === 'view_my_mmr_history') expect(mine.has(r.matchHistoryId)).toBe(true);
    }
}

function world() {
    const test = newHarness();
    seedElo(test);
    const ranked = scoringOf(test, 'A', { beforeStart: makeRanked(test) });
    finishGame(ranked, 'Blue');
    expect(lobbyRow(test, ranked.lobbyId).stage.tag).toBe('AwaitingResult');
    tx(test, 'internal', (ctx) => M.admin_force_finalize(ctx, { lobbyId: ranked.lobbyId, winnerTeamId: 1 }));
    expect(test.db.Lobby.id.find(ranked.lobbyId)).toBeNull(); // finalized: the lobby is gone

    const casual = scoringOf(test, 'B');
    finishGame(casual, 'Red');
    expect(test.db.Lobby.id.find(casual.lobbyId)).toBeNull(); // casual: finalized inline

    return { test, ranked, casual, outsider: guest(test, 'outsider') };
}

describe('A37 history views: per-sender scoping of view_my_*_history', () => {
    it.each(HISTORY_VIEWS)('%s: a Ranked participant reads only their own rows; an outsider, a player of the other match and an unmapped identity read none of them', (name) => {
        const { test, ranked, casual, outsider } = world();
        const rankedIds = playedIn(test, ranked.a.Ab1);
        expect(rankedIds.size).toBe(1);

        for (const who of [ranked.a.Ab1, ranked.a.Ar2]) {
            const rows = view(test, name, who);
            expect(rows.length).toBeGreaterThan(0);
            expectOwnRows(test, name, who, rows);
        }
        if (name === 'view_my_match_participant_history' || name === 'view_my_mmr_history') {
            expect(view(test, name, ranked.a.Ab1)).toHaveLength(1); // one match, one row of their own (not the team's four)
        }

        expect(view(test, name, outsider)).toEqual([]);
        expect(view(test, name, ghost())).toEqual([]);
        // The other match's player sees nothing of match A (their own rows only).
        const other = view(test, name, casual.a.Bb1);
        expectOwnRows(test, name, casual.a.Bb1, other);
        const aId = [...rankedIds][0];
        for (const r of other) {
            expect([r.id, r.matchHistoryId]).not.toContain(aId);
        }
    });

    it.each(HISTORY_VIEWS)('%s: a Casual participant reads their match rows (no MmrHistory: Casual skips MMR); outsider and unmapped identity read []', (name) => {
        const { test, casual, outsider } = world();
        const rows = view(test, name, casual.a.Br1);
        if (name === 'view_my_mmr_history') {
            expect(rows).toEqual([]);
        } else {
            expect(rows.length).toBeGreaterThan(0);
            expectOwnRows(test, name, casual.a.Br1, rows);
        }
        expect(view(test, name, outsider)).toEqual([]);
        expect(view(test, name, ghost())).toEqual([]);
    });
});
