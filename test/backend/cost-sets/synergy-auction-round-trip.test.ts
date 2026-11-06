/**
 * Phase 15.4 D-25a — Synergy auction row round-trip (FIRST-EVER coverage).
 *
 * Before 15.4, no synergy row ever carried `draftMode='Auction'`. After 15.4:
 *   - Every synergy row has a draftMode tag (Classic | Auction).
 *   - The default seed (D-13) ships 30 zero-valued Auction synergy rows.
 *   - Custom cost sets can edit Auction synergy rows per-(source, target, mode, csId).
 *
 * This file locks the round-trip for the new Auction path:
 *   1. admin_bulk_upsert inserts a synergy row with draftMode=Auction (direct write path).
 *   2. Classic + Auction rows for the same (source, target, mode, csId) coexist
 *      (5-tuple PK discrimination via reducer tuple match).
 *   3. edit_draft_synergy_cost updates an existing draft row by 5-tuple match.
 *   4. publish_cost_set materializes an Auction draft row to a live HsrSynergyCost row.
 *
 * Binding accessor casing notes (verified against src/module_bindings/):
 *   - Reducer names: camelCase (adminBulkUpsert, editDraftSynergyCost, publishCostSet, createCostSet).
 *   - Row column names: camelCase (sourceName, targetName, gameMode, draftMode, costModifier, costSetId).
 *   - Multi-col btree accessor: `by_tuple` (snake_case) on HsrSynergyCost — BUT per
 *     15.4-01 A2_FALLBACK_ITER decision, the active read path is iter() + predicate,
 *     not .by_tuple.filter([enum struct, ...]) (unsupported with tagged-union values).
 *     All assertions below use iter() + predicate.
 *   - Draft tables (CostSetDraftSynergy) are private (public: false) — cannot be
 *     read from the client subscription cache. Tests verify via PUBLIC live table
 *     after publish OR via the reducer not throwing on re-invoke.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    type TestHarness,
} from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';

describe.skipIf(!hasServerToken())('Phase 15.4 D-25a — synergy auction round-trip (first-ever)', () => {
    let admin: TestHarness;

    beforeAll(async () => {
        admin = await createVerifiedTestHarness();
        await promoteToRole(admin, 'Admin');
        await admin.sync(1000);
    }, 60_000);

    afterAll(async () => {
        await admin?.disconnect();
    });

    // ── Case 1: admin_bulk_upsert inserts an Auction synergy row ──────────

    it('admin_bulk_upsert inserts a synergy row with draftMode=Auction (direct write path)', async () => {
        const csId = 9801;
        await admin.call.adminBulkUpsert({
            tableName: 'HsrSynergyCost',
            jsonData: JSON.stringify([{
                sourceName: 'acheron',
                targetName: 'kafka',
                gameMode: 'MemoryOfChaos',
                draftMode: 'Auction',
                costModifier: 2.5,
                costSetId: csId,
            }]),
        });
        await admin.sync(1500);

        const found = [...admin.conn.db.HsrSynergyCost.iter()].filter(
            r => r.sourceName === 'acheron' &&
                 r.targetName === 'kafka' &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.draftMode.tag === 'Auction' &&
                 r.costSetId === csId
        );
        expect(found).toHaveLength(1);
        expect(found[0].draftMode.tag).toBe('Auction');
        expect(found[0].costModifier).toBeCloseTo(2.5, 5);
    });

    // ── Case 2: Classic + Auction coexist on identical (src, tgt, mode, csId) ─

    it('Classic and Auction rows for the same (source, target, mode, csId) coexist after bulk upsert', async () => {
        const csId = 9802;
        await admin.call.adminBulkUpsert({
            tableName: 'HsrSynergyCost',
            jsonData: JSON.stringify([
                {
                    sourceName: 'acheron',
                    targetName: 'kafka',
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Classic',
                    costModifier: 3.0,
                    costSetId: csId,
                },
                {
                    sourceName: 'acheron',
                    targetName: 'kafka',
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Auction',
                    costModifier: 1.0,
                    costSetId: csId,
                },
            ]),
        });
        await admin.sync(1500);

        const allForPair = [...admin.conn.db.HsrSynergyCost.iter()].filter(
            r => r.sourceName === 'acheron' &&
                 r.targetName === 'kafka' &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.costSetId === csId
        );
        expect(allForPair).toHaveLength(2);

        const tags = allForPair.map(r => r.draftMode.tag).sort();
        expect(tags).toEqual(['Auction', 'Classic']);

        const classic = allForPair.find(r => r.draftMode.tag === 'Classic')!;
        const auction = allForPair.find(r => r.draftMode.tag === 'Auction')!;
        expect(classic.costModifier).toBeCloseTo(3.0, 5);
        expect(auction.costModifier).toBeCloseTo(1.0, 5);
    });

    // ── Case 3: edit_draft_synergy_cost 5-tuple upsert (draft table is private) ──

    it('edit_draft_synergy_cost inserts and then updates a draft Auction row via 5-tuple match', async () => {
        // A fresh cost set gives us a private draft table to exercise without
        // collision. We cannot inspect CostSetDraftSynergy directly (private);
        // the round-trip verification is: (1) the reducer doesn't throw on
        // either call, (2) the updated value is the one that materializes to
        // live on publish.
        await admin.call.createCostSet({
            name: `D25a-edit-test-${Date.now()}`,
            sourceSetId: 0,
            gameModeTag: 'MemoryOfChaos',
        });
        await admin.sync(1500);

        const mine = [...admin.conn.db.CostSet.iter()]
            .filter(c => c.creatorId === admin.userId)
            .sort((a, b) => b.id - a.id);
        const cs = mine[0];
        expect(cs.isDraft).toBe(true);

        // Insert via editDraftSynergyCost (no pre-existing row → insert branch).
        await admin.call.editDraftSynergyCost({
            costSetId: cs.id,
            sourceName: 'acheron',
            targetName: 'kafka',
            gameModeTag: 'MemoryOfChaos',
            draftModeTag: 'Auction',
            costModifier: 1.25,
        });
        await admin.sync(800);

        // Second call — same 5-tuple, new modifier → update branch
        // (reducer finds the existing row via 5-tuple predicate).
        await admin.call.editDraftSynergyCost({
            costSetId: cs.id,
            sourceName: 'acheron',
            targetName: 'kafka',
            gameModeTag: 'MemoryOfChaos',
            draftModeTag: 'Auction',
            costModifier: 5.5,
        });
        await admin.sync(800);

        // Publish — the final live row value must be 5.5 (the update, not 1.25).
        // If the 5-tuple match missed draftMode, a second row with modifier=5.5
        // would have been inserted alongside the 1.25 row; we assert exactly 1
        // live Auction row after publish.
        await admin.call.publishCostSet({ costSetId: cs.id });
        await admin.sync(2500);

        const liveAuction = [...admin.conn.db.HsrSynergyCost.iter()].filter(
            r => r.sourceName === 'acheron' &&
                 r.targetName === 'kafka' &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.draftMode.tag === 'Auction' &&
                 r.costSetId === cs.id
        );
        expect(liveAuction).toHaveLength(1);
        expect(liveAuction[0].costModifier).toBeCloseTo(5.5, 5);

        // Cleanup
        await admin.call.lockCostSet({ costSetId: cs.id });
        await admin.sync(500);
        await admin.call.unpublishCostSet({ costSetId: cs.id });
        await admin.sync(500);
        await admin.call.deleteCostSet({ costSetId: cs.id });
        await admin.sync(500);
    }, 60_000);

    // ── Case 4: publish_cost_set materializes Auction draft row to live ───

    it('publish_cost_set materializes an Auction-only draft row to a live HsrSynergyCost row', async () => {
        // Create a fresh cost set, seed ONLY an Auction synergy draft row,
        // publish, and assert the live Auction row exists.
        await admin.call.createCostSet({
            name: `D25a-publish-test-${Date.now()}`,
            sourceSetId: 0,
            gameModeTag: 'ApocalypticShadow',
        });
        await admin.sync(1500);

        const mine = [...admin.conn.db.CostSet.iter()]
            .filter(c => c.creatorId === admin.userId)
            .sort((a, b) => b.id - a.id);
        const cs = mine[0];

        // Note: createCostSet already cloned any Auction synergy rows from
        // the default set (sourceSetId=0) with gameMode=ApocalypticShadow.
        // We add ONE MORE explicit Auction draft row on a distinct pair.
        await admin.call.editDraftSynergyCost({
            costSetId: cs.id,
            sourceName: 'feixiao',
            targetName: 'moze',
            gameModeTag: 'ApocalypticShadow',
            draftModeTag: 'Auction',
            costModifier: 7.75,
        });
        await admin.sync(800);

        await admin.call.publishCostSet({ costSetId: cs.id });
        await admin.sync(2500);

        // Assert: the specific Auction row we added materialized to live.
        const live = [...admin.conn.db.HsrSynergyCost.iter()].filter(
            r => r.sourceName === 'feixiao' &&
                 r.targetName === 'moze' &&
                 r.gameMode.tag === 'ApocalypticShadow' &&
                 r.draftMode.tag === 'Auction' &&
                 r.costSetId === cs.id
        );
        expect(live).toHaveLength(1);
        expect(live[0].costModifier).toBeCloseTo(7.75, 5);

        // Cleanup
        await admin.call.lockCostSet({ costSetId: cs.id });
        await admin.sync(500);
        await admin.call.unpublishCostSet({ costSetId: cs.id });
        await admin.sync(500);
        await admin.call.deleteCostSet({ costSetId: cs.id });
        await admin.sync(500);
    }, 60_000);

    // ── Sanity: `by_tuple` btree accessor is present on the client (structural) ──

    it('5-col by_tuple btree accessor is surfaced on the HsrSynergyCost client table', () => {
        // Structural presence — the index itself is declared in Plan 01 even if
        // the active admin write path uses iter() fallback (A2_FALLBACK_ITER).
        // Server-side reducers and future non-enum-struct filter paths use this.
        expect(typeof (admin.conn.db.HsrSynergyCost as any).by_tuple?.filter).toBe('function');
    });
});
