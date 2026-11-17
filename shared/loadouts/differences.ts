import { type DraftMode, decodeTeam, type GameMode, type Team } from '@shared/teambuilder';
import type { Content } from './sync';

// S14.3c-sync (second review N5): what differs between this browser's copy of a loadout and the account copy, for the
// conflict choice. Pure; the page puts it into words (with the characters' display names).

export type Modes = { gameMode: GameMode; draftMode: DraftMode; costSetId: number };

export type Difference =
    | { kind: 'name'; mine: string; theirs: string }
    | { kind: 'note' }
    /** Who is in the team (character key names, slot order; empty slots left out). */
    | { kind: 'members'; mine: string[]; theirs: string[] }
    /** The same members, but another light cone on at least one. */
    | { kind: 'lightcones' }
    /** The same members and cones, but another eidolon or superimposition. */
    | { kind: 'levels' }
    /** The same members, in another order. */
    | { kind: 'order' }
    | { kind: 'modes'; mine: Modes; theirs: Modes }
    /** Auction budgets or extra bids. */
    | { kind: 'auction' };

const members = (t: Team) => t.slots.flatMap((s) => (s ? [s.character] : []));
const modes = (t: Team): Modes => ({
    gameMode: t.gameMode,
    draftMode: t.draftMode,
    costSetId: t.costSetId,
});
const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** In a fixed order: name, note, members (or order, cones, levels), modes, Auction. Empty when equal. */
export function differences(mine: Content, theirs: Content): Difference[] {
    const out: Difference[] = [];
    if (mine.name !== theirs.name) out.push({ kind: 'name', mine: mine.name, theirs: theirs.name });
    if (mine.note !== theirs.note) out.push({ kind: 'note' });
    if (mine.code === theirs.code) return out;
    const a = decodeTeam(mine.code);
    const b = decodeTeam(theirs.code);
    if (!a.ok || !b.ok) {
        out.push({ kind: 'members', mine: [], theirs: [] });
        return out;
    }
    const ta = a.team;
    const tb = b.team;
    const ma = members(ta);
    const mb = members(tb);
    if (!sameSet(ma, mb)) out.push({ kind: 'members', mine: ma, theirs: mb });
    else {
        const byChar = (t: Team) => new Map(t.slots.flatMap((s) => (s ? [[s.character, s]] : [])));
        const sa = byChar(ta);
        const sb = byChar(tb);
        const pairs = ma.map((c) => [sa.get(c), sb.get(c)] as const);
        if (ma.join('\n') !== mb.join('\n')) out.push({ kind: 'order' });
        if (pairs.some(([x, y]) => x?.lightcone !== y?.lightcone)) out.push({ kind: 'lightcones' });
        if (
            pairs.some(
                ([x, y]) =>
                    x?.eidolon !== y?.eidolon ||
                    (x?.lightcone && x.superimposition !== y?.superimposition),
            )
        )
            out.push({ kind: 'levels' });
    }
    const ka = modes(ta);
    const kb = modes(tb);
    if (
        ka.gameMode !== kb.gameMode ||
        ka.draftMode !== kb.draftMode ||
        ka.costSetId !== kb.costSetId
    )
        out.push({ kind: 'modes', mine: ka, theirs: kb });
    const bids = (t: Team) =>
        t.slots
            .flatMap((s) => (s ? [`${s.character}:${s.bid ?? 0}`] : []))
            .sort()
            .join(',');
    if (
        ta.budgets.character !== tb.budgets.character ||
        ta.budgets.lightcone !== tb.budgets.lightcone ||
        (sameSet(ma, mb) && bids(ta) !== bids(tb))
    )
        out.push({ kind: 'auction' });
    return out;
}
