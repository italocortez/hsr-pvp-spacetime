// Tournaments: stand-in rules (approvals, checks, seats, locks, views).
// Decisions: A35, A104, A135, A136, A137, A138, A140
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10v (s10v-stand-ins.test.ts).
//
// T-S10v: stand-in rules (DECISIONS.md A135, A136) and the stand-in bugs of notes/audit-2026-11-09/standin-audit.md
// (SI1 to SI16). In-memory only; nothing reaches maincloud. Every `it` cites the decision row and the audit id; each
// rule is paired with its neighbouring allowed case. Probe sequences follow the audit's probes (P1 to P13).
import { describe, it, expect } from 'vitest';
import {
    M,
    tx,
    expectReject,
    member,
    lobbyRow,
    newHarness,
    seatOf,
    guest,
    type Actor,
    type Harness,
    type Lobby,
    AUDIT,
    linkDiscord,
    advance,
    priceCharacters,
    session,
    setupLobby,
    refereeActor,
} from '../fixtures/harness';
import { verified, host, moderator, setUserRole, fireDeletionJob } from '../fixtures/identity';
import { insertHsrAccount, ownedAccount } from '../fixtures/roster';
import { settingsFrom, join } from '../fixtures/lobby';
import { viewAs } from '../fixtures/views';
import {
    openTournament,
    enrollMany,
    advanceStage,
    seedAndGenerate,
    assignAssistant,
    resolveMatch,
    locks,
    matchRow,
    bracketRows,
    liveField,
    seedingField,
    makeTeam,
    tRow,
    teamRow,
    fullTeams,
    register,
    type TournamentArgs,
    lockAccount,
} from '../fixtures/tournaments';
import {
    byKey,
    createTournamentLobby,
    sidesOf,
    playLobbyGame,
    validate,
    drain,
    slotOf,
} from '../fixtures/tournament-matches';

const approve = (m: number, teamId: number, userId: number) => (ctx: any) => M.approve_stand_in(ctx, { bracketMatchId: m, teamId, userId });
const revoke = (m: number, userId: number) => (ctx: any) => M.revoke_stand_in(ctx, { bracketMatchId: m, userId });
const setSelf = (lobbyId: number, slot: string) => (ctx: any) => M.set_team_slot(ctx, { lobbyId, lobbySlot: { tag: slot } as any });
const moveOther = (test: Harness, lobbyId: number, target: Actor, slot: string) => {
    const targetJoinSeq = seatOf(test, lobbyId, target.userId);
    return (ctx: any) => M.set_team_slot(ctx, { lobbyId, targetJoinSeq, lobbySlot: { tag: slot } as any });
};
const confirm = (lobbyId: number) => (ctx: any) => M.confirm_ready(ctx, { lobbyId });
const start = (lobbyId: number) => (ctx: any) => M.start_draft(ctx, { lobbyId });
const rowsOf = (test: Harness) => [...test.db.TournamentStandIn.iter()].map((r) => ({ m: r.bracketMatchId, team: r.teamId, user: r.userId }));
const setTournament = (test: Harness, id: number, over: Record<string, unknown>) =>
    test.db.Tournament.id.update({ ...tRow(test, id), ...over } as any);
const lockAccounts = (tournamentId: number, hsrAccountIds: number[]) => (ctx: any) => M.lock_tournament_accounts(ctx, { tournamentId, hsrAccountIds });
const seedEloConfig = (test: Harness) => tx(test, 'internal', (ctx) => M.admin_seed_elo_config(ctx, {}));

/** A 2v2 single-elimination tournament in progress with `n` teams; `m1` = W-R1-M1 and its sides. */
function duel2v2(n = 2, over: Partial<TournamentArgs> = {}) {
    const f = liveField(n, over);
    const m1 = byKey(f.test, f.id, 'W-R1-M1');
    return { ...f, m1, ...sidesOf(f, m1.id) };
}

/** A 3v3 tournament in progress with two teams (captain + two mates each). */
function field3v3() {
    const test = newHarness();
    const org = host(test);
    const id = openTournament(test, org, { teamSize: 3, maxParticipants: 8 });
    const t1 = enrollMany(test, id, 3, 'a');
    const t2 = enrollMany(test, id, 3, 'b');
    const team1 = makeTeam(test, id, t1[0], [t1[1], t1[2]], 'Team A');
    const team2 = makeTeam(test, id, t2[0], [t2[1], t2[2]], 'Team B');
    advanceStage(test, org, id, 'Seeding');
    seedAndGenerate(test, org, id);
    advanceStage(test, org, id, 'InProgress');
    const m = bracketRows(test, id)[0];
    const blue = m.team1Id === team1 ? t1 : t2;
    const red = m.team1Id === team1 ? t2 : t1;
    return { test, org, id, m, blue, red };
}

describe('A136 / SI17: approvals from bracket generation on', () => {
    it('A136 SI17: accepted in Seeding once the bracket is generated (the "use stand-ins" message is true)', () => {
        const { test, org, id } = seedingField(2);
        seedAndGenerate(test, org, id);
        const m = bracketRows(test, id)[0];
        const sub = verified(test, 'sub');
        tx(test, org, approve(m.id, m.team1Id!, sub.userId));
        expect(rowsOf(test)).toEqual([{ m: m.id, team: m.team1Id, user: sub.userId }]);
    });

    it('A136 SI17: refused while the bracket is not generated (Seeding without bracketGeneratedAt); InProgress accepted', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        setTournament(f.test, f.id, { stage: { tag: 'Seeding' }, bracketGeneratedAt: undefined });
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId), 'Stand-ins can be approved once the bracket is generated, until the tournament ends.');
        setTournament(f.test, f.id, { stage: { tag: 'InProgress' }, bracketGeneratedAt: f.test.clock.now() });
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
    });

    it('A136 SI17: refused in a Cancelled and in a Completed tournament', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, (ctx) => M.cancel_tournament(ctx, { tournamentId: f.id }));
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId), 'Stand-ins can be approved once the bracket is generated, until the tournament ends.');

        const g = duel2v2();
        resolveMatch(g.test, g.org, g.m1.id, g.m1.team1Id!);
        advanceStage(g.test, g.org, g.id, 'Completed');
        const sub2 = verified(g.test, 'sub2');
        expectReject(g.test, g.org, approve(g.m1.id, g.m1.team1Id!, sub2.userId), 'Stand-ins can be approved once the bracket is generated, until the tournament ends.');
    });
});

describe('A135(1) SI6: the registration checks apply to a stand-in', () => {
    it('A135(1) SI6: minimum rating in the tournament mode and active season; a user at the floor is accepted', () => {
        const f = duel2v2();
        seedEloConfig(f.test);
        const sub = verified(f.test, 'sub');
        setTournament(f.test, f.id, { minimumMmr: 99999 });
        // S10v review F5: the refusal names the floor, never the user's (private, A40 / A45) rating.
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId), "This tournament needs an MMR of at least 99999; the stand-in's rating is below it.");
        expect(() => tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId))).not.toThrow(/1000/);
        setTournament(f.test, f.id, { minimumMmr: 1000 });
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
    });

    it('A135(1) SI6: requireRoster needs an active HSR account; with one the stand-in is accepted', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        setTournament(f.test, f.id, { requireRoster: true });
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId), 'The stand-in needs an active HSR account in their roster for this tournament.');
        insertHsrAccount(f.test, sub.userId, 'sub-acct');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
    });

    it('A135(1) SI6: requireOwnership needs a game account too; with one the stand-in is accepted', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        setTournament(f.test, f.id, { requireOwnership: true });
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId), 'The stand-in needs an active HSR account in their roster for this tournament.');
        insertHsrAccount(f.test, sub.userId, 'sub-acct');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
    });

    it('A135(1) SI6: requireVerified: a guest is refused (always, A112 sign-in included), a verified user accepted', () => {
        const f = duel2v2(2, { requireVerified: true });
        const g = guest(f.test, 'gst');
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, g.userId), 'A stand-in must be a verified user.');
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
    });

    it('A135(1) SI6: a deleted or banned (deletedAt set) user is refused; an active one accepted', () => {
        const f = duel2v2();
        const gone = verified(f.test, 'gone');
        f.test.db.User.id.update({ ...f.test.db.User.id.find(gone.userId)!, deletedAt: f.test.clock.now() });
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, gone.userId), 'Target user not found.');
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
    });

    it('A135(1) SI6 / A94: deleting an approved stand-in removes the approval and the locks', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        insertHsrAccount(f.test, sub.userId, 'acct');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        tx(f.test, sub, (ctx) => M.delete_my_account(ctx, {}));
        expect(rowsOf(f.test)).toEqual([]);
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
    });
});

