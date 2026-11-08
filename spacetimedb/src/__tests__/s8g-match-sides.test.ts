// T-S8g: in-memory tests for A70(1) and A71: every bracket match chooses its colours (`BracketMatch.blueTeamId`,
// default team1 = Blue, a stale value falls back to the default) through `set_match_sides(bracketMatchId, blueTeamId)`
// until the first game is played; the head start stays on slot 1 (team1, the winners' bracket finalist) whatever the
// colours (A71(1)(2), A27); a slot change voids the colour choice and rewrites the stored tally to the derived one
// (A71(3)). Covers the mapping sites (seating through allowedSlotsFor, the result credit, the derived tally, the concede
// hand-off, the DQ losing side, rollback), the reducer's guards and their order (A25 `bracket`, A70(3) as fixed by A71),
// group-stage matches, and the public row (A37). Builders in s4 / s7 / s8 / s8d fixtures; the S8e tally suite is the
// regression baseline. Nothing reaches maincloud.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { M, advance, expectReject, lobbyRow, member, tx, type Actor, type Harness, type Lobby } from './s4-fixtures';
import {
    advanceStage,
    assignAssistant,
    bracketRows,
    liveField,
    matchRow,
    resolveMatch,
    verified,
} from './s8-fixtures';
import {
    byKey,
    createTournamentLobby,
    join,
    lobbiesOf,
    openMatchLobby,
    playBracketMatch,
    playLobbyGame,
    playMatch,
    recordsOfLobby,
    recordsOfMatch,
    type Field,
    type TeamEntry,
} from './s8d-fixtures';
import { matchGames } from '@module/helpers/tournament/bracketResults';
import { slotChangeReset } from '@module/helpers/tournament/matchSides';
import { allowedSlotsFor } from '@module/helpers/tournament/tournamentLobbySides';
import { groupStandings } from '@module/helpers/tournament/tournamentStandings';
import { bracketMatchColumns } from '@module/tables/tournament/bracketMatch';

const BO3 = { defaultBestOf: 3, grandFinalBestOf: 3 };
const SEAT = 'This seat is not available to you in this tournament lobby.';
const NOT_AUTHORIZED = 'You are not authorized to set the sides of this match.';
const OPEN_LOBBY = 'Close the open lobby of this match before changing its sides.';
const STARTED = 'The sides can no longer be changed: a game of this match has started.';

const sidesBody = (bracketMatchId: number, blueTeamId: number) => (ctx: any) =>
    M.set_match_sides(ctx, { bracketMatchId, blueTeamId });
const setSides = (test: Harness, who: Actor, bracketMatchId: number, blueTeamId: number) =>
    tx(test, who, sidesBody(bracketMatchId, blueTeamId));

const tally = (test: Harness, matchId: number) => {
    const r = matchRow(test, matchId);
    return [r.team1Games, r.team2Games];
};
const derived = (test: Harness, matchId: number) => {
    const r = matchRow(test, matchId);
    const g = tx(test, 'internal', (ctx) => matchGames(ctx, r));
    return [g.team1, g.team2];
};
const slotOf = (test: Harness, lobbyId: number, who: Actor) => member(test, lobbyId, who.userId)?.lobbySlot.tag;
const entry = (f: Field, teamId: number | undefined): TeamEntry => f.ts.find((t) => t.teamId === teamId)!;
const rollback = (f: Field, bracketMatchId: number) =>
    tx(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId, reason: 'replay' }));

/** A 2-team single elimination whose only match is a Bo3 (W-R1-M1), no head start. */
function bo3Duel(over: Record<string, unknown> = {}) {
    const f = liveField(2, { ...BO3, ...over });
    const m = byKey(f.test, f.id, 'W-R1-M1');
    expect(m.bestOf).toBe(3);
    return { f, m };
}

