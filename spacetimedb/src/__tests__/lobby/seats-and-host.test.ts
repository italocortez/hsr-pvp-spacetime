// Lobby: host transfer, team slots and the captain flag, shuffles, unban, seated referees, start_draft naming the
//   seat, and an abandoned row keeping its accounts.
// Decisions: A34a, A39, A45, A88, A93, A120
// Contracts: docs/lobby/contract.md
// From S6, S10d, S10e, S10p (s6-rules.test.ts, s10d-rulings.test.ts, s10e-lobby-identity.test.ts,
//   s10p-fair-shuffles.test.ts).
import { describe, expect, it } from 'vitest';
import { teamDraft } from '@module/helpers/results/scoringHelpers';
import { SHUFFLE_DOMAIN, fairShuffle, shuffleKeyAt } from '@shared/lobby-rules';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    captainOf,
    disconnect,
    expectReject,
    fireCheck,
    guest,
    lobbyRow,
    member,
    newHarness,
    now,
    pendingCheck,
    refereeIds,
    seatOf,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    rejection,
} from '../fixtures/harness';
import { moderator, verified } from '../fixtures/identity';
import { insertHsrAccount, setActive } from '../fixtures/roster';
import {
    H,
    arrange,
    closeGame,
    insertCharacterCostLadder,
    insertRoster,
    recordScores,
    selectAccount,
    side,
} from '../fixtures/draft-and-scoring';
import { leave, lmaRows, members, moveSlot, selfSlot } from '../fixtures/lobby';
import { byKey, draftGame, duel, openMatchLobby, recordsOfLobby, sidesOf } from '../fixtures/tournament-matches';

// ─── A45(3): shuffle_teams, unban_member, delete_my_account ──────────────────────────────────────────────

const slotOf = (s: Lobby, name: string) => member(s.test, s.lobbyId, s.a[name].userId).lobbySlot.tag;

describe('A45(3): shuffle_teams', () => {
    it('TeamSwap moves every Blue seat to Red and back, with one confirmation reset', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.shuffle_teams(ctx, { lobbyId: s.lobbyId, mode: { tag: 'TeamSwap' } }));
        expect(['b1', 'b2'].map((n) => slotOf(s, n))).toEqual(['RedPlayer', 'RedPlayer']);
        expect(['r1', 'r2'].map((n) => slotOf(s, n))).toEqual(['BluePlayer', 'BluePlayer']);
        for (const n of ['b1', 'b2', 'r1', 'r2']) expect(member(test, s.lobbyId, s.a[n].userId).isConfirmed).toBe(false);
    });

    it('RandomSwap keeps two players per team; a player who is not the host is rejected; Drafting is rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.shuffle_teams(ctx, { lobbyId: s.lobbyId, mode: { tag: 'RandomSwap' } }));
        const slots = ['b1', 'b2', 'r1', 'r2'].map((n) => slotOf(s, n));
        expect(slots.filter((x) => x === 'BluePlayer')).toHaveLength(2);
        expect(slots.filter((x) => x === 'RedPlayer')).toHaveLength(2);
        expect(slotOf(s, 'host')).toBe('Spectator');

        expectReject(test, s.a.b1, (ctx) => M.shuffle_teams(ctx, { lobbyId: s.lobbyId, mode: { tag: 'TeamSwap' } }), /Only the host/);

        const d = setupLobby(newHarness());
        expectReject(d.test, d.host, (ctx) => M.shuffle_teams(ctx, { lobbyId: d.lobbyId, mode: { tag: 'TeamSwap' } }), /not allowed in the current lobby stage/);
    });
});

