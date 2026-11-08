/**
 * Unit tests: flag transfer helper functions — transferCaptain, transferReferee, transferHost, transferFlagsOnRemoval
 *
 * Contract: docs/lobby/architecture.md — Flag Transfers (D-34, D-36, A22(5), A68(7))
 * Phase: 10 (Disconnect Handling and Cost Parity); T-S8f rewrite: D-35's lowest-userId rule is retired (A68(7)).
 * Every flag moves in the A22(5) order (host → Blue players → Red players → spectators → coaches, by joinSeq), online
 * candidates first, then any remaining member; the leaver and away / abandoned rows (leftAt / abandonedAt) are never
 * candidates; with no candidate the flag stays with its holder (the caller deletes the row afterwards).
 */

import { describe, it, expect } from 'vitest';
import {
    transferCaptain,
    transferReferee,
    transferHost,
    transferFlagsOnRemoval,
} from '../../../spacetimedb/src/helpers/flagTransferHelpers';

// ── Mock helpers ──────────────────────────────────────────────────────────────

const BluePlayer = { tag: 'BluePlayer' };
const RedPlayer = { tag: 'RedPlayer' };
const Spectator = { tag: 'Spectator' };
const BlueCoach = { tag: 'BlueCoach' };
const RedCoach = { tag: 'RedCoach' };

const AT = { microsSinceUnixEpoch: 1n };

interface MockMember {
    lobbyId: number;
    userId: number;
    lobbySlot: any;
    isCaptain: boolean;
    isReferee: boolean;
    isOnline: boolean;
    joinSeq: number;
    leftAt?: any;
    abandonedAt?: any;
}

function makeMember(overrides: Partial<MockMember> & { userId: number; lobbySlot: any; joinSeq: number }): MockMember {
    return {
        lobbyId: 1,
        isCaptain: false,
        isReferee: false,
        isOnline: true,
        ...overrides,
    };
}

/** Create a mock ctx that tracks inserts/deletes/updates for verification */
function mockCtx(members: MockMember[], lobby?: any) {
    const store = [...members];
    const deleted: Array<[number, number]> = [];
    const inserted: any[] = [];
    const lobbyUpdates: any[] = [];
    let currentLobby = lobby;

    return {
        ctx: {
            db: {
                LobbyMember: {
                    lobby_id: {
                        filter: (lobbyId: number) => store.filter(m => m.lobbyId === lobbyId),
                    },
                    by_lobby_and_user: {
                        delete: (args: [number, number]) => {
                            deleted.push(args);
                            const idx = store.findIndex(m => m.lobbyId === args[0] && m.userId === args[1]);
                            if (idx >= 0) store.splice(idx, 1);
                        },
                    },
                    insert: (row: any) => {
                        inserted.push(row);
                        store.push(row);
                    },
                },
                Lobby: {
                    id: {
                        find: (id: number) => currentLobby?.id === id ? currentLobby : null,
                        update: (row: any) => { lobbyUpdates.push(row); currentLobby = row; },
                    },
                },
            },
            timestamp: { microsSinceUnixEpoch: 0n },
        },
        store,
        deleted,
        inserted,
        lobbyUpdates,
    };
}

const flagged = (inserted: any[], key: 'isCaptain' | 'isReferee') =>
    inserted.filter((m: any) => m[key] === true).map((m: any) => m.userId);

// ── transferCaptain ───────────────────────────────────────────────────────────

