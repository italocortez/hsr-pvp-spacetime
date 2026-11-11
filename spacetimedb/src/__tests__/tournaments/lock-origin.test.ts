// Tournaments: the origin of an account lock and the release of stand-in locks by origin.
// Decisions: A143 (A104, A112, A135, A136 for the paths)
// Contracts: docs/tournament/contract.md
//
// T-S11a (A143): TournamentPlayerAccount records where a lock came from (Entry: the player's own entry; StandIn: taking
// part as a stand-in) and has an index by tournament. The release of stand-in locks reads the origin instead of
// comparing lock time with approval time; the end-of-tournament sweep reads only that tournament's rows. In-memory
// only; nothing reaches maincloud.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { M, guest, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import { existingUser, host, signIn, verified } from '../fixtures/identity';
import { insertHsrAccount } from '../fixtures/roster';
import { join } from '../fixtures/lobby';
import {
    advanceStage,
    enrollMany,
    liveField,
    lockAccount,
    locks,
    openTournament,
    register,
    resolveMatch,
} from '../fixtures/tournaments';
import { byKey, createTournamentLobby, drain, sidesOf } from '../fixtures/tournament-matches';
import type { TournamentPlayerAccount } from '@bindings/types';

const approve = (m: number, teamId: number, userId: number) => (ctx: any) => M.approve_stand_in(ctx, { bracketMatchId: m, teamId, userId });
const revoke = (m: number, userId: number) => (ctx: any) => M.revoke_stand_in(ctx, { bracketMatchId: m, userId });
const lockAccounts = (tournamentId: number, hsrAccountIds: number[]) => (ctx: any) => M.lock_tournament_accounts(ctx, { tournamentId, hsrAccountIds });

/** The user's locks in the tournament as `accountId:origin`, ascending by account id. */
const origins = (test: Harness, tournamentId: number, userId: number) =>
    [...test.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, userId])]
        .sort((a, b) => a.hsrAccountId - b.hsrAccountId)
        .map((r) => `${r.hsrAccountId}:${r.origin.tag}`);

const selections = (test: Harness, lobbyId: number, who: Actor) =>
    [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, who.userId])].map((r) => r.hsrAccountId).sort((a, b) => a - b);

/** A 2v2 single-elimination tournament in progress with `n` teams; `m1` = W-R1-M1 and its sides. */
function duel2v2(n = 2) {
    const f = liveField(n);
    const m1 = byKey(f.test, f.id, 'W-R1-M1');
    return { ...f, m1, ...sidesOf(f, m1.id) };
}

// ════════════════════════════════════════════════════════════════════════════
// The origin written by each path
// ════════════════════════════════════════════════════════════════════════════

