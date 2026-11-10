// T-S10e: in-memory tests for the S10e change: DECISIONS.md A93 (the host in the waiting room; transfer_host) and the
// 2026-11-09 audit findings it closes (notes/audit-2026-11-09: lobby #3, #5, #6, #9, #10, #12, LOW #24; identity /
// admin #1, #3, #4, #5, #6 (re-aligned in s5-abuse), LOW #9, #14). The tests assert the decision row and the audit's
// failing scenario with the suggested fix as the intent; the code is not the reference. A rejection checks the state
// first and the text last (`rejection()`). Builders come from the s4 / s7 / s8 / s8d / s10 fixtures; the clock is the
// TestClock; the A22a scheduler is fired by hand. `server_link_provider`, `server_register_delegate`,
// `server_revoke_delegate`, `server_set_role` and `server_delete_user` run as 'internal' (the owner); none of them reads
// ctx.env. Nothing reaches maincloud.
// S10e fix pass (review findings F1-F5, N1, N3, N8, N9): lobby #12 re-aligned (abandoned rows keep their accounts; the
// roster guards ignore them), leaves no longer counted by the membership rate, negative handicaps accepted again; new
// tests for the admin_delete_row guards, the start_draft check for an offline host and a deleted last live identity.
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    START,
    advance,
    captainOf,
    connect,
    fireCheck,
    disconnect,
    guest,
    joinAsSpectator,
    linkDiscord,
    lobbyRow,
    member,
    newHarness,
    pendingCheck,
    refereeIds,
    seatOf,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SlotTag,
} from './s4-fixtures';
import { insertCharacterCostLadder, insertRoster, selectAccount } from './s7-fixtures';
import { AUDIT, insertHsrAccount, moderator, verified } from './s8-fixtures';
import { byKey, duel, openMatchLobby } from './s8d-fixtures';
import { createLobby, joinLobby, presetArgs, presetNamed, setActive, settingsArgs, updatePresetArgs } from './s10-a1-fixtures';
import { freshAuth, identitiesOf } from './s10-c1-fixtures';
import { DAY_MS, rejection } from './s10-c2-fixtures';

// ─── Texts ───────────────────────────────────────────────────────────────────

const HOST_ONLY = 'Only the host, moderators, or admins can hand over the host role.';
const NO_SEAT = (n: number) => `No member sits at seat ${n} of this lobby.`;
const ALREADY_HOST = (n: number) => `The member at seat ${n} is already the host.`;
const LEFT_HOST = (n: number) => `The member at seat ${n} has left the match and cannot become the host.`;
const ALIAS_CAP = 'Team aliases must be at most 30 characters.';
const META_CAP = 'Message metadata exceeds 200 character limit.';
const TOO_FAST = 'You are changing lobbies or seats too quickly. Please wait a moment.';
const NO_ACCOUNT_RANKED = (n: number) =>
    `The player at seat ${n} has no account selected for this match. All players must select an account before starting a ranked or MMR-counted match.`;
const NO_ACCOUNT_AUTO = (n: number) =>
    `The player at seat ${n} has no account selected. autoRandomPick requires all players to have characters.`;
const NO_CHARS_AUTO = (n: number) =>
    `The player at seat ${n} has no characters on their selected account(s). autoRandomPick requires all players to have characters.`;
const TEAM_SIZE = 'teamSize must be 1, 2, or 3.';
const RANGE = (name: string, min: number, max: number) => `${name} must be between ${min} and ${max}.`;
const AMOUNT = (name: string) => `${name} must be a number between 0 and 100000.`;
const HANDICAP = (name: string) => `${name} must be between -1000000 and 1000000 (hundredths).`; // S10e review N1
const THRESHOLD = 'rosterThreshold must be between 0 and 1000000 (hundredths).';
const RANKED_GUEST = 'A guest is in this lobby; guests cannot join Ranked lobbies.';
const SYSTEM_DELETE = 'The SYSTEM user cannot be deleted.';
const SYSTEM_CHANGE = 'The SYSTEM user cannot be changed.';
const BAD_JSON = (table: string) => `Invalid primary key for ${table}: expected JSON`;
const BAD_IDENTITY = 'Invalid primary key for UserIdentity: expected an identity hex string';
const NOT_ARRAY = 'jsonData must be a JSON array';
const LOBBY_ALIVE = (table: string, lobbyId: number) =>
    `Cannot delete a ${table} row of lobby #${lobbyId} while the lobby exists. Delete the Lobby row instead.`;
// S10e fix pass texts (review F1, F4, N9).
const TOURNAMENT_LOBBY = 'This is a tournament lobby: use rollback_bracket_match or the tournament result reducers (results permission).';
const RECORD_COUNTED = 'This lobby\'s match result is Validated or already processed: use admin_void_match or override_match_result.';
const NO_PLAYER_REMOVAL = 'Players cannot be removed once the draft has started; the match ends by result, concede or forfeit.';
const SERVER_MAPPING = 'A server identity mapping cannot be deleted.';
const SYSTEM_MAPPING = 'A mapping of the SYSTEM user cannot be deleted.';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const members = (test: Harness, lobbyId: number) => [...test.db.LobbyMember.lobby_id.filter(lobbyId)];
const chatRows = (test: Harness, lobbyId: number) => [...test.db.ChatMessage.lobby_id.filter(lobbyId)];
const lmaRows = (test: Harness, lobbyId: number, userId: number) =>
    [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])];
const transferHost = (lobbyId: number, targetJoinSeq: number) => (ctx: any) => M.transfer_host(ctx, { lobbyId, targetJoinSeq });
const leave = (test: Harness, who: Actor, lobbyId: number) => tx(test, who, (ctx) => M.leave_lobby(ctx, { lobbyId }));
const flags = (test: Harness, lobbyId: number) =>
    `${lobbyRow(test, lobbyId).hostUserId}|${refereeIds(test, lobbyId).join(',')}|${lobbyRow(test, lobbyId).stage.tag}`;
