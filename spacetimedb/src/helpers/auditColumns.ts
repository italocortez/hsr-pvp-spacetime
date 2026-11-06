/** System user ID sentinel — used for bootstrap and scheduled operations. */
export const SYSTEM_USER_ID = 0;

/**
 * Returns audit field values for a new row INSERT.
 * Both "created" and "lastModified" point to the same actor and timestamp.
 *
 * **RESTRICTED USE — prefer `insertWithAudit` from `./auditHelpers` for all
 * new-row inserts.** This primitive is retained only for the 9 conditional
 * upsert sites where a single row literal must admit BOTH audit shapes
 * (`existing ? auditUpdate(...) : auditInsert(...)`) or where file-symmetry
 * with such a ternary keeps a primitive `auditInsert` call in a structurally
 * paired else-branch. Splitting any of these sites into `insertWithAudit` /
 * `updateWithAudit` would either duplicate the row literal or force a
 * context switch between two forms of "new row insert" within the same
 * reducer body.
 *
 * **Permanent retention sites (Phase 15.3 Wave 3 Option α, 9 total):**
 * - `helpers/rosterMutations.ts` L55 — P5 inline ternary
 *   (HsrAccountCharacter composite-PK upsert, `applyBatchUpsert` helper).
 * - `reducers/rosterAdmin.ts` L160-161 — P5 inline ternary
 *   (admin_batch_upsert_characters HsrAccountCharacter composite-PK upsert).
 * - `helpers/finalizationHelpers.ts` L148-149 — P5 inline ternary
 *   (MmrRating composite-PK upsert inside `processMatchMmr`).
 * - `reducers/costSetManagement.ts` L176 — P5 if/else split-conditional
 *   (edit_draft_character_cost else-branch — caller builds explicit row
 *   after delete; if-branch carries `auditUpdate`, else-branch `auditInsert`).
 * - `reducers/costSetManagement.ts` L253 — P5 if/else split-conditional
 *   (edit_draft_lightcone_cost else-branch, mirror pattern).
 * - `reducers/costSetManagement.ts` L319 — P5 if/else split-conditional
 *   (edit_draft_synergy_cost else-branch, mirror pattern).
 * - `reducers/costSetManagement.ts` L369 — P5 inline ternary
 *   (publish_cost_set HsrCharacterCost sync).
 * - `reducers/costSetManagement.ts` L391 — P5 inline ternary
 *   (publish_cost_set HsrLightconeCost sync).
 * - `reducers/costSetManagement.ts` L424 — primitive call, file-symmetry
 *   (publish_cost_set HsrSynergyCost upsert else-branch — sibling inline
 *   ternaries at L369/L391 already force `auditInsert` to stay callable in
 *   this file; migrating only this else-branch yields zero eviction win).
 *
 * See Phase 15.3 CONTEXT.md D-06 / D-07 (two-tier API rationale) and
 * Plan 13 SUMMARY (Option α final accounting).
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
