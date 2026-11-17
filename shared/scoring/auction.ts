import { toHundredths } from './fixedPoint';

// A61(3) / A64: the Auction eidolon extra. A character sold in an Auction draft costs its winning bid (whose base is
// the E0 cost, A61(1)) plus, for a higher eidolon, the extra max(0, cost[e] - cost[e0]) from the lobby's cost set.
// The module charges it in `spacetimedb/src/reducers/draft/draftAuction.ts` (`auctionEidolonExtra`, f32 like the
// budgets); this is the same rule for previews that sum with the rest of this module (the team builder, S14.3a).
// Added in S14.3a; the module's own copy is unchanged.

/** The eidolon extra of two values already in hundredths: never below 0 (a cheaper eidolon adds nothing). */
export function eidolonExtra(costAtE0: number, costAtEidolon: number): number {
    return Math.max(0, costAtEidolon - costAtE0);
}

/**
 * The eidolon extra from the stored cost row (f32 values), in hundredths, in the module's order: subtract the stored
 * values, clamp at 0, and only then round once (`auctionEidolonExtra` subtracts the f32 costs; the result becomes
 * hundredths at the boundary). Rounding each cost first and subtracting can differ by one hundredth when a cost
 * holds more than two decimals (review S14.3a M1).
 */
export function auctionEidolonExtra(storedAtE0: number, storedAtEidolon: number): number {
    return toHundredths(Math.max(0, storedAtEidolon - storedAtE0));
}