describe('A45(3): unban_member', () => {
    it('the host lifts a ban and the user can rejoin; a plain player cannot; an unbanned user is rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        // T-S9c (A74(2)): the ban records the seat; unban_member takes that seat number.
        const seat = seatOf(test, s.lobbyId, s.a.r2.userId);
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seat }));
        expect([...test.db.LobbyBan.lobby_id.filter(s.lobbyId)]).toHaveLength(1);

        expectReject(test, s.a.b1, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: seat }), /lift a lobby ban/);
        tx(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: seat }));
        expect([...test.db.LobbyBan.lobby_id.filter(s.lobbyId)]).toHaveLength(0);
        tx(test, s.a.r2, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expect(member(test, s.lobbyId, s.a.r2.userId)).toBeDefined();

        // T-S9c (A74(2)/(3)): the lifted seat has no ban left (the old "not banned" text is now the seat rejection).
        expectReject(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: seat }), `No ban is recorded for seat ${seat} of this lobby.`);
    });
});

const SEATED_TIE = 'A referee seated on a team cannot decide a tie in a tournament lobby; staff must close this game.';

// ════════════════════════════════════════════════════════════════════════════
// A88: a team-seated tournament referee keeps score adjustments and the staff close (documentation test)
// ════════════════════════════════════════════════════════════════════════════

describe('A88: a referee seated on a team in a tournament lobby (documentation of A39 against A34a)', () => {
    /** A Bo1 tournament lobby created by the Blue captain (host + referee on the Blue player seat), played to Scoring. */
    function seatedRefereeGame() {
        const f = duel({ defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id, { creator: sidesOf(f, m.id).blue.captain });
        const { test, lobbyId } = s;
        const ref = [...test.db.LobbyMember.lobby_id.filter(lobbyId)].find((r) => r.userId === s.host.userId)!;
        expect(ref.isReferee).toBe(true);
        expect(ref.lobbySlot.tag).toBe('BluePlayer');
        draftGame(s);
        for (const team of ['Blue', 'Red'] as const) {
            const names = tx(test, 'internal', (ctx) => teamDraft(ctx, lobbyId, team).characters);
            advance(test, 300); // the lineup throttle on the referee
            arrange(s, s.host, team, [names.slice(0, 4), names.slice(4, 8)]);
        }
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId }));
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Scoring');
        return { f, s };
    }

    it('the seated referee adjusts the other team\'s score and closes the game as staff: accepted (A88, A34a, A60(4))', () => {
        const { s } = seatedRefereeGame();
        const { test, lobbyId } = s;
        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]);
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Red'), value: H(1), reason: 'penalty' }));
        closeGame(s, s.host);
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('AwaitingResult');
        const [rec] = recordsOfLobby(test, lobbyId);
        expect(rec.winnerTeamSide?.tag).toBe('Blue');
        expect(rec.refereeUserId).toBe(s.host.userId);
    });

    it('the same referee\'s winnerOverride on an unresolved tie is still rejected (A88 keeps A39)', () => {
        const { s } = seatedRefereeGame();
        const { test, lobbyId } = s;
        recordScores(s, s.host, 'Blue', [H(5), H(6)]);
        recordScores(s, s.host, 'Red', [H(5), H(6)]);
        const msg = rejection(test, s.host, (ctx) => M.close_game(ctx, { lobbyId, winnerOverride: side('Blue') }));
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Scoring');
        expect(recordsOfLobby(test, lobbyId)[0].status.tag).toBe('Pending');
        expect(msg).toBe(SEATED_TIE);
    });
});

// ─── Texts ───────────────────────────────────────────────────────────────────

const HOST_ONLY = 'Only the host, moderators, or admins can hand over the host role.';
const NO_SEAT = (n: number) => `No member sits at seat ${n} of this lobby.`;
const ALREADY_HOST = (n: number) => `The member at seat ${n} is already the host.`;
const LEFT_HOST = (n: number) => `The member at seat ${n} has left the match and cannot become the host.`;
const NO_ACCOUNT_RANKED = (n: number) =>
    `The player at seat ${n} has no account selected for this match. All players must select an account before starting a ranked or MMR-counted match.`;
const NO_ACCOUNT_AUTO = (n: number) =>
    `The player at seat ${n} has no account selected. autoRandomPick requires all players to have characters.`;
const NO_CHARS_AUTO = (n: number) =>
    `The player at seat ${n} has no characters on their selected account(s). autoRandomPick requires all players to have characters.`;
