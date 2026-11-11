// Views: paged and filtered match history, the match detail, the rating history and deleted history rows.
// Decisions: A115
// Contracts: docs/views/contract.md
// From S10n (s10n-history-pages.test.ts).
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import {
    M,
    START,
    TestAuth,
    advance,
    disconnect,
    guest,
    lobbyRow,
    newHarness,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SlotTag,
} from '../fixtures/harness';
import {
    H,
    blueNames,
    finishGame,
    gameRow,
    playToScoring,
    record,
    recordScores,
    redNames,
    type ScoringLobbyOpts,
} from '../fixtures/draft-and-scoring-builders';
import {
    byKey,
    drain,
    openMatchLobby,
    playMatch,
    recordsOfLobby,
    seedElo,
    validate,
} from '../fixtures/tournament-match-builders';
import { advanceStage, liveField, moderator } from '../fixtures/tournament-builders';
import { playRanked, rankedHook, validateAndFinalize } from '../fixtures/ranked-game-builders';

type Reader = Actor | TestAuth;
const authOf = (r: Reader): TestAuth => ('auth' in r ? r.auth : r);
const view = <T = any>(test: Harness, name: string, who: Reader, args: Record<string, unknown>): T[] =>
    (M as any)[name](test.viewContext(authOf(who)), args) as T[];

let ghostSeq = 19_000n;
/** An identity that never logged in (no UserIdentity mapping). */
const ghost = () => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub: `s10n-ghost-${ghostSeq}` }), new ConnectionId(ghostSeq++));

const ANY = { gameMode: '', draftMode: '', matchType: '' };
type Filters = { gameMode?: string; draftMode?: string; matchType?: string };
const listPage = (test: Harness, who: Reader, page: number, f: Filters = {}) =>
    view(test, 'view_my_match_history', who, { page, ...ANY, ...f });
const countOf = (test: Harness, who: Reader, f: Filters = {}) => view<{ total: number }>(test, 'view_my_match_history_count', who, { ...ANY, ...f });
/** Every page until the first empty one. */
function allPages(test: Harness, who: Reader, f: Filters = {}): any[][] {
    const pages: any[][] = [];
    for (let p = 0; p < 50; p++) {
        const rows = listPage(test, who, p, f);
        if (rows.length === 0) break;
        pages.push(rows);
    }
    return pages;
}
const idsOf = (rows: any[]) => rows.map((r) => r.matchHistoryId);

// ─── Archived matches by direct insert ───────────────────────────────────────

const MINUTE = 60_000_000n;
const at = (minutes: number) => new Timestamp(START.microsSinceUnixEpoch + BigInt(minutes) * MINUTE);
const auditAt = (ts: Timestamp) => ({ createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts });

interface Seat { who: Actor; side: 'Blue' | 'Red'; isCoach?: boolean }
interface ArchiveOpts {
    minutes: number;
    gameMode?: string;
    draftMode?: string;
    /** Write MmrHistory rows for the non-coach seats (a rated standalone match); the stored match type is Ranked. */
    rated?: boolean;
    tournamentId?: number;
    /** The stored winner (default Blue); null = no winner (no game row either). */
    winner?: 'Blue' | 'Red' | null;
}

/**
 * One archived match with its game row, participants and (rated) rating rows. Returns the match history id. The
 * session row carries the stored matchType (Ranked when rated) and winnerTeamSide, as finalization writes them.
 */
