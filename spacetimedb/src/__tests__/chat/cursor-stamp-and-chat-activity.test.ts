// Chat: the cursor throttle stamp off the member row and in the live stages only; chat stamps the lobby's activity at
// most once a minute.
// Decisions: A43 (B-4 cursor throttle), D-34, A96
// Contracts: docs/lobby/contract.md (Cursor Throttle), docs/chat/contract.md
// From S11a.
//
// T-S11a (triage L19): broadcast_cursor drops a call outside Drafting / Equipping / Scoring, and keeps its throttle
// stamp in the private LobbyCursorStamp table, so an accepted cursor does not rewrite the LobbyMember row the lobby views
// read. The stamp goes with the member (removeMemberRow) and with the lobby (hardDeleteLobby).
// T-S11a (triage L18): send_chat_message rewrites Lobby.lastActivityAt only when the stored stamp is at least 60 s old.
import { describe, expect, it } from 'vitest';
import { M, advance, member, newHarness, setupLobby, snap, tx, type Harness } from '../fixtures/harness';
import { chat, cursorEvents, leave } from '../fixtures/lobby';
import { hardDeleteLobby } from '@module/reducers/lobby/lobbyGc';

const stampsOf = (test: Harness, lobbyId: number) => [...test.db.LobbyCursorStamp.lobby_id.filter(lobbyId)];

describe('L19: broadcast_cursor in the live stages only, stamp off the member row', () => {
    it('Waiting and AwaitingResult: no event, no stamp, no error; Drafting: the event and one stamp', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        expect(cursorEvents(test, s.a.b1, s.lobbyId)).toHaveLength(0);
        expect(stampsOf(test, s.lobbyId)).toHaveLength(0);

        tx(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        advance(test, 100);
        expect(cursorEvents(test, s.a.b1, s.lobbyId)).toHaveLength(1);
        expect(stampsOf(test, s.lobbyId).map((r) => r.userId)).toEqual([s.a.b1.userId]);

        // AwaitingResult (stage written directly: only the stage matters to the guard)
        const lobby = test.db.Lobby.id.find(s.lobbyId)!;
        test.db.Lobby.id.update({ ...lobby, stage: { tag: 'AwaitingResult' } as any });
        advance(test, 100);
        expect(cursorEvents(test, s.a.b2, s.lobbyId)).toHaveLength(0);
        expect(stampsOf(test, s.lobbyId).map((r) => r.userId)).toEqual([s.a.b1.userId]);
    });

    it('an accepted cursor leaves the LobbyMember row unchanged; the stamp carries the time and throttles the next call', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const before = snap(member(test, s.lobbyId, s.a.b1.userId));
        expect(cursorEvents(test, s.a.b1, s.lobbyId)).toHaveLength(1);
        const first = stampsOf(test, s.lobbyId)[0];
        expect(first.lastCursorAt).toEqual(test.clock.now());
        expect(first).toMatchObject({ createdById: s.a.b1.userId, lastModifiedById: s.a.b1.userId });
        advance(test, 20);
        expect(cursorEvents(test, s.a.b1, s.lobbyId)).toHaveLength(0); // inside 50 ms
        advance(test, 60);
        expect(cursorEvents(test, s.a.b1, s.lobbyId)).toHaveLength(1);
        const second = stampsOf(test, s.lobbyId);
        expect(second).toHaveLength(1);
        expect(second[0].lastCursorAt).toEqual(test.clock.now());
        expect(second[0].createdDate).toEqual(first.createdDate); // a later stamp is not an audit bump
        expect(snap(member(test, s.lobbyId, s.a.b1.userId))).toBe(before);
    });

    it('the stamp goes with the member (a coach leaving a live lobby) and with the lobby (hardDeleteLobby)', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['bc', 'BlueCoach']] });
        expect(cursorEvents(test, s.a.bc, s.lobbyId)).toHaveLength(1); // coaches broadcast (D-34)
        expect(cursorEvents(test, s.a.r1, s.lobbyId)).toHaveLength(1);
        expect(stampsOf(test, s.lobbyId)).toHaveLength(2);

        leave(test, s.a.bc, s.lobbyId);
        expect(member(test, s.lobbyId, s.a.bc.userId)).toBeUndefined();
        expect(stampsOf(test, s.lobbyId).map((r) => r.userId)).toEqual([s.a.r1.userId]);

        tx(test, 'internal', (ctx) => hardDeleteLobby(ctx, s.lobbyId));
        expect(stampsOf(test, s.lobbyId)).toHaveLength(0);
        expect([...test.db.LobbyCursorStamp.iter()]).toHaveLength(0);
    });
});

describe('L18: a chat message stamps Lobby.lastActivityAt at most once a minute', () => {
    it('messages inside a minute of the stamp leave the Lobby row as it is; one a minute later stamps it', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        advance(test, 60_000);
        chat(test, s.a.b1, s.lobbyId, 'first');
        const stamped = test.db.Lobby.id.find(s.lobbyId)!;
        expect(stamped.lastActivityAt).toEqual(test.clock.now());

        const rowAfterFirst = snap(stamped);
        advance(test, 2_100);
        chat(test, s.a.r1, s.lobbyId, 'second');
        advance(test, 30_000);
        chat(test, s.a.b1, s.lobbyId, 'third');
        expect(snap(test.db.Lobby.id.find(s.lobbyId)!)).toBe(rowAfterFirst); // no rewrite of the Lobby row
        expect([...test.db.ChatMessage.lobby_id.filter(s.lobbyId)].filter((m) => m.senderType.tag === 'Player')).toHaveLength(3);

        advance(test, 28_000); // 60.1 s after the stamp
        chat(test, s.a.r1, s.lobbyId, 'fourth');
        expect(test.db.Lobby.id.find(s.lobbyId)!.lastActivityAt).toEqual(test.clock.now());
    });
});
