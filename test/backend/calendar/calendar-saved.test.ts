/**
 * Integration tests for saved calendar (bookmark) reducers.
 *
 * Tests save/unsave, toggle visibility, 5-cap, duplicate guard,
 * self-save rejection, and guest rejection.
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/calendar/contract.md — Saved Calendar scenarios
 * UAT: .planning/phases/08-calendar-and-scheduling/08-UAT.md — Tests 5-8
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createTestHarness,
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get this user's saved calendars from subscription cache */
function mySaved(h: TestHarness) {
    return [...h.conn.db.SavedCalendar.iter()].filter(s => s.userId === h.userId);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Calendar Saved (Bookmarks)', () => {
    let userA: TestHarness;
    let targets: TestHarness[] = [];
    let guest: TestHarness;

    beforeAll(async () => {
        // userA is the main test subject; create 6 targets for cap testing
        userA = await createVerifiedTestHarness();
        for (let i = 0; i < 6; i++) {
            targets.push(await createVerifiedTestHarness());
        }
        guest = await createTestHarness();

        await userA.sync();
        for (const t of targets) await t.sync();
        await guest.sync();
    }, 60000);

    afterAll(async () => {
        await userA?.disconnect();
        for (const t of targets) await t?.disconnect();
        await guest?.disconnect();
    });

    // ─── Save ───────────────────────────────────────────────────────────

    it('saves another user\'s calendar with isVisible=true', async () => {
        await userA.call.saveCalendar({ targetUserId: targets[0].userId });
        await userA.sync();

        const saved = mySaved(userA);
        const entry = saved.find(s => s.targetUserId === targets[0].userId);
        expect(entry).toBeDefined();
        expect(entry!.isVisible).toBe(true);
    });

    it('rejects saving own calendar', async () => {
        const err = await expectReducerError(
            userA.call.saveCalendar({ targetUserId: userA.userId })
        );
        expect(err).toContain('Cannot save your own calendar');
    });

    it('rejects duplicate save', async () => {
        // targets[0] already saved above
        const err = await expectReducerError(
            userA.call.saveCalendar({ targetUserId: targets[0].userId })
        );
        expect(err).toContain('Already saved');
    });

    it('enforces 5-saved-calendar cap', async () => {
        // Save targets[1] through targets[4] (4 more, total = 5)
        for (let i = 1; i <= 4; i++) {
            await userA.call.saveCalendar({ targetUserId: targets[i].userId });
        }
        await userA.sync();
        expect(mySaved(userA).length).toBe(5);

        // 6th should fail
        const err = await expectReducerError(
            userA.call.saveCalendar({ targetUserId: targets[5].userId })
        );
        expect(err).toContain('Maximum 5 saved calendars per user');
    });

    // ─── Toggle Visibility ──────────────────────────────────────────────

    it('toggles visibility false then back to true', async () => {
        await userA.call.toggleCalendarVisibility({
            targetUserId: targets[0].userId,
            isVisible: false,
        });
        await userA.sync();

        let entry = mySaved(userA).find(s => s.targetUserId === targets[0].userId);
        expect(entry).toBeDefined();
        expect(entry!.isVisible).toBe(false);

        await userA.call.toggleCalendarVisibility({
            targetUserId: targets[0].userId,
            isVisible: true,
        });
        await userA.sync();

        entry = mySaved(userA).find(s => s.targetUserId === targets[0].userId);
        expect(entry!.isVisible).toBe(true);
    });

    it('rejects toggle on non-saved calendar', async () => {
        const err = await expectReducerError(
            userA.call.toggleCalendarVisibility({
                targetUserId: targets[5].userId,  // not saved (cap prevented it)
                isVisible: false,
            })
        );
        expect(err).toContain('Calendar not saved');
    });

    // ─── Unsave ─────────────────────────────────────────────────────────

    it('unsaves a calendar', async () => {
        // Unsave targets[4]
        await userA.call.unsaveCalendar({ targetUserId: targets[4].userId });
        await userA.sync();

        const entry = mySaved(userA).find(s => s.targetUserId === targets[4].userId);
        expect(entry).toBeUndefined();
    });

    it('rejects unsave of non-saved calendar', async () => {
        const err = await expectReducerError(
            userA.call.unsaveCalendar({ targetUserId: targets[5].userId })
        );
        expect(err).toContain('Calendar not saved');
    });

    // ─── Guest Rejection ────────────────────────────────────────────────

    it('rejects guest saving a calendar', async () => {
        const err = await expectReducerError(
            guest.call.saveCalendar({ targetUserId: targets[0].userId })
        );
        expect(err).toContain('Guests cannot save calendars');
    });
});