const selfSlot = (lobbyId: number, tag: SlotTag) => (ctx: any) => M.set_team_slot(ctx, { lobbyId, lobbySlot: { tag } as any });
const moveSlot = (lobbyId: number, seat: number, tag: SlotTag) => (ctx: any) =>
    M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seat, lobbySlot: { tag } as any });
const systemUserId = (test: Harness) => test.db.User.username.find('SYSTEM')!.id;

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

/** A System ChatMessage row written straight into the datastore at `createdDate`. */
function insertChat(test: Harness, lobbyId: number, content: string, createdDate: Timestamp = test.clock.now()) {
    return test.db.ChatMessage.insert({
        id: 0,
        lobbyId,
        senderUserId: 0,
        senderType: { tag: 'System' } as any,
        content,
        metadata: undefined,
        anonymousLabel: undefined,
        createdById: 0,
        createdDate,
        lastModifiedById: 0,
        lastModifiedDate: createdDate,
    }).id;
}

/** Fills the lobby's chat up to 50 rows; the last row written is the oldest by createdDate (and the newest by id). */
function fillChatWithOldestLast(test: Harness, lobbyId: number): number {
    const existing = chatRows(test, lobbyId).length;
    for (let i = existing; i < 49; i++) insertChat(test, lobbyId, `filler-${i}`);
    const oldestId = insertChat(test, lobbyId, 'oldest', Timestamp.fromDate(new Date('2025-12-31T00:00:00Z')));
    expect(chatRows(test, lobbyId)).toHaveLength(50);
    return oldestId;
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
// 3. Lobby audit #5: alias and chat metadata caps
// ════════════════════════════════════════════════════════════════════════════

describe('lobby audit #5: team aliases (30) and chat metadata (200) are capped', () => {
    const A = (n: number) => 'a'.repeat(n);

    it('create_lobby: aliases of 30 accepted, 31 (Blue or Red) rejected with no lobby written (lobby audit #5)', () => {
        const test = newHarness();
        const ok = guest(test, 'ok');
        const id = createLobby(test, ok, { teamBlueAlias: A(30), teamRedAlias: A(30) });
        expect(lobbyRow(test, id).teamBlueAlias).toBe(A(30));
        expect(lobbyRow(test, id).teamRedAlias).toBe(A(30));
        for (const over of [{ teamBlueAlias: A(31) }, { teamRedAlias: A(31) }]) {
            const g = guest(test, `g-${Object.keys(over)[0]}`);
            const msg = rejection(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...over } as any));
            expect([...test.db.Lobby.host_user_id.filter(g.userId)]).toHaveLength(0);
            expect(msg).toBe(ALIAS_CAP);
        }
    });

    it('update_lobby_settings: aliases of 30 accepted, 31 rejected with the row unchanged (lobby audit #5)', () => {
        const test = newHarness();
        const h = guest(test, 'h');
        const id = createLobby(test, h);
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { teamBlueAlias: A(30), teamRedAlias: A(30) })));
        expect(lobbyRow(test, id).teamBlueAlias).toBe(A(30));
        for (const over of [{ teamBlueAlias: A(31) }, { teamRedAlias: A(31) }]) {
            const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { teamBlueAlias: 'x', ...over })));
            expect(lobbyRow(test, id).teamBlueAlias).toBe(A(30));
            expect(lobbyRow(test, id).teamRedAlias).toBe(A(30));
            expect(msg).toBe(ALIAS_CAP);
        }
    });

    it('send_chat_message: metadata of 200 accepted, 201 rejected; the documented shapes still pass (lobby audit #5, D-14)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const meta = (n: number) => {
            const base = '{"type":"text","pad":""}';
            return `${base.slice(0, -2)}${'x'.repeat(n - base.length)}"}`;
        };
        expect(meta(200)).toHaveLength(200);
        expect(JSON.parse(meta(201)).type).toBe('text');
        const send = (metadata: string) => (ctx: any) => M.send_chat_message(ctx, { lobbyId: s.lobbyId, content: 'hi', metadata });

        const accepted = ['', '{"type":"text"}', '{"type":"reply","replyToMessageId":4294967295}', '{"type":"emoji_only"}', meta(200)];
        for (const metadata of accepted) {
            const before = chatRows(test, s.lobbyId).length;
            tx(test, s.a.b1, send(metadata));
            expect(chatRows(test, s.lobbyId)).toHaveLength(before + 1);
            advance(test, 2_100);
        }
        const before = chatRows(test, s.lobbyId).length;
        const msg = rejection(test, s.a.b1, send(meta(201)));
        expect(chatRows(test, s.lobbyId)).toHaveLength(before);
        expect(msg).toBe(META_CAP);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Lobby audit #6: the chat window for System lines and the membership rate
// ════════════════════════════════════════════════════════════════════════════

describe('lobby audit #6: member-event and start lines stay inside the D-13 window', () => {
    it('30 guests join and leave a Waiting lobby (60 System lines): the chat never exceeds 50 rows (lobby audit #6)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        for (let i = 0; i < 30; i++) {
            const g = guest(test, `churn-${i}`);
            joinLobby(test, g, s.lobbyId);
            expect(chatRows(test, s.lobbyId).length).toBeLessThanOrEqual(50);
            advance(test, 500);
            leave(test, g, s.lobbyId);
            expect(chatRows(test, s.lobbyId).length).toBeLessThanOrEqual(50);
            advance(test, 500);
        }
        expect(chatRows(test, s.lobbyId)).toHaveLength(50);
    });

    it('a member-event line at a full window removes the oldest row by creation time, not the lowest id (lobby audit #6, #14)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        advance(test, 1_000);
        const lowestId = Math.min(...chatRows(test, s.lobbyId).map((r) => r.id));
        const oldestId = fillChatWithOldestLast(test, s.lobbyId);
        expect(oldestId).toBeGreaterThan(lowestId);

        joinLobby(test, guest(test, 'late'), s.lobbyId);
        const rows = chatRows(test, s.lobbyId);
        expect(rows).toHaveLength(50);
        expect(rows.map((r) => r.id)).not.toContain(oldestId);
        expect(rows.map((r) => r.id)).toContain(lowestId);
    });

    it('the "Draft has started!" line at a full window keeps the lobby at 50 and removes the oldest row by creation time (lobby audit #6)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        advance(test, 1_000);
        const oldestId = fillChatWithOldestLast(test, s.lobbyId);
        tx(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        const rows = chatRows(test, s.lobbyId);
        expect(rows).toHaveLength(50);
        expect(rows.map((r) => r.id)).not.toContain(oldestId);
        expect(rows.some((r) => r.content === 'Draft has started!')).toBe(true);
    });
});