const transferHost = (lobbyId: number, targetJoinSeq: number) => (ctx: any) => M.transfer_host(ctx, { lobbyId, targetJoinSeq });
const flags = (test: Harness, lobbyId: number) =>
    `${lobbyRow(test, lobbyId).hostUserId}|${refereeIds(test, lobbyId).join(',')}|${lobbyRow(test, lobbyId).stage.tag}`;

/** Guests created first so that user ids sit well above the seat numbers (a text naming a seat cannot hold an id by chance). */
function pad(test: Harness, n = 12) {
    for (let i = 0; i < n; i++) guest(test, `pad-${i}`);
}

/** The text names no user id of `userIds` (as a whole number). */
function expectNoUserId(msg: string, ...userIds: number[]) {
    for (const id of userIds) expect(msg).not.toMatch(new RegExp(`(^|\\D)${id}(\\D|$)`));
}

/** `who` leaves a live lobby (away) and takes a new lobby with abandonCurrentMatch: the away row becomes abandoned. */
function abandon(test: Harness, who: Actor, lobbyId: number) {
    leave(test, who, lobbyId);
    tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
    expect(member(test, lobbyId, who.userId).abandonedAt).toBeDefined();
}

// ════════════════════════════════════════════════════════════════════════════
// 1. A93: transfer_host and the host role on a disconnect
// ════════════════════════════════════════════════════════════════════════════

