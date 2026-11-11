// Tournaments: series in the bracket; the match tally derived from Validated records, one game per lobby.
// Decisions: A60, A67, D-45
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S8e (s8e-bracket-series.test.ts).
//
// T-S8e: in-memory tests for A67: one lobby per game, the bracket match is the only series. The derived tally
// (team1Games / team2Games = head start + Validated records won by Blue / Red, A27, A35), the decision at
// ceil(bestOf / 2), concede as a Validated game, D-45 with the game cap (A67(5)), rollback of the deciding record,
// resolve keeping Validated games (A67(8)), override while Decided (A67(4)), the finalize job with several records
// per match (A67(7)(8)), one game per record (A67(3)), the removed lobby / preset arguments (A67(2)), ensureOpenGame
// (A60(7)), the stage lists of concede / claim_forfeit / defer and the lobby GC (A67(1)). Builders in s4 / s7 / s8 /
// s8d fixtures. Nothing reaches maincloud.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { M, advance, disconnect, expectReject, guest, lobbyRow, newHarness, setupLobby, tx, type Harness, type Lobby } from '../fixtures/harness';
import { finishGame, setRole } from '../fixtures/draft-and-scoring-builders';
import { advanceStage, bracketRows, liveField, matchRow, resolveMatch, tRow } from '../fixtures/tournament-builders';
import {
    byKey,
    draftGame,
    drain,
    historyOf,
    jobsOf,
    lobbiesOf,
    openMatchLobby,
    playBracketMatch,
    playLobbyGame,
    playMatch,
    recordsOfLobby,
    recordsOfMatch,
    seedElo,
    deferredDuel,
    tick,
    validate,
    type Field,
} from '../fixtures/tournament-match-builders';
import { matchGames } from '@module/helpers/tournament/bracketResults';
import { tournamentRecordsInBracketOrder } from '@module/helpers/tournament/tournamentResults';
import { ensureEditableRecord, ensureOpenGame } from '@module/helpers/results/scoringHelpers';
import { parkedLobby } from '../fixtures/ranked-game-builders';

const BO3 = { defaultBestOf: 3, grandFinalBestOf: 3 };
const IN_PLAY = 'A lobby for this bracket match is still in play.';
const OVERRIDE = 'This game can no longer be edited here; corrections go through override_match_result.'; // A69(2)
const tally = (test: Harness, matchId: number) => {
    const r = matchRow(test, matchId);
    return [r.team1Games, r.team2Games];
};
const derived = (test: Harness, matchId: number) => {
    const r = matchRow(test, matchId);
    const g = tx(test, 'internal', (ctx) => matchGames(ctx, r));
    return [g.team1, g.team2];
};
const createLobby = (f: Field, bracketMatchId: number) => (ctx: any) => M.create_tournament_lobby(ctx, { bracketMatchId });
const rollback = (f: Field, bracketMatchId: number) =>
    tx(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId, reason: 'replay' }));
const override = (f: Field, matchResultId: number, newStatusTag: string, winnerTeamSideTag = '') =>
    tx(f.test, f.org, (ctx) => M.override_match_result(ctx, { matchResultId, newStatusTag, winnerTeamSideTag, reason: 'staff' }));
const concede = (s: Lobby, losingTeamSide: 1 | 2) =>
    tx(s.test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide }));

/** A 2-team single elimination whose only match is a Bo3 (W-R1-M1). */
function bo3Duel(over: Record<string, unknown> = {}) {
    const f = liveField(2, { ...BO3, ...over });
    const m = byKey(f.test, f.id, 'W-R1-M1');
    expect(m.bestOf).toBe(3);
    return { f, m };
}

/** A 4-team double elimination with a Bo3 grand final and winnerAdvantage 1; staff settle every other match. */
function grandFinalField() {
    const f = liveField(4, { format: 'DoubleElimination', grandFinalBestOf: 3, winnerAdvantage: 1 });
    const gfOf = () => bracketRows(f.test, f.id).find((r) => r.bracketSide.tag === 'GrandFinals')!;
    for (let guard = 0; matchRow(f.test, gfOf().id).state.tag !== 'Ready' && guard < 10; guard++) {
        const ready = bracketRows(f.test, f.id).find((r) => r.state.tag === 'Ready' && r.id !== gfOf().id)!;
        resolveMatch(f.test, f.org, ready.id, ready.team1Id!);
    }
    const gf = matchRow(f.test, gfOf().id);
    expect(gf.state.tag).toBe('Ready');
    expect(gf.bestOf).toBe(3);
    expect(gf.winnerAdvantage).toBe(1);
    return { f, gf };
}

// ─── The derived tally (A67(4), A27, A35) ─────────────────────────────────────

