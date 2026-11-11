// Fixtures: cost sets (create, edit, publish), cost rows and ladders, reference rows for bulk upserts, the live-cost
//   lock text.
// From S10 (s10-c1-fixtures.ts: cost data, with copies of s6-rules' E, S, publishedCostSet), S10i
// (s10i-draft-cost.test.ts: priced sets and ladders), S10w (s10w-account-edit-lock.test.ts: COST_LOCKED); gathered
// by T-REORG2.
//
// Not a test file. State is built through the module's reducers; `test.db` is read only outside `tx` bodies.
// Nothing reaches maincloud.
import { M, tx, type Actor, type CostKey, type Harness } from './harness';
import { seedReferenceNames } from './roster';

// ─── Costs and ladders ───────────────────────────────────────────────────────

export const MOC = 'MemoryOfChaos';
export type Mode = 'Classic' | 'Auction';

export const E = (n: number) => JSON.stringify({ e0: n, e1: n, e2: n, e3: n, e4: n, e5: n, e6: n });
export const S = (n: number) => JSON.stringify({ s1: n, s2: n, s3: n, s4: n, s5: n });
export const eCost = (n: number) => ({ e0: n, e1: n, e2: n, e3: n, e4: n, e5: n, e6: n });
export const sCost = (n: number) => ({ s1: n, s2: n, s3: n, s4: n, s5: n });

/** e0..e6 = base, base + step, ... */
export const ladder = (base: number, step = 1) => Array.from({ length: 7 }, (_, i) => base + i * step);
/** s1..s5 = base, base + 1, ... */
export const sLadder = (base: number) => Array.from({ length: 5 }, (_, i) => base + i);
export const eJson = (l: number[]) => JSON.stringify({ e0: l[0], e1: l[1], e2: l[2], e3: l[3], e4: l[4], e5: l[5], e6: l[6] });
export const sJson = (l: number[]) => JSON.stringify({ s1: l[0], s2: l[1], s3: l[2], s4: l[3], s5: l[4] });
export const key0 = (draftMode: Mode): CostKey => ({ costSetId: 0, gameMode: MOC, draftMode });

/** A142: the Admin cost-row refusal while lobbies using the set are live (the A107(4) test). */
export const COST_LOCKED = (costSetId: number, live: number) =>
    `Cannot change a cost row of cost set ${costSetId} while ${live} ${live === 1 ? 'lobby using it is' : 'lobbies using it are'} in Drafting, Equipping or Scoring.`;

// ─── Cost-set reducers (Memory of Chaos sets) ─────────────────────────────────

export function createSet(test: Harness, who: Actor | 'internal', name: string, sourceSetId = 0): number {
    tx(test, who, (ctx) => M.create_cost_set(ctx, { name, sourceSetId, gameModeTag: MOC }));
    return [...test.db.CostSet.iter()].find((r) => r.name === name)!.id;
}
export const editChar = (test: Harness, who: Actor | 'internal', costSetId: number, characterName: string, draftModeTag: Mode, l: number[]) =>
    tx(test, who, (ctx) => M.edit_draft_character_cost(ctx, { costSetId, characterName, gameModeTag: MOC, draftModeTag, costsJson: eJson(l) }));
export const editLc = (test: Harness, who: Actor | 'internal', costSetId: number, lightconeName: string, draftModeTag: Mode, l: number[]) =>
    tx(test, who, (ctx) => M.edit_draft_lightcone_cost(ctx, { costSetId, lightconeName, gameModeTag: MOC, draftModeTag, costsJson: sJson(l) }));
export const publishBody = (costSetId: number, confirmFillMissing?: boolean) => (ctx: any) =>
    M.publish_cost_set(ctx, { costSetId, confirmFillMissing });
export const publish = (test: Harness, who: Actor | 'internal', costSetId: number, confirmFillMissing?: boolean) =>
    tx(test, who, publishBody(costSetId, confirmFillMissing));