describe('transferCaptain (D-34, A68(7))', () => {
    it('transfers to the first teammate by joinSeq (not the lowest userId)', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, joinSeq: 3 }),
            makeMember({ userId: 20, lobbySlot: BluePlayer, joinSeq: 2 }),
        ];
        const { ctx, inserted } = mockCtx(members, { id: 1, hostUserId: 99 });

        transferCaptain(ctx, 1, 10);

        expect(flagged(inserted, 'isCaptain')).toEqual([20]);
        expect(inserted.find((m: any) => m.userId === 10)?.isCaptain).toBe(false);
    });

    it('online teammates first, then any teammate', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, isOnline: false, joinSeq: 2 }),
            makeMember({ userId: 20, lobbySlot: BluePlayer, joinSeq: 3 }),
        ];
        const a = mockCtx(members);
        transferCaptain(a.ctx, 1, 10);
        expect(flagged(a.inserted, 'isCaptain')).toEqual([20]);

        const b = mockCtx([members[0], members[1]]);
        transferCaptain(b.ctx, 1, 10);
        expect(flagged(b.inserted, 'isCaptain')).toEqual([15]);
    });

    it('onlineOnly (the 15 s check): no online teammate → the flag stays', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, isOnline: false, joinSeq: 2 }),
        ];
        const { ctx, inserted } = mockCtx(members);
        transferCaptain(ctx, 1, 10, { onlineOnly: true });
        expect(inserted).toHaveLength(0);
    });

    it('no-op if leaving member is not captain', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, joinSeq: 1 }), // not captain
            makeMember({ userId: 20, lobbySlot: BluePlayer, isCaptain: true, joinSeq: 2 }),
        ];
        const { ctx, inserted, deleted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        expect(inserted).toHaveLength(0);
        expect(deleted).toHaveLength(0);
    });

    it('no-op if leaving member is spectator', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isCaptain: true, joinSeq: 1 }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        expect(inserted).toHaveLength(0);
    });

    it('no teammate at all: nothing is written (the flag stays with its holder)', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true, joinSeq: 1 }),
            makeMember({ userId: 20, lobbySlot: RedPlayer, joinSeq: 2 }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        expect(inserted).toHaveLength(0);
    });

    it('skips away and abandoned teammates (A68(2)(4))', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, isOnline: false, leftAt: AT, joinSeq: 2 }),
            makeMember({ userId: 16, lobbySlot: BluePlayer, isOnline: false, leftAt: AT, abandonedAt: AT, joinSeq: 3 }),
            makeMember({ userId: 20, lobbySlot: BluePlayer, isOnline: false, joinSeq: 4 }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        expect(flagged(inserted, 'isCaptain')).toEqual([20]);
    });

    it('skips coaches', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BlueCoach, joinSeq: 2 }),
            makeMember({ userId: 20, lobbySlot: BluePlayer, joinSeq: 3 }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        expect(flagged(inserted, 'isCaptain')).toEqual([20]);
    });
});

// ── transferReferee ───────────────────────────────────────────────────────────

describe('transferReferee (A22(5), A68(7))', () => {
    const lobby = { id: 1, hostUserId: 20 };

    it('transfers to the host first', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isReferee: true, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, joinSeq: 2 }),
            makeMember({ userId: 20, lobbySlot: RedPlayer, joinSeq: 3 }), // host
        ];
        const { ctx, inserted } = mockCtx(members, lobby);

        transferReferee(ctx, 1, 10);

        expect(flagged(inserted, 'isReferee')).toEqual([20]);
    });

    it('host not a member: Blue players by joinSeq before Red players (not the lowest userId)', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isReferee: true, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: RedPlayer, joinSeq: 2 }),
            makeMember({ userId: 30, lobbySlot: BluePlayer, joinSeq: 4 }),
            makeMember({ userId: 25, lobbySlot: BluePlayer, joinSeq: 3 }),
        ];
        const { ctx, inserted } = mockCtx(members, { id: 1, hostUserId: 99 });

        transferReferee(ctx, 1, 10);

        expect(flagged(inserted, 'isReferee')).toEqual([25]);
    });

    it('no-op if leaving member is not referee', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, joinSeq: 1 }), // not referee
            makeMember({ userId: 20, lobbySlot: BluePlayer, joinSeq: 2 }),
        ];
        const { ctx, inserted } = mockCtx(members, lobby);

        transferReferee(ctx, 1, 10);

        expect(inserted).toHaveLength(0);
    });

    it('keeps referee flag when no other member exists', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isReferee: true, joinSeq: 1 }),
        ];
        const { ctx, inserted } = mockCtx(members, lobby);

        transferReferee(ctx, 1, 10);

        expect(inserted).toHaveLength(0);
    });

    it('online first in the A22(5) order: offline Blue, away Red skipped → the online spectator before the coach', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isReferee: true, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, isOnline: false, joinSeq: 2 }),
            makeMember({ userId: 25, lobbySlot: BlueCoach, joinSeq: 3 }),
            makeMember({ userId: 30, lobbySlot: RedPlayer, isOnline: false, leftAt: AT, joinSeq: 4 }),
            makeMember({ userId: 35, lobbySlot: Spectator, joinSeq: 5 }),
        ];
        const { ctx, inserted } = mockCtx(members, { id: 1, hostUserId: 99 });

        transferReferee(ctx, 1, 10);

        expect(flagged(inserted, 'isReferee')).toEqual([35]);
    });

    it('nobody online: the first remaining member in the A22(5) order (A68(7): a lobby always has a referee)', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isReferee: true, joinSeq: 1 }),
            makeMember({ userId: 40, lobbySlot: RedCoach, isOnline: false, joinSeq: 2 }),
            makeMember({ userId: 35, lobbySlot: Spectator, isOnline: false, joinSeq: 3 }),
            makeMember({ userId: 30, lobbySlot: RedPlayer, isOnline: false, joinSeq: 4 }),
        ];
        const { ctx, inserted } = mockCtx(members, { id: 1, hostUserId: 99 });

        transferReferee(ctx, 1, 10);

        expect(flagged(inserted, 'isReferee')).toEqual([30]);
    });
});

