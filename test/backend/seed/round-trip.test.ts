/**
 * Phase 15 D-21a + Phase 15.4 D-14/D-25 — post-publish.ts reseed round-trip.
 *
 * The integration-suite global setup (test/global-setup.ts) runs
 * `spacetime publish --clear-database` + `npx tsx scripts/post-publish.ts` once
 * before the suite. This test asserts the resulting state on maincloud — i.e.
 * the Plan 03 seed rewrite (sibling-block fan-out with one-row-per-sub-block
 * and draftMode emission) honors the D-22 canonical template shape end-to-end
 * against the Plan 01 schema and Plan 02 router.
 *
 * 15.4 assertions layered on top of 15 D-21a:
 *   - Every cost-table row carries a valid draftMode ∈ {Classic, Auction}.
 *   - HsrSynergyCost has BOTH Classic and Auction rows in the default seed
 *     (D-13: first-ever synergy auction rows, zero-valued modifiers).
 *   - Character and lightcone cost round-trip preserves `costs` struct + draftMode.
 *
 * Assertions target invariants (row shape, column presence, 3-mode count,
 * draftMode tag membership) rather than exact row totals, because the seeded
 * data files evolve independently (characters_table.json grows with patches).
 */

import { describe, it, expect } from 'vitest';
import { hasServerToken, queryPrivateTable } from '../../shared/connection';

