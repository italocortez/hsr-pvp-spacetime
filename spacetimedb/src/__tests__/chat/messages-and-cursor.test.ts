// Chat: message validation, delete permissions, the rolling window, member-event lines and cursor drops.
// Decisions: A74, D-10, D-11, D-12, D-13, D-14, D-26, D-34
// Contracts: docs/chat/contract.md
// From S10 (s10-chat.test.ts).
//
// T-S10 (batch B): in-memory port of test/backend/chat/chat-messages.test.ts and the broadcast_cursor cases of
// test/backend/anonymous-play/anonymous-labels.test.ts (docs/chat/contract.md, D-34). ChatMessage is private (S3), so
// the module-side row is read through `test.db` here; the per-reader rendering through view_my_lobby_chat is s9a's.
// The raw `ChatMessage.anonymousLabel` OR-gate is not ported (A37: the view is the boundary; s9a covers the labels).
// Chat throttle (B-4, D-B5: chatMinIntervalMs 700, chatPerMinute 30): every test advances the TestClock between a
// sender's messages (`say` advances 2.1 s first, i.e. at most 29 sends in any one-minute window); the limits are not
// lowered. LobbyCursorEvent is an event table: it is read through `ctx.db` inside the writing transaction
// (s5-abuse pattern). Kick / ban target a seat (A74). Roles through `test.db` (setUserRole). Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    expectReject,
    guest,
    newHarness,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from '../fixtures/harness';
import { moderator, setUserRole, verified, displayName } from '../fixtures/identity';

const INVALID_METADATA = 'Invalid metadata JSON. Expected: { type: "text" | "reply" | "emoji_only", replyToMessageId?: number }';
const DELETE_DENIED = 'Only the host, referees, moderators, or admins can delete chat messages.';

const rows = (test: Harness, lobbyId: number) => [...test.db.ChatMessage.lobby_id.filter(lobbyId)];
const sortIds = (xs: number[]) => [...xs].sort((a, b) => a - b);
const ids = (test: Harness, lobbyId: number) => sortIds(rows(test, lobbyId).map((r) => r.id));

/** Runs `call` and returns the one ChatMessage row it inserted in the lobby (a diff, not id order: ids are not ordered). */
function inserted(test: Harness, lobbyId: number, call: () => void) {
    const before = new Set(ids(test, lobbyId));
    call();
    const added = rows(test, lobbyId).filter((r) => !before.has(r.id));
    expect(added).toHaveLength(1);
    return added[0];
}

/** send_chat_message after 2.1 s of TestClock (clears the per-message interval and the per-minute cap). */
function say(test: Harness, who: Actor, lobbyId: number, content: string, metadata = ''): number {
    advance(test, 2_100);
    return inserted(test, lobbyId, () => tx(test, who, (ctx) => M.send_chat_message(ctx, { lobbyId, content, metadata }))).id;
}
const sendBody = (lobbyId: number, content: string, metadata = '') =>
    (ctx: any) => M.send_chat_message(ctx, { lobbyId, content, metadata });
const del = (test: Harness, who: Actor, messageId: number) => tx(test, who, (ctx) => M.delete_chat_message(ctx, { messageId }));

/**
 * A Waiting lobby: the host (spectator referee) hands the referee flag to the spectator `ref` (transfer_referee, A74 seat),
 * so the host and the referee are different users; b1 b2 r1 r2 seated, `sp` a plain spectator.
 */
function world(): Lobby & { test: Harness } {
    const test = newHarness();
    const s = setupLobby(test, {
        noStart: true,
        seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['ref', 'Spectator'], ['sp', 'Spectator']],
    });
    tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.ref.userId) }));
    return s;
}

// LobbyCursorEvent rows exist only inside the writing transaction: count them there.
function cursorEvents(test: Harness, who: Actor, lobbyId: number): number {
    return tx(test, who, (ctx) => {
        M.broadcast_cursor(ctx, { lobbyId, x: 0.5, y: 0.5 });
        return [...ctx.db.LobbyCursorEvent.iter()].length;
    });
}

// ─── send_chat_message ───────────────────────────────────────────────────────

