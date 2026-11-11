/**
 * S10ac (A157(2), A157(9), A157(11)): the one validator of every calendar time argument, the length and distance
 * bounds, the past-start rule, the UTC week of the slot cap and the character count of the event texts.
 *
 * Time arguments are micros since the Unix epoch sent as decimal strings (BigInt-safe). `parseCalendarTime` accepts
 * digits only (no sign, no decimal point, no spaces, not empty, at most 19 digits) inside [2020-01-01, 2100-01-01) UTC
 * and throws `SenderError` otherwise, so no `SyntaxError` / `TypeError` from `BigInt(...)` and no i64 wrap can reach a
 * stored row (review B1).
 */

import { SenderError } from 'spacetimedb/server';

const MICROS_PER_SECOND = 1_000_000n;
export const MICROS_PER_HOUR = 3_600n * MICROS_PER_SECOND;
export const MICROS_PER_DAY = 24n * MICROS_PER_HOUR;

/** 2020-01-01T00:00:00Z and 2100-01-01T00:00:00Z in micros: the accepted range (min included, max excluded). */
export const CALENDAR_TIME_MIN_MICROS = 1_577_836_800n * MICROS_PER_SECOND;
export const CALENDAR_TIME_MAX_MICROS = 4_102_444_800n * MICROS_PER_SECOND;

/** A157(11): bounds (orchestrator's values). */
export const MAX_SLOT_LENGTH_MICROS = 24n * MICROS_PER_HOUR;
export const MAX_EVENT_LENGTH_MICROS = 7n * MICROS_PER_DAY;
export const MAX_EVENT_LEAD_MICROS = 365n * MICROS_PER_DAY; // "12 months ahead"

export const PAST_START_TEXT = "You can't schedule something in the past."; // the mockup's text (calendar.html 2195)

const DIGITS = /^[0-9]{1,19}$/;

/** Parses a micros string; `label` names the argument in the refusal ("start time" → "Invalid start time."). */
export function parseCalendarTime(value: string, label: string): bigint {
    const text = typeof value === 'string' ? value : '';
    if (!DIGITS.test(text)) throw new SenderError(`Invalid ${label}.`);
    const micros = BigInt(text);
    if (micros < CALENDAR_TIME_MIN_MICROS || micros >= CALENDAR_TIME_MAX_MICROS) throw new SenderError(`Invalid ${label}.`);
    return micros;
}

/** Parses both bounds and checks start < end (the existing text). */
export function parseInterval(startAt: string, endAt: string): { start: bigint; end: bigint } {
    const start = parseCalendarTime(startAt, 'start time');
    const end = parseCalendarTime(endAt, 'end time');
    if (start >= end) throw new SenderError('Start time must be before end time.');
    return { start, end };
}

/**
 * A157(9): a start before `now` is refused on create, and on an update that moves the start (`previousStart` given and
 * different). An update that keeps the start of an item that has already started passes.
 */
export function ensureStartNotPast(start: bigint, now: bigint, previousStart?: bigint): void {
    if (previousStart !== undefined && start === previousStart) return;
    if (start < now) throw new SenderError(PAST_START_TEXT);
}

/** Monday 1970-01-05 00:00 UTC: weeks are counted from a Monday (A157(2), orchestrator's reading: UTC weeks). */
const MONDAY_EPOCH_MICROS = 4n * MICROS_PER_DAY;
const WEEK_MICROS = 7n * MICROS_PER_DAY;

/** A157(2): the start (Monday 00:00 UTC) of the UTC week `micros` falls in. Inputs are after 2020 (positive). */
export function utcWeekStart(micros: bigint): bigint {
    return ((micros - MONDAY_EPOCH_MICROS) / WEEK_MICROS) * WEEK_MICROS + MONDAY_EPOCH_MICROS;
}

/** A157(11): the length of a text in characters (Unicode code points), not UTF-16 units (review B6). */
export function charCount(text: string): number {
    let n = 0;
    for (const _ of text) n++;
    return n;
}

/** Half-open intervals [aStart, aEnd) and [bStart, bEnd) overlap; touching intervals do not. */
export function intervalsOverlap(aStart: bigint, aEnd: bigint, bStart: bigint, bEnd: bigint): boolean {
    return aStart < bEnd && bStart < aEnd;
}
