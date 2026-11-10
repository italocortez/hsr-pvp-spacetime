import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, ensureTournamentHost, isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { auditInsert, auditUpdate } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { deleteCostSetRows, isCostSetInUse, liveLobbiesOnCostSet } from '@module/helpers/draft/costSetGuards';
import {
    ensureCostSetPatchable,
    ensureDraftCopy,
    fillMissingAtZero,
    mirrorDraftToLive,
    missingCostEntries,
    missingCostText,
} from '@module/helpers/roster/costSetCompleteness';
import { readAbuseConfig } from '@module/helpers/lobby/abuseControls';
import { BUDGET_MAX } from '@module/helpers/lobby/lobbyConfigBounds';
import { canonicalPair } from '@shared/scoring';

// Valid GameMode tags
const VALID_GAME_MODE_TAGS = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'];

// Default cost set — cannot be unpublished, locked, or deleted via these reducers
const DEFAULT_COST_SET_ID = 0;

// ─── edit_draft_*_cost input rules (S10f, roster audit #9) ──────────────────────
// gameModeTag: one of the GameMode tags and equal to the set's own game mode (create_cost_set clones that mode only);
// draftModeTag: Classic or Auction. Every cost value (e0..e6, s1..s5) is a finite number from 0 to BUDGET_MAX (100000,
// the lobby budget ceiling: a higher price can never be paid); a synergy costModifier is finite with |value| <=
// BUDGET_MAX (negative modifiers stay allowed). Character and light-cone names must be HsrCharacter / HsrLightcone rows
// (the synergy names were already checked, S10c). The stored cost object holds the named fields only.

const VALID_DRAFT_MODE_TAGS = ['Classic', 'Auction'];

function ensureDraftRowTags(costSet: any, gameModeTag: string, draftModeTag: string): void {
    if (!VALID_GAME_MODE_TAGS.includes(gameModeTag)) {
        throw new SenderError(`Invalid gameModeTag. Must be one of: ${VALID_GAME_MODE_TAGS.join(', ')}`);
    }
    if (gameModeTag !== costSet.gameMode.tag) {
        throw new SenderError(`This cost set is for ${costSet.gameMode.tag}; gameModeTag must be ${costSet.gameMode.tag}.`);
    }
    if (!VALID_DRAFT_MODE_TAGS.includes(draftModeTag)) {
        throw new SenderError(`Invalid draftModeTag. Must be one of: ${VALID_DRAFT_MODE_TAGS.join(', ')}`);
    }
}

/** Parses costsJson into an object of exactly `keys`, each a finite number in 0..BUDGET_MAX. */
function parseCostFields(costsJson: string, keys: string[]): Record<string, number> {
    let parsed: any;
    try {
        parsed = JSON.parse(costsJson);
    } catch {
        throw new SenderError('costsJson must be a valid JSON object.');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SenderError('costsJson must be a valid JSON object.');
    }
    const costs: Record<string, number> = {};
    for (const key of keys) {
        const value = parsed[key];
        if (typeof value !== 'number') {
            throw new SenderError(`costsJson must have numeric field "${key}".`);
        }
        if (!Number.isFinite(value) || value < 0 || value > BUDGET_MAX) {
            throw new SenderError(`costsJson field "${key}" must be a number between 0 and ${BUDGET_MAX}.`);
        }
        costs[key] = value;
    }
    return costs;
}

// ─── create_cost_set ──────────────────────────────────────────────────────────
// Creates a new draft cost set by cloning costs from an existing published set
// (or the default set 0). Only TournamentHost, Moderator, or Admin may create.
//
// Lifecycle:
//   create_cost_set (clone) → edit_draft_*_cost → publish_cost_set
//   → (A107(3)) edit_draft_*_cost → publish_cost_set again (patch in place, same id), any number of times
//   → (optional) lock_cost_set → unpublish_cost_set → delete_cost_set
// A clone copies the source's live rows: draft edits of the source that were not published yet are not cloned.