describe('A67(4): the bracket match tally is derived from its Validated records', () => {
    it('Bo3: Blue (team1) wins game 1 → 1–0, Ready; Red wins game 2 → 1–1; game 3 decides with the right winner and routes', () => {
        const f = liveField(4, BO3);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        playBracketMatch(f, m.id, ['Blue']);
        expect(tally(f.test, m.id)).toEqual([1, 0]);
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');
        playBracketMatch(f, m.id, ['Red']);
        expect(tally(f.test, m.id)).toEqual([1, 1]);
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');
        playBracketMatch(f, m.id, ['Red']);
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Played');
        expect(after.winnerTeamId).toBe(m.team2Id);
        expect(after.loserTeamId).toBe(m.team1Id);
        expect([after.team1Games, after.team2Games]).toEqual([1, 2]);
        // S8c routing: the winner fills its exact slot of the next match.
        const next = matchRow(f.test, final.id);
        expect(m.nextWinnerSlot === 1 ? next.team1Id : next.team2Id).toBe(m.team2Id);
        expect(lobbiesOf(f.test, m.id).map((l) => l.stage.tag)).toEqual(['AwaitingResult', 'AwaitingResult', 'AwaitingResult']);
    });

    it('Bo1: one Validated record decides', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        expect(m.bestOf).toBe(1);
        playMatch(f, m.id, 'Red');
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.winnerTeamId).toBe(m.team2Id);
        expect([after.team1Games, after.team2Games]).toEqual([0, 1]);
    });

    it('head start (grand final, winnerAdvantage 1, Bo3): the derived tally before any game is 1–0; one Blue win decides', () => {
        const { f, gf } = grandFinalField();
        expect(derived(f.test, gf.id)).toEqual([1, 0]);
        playMatch(f, gf.id, 'Blue');
        const after = matchRow(f.test, gf.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.winnerTeamId).toBe(gf.team1Id);
        expect([after.team1Games, after.team2Games]).toEqual([2, 0]);
    });

    it('head start: two Red wins decide for team2 (1–2)', () => {
        const { f, gf } = grandFinalField();
        playMatch(f, gf.id, 'Red');
        expect(matchRow(f.test, gf.id).state.tag).toBe('Ready');
        expect(tally(f.test, gf.id)).toEqual([1, 1]);
        playMatch(f, gf.id, 'Red');
        const after = matchRow(f.test, gf.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.winnerTeamId).toBe(gf.team2Id);
        expect([after.team1Games, after.team2Games]).toEqual([1, 2]);
    });

    // A69(1) (ruled on the first S8e report): the head start sits on the bracket row from generation, so the stored
    // tally equals the derived one before any game.
    it('head start: the stored BracketMatch tally shows 1–0 before any game (A67(4) "tally = head start + Validated games")', () => {
        const { f, gf } = grandFinalField();
        expect(tally(f.test, gf.id)).toEqual([1, 0]);
    });

    it('A69(1): a Bo3 grand final with winnerAdvantage 1 reads 1–0 at generation (Pending, both slots empty) and still 1–0 once Ready; a single-elimination final reads 0–0', () => {
        const f = liveField(4, { format: 'DoubleElimination', grandFinalBestOf: 3, winnerAdvantage: 1 });
        const gfOf = () => bracketRows(f.test, f.id).find((r) => r.bracketSide.tag === 'GrandFinals')!;
        const gen = gfOf();
        expect(gen.state.tag).toBe('Pending');
        expect([gen.team1Id, gen.team2Id]).toEqual([undefined, undefined]);
        expect([gen.bestOf, gen.winnerAdvantage]).toEqual([3, 1]);
        expect(tally(f.test, gen.id)).toEqual([1, 0]);
        for (let guard = 0; gfOf().state.tag !== 'Ready' && guard < 10; guard++) {
            const ready = bracketRows(f.test, f.id).find((r) => r.state.tag === 'Ready' && r.id !== gen.id)!;
            resolveMatch(f.test, f.org, ready.id, ready.team1Id!);
        }
        expect(gfOf().state.tag).toBe('Ready');
        expect(tally(f.test, gen.id)).toEqual([1, 0]);
        expect(derived(f.test, gen.id)).toEqual([1, 0]);

        const se = liveField(4, { ...BO3 });
        const final = byKey(se.test, se.id, 'W-R2-M1');
        expect(final.winnerAdvantage).toBe(0);
        expect(tally(se.test, final.id)).toEqual([0, 0]);
        for (const r of bracketRows(se.test, se.id)) expect([r.team1Games, r.team2Games], r.positionKey).toEqual([0, 0]);
    });

    it('a concede is a Validated game: it moves the tally; a deciding concede decides (decidedBy Concede)', () => {
        const { f, m } = bo3Duel();
        concede(openMatchLobby(f, m.id), 2); // Red concedes game 1
        expect(tally(f.test, m.id)).toEqual([1, 0]);
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');
        expect(recordsOfMatch(f.test, m.id).map((r) => r.status.tag)).toEqual(['Validated']);
        concede(openMatchLobby(f, m.id), 2);
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Concede');
        expect(after.winnerTeamId).toBe(m.team1Id);
        expect([after.team1Games, after.team2Games]).toEqual([2, 0]);
    });

    it('Pending, Submitted, Disputed, Rejected and Voided records do not count', () => {
        const { f, m } = bo3Duel({ requireResultValidation: true });
        const live = openMatchLobby(f, m.id); // Drafting: a Pending record
        expect(recordsOfLobby(f.test, live.lobbyId)[0].status.tag).toBe('Pending');
        expect(derived(f.test, m.id)).toEqual([0, 0]);
        playLobbyGame(live, 'Blue');
        const [g1] = recordsOfLobby(f.test, live.lobbyId);
        expect(g1.status.tag).toBe('Submitted');
        expect(tally(f.test, m.id)).toEqual([0, 0]);
        expect(derived(f.test, m.id)).toEqual([0, 0]);
        tx(f.test, live.a.r1, (ctx) => M.dispute_match_result(ctx, { matchResultId: g1.id, reason: 'lag' }));
        expect(recordsOfLobby(f.test, live.lobbyId)[0].status.tag).toBe('Disputed');
        expect(derived(f.test, m.id)).toEqual([0, 0]);
        override(f, g1.id, 'Rejected'); // the lobby is voided, the record kept as Rejected
        expect(f.test.db.MatchResultRecord.id.find(g1.id)!.status.tag).toBe('Rejected');
        expect(derived(f.test, m.id)).toEqual([0, 0]);
        expect(tally(f.test, m.id)).toEqual([0, 0]);

        const g2 = playMatch(f, m.id, 'Red');
        validate(f.test, f.org, g2.lobbyId);
        expect(tally(f.test, m.id)).toEqual([0, 1]);
        const g3 = playMatch(f, m.id, 'Red');
        validate(f.test, f.org, g3.lobbyId); // decides 0–2
        expect(matchRow(f.test, m.id).state.tag).toBe('Decided');
        rollback(f, m.id); // voids the deciding record (g3)
        expect(f.test.db.Lobby.id.find(g3.lobbyId)).toBeFalsy(); // the lobby is gone; the record is kept Voided
        expect(recordsOfLobby(f.test, g3.lobbyId).map((r) => r.status.tag)).toEqual(['Voided']);
        expect(recordsOfMatch(f.test, m.id).map((r) => r.status.tag).sort()).toEqual(['Rejected', 'Validated', 'Voided']);
        expect(tally(f.test, m.id)).toEqual([0, 1]);
        expect(derived(f.test, m.id)).toEqual([0, 1]);
    });
});

