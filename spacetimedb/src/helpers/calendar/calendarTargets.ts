/**
 * S10ac (A157(7)): who may be saved (save_calendar) or invited by hand (create_calendar_event's manual invitees,
 * update_calendar_event's added invitees, invite_to_event). A guest cannot answer an invite (respond_to_invite refuses
 * guests) and a user pending deletion (`deletedAt` set) is about to be removed with all their calendar rows, so both
 * are refused. Invites the server writes itself (a match event's team members and approved stand-ins) are not checked
 * here. Rows that already point at such a user stay until the user's deletion (performUserDeletion →
 * deleteAllCalendarDataForUser; the identity GC deletes idle guests without match history, A95(1)).
 */

import { SenderError } from 'spacetimedb/server';

export type CalendarTargetUse = 'save' | 'invite';

const TEXTS: Record<CalendarTargetUse, { guest: string; deleting: string }> = {
    save: {
        guest: "A guest's calendar cannot be saved.",
        deleting: "This user's account is being deleted; their calendar cannot be saved.",
    },
    invite: {
        guest: 'Guests cannot be invited to calendar events.',
        deleting: "This user's account is being deleted; they cannot be invited.",
    },
};

/** Throws the A157(7) refusal for a guest or pending-deletion `target` (a User row). */
export function ensureCalendarTarget(target: any, use: CalendarTargetUse): void {
    if (target.isGuest) throw new SenderError(TEXTS[use].guest);
    if (target.deletedAt !== undefined) throw new SenderError(TEXTS[use].deleting);
}
