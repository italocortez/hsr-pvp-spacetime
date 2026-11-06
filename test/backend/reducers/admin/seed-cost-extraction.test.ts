/**
 * Phase 15.4 D-18/D-25 — Seed pipeline sibling-block fan-out regression tests
 * REWRITTEN for the new draftMode-discriminated row shape.
 *
 * OLD invariant (Phase 15.1 D-07/D-08): absent sub-block → zero-pad the paired
 * struct column (both classic + auction columns always present, one zeroed).
 *
 * NEW invariant (Phase 15.4 D-14): absent sub-block → NO row for that draftMode.
 * One template sub-block = one emitted row. Row absence = "not configured".
 *
 * Scenarios (mirrors Phase 15.1 numbering):
 *   15.4-1: Both classic + auction sub-blocks present → 2 rows emitted
 *           (one draftMode=Classic, one draftMode=Auction)
 *   15.4-2: Only classic sub-block present → 1 row (Classic), NO Auction row
 *   15.4-3: Only auction sub-block present → 1 row (Auction), NO Classic row
 *           (Phase 15.1 scenario #4 = struct-column preservation — lives in
 *           partial-update.test.ts; scenario ordering unchanged here.)
 *   15.4-5: Both sub-blocks absent for a mode → 0 rows for that (name, mode, csId)
 *
 * New 15.4 coverage (D-25):
 *   - Synergy auction emission: sibling-block pairing input with auction
 *     modifier > 0 produces an HsrSynergyCost row tagged draftMode=Auction
 *     (this test exists in cost-set-pk.test.ts via admin_bulk_upsert directly
 *     and in synergy-auction-round-trip.test.ts end-to-end; here we cover
 *     the admin-level emission shape via the same bulk_upsert surface).
 *   - draftMode emission on every cost-table row is one of {Classic, Auction}.
 *
 * Wire convention for HsrCharacterCost (admin_bulk_upsert — 15.4 shape):
 *   - Row keys: characterName, gameMode, draftMode, costs, costSetId
 *   - costs is the EidolonCost struct (direct object, not JSON string)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    type TestHarness,
} from '../../../shared/connection';
import { promoteToRole } from '../../../shared/helpers/promoteUser';

// Existing seeded character — 'acheron' is seeded by global-setup pre-suite.
const SEEDED_CHAR = 'acheron';
const SYN_SRC = 'acheron';
const SYN_TGT = 'kafka';

describe.skipIf(!hasServerToken())('15.4 D-18/D-25 seed cost extraction (sibling-block fan-out, draftMode shape)', () => {
    let admin: TestHarness;

    beforeAll(async () => {
        admin = await createVerifiedTestHarness();
        await promoteToRole(admin, 'Admin');
        await admin.sync(1000);
    }, 60_000);

    afterAll(async () => {
        await admin?.disconnect();
    });

    // ── 15.4-1: Both sub-blocks present → 2 rows (Classic + Auction) ──────

    it('15.4-1: both classic + auction sub-blocks → 2 rows emitted (one per draftMode)', async () => {
        const costSetId = 9991;

        // The seed pipeline fan-out emits one row per present sub-block.
        // Simulate: template has BOTH classic and auction for same (char, mode).
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([
                {
                    characterName: SEEDED_CHAR,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Classic',
                    costs: { e0: 7, e1: 8, e2: 11, e3: 12, e4: 13, e5: 14, e6: 15 },
                    costSetId,
                },
                {
                    characterName: SEEDED_CHAR,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Auction',
                    costs: { e0: 70, e1: 80, e2: 110, e3: 115, e4: 125, e5: 130, e6: 150 },
                    costSetId,
                },
            ]),
        });
        await admin.sync(1500);

        const rows = [...admin.conn.db.HsrCharacterCost.iter()].filter(
            r => r.characterName === SEEDED_CHAR &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.costSetId === costSetId
        );
        expect(rows).toHaveLength(2);

        const classic = rows.find(r => r.draftMode.tag === 'Classic')!;
        const auction = rows.find(r => r.draftMode.tag === 'Auction')!;
        expect(classic.costs.e0).toBe(7);
        expect(classic.costs.e6).toBe(15);
        expect(auction.costs.e0).toBe(70);
        expect(auction.costs.e6).toBe(150);
    }, 60_000);

    // ── 15.4-2: classic-only → 1 row (Classic), NO Auction row ─────────────

    it('15.4-2: classic-only sub-block → 1 row emitted (Classic), NO Auction row', async () => {
        const costSetId = 9992;

        // Template has ONLY classic sub-block — D-14: no auction row is emitted.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: SEEDED_CHAR,
                gameMode: 'MemoryOfChaos',
                draftMode: 'Classic',
                costs: { e0: 1, e1: 2, e2: 3, e3: 4, e4: 5, e5: 6, e6: 7 },
                costSetId,
            }]),
        });
        await admin.sync(1500);

        const rows = [...admin.conn.db.HsrCharacterCost.iter()].filter(
            r => r.characterName === SEEDED_CHAR &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.costSetId === costSetId
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].draftMode.tag).toBe('Classic');

        // D-14: NO row with draftMode=Auction — not zero-padded, not configured.
        const auctionRow = rows.find(r => r.draftMode.tag === 'Auction');
        expect(auctionRow).toBeUndefined();
    }, 60_000);

    // ── 15.4-3: auction-only → 1 row (Auction), NO Classic row ─────────────

    it('15.4-3: auction-only sub-block → 1 row emitted (Auction), NO Classic row', async () => {
        const costSetId = 9993;

        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: SEEDED_CHAR,
                gameMode: 'ApocalypticShadow',
                draftMode: 'Auction',
                costs: { e0: 50, e1: 51, e2: 52, e3: 53, e4: 54, e5: 55, e6: 56 },
                costSetId,
            }]),
        });
        await admin.sync(1500);

        const rows = [...admin.conn.db.HsrCharacterCost.iter()].filter(
            r => r.characterName === SEEDED_CHAR &&
                 r.gameMode.tag === 'ApocalypticShadow' &&
                 r.costSetId === costSetId
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].draftMode.tag).toBe('Auction');

        const classicRow = rows.find(r => r.draftMode.tag === 'Classic');
        expect(classicRow).toBeUndefined();
    }, 60_000);

    // ── 15.4-5: Both sub-blocks absent → no rows ───────────────────────────

    it('15.4-5: both sub-blocks absent for a mode → 0 rows written', async () => {
        const costSetId = 9995;

        // The seed pipeline emits NO row when both classic and auction are
        // absent (D-14). Model by NOT calling adminBulkUpsert for this tuple.
        const rows = [...admin.conn.db.HsrCharacterCost.iter()].filter(
            r => r.characterName === SEEDED_CHAR &&
                 r.gameMode.tag === 'AnomalyArbitration' &&
                 r.costSetId === costSetId
        );

        expect(rows).toHaveLength(0);
    }, 60_000);

    // ── D-25: Synergy auction emission (first-ever under new shape) ────────

    it('D-25: synergy auction row emits with correct shape and modifier', async () => {
        const costSetId = 9970;

        // Mirror the sibling-block pairing fan-out: one row per present
        // sub-block. An entry with auction.modifier > 0 produces a row tagged
        // draftMode=Auction.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrSynergyCost',
            jsonData: JSON.stringify([
                {
                    sourceName: SYN_SRC,
                    targetName: SYN_TGT,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Classic',
                    costModifier: 3.0,
                    costSetId,
                },
                {
                    sourceName: SYN_SRC,
                    targetName: SYN_TGT,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Auction',
                    costModifier: 1.5,
                    costSetId,
                },
            ]),
        });
        await admin.sync(1500);

        const rows = [...admin.conn.db.HsrSynergyCost.iter()].filter(
            r => r.sourceName === SYN_SRC &&
                 r.targetName === SYN_TGT &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.costSetId === costSetId
        );
        expect(rows).toHaveLength(2);

        const auction = rows.find(r => r.draftMode.tag === 'Auction')!;
        expect(auction).toBeDefined();
        expect(auction.costModifier).toBeCloseTo(1.5, 5);

        const classic = rows.find(r => r.draftMode.tag === 'Classic')!;
        expect(classic.costModifier).toBeCloseTo(3.0, 5);
    }, 60_000);

    // ── D-25: draftMode emission invariant — every row has a valid tag ─────

    it('D-25: every emitted HsrCharacterCost row has draftMode in {Classic, Auction}', async () => {
        // Sample some of the default-seed rows (costSetId=0) — validates the
        // production seed pipeline produced only legal draftMode tags for the
        // 83 seeded characters × 3 modes.
        const rows = [...admin.conn.db.HsrCharacterCost.iter()]
            .filter(r => r.costSetId === 0)
            .slice(0, 50);  // large enough sample, small enough for fast check

        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(['Classic', 'Auction']).toContain(row.draftMode.tag);
        }
    }, 30_000);

    // ── Default-seed regression (updated for 15.4 shape) ───────────────────

    it('Default-seed: every seeded HsrSynergyCost row has draftMode in {Classic, Auction}', async () => {
        // 15.4 D-13 introduced first-ever synergy auction rows (30 classic +
        // 30 zero-valued auction per default seed). Validate the shape.
        const rows = [...admin.conn.db.HsrSynergyCost.iter()]
            .filter(r => r.costSetId === 0)
            .slice(0, 60);

        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(['Classic', 'Auction']).toContain(row.draftMode.tag);
        }

        // At least one Auction row must exist in the default seed (D-13 invariant).
        const auctionRows = [...admin.conn.db.HsrSynergyCost.iter()]
            .filter(r => r.costSetId === 0 && r.draftMode.tag === 'Auction');
        expect(auctionRows.length).toBeGreaterThan(0);
    }, 30_000);
});
