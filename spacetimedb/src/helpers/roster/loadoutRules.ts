// S14.3s (A190 items 1, 3, 15): the rules and texts of the account loadouts (save_loadout, delete_loadout). The packed
// team text is checked with the same codec the page, the share link and browser storage use (`@shared/teambuilder`).
import { SenderError } from 'spacetimedb/server';
import { decodeTeam, encodeTeam, TEAM_CODE_MAX } from '@shared/teambuilder';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';

/** A190 item 3: 10 loadouts on the account, slots 0 to 9 (the page shows 1 to 10). */
export const LOADOUT_SLOTS = 10;
export const LOADOUT_NAME_MAX = 40;
/** A190 item 15. */
export const LOADOUT_NOTE_MAX = 1000;
export const LOADOUT_CODE_MAX = TEAM_CODE_MAX; // 400

export const LOADOUT_VERIFIED_TEXT =
    'Saving loadouts to your account needs a Discord-linked account. Your loadouts stay in this browser.';
export const LOADOUT_SLOT_TEXT = `Loadout slot must be between 1 and ${LOADOUT_SLOTS}.`;
// S14.3c-rev (A198): the version refusals. The client tells them apart by the exact sentence (one per case, listed in
// docs/loadout/architecture.md, which is the contract: the page cannot import this file), as it already does for the
// slot-taken and too-fast texts.
/** save_loadout with base version 0 (create) on a slot that holds a loadout. */
export const LOADOUT_SLOT_TAKEN_TEXT = 'That loadout slot is already in use. Your list was refreshed; save again.';
/** save_loadout with a base version above 0 when the loadout it was based on is gone (slot empty, or holding a newer loadout). */
export const LOADOUT_GONE_TEXT = 'That loadout was deleted on another device.';
/** save_loadout or delete_loadout based on a version of the loadout that is no longer the current one. */
export const LOADOUT_CONFLICT_TEXT = 'That loadout was changed on another device.';
/** The version cannot rise any more (u32 top; over 1,300 years of saves at the limit). */
export const LOADOUT_REV_MAX_TEXT = 'This loadout cannot be saved again. Save it as a new loadout.';
export const LOADOUT_REV_MAX = 0xffff_ffff;
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

/**
 * S14.3c-rev (A198): is `baseRev` a version of the loadout `row` (the slot's current one)? Every version the account was
 * given before `row` was created is below `row.firstRev`, so a lower base (0 included) is a loadout that is gone.
 */
export function isBaseOfLoadout(row: { firstRev: number }, baseRev: number): boolean {
    return baseRev >= row.firstRev;
}

/**
 * S14.3c-rev (A198): the version check of save_loadout. Base 0 creates: the slot must be empty. A base above 0 updates:
 * the slot must hold the loadout that base belongs to (else it was deleted) at exactly that version (else it changed).
 */
export function ensureLoadoutBase(existing: any | undefined, baseRev: number): void {
    if (baseRev === 0) {
        if (existing) throw new SenderError(LOADOUT_SLOT_TAKEN_TEXT);
        return;
    }
    if (!existing || !isBaseOfLoadout(existing, baseRev)) throw new SenderError(LOADOUT_GONE_TEXT);
    if (existing.rev !== baseRev) throw new SenderError(LOADOUT_CONFLICT_TEXT);
}

/**
 * S14.3c-rev (A198): the version a save writes. An update raises the row's version by 1; a new loadout starts one above
 * the highest version the account was ever given (UserLoadoutRate.revFloor; no row yet: 0, so the first loadout is 1).
 * Refused at the u32 top instead of wrapping.
 */
export function nextLoadoutRev(ctx: any, userId: number, existing: any | undefined): number {
    const base: number = existing ? existing.rev : (ctx.db.UserLoadoutRate.userId.find(userId)?.revFloor ?? 0);
    if (base >= LOADOUT_REV_MAX) throw new SenderError(LOADOUT_REV_MAX_TEXT);
    return base + 1;
}

/**
 * S14.3s-limit (A194 item 6, user ruling 2026-11-17: "6 saves per minute per account"): accepted save_loadout calls per
 * account per fixed window, counted in UserLoadoutRate and on nothing else (not the membership allowance of the lobby,
 * roster and calendar writes). Constants, not AbuseConfig columns: an admin-editable value would change AbuseConfig's
 * shape on a live database. A fixed window like the UserRateState neighbours: one row read and one write per save. Its
 * worst burst is 12 saves within a few seconds across a window edge; the monthly bound stays 6 per minute on average.
 */
export const LOADOUT_SAVES_PER_WINDOW = 6;
export const LOADOUT_SAVE_WINDOW_MS = 60_000;
export const LOADOUT_TOO_FAST_TEXT =
    'Your loadout was not saved yet: too many saves in a short time. It will be saved in a moment.';

/**
 * Counts one accepted save of the user, refusing it once the current window holds LOADOUT_SAVES_PER_WINDOW saves.
 * save_loadout calls it after every other check, right before the write, so the refusal only ever reaches a save that
 * would otherwise succeed (the page retries it from its draft). A refused call rolls back and writes nothing.
 * S14.3c-rev (A198): the same write raises `revFloor` to `newRev` (the version the save writes) when it is higher.
 */
export function consumeLoadoutSaveAllowance(ctx: any, userId: number, newRev: number): void {
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const state = ctx.db.UserLoadoutRate.userId.find(userId);
    if (!state) {
        ctx.db.UserLoadoutRate.insert(insertWithAudit(ctx, { userId, windowStart: ctx.timestamp, saveCount: 1, revFloor: newRev }, userId));
        return;
    }
    const revFloor = Math.max(state.revFloor, newRev);
    const windowOpen = now - state.windowStart.microsSinceUnixEpoch < BigInt(LOADOUT_SAVE_WINDOW_MS) * 1000n;
    if (!windowOpen) {
        ctx.db.UserLoadoutRate.userId.update(updateWithAudit(ctx, state, { windowStart: ctx.timestamp, saveCount: 1, revFloor }, userId));
        return;
    }
    if (state.saveCount >= LOADOUT_SAVES_PER_WINDOW) throw new SenderError(LOADOUT_TOO_FAST_TEXT);
    ctx.db.UserLoadoutRate.userId.update(updateWithAudit(ctx, state, { saveCount: state.saveCount + 1, revFloor }, userId));
}
