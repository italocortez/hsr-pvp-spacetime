// ─── Calendar Availability Reducers ───────────────────────────────────────────
// Manages recurring and one-time availability slots for players.
//
// Permission model:
//   - create/update_availability_slot: non-guest users only
//   - delete_availability_slot: owner OR Admin (D-14)
//
// Caps (per D-10): max 10 slots per user; 6-month window (D-12)
// Lazy cleanup (D-27): expired slots older than 1 week are deleted on every call

import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { cleanupExpiredSlots } from '../helpers/calendarCleanup';

const SIX_MONTHS_MICROS = BigInt(180 * 24 * 60 * 60) * BigInt(1_000_000);
const MAX_AVAILABILITY_SLOTS = 10;

// ─── create_availability_slot ────────────────────────────────────────────────
// Creates an availability slot for the authenticated user.
// isRecurring=true requires recurrenceType. expiresAt defaults to 6 months from now
// for recurring slots (or provided endDate), and equals endAt for one-time slots.

export const create_availability_slot = spacetimedb.reducer(
    {
        startAt: t.string(),         // BigInt micros as string
        endAt: t.string(),           // BigInt micros as string
        isRecurring: t.bool(),
        recurrenceType: t.string(),  // Daily/Weekly/Monthly or empty for non-recurring
        interval: t.u8(),            // Recurrence interval (1 = every day/week/month)
        dayOfWeek: t.u8(),           // 0-6 for weekly, 255 = not set
        dayOfMonth: t.u8(),          // 1-31 for monthly, 0 = not set
        endDate: t.string(),         // BigInt micros for recurrence end, empty = default 6 months
    },
    (ctx, { startAt, endAt, isRecurring, recurrenceType, interval, dayOfWeek, dayOfMonth, endDate }: {
        startAt: string;
        endAt: string;
        isRecurring: boolean;
        recurrenceType: string;
        interval: number;
        dayOfWeek: number;
        dayOfMonth: number;
        endDate: string;
    }) => {
        const user = getAuthenticatedUser(ctx);
        if (user.isGuest) throw new SenderError('Guests cannot manage availability slots.');

        const startMicros = BigInt(startAt);
        const endMicros = BigInt(endAt);
        if (startMicros >= endMicros) throw new SenderError('Start time must be before end time.');

        const now = ctx.timestamp.microsSinceUnixEpoch;
        if (startMicros > now + SIX_MONTHS_MICROS) {
            throw new SenderError('Availability slots cannot be scheduled more than 6 months in advance.');
        }

        // Lazy cleanup of expired slots
        cleanupExpiredSlots(ctx, user.id);

        // Cap check
        const existing = [...ctx.db.AvailabilitySlot.user_id.filter(user.id)];
        if (existing.length >= MAX_AVAILABILITY_SLOTS) {
            throw new SenderError(`Maximum ${MAX_AVAILABILITY_SLOTS} availability slots per user.`);
        }

        if (isRecurring && !recurrenceType) {
            throw new SenderError('Recurring slots require a recurrence type (Daily, Weekly, or Monthly).');
        }

        // Calculate expiresAt
        let expiresAtMicros: bigint;
        if (isRecurring) {
            if (endDate && endDate !== '') {
                expiresAtMicros = BigInt(endDate);
            } else {
                expiresAtMicros = now + SIX_MONTHS_MICROS;
            }
        } else {
            expiresAtMicros = endMicros;
        }

        // Build recurrenceRule — always pass values for optional fields
        // SpacetimeDB SDK can't serialize null/undefined/omitted for optional struct fields (BigInt conversion TypeError)
        // Use sentinel values: dayOfWeek=255 (not weekly), dayOfMonth=0 (not monthly), endDate epoch 0 (not set)
        let recurrenceRule: any;
        if (isRecurring) {
            recurrenceRule = {
                recurrenceType: { tag: recurrenceType, value: {} } as any,
                interval: interval || 1,
                dayOfWeek,
                dayOfMonth,
                endDate: endDate && endDate !== '' && endDate !== '0'
                    ? new Timestamp(BigInt(endDate))
                    : new Timestamp(0n),
            };
        } else {
            // Zero-value RecurrenceRule for non-recurring slots
            recurrenceRule = {
                recurrenceType: { tag: 'Daily', value: {} } as any,
                interval: 0,
                dayOfWeek: 255,
                dayOfMonth: 0,
                endDate: new Timestamp(0n),
            };
        }

        ctx.db.AvailabilitySlot.insert(insertWithAudit(ctx, {
            id: 0,
            userId: user.id,
            startAt: new Timestamp(startMicros),
            endAt: new Timestamp(endMicros),
            isRecurring,
            recurrenceRule,
            expiresAt: new Timestamp(expiresAtMicros),
        }, user.id));
    }
);