describe('A93(3): transfer_host', () => {
    it('Waiting: the host hands the role to a present member by seat; the referee flag stays; the new host may hand it back (A93(3))', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, transferHost(s.lobbyId, seatOf(test, s.lobbyId, s.a.r1.userId)));
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.r1.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');

        tx(test, s.a.r1, transferHost(s.lobbyId, seatOf(test, s.lobbyId, s.host.userId)));
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
    });

    it('a live stage (Drafting): the hand-over works and the referee flag does not move (A93(3))', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        tx(test, s.host, transferHost(s.lobbyId, seatOf(test, s.lobbyId, s.a.b2.userId)));
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b2.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });

    it('a Moderator who is not a member of the lobby can hand the host role over (A93(3))', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const mod = moderator(test);
        expect(member(test, s.lobbyId, mod.userId)).toBeUndefined();
        tx(test, mod, transferHost(s.lobbyId, seatOf(test, s.lobbyId, s.a.b1.userId)));
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expect(member(test, s.lobbyId, mod.userId)).toBeUndefined();
    });

    it('a member who is not the host (the referee included) is rejected; nothing changes (A93(3))', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
        for (const who of [s.a.b1, s.a.r1]) {
            const before = flags(test, s.lobbyId);
            const msg = rejection(test, who, transferHost(s.lobbyId, seatOf(test, s.lobbyId, s.a.r2.userId)));
            expect(flags(test, s.lobbyId)).toBe(before);
            expect(msg).toBe(HOST_ONLY);
        }
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
    });

    it('a missing seat, the host\'s own seat, an away and an abandoned target are rejected with their texts; nothing changes (A93(3), A74)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        leave(test, s.a.b2, s.lobbyId); // away (A68(2))
        abandon(test, s.a.r2, s.lobbyId); // abandoned (A68(4))
        const cases: Array<[number, string]> = [
            [99, NO_SEAT(99)],
            [seatOf(test, s.lobbyId, s.host.userId), ALREADY_HOST(seatOf(test, s.lobbyId, s.host.userId))],
            [seatOf(test, s.lobbyId, s.a.b2.userId), LEFT_HOST(seatOf(test, s.lobbyId, s.a.b2.userId))],
            [seatOf(test, s.lobbyId, s.a.r2.userId), LEFT_HOST(seatOf(test, s.lobbyId, s.a.r2.userId))],
        ];
        for (const [seat, text] of cases) {
            const before = flags(test, s.lobbyId);
            const msg = rejection(test, s.host, transferHost(s.lobbyId, seat));
            expect(flags(test, s.lobbyId)).toBe(before);
            expect(msg).toBe(text);
        }
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
    });

    it('an anonymous lobby: the rejection texts carry the seat number and no user id (A93(3), A74)', () => {
        const test = newHarness();
        pad(test);
        const s = setupLobby(test, { lobby: { isAnonymousPlayers: true, isAnonymousSpectators: true } });
        leave(test, s.a.b2, s.lobbyId);
        abandon(test, s.a.r2, s.lobbyId);
        const hostSeat = seatOf(test, s.lobbyId, s.host.userId);
        const b2Seat = seatOf(test, s.lobbyId, s.a.b2.userId);
        const r2Seat = seatOf(test, s.lobbyId, s.a.r2.userId);
        const ids = Object.values(s.a).map((a) => a.userId);
        for (const [seat, text] of [[hostSeat, ALREADY_HOST(hostSeat)], [b2Seat, LEFT_HOST(b2Seat)], [r2Seat, LEFT_HOST(r2Seat)]] as const) {
            const msg = rejection(test, s.host, transferHost(s.lobbyId, seat));
            expect(msg).toBe(text);
            expectNoUserId(msg, ...ids);
        }
    });

    it('Leave by the host in Waiting still passes the host role on (A93(4), A68(7))', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        leave(test, s.host, s.lobbyId);
        expect(member(test, s.lobbyId, s.host.userId)).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId); // A22(5): Blue players by joinSeq, online first
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
    });

    it('Drafting: a disconnected host still loses the role to an online member through the 15 s check (A93(4), D.8.2)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        disconnect(test, s.host);
        const row = pendingCheck(test, s.lobbyId, s.host.userId);
        advance(test, 15_000);
        fireCheck(test, row);
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
    });

    it('a spectator host who went offline in Waiting: start_draft schedules the 15 s check, which moves the host role in Drafting (A93(4), S10e review F2)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
        disconnect(test, s.host);
        // A93(1): a host who is not the referee schedules nothing in Waiting.
        expect([...test.db.RefereeTransferCheck.by_lobby_and_user.filter([s.lobbyId, s.host.userId])]).toHaveLength(0);

        tx(test, s.a.b1, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
        const check = pendingCheck(test, s.lobbyId, s.host.userId);
        expect(member(test, s.lobbyId, s.host.userId).disconnectedAt).toBeUndefined(); // no stamp beyond the check
        advance(test, 15_000);
        fireCheck(test, check);
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId); // A22(5): Blue players by joinSeq, online
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Lobby audit #3: the captain flag follows the seat
// ════════════════════════════════════════════════════════════════════════════

describe('lobby audit #3: set_team_slot clears the captain flag on a team, coach or spectator move', () => {
    const captainsOf = (test: Harness, lobbyId: number, team: 'Blue' | 'Red') =>
        members(test, lobbyId).filter((m) => m.lobbySlot.tag === `${team}Player` && m.isCaptain).map((m) => m.userId);
    const expectAtMostOneCaptain = (test: Harness, lobbyId: number) => {
        expect(captainsOf(test, lobbyId, 'Blue').length).toBeLessThanOrEqual(1);
        expect(captainsOf(test, lobbyId, 'Red').length).toBeLessThanOrEqual(1);
        // A captain flag sits on a team player seat only.
        for (const m of members(test, lobbyId)) {
            if (m.isCaptain) expect(['BluePlayer', 'RedPlayer']).toContain(m.lobbySlot.tag);
        }
    };

    it('a captain moved to the other team, to a coach seat or to Spectator is no longer captain; no team has two; start_draft fills the gap (lobby audit #3, D-30)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, lobby: { teamSize: 3 } });
        const { lobbyId } = s;
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, s.a.b1.userId) }));
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, s.a.r1.userId) }));
        expect(captainsOf(test, lobbyId, 'Blue')).toEqual([s.a.b1.userId]);
        expect(captainsOf(test, lobbyId, 'Red')).toEqual([s.a.r1.userId]);

        // The audit scenario: the Blue captain moves to Red.
        tx(test, s.a.b1, selfSlot(lobbyId, 'RedPlayer'));
        expect(member(test, lobbyId, s.a.b1.userId).isCaptain).toBe(false);
        expect(captainsOf(test, lobbyId, 'Red')).toEqual([s.a.r1.userId]);
        expect(captainsOf(test, lobbyId, 'Blue')).toEqual([]);
        expectAtMostOneCaptain(test, lobbyId);

        // A captain moved to a coach seat of its own team.
        tx(test, s.host, moveSlot(lobbyId, seatOf(test, lobbyId, s.a.r1.userId), 'RedCoach'));
        expect(member(test, lobbyId, s.a.r1.userId).isCaptain).toBe(false);
        expect(captainsOf(test, lobbyId, 'Red')).toEqual([]);
        expectAtMostOneCaptain(test, lobbyId);

        // A captain moved to Spectator, then back to a player seat: still not captain.
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, s.a.b2.userId) }));
        expect(captainsOf(test, lobbyId, 'Blue')).toEqual([s.a.b2.userId]);
        tx(test, s.a.b2, selfSlot(lobbyId, 'Spectator'));
        expect(member(test, lobbyId, s.a.b2.userId).isCaptain).toBe(false);
        tx(test, s.a.b2, selfSlot(lobbyId, 'BluePlayer'));
        expect(member(test, lobbyId, s.a.b2.userId).isCaptain).toBe(false);
        expectAtMostOneCaptain(test, lobbyId);

        // Blue: b2; Red: r2, b1 (r1 coaches). start_draft names one captain per team.
        for (const who of [s.a.b1, s.a.b2, s.a.r2]) tx(test, who, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        tx(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId }));
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Drafting');
        expect(captainsOf(test, lobbyId, 'Blue')).toEqual([s.a.b2.userId]);
        expect(captainsOf(test, lobbyId, 'Red')).toHaveLength(1);
        expect([s.a.r2.userId, s.a.b1.userId]).toContain(captainsOf(test, lobbyId, 'Red')[0]);
        expectAtMostOneCaptain(test, lobbyId);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Lobby audit #9: start_draft account rejections name the seat
