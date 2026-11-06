/**
 * Unit tests: flag transfer helper functions — transferCaptain, transferReferee, transferHost
 *
 * Contract: docs/lobby/architecture.md — Flag Transfers on Disconnect/Leave (D-34, D-35, D-36)
 * Phase: 10 (Disconnect Handling and Cost Parity)
 */

import { describe, it, expect } from 'vitest';
import {
    transferCaptain,
    transferReferee,
    transferHost,
} from '../../../spacetimedb/src/helpers/flagTransferHelpers';

// ── Mock helpers ──────────────────────────────────────────────────────────────

const BluePlayer = { tag: 'BluePlayer' };
const RedPlayer = { tag: 'RedPlayer' };
const Spectator = { tag: 'Spectator' };
const BlueCoach = { tag: 'BlueCoach' };

interface MockMember {
    lobbyId: number;
    userId: number;
    lobbySlot: any;
    isCaptain: boolean;
    isReferee: boolean;
    isOnline: boolean;
    voluntarilyLeft: boolean;
}

function makeMember(overrides: Partial<MockMember> & { userId: number; lobbySlot: any }): MockMember {
    return {
        lobbyId: 1,
        isCaptain: false,
        isReferee: false,
        isOnline: true,
        voluntarilyLeft: false,
        ...overrides,
    };
}

/** Create a mock ctx that tracks inserts/deletes/updates for verification */
function mockCtx(members: MockMember[], lobby?: any) {
    const store = [...members];
    const deleted: Array<[number, number]> = [];
    const inserted: any[] = [];
    const lobbyUpdates: any[] = [];

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
                        find: (id: number) => lobby?.id === id ? lobby : null,
                        update: (row: any) => { lobbyUpdates.push(row); },
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

// ── transferCaptain ───────────────────────────────────────────────────────────

describe('transferCaptain', () => {
    it('transfers to lowest userId teammate', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true }),
            makeMember({ userId: 20, lobbySlot: BluePlayer }),
            makeMember({ userId: 15, lobbySlot: BluePlayer }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        // userId 15 should be new captain (lowest after 10)
        const newCaptain = inserted.find((m: any) => m.userId === 15);
        expect(newCaptain).toBeDefined();
        expect(newCaptain.isCaptain).toBe(true);

        // userId 10 should be demoted
        const demoted = inserted.find((m: any) => m.userId === 10);
        expect(demoted).toBeDefined();
        expect(demoted.isCaptain).toBe(false);
    });

    it('no-op if leaving member is not captain', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer }), // not captain
            makeMember({ userId: 20, lobbySlot: BluePlayer, isCaptain: true }),
        ];
        const { ctx, inserted, deleted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        expect(inserted).toHaveLength(0);
        expect(deleted).toHaveLength(0);
    });

    it('no-op if leaving member is spectator', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isCaptain: true }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        // Spectator has no team → no transfer target → only demote
        // Actually slotTeam(Spectator) returns null → early return
        expect(inserted).toHaveLength(0);
    });

    it('demotes leaving member even when no candidates', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        // No candidates but still demotes leaving member
        const demoted = inserted.find((m: any) => m.userId === 10);
        expect(demoted).toBeDefined();
        expect(demoted.isCaptain).toBe(false);
    });

    it('skips voluntarilyLeft candidates', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, voluntarilyLeft: true }),
            makeMember({ userId: 20, lobbySlot: BluePlayer }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        // userId 15 skipped (voluntarilyLeft), userId 20 gets captain
        const newCaptain = inserted.find((m: any) => m.userId === 20);
        expect(newCaptain).toBeDefined();
        expect(newCaptain.isCaptain).toBe(true);
    });

    it('skips coaches', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true }),
            makeMember({ userId: 15, lobbySlot: BlueCoach }),
            makeMember({ userId: 20, lobbySlot: BluePlayer }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        const newCaptain = inserted.find((m: any) => m.userId === 20);
        expect(newCaptain).toBeDefined();
        expect(newCaptain.isCaptain).toBe(true);
    });
});

// ── transferReferee ───────────────────────────────────────────────────────────