// ── transferHost ──────────────────────────────────────────────────────────────

describe('transferHost (D-36, A68(7))', () => {
    it('the A22(5) order from the Blue players (the referee holds no priority any more)', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, joinSeq: 1 }), // host, leaving
            makeMember({ userId: 20, lobbySlot: RedPlayer, isReferee: true, joinSeq: 2 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, joinSeq: 3 }),
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10);

        expect(lobbyUpdates).toHaveLength(1);
        expect(lobbyUpdates[0].hostUserId).toBe(15);
    });

    it('Blue players by joinSeq, not by userId', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, joinSeq: 3 }),
            makeMember({ userId: 25, lobbySlot: BluePlayer, joinSeq: 2 }),
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10);

        expect(lobbyUpdates[0].hostUserId).toBe(25);
    });

    it('no-op if leaving member is not host', () => {
        const lobby = { id: 1, hostUserId: 99 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, joinSeq: 1 }),
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10);

        expect(lobbyUpdates).toHaveLength(0);
    });

    it('keeps host when no other member exists', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, joinSeq: 1 }),
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10);

        expect(lobbyUpdates).toHaveLength(0);
    });

    it('online first (offline Blue and away Red skipped → the online spectator), then any member', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, isOnline: false, joinSeq: 2 }),
            makeMember({ userId: 25, lobbySlot: BlueCoach, joinSeq: 3 }),
            makeMember({ userId: 30, lobbySlot: RedPlayer, isOnline: false, leftAt: AT, joinSeq: 4 }),
            makeMember({ userId: 35, lobbySlot: Spectator, joinSeq: 5 }),
        ];
        const a = mockCtx(members, lobby);
        transferHost(a.ctx, 1, lobby, 10);
        expect(a.lobbyUpdates[0].hostUserId).toBe(35);

        const offline = members.map((m) => ({ ...m, isOnline: false }));
        const b = mockCtx(offline, lobby);
        transferHost(b.ctx, 1, lobby, 10);
        expect(b.lobbyUpdates[0].hostUserId).toBe(15); // nobody online: the first Blue player; away rows never
    });

    it('onlineOnly (the 15 s check): nobody online → the host stays', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, isOnline: false, joinSeq: 2 }),
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10, { onlineOnly: true });

        expect(lobbyUpdates).toHaveLength(0);
    });
});

// ── transferFlagsOnRemoval ────────────────────────────────────────────────────

describe('transferFlagsOnRemoval (A68(7))', () => {
    it('a host who is referee and captain hands over all three flags', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true, isReferee: true, joinSeq: 1 }),
            makeMember({ userId: 20, lobbySlot: RedPlayer, isCaptain: true, joinSeq: 2 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, joinSeq: 3 }),
        ];
        const { ctx, store, lobbyUpdates } = mockCtx(members, lobby);

        transferFlagsOnRemoval(ctx, 1, 10);

        const row = (id: number) => store.find((m) => m.userId === id)!;
        expect(row(15).isCaptain).toBe(true);
        expect(row(15).isReferee).toBe(true);
        expect(row(10).isCaptain).toBe(false);
        expect(row(10).isReferee).toBe(false);
        expect(row(20).isCaptain).toBe(true); // the other team's captain untouched
        expect(lobbyUpdates.at(-1).hostUserId).toBe(15);
    });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
    it('all teammates away — no captain transfer, nothing written', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true, joinSeq: 1 }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, isOnline: false, leftAt: AT, joinSeq: 2 }),
            makeMember({ userId: 20, lobbySlot: BluePlayer, isOnline: false, leftAt: AT, abandonedAt: AT, joinSeq: 3 }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        expect(inserted).toHaveLength(0);
    });

    it('member not found — no-op for all transfers', () => {
        const members = [
            makeMember({ userId: 20, lobbySlot: BluePlayer, joinSeq: 1 }),
        ];
        const lobby = { id: 1, hostUserId: 20 };
        const { ctx, inserted, deleted, lobbyUpdates } = mockCtx(members, lobby);

        transferCaptain(ctx, 1, 99); // userId 99 doesn't exist
        transferReferee(ctx, 1, 99);
        transferHost(ctx, 1, lobby, 99);

        expect(inserted).toHaveLength(0);
        expect(deleted).toHaveLength(0);
        expect(lobbyUpdates).toHaveLength(0);
    });
});