describe('A135(2) SI7: staff of the tournament cannot stand in', () => {
    it('A135(2) SI7: the organizer is refused, whoever approves', () => {
        const f = duel2v2();
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, f.org.userId), 'Tournament staff (the organizer and the assistants) cannot be a stand-in.');
        const mod = moderator(f.test, 'mod');
        expectReject(f.test, mod, approve(f.m1.id, f.m1.team1Id!, f.org.userId), 'Tournament staff (the organizer and the assistants) cannot be a stand-in.');
    });

    it('A135(2) SI7: every assistant is refused (with or without permissions); a user who is not staff is accepted', () => {
        const f = duel2v2();
        const pa = verified(f.test, 'pa');
        assignAssistant(f.test, f.org, f.id, pa, { participants: true });
        const none = verified(f.test, 'none');
        assignAssistant(f.test, f.org, f.id, none, {});
        expectReject(f.test, pa, approve(f.m1.id, f.m1.team2Id!, pa.userId), 'Tournament staff (the organizer and the assistants) cannot be a stand-in.');
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team2Id!, none.userId), 'Tournament staff (the organizer and the assistants) cannot be a stand-in.');
        const sub = verified(f.test, 'sub');
        tx(f.test, pa, approve(f.m1.id, f.m1.team2Id!, sub.userId));
    });

    it('A137(1) review F8: nobody approves themself (a Moderator who is not staff included); the organizer may approve that Moderator', () => {
        const f = duel2v2();
        const mod = moderator(f.test, 'mod');
        expectReject(f.test, mod, approve(f.m1.id, f.m1.team1Id!, mod.userId), 'You cannot approve yourself as a stand-in.');
        const admin = verified(f.test, 'adm');
        setUserRole(f.test, admin.userId, 'Admin');
        expectReject(f.test, admin, approve(f.m1.id, f.m1.team1Id!, admin.userId), 'You cannot approve yourself as a stand-in.');
        expect(rowsOf(f.test)).toEqual([]);
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, mod.userId));
        expect(rowsOf(f.test)).toEqual([{ m: f.m1.id, team: f.m1.team1Id, user: mod.userId }]);
    });
});

describe('A135(3) SI8 / SI1: a player whose team is still in cannot stand in', () => {
    it('A135(3) SI8: Seeding after generation: a member of a Ready team (enrolment Registered) is refused; a non-enrolled user accepted', () => {
        const { test, org, id, ts } = seedingField(4);
        seedAndGenerate(test, org, id);
        const m1 = byKey(test, id, 'W-R1-M1');
        const rival = ts.find((t) => t.teamId !== m1.team1Id && t.teamId !== m1.team2Id)!;
        expectReject(test, org, approve(m1.id, m1.team1Id!, rival.mate.userId), 'A player whose team is still in the tournament cannot be a stand-in.');
        const sub = verified(test, 'sub');
        tx(test, org, approve(m1.id, m1.team1Id!, sub.userId));
    });

    it('A135(3) SI8: CheckedIn member of a checked-in team refused; a member of a team Withdrawn at check-in accepted', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true, maxParticipants: 8 });
        const ts = fullTeams(test, id, 3);
        advanceStage(test, org, id, 'CheckIn');
        tx(test, ts[0].captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        tx(test, ts[1].captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        advanceStage(test, org, id, 'Seeding');
        expect(teamRow(test, ts[2].teamId)!.status.tag).toBe('Withdrawn');
        seedAndGenerate(test, org, id);
        const m = bracketRows(test, id).find((r) => r.team1Id !== undefined && r.team2Id !== undefined)!;
        const inTeam = ts.find((t) => t.teamId === m.team1Id)!;
        const otherIn = ts.find((t) => t.teamId === m.team2Id)!;
        expectReject(test, org, approve(m.id, m.team1Id!, otherIn.mate.userId), /cannot be|still in/);
        const team3 = ts[2];
        tx(test, org, approve(m.id, inTeam.teamId, team3.mate.userId));
    });

    it('A135(3) SI8: InProgress: a member of an Active team in another match is refused (P5, P8); an Eliminated player accepted', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const c = f.ts.find((t) => t.teamId === m2.team1Id)!;
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, c.mate.userId), 'A player whose team is still in the tournament cannot be a stand-in.');
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!); // C is eliminated
        expect(teamRow(f.test, c.teamId)!.status.tag).toBe('Eliminated');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, c.mate.userId));
    });

    it('A135(3) SI8: anonymous tournament: a rival still in is refused, an outsider accepted; labels unchanged and opponents see no name', () => {
        const f = duel2v2(4, { isAnonymousDefault: true });
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const rival = f.ts.find((t) => t.teamId === m2.team1Id)!;
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, rival.mate.userId), 'A player whose team is still in the tournament cannot be a stand-in.');
        const sub = verified(f.test, 'outsider');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, sub, f.red.captain, f.red.mate]) join(f.test, p, lobbyId);
        const seq = seatOf(f.test, lobbyId, sub.userId);
        const seenByOpponent = viewAs(f.test, 'view_my_lobby_members', f.red.captain, { lobbyId }).find((r) => r.joinSeq === seq);
        expect(seenByOpponent.userId).toBe(0);
        expect(seenByOpponent.label).toBe(`Blue Player #${seq}`);
        expect(viewAs(f.test, 'view_my_stand_ins', f.red.captain)).toEqual([]);
    });

    it('A135(3) SI1: a stand-in row of a player whose team is then placed into the same match is deleted (audit P2)', () => {
        const f = liveField(4);
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const fin = bracketRows(f.test, f.id).find((r) => r.id !== m1.id && r.id !== m2.id)!;
        const teamA = m1.team1Id!;
        const c = f.ts.find((t) => t.teamId === m2.team1Id)!;
        resolveMatch(f.test, f.org, m1.id, teamA);
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!); // C eliminated, D in the final
        tx(f.test, f.org, approve(fin.id, teamA, c.mate.userId)); // accepted: C is out
        tx(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m2.id, reason: 'x' }));
        resolveMatch(f.test, f.org, m2.id, c.teamId); // C now plays the final
        expect(matchRow(f.test, fin.id).team2Id).toBe(c.teamId);
        expect(rowsOf(f.test)).toEqual([]);
    });

    it('A135(3) SI1: a member of one team of the match never gets the other side, even with a stand-in row for it', () => {
        const f = duel2v2();
        // a conflicting row written straight into the datastore (no reducer can create it any more)
        f.test.db.TournamentStandIn.insert({ id: 0, bracketMatchId: f.m1.id, teamId: f.m1.team1Id!, userId: f.red.mate.userId, approvedByUserId: f.org.userId, ...AUDIT(f.test) });
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, f.red.mate, lobbyId);
        expect(slotOf(f.test, lobbyId, f.red.mate)).toBe('RedPlayer');
        expectReject(f.test, f.red.mate, setSelf(lobbyId, 'BluePlayer'), 'This seat is not available to you in this tournament lobby.');
        tx(f.test, f.red.mate, setSelf(lobbyId, 'Spectator'));
        tx(f.test, f.red.mate, setSelf(lobbyId, 'RedPlayer'));
    });
});

