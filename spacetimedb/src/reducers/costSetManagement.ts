import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, ensureTournamentHost, isRoleAtLeast } from '../helpers/ensurePermissions';
import { auditInsert, auditUpdate } from '../helpers/auditColumns';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';

// Valid GameMode tags
const VALID_GAME_MODE_TAGS = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'];

// Default cost set — cannot be unpublished, locked, or deleted via these reducers
const DEFAULT_COST_SET_ID = 0;

// ─── create_cost_set ──────────────────────────────────────────────────────────
// Creates a new draft cost set by cloning costs from an existing published set
// (or the default set 0). Only TournamentHost, Moderator, or Admin may create.
//
// Lifecycle:
//   create_cost_set (clone) → edit_draft_*_cost → publish_cost_set
//   → (optional) lock_cost_set → unpublish_cost_set → delete_cost_set

export const create_cost_set = spacetimedb.reducer(
    { name: t.string(), sourceSetId: t.u32(), gameModeTag: t.string() },
    (ctx, { name, sourceSetId, gameModeTag }) => {
        const user = ensureTournamentHost(ctx);

        const trimmedName = name.trim();
        if (trimmedName.length < 1 || trimmedName.length > 100) {
            throw new SenderError('Cost set name must be between 1 and 100 characters.');
        }

        if (!VALID_GAME_MODE_TAGS.includes(gameModeTag)) {
            throw new SenderError(`Invalid gameModeTag. Must be one of: ${VALID_GAME_MODE_TAGS.join(', ')}`);
        }

        // If sourceSetId !== 0, the source must exist and be published
        if (sourceSetId !== DEFAULT_COST_SET_ID) {
            const sourceSet = ctx.db.CostSet.id.find(sourceSetId);
            if (!sourceSet) {
                throw new SenderError(`Source cost set ${sourceSetId} not found.`);
            }
            if (!sourceSet.isPublished) {
                throw new SenderError(`Source cost set ${sourceSetId} must be published before cloning.`);
            }
        }

        // Insert the CostSet metadata row (autoInc id — pass 0)
        const costSet = ctx.db.CostSet.insert(insertWithAudit(ctx, {
            id: 0,
            name: trimmedName,
            creatorId: user.id,
            gameMode: { tag: gameModeTag, value: {} } as any,
            isPublished: false,
            isDraft: true,
            isLocked: false,
        }, user.id));

        // 15.4 D-20: Clone character costs (source row's draftMode passes through).
        // Both Classic and Auction rows match the gameMode filter and are cloned together.
        const sourceCharCosts = [...ctx.db.HsrCharacterCost.cost_set_id.filter(sourceSetId)];
        for (const row of sourceCharCosts) {
            if (row.gameMode.tag === gameModeTag) {
                ctx.db.CostSetDraftCharacter.insert(insertWithAudit(ctx, {
                    costSetId: costSet.id,
                    characterName: row.characterName,
                    gameMode: row.gameMode,
                    draftMode: row.draftMode,
                    costs: row.costs,
                }, user.id));
            }
        }

        // 15.4 D-20: Clone lightcone costs (draftMode passes through).
        const sourceLcCosts = [...ctx.db.HsrLightconeCost.cost_set_id.filter(sourceSetId)];
        for (const row of sourceLcCosts) {
            if (row.gameMode.tag === gameModeTag) {
                ctx.db.CostSetDraftLightcone.insert(insertWithAudit(ctx, {
                    costSetId: costSet.id,
                    lightconeName: row.lightconeName,
                    gameMode: row.gameMode,
                    draftMode: row.draftMode,
                    costs: row.costs,
                }, user.id));
            }
        }

        // 15.4 D-20: Clone synergy costs (draftMode passes through).
        const sourceSynCosts = [...ctx.db.HsrSynergyCost.cost_set_id.filter(sourceSetId)];
        for (const row of sourceSynCosts) {
            if (row.gameMode.tag === gameModeTag) {
                ctx.db.CostSetDraftSynergy.insert(insertWithAudit(ctx, {
                    costSetId: costSet.id,
                    sourceName: row.sourceName,
                    targetName: row.targetName,
                    gameMode: row.gameMode,
                    draftMode: row.draftMode,
                    costModifier: row.costModifier,
                }, user.id));
            }
        }
    }
);

// ─── edit_draft_character_cost ────────────────────────────────────────────────
// Updates (upserts) a character's cost row in the draft table.
// Only the creator of the cost set (or Moderator+) may edit.

