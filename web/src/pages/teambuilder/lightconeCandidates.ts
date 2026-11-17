import { normName, signatureLightcone } from '@shared/teambuilder';

/*
 * The light cone picker's list (S14.3a; the mockup's `renderResults`). With an empty search: only the character's
 * signature cone (5-star characters, the mockup's alias rule), under the panel's "Start typing to search…" line, as
 * in the mockup. With a search: every cone whose name or alias contains it (spaces and case ignored), the
 * signature first, then the character's path (a cone's passive only works on its path), 5-star before 4-star
 * before 3-star, then by name. The equipped cone is left out. At most `LIMIT` entries: the list is text only (no
 * images), and a short list stays readable.
 */

export const LIMIT = 40;

type Cone = {
    name: string;
    displayName: string;
    rarity: number;
    aliases: readonly string[];
    path: { tag: string };
};
type Character = {
    displayName: string;
    aliases: readonly string[];
    rarity: number;
    path: { tag: string };
};

export type Candidate<L> = { cone: L; signature: boolean };

export function lightconeCandidates<L extends Cone>(
    query: string,
    character: Character | undefined,
    lightcones: readonly L[],
    exclude: string | null = null,
): Candidate<L>[] {
    const q = normName(query);
    const signature = character ? signatureLightcone(character, lightcones) : undefined;
    const path = character?.path.tag;
    const rank = (l: L) =>
        (l === signature ? 0 : 1) * 100 + (l.path.tag === path ? 0 : 10) + (5 - l.rarity);
    const pool = lightcones.filter((l) => {
        if (l.name === exclude) return false;
        if (q === '') return l === signature;
        return (
            normName(l.displayName).includes(q) || l.aliases.some((a) => normName(a).includes(q))
        );
    });
    return pool
        .map((cone, i) => ({ cone, i, r: rank(cone) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .slice(0, LIMIT)
        .map(({ cone }) => ({ cone, signature: cone === signature }));
}