describe('transferReferee', () => {
    const lobby = { id: 1, hostUserId: 20 };

    it('transfers to host first (priority 1)', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isReferee: true }),
            makeMember({ userId: 15, lobbySlot: BluePlayer }),
            makeMember({ userId: 20, lobbySlot: RedPlayer }), // host
        ];
        const { ctx, inserted } = mockCtx(members, lobby);

        transferReferee(ctx, 1, 10);

        const newRef = inserted.find((m: any) => m.userId === 20);
        expect(newRef).toBeDefined();
        expect(newRef.isReferee).toBe(true);
    });

    it('transfers to lowest userId when host not eligible', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isReferee: true }),
            makeMember({ userId: 25, lobbySlot: BluePlayer }),
            makeMember({ userId: 15, lobbySlot: RedPlayer }),
        ];
        const lobbyNoHost = { id: 1, hostUserId: 99 }; // host not in members
        const { ctx, inserted } = mockCtx(members, lobbyNoHost);

        transferReferee(ctx, 1, 10);

        const newRef = inserted.find((m: any) => m.userId === 15);
        expect(newRef).toBeDefined();
        expect(newRef.isReferee).toBe(true);
    });

    it('no-op if leaving member is not referee', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator }), // not referee
            makeMember({ userId: 20, lobbySlot: BluePlayer }),
        ];
        const { ctx, inserted } = mockCtx(members, lobby);

        transferReferee(ctx, 1, 10);

        expect(inserted).toHaveLength(0);
    });

    it('keeps referee flag when no eligible candidates', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isReferee: true }),
        ];
        const { ctx, inserted } = mockCtx(members, lobby);

        transferReferee(ctx, 1, 10);

        // No candidates → referee stays on leaving member
        expect(inserted).toHaveLength(0);
    });

    it('skips offline, spectator, coach, voluntarilyLeft candidates', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: Spectator, isReferee: true }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, isOnline: false }),
            makeMember({ userId: 20, lobbySlot: Spectator }), // spectator
            makeMember({ userId: 25, lobbySlot: BlueCoach }), // coach
            makeMember({ userId: 30, lobbySlot: RedPlayer, voluntarilyLeft: true }),
            makeMember({ userId: 35, lobbySlot: RedPlayer }), // only eligible
        ];
        const { ctx, inserted } = mockCtx(members, lobby);

        transferReferee(ctx, 1, 10);

        const newRef = inserted.find((m: any) => m.userId === 35);
        expect(newRef).toBeDefined();
        expect(newRef.isReferee).toBe(true);
    });
});

// ── transferHost ──────────────────────────────────────────────────────────────

describe('transferHost', () => {
    it('transfers to referee first (priority 1)', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer }), // host, leaving
            makeMember({ userId: 20, lobbySlot: RedPlayer, isReferee: true }),
            makeMember({ userId: 15, lobbySlot: BluePlayer }),
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10);

        expect(lobbyUpdates).toHaveLength(1);
        expect(lobbyUpdates[0].hostUserId).toBe(20);
    });

    it('transfers to lowest userId when no referee', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer }),
            makeMember({ userId: 25, lobbySlot: RedPlayer }),
            makeMember({ userId: 15, lobbySlot: BluePlayer }),
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10);

        expect(lobbyUpdates).toHaveLength(1);
        expect(lobbyUpdates[0].hostUserId).toBe(15);
    });

    it('no-op if leaving member is not host', () => {
        const lobby = { id: 1, hostUserId: 99 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer }),
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10);

        expect(lobbyUpdates).toHaveLength(0);
    });

    it('keeps host when no eligible candidates', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer }),
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10);

        expect(lobbyUpdates).toHaveLength(0);
    });

    it('skips offline, spectator, coach, voluntarilyLeft candidates', () => {
        const lobby = { id: 1, hostUserId: 10 };
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, isOnline: false }),
            makeMember({ userId: 20, lobbySlot: Spectator }),
            makeMember({ userId: 25, lobbySlot: BlueCoach }),
            makeMember({ userId: 30, lobbySlot: RedPlayer, voluntarilyLeft: true }),
            makeMember({ userId: 35, lobbySlot: RedPlayer }), // only eligible
        ];
        const { ctx, lobbyUpdates } = mockCtx(members, lobby);

        transferHost(ctx, 1, lobby, 10);

        expect(lobbyUpdates).toHaveLength(1);
        expect(lobbyUpdates[0].hostUserId).toBe(35);
    });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
    it('single member lobby — captain demoted, no transfer', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        const demoted = inserted.find((m: any) => m.userId === 10);
        expect(demoted?.isCaptain).toBe(false);
    });

    it('all candidates voluntarilyLeft — no captain transfer', () => {
        const members = [
            makeMember({ userId: 10, lobbySlot: BluePlayer, isCaptain: true }),
            makeMember({ userId: 15, lobbySlot: BluePlayer, voluntarilyLeft: true }),
            makeMember({ userId: 20, lobbySlot: BluePlayer, voluntarilyLeft: true }),
        ];
        const { ctx, inserted } = mockCtx(members);

        transferCaptain(ctx, 1, 10);

        // No transfer to anyone, but still demotes userId 10
        const captainInserts = inserted.filter((m: any) => m.isCaptain === true);
        expect(captainInserts).toHaveLength(0);
    });

    it('member not found — no-op for all transfers', () => {
        const members = [
            makeMember({ userId: 20, lobbySlot: BluePlayer }),
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
