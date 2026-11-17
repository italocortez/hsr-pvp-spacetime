// ─── Pair modifier floor (A199(2), S14.3-pairs) ──────────────────────────────────────────────────────────────────
// A cost set's synergy pair modifier is always 0 or more. Every reducer path that writes a pair modifier of a cost set
// calls this check before it writes: edit_draft_synergy_cost (the edited value), create_cost_set (each copied source
// row), publish_cost_set (each draft row, before the live copy is made equal to the draft) and admin_bulk_upsert
// (HsrSynergyCost, each incoming value; the seed runs through it). The floor at 0 in the scoring code stays as a
// safeguard for a negative row written before this rule (A199(3)).

import { SenderError } from 'spacetimedb/server';

export const NEGATIVE_PAIR_MODIFIER = "A pairing's cost cannot be negative.";

/**
 * Refuses a negative pair modifier with NEGATIVE_PAIR_MODIFIER. A value that is not below 0 passes (0 included, and
 * null / undefined: admin_bulk_upsert's "keep the stored value" marker); the callers keep their own finite / upper
 * bound checks.
 */
export function ensurePairModifierNotNegative(costModifier: unknown): void {
    if (typeof costModifier === 'number' && costModifier < 0) throw new SenderError(NEGATIVE_PAIR_MODIFIER);
}
