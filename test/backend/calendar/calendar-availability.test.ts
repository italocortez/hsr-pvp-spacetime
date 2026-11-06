/**
 * Integration tests for calendar availability slot reducers.
 *
 * Tests CRUD, 10-slot cap, ownership guards, guest rejection,
 * and lazy cleanup of expired slots against a live SpacetimeDB instance.
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/calendar/contract.md — Availability Slot scenarios
 * UAT: .planning/phases/08-calendar-and-scheduling/08-UAT.md — Tests 1-4, 14
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createTestHarness,
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate BigInt micros timestamp string offset from now */
function tsStr(offsetMs: number): string {
    return (BigInt(Date.now() + offsetMs) * 1000n).toString();
}

/** Default non-recurring slot args */
function slotArgs(overrides: Record<string, unknown> = {}) {
    return {
        startAt: tsStr(3600_000),      // +1 hour
        endAt: tsStr(7200_000),        // +2 hours
        isRecurring: false,
        recurrenceType: '',
        interval: 0,
        dayOfWeek: 255,
        dayOfMonth: 0,
        endDate: '',
        ...overrides,
    };
}

/** Get this user's availability slots from subscription cache */
function mySlots(h: TestHarness) {
    return [...h.conn.db.AvailabilitySlot.iter()].filter(s => s.userId === h.userId);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Calendar Availability Slots', () => {
    let userA: TestHarness;
    let userB: TestHarness;
    let guest: TestHarness;

    beforeAll(async () => {
        userA = await createVerifiedTestHarness();
        userB = await createVerifiedTestHarness();
        guest = await createTestHarness();
        await userA.sync();
        await userB.sync();
        await guest.sync();
    }, 30000);

    afterAll(async () => {
        await userA?.disconnect();
        await userB?.disconnect();
        await guest?.disconnect();
    });

    // ─── Create ─────────────────────────────────────────────────────────

    it('creates a recurring weekly slot with expiresAt ~6 months ahead', async () => {
        const now = Date.now();
        await userA.call.createAvailabilitySlot(slotArgs({
            isRecurring: true,
            recurrenceType: 'Weekly',
            interval: 1,
            dayOfWeek: 3,  // Wednesday
        }));
        await userA.sync();

        const slots = mySlots(userA);
        expect(slots.length).toBeGreaterThanOrEqual(1);

        const slot = slots[slots.length - 1];
        expect(slot.isRecurring).toBe(true);

        // expiresAt should be ~6 months from now (within 1 minute tolerance)
        const sixMonthsMicros = BigInt(180 * 24 * 60 * 60) * 1_000_000n;
        const nowMicros = BigInt(now) * 1000n;
        const expiresMicros = slot.expiresAt.microsSinceUnixEpoch;
        const diff = expiresMicros - nowMicros;
        // Should be within 6 months ± 1 minute
        expect(diff).toBeGreaterThan(sixMonthsMicros - 60_000_000n);
        expect(diff).toBeLessThan(sixMonthsMicros + 60_000_000n);
    });

    it('creates a non-recurring slot with expiresAt = endAt', async () => {
        const endAt = tsStr(7200_000);
        await userA.call.createAvailabilitySlot(slotArgs({ endAt }));
        await userA.sync();

        const slots = mySlots(userA);
        const slot = slots[slots.length - 1];
        expect(slot.isRecurring).toBe(false);
        expect(slot.expiresAt.microsSinceUnixEpoch.toString()).toBe(
            slot.endAt.microsSinceUnixEpoch.toString()
        );
    });

    // ─── Update ─────────────────────────────────────────────────────────

    it('updates own slot with new times', async () => {
        // Create a slot to update
        await userA.call.createAvailabilitySlot(slotArgs());
        await userA.sync();

        const slots = mySlots(userA);
        const target = slots[slots.length - 1];

        const newStart = tsStr(10800_000);  // +3 hours
        const newEnd = tsStr(14400_000);    // +4 hours
        await userA.call.updateAvailabilitySlot({
            slotId: target.id,
            startAt: newStart,
            endAt: newEnd,
            isRecurring: false,
            recurrenceType: '',
            interval: 0,
            dayOfWeek: 255,
            dayOfMonth: 0,
            endDate: '',
        });
        await userA.sync();

        const updated = mySlots(userA).find(s => s.id === target.id);
        expect(updated).toBeDefined();
        expect(updated!.startAt.microsSinceUnixEpoch.toString()).toBe(BigInt(newStart).toString());
    });

    it('rejects update from non-owner', async () => {
        const slots = mySlots(userA);
        const target = slots[0];

        const err = await expectReducerError(
            userB.call.updateAvailabilitySlot({
                slotId: target.id,
                startAt: tsStr(3600_000),
                endAt: tsStr(7200_000),
                isRecurring: false,
                recurrenceType: '',
                interval: 0,
                dayOfWeek: 255,
                dayOfMonth: 0,
                endDate: '',
            })
        );
        expect(err).toContain('Not your availability slot');
    });

    // ─── Delete ─────────────────────────────────────────────────────────

    it('deletes own slot', async () => {
        // Create a slot to delete
        await userA.call.createAvailabilitySlot(slotArgs());
        await userA.sync();

        const slotsBefore = mySlots(userA);
        const target = slotsBefore[slotsBefore.length - 1];

        await userA.call.deleteAvailabilitySlot({ slotId: target.id });
        await userA.sync();

        const slotsAfter = mySlots(userA);
        expect(slotsAfter.find(s => s.id === target.id)).toBeUndefined();
    });

    it('rejects delete from non-owner non-Admin', async () => {
        const slots = mySlots(userA);
        if (slots.length === 0) {
            await userA.call.createAvailabilitySlot(slotArgs());
            await userA.sync();
        }
        const target = mySlots(userA)[0];

        const err = await expectReducerError(
            userB.call.deleteAvailabilitySlot({ slotId: target.id })
        );
        expect(err).toContain('You can only delete your own availability slots');
    });

    // ─── Cap Enforcement ────────────────────────────────────────────────

    it('enforces 10-slot cap', async () => {
        // Clean up userB slots first, then fill to cap
        const existingB = mySlots(userB);
        for (const s of existingB) {
            await userB.call.deleteAvailabilitySlot({ slotId: s.id });
        }
        await userB.sync();

        // Create 10 slots
        for (let i = 0; i < 10; i++) {
            await userB.call.createAvailabilitySlot(slotArgs({
                startAt: tsStr(3600_000 + i * 7200_000),
                endAt: tsStr(7200_000 + i * 7200_000),
            }));
        }
        await userB.sync();
        expect(mySlots(userB).length).toBe(10);

        // 11th should fail
        const err = await expectReducerError(
            userB.call.createAvailabilitySlot(slotArgs({
                startAt: tsStr(3600_000 + 10 * 7200_000),
                endAt: tsStr(7200_000 + 10 * 7200_000),
            }))
        );
        expect(err).toContain('Maximum 10 availability slots per user');
    }, 30000);

    // ─── Guest Rejection ────────────────────────────────────────────────

    it('rejects guest creating a slot', async () => {
        const err = await expectReducerError(
            guest.call.createAvailabilitySlot(slotArgs())
        );
        expect(err).toContain('Guests cannot manage availability slots');
    });

    // ─── Lazy Cleanup ───────────────────────────────────────────────────

    it('auto-deletes expired slots (>1 week old) on next create', async () => {
        // Create a fresh user so we have clean state
        const cleanUser = await createVerifiedTestHarness();
        await cleanUser.sync();

        // Create a non-recurring slot with endAt 2 weeks in the past
        // expiresAt = endAt, so expiresAt will be 14 days ago (>1 week grace)
        const twoWeeksAgo = tsStr(-14 * 24 * 60 * 60 * 1000);
        const fifteenDaysAgo = tsStr(-15 * 24 * 60 * 60 * 1000);

        await cleanUser.call.createAvailabilitySlot(slotArgs({
            startAt: fifteenDaysAgo,
            endAt: twoWeeksAgo,
        }));
        await cleanUser.sync();

        const slotsBeforeCleanup = mySlots(cleanUser);
        expect(slotsBeforeCleanup.length).toBe(1);
        const expiredSlotId = slotsBeforeCleanup[0].id;

        // Create a valid future slot — triggers cleanupExpiredSlots
        await cleanUser.call.createAvailabilitySlot(slotArgs());
        await cleanUser.sync();

        const slotsAfterCleanup = mySlots(cleanUser);
        // Expired slot should be gone, only the new valid slot remains
        expect(slotsAfterCleanup.find(s => s.id === expiredSlotId)).toBeUndefined();
        expect(slotsAfterCleanup.length).toBe(1);

        await cleanUser.disconnect();
    }, 20000);
});