describe.skipIf(!hasServerToken())('Phase 15 + 15.4 seed round-trip — clean DB reseed (D-21a / D-14 / D-25)', () => {
    it('HsrCharacter rows have Spine + positioning columns populated (D-05, D-05a)', async () => {
        const rows = await queryPrivateTable(
            `SELECT name, skel_url, atlas_url, atlas_img_urls, pos_x, pos_y, width FROM hsr_character LIMIT 10`
        );
        expect(rows.length).toBeGreaterThan(0);

        for (const r of rows) {
            expect(r.pos_x).toBeDefined();
            expect(r.pos_y).toBeDefined();
            expect(r.width).toBeDefined();
            expect(Number.isFinite(Number(r.pos_x))).toBe(true);
            expect(Number.isFinite(Number(r.pos_y))).toBe(true);
            expect(Number.isFinite(Number(r.width))).toBe(true);
            expect(r.skel_url).toBeDefined();
            expect(r.atlas_url).toBeDefined();
            expect(r.atlas_img_urls).toBeDefined();
        }
    });

    it('HsrCharacterCost has all 3 game modes (D-22 3-mode fan-out)', async () => {
        const rows = await queryPrivateTable(
            `SELECT game_mode FROM hsr_character_cost LIMIT 300`
        );
        const modesStr = rows.map(r => String(r.game_mode)).join(' ').toLowerCase();
        expect(modesStr).toContain('memoryofchaos');
        expect(modesStr).toContain('apocalypticshadow');
        expect(modesStr).toContain('anomalyarbitration');
        expect(rows.length).toBeGreaterThan(0);
    });

    it('HsrLightconeCost has 3 game modes', async () => {
        const rows = await queryPrivateTable(
            `SELECT game_mode FROM hsr_lightcone_cost LIMIT 300`
        );
        const modesStr = rows.map(r => String(r.game_mode)).join(' ').toLowerCase();
        expect(modesStr).toContain('memoryofchaos');
        expect(modesStr).toContain('apocalypticshadow');
        expect(modesStr).toContain('anomalyarbitration');
        expect(rows.length).toBeGreaterThan(0);
    });

    it('HsrSynergyCost has 3 game modes (pairing fan-out covers anomaly_arbitration)', async () => {
        const rows = await queryPrivateTable(
            `SELECT game_mode FROM hsr_synergy_cost LIMIT 300`
        );
        const modesStr = rows.map(r => String(r.game_mode)).join(' ').toLowerCase();
        expect(modesStr).toContain('memoryofchaos');
        expect(modesStr).toContain('apocalypticshadow');
        expect(modesStr).toContain('anomalyarbitration');
        expect(rows.length).toBeGreaterThan(0);
    });

    it('costSetId=0 is the default sentinel present in all three cost tables', async () => {
        const charDefaults = await queryPrivateTable(
            `SELECT COUNT(*) AS c FROM hsr_character_cost WHERE cost_set_id = 0`
        );
        const lcDefaults = await queryPrivateTable(
            `SELECT COUNT(*) AS c FROM hsr_lightcone_cost WHERE cost_set_id = 0`
        );
        const synDefaults = await queryPrivateTable(
            `SELECT COUNT(*) AS c FROM hsr_synergy_cost WHERE cost_set_id = 0`
        );
        expect(Number(charDefaults[0]?.c ?? 0)).toBeGreaterThan(0);
        expect(Number(lcDefaults[0]?.c ?? 0)).toBeGreaterThan(0);
        expect(Number(synDefaults[0]?.c ?? 0)).toBeGreaterThan(0);
    });

    // ── 15.4 D-14 / D-25: draftMode emission through normalize→bulk_upsert→DB ──

    it('15.4 D-14: HsrCharacterCost default-seed rows carry draftMode in {Classic, Auction}', async () => {
        // spacetime sql serializes enum columns as "(classic = ())" / "(auction = ())"
        // tagged-union literals. Fetch a sample and assert the tag name appears.
        const rows = await queryPrivateTable(
            `SELECT character_name, draft_mode FROM hsr_character_cost WHERE cost_set_id = 0 LIMIT 100`
        );
        expect(rows.length).toBeGreaterThan(0);

        for (const r of rows) {
            const dm = String(r.draft_mode).toLowerCase();
            const isValid = dm.includes('classic') || dm.includes('auction');
            expect(isValid).toBe(true);
        }

        // The default seed currently carries Classic-only rows for chars (per
        // Plan 03 characters_template shape — auction sub-block absent). But
        // this test asserts shape, not population counts: every row must tag.
        const classicHit = rows.some(r => String(r.draft_mode).toLowerCase().includes('classic'));
        expect(classicHit).toBe(true);
    });

    it('15.4 D-14: HsrLightconeCost default-seed rows carry draftMode in {Classic, Auction}', async () => {
        const rows = await queryPrivateTable(
            `SELECT lightcone_name, draft_mode FROM hsr_lightcone_cost WHERE cost_set_id = 0 LIMIT 100`
        );
        expect(rows.length).toBeGreaterThan(0);

        for (const r of rows) {
            const dm = String(r.draft_mode).toLowerCase();
            const isValid = dm.includes('classic') || dm.includes('auction');
            expect(isValid).toBe(true);
        }
    });

    it('15.4 D-13/D-25: HsrSynergyCost default seed contains BOTH Classic and Auction rows', async () => {
        // Plan 03 Task 3 reseed produced 60 synergy rows: 10 pairings × 3 modes
        // × 2 draftModes. This is the first-ever seeded synergy auction data.
        const rows = await queryPrivateTable(
            `SELECT source_name, target_name, draft_mode FROM hsr_synergy_cost WHERE cost_set_id = 0 LIMIT 100`
        );
        expect(rows.length).toBeGreaterThan(0);

        const hasClassic = rows.some(r => String(r.draft_mode).toLowerCase().includes('classic'));
        const hasAuction = rows.some(r => String(r.draft_mode).toLowerCase().includes('auction'));
        expect(hasClassic).toBe(true);
        expect(hasAuction).toBe(true);

        for (const r of rows) {
            const dm = String(r.draft_mode).toLowerCase();
            const isValid = dm.includes('classic') || dm.includes('auction');
            expect(isValid).toBe(true);
        }
    });

    it('15.4 D-25: HsrSynergyCost default seed Auction rows carry numeric costModifier', async () => {
        // D-13: Auction rows are seeded with modifier=0 pending a future tuning
        // pass. The round-trip must preserve the numeric value (not drop or corrupt).
        // Query carefully — SQL may not filter on enum columns directly, so
        // fetch all and filter in JS.
        const rows = await queryPrivateTable(
            `SELECT source_name, target_name, draft_mode, cost_modifier FROM hsr_synergy_cost WHERE cost_set_id = 0 LIMIT 200`
        );
        const auctionRows = rows.filter(r => String(r.draft_mode).toLowerCase().includes('auction'));
        expect(auctionRows.length).toBeGreaterThan(0);

        for (const r of auctionRows) {
            expect(Number.isFinite(Number(r.cost_modifier))).toBe(true);
        }
    });

    it('15.4 D-01: HsrCharacterCost `costs` struct column is populated on default-seed rows', async () => {
        // The struct column serializes as "(e_0 = N, e_1 = N, ...)" tuple literal.
        const rows = await queryPrivateTable(
            `SELECT character_name, costs FROM hsr_character_cost WHERE cost_set_id = 0 LIMIT 10`
        );
        expect(rows.length).toBeGreaterThan(0);

        for (const r of rows) {
            const s = String(r.costs);
            // Every eidolon key e_0..e_6 must appear in the struct serialization.
            expect(s).toMatch(/e_0\s*=/);
            expect(s).toMatch(/e_6\s*=/);
        }
    });

    it('15.4 D-02: HsrLightconeCost `costs` struct column is populated on default-seed rows', async () => {
        const rows = await queryPrivateTable(
            `SELECT lightcone_name, costs FROM hsr_lightcone_cost WHERE cost_set_id = 0 LIMIT 10`
        );
        expect(rows.length).toBeGreaterThan(0);

        for (const r of rows) {
            const s = String(r.costs);
            // Every superimposition key s_1..s_5 must appear.
            expect(s).toMatch(/s_1\s*=/);
            expect(s).toMatch(/s_5\s*=/);
        }
    });
});
