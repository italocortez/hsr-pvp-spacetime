// T-S4(a): the referee-transfer and auto-pause tests moved from the lobby-rules prototype
// (notes/migration/prototypes/lobby-rules/lobbyRules.test.ts). The allowedSlots tests stay with S8.
import { describe, expect, it } from 'vitest';
import {
    decideAutoPause,
    decideRefereeTransfer,
    type MemberLite,
    pickRefereeSuccessor,
    pickSuccessor,
} from './refereeTransfer';

// T-S8f (A68(2)(4)): MemberLite.voluntarilyLeft is now hasLeft (the row carries leftAt or abandonedAt).
const m = (
    userId: number,
    slot: MemberLite['slot'],
    joinOrder: number,
    over: Partial<MemberLite> = {},
): MemberLite => ({
    userId,
    slot,
    joinOrder,
    isOnline: true,
    hasLeft: false,
    isReferee: false,
    ...over,
});

describe('pickRefereeSuccessor (A22 order)', () => {
    const HOST = 1;
    const members = [
        m(HOST, 'Spectator', 0, { isReferee: true }),
        m(20, 'RedPlayer', 1),
        m(21, 'RedPlayer', 2),
        m(10, 'BluePlayer', 3),
        m(11, 'BluePlayer', 4),
        m(30, 'Spectator', 5),
        m(40, 'BlueCoach', 6),
        m(41, 'RedCoach', 7),
    ];

    it('prefers the host when online and not the leaver', () => {
        expect(pickRefereeSuccessor(members, HOST, 10)).toBe(HOST);
    });
    it('then Blue players in join order (not lowest userId)', () => {
        const noHost = members.filter((x) => x.userId !== HOST);
        expect(pickRefereeSuccessor(noHost, HOST, 99)).toBe(10); // joined before 11, after Red 20/21
    });
    it('then Red players, spectators, coaches', () => {
        const noHostNoBlue = members.filter((x) => x.userId !== HOST && x.slot !== 'BluePlayer');
        expect(pickRefereeSuccessor(noHostNoBlue, HOST, 99)).toBe(20);
        const specOnly = [m(30, 'Spectator', 5), m(31, 'Spectator', 2), m(40, 'BlueCoach', 1)];
        expect(pickRefereeSuccessor(specOnly, HOST, 99)).toBe(31);
        const coachOnly = [m(41, 'RedCoach', 1), m(40, 'BlueCoach', 2)];
        expect(pickRefereeSuccessor(coachOnly, HOST, 99)).toBe(40); // Blue coach before Red coach
    });
    it('skips offline members, the leaver and hasLeft (away / abandoned) rows', () => {
        const ms = [
            m(HOST, 'Spectator', 0, { isOnline: false }),
            m(10, 'BluePlayer', 1, { hasLeft: true }),
            m(11, 'BluePlayer', 2),
        ];
        expect(pickRefereeSuccessor(ms, HOST, 11)).toBeNull();
        expect(pickRefereeSuccessor(ms, HOST, 99)).toBe(11);
    });
});

// T-S8f: the generic successor of A68(7) (host, captain, referee on every removal): A22(5) order, online first, then
// any remaining member; hasLeft rows and the leaver never; `onlineOnly` is the 15 s check's rule (A22a).
describe('pickSuccessor (A68(7))', () => {
    const HOST = 1;
    it('online candidates first, in the A22(5) order', () => {
        const ms = [
            m(HOST, 'Spectator', 0, { isOnline: false }),
            m(10, 'BluePlayer', 1, { isOnline: false }),
            m(20, 'RedPlayer', 2),
            m(30, 'Spectator', 3),
        ];
        expect(pickSuccessor(ms, HOST, 99)).toBe(20);
    });
    it('then any remaining member when nobody is online (host → Blue → Red → spectators → coaches)', () => {
        const ms = [
            m(40, 'BlueCoach', 0, { isOnline: false }),
            m(30, 'Spectator', 1, { isOnline: false }),
            m(20, 'RedPlayer', 2, { isOnline: false }),
            m(11, 'BluePlayer', 4, { isOnline: false }),
            m(10, 'BluePlayer', 3, { isOnline: false }),
        ];
        expect(pickSuccessor(ms, HOST, 99)).toBe(10);
        expect(pickSuccessor([...ms, m(HOST, 'Spectator', 9, { isOnline: false })], HOST, 99)).toBe(
            HOST,
        );
    });
    it('onlineOnly: nobody online → null (the 15 s check keeps the flag)', () => {
        const ms = [m(10, 'BluePlayer', 1, { isOnline: false })];
        expect(pickSuccessor(ms, HOST, 99, () => true, true)).toBeNull();
        expect(pickSuccessor(ms, HOST, 99)).toBe(10);
    });
    it('hasLeft rows and the leaver are never candidates, even as the last resort', () => {
        const ms = [
            m(10, 'BluePlayer', 1, { hasLeft: true, isOnline: false }),
            m(11, 'BluePlayer', 2),
        ];
        expect(pickSuccessor(ms, HOST, 11)).toBeNull();
    });
    it('a predicate narrows the set (the captain: same-team players only)', () => {
        const ms = [
            m(10, 'BluePlayer', 1),
            m(20, 'RedPlayer', 0),
            m(21, 'RedPlayer', 2, { isOnline: false }),
        ];
        expect(pickSuccessor(ms, HOST, 20, (x) => x.slot === 'RedPlayer')).toBe(21);
    });
});

