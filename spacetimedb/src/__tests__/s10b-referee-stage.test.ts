// T-S10b-A80: start_draft and advance_stage are referee powers (DECISIONS.md A80). The caller holds the lobby's
// referee flag or is a Moderator / Admin; the host as such no longer qualifies; no lobby setting gates it.
// In-memory datastore on the TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    M,
    expectReject,
    guest,
    joinAsSpectator,
    lobbyRow,
    newHarness,
    refereeIds,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Lobby,
} from './s4-fixtures';
import { captain, setRole } from './s7-fixtures';

const REFEREE_OR_ABOVE = 'Only the referee, moderators, or admins can perform this action.';
const SEATS: Array<[string, 'BluePlayer' | 'BlueCoach' | 'RedPlayer']> = [
    ['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'],
];

type Stage = 'Waiting' | 'Drafting' | 'Equipping';

/** A lobby in `stage`: the host is a spectator referee; b1 / b2 Blue, bc the Blue coach, r1 / r2 Red, `watch` a plain spectator. */
function lobbyAt(stage: Stage): Lobby {
    const test = newHarness();
    const s = setupLobby(test, { seats: SEATS, noStart: stage === 'Waiting' });
    joinAsSpectator(s, 'watch');
    if (stage === 'Equipping') tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
    expect(lobbyRow(test, s.lobbyId).stage.tag).toBe(stage);
    expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
    return s;
}

const transferTo = (s: Lobby, from: Actor, to: Actor) =>
    tx(s.test, from, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, to.userId) }));

const sessionRow = (s: Lobby) => s.test.db.MatchSession.lobbyId.find(s.lobbyId);
const snapshot = (s: Lobby) => ({ stage: lobbyRow(s.test, s.lobbyId).stage.tag, session: sessionRow(s) });

/** One reducer under test, with the stage it starts from and the stage it reaches. */
interface Case {
    name: string;
    from: Stage;
    to: string;
    call: (s: Lobby, who: Actor) => void;
    reject: (s: Lobby, who: Actor) => void;
}

const startDraft: Case = {
    name: 'start_draft',
    from: 'Waiting',
    to: 'Drafting',
    call: (s, who) => tx(s.test, who, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId })),
    reject: (s, who) => expectReject(s.test, who, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }), REFEREE_OR_ABOVE),
};
const advance = (from: 'Drafting' | 'Equipping', to: string): Case => ({
    name: `advance_stage ${from} → ${to}`,
    from,
    to,
    call: (s, who) => tx(s.test, who, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId })),
    reject: (s, who) => expectReject(s.test, who, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }), REFEREE_OR_ABOVE),
});

const CASES: Case[] = [startDraft, advance('Drafting', 'Equipping'), advance('Equipping', 'Scoring')];

function expectAdvanced(s: Lobby, c: Case) {
    expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe(c.to);
    if (c.to === 'Drafting') expect(sessionRow(s)).toBeTruthy();
}

for (const c of CASES) {
    describe(`${c.name} is a referee power (A80)`, () => {
        it('(a) the host who holds the referee flag succeeds (A80(1))', () => {
            const s = lobbyAt(c.from);
            c.call(s, s.host);
            expectAdvanced(s, c);
        });

        it('(b) after the flag moves to a player, that referee succeeds and the host is rejected with state unchanged (A80(1))', () => {
            const s = lobbyAt(c.from);
            transferTo(s, s.host, s.a.r1);
            expect(refereeIds(s.test, s.lobbyId)).toEqual([s.a.r1.userId]);
            const before = snapshot(s);
            c.reject(s, s.host);
            expect(snapshot(s)).toEqual(before);
            if (c.from === 'Waiting') expect(sessionRow(s)).toBeNull();
            c.call(s, s.a.r1);
            expectAdvanced(s, c);
        });

        it('(c) a plain player, a captain, a coach and a plain spectator are rejected; state unchanged (A80(1))', () => {
            const s = lobbyAt(c.from);
            if (c.from === 'Waiting') {
                // Captains are drawn at start_draft; in Waiting the host names b1 the Blue captain (set_captain).
                tx(s.test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
            }
            const cap = captain(s, 'Blue');
            const plain = cap.userId === s.a.b1.userId ? s.a.b2 : s.a.b1;
            const before = snapshot(s);
            const callers = [plain, cap, s.a.bc, s.a.watch];
            if (c.from !== 'Waiting') callers.push(captain(s, 'Red'));
            for (const who of callers) {
                c.reject(s, who);
            }
            expect(snapshot(s)).toEqual(before);
        });

        it('(d) a Moderator and an Admin who hold no flag succeed (A80(1))', () => {
            for (const role of ['Moderator', 'Admin'] as const) {
                const s = lobbyAt(c.from);
                const staff = guest(s.test, `staff-${role}`);
                setRole(s.test, staff.userId, role);
                c.call(s, staff);
                expectAdvanced(s, c);
            }
        });

        it('(e) a host who gave the flag away takes it back with reclaim_referee and then succeeds (A80(1))', () => {
            const s = lobbyAt(c.from);
            transferTo(s, s.host, s.a.b2);
            c.reject(s, s.host);
            tx(s.test, s.host, (ctx) => M.reclaim_referee(ctx, { lobbyId: s.lobbyId }));
            expect(refereeIds(s.test, s.lobbyId)).toEqual([s.host.userId]);
            c.call(s, s.host);
            expectAdvanced(s, c);
        });

        it('(f) a spectator referee who is not the host succeeds (A80(1))', () => {
            const s = lobbyAt(c.from);
            transferTo(s, s.host, s.a.watch);
            expect(lobbyRow(s.test, s.lobbyId).hostUserId).toBe(s.host.userId);
            c.call(s, s.a.watch);
            expectAdvanced(s, c);
        });
    });
}