describe('A138 (A135(4) as superseded): no automatic seat moves; the host moves people by hand', () => {
    it('A138: a member joining a full side with a stand-in seated becomes Spectator; nobody is moved', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, f.blue.captain, lobbyId);
        join(f.test, sub, lobbyId);
        tx(f.test, sub, confirm(lobbyId));
        join(f.test, f.blue.mate, lobbyId);
        expect(slotOf(f.test, lobbyId, f.blue.mate)).toBe('Spectator');
        expect(slotOf(f.test, lobbyId, sub)).toBe('BluePlayer');
        expect(member(f.test, lobbyId, sub.userId).isConfirmed).toBe(true);
        expect(slotOf(f.test, lobbyId, f.blue.captain)).toBe('BluePlayer');
    });

    it('A138: automatic seating into a free seat on join is unchanged (member or stand-in)', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, sub, lobbyId);
        join(f.test, f.blue.mate, lobbyId);
        expect([slotOf(f.test, lobbyId, sub), slotOf(f.test, lobbyId, f.blue.mate)]).toEqual(['BluePlayer', 'BluePlayer']);
    });

    it('A138: a member\'s own seat request for a full side is refused as full; so is a stand-in\'s', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        const sub2 = verified(f.test, 'sub2');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub2.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, f.blue.captain, lobbyId);
        join(f.test, sub, lobbyId);
        join(f.test, f.blue.mate, lobbyId);
        join(f.test, sub2, lobbyId);
        expectReject(f.test, f.blue.mate, setSelf(lobbyId, 'BluePlayer'), 'Blue team is full (max 2 players).');
        expectReject(f.test, sub2, setSelf(lobbyId, 'BluePlayer'), 'Blue team is full (max 2 players).');
        expect(slotOf(f.test, lobbyId, sub)).toBe('BluePlayer');
    });

    it('A138 / A137(3): the host moves the stand-in out and then the member in; moving the member first is refused as full', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id); // org = host
        join(f.test, f.blue.captain, lobbyId);
        join(f.test, sub, lobbyId);
        join(f.test, f.blue.mate, lobbyId);
        expectReject(f.test, f.org, moveOther(f.test, lobbyId, f.blue.mate, 'BluePlayer'), 'Blue team is full (max 2 players).');
        tx(f.test, f.org, moveOther(f.test, lobbyId, sub, 'Spectator'));
        tx(f.test, f.org, moveOther(f.test, lobbyId, f.blue.mate, 'BluePlayer'));
        expect([slotOf(f.test, lobbyId, sub), slotOf(f.test, lobbyId, f.blue.mate)]).toEqual(['Spectator', 'BluePlayer']);
    });

    it('A138 (captain kept): the team captain moves a stand-in of the own team to Spectator; a mate, the other captain, or another target are refused', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, sub, f.red.captain, f.red.mate, f.blue.mate]) join(f.test, p, lobbyId);
        const NOT_HOST = 'Only the host, moderators, or admins can perform this action.';
        expectReject(f.test, f.red.captain, moveOther(f.test, lobbyId, sub, 'Spectator'), NOT_HOST);
        expectReject(f.test, f.blue.captain, moveOther(f.test, lobbyId, f.red.mate, 'Spectator'), NOT_HOST);
        expectReject(f.test, f.blue.captain, moveOther(f.test, lobbyId, sub, 'BlueCoach'), NOT_HOST);
        expectReject(f.test, f.blue.mate, moveOther(f.test, lobbyId, sub, 'Spectator'), NOT_HOST);
        tx(f.test, f.blue.captain, moveOther(f.test, lobbyId, sub, 'Spectator'));
        expect(slotOf(f.test, lobbyId, sub)).toBe('Spectator');
        tx(f.test, f.blue.mate, setSelf(lobbyId, 'BluePlayer')); // the freed seat is taken by hand
        expect(slotOf(f.test, lobbyId, f.blue.mate)).toBe('BluePlayer');
    });

    it('A138: nothing changes once the game has started: a member joining mid-game watches, the stand-in keeps the seat', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, sub, f.red.captain, f.red.mate]) { join(f.test, p, lobbyId); tx(f.test, p, confirm(lobbyId)); }
        tx(f.test, f.org, start(lobbyId));
        join(f.test, f.blue.mate, lobbyId);
        expect(slotOf(f.test, lobbyId, f.blue.mate)).toBe('Spectator');
        expect(slotOf(f.test, lobbyId, sub)).toBe('BluePlayer');
    });
});

describe('A135(5) SI11: at least one real member plays each game', () => {
    it('A135(5) SI11: start refused with a side of stand-ins only (audit P8); accepted once the host seats one member', () => {
        const f = duel2v2();
        const sub1 = verified(f.test, 'sub1');
        const sub2 = verified(f.test, 'sub2');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub1.userId));
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub2.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [sub1, sub2, f.red.captain, f.red.mate]) { join(f.test, p, lobbyId); tx(f.test, p, confirm(lobbyId)); }
        expectReject(f.test, f.org, start(lobbyId), 'Blue team needs at least one of its own members seated as a player; stand-ins cannot play without one.');
        join(f.test, f.blue.captain, lobbyId);
        expect(slotOf(f.test, lobbyId, f.blue.captain)).toBe('Spectator'); // A138: no take-over
        tx(f.test, f.org, moveOther(f.test, lobbyId, sub2, 'Spectator'));
        tx(f.test, f.org, moveOther(f.test, lobbyId, f.blue.captain, 'BluePlayer'));
        tx(f.test, f.blue.captain, confirm(lobbyId));
        tx(f.test, f.org, start(lobbyId));
        expect(lobbyRow(f.test, lobbyId).stage.tag).toBe('Drafting');
    });

    it('A135(5) SI11: no cap on approvals: six stand-ins approved for one team (audit P8)', () => {
        const f = duel2v2();
        for (let i = 0; i < 6; i++) tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, verified(f.test, 'sub' + i).userId));
        expect(rowsOf(f.test)).toHaveLength(6);
    });

    it('A135(5) SI11: 3v3: one member with two stand-ins starts; three stand-ins do not', () => {
        const { test, org, m, blue, red } = field3v3();
        const subs = [verified(test, 's1'), verified(test, 's2'), verified(test, 's3')];
        for (const s of subs) tx(test, org, approve(m.id, m.team1Id!, s.userId));
        const lobbyId = createTournamentLobby(test, org, m.id);
        for (const p of [...subs, ...red]) { join(test, p, lobbyId); tx(test, p, confirm(lobbyId)); }
        expectReject(test, org, start(lobbyId), 'Blue team needs at least one of its own members seated as a player; stand-ins cannot play without one.');
        join(test, blue[0], lobbyId);
        tx(test, org, moveOther(test, lobbyId, subs[2], 'Spectator'));
        tx(test, org, moveOther(test, lobbyId, blue[0], 'BluePlayer'));
        tx(test, blue[0], confirm(lobbyId));
        tx(test, org, start(lobbyId));
    });

    it('A135(5) SI11: a solo tournament cannot field a stand-in (audit P1); a team tournament can', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 8 });
        enrollMany(test, id, 2, 's');
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        advanceStage(test, org, id, 'InProgress');
        const m = bracketRows(test, id)[0];
        const sub = verified(test, 'sub');
        expectReject(test, org, approve(m.id, m.team1Id!, sub.userId), 'A solo tournament cannot field a stand-in: a team member must play every game.');
        const f = duel2v2();
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, verified(f.test, 'x').userId));
    });
});

