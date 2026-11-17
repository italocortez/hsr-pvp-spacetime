// S14.3a: the team builder's team, pure TypeScript shared by the page, browser storage and (later, S14.3s) the
// module's loadout validation and the share link. No `spacetimedb` or `react` import.
//
// A team is four slots, each empty or a character (by its key name, `hsr_character.name`, for example `firefly`)
// with an eidolon (0 to 6) and an optional light cone (by `hsr_lightcone.name`) with a superimposition (1 to 5);
// plus the draft mode, the game mode, the cost set id (0 = the Default set, A185 item 1) and the two Auction budgets.
// Characters and light cones are always referenced by key name, never by a numeric id: names are the primary keys
// of the reference tables, survive a reseed and mean the same on test1 and prod.

export const TEAM_SIZE = 4;

export const GAME_MODES = ['as', 'moc', 'aa'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export const DRAFT_MODES = ['classic', 'auction'] as const;
export type DraftMode = (typeof DRAFT_MODES)[number];

export type Eidolon = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type Superimposition = 1 | 2 | 3 | 4 | 5;

export const EIDOLON_MAX = 6;
export const SUPERIMPOSITION_MAX = 5;

/** A filled slot. `lightcone` null: no light cone equipped (its superimposition is then 1 and unused). */
export type TeamSlot = {
    character: string;
    eidolon: Eidolon;
    lightcone: string | null;
    superimposition: Superimposition;
    /**
     * Auction only: the extra bid on top of the base, integer hundredths 0 to 9999 (`BID_MAX`); absent means 0. The
     * input that sets it is S14.3b; the packed text carries it from version 1 on.
     */
    bid?: number;
};

export type Slot = TeamSlot | null;
export type Slots = readonly [Slot, Slot, Slot, Slot];

/** Auction budgets in integer hundredths (30 = 3000), A190 item 5. */
export type Budgets = { character: number; lightcone: number };

export type Team = {
    slots: Slots;
    draftMode: DraftMode;
    gameMode: GameMode;
    /** 0 = the Default set; otherwise a published cost set id (u32). */
    costSetId: number;
    budgets: Budgets;
};

/** A190 item 5: the Auction simulator's starting budgets, 30 and 15. */
export const DEFAULT_BUDGETS: Budgets = { character: 3000, lightcone: 1500 };

export const EMPTY_SLOTS: Slots = [null, null, null, null];

export function emptyTeam(): Team {
    return {
        slots: EMPTY_SLOTS,
        draftMode: 'classic',
        gameMode: 'as',
        costSetId: 0,
        budgets: { ...DEFAULT_BUDGETS },
    };
}

export function isEidolon(value: number): value is Eidolon {
    return Number.isInteger(value) && value >= 0 && value <= EIDOLON_MAX;
}

export function isSuperimposition(value: number): value is Superimposition {
    return Number.isInteger(value) && value >= 1 && value <= SUPERIMPOSITION_MAX;
}

/** The index of the first empty slot, or -1 when the team is full. */
export function firstEmptySlot(slots: Slots): number {
    return slots.indexOf(null);
}

/** The slot index holding `character`, or -1. */
export function slotOf(slots: Slots, character: string): number {
    return slots.findIndex((s) => s?.character === character);
}

/** A copy of `slots` with slot `index` replaced. */
export function withSlot(slots: Slots, index: number, slot: Slot): Slots {
    const next = [...slots] as [Slot, Slot, Slot, Slot];
    next[index] = slot;
    return next;
}

/** A copy of `slots` with slots `a` and `b` exchanged (a no-op for a == b or an index out of range). */
export function swapSlots(slots: Slots, a: number, b: number): Slots {
    if (a === b || a < 0 || b < 0 || a >= TEAM_SIZE || b >= TEAM_SIZE) return slots;
    const next = [...slots] as [Slot, Slot, Slot, Slot];
    const held = next[a] as Slot;
    next[a] = next[b] as Slot;
    next[b] = held;
    return next;
}

/** The character names on the team, in slot order. */
export function teamCharacters(slots: Slots): string[] {
    return slots.flatMap((s) => (s ? [s.character] : []));
}