// ─── D-45 and the cap (A67(5)) ────────────────────────────────────────────────

describe('A67(5): create_tournament_lobby D-45 and the game cap', () => {
    it('a second lobby is rejected while the first is Drafting and while it is parked with a Submitted record; allowed once Validated', () => {
        const { f, m } = bo3Duel({ requireResultValidation: true });
        const first = openMatchLobby(f, m.id);
        expect(lobbyRow(f.test, first.lobbyId).stage.tag).toBe('Drafting');
        expectReject(f.test, f.org, createLobby(f, m.id), IN_PLAY);
        playLobbyGame(first, 'Blue'); // AwaitingResult, Submitted
        expect(recordsOfLobby(f.test, first.lobbyId)[0].status.tag).toBe('Submitted');
        expectReject(f.test, f.org, createLobby(f, m.id), IN_PLAY);
        validate(f.test, f.org, first.lobbyId);
        expect(lobbyRow(f.test, first.lobbyId).stage.tag).toBe('AwaitingResult'); // parked, settled
        const second = openMatchLobby(f, m.id, { noStart: true });
        expect(lobbyRow(f.test, second.lobbyId).stage.tag).toBe('Waiting');
        expectReject(f.test, f.org, createLobby(f, m.id), IN_PLAY); // a Waiting lobby is in play too
        expect(lobbiesOf(f.test, m.id)).toHaveLength(2);
    });

    it('rejected once the match is decided', () => {
        const { f, m } = bo3Duel();
        playBracketMatch(f, m.id, ['Blue', 'Blue']);
        expect(matchRow(f.test, m.id).state.tag).toBe('Decided');
        expectReject(f.test, f.org, createLobby(f, m.id), 'W-R1-M1 is Decided; a lobby needs a Ready match.');
    });

    // No reducer path leaves a Ready match at the cap or with a deciding tally (rollback re-decides, S8e review), so
    // the two defensive guards are reached through direct row edits, like the S8b / S8c guard tests (stampGenerated).
    it('rejected at the cap (Validated records ≥ bestOf) and when the derived tally already decides the match (direct row edits)', () => {
        const { f, m } = bo3Duel();
        playBracketMatch(f, m.id, ['Blue']); // 1–0, Ready, one Validated record
        const row = matchRow(f.test, m.id);
        f.test.db.BracketMatch.id.update({ ...row, winnerAdvantage: 1 }); // derived 2–0 on a Ready Bo3
        expectReject(f.test, f.org, createLobby(f, m.id), 'This bracket match is decided by its games.');
        f.test.db.BracketMatch.id.update({ ...row, bestOf: 1 }); // one Validated record = the cap of a Bo1
        expectReject(f.test, f.org, createLobby(f, m.id), 'This bracket match has no games left (best of 1).');
        f.test.db.BracketMatch.id.update(row);
        expect(openMatchLobby(f, m.id, { noStart: true }).lobbyId).toBeGreaterThan(0); // the untouched row takes game 2
    });

    it('2–0 by play, staff resolve for the other team, rollback: the games re-decide the match (Played, S8e review)', () => {
        const { f, m } = bo3Duel();
        playBracketMatch(f, m.id, ['Blue', 'Blue']);
        resolveMatch(f.test, f.org, m.id, m.team2Id!); // every game kept, decidedBy Staff
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Staff');
        rollback(f, m.id); // a staff decision has no deciding record; the 2–0 tally decides again
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Played');
        expect(after.winnerTeamId).toBe(m.team1Id);
        expect([after.team1Games, after.team2Games]).toEqual([2, 0]);
        expect(recordsOfMatch(f.test, m.id).map((r) => r.status.tag)).toEqual(['Validated', 'Validated']);
    });
});

