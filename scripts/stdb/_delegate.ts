/**
 * S10s (A122(23), L101): the delegate rotation of bootstrap, in the order that keeps sign-in working.
 *
 *   1. register the new delegate (as the owner);
 *   2. save its token and identity to `.env.<target>.local`;
 *   3. only then revoke the previous delegate (best effort).
 *
 * A failure in step 1 or 2 throws before anything is revoked, so the previous delegate (and the token the auth
 * function holds) keeps working; a re-run mints another identity and tries again. A failed revoke in step 3 is
 * reported and the rotation still counts as done (the new delegate is registered and saved; the old one can be revoked
 * by the next run or by hand). Pure orchestration: the reducer calls and the file write are injected, so the ordering
 * is unit-tested with fakes (test/backend/scripts/delegate-rotation.unit.test.ts) without contacting a database.
 */
export interface DelegateRotationSteps {
    /** server_register_delegate(freshHex, label) as the owner. */
    register: (identityHex: string, label: string) => Promise<void>;
    /** Writes STDB_SERVER_TOKEN and STDB_SERVER_IDENTITY for this target. */
    save: (token: string, identityHex: string) => void;
    /** server_revoke_delegate(previousHex) as the owner. */
    revoke: (identityHex: string) => Promise<void>;
    log: (line: string) => void;
}

export interface DelegateRotation {
    freshToken: string;
    freshHex: string;
    /** STDB_SERVER_IDENTITY read from the target's file before the rotation, if any. */
    previousHex: string | undefined;
    label: string;
}

export async function rotateDelegate(r: DelegateRotation, steps: DelegateRotationSteps): Promise<void> {
    await steps.register(r.freshHex, r.label);
    steps.log(`[bootstrap] registered delegate "${r.label}"`);

    steps.save(r.freshToken, r.freshHex);
    steps.log('[bootstrap] saved the new delegate token and identity');

    if (r.previousHex && r.previousHex !== r.freshHex) {
        try {
            await steps.revoke(r.previousHex);
            steps.log(`[bootstrap] revoked previous delegate ${r.previousHex}`);
        } catch (err) {
            steps.log(`[bootstrap] previous delegate not revoked (${err instanceof Error ? err.message : err})`);
        }
    }
}