function archive(test: Harness, seats: Seat[], o: ArchiveOpts): number {
    const playedAt = at(o.minutes);
    const draftMode = { tag: o.draftMode ?? 'Classic' };
    const gameMode = { tag: o.gameMode ?? 'MemoryOfChaos' };
    const winner = o.winner === undefined ? 'Blue' : o.winner;
    const row = test.db.MatchSessionHistory.insert({
        id: 0, lobbyCode: 'HIST01', playedAt, draftMode, gameMode, teamBlueAlias: 'Blue', teamRedAlias: 'Red',
        snapshotConfig: {
            teamSize: 1, draftMode, banMode: { tag: 'None' }, lineupFormat: { tag: 'Halves' }, standardTurnSeconds: 30,
            reserveBankSeconds: 60, characterBudget: 100, lightconeBudget: 50, rosterDiffAdvantage: 0, rosterThreshold: 0,
            underThresholdAdvantage: 0, aboveThresholdPenalty: 0, deathPenalty: 0,
        },
        outcome: { tag: 'Completed' }, teamBlueSpent: undefined, teamRedSpent: undefined, handicapApplied: undefined,
        tournamentId: o.tournamentId, bracketMatchId: undefined, voidedAt: undefined,
        winnerOverride: undefined, winnerOverrideById: undefined, winnerOverrideReason: undefined,
        matchType: { tag: o.rated ? 'Ranked' : 'Casual' }, winnerTeamSide: winner ? { tag: winner } : undefined,
        ...auditAt(playedAt),
    } as any);
    if (winner) {
        test.db.MatchResultGameHistory.insert({
            matchHistoryId: row.id, gameMode, teamBlueScreenshotUrl: undefined, teamRedScreenshotUrl: undefined,
            teamBlueCyclesUsed: undefined, teamRedCyclesUsed: undefined, teamBlueScore: undefined, teamRedScore: undefined,
            teamBlueDeaths: 0, teamRedDeaths: 0, teamBlueAdjustedResult: undefined, teamRedAdjustedResult: undefined,
            tieBreakLevel: undefined, winnerTeamSide: { tag: winner }, ...auditAt(playedAt),
        } as any);
    }
    for (const s of seats) {
        test.db.MatchParticipantHistory.insert({
            userId: s.who.userId, matchHistoryId: row.id, teamSide: { tag: s.side }, displayName: s.who.sub,
            isReferee: false, isCoach: s.isCoach ?? false, isCaptain: false, ...auditAt(playedAt),
        } as any);
        if (o.rated && !s.isCoach) {
            const delta = s.side === winner ? 16 : -16;
            test.db.MmrHistory.insert({
                id: 0, userId: s.who.userId, gameMode, matchHistoryId: row.id, previousRating: 1000, newRating: 1000 + delta,
                delta, seasonId: undefined, ...auditAt(playedAt),
            } as any);
        }
    }
    return row.id;
}

/** A pair of players and n archived 1v1 matches between them at the given minutes. */
function pair(test: Harness, tag: string) {
    return { me: guest(test, `${tag}-me`), opp: guest(test, `${tag}-opp`) };
}
const duelSeats = (me: Actor, opp: Actor): Seat[] => [{ who: me, side: 'Blue' }, { who: opp, side: 'Red' }];

// ════════════════════════════════════════════════════════════════════════════
// A115(1)(2): pages, order, filters, count
// ════════════════════════════════════════════════════════════════════════════