/** A 4-team double elimination with a Bo3 grand final and winnerAdvantage 1; staff settle every other match (team1 wins). */
function grandFinalField() {
    const f = liveField(4, { format: 'DoubleElimination', grandFinalBestOf: 3, winnerAdvantage: 1 });
    const gfOf = () => bracketRows(f.test, f.id).find((r) => r.bracketSide.tag === 'GrandFinals')!;
    for (let guard = 0; matchRow(f.test, gfOf().id).state.tag !== 'Ready' && guard < 10; guard++) {
        const ready = bracketRows(f.test, f.id).find((r) => r.state.tag === 'Ready' && r.id !== gfOf().id)!;
        resolveMatch(f.test, f.org, ready.id, ready.team1Id!);
    }
    const gf = matchRow(f.test, gfOf().id);
    expect(gf.state.tag).toBe('Ready');
    expect([gf.bestOf, gf.winnerAdvantage]).toEqual([3, 1]);
    expect(tally(f.test, gf.id)).toEqual([1, 0]);
    return { f, gf };
}

/**
 * Creates the match's lobby (organizer = spectator referee), joins the four players (auto-seated by the match's colour
 * mapping, A70(1)), confirms and starts the draft. Actors: `blue1/blue2` = the team the caller says plays Blue.
 */
function openLobbyBySides(f: Field, bracketMatchId: number, blueTeam: TeamEntry, redTeam: TeamEntry): Lobby {
    const lobbyId = createTournamentLobby(f.test, f.org, bracketMatchId);
    const a: Record<string, Actor> = { host: f.org, b1: blueTeam.captain, b2: blueTeam.mate, r1: redTeam.captain, r2: redTeam.mate };
    for (const name of ['b1', 'b2', 'r1', 'r2']) join(f.test, a[name], lobbyId);
    for (const name of ['b1', 'b2']) expect(slotOf(f.test, lobbyId, a[name]), name).toBe('BluePlayer');
    for (const name of ['r1', 'r2']) expect(slotOf(f.test, lobbyId, a[name]), name).toBe('RedPlayer');
    for (const name of ['b1', 'b2', 'r1', 'r2']) tx(f.test, a[name], (ctx) => M.confirm_ready(ctx, { lobbyId }));
    tx(f.test, f.org, (ctx) => M.start_draft(ctx, { lobbyId }));
    return { test: f.test, lobbyId, host: f.org, a };
}

// ─── S8g-B1: the default mapping is unchanged (A70(1), A35, A27) ──────────────

describe('A70: the default mapping (sides never set) is unchanged', () => {
    it('Bo3 without set_match_sides: team1 seated on Blue, Blue wins credited to team1; tally and decision as in S8e', () => {
        const { f, m } = bo3Duel();
        const row = matchRow(f.test, m.id);
        expect(row.blueTeamId).toBeUndefined();
        expect(row).not.toHaveProperty('headStartSide'); // A71(2)
        const s1 = openLobbyBySides(f, m.id, entry(f, m.team1Id), entry(f, m.team2Id));
        playLobbyGame(s1, 'Blue');
        expect(tally(f.test, m.id)).toEqual([1, 0]);
        playBracketMatch(f, m.id, ['Red']);
        expect(tally(f.test, m.id)).toEqual([1, 1]);
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');
        playBracketMatch(f, m.id, ['Blue']);
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Played');
        expect(after.winnerTeamId).toBe(m.team1Id);
        expect([after.team1Games, after.team2Games]).toEqual([2, 1]);
    });
});

// ─── S8g-B2: colours swapped on a grand final; the head start stays on team1 (A70(1), A71(1)) ──

