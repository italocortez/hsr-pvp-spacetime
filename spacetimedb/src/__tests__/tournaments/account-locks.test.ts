// Tournaments: lock_tournament_accounts (stages, first game, waitlisted players) and the entry-write throttle.
// Decisions: A104
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10g (s10g-tournament.test.ts).
import { describe, expect, it } from 'vitest';
import { M, advance, lobbyRow, newHarness, tx, rejection } from '../fixtures/harness';
import { host, verified } from '../fixtures/identity';
import { insertHsrAccount } from '../fixtures/roster';
import { join } from '../fixtures/lobby';
import {
    advanceStage,
    createTournament,
    enrollMany,
    enrolled,
    locks,
    openTournament,
    register,
    resolveMatch,
    seedAndGenerate,
    stageOf,
    tRow,
    teamRow,
    teams,
    dq,
    lockBody,
    waitlistRows,
} from '../fixtures/tournaments';
import {
    byKey,
    createTournamentLobby,
    duel,
    openMatchLobby,
    recordsOfLobby,
    seedElo,
    sidesOf,
} from '../fixtures/tournament-matches';

const LOCK_STAGE = 'Accounts can be locked from Registration until the tournament ends.';
const LOCK_EMPTY = 'Name at least one account to lock.';
const LOCK_NOT_REGISTERED = 'You are not registered for this tournament.';
const LOCK_DQ = 'You were disqualified from this tournament.';
const LOCK_STARTED = 'Your first game of this tournament has started; accounts can no longer be locked.';
const notYours = (id: number) => `HSR account #${id} is not one of your accounts.`;
const NOT_LOCKED = 'This account is not locked for this tournament. Use a registered tournament account.';
const THROTTLE = 'You are changing your tournament entries too quickly. Please wait a minute.';
const LOCK_WAITLIST_CLOSED = 'The bracket has been generated; waitlisted players can no longer be promoted, so accounts cannot be locked.';

// ════════════════════════════════════════════════════════════════════════════
// A104: lock_tournament_accounts
// ════════════════════════════════════════════════════════════════════════════

