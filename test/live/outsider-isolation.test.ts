/**
 * Live residue (T-S10 placeholder, written at T-S11a for triage L110): outsider isolation over a real subscription
 * (ACCESS-SECURITY-OPS §D.5: subscription isolation is live-only; the in-memory suites check the view bodies, not what
 * the wire delivers). Helpers: test/live/_helpers.ts.
 *
 * One scenario feeds every check (the flow was rehearsed in memory against the current module before it was written):
 *   - A and B (verified, one HSR account each) play a Ranked 1v1 lobby with isAnonymousPlayers and
 *     isAnonymousSpectators on; C (verified) watches as a Spectator. A hosts and sits Blue, B sits Red.
 *     A selects its account (B's is auto-selected on join), start_draft → Drafting.
 *   - O is an outsider (a guest in no lobby); U is an unmapped identity (connected, never called login_as_guest).
 *   - Live-match checks run in Drafting. Then B concedes (Ranked, non-tournament: finalized at once, the match archived
 *     with its participants and A's and B's MmrHistory rows; the lobby is deleted), and the history checks read the
 *     archived match by its id.
 *
 * S10n (A115): views with arguments are not delivered by subscribeToAllTables (the SDK skips them), so each one is
 * subscribed by name with its argument literals (`SELECT * FROM view_my_match_history(0, '', '', '')`), one argument
 * set per view at a time, and unsubscribed after the read. Each outsider check first proves the rows exist (the
 * player sees them), so an empty outsider cache is not vacuous; where the player's own cache is empty too (no draft
 * step, no game, no lineup in a match conceded at the start of the draft) the check still runs and says so in its title.
 *
 * Maincloud calls (one run): 5 connections (+3 short delegate connections for server_link_provider); about 19 reducer
 * calls (4 login_as_guest, 3 server_link_provider, 2 create_hsr_account, create_lobby, 2 set_team_slot, 2 confirm_ready,
 * 2 join_lobby, select_match_account, start_draft, concede_match); about 30 subscribe calls, the largest being U's one
 * call over the 38 per-sender views without arguments (0 rows expected). No reference table is subscribed.
 *
 * Estimated runtime: ~60 s.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbConnection } from '@bindings/index';
import { hasServerToken } from '../shared/connection';
import {
    type LiveConn,
    type LiveUser,
    LOBBY_QUERIES,
    closeAll,
    connectGuest,
    connectVerified,
    lobbyMembers,
    openConnection,
    setupOneVsOne,
    subscribe,
    waitFor,
} from './_helpers';

/** The live-match views (CLAUDE.md §4: subscribed only past Waiting). */
const MATCH_VIEWS = [
    'view_my_match_session',
    'view_my_match_steps',
    'view_my_match_participants',
    'view_my_match_result',
    'view_my_match_result_games',
] as const;

/** Every per-sender view without arguments (web/src/module_bindings/index.ts, `view_my_*`, S11a). */
const PER_SENDER_VIEWS = [
    'view_my_availability', 'view_my_calendar_events', 'view_my_calendar_invites', 'view_my_character_stats',
    'view_my_cost_sets', 'view_my_draft_character_costs', 'view_my_draft_lightcone_costs', 'view_my_draft_synergy_costs',
    'view_my_identity', 'view_my_lineups', 'view_my_lobbies', 'view_my_lobby', 'view_my_lobby_bans', 'view_my_lobby_chat',
    'view_my_lobby_members', 'view_my_match_participants', 'view_my_match_result', 'view_my_match_result_games',
    'view_my_match_session', 'view_my_match_steps', 'view_my_mmr_ratings', 'view_my_player_stats', 'view_my_profile',
    'view_my_relationships', 'view_my_roster', 'view_my_roster_visibility', 'view_my_saved_calendars', 'view_my_stand_ins',
    'view_my_team_requests', 'view_my_tournament_enrolled', 'view_my_tournament_enrollment', 'view_my_tournament_lobbies',
    'view_my_tournament_match_results', 'view_my_tournament_matches', 'view_my_tournament_stand_ins',
    'view_my_tournament_team_members', 'view_my_tournament_teams', 'view_my_tournaments',
] as const;

