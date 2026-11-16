import type { HsrCharacterCost, HsrLightconeCost, HsrSynergyCost } from '@bindings/types';

/*
 * Lookups over the cost rows of one cost set (S14.2), shared by the reference set (the default
 * set) and a page's custom-set subscription. Pure; no SDK import.
 *
 * The client cache is one table per cost table for every subscribed set, so rows are always
 * filtered by `costSetId` first (`rowsOfSet`): a cache that holds the default set and a custom set
 * at once must never mix them.
 */

export type GameModeTag = 'MemoryOfChaos' | 'ApocalypticShadow' | 'AnomalyArbitration';
export type DraftModeTag = 'Classic' | 'Auction';

/** The rows of one cost set, from a cache that may hold several. */
export function rowsOfSet<Row extends { costSetId: number }>(
    rows: Iterable<Row>,
    costSetId: number,
): Row[] {
    const out: Row[] = [];
    for (const row of rows) if (row.costSetId === costSetId) out.push(row);
    return out;
}

const key = (name: string, gameMode: string, draftMode: string) =>
    `${gameMode}\u0000${draftMode}\u0000${name}`;

export type CostLookup = {
    /** The character's cost row for the mode pair, or undefined (not priced there). */
    character(
        name: string,
        gameMode: GameModeTag,
        draftMode: DraftModeTag,
    ): HsrCharacterCost | undefined;
    lightcone(
        name: string,
        gameMode: GameModeTag,
        draftMode: DraftModeTag,
    ): HsrLightconeCost | undefined;
    /** The synergy rows of the mode pair (both orders of a pair are one row, A21). */
    synergies(gameMode: GameModeTag, draftMode: DraftModeTag): readonly HsrSynergyCost[];
};

/** Builds the lookups of one set's rows (callers memoize on the row arrays). */
export function buildCostLookup(
    characterCosts: readonly HsrCharacterCost[],
    lightconeCosts: readonly HsrLightconeCost[],
    synergyCosts: readonly HsrSynergyCost[],
): CostLookup {
    const characters = new Map<string, HsrCharacterCost>();
    for (const row of characterCosts) {
        characters.set(key(row.characterName, row.gameMode.tag, row.draftMode.tag), row);
    }
    const lightcones = new Map<string, HsrLightconeCost>();
    for (const row of lightconeCosts) {
        lightcones.set(key(row.lightconeName, row.gameMode.tag, row.draftMode.tag), row);
    }
    const synergies = new Map<string, HsrSynergyCost[]>();
    for (const row of synergyCosts) {
        const k = key('', row.gameMode.tag, row.draftMode.tag);
        const list = synergies.get(k);
        if (list) list.push(row);
        else synergies.set(k, [row]);
    }
    return {
        character: (name, gameMode, draftMode) => characters.get(key(name, gameMode, draftMode)),
        lightcone: (name, gameMode, draftMode) => lightcones.get(key(name, gameMode, draftMode)),
        synergies: (gameMode, draftMode) => synergies.get(key('', gameMode, draftMode)) ?? [],
    };
}
