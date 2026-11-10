/** System user ID sentinel — used for bootstrap and scheduled operations. */
export const SYSTEM_USER_ID = 0;

/**
 * Returns audit field values for a new row INSERT.
 * Both "created" and "lastModified" point to the same actor and timestamp.
 *
 * **RESTRICTED USE — prefer `insertWithAudit` from `./auditHelpers` for all
 * new-row inserts.** This primitive is retained only for the conditional
 * upsert sites where a single row literal must admit BOTH audit shapes
 * (`existing ? auditUpdate(...) : auditInsert(...)`) or where file-symmetry
 * with such a ternary keeps a primitive `auditInsert` call in a structurally
 * paired else-branch. Splitting any of these sites into `insertWithAudit` /
 * `updateWithAudit` would either duplicate the row literal or force a
 * context switch between two forms of "new row insert" within the same
 * reducer body.
 *
 * **Retention sites (Phase 15.3 Option α; paths and functions as of S10j):**
 * - `helpers/roster/rosterMutations.ts` `applyBatchUpsert` — inline ternary
 *   (HsrAccountCharacter composite-PK upsert).
 * - `reducers/roster/rosterAdmin.ts` `admin_batch_upsert_characters` — inline ternary (same upsert).
 * - `helpers/results/finalizationHelpers.ts` `processMatchMmr` — inline ternary (MmrRating upsert).
 * - `reducers/roster/costSetManagement.ts` `edit_draft_character_cost` / `edit_draft_lightcone_cost` /
 *   `edit_draft_synergy_cost` — if/else split-conditional (the else-branch inserts the new draft row).
 * - `helpers/roster/costSetCompleteness.ts` `mirrorDraftToLive` — inline ternaries (publish sync), with
 *   the primitive inserts of `fillMissingAtZero`, `ensureDraftCopy` and `mirrorDraftToLive` kept for symmetry.
 *
 * See Phase 15.3 CONTEXT.md D-06 / D-07 (two-tier API rationale).
 */
export function auditInsert(ctx: any, userId: number = SYSTEM_USER_ID) {
    return {
        createdById: userId,
        createdDate: ctx.timestamp,
        lastModifiedById: userId,
        lastModifiedDate: ctx.timestamp,
    };
}

/**
 * Returns audit field values for an UPDATE (preserves original created* fields).
 * Caller must spread the existing row first, then spread this on top.
 */
export function auditUpdate(ctx: any, existing: any, userId: number = SYSTEM_USER_ID) {
    return {
        createdById: existing.createdById,
        createdDate: existing.createdDate,
        lastModifiedById: userId,
        lastModifiedDate: ctx.timestamp,
    };
}
