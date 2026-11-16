/*
 * The subscription SQL for one cost set's rows (S14.2): the three cost tables filtered on
 * `cost_set_id`. Plain strings, so a page can import them without pulling the SDK into its chunk
 * (`entryChunk.test.ts` pins that the public routes reach no SDK module statically). The text is
 * exactly what the SDK's query builder writes for
 * `toSql(tables.hsrCharacterCost.where((r) => r.costSetId.eq(id)))` and its two siblings;
 * `costQueries.test.ts` compares the two with the installed SDK.
 *
 * The default set is the sentinel id 0 (no `cost_set` row); a custom set is a published
 * `cost_set` id. One set per query, so the default set's queries and a custom set's never
 * overlap (never `0 OR N`).
 */

export type CostQueries = {
    characters: string;
    lightcones: string;
    synergies: string;
};

/** The default cost set (`DEFAULT_COST_SET_ID` in the module's costSetGuards.ts). */
export const DEFAULT_COST_SET_ID = 0;

const U32_MAX = 4294967295;

/** True for an integer in the u32 range (a valid `cost_set_id`). */
export function isCostSetId(id: unknown): id is number {
    return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= U32_MAX;
}

function byCostSet(table: string, id: number): string {
    return `SELECT * FROM "${table}" WHERE "${table}"."cost_set_id" = ${id}`;
}

/** The three queries for cost set `id`; throws for anything that is not a u32 integer. */
export function costQueries(id: number): CostQueries {
    if (!isCostSetId(id)) throw new Error(`not a cost set id: ${String(id)}`);
    return {
        characters: byCostSet('hsr_character_cost', id),
        lightcones: byCostSet('hsr_lightcone_cost', id),
        synergies: byCostSet('hsr_synergy_cost', id),
    };
}

/** The three queries as a list, in a fixed order (characters, light cones, synergies). */
export function costQueryList(id: number): string[] {
    const q = costQueries(id);
    return [q.characters, q.lightcones, q.synergies];
}
