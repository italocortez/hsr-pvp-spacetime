// Tournaments: DQ, rollback, override and resolve guards around staff decisions and live downstream matches.
// Decisions: A84
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10g, S10c (s10g-tournament.test.ts, s10c-high-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import { M, lobbyRow, newHarness, tx, rejection, snap } from '../fixtures/harness';
import { host, verified } from '../fixtures/identity';
import {
    advanceStage,
    bracketRows,
    createTournament,
    enrolled,
    liveField,
    matchRow,
    membersOf,
    openTournament,
    register,
    resolveMatch,
    stageOf,
    teamRow,
    dq,
    BO1,
} from '../fixtures/tournaments';
import {
    byKey,
    duel,
    lobbiesOf,
    openMatchLobby,
    playBracketMatch,
    playMatch,
    recordsOfLobby,
    recordsOfMatch,
    validate,
} from '../fixtures/tournament-matches';

const DECIDED_BY_STAFF = 'This match was decided by staff or a disqualification; roll the match back first (rollback_bracket_match).';
const GROUP_LOCKED = 'Group results are locked: the elimination bracket already exists.';
const dqStage = (stage: string) => `Tournament is ${stage}; participants can be disqualified from Registration through InProgress only.`;
const rollbackBody = (bracketMatchId: number) => (ctx: any) => M.rollback_bracket_match(ctx, { bracketMatchId, reason: 'replay' });
const resolveBody = (bracketMatchId: number, winnerTeamId: number) =>
    (ctx: any) => M.resolve_bracket_match(ctx, { bracketMatchId, winnerTeamId, reason: 'staff' });
const overrideBody = (matchResultId: number, newStatusTag: string, winnerTeamSideTag = '') =>
    (ctx: any) => M.override_match_result(ctx, { matchResultId, newStatusTag, winnerTeamSideTag, reason: 'staff' });

// ════════════════════════════════════════════════════════════════════════════
// Audit #2 and #8: dq_participant lobby voiding and stage bounds
// ════════════════════════════════════════════════════════════════════════════

describe('tournament audit #2: a DQ voids the unsettled lobbies of the matches it settles', () => {
    it('audit #2: a Waiting lobby of the DQ\'d team\'s Ready match is removed; advance_tournament_stage(Completed) is not blocked', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id, { noStart: true });
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('Waiting');
        tx(f.test, f.org, dq(f.id, f.ts[1].captain.userId, true));
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Dq');
        expect(after.winnerTeamId).toBe(f.ts[0].teamId);
        expect(f.test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(lobbiesOf(f.test, m.id)).toEqual([]);
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(stageOf(f.test, f.id)).toBe('Completed');
    });

    it('audit #2 (A68(6)): a lobby parked with a Submitted record is voided (record Voided, lobby gone)', () => {
        const f = liveField(2, { defaultBestOf: 3, grandFinalBestOf: 3, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const [parked] = playBracketMatch(f, m.id, ['Blue']);
        const [rec] = recordsOfLobby(f.test, parked.lobbyId);
        expect(rec.status.tag).toBe('Submitted');
        tx(f.test, f.org, dq(f.id, f.ts[1].captain.userId, true));
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Dq');
        expect(f.test.db.MatchResultRecord.id.find(rec.id)!.status.tag).toBe('Voided');
        expect(f.test.db.Lobby.id.find(parked.lobbyId)).toBeFalsy();
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(stageOf(f.test, f.id)).toBe('Completed');
    });

    it('audit #2 (D-25): the DQ\'d team\'s live lobby is still force-conceded (Validated concede record, lobby parked)', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const live = openMatchLobby(f, m.id);
        expect(lobbyRow(f.test, live.lobbyId).stage.tag).toBe('Drafting');
        tx(f.test, f.org, dq(f.id, f.ts[1].captain.userId, true));
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Dq');
        expect(lobbyRow(f.test, live.lobbyId).stage.tag).toBe('AwaitingResult');
        const [rec] = recordsOfLobby(f.test, live.lobbyId);
        expect(rec.status.tag).toBe('Validated');
        expect(rec.winnerTeamSide?.tag).toBe('Blue');
    });
});

describe('tournament audit #8: dq_participant needs Registration through InProgress', () => {
    it('audit #8: refused in Draft, Completed and Cancelled with the text; nothing changes', () => {
        const test = newHarness();
        const org = host(test);
        const draft = createTournament(test, org);
        const p = verified(test, 'p');
        expect(rejection(test, org, dq(draft, p.userId))).toBe(dqStage('Draft'));

        const cancelled = openTournament(test, org, { name: 'Cancelled' });
        register(test, p, cancelled);
        tx(test, org, (ctx) => M.cancel_tournament(ctx, { tournamentId: cancelled }));
        const before = enrolled(test, cancelled, p.userId);
        expect(rejection(test, org, dq(cancelled, p.userId))).toBe(dqStage('Cancelled'));
        expect(enrolled(test, cancelled, p.userId)).toEqual(before);

        const f = duel();
        resolveMatch(f.test, f.org, byKey(f.test, f.id, 'W-R1-M1').id, f.ts[0].teamId);
        advanceStage(f.test, f.org, f.id, 'Completed');
        const loser = f.ts[1].captain;
        const team = teamRow(f.test, f.ts[1].teamId)!;
        expect(rejection(f.test, f.org, dq(f.id, loser.userId, true))).toBe(dqStage('Completed'));
        expect(enrolled(f.test, f.id, loser.userId).status.tag).not.toBe('Disqualified');
        expect(membersOf(f.test, f.ts[1].teamId)).toEqual([loser.userId, f.ts[1].mate.userId].sort((a, b) => a - b));
        expect(teamRow(f.test, f.ts[1].teamId)).toEqual(team);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Audit #3, #4, #5: rollback, override and the group lock
// ════════════════════════════════════════════════════════════════════════════

describe('tournament audit #3: rollback after an override or a staff decision', () => {
    it('audit #3: a Bo1 decided by an override to Validated, then rollback_bracket_match: Ready, record Voided, winner removed downstream', () => {
        const f = liveField(4, { defaultBestOf: 1, grandFinalBestOf: 1, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const slot = () => { const r = matchRow(f.test, final.id); return m.nextWinnerSlot === 1 ? r.team1Id : r.team2Id; };
        const s = playMatch(f, m.id, 'Blue');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        tx(f.test, f.org, overrideBody(r.id, 'Validated', 'Blue'));
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Staff');
        expect(slot()).toBe(m.team1Id);

        tx(f.test, f.org, rollbackBody(m.id));
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Ready');
        expect(after.winnerTeamId).toBeUndefined();
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Voided');
        expect(f.test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(slot()).toBeUndefined();
    });

    it('audit #3 (S8e rule kept): a staff resolve against the tally, then rollback: nothing is voided and the games re-decide the match (Played)', () => {
        const f = liveField(2, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        playBracketMatch(f, m.id, ['Blue', 'Blue']);
        resolveMatch(f.test, f.org, m.id, m.team2Id!);
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Staff');
        tx(f.test, f.org, rollbackBody(m.id));
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Played');
        expect(after.winnerTeamId).toBe(m.team1Id);
        expect(recordsOfMatch(f.test, m.id).map((r) => r.status.tag)).toEqual(['Validated', 'Validated']);
    });
});

describe('tournament audit #4: override_match_result on a staff or DQ decision', () => {
    it('audit #4: a record of a match decided by Dq is refused with the text; nothing changes', () => {
        const f = liveField(2, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const [g1] = playBracketMatch(f, m.id, ['Blue']);
        const [rec] = recordsOfLobby(f.test, g1.lobbyId);
        tx(f.test, f.org, dq(f.id, f.ts[1].captain.userId, true));
        const decided = matchRow(f.test, m.id);
        expect(decided.decidedBy?.tag).toBe('Dq');
        expect(rejection(f.test, f.org, overrideBody(rec.id, 'Validated', 'Red'))).toBe(DECIDED_BY_STAFF);
        expect(matchRow(f.test, m.id)).toEqual(decided);
        expect(f.test.db.MatchResultRecord.id.find(rec.id)!.status.tag).toBe('Validated');
    });

    it('audit #4: a match decided by Staff against the tally (resolve_bracket_match) is refused; nothing changes', () => {
        const f = liveField(4, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const [g1] = playBracketMatch(f, m.id, ['Blue']);
        const [rec] = recordsOfLobby(f.test, g1.lobbyId);
        resolveMatch(f.test, f.org, m.id, m.team2Id!); // 1–0 for team1 on games; staff decide for team2
        const decided = matchRow(f.test, m.id);
        expect(rejection(f.test, f.org, overrideBody(rec.id, 'Validated', 'Red'))).toBe(DECIDED_BY_STAFF);
        expect(matchRow(f.test, m.id)).toEqual(decided);
        const r = matchRow(f.test, final.id);
        expect(m.nextWinnerSlot === 1 ? r.team1Id : r.team2Id).toBe(m.team2Id); // still placed downstream
    });

    it('audit #4: a Staff decision the tally gives (an earlier override) can be corrected by another override', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const [rec] = recordsOfLobby(f.test, s.lobbyId);
        tx(f.test, f.org, overrideBody(rec.id, 'Validated', 'Blue'));
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team1Id);
        tx(f.test, f.org, overrideBody(rec.id, 'Validated', 'Red'));
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Staff');
        expect(after.winnerTeamId).toBe(m.team2Id);
    });
});

describe('tournament audit #5: group matches lock once the elimination bracket exists', () => {
    it('audit #5: before advance_group_stage resolve / rollback / override work on a group match; after it each is refused with the text', () => {
        const f = liveField(4, { format: 'GroupIntoSingleElim', groupSize: 4, groupAdvanceCount: 2 });
        const { test, org } = f;
        const groupRows = () => bracketRows(test, f.id).filter((r) => r.bracketSide.tag === 'Group').sort((a, b) => a.id - b.id);
        const [g1, g2] = groupRows();
        const s = playMatch(f, g1.id, 'Blue'); // decided by play (Bo1)
        const [rec] = recordsOfLobby(test, s.lobbyId);
        tx(test, org, overrideBody(rec.id, 'Validated', 'Red')); // works before the elimination bracket exists
        expect(matchRow(test, g1.id).winnerTeamId).toBe(g1.team2Id);
        resolveMatch(test, org, g2.id, g2.team1Id!);
        tx(test, org, rollbackBody(g2.id));
        expect(matchRow(test, g2.id).state.tag).toBe('Ready');
        resolveMatch(test, org, g2.id, g2.team1Id!);
        for (const r of groupRows().filter((x) => x.state.tag === 'Ready')) resolveMatch(test, org, r.id, r.team1Id!);
        tx(test, org, (ctx) => M.advance_group_stage(ctx, { tournamentId: f.id }));
        expect(bracketRows(test, f.id).some((r) => r.bracketSide.tag !== 'Group')).toBe(true);

        const before = groupRows();
        expect(rejection(test, org, resolveBody(g2.id, g2.team2Id!))).toBe(GROUP_LOCKED);
        expect(rejection(test, org, rollbackBody(g1.id))).toBe(GROUP_LOCKED);
        expect(rejection(test, org, overrideBody(rec.id, 'Validated', 'Blue'))).toBe(GROUP_LOCKED);
        expect(groupRows()).toEqual(before);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A84: re-resolving a bracket match is refused while the next match is live
// ════════════════════════════════════════════════════════════════════════════

describe('A84: resolve / rollback / override that would un-place a team from a live downstream match are refused', () => {
    type Field = ReturnType<typeof liveField>;

    /** 4 teams: semi m1 played (Blue wins, Validated record), semi m2 resolved by staff; the final has both teams. */
    function semisDecided(f: Field, validateM1 = false) {
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const semi = playMatch(f, m1.id, 'Blue');
        if (validateM1) validate(f.test, f.org, semi.lobbyId);
        resolveMatch(f.test, f.org, m2.id, m2.team1Id!);
        expect(matchRow(f.test, m1.id).state.tag).toBe('Decided');
        expect(matchRow(f.test, final.id).team1Id).toBeDefined();
        expect(matchRow(f.test, final.id).team2Id).toBeDefined();
        const [semiRecord] = recordsOfLobby(f.test, semi.lobbyId);
        expect(semiRecord.status.tag).toBe('Validated');
        return { m1, m2, final, semiRecord };
    }

    const m1Slot = (f: Field, m1: any, finalId: number) => {
        const row = matchRow(f.test, finalId);
        return m1.nextWinnerSlot === 1 ? row.team1Id : row.team2Id;
    };

    /** Every un-placing call on the semi is rejected and leaves the semi, the final, its lobbies and its records as they were. */
    function expectAllRefused(f: Field, m1: any, finalId: number, semiRecordId: number) {
        const { test, org } = f;
        const state = () => snap(matchRow(test, m1.id), matchRow(test, finalId), recordsOfMatch(test, finalId), recordsOfMatch(test, m1.id),
            [...test.db.Lobby.bracket_match_id.filter(finalId)].map((l) => [l.id, l.stage.tag]));
        const before = state();
        const msgs = [
            rejection(test, org, (ctx) => M.resolve_bracket_match(ctx, { bracketMatchId: m1.id, winnerTeamId: m1.team2Id, reason: 'staff' })),
            rejection(test, org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m1.id, reason: 'replay' })),
            rejection(test, org, (ctx) => M.override_match_result(ctx, {
                matchResultId: semiRecordId, newStatusTag: 'Validated', winnerTeamSideTag: 'Red', reason: 'staff',
            })),
        ];
        expect(state()).toBe(before);
        const key = matchRow(test, finalId).positionKey;
        for (const msg of msgs) expect(msg).toBe(`${key} has a lobby or a game result; void or roll that match back first.`);
    }

    it('final Ready with a drafting lobby (Pending record): refused; after staff resolve + roll back the final, the re-resolve succeeds and the replacement team has zero games (A84; Voided does not block)', () => {
        const f = liveField(4, BO1);
        const { m1, final, semiRecord } = semisDecided(f);
        const live = openMatchLobby(f, final.id);
        expect(lobbyRow(f.test, live.lobbyId).stage.tag).toBe('Drafting');
        expect(recordsOfLobby(f.test, live.lobbyId)[0].status.tag).toBe('Pending');
        expectAllRefused(f, m1, final.id, semiRecord.id);
        expect(m1Slot(f, m1, final.id)).toBe(m1.team1Id);

        // The documented clearing path (docs/brackets/architecture.md, Phase S10c): resolve the final, then roll it back.
        resolveMatch(f.test, f.org, final.id, matchRow(f.test, final.id).team1Id!);
        tx(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: final.id, reason: 'clear' }));
        expect(matchRow(f.test, final.id).state.tag).toBe('Ready');
        expect([...f.test.db.Lobby.bracket_match_id.filter(final.id)]).toHaveLength(0);
        expect(recordsOfMatch(f.test, final.id).map((r) => r.status.tag)).toEqual(['Voided']);

        resolveMatch(f.test, f.org, m1.id, m1.team2Id!);
        expect(matchRow(f.test, m1.id).winnerTeamId).toBe(m1.team2Id);
        expect(m1Slot(f, m1, final.id)).toBe(m1.team2Id);
        const after = matchRow(f.test, final.id);
        expect([after.team1Games, after.team2Games]).toEqual([0, 0]);
    });

    it('final Ready with a Submitted record (validation on): refused; after staff override it Rejected, the re-resolve succeeds with zero games (A84; Rejected does not block)', () => {
        const f = liveField(4, { ...BO1, requireResultValidation: true });
        const { m1, final, semiRecord } = semisDecided(f, true);
        const fin = playMatch(f, final.id, 'Blue');
        const [sub] = recordsOfLobby(f.test, fin.lobbyId);
        expect(sub.status.tag).toBe('Submitted');
        expect(matchRow(f.test, final.id).state.tag).toBe('Ready');
        expectAllRefused(f, m1, final.id, semiRecord.id);

        tx(f.test, f.org, (ctx) => M.override_match_result(ctx, { matchResultId: sub.id, newStatusTag: 'Rejected', winnerTeamSideTag: '', reason: 'clear' }));
        expect(f.test.db.MatchResultRecord.id.find(sub.id)!.status.tag).toBe('Rejected');

        resolveMatch(f.test, f.org, m1.id, m1.team2Id!);
        expect(m1Slot(f, m1, final.id)).toBe(m1.team2Id);
        const after = matchRow(f.test, final.id);
        expect([after.team1Games, after.team2Games]).toEqual([0, 0]);
        expect(f.test.db.MatchResultRecord.id.find(sub.id)!.status.tag).toBe('Rejected');
    });

    it('final Ready (Bo3) with one Validated game: refused, nothing changes (A84)', () => {
        const f = liveField(4, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        resolveMatch(f.test, f.org, m1.id, m1.team1Id!);
        resolveMatch(f.test, f.org, m2.id, m2.team1Id!);
        const g1 = playMatch(f, final.id, 'Blue');
        expect(recordsOfLobby(f.test, g1.lobbyId)[0].status.tag).toBe('Validated');
        expect(matchRow(f.test, final.id).state.tag).toBe('Ready');
        const state = () => snap(matchRow(f.test, m1.id), matchRow(f.test, final.id), recordsOfMatch(f.test, final.id));
        const before = state();
        const msg = rejection(f.test, f.org, (ctx) => M.resolve_bracket_match(ctx, { bracketMatchId: m1.id, winnerTeamId: m1.team2Id!, reason: 'staff' }));
        const msg2 = rejection(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m1.id, reason: 'replay' }));
        expect(state()).toBe(before);
        const key = matchRow(f.test, final.id).positionKey;
        expect(msg).toBe(`${key} has a lobby or a game result; void or roll that match back first.`);
        expect(msg2).toBe(`${key} has a lobby or a game result; void or roll that match back first.`);
    });
});