describe('A115(1): view_my_match_history pages 10 matches newest first by played-at', () => {
    it('25 matches: pages 0, 1, 2 return 10, 10, 5 with no overlap and no gap; page 3 is empty; the order follows played-at, not the ids (A115(1))', () => {
        const test = newHarness();
        const { me, opp } = pair(test, 'p');
        // Inserted out of time order: insert i is played at minute (i * 7) % 25 (a permutation of 0..24), so the
        // auto-increment ids and the times disagree.
        const byMinute = new Map<number, number>();
        for (let i = 0; i < 25; i++) {
            const minutes = (i * 7) % 25;
            byMinute.set(minutes, archive(test, duelSeats(me, opp), { minutes }));
        }
        const expected = [...byMinute.entries()].sort((a, b) => b[0] - a[0]).map(([, id]) => id);
        const byIdDesc = [...expected].sort((a, b) => b - a);
        expect(expected).not.toEqual(byIdDesc); // the test would not tell time order from id order otherwise

        const pages = [0, 1, 2, 3].map((p) => listPage(test, me, p));
        expect(pages.map((p) => p.length)).toEqual([10, 10, 5, 0]);
        const seen = pages.flatMap(idsOf);
        expect(new Set(seen).size).toBe(25); // no overlap
        expect(seen).toEqual(expected); // no gap, newest first by played-at
        for (const rows of pages) {
            for (let i = 1; i < rows.length; i++) {
                expect(rows[i - 1].playedAt.microsSinceUnixEpoch >= rows[i].playedAt.microsSinceUnixEpoch).toBe(true);
            }
        }
        expect(listPage(test, me, 1_000)).toEqual([]); // far past the end
        expect(countOf(test, me)).toEqual([{ total: 25 }]);
    });

    it('two matches played at the same time: the id only breaks the tie (A115(1), CLAUDE.md §3.4)', () => {
        const test = newHarness();
        const { me, opp } = pair(test, 't');
        const older = archive(test, duelSeats(me, opp), { minutes: 1 });
        const tieA = archive(test, duelSeats(me, opp), { minutes: 5 });
        const tieB = archive(test, duelSeats(me, opp), { minutes: 5 });
        expect(idsOf(listPage(test, me, 0))).toEqual([Math.max(tieA, tieB), Math.min(tieA, tieB), older]);
    });

    it('a new match appears first on page 0 and shifts the others one place towards the later pages (A115(1))', () => {
        const test = newHarness();
        const { me, opp } = pair(test, 'n');
        for (let m = 0; m < 11; m++) archive(test, duelSeats(me, opp), { minutes: m });
        const before = allPages(test, me).map(idsOf);
        expect(before.map((p) => p.length)).toEqual([10, 1]);
        const fresh = archive(test, duelSeats(me, opp), { minutes: 100 });
        const after = allPages(test, me).map(idsOf);
        expect(after.map((p) => p.length)).toEqual([10, 2]);
        expect(after[0][0]).toBe(fresh);
        expect(after.flat()).toEqual([fresh, ...before.flat()]);
        expect(countOf(test, me)).toEqual([{ total: 12 }]);
    });

    it('the list row carries the session fields and the caller\'s own side, result and rating change; no audit columns (A115(1))', () => {
        const test = newHarness();
        const { me, opp } = pair(test, 'r');
        const won = archive(test, duelSeats(me, opp), { minutes: 2, rated: true, winner: 'Blue', gameMode: 'ApocalypticShadow', draftMode: 'Auction' });
        const lost = archive(test, duelSeats(me, opp), { minutes: 1, winner: 'Red' });
        const [first, second] = listPage(test, me, 0);
        expect(first).toMatchObject({
            matchHistoryId: won, lobbyCode: 'HIST01', gameMode: { tag: 'ApocalypticShadow' }, draftMode: { tag: 'Auction' },
            matchType: { tag: 'Ranked' }, teamSide: { tag: 'Blue' }, winnerTeamSide: { tag: 'Blue' }, won: true,
            previousRating: 1000, newRating: 1016, ratingDelta: 16, isCoach: false, isReferee: false,
        });
        expect(second).toMatchObject({ matchHistoryId: lost, matchType: { tag: 'Casual' }, won: false });
        expect(second.ratingDelta).toBeUndefined();
        for (const k of ['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate']) expect(k in first, k).toBe(false);
        // The opponent's row of the same match is their own side.
        expect(listPage(test, opp, 0)[0]).toMatchObject({ matchHistoryId: won, teamSide: { tag: 'Red' }, won: false, ratingDelta: -16 });
    });

    it('an unmapped identity reads no list and no count row; a user without matches reads count 0 (A115(2))', () => {
        const test = newHarness();
        const lonely = guest(test, 'lonely');
        expect(listPage(test, ghost(), 0)).toEqual([]);
        expect(countOf(test, ghost())).toEqual([]);
        expect(listPage(test, lonely, 0)).toEqual([]);
        expect(countOf(test, lonely)).toEqual([{ total: 0 }]);
    });
});