describe('A104: lock_tournament_accounts', () => {
    it('A104 (audit #7): an approved player locks an account added after registration, selects it in the match lobby and the draft starts; afterwards the call is rejected', () => {
        const f = duel({ countTowardsMmr: true });
        const { test, org } = f;
        seedElo(test);
        const m = byKey(test, f.id, 'W-R1-M1');
        const players = [f.ts[0].captain, f.ts[0].mate, f.ts[1].captain, f.ts[1].mate];
        for (const p of players) expect(locks(test, f.id, p.userId)).toEqual([]); // registered before owning an account
        const accts = new Map(players.map((p) => [p.userId, insertHsrAccount(test, p.userId, `late-${p.userId}`)]));

        const lobbyId = createTournamentLobby(test, org, m.id);
        expect(lobbyRow(test, lobbyId).matchType.tag).toBe('Ranked');
        for (const p of players) {
            join(test, p, lobbyId);
            tx(test, p, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        }
        const b1 = players[0];
        const b1Acct = accts.get(b1.userId)!;
        expect(rejection(test, b1, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: b1Acct }))).toBe(NOT_LOCKED);

        for (const p of players) {
            const acct = accts.get(p.userId)!;
            tx(test, p, lockBody(f.id, [acct]));
            expect(locks(test, f.id, p.userId)).toEqual([acct]);
            tx(test, p, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: acct }));
        }
        tx(test, org, (ctx) => M.start_draft(ctx, { lobbyId }));
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Drafting');

        // b1 and the teammate both sit in the started game: no more locks for either (review F3: the player's own game)
        const extra = insertHsrAccount(test, b1.userId, 'too-late');
        expect(rejection(test, b1, lockBody(f.id, [extra]))).toBe(LOCK_STARTED);
        expect(rejection(test, players[1], lockBody(f.id, [accts.get(players[1].userId)!]))).toBe(LOCK_STARTED);
        expect(locks(test, f.id, b1.userId)).toEqual([b1Acct]);
    });

    it('A104: locks are only added: naming fewer accounts keeps the old ones', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const p = verified(test, 'p');
        const a1 = insertHsrAccount(test, p.userId, 'a1');
        register(test, p, id, { hsrAccountIds: [a1] });
        const a2 = insertHsrAccount(test, p.userId, 'a2');
        const a3 = insertHsrAccount(test, p.userId, 'a3');
        tx(test, p, lockBody(id, [a2, a3]));
        expect(locks(test, id, p.userId)).toEqual([a1, a2, a3].sort((x, y) => x - y));
        tx(test, p, lockBody(id, [a1]));
        expect(locks(test, id, p.userId)).toEqual([a1, a2, a3].sort((x, y) => x - y));
    });

    it('A104: someone else\'s account, an empty list, a non-registrant and a disqualified player are rejected with their texts; nothing is locked', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const p = verified(test, 'p');
        const other = verified(test, 'other');
        register(test, p, id);
        const foreign = insertHsrAccount(test, other.userId, 'foreign');
        const own = insertHsrAccount(test, p.userId, 'own');

        expect(rejection(test, p, lockBody(id, [own, foreign]))).toBe(notYours(foreign));
        expect(rejection(test, p, lockBody(id, []))).toBe(LOCK_EMPTY);
        expect(rejection(test, other, lockBody(id, [foreign]))).toBe(LOCK_NOT_REGISTERED);
        expect(locks(test, id, p.userId)).toEqual([]);

        const d = verified(test, 'd');
        register(test, d, id);
        const dAcct = insertHsrAccount(test, d.userId, 'd-acct');
        tx(test, org, dq(id, d.userId));
        expect(rejection(test, d, lockBody(id, [dAcct]))).toBe(LOCK_DQ);
        expect(locks(test, id, d.userId)).toEqual([]);
    });

    it('A104: a waitlisted player\'s call is remembered and every remembered account is locked at promotion', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 2, waitlistEnabled: true }); // S10s re-alignment (A122(17), F7): the floor is 2
        const [first] = enrollMany(test, id, 2); // S10s re-alignment (F7): two fill the 2 spots
        const w = verified(test, 'w');
        const a1 = insertHsrAccount(test, w.userId, 'w1');
        register(test, w, id, { hsrAccountIds: [a1] });
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        const a2 = insertHsrAccount(test, w.userId, 'w2');
        insertHsrAccount(test, w.userId, 'w3'); // owned, never named
        tx(test, w, lockBody(id, [a2]));
        expect(locks(test, id, w.userId)).toEqual([]); // nothing locked while waitlisted
        expect(waitlistRows(test, id, w.userId)).toEqual([a1, a2].sort((x, y) => x - y));

        tx(test, first, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }));
        expect(locks(test, id, w.userId)).toEqual([a1, a2].sort((x, y) => x - y));
        expect(waitlistRows(test, id, w.userId)).toEqual([]);
    });

    it('A104: stage bounds: rejected in Draft and in Completed with the text', () => {
        const test = newHarness();
        const org = host(test);
        const draft = createTournament(test, org);
        const p = verified(test, 'p');
        const acct = insertHsrAccount(test, p.userId, 'p-acct');
        expect(rejection(test, p, lockBody(draft, [acct]))).toBe(LOCK_STAGE);

        const f = duel();
        const cap = f.ts[0].captain;
        const capAcct = insertHsrAccount(f.test, cap.userId, 'cap-acct');
        resolveMatch(f.test, f.org, byKey(f.test, f.id, 'W-R1-M1').id, f.ts[0].teamId);
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(rejection(f.test, cap, lockBody(f.id, [capAcct]))).toBe(LOCK_STAGE);
        expect(locks(f.test, f.id, cap.userId)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Audit #13: the tournament entry throttle
// ════════════════════════════════════════════════════════════════════════════

describe('tournament audit #13: at most 10 tournament entry writes per 60 s window', () => {
    it('audit #13: register, alias, rename and lock share one window; the 11th is rejected; withdraw and an unchanged rename are never counted; a new window passes', () => {
        const test = newHarness();
        const org = host(test);
        const anon = openTournament(test, org, { name: 'Anon', isAnonymousDefault: true });
        const plain = openTournament(test, org, { name: 'Plain' });
        const u = verified(test, 'u');
        const count = () => test.db.UserRateState.userId.find(u.userId)?.tournamentCount;
        const alias = (a: string) => (ctx: any) => M.set_anonymous_alias(ctx, { tournamentId: anon, alias: a });
        const withdraw = (ctx: any) => M.withdraw_from_tournament(ctx, { tournamentId: plain });
        const registerPlain = (ctx: any) => M.register_for_tournament(ctx, { tournamentId: plain });

        register(test, u, anon, { anonymousAlias: 'Ghost' });       // 1
        expect(count()).toBe(1);
        tx(test, u, alias('Ghost two'));                            // 2
        tx(test, u, (ctx) => M.create_tournament_team(ctx, { tournamentId: anon, teamName: 'Alpha' }));
        expect(count()).toBe(2); // creating a team is not an entry write
        const teamId = teams(test, anon).find((t) => t.name === 'Alpha')!.id;
        const rename = (name: string) => (ctx: any) => M.rename_tournament_team(ctx, { teamId, name });
        tx(test, u, rename('Beta'));                                // 3
        tx(test, u, rename('Beta'));                                // unchanged: not counted
        expect(count()).toBe(3);
        const acct = insertHsrAccount(test, u.userId, 'u-acct');
        tx(test, u, lockBody(anon, [acct]));                        // 4
        for (let i = 0; i < 3; i++) {
            tx(test, u, registerPlain);                             // 5, 6, 7
            tx(test, u, withdraw);                                  // never counted
        }
        expect(count()).toBe(7);
        tx(test, u, alias('Ghost three'));                          // 8
        tx(test, u, alias('Ghost four'));                           // 9
        tx(test, u, registerPlain);                                 // 10
        expect(count()).toBe(10);

        expect(rejection(test, u, alias('Ghost five'))).toBe(THROTTLE);
        expect(rejection(test, u, rename('Gamma'))).toBe(THROTTLE);
        expect(rejection(test, u, lockBody(anon, [acct]))).toBe(THROTTLE);
        expect(enrolled(test, anon, u.userId).anonymousAlias).toBe('Ghost four');
        expect(teamRow(test, teamId)!.name).toBe('Beta');
        tx(test, u, rename('Beta'));                                // unchanged: passes at the cap
        tx(test, u, withdraw);                                      // never rejected
        expect(enrolled(test, plain, u.userId)).toBeUndefined();
        expect(rejection(test, u, registerPlain)).toBe(THROTTLE);
        expect(count()).toBe(10);

        advance(test, 60_000);
        tx(test, u, alias('Ghost five'));
        expect(count()).toBe(1);
        expect(enrolled(test, anon, u.userId).anonymousAlias).toBe('Ghost five');
    });
});

describe('A104 review F3: "their first game" is the player\'s own game', () => {
    it('A104 / F3: a member who sat out the team\'s first game (a stand-in played) can still lock; the teammate who played cannot', () => {
        const f = duel();
        const { test, org } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const sub = verified(test, 'sub');
        tx(test, org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId }));
        const lobbyId = createTournamentLobby(test, org, m.id);
        for (const p of [blue.captain, sub, red.captain, red.mate]) {
            join(test, p, lobbyId);
            tx(test, p, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        }
        tx(test, org, (ctx) => M.start_draft(ctx, { lobbyId }));
        expect(lobbyRow(test, lobbyId).stage.tag).not.toBe('Waiting');
        expect([...test.db.LobbyMember.lobby_id.filter(lobbyId)].some((r) => r.userId === blue.mate.userId)).toBe(false);

        const mateAcct = insertHsrAccount(test, blue.mate.userId, 'mate-late');
        tx(test, blue.mate, lockBody(f.id, [mateAcct]));
        expect(locks(test, f.id, blue.mate.userId)).toEqual([mateAcct]);
        const capAcct = insertHsrAccount(test, blue.captain.userId, 'cap-late');
        expect(rejection(test, blue.captain, lockBody(f.id, [capAcct]))).toBe(LOCK_STARTED);
        expect(locks(test, f.id, blue.captain.userId)).toEqual([]);
    });

    it('A104 / F3: a voided game the player took part in still counts (resolve_bracket_match voids the live lobby; record Voided, lobby gone)', () => {
        const f = duel();
        const { test, org } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        const [rec] = recordsOfLobby(test, s.lobbyId);
        resolveMatch(test, org, m.id, m.team1Id!);
        expect(test.db.MatchResultRecord.id.find(rec.id)!.status.tag).toBe('Voided');
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(stageOf(test, f.id)).toBe('InProgress');

        const b1 = s.a.b1;
        const acct = insertHsrAccount(test, b1.userId, 'b1-late');
        expect(rejection(test, b1, lockBody(f.id, [acct]))).toBe(LOCK_STARTED);
        expect(locks(test, f.id, b1.userId)).toEqual([]);
    });
});

describe('A104 review F5: lock_tournament_accounts by a waitlisted player', () => {
    it('A104 / F5: the first waitlisted call (no accounts named at registration) is stored and applied at promotion: only the chosen account is locked', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 2, waitlistEnabled: true }); // S10s re-alignment (A122(17), F7): the floor is 2
        const [first] = enrollMany(test, id, 2); // S10s re-alignment (F7): two fill the 2 spots
        const w = verified(test, 'w');
        insertHsrAccount(test, w.userId, 'w1');
        const a2 = insertHsrAccount(test, w.userId, 'w2');
        register(test, w, id);
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        expect(waitlistRows(test, id, w.userId)).toEqual([]);

        tx(test, w, lockBody(id, [a2]));
        expect(waitlistRows(test, id, w.userId)).toEqual([a2]);
        expect(locks(test, id, w.userId)).toEqual([]);

        tx(test, first, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }));
        expect(locks(test, id, w.userId)).toEqual([a2]);
        expect(waitlistRows(test, id, w.userId)).toEqual([]);
    });

    it('A104 / F5: once the bracket is generated (Seeding, then InProgress) a waitlisted call is refused with the text; nothing is stored', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 2, waitlistEnabled: true });
        enrollMany(test, id, 2, 'in');
        const w = verified(test, 'w');
        const acct = insertHsrAccount(test, w.userId, 'w-acct');
        register(test, w, id);
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        expect(tRow(test, id).bracketGeneratedAt).toBeDefined();
        expect(rejection(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }))).toBe('Bracket generated; use stand-ins.');

        expect(rejection(test, w, lockBody(id, [acct]))).toBe(LOCK_WAITLIST_CLOSED);
        expect(waitlistRows(test, id, w.userId)).toEqual([]);
        advanceStage(test, org, id, 'InProgress');
        expect(rejection(test, w, lockBody(id, [acct]))).toBe(LOCK_WAITLIST_CLOSED);
        expect(waitlistRows(test, id, w.userId)).toEqual([]);
        expect(locks(test, id, w.userId)).toEqual([]);
    });
});
