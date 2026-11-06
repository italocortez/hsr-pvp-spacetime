import { CharacterCost, Character, Element, GAME_MODE_VARIANTS, LightconeAnchor, LightconeCost, Lightcone, Path, Rarity, Role, RuleSet, Synergy } from "@/components/features/types/enums";
import { HsrCharacterCostRow, HsrCharacterRow, HsrLightconeCostRow, HsrLightconeRow, HsrSynergyCostRow } from "./GameDataProvider";

export const getCharacterCost = (characterCostRows: readonly HsrCharacterCostRow[], characterName: string): CharacterCost => {
    // Searching for multiple entries, as char cost is separated by ruleSets
    const charCosts: HsrCharacterCostRow[] = characterCostRows.filter(row => row.characterName === characterName);

    const emptyEidolonCost = () => ({ E0: 0, E1: 0, E2: 0, E3: 0, E4: 0, E5: 0, E6: 0 });
    const toEidolonCost = (arr: unknown): { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number } => {
        const values = Array.isArray(arr) ? arr : Object.values(arr ?? {});

        return Object.fromEntries(
            values.map((v, i) => [`E${i}`, Number(v)])
        ) as { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number };
    };

    const costSheet: CharacterCost = {
        Classic: Object.fromEntries(
            GAME_MODE_VARIANTS.map(m => [m, emptyEidolonCost()])
        ) as Record<RuleSet, { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number }>,

        Auction: Object.fromEntries(
            GAME_MODE_VARIANTS.map(m => [m, emptyEidolonCost()])
        ) as Record<RuleSet, { E0: number, E1: number, E2: number, E3: number, E4: number, E5: number, E6: number }>,
    };

    for (const sheet of charCosts) {
        const mode = sheet.gameMode.tag as RuleSet;
        const draftMode = sheet.draftMode?.tag;
        if (draftMode === 'Classic') {
            costSheet.Classic[mode] = toEidolonCost(sheet.costs);
        } else if (draftMode === 'Auction') {
            costSheet.Auction[mode] = toEidolonCost(sheet.costs);
        }
    }

    return costSheet;
}

export const getLightconeCost = (lightconeCostRows: readonly HsrLightconeCostRow[], lightconeName: string): LightconeCost => {
    // Post-15.4: one row per (lightconeName, gameMode, draftMode, costSetId).
    // LightconeCost has no gameMode axis today (Phase 17 redesign concern), so we
    // deterministically collapse to a canonical gameMode (MemoryOfChaos) to avoid
    // nondeterministic last-row-wins behavior across gameModes (WR-01 Phase 15.4).
    const CANONICAL_MODE = 'MemoryOfChaos';
    const lcCosts = lightconeCostRows.filter(r => r.lightconeName === lightconeName);

    const emptyImpositionCost = { S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 };

    const toCost = (arr: unknown) =>
        Object.fromEntries(
            (Array.isArray(arr) ? arr : Object.values(arr ?? {}))
                .map((v, i) => [`S${i + 1}`, Number(v)])
    ) as typeof emptyImpositionCost;

    const sheet: LightconeCost = { Classic: { ...emptyImpositionCost }, Auction: { ...emptyImpositionCost } };
    for (const row of lcCosts) {
        if (row.gameMode.tag !== CANONICAL_MODE) continue;
        const draftMode = row.draftMode?.tag;
        if (draftMode === 'Classic') {
            sheet.Classic = toCost(row.costs);
        } else if (draftMode === 'Auction') {
            sheet.Auction = toCost(row.costs);
        }
    }
    return sheet;
}

export const getLightconeAnchor = (lightcone: HsrLightconeRow): LightconeAnchor => {
    return {
        x: lightcone.posX as number,
        y: lightcone.posY as number,
        width: lightcone.width as number
    };
}

export const mapToCharacterData = (characterCostRows: readonly HsrCharacterCostRow[], character: HsrCharacterRow): Character => ({
    name: character.name as string,
    displayName: character.displayName as string,
    aliases: character.aliases as string[],
    element: character.element.tag as Element,
    path: character.path.tag as Path,
    rarity: character.rarity as Rarity,
    role: character.role.tag as Role,
    imageUrl: character.imageUrl as string | undefined,
    cost: getCharacterCost(characterCostRows, character.name as string)
});

export const mapToLightconeData = (lightconeCostRows: readonly HsrLightconeCostRow[], lightcone: HsrLightconeRow): Lightcone => ({
    name: lightcone.name as string,
    displayName: lightcone.displayName as string,
    aliases: lightcone.aliases as string[],
    path: lightcone.path.tag as Path,
    rarity: lightcone.rarity as Rarity,
    imageUrl: lightcone.imageUrl as string | undefined,
    anchor: getLightconeAnchor(lightcone),
    cost: getLightconeCost(lightconeCostRows, lightcone.name as string)
});

export const mapToSynergyData = (synergy: HsrSynergyCostRow): Synergy => ({
    id: synergy.id as number,
    sourceName: synergy.sourceName as string,
    targetName: synergy.targetName as string,
    ruleSet: synergy.gameMode.tag as RuleSet,
    costModifier: synergy.costModifier as number
});