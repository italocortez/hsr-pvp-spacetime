import { Timestamp } from 'spacetimedb';
import { SYSTEM_USER_ID } from './auditColumns';

/**
 * Shape of the four audit columns every audited table carries.
 * Generic helpers return `T & AuditFields` to preserve caller row typing.
 */
export type AuditFields = {
    createdById: number;
    createdDate: Timestamp;
    lastModifiedById: number;
    lastModifiedDate: Timestamp;
};

/**
 * Returns `row` with audit fields stamped for an INSERT.
 * createdBy/Date and lastModifiedBy/Date point to the same actor + timestamp.
 *
 * Usage:
 *   ctx.db.HsrCharacter.insert(insertWithAudit(ctx, row, admin.id));
 */
export function insertWithAudit<T extends object>(
    ctx: any,
    row: T,
    userId: number = SYSTEM_USER_ID,
): T & AuditFields {
    return {
        ...row,
        createdById: userId,
        createdDate: ctx.timestamp,
        lastModifiedById: userId,
        lastModifiedDate: ctx.timestamp,
    };
}

/**
 * Returns a merged row with `changes` applied on top of `existing`, audit fields
 * stamped for an UPDATE (createdById/Date carried over from existing; lastModified*
 * set to the acting user + now).
 *
 * Usage:
 *   ctx.db.BracketMatch.id.update(
 *     updateWithAudit(ctx, existing, { team1Id: teamId }, userId)
 *   );
 *
 * For composite-PK delete+insert sites where the caller has already built a full
 * row, use the `auditUpdate` primitive from `./auditColumns` instead.
 */
export function updateWithAudit<T extends { createdById: number; createdDate: Timestamp }>(
    ctx: any,
    existing: T,
    changes: Partial<T>,
    userId: number = SYSTEM_USER_ID,
): T & AuditFields {
    return {
        ...existing,
        ...changes,
        createdById: existing.createdById,
        createdDate: existing.createdDate,
        lastModifiedById: userId,
        lastModifiedDate: ctx.timestamp,
    };
}
