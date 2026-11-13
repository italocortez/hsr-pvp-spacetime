// A21 lineup format: 8 characters in halves (2 groups of 4) or 12 in thirds (3 groups of 4). No other
// split, no bench: the character count *is* the format (todo 2026-11-06).

export type LineupFormatTag = 'Halves' | 'Thirds';

export const GROUP_SIZE = 4;

export function groupCount(format: LineupFormatTag): number {
    return format === 'Thirds' ? 3 : 2;
}

/** Characters drafted per team: 8 for Halves, 12 for Thirds. */
export function charactersPerTeam(format: LineupFormatTag): number {
    return groupCount(format) * GROUP_SIZE;
}

/**
 * Checks a lineup: groupCount(format) groups of GROUP_SIZE names, every drafted character placed exactly
 * once and nothing else. Returns the first problem as a message, or null when the lineup is valid.
 * Compares counts, not sets, because the EMPTY placeholder (timer auto-pick) can appear more than once.
 */
export function lineupError(
    groups: string[][],
    drafted: string[],
    format: LineupFormatTag,
): string | null {
    const expected = groupCount(format);
    if (groups.length !== expected) return `A ${format} lineup has ${expected} groups.`;
    if (groups.some((g) => g.length !== GROUP_SIZE))
        return `Every group has ${GROUP_SIZE} characters.`;
    const remaining = new Map<string, number>();
    for (const name of drafted) remaining.set(name, (remaining.get(name) ?? 0) + 1);
    for (const name of groups.flat()) {
        const left = remaining.get(name) ?? 0;
        if (left === 0)
            return `${name} is not a drafted character of this team, or is placed twice.`;
        remaining.set(name, left - 1);
    }
    if ([...remaining.values()].some((n) => n > 0))
        return 'Every drafted character must be placed once.';
    return null;
}
