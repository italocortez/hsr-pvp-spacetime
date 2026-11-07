import { SenderError } from 'spacetimedb/server';

// ─── Backlog #2 (R2, D-D6): cost-set selectability and coverage ──────────────────────────────────────
// Used at every selection site: create_lobby, update_lobby_settings (when costSetId / gameMode / draftMode change),
// create/update_lobby_preset, create/update_tournament. delete_cost_set uses isCostSetInUse.

/** The default cost set: always selectable, never checked for coverage. */
export const DEFAULT_COST_SET_ID = 0;

/** id 0 passes; otherwise the set must exist, be published and not locked (lock_cost_set stops new selections). */
export function ensureSelectableCostSet(ctx: any, costSetId: number): void {
    if (costSetId === DEFAULT_COST_SET_ID) return;
    const costSet = ctx.db.CostSet.id.find(costSetId);
    if (!costSet) throw new SenderError(`Cost set ${costSetId} not found.`);
    if (!costSet.isPublished) throw new SenderError(`Cost set ${costSetId} is not published.`);
    if (costSet.isLocked) throw new SenderError(`Cost set ${costSetId} is locked and cannot be selected.`);
}

/**
 * D-D6 loose coverage: at least one HsrCharacterCost row and at least one HsrLightconeCost row for
 * (costSetId, gameMode, draftMode). Synergies are an optional modifier and never a rejection condition.
 * The default set (id 0) always passes.
 */
export function doesCostSetCover(ctx: any, costSetId: number, gameModeTag: string, draftModeTag: string): boolean {
    if (costSetId === DEFAULT_COST_SET_ID) return true;
    const matches = (r: any) => r.gameMode.tag === gameModeTag && r.draftMode.tag === draftModeTag;
    const hasCharacters = [...ctx.db.HsrCharacterCost.cost_set_id.filter(costSetId)].some(matches);
    if (!hasCharacters) return false;
    return [...ctx.db.HsrLightconeCost.cost_set_id.filter(costSetId)].some(matches);
}

/** ensureSelectableCostSet + doesCostSetCover with the backlog #2 UI error text. */
export function ensureCostSetUsable(ctx: any, costSetId: number, gameModeTag: string, draftModeTag: string): void {
    ensureSelectableCostSet(ctx, costSetId);
    ensureCostSetCovers(ctx, costSetId, gameModeTag, draftModeTag);
}

export function ensureCostSetCovers(ctx: any, costSetId: number, gameModeTag: string, draftModeTag: string): void {
    if (!doesCostSetCover(ctx, costSetId, gameModeTag, draftModeTag)) {
        throw new SenderError(
            `This cost set has no costs for ${gameModeTag} × ${draftModeTag}. Pick another set or ask its owner to extend it.`,
        );
    }
}

/** delete_cost_set guard: a non-Finished Lobby or a non-terminal Tournament still references the set. */
export function isCostSetInUse(ctx: any, costSetId: number): boolean {
    // iter() required: neither Lobby nor Tournament has a costSetId index; Lobby holds live lobbies only (GC'd)
    // and Tournament is small, and this runs only on an explicit delete.
    for (const lobby of ctx.db.Lobby.iter()) {
        if (lobby.costSetId === costSetId && lobby.stage.tag !== 'Finished') return true;
    }
    for (const tournament of ctx.db.Tournament.iter()) {
        if (tournament.costSetId === costSetId
            && tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled') return true;
    }
    return false;
}
