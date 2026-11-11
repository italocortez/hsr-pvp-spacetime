// Views: the live match views, the replay set, stuck games, the tournament views and their egress.
// Decisions: A37, A83, D-22
// Contracts: docs/views/contract.md
// From S9a, S10c (s9a-views.test.ts, s10c-high-fixes.test.ts).
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
    AdjustmentItem,
    AnonymousChatRow,
    AnonymousMatchParticipantRow,
    AnonymousMatchStepRow,
    GroupScoreItem,
    Lobby as LobbyBinding,
    LobbyBanViewRow,
    LobbyBrowserRow,
    LobbyMemberViewRow,
    MatchForMeRow,
    MatchLineupViewRow,
    MatchResultGameViewRow,
    MatchResultRecord as MatchResultRecordBinding,
    MatchResultViewRow,
    MatchSessionViewRow,
    MyLobbyListRow,
    StandInViewRow,
    StuckGameRow,
    TeamRequestViewRow,
    TournamentLobbyRow,
    TournamentParticipantRow,
    TournamentRegistrantAccountRow,
    TournamentStaffRow,
    TournamentTeamMemberPublicRow,
    TournamentTeamPublicRow,
} from '@bindings/types';
import type { tables as bindingTables } from '@bindings/index';
import {
    M,
    advance,
    guest,
    joinAsSpectator,
    lobbyRow,
    newHarness,
    tx,
    type Actor,
    type Harness,
} from '../fixtures/harness';
import { host as tournamentHost, moderator, verified, displayName } from '../fixtures/identity';
import { insertHsrAccount } from '../fixtures/roster';
import {
    H,
    captain,
    closeGame,
    confirmBoth,
    confirmGame,
    finishGame,
    recordScores,
    setRole,
    side,
    recordOf,
} from '../fixtures/draft-and-scoring';
import {
    AUDIT_KEYS,
    COLS,
    expectOnlyColumns,
    ghost,
    keysOf,
    lobbyOf,
    makeRanked,
    onlyMatchOf,
    scoringOf,
    shared,
    view,
    type Reader,
    type Cols,
} from '../fixtures/views';
import {
    assignAssistant,
    liveField,
    makeTeam,
    matchRow,
    openTournament,
    register,
    type RegisterOpts,
} from '../fixtures/tournaments';
import {
    byKey,
    deferredDuel,
    duel,
    offlinePastGrace,
    openMatchLobby,
    playMatch,
    recordsOfLobby,
    sidesOf,
} from '../fixtures/tournament-matches';


// ════════════════════════════════════════════════════════════════════════════
// Live match views (S9a-V7; PAGE-MAP D3; A56, A60, A63, A67(3); interpretation 1)
// ════════════════════════════════════════════════════════════════════════════

