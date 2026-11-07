// T-S8c: in-memory tests for the S8c staff result reducers and the DQ rule (A23, A24(1)(3), A25 results /
// participants, A26, A26a(2), A38(1), D.8.3 bracket side): resolve_bracket_match, rollback_bracket_match,
// dq_participant. Builders in s8-fixtures.ts (liveField = seeded by team id, generated, InProgress). The record /
// lobby side effects of resolve / rollback are S8d's and not covered here. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_PERM_MESSAGES } from '../helpers/tournamentPermissions';
import { M, advance, expectReject, tx, type Actor, type Harness } from './s4-fixtures';
import {
    AUDIT,
    assignAssistant,
    advanceStage,
    bracketByKey,
    bracketRows,
    enrolled,
    generateBracket,
    liveField,
    matchRow,
    membership,
    membersOf,
    moderator,
    resolveMatch,
    seedAndGenerate,
    seedingField,
    stageOf,
    tRow,
    teamRow,
    verified,
} from './s8-fixtures';

const RESULTS = TOURNAMENT_PERM_MESSAGES.results;
const OPEN = ['Ready', 'Pending'];

const byKey = (test: Harness, id: number, key: string) => bracketByKey(test, id).get(key)!;
const lower = (r: any) => Math.min(r.team1Id!, r.team2Id!);
const higher = (r: any) => Math.max(r.team1Id!, r.team2Id!);
const slotOf = (row: any, slot: number) => (slot === 1 ? row.team1Id : row.team2Id);
const rollback = (test: Harness, who: Actor, bracketMatchId: number, reason = 'staff') =>
    tx(test, who, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId, reason }));
const dq = (test: Harness, by: Actor, tournamentId: number, userId: number, dqWholeTeam?: boolean) =>
    tx(test, by, (ctx) => M.dq_participant(ctx, { tournamentId, userId, reason: 'test', dqWholeTeam }));

// ─── resolve_bracket_match ────────────────────────────────────────────────────

describe('resolve_bracket_match: permission (A25 results, A24(3) staff set)', () => {
    type Who = 'organizer' | 'moderator' | 'results-assistant' | 'other-assistant' | 'captain' | 'plain';
    const allowed: Who[] = ['organizer', 'moderator', 'results-assistant'];

    it.each(['organizer', 'moderator', 'results-assistant', 'other-assistant', 'captain', 'plain'] as Who[])('%s', (who) => {
        const { test, org, id, ts } = liveField(4);
        const m = byKey(test, id, 'W-R1-M1');
        let a: Actor;
        if (who === 'organizer') a = org;
        else if (who === 'moderator') a = moderator(test);
        else if (who === 'captain') a = ts.find((t) => t.teamId === m.team1Id)!.captain; // a plain captain of the match
        else if (who === 'plain') a = verified(test, 'plain');
        else {
            a = verified(test, who);
            assignAssistant(test, org, id, a, who === 'results-assistant'
                ? { results: true }
                : { participants: true, bracket: true });
        }
        const call = () => resolveMatch(test, a, m.id, m.team1Id!);
        if (allowed.includes(who)) {
            call();
            expect(matchRow(test, m.id).state.tag).toBe('Decided');
            expect(matchRow(test, m.id).lastModifiedById).toBe(a.userId);
        } else {
            expect(call).toThrow(RESULTS);
            expect(matchRow(test, m.id).state.tag).toBe('Ready');
        }
    });
});

