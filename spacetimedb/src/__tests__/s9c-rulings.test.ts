// T-S9c: the three S9 rulings, in memory (SpacetimeDB test-utils; nothing reaches maincloud).
//   A74 — lobby members are targeted by seat number (`targetJoinSeq` / `bannedJoinSeq`); the server resolves the seat.
//   A75 — only the spectator referee sees every roster (view_my_roster_visibility).
//   A73 — team requests identify the requester to the captain (view_my_team_requests).
// One describe per decision clause; each it cites its clause. The code is the truth for row shapes and messages; the
// decision rows (DECISIONS.md A73-A75) say what must hold. Rejection order follows the S9c fix pass: "Lobby not found."
// first, then the caller's membership / permission checks, then the seat ("No member sits at seat N of this lobby.").
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AdminLobbyBanRow, LobbyBanViewRow, LobbyMemberViewRow, RosterVisibilityRow, TeamRequestViewRow } from '@bindings/types';
import {
    M,
    TestAuth,
    captainOf,
    guest,
    lobbyRow,
    member,
    newHarness,
    refereeIds,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type SetupOpts,
} from './s4-fixtures';
import { host as tournamentHost, insertHsrAccount, liveField, moderator, openTournament, register, verified, AUDIT } from './s8-fixtures';
import { byKey, createTournamentLobby, join } from './s8d-fixtures';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Reader = Actor | TestAuth;
const authOf = (r: Reader): TestAuth => ('auth' in r ? r.auth : r);
function view<T = any>(test: Harness, name: string, who: Reader): T[] {
    return (M as any)[name](test.viewContext(authOf(who)), {}) as T[];
}
const keysOf = (row: object) => Object.keys(row).sort();
const displayName = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.displayName;
type Ctx = Parameters<Parameters<Harness['withReducerTx']>[1]>[0];

/** The exact rejection message of a reducer call (fails the test if the call succeeds). */
function errorOf(test: Harness, who: Actor, body: (ctx: Ctx) => unknown): string {
    try {
        tx(test, who, body);
    } catch (e) {
        return (e as Error).message;
    }
    throw new Error('expected the reducer call to be rejected');
}

const SEAT = (n: number) => `No member sits at seat ${n} of this lobby.`;
const NO_BAN = (n: number) => `No ban is recorded for seat ${n} of this lobby.`;
const NOT_FOUND = 'Lobby not found.';
const NOT_MEMBER = 'You are not a member of this lobby.';
const HOST_OR_ABOVE = 'Only the host, moderators, or admins can perform this action.';
const KICK_PERM = 'Only the host, moderators, admins, or an authorized referee can kick members.';
const BAN_PERM = 'Only the host, moderators, admins, or an authorized referee can ban members.';
const CAPTAIN_PERM = 'Only the host, an authorized referee, or an admin can assign captains.';
const UNBAN_PERM = 'Only the host, moderators, admins, or an authorized referee can lift a lobby ban.';
const NOT_REFEREE = 'You are not the referee of this lobby.';
const NO_PLAYER_REMOVAL = 'Players cannot be removed once the draft has started; the match ends by result, concede or forfeit.';
const NO_LOBBY = 999_999;
const NO_SEAT = 99;