// ════════════════════════════════════════════════════════════════════════════

describe('lobby audit #9: start_draft names the seat, never a user id (anonymous lobby, seated referee)', () => {
    /** Host = referee seated on Blue with b1; r1 alone on Red. */
    function anonLobby(test: Harness, lobby: Record<string, unknown>, actors: Record<string, Actor> = {}): Lobby {
        return setupLobby(test, {
            noStart: true,
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer']],
            actors,
            lobby: { isAnonymousPlayers: true, isAnonymousSpectators: true, ...lobby },
        });
    }
    const ids = (s: Lobby) => Object.values(s.a).map((a) => a.userId);

    it('Ranked: "The player at seat N has no account selected for this match ..." (lobby audit #9)', () => {
        const test = newHarness();
        pad(test);
        const actors = { host: verified(test, 'h'), b1: verified(test, 'b1'), r1: verified(test, 'r1') };
        const s = anonLobby(test, { matchType: { tag: 'Ranked' } }, actors);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        for (const who of [s.host, s.a.b1]) {
            test.db.LobbyMemberAccount.insert({ lobbyId: s.lobbyId, userId: who.userId, hsrAccountId: insertHsrAccount(test, who.userId, `uid-${who.sub}`) });
        }
        const seat = seatOf(test, s.lobbyId, s.a.r1.userId);
        const msg = rejection(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
        expect(msg).toBe(NO_ACCOUNT_RANKED(seat));
        expectNoUserId(msg, ...ids(s));
    });

    it('autoRandomPick: "no account selected" and "no characters" texts name the seat (lobby audit #9)', () => {
        const test = newHarness();
        pad(test);
        // S10o: A117(1) runs the autoRandomPick account check only when the lobby requires ownership.
        const s = anonLobby(test, { autoRandomPick: true, requireOwnership: true });
        selectAccount(test, s.lobbyId, s.host.userId, 900, { c1: 0 });
        selectAccount(test, s.lobbyId, s.a.b1.userId, 901, { c2: 0 });
        const seat = seatOf(test, s.lobbyId, s.a.r1.userId);

        const noAccount = rejection(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
        expect(noAccount).toBe(NO_ACCOUNT_AUTO(seat));
        expectNoUserId(noAccount, ...ids(s));

        selectAccount(test, s.lobbyId, s.a.r1.userId, 902, {}); // an account with no characters
        const noChars = rejection(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
        expect(noChars).toBe(NO_CHARS_AUTO(seat));
        expectNoUserId(noChars, ...ids(s));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Lobby audit #12: the roster guards ignore an abandoned membership (S10e review F3)
// ════════════════════════════════════════════════════════════════════════════

describe('lobby audit #12 / S10e review F3: an abandoned row keeps its accounts; the roster guards ignore it', () => {
    it('the abandoned row keeps its LobbyMemberAccount rows, the team still owns what only the departed player owned, and the player can change the active account, edit and delete the selected one (lobby audit #12, F3)', () => {
        const test = newHarness();
        insertRoster(test, ['c1', 'c2']);
        for (const c of ['c1', 'c2']) insertCharacterCostLadder(test, c, 'Classic', [1, 1, 1, 1, 1, 1, 1]);
        const b1 = verified(test, 'b1');
        const acctE2 = insertHsrAccount(test, b1.userId, 'uid-a1'); // c1 at E2
        const acctE0 = insertHsrAccount(test, b1.userId, 'uid-a3'); // c1 at E0
        const other = insertHsrAccount(test, b1.userId, 'uid-a2');
        setActive(test, acctE0, false);
        setActive(test, other, false);
        const s = setupLobby(test, {
            actors: { b1 },
            // requireOwnership: the team's levels come from its players' selected accounts; NoAction: no auto-pause.
            lobby: { requireOwnership: true, disconnectPolicy: { tag: 'NoAction' } },
            beforeStart: (l) => {
                selectAccount(test, l.lobbyId, b1.userId, acctE2, { c1: 2 });
                selectAccount(test, l.lobbyId, b1.userId, acctE0, { c1: 0 });
            },
        });
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(b1.userId);
        tx(test, b1, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'c1', eidolon: 0 })); // resolved E2
        // The lock holds while the membership is live, and while it is only away (A68(2): the player may return).
        expect(rejection(test, b1, (ctx) => M.set_active_hsr_account(ctx, { hsrAccountId: other }))).toMatch(/Leave the lobby first\.$/);
        leave(test, b1, s.lobbyId);
        expect(rejection(test, b1, (ctx) => M.set_active_hsr_account(ctx, { hsrAccountId: other }))).toMatch(/Leave the lobby first\.$/);

        abandon(test, b1, s.lobbyId);
        expect(lmaRows(test, s.lobbyId, b1.userId).map((r) => r.hsrAccountId).sort()).toEqual([acctE2, acctE0].sort());
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.a.b2.userId); // A68(4): the flag transfers

        // The team's ownership pool is unchanged: E0 of c1 is owned only through the departed player's account.
        tx(test, s.a.b2, (ctx) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' } as any, characterName: 'c1', eidolon: 0 }));
        const edit = steps(test, s.lobbyId).find((st) => st.action.tag === 'SetEidolon')!;
        expect(edit.payload.value).toMatchObject({ characterName: 'c1', eidolon: 0, previousEidolon: 2 });

        // The roster guards ignore the abandoned row: active account, character edit, delete.
        tx(test, b1, (ctx) => M.set_active_hsr_account(ctx, { hsrAccountId: other }));
        expect(test.db.HsrAccount.id.find(other)?.isActive).toBe(true);
        tx(test, b1, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: acctE2, charactersJson: JSON.stringify([{ characterName: 'c2', eidolonLevel: 1 }]) }));
        expect([...test.db.HsrAccountCharacter.by_account_and_character.filter([acctE2, 'c2'])]).toHaveLength(1);
        tx(test, b1, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: acctE2 }));
        expect(test.db.HsrAccount.id.find(acctE2)).toBeFalsy();
    });
});

const PLAYER_SLOTS = new Set(['BluePlayer', 'RedPlayer']);
const SHUFFLE_SEATS: Array<[string, 'BluePlayer' | 'RedPlayer' | 'BlueCoach' | 'RedCoach' | 'Spectator']> = [
    ['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['rc', 'RedCoach'], ['sp', 'Spectator'],
];

const randomSwap = (s: Lobby) => tx(s.test, s.host, (ctx) => M.shuffle_teams(ctx, { lobbyId: s.lobbyId, mode: { tag: 'RandomSwap' } as any }));
const slotsOf = (s: Lobby, names: string[]) => Object.fromEntries(names.map((n) => [n, member(s.test, s.lobbyId, s.a[n].userId).lobbySlot.tag]));

/** The seats RandomSwap must deal: the players (by joinSeq) through fairShuffle at the current clock, Blue, Red, Blue, ... */
function expectedSwap(s: Lobby): Map<number, string> {
    const players = [...s.test.db.LobbyMember.lobby_id.filter(s.lobbyId)]
        .filter((m) => PLAYER_SLOTS.has(m.lobbySlot.tag))
        .sort((a, b) => a.joinSeq - b.joinSeq)
        .map((m) => m.userId);
    const pool = fairShuffle(players, shuffleKeyAt(now(s.test), [SHUFFLE_DOMAIN.RandomSwap, s.lobbyId]));
    return new Map(pool.map((userId, i) => [userId, i % 2 === 0 ? 'BluePlayer' : 'RedPlayer']));
}

// ════════════════════════════════════════════════════════════════════════════
// shuffle_teams RandomSwap (A45(3))
// ════════════════════════════════════════════════════════════════════════════

describe('A120: shuffle_teams RandomSwap uses the fair shuffle', () => {
    it('A120: two players per team, dealt as fairShuffle gives; coaches and the spectator stay; captain flags cleared; everyone unconfirmed', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SHUFFLE_SEATS, noStart: true });
        // A captain flag on a Blue player, written directly, to see RandomSwap clear it.
        const cap = member(test, s.lobbyId, s.a.b1.userId);
        test.db.LobbyMember.by_lobby_and_user.delete([s.lobbyId, cap.userId]);
        test.db.LobbyMember.insert({ ...cap, isCaptain: true });
        advance(test, 777);
        const want = expectedSwap(s);
        randomSwap(s);

        const players = ['b1', 'b2', 'r1', 'r2'];
        const slots = slotsOf(s, players);
        for (const n of players) expect(slots[n]).toBe(want.get(s.a[n].userId));
        expect(Object.values(slots).filter((x) => x === 'BluePlayer')).toHaveLength(2);
        expect(Object.values(slots).filter((x) => x === 'RedPlayer')).toHaveLength(2);
        expect(slotsOf(s, ['bc', 'rc', 'sp', 'host'])).toEqual({ bc: 'BlueCoach', rc: 'RedCoach', sp: 'Spectator', host: 'Spectator' });
        for (const m of [...test.db.LobbyMember.lobby_id.filter(s.lobbyId)]) {
            expect(m.isCaptain).toBe(false);
            expect(m.isConfirmed).toBe(false);
        }
    });

    it('A120: repeated RandomSwaps at different timestamps give at least two distinct assignments, each the one fairShuffle gives', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SHUFFLE_SEATS, noStart: true });
        const assignments = new Set<string>();
        for (let i = 0; i < 12; i++) {
            advance(test, 1_000);
            const want = expectedSwap(s);
            randomSwap(s);
            const slots = slotsOf(s, ['b1', 'b2', 'r1', 'r2']);
            for (const n of ['b1', 'b2', 'r1', 'r2']) expect(slots[n]).toBe(want.get(s.a[n].userId));
            expect(slotsOf(s, ['bc', 'rc'])).toEqual({ bc: 'BlueCoach', rc: 'RedCoach' });
            assignments.add(JSON.stringify(slots));
        }
        expect(assignments.size).toBeGreaterThanOrEqual(2);
    });
});