// ─── Rollback, resolve, override (A67(4)(8)) ──────────────────────────────────

describe('A67(4): rollback of a decided Bo3 voids the deciding record only', () => {
    it('games Blue, Red, Blue → decided 2–1; rollback voids game 3 and deletes its lobby; games 1–2 stay; 1–1, Ready; a replay decides', () => {
        const { f, m } = bo3Duel();
        const [l1, l2, l3] = playBracketMatch(f, m.id, ['Blue', 'Red', 'Blue']);
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team1Id);
        const [r1] = recordsOfLobby(f.test, l1.lobbyId);
        const [r2] = recordsOfLobby(f.test, l2.lobbyId);
        const [r3] = recordsOfLobby(f.test, l3.lobbyId);
        rollback(f, m.id);
        const back = matchRow(f.test, m.id);
        expect(back.state.tag).toBe('Ready');
        expect(back.winnerTeamId).toBeUndefined();
        expect(back.decidedBy).toBeUndefined();
        expect([back.team1Games, back.team2Games]).toEqual([1, 1]);
        expect(f.test.db.MatchResultRecord.id.find(r3.id)!.status.tag).toBe('Voided');
        expect(f.test.db.Lobby.id.find(l3.lobbyId)).toBeFalsy();
        for (const [r, l] of [[r1, l1], [r2, l2]] as const) {
            expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Validated');
            expect(lobbyRow(f.test, l.lobbyId).stage.tag).toBe('AwaitingResult');
        }
        playMatch(f, m.id, 'Red');
        const replay = matchRow(f.test, m.id);
        expect(replay.state.tag).toBe('Decided');
        expect(replay.winnerTeamId).toBe(m.team2Id);
        expect([replay.team1Games, replay.team2Games]).toEqual([1, 2]);
    });

    // T-S10g (tournament audit #3): a match decided through an override (decidedBy Staff) whose winner the tally gives
    // is rolled back like a played decision: the deciding record is voided and the match returns to Ready.
    it('rollback of a match decided through override_match_result voids the deciding record and returns the match to Ready (audit #3)', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        override(f, r.id, 'Validated', 'Blue'); // decides the Bo1 (decidedBy Staff)
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Staff');
        rollback(f, m.id);
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Ready');
        expect(after.decidedBy).toBeUndefined();
        expect(after.winnerTeamId).toBeUndefined();
        expect([after.team1Games, after.team2Games]).toEqual([0, 0]);
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Voided');
        expect(f.test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });
});

