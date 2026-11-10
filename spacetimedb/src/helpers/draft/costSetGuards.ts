import { SenderError } from 'spacetimedb/server';

// ─── Backlog #2 (R2, D-D6): cost-set selectability and coverage ──────────────────────────────────────
// Used at every selection site: create_lobby, update_lobby_settings (when costSetId / gameMode / draftMode change),
// create/update_lobby_preset, create/update_tournament. delete_cost_set uses isCostSetInUse.

/** The default cost set: always selectable (no CostSet row); checked for coverage like any other set (S10i review F2). */
export const DEFAULT_COST_SET_ID = 0;

/** id 0 passes; otherwise the set must exist, be published and not locked (lock_cost_set stops new selections). */
export function ensureSelectableCostSet(ctx: any, costSetId: number): void {
    if (costSetId === DEFAULT_COST_SET_ID) return;
    const costSet = ctx.db.CostSet.id.find(costSetId);
    if (!costSet) throw new SenderError(`Cost set ${costSetId} not found.`);
    if (!costSet.isPublished) throw new SenderError(`Cost set ${costSetId} is not published.`);
    if (costSet.isLocked) throw new SenderError(`Cost set ${costSetId} is locked and cannot be selected.`);
}

// ─── A107(1)(5): the lobby's cost rows ──────────────────────────────────────────────────────────────
// Every character and light-cone price is read from the live rows of the lobby's own cost set, game mode and draft
// mode (costSetRowsFor). There is no fallback to the default set and no fixed draft mode. A real entry with no row is
// rejected with costMissingText; EMPTY is the no-pick placeholder and always costs 0. doesCostSetCover reads the same
// rows (costSetRowsFor), so the guard and the lookups cannot disagree.

/** The live rows of `table` (HsrCharacterCost or HsrLightconeCost) for a cost set, game mode and draft mode. */
function costSetRowsFor(ctx: any, table: 'HsrCharacterCost' | 'HsrLightconeCost', costSetId: number, gameModeTag: string, draftModeTag: string): any[] {
    return [...ctx.db[table].cost_set_id.filter(costSetId)].filter(
        (r: any) => r.gameMode.tag === gameModeTag && r.draftMode.tag === draftModeTag,
    );
}

/** A107(5): the rejection text for an entry without a row in the lobby's cost set and mode. */
export const costMissingText = (name: string) => `${name} has no cost in this lobby's cost set.`;

/** The lobby's HsrCharacterCost row of a character (cost set, game mode, draft mode), or undefined. */
export function characterCostRow(ctx: any, lobby: any, characterName: string): any {
    return costSetRowsFor(ctx, 'HsrCharacterCost', lobby.costSetId, lobby.gameMode.tag, lobby.draftMode.tag)
        .find((r: any) => r.characterName === characterName);
}

/** The lobby's HsrLightconeCost row of a light cone (cost set, game mode, draft mode), or undefined. */
export function lightconeCostRow(ctx: any, lobby: any, lightconeName: string): any {
    return costSetRowsFor(ctx, 'HsrLightconeCost', lobby.costSetId, lobby.gameMode.tag, lobby.draftMode.tag)
        .find((r: any) => r.lightconeName === lightconeName);
}

/** The character names the lobby's cost set prices in its game mode and draft mode (the timer pools draw from these). */
export function pricedCharacterNames(ctx: any, lobby: any): Set<string> {
    return new Set(costSetRowsFor(ctx, 'HsrCharacterCost', lobby.costSetId, lobby.gameMode.tag, lobby.draftMode.tag)
        .map((r: any) => r.characterName));
}

/** S10i review F3 (A108(2)): the rejection text for a cost row that exists but lacks the requested field (a data defect). */
export const costFieldMissingText = (name: string, field: string) => `The cost row of ${name} has no ${field} value.`;

/** The `field` (e0..e6 / s1..s5) of a cost row; a row without it is rejected, never priced at a default. */
function costField(row: any, name: string, field: string): number {
    const value = row.costs[field];
    if (typeof value !== 'number') throw new SenderError(costFieldMissingText(name, field));
    return value;
}

/**
 * A107(5): the lobby's cost of a character at an eidolon level (pick, nomination, bid, sale, set_eidolon). EMPTY costs 0
 * by rule; a character without a row is rejected (costMissingText), a row without the eidolon's field too
 * (costFieldMissingText).
 */
