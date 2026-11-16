import type {
    CostSet,
    HsrCharacter,
    HsrCharacterCost,
    HsrLightcone,
    HsrLightconeCost,
    HsrSynergyCost,
} from '@bindings/types';
import type { DraftModeTag, GameModeTag } from '@/stdb/costLookup';

/*
 * Test rows for the costs page (T-COSTS), in the shapes of data/seed/*.json as the module stores
 * them (names, display names, aliases including the seed's joke alias "feet" for Clara, the
 * enums as tags). Audit columns are zero.
 */

const AUDIT = {
    createdById: 0,
    createdDate: { microsSinceUnixEpoch: 0n },
    lastModifiedById: 0,
    lastModifiedDate: { microsSinceUnixEpoch: 0n },
} as unknown as Pick<
    HsrCharacter,
    'createdById' | 'createdDate' | 'lastModifiedById' | 'lastModifiedDate'
>;

export const IMG = (key: string) => `https://zmvtaeh9bl.ufs.sh/f/${key}`;

export function character(
    name: string,
    displayName: string,
    o: {
        aliases?: string[];
        rarity?: number;
        path?: string;
        element?: string;
        role?: string;
        image?: string;
    } = {},
): HsrCharacter {
    return {
        name,
        displayName,
        aliases: o.aliases ?? [name],
        rarity: o.rarity ?? 5,
        path: { tag: o.path ?? 'Nihility' },
        element: { tag: o.element ?? 'Lightning' },
        role: { tag: o.role ?? 'Dps' },
        imageUrl: o.image ?? IMG(name),
        versionReleased: 1,
        treatAsVersion: 0,
        posX: 0,
        posY: 0,
        width: 0,
        ...AUDIT,
    } as unknown as HsrCharacter;
}

export function lightcone(
    name: string,
    displayName: string,
    o: { aliases?: string[]; rarity?: number; path?: string; image?: string } = {},
): HsrLightcone {
    return {
        name,
        displayName,
        aliases: o.aliases ?? [name],
        rarity: o.rarity ?? 5,
        path: { tag: o.path ?? 'Harmony' },
        imageUrl: o.image ?? IMG(name),
        posX: 0,
        posY: 0,
        width: 0,
        ...AUDIT,
    } as unknown as HsrLightcone;
}

const EIDOLONS = (e0: number) => ({
    e0,
    e1: e0 + 1,
    e2: e0 + 2,
    e3: e0 + 3,
    e4: e0 + 4,
    e5: e0 + 5,
    e6: e0 + 6,
});

export function characterCost(
    characterName: string,
    e0: number,
    o: { set?: number; mode?: GameModeTag; draft?: DraftModeTag } = {},
): HsrCharacterCost {
    return {
        characterName,
        gameMode: { tag: o.mode ?? 'ApocalypticShadow' },
        draftMode: { tag: o.draft ?? 'Classic' },
        costs: EIDOLONS(e0),
        costSetId: o.set ?? 0,
        ...AUDIT,
    } as unknown as HsrCharacterCost;
}

export function lightconeCost(
    lightconeName: string,
    s1: number,
    o: { set?: number; mode?: GameModeTag; draft?: DraftModeTag } = {},
): HsrLightconeCost {
    return {
        lightconeName,
        gameMode: { tag: o.mode ?? 'ApocalypticShadow' },
        draftMode: { tag: o.draft ?? 'Classic' },
        costs: { s1, s2: s1 + 0.5, s3: s1 + 1, s4: s1 + 1.5, s5: s1 + 2 },
        costSetId: o.set ?? 0,
        ...AUDIT,
    } as unknown as HsrLightconeCost;
}

let synergyId = 1;
export function synergy(
    characterA: string,
    characterB: string,
    costModifier: number,
    o: { set?: number; mode?: GameModeTag; draft?: DraftModeTag } = {},
): HsrSynergyCost {
    return {
        id: synergyId++,
        characterA,
        characterB,
        gameMode: { tag: o.mode ?? 'ApocalypticShadow' },
        draftMode: { tag: o.draft ?? 'Classic' },
        costModifier,
        costSetId: o.set ?? 0,
        ...AUDIT,
    } as unknown as HsrSynergyCost;
}

export function costSet(
    id: number,
    name: string,
    o: { mode?: GameModeTag; locked?: boolean } = {},
): CostSet {
    return {
        id,
        name,
        creatorId: 1,
        gameMode: { tag: o.mode ?? 'ApocalypticShadow' },
        isPublished: true,
        isDraft: false,
        isLocked: o.locked ?? false,
        ...AUDIT,
    } as unknown as CostSet;
}

/** A small roster in the seed's shapes. */
export const CHARACTERS = [
    character('acheron', 'Acheron', { element: 'Lightning', path: 'Nihility', role: 'Dps' }),
    character('clara', 'Clara', {
        aliases: ['clara', 'feet'],
        element: 'Physical',
        path: 'Destruction',
        role: 'Dps',
    }),
    character('pela', 'Pela', {
        rarity: 4,
        element: 'Ice',
        path: 'Nihility',
        role: 'Support',
    }),
    character('huohuo', 'Huohuo', { element: 'Wind', path: 'Abundance', role: 'Sustain' }),
];

export const LIGHTCONES = [
    lightcone('pastselfinmirror', 'Past Self in Mirror', { aliases: ['psim'], path: 'Harmony' }),
    lightcone('meshingcogs', 'Meshing Cogs', { rarity: 3, path: 'Harmony' }),
    lightcone('nowheretorun', 'Nowhere to Run', { rarity: 4, path: 'Destruction', image: '' }),
];