describe('A71(1): set_match_sides(gf, team2) on a Bo3 grand final with winnerAdvantage 1', () => {
    it('the stored tally equals the derived one and team1Games === winnerAdvantage after the colour swap', () => {
        const { f, gf } = grandFinalField();
        setSides(f.test, f.org, gf.id, gf.team2Id!);
        const row = matchRow(f.test, gf.id);
        expect(row.blueTeamId).toBe(gf.team2Id);
        expect(row.team1Games).toBe(row.winnerAdvantage);
        expect(row.team2Games).toBe(0);
        expect(tally(f.test, gf.id)).toEqual(derived(f.test, gf.id));
    });

    it('team2 seated on Blue, team1 on Red; the tally stays 1–0 for team1; a Red win (team1) decides 2–0 for team1', () => {
        const { f, gf } = grandFinalField();
        const t1 = entry(f, gf.team1Id);
        const t2 = entry(f, gf.team2Id);
        setSides(f.test, f.org, gf.id, gf.team2Id!);
        const row = matchRow(f.test, gf.id);
        expect(row.blueTeamId).toBe(gf.team2Id);
        expect(row.lastModifiedById).toBe(f.org.userId); // audited with the caller's id
        expect(tally(f.test, gf.id)).toEqual([1, 0]);
        expect(derived(f.test, gf.id)).toEqual([1, 0]);

        // Seating (A35 / A70(1)): auto-seat and set_team_slot follow the match's colours.
        const lobbyId = createTournamentLobby(f.test, f.org, gf.id);
        join(f.test, t2.captain, lobbyId);
        join(f.test, t1.captain, lobbyId);
        expect(slotOf(f.test, lobbyId, t2.captain)).toBe('BluePlayer');
        expect(slotOf(f.test, lobbyId, t1.captain)).toBe('RedPlayer');
        expectReject(f.test, t1.captain, (ctx) => M.set_team_slot(ctx, { lobbyId, targetUserId: t1.captain.userId, lobbySlot: { tag: 'BluePlayer' } as any }), SEAT);
        expectReject(f.test, f.org, (ctx) => M.set_team_slot(ctx, { lobbyId, targetUserId: t2.captain.userId, lobbySlot: { tag: 'RedPlayer' } as any }), SEAT);
        expectReject(f.test, f.org, (ctx) => M.set_team_slot(ctx, { lobbyId, targetUserId: t1.captain.userId, lobbySlot: { tag: 'BlueCoach' } as any }), SEAT);
        const lobby = lobbyRow(f.test, lobbyId);
        const allowed = (who: Actor) => tx(f.test, 'internal', (ctx) => allowedSlotsFor(ctx, lobby, who.userId));
        expect(allowed(t2.mate)).toEqual(expect.arrayContaining(['BluePlayer', 'BlueCoach', 'Spectator']));
        expect(allowed(t2.mate)).not.toContain('RedPlayer');
        expect(allowed(t1.mate)).toEqual(expect.arrayContaining(['RedPlayer', 'RedCoach', 'Spectator']));
        expect(allowed(t1.mate)).not.toContain('BluePlayer');
        join(f.test, t2.mate, lobbyId);
        join(f.test, t1.mate, lobbyId);
        expect(slotOf(f.test, lobbyId, t2.mate)).toBe('BluePlayer');
        expect(slotOf(f.test, lobbyId, t1.mate)).toBe('RedPlayer');
        for (const who of [t1.captain, t1.mate, t2.captain, t2.mate]) tx(f.test, who, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        tx(f.test, f.org, (ctx) => M.start_draft(ctx, { lobbyId }));

        playLobbyGame({ test: f.test, lobbyId, host: f.org, a: { host: f.org, b1: t2.captain, b2: t2.mate, r1: t1.captain, r2: t1.mate } }, 'Red');
        const [record] = recordsOfLobby(f.test, lobbyId);
        expect(record.winnerTeamSide?.tag).toBe('Red');
        const after = matchRow(f.test, gf.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Played');
        expect(after.winnerTeamId).toBe(gf.team1Id);
        expect(after.loserTeamId).toBe(gf.team2Id);
        expect([after.team1Games, after.team2Games]).toEqual([2, 0]);
    });

    it('a Blue win (team2) makes it 1–1; a second Blue win decides 1–2 for team2', () => {
        const { f, gf } = grandFinalField();
        setSides(f.test, f.org, gf.id, gf.team2Id!);
        const blue = entry(f, gf.team2Id);
        const red = entry(f, gf.team1Id);
        playLobbyGame(openLobbyBySides(f, gf.id, blue, red), 'Blue');
        expect(matchRow(f.test, gf.id).state.tag).toBe('Ready');
        expect(tally(f.test, gf.id)).toEqual([1, 1]);
        playLobbyGame(openLobbyBySides(f, gf.id, blue, red), 'Blue');
        const after = matchRow(f.test, gf.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.winnerTeamId).toBe(gf.team2Id);
        expect([after.team1Games, after.team2Games]).toEqual([1, 2]);
        expect(tally(f.test, gf.id)).toEqual(derived(f.test, gf.id));
    });
});

// ─── Concede, DQ and rollback under swapped sides (A70(1), A71(1)) ────────────

describe('A70(1): concede, DQ and rollback follow the match colours', () => {
    it('concede: Blue (team2) concedes → the game is credited to team1 (Red)', () => {
        const { f, m } = bo3Duel();
        setSides(f.test, f.org, m.id, m.team2Id!);
        const s = openLobbyBySides(f, m.id, entry(f, m.team2Id), entry(f, m.team1Id));
        tx(f.test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 1 })); // 1 = Blue
        const [record] = recordsOfLobby(f.test, s.lobbyId);
        expect(record.status.tag).toBe('Validated');
        expect(record.winnerTeamSide?.tag).toBe('Red');
        expect(tally(f.test, m.id)).toEqual([1, 0]);
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');
    });

    it('DQ of team2 (Blue) while game 2 is live: the force-concede is on Blue, credited to team1; decidedBy Dq; stored = derived', () => {
        const { f, m } = bo3Duel();
        setSides(f.test, f.org, m.id, m.team2Id!);
        const blue = entry(f, m.team2Id);
        const red = entry(f, m.team1Id);
        playLobbyGame(openLobbyBySides(f, m.id, blue, red), 'Blue'); // game 1 to team2
        expect(tally(f.test, m.id)).toEqual([0, 1]);
        const live = openLobbyBySides(f, m.id, blue, red);
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: blue.captain.userId, reason: 'no-show', dqWholeTeam: true }));
        const [conceded] = recordsOfLobby(f.test, live.lobbyId);
        expect(conceded.status.tag).toBe('Validated');
        expect(conceded.winnerTeamSide?.tag).toBe('Red'); // the Blue side (team2) conceded
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Dq');
        expect(after.winnerTeamId).toBe(m.team1Id);
        expect(tally(f.test, m.id)).toEqual([1, 1]);
        expect(tally(f.test, m.id)).toEqual(derived(f.test, m.id));
    });

    it('rollback: grand final with team2 on Blue decided 1–2 by two Blue wins; rollback voids the deciding game; 1–1 keeps the head start on team1; a Red replay decides for team1', () => {
        const { f, gf } = grandFinalField();
        setSides(f.test, f.org, gf.id, gf.team2Id!);
        const blue = entry(f, gf.team2Id);
        const red = entry(f, gf.team1Id);
        const l1 = openLobbyBySides(f, gf.id, blue, red);
        playLobbyGame(l1, 'Blue');
        const l2 = openLobbyBySides(f, gf.id, blue, red);
        playLobbyGame(l2, 'Blue');
        expect(matchRow(f.test, gf.id).winnerTeamId).toBe(gf.team2Id);
        const [r1] = recordsOfLobby(f.test, l1.lobbyId);
        const [r2] = recordsOfLobby(f.test, l2.lobbyId);
        rollback(f, gf.id);
        const back = matchRow(f.test, gf.id);
        expect(back.state.tag).toBe('Ready');
        expect(back.blueTeamId).toBe(gf.team2Id); // no slot of this match changed: the colours stand
        expect([back.team1Games, back.team2Games]).toEqual([1, 1]);
        expect(derived(f.test, gf.id)).toEqual([1, 1]);
        expect(f.test.db.MatchResultRecord.id.find(r2.id)!.status.tag).toBe('Voided');
        expect(f.test.db.MatchResultRecord.id.find(r1.id)!.status.tag).toBe('Validated');
        playLobbyGame(openLobbyBySides(f, gf.id, blue, red), 'Red');
        const replay = matchRow(f.test, gf.id);
        expect(replay.state.tag).toBe('Decided');
        expect(replay.winnerTeamId).toBe(gf.team1Id);
        expect([replay.team1Games, replay.team2Games]).toEqual([2, 1]);
    });
});

