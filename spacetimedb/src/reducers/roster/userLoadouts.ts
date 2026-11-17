// ─── Team builder loadouts (S14.3s; A190 items 1, 3, 15) ─────────────────────
// A verified member keeps up to 10 loadouts on the account (slots 0 to 9). Guests and visitors keep theirs in browser
// storage (no backend). Reads go through view_my_loadouts. The caller is always ctx.sender; no identity argument.
// Every write counts on the per-user membership allowance the roster writes use (20 calls per 10 s, A122(4)).
// Contract: docs/loadout/contract.md.

import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureVerifiedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { consumeMembershipAllowance, MEMBERSHIP_ACTION_TEXT } from '@module/helpers/lobby/abuseControls';
import {
    ensureLoadoutCode,
    ensureLoadoutNote,
    ensureLoadoutSlot,
    loadoutAt,
    loadoutName,
    LOADOUT_GONE_TEXT,
    LOADOUT_SLOT_TAKEN_TEXT,
    LOADOUT_VERIFIED_TEXT,
} from '@module/helpers/roster/loadoutRules';

// ─── save_loadout ────────────────────────────────────────────────────────────
// Upsert on (caller, slot). `isNew` true: the slot must be free (two devices creating in one slot at once: the second
// is refused and the page picks another). `isNew` false: the slot must hold a loadout (deleted elsewhere: refused).
// Every check runs before the one write, so a refused call writes nothing.

export const save_loadout = spacetimedb.reducer(
    { slot: t.u8(), isNew: t.bool(), name: t.string(), note: t.string(), code: t.string() },
    (ctx, { slot, isNew, name, note, code }) => {
        const user = ensureVerifiedUser(ctx, LOADOUT_VERIFIED_TEXT);
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT);

        ensureLoadoutSlot(slot);
        const trimmed = loadoutName(name);
        ensureLoadoutNote(note);
        ensureLoadoutCode(ctx, code);

        const existing = loadoutAt(ctx, user.id, slot);
        if (isNew && existing) throw new SenderError(LOADOUT_SLOT_TAKEN_TEXT);
        if (!isNew && !existing) throw new SenderError(LOADOUT_GONE_TEXT);

        if (existing) {
            ctx.db.UserLoadout.id.update(updateWithAudit(ctx, existing, { name: trimmed, note, code }, user.id));
        } else {
            ctx.db.UserLoadout.insert(insertWithAudit(ctx, {
                id: 0, // autoInc
                userId: user.id,
                slot,
                name: trimmed,
                note,
                code,
            }, user.id));
        }
    }
);

// ─── delete_loadout ──────────────────────────────────────────────────────────
// Removes the caller's loadout in `slot`. An empty slot is a silent no-op (a second delete from another tab).

export const delete_loadout = spacetimedb.reducer(
    { slot: t.u8() },
    (ctx, { slot }) => {
        const user = ensureVerifiedUser(ctx, LOADOUT_VERIFIED_TEXT);
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT);

        ensureLoadoutSlot(slot);
        const existing = loadoutAt(ctx, user.id, slot);
        if (existing) ctx.db.UserLoadout.id.delete(existing.id);
    }
);
