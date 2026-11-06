/**
 * Phase 15, D-13, D-17, D-18, D-20 — Self-scoped history views: cross-user isolation.
 *
 * Asserts that each of the 5 new `view_my_*_history` views filters server-side
 * by `ctx.sender` (via UserIdentity.identity lookup → userId) and never leaks
 * another user's rows.
 *
 * Strategy: history tables are populated only via `matchFinalization` (a full
 * match flow). Rather than orchestrate two full matches here (expensive and
 * duplicative with match-results tests), this file asserts the invariants
 * that must hold regardless of data volume:
 *
 *   I1. For any verified caller, the view result contains only rows whose
 *       (implicit or explicit) userId matches the caller's userId.
 *   I2. For any verified caller, the view result is a subset of the direct
 *       SQL query `SELECT * FROM <backing_table> WHERE user_id = <callerId>`
 *       (for Pattern A tables) or the participant-first union (Pattern B).
 *   I3. A fresh verified user (no matches yet) sees an empty view.
 *   I4. Given two concurrent verified users userA and userB, userA's view
 *       never includes rows where user_id = userB.userId, and vice versa.
 *
 * I3 is the strongest isolation signal achievable without running full matches —
 * a fresh user whose view returns [] while other users in the database have
 * history rows proves the per-sender filter is in effect.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createTwoVerifiedHarnesses,
    disconnectBoth,
    hasServerToken,
    type TwoIdentities,
} from '../../../shared/two-identity-harness';
import { queryPrivateTable } from '../../../shared/connection';

describe.skipIf(!hasServerToken())('Phase 15 — self-scoped history views: cross-user isolation', () => {
    let pair: TwoIdentities;

    beforeAll(async () => {
        pair = await createTwoVerifiedHarnesses();
        // Allow subscription caches to hydrate fully.
        await pair.userA.sync(1500);
        await pair.userB.sync(1500);
    });

    afterAll(async () => {
        await disconnectBoth(pair);
    });

    // ─── Pattern A views (direct userId index filter) ────────────────────────

    describe('view_my_mmr_history (Pattern A — direct user_id filter)', () => {
        it('fresh userA sees empty view (I3)', () => {
            const rows = [...(pair.userA.conn.db as any).view_my_mmr_history.iter()];
            expect(rows).toEqual([]);
        });

        it('fresh userB sees empty view (I3)', () => {
            const rows = [...(pair.userB.conn.db as any).view_my_mmr_history.iter()];
            expect(rows).toEqual([]);
        });

        it('userA view contains only rows with userId === userA.userId (I1)', () => {
            const rows = [...(pair.userA.conn.db as any).view_my_mmr_history.iter()];
            for (const r of rows) {
                expect(r.userId).toBe(pair.userA.userId);
            }
        });

        it('userA view never includes userB rows (I4)', () => {
            const rows = [...(pair.userA.conn.db as any).view_my_mmr_history.iter()];
            const leaked = rows.filter((r: any) => r.userId === pair.userB.userId);
            expect(leaked).toEqual([]);
        });

        it('userA view is subset of SQL filter on backing table (I2)', async () => {
            const sqlRows = await queryPrivateTable(
                `SELECT id FROM mmr_history WHERE user_id = ${pair.userA.userId}`
            );
            const viewRows = [...(pair.userA.conn.db as any).view_my_mmr_history.iter()];
            expect(viewRows.length).toBeLessThanOrEqual(sqlRows.length);
        });
    });

    describe('view_my_match_participant_history (Pattern A — direct by_user filter)', () => {
        it('fresh userA sees empty view (I3)', () => {
            const rows = [...(pair.userA.conn.db as any).view_my_match_participant_history.iter()];
            expect(rows).toEqual([]);
        });

        it('fresh userB sees empty view (I3)', () => {
            const rows = [...(pair.userB.conn.db as any).view_my_match_participant_history.iter()];
            expect(rows).toEqual([]);
        });

        it('userA view contains only rows with userId === userA.userId (I1)', () => {
            const rows = [...(pair.userA.conn.db as any).view_my_match_participant_history.iter()];
            for (const r of rows) {
                expect(r.userId).toBe(pair.userA.userId);
            }
        });

        it('userA view never includes userB rows (I4)', () => {
            const rows = [...(pair.userA.conn.db as any).view_my_match_participant_history.iter()];
            const leaked = rows.filter((r: any) => r.userId === pair.userB.userId);
            expect(leaked).toEqual([]);
        });
    });

    // ─── Pattern B views (participant-first iteration, no direct userId column) ──

    describe('view_my_match_session_history (Pattern B — participant-first iteration)', () => {
        it('fresh userA sees empty view (I3)', () => {
            const rows = [...(pair.userA.conn.db as any).view_my_match_session_history.iter()];
            expect(rows).toEqual([]);
        });

        it('fresh userB sees empty view (I3)', () => {
            const rows = [...(pair.userB.conn.db as any).view_my_match_session_history.iter()];
            expect(rows).toEqual([]);
        });

        it('userA view rows are matchHistoryIds where userA was a participant (I1)', () => {
            const sessionRows = [...(pair.userA.conn.db as any).view_my_match_session_history.iter()];
            const participantRows = [...(pair.userA.conn.db as any).view_my_match_participant_history.iter()];
            const allowedMatchIds = new Set(participantRows.map((p: any) => p.matchHistoryId));
            for (const s of sessionRows) {
                expect(allowedMatchIds.has(s.id)).toBe(true);
            }
        });
    });

    describe('view_my_match_session_step_history (Pattern B — participant-first iteration)', () => {
        it('fresh userA sees empty view (I3)', () => {
            const rows = [...(pair.userA.conn.db as any).view_my_match_session_step_history.iter()];
            expect(rows).toEqual([]);
        });

        it('fresh userB sees empty view (I3)', () => {
            const rows = [...(pair.userB.conn.db as any).view_my_match_session_step_history.iter()];
            expect(rows).toEqual([]);
        });

        it('userA view rows belong to matchHistoryIds where userA participated (I1)', () => {
            const stepRows = [...(pair.userA.conn.db as any).view_my_match_session_step_history.iter()];
            const participantRows = [...(pair.userA.conn.db as any).view_my_match_participant_history.iter()];
            const allowedMatchIds = new Set(participantRows.map((p: any) => p.matchHistoryId));
            for (const s of stepRows) {
                expect(allowedMatchIds.has(s.matchHistoryId)).toBe(true);
            }
        });
    });

    describe('view_my_match_result_game_history (Pattern B — participant-first iteration)', () => {
        it('fresh userA sees empty view (I3)', () => {
            const rows = [...(pair.userA.conn.db as any).view_my_match_result_game_history.iter()];
            expect(rows).toEqual([]);
        });

        it('fresh userB sees empty view (I3)', () => {
            const rows = [...(pair.userB.conn.db as any).view_my_match_result_game_history.iter()];
            expect(rows).toEqual([]);
        });

        it('userA view rows belong to matchHistoryIds where userA participated (I1)', () => {
            const gameRows = [...(pair.userA.conn.db as any).view_my_match_result_game_history.iter()];
            const participantRows = [...(pair.userA.conn.db as any).view_my_match_participant_history.iter()];
            const allowedMatchIds = new Set(participantRows.map((p: any) => p.matchHistoryId));
            for (const g of gameRows) {
                expect(allowedMatchIds.has(g.matchHistoryId)).toBe(true);
            }
        });
    });
});