describe('A115(1)(2): filters by game mode, draft mode and match type; the count agrees with the pages', () => {
    /** 24 matches covering every combination: game mode by i % 3, draft mode by (i >> 1) % 2, rated when i % 4 === 0. */
    function filterWorld() {
        const test = newHarness();
        const { me, opp } = pair(test, 'f');
        const modes = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'];
        const specs: Array<{ id: number; minutes: number; gameMode: string; draftMode: string; matchType: string }> = [];
        for (let i = 0; i < 24; i++) {
            const spec = { minutes: (i * 5) % 24, gameMode: modes[i % 3], draftMode: (i >> 1) % 2 ? 'Auction' : 'Classic', rated: i % 4 === 0 };
            const id = archive(test, duelSeats(me, opp), spec);
            specs.push({ id, minutes: spec.minutes, gameMode: spec.gameMode, draftMode: spec.draftMode, matchType: spec.rated ? 'Ranked' : 'Casual' });
        }
        return { test, me, specs };
    }

    const CASES: Filters[] = [
        { gameMode: 'MemoryOfChaos' }, { gameMode: 'AnomalyArbitration' },
        { draftMode: 'Auction' }, { draftMode: 'Classic' },
        { matchType: 'Ranked' }, { matchType: 'Casual' },
        { gameMode: 'ApocalypticShadow', draftMode: 'Classic' },
        { gameMode: 'MemoryOfChaos', matchType: 'Ranked' },
        { draftMode: 'Auction', matchType: 'Casual' },
        { gameMode: 'MemoryOfChaos', draftMode: 'Classic', matchType: 'Ranked' },
    ];

    it.each(CASES)('filter %o: the pages hold exactly the matching matches newest first, and the count equals their number (A115(1)(2))', (f) => {
        const { test, me, specs } = filterWorld();
        const expected = specs
            .filter((s) => (!f.gameMode || s.gameMode === f.gameMode) && (!f.draftMode || s.draftMode === f.draftMode) && (!f.matchType || s.matchType === f.matchType))
            .sort((a, b) => b.minutes - a.minutes || b.id - a.id)
            .map((s) => s.id);
        expect(expected.length).toBeGreaterThan(0);
        const pages = allPages(test, me, f);
        for (const p of pages.slice(0, -1)) expect(p).toHaveLength(10);
        expect(pages.flatMap(idsOf)).toEqual(expected);
        expect(countOf(test, me, f)).toEqual([{ total: expected.length }]);
        for (const r of pages.flat()) {
            if (f.gameMode) expect(r.gameMode.tag).toBe(f.gameMode);
            if (f.draftMode) expect(r.draftMode.tag).toBe(f.draftMode);
            if (f.matchType) expect(r.matchType.tag).toBe(f.matchType);
        }
    });

    it('no filter returns every match; an unknown tag matches nothing (A115(1)(2))', () => {
        const { test, me, specs } = filterWorld();
        expect(countOf(test, me)).toEqual([{ total: specs.length }]);
        expect(allPages(test, me).flat()).toHaveLength(specs.length);
        for (const f of [{ gameMode: 'Nope' }, { draftMode: 'Nope' }, { matchType: 'Tournament' }]) {
            expect(listPage(test, me, 0, f)).toEqual([]);
            expect(countOf(test, me, f)).toEqual([{ total: 0 }]);
        }
    });

    it('match type and winner are read from the stored columns: a later change to the tournament does not move the match (A115(1); review F2)', () => {
        const f = liveField(2);
        const test = f.test;
        const { me, opp } = pair(test, 'tm');
        const id = archive(test, duelSeats(me, opp), { minutes: 1, tournamentId: f.id }); // stored Casual, no rating rows
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(f.id)!, countTowardsMmr: true });
        expect(idsOf(listPage(test, me, 0, { matchType: 'Casual' }))).toEqual([id]);
        expect(countOf(test, me, { matchType: 'Ranked' })).toEqual([{ total: 0 }]);
        expect(listPage(test, me, 0)[0]).toMatchObject({ tournamentId: f.id, matchType: { tag: 'Casual' } });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A115(4): rating history pages
// ════════════════════════════════════════════════════════════════════════════

describe('A115(4): view_my_mmr_history pages 10 rating rows newest first', () => {
    it('13 rated matches inserted out of time order: pages 10, 3, 0 newest first; a game-mode filter narrows them; other users\' rows never appear (A115(4))', () => {
        const test = newHarness();
        const { me, opp } = pair(test, 'm');
        const minutesOf = new Map<number, number>();
        for (let i = 0; i < 13; i++) {
            const minutes = (i * 5) % 13;
            const id = archive(test, duelSeats(me, opp), { minutes, rated: true, gameMode: i % 2 ? 'ApocalypticShadow' : 'MemoryOfChaos' });
            minutesOf.set(id, minutes);
        }
        const mmr = (page: number, gameMode = '') => view(test, 'view_my_mmr_history', me, { page, gameMode });
        const pages = [0, 1, 2].map((p) => mmr(p));
        expect(pages.map((p) => p.length)).toEqual([10, 3, 0]);
        const rows = pages.flat();
        expect(new Set(rows.map((r) => r.matchHistoryId)).size).toBe(13);
        expect(rows.every((r) => r.userId === me.userId)).toBe(true);
        expect(rows.map((r) => minutesOf.get(r.matchHistoryId))).toEqual([...minutesOf.values()].sort((a, b) => b - a));
        const shadow = [mmr(0, 'ApocalypticShadow'), mmr(1, 'ApocalypticShadow')].flat();
        expect(shadow).toHaveLength(6);
        expect(shadow.every((r) => r.gameMode.tag === 'ApocalypticShadow')).toBe(true);
        expect(view(test, 'view_my_mmr_history', ghost(), { page: 0, gameMode: '' })).toEqual([]);
        expect(view(test, 'view_my_mmr_history', guest(test, 'm-out'), { page: 0, gameMode: '' })).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A115(3): per-match detail views over real finalized games
// ════════════════════════════════════════════════════════════════════════════

const DETAIL_VIEWS = [
    'view_my_match_history_participants', 'view_my_match_history_steps',
    'view_my_match_history_games', 'view_my_match_history_lineups',
] as const;

const seatsOf = (p: string): Array<[string, SlotTag]> =>
    [[`${p}b1`, 'BluePlayer'], [`${p}b2`, 'BluePlayer'], [`${p}r1`, 'RedPlayer'], [`${p}r2`, 'RedPlayer']];

/** A finished casual match with prefixed actors (the s10-history-views pattern), plus extra seats if given. */
function played(test: Harness, p: string, opts: ScoringLobbyOpts & { extra?: Array<[string, SlotTag]> } = {}): Lobby {
    const s = playToScoring(test, {
        seats: [...seatsOf(p), ...(opts.extra ?? [])],
        actors: { host: guest(test, `${p}host`) },
        blue: blueNames().map((n) => `${p}${n}`),
        red: redNames().map((n) => `${p}${n}`),
        ...opts,
    });
    finishGame(s, 'Blue');
    expect(test.db.Lobby.id.find(s.lobbyId)).toBeNull(); // casual: finalized at the close
    return s;
}
const matchOf = (test: Harness, who: Actor) => [...test.db.MatchParticipantHistory.by_user.filter(who.userId)][0].matchHistoryId;

describe('A115(3): the detail of one match goes to its participants only', () => {
    it.each(DETAIL_VIEWS)('%s: a participant reads the match rows; an outsider, a player of another match, a spectator-only user and an unmapped identity read none (A115(3))', (name) => {
        const test = newHarness();
        const a = played(test, 'A', { extra: [['Aspec', 'Spectator']] });
        const b = played(test, 'B');
        const aId = matchOf(test, a.a.Ab1);
        const args = { matchHistoryId: aId };
        for (const who of [a.a.Ab1, a.a.Ar2]) {
            const rows = view(test, name, who, args);
            expect(rows.length, who.sub).toBeGreaterThan(0);
            for (const r of rows) expect(r.matchHistoryId).toBe(aId);
        }
        expect(view(test, name, guest(test, 'outsider'), args)).toEqual([]);
        expect(view(test, name, b.a.Bb1, args)).toEqual([]);
        expect(view(test, name, a.a.Aspec, args)).toEqual([]); // watched the match, did not play in it
        expect(view(test, name, a.host, args)).toEqual([]);    // the spectator referee host did not play either
        expect(view(test, name, ghost(), args)).toEqual([]);
        expect(view(test, name, a.a.Ab1, { matchHistoryId: 999_999 })).toEqual([]); // an unknown match
        // B's own player reads B's rows, never A's.
        const bRows = view(test, name, b.a.Bb1, { matchHistoryId: matchOf(test, b.a.Bb1) });
        expect(bRows.length).toBeGreaterThan(0);
        expect(bRows.every((r) => r.matchHistoryId !== aId)).toBe(true);
    });

    it('the detail rows keep today\'s shapes: every participant of the match, steps in sequence, one game, one lineup per team (A115(3))', () => {
        const test = newHarness();
        const a = played(test, 'S');
        const args = { matchHistoryId: matchOf(test, a.a.Sb1) };
        const participants = view(test, 'view_my_match_history_participants', a.a.Sb1, args);
        expect(participants.map((p) => p.userId).sort()).toEqual([a.a.Sb1, a.a.Sb2, a.a.Sr1, a.a.Sr2].map((p) => p.userId).sort());
        const steps = view(test, 'view_my_match_history_steps', a.a.Sb1, args);
        expect(steps.map((r) => r.sequence)).toEqual([...steps.map((r) => r.sequence)].sort((x, y) => x - y));
        expect(steps).toHaveLength([...test.db.MatchSessionStepHistory.by_match_history.filter(args.matchHistoryId)].length);
        expect(view(test, 'view_my_match_history_games', a.a.Sb1, args)).toHaveLength(1);
        expect(view(test, 'view_my_match_history_lineups', a.a.Sb1, args).map((r) => r.teamSide.tag).sort()).toEqual(['Blue', 'Red']);
        expect(view(test, 'view_my_match_history_count', a.a.Sb1, ANY)).toEqual([{ total: 1 }]);
    });

    it('an anonymous match keeps the history rule: its participants read the real identities in the list and the detail, with no label column (A115(3), A37)', () => {
        const test = newHarness();
        const s = played(test, 'N', { lobby: { isAnonymousPlayers: true } });
        const args = { matchHistoryId: matchOf(test, s.a.Nr1) };
        const nameOf = (who: Actor) => test.db.User.id.find(who.userId)!.displayName;
        const [row] = listPage(test, s.a.Nr1, 0);
        expect(row).toMatchObject({ matchHistoryId: args.matchHistoryId, displayName: nameOf(s.a.Nr1), teamSide: { tag: 'Red' }, won: false });
        const participants = view(test, 'view_my_match_history_participants', s.a.Nr1, args);
        for (const who of [s.a.Nb1, s.a.Nb2]) {
            expect(participants.find((p) => p.userId === who.userId)?.displayName).toBe(nameOf(who)); // the opponents, by name
        }
        const steps = view(test, 'view_my_match_history_steps', s.a.Nr1, args);
        expect(steps.some((r) => r.actorUserId === s.a.Nb1.userId || r.actorUserId === s.a.Nb2.userId)).toBe(true);
        expect(steps.every((r) => r.actorUserId !== 0)).toBe(true);
        for (const r of [row, ...participants, ...steps]) expect('anonymousLabel' in r).toBe(false);
    });

    it('a match whose opponent deleted their account still lists, and its detail still reads (A115(1)(3))', () => {
        const test = newHarness();
        const s = played(test, 'D');
        const id = matchOf(test, s.a.Db1);
        const opponent = s.a.Dr1;
        const nameBefore = view(test, 'view_my_match_history_participants', s.a.Db1, { matchHistoryId: id }).find((p) => p.userId === opponent.userId)!.displayName;
        const username = test.db.User.id.find(opponent.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(test.db.User.id.find(opponent.userId)).toBeNull();
        expect(idsOf(listPage(test, s.a.Db1, 0))).toEqual([id]);
        expect(countOf(test, s.a.Db1)).toEqual([{ total: 1 }]);
        const participants = view(test, 'view_my_match_history_participants', s.a.Db1, { matchHistoryId: id });
        expect(participants.find((p) => p.userId === opponent.userId)?.displayName).toBe(nameBefore);
        expect(view(test, 'view_my_match_history_steps', s.a.Db1, { matchHistoryId: id }).length).toBeGreaterThan(0);
    });

    it('the five unbounded history views are gone (A115(4))', () => {
        for (const name of [
            'view_my_match_participant_history', 'view_my_match_session_history', 'view_my_match_session_step_history',
            'view_my_match_result_game_history', 'view_my_match_lineup_history',
        ]) {
            expect(name in M, name).toBe(false);
        }
        expectTypeOf<typeof M>().not.toHaveProperty('view_my_match_session_history');
        expectTypeOf<typeof M>().not.toHaveProperty('view_my_match_lineup_history');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A115(1), review F1 / F2 / F9: the stored match type and winner, through the real reducers and finalization
// ════════════════════════════════════════════════════════════════════════════

/** The caller's list row of their only match. */
const onlyRow = (test: Harness, who: Actor) => {
    const rows = listPage(test, who, 0);
    expect(rows, who.sub).toHaveLength(1);
    return rows[0];
};
/** The match history row of the caller's only match. */
const sessionOf = (test: Harness, who: Actor) => test.db.MatchSessionHistory.id.find(matchOf(test, who))!;
const gameHistoryOf = (test: Harness, matchHistoryId: number) => [...test.db.MatchResultGameHistory.by_match_history.filter(matchHistoryId)];

/**
 * The winner's and the loser's rows of a finalized Ranked standalone match: stored Ranked and the stored winner; the
 * winner reads won true and a positive rating change, the loser won false and a negative one.
 */
function expectRankedResult(test: Harness, winners: Actor[], losers: Actor[], winner: 'Blue' | 'Red', outcome: string) {
    const session = sessionOf(test, winners[0]);
    expect(session.matchType.tag).toBe('Ranked');
    expect(session.winnerTeamSide?.tag).toBe(winner);
    expect(session.outcome.tag).toBe(outcome);
    for (const who of winners) {
        const r = onlyRow(test, who);
        expect(r, who.sub).toMatchObject({ matchType: { tag: 'Ranked' }, winnerTeamSide: { tag: winner }, teamSide: { tag: winner }, won: true, outcome: { tag: outcome } });
        expect(r.ratingDelta, who.sub).toBeGreaterThan(0);
    }
    for (const who of losers) {
        const r = onlyRow(test, who);
        expect(r, who.sub).toMatchObject({ matchType: { tag: 'Ranked' }, winnerTeamSide: { tag: winner }, won: false });
        expect(r.ratingDelta, who.sub).toBeLessThan(0);
    }
    for (const who of [...winners, ...losers]) {
        expect(countOf(test, who, { matchType: 'Ranked' })).toEqual([{ total: 1 }]);
        expect(countOf(test, who, { matchType: 'Casual' })).toEqual([{ total: 0 }]);
    }
}

/** A standalone Ranked lobby (EloConfig seeded, accounts selected) played to Scoring; the host is the Spectator referee. */
function rankedScoring(test: Harness): Lobby {
    seedElo(test);
    return playToScoring(test, { beforeStart: rankedHook(test) });
}

describe('A115(1), review F1: a conceded or forfeited Ranked match lists the record\'s winner', () => {
    it('conceded in Scoring after the first score (game row winner Spectator): the winner reads won true, the stored winner and a positive rating change; the loser won false (A115(1); review F1)', () => {
        const test = newHarness();
        const s = rankedScoring(test);
        recordScores(s, s.host, 'Blue', [H(10), H(10)]); // the first score creates the game row, no winner yet
        const recId = record(test, s.lobbyId).id;
        expect(gameRow(test, recId).winnerTeamSide.tag).toBe('Spectator');
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 })); // Red concedes
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeNull(); // standalone concede: finalized inline
        expect(gameHistoryOf(test, matchOf(test, s.a.b1)).map((g) => g.winnerTeamSide.tag)).toEqual(['Spectator']); // the game row disagrees
        expectRankedResult(test, [s.a.b1, s.a.b2], [s.a.r1, s.a.r2], 'Blue', 'Concede');
    });

    it('both sides scored (computed winner Blue), then Blue concedes: Red reads won true, Blue won false (A115(1); review F1)', () => {
        const test = newHarness();
        const s = rankedScoring(test);
        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]);
        expect(gameRow(test, record(test, s.lobbyId).id).winnerTeamSide.tag).toBe('Blue');
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 1 })); // Blue concedes
        expect(gameHistoryOf(test, matchOf(test, s.a.r1)).map((g) => g.winnerTeamSide.tag)).toEqual(['Blue']);
        expectRankedResult(test, [s.a.r1, s.a.r2], [s.a.b1, s.a.b2], 'Red', 'Concede');
    });

    it('conceded in Drafting (no game row): the list still names the winner (A115(1); review F1)', () => {
        const test = newHarness();
        seedElo(test);
        const s = setupLobby(test, { beforeStart: rankedHook(test) });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        expect(gameHistoryOf(test, matchOf(test, s.a.b1))).toEqual([]);
        expectRankedResult(test, [s.a.b1, s.a.b2], [s.a.r1, s.a.r2], 'Blue', 'Concede');
    });

    it('a claimed forfeit (Red offline past the grace): Blue reads won true, Red won false (A115(1); review F1)', () => {
        const test = newHarness();
        seedElo(test);
        const s = setupLobby(test, { beforeStart: rankedHook(test) });
        disconnect(test, s.a.r1);
        disconnect(test, s.a.r2);
        advance(test, 61_000);
        tx(test, s.host, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 2 }));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeNull();
        expectRankedResult(test, [s.a.b1, s.a.b2], [s.a.r1, s.a.r2], 'Blue', 'Concede');
    });
});

describe('A115(1), review F1 / F9: a staff decision that flips the computed winner lists the staff winner', () => {
    it.each(['override_match_result', 'admin_force_finalize'] as const)('%s: game computed Blue, staff gives Red; Red reads won true and a positive rating change (A115(1); review F1 / F9)', (path) => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Blue');
        expect(gameRow(test, recId).winnerTeamSide.tag).toBe('Blue');
        if (path === 'override_match_result') {
            validateAndFinalize(test, s, recId, mod, 'Red');
        } else {
            tx(test, 'internal', (ctx) => M.admin_force_finalize(ctx, { lobbyId: s.lobbyId, winnerTeamId: 2 }));
        }
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeNull();
        expect(gameHistoryOf(test, matchOf(test, s.a.r1)).map((g) => g.winnerTeamSide.tag)).toEqual(['Blue']);
        expectRankedResult(test, [s.a.r1, s.a.r2], [s.a.b1, s.a.b2], 'Red', 'Completed');
    });
});