describe('decideRefereeTransfer (A22a grace check)', () => {
    const host = m(1, 'Spectator', 0, { isReferee: true, isOnline: false });
    const blue = m(10, 'BluePlayer', 1);
    const base = {
        subjectUserId: 1,
        members: [host, blue],
        hostUserId: 1,
        stage: 'Drafting' as const,
    };

    it('transfers when the referee is still offline after the grace period', () => {
        expect(decideRefereeTransfer({ ...base, subject: host })).toEqual({
            action: 'transfer',
            toUserId: 10,
        });
    });
    it('does nothing after a page refresh (reconnected inside the window)', () => {
        expect(decideRefereeTransfer({ ...base, subject: { ...host, isOnline: true } })).toEqual({
            action: 'none',
            reason: 'reconnected',
        });
    });
    it('does nothing if the flag already moved or the member left', () => {
        expect(decideRefereeTransfer({ ...base, subject: { ...host, isReferee: false } })).toEqual({
            action: 'none',
            reason: 'not-referee',
        });
        expect(decideRefereeTransfer({ ...base, subject: undefined })).toEqual({
            action: 'none',
            reason: 'left-lobby',
        });
    });
    // T-S8e (A67(1)): Finished is gone from LobbyStage. T-S10d (A92(5)): Waiting runs the same 15 s flag check as the
    // live stages; AwaitingResult stays inactive.
    it('Waiting: the flag moves to the first online candidate, as in the live stages (A92(5))', () => {
        expect(decideRefereeTransfer({ ...base, stage: 'Waiting', subject: host })).toEqual({
            action: 'transfer',
            toUserId: 10,
        });
        expect(
            decideRefereeTransfer({
                ...base,
                stage: 'Waiting',
                subject: { ...host, isOnline: true },
            }),
        ).toEqual({ action: 'none', reason: 'reconnected' });
    });
    it('does nothing in AwaitingResult (A67(1), A92(5))', () => {
        expect(decideRefereeTransfer({ ...base, stage: 'AwaitingResult', subject: host })).toEqual({
            action: 'none',
            reason: 'inactive-stage',
        });
    });
    it('reports no candidate instead of inventing one', () => {
        expect(decideRefereeTransfer({ ...base, members: [host], subject: host })).toEqual({
            action: 'none',
            reason: 'no-candidate',
        });
    });
});

describe('decideAutoPause (F5 + A22a)', () => {
    const offlinePlayer = m(10, 'BluePlayer', 1, { isOnline: false });
    it('pauses for an offline player in Drafting under Standard', () => {
        expect(
            decideAutoPause({
                subject: offlinePlayer,
                stage: 'Drafting',
                isPaused: false,
                disconnectPolicy: 'Standard',
            }),
        ).toBe(true);
    });
    it('never pauses for spectators, coaches or referees without a team', () => {
        expect(
            decideAutoPause({
                subject: m(1, 'Spectator', 0, { isOnline: false, isReferee: true }),
                stage: 'Drafting',
                isPaused: false,
                disconnectPolicy: 'Standard',
            }),
        ).toBe(false);
        expect(
            decideAutoPause({
                subject: m(40, 'BlueCoach', 0, { isOnline: false }),
                stage: 'Drafting',
                isPaused: false,
                disconnectPolicy: 'Standard',
            }),
        ).toBe(false);
    });
    it('does not pause when reconnected, already paused, NoAction, or outside Drafting', () => {
        expect(
            decideAutoPause({
                subject: { ...offlinePlayer, isOnline: true },
                stage: 'Drafting',
                isPaused: false,
                disconnectPolicy: 'Standard',
            }),
        ).toBe(false);
        expect(
            decideAutoPause({
                subject: offlinePlayer,
                stage: 'Drafting',
                isPaused: true,
                disconnectPolicy: 'Standard',
            }),
        ).toBe(false);
        expect(
            decideAutoPause({
                subject: offlinePlayer,
                stage: 'Drafting',
                isPaused: false,
                disconnectPolicy: 'NoAction',
            }),
        ).toBe(false);
        expect(
            decideAutoPause({
                subject: offlinePlayer,
                stage: 'Equipping',
                isPaused: false,
                disconnectPolicy: 'Standard',
            }),
        ).toBe(false);
    });
});