describe('A135(6) SI15: staff see the approvals', () => {
    it('A135(6) SI15: organizer and an assistant with a permission see who, for which team and match, approved by whom and when; others see nothing', () => {
        const f = duel2v2();
        const pa = verified(f.test, 'pa');
        assignAssistant(f.test, f.org, f.id, pa, { participants: true });
        const none = verified(f.test, 'none');
        assignAssistant(f.test, f.org, f.id, none, {});
        const sub = verified(f.test, 'sub');
        tx(f.test, pa, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const expected = {
            tournamentId: f.id, bracketMatchId: f.m1.id, teamId: f.m1.team1Id, userId: sub.userId, userLabel: 'sub',
            approvedByUserId: pa.userId, approvedByLabel: 'pa',
        };
        for (const who of [f.org, pa]) {
            const rows = viewAs(f.test, 'view_my_tournament_stand_ins', who);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject(expected);
            expect(rows[0].approvedAt.microsSinceUnixEpoch).toBe(f.test.clock.now().microsSinceUnixEpoch);
        }
        expect(viewAs(f.test, 'view_my_tournament_stand_ins', none)).toEqual([]);
        expect(viewAs(f.test, 'view_my_tournament_stand_ins', f.red.captain)).toEqual([]);
        expect(viewAs(f.test, 'view_my_tournament_stand_ins', sub)).toEqual([]);
        expect(viewAs(f.test, 'view_my_stand_ins', f.red.captain)).toEqual([]);
    });
});

describe('A135(8) SI3: a stand-in locks an account added later, within the A104 limit', () => {
    it('A135(8) SI3: accepted before the first game; refused after it started; refused for a user who is no stand-in (audit P3c)', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        const acct = insertHsrAccount(f.test, sub.userId, 'later');
        tx(f.test, sub, lockAccounts(f.id, [acct]));
        expect(locks(f.test, f.id, sub.userId)).toEqual([acct]);
        const stranger = verified(f.test, 'stranger');
        const sAcct = insertHsrAccount(f.test, stranger.userId, 's');
        expectReject(f.test, stranger, lockAccounts(f.id, [sAcct]), 'You are not registered for this tournament.');
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, sub, f.red.captain, f.red.mate]) { join(f.test, p, lobbyId); tx(f.test, p, confirm(lobbyId)); }
        tx(f.test, f.org, start(lobbyId));
        const acct2 = insertHsrAccount(f.test, sub.userId, 'later2');
        expectReject(f.test, sub, lockAccounts(f.id, [acct2]), 'Your first game of this tournament has started; accounts can no longer be locked.');
    });
});

describe('SI2 / review F7, F11: the account-lock snapshot is taken at the stand-in\'s own first participation', () => {
    it('F7: an approval alone locks nothing; the user can still delete an account', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        const acct = insertHsrAccount(f.test, sub.userId, 'sub-acct');
        insertHsrAccount(f.test, sub.userId, 'sub-acct2');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        tx(f.test, sub, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: acct }));
    });

    // T-S10v (A140): the audit's P3a creator case is gone (a plain stand-in cannot create); the subject is kept with a
    // member creating and the stand-in joining: locked and selected at the join, the ranked game starts.
    it('SI2 (A140 re-aligned): a stand-in joining a member-created lobby is locked and selected at the join; the ranked game starts', () => {
        const f = duel2v2(2, { countTowardsMmr: true });
        const sub = verified(f.test, 'sub');
        const acct = insertHsrAccount(f.test, sub.userId, 'sub-acct');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        const lobbyId = createTournamentLobby(f.test, f.blue.captain, f.m1.id);
        f.test.db.LobbyMemberAccount.insert({ lobbyId, userId: f.blue.captain.userId, hsrAccountId: insertHsrAccount(f.test, f.blue.captain.userId, 'cap') });
        join(f.test, sub, lobbyId);
        expect(slotOf(f.test, lobbyId, sub)).toBe('BluePlayer');
        expect(locks(f.test, f.id, sub.userId)).toEqual([acct]);
        expect([...f.test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, sub.userId])].map((r) => r.hsrAccountId)).toEqual([acct]);
        for (const p of [f.red.captain, f.red.mate]) {
            join(f.test, p, lobbyId);
            const a = insertHsrAccount(f.test, p.userId, 'x' + p.userId);
            f.test.db.LobbyMemberAccount.insert({ lobbyId, userId: p.userId, hsrAccountId: a });
        }
        for (const p of [sub, f.blue.captain, f.red.captain, f.red.mate]) tx(f.test, p, confirm(lobbyId));
        expect(slotOf(f.test, lobbyId, sub)).toBe('BluePlayer');
        tx(f.test, f.blue.captain, start(lobbyId)); // the member creator is the referee
    });

    it('SI2: a user watching before the approval can take the seat and select (audit P3b); an account added after a first join still locks at join', () => {
        const f = duel2v2(2, { countTowardsMmr: true });
        const sub = verified(f.test, 'sub');
        const acct = insertHsrAccount(f.test, sub.userId, 'sub-acct');
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, sub, lobbyId);
        expect(slotOf(f.test, lobbyId, sub)).toBe('Spectator');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]); // F7: watching + approved: nothing locked yet
        tx(f.test, sub, setSelf(lobbyId, 'BluePlayer'));       // F7: taking the seat is the participation
        expect(locks(f.test, f.id, sub.userId)).toEqual([acct]);
        expect([...f.test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, sub.userId])].map((r) => r.hsrAccountId)).toEqual([acct]);

        const late = verified(f.test, 'late'); // no account at approval: the join snapshot still applies
        tx(f.test, f.org, approve(f.m1.id, f.m1.team2Id!, late.userId));
        const lateAcct = insertHsrAccount(f.test, late.userId, 'late-acct');
        join(f.test, late, lobbyId);
        expect(locks(f.test, f.id, late.userId)).toEqual([lateAcct]);
    });
});

describe('SI4: revoke unseats in a Waiting lobby', () => {
    it('SI4: revoked while seated in Waiting -> Spectator (audit P4); a game already running keeps the seat', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, sub, f.red.captain, f.red.mate]) join(f.test, p, lobbyId);
        tx(f.test, f.org, revoke(f.m1.id, sub.userId));
        expect(slotOf(f.test, lobbyId, sub)).toBe('Spectator');
        expectReject(f.test, sub, setSelf(lobbyId, 'BluePlayer'), 'This seat is not available to you in this tournament lobby.');

        const g = duel2v2();
        const sub2 = verified(g.test, 'sub2');
        tx(g.test, g.org, approve(g.m1.id, g.m1.team1Id!, sub2.userId));
        const l2 = createTournamentLobby(g.test, g.org, g.m1.id);
        for (const p of [g.blue.captain, sub2, g.red.captain, g.red.mate]) { join(g.test, p, l2); tx(g.test, p, confirm(l2)); }
        tx(g.test, g.org, start(l2));
        tx(g.test, g.org, revoke(g.m1.id, sub2.userId));
        expect(slotOf(g.test, l2, sub2)).toBe('BluePlayer');
    });
});

describe('SI5: a disqualified stand-in loses the approvals', () => {
    it('SI5: DQ removes the approval and unseats in Waiting (audit P5); an approval of another user stays', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const c = f.ts.find((t) => t.teamId === m2.team1Id)!;
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!); // C out, its players can stand in
        const other = verified(f.test, 'other');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, c.mate.userId));
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, other.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, c.mate, lobbyId);
        expect(slotOf(f.test, lobbyId, c.mate)).toBe('BluePlayer');
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: c.mate.userId, reason: 'x', dqWholeTeam: false }));
        expect(rowsOf(f.test)).toEqual([{ m: f.m1.id, team: f.m1.team1Id, user: other.userId }]);
        expect(slotOf(f.test, lobbyId, c.mate)).toBe('Spectator');
    });
});