export const edit_draft_character_cost = spacetimedb.reducer(
    {
        costSetId: t.u32(),
        characterName: t.string(),
        gameModeTag: t.string(),
        draftModeTag: t.string(),
        costsJson: t.string(),
    },
    (ctx, { costSetId, characterName, gameModeTag, draftModeTag, costsJson }) => {
        const user = getAuthenticatedUser(ctx);

        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) {
            throw new SenderError(`Cost set ${costSetId} not found.`);
        }

        // Ownership check: creator or Moderator+
        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Forbidden: You do not own this cost set and are not a Moderator.');
        }

        if (!costSet.isDraft) {
            throw new SenderError('Cannot edit a cost set that is not in draft state. Publish creates a live copy; clone to make a new draft.');
        }

        // Parse JSON cost object (15.4 D-16: single costsJson, one row = one draftMode)
        let costs: any;
        try {
            costs = JSON.parse(costsJson);
        } catch {
            throw new SenderError('costsJson must be a valid JSON object.');
        }

        // Validate EidolonCost structure (e0-e6 as numbers)
        const eidolonKeys = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
        for (const key of eidolonKeys) {
            if (typeof costs[key] !== 'number') {
                throw new SenderError(`costsJson must have numeric field "${key}".`);
            }
        }

        const gameMode = { tag: gameModeTag, value: {} } as any;
        const draftMode = { tag: draftModeTag, value: {} } as any;

        // Find existing draft row via indexed filter + manual match (5-tuple including draftMode)
        const drafts = [...ctx.db.CostSetDraftCharacter.cost_set_id.filter(costSetId)];
        const existing = drafts.find(d =>
            d.characterName === characterName &&
            d.gameMode.tag === gameModeTag &&
            d.draftMode.tag === draftModeTag);

        if (existing) {
            // Delete old row, insert updated row (composite PK upsert pattern)
            ctx.db.CostSetDraftCharacter.delete(existing);
            ctx.db.CostSetDraftCharacter.insert({
                costSetId,
                characterName,
                gameMode,
                draftMode,
                costs,
                ...auditUpdate(ctx, existing, user.id),
            } as any);
        } else {
            ctx.db.CostSetDraftCharacter.insert({
                costSetId,
                characterName,
                gameMode,
                draftMode,
                costs,
                ...auditInsert(ctx, user.id),
            } as any);
        }
    }
);

// ─── edit_draft_lightcone_cost ────────────────────────────────────────────────
// Updates (upserts) a lightcone's cost row in the draft table.
// Only the creator of the cost set (or Moderator+) may edit.

export const edit_draft_lightcone_cost = spacetimedb.reducer(
    {
        costSetId: t.u32(),
        lightconeName: t.string(),
        gameModeTag: t.string(),
        draftModeTag: t.string(),
        costsJson: t.string(),
    },
    (ctx, { costSetId, lightconeName, gameModeTag, draftModeTag, costsJson }) => {
        const user = getAuthenticatedUser(ctx);

        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) {
            throw new SenderError(`Cost set ${costSetId} not found.`);
        }

        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Forbidden: You do not own this cost set and are not a Moderator.');
        }

        if (!costSet.isDraft) {
            throw new SenderError('Cannot edit a cost set that is not in draft state.');
        }

        // Parse JSON cost object (15.4 D-17: single costsJson, one row = one draftMode)
        let costs: any;
        try {
            costs = JSON.parse(costsJson);
        } catch {
            throw new SenderError('costsJson must be a valid JSON object.');
        }

        // Validate SuperimpositionCost structure (s1-s5 as numbers)
        const superimpositionKeys = ['s1', 's2', 's3', 's4', 's5'];
        for (const key of superimpositionKeys) {
            if (typeof costs[key] !== 'number') {
                throw new SenderError(`costsJson must have numeric field "${key}".`);
            }
        }

        const gameMode = { tag: gameModeTag, value: {} } as any;
        const draftMode = { tag: draftModeTag, value: {} } as any;

        // Find existing draft row via indexed filter + manual match (5-tuple including draftMode)
        const drafts = [...ctx.db.CostSetDraftLightcone.cost_set_id.filter(costSetId)];
        const existing = drafts.find(d =>
            d.lightconeName === lightconeName &&
            d.gameMode.tag === gameModeTag &&
            d.draftMode.tag === draftModeTag);

        if (existing) {
            ctx.db.CostSetDraftLightcone.delete(existing);
            ctx.db.CostSetDraftLightcone.insert({
                costSetId,
                lightconeName,
                gameMode,
                draftMode,
                costs,
                ...auditUpdate(ctx, existing, user.id),
            } as any);
        } else {
            ctx.db.CostSetDraftLightcone.insert({
                costSetId,
                lightconeName,
                gameMode,
                draftMode,
                costs,
                ...auditInsert(ctx, user.id),
            } as any);
        }
    }
);