export const create_cost_set = spacetimedb.reducer(
    { name: t.string(), sourceSetId: t.u32(), gameModeTag: t.string() },
    (ctx, { name, sourceSetId, gameModeTag }) => {
        const user = ensureTournamentHost(ctx);

        // B-7: per-user cost-set cap, AbuseConfig.maxCostSetsPerUser (D-B5: 5).
        const maxCostSets = readAbuseConfig(ctx).maxCostSetsPerUser;
        if ([...ctx.db.CostSet.creator_id.filter(user.id)].length >= maxCostSets) {
            throw new SenderError(`Cost set limit reached: you can own at most ${maxCostSets} cost sets. Delete one first.`);
        }

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
                    characterA: row.characterA,
                    characterB: row.characterB,
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

        // A107(3): a draft, or a published set that is not locked (patch in place: the draft stays editable).
        ensureCostSetPatchable(costSet);

        // Parse JSON cost object (15.4 D-16: single costsJson, one row = one draftMode); EidolonCost e0-e6, S10f bounds
        const costs = parseCostFields(costsJson, ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
        ensureDraftRowTags(costSet, gameModeTag, draftModeTag);
        if (!ctx.db.HsrCharacter.name.find(characterName)) throw new SenderError(`Character ${characterName} not found.`);
        ensureDraftCopy(ctx, costSet, user.id); // a set published before S10i: rebuild its draft from the live rows first

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

        // A107(3): a draft, or a published set that is not locked.
        ensureCostSetPatchable(costSet);

        // Parse JSON cost object (15.4 D-17: single costsJson, one row = one draftMode); SuperimpositionCost s1-s5, S10f bounds
        const costs = parseCostFields(costsJson, ['s1', 's2', 's3', 's4', 's5']);
        ensureDraftRowTags(costSet, gameModeTag, draftModeTag);
        if (!ctx.db.HsrLightcone.name.find(lightconeName)) throw new SenderError(`Light cone ${lightconeName} not found.`);
        ensureDraftCopy(ctx, costSet, user.id);

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
        // A21: synergies are unordered pairs. The two names are stored in canonical (alphabetical) order, so
        // editing B + A updates the A + B row instead of creating a reversed duplicate. The argument names stay
        // sourceName / targetName (renaming them would change the client API; nothing else depends on the order).
        const [characterA, characterB] = canonicalPair(sourceName, targetName);

        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) {
            throw new SenderError(`Cost set ${costSetId} not found.`);
        }

        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Forbidden: You do not own this cost set and are not a Moderator.');
        }

        // A107(3): a draft, or a published set that is not locked.
        ensureCostSetPatchable(costSet);

        // Audit 2026-11-09 (roster finding 1): both names must be HsrCharacter rows.
        for (const name of [characterA, characterB]) {
            if (!ctx.db.HsrCharacter.name.find(name)) throw new SenderError(`Character ${name} not found.`);
        }
        // S10f (roster audit #9): the modifier is finite and bounded; the tags are checked like the cost rows'.
        if (!Number.isFinite(costModifier) || Math.abs(costModifier) > BUDGET_MAX) {
            throw new SenderError(`costModifier must be a number between -${BUDGET_MAX} and ${BUDGET_MAX}.`);
        }
        ensureDraftRowTags(costSet, gameModeTag, draftModeTag);
        ensureDraftCopy(ctx, costSet, user.id);

        const gameMode = { tag: gameModeTag, value: {} } as any;
        const draftMode = { tag: draftModeTag, value: {} } as any;

        // 15.4 D-18: Find existing draft row by 5-tuple (source, target, gameMode, draftMode, costSetId).
        const drafts = [...ctx.db.CostSetDraftSynergy.cost_set_id.filter(costSetId)];
        const existing = drafts.find(d =>
            d.characterA === characterA &&
            d.characterB === characterB &&
            d.gameMode.tag === gameModeTag &&
            d.draftMode.tag === draftModeTag
        );

        if (existing) {
            ctx.db.CostSetDraftSynergy.delete(existing);
            ctx.db.CostSetDraftSynergy.insert({
                costSetId,
                characterA,
                characterB,
                gameMode,
                draftMode,
                costModifier,
                ...auditUpdate(ctx, existing, user.id),
            } as any);
        } else {
            ctx.db.CostSetDraftSynergy.insert({
                costSetId,
                characterA,
                characterB,
                gameMode,
                draftMode,
                costModifier,
                ...auditInsert(ctx, user.id),
            } as any);
        }
    }
);

