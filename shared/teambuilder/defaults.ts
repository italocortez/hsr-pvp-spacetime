import type { Eidolon, Superimposition } from './team';

// S14.3a: the levels a pick starts at.

/** A Trailblazer: the four "MC" characters of the seed (`trailblazerdestruction`, display name "MC Destruction"). */
export function isTrailblazer(character: { name: string; displayName: string }): boolean {
    return character.name.startsWith('trailblazer') || character.displayName.startsWith('MC ');
}

/**
 * A190 item 4 (both old apps): a character added to the team starts at E6 when it is a 4-star or a Trailblazer
 * (players own those at E6), at E0 when it is any other 5-star.
 */
export function defaultEidolon(character: {
    name: string;
    displayName: string;
    rarity: number;
}): Eidolon {
    return character.rarity <= 4 || isTrailblazer(character) ? 6 : 0;
}

/** A name or alias as the matching rules compare it: lower case, spaces removed. */
export const normName = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const norm = normName;

/**
 * The superimposition a newly equipped cone starts at (the mockup and the old apps): S1 for a limited 5-star cone,
 * S5 for anything else (4-star, 3-star, or a 5-star with the alias "shop", the six standard-shop cones).
 */
export function defaultSuperimposition(lightcone: {
    rarity: number;
    aliases: readonly string[];
}): Superimposition {
    return lightcone.rarity >= 5 && !lightcone.aliases.some((a) => norm(a) === 'shop') ? 1 : 5;
}

/**
 * A 5-star character's signature cone (the mockup's rule): the first cone with an alias equal to the character's
 * display name or one of its aliases, spaces and case ignored. 4-stars have none.
 */
export function signatureLightcone<
    L extends { aliases: readonly string[] },
    C extends { displayName: string; aliases: readonly string[]; rarity: number },
>(character: C, lightcones: readonly L[]): L | undefined {
    if (character.rarity < 5) return undefined;
    const names = new Set([norm(character.displayName), ...character.aliases.map(norm)]);
    names.delete('');
    return lightcones.find((l) => l.aliases.some((a) => names.has(norm(a))));
}
