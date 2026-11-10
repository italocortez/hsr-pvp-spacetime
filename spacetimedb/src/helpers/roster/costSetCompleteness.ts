// ─── Cost-set completeness and patching (A107(2)(3)) ─────────────────────────────────────────────────────
// Shared by publish_cost_set, the edit_draft_*_cost reducers and view_cost_set_missing.
//
// The draft copy (CostSetDraft*) of a set is its full editable image: since S10i publish no longer deletes it, so a
// published, unlocked set stays editable and publishing again makes the live rows equal to the draft (patch in place).
// A set published before S10i has no draft rows; ensureDraftCopy rebuilds the draft from the live rows the first time
// such a set is edited or published again, so a patch never starts from an empty draft.

import { SenderError } from 'spacetimedb/server';
import { auditInsert, auditUpdate } from '@module/helpers/admin/auditColumns';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';

export type CostEntryKind = 'Character' | 'Lightcone';

export interface MissingCostEntry {
    draftMode: string;
    kind: CostEntryKind;
    name: string;
}

const EIDOLON_KEYS = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
const SUPERIMPOSITION_KEYS = ['s1', 's2', 's3', 's4', 's5'];

const zeroCosts = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, 0]));
const sameCosts = (a: any, b: any, keys: string[]) => keys.every((k) => a[k] === b[k]);

const draftChars = (ctx: any, id: number): any[] => [...ctx.db.CostSetDraftCharacter.cost_set_id.filter(id)];
const draftLcs = (ctx: any, id: number): any[] => [...ctx.db.CostSetDraftLightcone.cost_set_id.filter(id)];
const draftSyns = (ctx: any, id: number): any[] => [...ctx.db.CostSetDraftSynergy.cost_set_id.filter(id)];
const liveChars = (ctx: any, id: number): any[] => [...ctx.db.HsrCharacterCost.cost_set_id.filter(id)];
const liveLcs = (ctx: any, id: number): any[] => [...ctx.db.HsrLightconeCost.cost_set_id.filter(id)];
const liveSyns = (ctx: any, id: number): any[] => [...ctx.db.HsrSynergyCost.cost_set_id.filter(id)];

/** True when the set has no row in any of the three draft tables. */
function draftIsEmpty(ctx: any, costSetId: number): boolean {
    return draftChars(ctx, costSetId).length === 0
        && draftLcs(ctx, costSetId).length === 0
        && draftSyns(ctx, costSetId).length === 0;
}

/**
 * The character and light-cone rows the draft of a set holds, for the completeness check. A published set without
 * any draft row (published before S10i) reads its live rows instead: that is what ensureDraftCopy would copy.
 */
export function effectiveDraftRows(ctx: any, costSet: any): { characters: any[]; lightcones: any[] } {
    if (costSet.isPublished && draftIsEmpty(ctx, costSet.id)) {
        return { characters: liveChars(ctx, costSet.id), lightcones: liveLcs(ctx, costSet.id) };
    }
    return { characters: draftChars(ctx, costSet.id), lightcones: draftLcs(ctx, costSet.id) };
}

/**
 * A107(2): per draft mode the draft prices at all (a character or light-cone row of the set's game mode with that
 * draft mode; synergy rows do not count), the HsrCharacter and HsrLightcone reference rows with no draft row in that
 * mode. A draft mode without any character or light-cone row is not listed. Sorted by draft mode, kind, name.
 */
