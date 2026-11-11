// Shared helpers: row snapshots and the 1v1 seats.
// From S10d (s10d-rulings.test.ts); not a test file.
import type { SetupOpts } from './harness';

// ─── Shared builders ──────────────────────────────────────────────────────────────────────────────────────────────

/** A JSON snapshot of rows (bigint-safe), to prove "nothing changed" across a rejected call. */
export const snap = (...rows: unknown[]) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
export const ONE_V_ONE: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];