// ─── update_availability_slot ────────────────────────────────────────────────
// Updates an existing availability slot owned by the authenticated user.

export const update_availability_slot = spacetimedb.reducer(
    {
        slotId: t.u32(),
        startAt: t.string(),
        endAt: t.string(),
        isRecurring: t.bool(),
        recurrenceType: t.string(),
        interval: t.u8(),
        dayOfWeek: t.u8(),
        dayOfMonth: t.u8(),
        endDate: t.string(),
    },
    (ctx, { slotId, startAt, endAt, isRecurring, recurrenceType, interval, dayOfWeek, dayOfMonth, endDate }: {
        slotId: number;
        startAt: string;
        endAt: string;
        isRecurring: boolean;
        recurrenceType: string;
        interval: number;
        dayOfWeek: number;
        dayOfMonth: number;
        endDate: string;
    }) => {
        const user = getAuthenticatedUser(ctx);
        if (user.isGuest) throw new SenderError('Guests cannot manage availability slots.');

        const slot = ctx.db.AvailabilitySlot.id.find(slotId);
        if (!slot) throw new SenderError('Availability slot not found.');
        if (slot.userId !== user.id) throw new SenderError('Not your availability slot.');

        const startMicros = BigInt(startAt);
        const endMicros = BigInt(endAt);
        if (startMicros >= endMicros) throw new SenderError('Start time must be before end time.');

        const now = ctx.timestamp.microsSinceUnixEpoch;
        if (startMicros > now + SIX_MONTHS_MICROS) {
            throw new SenderError('Availability slots cannot be scheduled more than 6 months in advance.');
        }

        if (isRecurring && !recurrenceType) {
            throw new SenderError('Recurring slots require a recurrence type (Daily, Weekly, or Monthly).');
        }

        // Calculate expiresAt
        let expiresAtMicros: bigint;
        if (isRecurring) {
            if (endDate && endDate !== '') {
                expiresAtMicros = BigInt(endDate);
            } else {
                expiresAtMicros = now + SIX_MONTHS_MICROS;
            }
        } else {
            expiresAtMicros = endMicros;
        }

        // Build recurrenceRule — always pass values for optional fields (same sentinel pattern as create)
        let recurrenceRule: any;
        if (isRecurring) {
            recurrenceRule = {
                recurrenceType: { tag: recurrenceType, value: {} } as any,
                interval: interval || 1,
                dayOfWeek,
                dayOfMonth,
                endDate: endDate && endDate !== '' && endDate !== '0'
                    ? new Timestamp(BigInt(endDate))
                    : new Timestamp(0n),
            };
        } else {
            recurrenceRule = {
                recurrenceType: { tag: 'Daily', value: {} } as any,
                interval: 0,
                dayOfWeek: 255,
                dayOfMonth: 0,
                endDate: new Timestamp(0n),
            };
        }

        ctx.db.AvailabilitySlot.id.update(updateWithAudit(ctx, slot, {
            startAt: new Timestamp(startMicros),
            endAt: new Timestamp(endMicros),
            isRecurring,
            recurrenceRule,
            expiresAt: new Timestamp(expiresAtMicros),
        }, user.id));
    }
);

// ─── delete_availability_slot ────────────────────────────────────────────────
// Deletes an availability slot. Owner or Admin.

export const delete_availability_slot = spacetimedb.reducer(
    { slotId: t.u32() },
    (ctx, { slotId }: { slotId: number }) => {
        const user = getAuthenticatedUser(ctx);

        const slot = ctx.db.AvailabilitySlot.id.find(slotId);
        if (!slot) throw new SenderError('Availability slot not found.');
        if (slot.userId !== user.id && !isRoleAtLeast(user.role, 'Admin')) {
            throw new SenderError('Forbidden: You can only delete your own availability slots.');
        }

        ctx.db.AvailabilitySlot.id.delete(slotId);
    }
);