describe('A67(8): resolve_bracket_match keeps Validated games, voids the live lobby', () => {
    it('one Validated game parked and one lobby in Drafting: the game stays, the live lobby is voided, the staff result applies', () => {
        const { f, m } = bo3Duel();
        const [done] = playBracketMatch(f, m.id, ['Blue']);
        const live = openMatchLobby(f, m.id);
        const [kept] = recordsOfLobby(f.test, done.lobbyId);
        const [pending] = recordsOfLobby(f.test, live.lobbyId);
        resolveMatch(f.test, f.org, m.id, m.team2Id!);
        expect(f.test.db.MatchResultRecord.id.find(kept.id)!.status.tag).toBe('Validated');
        expect(lobbyRow(f.test, done.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(f.test.db.MatchResultRecord.id.find(pending.id)!.status.tag).toBe('Voided');
        expect(f.test.db.Lobby.id.find(live.lobbyId)).toBeFalsy();
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Staff');
        expect(after.winnerTeamId).toBe(m.team2Id);
        expect([after.team1Games, after.team2Games]).toEqual([1, 0]); // the current tally
    });
});

describe('A67(4) (S8e review): override_match_result on a game of a Decided match reverts and re-decides', () => {
    it('a decided Bo1: the override flips the winner and re-routes; nothing is voided', () => {
        const f = liveField(4, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const s = playMatch(f, m.id, 'Blue');
        const slot = () => { const r = matchRow(f.test, final.id); return m.nextWinnerSlot === 1 ? r.team1Id : r.team2Id; };
        expect(slot()).toBe(m.team1Id);
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        override(f, r.id, 'Validated', 'Red');
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.winnerTeamId).toBe(m.team2Id);
        expect(after.decidedBy?.tag).toBe('Staff');
        expect([after.team1Games, after.team2Games]).toEqual([0, 1]);
        expect(slot()).toBe(m.team2Id);
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Validated');
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });

    it('a 2–0 Bo3: overriding game 1 to Red leaves game 2 Validated; 1–1 re-decides nothing (Ready, slot cleared)', () => {
        const f = liveField(4, BO3);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const [l1, l2] = playBracketMatch(f, m.id, ['Blue', 'Blue']);
        expect(matchRow(f.test, m.id).state.tag).toBe('Decided');
        const [r1] = recordsOfLobby(f.test, l1.lobbyId);
        const [r2] = recordsOfLobby(f.test, l2.lobbyId);
        override(f, r1.id, 'Validated', 'Red');
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Ready');
        expect([after.team1Games, after.team2Games]).toEqual([1, 1]);
        expect(after.winnerTeamId).toBeUndefined();
        const r = matchRow(f.test, final.id);
        expect(m.nextWinnerSlot === 1 ? r.team1Id : r.team2Id).toBeUndefined();
        expect(f.test.db.MatchResultRecord.id.find(r2.id)!.status.tag).toBe('Validated');
        for (const l of [l1, l2]) expect(lobbyRow(f.test, l.lobbyId).stage.tag).toBe('AwaitingResult');
        playMatch(f, m.id, 'Red'); // the decider: 1–2
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team2Id);
    });
});

describe('A67(4) (S8e review): dq_participant and the stored tally', () => {
    it('DQ of team2 while game 2 is live: the force-concede counts, the stored tally equals the derived one (decidedBy Dq)', () => {
        const { f, m } = bo3Duel();
        playBracketMatch(f, m.id, ['Blue']);
        const live = openMatchLobby(f, m.id);
        const red = live.a.r1;
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: red.userId, reason: 'no-show', dqWholeTeam: true }));
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Dq');
        expect(after.winnerTeamId).toBe(m.team1Id);
        expect(tally(f.test, m.id)).toEqual(derived(f.test, m.id));
        expect(recordsOfMatch(f.test, m.id).filter((r) => r.status.tag === 'Validated')).toHaveLength(2);
        expect(tally(f.test, m.id)).toEqual([2, 0]);
    });
});

// ─── The finalize job (A67(7)(8)) ─────────────────────────────────────────────

describe('A67(7)(8): the finalize job with several records per match', () => {
    it('4-team SE Bo3 MMR tournament: bracket order then creation order; each record finalized once; MMR per record; one leaderboard rebuild', () => {
        const f = liveField(4, { ...BO3, countTowardsMmr: true });
        seedElo(f.test);
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const play = (matchId: number, winners: Array<'Blue' | 'Red'>) =>
            winners.map((w) => {
                const s = playMatch(f, matchId, w);
                expect(lobbyRow(f.test, s.lobbyId).matchType.tag).toBe('Ranked');
                validate(f.test, f.org, s.lobbyId); // countTowardsMmr forces validation
                advance(f.test, 1_000);
                return recordsOfLobby(f.test, s.lobbyId)[0].id;
            });
        const m1Records = play(m1.id, ['Blue', 'Blue']);
        const m2Records = play(m2.id, ['Red', 'Blue', 'Red']);
        const final = byKey(f.test, f.id, 'W-R2-M1');
        expect(final.state.tag).toBe('Ready');
        const finalRecords = play(final.id, ['Blue', 'Blue']);
        expect(matchRow(f.test, final.id).state.tag).toBe('Decided');

        const expected = [...m1Records, ...m2Records, ...finalRecords];
        expect(tx(f.test, 'internal', (ctx) => tournamentRecordsInBracketOrder(ctx, f.id)).map((r: any) => r.id)).toEqual(expected);

        const m1Players = [...f.test.db.MatchResultParticipant.match_result_id.filter(m1Records[0])].map((p) => p.userId);
        expect(m1Players).toHaveLength(4);
        expect([...f.test.db.MmrHistory.iter()]).toHaveLength(0);
        advanceStage(f.test, f.org, f.id, 'Completed');

        tick(f.test, f.id); // K = 4: m1's two records, then m2's first two
        expect(historyOf(f.test, f.id).map((h) => h.bracketMatchId).sort()).toEqual([m1.id, m1.id, m2.id, m2.id].sort());
        for (const id of expected.slice(0, 4)) expect(f.test.db.MatchResultRecord.id.find(id)).toBeFalsy();
        for (const id of expected.slice(4)) expect(f.test.db.MatchResultRecord.id.find(id)).toBeTruthy();
        expect([...f.test.db.Leaderboard.iter()]).toHaveLength(0);

        tick(f.test, f.id); // the remaining three
        expect(historyOf(f.test, f.id)).toHaveLength(7);
        expect([...f.test.db.Leaderboard.iter()]).toHaveLength(0); // not rebuilt per record
        drain(f.test, f.id); // the last tick ends the job
        expect(tRow(f.test, f.id).finalizedAt).toBeDefined();
        expect([...f.test.db.Leaderboard.iter()].length).toBeGreaterThan(0);

        // Every record finalized once: one history row per record, every record and lobby gone.
        expect(historyOf(f.test, f.id)).toHaveLength(7);
        expect([...f.test.db.MatchResultRecord.iter()]).toHaveLength(0);
        expect([...f.test.db.Lobby.iter()].filter((l) => l.tournamentId === f.id)).toHaveLength(0);
        // A67(7): MMR moves per record: 4 participants × 7 records; a player of the 2–0 Bo3 moved twice for it.
        const mmr = [...f.test.db.MmrHistory.iter()];
        expect(mmr).toHaveLength(28);
        const m1History = new Set(historyOf(f.test, f.id).filter((h) => h.bracketMatchId === m1.id).map((h) => h.id));
        for (const userId of m1Players) {
            expect(mmr.filter((x) => x.userId === userId && m1History.has(x.matchHistoryId))).toHaveLength(2);
        }
        expect(jobsOf(f.test, f.id)).toHaveLength(0);
    });
});