const join_ = (test: Harness, who: Actor, lobbyId: number) =>
    tx(test, who, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' }));
const bansOf = (test: Harness, lobbyId: number) => [...test.db.LobbyBan.lobby_id.filter(lobbyId)];
const members = (test: Harness, lobbyId: number) => [...test.db.LobbyMember.lobby_id.filter(lobbyId)];

/** A casual Waiting lobby: host (seat 1, Spectator, referee), b1 (2), b2 (3) Blue, r1 (4), r2 (5) Red. */
function waiting(opts: SetupOpts = {}) {
    const test = newHarness();
    const s = setupLobby(test, { noStart: true, ...opts });
    return { test, s, seat: (who: Actor) => seatOf(test, s.lobbyId, who.userId) };
}

// ════════════════════════════════════════════════════════════════════════════
// A74(1): one argument, one path
// ════════════════════════════════════════════════════════════════════════════

describe('A74(1): the five member-targeting reducers work by seat', () => {
    it('A74(1) kick_member by seat removes the row and transfers the captain flag', () => {
        const { test, s, seat } = waiting();
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) })); // no captain in Waiting until one is set
        const cap = captainOf(test, s.lobbyId, 'BluePlayer')!;
        expect(cap).toBeDefined();
        const capSeat = cap.joinSeq;
        tx(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: capSeat }));
        expect(member(test, s.lobbyId, cap.userId)).toBeUndefined();
        const next = captainOf(test, s.lobbyId, 'BluePlayer')!;
        expect(next).toBeDefined();
        expect(next.userId).not.toBe(cap.userId);
        expect(seat(s.a.r1)).toBe(4); // the other seats are untouched
    });

    it('A74(1) ban_member by seat inserts the ban row and removes the member; the user cannot rejoin', () => {
        const { test, s, seat } = waiting();
        const r2Seat = seat(s.a.r2);
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: r2Seat }));
        expect(member(test, s.lobbyId, s.a.r2.userId)).toBeUndefined();
        expect(bansOf(test, s.lobbyId)).toEqual([expect.objectContaining({ lobbyId: s.lobbyId, bannedUserId: s.a.r2.userId, bannedByUserId: s.host.userId })]);
        expect(() => join_(test, s.a.r2, s.lobbyId)).toThrow();
        expect(member(test, s.lobbyId, s.a.r2.userId)).toBeUndefined();
    });

    it('A74(1) set_captain by seat promotes the target and demotes the previous captain of that team', () => {
        const { test, s, seat } = waiting();
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) })); // no captain in Waiting until one is set
        const before = captainOf(test, s.lobbyId, 'BluePlayer')!;
        const other = before.userId === s.a.b1.userId ? s.a.b2 : s.a.b1;
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, other.userId) }));
        expect(member(test, s.lobbyId, other.userId).isCaptain).toBe(true);
        expect(member(test, s.lobbyId, before.userId).isCaptain).toBe(false);
        expect(members(test, s.lobbyId).filter((m) => m.isCaptain && m.lobbySlot.tag === 'BluePlayer')).toHaveLength(1);
    });

    it('A74(1) transfer_referee by seat moves the flag', () => {
        const { test, s, seat } = waiting();
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.r1.userId]);
    });

    it('A74(1) set_team_slot by seat moves the target (host moves a Red player to Spectator)', () => {
        const { test, s, seat } = waiting();
        tx(test, s.host, (ctx) => M.set_team_slot(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r2.userId), lobbySlot: { tag: 'Spectator' } }));
        expect(member(test, s.lobbyId, s.a.r2.userId).lobbySlot.tag).toBe('Spectator');
        expect(member(test, s.lobbyId, s.host.userId).lobbySlot.tag).toBe('Spectator');
    });

    it('A74(1) an unknown seat is rejected with exactly "No member sits at seat N of this lobby." (each of the five)', () => {
        const { test, s } = waiting();
        const L = s.lobbyId;
        expect(errorOf(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT }))).toBe(SEAT(NO_SEAT));
        expect(errorOf(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT }))).toBe(SEAT(NO_SEAT));
        expect(errorOf(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT }))).toBe(SEAT(NO_SEAT));
        expect(errorOf(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT }))).toBe(SEAT(NO_SEAT));
        expect(errorOf(test, s.host, (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT, lobbySlot: { tag: 'Spectator' } }))).toBe(SEAT(NO_SEAT));
        // seat 0 is never handed out (the host is seat 1)
        expect(errorOf(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: 0 }))).toBe(SEAT(0));
        expect(members(test, L)).toHaveLength(5);
    });

    it('A74(1) "Lobby not found." still comes before the seat', () => {
        const { test, s } = waiting();
        expect(errorOf(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: NO_LOBBY, targetJoinSeq: NO_SEAT }))).toBe(NOT_FOUND);
        expect(errorOf(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: NO_LOBBY, targetJoinSeq: NO_SEAT }))).toBe(NOT_FOUND);
        expect(errorOf(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: NO_LOBBY, targetJoinSeq: NO_SEAT }))).toBe(NOT_FOUND);
        expect(errorOf(test, s.host, (ctx) => M.set_team_slot(ctx, { lobbyId: NO_LOBBY, targetJoinSeq: NO_SEAT, lobbySlot: { tag: 'Spectator' } }))).toBe(NOT_FOUND);
        expect(errorOf(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: NO_LOBBY, bannedJoinSeq: NO_SEAT }))).toBe(NOT_FOUND);
    });

    it('A74(1) the caller checks run before the seat: a stranger cannot probe seat numbers (S9c fix-pass order)', () => {
        const { test, s } = waiting();
        const stranger = guest(test, 'stranger');
        const L = s.lobbyId;
        for (const n of [NO_SEAT, 2]) {
            expect(errorOf(test, stranger, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: n }))).toBe(NOT_MEMBER);
            expect(errorOf(test, stranger, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: n }))).toBe(NOT_MEMBER);
            expect(errorOf(test, stranger, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: n }))).toBe(NOT_MEMBER);
            expect(errorOf(test, stranger, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: n }))).toBe(NOT_MEMBER);
            expect(errorOf(test, stranger, (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: n, lobbySlot: { tag: 'Spectator' } }))).toBe(HOST_OR_ABOVE);
        }
        // a plain member gets the permission rejection, whatever the seat
        expect(errorOf(test, s.a.b1, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT }))).toBe(KICK_PERM);
        expect(errorOf(test, s.a.b1, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT }))).toBe(BAN_PERM);
        expect(errorOf(test, s.a.b1, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT }))).toBe(CAPTAIN_PERM);
        expect(errorOf(test, s.a.b1, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT }))).toBe(NOT_REFEREE);
    });

    it('A74(1) the resolved-id guards fire by seat: own seat, the host\'s seat, already the referee', () => {
        const { test, s, seat } = waiting();
        const L = s.lobbyId;
        expect(seat(s.host)).toBe(1);
        expect(errorOf(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: 1 }))).toBe('Cannot kick yourself.');
        expect(errorOf(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: 1 }))).toBe('Cannot ban yourself.');
        expect(errorOf(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: 1 }))).toBe('You are already the referee.');
        // a referee with refereeCanKick (default on) targeting the host's seat
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        expect(errorOf(test, s.a.r1, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: 1 }))).toBe('Cannot kick the host.');
        expect(errorOf(test, s.a.r1, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: 1 }))).toBe('Cannot ban the host.');
        expect(members(test, L)).toHaveLength(5);
    });

    it('A74(1) set_team_slot: seat omitted moves the caller; the caller\'s own seat moves the caller; another seat needs host-or-above', () => {
        const { test, s, seat } = waiting();
        const L = s.lobbyId;
        tx(test, s.a.b1, (ctx) => M.set_team_slot(ctx, { lobbyId: L, lobbySlot: { tag: 'Spectator' } }));
        expect(member(test, L, s.a.b1.userId).lobbySlot.tag).toBe('Spectator');
        tx(test, s.a.b1, (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId), lobbySlot: { tag: 'BluePlayer' } }));
        expect(member(test, L, s.a.b1.userId).lobbySlot.tag).toBe('BluePlayer');
        expect(errorOf(test, s.a.b1, (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId), lobbySlot: { tag: 'Spectator' } }))).toBe(HOST_OR_ABOVE);
        expect(member(test, L, s.a.r1.userId).lobbySlot.tag).toBe('RedPlayer');
    });

    it('A74(1) / A68(6): after start_draft a seated player cannot be kicked or banned by seat; a spectator still can', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const spec = guest(test, 'spec');
        join_(test, spec, s.lobbyId);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        const b1Seat = seatOf(test, s.lobbyId, s.a.b1.userId);
        expect(errorOf(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: b1Seat }))).toBe(NO_PLAYER_REMOVAL);
        expect(errorOf(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: b1Seat }))).toBe(NO_PLAYER_REMOVAL);
        expect(member(test, s.lobbyId, s.a.b1.userId)).toBeDefined();
        tx(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, spec.userId) }));
        expect(member(test, s.lobbyId, spec.userId)).toBeUndefined();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A74(2): bans record the seat