/** A published cost set (owner SYSTEM) with one character row and one light-cone row for MoC × the draft mode. */
export function publishedCostSet(test: Harness, name: string, draftModeTag: 'Classic' | 'Auction' | null): number {
    tx(test, 'internal', (ctx) => M.create_cost_set(ctx, { name, sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
    const id = costSetId(test, name);
    if (draftModeTag) {
        // T-S10f (roster audit #9): edit_draft_*_cost requires the HsrCharacter / HsrLightcone rows
        seedReferenceNames(test, ['acheron'], ['along-the-passing-shore']);
        tx(test, 'internal', (ctx) => M.edit_draft_character_cost(ctx, {
            costSetId: id, characterName: 'acheron', gameModeTag: 'MemoryOfChaos', draftModeTag, costsJson: E(2),
        }));
        tx(test, 'internal', (ctx) => M.edit_draft_lightcone_cost(ctx, {
            costSetId: id, lightconeName: 'along-the-passing-shore', gameModeTag: 'MemoryOfChaos', draftModeTag, costsJson: S(1),
        }));
    }
    tx(test, 'internal', (ctx) => M.publish_cost_set(ctx, { costSetId: id }));
    return id;
}

export const costSetId = (test: Harness, name: string) => [...test.db.CostSet.iter()].find((c) => c.name === name)!.id;
export const costSetRow = (test: Harness, id: number) => test.db.CostSet.id.find(id);

// ─── Cost rows ───────────────────────────────────────────────────────────────

export const liveChar = (test: Harness, costSetId: number) => [...test.db.HsrCharacterCost.cost_set_id.filter(costSetId)];
export const liveChars = liveChar;
export const liveLc = (test: Harness, costSetId: number) => [...test.db.HsrLightconeCost.cost_set_id.filter(costSetId)];
export const liveSyn = (test: Harness, costSetId: number) => [...test.db.HsrSynergyCost.cost_set_id.filter(costSetId)];
export const draftChar = (test: Harness, costSetId: number) => [...test.db.CostSetDraftCharacter.cost_set_id.filter(costSetId)];
export const draftLc = (test: Harness, costSetId: number) => [...test.db.CostSetDraftLightcone.cost_set_id.filter(costSetId)];
export const draftSyn = (test: Harness, costSetId: number) => [...test.db.CostSetDraftSynergy.cost_set_id.filter(costSetId)];
export const charRow = (rows: any[], name: string, mode: Mode = 'Classic') =>
    rows.find((r) => r.characterName === name && r.draftMode.tag === mode && r.gameMode.tag === MOC);

/** `${name}|${gameMode}|${draftMode}` keys of cost rows, sorted (for set-shaped assertions). */
export const keysOf = (rows: Array<{ gameMode: { tag: string }; draftMode: { tag: string } } & Record<string, any>>, nameField: string) =>
    rows.map((r) => `${r[nameField]}|${r.gameMode.tag}|${r.draftMode.tag}`).sort();

// ─── Bulk-upsert rows (admin_bulk_upsert) ─────────────────────────────────────

/** admin_bulk_upsert as `who` (default the owner, which init links to the SYSTEM Admin; what the seed script's token is). */
export function bulkUpsert(test: Harness, tableName: string, rows: unknown[], who: Actor | 'internal' = 'internal') {
    tx(test, who, (ctx) => M.admin_bulk_upsert(ctx, { tableName, jsonData: JSON.stringify(rows) }));
}

type DM = 'Classic' | 'Auction';
type GM = 'MemoryOfChaos' | 'ApocalypticShadow' | 'AnomalyArbitration';

export const charCostRow = (characterName: string, draftMode: DM, n: number, costSetId = 0, gameMode: GM = 'MemoryOfChaos') =>
    ({ characterName, gameMode, draftMode, costs: eCost(n), costSetId });
export const lcCostRow = (lightconeName: string, draftMode: DM, n: number, costSetId = 0, gameMode: GM = 'MemoryOfChaos') =>
    ({ lightconeName, gameMode, draftMode, costs: sCost(n), costSetId });
export const synergyRow = (characterA: string, characterB: string, draftMode: DM, costModifier: number, costSetId = 0, gameMode: GM = 'MemoryOfChaos') =>
    ({ characterA, characterB, gameMode, draftMode, costModifier, costSetId });

/** A full HsrCharacter bulk-upsert row (A17 column set). */
export const characterRow = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    displayName: name,
    aliases: [] as string[],
    rarity: 5,
    path: 'Destruction',
    element: 'Physical',
    role: 'Dps',
    imageUrl: '',
    versionReleased: 1,
    treatAsVersion: 1,
    posX: 0,
    posY: 0,
    width: 0,
    ...over,
});

/** A full HsrLightcone bulk-upsert row. */
export const lightconeRow = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    displayName: name,
    aliases: [] as string[],
    path: 'Destruction',
    rarity: 5,
    imageUrl: '',
    posX: 0,
    posY: 0,
    width: 0,
    ...over,
});
