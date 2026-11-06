import { SenderError } from 'spacetimedb/server';
import { updateWithAudit } from './auditHelpers';

/** Map of UID first digit to HSR region name */
const REGION_MAP: Record<string, string> = {
    '6': 'America',
    '7': 'Europe',
    '8': 'Asia',
    '9': 'TW_HK_MO',
};

/**
 * Validates that a UID is exactly 9 digits and starts with a valid region digit.
 * Throws SenderError on failure.
 */
export function validateUid(uid: string): void {
    if (!/^\d{9}$/.test(uid)) {
        throw new SenderError('UID must be exactly 9 digits');
    }
    if (!REGION_MAP[uid[0]]) {
        throw new SenderError(`Invalid UID: first digit must be 6, 7, 8, or 9`);
    }
}

/**
 * Derives the HSR region string from the first digit of the UID.
 * Must be called AFTER validateUid().
 */
export function deriveRegion(uid: string): string {
    const region = REGION_MAP[uid[0]];
    if (!region) {
        throw new SenderError(`Invalid UID: first digit "${uid[0]}" does not map to a known region`);
    }
    return region;
}

/**
 * Recalculates isDuplicateUid for ALL accounts sharing the given UID.
 * Called after account creation or deletion.
 * If 2+ accounts share the UID, all get isDuplicateUid = true.
 * If only 1 account has the UID, it gets isDuplicateUid = false.
 */
export function recalcDuplicateUid(ctx: any, uid: string, actorId: number): void {
    const accounts = [...ctx.db.HsrAccount.uid.filter(uid)];
    const isDuplicate = accounts.length > 1;
    for (const acc of accounts) {
        if (acc.isDuplicateUid !== isDuplicate) {
            ctx.db.HsrAccount.id.update(
                updateWithAudit(ctx, acc, { isDuplicateUid: isDuplicate }, actorId),
            );
        }
    }
}