describe('live match views: view_my_match_session / view_my_lineups / view_my_match_result / view_my_match_result_games', () => {
    it('a member reads the rows of their own live lobby only (two lobbies in Scoring)', () => {
        const test = newHarness();
        const a = scoringOf(test, '');
        const b = scoringOf(test, 'Y');
        for (const s of [a, b]) { // the game row exists once a score is recorded
            recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(10)]);
            recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(20)]);
        }
        for (const name of ['view_my_match_session', 'view_my_lineups', 'view_my_match_result', 'view_my_match_result_games']) {
            const rows = view<{ lobbyId: number }>(test, name, a.a.b1);
            expect(rows.length, name).toBeGreaterThan(0);
            expect(rows.every((r) => r.lobbyId === a.lobbyId), name).toBe(true);
            expect(view<{ lobbyId: number }>(test, name, b.a.Yr1).every((r) => r.lobbyId === b.lobbyId), name).toBe(true);
        }
    });

    it('view_my_match_session: the session row without audit columns; nothing in Waiting', () => {
        const test = newHarness();
        const w = lobbyOf(test, 'w', { noStart: true });
        expect(view(test, 'view_my_match_session', w.a.wb1)).toEqual([]);
        const s = scoringOf(test, '');
        const [row] = view<MatchSessionViewRow>(test, 'view_my_match_session', s.a.r2);
        expect(row.lobbyId).toBe(s.lobbyId);
        expectOnlyColumns(row, COLS.session);
        for (const k of AUDIT_KEYS) expect(k in row, k).toBe(false);
    });

    it('interpretation 1: every member (players of both teams, the spectator) reads both teams\' lineups; Blue\'s confirmation shows on both rows', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { beforeStart: makeRanked(test) });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(20)]);
        confirmGame(s, captain(s, 'Blue'), 'Blue');
        for (const who of [s.a.b1, s.a.r1, s.host]) {
            const rows = view<MatchLineupViewRow>(test, 'view_my_lineups', who);
            expect(rows.map((r) => r.teamSide.tag).sort(), who.sub).toEqual(['Blue', 'Red']);
            for (const r of rows) {
                expect(keysOf(r)).toEqual([...COLS.lineup].sort());
                expect(r).toMatchObject({ blueConfirmed: true, redConfirmed: false, closedAt: undefined });
            }
        }
        const [game] = view<MatchResultGameViewRow>(test, 'view_my_match_result_games', s.a.r1);
        expect(game).toMatchObject({ blueConfirmed: true, redConfirmed: false, closedAt: undefined });
    });

    it('after the close (both ready, a captain submits): closedAt and both flags appear in view_my_lineups and view_my_match_result_games', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { beforeStart: makeRanked(test) });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(20)]);
        confirmBoth(s);
        closeGame(s, captain(s, 'Blue'));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        for (const r of view<MatchLineupViewRow>(test, 'view_my_lineups', s.a.r1)) {
            expect(r.blueConfirmed && r.redConfirmed).toBe(true);
            expect(r.closedAt).toBeDefined();
        }
        const [game] = view<MatchResultGameViewRow>(test, 'view_my_match_result_games', s.a.r1);
        expect(game.blueConfirmed && game.redConfirmed).toBe(true);
        expect(game.closedAt).toBeDefined();
        expect(game.winnerTeamSide.tag).toBe('Blue');
        const [result] = view<MatchResultViewRow>(test, 'view_my_match_result', s.a.r1);
        expect(result.status.tag).toBe('Submitted');
    });

    it('view_my_match_result_games nests the group scores and the adjustments of the lobby\'s one game', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { beforeStart: makeRanked(test) });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(11)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(21)]);
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), value: H(-1), reason: 'penalty' }));
        const rows = view<MatchResultGameViewRow>(test, 'view_my_match_result_games', s.a.b1);
        expect(rows).toHaveLength(1);
        const [game] = rows;
        expect(keysOf(game)).toEqual([...COLS.game].sort());
        expect(game.matchResultId).toBe(recordOf(test, s.lobbyId).id);
        expect(game.groupScores).toHaveLength(4);
        for (const g of game.groupScores) expect(keysOf(g)).toEqual([...COLS.groupScore].sort());
        const blueValues = game.groupScores.filter((g) => g.teamSide.tag === 'Blue').sort((x, y) => x.groupIndex - y.groupIndex).map((g) => g.value);
        expect(blueValues).toEqual([H(10), H(11)]);
        expect(game.adjustments).toHaveLength(1);
        expect(keysOf(game.adjustments[0])).toEqual([...COLS.adjustment].sort());
        expect(game.adjustments[0]).toMatchObject({ value: H(-1), reason: 'penalty', setById: s.host.userId });
        expect(game.adjustments[0].teamSide.tag).toBe('Red');
    });

    it('view_my_match_result: the documented columns, no referee id or refereeFullControl, no audit columns', () => {
        const test = newHarness();
        const s = scoringOf(test, '');
        const [row] = view<MatchResultViewRow>(test, 'view_my_match_result', s.a.b1);
        expect(keysOf(row)).toEqual([...COLS.result].sort());
        expect(row.status.tag).toBe('Pending');
        for (const k of ['refereeUserId', 'refereeFullControl', ...AUDIT_KEYS]) expect(k in row, k).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Replay set (S9a-V9; A37, A56(1))
// ════════════════════════════════════════════════════════════════════════════

describe('replay set: view_my_match_history_lineups (was view_my_match_lineup_history) and the removed public history views', () => {
    it('the archived lineups of a finalized casual match go to its participants only (T-S10n: per match, A115(3))', () => {
        const test = newHarness();
        const s = scoringOf(test, '');
        finishGame(s, 'Blue'); // Casual: the close validates and finalizes inline (A60(6))
        const history = [...test.db.MatchLineupHistory.iter()];
        expect(history).toHaveLength(2);
        const args = { matchHistoryId: onlyMatchOf(test, s.a.b1) };
        for (const who of [s.a.b1, s.a.r2]) {
            const rows = view<{ matchHistoryId: number; teamSide: { tag: string } }>(test, 'view_my_match_history_lineups', who, args);
            expect(rows.map((r) => r.teamSide.tag).sort(), who.sub).toEqual(['Blue', 'Red']);
        }
        expect(view(test, 'view_my_match_history_lineups', s.host, args)).toEqual([]); // the spectator host did not play
        expect(view(test, 'view_my_match_history_lineups', guest(test, 'outsider'), args)).toEqual([]);
    });

    it('view_match_history, view_match_participant_history and view_match_step_history are gone (module and bindings)', () => {
        expectTypeOf<typeof M>().not.toHaveProperty('view_match_history');
        expectTypeOf<typeof M>().not.toHaveProperty('view_match_participant_history');
        expectTypeOf<typeof M>().not.toHaveProperty('view_match_step_history');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('viewMatchHistory');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('viewMatchParticipantHistory');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('viewMatchStepHistory');
        for (const name of ['view_match_history', 'view_match_participant_history', 'view_match_step_history']) {
            expect(name in M, name).toBe(false);
        }
        expect('view_my_match_history_lineups' in M).toBe(true); // T-S10n (A115): the per-match replay lineups
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_admin_stuck_games (S9a-V8; A60(9), A63; interpretation 3)
// ════════════════════════════════════════════════════════════════════════════

describe('view_admin_stuck_games', () => {
    it('a Moderator reads a ranked Scoring lobby with one ready flag and a ranked open level-4 tie with both flags; a casual lobby and a closed game are absent', () => {
        const test = newHarness();
        const oneSided = scoringOf(test, 'A', { beforeStart: makeRanked(test) });
        recordScores(oneSided, captain(oneSided, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(oneSided, captain(oneSided, 'Red'), 'Red', [H(20), H(20)]);
        confirmGame(oneSided, captain(oneSided, 'Red'), 'Red');

        const tie = scoringOf(test, 'T', { beforeStart: makeRanked(test) });
        recordScores(tie, captain(tie, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(tie, captain(tie, 'Red'), 'Red', [H(5), H(5)]);
        confirmBoth(tie);

        const casual = scoringOf(test, 'C');
        recordScores(casual, captain(casual, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(casual, captain(casual, 'Red'), 'Red', [H(20), H(20)]);
        confirmGame(casual, captain(casual, 'Blue'), 'Blue');

        const both = scoringOf(test, 'B', { beforeStart: makeRanked(test) });
        recordScores(both, captain(both, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(both, captain(both, 'Red'), 'Red', [H(20), H(20)]);
        confirmBoth(both); // both ready, no tie: waiting for the submit click, not stuck

        const closed = scoringOf(test, 'X', { beforeStart: makeRanked(test) });
        finishGame(closed, 'Red');

        const rows = view<StuckGameRow>(test, 'view_admin_stuck_games', moderator(test));
        expect(rows.map((r) => r.lobbyId).sort((x, y) => x - y)).toEqual([oneSided.lobbyId, tie.lobbyId].sort((x, y) => x - y));
        const one = rows.find((r) => r.lobbyId === oneSided.lobbyId)!;
        expect(keysOf(one)).toEqual([...COLS.stuck].sort());
        expect(one).toMatchObject({ joinCode: lobbyRow(test, oneSided.lobbyId).joinCode, blueConfirmed: false, redConfirmed: true, isTie: false });
        expect(one.stage.tag).toBe('Scoring');
        const gameRow = [...test.db.MatchResultGame.match_result_id.filter(recordOf(test, oneSided.lobbyId).id)][0];
        expect(one.sinceAt.microsSinceUnixEpoch).toBe(gameRow.lastModifiedDate.microsSinceUnixEpoch);
        expect(rows.find((r) => r.lobbyId === tie.lobbyId)).toMatchObject({ blueConfirmed: true, redConfirmed: true, isTie: true });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Tournament arg views (S9a-V10; A37, A26a(2), §A.4 P3; interpretation 9)
// ════════════════════════════════════════════════════════════════════════════

describe('tournament arg views', () => {
    /**
     * A Registration-stage tournament: p1 (alias "Masked" when anonymous) and p2 form team Alpha; p3 is disqualified;
     * p4 enrolls last. One second between enrollments, so the seat order is the enrollment order. An assistant with
     * the results flag.
     */
    function cup(isAnonymousDefault: boolean) {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault });
        const p = [1, 2, 3, 4].map((i) => verified(test, `p${i}`));
        p.forEach((who, i) => {
            advance(test, 1_000);
            const opts: RegisterOpts = isAnonymousDefault && i === 0 ? { anonymousAlias: 'Masked' } : {};
            register(test, who, id, opts);
        });
        const teamId = makeTeam(test, id, p[0], [p[1]], 'Alpha');
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: p[2].userId, reason: 'no-show' }));
        const asst = verified(test, 'asst');
        assignAssistant(test, org, id, asst, { results: true });
        return { test, org, id, p, teamId, asst };
    }

    it('non-anonymous: participants (DQ hidden), team captain, team members and staff carry real ids and display names', () => {
        const { test, org, id, p, teamId, asst } = cup(false);
        const parts = shared<TournamentParticipantRow>(test, 'view_tournament_participants', { tournamentId: id });
        expect(parts.map((r) => r.userId).sort()).toEqual([p[0].userId, p[1].userId, p[3].userId].sort());
        for (const r of parts) {
            expect(keysOf(r)).toEqual([...COLS.tParticipant].sort());
            expect(r.label).toBe(test.db.User.id.find(r.userId)!.displayName);
        }
        expect(parts.find((r) => r.userId === p[0].userId)!.teamId).toBe(teamId);
        const [team] = shared<TournamentTeamPublicRow>(test, 'view_tournament_teams', { tournamentId: id });
        expect(keysOf(team)).toEqual([...COLS.tTeam].sort());
        expect(team).toMatchObject({ id: teamId, name: 'Alpha', captainUserId: p[0].userId });
        const members = shared<TournamentTeamMemberPublicRow>(test, 'view_tournament_team_members', { tournamentId: id });
        expect(members.map((r) => r.userId).sort()).toEqual([p[0].userId, p[1].userId].sort());
        for (const r of members) expect(keysOf(r)).toEqual([...COLS.tTeamMember].sort());
        const staff = shared<TournamentStaffRow>(test, 'view_tournament_staff', { tournamentId: id });
        expect(staff.map((r) => r.userId).sort()).toEqual([org.userId, asst.userId].sort());
        for (const r of staff) expect(keysOf(r)).toEqual([...COLS.tStaff].sort());
    });

    it('A26a(2) / A37 / interpretation 9: anonymous: DQ row hidden, userId 0, alias or Seat-<n> by enrollment order (the DQ row keeps its seat)', () => {
        const { test, id, p } = cup(true);
        const parts = shared<TournamentParticipantRow>(test, 'view_tournament_participants', { tournamentId: id });
        expect(parts).toHaveLength(3);
        expect(parts.every((r) => r.userId === 0)).toBe(true);
        expect(parts.map((r) => r.label).sort()).toEqual(['Masked', 'Seat-2', 'Seat-4']);
        expect(parts.map((r) => r.seat).sort()).toEqual([1, 2, 4]);
        for (const r of parts) {
            for (const who of p) expect(r.label).not.toContain(displayName(test, who));
        }
    });

    it('anonymous: teams carry no captainUserId; team members carry userId 0 and the alias / seat label', () => {
        const { test, id } = cup(true);
        const [team] = shared<TournamentTeamPublicRow>(test, 'view_tournament_teams', { tournamentId: id });
        expect(team.captainUserId).toBeUndefined();
        const members = shared<TournamentTeamMemberPublicRow>(test, 'view_tournament_team_members', { tournamentId: id });
        expect(members.every((r) => r.userId === 0)).toBe(true);
        expect(members.map((r) => r.label).sort()).toEqual(['Masked', 'Seat-2']);
    });

    it('anonymous: staff are identified always (organizer + assistant with their flags)', () => {
        const { test, org, id, asst } = cup(true);
        const staff = shared<TournamentStaffRow>(test, 'view_tournament_staff', { tournamentId: id });
        expect(staff.find((r) => r.isOrganizer)).toMatchObject({ userId: org.userId, label: displayName(test, org) });
        expect(staff.find((r) => !r.isOrganizer)).toMatchObject({
            userId: asst.userId, canResolveResults: true, canManageBracket: false, canManageParticipants: false,
        });
    });

    it('a wrong tournamentId reads [] from all four arg views', () => {
        const { test, id } = cup(false);
        for (const name of ['view_tournament_participants', 'view_tournament_teams', 'view_tournament_team_members', 'view_tournament_staff']) {
            expect(shared(test, name, { tournamentId: id + 999 }), name).toEqual([]);
        }
    });

    // Module finding (A37 leak, a kept view re-checked in S9a): view_tournament_registrant_accounts emits every other
    // enrolled player's real userId to an enrolled player, whatever Tournament.isAnonymousDefault says.
    it('A37: anonymous tournament: an enrolled player reads no other participant\'s real id in view_tournament_registrant_accounts', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault: true, rosterVisibility: 'OpenRoster' });
        const a = verified(test, 'pa');
        const b = verified(test, 'pb');
        insertHsrAccount(test, a.userId, 'uid-a');
        insertHsrAccount(test, b.userId, 'uid-b');
        register(test, a, id);
        register(test, b, id);
        const rows = view<{ userId: number }>(test, 'view_tournament_registrant_accounts', a);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter((r) => r.userId === b.userId)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Per-sender tournament views (S9a-V11; PAGE-MAP D9; A70(1), A71; interpretations 10, 11)
// ════════════════════════════════════════════════════════════════════════════

describe('per-sender tournament views', () => {
    it('view_my_tournament_enrollment: the caller\'s own rows only, across tournaments', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const t1 = openTournament(test, org, { name: 'One' });
        const t2 = openTournament(test, org, { name: 'Two' });
        const me = verified(test, 'me');
        const other = verified(test, 'other');
        register(test, me, t1);
        register(test, me, t2);
        register(test, other, t1);
        const rows = view<{ userId: number; tournamentId: number }>(test, 'view_my_tournament_enrollment', me);
        expect(rows.map((r) => r.tournamentId).sort()).toEqual([t1, t2].sort());
        expect(rows.every((r) => r.userId === me.userId)).toBe(true);
        expect(view(test, 'view_my_tournament_enrollment', org)).toEqual([]);
    });

    it('view_my_team_requests: the requester reads their own request (isMine); the captain reads requests to their team with the requester\'s id (interpretation 10); a third player reads nothing', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org);
        const [cap, asker, third] = ['cap', 'asker', 'third'].map((n) => verified(test, n));
        for (const who of [cap, asker, third]) register(test, who, id);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'Forming' }));
        const teamId = [...test.db.TournamentTeam.tournament_id.filter(id)][0].id;
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));

        const capRows = view<TeamRequestViewRow>(test, 'view_my_team_requests', cap);
        expect(capRows).toHaveLength(1);
        expect(keysOf(capRows[0])).toEqual([...COLS.teamRequest].sort());
        expect(capRows[0]).toMatchObject({ teamId, teamName: 'Forming', userId: asker.userId, isMine: false, label: displayName(test, asker) });
        const askerRows = view<TeamRequestViewRow>(test, 'view_my_team_requests', asker);
        expect(askerRows).toEqual([expect.objectContaining({ teamId, userId: asker.userId, isMine: true })]);
        expect(view(test, 'view_my_team_requests', third)).toEqual([]);
    });

    // T-S9c: S9a's seat label is superseded by A73(1): the captain reads the requester's real display name in every tournament.
    it('view_my_team_requests in an anonymous tournament: the captain reads the display name of the requester (A73(1), was the seat label)', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault: true });
        const [cap, asker] = ['cap', 'asker'].map((n) => verified(test, n));
        register(test, cap, id);
        advance(test, 1_000);
        register(test, asker, id);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'Forming' }));
        const teamId = [...test.db.TournamentTeam.tournament_id.filter(id)][0].id;
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));
        const [row] = view<TeamRequestViewRow>(test, 'view_my_team_requests', cap);
        expect(row.label).toBe(displayName(test, asker));
        expect(row.userId).toBe(asker.userId);
    });

    it('view_my_stand_ins: the stand-in and their team read the row; the opponents do not (interpretation 11)', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const { blue, red } = sidesOf(f, m.id);
        const sub = verified(test, 'sub');
        tx(test, org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId }));
        const [own] = view<StandInViewRow>(test, 'view_my_stand_ins', sub);
        expect(keysOf(own)).toEqual([...COLS.standIn].sort());
        expect(own).toMatchObject({ bracketMatchId: m.id, teamId: m.team1Id, userId: sub.userId, label: displayName(test, sub) });
        expect('approvedByUserId' in own).toBe(false);
        expect(view<StandInViewRow>(test, 'view_my_stand_ins', blue.captain).map((r) => r.userId)).toEqual([sub.userId]);
        expect(view<StandInViewRow>(test, 'view_my_stand_ins', blue.mate).map((r) => r.userId)).toEqual([sub.userId]);
        expect(view(test, 'view_my_stand_ins', red.captain)).toEqual([]);
    });

    it('view_tournament_matches_for_me: the Ready match of my team with the opponent\'s name and colours; after set_match_sides the colours follow; the tally stays team-based (A71)', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const { blue, red } = sidesOf(f, m.id);
        const [mine] = view<MatchForMeRow>(test, 'view_tournament_matches_for_me', blue.captain);
        expect(keysOf(mine)).toEqual([...COLS.matchForMe].sort());
        expect(mine).toMatchObject({
            bracketMatchId: m.id, tournamentId: f.id, myTeamId: blue.teamId, opponentTeamId: red.teamId,
            opponentTeamName: test.db.TournamentTeam.id.find(red.teamId)!.name, blueTeamId: m.team1Id, redTeamId: m.team2Id,
        });
        expect(mine.state.tag).toBe('Ready');
        const [theirs] = view<MatchForMeRow>(test, 'view_tournament_matches_for_me', red.mate);
        expect(theirs).toMatchObject({ myTeamId: red.teamId, opponentTeamId: blue.teamId });

        tx(test, org, (ctx) => M.set_match_sides(ctx, { bracketMatchId: m.id, blueTeamId: m.team2Id! }));
        const [after] = view<MatchForMeRow>(test, 'view_tournament_matches_for_me', blue.captain);
        expect(after).toMatchObject({ blueTeamId: m.team2Id, redTeamId: m.team1Id });
        expect(after.team1Games).toBe(matchRow(test, m.id).team1Games);
        expect(after.team2Games).toBe(matchRow(test, m.id).team2Games);
    });

    it('view_tournament_matches_for_me: a decided match is not listed', () => {
        const f = duel();
        const m = [...f.test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const { blue } = sidesOf(f, m.id);
        playMatch(f, m.id, 'Blue');
        expect(matchRow(f.test, m.id).state.tag).not.toBe('Ready');
        expect(view(f.test, 'view_tournament_matches_for_me', blue.captain)).toEqual([]);
    });

    it('view_my_tournament_lobbies: staff read each lobby with its match\'s blue / red team ids (A70(1)), following set_match_sides', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        tx(test, org, (ctx) => M.set_match_sides(ctx, { bracketMatchId: m.id, blueTeamId: m.team2Id! }));
        const s = openMatchLobby(f, m.id, { noStart: true });
        const rows = view<TournamentLobbyRow>(test, 'view_my_tournament_lobbies', org);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: s.lobbyId, blueTeamId: m.team2Id, redTeamId: m.team1Id });
    });

    it('view_my_tournament_match_results: rows of a played match carry no refereeFullControl (runtime and type-level)', () => {
        const f = duel();
        const m = [...f.test.db.BracketMatch.tournament_id.filter(f.id)][0];
        playMatch(f, m.id, 'Red');
        const rows = view<MatchResultRecordBinding>(f.test, 'view_my_tournament_match_results', f.org);
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect('refereeFullControl' in r).toBe(false);
        expectTypeOf<MatchResultRecordBinding>().not.toHaveProperty('refereeFullControl');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Egress smoke: the generated row types equal the documented column lists (type-level, checked by npm run typecheck)
// ════════════════════════════════════════════════════════════════════════════

describe('egress smoke (type-level)', () => {
    it('each new or reshaped S9a row type has exactly the documented columns', () => {
        expectTypeOf<keyof LobbyBrowserRow>().toEqualTypeOf<Cols<'browser'>>();
        expectTypeOf<keyof MyLobbyListRow>().toEqualTypeOf<Cols<'myLobbies'>>();
        expectTypeOf<keyof LobbyMemberViewRow>().toEqualTypeOf<Cols<'member'>>();
        expectTypeOf<keyof LobbyBanViewRow>().toEqualTypeOf<Cols<'ban'>>();
        expectTypeOf<keyof AnonymousChatRow>().toEqualTypeOf<Cols<'chat'>>();
        expectTypeOf<keyof MatchSessionViewRow>().toEqualTypeOf<Cols<'session'>>();
        expectTypeOf<keyof AnonymousMatchStepRow>().toEqualTypeOf<Cols<'step'>>();
        expectTypeOf<keyof AnonymousMatchParticipantRow>().toEqualTypeOf<Cols<'participant'>>();
        expectTypeOf<keyof MatchLineupViewRow>().toEqualTypeOf<Cols<'lineup'>>();
        expectTypeOf<keyof MatchResultViewRow>().toEqualTypeOf<Cols<'result'>>();
        expectTypeOf<keyof MatchResultGameViewRow>().toEqualTypeOf<Cols<'game'>>();
        expectTypeOf<keyof GroupScoreItem>().toEqualTypeOf<Cols<'groupScore'>>();
        expectTypeOf<keyof AdjustmentItem>().toEqualTypeOf<Cols<'adjustment'>>();
        expectTypeOf<keyof StuckGameRow>().toEqualTypeOf<Cols<'stuck'>>();
        expectTypeOf<keyof TournamentParticipantRow>().toEqualTypeOf<Cols<'tParticipant'>>();
        expectTypeOf<keyof TournamentTeamPublicRow>().toEqualTypeOf<Cols<'tTeam'>>();
        expectTypeOf<keyof TournamentTeamMemberPublicRow>().toEqualTypeOf<Cols<'tTeamMember'>>();
        expectTypeOf<keyof TournamentStaffRow>().toEqualTypeOf<Cols<'tStaff'>>();
        expectTypeOf<keyof TeamRequestViewRow>().toEqualTypeOf<Cols<'teamRequest'>>();
        expectTypeOf<keyof StandInViewRow>().toEqualTypeOf<Cols<'standIn'>>();
        expectTypeOf<keyof MatchForMeRow>().toEqualTypeOf<Cols<'matchForMe'>>();
        // T-S9a follow-up: the fix pass added `seat` to the registrant row; the browser, view_my_lobby and the staff
        // row kept their columns (review #6, #7, #12 skipped), so their key sets above stand
        expectTypeOf<keyof TournamentRegistrantAccountRow>().toEqualTypeOf<Cols<'registrant'>>();
        // view_my_lobby emits the Lobby row type; no secret column exists on it (the hash is in LobbyPassword)
        expectTypeOf<LobbyBinding>().not.toHaveProperty('passwordHash');
        expectTypeOf<LobbyBinding>().not.toHaveProperty('password');
        // view_my_tournament_lobbies: the Lobby columns plus the colours
        expectTypeOf<TournamentLobbyRow>().toHaveProperty('blueTeamId');
        expectTypeOf<TournamentLobbyRow>().toHaveProperty('redTeamId');
    });
});

describe('view_tournament_registrant_accounts scope (S9a fix; A37, D-22)', () => {
    /** An OpenRoster tournament: a (seat 1) and b (seat 2) enrolled with one HSR account each; an assistant; an outsider. */
    function regWorld(isAnonymousDefault: boolean) {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault, rosterVisibility: 'OpenRoster' });
        const a = verified(test, 'pa');
        const b = verified(test, 'pb');
        const accA = insertHsrAccount(test, a.userId, 'uid-a');
        const accB = insertHsrAccount(test, b.userId, 'uid-b');
        register(test, a, id);
        advance(test, 1_000);
        register(test, b, id);
        const asst = verified(test, 'asst');
        assignAssistant(test, org, id, asst, { results: true });
        const rows = (who: Reader) => view<TournamentRegistrantAccountRow>(test, 'view_tournament_registrant_accounts', who);
        return { test, org, id, a, b, accA, accB, asst, rows, outsider: guest(test, 'outsider') };
    }

    it('staff (organizer, assistant) read every participant\'s rows with real ids, account ids and seats, in an anonymous tournament too', () => {
        const { org, asst, a, b, accA, accB, rows } = regWorld(true);
        for (const who of [org, asst]) {
            const r = rows(who);
            expect(r.find((x) => x.userId === a.userId), who.sub).toMatchObject({ hsrAccountId: accA, seat: 1 });
            expect(r.find((x) => x.userId === b.userId), who.sub).toMatchObject({ hsrAccountId: accB, seat: 2 });
            expect(r.filter((x) => x.userId === 0), who.sub).toEqual([]);
            for (const x of r) expect(keysOf(x)).toEqual([...COLS.registrant].sort());
        }
    });

    it('anonymous tournament: a participant reads their own rows with real ids and the others with userId 0, hsrAccountId 0 and the seat; no other player\'s id or account id', () => {
        const { a, b, accA, accB, rows } = regWorld(true);
        const r = rows(a);
        expect(r.some((x) => x.userId === a.userId)).toBe(true);
        expect(r.filter((x) => x.userId === a.userId).every((x) => x.hsrAccountId === accA && x.seat === 1)).toBe(true);
        const others = r.filter((x) => x.userId !== a.userId);
        expect(others.length).toBeGreaterThan(0);
        expect(others.every((x) => x.userId === 0 && x.hsrAccountId === 0 && x.seat === 2)).toBe(true);
        expect(r.filter((x) => x.userId === b.userId || x.hsrAccountId === accB)).toEqual([]);
    });

    it('an outsider and an unmapped identity read nothing', () => {
        const { rows, outsider } = regWorld(true);
        expect(rows(outsider)).toEqual([]);
        expect(rows(ghost())).toEqual([]);
    });

    it('non-anonymous OpenRoster tournament: a participant reads the other participant\'s rows with the real id (D-22)', () => {
        const { a, b, accB, rows } = regWorld(false);
        expect(rows(a).find((x) => x.userId === b.userId)).toMatchObject({ hsrAccountId: accB, seat: 2 });
    });
});

