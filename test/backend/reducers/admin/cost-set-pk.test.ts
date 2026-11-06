/**
 * Phase 15.4 D-24 / D-25b — PK tuple distinction under the new draftMode shape.
 *
 * Regression guards:
 *   1. 4-tuple char/lc PK (characterName|lightconeName, gameMode, draftMode, costSetId)
 *      distinguishes Classic vs Auction rows that share all other axes.
 *   2. 5-tuple synergy PK (sourceName, targetName, gameMode, draftMode, costSetId)
 *      distinguishes Classic vs Auction rows for the same pairing.
 *   3. admin_bulk_upsert tuple match INCLUDES draftMode — Pitfall 1 regression
 *      (Classic and Auction rows for the same (name, mode, csId) must NOT
 *      silently overwrite each other).
 *   4. Distinct costSetId rows still coexist (carried forward from pre-15.4 scope).
 *
 * Implementation reality (per 15.4-01 SUMMARY `A2_FALLBACK_ITER` decision):
 * the active admin-write path uses iter() + predicate; the 4/5-col btree
 * accessors are structurally declared but not exercised server-side for enum
 * struct filtering (unsupported in bindings). The tests below assert via the
 * same iter() + predicate pattern so the test correctness is independent of
 * the implementation route.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    queryPrivateTable,
    type TestHarness,
} from '../../../shared/connection';
import { promoteToRole } from '../../../shared/helpers/promoteUser';

// Distinct namespaces to avoid collision with seeded data.
const TEST_CHAR = 'cs-test-char';
const TEST_LC = 'cs-test-lc';
const TEST_SRC = 'cs-test-src';
const TEST_TGT = 'cs-test-tgt';

const eidolonCost = (base: number) => ({
    e0: base, e1: base, e2: base, e3: base, e4: base, e5: base, e6: base,
});

const superpositionCost = (base: number) => ({
    s1: base, s2: base, s3: base, s4: base, s5: base,
});

describe.skipIf(!hasServerToken())('admin_bulk_upsert — PK tuple isolation with draftMode (15.4 D-25b)', () => {
    let admin: TestHarness;

    beforeAll(async () => {
        admin = await createVerifiedTestHarness();
        await promoteToRole(admin, 'Admin');
        await admin.sync(1000);

        // Ensure parent rows exist so the cost rows are well-formed.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacter',
            jsonData: JSON.stringify([{
                name: TEST_CHAR, displayName: 'CS', aliases: [], rarity: 5,
                path: 'Destruction', element: 'Physical', role: 'Dps',
                imageUrl: '', versionReleased: 1, treatAsVersion: 1,
                skelUrl: null, atlasUrl: null, atlasImgUrls: [],
                posX: 0, posY: 0, width: 0,
            }, {
                name: TEST_SRC, displayName: 'CS Src', aliases: [], rarity: 5,
                path: 'Destruction', element: 'Physical', role: 'Dps',
                imageUrl: '', versionReleased: 1, treatAsVersion: 1,
                skelUrl: null, atlasUrl: null, atlasImgUrls: [],
                posX: 0, posY: 0, width: 0,
            }, {
                name: TEST_TGT, displayName: 'CS Tgt', aliases: [], rarity: 5,
                path: 'Destruction', element: 'Physical', role: 'Dps',
                imageUrl: '', versionReleased: 1, treatAsVersion: 1,
                skelUrl: null, atlasUrl: null, atlasImgUrls: [],
                posX: 0, posY: 0, width: 0,
            }]),
        });
        await admin.call.adminBulkUpsert({
            tableName: 'HsrLightcone',
            jsonData: JSON.stringify([{
                name: TEST_LC, displayName: 'CS LC', aliases: [],
                path: 'Destruction', rarity: 5, imageUrl: '',
                posX: 0, posY: 0, width: 0,
            }]),
        });
        await admin.sync(1000);
    }, 60000);

    afterAll(async () => {
        await admin?.disconnect();
    });

    // ── Killer test 1: char 4-tuple — Classic + Auction coexist ──────────────
    it('HsrCharacterCost: same (name, mode, csId) with Classic + Auction draftMode → 2 rows', async () => {
        const csId = 9100;  // isolation-only
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([
                {
                    characterName: TEST_CHAR,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Classic',
                    costs: eidolonCost(10),
                    costSetId: csId,
                },
                {
                    characterName: TEST_CHAR,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Auction',
                    costs: eidolonCost(99),
                    costSetId: csId,
                },
            ]),
        });
        await admin.sync(1500);

        // iter() + predicate (the 4-tuple is the point) — both rows must exist.
        const rows = [...admin.conn.db.HsrCharacterCost.iter()].filter(
            r => r.characterName === TEST_CHAR &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.costSetId === csId
        );
        expect(rows).toHaveLength(2);

        const tags = rows.map(r => r.draftMode.tag).sort();
        expect(tags).toEqual(['Auction', 'Classic']);

        // Row values preserved per draftMode (no collision).
        const classic = rows.find(r => r.draftMode.tag === 'Classic')!;
        const auction = rows.find(r => r.draftMode.tag === 'Auction')!;
        expect(classic.costs.e0).toBe(10);
        expect(auction.costs.e0).toBe(99);
    });

    // ── Killer test 2: lc 4-tuple — Classic + Auction coexist ────────────────
    it('HsrLightconeCost: same (name, mode, csId) with Classic + Auction draftMode → 2 rows', async () => {
        const csId = 9101;
        await admin.call.adminBulkUpsert({
            tableName: 'HsrLightconeCost',
            jsonData: JSON.stringify([
                {
                    lightconeName: TEST_LC,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Classic',
                    costs: superpositionCost(3),
                    costSetId: csId,
                },
                {
                    lightconeName: TEST_LC,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Auction',
                    costs: superpositionCost(77),
                    costSetId: csId,
                },
            ]),
        });
        await admin.sync(1500);

        const rows = [...admin.conn.db.HsrLightconeCost.iter()].filter(
            r => r.lightconeName === TEST_LC &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.costSetId === csId
        );
        expect(rows).toHaveLength(2);

        const classic = rows.find(r => r.draftMode.tag === 'Classic')!;
        const auction = rows.find(r => r.draftMode.tag === 'Auction')!;
        expect(classic.costs.s1).toBe(3);
        expect(auction.costs.s1).toBe(77);
    });

    // ── Killer test 3: synergy 5-tuple (D-07) — Classic + Auction coexist ────
    it('HsrSynergyCost: same (source, target, mode, csId) with Classic + Auction → 2 rows', async () => {
        const csId = 9102;
        await admin.call.adminBulkUpsert({
            tableName: 'HsrSynergyCost',
            jsonData: JSON.stringify([
                {
                    sourceName: TEST_SRC,
                    targetName: TEST_TGT,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Classic',
                    costModifier: 0.5,
                    costSetId: csId,
                },
                {
                    sourceName: TEST_SRC,
                    targetName: TEST_TGT,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Auction',
                    costModifier: 1.5,
                    costSetId: csId,
                },
            ]),
        });
        await admin.sync(1500);

        const rows = [...admin.conn.db.HsrSynergyCost.iter()].filter(
            r => r.sourceName === TEST_SRC &&
                 r.targetName === TEST_TGT &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.costSetId === csId
        );
        expect(rows).toHaveLength(2);

        const tags = rows.map(r => r.draftMode.tag).sort();
        expect(tags).toEqual(['Auction', 'Classic']);

        const classic = rows.find(r => r.draftMode.tag === 'Classic')!;
        const auction = rows.find(r => r.draftMode.tag === 'Auction')!;
        expect(classic.costModifier).toBeCloseTo(0.5, 5);
        expect(auction.costModifier).toBeCloseTo(1.5, 5);
    });

    // ── Pitfall 1 regression — same 4-tuple overwrites itself, NOT its sibling
    it('Pitfall 1: two Classic rows for same (char, mode, draftMode, csId) → 1 row (the update); Auction sibling untouched', async () => {
        const csId = 9103;

        // Initial state: one Classic + one Auction row.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([
                {
                    characterName: TEST_CHAR,
                    gameMode: 'ApocalypticShadow',
                    draftMode: 'Classic',
                    costs: eidolonCost(1),
                    costSetId: csId,
                },
                {
                    characterName: TEST_CHAR,
                    gameMode: 'ApocalypticShadow',
                    draftMode: 'Auction',
                    costs: eidolonCost(42),
                    costSetId: csId,
                },
            ]),
        });
        await admin.sync(1000);

        // Upsert a single Classic row with new values — MUST update-in-place,
        // NOT collide with the Auction row.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: TEST_CHAR,
                gameMode: 'ApocalypticShadow',
                draftMode: 'Classic',
                costs: eidolonCost(777),
                costSetId: csId,
            }]),
        });
        await admin.sync(1500);

        const rows = [...admin.conn.db.HsrCharacterCost.iter()].filter(
            r => r.characterName === TEST_CHAR &&
                 r.gameMode.tag === 'ApocalypticShadow' &&
                 r.costSetId === csId
        );
        expect(rows).toHaveLength(2);  // Still 2 — tuple match kept them separate.

        const classic = rows.find(r => r.draftMode.tag === 'Classic')!;
        const auction = rows.find(r => r.draftMode.tag === 'Auction')!;
        expect(classic.costs.e0).toBe(777);   // Classic updated.
        expect(auction.costs.e0).toBe(42);    // Auction untouched — the Pitfall 1 guard.
    });

    // ── Pitfall 1 regression — synergy 5-tuple, same scenario ────────────────
    it('Pitfall 1 synergy: upserting the Classic row does NOT collide with the Auction sibling', async () => {
        const csId = 9104;

        await admin.call.adminBulkUpsert({
            tableName: 'HsrSynergyCost',
            jsonData: JSON.stringify([
                {
                    sourceName: TEST_SRC,
                    targetName: TEST_TGT,
                    gameMode: 'ApocalypticShadow',
                    draftMode: 'Classic',
                    costModifier: 0.1,
                    costSetId: csId,
                },
                {
                    sourceName: TEST_SRC,
                    targetName: TEST_TGT,
                    gameMode: 'ApocalypticShadow',
                    draftMode: 'Auction',
                    costModifier: 9.9,
                    costSetId: csId,
                },
            ]),
        });
        await admin.sync(1000);

        await admin.call.adminBulkUpsert({
            tableName: 'HsrSynergyCost',
            jsonData: JSON.stringify([{
                sourceName: TEST_SRC,
                targetName: TEST_TGT,
                gameMode: 'ApocalypticShadow',
                draftMode: 'Classic',
                costModifier: 0.25,
                costSetId: csId,
            }]),
        });
        await admin.sync(1500);

        const rows = [...admin.conn.db.HsrSynergyCost.iter()].filter(
            r => r.sourceName === TEST_SRC &&
                 r.targetName === TEST_TGT &&
                 r.gameMode.tag === 'ApocalypticShadow' &&
                 r.costSetId === csId
        );
        expect(rows).toHaveLength(2);
        const classic = rows.find(r => r.draftMode.tag === 'Classic')!;
        const auction = rows.find(r => r.draftMode.tag === 'Auction')!;
        expect(classic.costModifier).toBeCloseTo(0.25, 5);
        expect(auction.costModifier).toBeCloseTo(9.9, 5);  // Untouched.
    });

    // ── btree accessor structural presence (D-07 / D-08) ─────────────────────
    it('btree index accessors are surfaced on the client db object', () => {
        // The btrees were added in 15.4-01 Plan (4-col char/lc + 5-col synergy).
        // Even though server-side admin path uses iter() fallback per A2_FALLBACK_ITER,
        // the accessors must exist so subscriptions/views can reach them.
        expect(typeof (admin.conn.db.HsrCharacterCost as any).by_character_mode_and_set?.filter)
            .toBe('function');
        expect(typeof (admin.conn.db.HsrLightconeCost as any).by_lightcone_mode_and_set?.filter)
            .toBe('function');
        expect(typeof (admin.conn.db.HsrSynergyCost as any).by_tuple?.filter)
            .toBe('function');
    });

    // ── costSetId isolation (carried forward from pre-15.4) ──────────────────
    it('HsrCharacterCost: distinct costSetId rows coexist for same (name, mode, draftMode)', async () => {
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([
                {
                    characterName: TEST_CHAR,
                    gameMode: 'AnomalyArbitration',
                    draftMode: 'Classic',
                    costs: eidolonCost(20),
                    costSetId: 0,
                },
                {
                    characterName: TEST_CHAR,
                    gameMode: 'AnomalyArbitration',
                    draftMode: 'Classic',
                    costs: eidolonCost(30),
                    costSetId: 5,
                },
            ]),
        });
        await admin.sync(1500);

        const rows = await queryPrivateTable(
            `SELECT cost_set_id FROM hsr_character_cost WHERE character_name = '${TEST_CHAR}'`
        );
        const setIds = rows.map(r => Number(r.cost_set_id));
        expect(setIds).toContain(0);
        expect(setIds).toContain(5);
    });

    it('Re-seeding default-set row does NOT overwrite a pre-existing non-default row (legacy regression)', async () => {
        // Seed a custom cost set first.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: TEST_CHAR,
                gameMode: 'MemoryOfChaos',
                draftMode: 'Classic',
                costs: eidolonCost(99),
                costSetId: 5,
            }]),
        });
        await admin.sync(500);

        // Then upsert the default set (costSetId=0) for the same (char, mode, draftMode).
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: TEST_CHAR,
                gameMode: 'MemoryOfChaos',
                draftMode: 'Classic',
                costs: eidolonCost(1),
                costSetId: 0,
            }]),
        });
        await admin.sync(1500);

        // The costSetId=5 row must still exist with its custom values untouched.
        const set5 = [...admin.conn.db.HsrCharacterCost.iter()].filter(
            r => r.characterName === TEST_CHAR &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.draftMode.tag === 'Classic' &&
                 r.costSetId === 5
        );
        expect(set5).toHaveLength(1);
        expect(set5[0].costs.e0).toBe(99);  // Preserved.
    });
});
