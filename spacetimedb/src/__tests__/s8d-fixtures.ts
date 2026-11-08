// T-S8d: builders for the S8d in-memory tests (tournament lobbies, the one record per lobby, the result → bracket
// hand-off, finalization at Completed / Cancelled; T-S8e: one game per lobby, A67). Not a test file: imported by s8d-*.test.ts.
// Reuses the S4 / S7 / S8 builders. Tournament lobbies are created and played through the module's reducers; HSR
// accounts, roles and the EloConfig row are written straight into the in-memory datastore (or through the internal
// owner), like the earlier suites. `test.db` is read only outside `tx` bodies. Nothing reaches maincloud.
import { expect } from 'vitest';
import { M, guest, lobbyRow, session, tx, type Actor, type Harness, type Lobby } from './s4-fixtures';
import { finishGame } from './s7-fixtures';
import { bracketByKey, insertHsrAccount, liveField, matchRow, type TournamentArgs } from './s8-fixtures';

export type Field = ReturnType<typeof liveField>;
export type TeamEntry = Field['ts'][number];

/** The live lobbies of a bracket match (Lobby.bracket_match_id). */
export const lobbiesOf = (test: Harness, bracketMatchId: number) => [...test.db.Lobby.bracket_match_id.filter(bracketMatchId)];
export const recordsOfMatch = (test: Harness, bracketMatchId: number) => [...test.db.MatchResultRecord.bracket_match_id.filter(bracketMatchId)];
export const recordsOfLobby = (test: Harness, lobbyId: number) => [...test.db.MatchResultRecord.lobby_id.filter(lobbyId)];
export const historyOf = (test: Harness, tournamentId: number) => [...test.db.MatchSessionHistory.tournament_id.filter(tournamentId)];
export const jobsOf = (test: Harness, tournamentId: number) => [...test.db.TournamentFinalizeJob.tournament_id.filter(tournamentId)];
export const byKey = (test: Harness, tournamentId: number, key: string) => bracketByKey(test, tournamentId).get(key)!;

/** The bracket entries (captain + mate) of a match's team1 (Blue, A35) and team2 (Red). */
export function sidesOf(f: Field, bracketMatchId: number): { blue: TeamEntry; red: TeamEntry } {
    const m = matchRow(f.test, bracketMatchId);
    return {
        blue: f.ts.find((t) => t.teamId === m.team1Id)!,
        red: f.ts.find((t) => t.teamId === m.team2Id)!,
    };
}

/** create_tournament_lobby as `who`; returns the new lobby's id (T-S8e: earlier lobbies of the match may be parked). */
export function createTournamentLobby(test: Harness, who: Actor, bracketMatchId: number): number {
    const before = new Set(lobbiesOf(test, bracketMatchId).map((l) => l.id));
    tx(test, who, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId, joinCode: '' }));
    const created = lobbiesOf(test, bracketMatchId).filter((l) => !before.has(l.id));
    expect(created).toHaveLength(1);
    return created[0].id;
}