// ─── One game per record (A67(3)) ─────────────────────────────────────────────

describe('A67(3): one game per record, history keyed without game numbers', () => {
    it('MatchResultGame: one row per record; MatchResultGameHistory / MatchLineupHistory / MatchSessionStepHistory keyed by matchHistoryId', () => {
        const { f, m } = bo3Duel();
        const lobbies = playBracketMatch(f, m.id, ['Blue', 'Blue']);
        const records = lobbies.map((s) => recordsOfLobby(f.test, s.lobbyId)[0]);
        for (const r of records) {
            const games = [...f.test.db.MatchResultGame.match_result_id.filter(r.id)];
            expect(games).toHaveLength(1);
            expect('gameNumber' in games[0]).toBe(false);
        }
        for (const s of lobbies) {
            const lineups = [...f.test.db.MatchLineup.by_lobby.filter(s.lobbyId)];
            expect(lineups.map((l) => l.teamSide.tag).sort()).toEqual(['Blue', 'Red']);
            expect(lineups.every((l) => !('gameNumber' in l))).toBe(true);
        }
        advanceStage(f.test, f.org, f.id, 'Completed');
        drain(f.test, f.id);
        const history = historyOf(f.test, f.id);
        expect(history).toHaveLength(2);
        for (const h of history) {
            const gh = [...f.test.db.MatchResultGameHistory.by_match_history.filter(h.id)];
            expect(gh).toHaveLength(1);
            expect('gameNumber' in gh[0]).toBe(false);
            const lh = [...f.test.db.MatchLineupHistory.by_match_history.filter(h.id)];
            expect(lh.map((l) => l.teamSide.tag).sort()).toEqual(['Blue', 'Red']);
            expect(lh.every((l) => !('gameNumber' in l))).toBe(true);
            const sh = [...f.test.db.MatchSessionStepHistory.by_match_history.filter(h.id)];
            expect(sh.length).toBeGreaterThan(0);
            expect(new Set(sh.map((x) => x.sequence)).size).toBe(sh.length); // PK [matchHistoryId, sequence]
            expect(sh.every((x) => !('gameNumber' in x))).toBe(true);
        }
    });
});

// ─── Removed arguments (A67(2)) ───────────────────────────────────────────────

type ArgsOf<F> = F extends (ctx: any, args: infer A) => any ? A : never;

describe('A67(2): no series arguments on lobbies and presets', () => {
    it('type level: create_lobby / update_lobby_settings / create_lobby_preset / update_lobby_preset', () => {
        for (const _ of [0]) {
            expectTypeOf<ArgsOf<typeof M.create_lobby>>().not.toHaveProperty('bestOf');
            expectTypeOf<ArgsOf<typeof M.create_lobby>>().not.toHaveProperty('bestOfNAdvantage');
            expectTypeOf<ArgsOf<typeof M.create_lobby>>().not.toHaveProperty('refereeControlsShelving');
            expectTypeOf<ArgsOf<typeof M.update_lobby_settings>>().not.toHaveProperty('bestOf');
            expectTypeOf<ArgsOf<typeof M.update_lobby_settings>>().not.toHaveProperty('bestOfNAdvantage');
            expectTypeOf<ArgsOf<typeof M.update_lobby_settings>>().not.toHaveProperty('refereeControlsShelving');
            expectTypeOf<ArgsOf<typeof M.create_lobby_preset>>().not.toHaveProperty('bestOf');
            expectTypeOf<ArgsOf<typeof M.create_lobby_preset>>().not.toHaveProperty('bestOfNAdvantage');
            expectTypeOf<ArgsOf<typeof M.create_lobby_preset>>().not.toHaveProperty('refereeControlsShelving');
            expectTypeOf<ArgsOf<typeof M.update_lobby_preset>>().not.toHaveProperty('bestOf');
            expectTypeOf<ArgsOf<typeof M.update_lobby_preset>>().not.toHaveProperty('bestOfNAdvantage');
            expectTypeOf<ArgsOf<typeof M.update_lobby_preset>>().not.toHaveProperty('refereeControlsShelving');
            expectTypeOf<ArgsOf<typeof M.create_lobby>>().toHaveProperty('teamSize');
        }
    });

    it('the lobby, the preset rows and the system preset carry no series columns', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const presets = [...test.db.LobbyPreset.iter()];
        expect(presets.some((p) => p.isSystemPreset)).toBe(true);
        for (const row of [lobbyRow(test, s.lobbyId), ...presets] as Record<string, unknown>[]) {
            for (const k of ['bestOf', 'bestOfNAdvantage', 'refereeControlsShelving']) expect(k in row).toBe(false);
        }
    });
});