describe('A115(1), review F2: the stored match type of casual and tournament matches', () => {
    it('a casual standalone game: stored Casual and the winner; no rating change (A115(1); review F2)', () => {
        const test = newHarness();
        const s = played(test, 'C'); // Blue wins
        expect(sessionOf(test, s.a.Cb1)).toMatchObject({ matchType: { tag: 'Casual' }, winnerTeamSide: { tag: 'Blue' } });
        expect(onlyRow(test, s.a.Cb1)).toMatchObject({ matchType: { tag: 'Casual' }, winnerTeamSide: { tag: 'Blue' }, won: true });
        expect(onlyRow(test, s.a.Cr1)).toMatchObject({ matchType: { tag: 'Casual' }, winnerTeamSide: { tag: 'Blue' }, won: false });
        expect(onlyRow(test, s.a.Cb1).ratingDelta).toBeUndefined();
        expect(countOf(test, s.a.Cb1, { matchType: 'Casual' })).toEqual([{ total: 1 }]);
        expect(countOf(test, s.a.Cb1, { matchType: 'Ranked' })).toEqual([{ total: 0 }]);
    });

    it.each([[true, 'Ranked'], [false, 'Casual']] as const)('a tournament game (countTowardsMmr %s): stored %s, the filter and the count agree (A115(1), D-67; review F2)', (countTowardsMmr, type) => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1, countTowardsMmr });
        seedElo(f.test);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Red');
        if (recordsOfLobby(f.test, s.lobbyId)[0].status.tag !== 'Validated') validate(f.test, f.org, s.lobbyId);
        advanceStage(f.test, f.org, f.id, 'Completed');
        drain(f.test, f.id);
        const id = matchOf(f.test, s.a.r1);
        expect(f.test.db.MatchSessionHistory.id.find(id)).toMatchObject({ tournamentId: f.id, matchType: { tag: type }, winnerTeamSide: { tag: 'Red' } });
        const other = type === 'Ranked' ? 'Casual' : 'Ranked';
        for (const who of [s.a.b1, s.a.r1]) {
            expect(idsOf(listPage(f.test, who, 0, { matchType: type }))).toEqual([id]);
            expect(countOf(f.test, who, { matchType: type })).toEqual([{ total: 1 }]);
            expect(listPage(f.test, who, 0, { matchType: other })).toEqual([]);
            expect(countOf(f.test, who, { matchType: other })).toEqual([{ total: 0 }]);
        }
        const red = onlyRow(f.test, s.a.r1);
        expect(red).toMatchObject({ matchType: { tag: type }, winnerTeamSide: { tag: 'Red' }, won: true, tournamentId: f.id });
        expect(onlyRow(f.test, s.a.b1)).toMatchObject({ won: false });
        if (countTowardsMmr) expect(red.ratingDelta).toBeGreaterThan(0);
        else expect(red.ratingDelta).toBeUndefined();
    });
});

