// S14.3s (A190 items 1, 3, 15): the rules and texts of the account loadouts (save_loadout, delete_loadout). The packed
// team text is checked with the same codec the page, the share link and browser storage use (`@shared/teambuilder`).
import { SenderError } from 'spacetimedb/server';
import { decodeTeam, encodeTeam, TEAM_CODE_MAX } from '@shared/teambuilder';

/** A190 item 3: 10 loadouts on the account, slots 0 to 9 (the page shows 1 to 10). */
export const LOADOUT_SLOTS = 10;
export const LOADOUT_NAME_MAX = 40;
/** A190 item 15. */
export const LOADOUT_NOTE_MAX = 1000;
export const LOADOUT_CODE_MAX = TEAM_CODE_MAX; // 400

export const LOADOUT_VERIFIED_TEXT =
    'Saving loadouts to your account needs a Discord-linked account. Your loadouts stay in this browser.';
export const LOADOUT_SLOT_TEXT = `Loadout slot must be between 1 and ${LOADOUT_SLOTS}.`;
export const LOADOUT_SLOT_TAKEN_TEXT = 'That loadout slot is already in use. Your list was refreshed; save again.';
export const LOADOUT_GONE_TEXT = 'That loadout no longer exists.';
export const LOADOUT_NAME_EMPTY_TEXT = 'Loadout name cannot be empty.';
export const LOADOUT_NAME_TEXT = `Loadout name cannot exceed ${LOADOUT_NAME_MAX} characters.`;
export const LOADOUT_NOTE_TEXT = `Loadout note cannot exceed ${LOADOUT_NOTE_MAX} characters.`;
export const LOADOUT_CODE_TEXT = 'This team could not be read. Reload the page and try again.';
export const LOADOUT_DUPLICATE_TEXT = 'A team cannot hold the same character twice.';
export const unknownCharacterText = (name: string) => `Unknown character "${name}".`;
export const unknownLightconeText = (name: string) => `Unknown light cone "${name}".`;

export function ensureLoadoutSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= LOADOUT_SLOTS) throw new SenderError(LOADOUT_SLOT_TEXT);
}

/** The trimmed name; refused when empty or longer than 40 (JavaScript string length, as the page counts). */
export function loadoutName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new SenderError(LOADOUT_NAME_EMPTY_TEXT);
    if (trimmed.length > LOADOUT_NAME_MAX) throw new SenderError(LOADOUT_NAME_TEXT);
    return trimmed;
}

export function ensureLoadoutNote(note: string): void {
    if (note.length > LOADOUT_NOTE_MAX) throw new SenderError(LOADOUT_NOTE_TEXT);
}

/**
 * The packed team text must decode (version 1 grammar: levels in range, no character twice, valid settings), be at
 * most 400 characters, be canonical (encoding the decoded team gives the same text, so one team has one stored text),
 * and name only characters and light cones of the reference tables (primary-key reads). The cost set id in the
 * settings is not looked up: the page falls back to Default when a set is gone (design § 2.1).
 */
export function ensureLoadoutCode(ctx: any, code: string): void {
    if (code.length > LOADOUT_CODE_MAX) throw new SenderError(LOADOUT_CODE_TEXT);
    const decoded = decodeTeam(code, {
        characters: { has: (n: string) => !!ctx.db.HsrCharacter.name.find(n) },
        lightcones: { has: (n: string) => !!ctx.db.HsrLightcone.name.find(n) },
    });
    if (!decoded.ok) {
        throw new SenderError(decoded.error === 'duplicate' ? LOADOUT_DUPLICATE_TEXT : LOADOUT_CODE_TEXT);
    }
    const encoded = encodeTeam(decoded.team);
    if (!encoded.ok || encoded.code !== code) throw new SenderError(LOADOUT_CODE_TEXT);
    const first = decoded.unavailable[0];
    if (first) {
        throw new SenderError(first.kind === 'character' ? unknownCharacterText(first.name) : unknownLightconeText(first.name));
    }
}

/** The caller's row in `slot`, or undefined (the by_user_and_slot index; the reducer keeps the pair unique). */
export function loadoutAt(ctx: any, userId: number, slot: number): any | undefined {
    return [...ctx.db.UserLoadout.by_user_and_slot.filter([userId, slot])][0];
}