describe('SI12: stand-in locks are released', () => {
    it('SI12: on revoke, a stand-in not enrolled, without another open approval, who has not played: locks released (audit P12)', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const sub = verified(f.test, 'sub');
        const acct = insertHsrAccount(f.test, sub.userId, 'a');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        tx(f.test, f.org, approve(m2.id, m2.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, sub, lobbyId); // F7: the join takes the locks
        expect(locks(f.test, f.id, sub.userId)).toEqual([acct]);
        tx(f.test, f.org, revoke(f.m1.id, sub.userId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([acct]); // another open approval
        tx(f.test, f.org, revoke(m2.id, sub.userId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        tx(f.test, sub, (ctx) => M.leave_lobby(ctx, { lobbyId })); // the lobby's account selection is separate from the lock
        tx(f.test, sub, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: acct }));
    });

    it('SI12: after the match is decided a stand-in who did not play is released; an enrolled (eliminated) stand-in keeps the enrolment locks', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const c = f.ts.find((t) => t.teamId === m2.team1Id)!;
        const sub = verified(f.test, 'sub');
        const subAcct = insertHsrAccount(f.test, sub.userId, 'a');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        tx(f.test, sub, lockAccounts(f.id, [subAcct])); // SI3: the stand-in's own lock
        expect(locks(f.test, f.id, sub.userId)).toEqual([subAcct]);
        // review F15: the entrant holds a real enrolment lock before and after
        const cAcct = insertHsrAccount(f.test, c.mate.userId, 'c-own');
        tx(f.test, c.mate, lockAccounts(f.id, [cAcct]));
        advance(f.test, 1000); // the entrant's lock predates the approval (T-S11a: an Entry lock, A143; the time no longer matters)
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!);
        expect(locks(f.test, f.id, c.mate.userId)).toEqual([cAcct]);
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, c.mate.userId));
        resolveMatch(f.test, f.org, f.m1.id, f.m1.team1Id!);
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        expect(locks(f.test, f.id, c.mate.userId)).toEqual([cAcct]);
    });

    it('SI12: a stand-in who played keeps the locks after a revoke until the end, then the sweep releases them (Cancelled, audit P4)', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        const acct = insertHsrAccount(f.test, sub.userId, 'a');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, sub, f.red.captain, f.red.mate]) { join(f.test, p, lobbyId); tx(f.test, p, confirm(lobbyId)); }
        tx(f.test, f.org, start(lobbyId));
        tx(f.test, f.org, revoke(f.m1.id, sub.userId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([acct]);
        tx(f.test, f.org, (ctx) => M.cancel_tournament(ctx, { tournamentId: f.id }));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
    });

    it('SI12: Completed: the locks of a revoked stand-in who played are swept; enrolled players keep theirs', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        insertHsrAccount(f.test, sub.userId, 'a');
        // review F15: an enrolled player with a real lock
        const capAcct = insertHsrAccount(f.test, f.blue.captain.userId, 'cap-own');
        tx(f.test, f.blue.captain, lockAccounts(f.id, [capAcct]));
        advance(f.test, 1000);
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        const players = [f.blue.captain, sub, f.red.captain, f.red.mate];
        for (const p of players) { join(f.test, p, lobbyId); tx(f.test, p, confirm(lobbyId)); }
        tx(f.test, f.org, start(lobbyId));
        const s: Lobby = { test: f.test, lobbyId, host: f.org, a: { host: f.org, b1: f.blue.captain, b2: sub, r1: f.red.captain, r2: f.red.mate } };
        playLobbyGame(s, 'Blue');
        expect(matchRow(f.test, f.m1.id).state.tag).toBe('Decided'); // requireResultValidation off: the close validates
        expect(locks(f.test, f.id, sub.userId)).not.toEqual([]); // played
        tx(f.test, f.org, revoke(f.m1.id, sub.userId));
        const captainLocks = locks(f.test, f.id, f.blue.captain.userId);
        advanceStage(f.test, f.org, f.id, 'Completed');
        drain(f.test, f.id);
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        expect(captainLocks).toEqual([capAcct]);
        expect(locks(f.test, f.id, f.blue.captain.userId)).toEqual([capAcct]);
    });
});

describe('SI13: approval needs an open match', () => {
    it('SI13: a Decided match and a bye (Walkover) are refused (audit P8); a Pending match with the team placed is accepted', () => {
        const f = duel2v2(4);
        const sub = verified(f.test, 'sub');
        resolveMatch(f.test, f.org, f.m1.id, f.m1.team1Id!);
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team2Id!, sub.userId), 'Stand-ins can only be approved for a match that is still open (Pending or Ready).');
        const fin = bracketRows(f.test, f.id).find((r) => r.team1Id === f.m1.team1Id && r.id !== f.m1.id)!;
        expect(fin.state.tag).toBe('Pending');
        tx(f.test, f.org, approve(fin.id, f.m1.team1Id!, sub.userId));

        const g = liveField(3);
        const bye = bracketRows(g.test, g.id).find((r) => r.state.tag === 'Walkover')!;
        const s2 = verified(g.test, 'sub2');
        expectReject(g.test, g.org, approve(bye.id, bye.winnerTeamId!, s2.userId), 'Stand-ins can only be approved for a match that is still open (Pending or Ready).');
    });
});

describe('SI14: a slot that changes team drops the old team\'s stand-ins', () => {
    it('SI14: after a re-resolve the stale row is gone and the same user is approved for the new team (audit P9)', () => {
        const f = liveField(4);
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const fin = bracketRows(f.test, f.id).find((r) => r.id !== m1.id && r.id !== m2.id)!;
        resolveMatch(f.test, f.org, m1.id, m1.team1Id!);
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(fin.id, m1.team1Id!, sub.userId));
        tx(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m1.id, reason: 'x' }));
        expect(rowsOf(f.test)).toEqual([]);
        resolveMatch(f.test, f.org, m1.id, m1.team2Id!);
        expect(viewAs(f.test, 'view_my_stand_ins', sub)).toEqual([]);
        tx(f.test, f.org, approve(fin.id, m1.team2Id!, sub.userId));
        expect(rowsOf(f.test)).toEqual([{ m: fin.id, team: m1.team2Id, user: sub.userId }]);
    });
});

describe('SI16: a stand-in sees the match and its calendar event', () => {
    it('SI16: view_tournament_matches_for_me lists the match for the stand-in (audit P10); revoked, it is gone', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        expect(viewAs(f.test, 'view_tournament_matches_for_me', sub)).toEqual([]);
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const rows = viewAs(f.test, 'view_tournament_matches_for_me', sub);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ bracketMatchId: f.m1.id, myTeamId: f.m1.team1Id, opponentTeamId: f.m1.team2Id });
        tx(f.test, f.org, revoke(f.m1.id, sub.userId));
        expect(viewAs(f.test, 'view_tournament_matches_for_me', sub)).toEqual([]);
    });

    it('SI16: the stand-in sees the match event and gets an invite like the members, approved before or after the event; revoke removes it', () => {
        const f = duel2v2();
        const now = f.test.clock.now().microsSinceUnixEpoch;
        const before = verified(f.test, 'before');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, before.userId));
        tx(f.test, f.org, (ctx) => M.create_calendar_event(ctx, {
            title: 'M1', description: '', startAt: String(now + 3_600_000_000n), endAt: String(now + 7_200_000_000n), bracketMatchId: f.m1.id, inviteeUserIds: '',
        }));
        const event = [...f.test.db.CalendarEvent.bracket_match_id.filter(f.m1.id)][0];
        const invited = (u: Actor) => [...f.test.db.CalendarEventInvite.by_event_and_invitee.filter([event.id, u.userId])].length === 1;
        expect(invited(f.blue.captain)).toBe(true);
        expect(invited(before)).toBe(true);
        const after = verified(f.test, 'after');
        expect(viewAs(f.test, 'view_my_calendar_events', after)).toEqual([]);
        tx(f.test, f.org, approve(f.m1.id, f.m1.team2Id!, after.userId));
        expect(invited(after)).toBe(true);
        expect(viewAs(f.test, 'view_my_calendar_events', after).map((e) => e.id)).toEqual([event.id]);
        tx(f.test, f.org, revoke(f.m1.id, after.userId));
        expect(invited(after)).toBe(false);
        expect(viewAs(f.test, 'view_my_calendar_events', after)).toEqual([]);
    });
});

