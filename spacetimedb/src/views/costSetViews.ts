// ─── Cost Set Views ───────────────────────────────────────────────────────────
// Per-user views over CostSet and its draft child tables.
//
// 1. view_my_cost_sets             — CostSet rows owned by the caller
// 2. view_my_draft_character_costs — draft character cost rows for caller's sets
// 3. view_my_draft_lightcone_costs — draft lightcone cost rows for caller's sets
// 4. view_my_draft_synergy_costs   — draft synergy cost rows for caller's sets

import spacetimedb from '../schema';
import { t } from 'spacetimedb/server';
import { CostSet } from '../tables/costSet';
import { CostSetDraftCharacter } from '../tables/costSetDraftCharacter';
import { CostSetDraftLightcone } from '../tables/costSetDraftLightcone';
import { CostSetDraftSynergy } from '../tables/costSetDraftSynergy';

// ---------------------------------------------------------------------------
// 1. My Cost Sets (per-user view) — CostSet rows owned by the requesting user
//    Used by TOs to manage their own cost sets in the draft/publish workflow.
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_cost_sets = spacetimedb.view(
    { name: 'view_my_cost_sets', public: true },
    t.array(CostSet.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const user = ctx.db.User.id.find(mapping.userId);
        if (!user) return [];
        return [...ctx.db.CostSet.creator_id.filter(user.id)];
    }
);

// ---------------------------------------------------------------------------
// 2. My Draft Character Costs (per-user view) — CostSetDraftCharacter rows
//    for all cost sets owned by the requesting user. Draft tables are private
//    (not broadcast to clients), so this view is the only way to read them.
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_draft_character_costs = spacetimedb.view(
    { name: 'view_my_draft_character_costs', public: true },
    t.array(CostSetDraftCharacter.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const user = ctx.db.User.id.find(mapping.userId);
        if (!user) return [];
        // Collect all cost set ids owned by this user, then use cost_set_id index on each
        const mySets = [...ctx.db.CostSet.creator_id.filter(user.id)];
        const results: any[] = [];
        for (const set of mySets) {
            for (const row of ctx.db.CostSetDraftCharacter.cost_set_id.filter(set.id)) {
                results.push(row);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 3. My Draft Lightcone Costs (per-user view) — CostSetDraftLightcone rows
//    for all cost sets owned by the requesting user.
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_draft_lightcone_costs = spacetimedb.view(
    { name: 'view_my_draft_lightcone_costs', public: true },
    t.array(CostSetDraftLightcone.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const user = ctx.db.User.id.find(mapping.userId);
        if (!user) return [];
        const mySets = [...ctx.db.CostSet.creator_id.filter(user.id)];
        const results: any[] = [];
        for (const set of mySets) {
            for (const row of ctx.db.CostSetDraftLightcone.cost_set_id.filter(set.id)) {
                results.push(row);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 4. My Draft Synergy Costs (per-user view) — CostSetDraftSynergy rows
//    for all cost sets owned by the requesting user.
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_draft_synergy_costs = spacetimedb.view(
    { name: 'view_my_draft_synergy_costs', public: true },
    t.array(CostSetDraftSynergy.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const user = ctx.db.User.id.find(mapping.userId);
        if (!user) return [];
        const mySets = [...ctx.db.CostSet.creator_id.filter(user.id)];
        const results: any[] = [];
        for (const set of mySets) {
            for (const row of ctx.db.CostSetDraftSynergy.cost_set_id.filter(set.id)) {
                results.push(row);
            }
        }
        return results;
    }
);
