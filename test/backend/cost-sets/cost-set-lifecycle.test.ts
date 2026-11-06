/**
 * Integration tests: Cost set full lifecycle (Phase 15.4 rewrite).
 *
 * Covers:
 * - Create cost set → CostSet row created; draft character/lc/synergy rows
 *   cloned from source set preserve BOTH Classic and Auction draftMode tags.
 * - Edit draft character cost (per-draftMode; one call = one row).
 * - Edit draft lightcone cost (per-draftMode).
 * - Edit draft synergy cost (per-draftMode, including first-ever Auction rows).
 * - Publish — live HsrCharacterCost / HsrLightconeCost / HsrSynergyCost rows
 *   appear for BOTH draftModes when the draft had both (Pitfall 7 regression).
 * - Lock / unpublish / delete (cascades delete across both draftModes).
 * - Default-protection: lock/unpublish/delete on costSetId=0 rejected.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createVerifiedTestHarness, hasServerToken, expectReducerError, type TestHarness } from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';

describe.skipIf(!hasServerToken())('Cost Set Lifecycle (15.4 draftMode shape)', () => {
  let h: TestHarness;
  let costSetId: number;

  const myCostSets = () => [...h.conn.db.CostSet.iter()].filter(c => c.creatorId === h.userId);

  beforeAll(async () => {
    h = await createVerifiedTestHarness();
    await promoteToRole(h, 'TournamentHost');
  }, 30000);

  afterAll(async () => {
    await h?.disconnect();
  });

  // ── Create cost set ──
  it('creates cost set -> isDraft=true, isPublished=false', async () => {
    const countBefore = myCostSets().length;

    await h.call.createCostSet({
      name: 'Test Set',
      sourceSetId: 0,
      gameModeTag: 'MemoryOfChaos',
    });
    await h.sync(1500);

    const mine = myCostSets();
    expect(mine.length).toBe(countBefore + 1);

    const created = mine[mine.length - 1];
    costSetId = created.id;

    expect(created.isDraft).toBe(true);
    expect(created.isPublished).toBe(false);
    expect(created.isLocked).toBe(false);
    expect(created.name).toBe('Test Set');
  });

  // ── Edit draft character cost (Classic) ──
  it('edits draft character cost with draftMode=Classic -> reducer succeeds', async () => {
    await h.call.editDraftCharacterCost({
      costSetId,
      characterName: 'acheron',
      gameModeTag: 'MemoryOfChaos',
      draftModeTag: 'Classic',
      costsJson: '{"e0":10,"e1":12,"e2":14,"e3":16,"e4":18,"e5":20,"e6":22}',
    });
    await h.sync();
    // Draft tables are private (public: false) — no direct iter() verification;
    // the reducer not throwing is the pass signal.
  });

  // ── Edit draft character cost (Auction — per-row granularity) ──
  it('edits draft character cost with draftMode=Auction -> reducer succeeds (per-row granularity)', async () => {
    await h.call.editDraftCharacterCost({
      costSetId,
      characterName: 'acheron',
      gameModeTag: 'MemoryOfChaos',
      draftModeTag: 'Auction',
      costsJson: '{"e0":100,"e1":120,"e2":140,"e3":160,"e4":180,"e5":200,"e6":220}',
    });
    await h.sync();
  });

  // ── Edit draft lightcone cost (Classic) ──
  it('edits draft lightcone cost with draftMode=Classic -> reducer succeeds', async () => {
    await h.call.editDraftLightconeCost({
      costSetId,
      lightconeName: 'adreamscentedinwheat',
      gameModeTag: 'MemoryOfChaos',
      draftModeTag: 'Classic',
      costsJson: '{"s1":5,"s2":6,"s3":7,"s4":8,"s5":9}',
    });
    await h.sync();
  });

  // ── Edit draft lightcone cost (Auction) ──
  it('edits draft lightcone cost with draftMode=Auction -> reducer succeeds', async () => {
    await h.call.editDraftLightconeCost({
      costSetId,
      lightconeName: 'adreamscentedinwheat',
      gameModeTag: 'MemoryOfChaos',
      draftModeTag: 'Auction',
      costsJson: '{"s1":50,"s2":60,"s3":70,"s4":80,"s5":90}',
    });
    await h.sync();
  });

  // ── Edit draft synergy cost (Classic) ──
  it('edits draft synergy cost with draftMode=Classic -> reducer succeeds', async () => {
    await h.call.editDraftSynergyCost({
      costSetId,
      sourceName: 'acheron',
      targetName: 'kafka',
      gameModeTag: 'MemoryOfChaos',
      draftModeTag: 'Classic',
      costModifier: 1.5,
    });
    await h.sync();
  });

  // ── Edit draft synergy cost (Auction — first-ever) ──
  it('edits draft synergy cost with draftMode=Auction -> reducer succeeds (15.4 first-ever)', async () => {
    await h.call.editDraftSynergyCost({
      costSetId,
      sourceName: 'acheron',
      targetName: 'kafka',
      gameModeTag: 'MemoryOfChaos',
      draftModeTag: 'Auction',
      costModifier: 0.75,
    });
    await h.sync();
  });

  // ── Publish — Pitfall 7 regression guard ──
  it('publishes cost set -> BOTH Classic and Auction live rows appear (Pitfall 7 fix)', async () => {
    await h.call.publishCostSet({ costSetId });
    await h.sync(2000);

    const cs = h.conn.db.CostSet.id.find(costSetId);
    expect(cs).toBeDefined();
    expect(cs!.isPublished).toBe(true);
    expect(cs!.isDraft).toBe(false);

    // Character costs: the edited (acheron, MemoryOfChaos) row produced BOTH
    // Classic and Auction live rows under the same costSetId. This is the
    // Pitfall 7 regression guard — the old publish_cost_set existingLive.find
    // predicate without draftMode would have collapsed these into 1 row.
    const acheronMocRows = [...h.conn.db.HsrCharacterCost.iter()].filter(
      c => c.costSetId === costSetId &&
           c.characterName === 'acheron' &&
           c.gameMode.tag === 'MemoryOfChaos'
    );
    expect(acheronMocRows).toHaveLength(2);
    const charTags = acheronMocRows.map(r => r.draftMode.tag).sort();
    expect(charTags).toEqual(['Auction', 'Classic']);

    const classicChar = acheronMocRows.find(r => r.draftMode.tag === 'Classic')!;
    const auctionChar = acheronMocRows.find(r => r.draftMode.tag === 'Auction')!;
    expect(classicChar.costs.e0).toBe(10);
    expect(auctionChar.costs.e0).toBe(100);

    // Lightcone costs (phase B publish): same shape — 2 rows per (name, mode).
    const lcRows = [...h.conn.db.HsrLightconeCost.iter()].filter(
      c => c.costSetId === costSetId &&
           c.lightconeName === 'adreamscentedinwheat' &&
           c.gameMode.tag === 'MemoryOfChaos'
    );
    expect(lcRows).toHaveLength(2);
    const lcTags = lcRows.map(r => r.draftMode.tag).sort();
    expect(lcTags).toEqual(['Auction', 'Classic']);

    const classicLc = lcRows.find(r => r.draftMode.tag === 'Classic')!;
    const auctionLc = lcRows.find(r => r.draftMode.tag === 'Auction')!;
    expect(classicLc.costs.s1).toBe(5);
    expect(auctionLc.costs.s1).toBe(50);

    // Synergy costs (phase C publish — autoInc id path; first-ever Auction
    // materialization to live table from publish).
    const synRows = [...h.conn.db.HsrSynergyCost.iter()].filter(
      c => c.costSetId === costSetId &&
           c.sourceName === 'acheron' &&
           c.targetName === 'kafka' &&
           c.gameMode.tag === 'MemoryOfChaos'
    );
    expect(synRows).toHaveLength(2);
    const synTags = synRows.map(r => r.draftMode.tag).sort();
    expect(synTags).toEqual(['Auction', 'Classic']);

    const classicSyn = synRows.find(r => r.draftMode.tag === 'Classic')!;
    const auctionSyn = synRows.find(r => r.draftMode.tag === 'Auction')!;
    expect(classicSyn.costModifier).toBeCloseTo(1.5, 5);
    expect(auctionSyn.costModifier).toBeCloseTo(0.75, 5);
  }, 30_000);

  // ── Lock ──
  it('locks cost set -> isLocked=true', async () => {
    await h.call.lockCostSet({ costSetId });
    await h.sync();

    const cs = h.conn.db.CostSet.id.find(costSetId);
    expect(cs).toBeDefined();
    expect(cs!.isLocked).toBe(true);
  });

  // ── Unpublish ──
  it('unpublishes cost set -> isPublished=false, isLocked=false', async () => {
    await h.call.unpublishCostSet({ costSetId });
    await h.sync();

    const cs = h.conn.db.CostSet.id.find(costSetId);
    expect(cs).toBeDefined();
    expect(cs!.isPublished).toBe(false);
    expect(cs!.isLocked).toBe(false);
  });

  // ── Delete — cascades across BOTH draftModes ──
  it('deletes cost set -> row gone, live costs cascade-deleted for all draftModes', async () => {
    await h.call.deleteCostSet({ costSetId });
    await h.sync(1500);

    const cs = h.conn.db.CostSet.id.find(costSetId);
    expect(cs).toBeNull();

    // All live cost rows (Classic AND Auction) for this costSetId must be gone.
    const charCosts = [...h.conn.db.HsrCharacterCost.iter()].filter(c => c.costSetId === costSetId);
    expect(charCosts.length).toBe(0);

    const lcCosts = [...h.conn.db.HsrLightconeCost.iter()].filter(c => c.costSetId === costSetId);
    expect(lcCosts.length).toBe(0);

    const synCosts = [...h.conn.db.HsrSynergyCost.iter()].filter(c => c.costSetId === costSetId);
    expect(synCosts.length).toBe(0);
  });

  // ── 15.4 D-20: create_cost_set clones BOTH draftModes from source ──
  describe('create_cost_set clones both Classic and Auction rows from source set (D-20)', () => {
    it('cloning from the default set (0) preserves draftMode on copied char/lc/synergy draft rows', async () => {
      // Default set (0) seed includes Auction rows (D-13 for synergy; and
      // whatever the seed file carries for char/lc). The create_cost_set clone
      // carries draftMode through without transformation.
      const countBefore = myCostSets().length;

      await h.call.createCostSet({
        name: 'Clone Verifier',
        sourceSetId: 0,
        gameModeTag: 'MemoryOfChaos',
      });
      await h.sync(1500);

      const mine = myCostSets();
      expect(mine.length).toBe(countBefore + 1);
      const newCs = mine[mine.length - 1];

      // We cannot iter() private draft tables directly from the client, but we
      // CAN publish and then verify that the live copies include both draftModes
      // for some well-known synergy pair (acheron→kafka MemoryOfChaos has both
      // Classic and Auction in the default seed per Plan 03).
      await h.call.publishCostSet({ costSetId: newCs.id });
      await h.sync(3000);

      // Synergy live rows for the pair should have both draftModes if the clone
      // preserved them. The default seed always has both (D-13).
      const synRows = [...h.conn.db.HsrSynergyCost.iter()].filter(
        c => c.costSetId === newCs.id &&
             c.gameMode.tag === 'MemoryOfChaos'
      );
      const tags = new Set(synRows.map(r => r.draftMode.tag));
      // D-13 guarantees: default seed includes Auction synergy rows.
      expect(tags.has('Classic')).toBe(true);
      expect(tags.has('Auction')).toBe(true);

      // Cleanup.
      await h.call.lockCostSet({ costSetId: newCs.id });
      await h.sync();
      await h.call.unpublishCostSet({ costSetId: newCs.id });
      await h.sync();
      await h.call.deleteCostSet({ costSetId: newCs.id });
      await h.sync();
    }, 45_000);
  });

  // ── Default cost set protection ──
  describe('default cost set (id=0) protection', () => {
    it('rejects lock on default cost set', async () => {
      const msg = await expectReducerError(
        h.call.lockCostSet({ costSetId: 0 })
      );
      expect(msg.toLowerCase()).toMatch(/default/i);
    });

    it('rejects unpublish on default cost set', async () => {
      const msg = await expectReducerError(
        h.call.unpublishCostSet({ costSetId: 0 })
      );
      expect(msg.toLowerCase()).toMatch(/default/i);
    });

    it('rejects delete on default cost set', async () => {
      const msg = await expectReducerError(
        h.call.deleteCostSet({ costSetId: 0 })
      );
      expect(msg.toLowerCase()).toMatch(/default/i);
    });
  });
});