// ─── ensureOpenGame (A60(7), A67(3)) ──────────────────────────────────────────

describe('A60(7): ensureOpenGame on the lobby\'s one game', () => {
    const ADMIN = { id: 9999, role: { tag: 'Admin' } };
    const PLAYER = { id: 9998, role: { tag: 'User' } };
    const check = (test: Harness, lobby: any, record: any, user: any) => () =>
        tx(test, 'internal', (ctx) => ensureOpenGame(ctx, lobby, record, user));

    it("open game → 'open' for anyone; closed + Submitted → 'admin' for an Admin, 'This game is closed.' for anyone else", () => {
        const test = newHarness();
        const s = setupLobby(test, {
            beforeStart: (l) => {
                test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
                let acct = 600;
                for (const n of ['b1', 'b2', 'r1', 'r2']) test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[n].userId, hsrAccountId: acct++ });
            },
        });
        const open = recordsOfLobby(test, s.lobbyId)[0];
        expect(check(test, lobbyRow(test, s.lobbyId), open, PLAYER)()).toBe('open');
        expect(check(test, lobbyRow(test, s.lobbyId), open, ADMIN)()).toBe('open');

        // Close the game (Ranked → Submitted, parked).
        draftGame(s);
        finishGame(s, 'Blue');
        const closed = recordsOfLobby(test, s.lobbyId)[0];
        expect(closed.status.tag).toBe('Submitted');
        expect(check(test, lobbyRow(test, s.lobbyId), closed, ADMIN)()).toBe('admin');
        expect(check(test, lobbyRow(test, s.lobbyId), closed, PLAYER)).toThrow('This game is closed.');
        expect(check(test, lobbyRow(test, s.lobbyId), closed, { id: 1, role: { tag: 'Moderator' } })).toThrow('This game is closed.');
    });

    // A69(2): Admin edits need a Pending or Submitted record (ensureEditableRecord). A tournament game parked
    // Validated (it has moved the bracket; not yet finalized by the job) is not editable, Admins included; the
    // correction path is override_match_result.
    it('A69(2): a parked Validated tournament record: record_group_scores / set_score_adjustment reject an Admin with the override message; set_eidolon / arrange_lineup / equip / unequip meet the stage guard first', () => {
        const f = liveField(2, { ...BO3 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const r = recordsOfLobby(f.test, s.lobbyId)[0];
        expect(r.status.tag).toBe('Validated');
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const before = tally(f.test, m.id);
        expect(before).toEqual([1, 0]);
        expect(() => ensureEditableRecord(r, ADMIN)).toThrow(OVERRIDE);
        const admin = guest(f.test, 'admin');
        setRole(f.test, admin.userId, 'Admin');
        const { lobbyId } = s;
        const blue = { tag: 'Blue' } as any;
        expectReject(f.test, admin, (ctx) => M.record_group_scores(ctx, { lobbyId, teamSide: blue, values: [100, 100], deaths: 0 }), OVERRIDE);
        expectReject(f.test, admin, (ctx) => M.set_score_adjustment(ctx, { lobbyId, teamSide: blue, value: 100 }), OVERRIDE);
        // resolveEditWindow (postDraft.ts): the admin window opens only for a Pending / Submitted record, so on a
        // Validated record the stage guard fires first: the lobby is parked in AwaitingResult.
        const STAGE = 'This action is not allowed in the current lobby stage (AwaitingResult).';
        expectReject(f.test, admin, (ctx) => M.set_eidolon(ctx, { lobbyId, teamSide: blue, characterName: 'x', eidolon: 1 }), STAGE);
        expectReject(f.test, admin, (ctx) => M.arrange_lineup(ctx, { lobbyId, teamSide: blue, groups: '[[],[]]' }), STAGE);
        expectReject(f.test, admin, (ctx) => M.equip_lightcone(ctx, { lobbyId, teamSide: blue, characterName: 'x', lightconeName: 'y', superimposition: 1 }), STAGE);
        expectReject(f.test, admin, (ctx) => M.unequip_lightcone(ctx, { lobbyId, teamSide: blue, characterName: 'x' }), STAGE);
        expect(recordsOfLobby(f.test, lobbyId)[0].status.tag).toBe('Validated');
        expect(tally(f.test, m.id)).toEqual(before);
    });
});

