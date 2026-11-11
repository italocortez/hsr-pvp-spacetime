// ─── Calendar Availability Reducers ───────────────────────────────────────────
// Manages dated availability slots: each slot is one interval, Available or Blocked (S10ac, A157(1), A157(3):
// recurrence removed).
//
// Permission model:
//   - create/update_availability_slot: non-guest users only
//   - delete_availability_slot: owner OR Admin (D-14)
//
// Rules (S10ac, A157): times through parseInterval (digits only, 2020..2100, A157(11)); a slot lasts at most 24 h;
// a start in the past is refused on create and on an update that moves the start (A157(9)); the start lies at most
// 6 months ahead (D-28); at most 10 slots per UTC week (Monday 00:00 UTC) counted by start, ended slots not counted
// (A157(2)), the slot under update not counted.
// Lazy cleanup (D-27, D-07): S10s (A122(22), L86): every calendar reducer first deletes the caller's slots ended more
// than a week ago and events ended more than 90 days ago (runCalendarCleanup). S10s (A122(4), L93): each counts on the
// per-user membership allowance (consumeMembershipAllowance). Fix pass (F2, F11): order = authenticate, allowance,
// clean-up sparing the call's own slot, main operation.

import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import { getAuthenticatedUser, isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { runCalendarCleanup } from '@module/helpers/calendar/calendarCleanup';
import { consumeMembershipAllowance, MEMBERSHIP_ACTION_TEXT } from '@module/helpers/lobby/abuseControls';
import {
    MAX_SLOT_LENGTH_MICROS,
    MICROS_PER_DAY,
    ensureStartNotPast,
    parseInterval,
    utcWeekStart,
} from '@module/helpers/calendar/calendarTime';

const SIX_MONTHS_MICROS = 180n * MICROS_PER_DAY;
export const MAX_SLOTS_PER_WEEK = 10;
const SLOT_KINDS = ['Available', 'Blocked'];

/** A157(1): the slot kind argument, 'Available' or 'Blocked'. */
function parseSlotKind(kind: string): any {
    if (!SLOT_KINDS.includes(kind)) throw new SenderError('Invalid slot kind. Must be Available or Blocked.');
    return { tag: kind, value: {} };
}

/**
 * The checks shared by create and update after the times are parsed: length (24 h), past start (create: always;
 * update: only when the start moves), the 6-month window, then the weekly cap on the week of the (new) start:
 * the user's slots starting in that UTC week that have not ended (endAt > now), the slot under update excluded.
 */
function checkSlotTimes(ctx: any, userId: number, start: bigint, end: bigint, now: bigint, current?: any): void {
    if (end - start > MAX_SLOT_LENGTH_MICROS) {
        throw new SenderError('An availability slot can last at most 24 hours.');
    }
    ensureStartNotPast(start, now, current?.startAt.microsSinceUnixEpoch);
    if (start > now + SIX_MONTHS_MICROS) {
        throw new SenderError('Availability slots cannot be scheduled more than 6 months in advance.');
    }
    const week = utcWeekStart(start);
    let inWeek = 0;
    for (const slot of ctx.db.AvailabilitySlot.user_id.filter(userId)) {
        if (current && slot.id === current.id) continue;
        if (slot.endAt.microsSinceUnixEpoch <= now) continue; // ended slots do not count
        if (utcWeekStart(slot.startAt.microsSinceUnixEpoch) === week) inWeek++;
    }
    if (inWeek >= MAX_SLOTS_PER_WEEK) {
        throw new SenderError(`You can set at most ${MAX_SLOTS_PER_WEEK} availability slots per week.`);
    }
}

// ─── create_availability_slot ────────────────────────────────────────────────

export const create_availability_slot = spacetimedb.reducer(
    {
        startAt: t.string(), // BigInt micros as string
        endAt: t.string(),   // BigInt micros as string
        kind: t.string(),    // 'Available' | 'Blocked' (A157(1))
    },
    (ctx, { startAt, endAt, kind }: { startAt: string; endAt: string; kind: string }) => {
        const user = getAuthenticatedUser(ctx);
        if (user.isGuest) throw new SenderError('Guests cannot manage availability slots.');
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id); // S10s (A122(22), L86): clean-up before the main operation

        const slotKind = parseSlotKind(kind);
        const { start, end } = parseInterval(startAt, endAt);
        checkSlotTimes(ctx, user.id, start, end, ctx.timestamp.microsSinceUnixEpoch);

        ctx.db.AvailabilitySlot.insert(insertWithAudit(ctx, {
            id: 0,
            userId: user.id,
            startAt: new Timestamp(start),
            endAt: new Timestamp(end),
            kind: slotKind,
        }, user.id));
    }
);

// ─── update_availability_slot ────────────────────────────────────────────────
// Updates an existing availability slot owned by the authenticated user (all fields; the id stays).

export const update_availability_slot = spacetimedb.reducer(
    {
        slotId: t.u32(),
        startAt: t.string(),
        endAt: t.string(),
        kind: t.string(),
    },
    (ctx, { slotId, startAt, endAt, kind }: { slotId: number; startAt: string; endAt: string; kind: string }) => {
        const user = getAuthenticatedUser(ctx);
        if (user.isGuest) throw new SenderError('Guests cannot manage availability slots.');
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id, { slotId }); // S10s (A122(22), L86; fix pass F2): clean-up, sparing this call's target

        const slot = ctx.db.AvailabilitySlot.id.find(slotId);
        if (!slot) throw new SenderError('Availability slot not found.');
        if (slot.userId !== user.id) throw new SenderError('Not your availability slot.');

        const slotKind = parseSlotKind(kind);
        const { start, end } = parseInterval(startAt, endAt);
        checkSlotTimes(ctx, user.id, start, end, ctx.timestamp.microsSinceUnixEpoch, slot);

        ctx.db.AvailabilitySlot.id.update(updateWithAudit(ctx, slot, {
            startAt: new Timestamp(start),
            endAt: new Timestamp(end),
            kind: slotKind,
        }, user.id));
    }
);

// ─── delete_availability_slot ────────────────────────────────────────────────
// Deletes an availability slot. Owner or Admin.

export const delete_availability_slot = spacetimedb.reducer(
    { slotId: t.u32() },
    (ctx, { slotId }: { slotId: number }) => {
        const user = getAuthenticatedUser(ctx);
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id, { slotId }); // S10s (A122(22), L86; fix pass F2): clean-up, sparing this call's target

        const slot = ctx.db.AvailabilitySlot.id.find(slotId);
        if (!slot) throw new SenderError('Availability slot not found.');
        if (slot.userId !== user.id && !isRoleAtLeast(user.role, 'Admin')) {
            throw new SenderError('Forbidden: You can only delete your own availability slots.');
        }

        ctx.db.AvailabilitySlot.id.delete(slotId);
    }
);