describe('A35 scope: one bracket match, every game of it', () => {
    it('A135 / A35: in a best of 3 the approval seats the stand-in in each game lobby of the match (audit P13)', () => {
        const f = duel2v2(2, { defaultBestOf: 3, grandFinalBestOf: 3 });
        expect(f.m1.bestOf).toBe(3);
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const players = [f.blue.captain, sub, f.red.captain, f.red.mate];
        for (let game = 1; game <= 2; game++) {
            const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
            for (const p of players) { join(f.test, p, lobbyId); tx(f.test, p, confirm(lobbyId)); }
            expect(slotOf(f.test, lobbyId, sub)).toBe('BluePlayer');
            tx(f.test, f.org, start(lobbyId));
            const s: Lobby = { test: f.test, lobbyId, host: f.org, a: { host: f.org, b1: f.blue.captain, b2: sub, r1: f.red.captain, r2: f.red.mate } };
            playLobbyGame(s, 'Blue');
            expect([...f.test.db.MatchResultRecord.lobby_id.filter(lobbyId)][0].status.tag).toBe('Validated');
        }
        expect(matchRow(f.test, f.m1.id).state.tag).toBe('Decided');
    });

    it('A135 / A35: the approval does not carry to the next match (single and double elimination)', () => {
        const f = duel2v2(4);
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        resolveMatch(f.test, f.org, f.m1.id, f.m1.team1Id!);
        resolveMatch(f.test, f.org, m2.id, m2.team1Id!);
        const fin = bracketRows(f.test, f.id).find((r) => r.id !== f.m1.id && r.id !== m2.id)!;
        const lobbyId = createTournamentLobby(f.test, f.org, fin.id);
        join(f.test, sub, lobbyId);
        expect(slotOf(f.test, lobbyId, sub)).toBe('Spectator');
        expectReject(f.test, sub, setSelf(lobbyId, 'BluePlayer'), 'This seat is not available to you in this tournament lobby.');

        const d = duel2v2(4, { format: 'DoubleElimination' });
        const dsub = verified(d.test, 'dsub');
        tx(d.test, d.org, approve(d.m1.id, d.m1.team2Id!, dsub.userId));
        const dm2 = byKey(d.test, d.id, 'W-R1-M2');
        resolveMatch(d.test, d.org, d.m1.id, d.m1.team1Id!);
        resolveMatch(d.test, d.org, dm2.id, dm2.team1Id!);
        const losers = matchRow(d.test, d.m1.nextLoserMatchId!);
        expect([losers.team1Id, losers.team2Id]).toContain(d.m1.team2Id);
        expect(losers.state.tag).toBe('Ready');
        const l2 = createTournamentLobby(d.test, d.org, losers.id);
        join(d.test, dsub, l2);
        expect(slotOf(d.test, l2, dsub)).toBe('Spectator');
    });
});

describe('S10v fix pass: A137 and review findings', () => {
    it('A137(2): an assistant with every permission off is staff and refused; an outsider approved by that tournament\'s organizer is accepted', () => {
        const f = duel2v2();
        const none = verified(f.test, 'none');
        assignAssistant(f.test, f.org, f.id, none, {});
        expectReject(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, none.userId), 'Tournament staff (the organizer and the assistants) cannot be a stand-in.');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, verified(f.test, 'out').userId));
    });

    it('A137(4): register_for_tournament in a requireOwnership tournament needs an active game account; with one it is accepted', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { requireOwnership: true, requireVerified: true });
        const p = verified(test, 'p');
        expectReject(test, p, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }), 'This tournament requires an active HSR account in your roster.');
        insertHsrAccount(test, p.userId, 'p-acct');
        register(test, p, id);
    });

    it('review F1 / A135(3): a roll-back that makes a team active again removes its members\' approvals, seats and locks', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const d = f.ts.find((t) => t.teamId === m2.team2Id)!;
        resolveMatch(f.test, f.org, m2.id, m2.team1Id!); // D eliminated
        const acct = insertHsrAccount(f.test, d.mate.userId, 'd-acct');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, d.mate.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, d.mate, lobbyId);
        expect(slotOf(f.test, lobbyId, d.mate)).toBe('BluePlayer');
        expect(locks(f.test, f.id, d.mate.userId)).toEqual([acct]);
        tx(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m2.id, reason: 'x' }));
        expect(teamRow(f.test, d.teamId)!.status.tag).toBe('Active');
        expect(rowsOf(f.test)).toEqual([]);
        expect(slotOf(f.test, lobbyId, d.mate)).toBe('Spectator');
        expect(locks(f.test, f.id, d.mate.userId)).toEqual([]); // F10: the locks came through the stand-in path (T-S11a: origin StandIn, A143)
    });

    it('review F2 / A112: an existing user receiving a guest\'s entry on a team still in loses every approval in that tournament', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2, maxParticipants: 8 });
        fullTeams(test, id, 3, 'v');
        const g = guest(test, 'g-si');
        const mate = verified(test, 'mate-si');
        register(test, g, id);
        register(test, mate, id);
        const gTeam = makeTeam(test, id, g, [mate], 'Guest team');
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        advanceStage(test, org, id, 'InProgress');
        const e = guest(test, 'existing');
        linkDiscord(test, e, 'pid-existing-f2', 'Existing');
        const unrelated = bracketRows(test, id).find((r) => r.team1Id !== undefined && r.team2Id !== undefined && r.team1Id !== gTeam && r.team2Id !== gTeam)!;
        tx(test, org, approve(unrelated.id, unrelated.team1Id!, e.userId));
        expect(rowsOf(test)).toHaveLength(1);
        linkDiscord(test, g, 'pid-existing-f2', 'ignored');
        expect(rowsOf(test)).toEqual([]);
    });

    it('review F3: a stand-in made assistant loses the approval (assignment accepted) and the seat', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, sub, lobbyId);
        expect(slotOf(f.test, lobbyId, sub)).toBe('BluePlayer');
        assignAssistant(f.test, f.org, f.id, sub, { bracket: true });
        expect(rowsOf(f.test)).toEqual([]);
        expect(slotOf(f.test, lobbyId, sub)).toBe('Spectator');
    });

    it('review F3 / A121: a stand-in who becomes organizer by the hand-over loses the approval', () => {
        const f = duel2v2();
        const admin = verified(f.test, 'boss');
        setUserRole(f.test, admin.userId, 'Admin');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, admin.userId));
        tx(f.test, admin, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(f.org.userId) }));
        fireDeletionJob(f.test, f.org.userId);
        expect(tRow(f.test, f.id).organizerId).toBe(admin.userId);
        expect(rowsOf(f.test)).toEqual([]);
    });

    it('review F4: a match event is created whatever the approvals: members first, stand-ins while room is left (9 invites)', () => {
        const f = duel2v2();
        const subs = Array.from({ length: 6 }, (_, i) => verified(f.test, 'sub' + i));
        for (const s of subs) tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, s.userId));
        const now = f.test.clock.now().microsSinceUnixEpoch;
        tx(f.test, f.org, (ctx) => M.create_calendar_event(ctx, {
            title: 'M1', description: '', startAt: String(now + 3_600_000_000n), endAt: String(now + 7_200_000_000n), bracketMatchId: f.m1.id, inviteeUserIds: '',
        }));
        const event = [...f.test.db.CalendarEvent.bracket_match_id.filter(f.m1.id)][0];
        const invitees = [...f.test.db.CalendarEventInvite.event_id.filter(event.id)].map((r) => r.inviteeUserId);
        expect(invitees).toHaveLength(9);
        for (const p of [f.blue.captain, f.blue.mate, f.red.captain, f.red.mate]) expect(invitees).toContain(p.userId);
        const last = subs[5];
        expect(invitees).not.toContain(last.userId);
        expect(viewAs(f.test, 'view_my_calendar_events', last).map((e) => e.id)).toEqual([event.id]);
    });

    it('review F6: a disqualified member seated in a Waiting lobby is moved to Spectator; the other members keep their seats', () => {
        const f = duel2v2();
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, f.blue.mate]) join(f.test, p, lobbyId);
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: f.blue.mate.userId, reason: 'x', dqWholeTeam: false }));
        expect(slotOf(f.test, lobbyId, f.blue.mate)).toBe('Spectator');
        expect(slotOf(f.test, lobbyId, f.blue.captain)).toBe('BluePlayer');
    });

    it('review F9: the team captain moves an own stand-in to Spectator even when the spectator seats are full', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id); // org watches: 1 spectator
        f.test.db.Lobby.id.update({ ...lobbyRow(f.test, lobbyId), maxSpectators: 1 });
        join(f.test, f.blue.captain, lobbyId);
        join(f.test, sub, lobbyId);
        tx(f.test, f.blue.captain, moveOther(f.test, lobbyId, sub, 'Spectator'));
        expect(slotOf(f.test, lobbyId, sub)).toBe('Spectator');
    });

    it('review F10: an enrolled user without locks who gets them through the stand-in path loses them by the stand-in rules', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const c = f.ts.find((t) => t.teamId === m2.team1Id)!;
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!); // C out; c.mate is enrolled and holds no lock
        expect(locks(f.test, f.id, c.mate.userId)).toEqual([]);
        const acct = insertHsrAccount(f.test, c.mate.userId, 'c-new');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, c.mate.userId));
        join(f.test, c.mate, createTournamentLobby(f.test, f.org, f.m1.id));
        expect(locks(f.test, f.id, c.mate.userId)).toEqual([acct]);
        tx(f.test, f.org, revoke(f.m1.id, c.mate.userId));
        expect(locks(f.test, f.id, c.mate.userId)).toEqual([]);
    });

    it('review F12: a side whose only member sits as coach is refused with "seated as a player"', () => {
        const f = duel2v2();
        const s1 = verified(f.test, 's1');
        const s2 = verified(f.test, 's2');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, s1.userId));
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, s2.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [s1, s2, f.red.captain, f.red.mate]) join(f.test, p, lobbyId);
        join(f.test, f.blue.captain, lobbyId); // A138: Spectator (side full)
        tx(f.test, f.org, moveOther(f.test, lobbyId, f.blue.captain, 'BlueCoach'));
        for (const p of [s1, s2, f.red.captain, f.red.mate]) tx(f.test, p, confirm(lobbyId));
        expectReject(f.test, f.org, start(lobbyId), 'Blue team needs at least one of its own members seated as a player; stand-ins cannot play without one.');
    });
});