/** The per-match history views, all with the argument `matchHistoryId` (A115(3)). */
const HISTORY_DETAIL_VIEWS = [
    'view_my_match_history_participants',
    'view_my_match_history_steps',
    'view_my_match_history_games',
    'view_my_match_history_lineups',
] as const;

const historyListQuery = () => `SELECT * FROM view_my_match_history(0, '', '', '')`;
const historyCountQuery = () => `SELECT * FROM view_my_match_history_count('', '', '')`;
const mmrHistoryQuery = () => `SELECT * FROM view_my_mmr_history(0, '')`;
const detailQuery = (view: string, matchHistoryId: number) => `SELECT * FROM ${view}(${matchHistoryId})`;

/** `view_my_match_session` → `viewMyMatchSession` (the generated camelCase accessor). */
const accessorOf = (view: string) => view.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());

/** Rows of a view in a connection's client cache, by view name. */
function cached(conn: DbConnection, view: string): unknown[] {
    const table = (conn.db as unknown as Record<string, { iter(): Iterable<unknown> } | undefined>)[accessorOf(view)];
    if (!table) throw new Error(`no client table for ${view}`);
    return [...table.iter()];
}

/** Subscribes one query, returns the cached rows of `view`, unsubscribes (one argument set per view at a time). */
async function readOnce(conn: DbConnection, view: string, query: string): Promise<unknown[]> {
    const handle = await subscribe(conn, [query]);
    try {
        return cached(conn, view);
    } finally {
        handle.unsubscribe();
    }
}