// ─── publish_cost_set ─────────────────────────────────────────────────────────
// A107(2)(3)(4). Publishes a draft set, or patches a published, unlocked set in place (same id). Steps:
//   1. Owner or Moderator+; the set must be a draft or published and not locked (ensureCostSetPatchable).
//   2. Patch only (the set is already published): refused while any lobby on the set is in Drafting, Equipping or
//      Scoring ("Cannot patch this cost set while N lobbies using it are in Drafting, Equipping or Scoring.").
//      liveLobbiesOnCostSet: an index read (Lobby.stage per live stage, then costSetId). Waiting rooms, lobbies in
//      AwaitingResult and tournaments between games do not block.
//   3. A set published before S10i gets its draft rebuilt from its live rows (ensureDraftCopy).
//   4. Completeness (missingCostEntries): per draft mode the draft prices at all, the HsrCharacter / HsrLightcone rows
//      without a draft row. With gaps and no confirmFillMissing the call is refused with the counts (missingCostText);
//      with it the gaps are written into the draft at cost 0 (fillMissingAtZero) and so reach the live copy.
//   5. The live rows become equal to the draft (mirrorDraftToLive): new rows inserted, changed rows replaced,
//      unchanged rows untouched, live rows with no draft row deleted. The draft is kept: it stays the editable copy.
//   6. CostSet: isPublished = true, isDraft = false.
// Lobbies, presets and tournaments that point at the set are not touched: they read the new prices from now on.
// History keeps the costs stored on its steps and lineups (A107(6)).

export const publish_cost_set = spacetimedb.reducer(
    { costSetId: t.u32(), confirmFillMissing: t.bool().optional() },
    (ctx, { costSetId, confirmFillMissing }) => {
        const user = getAuthenticatedUser(ctx);

        const costSet = ctx.db.CostSet.id.find(costSetId);
        if (!costSet) {
            throw new SenderError(`Cost set ${costSetId} not found.`);
        }

        if (costSet.creatorId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Forbidden: You do not own this cost set and are not a Moderator.');
        }

        ensureCostSetPatchable(costSet);

        if (costSet.isPublished) {
            const live = liveLobbiesOnCostSet(ctx, costSetId);
            if (live > 0) {
                throw new SenderError(
                    `Cannot patch this cost set while ${live} ${live === 1 ? 'lobby using it is' : 'lobbies using it are'} in Drafting, Equipping or Scoring.`,
                );
            }
        }

        ensureDraftCopy(ctx, costSet, user.id);

        const missing = missingCostEntries(ctx, costSet);
        if (missing.length > 0) {
            if (!confirmFillMissing) throw new SenderError(missingCostText(missing));
            fillMissingAtZero(ctx, costSet, missing, user.id);
        }

        mirrorDraftToLive(ctx, costSetId, user.id);

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
// A107(3): a locked set can no longer be edited or patched; draft edits not yet published stay in the private draft
// and never reach the live rows (delete_cost_set removes them).
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
// Live cost rows remain in the public cost tables until delete_cost_set (a client subscribed with
// WHERE costSetId = N keeps receiving them); only the CostSet flags change.
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

        // Backlog #2 (R2): never delete a set a live lobby or tournament still points at.
        if (isCostSetInUse(ctx, costSetId)) {
            throw new SenderError('This cost set is used by an active lobby or tournament and cannot be deleted.');
        }

        // Live rows, draft rows and the CostSet row (S10r: the loop moved to deleteCostSetRows, shared with the user
        // deletion cascade, A122(6)).
        deleteCostSetRows(ctx, costSetId);
    }
);