// ─── set_match_sides guards (A70(3), A71 guard order, A25) ────────────────────

describe('A70(3): set_match_sides guards', () => {
    it('a player of the match (not staff) is rejected', () => {
        const { f, m } = bo3Duel();
        const t1 = entry(f, m.team1Id);
        expectReject(f.test, t1.captain, sidesBody(m.id, m.team1Id!), NOT_AUTHORIZED);
        expectReject(f.test, verified(f.test, 'outsider'), sidesBody(m.id, m.team1Id!), NOT_AUTHORIZED);
        expect(matchRow(f.test, m.id).blueTeamId).toBeUndefined();
    });

    it('the organizer and an assistant with `bracket` are accepted; an assistant without it is rejected', () => {
        const { f, m } = bo3Duel();
        const withBracket = verified(f.test, 'asst-b');
        const without = verified(f.test, 'asst-pr');
        assignAssistant(f.test, f.org, f.id, withBracket, { bracket: true });
        assignAssistant(f.test, f.org, f.id, without, { participants: true, results: true });
        expectReject(f.test, without, sidesBody(m.id, m.team2Id!), NOT_AUTHORIZED);
        setSides(f.test, withBracket, m.id, m.team2Id!);
        expect(matchRow(f.test, m.id).blueTeamId).toBe(m.team2Id);
        expect(matchRow(f.test, m.id).lastModifiedById).toBe(withBracket.userId);
        setSides(f.test, f.org, m.id, m.team1Id!);
        expect(matchRow(f.test, m.id).blueTeamId).toBe(m.team1Id);
    });

    it('a Pending match is rejected', () => {
        const f = liveField(4, BO3);
        const final = byKey(f.test, f.id, 'W-R2-M1');
        expect(final.state.tag).toBe('Pending');
        expectReject(f.test, f.org, sidesBody(final.id, f.ts[0].teamId), 'W-R2-M1 is Pending; sides are set on a Ready match.');
    });

    it('a blueTeamId outside the match is rejected', () => {
        const f = liveField(4, BO3);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const other = f.ts.find((t) => t.teamId !== m.team1Id && t.teamId !== m.team2Id)!;
        expectReject(f.test, f.org, sidesBody(m.id, other.teamId), "blueTeamId must be one of the match's two teams.");
        expectReject(f.test, f.org, sidesBody(m.id, 999_999), "blueTeamId must be one of the match's two teams.");
    });

    it('a Waiting lobby of the match blocks; once it is closed the sides can be set', () => {
        const { f, m } = bo3Duel();
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        expect(lobbyRow(f.test, lobbyId).stage.tag).toBe('Waiting');
        expectReject(f.test, f.org, sidesBody(m.id, m.team2Id!), OPEN_LOBBY);
        expect(matchRow(f.test, m.id).blueTeamId).toBeUndefined();
        tx(f.test, f.org, (ctx) => M.close_lobby(ctx, { lobbyId }));
        setSides(f.test, f.org, m.id, m.team2Id!);
        expect(matchRow(f.test, m.id).blueTeamId).toBe(m.team2Id);
    });

    // A70(3) / A71 guard order: a Pending record means a game has started; the record guard runs before the lobby guard,
    // so the record's message wins although the lobby still exists.
    it('after start_draft (Pending record) the sides can no longer be changed ("a game of this match has started")', () => {
        const { f, m } = bo3Duel();
        const s = openMatchLobby(f, m.id);
        expect(recordsOfLobby(f.test, s.lobbyId)[0].status.tag).toBe('Pending');
        expect(lobbiesOf(f.test, m.id)).toHaveLength(1);
        expectReject(f.test, f.org, sidesBody(m.id, m.team2Id!), STARTED);
    });

    // A70(3) / A71 guard order: after a Validated game the lobby stays parked in AwaitingResult (A24(2)) and cannot be
    // closed (close_lobby is Waiting-only); the record guard answers first.
    it('after a Validated game (lobby parked) the sides can no longer be changed ("a game of this match has started")', () => {
        const { f, m } = bo3Duel();
        const [s] = playBracketMatch(f, m.id, ['Blue']);
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(recordsOfLobby(f.test, s.lobbyId)[0].status.tag).toBe('Validated');
        expectReject(f.test, f.org, sidesBody(m.id, m.team2Id!), STARTED);
    });

    it('the record guard on its own: Validated and Submitted records block once no lobby is left (direct row delete of the parked lobby)', () => {
        for (const over of [{}, { requireResultValidation: true }]) {
            const { f, m } = bo3Duel(over);
            const [s] = playBracketMatch(f, m.id, ['Blue']);
            const status = recordsOfLobby(f.test, s.lobbyId)[0].status.tag;
            expect(status).toBe(over.requireResultValidation ? 'Submitted' : 'Validated');
            f.test.db.Lobby.id.delete(s.lobbyId); // direct row edit: isolates the record guard from the lobby guard
            expect(lobbiesOf(f.test, m.id)).toHaveLength(0);
            expectReject(f.test, f.org, sidesBody(m.id, m.team2Id!), STARTED);
        }
    });

    it('after a rollback that voided the only game the sides can be set again; a Rejected record does not block either', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        playMatch(f, m.id, 'Blue');
        expect(matchRow(f.test, m.id).state.tag).toBe('Decided');
        rollback(f, m.id);
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');
        expect(recordsOfMatch(f.test, m.id).map((r) => r.status.tag)).toEqual(['Voided']);
        expect(lobbiesOf(f.test, m.id)).toHaveLength(0);
        setSides(f.test, f.org, m.id, m.team2Id!);
        expect(matchRow(f.test, m.id).blueTeamId).toBe(m.team2Id);

        const { f: g, m: gm } = bo3Duel({ requireResultValidation: true });
        const [s] = playBracketMatch(g, gm.id, ['Blue']);
        const [r] = recordsOfLobby(g.test, s.lobbyId);
        tx(g.test, g.org, (ctx) => M.override_match_result(ctx, { matchResultId: r.id, newStatusTag: 'Rejected', winnerTeamSideTag: '', reason: 'staff' }));
        expect(g.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Rejected');
        expect(lobbiesOf(g.test, gm.id)).toHaveLength(0);
        setSides(g.test, g.org, gm.id, gm.team2Id!);
        expect(matchRow(g.test, gm.id).blueTeamId).toBe(gm.team2Id);
    });

    it('re-setting the current value writes nothing (idempotent)', () => {
        const { f, gf } = grandFinalField();
        setSides(f.test, f.org, gf.id, gf.team2Id!);
        const first = matchRow(f.test, gf.id);
        advance(f.test, 60_000);
        const asst = verified(f.test, 'asst');
        assignAssistant(f.test, f.org, f.id, asst, { bracket: true });
        setSides(f.test, asst, gf.id, gf.team2Id!);
        const second = matchRow(f.test, gf.id);
        expect(second.lastModifiedDate).toEqual(first.lastModifiedDate);
        expect(second.lastModifiedById).toBe(f.org.userId);
        expect(second).toEqual(first);
    });

    it('a Completed tournament is rejected ("Tournament is over.")', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        resolveMatch(f.test, f.org, m.id, m.team1Id!);
        advanceStage(f.test, f.org, f.id, 'Completed');
        expectReject(f.test, f.org, sidesBody(m.id, m.team2Id!), 'Tournament is over.');
    });

    it('an unknown bracket match is rejected', () => {
        const { f } = bo3Duel();
        expectReject(f.test, f.org, sidesBody(999_999, 1), 'Bracket match not found.');
    });
});