describe('lobby audit #6: the membership rate (20 changes per 10 s per user)', () => {
    it('20 seat changes inside 10 s pass, the 21st is rejected with the row unchanged, a new window passes (lobby audit #6)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, seats: [['m', 'Spectator']] });
        const m = s.a.m;
        advance(test, 10_000); // the join opened a window; start a fresh one
        for (let i = 0; i < 20; i++) {
            tx(test, m, selfSlot(s.lobbyId, i % 2 === 0 ? 'BluePlayer' : 'Spectator'));
            advance(test, 100);
        }
        expect(member(test, s.lobbyId, m.userId).lobbySlot.tag).toBe('Spectator');
        const msg = rejection(test, m, selfSlot(s.lobbyId, 'BluePlayer'));
        expect(member(test, s.lobbyId, m.userId).lobbySlot.tag).toBe('Spectator');
        expect(msg).toBe(TOO_FAST);

        advance(test, 10_000);
        tx(test, m, selfSlot(s.lobbyId, 'BluePlayer'));
        expect(member(test, s.lobbyId, m.userId).lobbySlot.tag).toBe('BluePlayer');
    });

    it('20 join + leave cycles pass (only the 20 joins count), the 21st join is rejected, a new window passes (lobby audit #6, S10e review N8)', () => {
        const test = newHarness();
        const h = guest(test, 'h');
        const lobbyId = createLobby(test, h);
        const g = guest(test, 'g');
        for (let i = 0; i < 20; i++) {
            joinLobby(test, g, lobbyId);
            leave(test, g, lobbyId);
            advance(test, 200);
        }
        expect(test.db.UserRateState.userId.find(g.userId)?.membershipCount).toBe(20);
        const msg = rejection(test, g, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' }));
        expect(member(test, lobbyId, g.userId)).toBeUndefined();
        expect(msg).toBe(TOO_FAST);
        advance(test, 10_000);
        joinLobby(test, g, lobbyId);
        expect(member(test, lobbyId, g.userId)).toBeDefined();
    });

    it('a Leave at a full window is never rejected and consumes nothing, in Waiting (row removed) and in Drafting (away) (S10e review N8)', () => {
        const test = newHarness();
        // Waiting: a spectator fills the window with 20 seat moves, then leaves.
        const w = setupLobby(test, { noStart: true, seats: [['m', 'Spectator']] });
        const m = w.a.m;
        advance(test, 10_000);
        for (let i = 0; i < 20; i++) tx(test, m, selfSlot(w.lobbyId, i % 2 === 0 ? 'BluePlayer' : 'Spectator'));
        leave(test, m, w.lobbyId);
        expect(member(test, w.lobbyId, m.userId)).toBeUndefined();
        expect(test.db.UserRateState.userId.find(m.userId)?.membershipCount).toBe(20);
        expect(rejection(test, m, (ctx) => M.join_lobby(ctx, { lobbyId: w.lobbyId, joinCode: '', password: '' }))).toBe(TOO_FAST);

        // Drafting: a player fills the window with 20 returns (each counted), then leaves once more: away, no rejection.
        const live = newHarness();
        const d = setupLobby(live, { lobby: { disconnectPolicy: { tag: 'NoAction' } } });
        const p = d.a.b2;
        advance(live, 10_000);
        for (let i = 0; i < 20; i++) {
            leave(live, p, d.lobbyId);
            joinLobby(live, p, d.lobbyId); // a return (leftAt cleared), counted
        }
        expect(live.db.UserRateState.userId.find(p.userId)?.membershipCount).toBe(20);
        leave(live, p, d.lobbyId);
        expect(member(live, d.lobbyId, p.userId).leftAt).toBeDefined();
        expect(live.db.UserRateState.userId.find(p.userId)?.membershipCount).toBe(20);
        expect(rejection(live, p, (ctx) => M.join_lobby(ctx, { lobbyId: d.lobbyId, joinCode: '', password: '' }))).toBe(TOO_FAST);
        expect(member(live, d.lobbyId, p.userId).leftAt).toBeDefined();
    });

    it('a plain reconnect (join_lobby on a present row) is not counted: it passes with the window full, which stays full (lobby audit #6)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, seats: [['m', 'Spectator']] });
        const m = s.a.m;
        advance(test, 10_000);
        for (let i = 0; i < 20; i++) tx(test, m, selfSlot(s.lobbyId, i % 2 === 0 ? 'BluePlayer' : 'Spectator'));
        joinLobby(test, m, s.lobbyId); // reconnect: no rejection
        joinLobby(test, m, s.lobbyId);
        expect(member(test, s.lobbyId, m.userId)).toBeDefined();
        expect(rejection(test, m, selfSlot(s.lobbyId, 'BluePlayer'))).toBe(TOO_FAST);
    });

    it('a host moving other members is charged to the host, not to the members moved (lobby audit #6)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, seats: [['a', 'Spectator'], ['b', 'Spectator']] });
        advance(test, 10_000);
        const aSeat = seatOf(test, s.lobbyId, s.a.a.userId);
        const bSeat = seatOf(test, s.lobbyId, s.a.b.userId);
        for (let i = 0; i < 20; i++) tx(test, s.host, moveSlot(s.lobbyId, aSeat, i % 2 === 0 ? 'BluePlayer' : 'Spectator'));
        const msg = rejection(test, s.host, moveSlot(s.lobbyId, bSeat, 'RedPlayer'));
        expect(member(test, s.lobbyId, s.a.b.userId).lobbySlot.tag).toBe('Spectator');
        expect(msg).toBe(TOO_FAST);
        // The moved members' own allowance is untouched.
        tx(test, s.a.a, selfSlot(s.lobbyId, 'RedPlayer'));
        tx(test, s.a.b, selfSlot(s.lobbyId, 'BluePlayer'));
        expect(member(test, s.lobbyId, s.a.a.userId).lobbySlot.tag).toBe('RedPlayer');
        expect(member(test, s.lobbyId, s.a.b.userId).lobbySlot.tag).toBe('BluePlayer');
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
        const s = anonLobby(test, { autoRandomPick: true });
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
// 6. Lobby audit #10: settings ranges
// ════════════════════════════════════════════════════════════════════════════

type BoundCase = [field: string, value: number, error?: string];

const BOUND_CASES: BoundCase[] = [
    ['teamSize', 0, TEAM_SIZE], ['teamSize', 1], ['teamSize', 3], ['teamSize', 4, TEAM_SIZE],
    ['standardTurnSeconds', 9, RANGE('standardTurnSeconds', 10, 600)], ['standardTurnSeconds', 10], ['standardTurnSeconds', 600],
    ['standardTurnSeconds', 601, RANGE('standardTurnSeconds', 10, 600)],
    ['reserveBankSeconds', -1, RANGE('reserveBankSeconds', 0, 1800)], ['reserveBankSeconds', 0], ['reserveBankSeconds', 1800],
    ['reserveBankSeconds', 1801, RANGE('reserveBankSeconds', 0, 1800)],
    ...(['characterBudget', 'lightconeBudget', 'minimumBidRaise'] as const).flatMap((f): BoundCase[] => [
        [f, -1, AMOUNT(f)], [f, 0], [f, 100_000], [f, 100_001, AMOUNT(f)],
        [f, Number.NaN, AMOUNT(f)], [f, Number.POSITIVE_INFINITY, AMOUNT(f)], [f, Number.NEGATIVE_INFINITY, AMOUNT(f)],
    ]),
    ...(['rosterDiffAdvantage', 'underThresholdAdvantage', 'aboveThresholdPenalty', 'deathPenalty'] as const)
        // S10e review N1: negative handicaps (i32 columns) accepted again; the magnitude is bounded both ways.
        .flatMap((f): BoundCase[] => [
            [f, -1_000_001, HANDICAP(f)], [f, -1_000_000], [f, -1], [f, 0], [f, 1_000_000], [f, 1_000_001, HANDICAP(f)],
        ]),
    // rosterThreshold is a roster cost (u32 column, no sign): 0 to 1000000.
    ['rosterThreshold', 0], ['rosterThreshold', 1_000_000], ['rosterThreshold', 1_000_001, THRESHOLD],
];

/** One rejected and one accepted value per setting, for update_lobby_settings and the preset reducers. */
const SAMPLE_REJECTED: BoundCase[] = [
    ['teamSize', 4, TEAM_SIZE],
    ['standardTurnSeconds', 0, RANGE('standardTurnSeconds', 10, 600)],
    ['reserveBankSeconds', 1801, RANGE('reserveBankSeconds', 0, 1800)],
    ['characterBudget', Number.NaN, AMOUNT('characterBudget')],
    ['lightconeBudget', -1, AMOUNT('lightconeBudget')],
    ['minimumBidRaise', Number.POSITIVE_INFINITY, AMOUNT('minimumBidRaise')],
    ['rosterThreshold', 1_000_001, THRESHOLD],
    ['deathPenalty', -1_000_001, HANDICAP('deathPenalty')],
];
const SAMPLE_ACCEPTED = {
    teamSize: 3, standardTurnSeconds: 600, reserveBankSeconds: 0, characterBudget: 100_000, deathPenalty: 1_000_000,
    aboveThresholdPenalty: -500, // S10e review N1
};

describe('lobby audit #10: lobby settings are range-checked', () => {
    it('create_lobby: each bound one below, at and one above (NaN / ±Infinity for the f32 budgets); a rejection writes no lobby (lobby audit #10)', () => {
        const test = newHarness();
        let n = 0;
        for (const [field, value, error] of BOUND_CASES) {
            const g = guest(test, `c-${n++}`);
            if (error) {
                const msg = rejection(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, [field]: value } as any));
                expect([...test.db.Lobby.host_user_id.filter(g.userId)], `${field}=${value}`).toHaveLength(0);
                expect(msg, `${field}=${value}`).toBe(error);
            } else {
                const id = createLobby(test, g, { [field]: value });
                expect((lobbyRow(test, id) as any)[field], `${field}=${value}`).toBe(value);
            }
        }
    });

    it('update_lobby_settings: a sample of each setting rejected with the row unchanged; in-range values stored (lobby audit #10)', () => {
        const test = newHarness();
        const h = guest(test, 'h');
        const id = createLobby(test, h);
        for (const [field, value, error] of SAMPLE_REJECTED) {
            const before = (lobbyRow(test, id) as any)[field];
            const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { [field]: value })));
            expect((lobbyRow(test, id) as any)[field], field).toBe(before);
            expect(msg, field).toBe(error);
        }
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, SAMPLE_ACCEPTED)));
        expect(lobbyRow(test, id)).toMatchObject(SAMPLE_ACCEPTED);
    });

    it('create_lobby_preset and update_lobby_preset: the same samples rejected; in-range values stored (lobby audit #10)', () => {
        const test = newHarness();
        for (const [field, value, error] of SAMPLE_REJECTED) {
            const msg = rejection(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs(`bad-${field}`, { [field]: value })));
            expect(presetNamed(test, `bad-${field}`), field).toBeUndefined();
            expect(msg, field).toBe(error);
        }
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('good', SAMPLE_ACCEPTED)));
        const preset = presetNamed(test, 'good')!;
        expect(preset).toMatchObject(SAMPLE_ACCEPTED);

        for (const [field, value, error] of SAMPLE_REJECTED) {
            const msg = rejection(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(preset.id, 'good', { ...SAMPLE_ACCEPTED, [field]: value })));
            expect(presetNamed(test, 'good'), field).toMatchObject(SAMPLE_ACCEPTED);
            expect(msg, field).toBe(error);
        }
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(preset.id, 'good', { teamSize: 1, standardTurnSeconds: 10 })));
        expect(presetNamed(test, 'good')).toMatchObject({ teamSize: 1, standardTurnSeconds: 10 });
    });

    it('start_draft rejects a team with more players than teamSize after the size was lowered (lobby audit #10)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true }); // 2v2
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { teamSize: 1 })));
        expect(lobbyRow(test, s.lobbyId).teamSize).toBe(1);
        for (const n of ['b1', 'b2', 'r1', 'r2']) tx(test, s.a[n], (ctx) => M.confirm_ready(ctx, { lobbyId: s.lobbyId }));
        const msg = rejection(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
        expect(test.db.MatchSession.lobbyId.find(s.lobbyId)).toBeFalsy();
        expect(msg).toBe('Blue team has 2 players; the team size is 1.');
    });

    it('a tournament lobby still builds and starts its draft (lobby audit #10)', () => {
        const f = duel();
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(lobbyRow(f.test, s.lobbyId).isTournamentControlled).toBe(true);
        expect(session(f.test, s.lobbyId)).toBeTruthy();
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

// ════════════════════════════════════════════════════════════════════════════
// 8. Lobby LOW #24: no switch to Ranked with a guest in the lobby
// ════════════════════════════════════════════════════════════════════════════

describe('lobby audit LOW #24: update_lobby_settings to Ranked with a guest member', () => {
    it('rejected while a guest holds a member row; accepted once the guest left (lobby audit #24, D-23)', () => {
        const test = newHarness();
        const h = verified(test, 'h');
        const id = createLobby(test, h);
        const g = guest(test, 'g');
        joinLobby(test, g, id);
        const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { matchType: { tag: 'Ranked' } })));
        expect(lobbyRow(test, id).matchType.tag).toBe('Casual');
        expect(msg).toBe(RANKED_GUEST);

        leave(test, g, id);
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { matchType: { tag: 'Ranked' } })));
        expect(lobbyRow(test, id).matchType.tag).toBe('Ranked');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Identity audit #1: identity GC never collects server identities or SYSTEM mappings
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit #1: identity GC and the server identities', () => {
    /** A verified user on two devices, both offline; `second` is 10 days newer. */
    function twoDevices(test: Harness, name: string) {
        const first = verified(test, name);
        const second = guest(test, `${name}-2`);
        linkDiscord(test, second, test.db.UserPrivate.userId.find(first.userId)!.providerId, name);
        advance(test, 10 * DAY_MS);
        connect(test, second);
        disconnect(test, first);
        disconnect(test, second);
        return { first, second };
    }
    const has = (test: Harness, identity: any) => !!test.db.UserIdentity.identity.find(identity);

    it('keeps every ServerIdentity identity and every SYSTEM mapping however old; still removes an ordinary stale identity (identity audit #1)', () => {
        const test = newHarness();
        const sys = systemUserId(test);
        const owner = [...test.db.ServerIdentity.iter()].find((r) => r.kind.tag === 'Owner')!.identity;
        // A SYSTEM mapping without a ServerIdentity row, as old as the owner's.
        const extra = freshAuth(test, 'system-extra').identity;
        test.db.UserIdentity.insert({ identity: extra, userId: sys, lastSeenAt: START, ...AUDIT(test) });
        advance(test, DAY_MS);
        const delegate = freshAuth(test, 'delegate').identity;
        tx(test, 'internal', (ctx) => M.server_register_delegate(ctx, { identityHex: delegate.toHexString(), label: 'bootstrap' }));

        const guarded = twoDevices(test, 'guarded'); // its older identity gets a ServerIdentity row
        test.db.ServerIdentity.insert({ identity: guarded.first.identity, kind: { tag: 'Delegate' } as any, label: 'x', registeredAt: test.clock.now() });
        const plain = twoDevices(test, 'plain');

        advance(test, 91 * DAY_MS);
        tx(test, 'internal', (ctx) => M.admin_gc_identities(ctx, {}));

        expect(has(test, owner)).toBe(true);
        expect(has(test, delegate)).toBe(true);
        expect(has(test, extra)).toBe(true);
        expect(identitiesOf(test, sys)).toHaveLength(3);
        expect(has(test, guarded.first.identity)).toBe(true);
        expect(has(test, guarded.second.identity)).toBe(true);
        expect(has(test, plain.first.identity)).toBe(false); // D-07 / D-11 unchanged for an ordinary user
        expect(has(test, plain.second.identity)).toBe(true);
        // The owner still passes the admin gate after the run.
        tx(test, 'internal', (ctx) => M.admin_update_abuse_config(ctx, { guestLobbyBurstThreshold: 51 }));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Identity audit #3: server_link_provider and a taken username
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit #3: a guest upgrade with a provider name another user holds', () => {
    const link = (test: Harness, a: Actor, providerId: string, providerName: string) => (ctx: any) =>
        M.server_link_provider(ctx, { callerIdentityHex: a.identity.toHexString(), provider: 'discord', providerId, providerName });
    const userOf = (test: Harness, a: Actor) => test.db.User.id.find(a.userId)!;

    it('a taken name links with the first free name_2, name_3 ...; the display name is the provider name (identity audit #3)', () => {
        const test = newHarness();
        const bob = verified(test, 'bob');
        expect(userOf(test, bob).username).toBe('bob');
        const g2 = guest(test, 'g2');
        tx(test, 'internal', link(test, g2, 'p-g2', 'bob'));
        expect(userOf(test, g2)).toMatchObject({ username: 'bob_2', displayName: 'bob', isGuest: false });
        const g3 = guest(test, 'g3');
        tx(test, 'internal', link(test, g3, 'p-g3', 'bob'));
        expect(userOf(test, g3).username).toBe('bob_3');
        expect(userOf(test, bob).username).toBe('bob');
    });

    it('the provider name is trimmed and cut to 32; a 32-character collision keeps the result within 32; blank is rejected (identity audit #3)', () => {
        const test = newHarness();
        const long = 'x'.repeat(40);
        const g1 = guest(test, 'g1');
        tx(test, 'internal', link(test, g1, 'p-1', `  ${long}  `));
        expect(userOf(test, g1)).toMatchObject({ username: 'x'.repeat(32), displayName: 'x'.repeat(32) });
        expect(test.db.UserPrivate.userId.find(g1.userId)?.providerUsername).toBe('x'.repeat(32));

        const g2 = guest(test, 'g2');
        tx(test, 'internal', link(test, g2, 'p-2', long));
        expect(userOf(test, g2).username).toBe(`${'x'.repeat(30)}_2`);

        const g3 = guest(test, 'g3');
        const msg = rejection(test, 'internal', link(test, g3, 'p-3', '   '));
        expect(userOf(test, g3).isGuest).toBe(true);
        expect(msg).toBe('providerName is required');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Identity audit #4: admin_delete_row on lobby rows
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit #4: admin_delete_row goes through the lobby removal paths', () => {
    const del = (tableName: string, primaryKeyJson: string) => (ctx: any) => M.admin_delete_row(ctx, { tableName, primaryKeyJson });

    /** A Drafting lobby with a ban, a password, a selected account, a chat line, a session, a result record and a pick. */
    function busyLobby(test: Harness) {
        insertRoster(test, ['c1', 'c2']);
        for (const c of ['c1', 'c2']) insertCharacterCostLadder(test, c, 'Classic', [1, 1, 1, 1, 1, 1, 1]);
        const s = setupLobby(test, {
            beforeStart: (l) => {
                const x = guest(test, 'x');
                joinLobby(test, x, l.lobbyId);
                tx(test, l.host, (ctx) => M.ban_member(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, x.userId) }));
                tx(test, l.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(l.lobbyId, { isPublic: false, password: 'pw' })));
                for (const n of ['b1', 'b2', 'r1', 'r2']) tx(test, l.a[n], (ctx) => M.confirm_ready(ctx, { lobbyId: l.lobbyId }));
                selectAccount(test, l.lobbyId, l.a.b1.userId, 900, { c1: 0 });
            },
        });
        tx(test, s.a.b1, (ctx) => M.send_chat_message(ctx, { lobbyId: s.lobbyId, content: 'gl', metadata: '' }));
        const blueCaptain = captainOf(test, s.lobbyId, 'BluePlayer')!.userId;
        const captain = Object.values(s.a).find((a) => a.userId === blueCaptain)!;
        tx(test, captain, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'c1', eidolon: 0 }));
        return s;
    }

    const lobbyChildren = (test: Harness, lobbyId: number) => {
        const byLobby = (rows: Iterable<any>) => [...rows].filter((r) => r.lobbyId === lobbyId).length;
        return {
            ChatMessage: byLobby(test.db.ChatMessage.iter()),
            LobbyBan: byLobby(test.db.LobbyBan.iter()),
            LobbyMember: byLobby(test.db.LobbyMember.iter()),
            LobbyMemberAccount: byLobby(test.db.LobbyMemberAccount.iter()),
            LobbyPassword: byLobby(test.db.LobbyPassword.iter()),
            MatchLineup: byLobby(test.db.MatchLineup.iter()),
            MatchSession: byLobby(test.db.MatchSession.iter()),
            MatchSessionStep: byLobby(test.db.MatchSessionStep.iter()),
            MatchResultRecord: byLobby(test.db.MatchResultRecord.iter()),
        };
    };
    const resultChildren = (test: Harness, recordIds: number[]) => {
        const byRecord = (rows: Iterable<any>) => [...rows].filter((r) => recordIds.includes(r.matchResultId)).length;
        return {
            MatchResultParticipant: byRecord(test.db.MatchResultParticipant.iter()),
            MatchResultGame: byRecord(test.db.MatchResultGame.iter()),
            MatchResultGroupScore: byRecord(test.db.MatchResultGroupScore.iter()),
            MatchResultAdjustment: byRecord(test.db.MatchResultAdjustment.iter()),
        };
    };

    it('Lobby in Drafting: the D-19 cascade leaves no row in any child table the lobby GC clears (identity audit #4)', () => {
        const test = newHarness();
        const s = busyLobby(test);
        const before = lobbyChildren(test, s.lobbyId);
        for (const table of ['ChatMessage', 'LobbyBan', 'LobbyMember', 'LobbyMemberAccount', 'LobbyPassword', 'MatchSession', 'MatchSessionStep', 'MatchResultRecord'] as const) {
            expect(before[table], `${table} set up`).toBeGreaterThan(0);
        }
        const recordIds = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)].map((r) => r.id);
        expect(resultChildren(test, recordIds).MatchResultParticipant).toBeGreaterThan(0);

        tx(test, 'internal', del('Lobby', String(s.lobbyId)));

        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(Object.values(lobbyChildren(test, s.lobbyId)).every((n) => n === 0), JSON.stringify(lobbyChildren(test, s.lobbyId))).toBe(true);
        expect(Object.values(resultChildren(test, recordIds)).every((n) => n === 0), JSON.stringify(resultChildren(test, recordIds))).toBe(true);
    });

    it('LobbyMember: the removed host\'s flags move (A22(5)), the count drops and the removed player\'s account rows go (identity audit #4)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        selectAccount(test, s.lobbyId, s.a.b2.userId, 900, { c1: 0 });
        const count = lobbyRow(test, s.lobbyId).currentPlayerCount;
        expect(count).toBe(members(test, s.lobbyId).length);

        tx(test, 'internal', del('LobbyMember', JSON.stringify({ lobbyId: s.lobbyId, userId: s.host.userId })));
        expect(member(test, s.lobbyId, s.host.userId)).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count - 1);

        tx(test, 'internal', del('LobbyMember', JSON.stringify({ lobbyId: s.lobbyId, userId: s.a.b2.userId })));
        expect(member(test, s.lobbyId, s.a.b2.userId)).toBeUndefined();
        expect(lmaRows(test, s.lobbyId, s.a.b2.userId)).toHaveLength(0);
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count - 2);
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(members(test, s.lobbyId).length);
    });

    it('Lobby: a tournament lobby is refused and nothing is deleted (S10e review F1, D.8.3)', () => {
        const f = duel();
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        const test = f.test;
        expect(lobbyRow(test, s.lobbyId).isTournamentControlled).toBe(true);
        const before = lobbyChildren(test, s.lobbyId);
        expect(before.MatchResultRecord).toBe(1);
        const msg = rejection(test, 'internal', del('Lobby', String(s.lobbyId)));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeTruthy();
        expect(lobbyChildren(test, s.lobbyId)).toEqual(before);
        expect(msg).toBe(TOURNAMENT_LOBBY);
    });

    it('Lobby: a lobby whose record is Validated, or already processed, is refused and nothing is deleted (S10e review F1, D-56)', () => {
        for (const mark of ['Validated', 'processed'] as const) {
            const test = newHarness();
            const s = setupLobby(test);
            const record = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0];
            test.db.MatchResultRecord.id.update(mark === 'Validated'
                ? { ...record, status: { tag: 'Validated' } as any }
                : { ...record, status: { tag: 'Submitted' } as any, mmrProcessedAt: test.clock.now() });
            const before = lobbyChildren(test, s.lobbyId);
            const msg = rejection(test, 'internal', del('Lobby', String(s.lobbyId)));
            expect(test.db.Lobby.id.find(s.lobbyId), mark).toBeTruthy();
            expect(lobbyChildren(test, s.lobbyId), mark).toEqual(before);
            expect(msg, mark).toBe(RECORD_COUNTED);
        }
    });

    it('LobbyMember: a seated player is refused in Drafting (row kept); a spectator row is still removed (S10e review F4, A68(6))', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const spec = joinAsSpectator(s, 'spec');
        const count = lobbyRow(test, s.lobbyId).currentPlayerCount;
        const key = (userId: number) => JSON.stringify({ lobbyId: s.lobbyId, userId });

        const msg = rejection(test, 'internal', del('LobbyMember', key(s.a.b2.userId)));
        expect(member(test, s.lobbyId, s.a.b2.userId)).toBeDefined();
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count);
        expect(msg).toBe(NO_PLAYER_REMOVAL);

        tx(test, 'internal', del('LobbyMember', key(spec.userId)));
        expect(member(test, s.lobbyId, spec.userId)).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count - 1);
    });

    it('MatchSession / MatchSessionStep: refused while the lobby exists, allowed for orphans (identity audit #4)', () => {
        const test = newHarness();
        const s = busyLobby(test);
        const stepId = steps(test, s.lobbyId)[0].id;
        for (const [table, key] of [['MatchSession', String(s.lobbyId)], ['MatchSessionStep', String(stepId)]] as const) {
            const msg = rejection(test, 'internal', del(table, key));
            expect(test.db.MatchSession.lobbyId.find(s.lobbyId)).toBeTruthy();
            expect(test.db.MatchSessionStep.id.find(stepId)).toBeTruthy();
            expect(msg).toBe(LOBBY_ALIVE(table, s.lobbyId));
        }

        test.db.Lobby.id.delete(s.lobbyId); // an orphaned session and step (raw delete, as before S10e)
        tx(test, 'internal', del('MatchSessionStep', String(stepId)));
        expect(test.db.MatchSessionStep.id.find(stepId)).toBeFalsy();
        tx(test, 'internal', del('MatchSession', String(s.lobbyId)));
        expect(test.db.MatchSession.lobbyId.find(s.lobbyId)).toBeFalsy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Identity audit #5: identity rows and presence
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit #5: an identity goes with its presence row', () => {
    const delIdentity = (hex: string) => (ctx: any) => M.admin_delete_row(ctx, { tableName: 'UserIdentity', primaryKeyJson: hex });

    it('admin_delete_row(\'UserIdentity\'): the mapping and its live presence row go; the user and its other identity stay (identity audit #5)', () => {
        const test = newHarness();
        const desk = verified(test, 'u');
        const phone = guest(test, 'u-phone');
        linkDiscord(test, phone, test.db.UserPrivate.userId.find(desk.userId)!.providerId, 'u');
        expect(phone.userId).toBe(desk.userId);
        connect(test, phone);
        expect(test.db.UserPresence.identity.find(phone.identity)?.isOnline).toBe(true);

        tx(test, 'internal', delIdentity(phone.identity.toHexString()));
        expect(test.db.UserIdentity.identity.find(phone.identity)).toBeFalsy();
        expect(test.db.UserPresence.identity.find(phone.identity)).toBeFalsy();
        expect(test.db.User.id.find(desk.userId)).toBeTruthy();
        expect(test.db.UserIdentity.identity.find(desk.identity)).toBeTruthy();
    });

    it('a malformed key is rejected with its text; an unknown identity is "Row not found" (identity audit #5, #14)', () => {
        const test = newHarness();
        const before = [...test.db.UserIdentity.iter()].length;
        const msg = rejection(test, 'internal', delIdentity('not-a-hex'));
        expect([...test.db.UserIdentity.iter()]).toHaveLength(before);
        expect(msg).toBe(BAD_IDENTITY);
        expect(rejection(test, 'internal', delIdentity(freshAuth(test, 'nobody').identity.toHexString()))).toBe('Row not found');
    });

    it('a guest left with no identity is deleted, and the same browser can log in as a guest again (identity audit #5)', () => {
        const test = newHarness();
        const g = guest(test, 'lonely');
        tx(test, 'internal', delIdentity(g.identity.toHexString()));
        expect(test.db.User.id.find(g.userId)).toBeFalsy();
        expect(test.db.UserPresence.identity.find(g.identity)).toBeFalsy();

        tx(test, g, (ctx) => M.login_as_guest(ctx, {}));
        const again = test.db.UserIdentity.identity.find(g.identity);
        expect(again).toBeTruthy();
        expect(again!.userId).not.toBe(g.userId);
    });

    it('the deleted identity was the user\'s only live one: the Drafting membership goes offline (stamped) and the 15 s check is pending; it moves the captaincy (S10e review F5, A22a)', () => {
        const test = newHarness();
        const b1 = verified(test, 'b1');
        const s = setupLobby(test, { actors: { b1 } });
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(b1.userId);
        expect(member(test, s.lobbyId, b1.userId).isOnline).toBe(true);
        expect(identitiesOf(test, b1.userId)).toHaveLength(1);

        tx(test, 'internal', delIdentity(b1.identity.toHexString()));
        expect(test.db.User.id.find(b1.userId)).toBeTruthy();
        const m = member(test, s.lobbyId, b1.userId);
        expect(m.isOnline).toBe(false);
        expect(m.disconnectedAt?.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch); // Standard policy
        const check = pendingCheck(test, s.lobbyId, b1.userId);
        advance(test, 15_000);
        fireCheck(test, check);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.a.b2.userId);
    });

    it('a user who keeps another live identity stays online; nothing is scheduled (S10e review F5)', () => {
        const test = newHarness();
        const desk = verified(test, 'u');
        const phone = guest(test, 'u-phone');
        linkDiscord(test, phone, test.db.UserPrivate.userId.find(desk.userId)!.providerId, 'u');
        connect(test, phone);
        const s = setupLobby(test, { actors: { b1: desk } });
        tx(test, 'internal', delIdentity(phone.identity.toHexString()));
        expect(member(test, s.lobbyId, desk.userId).isOnline).toBe(true);
        expect([...test.db.RefereeTransferCheck.by_lobby_and_user.filter([s.lobbyId, desk.userId])]).toHaveLength(0);
    });

    it('a server identity mapping and a SYSTEM mapping are refused; both stay (S10e review N9, identity audit #1)', () => {
        const test = newHarness();
        const sys = systemUserId(test);
        const owner = [...test.db.ServerIdentity.iter()].find((r) => r.kind.tag === 'Owner')!.identity;
        const extra = freshAuth(test, 'system-extra').identity; // a SYSTEM mapping without a ServerIdentity row
        test.db.UserIdentity.insert({ identity: extra, userId: sys, lastSeenAt: START, ...AUDIT(test) });
        for (const [identity, text] of [[owner, SERVER_MAPPING], [extra, SYSTEM_MAPPING]] as const) {
            const msg = rejection(test, 'internal', delIdentity(identity.toHexString()));
            expect(test.db.UserIdentity.identity.find(identity)).toBeTruthy();
            expect(msg).toBe(text);
        }
        expect(identitiesOf(test, sys)).toHaveLength(2);
    });

    it('server_revoke_delegate deletes the delegate\'s presence row with its mapping (identity audit #5)', () => {
        const test = newHarness();
        const d = freshAuth(test, 'delegate');
        tx(test, 'internal', (ctx) => M.server_register_delegate(ctx, { identityHex: d.identity.toHexString(), label: 'vercel' }));
        test.withReducerTx(d.auth, (ctx) => M.client_connected(ctx, {}));
        expect(test.db.UserPresence.identity.find(d.identity)?.isOnline).toBe(true);

        tx(test, 'internal', (ctx) => M.server_revoke_delegate(ctx, { identityHex: d.identity.toHexString() }));
        expect(test.db.ServerIdentity.identity.find(d.identity)).toBeFalsy();
        expect(test.db.UserIdentity.identity.find(d.identity)).toBeFalsy();
        expect(test.db.UserPresence.identity.find(d.identity)).toBeFalsy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Identity audit LOW #9 and #14: the SYSTEM user; malformed admin payloads
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit LOW #9: the SYSTEM user cannot be deleted or changed', () => {
    it('admin_delete_row(\'User\'), admin_update_user, server_delete_user and server_set_role reject SYSTEM; the row is unchanged (identity audit #9)', () => {
        const test = newHarness();
        const sys = systemUserId(test);
        const snap = () => {
            const u = test.db.User.id.find(sys)!;
            return `${u.username}|${u.displayName}|${u.role.tag}|${u.deletedAt === undefined}`;
        };
        const before = snap();
        const cases: Array<[(ctx: any) => unknown, string]> = [
            [(ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(sys) }), SYSTEM_DELETE],
            [(ctx) => M.admin_update_user(ctx, { userId: sys, displayName: 'x', username: 'x', roleTag: 'User' }), SYSTEM_CHANGE],
            [(ctx) => M.server_delete_user(ctx, { username: 'SYSTEM' }), SYSTEM_DELETE],
            [(ctx) => M.server_set_role(ctx, { username: 'SYSTEM', roleTag: 'User' }), SYSTEM_CHANGE],
        ];
        for (const [body, text] of cases) {
            const msg = rejection(test, 'internal', body);
            expect(snap()).toBe(before);
            expect(msg).toBe(text);
        }
        expect(before).toBe('SYSTEM|SYSTEM|Admin|true');
        expect([...test.db.UserDeletionJob.iter()]).toHaveLength(0);
        expect(identitiesOf(test, sys)).toHaveLength(1);
        // Another user is still editable.
        const u = guest(test, 'u');
        tx(test, 'internal', (ctx) => M.admin_update_user(ctx, { userId: u.userId, displayName: 'Renamed', username: 'renamed', roleTag: 'User' }));
        expect(test.db.User.id.find(u.userId)?.username).toBe('renamed');
    });
});

describe('identity audit LOW #14: malformed admin keys and payloads get their texts', () => {
    it('admin_delete_row with a malformed JSON key names the table; admin_bulk_upsert answers unparsable and non-array payloads (identity audit #14)', () => {
        const test = newHarness();
        for (const table of ['LobbyMember', 'HsrCharacterCost', 'HsrLightconeCost', 'HsrCharacterArchetype', 'MatchSessionStepHistory']) {
            expect(rejection(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: table, primaryKeyJson: '{bad' })), table).toBe(BAD_JSON(table));
            // S10e review N3: valid JSON that is not an object gets the same text.
            for (const key of ['null', '5', '"x"']) {
                expect(rejection(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: table, primaryKeyJson: key })), `${table} ${key}`).toBe(BAD_JSON(table));
            }
        }
        for (const jsonData of ['not json', '{}', '"x"']) {
            expect(rejection(test, 'internal', (ctx) => M.admin_bulk_upsert(ctx, { tableName: 'HsrCharacter', jsonData })), jsonData).toBe(NOT_ARRAY);
        }
    });
});