// ─── edit_draft_synergy_cost ──────────────────────────────────────────────────
// Updates (upserts) a synergy cost row in the draft table.
// Only the creator of the cost set (or Moderator+) may edit.

export const edit_draft_synergy_cost = spacetimedb.reducer(
    {
        costSetId: t.u32(),
        sourceName: t.string(),
        targetName: t.string(),
        gameModeTag: t.string(),
        draftModeTag: t.string(),
        costModifier: t.f32(),
    },
    (ctx, { costSetId, sourceName, targetName, gameModeTag, draftModeTag, costModifier }) => {
        const user = getAuthenticatedUser(ctx);

        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) {
            throw new SenderError(`Cost set ${costSetId} not found.`);
        }

        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Forbidden: You do not own this cost set and are not a Moderator.');
        }

        if (!costSet.isDraft) {
            throw new SenderError('Cannot edit a cost set that is not in draft state.');
        }

        const gameMode = { tag: gameModeTag, value: {} } as any;
        const draftMode = { tag: draftModeTag, value: {} } as any;

        // 15.4 D-18: Find existing draft row by 5-tuple (source, target, gameMode, draftMode, costSetId).
        const drafts = [...ctx.db.CostSetDraftSynergy.cost_set_id.filter(costSetId)];
        const existing = drafts.find(d =>
            d.sourceName === sourceName &&
            d.targetName === targetName &&
            d.gameMode.tag === gameModeTag &&
            d.draftMode.tag === draftModeTag
        );

        if (existing) {
            ctx.db.CostSetDraftSynergy.delete(existing);
            ctx.db.CostSetDraftSynergy.insert({
                costSetId,
                sourceName,
                targetName,
                gameMode,
                draftMode,
                costModifier,
                ...auditUpdate(ctx, existing, user.id),
            } as any);
        } else {
            ctx.db.CostSetDraftSynergy.insert({
                costSetId,
                sourceName,
                targetName,
                gameMode,
                draftMode,
                costModifier,
                ...auditInsert(ctx, user.id),
            } as any);
        }
    }
);

// ─── publish_cost_set ─────────────────────────────────────────────────────────
// Copies draft rows to live cost tables, cleans up draft tables, and marks
// the CostSet as published (isDraft=false, isPublished=true).
//
// After publish, the cost data is broadcast to all subscribers via the live
// HsrCharacterCost / HsrLightconeCost / HsrSynergyCost tables.