// ─── S8g-B5 / A71(3): a slot change voids the colour choice ───────────────────

describe('A71(3): a slot change resets blueTeamId and the stored tally', () => {
    // Reducer path: the grand final's team2 slot comes from the losers final. Sides set on the grand final (team2 on
    // Blue), then the losers final is rolled back (the GF slot is un-placed) and re-decided for the other team (the slot
    // is placed again): both slot writes void the colour choice.
    function slotChangeField() {
        const { f, gf } = grandFinalField();
        const oldTeam2 = gf.team2Id!;
        setSides(f.test, f.org, gf.id, oldTeam2);
        expect(matchRow(f.test, gf.id).blueTeamId).toBe(oldTeam2);
        expect(tally(f.test, gf.id)).toEqual([1, 0]);
        const lbFinal = bracketRows(f.test, f.id).find((r) => r.nextWinnerMatchId === gf.id && r.bracketSide.tag === 'Losers')!;
        expect(lbFinal.winnerTeamId).toBe(oldTeam2);
        rollback(f, lbFinal.id);
        const unplaced = matchRow(f.test, gf.id);
        expect(unplaced.state.tag).toBe('Pending');
        expect(unplaced.blueTeamId).toBeUndefined(); // A71(3): un-placement voids the choice
        const lb = matchRow(f.test, lbFinal.id);
        const newTeam2 = lb.team1Id === oldTeam2 ? lb.team2Id! : lb.team1Id!;
        resolveMatch(f.test, f.org, lbFinal.id, newTeam2);
        const now = matchRow(f.test, gf.id);
        expect(now.state.tag).toBe('Ready');
        expect(now.team2Id).toBe(newTeam2);
        return { f, gf: now };
    }

    it('after the feeder rollback and re-decide: blueTeamId is unset; seating follows the default mapping (team1 Blue, new team2 Red)', () => {
        const { f, gf } = slotChangeField();
        expect(gf.blueTeamId).toBeUndefined();
        openLobbyBySides(f, gf.id, entry(f, gf.team1Id), entry(f, gf.team2Id)); // asserts Blue = team1, Red = team2
    });

    // A69(1) / A67(4) / A71(3): the stored tally equals the derived one at all times, including after a slot change.
    it('the stored grand-final tally equals the derived one after the slot change (team1Games = winnerAdvantage, team2Games = 0)', () => {
        const { f, gf } = slotChangeField();
        expect(tally(f.test, gf.id)).toEqual(derived(f.test, gf.id));
        expect(gf.team1Games).toBe(gf.winnerAdvantage);
        expect(gf.team2Games).toBe(0);
    });

    it('result credit and decision after the reset: a Blue win (team1) decides 2–0 for team1', () => {
        const { f, gf } = slotChangeField();
        playLobbyGame(openLobbyBySides(f, gf.id, entry(f, gf.team1Id), entry(f, gf.team2Id)), 'Blue');
        const after = matchRow(f.test, gf.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.winnerTeamId).toBe(gf.team1Id);
        expect([after.team1Games, after.team2Games]).toEqual([2, 0]);
    });

    it('slotChangeReset (pure): colours unset, tally back to the head start whatever the previous values', () => {
        expect(slotChangeReset({ winnerAdvantage: 1, blueTeamId: 7, team1Games: 1, team2Games: 2 })).toEqual({ blueTeamId: undefined, team1Games: 1, team2Games: 0 });
        expect(slotChangeReset({ winnerAdvantage: 0, blueTeamId: undefined, team1Games: 1, team2Games: 0 })).toEqual({ blueTeamId: undefined, team1Games: 0, team2Games: 0 });
    });

    // A70(1) read-side defence (kept by A71(3)): a blueTeamId that names neither team reads as the default.
    it('a stale blueTeamId (direct row edit) falls back to team1 = Blue for seating and the derived tally', () => {
        const { f, gf } = grandFinalField();
        f.test.db.BracketMatch.id.update({ ...matchRow(f.test, gf.id), blueTeamId: 999_999 });
        expect(matchRow(f.test, gf.id).blueTeamId).toBe(999_999);
        expect(derived(f.test, gf.id)).toEqual([1, 0]);
        playLobbyGame(openLobbyBySides(f, gf.id, entry(f, gf.team1Id), entry(f, gf.team2Id)), 'Blue');
        expect(matchRow(f.test, gf.id).winnerTeamId).toBe(gf.team1Id);
    });
});

