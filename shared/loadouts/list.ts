import { copyName, loadoutName, loadoutNote } from './names';

// S14.3c: a saved loadout and the list operations of the team builder's Loadouts menu. Pure: no storage, no clock,
// no random value (ids come from the caller). One shape for both stores: in browser storage `key` is an id the page
// made; on the account it is the slot (0 to 9) as text.

export type Loadout = {
    key: string;
    /** Trimmed, 1 to 40 units (`loadoutName`). */
    name: string;
    /** 0 to 1,000 units (`loadoutNote`). */
    note: string;
    /** The packed team text of `shared/teambuilder` (team, modes, cost set, budgets, bids). */
    code: string;
};

export type ListResult =
    | { ok: true; list: Loadout[]; key: string }
    | { ok: false; reason: 'full' | 'missing' };

/** A loadout with its name and note brought to the rules. */
export function cleanLoadout(l: Loadout): Loadout {
    return { key: l.key, name: loadoutName(l.name), note: loadoutNote(l.note), code: l.code };
}

/** Appends a loadout; refused when the list already holds `limit`. */
export function addLoadout(list: readonly Loadout[], loadout: Loadout, limit: number): ListResult {
    if (list.length >= limit) return { ok: false, reason: 'full' };
    const added = cleanLoadout(loadout);
    return { ok: true, list: [...list, added], key: added.key };
}

/** Replaces the loadout with the same key (name, note, code); unknown keys leave the list as it is. */
export function updateLoadout(
    list: readonly Loadout[],
    key: string,
    change: Partial<Omit<Loadout, 'key'>>,
): Loadout[] {
    return list.map((l) => (l.key === key ? cleanLoadout({ ...l, ...change, key }) : l));
}

/**
 * A copy of `key` right after it (the mockup), named "<name> Copy" (then "Copy 2", ...); refused when the list is
 * full or the source is gone.
 */
export function duplicateLoadout(
    list: readonly Loadout[],
    key: string,
    newKey: string,
    limit: number,
): ListResult {
    const at = list.findIndex((l) => l.key === key);
    const source = list[at];
    if (!source) return { ok: false, reason: 'missing' };
    if (list.length >= limit) return { ok: false, reason: 'full' };
    const copy: Loadout = {
        key: newKey,
        name: copyName(
            source.name,
            list.map((l) => l.name),
        ),
        note: source.note,
        code: source.code,
    };
    const next = [...list];
    next.splice(at + 1, 0, copy);
    return { ok: true, list: next, key: newKey };
}

/**
 * Removes `key`. `next` is the loadout to show when the removed one was the active one: the one before it (the
 * mockup), else the new first one, else null (the list is empty).
 */
export function removeLoadout(
    list: readonly Loadout[],
    key: string,
): { list: Loadout[]; next: string | null } {
    const at = list.findIndex((l) => l.key === key);
    if (at < 0) return { list: [...list], next: list[0]?.key ?? null };
    const next = list.filter((l) => l.key !== key);
    return { list: next, next: next[Math.max(0, at - 1)]?.key ?? null };
}

/**
 * Account slots (S14.3s: the server keys a member's loadouts by slot 0 to 9). The list is shown in slot order; a
 * new loadout takes the lowest free slot, counting the slots of loadouts not saved yet. Null when all ten are used.
 */
export function freeSlot(used: Iterable<number>, limit: number): number | null {
    const taken = new Set(used);
    for (let s = 0; s < limit; s++) if (!taken.has(s)) return s;
    return null;
}

/** Account keys are the slot as text. */
export const slotKey = (slot: number) => String(slot);
export const keySlot = (key: string): number | null => {
    if (!/^[0-9]$/.test(key)) return null;
    return Number(key);
};

/** Same name, note and code. */
export function sameContent(a: Omit<Loadout, 'key'>, b: Omit<Loadout, 'key'>): boolean {
    return a.name === b.name && a.note === b.note && a.code === b.code;
}