export const publish_cost_set = spacetimedb.reducer(
    { costSetId: t.u32() },
    (ctx, { costSetId }) => {
        const user = getAuthenticatedUser(ctx);

        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) {
            throw new SenderError(`Cost set ${costSetId} not found.`);
        }

        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Forbidden: You do not own this cost set and are not a Moderator.');
        }

        if (!costSet.isDraft) {
            throw new SenderError('Cannot publish a cost set that is not in draft state.');
        }

        // Phase A: Copy draft character costs to live HsrCharacterCost table (15.4 D-21 Pitfall 7).
        // existingLive predicate extended with draftMode.tag match.
        const draftChars = [...ctx.db.CostSetDraftCharacter.cost_set_id.filter(costSetId)];
        for (const draft of draftChars) {
            const liveRows = [...ctx.db.HsrCharacterCost.cost_set_id.filter(costSetId)];
            const existingLive = liveRows.find(
                r => r.characterName === draft.characterName &&
                     r.gameMode.tag === draft.gameMode.tag &&
                     r.draftMode.tag === draft.draftMode.tag
            );
            if (existingLive) {
                ctx.db.HsrCharacterCost.delete(existingLive);
            }
            ctx.db.HsrCharacterCost.insert({
                characterName: draft.characterName,
                gameMode: draft.gameMode,
                draftMode: draft.draftMode,
                costs: draft.costs,
                costSetId: costSetId,
                ...(existingLive ? auditUpdate(ctx, existingLive, user.id) : auditInsert(ctx, user.id)),
            } as any);
        }

        // Phase B: Copy draft lightcone costs to live HsrLightconeCost table (15.4 D-21).
        const draftLcs = [...ctx.db.CostSetDraftLightcone.cost_set_id.filter(costSetId)];
        for (const draft of draftLcs) {
            const liveRows = [...ctx.db.HsrLightconeCost.cost_set_id.filter(costSetId)];
            const existingLive = liveRows.find(
                r => r.lightconeName === draft.lightconeName &&
                     r.gameMode.tag === draft.gameMode.tag &&
                     r.draftMode.tag === draft.draftMode.tag
            );
            if (existingLive) {
                ctx.db.HsrLightconeCost.delete(existingLive);
            }
            ctx.db.HsrLightconeCost.insert({
                lightconeName: draft.lightconeName,
                gameMode: draft.gameMode,
                draftMode: draft.draftMode,
                costs: draft.costs,
                costSetId: costSetId,
                ...(existingLive ? auditUpdate(ctx, existingLive, user.id) : auditInsert(ctx, user.id)),
            } as any);
        }

        // Phase C: Copy draft synergy costs to live HsrSynergyCost table (15.4 D-21).
        // HsrSynergyCost uses autoInc id PK — find existing by 5-tuple including draftMode.
        const draftSyns = [...ctx.db.CostSetDraftSynergy.cost_set_id.filter(costSetId)];
        for (const draft of draftSyns) {
            const liveSyns = [...ctx.db.HsrSynergyCost.cost_set_id.filter(costSetId)];
            const existingLive = liveSyns.find(
                r =>
                    r.sourceName === draft.sourceName &&
                    r.targetName === draft.targetName &&
                    r.gameMode.tag === draft.gameMode.tag &&
                    r.draftMode.tag === draft.draftMode.tag
            );
            if (existingLive) {
                // Update via id.update() — preserves autoInc id and existing draftMode (via spread).
                ctx.db.HsrSynergyCost.id.update(
                    updateWithAudit(ctx, existingLive, { costModifier: draft.costModifier }, user.id),
                );
            } else {
                // KEEP `auditInsert` primitive for file-symmetry with L369/L391 inline ternaries
                // and 3 edit_draft_* else-branches — auditInsert stays callable in this file
                // regardless, so migrating only this branch yields zero eviction win.
                ctx.db.HsrSynergyCost.insert({
                    id: 0,
                    sourceName: draft.sourceName,
                    targetName: draft.targetName,
                    gameMode: draft.gameMode,
                    draftMode: draft.draftMode,
                    costModifier: draft.costModifier,
                    costSetId: costSetId,
                    ...auditInsert(ctx, user.id),
                } as any);
            }
        }

        // Phase D: Clean up all draft rows for this costSetId
        for (const row of [...ctx.db.CostSetDraftCharacter.cost_set_id.filter(costSetId)]) {
            ctx.db.CostSetDraftCharacter.delete(row);
        }
        for (const row of [...ctx.db.CostSetDraftLightcone.cost_set_id.filter(costSetId)]) {
            ctx.db.CostSetDraftLightcone.delete(row);
        }
        for (const row of [...ctx.db.CostSetDraftSynergy.cost_set_id.filter(costSetId)]) {
            ctx.db.CostSetDraftSynergy.delete(row);
        }

        // Phase E: Update CostSet metadata — mark as published and no longer a draft
        ctx.db.CostSet.id.update(
            updateWithAudit(ctx, costSet, { isPublished: true, isDraft: false }, user.id),
        );
    }
);

// ─── lock_cost_set ────────────────────────────────────────────────────────────
// Sets isLocked = true on a published set, preventing new lobbies/tournaments
// from selecting this cost set. Existing lobbies that already reference this
// cost set continue unaffected.
//
// Lock is the required precursor to unpublish.
// NOTE: costSetId=0 (the default set) cannot be locked.