describe('A143: every writer records the origin of the lock', () => {
    it('registration (named accounts, and every account when none are named) writes Entry', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const named = verified(test, 'named');
        const n1 = insertHsrAccount(test, named.userId, 'n1');
        insertHsrAccount(test, named.userId, 'n2'); // owned, not named
        register(test, named, id, { hsrAccountIds: [n1] });
        expect(origins(test, id, named.userId)).toEqual([`${n1}:Entry`]);
        const all = verified(test, 'all');
        const a1 = insertHsrAccount(test, all.userId, 'a1');
        const a2 = insertHsrAccount(test, all.userId, 'a2');
        register(test, all, id);
        expect(origins(test, id, all.userId)).toEqual([`${a1}:Entry`, `${a2}:Entry`]);
    });

    it('add_participant (staff add) writes Entry', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const p = verified(test, 'added');
        const acct = insertHsrAccount(test, p.userId, 'added-acct');
        tx(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: p.userId }));
        expect(origins(test, id, p.userId)).toEqual([`${acct}:Entry`]);
    });

    it('waitlist promotion writes Entry (remembered accounts)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 2, waitlistEnabled: true });
        const [first] = enrollMany(test, id, 2);
        const w = verified(test, 'w');
        const acct = insertHsrAccount(test, w.userId, 'w1');
        register(test, w, id, { hsrAccountIds: [acct] });
        expect(origins(test, id, w.userId)).toEqual([]);
        tx(test, first, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }));
        expect(origins(test, id, w.userId)).toEqual([`${acct}:Entry`]);
    });

    it('lock_tournament_accounts writes Entry for an enrolled player and StandIn for an approved stand-in without an enrolment', () => {
        const f = duel2v2();
        const p = f.blue.captain;
        const own = insertHsrAccount(f.test, p.userId, 'cap-own');
        tx(f.test, p, lockAccounts(f.id, [own]));
        expect(origins(f.test, f.id, p.userId)).toContain(`${own}:Entry`);
        const sub = verified(f.test, 'sub');
        const subAcct = insertHsrAccount(f.test, sub.userId, 'sub-own');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        tx(f.test, sub, lockAccounts(f.id, [subAcct]));
        expect(origins(f.test, f.id, sub.userId)).toEqual([`${subAcct}:StandIn`]);
    });

    it('the stand-in snapshot at the first participation (lobby join) writes StandIn', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        const a = insertHsrAccount(f.test, sub.userId, 'a');
        const b = insertHsrAccount(f.test, sub.userId, 'b');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        join(f.test, sub, createTournamentLobby(f.test, f.org, f.m1.id));
        expect(origins(f.test, f.id, sub.userId)).toEqual([`${a}:StandIn`, `${b}:StandIn`]);
    });

    it('an A112 entry transfer (a guest\'s entry moved to the existing user at sign-in) writes Entry for the user\'s accounts', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const g = guest(test, 'g-origin');
        register(test, g, id);
        const e = existingUser(test, 'e-origin', { name: 'Origin', accounts: 2 });
        signIn(test, g, e.providerId);
        expect(origins(test, id, e.a.userId)).toEqual(e.accountIds.map((a) => `${a}:Entry`));
    });

    it('an account held by a StandIn lock that the enrolled player then locks through the entry path becomes an Entry lock; an Entry lock is never turned into a StandIn lock', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!); // team1 of M2 out: its members are enrolled and may stand in
        const mate = f.ts.find((t) => t.teamId === m2.team1Id)!.mate;
        expect(locks(f.test, f.id, mate.userId)).toEqual([]);
        const acct = insertHsrAccount(f.test, mate.userId, 'm-acct');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, mate.userId));
        join(f.test, mate, createTournamentLobby(f.test, f.org, f.m1.id));
        expect(origins(f.test, f.id, mate.userId)).toEqual([`${acct}:StandIn`]);
        tx(f.test, mate, lockAccounts(f.id, [acct]));
        expect(origins(f.test, f.id, mate.userId)).toEqual([`${acct}:Entry`]);
        // the stand-in path never downgrades it
        tx(f.test, f.org, revoke(f.m1.id, mate.userId));
        expect(origins(f.test, f.id, mate.userId)).toEqual([`${acct}:Entry`]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// The release reads the origin (replaces the lock-time vs approval-time rule of S10v)
// ════════════════════════════════════════════════════════════════════════════

describe('A143: the release of stand-in locks reads the origin', () => {
    it('a stand-in without an enrolment: every lock is StandIn and is released at the revoke (unchanged)', () => {
        const f = duel2v2();
        const sub = verified(f.test, 'sub');
        const acct = insertHsrAccount(f.test, sub.userId, 'a');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        join(f.test, sub, createTournamentLobby(f.test, f.org, f.m1.id));
        expect(locks(f.test, f.id, sub.userId)).toEqual([acct]);
        tx(f.test, f.org, revoke(f.m1.id, sub.userId));
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
    });

    it('S10v review G2: an entrant who locks an own account AFTER their approval keeps it at the revoke (the time rule released it)', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!);
        const mate = f.ts.find((t) => t.teamId === m2.team1Id)!.mate;
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, mate.userId));
        const own = insertHsrAccount(f.test, mate.userId, 'own-late');
        tx(f.test, mate, lockAccounts(f.id, [own])); // enrolled: an Entry lock, created after the approval
        expect(origins(f.test, f.id, mate.userId)).toEqual([`${own}:Entry`]);
        tx(f.test, f.org, revoke(f.m1.id, mate.userId));
        expect(origins(f.test, f.id, mate.userId)).toEqual([`${own}:Entry`]);
    });

    it('an entrant holding both kinds loses only the StandIn locks, and only the selections of the released accounts in Waiting lobbies', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!);
        const mate = f.ts.find((t) => t.teamId === m2.team1Id)!.mate;
        const viaStandIn = insertHsrAccount(f.test, mate.userId, 'via-standin');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, mate.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, mate, lobbyId); // snapshot: StandIn lock on viaStandIn, selected
        expect(selections(f.test, lobbyId, mate)).toEqual([viaStandIn]);
        const viaEntry = insertHsrAccount(f.test, mate.userId, 'via-entry');
        tx(f.test, mate, lockAccounts(f.id, [viaEntry])); // Entry
        expect(origins(f.test, f.id, mate.userId)).toEqual([`${viaStandIn}:StandIn`, `${viaEntry}:Entry`]);
        tx(f.test, f.org, revoke(f.m1.id, mate.userId));
        expect(origins(f.test, f.id, mate.userId)).toEqual([`${viaEntry}:Entry`]);
        expect(selections(f.test, lobbyId, mate)).toEqual([]); // the selection of the released account went
    });

    it('S10v review G2: after a revoke and a re-approval, the locks of the new participation are released at the next revoke', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!);
        const mate = f.ts.find((t) => t.teamId === m2.team1Id)!.mate;
        const acct = insertHsrAccount(f.test, mate.userId, 'again');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, mate.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, f.m1.id);
        join(f.test, mate, lobbyId);
        tx(f.test, f.org, revoke(f.m1.id, mate.userId));
        expect(locks(f.test, f.id, mate.userId)).toEqual([]);
        tx(f.test, mate, (ctx) => M.leave_lobby(ctx, { lobbyId }));
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, mate.userId));
        join(f.test, mate, lobbyId);
        expect(origins(f.test, f.id, mate.userId)).toEqual([`${acct}:StandIn`]);
        tx(f.test, f.org, revoke(f.m1.id, mate.userId));
        expect(locks(f.test, f.id, mate.userId)).toEqual([]);
    });

    it('a decided match releases its unused stand-ins\' StandIn locks; an Entry lock of an entrant stand-in stays', () => {
        const f = duel2v2(4);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!);
        const mate = f.ts.find((t) => t.teamId === m2.team1Id)!.mate;
        const own = insertHsrAccount(f.test, mate.userId, 'own');
        tx(f.test, mate, lockAccounts(f.id, [own])); // Entry, before the approval
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, mate.userId));
        const sub = verified(f.test, 'sub');
        const subAcct = insertHsrAccount(f.test, sub.userId, 'sub');
        tx(f.test, f.org, approve(f.m1.id, f.m1.team1Id!, sub.userId));
        tx(f.test, sub, lockAccounts(f.id, [subAcct])); // StandIn
        resolveMatch(f.test, f.org, f.m1.id, f.m1.team1Id!);
        expect(origins(f.test, f.id, sub.userId)).toEqual([]);
        expect(origins(f.test, f.id, mate.userId)).toEqual([`${own}:Entry`]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// The end-of-tournament sweep reads the tournament index
// ════════════════════════════════════════════════════════════════════════════

describe('A143: the end-of-tournament sweep reads only that tournament\'s rows (index by tournament)', () => {
    it('the table has the tournament_id index; it returns exactly the rows of one tournament', () => {
        expectTypeOf<TournamentPlayerAccount['origin']['tag']>().toEqualTypeOf<'Entry' | 'StandIn'>();
        const test = newHarness();
        lockAccount(test, 101, 1, 11);
        lockAccount(test, 101, 2, 12, 'StandIn');
        lockAccount(test, 202, 1, 13);
        expect([...test.db.TournamentPlayerAccount.tournament_id.filter(101)].map((r) => r.hsrAccountId).sort()).toEqual([11, 12]);
        expect([...test.db.TournamentPlayerAccount.tournament_id.filter(202)].map((r) => r.hsrAccountId)).toEqual([13]);
    });

    it('Completed: every StandIn lock of the tournament goes (a stand-in\'s, and an enrolled player\'s stand-in lock); Entry locks of enrolled players stay; another tournament\'s locks are untouched', () => {
        const f = duel2v2();
        const p = f.blue.mate; // enrolled
        const own = insertHsrAccount(f.test, p.userId, 'own');
        tx(f.test, p, lockAccounts(f.id, [own])); // Entry
        // rows a played stand-in keeps until the end (a revoke after playing keeps them, SI12), written directly
        const extra = insertHsrAccount(f.test, p.userId, 'extra');
        lockAccount(f.test, f.id, p.userId, extra, 'StandIn');
        const sub = verified(f.test, 'sub');
        const subAcct = insertHsrAccount(f.test, sub.userId, 'sub');
        lockAccount(f.test, f.id, sub.userId, subAcct, 'StandIn');
        // another tournament's locks of the same users
        const other = 9_999;
        lockAccount(f.test, other, sub.userId, subAcct, 'StandIn');
        lockAccount(f.test, other, p.userId, extra, 'StandIn');
        resolveMatch(f.test, f.org, f.m1.id, f.m1.team1Id!);
        advanceStage(f.test, f.org, f.id, 'Completed');
        drain(f.test, f.id);
        expect(origins(f.test, f.id, sub.userId)).toEqual([]);
        expect(origins(f.test, f.id, p.userId)).toEqual([`${own}:Entry`]);
        expect(origins(f.test, other, sub.userId)).toEqual([`${subAcct}:StandIn`]);
        expect(origins(f.test, other, p.userId)).toEqual([`${extra}:StandIn`]);
    });
});