describe('S10v review G1 / N5: every seated stand-in passes the lock snapshot before a start; in ranked and ownership tournaments it starts with a selected account', () => {
    const lmaOfUser = (test: Harness, lobbyId: number, userId: number) =>
        [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])].map((r) => r.hsrAccountId);

    for (const kind of ['ranked', 'ownership', 'plain'] as const) {
        it(`G1: a watching stand-in seated by the host is locked and selected when confirming; the start sees both (${kind})`, () => {
            const f = duel2v2(2, kind === 'ranked' ? { countTowardsMmr: true } : {});
            if (kind === 'ownership') setTournament(f.test, f.id, { requireOwnership: true });
            const sub = verified(f.test, 'sub');
            const acct = ownedAccount(f.test, sub.userId, 'sub-acct', ['sx']);
            for (const p of [f.blue.captain, f.red.captain, f.red.mate]) {
                lockAccount(f.test, f.id, p.userId, ownedAccount(f.test, p.userId, 'acc' + p.userId, ['c' + p.userId]));
            }
            const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
            join(f.test, sub, lobbyId);                                 // watching
            tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
            tx(f.test, f.org, moveOther(f.test, lobbyId, sub, 'BluePlayer')); // the host seats them (A138)
            expect(locks(f.test, f.id, sub.userId)).toEqual([]);        // not the stand-in's own act
            expect(lmaOfUser(f.test, lobbyId, sub.userId)).toEqual([]);
            for (const p of [f.blue.captain, f.red.captain, f.red.mate]) join(f.test, p, lobbyId);
            for (const p of [sub, f.blue.captain, f.red.captain, f.red.mate]) tx(f.test, p, confirm(lobbyId));
            expect(locks(f.test, f.id, sub.userId)).toEqual([acct]);    // confirm_ready = participation
            expect(lmaOfUser(f.test, lobbyId, sub.userId)).toEqual([acct]);
            tx(f.test, f.org, start(lobbyId));
            expect(lobbyRow(f.test, lobbyId).stage.tag).toBe('Drafting');
        });
    }

    it('G1 (a): ownership, host-seated stand-in seated first is captain and picks an owned character', () => {
        const f = duel2v2();
        setTournament(f.test, f.id, { requireOwnership: true });
        const sub = verified(f.test, 'sub');
        const acct = ownedAccount(f.test, sub.userId, 'sub-acct', ['sx']);
        for (const p of [f.blue.captain, f.red.captain, f.red.mate]) {
            lockAccount(f.test, f.id, p.userId, ownedAccount(f.test, p.userId, 'acc' + p.userId, ['c' + p.userId]));
        }
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        priceCharacters(f.test, lobbyId, ['sx', ...[f.blue.captain, f.red.captain, f.red.mate].map((p) => 'c' + p.userId)]);
        const settings = settingsFrom(f.test, lobbyId, { banMode: { tag: 'None' } }); // read outside the transaction
        tx(f.test, f.org, (ctx) => M.update_lobby_settings(ctx, settings as any));
        join(f.test, sub, lobbyId);
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        tx(f.test, f.org, moveOther(f.test, lobbyId, sub, 'BluePlayer'));
        for (const p of [f.blue.captain, f.red.captain, f.red.mate]) join(f.test, p, lobbyId);
        const seq = seatOf(f.test, lobbyId, sub.userId);
        tx(f.test, f.org, (ctx) => M.set_captain(ctx, { lobbyId, targetJoinSeq: seq }));
        for (const p of [sub, f.blue.captain, f.red.captain, f.red.mate]) tx(f.test, p, confirm(lobbyId));
        tx(f.test, f.org, start(lobbyId));
        expect(member(f.test, lobbyId, sub.userId).isCaptain).toBe(true);
        expect(lmaOfUser(f.test, lobbyId, sub.userId)).toEqual([acct]);
        const sess = session(f.test, lobbyId);
        expect(sess.draftSequence[sess.turnIndex].teamTurn.tag).toBe('Blue');
        tx(f.test, sub, (ctx) => M.pick_character(ctx, { lobbyId, characterName: 'sx', eidolon: 0 }));
    });

    it('G1 (b): ranked, approve / join / revoke / approve again / host seats: the old selection is gone with the lock; locked again at confirm', () => {
        const f = duel2v2(2, { countTowardsMmr: true });
        const sub = verified(f.test, 'sub');
        const acct = insertHsrAccount(f.test, sub.userId, 'sub-acct');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, sub, lobbyId);
        expect(locks(f.test, f.id, sub.userId)).toEqual([acct]);
        expect(lmaOfUser(f.test, lobbyId, sub.userId)).toEqual([acct]);
        tx(f.test, f.org, revoke(f.m1.id, sub.userId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        expect(lmaOfUser(f.test, lobbyId, sub.userId)).toEqual([]);      // the selection went with the lock
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        tx(f.test, f.org, moveOther(f.test, lobbyId, sub, 'BluePlayer'));
        for (const p of [f.blue.captain, f.red.captain, f.red.mate]) {
            join(f.test, p, lobbyId);
            f.test.db.LobbyMemberAccount.insert({ lobbyId, userId: p.userId, hsrAccountId: insertHsrAccount(f.test, p.userId, 'x' + p.userId) });
        }
        for (const p of [f.blue.captain, f.red.captain, f.red.mate]) tx(f.test, p, confirm(lobbyId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        expectReject(f.test, f.org, start(lobbyId), 'All Blue and Red players must be confirmed before starting.');
        tx(f.test, sub, confirm(lobbyId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([acct]);
        expect(lmaOfUser(f.test, lobbyId, sub.userId)).toEqual([acct]);
        tx(f.test, f.org, start(lobbyId));
    });

    it('G1 (c) / A104: a stand-in who played game 1 without any account does not get a later account locked by game 2', () => {
        const f = duel2v2(2, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const sub = verified(f.test, 'sub'); // no account: game 1 is played unlocked (unrated, no ownership)
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const players = [f.blue.captain, sub, f.red.captain, f.red.mate];
        const l1 = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of players) { join(f.test, p, l1); tx(f.test, p, confirm(l1)); }
        tx(f.test, f.org, start(l1));
        playLobbyGame({ test: f.test, lobbyId: l1, host: f.org, a: { host: f.org, b1: f.blue.captain, b2: sub, r1: f.red.captain, r2: f.red.mate } }, 'Blue');
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        const a2 = insertHsrAccount(f.test, sub.userId, 'a2');
        expectReject(f.test, sub, lockAccounts(f.id, [a2]), 'Your first game of this tournament has started; accounts can no longer be locked.');
        expect([...f.test.db.MatchResultRecord.lobby_id.filter(l1)][0].status.tag).toBe('Validated');
        const l2 = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, sub, l2);
        expect(locks(f.test, f.id, sub.userId)).toEqual([]); // before the fix: [a2]
        tx(f.test, sub, confirm(l2));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
    });

    // T-S10v (A140): a plain stand-in cannot create; the creator path is kept with a Moderator stand-in (role creator).
    it('G8 (A140 re-aligned): a Moderator stand-in creating through the role, whose active account is not locked, gets the first locked account selected', () => {
        const f = duel2v2();
        const mod = moderator(f.test, 'mod');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, mod.userId));
        const locked = insertHsrAccount(f.test, mod.userId, 'm-locked');
        tx(f.test, mod, lockAccounts(f.id, [locked])); // SI3: an approved stand-in locks before the first game
        const active = insertHsrAccount(f.test, mod.userId, 'm-active');
        f.test.db.HsrAccount.id.update({ ...f.test.db.HsrAccount.id.find(locked)!, isActive: false });
        expect(f.test.db.HsrAccount.id.find(active)!.isActive).toBe(true);
        const lobbyId = createTournamentLobby(f.test, mod, f.m1.id);
        expect(lmaOfUser(f.test, lobbyId, mod.userId)).toEqual([locked]);
    });
});