export const lock_cost_set = spacetimedb.reducer(
    { costSetId: t.u32() },
    (ctx, { costSetId }) => {
        const user = getAuthenticatedUser(ctx);

        if (costSetId === DEFAULT_COST_SET_ID) {
            throw new SenderError('The default cost set (id=0) cannot be locked.');
        }

        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) {
            throw new SenderError(`Cost set ${costSetId} not found.`);
        }

        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Forbidden: You do not own this cost set and are not a Moderator.');
        }

        if (!costSet.isPublished) {
            throw new SenderError('Cannot lock a cost set that is not published.');
        }

        if (costSet.isLocked) {
            throw new SenderError('Cost set is already locked.');
        }

        ctx.db.CostSet.id.update(
            updateWithAudit(ctx, costSet, { isLocked: true }, user.id),
        );
    }
);

// ─── unpublish_cost_set ───────────────────────────────────────────────────────
// Sets isPublished = false and isLocked = false on a locked+published set.
// Live cost rows remain in the tables but the CostSet metadata signals
// "don't broadcast" — clients will stop receiving this set's cost data.
//
// Requires isLocked === true (must lock before unpublishing).
// NOTE: costSetId=0 (the default set) cannot be unpublished.

export const unpublish_cost_set = spacetimedb.reducer(
    { costSetId: t.u32() },
    (ctx, { costSetId }) => {
        const user = getAuthenticatedUser(ctx);

        if (costSetId === DEFAULT_COST_SET_ID) {
            throw new SenderError('The default cost set (id=0) cannot be unpublished.');
        }

        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) {
            throw new SenderError(`Cost set ${costSetId} not found.`);
        }

        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Forbidden: You do not own this cost set and are not a Moderator.');
        }

        if (!costSet.isPublished) {
            throw new SenderError('Cost set is not published.');
        }

        if (!costSet.isLocked) {
            throw new SenderError('Cost set must be locked before it can be unpublished. Call lock_cost_set first.');
        }

        ctx.db.CostSet.id.update(
            updateWithAudit(ctx, costSet, { isPublished: false, isLocked: false }, user.id),
        );
    }
);

// ─── delete_cost_set ──────────────────────────────────────────────────────────
// Permanently deletes a cost set and all associated live and draft cost rows.
// Requires isPublished === false (must call unpublish_cost_set first).
//
// Deletion cascade:
//   - All HsrCharacterCost rows with this costSetId
//   - All HsrLightconeCost rows with this costSetId
//   - All HsrSynergyCost rows with this costSetId
//   - Any remaining CostSetDraft* rows (all 3 tables)
//   - The CostSet metadata row itself
//
// NOTE: costSetId=0 (the default set) cannot be deleted.

export const delete_cost_set = spacetimedb.reducer(
    { costSetId: t.u32() },
    (ctx, { costSetId }) => {
        const user = getAuthenticatedUser(ctx);

        if (costSetId === DEFAULT_COST_SET_ID) {
            throw new SenderError('The default cost set (id=0) cannot be deleted.');
        }

        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) {
            throw new SenderError(`Cost set ${costSetId} not found.`);
        }

        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Forbidden: You do not own this cost set and are not a Moderator.');
        }

        if (costSet.isPublished) {
            throw new SenderError('Cost set must be unpublished before deleting. Call unpublish_cost_set first.');
        }

        // Delete all live character cost rows with this costSetId
        for (const row of [...ctx.db.HsrCharacterCost.cost_set_id.filter(costSetId)]) {
            ctx.db.HsrCharacterCost.delete(row);
        }

        // Delete all live lightcone cost rows with this costSetId
        for (const row of [...ctx.db.HsrLightconeCost.cost_set_id.filter(costSetId)]) {
            ctx.db.HsrLightconeCost.delete(row);
        }

        // Delete all live synergy cost rows with this costSetId
        for (const row of [...ctx.db.HsrSynergyCost.cost_set_id.filter(costSetId)]) {
            ctx.db.HsrSynergyCost.id.delete(row.id);
        }

        // Delete any remaining draft rows (covers draft-only sets that were never published)
        for (const row of [...ctx.db.CostSetDraftCharacter.cost_set_id.filter(costSetId)]) {
            ctx.db.CostSetDraftCharacter.delete(row);
        }
        for (const row of [...ctx.db.CostSetDraftLightcone.cost_set_id.filter(costSetId)]) {
            ctx.db.CostSetDraftLightcone.delete(row);
        }
        for (const row of [...ctx.db.CostSetDraftSynergy.cost_set_id.filter(costSetId)]) {
            ctx.db.CostSetDraftSynergy.delete(row);
        }

        // Delete the CostSet metadata row
        ctx.db.CostSet.id.delete(costSetId);
    }
);