describe('resolve_bracket_match: results (A23 single writer, A24(3))', () => {
    it('Ready → Decided by Staff, 0-0, winner routed, loser Eliminated (single elimination)', () => {
        const { test, org, id } = liveField(4);
        const m = byKey(test, id, 'W-R1-M1');
        const [w, l] = [m.team2Id!, m.team1Id!]; // the lower seed wins: any participant may be named
        resolveMatch(test, org, m.id, w, '  no-show  ');
        const after = matchRow(test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Staff');
        expect(after).toMatchObject({ winnerTeamId: w, loserTeamId: l, team1Games: 0, team2Games: 0 });
        expect(slotOf(matchRow(test, after.nextWinnerMatchId!), after.nextWinnerSlot)).toBe(w);
        expect(teamRow(test, l)!.status.tag).toBe('Eliminated');
        expect(teamRow(test, w)!.status.tag).toBe('Active');
    });

    it('resolving a Ready match deletes its calendar event (D-22, like DQ and rollback); other matches keep theirs', () => {
        const { test, org, id } = liveField(4);
        const m1 = byKey(test, id, 'W-R1-M1');
        const m2 = byKey(test, id, 'W-R1-M2');
        const event = (bracketMatchId: number) => test.db.CalendarEvent.insert({
            id: 0, organizerId: org.userId, title: 'match', startAt: test.clock.now(), endAt: test.clock.now(),
            bracketMatchId, description: undefined, ...AUDIT(test),
        } as any);
        event(m1.id);
        event(m2.id);
        const eventsOf = (bracketMatchId: number) => [...test.db.CalendarEvent.bracket_match_id.filter(bracketMatchId)];
        expect(eventsOf(m1.id)).toHaveLength(1);
        resolveMatch(test, org, m1.id, m1.team1Id!);
        expect(eventsOf(m1.id)).toHaveLength(0);
        expect(eventsOf(m2.id)).toHaveLength(1);
    });

    it('the same winner again is a no-op (rows unchanged)', () => {
        const { test, org, id } = liveField(4, { format: 'DoubleElimination' });
        const m = byKey(test, id, 'W-R1-M1');
        resolveMatch(test, org, m.id, m.team1Id!);
        const before = bracketRows(test, id);
        advance(test, 1_000);
        resolveMatch(test, moderator(test), m.id, m.team1Id!, 'again');
        expect(bracketRows(test, id)).toEqual(before);
    });

    it('a different winner on a Decided match rolls back and re-applies (downstream slots swapped)', () => {
        const { test, org, id } = liveField(4, { format: 'DoubleElimination' });
        const m = byKey(test, id, 'W-R1-M1');
        const [a, b] = [m.team1Id!, m.team2Id!];
        resolveMatch(test, org, m.id, a);
        const r1 = matchRow(test, m.id);
        const wbNext = r1.nextWinnerMatchId!;
        const lbNext = r1.nextLoserMatchId!;
        expect(slotOf(matchRow(test, wbNext), r1.nextWinnerSlot)).toBe(a);
        expect(slotOf(matchRow(test, lbNext), r1.nextLoserSlot)).toBe(b);

        resolveMatch(test, org, m.id, b, 'wrong winner entered');
        const r2 = matchRow(test, m.id);
        expect(r2).toMatchObject({ winnerTeamId: b, loserTeamId: a, team1Games: 0, team2Games: 0 });
        expect(r2.decidedBy?.tag).toBe('Staff');
        expect(slotOf(matchRow(test, wbNext), r2.nextWinnerSlot)).toBe(b);
        expect(slotOf(matchRow(test, lbNext), r2.nextLoserSlot)).toBe(a);
        // no stale copy of the old winner / loser anywhere downstream
        const holding = (team: number) => bracketRows(test, id).filter((r) => r.id !== m.id && (r.team1Id === team || r.team2Id === team));
        expect(holding(a).map((r) => r.id)).toEqual([lbNext]);
        expect(holding(b).map((r) => r.id)).toEqual([wbNext]);
    });

    it('a different winner is refused while a downstream match is Decided; nothing changes', () => {
        const { test, org, id } = liveField(4);
        const m1 = byKey(test, id, 'W-R1-M1');
        const m2 = byKey(test, id, 'W-R1-M2');
        resolveMatch(test, org, m1.id, lower(m1));
        resolveMatch(test, org, m2.id, lower(m2));
        const final = byKey(test, id, 'W-R2-M1');
        resolveMatch(test, org, final.id, lower(final));
        const before = bracketRows(test, id);
        expectReject(test, org, (ctx) => M.resolve_bracket_match(ctx, { bracketMatchId: m1.id, winnerTeamId: higher(m1), reason: '' }),
            /roll that back first/);
        expect(bracketRows(test, id)).toEqual(before);
    });

    it('guards: unknown match, Pending match, non-participant winner, reason > 1000; stage InProgress only', () => {
        const { test, org, id, ts } = liveField(4);
        const m = byKey(test, id, 'W-R1-M1');
        const call = (bracketMatchId: number, winnerTeamId: number, reason = '') =>
            (ctx: any) => M.resolve_bracket_match(ctx, { bracketMatchId, winnerTeamId, reason });
        expectReject(test, org, call(99_999, m.team1Id!), 'Bracket match not found.');
        const pending = byKey(test, id, 'W-R2-M1');
        expectReject(test, org, call(pending.id, ts[0].teamId), 'W-R2-M1 is Pending; only a Ready or Decided match can be resolved.');
        const outsider = ts.map((t) => t.teamId).find((t) => t !== m.team1Id && t !== m.team2Id)!;
        expectReject(test, org, call(m.id, outsider), `Team ${outsider} does not play W-R1-M1.`);
        expectReject(test, org, call(m.id, m.team1Id!, 'x'.repeat(1001)), 'Reason must be at most 1000 characters.');
        resolveMatch(test, org, m.id, m.team1Id!, ` ${'x'.repeat(1000)} `); // trimmed to 1000: accepted
        expect(matchRow(test, m.id).state.tag).toBe('Decided');

        const s = seedingField(2);
        seedAndGenerate(s.test, s.org, s.id);
        const sm = bracketRows(s.test, s.id)[0];
        expectReject(s.test, s.org, (ctx) => M.resolve_bracket_match(ctx, { bracketMatchId: sm.id, winnerTeamId: sm.team1Id!, reason: '' }),
            'Tournament is not in progress.');
    });
});

// ─── rollback_bracket_match ───────────────────────────────────────────────────

describe('rollback_bracket_match (A24(3))', () => {
    it('refused while downstream is Decided; unwinding from the top works; the loser is un-eliminated', () => {
        const { test, org, id } = liveField(4);
        const m1 = byKey(test, id, 'W-R1-M1');
        const m2 = byKey(test, id, 'W-R1-M2');
        resolveMatch(test, org, m1.id, lower(m1));
        resolveMatch(test, org, m2.id, lower(m2));
        const final = byKey(test, id, 'W-R2-M1');
        resolveMatch(test, org, final.id, lower(final));
        const before = bracketRows(test, id);
        expectReject(test, org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m1.id, reason: '' }), /roll that back first/);
        expect(bracketRows(test, id)).toEqual(before);

        rollback(test, org, final.id);
        expect(matchRow(test, final.id).state.tag).toBe('Ready');
        rollback(test, org, m1.id, 'entered by mistake');
        const back = matchRow(test, m1.id);
        expect(back.state.tag).toBe('Ready');
        expect(back).toMatchObject({ winnerTeamId: undefined, loserTeamId: undefined, decidedBy: undefined, team1Games: 0, team2Games: 0 });
        expect(teamRow(test, higher(m1))!.status.tag).toBe('Active');
        expect(slotOf(matchRow(test, final.id), back.nextWinnerSlot)).toBeUndefined();
        expect(matchRow(test, final.id).state.tag).toBe('Pending');
        // decided again after the rollback, by the other team
        resolveMatch(test, org, m1.id, higher(m1));
        expect(slotOf(matchRow(test, final.id), back.nextWinnerSlot)).toBe(higher(m1));
    });

    it('guards: a Ready match, results permission, reason length', () => {
        const { test, org, id } = liveField(4);
        const m = byKey(test, id, 'W-R1-M1');
        expectReject(test, org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m.id, reason: '' }),
            'W-R1-M1 is Ready; only a decided match can be rolled back.');
        resolveMatch(test, org, m.id, m.team1Id!);
        expectReject(test, verified(test, 'plain'), (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m.id, reason: '' }), RESULTS);
        expectReject(test, org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m.id, reason: 'x'.repeat(1001) }),
            'Reason must be at most 1000 characters.');
        const asst = verified(test, 'asst');
        assignAssistant(test, org, id, asst, { results: true });
        rollback(test, asst, m.id);
        expect(matchRow(test, m.id).state.tag).toBe('Ready');
    });
});