describe('A115(1), review F1 / F9: a match without a winner; coaches', () => {
    it('a tournament match cancelled mid-draft has no winner: no history row, nothing listed (A115(1), A31; review F1)', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id); // Drafting, Pending record without a winner
        expect(recordsOfLobby(f.test, s.lobbyId)[0].winnerTeamSide).toBeUndefined();
        advanceStage(f.test, f.org, f.id, 'Cancelled');
        drain(f.test, f.id);
        for (const who of [s.a.b1, s.a.r1]) {
            expect(listPage(f.test, who, 0)).toEqual([]);
            expect(countOf(f.test, who)).toEqual([{ total: 0 }]);
        }
        expect([...f.test.db.MatchSessionHistory.iter()]).toEqual([]);
    });

    it('a stored history row without a winner lists winnerTeamSide and won as absent, for both sides (A115(1); review F1)', () => {
        // Finalization refuses a record without a winner (A31), so no reducer writes this row; the direct insert pins
        // the view's rule for the optional column.
        const test = newHarness();
        const { me, opp } = pair(test, 'nw');
        archive(test, duelSeats(me, opp), { minutes: 1, winner: null });
        for (const who of [me, opp]) {
            const r = onlyRow(test, who);
            expect(r.winnerTeamSide).toBeUndefined();
            expect(r.won).toBeUndefined();
        }
    });

    it('a coach of a played match gets no participant row from finalization and reads no history (A115(1)(3); review F9)', () => {
        // Finalization writes MatchParticipantHistory for the record's participants (players only) or, on a concede
        // without them, for the non-coach lobby members: a coach row never exists, so a coach lists nothing.
        const test = newHarness();
        const s = played(test, 'K', { extra: [['Kcoach', 'BlueCoach']] });
        const coach = s.a.Kcoach;
        expect([...test.db.MatchParticipantHistory.by_user.filter(coach.userId)]).toEqual([]);
        expect(listPage(test, coach, 0)).toEqual([]);
        expect(countOf(test, coach)).toEqual([{ total: 0 }]);
        const args = { matchHistoryId: matchOf(test, s.a.Kb1) };
        for (const name of DETAIL_VIEWS) expect(view(test, name, coach, args)).toEqual([]);
    });
});