export const join = (test: Harness, who: Actor, lobbyId: number) =>
    tx(test, who, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' }));

export interface OpenOpts {
    /** The lobby creator (default: the organizer, a Spectator referee). */
    creator?: Actor;
    /** Stop in Waiting (no start_draft). */
    noStart?: boolean;
}

/**
 * Opens the lobby of a bracket match: the creator creates it, the four players join (auto-seated on their team's side,
 * A35) and confirm; a Ranked lobby (countTowardsMmr) gets an HSR account per player (D-08); the creator starts the
 * draft. Actors in `a`: b1 / b2 = team1 captain / mate (Blue), r1 / r2 = team2 (Red), host = the creator.
 */
export function openMatchLobby(f: Field, bracketMatchId: number, opts: OpenOpts = {}): Lobby {
    const { test } = f;
    const creator = opts.creator ?? f.org;
    const { blue, red } = sidesOf(f, bracketMatchId);
    const lobbyId = createTournamentLobby(test, creator, bracketMatchId);
    const a: Record<string, Actor> = { host: creator, b1: blue.captain, b2: blue.mate, r1: red.captain, r2: red.mate };
    for (const name of ['b1', 'b2', 'r1', 'r2']) {
        const who = a[name];
        if (who.userId !== creator.userId) join(test, who, lobbyId);
        tx(test, who, (ctx) => M.confirm_ready(ctx, { lobbyId }));
    }
    if (lobbyRow(test, lobbyId).matchType.tag === 'Ranked') {
        for (const name of ['b1', 'b2', 'r1', 'r2']) {
            const accountId = insertHsrAccount(test, a[name].userId, `${lobbyId}-${name}`);
            test.db.LobbyMemberAccount.insert({ lobbyId, userId: a[name].userId, hsrAccountId: accountId });
        }
    }
    const s: Lobby = { test, lobbyId, host: creator, a };
    if (!opts.noStart) tx(test, creator, (ctx) => M.start_draft(ctx, { lobbyId }));
    return s;
}

const actorOf = (s: Lobby, userId: number): Actor => Object.values(s.a).find((x) => x.userId === userId)!;
export function captainActor(s: Lobby, team: 'Blue' | 'Red'): Actor {
    const slot = team === 'Blue' ? 'BluePlayer' : 'RedPlayer';
    const row = [...s.test.db.LobbyMember.lobby_id.filter(s.lobbyId)].find((m) => m.lobbySlot.tag === slot && m.isCaptain)!;
    return actorOf(s, row.userId);
}

/** Drafts the lobby's Classic game to Equipping: each step by the acting team's captain (T-S8e: one game per lobby). */
export function draftGame(s: Lobby, prefix = 'c') {
    const game = 1; // T-S8e (A67(3)): no game number; the name shape of S8d is kept
    let guard = 0;
    while (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting' && guard++ < 60) {
        const sess = session(s.test, s.lobbyId);
        const step = sess.draftSequence[sess.turnIndex];
        const who = captainActor(s, step.teamTurn.tag as 'Blue' | 'Red');
        const characterName = `${prefix}${game}_${sess.turnIndex}`;
        if (step.actionRequired.tag === 'Pick') {
            tx(s.test, who, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 }));
        } else {
            tx(s.test, who, (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName }));
        }
    }
    expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
}

/** T-S8e (A67(1)): plays the lobby's one game: drafted, then closed by the host referee for `winner` (→ AwaitingResult). */
export function playLobbyGame(s: Lobby, winner: 'Blue' | 'Red') {
    if (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting') draftGame(s);
    finishGame(s, winner);
    expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
}

/**
 * Opens, plays and parks one lobby (one game, A67) of a bracket match; team1 (Blue) or team2 (Red) wins it. In a Bo1
 * that game decides the match; in a Bo3 it moves the derived tally only (playBracketMatch plays several lobbies).
 */
export function playMatch(f: Field, bracketMatchId: number, winner: 'Blue' | 'Red', opts: OpenOpts = {}): Lobby {
    const s = openMatchLobby(f, bracketMatchId, opts);
    playLobbyGame(s, winner);
    return s;
}

/** T-S8e: one lobby per game, in order (each parks before the next is created, D-45 / A67(5)). */
export function playBracketMatch(f: Field, bracketMatchId: number, winners: Array<'Blue' | 'Red'>, opts: OpenOpts = {}): Lobby[] {
    return winners.map((w) => playMatch(f, bracketMatchId, w, opts));
}

/** validate_match_result as `who` on the lobby's one record. */
export function validate(test: Harness, who: Actor, lobbyId: number) {
    const record = recordsOfLobby(test, lobbyId)[0];
    tx(test, who, (ctx) => M.validate_match_result(ctx, { matchResultId: record.id }));
}

/** The EloConfig row (Admin reducer through the internal owner = SYSTEM Admin). */
export const seedElo = (test: Harness) => tx(test, 'internal', (ctx) => M.admin_seed_elo_config(ctx, {}));

/**
 * One scheduler firing of the finalize job: the single job row of the tournament is consumed (deleted) and
 * run_tournament_finalize is called with it by the internal sender, as the S4 / S6 suites drive scheduled reducers.
 */
export function tick(test: Harness, tournamentId: number) {
    const rows = jobsOf(test, tournamentId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    test.db.TournamentFinalizeJob.scheduledId.delete(row.scheduledId);
    tx(test, 'internal', (ctx) => M.run_tournament_finalize(ctx, { arg: row }));
}

/** Ticks until the job row is gone (bounded); returns the number of ticks. */
export function drain(test: Harness, tournamentId: number, max = 20): number {
    let n = 0;
    while (jobsOf(test, tournamentId).length > 0 && n < max) {
        tick(test, tournamentId);
        n++;
    }
    expect(jobsOf(test, tournamentId)).toHaveLength(0);
    return n;
}

/** liveField over a 2-team single elimination (one final, Bo1 by default). */
export const duel = (over: Partial<TournamentArgs> = {}) => liveField(2, over);

/** A fresh verified-free guest (outsider). */
export const outsider = (test: Harness, name = 'outsider') => guest(test, name);
