// Lobby: anonymized members are named by seat (cursor events, member labels, stored chat lines).
// Decisions: A96, A97
// Contracts: docs/lobby/contract.md
// From S10h (s10h-lobby-rulings.test.ts).
import { describe, expect, it } from 'vitest';
import type {
    AnonymousChatRow,
    AnonymousMatchParticipantRow,
    AnonymousMatchStepRow,
    LobbyMemberViewRow,
} from '@bindings/types';
import {
    M,
    advance,
    guest,
    joinAsSpectator,
    lobbyRow,
    member,
    newHarness,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Harness,
} from '../fixtures/harness';
import { captain, playToScoring } from '../fixtures/draft-and-scoring-builders';
import { settingsFrom } from '../fixtures/ranked-game-builders';
import { seatLabel } from '../fixtures/seat-labels';
import { abandon, chat, cursorEvents, join, leave } from '../fixtures/lobby-action-helpers';

function view<T = any>(test: Harness, name: string, who: Actor): T[] {
    return (M as any)[name](test.viewContext(who.auth), {}) as T[];
}
const displayName = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.displayName;

describe('A96: a cursor event names the sender by seat, never by user id', () => {
    for (const [kind, lobby] of [['identified', {}], ['anonymous', { isAnonymousPlayers: true, isAnonymousSpectators: true }]] as const) {
        it(`A96 ${kind} lobby: the event carries senderJoinSeq = the sender's seat and no user id field; spectators and non-members produce no event`, () => {
            const test = newHarness();
            const s = setupLobby(test, { lobby });
            const spec = joinAsSpectator(s, 'spec');
            for (const who of [s.a.b1, s.a.r2]) {
                const events = cursorEvents(test, who, s.lobbyId);
                expect(events, who.sub).toHaveLength(1);
                expect(Object.keys(events[0]).sort()).toEqual(['lobbyId', 'senderJoinSeq', 'timestamp', 'x', 'y']);
                expect(events[0].senderJoinSeq).toBe(seatOf(test, s.lobbyId, who.userId));
                expect(events[0].lobbyId).toBe(s.lobbyId);
                expect(Object.keys(events[0]).filter((k) => /user|label/i.test(k))).toEqual([]);
            }
            const outsider = guest(test, 'outsider');
            for (const who of [spec, s.host, outsider]) {
                expect(cursorEvents(test, who, s.lobbyId), who.sub).toEqual([]);
            }
        });
    }

    it('A96 / A98: an away member\'s cursor call produces no event and no error; back through join_lobby it emits again with the same seat; an abandoned member\'s produces none', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const seat = seatOf(test, s.lobbyId, s.a.b1.userId);
        leave(test, s.a.b1, s.lobbyId);
        expect(cursorEvents(test, s.a.b1, s.lobbyId)).toEqual([]);
        join(test, s.a.b1, s.lobbyId);
        expect(cursorEvents(test, s.a.b1, s.lobbyId).map((e) => e.senderJoinSeq)).toEqual([seat]);

        leave(test, s.a.b2, s.lobbyId);
        abandon(test, s.a.b2);
        expect(member(test, s.lobbyId, s.a.b2.userId).abandonedAt).toBeDefined();
        expect(cursorEvents(test, s.a.b2, s.lobbyId)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. A97: anonymous labels from the seat number
// ════════════════════════════════════════════════════════════════════════════

const FULL_ANON = { isAnonymousPlayers: true, isAnonymousSpectators: true };
const SEAT_LABEL = /^(?:(?:Blue|Red) (?:Player|Coach)|Spectator) #(\d+)$/;
const labelsBySeat = (test: Harness, reader: Actor) =>
    new Map(view<LobbyMemberViewRow>(test, 'view_my_lobby_members', reader).map((r) => [r.joinSeq, r.label]));

describe('A97: an anonymized member\'s label is "<seat kind> #<joinSeq>"', () => {
    it('A97 every seat kind: "Blue Player #n", "Red Player #n", "Blue Coach #n", "Red Coach #n", "Spectator #n"', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            lobby: FULL_ANON,
            noStart: true,
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['bc', 'BlueCoach'], ['rc', 'RedCoach'], ['s1', 'Spectator']],
        });
        const seat = (who: Actor) => seatOf(test, s.lobbyId, who.userId);
        expect([s.host, s.a.b1, s.a.r1, s.a.bc, s.a.rc, s.a.s1].map(seat)).toEqual([1, 2, 3, 4, 5, 6]);

        const fromRed = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.r1);
        const fromBlue = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.b1);
        const at = (rows: LobbyMemberViewRow[], n: number) => rows.find((r) => r.joinSeq === n)!;
        expect(at(fromRed, 2)).toMatchObject({ userId: 0, label: 'Blue Player #2' });
        expect(at(fromRed, 4)).toMatchObject({ userId: 0, label: 'Blue Coach #4' });
        expect(at(fromRed, 6)).toMatchObject({ userId: 0, label: 'Spectator #6' });
        expect(at(fromRed, 1)).toMatchObject({ userId: 0, label: 'Spectator #1' }); // the spectator host
        expect(at(fromBlue, 3)).toMatchObject({ userId: 0, label: 'Red Player #3' });
        expect(at(fromBlue, 5)).toMatchObject({ userId: 0, label: 'Red Coach #5' });
    });

    it('A97 a member\'s label does not change when an earlier peer changes seat or leaves', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: FULL_ANON, noStart: true, seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['s1', 'Spectator'], ['s2', 'Spectator']] });
        const b1Seat = seatOf(test, s.lobbyId, s.a.b1.userId);
        const before = labelsBySeat(test, s.a.r1);
        expect(before.get(seatOf(test, s.lobbyId, s.a.b2.userId))).toBe(`Blue Player #${seatOf(test, s.lobbyId, s.a.b2.userId)}`);

        // the earlier Blue player and the earlier spectator change seat kind
        tx(test, s.a.b1, (ctx) => M.unconfirm_ready(ctx, { lobbyId: s.lobbyId }));
        tx(test, s.a.b1, (ctx) => M.set_team_slot(ctx, { lobbyId: s.lobbyId, lobbySlot: { tag: 'Spectator' } as any }));
        tx(test, s.host, (ctx) => M.set_team_slot(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.s1.userId), lobbySlot: { tag: 'BlueCoach' } as any }));
        const moved = labelsBySeat(test, s.a.r1);
        const s1Seat = seatOf(test, s.lobbyId, s.a.s1.userId);
        expect(moved.get(b1Seat)).toBe(`Spectator #${b1Seat}`); // its own label follows its own seat kind
        expect(moved.get(s1Seat)).toBe(`Blue Coach #${s1Seat}`);
        for (const [joinSeq, label] of before) {
            if (joinSeq === b1Seat || joinSeq === s1Seat) continue;
            expect(moved.get(joinSeq), `seat ${joinSeq} after the moves`).toBe(label);
        }

        // the earlier peers leave (Waiting: the rows are deleted, A68(5))
        leave(test, s.a.b1, s.lobbyId);
        leave(test, s.a.s1, s.lobbyId);
        const after = labelsBySeat(test, s.a.r1);
        expect(after.has(b1Seat)).toBe(false);
        for (const [joinSeq, label] of before) {
            if (joinSeq === b1Seat || joinSeq === s1Seat) continue;
            expect(after.get(joinSeq), `seat ${joinSeq} after the departures`).toBe(label);
        }
    });

    it('A97 a chat line stored before its sender left keeps that sender\'s label after they are gone; no remaining member inherits it', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: FULL_ANON, noStart: true });
        const b1Label = seatLabel(test, s.lobbyId, s.a.b1.userId);
        chat(test, s.a.b1, s.lobbyId, 'from b1');
        const stored = [...test.db.ChatMessage.lobby_id.filter(s.lobbyId)].find((m) => m.content === 'from b1')!;
        expect(stored.anonymousLabel).toBe(b1Label);

        leave(test, s.a.b1, s.lobbyId); // Waiting: the row is deleted
        expect(member(test, s.lobbyId, s.a.b1.userId)).toBeUndefined();
        const late = guest(test, 'late');
        join(test, late, s.lobbyId);
        tx(test, late, (ctx) => M.set_team_slot(ctx, { lobbyId: s.lobbyId, lobbySlot: { tag: 'BluePlayer' } as any }));
        const lateLabel = seatLabel(test, s.lobbyId, late.userId);
        expect(lateLabel).not.toBe(b1Label);

        for (const reader of [s.a.r1, late]) {
            const row = view<AnonymousChatRow>(test, 'view_my_lobby_chat', reader).find((c) => c.content === 'from b1')!;
            expect(row.senderUserId, reader.sub).toBe(0);
            expect(row.anonymousLabel, reader.sub).toBe(b1Label);
        }
        const labels = [...labelsBySeat(test, s.a.r1).values()];
        expect(labels).not.toContain(b1Label);
    });

    /** A fully anonymous Classic lobby played to Scoring, a chat line from each Blue player and a spectator who joined late. */
    function anonScoring() {
        const test = newHarness();
        const s = playToScoring(test, { lobby: FULL_ANON });
        chat(test, s.a.b1, s.lobbyId, 'b1 here');
        chat(test, s.a.b2, s.lobbyId, 'b2 here');
        const spec = joinAsSpectator(s, 'spec');
        chat(test, spec, s.lobbyId, 'spec here');
        return { test, s, spec };
    }

    it('A97 / A37: in an anonymous lobby no view row of an opponent carries a user id or display name of an anonymized member (members, chat, steps, participants, member-event lines); every label is a seat label', () => {
        const { test, s, spec } = anonScoring();
        const hidden = [s.a.b1, s.a.b2, s.host, spec];
        const hiddenIds = new Set(hidden.map((h) => h.userId));
        const hiddenNames = hidden.map((h) => displayName(test, h));
        const seats = new Set([...test.db.LobbyMember.lobby_id.filter(s.lobbyId)].map((m) => m.joinSeq));
        const reader = s.a.r1;

        const problems: string[] = [];
        const walk = (where: string, v: unknown, key = '') => {
            if (typeof v === 'number' && /userid$|byid$/i.test(key) && hiddenIds.has(v)) problems.push(`${where}.${key} = hidden id ${v}`);
            if (typeof v === 'string') {
                for (const n of hiddenNames) if (v.includes(n)) problems.push(`${where}.${key} names ${n}`);
                if (/label$/i.test(key) && v !== '' && !SEAT_LABEL.test(v) && !v.includes(displayName(test, s.a.r2)) && !v.includes(displayName(test, reader))) {
                    problems.push(`${where}.${key} = "${v}" is not a seat label`);
                }
                // a seat label's number is a seat of this lobby (labels come from joinSeq, never from an id; nobody left)
                const m = /label$/i.test(key) ? SEAT_LABEL.exec(v) : null;
                if (m && !seats.has(Number(m[1]))) problems.push(`${where}.${key} = "${v}" names no seat`);
                if (key === 'metadata' && v.startsWith('{')) {
                    try { walk(`${where}.metadata`, JSON.parse(v)); } catch { /* not JSON */ }
                }
            }
            if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(where, x, k);
        };
        for (const name of ['view_my_lobby_members', 'view_my_lobby_chat', 'view_my_match_steps', 'view_my_match_participants', 'view_my_lobby']) {
            const rows = view(test, name, reader);
            expect(rows.length, name).toBeGreaterThan(0);
            rows.forEach((r, i) => walk(`${name}[${i}]`, r));
        }
        expect(problems).toEqual([]);
    });

    it('A97 the same member carries the same label in every view: members, chat, steps, participants; the member-event line carries the same seat number with the seat kind it was written under (review F6)', () => {
        const { test, s } = anonScoring();
        const reader = s.a.r1;
        const subject = captain(s, 'Blue'); // the Blue captain picked, so it has step rows
        const label = seatLabel(test, s.lobbyId, subject.userId);
        expect(label).toMatch(SEAT_LABEL);

        const memberRow = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', reader).find((r) => r.joinSeq === seatOf(test, s.lobbyId, subject.userId))!;
        expect(memberRow.label).toBe(label);

        const chatRows = view<AnonymousChatRow>(test, 'view_my_lobby_chat', reader);
        const own = subject === s.a.b1 ? 'b1 here' : 'b2 here';
        expect(chatRows.find((c) => c.content === own)!.anonymousLabel).toBe(label);
        // S10h review F6: the joined line keeps the label stored when it was written (the member joined as a spectator
        // and then took a player seat): the same seat number, the seat kind of that moment
        const joinedAs = `Spectator #${seatOf(test, s.lobbyId, subject.userId)}`;
        expect(chatRows.find((c) => c.content === `${joinedAs} joined the lobby.`), 'joined line').toBeDefined();

        const stepIds = new Set([...test.db.MatchSessionStep.lobby_id.filter(s.lobbyId)].filter((st) => st.actorUserId === subject.userId).map((st) => st.id));
        expect(stepIds.size).toBeGreaterThan(0);
        const stepRows = view<AnonymousMatchStepRow>(test, 'view_my_match_steps', reader).filter((r) => stepIds.has(r.id));
        expect(stepRows).toHaveLength(stepIds.size);
        for (const r of stepRows) expect(r.anonymousLabel).toBe(label);

        const blueParticipants = view<AnonymousMatchParticipantRow>(test, 'view_my_match_participants', reader).filter((r) => r.teamSide.tag === 'Blue');
        expect(blueParticipants.map((r) => r.anonymousLabel).sort())
            .toEqual([s.a.b1, s.a.b2].map((w) => seatLabel(test, s.lobbyId, w.userId)).sort());
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. S10h review fixes (F5 to F9) and the guest username (fix pass)
// ════════════════════════════════════════════════════════════════════════════

const isEvent = (event: string) => (m: { metadata?: string }) => {
    try { return JSON.parse(m.metadata ?? '').event === event; } catch { return false; }
};

describe('review F6 / F7 (A97): a stored chat line keeps the label of the membership it was written under', () => {
    it('review F6: a member who left and rejoined: old lines (chat, the "left" line) keep the old label, new lines (chat, the "joined" line) carry the new one', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: FULL_ANON, noStart: true });
        const L = s.lobbyId;
        const x = s.a.b1;
        const oldLabel = seatLabel(test, L, x.userId);
        chat(test, x, L, 'first membership');
        advance(test, 3_000);
        leave(test, x, L); // Waiting: the row is deleted (A68(5))
        advance(test, 3_000);
        join(test, x, L); // a new seat (A74: never reused)
        const newLabel = seatLabel(test, L, x.userId);
        expect(newLabel).not.toBe(oldLabel);
        advance(test, 3_000);
        chat(test, x, L, 'second membership');

        const rows = view<AnonymousChatRow>(test, 'view_my_lobby_chat', s.a.r1);
        expect(rows.find((c) => c.content === 'first membership')).toMatchObject({ senderUserId: 0, anonymousLabel: oldLabel });
        expect(rows.find((c) => c.content === 'second membership')).toMatchObject({ senderUserId: 0, anonymousLabel: newLabel });
        expect(rows.some((c) => c.content === `${oldLabel} left the lobby.`), 'left line').toBe(true);
        expect(rows.some((c) => c.content === `${newLabel} joined the lobby.`), 'joined line').toBe(true);
        expect(rows.some((c) => c.content === `${newLabel} left the lobby.`), 'no relabelled left line').toBe(false);
    });

    it('review F7: a member-event line written in an identified lobby stores the subject\'s seat label; after the lobby turns anonymous in Waiting an opponent reads that label, not "A player"', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const L = s.lobbyId;
        expect(lobbyRow(test, L).isAnonymousPlayers).toBe(false);
        const b2Label = seatLabel(test, L, s.a.b2.userId);
        tx(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, s.a.b2.userId) }));
        const raw = [...test.db.ChatMessage.lobby_id.filter(L)].find(isEvent('kicked'))!;
        expect(raw.anonymousLabel).toBe(b2Label);

        const anon = settingsFrom(test, L, { isAnonymousPlayers: true, isAnonymousSpectators: true }); // read outside the tx
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, anon));
        expect(lobbyRow(test, L).isAnonymousPlayers).toBe(true);
        const row = view<AnonymousChatRow>(test, 'view_my_lobby_chat', s.a.r1).find((c) => c.id === raw.id)!;
        expect(row.content).toBe(`${b2Label} was kicked from the lobby.`);
        expect(JSON.parse(row.metadata!)).toEqual({ event: 'kicked', subjectUserId: 0 });
    });
});
