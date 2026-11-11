// Shared helpers: the Auction draft mode, row snapshots and step lists.
// From S10c (s10c-high-fixes.test.ts); not a test file.
import { steps, type Harness } from './harness';

export const AUCTION = { draftMode: { tag: 'Auction' } };

/** A JSON snapshot of rows (bigint-safe), to prove "nothing changed" across a rejected call. */
export const snap = (...rows: unknown[]) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

export const stepsOf = (test: Harness, lobbyId: number, action: string) =>
    steps(test, lobbyId).filter((st) => st.action.tag === action).sort((a, b) => a.sequence - b.sequence);
