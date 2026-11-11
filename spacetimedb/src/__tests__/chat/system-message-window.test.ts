// Chat: System lines (member events, start lines) stay inside the message window and drop the oldest line by time.
// Decisions: A122, D-13
// Contracts: docs/chat/contract.md
// From S10e, S10r (s10e-lobby-identity.test.ts, s10r-triage-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
    M,
    advance,
    guest,
    lobbyRow,
    newHarness,
    setupLobby,
    tx,
    type Harness,
} from '../fixtures/harness';
import { joinLobby } from '../fixtures/preset-and-account-builders';
import { leave } from '../fixtures/lobby-member-helpers';
import { completeDraft } from '../fixtures/draft-and-scoring-builders';
import { liveField } from '../fixtures/tournament-builders';
import {
    byKey,
    deferredDuel,
    offlinePastGrace,
    openMatchLobby,
} from '../fixtures/tournament-match-builders';
import { AUDIT0 } from '../fixtures/admin-and-turn-helpers';

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

const chatRows = (test: Harness, lobbyId: number) => [...test.db.ChatMessage.lobby_id.filter(lobbyId)];

/**
 * Fills the lobby's chat to 50 rows with direct inserts whose createdDate runs against the id: the first row inserted
 * (lowest id of the batch) is the newest, the last one (highest id) the oldest, older than everything already there.
 * Returns the id of the oldest row by time.
 */
function fillChatTo50(test: Harness, lobbyId: number): number {
    const have = chatRows(test, lobbyId).length;
    const count = 50 - have;
    const base = test.clock.now().microsSinceUnixEpoch;
    let oldestId = -1;
    for (let i = 0; i < count; i++) {
        const ts = new Timestamp(base - BigInt((i + 1) * 1_000_000) - 3_600_000_000n);
        const row = test.db.ChatMessage.insert({
            id: 0, lobbyId, senderUserId: 0, senderType: { tag: 'System' } as any, content: `filler ${i}`,
            metadata: undefined, anonymousLabel: undefined, ...AUDIT0(ts),
        } as any);
        oldestId = row.id;
    }
    return oldestId;
}

// ════════════════════════════════════════════════════════════════════════════
// L16: system chat lines go through the shared 50-message trim
// ════════════════════════════════════════════════════════════════════════════

describe('A122(3), L16: every system chat line keeps the 50-message window and drops the oldest message by time', () => {
    it('A122(3) L16: a concede line in a full chat removes the oldest row by createdDate (not the lowest id); the lobby stays at 50', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        const { test } = f;
        const lowestId = Math.min(...chatRows(test, s.lobbyId).map((r) => r.id));
        const oldestByTime = fillChatTo50(test, s.lobbyId);
        expect(oldestByTime).toBeGreaterThan(lowestId);
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const rows = chatRows(test, s.lobbyId);
        expect(rows).toHaveLength(50);
        expect(rows.some((r) => r.id === oldestByTime)).toBe(false);
        expect(rows.some((r) => r.id === lowestId)).toBe(true);
        expect(rows.some((r) => r.content.startsWith('Match conceded.'))).toBe(true);
    });

    it('A122(3) L16: the defer line trims the same way', () => {
        const { f, s } = deferredDuel();
        const { test } = f;
        offlinePastGrace(test, s.a.b2);
        const lowestId = Math.min(...chatRows(test, s.lobbyId).map((r) => r.id));
        const oldestByTime = fillChatTo50(test, s.lobbyId);
        tx(test, f.org, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }));
        const rows = chatRows(test, s.lobbyId);
        expect(rows).toHaveLength(50);
        expect(rows.some((r) => r.id === oldestByTime)).toBe(false);
        expect(rows.some((r) => r.id === lowestId)).toBe(true);
        expect(rows.some((r) => r.content === 'Match deferred to admin/TO resolution.')).toBe(true);
    });

    it('A122(3) L16: the stage-change line of advance_stage (Equipping → Scoring) trims the same way', () => {
        const test = newHarness();
        const s = setupLobby(test);
        completeDraft(s);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        const lowestId = Math.min(...chatRows(test, s.lobbyId).map((r) => r.id));
        const oldestByTime = fillChatTo50(test, s.lobbyId);
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        const rows = chatRows(test, s.lobbyId);
        expect(rows).toHaveLength(50);
        expect(rows.some((r) => r.id === oldestByTime)).toBe(false);
        expect(rows.some((r) => r.id === lowestId)).toBe(true);
        expect(rows.some((r) => r.content === 'Lineups set. Stage: Scoring')).toBe(true);
    });

    it('A122(3) L16: below the window a system line deletes nothing', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        const { test } = f;
        const before = chatRows(test, s.lobbyId).map((r) => r.id);
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        const after = chatRows(test, s.lobbyId).map((r) => r.id);
        expect(after).toHaveLength(before.length + 1);
        expect(before.every((id) => after.includes(id))).toBe(true);
    });
});