describe('send_chat_message validation (docs/chat/contract.md, D-10, D-12, D-14)', () => {
    it('contract edge rows "Empty content string" / "Content 501 chars" / "Content exactly 500 chars": empty and 501 rejected, 500 accepted', () => {
        const s = world();
        const { test, lobbyId } = s;
        const before = ids(test, lobbyId);
        advance(test, 2_100);
        expectReject(test, s.a.b1, sendBody(lobbyId, ''), 'Message cannot be empty.');
        expectReject(test, s.a.b1, sendBody(lobbyId, 'x'.repeat(501)), 'Message exceeds 500 character limit.');
        expect(ids(test, lobbyId)).toEqual(before);
        const id = say(test, s.a.b1, lobbyId, 'y'.repeat(500));
        expect(test.db.ChatMessage.id.find(id)!.content).toHaveLength(500);
    });

    it('contract "Happy Path: Send a Text Message" + "Metadata Defaults When Empty": metadata {"type":"text"}, Player row with the real sender id, Lobby.lastActivityAt bumped', () => {
        const s = world();
        const { test, lobbyId } = s;
        const id = say(test, s.a.b1, lobbyId, 'hello');
        const row = test.db.ChatMessage.id.find(id)!;
        expect(row).toMatchObject({ content: 'hello', metadata: '{"type":"text"}', senderUserId: s.a.b1.userId });
        expect(row.senderType.tag).toBe('Player');
        expect(test.db.Lobby.id.find(lobbyId)!.lastActivityAt).toEqual(test.clock.now());
    });

    it('contract "Happy Path: Send a Reply" / "Send an Emoji-Only Message": reply and emoji_only metadata stored verbatim', () => {
        const s = world();
        const { test, lobbyId } = s;
        const first = say(test, s.a.b1, lobbyId, 'first');
        const replyMeta = `{"type":"reply","replyToMessageId":${first}}`;
        const reply = say(test, s.a.r1, lobbyId, 'I agree', replyMeta);
        const emoji = say(test, s.a.r1, lobbyId, ':thumbsup:', '{"type":"emoji_only"}');
        expect(test.db.ChatMessage.id.find(reply)!.metadata).toBe(replyMeta);
        expect(test.db.ChatMessage.id.find(emoji)!.metadata).toBe('{"type":"emoji_only"}');
    });

    it('contract edge rows "unknown type" / "valid JSON but no type field" / "not valid JSON": rejected with the metadata text; nothing inserted', () => {
        const s = world();
        const { test, lobbyId } = s;
        const before = ids(test, lobbyId);
        advance(test, 2_100);
        for (const metadata of ['{"type":"image"}', '{"replyToMessageId":3}', 'not json {']) {
            expectReject(test, s.a.b1, sendBody(lobbyId, 'hi', metadata), INVALID_METADATA);
        }
        expect(ids(test, lobbyId)).toEqual(before);
    });

    it('contract edge row "Non-member sends message": rejected by ensureLobbyMember ("You are not a member of this lobby.")', () => {
        const s = world();
        const { test, lobbyId } = s;
        const outsider = guest(test, 'outsider');
        const before = ids(test, lobbyId);
        expectReject(test, outsider, sendBody(lobbyId, 'hi'), 'You are not a member of this lobby.');
        expect(ids(test, lobbyId)).toEqual(before);
    });
});

// ─── delete_chat_message ─────────────────────────────────────────────────────

describe('delete_chat_message permissions (D-26)', () => {
    it('contract "Delete Message by Host" / "by Referee" / "by Admin/Moderator": the host, the (non-host) referee, a non-member Moderator and a non-member Admin each delete one message; nothing else changes', () => {
        const s = world();
        const { test, lobbyId } = s;
        const mod = moderator(test);
        const admin = verified(test, 'adm');
        setUserRole(test, admin.userId, 'Admin');
        const m = ['m1', 'm2', 'm3', 'm4'].map((c) => say(test, s.a.b1, lobbyId, c));
        expect([...test.db.LobbyMember.by_lobby_and_user.filter([lobbyId, s.a.ref.userId])][0].isReferee).toBe(true);

        const deleters: Actor[] = [s.host, s.a.ref, mod, admin];
        deleters.forEach((who, i) => {
            const before = ids(test, lobbyId);
            del(test, who, m[i]);
            expect(test.db.ChatMessage.id.find(m[i])).toBeNull();
            expect(ids(test, lobbyId)).toEqual(before.filter((id) => id !== m[i]));
        });
    });

    it('contract edge rows "Regular player tries to delete" / "Delete non-existent message": the exact rejection texts; the message stays', () => {
        const s = world();
        const { test, lobbyId } = s;
        const target = say(test, s.a.b1, lobbyId, 'mine');
        expectReject(test, s.a.r1, (ctx) => M.delete_chat_message(ctx, { messageId: target }), DELETE_DENIED);
        expectReject(test, s.a.b1, (ctx) => M.delete_chat_message(ctx, { messageId: target }), DELETE_DENIED); // no self-delete
        expectReject(test, s.a.sp, (ctx) => M.delete_chat_message(ctx, { messageId: target }), DELETE_DENIED);
        expect(test.db.ChatMessage.id.find(target)).not.toBeNull();
        expectReject(test, s.host, (ctx) => M.delete_chat_message(ctx, { messageId: 99_999 }), 'Message not found.');
    });

    it('contract "Reply to Deleted Message (Dangling Reference)" (D-17): the reply survives with its replyToMessageId', () => {
        const s = world();
        const { test, lobbyId } = s;
        const original = say(test, s.a.b1, lobbyId, 'original');
        const meta = `{"type":"reply","replyToMessageId":${original}}`;
        const reply = say(test, s.a.r1, lobbyId, 'reply', meta);
        del(test, s.host, original);
        expect(test.db.ChatMessage.id.find(original)).toBeNull();
        const kept = test.db.ChatMessage.id.find(reply)!;
        expect(kept.content).toBe('reply');
        expect(kept.metadata).toBe(meta);
    });
});