export function characterCostAt(ctx: any, lobby: any, characterName: string, eidolon: number): number {
    if (characterName === 'EMPTY') return 0;
    const row = characterCostRow(ctx, lobby, characterName);
    if (!row) throw new SenderError(costMissingText(characterName));
    return costField(row, characterName, `e${eidolon}`);
}

/** A107(5): the lobby's cost of a light cone at a superimposition (equip_lightcone); no row or no such field → rejected. */
export function lightconeCostAt(ctx: any, lobby: any, lightconeName: string, superimposition: number): number {
    const row = lightconeCostRow(ctx, lobby, lightconeName);
    if (!row) throw new SenderError(costMissingText(lightconeName));
    return costField(row, lightconeName, `s${superimposition}`);
}

/**
 * D-D6 loose coverage: at least one HsrCharacterCost row and at least one HsrLightconeCost row for
 * (costSetId, gameMode, draftMode), the rows the A107 lookups read. Synergies are an optional modifier and never a
 * rejection condition. S10i review F2 (A108(2)): the default set (id 0) is checked like any other, so a database whose
 * seed lacks a mode's rows is refused at selection, not mid-draft.
 */
export function doesCostSetCover(ctx: any, costSetId: number, gameModeTag: string, draftModeTag: string): boolean {
    if (costSetRowsFor(ctx, 'HsrCharacterCost', costSetId, gameModeTag, draftModeTag).length === 0) return false;
    return costSetRowsFor(ctx, 'HsrLightconeCost', costSetId, gameModeTag, draftModeTag).length > 0;
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

/**
 * A107(4): the lobbies on a cost set whose game is live (Drafting, Equipping or Scoring); a patch of the set is refused
 * while this is above 0. Index read: Lobby.stage filtered per live stage, then the costSetId compared (Lobby has no
 * costSetId index). Waiting rooms and lobbies past the game (AwaitingResult) do not count.
 */
export function liveLobbiesOnCostSet(ctx: any, costSetId: number): number {
    let count = 0;
    for (const stage of ['Drafting', 'Equipping', 'Scoring']) {
        for (const lobby of ctx.db.Lobby.stage.filter({ tag: stage, value: {} } as any)) {
            if (lobby.costSetId === costSetId) count++;
        }
    }
    return count;
}

/**
 * Deletes a cost set's live rows (HsrCharacterCost / HsrLightconeCost / HsrSynergyCost), its draft rows
 * (CostSetDraft*) and the CostSet row. delete_cost_set runs it after its guards; S10r (A122(6), L89): the user
 * deletion cascade runs it for the user's unpublished sets that isCostSetInUse does not hold.
 */
export function deleteCostSetRows(ctx: any, costSetId: number): void {
    for (const row of [...ctx.db.HsrCharacterCost.cost_set_id.filter(costSetId)]) ctx.db.HsrCharacterCost.delete(row);
    for (const row of [...ctx.db.HsrLightconeCost.cost_set_id.filter(costSetId)]) ctx.db.HsrLightconeCost.delete(row);
    for (const row of [...ctx.db.HsrSynergyCost.cost_set_id.filter(costSetId)]) ctx.db.HsrSynergyCost.id.delete(row.id);
    for (const row of [...ctx.db.CostSetDraftCharacter.cost_set_id.filter(costSetId)]) ctx.db.CostSetDraftCharacter.delete(row);
    for (const row of [...ctx.db.CostSetDraftLightcone.cost_set_id.filter(costSetId)]) ctx.db.CostSetDraftLightcone.delete(row);
    for (const row of [...ctx.db.CostSetDraftSynergy.cost_set_id.filter(costSetId)]) ctx.db.CostSetDraftSynergy.delete(row);
    ctx.db.CostSet.id.delete(costSetId);
}

/** delete_cost_set guard: any Lobby (A67(1): every lobby stage is live) or a non-terminal Tournament still references the set. */
export function isCostSetInUse(ctx: any, costSetId: number): boolean {
    // iter() required: neither Lobby nor Tournament has a costSetId index; Lobby holds live lobbies only (GC'd)
    // and Tournament is small, and this runs only on an explicit delete.
    for (const lobby of ctx.db.Lobby.iter()) {
        if (lobby.costSetId === costSetId) return true;
    }
    for (const tournament of ctx.db.Tournament.iter()) {
        if (tournament.costSetId === costSetId
            && tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled') return true;
    }
    return false;
}