export function missingCostEntries(ctx: any, costSet: any): MissingCostEntry[] {
    const gameModeTag = costSet.gameMode.tag;
    const { characters, lightcones } = effectiveDraftRows(ctx, costSet);
    const inMode = (r: any) => r.gameMode.tag === gameModeTag;
    const pricedModes = new Set<string>();
    for (const r of [...characters, ...lightcones]) if (inMode(r)) pricedModes.add(r.draftMode.tag);
    if (pricedModes.size === 0) return [];

    const charKeys = new Set(characters.filter(inMode).map((r: any) => `${r.draftMode.tag}|${r.characterName}`));
    const lcKeys = new Set(lightcones.filter(inMode).map((r: any) => `${r.draftMode.tag}|${r.lightconeName}`));
    // iter(): the completeness check is against the whole reference data (HsrCharacter ~100 rows, HsrLightcone ~160);
    // callers check the owner / Moderator+ permission before this read.
    const charNames = [...ctx.db.HsrCharacter.iter()].map((c: any) => c.name).sort();
    const lcNames = [...ctx.db.HsrLightcone.iter()].map((l: any) => l.name).sort();

    const missing: MissingCostEntry[] = [];
    for (const draftMode of [...pricedModes].sort()) {
        for (const name of charNames) if (!charKeys.has(`${draftMode}|${name}`)) missing.push({ draftMode, kind: 'Character', name });
        for (const name of lcNames) if (!lcKeys.has(`${draftMode}|${name}`)) missing.push({ draftMode, kind: 'Lightcone', name });
    }
    return missing;
}

/** The publish refusal text: the missing counts per kind, then per draft mode. */
export function missingCostText(missing: MissingCostEntry[]): string {
    const count = (kind: CostEntryKind, mode?: string) =>
        missing.filter((m) => m.kind === kind && (mode === undefined || m.draftMode === mode)).length;
    const modes = [...new Set(missing.map((m) => m.draftMode))];
    const perMode = modes
        .map((mode) => `${mode}: ${count('Character', mode)} characters, ${count('Lightcone', mode)} light cones`)
        .join('; ');
    return `This cost set has no cost for ${count('Character')} characters and ${count('Lightcone')} light cones `
        + `(${perMode}). Confirm to publish them at cost 0.`;
}

/** A107(2): writes the missing entries into the draft at cost 0 (every eidolon / superimposition field 0). */
export function fillMissingAtZero(ctx: any, costSet: any, missing: MissingCostEntry[], userId: number): void {
    for (const m of missing) {
        const base = {
            costSetId: costSet.id,
            gameMode: costSet.gameMode,
            draftMode: { tag: m.draftMode, value: {} },
            ...auditInsert(ctx, userId),
        };
        if (m.kind === 'Character') {
            ctx.db.CostSetDraftCharacter.insert({ ...base, characterName: m.name, costs: zeroCosts(EIDOLON_KEYS) } as any);
        } else {
            ctx.db.CostSetDraftLightcone.insert({ ...base, lightconeName: m.name, costs: zeroCosts(SUPERIMPOSITION_KEYS) } as any);
        }
    }
}

/**
 * A107(3): a published set without any draft row (published before S10i, when publish deleted the draft) gets its
 * draft rebuilt from its live rows, so an edit or a re-publish starts from the live prices. No-op otherwise.
 */
export function ensureDraftCopy(ctx: any, costSet: any, userId: number): void {
    if (!costSet.isPublished || !draftIsEmpty(ctx, costSet.id)) return;
    for (const r of liveChars(ctx, costSet.id)) {
        ctx.db.CostSetDraftCharacter.insert({
            costSetId: costSet.id, characterName: r.characterName, gameMode: r.gameMode, draftMode: r.draftMode, costs: r.costs,
            ...auditInsert(ctx, userId),
        } as any);
    }
    for (const r of liveLcs(ctx, costSet.id)) {
        ctx.db.CostSetDraftLightcone.insert({
            costSetId: costSet.id, lightconeName: r.lightconeName, gameMode: r.gameMode, draftMode: r.draftMode, costs: r.costs,
            ...auditInsert(ctx, userId),
        } as any);
    }
    for (const r of liveSyns(ctx, costSet.id)) {
        ctx.db.CostSetDraftSynergy.insert({
            costSetId: costSet.id, characterA: r.characterA, characterB: r.characterB, gameMode: r.gameMode, draftMode: r.draftMode,
            costModifier: r.costModifier,
            ...auditInsert(ctx, userId),
        } as any);
    }
}