// ─── rolling window ──────────────────────────────────────────────────────────

describe('rolling window (D-13)', () => {
    it('contract "Rolling Window Enforcement" + edge row "System messages count toward rolling window": never more than 50 rows; the 51st message deletes the oldest', () => {
        const s = world();
        const { test, lobbyId } = s;
        const systemIds = rows(test, lobbyId).filter((r) => r.senderType.tag === 'System').map((r) => r.id);
        expect(systemIds.length).toBeGreaterThan(0); // the join lines

        // 50 player messages push every (older) System row out: the window is then exactly P1..P50.
        const sent: number[] = [];
        for (let i = 1; i <= 50; i++) {
            sent.push(say(test, s.a.b1, lobbyId, `P${i}`));
            expect(rows(test, lobbyId).length).toBeLessThanOrEqual(50);
        }
        expect(ids(test, lobbyId)).toEqual(sortIds(sent));
        for (const id of systemIds) expect(test.db.ChatMessage.id.find(id)).toBeNull();

        // The 51st: P1 (the oldest) goes, the new row is in, still 50.
        const p51 = say(test, s.a.b1, lobbyId, 'P51');
        expect(rows(test, lobbyId)).toHaveLength(50);
        expect(test.db.ChatMessage.id.find(sent[0])).toBeNull();
        expect(ids(test, lobbyId)).toEqual(sortIds([...sent.slice(1), p51]));
    });
});

// ─── System rows ─────────────────────────────────────────────────────────────

describe('System messages for member events (D-11; A74 seats)', () => {
    it('contract "System Message on Leave / Kick / Ban": a Waiting leave, a kick and a ban (by seat) each write a System row with senderUserId 0 and the subject in metadata', () => {
        const s = world();
        const { test, lobbyId } = s;
        const names = { b2: displayName(test, s.a.b2), r2: displayName(test, s.a.r2), r1: displayName(test, s.a.r1) };
        const systemRow = (call: () => void) => {
            const r = inserted(test, lobbyId, call);
            expect(r.senderType.tag).toBe('System');
            expect(r.senderUserId).toBe(0);
            return r;
        };

        const left = systemRow(() => tx(test, s.a.b2, (ctx) => M.leave_lobby(ctx, { lobbyId })));
        expect(left.content).toBe(`${names.b2} left the lobby.`);
        expect(JSON.parse(left.metadata!)).toEqual({ event: 'left', subjectUserId: s.a.b2.userId });

        const kicked = systemRow(() =>
            tx(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, s.a.r2.userId) })));
        expect(kicked.content).toBe(`${names.r2} was kicked from the lobby.`);
        expect(JSON.parse(kicked.metadata!)).toEqual({ event: 'kicked', subjectUserId: s.a.r2.userId });

        const banned = systemRow(() =>
            tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, s.a.r1.userId) })));
        expect(banned.content).toBe(`${names.r1} was banned from the lobby.`);
        expect(JSON.parse(banned.metadata!)).toEqual({ event: 'banned', subjectUserId: s.a.r1.userId });
    });
});

// ─── broadcast_cursor ────────────────────────────────────────────────────────

describe('broadcast_cursor silent drops (D-34)', () => {
    it('D-34: a spectator emits no LobbyCursorEvent and does not throw (a seated player in the same lobby does emit)', () => {
        const s = world();
        const { test, lobbyId } = s;
        expect(cursorEvents(test, s.a.b1, lobbyId)).toBe(1); // control: the call shape emits for a player
        advance(test, 100);
        expect(() => cursorEvents(test, s.a.sp, lobbyId)).not.toThrow();
        advance(test, 100);
        expect(cursorEvents(test, s.a.sp, lobbyId)).toBe(0);
    });

    it('D-34 / contract "membership required": a non-member emits no LobbyCursorEvent and does not throw', () => {
        const s = world();
        const { test, lobbyId } = s;
        const outsider = guest(test, 'outsider');
        expect(() => cursorEvents(test, outsider, lobbyId)).not.toThrow();
        advance(test, 100);
        expect(cursorEvents(test, outsider, lobbyId)).toBe(0);
    });
});
