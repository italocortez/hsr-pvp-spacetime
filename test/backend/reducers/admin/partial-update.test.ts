/**
 * Phase 15, D-08/D-10 + Phase 15.4 D-19 — admin_bulk_upsert partial-update preservation.
 *
 * Wire convention under test (see spacetimedb/src/reducers/admin.ts):
 *   - Every EXPECTED_KEYS entry must appear in the incoming JSON row
 *     (validateKeys strict-key contract).
 *   - `null` on an EXISTING row = "preserve this field" (do not overwrite).
 *   - `null` on an INSERT row = "apply schema default" (required columns)
 *     OR "stay null" (optional columns: skelUrl, atlasUrl).
 *   - Non-null value = "set to this value".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Phase 15.4 note on cost-table partial-update granularity:
 *
 * Under the new draftMode-discriminated shape, the partial-update granularity
 * shrinks from (name, mode, costSetId) with dual struct columns to
 * (name, mode, draftMode, costSetId) with a SINGLE `costs` struct column. To
 * update only the Classic payload, send a row with draftMode='Classic'; to
 * update only Auction, send a separate row with draftMode='Auction'. The old
 * "send the paired struct column as null to preserve while updating its
 * sibling" pattern is no longer applicable — those are now two distinct rows
 * in the PK tuple, each with its own preserve-via-null semantics on the
 * single `costs` column.
 *
 * Valid preserve-via-null field on the new shape: the single `costs` column.
 * validateKeys requires `costs` to be present on every HsrCharacterCost row;
 * sending `costs: null` on an EXISTING row preserves the existing struct.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    queryPrivateTable,
    expectReducerError,
    type TestHarness,
} from '../../../shared/connection';
import { promoteToRole } from '../../../shared/helpers/promoteUser';

// Test data namespace to avoid collisions with seeded characters / lightcones.
const TEST_CHAR = 'pu-test-char';
const TEST_LC = 'pu-test-lc';

const fullEidolonCost = (base: number) => ({
    e0: base,
    e1: base + 1,
    e2: base + 2,
    e3: base + 3,
    e4: base + 4,
    e5: base + 5,
    e6: base + 6,
});

describe.skipIf(!hasServerToken())('admin_bulk_upsert — partial-update preservation (D-08/D-10 + 15.4 D-19)', () => {
    let admin: TestHarness;

    beforeAll(async () => {
        admin = await createVerifiedTestHarness();
        await promoteToRole(admin, 'Admin');
        await admin.sync(1000);

        // Parent character for cost rows.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacter',
            jsonData: JSON.stringify([{
                name: TEST_CHAR, displayName: 'PU Char', aliases: [], rarity: 5,
                path: 'Destruction', element: 'Physical', role: 'Dps',
                imageUrl: '', versionReleased: 1, treatAsVersion: 1,
                skelUrl: null, atlasUrl: null, atlasImgUrls: [],
                posX: 0, posY: 0, width: 0,
            }]),
        });
        await admin.sync(500);
    }, 60000);

    afterAll(async () => {
        await admin?.disconnect();
    });

    // ── Non-cost tables: baseline partial-update preservation ──────────────

    it('HsrCharacter: updating skelUrl alone preserves imageUrl, displayName, posX, etc.', async () => {
        // Seed a fully populated row.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacter',
            jsonData: JSON.stringify([{
                name: TEST_CHAR,
                displayName: 'Partial Update Test',
                aliases: ['alpha', 'beta'],
                rarity: 5,
                path: 'Destruction',
                element: 'Physical',
                role: 'Dps',
                imageUrl: 'https://img.orig',
                versionReleased: 1.0,
                treatAsVersion: 1.0,
                skelUrl: 'https://skel.orig',
                atlasUrl: 'https://atlas.orig',
                atlasImgUrls: ['a.png'],
                posX: 10,
                posY: 20,
                width: 300,
            }]),
        });
        await admin.sync(1000);

        // Partial update: change ONLY skelUrl; every other key is null.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacter',
            jsonData: JSON.stringify([{
                name: TEST_CHAR,
                displayName: null,
                aliases: null,
                rarity: null,
                path: null,
                element: null,
                role: null,
                imageUrl: null,
                versionReleased: null,
                treatAsVersion: null,
                skelUrl: 'https://skel.NEW',
                atlasUrl: null,
                atlasImgUrls: null,
                posX: null,
                posY: null,
                width: null,
            }]),
        });
        await admin.sync(1000);

        const rows = await queryPrivateTable(
            `SELECT * FROM hsr_character WHERE name = '${TEST_CHAR}'`
        );
        expect(rows.length).toBe(1);
        const row = rows[0];

        expect(row.skel_url).toContain('skel.NEW');
        expect(row.display_name).toContain('Partial Update Test');
        expect(row.image_url).toContain('img.orig');
        expect(row.atlas_url).toContain('atlas.orig');
        expect(Number(row.pos_x)).toBe(10);
        expect(Number(row.pos_y)).toBe(20);
        expect(Number(row.width)).toBe(300);
        expect(Number(row.rarity)).toBe(5);
    });

    it('HsrLightcone: partial update preserves unsent fields', async () => {
        await admin.call.adminBulkUpsert({
            tableName: 'HsrLightcone',
            jsonData: JSON.stringify([{
                name: TEST_LC,
                displayName: 'PU LC',
                aliases: ['lc-alpha'],
                path: 'Destruction',
                rarity: 5,
                imageUrl: 'https://lc.orig',
                posX: 5,
                posY: 15,
                width: 250,
            }]),
        });
        await admin.sync(1000);

        await admin.call.adminBulkUpsert({
            tableName: 'HsrLightcone',
            jsonData: JSON.stringify([{
                name: TEST_LC,
                displayName: null,
                aliases: null,
                path: null,
                rarity: null,
                imageUrl: 'https://lc.NEW',
                posX: null,
                posY: null,
                width: null,
            }]),
        });
        await admin.sync(1000);

        const rows = await queryPrivateTable(
            `SELECT * FROM hsr_lightcone WHERE name = '${TEST_LC}'`
        );
        expect(rows.length).toBe(1);
        const row = rows[0];
        expect(row.image_url).toContain('lc.NEW');
        expect(row.display_name).toContain('PU LC');
        expect(Number(row.pos_x)).toBe(5);
        expect(Number(row.pos_y)).toBe(15);
        expect(Number(row.width)).toBe(250);
        expect(Number(row.rarity)).toBe(5);
    });

    it('Insert branch applies schema defaults when fields null on NEW row', async () => {
        const INSERT_CHAR = 'pu-insert-defaults';
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacter',
            jsonData: JSON.stringify([{
                name: INSERT_CHAR,
                displayName: null,
                aliases: null,
                rarity: null,
                path: 'Destruction',
                element: 'Physical',
                role: 'Dps',
                imageUrl: null,
                versionReleased: null,
                treatAsVersion: null,
                skelUrl: null,
                atlasUrl: null,
                atlasImgUrls: null,
                posX: null,
                posY: null,
                width: null,
            }]),
        });
        await admin.sync(1000);

        const rows = await queryPrivateTable(
            `SELECT * FROM hsr_character WHERE name = '${INSERT_CHAR}'`
        );
        expect(rows.length).toBe(1);
        const row = rows[0];
        const displayName = String(row.display_name).replace(/^"|"$/g, '');
        expect(displayName).toBe('');
        expect(Number(row.rarity)).toBe(0);
        expect(Number(row.pos_x)).toBe(0);
        expect(Number(row.pos_y)).toBe(0);
        expect(Number(row.width)).toBe(0);
    });

    // ── 15.4 D-19: cost-table partial-update (single `costs` column) ───────

    it('15.4 D-19: HsrCharacterCost — null costs on UPDATE preserves existing struct', async () => {
        const costSetId = 9994;

        const initialClassic = { e0: 5, e1: 6, e2: 7, e3: 8, e4: 9, e5: 10, e6: 20 };

        // Pre-insert Classic row with populated costs.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: TEST_CHAR,
                gameMode: 'MemoryOfChaos',
                draftMode: 'Classic',
                costs: initialClassic,
                costSetId,
            }]),
        });
        await admin.sync(1000);

        // Partial update: same tuple, send costs: null — D-08 "preserve existing" signal.
        // The row already exists, so null-on-update must NOT zero or drop the column.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: TEST_CHAR,
                gameMode: 'MemoryOfChaos',
                draftMode: 'Classic',
                costs: null,  // preserve existing
                costSetId,
            }]),
        });
        await admin.sync(1500);

        const row = [...admin.conn.db.HsrCharacterCost.iter()].find(
            r => r.characterName === TEST_CHAR &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.draftMode.tag === 'Classic' &&
                 r.costSetId === costSetId
        );

        expect(row).toBeDefined();
        expect(row!.costs.e0).toBe(5);     // Preserved, not zeroed.
        expect(row!.costs.e6).toBe(20);
    }, 60_000);

    it('15.4 D-19: Classic and Auction rows preserve independently (per-draftMode granularity)', async () => {
        const costSetId = 9995;

        // Seed BOTH Classic and Auction rows for same (char, mode, csId).
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([
                {
                    characterName: TEST_CHAR,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Classic',
                    costs: fullEidolonCost(100),
                    costSetId,
                },
                {
                    characterName: TEST_CHAR,
                    gameMode: 'MemoryOfChaos',
                    draftMode: 'Auction',
                    costs: fullEidolonCost(500),
                    costSetId,
                },
            ]),
        });
        await admin.sync(1000);

        // Update ONLY Classic — send an explicit new Classic row.
        // Auction row is never sent — remains untouched at 500-series values.
        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: TEST_CHAR,
                gameMode: 'MemoryOfChaos',
                draftMode: 'Classic',
                costs: fullEidolonCost(200),
                costSetId,
            }]),
        });
        await admin.sync(1500);

        const rows = [...admin.conn.db.HsrCharacterCost.iter()].filter(
            r => r.characterName === TEST_CHAR &&
                 r.gameMode.tag === 'MemoryOfChaos' &&
                 r.costSetId === costSetId
        );
        expect(rows).toHaveLength(2);

        const classic = rows.find(r => r.draftMode.tag === 'Classic')!;
        const auction = rows.find(r => r.draftMode.tag === 'Auction')!;

        // Classic updated to 200-series.
        expect(classic.costs.e0).toBe(200);
        expect(classic.costs.e6).toBe(206);
        // Auction untouched — preserved at 500-series (D-19 per-draftMode granularity).
        expect(auction.costs.e0).toBe(500);
        expect(auction.costs.e6).toBe(506);
    }, 60_000);

    it('15.4 D-19: mergeForUpdate replaces `costs` struct wholesale when non-null (no field-level merge inside struct)', async () => {
        const costSetId = 9996;

        const initial = { e0: 11, e1: 12, e2: 13, e3: 14, e4: 15, e5: 16, e6: 17 };
        const replacement = { e0: 111, e1: 112, e2: 113, e3: 114, e4: 115, e5: 116, e6: 117 };

        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: TEST_CHAR,
                gameMode: 'AnomalyArbitration',
                draftMode: 'Classic',
                costs: initial,
                costSetId,
            }]),
        });
        await admin.sync(1000);

        await admin.call.adminBulkUpsert({
            tableName: 'HsrCharacterCost',
            jsonData: JSON.stringify([{
                characterName: TEST_CHAR,
                gameMode: 'AnomalyArbitration',
                draftMode: 'Classic',
                costs: replacement,
                costSetId,
            }]),
        });
        await admin.sync(1500);

        const row = [...admin.conn.db.HsrCharacterCost.iter()].find(
            r => r.characterName === TEST_CHAR &&
                 r.gameMode.tag === 'AnomalyArbitration' &&
                 r.draftMode.tag === 'Classic' &&
                 r.costSetId === costSetId
        );

        expect(row).toBeDefined();
        // Full struct replacement — every field swapped.
        expect(row!.costs.e0).toBe(111);
        expect(row!.costs.e1).toBe(112);
        expect(row!.costs.e6).toBe(117);
    }, 60_000);

    // ── 15.4 D-19: missing-draftMode rejection (validateKeys) ──────────────

    it('15.4 D-19: admin_bulk_upsert rejects HsrCharacterCost rows with missing `draftMode` key', async () => {
        // validateKeys enforces the exact key set on every incoming row. Under
        // the new schema, `draftMode` is a required column, so omitting it MUST
        // be rejected before any tuple-match or insert logic runs. This is the
        // regression guard that Auction rows can't accidentally leak into the
        // Classic lane (or vice versa) just because the caller forgot the key.
        const err = await expectReducerError(
            admin.call.adminBulkUpsert({
                tableName: 'HsrCharacterCost',
                jsonData: JSON.stringify([{
                    characterName: TEST_CHAR,
                    gameMode: 'MemoryOfChaos',
                    // draftMode OMITTED — validateKeys must reject.
                    costs: fullEidolonCost(1),
                    costSetId: 9997,
                }]),
            })
        );
        expect(err).toMatch(/draftMode|key mismatch/i);
    });

    it('15.4 D-19: admin_bulk_upsert rejects HsrLightconeCost rows with missing `draftMode` key', async () => {
        const err = await expectReducerError(
            admin.call.adminBulkUpsert({
                tableName: 'HsrLightconeCost',
                jsonData: JSON.stringify([{
                    lightconeName: TEST_LC,
                    gameMode: 'MemoryOfChaos',
                    // draftMode OMITTED
                    costs: { s1: 1, s2: 1, s3: 1, s4: 1, s5: 1 },
                    costSetId: 9998,
                }]),
            })
        );
        expect(err).toMatch(/draftMode|key mismatch/i);
    });

    it('15.4 D-19: admin_bulk_upsert rejects HsrSynergyCost rows with missing `draftMode` key', async () => {
        const err = await expectReducerError(
            admin.call.adminBulkUpsert({
                tableName: 'HsrSynergyCost',
                jsonData: JSON.stringify([{
                    sourceName: 'cs-test-src',
                    targetName: 'cs-test-tgt',
                    gameMode: 'MemoryOfChaos',
                    // draftMode OMITTED
                    costModifier: 1.0,
                    costSetId: 9999,
                }]),
            })
        );
        expect(err).toMatch(/draftMode|key mismatch/i);
    });
});