/**
 * A107(3): makes the live rows of the set equal to its draft rows, under the same cost set id. A draft row with no
 * live row is inserted; a live row whose price differs is replaced (audit kept, auditUpdate); an unchanged live row is
 * left alone (no write, so no broadcast to the public cost tables' subscribers); a live row with no draft row is
 * deleted. The draft is kept (it stays the editable copy).
 */
export function mirrorDraftToLive(ctx: any, costSetId: number, userId: number): void {
    const charKey = (r: any) => `${r.characterName}|${r.gameMode.tag}|${r.draftMode.tag}`;
    const live = new Map(liveChars(ctx, costSetId).map((r) => [charKey(r), r]));
    for (const d of draftChars(ctx, costSetId)) {
        const existing = live.get(charKey(d));
        live.delete(charKey(d));
        if (existing && sameCosts(existing.costs, d.costs, EIDOLON_KEYS)) continue;
        if (existing) ctx.db.HsrCharacterCost.delete(existing);
        ctx.db.HsrCharacterCost.insert({
            characterName: d.characterName, gameMode: d.gameMode, draftMode: d.draftMode, costs: d.costs, costSetId,
            ...(existing ? auditUpdate(ctx, existing, userId) : auditInsert(ctx, userId)),
        } as any);
    }
    for (const stale of live.values()) ctx.db.HsrCharacterCost.delete(stale);

    const lcKey = (r: any) => `${r.lightconeName}|${r.gameMode.tag}|${r.draftMode.tag}`;
    const liveLc = new Map(liveLcs(ctx, costSetId).map((r) => [lcKey(r), r]));
    for (const d of draftLcs(ctx, costSetId)) {
        const existing = liveLc.get(lcKey(d));
        liveLc.delete(lcKey(d));
        if (existing && sameCosts(existing.costs, d.costs, SUPERIMPOSITION_KEYS)) continue;
        if (existing) ctx.db.HsrLightconeCost.delete(existing);
        ctx.db.HsrLightconeCost.insert({
            lightconeName: d.lightconeName, gameMode: d.gameMode, draftMode: d.draftMode, costs: d.costs, costSetId,
            ...(existing ? auditUpdate(ctx, existing, userId) : auditInsert(ctx, userId)),
        } as any);
    }
    for (const stale of liveLc.values()) ctx.db.HsrLightconeCost.delete(stale);

    // HsrSynergyCost has an autoInc id: a changed modifier is an id.update (the id is kept).
    const synKey = (r: any) => `${r.characterA}|${r.characterB}|${r.gameMode.tag}|${r.draftMode.tag}`;
    const liveSyn = new Map(liveSyns(ctx, costSetId).map((r) => [synKey(r), r]));
    for (const d of draftSyns(ctx, costSetId)) {
        const existing = liveSyn.get(synKey(d));
        liveSyn.delete(synKey(d));
        if (existing) {
            if (existing.costModifier !== d.costModifier) {
                ctx.db.HsrSynergyCost.id.update(updateWithAudit(ctx, existing, { costModifier: d.costModifier }, userId));
            }
            continue;
        }
        ctx.db.HsrSynergyCost.insert({
            id: 0, characterA: d.characterA, characterB: d.characterB, gameMode: d.gameMode, draftMode: d.draftMode,
            costModifier: d.costModifier, costSetId,
            ...auditInsert(ctx, userId),
        } as any);
    }
    for (const stale of liveSyn.values()) ctx.db.HsrSynergyCost.id.delete(stale.id);
}

/**
 * A107(3): the draft of a set is editable, and the set publishable, while it is a draft or published and not locked.
 * A locked set and an unpublished set (unpublish needs a lock first) are frozen.
 */
export function ensureCostSetPatchable(costSet: any): void {
    if (costSet.isDraft) return;
    if (costSet.isPublished && !costSet.isLocked) return;
    if (costSet.isLocked) throw new SenderError('This cost set is locked; its costs cannot be changed.');
    throw new SenderError('This cost set is unpublished; its costs cannot be changed.');
}
