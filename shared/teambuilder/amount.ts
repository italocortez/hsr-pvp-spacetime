// S14.3b: the Auction amounts typed into the team builder (a slot's extra bid, the two budgets). The team keeps them
// in integer hundredths, as the packed team text writes them (teamCode.ts: a bid 0..BID_MAX, a budget 0..BUDGET_MAX).

/** What a typed amount reads as. */
export type AmountRead =
    /** Nothing typed (spaces only). */
    | { kind: 'blank' }
    /** An amount in hundredths, at most `max`; `capped` when the text asked for more. */
    | { kind: 'amount'; value: number; capped: boolean }
    /**
     * Not read: `ambiguous` for a comma followed by exactly three digits ("1,000": a thousand to one reader, one to
     * another; also ",500" and "0,500"); `unreadable` for anything else that is not an amount (letters, a sign, "1e3", "1.2.3", "1,000.50").
     */
    | { kind: 'refused'; reason: 'ambiguous' | 'unreadable' };

/** One currency sign at either end, as a pasted price has it ("$5.00", "2,5 €"). */
const CURRENCY = /^[$€£¥]\s*|\s*[$€£¥]$/g;

/**
 * Reads a typed amount (review S3, S4, M5, fix pass). Accepted: digits with at most one decimal mark, a dot or a
 * comma ("2", "2.5", "2,5", ".5", "2.", "2.25"); spaces around it and one currency sign at either end are dropped.
 * A comma is a decimal mark, because many players write decimals with one, except where it is followed by exactly
 * three digits ("1,000", "12,500"): that reads as a thousands separator to others, so it is refused rather than
 * guessed. S14.3d, one rule whatever stands before the comma: a comma followed by exactly three digits is refused
 * as unclear also with nothing or only zeros before it (",500" like "0,500"; ",5" and ",50" still read 0.5).
 * A dot is always the decimal mark. More than two decimals round half up on the digits ("1.005" is 1.01,
 * "1.234" is 1.23), never through floating point. Above `max` the amount is `max`, marked `capped`.
 */
export function readAmount(text: string, max: number): AmountRead {
    const t = text.trim().replace(CURRENCY, '').trim();
    const unreadable: AmountRead = { kind: 'refused', reason: 'unreadable' };
    if (t === '') return text.trim() === '' ? { kind: 'blank' } : unreadable;
    if (/^\d*,\d{3}$/.test(t)) return { kind: 'refused', reason: 'ambiguous' };
    const m = /^(\d*)(?:[.,](\d*))?$/.exec(t);
    const whole = (m?.[1] ?? '').replace(/^0+(?=\d)/, '');
    const fraction = m?.[2] ?? '';
    if (!m || (whole === '' && fraction === '')) return unreadable;
    // Longer than any cap in hundredths: no need to read it exactly.
    if (whole.length > 12) return { kind: 'amount', value: max, capped: true };
    const roundUp = Number(fraction.charAt(2) || '0') >= 5 ? 1 : 0;
    const cents = Number(`${fraction}00`.slice(0, 2)) + roundUp;
    const value = Number(whole || '0') * 100 + cents;
    if (value > max) return { kind: 'amount', value: max, capped: true };
    return { kind: 'amount', value, capped: false };
}

/** The amount in hundredths a text reads as, or null for a blank or a refused text (see `readAmount`). */
export function parseAmount(text: string, max: number): number | null {
    const r = readAmount(text, max);
    return r.kind === 'amount' ? r.value : null;
}

/** An amount in hundredths as a field shows it: "0", "2.5", "2.25", "30" (no trailing zeros). */
export function amountText(hundredths: number): string {
    const whole = Math.trunc(hundredths / 100);
    const cents = Math.abs(hundredths % 100);
    if (cents === 0) return String(whole);
    const sign = hundredths < 0 && whole === 0 ? '-' : '';
    return `${sign}${whole}.${String(cents).padStart(2, '0').replace(/0$/, '')}`;
}