// ════════════════════════════════════════════════════════════════════════════

describe('A74(2): ban_member records the seat; unban_member takes it', () => {
    it('A74(2) the ban row carries bannedJoinSeq = the seat the member held', () => {
        const { test, s, seat } = waiting();
        const r1Seat = seat(s.a.r1);
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: r1Seat }));
        const [ban] = bansOf(test, s.lobbyId);
        expect(ban.bannedJoinSeq).toBe(r1Seat);
        expect(ban.bannedUserId).toBe(s.a.r1.userId);
    });

    it('A74(2) banning a seat nobody holds is rejected with the A74 text; no preventive ban row is written', () => {
        const { test, s } = waiting();
        const outsider = guest(test, 'outsider');
        expect(errorOf(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: NO_SEAT }))).toBe(SEAT(NO_SEAT));
        expect(bansOf(test, s.lobbyId)).toEqual([]);
        join_(test, outsider, s.lobbyId); // nobody pre-banned them
        expect(member(test, s.lobbyId, outsider.userId)).toBeDefined();
    });

    it('A74(2) unban_member(lobbyId, bannedJoinSeq) deletes the ban; the user rejoins on a fresh seat (A74(3))', () => {
        const { test, s, seat } = waiting();
        const r2Seat = seat(s.a.r2);
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: r2Seat }));
        tx(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: r2Seat }));
        expect(bansOf(test, s.lobbyId)).toEqual([]);
        join_(test, s.a.r2, s.lobbyId);
        expect(seat(s.a.r2)).toBeGreaterThan(r2Seat);
        expect(errorOf(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: r2Seat }))).toBe(NO_BAN(r2Seat));
    });

    it('A74(2) an unknown seat is rejected with exactly "No ban is recorded for seat N of this lobby."', () => {
        const { test, s, seat } = waiting();
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r2.userId) }));
        expect(errorOf(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: 42 }))).toBe(NO_BAN(42));
        // a seat held by a present member is not a ban either
        expect(errorOf(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }))).toBe(NO_BAN(seatOf(test, s.lobbyId, s.a.b1.userId)));
        expect(bansOf(test, s.lobbyId)).toHaveLength(1);
    });

    it('A74(2) / A45(3) permission unchanged: a plain player rejected; host, referee with refereeCanKick, non-member Moderator allowed', () => {
        const { test, s, seat } = waiting();
        const L = s.lobbyId;
        const banSeat = (who: Actor) => {
            const n = seat(who);
            tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: n }));
            return n;
        };
        const b2 = banSeat(s.a.b2);
        const r2 = banSeat(s.a.r2);
        const extra = guest(test, 'extra');
        join_(test, extra, L);
        const ex = banSeat(extra);

        expect(errorOf(test, s.a.b1, (ctx) => M.unban_member(ctx, { lobbyId: L, bannedJoinSeq: b2 }))).toBe(UNBAN_PERM);
        expect(bansOf(test, L)).toHaveLength(3);

        tx(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: L, bannedJoinSeq: b2 }));
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        expect(lobbyRow(test, L).refereeCanKick).toBe(true);
        tx(test, s.a.r1, (ctx) => M.unban_member(ctx, { lobbyId: L, bannedJoinSeq: r2 }));
        const mod = moderator(test, 'mod');
        expect(member(test, L, mod.userId)).toBeUndefined();
        tx(test, mod, (ctx) => M.unban_member(ctx, { lobbyId: L, bannedJoinSeq: ex }));
        expect(bansOf(test, L)).toEqual([]);
    });

    it('A74(2) view_my_lobby_bans and view_admin_lobby_bans carry bannedJoinSeq', () => {
        const { test, s, seat } = waiting();
        const r1Seat = seat(s.a.r1);
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: r1Seat }));
        const [mine] = view<LobbyBanViewRow>(test, 'view_my_lobby_bans', s.host);
        expect(mine).toMatchObject({ lobbyId: s.lobbyId, bannedUserId: s.a.r1.userId, bannedJoinSeq: r1Seat });
        const mod = moderator(test, 'mod');
        const admin = view<AdminLobbyBanRow>(test, 'view_admin_lobby_bans', mod).filter((r) => r.lobbyId === s.lobbyId);
        expect(admin).toEqual([expect.objectContaining({ bannedUserId: s.a.r1.userId, bannedJoinSeq: r1Seat })]);
    });

    it('A74(2) / A37: an anonymized player referee reads the seat but bannedUserId stays masked (S9a), and can unban by it', () => {
        const { test, s, seat } = waiting({ lobby: { isAnonymousPlayers: true }, hostSlot: 'BluePlayer', seats: [['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        const target = guest(test, 'target');
        join_(test, target, s.lobbyId);
        const tSeat = seat(target);
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: tSeat }));
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        const [row] = view<LobbyBanViewRow>(test, 'view_my_lobby_bans', s.a.r1);
        expect(row.bannedUserId).toBe(0);
        expect(row.bannedJoinSeq).toBe(tSeat);
        expect(row.label).not.toBe(displayName(test, target));
        tx(test, s.a.r1, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: row.bannedJoinSeq }));
        expect(bansOf(test, s.lobbyId)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A74(3): seat numbers are never reused within a lobby
// ════════════════════════════════════════════════════════════════════════════

describe('A74(3): Lobby.lastJoinSeq; a departed seat number is never handed out again', () => {
    it('A74(3) a casual lobby starts with the host on seat 1 and lastJoinSeq 1', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, seats: [] });
        expect(seatOf(test, s.lobbyId, s.host.userId)).toBe(1);
        expect(lobbyRow(test, s.lobbyId).lastJoinSeq).toBe(1);
    });

    it('A74(3) after the highest-seated member leaves a Waiting lobby, the next joiner gets lastJoinSeq + 1', () => {
        const { test, s, seat } = waiting();
        expect(seat(s.a.r2)).toBe(5);
        expect(lobbyRow(test, s.lobbyId).lastJoinSeq).toBe(5);
        tx(test, s.a.r2, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        expect(member(test, s.lobbyId, s.a.r2.userId)).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).lastJoinSeq).toBe(5); // a leave does not move the counter
        const late = guest(test, 'late');
        join_(test, late, s.lobbyId);
        expect(seat(late)).toBe(6);
        expect(lobbyRow(test, s.lobbyId).lastJoinSeq).toBe(6);
        // the departed member returns on a fresh seat too
        join_(test, s.a.r2, s.lobbyId);
        expect(seat(s.a.r2)).toBe(7);
    });

    it('A74(3) a kicked seat is not reused; lastJoinSeq equals the highest seat ever handed out', () => {
        const { test, s, seat } = waiting();
        tx(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: 5 }));
        tx(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: 4 }));
        const n = guest(test, 'n');
        join_(test, n, s.lobbyId);
        expect(seat(n)).toBe(6);
        const all = members(test, s.lobbyId).map((m) => m.joinSeq);
        expect(new Set(all).size).toBe(all.length);
        expect(lobbyRow(test, s.lobbyId).lastJoinSeq).toBe(6);
        expect(lobbyRow(test, s.lobbyId).lastJoinSeq).toBeGreaterThanOrEqual(Math.max(...all));
    });

    it('A74(3) a tournament lobby: its host holds seat 1 and lastJoinSeq starts at 1; joiners continue from it', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        const lobby = lobbyRow(f.test, lobbyId);
        expect(seatOf(f.test, lobbyId, lobby.hostUserId)).toBe(1);
        expect(lobby.lastJoinSeq).toBe(1);
        const cap = f.ts.find((t: any) => t.teamId === m.team1Id)!.captain;
        join(f.test, cap, lobbyId);
        expect(seatOf(f.test, lobbyId, cap.userId)).toBe(2);
        expect(lobbyRow(f.test, lobbyId).lastJoinSeq).toBe(2);
    });

    it('A74(3) / S9a: anonymous labels still follow joinSeq order after a departure', () => {
        const { test, s, seat } = waiting({ lobby: { isAnonymousPlayers: true } });
        tx(test, s.a.b1, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        const late = guest(test, 'late');
        join_(test, late, s.lobbyId);
        tx(test, late, (ctx) => M.set_team_slot(ctx, { lobbyId: s.lobbyId, lobbySlot: { tag: 'BluePlayer' } }));
        expect(seat(late)).toBe(6);
        const rows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.r1);
        const label = (n: number) => rows.find((r) => r.joinSeq === n)!.label;
        expect(label(seat(s.a.b2))).toBe('Blue-1');
        expect(label(seat(late))).toBe('Blue-2');
        expect(label(seat(s.a.r1))).toBe(displayName(test, s.a.r1)); // self identified
        expect(label(seat(s.a.r2))).toBe(displayName(test, s.a.r2)); // teammate identified
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A74(4): anonymity
// ════════════════════════════════════════════════════════════════════════════

describe('A74(4): no user id in the arguments or rejections; an anonymized host acts from view_my_lobby_members', () => {
    it('A74(4) the rejection texts of the six reducers are the exact, id-free strings', () => {
        const { test, s, seat } = waiting();
        const L = s.lobbyId;
        tx(test, s.host, (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r2.userId), lobbySlot: { tag: 'Spectator' } }));
        const texts = [
            errorOf(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT })),
            errorOf(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT })),
            errorOf(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT })),
            errorOf(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r2.userId) })),
            errorOf(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT })),
            errorOf(test, s.host, (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: NO_SEAT, lobbySlot: { tag: 'Spectator' } })),
            errorOf(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: L, bannedJoinSeq: NO_SEAT })),
            errorOf(test, s.a.b1, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) })),
            errorOf(test, s.a.b1, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) })),
            errorOf(test, s.a.b1, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) })),
            errorOf(test, s.a.b1, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) })),
            errorOf(test, s.a.b1, (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId), lobbySlot: { tag: 'Spectator' } })),
            errorOf(test, s.a.b1, (ctx) => M.unban_member(ctx, { lobbyId: L, bannedJoinSeq: NO_SEAT })),
            errorOf(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: 1 })),
            errorOf(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: 1 })),
            errorOf(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: 1 })),
        ];
        expect(texts).toEqual([
            SEAT(NO_SEAT), SEAT(NO_SEAT), SEAT(NO_SEAT),
            'Captain must be a team member (Blue or Red), not a spectator.',
            SEAT(NO_SEAT), SEAT(NO_SEAT), NO_BAN(NO_SEAT),
            KICK_PERM, BAN_PERM, CAPTAIN_PERM, NOT_REFEREE, HOST_OR_ABOVE, UNBAN_PERM,
            'Cannot kick yourself.', 'Cannot ban yourself.', 'You are already the referee.',
        ]);
        for (const t of texts) expect(t).not.toMatch(/user/i);
    });

    it('A74(4) the reducer argument shapes carry no user id (type level)', () => {
        type Args<F> = F extends (ctx: any, args: infer A) => any ? keyof A : never;
        expectTypeOf<Args<typeof M.kick_member>>().toEqualTypeOf<'lobbyId' | 'targetJoinSeq'>();
        expectTypeOf<Args<typeof M.ban_member>>().toEqualTypeOf<'lobbyId' | 'targetJoinSeq'>();
        expectTypeOf<Args<typeof M.set_captain>>().toEqualTypeOf<'lobbyId' | 'targetJoinSeq'>();
        expectTypeOf<Args<typeof M.transfer_referee>>().toEqualTypeOf<'lobbyId' | 'targetJoinSeq'>();
        expectTypeOf<Args<typeof M.set_team_slot>>().toEqualTypeOf<'lobbyId' | 'targetJoinSeq' | 'lobbySlot'>();
        expectTypeOf<Args<typeof M.unban_member>>().toEqualTypeOf<'lobbyId' | 'bannedJoinSeq'>();
    });

    it('A74(4) a fully anonymized player-host moves, sets captain, kicks, bans and transfers the referee using only view_my_lobby_members', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            lobby: { isAnonymousPlayers: true, isAnonymousSpectators: true },
            noStart: true,
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['sp1', 'Spectator'], ['sp2', 'Spectator']],
        });
        const L = s.lobbyId;
        const rows = () => view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.host);
        const seatByLabel = (label: string) => {
            const row = rows().find((r) => r.label === label);
            expect(row, label).toBeDefined();
            expect(row!.userId, `${label} is anonymized to the host`).toBe(0);
            return row!.joinSeq;
        };
        // every opponent and spectator is anonymized to the host
        for (const r of rows().filter((r) => r.lobbySlot.tag === 'RedPlayer' || r.lobbySlot.tag === 'Spectator')) {
            if (r.joinSeq !== 1) expect(r.userId).toBe(0);
        }

        // set_captain: Red-2 becomes the Red captain
        const red2 = seatByLabel('Red-2');
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: red2 }));
        expect(captainOf(test, L, 'RedPlayer')!.joinSeq).toBe(red2);

        // set_team_slot: Red-1 moves to Spectator
        const red1 = seatByLabel('Red-1');
        tx(test, s.host, (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: red1, lobbySlot: { tag: 'Spectator' } }));
        expect(members(test, L).find((m) => m.joinSeq === red1)!.lobbySlot.tag).toBe('Spectator');

        // kick: a spectator seat read from the view
        const spSeats = rows().filter((r) => r.lobbySlot.tag === 'Spectator' && r.joinSeq !== 1).map((r) => r.joinSeq);
        expect(spSeats.length).toBeGreaterThanOrEqual(3);
        const kicked = members(test, L).find((m) => m.joinSeq === spSeats[0])!.userId;
        tx(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: spSeats[0] }));
        expect(member(test, L, kicked)).toBeUndefined();

        // ban: another spectator seat; the ban row records it
        const banned = members(test, L).find((m) => m.joinSeq === spSeats[1])!.userId;
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: spSeats[1] }));
        expect(member(test, L, banned)).toBeUndefined();
        expect(bansOf(test, L).map((b) => b.bannedJoinSeq)).toEqual([spSeats[1]]);

        // transfer_referee: to the Red captain's seat
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: red2 }));
        expect(refereeIds(test, L)).toEqual([members(test, L).find((m) => m.joinSeq === red2)!.userId]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A75: only the spectator referee sees every roster
// ════════════════════════════════════════════════════════════════════════════

describe('A75(1): view_my_roster_visibility grants the referee exemption to the spectator referee only', () => {
    function addAccount(test: Harness, lobbyId: number, who: Actor, uid: string, rating: number, chars: string[]): number {
        const id = insertHsrAccount(test, who.userId, uid);
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(id)!, accountRating: rating, isRosterPublic: true, isRatingPublic: true });
        for (const [i, characterName] of chars.entries()) {
            test.db.HsrAccountCharacter.insert({ hsrAccountId: id, characterName, eidolonLevel: i, ...AUDIT(test) });
        }
        test.db.LobbyMemberAccount.insert({ lobbyId, userId: who.userId, hsrAccountId: id });
        return id;
    }
    /** Anonymous-players Waiting lobby; verified host (the referee) on `hostSlot`; b1 Blue, r1 / r2 Red, each with one account. */
    function world(rv: 'OpenRoster' | 'ClosedWithRating' | 'ClosedNoRating', hostSlot: 'BluePlayer' | 'Spectator') {
        const test = newHarness();
        const host = verified(test, 'rhost');
        const seats: Array<[string, 'BluePlayer' | 'RedPlayer']> = hostSlot === 'BluePlayer'
            ? [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']]
            : [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
        const s = setupLobby(test, { lobby: { isAnonymousPlayers: true, rosterVisibility: { tag: rv } }, noStart: true, hostSlot, seats, actors: { host } });
        expect(lobbyRow(test, s.lobbyId).rosterVisibility.tag).toBe(rv);
        expect(refereeIds(test, s.lobbyId)).toEqual([host.userId]);
        const acc: Record<string, number> = {};
        const names = ['host', ...seats.map(([n]) => n)];
        for (const [i, n] of names.entries()) acc[n] = addAccount(test, s.lobbyId, s.a[n], `${n}-acc`, 1100 + i, [`${n}-c1`, `${n}-c2`]);
        const rows = view<RosterVisibilityRow>(test, 'view_my_roster_visibility', host);
        const seatOfName = (n: string) => seatOf(test, s.lobbyId, s.a[n].userId);
        const of = (n: string) => rows.filter((r) => r.joinSeq === seatOfName(n));
        return { test, s, acc, rows, of, seatOfName };
    }

    it('A75(1) a Blue-seated referee under ClosedNoRating reads nothing of Red; the member row withholds the rating (S9a)', () => {
        const { test, s, of, seatOfName } = world('ClosedNoRating', 'BluePlayer');
        expect(of('r1')).toEqual([]);
        expect(of('r2')).toEqual([]);
        const memberRows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.host);
        for (const n of ['r1', 'r2']) {
            const row = memberRows.find((r) => r.joinSeq === seatOfName(n))!;
            expect(row.accountRating, n).toBeUndefined();
            expect(row.userId, n).toBe(0);
        }
    });

    it('A75(1) a Blue-seated referee under ClosedWithRating reads the rating-only rows of Red (ids 0)', () => {
        const { s, of, seatOfName } = world('ClosedWithRating', 'BluePlayer');
        for (const n of ['r1', 'r2']) {
            expect(of(n), n).toEqual([{ lobbyId: s.lobbyId, joinSeq: seatOfName(n), memberUserId: 0, hsrAccountId: 0, characterName: '', eidolonLevel: 0, accountRating: expect.any(Number) }]);
            expect(of(n)[0].accountRating).toBeGreaterThan(0);
        }
    });

    it('A75(1) a Blue-seated referee under OpenRoster reads Red\'s rosters and ratings with ids masked', () => {
        const { s, acc, rows, of } = world('OpenRoster', 'BluePlayer');
        for (const n of ['r1', 'r2']) {
            expect(of(n).map((r) => r.characterName).sort(), n).toEqual([`${n}-c1`, `${n}-c2`]);
            for (const r of of(n)) expect(r).toMatchObject({ memberUserId: 0, hsrAccountId: 0 });
        }
        expect(rows.some((r) => r.memberUserId === s.a.r1.userId || r.hsrAccountId === acc.r1)).toBe(false);
    });

    it('A75(1) a seated referee reads self and teammates in full (real ids)', () => {
        const { s, acc, of } = world('ClosedNoRating', 'BluePlayer');
        expect(of('host').filter((r) => r.memberUserId === s.host.userId && r.hsrAccountId === acc.host)).toHaveLength(2);
        expect(of('b1').filter((r) => r.memberUserId === s.a.b1.userId && r.hsrAccountId === acc.b1)).toHaveLength(2);
    });

    it('A75(1) the spectator referee reads every roster and rating with real ids, under ClosedNoRating', () => {
        const { s, acc, rows, of } = world('ClosedNoRating', 'Spectator');
        for (const n of ['b1', 'b2', 'r1', 'r2']) {
            const r = of(n);
            expect(r.filter((x) => x.memberUserId === s.a[n].userId && x.hsrAccountId === acc[n]), n).toHaveLength(2);
            for (const x of r) expect(x.accountRating, n).toBeGreaterThan(0);
        }
        expect(rows.some((x) => x.memberUserId === 0)).toBe(false);
    });

    it('A75(1) the referee flag moved to a Red player: that player reads Blue per rosterVisibility (ClosedNoRating: nothing)', () => {
        const { test, s, seatOfName } = world('ClosedNoRating', 'BluePlayer');
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        const r = view<RosterVisibilityRow>(test, 'view_my_roster_visibility', s.a.r1);
        expect(r.filter((x) => x.joinSeq === seatOfName('host') || x.joinSeq === seatOfName('b1'))).toEqual([]);
        expect(r.filter((x) => x.memberUserId === s.a.r2.userId)).toHaveLength(2);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A73: team requests identify the requester to the captain
// ════════════════════════════════════════════════════════════════════════════

describe('A73(1): view_my_team_requests identifies the requester to the captain in every tournament', () => {
    function anonTournamentRequest() {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault: true });
        const [cap, asker, outsider] = ['cap', 'asker', 'outsider'].map((n) => verified(test, n));
        register(test, cap, id);
        register(test, asker, id);
        register(test, outsider, id);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'Forming' }));
        const teamId = [...test.db.TournamentTeam.tournament_id.filter(id)][0].id;
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));
        return { test, id, org, cap, asker, outsider, teamId };
    }

    it('A73(1) the captain of an anonymous tournament reads the requester\'s real userId and real display name', () => {
        const { test, cap, asker, teamId, id } = anonTournamentRequest();
        expect(test.db.Tournament.id.find(id)!.isAnonymousDefault).toBe(true);
        const rows = view<TeamRequestViewRow>(test, 'view_my_team_requests', cap);
        expect(rows).toEqual([expect.objectContaining({ teamId, userId: asker.userId, label: displayName(test, asker), isMine: false })]);
    });

    it('A73(1) the requester\'s own row is unchanged (isMine, real id, the tournament-anonymity label)', () => {
        const { test, asker, teamId } = anonTournamentRequest();
        const [own] = view<TeamRequestViewRow>(test, 'view_my_team_requests', asker);
        expect(own).toMatchObject({ teamId, userId: asker.userId, isMine: true });
        expect(own.label).not.toBe(displayName(test, asker));
        expect(own.label).toBe('Seat-2');
    });

    it('A73(1) an outsider (another registrant, the organizer) reads nothing', () => {
        const { test, outsider, org } = anonTournamentRequest();
        expect(view(test, 'view_my_team_requests', outsider)).toEqual([]);
        expect(view(test, 'view_my_team_requests', org)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Egress: the two ban-view rows gained exactly bannedJoinSeq
// ════════════════════════════════════════════════════════════════════════════

describe('egress: the ban-view rows', () => {
    const BAN = ['lobbyId', 'bannedUserId', 'bannedJoinSeq', 'label', 'bannedByUserId', 'createdDate'] as const;
    const ADMIN_BAN = ['lobbyId', 'bannedUserId', 'bannedJoinSeq', 'bannedUserLabel', 'bannedByUserId', 'bannedByLabel', 'createdDate'] as const;

    it('type level: keyof Row equals the documented columns', () => {
        expectTypeOf<keyof LobbyBanViewRow>().toEqualTypeOf<(typeof BAN)[number]>();
        expectTypeOf<keyof AdminLobbyBanRow>().toEqualTypeOf<(typeof ADMIN_BAN)[number]>();
    });

    it('runtime: one row of each view carries exactly those keys', () => {
        const { test, s, seat } = waiting();
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        const [mine] = view<LobbyBanViewRow>(test, 'view_my_lobby_bans', s.host);
        expect(keysOf(mine)).toEqual([...BAN].sort());
        const [admin] = view<AdminLobbyBanRow>(test, 'view_admin_lobby_bans', moderator(test, 'mod')).filter((r) => r.lobbyId === s.lobbyId);
        expect(keysOf(admin)).toEqual([...ADMIN_BAN].sort());
    });

    // The live residue: A74 through a real client (seat read from a subscribed view_my_lobby_members, reducer called over
    // the wire) needs the maincloud harness; S10 rewrites the marked live call sites.
    it.todo('live (S10): an anonymized host kicks a seat read from the subscribed view_my_lobby_members over the wire');
    it.todo('live (S10): a banned user reconnecting with a new identity on the same account is refused (ban by bannedUserId, seat recorded)');
});
