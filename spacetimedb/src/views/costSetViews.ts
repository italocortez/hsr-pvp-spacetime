// ─── Cost Set Views ───────────────────────────────────────────────────────────
// Per-user views over CostSet and its draft child tables.
//
// 1. view_my_cost_sets             — CostSet rows owned by the caller
// 2. view_my_draft_character_costs — draft character cost rows for caller's sets
// 3. view_my_draft_lightcone_costs — draft lightcone cost rows for caller's sets
// 4. view_my_draft_synergy_costs   — draft synergy cost rows for caller's sets
// 5. view_cost_set_missing(id)     — A107(2): reference entries the set's draft lacks (owner / Moderator+)
// 6. view_published_cost_sets      — S11a (L91): the published CostSet rows, for every caller (CostSet is private)
// Since S10i (A107(3)) the draft rows of a published set stay after publish: they are its editable copy.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { CostSet } from '@module/tables/roster/costSet';
import { CostSetDraftCharacter } from '@module/tables/roster/costSetDraftCharacter';
import { CostSetDraftLightcone } from '@module/tables/roster/costSetDraftLightcone';
import { CostSetDraftSynergy } from '@module/tables/roster/costSetDraftSynergy';
import { DraftMode } from '@module/types/enums';
import { isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { missingCostEntries } from '@module/helpers/roster/costSetCompleteness';

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
// 6. view_published_cost_sets — S11a (triage L91): `CostSet` is private, so unpublished drafts (name, creator) are no
//    longer readable by every client. Every caller reads the published sets (the ones a lobby, preset or tournament may
//    select, ensureSelectableCostSet; a locked one is listed with its flag). Index read (is_published), no scan.
//    Part of the reference set (docs/frontend/subscriptions.md Decision 1) in place of the `cost_set` table.
// ---------------------------------------------------------------------------
export const view_published_cost_sets = spacetimedb.anonymousView(
    { name: 'view_published_cost_sets', public: true },
    t.array(CostSet.rowType),
    (ctx) => [...ctx.db.CostSet.is_published.filter(true)],
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
// 5. view_cost_set_missing(costSetId) — A107(2): the entries the "push cost set live" dialog shows before
//    publish_cost_set. Per draft mode the set's draft prices at all, the HsrCharacter and HsrLightcone rows with no
//    draft row (missingCostEntries; a set published before S10i without draft rows is read from its live rows).
//    The set's owner and Moderator+ only: the permission is checked before any cost or reference read; anyone else,
//    and an unknown set, gets no rows. Subscribe as `SELECT * FROM view_cost_set_missing(7)`.
// ---------------------------------------------------------------------------
const CostSetMissingRow = t.row('CostSetMissingRow', {
    costSetId: t.u32(),
    draftMode: DraftMode,
    kind: t.string(),                       // 'Character' | 'Lightcone'
    name: t.string(),                       // HsrCharacter.name / HsrLightcone.name
});

export const view_cost_set_missing = spacetimedb.view(
    { name: 'view_cost_set_missing', public: true },
    { costSetId: t.u32() },
    t.array(CostSetMissingRow),
    (ctx, { costSetId }) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const user = ctx.db.User.id.find(mapping.userId);
        if (!user) return [];
        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) return [];
        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) return [];
        return missingCostEntries(ctx, costSet).map((m) => ({
            costSetId,
            draftMode: { tag: m.draftMode, value: {} } as any,
            kind: m.kind,
            name: m.name,
        }));
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
