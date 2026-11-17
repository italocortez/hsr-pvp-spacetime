// ─── Team builder loadouts (S14.3s; A190 items 1, 3, 15) ─────────────────────
// A verified member keeps up to 10 loadouts on the account (slots 0 to 9). Guests and visitors keep theirs in browser
// storage (no backend). Reads go through view_my_loadouts. The caller is always ctx.sender; no identity argument.
// S14.3s-limit (A194 item 6): saves count on a limit of their own (6 per account per minute, UserLoadoutRate), not on
// the membership allowance of the lobby, roster and calendar writes. Deletes count on nothing: see delete_loadout.
// S14.3c-rev (A198): every loadout carries a version (`rev`); a save and a delete state the version they are based on,
// and the database refuses one based on an older copy instead of the page guessing from contents.
// Contract: docs/loadout/contract.md.

import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureVerifiedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import {
    consumeLoadoutSaveAllowance,
    ensureLoadoutBase,
    ensureLoadoutCode,
    ensureLoadoutNote,
    ensureLoadoutSlot,
    isBaseOfLoadout,
    loadoutAt,
    loadoutName,
    nextLoadoutRev,
    LOADOUT_CONFLICT_TEXT,
    LOADOUT_VERIFIED_TEXT,
} from '@module/helpers/roster/loadoutRules';

// ─── save_loadout ────────────────────────────────────────────────────────────
// Upsert on (caller, slot), based on version `baseRev` of the caller's copy (A198). `baseRev` 0 creates: the slot must
// be free (two devices creating in one slot at once: the second is refused and the page picks another). `baseRev` above
// 0 updates: the slot must still hold that loadout (else "deleted on another device") at exactly that version (else
// "changed on another device"). A write sets `rev` to `baseRev + 1` (an update) or one above the account's highest
// version so far (a new loadout).
// Order: caller, slot, version, content, unchanged, version top, save limit, write. The version check comes before the
// content checks so the person is first told which copy is current; a payload that is also invalid is then refused with
// its content text on the resend, which carries the current version, so no conflict can repeat for ever. A save equal to
// the stored row (same name after trimming, note and code) at the current version writes nothing, keeps the version and
// does not count on the limit. The save limit is the last check, so its refusal only reaches a save that would otherwise
// write (the page keeps a draft and retries it). Every check runs before the one write: a refused call writes nothing.

export const save_loadout = spacetimedb.reducer(
    { slot: t.u8(), baseRev: t.u32(), name: t.string(), note: t.string(), code: t.string() },
    (ctx, { slot, baseRev, name, note, code }) => {
        const user = ensureVerifiedUser(ctx, LOADOUT_VERIFIED_TEXT);

        ensureLoadoutSlot(slot);
        const existing = loadoutAt(ctx, user.id, slot);
        ensureLoadoutBase(existing, baseRev);

        const trimmed = loadoutName(name);
        ensureLoadoutNote(note);
        ensureLoadoutCode(ctx, code);

        if (existing && existing.name === trimmed && existing.note === note && existing.code === code) return;

        const rev = nextLoadoutRev(ctx, user.id, existing);
        consumeLoadoutSaveAllowance(ctx, user.id, rev);

        if (existing) {
            ctx.db.UserLoadout.id.update(updateWithAudit(ctx, existing, { rev, name: trimmed, note, code }, user.id));
        } else {
            ctx.db.UserLoadout.insert(insertWithAudit(ctx, {
                id: 0, // autoInc
                userId: user.id,
                slot,
                rev,
                firstRev: rev,
                name: trimmed,
                note,
                code,
            }, user.id));
        }
    }
);

// ─── delete_loadout ──────────────────────────────────────────────────────────
// Removes the caller's loadout in `slot`, based on version `baseRev` of the caller's copy (A198), so a delete made from
// an old copy cannot remove another device's newer edits. The slot's loadout at exactly `baseRev`: deleted. At another
// version of the same loadout: refused "changed on another device" (the page shows the newer copy and asks again). An
// empty slot, or a slot that now holds a different loadout (base below its firstRev, 0 included): the loadout the page
// meant is already gone, a silent no-op that writes nothing (a second delete from another tab).
// S14.3s-limit: no rate limit beyond the slot range. A delete only removes a row a counted save created, so a save,
// delete, save loop is held by its saves (6 a minute); a delete of an empty slot writes nothing, and a refused call
// would cost the same single call as that no-op, so counting deletes would save no energy and would add a write.

export const delete_loadout = spacetimedb.reducer(
    { slot: t.u8(), baseRev: t.u32() },
    (ctx, { slot, baseRev }) => {
        const user = ensureVerifiedUser(ctx, LOADOUT_VERIFIED_TEXT);

        ensureLoadoutSlot(slot);
        const existing = loadoutAt(ctx, user.id, slot);
        if (!existing || !isBaseOfLoadout(existing, baseRev)) return;
        if (existing.rev !== baseRev) throw new SenderError(LOADOUT_CONFLICT_TEXT);
        ctx.db.UserLoadout.id.delete(existing.id);
    }
);