// ─── S8g-B6: group-stage matches (user, 2026-11-08) ───────────────────────────

describe('A70(1): group-stage matches choose colours too', () => {
    const GROUP = { format: 'GroupOnly', groupSize: 4, groupAdvanceCount: 2, defaultBestOf: 1 };

    /** Plays the first group match with team2 winning: on Blue when sides are swapped, on Red by default. */
    function groupRun(swap: boolean) {
        const f = liveField(4, GROUP);
        const gm = bracketRows(f.test, f.id).filter((r) => r.bracketSide.tag === 'Group')
            .sort((a, b) => a.positionKey.localeCompare(b.positionKey))[0];
        expect(gm.state.tag).toBe('Ready');
        expect(gm.winnerAdvantage).toBe(0);
        const t1 = entry(f, gm.team1Id);
        const t2 = entry(f, gm.team2Id);
        if (swap) {
            setSides(f.test, f.org, gm.id, gm.team2Id!);
            const row = matchRow(f.test, gm.id);
            expect(row.blueTeamId).toBe(gm.team2Id);
            expect(tally(f.test, gm.id)).toEqual([0, 0]);
            expect(derived(f.test, gm.id)).toEqual([0, 0]);
        }
        const s = swap ? openLobbyBySides(f, gm.id, t2, t1) : openLobbyBySides(f, gm.id, t1, t2);
        playLobbyGame(s, swap ? 'Blue' : 'Red');
        const after = matchRow(f.test, gm.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.winnerTeamId).toBe(gm.team2Id);
        expect([after.team1Games, after.team2Games]).toEqual([0, 1]);
        const index = (teamId: number) => f.ts.findIndex((t) => t.teamId === teamId);
        const standings = tx(f.test, 'internal', (ctx) => groupStandings(ctx, f.id, gm.groupId!))
            .map((r) => ({ team: index(r.teamId), rank: r.rank, wins: r.wins, gameDiff: r.gameDiff }));
        return { positionKey: gm.positionKey, standings };
    }

    it('team2 on Blue on a Ready group match: team2 seated on Blue; a Blue win is credited to team2; standings equal the default-colour run', () => {
        const swapped = groupRun(true);
        const plain = groupRun(false);
        expect(swapped.positionKey).toBe(plain.positionKey);
        expect(swapped.standings).toEqual(plain.standings);
        const winner = swapped.standings.find((r) => r.wins === 1)!;
        expect(winner.gameDiff).toBe(1);
    });

    it('type level: set_match_sides takes two arguments only (A71(2))', () => {
        type Args = Parameters<typeof M.set_match_sides>[1];
        expectTypeOf<Args>().toEqualTypeOf<{ bracketMatchId: number; blueTeamId: number }>();
        // Never executed: the removed argument does not compile.
        const _check = (ctx: any) =>
            // @ts-expect-error headStartSide was removed by A71(2)
            M.set_match_sides(ctx, { bracketMatchId: 1, blueTeamId: 1, headStartSide: { tag: 'Blue' } });
        expect(_check).toBeTypeOf('function');
    });
});

// ─── Public row (A37) ─────────────────────────────────────────────────────────

describe('A70(1), A71(2), A37: the public BracketMatch row', () => {
    it('type level: blueTeamId present, headStartSide absent; no user id column added', () => {
        type Row = ReturnType<typeof matchRow>;
        expectTypeOf<Row>().toHaveProperty('blueTeamId');
        expectTypeOf<Row>().not.toHaveProperty('headStartSide');
        expectTypeOf<Row['blueTeamId']>().toEqualTypeOf<number | undefined>();
        expect(Object.keys(bracketMatchColumns)).not.toContain('headStartSide');
        const userColumns = Object.keys(bracketMatchColumns).filter((k) => /user/i.test(k));
        expect(userColumns).toEqual([]);
        const idColumns = Object.keys(bracketMatchColumns).filter((k) => /Id$/.test(k)).sort();
        expect(idColumns).toEqual([
            'blueTeamId', 'createdById', 'groupId', 'lastModifiedById', 'loserTeamId', 'nextLoserMatchId',
            'nextWinnerMatchId', 'team1Id', 'team2Id', 'tournamentId', 'winnerTeamId',
        ].sort());
    });
});