// ─── Not drivable in memory ──────────────────────────────────────────────────

describe('S9a: outside the in-memory harness', () => {
    it.todo('A37 / T-S11: a real client subscribed as an outsider receives no identifying row (subscription-level; live residue on test1)');
    it.todo('arg views over the wire: `SELECT * FROM view_tournament_participants(<id>)` subscription syntax and per-argument sharing (live residue, S11)');
    it.todo('PAGE-MAP D3: the room subscribes the match views only past Waiting (client behaviour, S14)');
    it.todo('egress: the member row is not rewritten by cursor / lineup throttle stamps (row-diff over the wire; live residue)');
    it.todo('review #9: a tournament Seat-<n> stays stable when an earlier enrollment is withdrawn (not applied in the fix pass: the anonymous-play contract documents the renumbering; the alias is the stable label)');
});

// ════════════════════════════════════════════════════════════════════════════
// A83: the concede summary is staff-only
// ════════════════════════════════════════════════════════════════════════════

describe('A83: view_my_match_result emits concedeSummary only to a Moderator or Admin', () => {
    const resultFor = (test: Harness, who: Actor, lobbyId: number) =>
        ((M as any).view_my_match_result(test.viewContext(who.auth), {}) as any[]).find((r) => r.lobbyId === lobbyId);

    // T-S10d (A91(1)(2)): Deferred is tournament-only, so the deferred lobby is the lobby of a Deferred tournament
    // (isAnonymousDefault carries the anonymity), and the defer follows a seated player (r1) offline past the grace.
    it.each([false, true])('deferred tournament lobby, parked (isAnonymousPlayers %s): player and spectator get none; Moderator and Admin members get the text; the column keeps it (A83)', (anon) => {
        const { f, s } = deferredDuel({}, { isAnonymousDefault: anon });
        const { test } = f;
        expect(lobbyRow(test, s.lobbyId).isAnonymousPlayers).toBe(anon);
        const spec = joinAsSpectator(s, 'spec');
        const mod = joinAsSpectator(s, 'modspec');
        const adm = joinAsSpectator(s, 'admspec');
        setRole(test, mod.userId, 'Moderator');
        setRole(test, adm.userId, 'Admin');
        offlinePastGrace(test, s.a.r1);
        tx(test, s.host, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const [stored] = recordsOfLobby(test, s.lobbyId);
        expect(stored.status.tag).toBe('Pending');
        expect(typeof stored.concedeSummary).toBe('string');
        expect(stored.concedeSummary!.length).toBeGreaterThan(0);

        for (const who of [s.a.b1, s.a.r2, spec, s.host]) {
            const row = resultFor(test, who, s.lobbyId);
            expect(row).toBeDefined();
            expect(row.concedeSummary).toBeUndefined();
        }
        for (const who of [mod, adm]) expect(resultFor(test, who, s.lobbyId).concedeSummary).toBe(stored.concedeSummary);
        expect(recordsOfLobby(test, s.lobbyId)[0].concedeSummary).toBe(stored.concedeSummary);
    });

    it('tournament concede, parked: players and the organizer (Tournament Host) get none; a member promoted to Moderator / Admin gets the text (A83)', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        tx(f.test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        const { test } = f;
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const [stored] = recordsOfLobby(test, s.lobbyId);
        expect(stored.matchEndReason?.tag).toBe('Concede');
        expect(stored.concedeSummary).toBeTruthy();

        for (const who of [s.a.b1, s.a.r1, s.a.r2, f.org]) expect(resultFor(test, who, s.lobbyId).concedeSummary).toBeUndefined();
        setRole(test, s.a.b2.userId, 'Moderator');
        setRole(test, s.a.r2.userId, 'Admin');
        expect(resultFor(test, s.a.b2, s.lobbyId).concedeSummary).toBe(stored.concedeSummary);
        expect(resultFor(test, s.a.r2, s.lobbyId).concedeSummary).toBe(stored.concedeSummary);
    });
});