/** A random 9-digit UID with a valid region digit (validateUid: /^\d{9}$/, first digit 6-9). */
const randomUid = () => `6${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

describe.skipIf(!hasServerToken())('Outsider isolation over the wire (§D.5, triage L110)', () => {
    const open: Array<LiveConn | LiveUser> = [];
    let A: LiveUser; // host, Blue player
    let B: LiveUser; // Red player
    let C: LiveUser; // spectator
    let O: LiveUser; // outsider: a guest in no lobby
    let U: LiveConn; // unmapped identity: connected, never logged in
    let lobbyId: number;
    let hostSeat: number;
    let conceded: Promise<number> | undefined;

    beforeAll(async () => {
        [A, B, C, O, U] = await Promise.all([
            connectVerified([...LOBBY_QUERIES, 'SELECT * FROM view_my_roster']),
            connectVerified([...LOBBY_QUERIES, 'SELECT * FROM view_my_roster']),
            connectVerified(LOBBY_QUERIES),
            connectGuest(),
            openConnection(),
        ]);
        open.push(A, B, C, O, U);

        // One HSR account each: Ranked needs a selected account per player (D-08); B's first account is active, so
        // join_lobby selects it; A created the lobby, so A selects its own.
        await A.conn.reducers.createHsrAccount({ uid: randomUid(), displayLabel: '' });
        await B.conn.reducers.createHsrAccount({ uid: randomUid(), displayLabel: '' });
        const accountA = (await waitFor(() => [...A.conn.db.viewMyRoster.iter()][0], 'A sees its HSR account')).accountId;
        await waitFor(() => [...B.conn.db.viewMyRoster.iter()][0], 'B sees its HSR account');

        lobbyId = await setupOneVsOne(A.conn, B.conn, {
            start: false,
            lobby: { matchType: { tag: 'Ranked' }, isAnonymousPlayers: true, isAnonymousSpectators: true },
        });
        await C.conn.reducers.joinLobby({ lobbyId, joinCode: '', password: '' }); // joins as a Spectator
        await A.conn.reducers.selectMatchAccount({ lobbyId, hsrAccountId: accountA });
        await A.conn.reducers.startDraft({ lobbyId });
        await waitFor(
            () => [...A.conn.db.viewMyLobby.iter()].find((l) => l.id === lobbyId && l.stage.tag === 'Drafting'),
            'A sees the lobby in Drafting',
        );
        hostSeat = await waitFor(
            () => lobbyMembers(A.conn, lobbyId).find((m) => m.userId === A.userId)?.joinSeq,
            'A sees its own seat',
        );
        await subscribe(A.conn, MATCH_VIEWS.map((v) => `SELECT * FROM ${v}`));
        await subscribe(B.conn, ['SELECT * FROM view_my_match_participants']);
    }, 120_000);

    afterAll(() => closeAll(open));

    /** B concedes once (Ranked, non-tournament: finalized and archived at once); resolves with the archived match id. */
    function concede(): Promise<number> {
        conceded ??= (async () => {
            await B.conn.reducers.concedeMatch({ lobbyId, losingTeamSide: 0 });
            const handle = await subscribe(A.conn, [historyListQuery()]);
            const row = await waitFor(
                () => [...A.conn.db.viewMyMatchHistory.iter()][0],
                'A sees the archived match in view_my_match_history',
            );
            handle.unsubscribe();
            return row.matchHistoryId;
        })();
        return conceded;
    }

    it('view_my_lobby_members: a user outside the lobby receives none of its member rows', async () => {
        expect(lobbyMembers(A.conn, lobbyId), 'A sees the three seats').toHaveLength(3);
        const rows = await readOnce(O.conn, 'view_my_lobby_members', 'SELECT * FROM view_my_lobby_members');
        expect(rows, 'O receives no member row').toHaveLength(0);
    }, 30_000);

    it('view_my_match_* (session, steps, participants, result, result games): a user outside the match receives nothing', async () => {
        // The player's own cache proves the rows exist (steps and result games are empty this early in the draft).
        expect(cached(A.conn, 'view_my_match_session'), 'A sees the session').toHaveLength(1);
        expect(cached(A.conn, 'view_my_match_participants'), 'A sees both players').toHaveLength(2);
        expect(cached(A.conn, 'view_my_match_result'), 'A sees the Pending result').toHaveLength(1);
        const handle = await subscribe(O.conn, MATCH_VIEWS.map((v) => `SELECT * FROM ${v}`));
        for (const view of MATCH_VIEWS) {
            expect(cached(O.conn, view), `O receives nothing from ${view}`).toHaveLength(0);
        }
        handle.unsubscribe();
    }, 30_000);

    it('anonymized seats (isAnonymousPlayers / isAnonymousSpectators) carry userId 0 on the wire, not only in the view body (A37)', async () => {
        // B (Red player) sees the opposing player A and the spectator C as seats with userId 0, and itself by id.
        const seen = await waitFor(
            () => (lobbyMembers(B.conn, lobbyId).length === 3 ? lobbyMembers(B.conn, lobbyId) : undefined),
            'B sees the three seats',
        );
        const bySeat = new Map(seen.map((m) => [m.joinSeq, m]));
        const hostRow = bySeat.get(hostSeat)!;
        expect(hostRow.userId, 'A (opposing player) is userId 0 for B').toBe(0);
        expect(hostRow.label, 'A is shown by its seat label, not its name').not.toBe(A.username);
        const spectatorRow = seen.find((m) => m.lobbySlot.tag === 'Spectator')!;
        expect(spectatorRow.userId, 'C (spectator) is userId 0 for B').toBe(0);
        expect(spectatorRow.label).not.toBe(C.username);
        expect(seen.find((m) => m.userId === B.userId), 'B sees itself by id').toBeDefined();
        expect(seen.some((m) => m.userId === A.userId || m.userId === C.userId), 'no real id of A or C reaches B').toBe(false);

        // view_my_lobby masks the host id for B; view_my_match_participants masks A's id.
        expect([...B.conn.db.viewMyLobby.iter()].find((l) => l.id === lobbyId)?.hostUserId, 'hostUserId is 0 for B').toBe(0);
        const participants = await waitFor(
            () => ([...B.conn.db.viewMyMatchParticipants.iter()].length === 2 ? [...B.conn.db.viewMyMatchParticipants.iter()] : undefined),
            'B sees both match participants',
        );
        expect(participants.find((p) => p.teamSide.tag === 'Blue')?.userId, 'A as a match participant is userId 0 for B').toBe(0);

        // C (spectator, not the referee) sees both players as userId 0 (isAnonymousPlayers).
        const fromC = await waitFor(
            () => (lobbyMembers(C.conn, lobbyId).length === 3 ? lobbyMembers(C.conn, lobbyId) : undefined),
            'C sees the three seats',
        );
        expect(fromC.filter((m) => m.lobbySlot.tag !== 'Spectator').map((m) => m.userId), 'both players are userId 0 for C').toEqual([0, 0]);
    }, 30_000);

    it('an unmapped identity (connected, no login_as_guest) receives nothing from any per-sender view, live match included', async () => {
        const handle = await subscribe(U.conn, PER_SENDER_VIEWS.map((v) => `SELECT * FROM ${v}`), 45_000);
        for (const view of PER_SENDER_VIEWS) {
            expect(cached(U.conn, view), `U receives nothing from ${view}`).toHaveLength(0);
        }
        handle.unsubscribe();
    }, 60_000);

    it('view_my_match_history(page, filters) / view_my_match_history_count(filters): an outsider receives none of another user\'s matches', async () => {
        await concede();
        expect(await readOnce(O.conn, 'view_my_match_history', historyListQuery()), 'O receives no history row').toHaveLength(0);
        const count = (await readOnce(O.conn, 'view_my_match_history_count', historyCountQuery())) as Array<{ total: number }>;
        expect(count.map((r) => r.total), 'O (a mapped guest) gets one count row, total 0').toEqual([0]);
        // The player's count proves the match is there.
        const own = (await readOnce(A.conn, 'view_my_match_history_count', historyCountQuery())) as Array<{ total: number }>;
        expect(own[0]?.total, 'A counts its match').toBeGreaterThanOrEqual(1);
    }, 60_000);

    it('view_my_match_history_participants(matchHistoryId): an outsider receives none of that match\'s rows', async () => {
        const id = await concede();
        const query = detailQuery('view_my_match_history_participants', id);
        expect(await readOnce(A.conn, 'view_my_match_history_participants', query), 'A sees both participants').toHaveLength(2);
        expect(await readOnce(O.conn, 'view_my_match_history_participants', query), 'O receives none').toHaveLength(0);
    }, 60_000);

    it('view_my_match_history_steps(matchHistoryId): an outsider receives none of that match\'s rows (conceded before any step: the player has none either)', async () => {
        const id = await concede();
        const query = detailQuery('view_my_match_history_steps', id);
        const own = await readOnce(A.conn, 'view_my_match_history_steps', query);
        console.info(`[outsider-isolation] A's view_my_match_history_steps(${id}): ${own.length} rows`);
        expect(await readOnce(O.conn, 'view_my_match_history_steps', query), 'O receives none').toHaveLength(0);
    }, 60_000);

    it('view_my_match_history_games(matchHistoryId) / view_my_match_history_lineups(matchHistoryId): an outsider receives none of that match\'s rows (no game or lineup in a draft-stage concede)', async () => {
        const id = await concede();
        for (const view of ['view_my_match_history_games', 'view_my_match_history_lineups'] as const) {
            const own = await readOnce(A.conn, view, detailQuery(view, id));
            console.info(`[outsider-isolation] A's ${view}(${id}): ${own.length} rows`);
            expect(await readOnce(O.conn, view, detailQuery(view, id)), `O receives nothing from ${view}`).toHaveLength(0);
        }
    }, 60_000);

    it('view_my_mmr_history(page, gameMode): an outsider subscribed over a real connection receives none of another user\'s rows', async () => {
        await concede();
        expect(await readOnce(A.conn, 'view_my_mmr_history', mmrHistoryQuery()), 'A has its rating row for the match').not.toHaveLength(0);
        expect(await readOnce(O.conn, 'view_my_mmr_history', mmrHistoryQuery()), 'O receives none').toHaveLength(0);
    }, 60_000);

    it('an unmapped identity receives nothing from the history views with arguments either', async () => {
        const id = await concede();
        expect(await readOnce(U.conn, 'view_my_match_history', historyListQuery())).toHaveLength(0);
        expect(await readOnce(U.conn, 'view_my_match_history_count', historyCountQuery()), 'no count row for an unmapped identity').toHaveLength(0);
        expect(await readOnce(U.conn, 'view_my_mmr_history', mmrHistoryQuery())).toHaveLength(0);
        for (const view of HISTORY_DETAIL_VIEWS) {
            expect(await readOnce(U.conn, view, detailQuery(view, id)), `U receives nothing from ${view}`).toHaveLength(0);
        }
    }, 60_000);
});