// ─── dq_participant ───────────────────────────────────────────────────────────

describe('dq_participant: the bracket side (A23, A26, A26a(2); S8c DQ rule)', () => {
    /** No open (Ready / Pending) match holds the team in a slot. */
    const holdsOpenSlot = (test: Harness, id: number, teamId: number) =>
        bracketRows(test, id).some((r) => OPEN.includes(r.state.tag) && (r.team1Id === teamId || r.team2Id === teamId));

    it('dqWholeTeam on a team in a Ready match: the opponent advances (decidedBy Dq, 0-0); team and every enrolment Disqualified', () => {
        const { test, org, id, ts } = liveField(4);
        const m = byKey(test, id, 'W-R1-M1');
        const victim = ts.find((t) => t.teamId === m.team2Id)!;
        const opponent = m.team1Id!;
        dq(test, org, id, victim.captain.userId, true);
        const after = matchRow(test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Dq');
        expect(after).toMatchObject({ winnerTeamId: opponent, loserTeamId: victim.teamId, team1Games: 0, team2Games: 0 });
        expect(slotOf(matchRow(test, after.nextWinnerMatchId!), after.nextWinnerSlot)).toBe(opponent);
        expect(teamRow(test, victim.teamId)!.status.tag).toBe('Disqualified'); // not overwritten with Eliminated
        expect(enrolled(test, id, victim.captain.userId).status.tag).toBe('Disqualified');
        expect(enrolled(test, id, victim.mate.userId).status.tag).toBe('Disqualified');
        expect(membersOf(test, victim.teamId)).toEqual([]);
        expect(holdsOpenSlot(test, id, victim.teamId)).toBe(false);
        expect(teamRow(test, opponent)!.status.tag).toBe('Active');
    });

    it('one member DQ: enrolment Disqualified, the team plays on; the last member DQ settles the match', () => {
        const { test, org, id, ts } = liveField(4);
        const m = byKey(test, id, 'W-R1-M1');
        const victim = ts.find((t) => t.teamId === m.team1Id)!;
        dq(test, org, id, victim.captain.userId); // the captain: captaincy passes to the mate (D-21)
        expect(enrolled(test, id, victim.captain.userId).status.tag).toBe('Disqualified');
        expect(membership(test, id, victim.captain.userId)).toBeUndefined();
        expect(teamRow(test, victim.teamId)!).toMatchObject({ captainUserId: victim.mate.userId });
        expect(teamRow(test, victim.teamId)!.status.tag).toBe('Active');
        expect(matchRow(test, m.id).state.tag).toBe('Ready');
        expect(enrolled(test, id, victim.mate.userId).status.tag).toBe('Active');

        dq(test, org, id, victim.mate.userId);
        expect(teamRow(test, victim.teamId)!.status.tag).toBe('Disqualified');
        expect(matchRow(test, m.id)).toMatchObject({ winnerTeamId: m.team2Id, decidedBy: { tag: 'Dq' } });
        expectReject(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: victim.mate.userId, reason: '' }),
            'Participant is already disqualified.');
    });

    it('a team waiting in a Pending match: its slot becomes a BYE; the opponent gets a walkover when it arrives', () => {
        const { test, org, id, ts } = liveField(4);
        const m1 = byKey(test, id, 'W-R1-M1');
        const m2 = byKey(test, id, 'W-R1-M2');
        const final = byKey(test, id, 'W-R2-M1');
        const a = lower(m1);
        resolveMatch(test, org, m1.id, a);
        const slotA = matchRow(test, m1.id).nextWinnerSlot;
        expect(slotOf(matchRow(test, final.id), slotA)).toBe(a);

        const victim = ts.find((t) => t.teamId === a)!;
        dq(test, org, id, victim.captain.userId, true);
        const waiting = matchRow(test, final.id);
        expect(waiting.state.tag).toBe('Pending');
        expect(slotOf(waiting, slotA)).toBeUndefined();
        expect(slotA === 1 ? waiting.team1IsBye : waiting.team2IsBye).toBe(true);
        expect(holdsOpenSlot(test, id, a)).toBe(false);
        expect(matchRow(test, m1.id).winnerTeamId).toBe(a); // the decided match keeps its result
        // Documented S8c limit: once the DQ turned the slot into a BYE, the feeder match cannot be rolled back. Pinned
        // as landed: the refusal surfaces the helper's slot check ('W-R2-M1 slot N does not hold <team>').
        expectReject(test, org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m1.id, reason: '' }), `W-R2-M1 slot ${slotA} does not hold ${a}.`);

        const b = lower(m2);
        resolveMatch(test, org, m2.id, b);
        const settled = matchRow(test, final.id);
        expect(settled.state.tag).toBe('Walkover');
        expect(settled.winnerTeamId).toBe(b);
        expect(teamRow(test, b)!.status.tag).toBe('Active');
    });

    it('double elimination: the DQ loss routes the team into the losers bracket, where its slot becomes a BYE', () => {
        const { test, org, id, ts } = liveField(4, { format: 'DoubleElimination' });
        const m1 = byKey(test, id, 'W-R1-M1');
        const m2 = byKey(test, id, 'W-R1-M2');
        const victimId = m1.team1Id!;
        const opponent = m1.team2Id!;
        const victim = ts.find((t) => t.teamId === victimId)!;
        dq(test, org, id, victim.captain.userId, true);

        const r1 = matchRow(test, m1.id);
        expect(r1).toMatchObject({ winnerTeamId: opponent, loserTeamId: victimId, decidedBy: { tag: 'Dq' } });
        const lb = matchRow(test, r1.nextLoserMatchId!);
        expect(lb.state.tag).toBe('Pending');
        expect(slotOf(lb, r1.nextLoserSlot)).toBeUndefined();
        expect(r1.nextLoserSlot === 1 ? lb.team1IsBye : lb.team2IsBye).toBe(true);
        expect(holdsOpenSlot(test, id, victimId)).toBe(false);

        // the other WB match: its loser meets the BYE and walks over
        resolveMatch(test, org, m2.id, lower(m2));
        const lbAfter = matchRow(test, lb.id);
        expect(lbAfter.state.tag).toBe('Walkover');
        expect(lbAfter.winnerTeamId).toBe(higher(m2));
        expect(teamRow(test, victimId)!.status.tag).toBe('Disqualified');
    });

    it('one member DQ of a bracketed Ready team in Seeding: the team stays Ready (A26a(3), stand-ins), no seed stamp, InProgress activates it', () => {
        const { test, org, id, ts } = seedingField(4);
        seedAndGenerate(test, org, id);
        const stamped = tRow(test, id).lastSeedChangeAt!.microsSinceUnixEpoch;
        advance(test, 1_000);
        dq(test, org, id, ts[0].mate.userId);
        expect(enrolled(test, id, ts[0].mate.userId).status.tag).toBe('Disqualified');
        expect(membersOf(test, ts[0].teamId)).toEqual([ts[0].captain.userId]);
        expect(teamRow(test, ts[0].teamId)!.status.tag).toBe('Ready');
        expect(tRow(test, id).lastSeedChangeAt!.microsSinceUnixEpoch).toBe(stamped);
        advanceStage(test, org, id, 'InProgress');
        expect(teamRow(test, ts[0].teamId)!.status.tag).toBe('Active');
        expect(bracketRows(test, id).some((r) => r.team1Id === ts[0].teamId || r.team2Id === ts[0].teamId)).toBe(true);
    });

    it('the same one-member DQ before generation drops the team to Forming (A26)', () => {
        const { test, org, id, ts } = seedingField(3);
        dq(test, org, id, ts[0].mate.userId);
        expect(teamRow(test, ts[0].teamId)!.status.tag).toBe('Forming');
        expect(tRow(test, id).lastSeedChangeAt).toBeUndefined();
    });

    it('Seeding after generation: an emptied team stamps lastSeedChangeAt; regeneration is required, then InProgress', () => {
        const { test, org, id, ts } = seedingField(4);
        seedAndGenerate(test, org, id);
        advance(test, 1_000);
        dq(test, org, id, ts[3].captain.userId, true);
        expect(teamRow(test, ts[3].teamId)!.status.tag).toBe('Disqualified');
        expect(tRow(test, id).lastSeedChangeAt!.microsSinceUnixEpoch > tRow(test, id).bracketGeneratedAt!.microsSinceUnixEpoch).toBe(true);
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'InProgress' }),
            'Seeding changed after the bracket was generated; regenerate it.');
        advance(test, 1_000);
        generateBracket(test, org, id); // 3 Ready teams, seeds 1..3 still unique
        expect(bracketRows(test, id).some((r) => r.team1Id === ts[3].teamId || r.team2Id === ts[3].teamId)).toBe(false);
        advanceStage(test, org, id, 'InProgress');
        expect(stageOf(test, id)).toBe('InProgress');
    });
});