describe('S10v review N1: a tournament that requires ownership starts only with a selected account for every seated player', () => {
    const OWN = (seat: number) => `The player at seat ${seat} has no account selected for this match. All players must select an account before starting a match that requires ownership.`;
    /** An ownership tournament whose two members of each side have a locked, owned account (auto-selected at join). */
    function ownershipDuel() {
        const f = duel2v2();
        setTournament(f.test, f.id, { requireOwnership: true });
        for (const p of [f.blue.captain, f.blue.mate, f.red.captain, f.red.mate]) {
            lockAccount(f.test, f.id, p.userId, ownedAccount(f.test, p.userId, 'acc' + p.userId, ['c' + p.userId]));
        }
        return f;
    }

    it('N1 (a): a stand-in who deleted their only account after approval cannot start the game; locking and selecting a new one lets it start', () => {
        const f = ownershipDuel();
        const sub = verified(f.test, 'sub');
        const old = insertHsrAccount(f.test, sub.userId, 'old');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        tx(f.test, sub, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: old })); // nothing locked at approval (F7)
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, sub, f.red.captain, f.red.mate]) { join(f.test, p, lobbyId); tx(f.test, p, confirm(lobbyId)); }
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        expectReject(f.test, f.org, start(lobbyId), OWN(seatOf(f.test, lobbyId, sub.userId)));
        const fresh = insertHsrAccount(f.test, sub.userId, 'fresh');
        tx(f.test, sub, lockAccounts(f.id, [fresh]));
        tx(f.test, sub, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: fresh }));
        tx(f.test, f.org, start(lobbyId));
        expect(lobbyRow(f.test, lobbyId).stage.tag).toBe('Drafting');
    });

    it('N1 (b): a member who deselects after confirming blocks the start (entrants alike); selecting again lets it start', () => {
        const f = ownershipDuel();
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, f.blue.mate, f.red.captain, f.red.mate]) { join(f.test, p, lobbyId); tx(f.test, p, confirm(lobbyId)); }
        const acct = [...f.test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, f.blue.mate.userId])][0].hsrAccountId;
        tx(f.test, f.blue.mate, (ctx) => M.deselect_match_account(ctx, { lobbyId, hsrAccountId: acct }));
        expect(member(f.test, lobbyId, f.blue.mate.userId).isConfirmed).toBe(true);
        expectReject(f.test, f.org, start(lobbyId), OWN(seatOf(f.test, lobbyId, f.blue.mate.userId)));
        tx(f.test, f.blue.mate, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: acct }));
        tx(f.test, f.org, start(lobbyId));
    });

    it('N1 (neighbours): the gate is not applied to a tournament without requireOwnership (unrated) nor to a casual lobby', () => {
        const f = duel2v2();
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        for (const p of [f.blue.captain, f.blue.mate, f.red.captain, f.red.mate]) { join(f.test, p, lobbyId); tx(f.test, p, confirm(lobbyId)); }
        expect([...f.test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, f.blue.mate.userId])]).toEqual([]);
        tx(f.test, f.org, start(lobbyId));

        const c = setupLobby(newHarness(), { lobby: { requireOwnership: true }, noStart: true });
        for (const who of ['b1', 'b2', 'r1', 'r2']) {
            for (const lma of [...c.test.db.LobbyMemberAccount.by_lobby_and_user.filter([c.lobbyId, c.a[who].userId])]) c.test.db.LobbyMemberAccount.delete(lma);
        }
        tx(c.test, refereeActor(c), start(c.lobbyId));
        expect(lobbyRow(c.test, c.lobbyId).stage.tag).toBe('Drafting');
    });
});

describe('A140: a stand-in cannot create the match lobby', () => {
    it('A140: a plain stand-in is refused; a member of the match creates it', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        expectReject(f.test, sub, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: f.m1.id }), 'A stand-in cannot create the match lobby: a team member or tournament staff creates it.');
        expect([...f.test.db.Lobby.bracket_match_id.filter(f.m1.id)]).toEqual([]);
        const outsider = verified(f.test, 'out');
        expectReject(f.test, outsider, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: f.m1.id }), 'You are not authorized to create a lobby for this bracket match.');
        const lobbyId = createTournamentLobby(f.test, f.red.mate, f.m1.id);
        expect(slotOf(f.test, lobbyId, f.red.mate)).toBe('RedPlayer');
    });

    it('A140: a member creates and the stand-in joins, auto-seated into the free seat of its side', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.blue.captain, f.m1.id);
        expect(slotOf(f.test, lobbyId, f.blue.captain)).toBe('BluePlayer');
        expect(member(f.test, lobbyId, f.blue.captain.userId).isReferee).toBe(true);
        join(f.test, sub, lobbyId);
        expect(slotOf(f.test, lobbyId, sub)).toBe('BluePlayer');
    });

    it('A140: a Moderator (and an Admin) approved as stand-in creates through the role: Spectator referee, locked at creation, takes the seat by hand', () => {
        const f = duel2v2();
        const mod = moderator(f.test, 'mod');
        const acct = insertHsrAccount(f.test, mod.userId, 'm-acct');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, mod.userId));
        const lobbyId = createTournamentLobby(f.test, mod, f.m1.id);
        expect(slotOf(f.test, lobbyId, mod)).toBe('Spectator');
        expect(member(f.test, lobbyId, mod.userId).isReferee).toBe(true);
        expect(locks(f.test, f.id, mod.userId)).toEqual([acct]);
        tx(f.test, mod, setSelf(lobbyId, 'BluePlayer'));
        expect(slotOf(f.test, lobbyId, mod)).toBe('BluePlayer');

        const g = duel2v2();
        const admin = verified(g.test, 'adm');
        setUserRole(g.test, admin.userId, 'Admin');
        tx(g.test, g.org, approve(g.m1.id, g.m1.team2Id!, admin.userId));
        const l2 = createTournamentLobby(g.test, admin, g.m1.id);
        expect(slotOf(g.test, l2, admin)).toBe('Spectator');
    });

    it('A140: staff creation is unchanged (organizer and a bracket assistant: Spectator referee)', () => {
        const f = duel2v2(4);
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        expect(slotOf(f.test, lobbyId, f.org)).toBe('Spectator');
        expect(member(f.test, lobbyId, f.org.userId).isReferee).toBe(true);
        const ba = verified(f.test, 'ba');
        assignAssistant(f.test, f.org, f.id, ba, { bracket: true });
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const l2 = createTournamentLobby(f.test, ba, m2.id);
        expect(slotOf(f.test, l2, ba)).toBe('Spectator');
    });
});