// ─── Stage lists and the lobby GC (A67(1)) ────────────────────────────────────

describe('A67(1): concede / claim_forfeit / defer stage lists', () => {
    const MSG = {
        concede: 'Concede is only available during Drafting, Equipping, or Scoring.',
        forfeit: 'Forfeit claim is only available during Drafting, Equipping, or Scoring.',
        defer: 'Defer is only available during Drafting, Equipping, or Scoring.',
    };
    const calls = (s: Lobby) => ({
        concede: (ctx: any) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 1 }),
        forfeit: (ctx: any) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 1 }),
        defer: (ctx: any) => M.defer_match(ctx, { lobbyId: s.lobbyId }),
    });

    it('rejected in Waiting and in AwaitingResult', () => {
        // T-S10d (A91(2)): a Deferred lobby is a tournament lobby (the Deferred tournament's lobby, still in Waiting).
        const { f: wf, s: waiting } = deferredDuel({ noStart: true });
        expect(lobbyRow(wf.test, waiting.lobbyId).stage.tag).toBe('Waiting');
        for (const [k, body] of Object.entries(calls(waiting))) expectReject(wf.test, waiting.host, body, MSG[k as keyof typeof MSG]);

        const { f, m } = bo3Duel({ disconnectPolicy: 'Deferred' });
        const parked = playMatch(f, m.id, 'Blue');
        expect(lobbyRow(f.test, parked.lobbyId).stage.tag).toBe('AwaitingResult');
        for (const [k, body] of Object.entries(calls(parked))) expectReject(f.test, parked.host, body, MSG[k as keyof typeof MSG]);
    });

    it('concede accepted in Drafting, Equipping and Scoring; defer accepted in Equipping', () => {
        for (const stage of ['Drafting', 'Equipping', 'Scoring'] as const) {
            const { f, m } = bo3Duel();
            const s = openMatchLobby(f, m.id);
            if (stage !== 'Drafting') draftGame(s);
            if (stage === 'Scoring') tx(f.test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
            expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe(stage);
            concede(s, 2);
            expect(recordsOfLobby(f.test, s.lobbyId)[0].concedeAtStage).toBe(stage);
            expect(tally(f.test, m.id)).toEqual([1, 0]);
        }
        const { f, m } = bo3Duel({ disconnectPolicy: 'Deferred' });
        const s = openMatchLobby(f, m.id);
        draftGame(s);
        tx(f.test, s.host, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(recordsOfLobby(f.test, s.lobbyId)[0].status.tag).toBe('Pending');
    });
});

describe('A67(1): the lobby GC', () => {
    const gc = (test: Harness) => tx(test, 'internal', (ctx) => M.admin_gc_lobbies(ctx, {}));

    // T-S8f (A68(9)): D-49's unconditional Waiting rule is retired; a Waiting lobby takes the presence test first, so the
    // members of the idle lobby disconnect before the 30 min rule can delete it (s8f-membership covers the online case).
    it('Waiting with every member offline: deleted after 30 min idle, kept before; AwaitingResult never deleted', () => {
        const test = newHarness();
        const waiting = setupLobby(test, { noStart: true });
        const host2 = guest(test, 'host2');
        // T-S10d (A91(2)): parked through a submitted Ranked game instead of a standalone Deferred defer.
        const parked = parkedLobby(test, {
            actors: { host: host2 },
            seats: [['x1', 'BluePlayer'], ['x2', 'BluePlayer'], ['y1', 'RedPlayer'], ['y2', 'RedPlayer']],
        });
        expect(lobbyRow(test, parked.lobbyId).stage.tag).toBe('AwaitingResult');

        for (const who of Object.values(waiting.a)) disconnect(test, who);
        advance(test, 29 * 60_000);
        gc(test);
        expect(test.db.Lobby.id.find(waiting.lobbyId)).toBeTruthy();
        advance(test, 2 * 60_000);
        gc(test);
        expect(test.db.Lobby.id.find(waiting.lobbyId)).toBeFalsy();
        advance(test, 72 * 60 * 60_000); // far past the removed 72 h Shelved rule
        gc(test);
        expect(lobbyRow(test, parked.lobbyId).stage.tag).toBe('AwaitingResult');
    });

    it('LobbyStage has no BetweenGames / Shelved / Finished variant', () => {
        const stages = ['Waiting', 'Drafting', 'Equipping', 'Scoring', 'AwaitingResult'] as const;
        type Stage = ReturnType<typeof lobbyRow>['stage']['tag'];
        expectTypeOf<Stage>().toEqualTypeOf<(typeof stages)[number]>();
    });
});
