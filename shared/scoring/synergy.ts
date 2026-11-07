// A21 synergies are unordered pairs (backlog #3). Every pair whose two characters sit in the same group
// adds its costModifier once. The Herta + Argenti + Tribbie in one group with Herta–Argenti +4 and
// Herta–Tribbie +4 is +8; Argenti–Tribbie is not a pair.

export interface SynergyPair {
    characterA: string;
    characterB: string;
    /** Hundredths. */
    costModifier: number;
}

/** Canonical (alphabetical) order of a pair, as stored in HsrSynergyCost. */
export function canonicalPair(x: string, y: string): [string, string] {
    return x <= y ? [x, y] : [y, x];
}

/** Sum of the costModifier of every pair placed inside one group (hundredths). A pair listed twice counts once. */
export function synergySurcharge(groups: string[][], pairs: SynergyPair[]): number {
    const seen = new Set<string>();
    let total = 0;
    for (const pair of pairs) {
        const [a, b] = canonicalPair(pair.characterA, pair.characterB);
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (groups.some((g) => g.includes(a) && g.includes(b))) total += pair.costModifier;
    }
    return total;
}
