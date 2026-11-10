// T-S10 batch C2: builders shared by s10-calendar, s10-roster and s10-seed (in-memory ports of the calendar, roster and
// seed live suites). Not a test file. State is built through the module's reducers; reference rows (characters,
// archetypes) are inserted straight into the in-memory datastore like the S6 / S7 builders. Calendar reducers take
// micros strings derived from the TestClock (START = 2026-01-01), never Date.now(). `test.db` is read only outside
// `tx` bodies. Nothing reaches maincloud.
import { expect } from 'vitest';
import { M, linkDiscord, guest, tx, type Actor, type Harness } from './s4-fixtures';

// ─── Time ────────────────────────────────────────────────────────────────────

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const MICROS_PER_MS = 1_000n;

/** Micros since the epoch, `ms` from the TestClock's now, as the micros string the calendar reducers take. */
export const fromNow = (test: Harness, ms: number) => (test.clock.now().microsSinceUnixEpoch + BigInt(ms) * MICROS_PER_MS).toString();
export const micros = (ms: number) => BigInt(ms) * MICROS_PER_MS;

// ─── Rejections ──────────────────────────────────────────────────────────────

type Ctx = Parameters<Parameters<Harness['withReducerTx']>[1]>[0];

/**
 * Runs the call, asserts it throws (the transaction is rolled back) and returns the message, so a test can check the
 * state first and the contract's exact text last: a text mismatch then reads as a text mismatch, not a behaviour one.
 */
export function rejection(test: Harness, actor: Actor | 'internal', body: (ctx: Ctx) => unknown): string {
    let message: string | undefined;
    try {
        tx(test, actor, body);
    } catch (e) {
        message = e instanceof Error ? e.message : String(e);
    }
    expect(message, 'the call was expected to be rejected').toBeDefined();
    return message!;
}

// ─── Calendar ────────────────────────────────────────────────────────────────

export interface SlotOpts {
    startMs?: number;
    endMs?: number;
    isRecurring?: boolean;
    recurrenceType?: string;
    interval?: number;
    dayOfWeek?: number;
    dayOfMonth?: number;
    endDate?: string;
}

/** create_availability_slot arguments; a one-time 2-hour slot one day out unless overridden. */
export function slotArgs(test: Harness, o: SlotOpts = {}) {
    const startMs = o.startMs ?? DAY_MS;
    return {
        startAt: fromNow(test, startMs),
        endAt: fromNow(test, o.endMs ?? startMs + 2 * HOUR_MS),
        isRecurring: o.isRecurring ?? false,
        recurrenceType: o.recurrenceType ?? '',
        interval: o.interval ?? 0,
        dayOfWeek: o.dayOfWeek ?? 255,
        dayOfMonth: o.dayOfMonth ?? 0,
        endDate: o.endDate ?? '',
    };
}

export function addSlot(test: Harness, who: Actor, o: SlotOpts = {}): number {
    const before = new Set(slotsOf(test, who).map((s) => s.id));
    const args = slotArgs(test, o);
    tx(test, who, (ctx) => M.create_availability_slot(ctx, args));
    return slotsOf(test, who).find((s) => !before.has(s.id))!.id;
}

export const slotsOf = (test: Harness, who: Actor) => [...test.db.AvailabilitySlot.user_id.filter(who.userId)];

export interface EventOpts {
    title?: string;
    description?: string;
    startMs?: number;
    endMs?: number;
    bracketMatchId?: number;
    invitees?: Array<Actor | number>;
}

/** create_calendar_event arguments: a 2-hour event one day out, comma-separated invitee ids. */
export function eventArgs(test: Harness, o: EventOpts = {}) {
    const startMs = o.startMs ?? DAY_MS;
    return {
        title: o.title ?? 'Scrim',
        description: o.description ?? '',
        startAt: fromNow(test, startMs),
        endAt: fromNow(test, o.endMs ?? startMs + 2 * HOUR_MS),
        bracketMatchId: o.bracketMatchId ?? 0,
        inviteeUserIds: (o.invitees ?? []).map((i) => (typeof i === 'number' ? i : i.userId)).join(','),
    };
}

/**
 * S10s re-alignment (A122(4), L93): calendar reducers count on the per-user membership allowance (20 calls per 10 s).
 * Seeding helpers that create dozens of rows in one instant empty the caller's count first, so cap tests keep testing
 * the caps; the allowance itself is tested in s10s-triage-fixes.test.ts through direct reducer calls.
 */
export function clearMembershipCount(test: Harness, who: Actor): void {
    const row = test.db.UserRateState.userId.find(who.userId);
    if (row) test.db.UserRateState.userId.update({ ...row, membershipCount: 0 });
}

/** Creates the event as `who`; returns the new event's id (a seeding helper: clears the allowance count first). */
export function createEvent(test: Harness, who: Actor, o: EventOpts = {}): number {
    clearMembershipCount(test, who);
    const before = new Set(eventsOf(test, who).map((e) => e.id));
    const args = eventArgs(test, o);
    tx(test, who, (ctx) => M.create_calendar_event(ctx, args));
    return eventsOf(test, who).find((e) => !before.has(e.id))!.id;
}

export const eventsOf = (test: Harness, who: Actor) => [...test.db.CalendarEvent.organizer_id.filter(who.userId)];
export const invitesOf = (test: Harness, eventId: number) => [...test.db.CalendarEventInvite.event_id.filter(eventId)];
export const invite = (test: Harness, eventId: number, userId: number) =>
    [...test.db.CalendarEventInvite.by_event_and_invitee.filter([eventId, userId])][0];
export const savedOf = (test: Harness, who: Actor) => [...test.db.SavedCalendar.user_id.filter(who.userId)];

// ─── Roster ──────────────────────────────────────────────────────────────────

/** A JSON character batch for batch_upsert_characters (`[name, eidolon]` pairs; a bare name is E0). */
export const roster = (items: Array<string | [string, number]>) =>
    JSON.stringify(items.map((i) => (typeof i === 'string' ? { characterName: i, eidolonLevel: 0 } : { characterName: i[0], eidolonLevel: i[1] })));

/** create_hsr_account as `who`; returns the new account's id. */
export function createAccount(test: Harness, who: Actor, uid: string, displayLabel = ''): number {
    tx(test, who, (ctx) => M.create_hsr_account(ctx, { uid, displayLabel }));
    return [...test.db.HsrAccount.user_id.filter(who.userId)].find((a) => a.uid === uid)!.id;
}

export const account = (test: Harness, id: number) => test.db.HsrAccount.id.find(id) ?? undefined; // find() returns null when absent
export const accountsOf = (test: Harness, userId: number) => [...test.db.HsrAccount.user_id.filter(userId)];
/** The account's characters as { name: eidolon }. */
export const charsOf = (test: Harness, accountId: number) =>
    Object.fromEntries([...test.db.HsrAccountCharacter.hsr_account_id.filter(accountId)].map((c) => [c.characterName, c.eidolonLevel]));

/** Reference characters with no rating config (role Dps, version 1.0). */
export function seedCharacters(test: Harness, names: string[]) {
    tx(test, 'internal', (ctx) => {
        for (const name of names) {
            ctx.db.HsrCharacter.insert({
                name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Hunt' }, element: { tag: 'Fire' },
                role: { tag: 'Dps' }, imageUrl: '', versionReleased: 1.0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
    });
}

/** Reference light cones (path Destruction). */
export function seedLightcones(test: Harness, names: string[]) {
    tx(test, 'internal', (ctx) => {
        for (const name of names) {
            ctx.db.HsrLightcone.insert({
                name, displayName: name, aliases: [], path: { tag: 'Destruction' }, rarity: 5, imageUrl: '', posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
    });
}

/**
 * T-S10f (roster audit #9): edit_draft_character_cost / _lightcone_cost require HsrCharacter / HsrLightcone rows.
 * Seeds the names that are not there yet (safe to call after seedCharacters / seedLightcones).
 */
export function seedReferenceNames(test: Harness, characters: string[], lightcones: string[] = []) {
    seedCharacters(test, characters.filter((n) => !test.db.HsrCharacter.name.find(n)));
    seedLightcones(test, lightcones.filter((n) => !test.db.HsrLightcone.name.find(n)));
}

// Copied from s6-rules.test.ts (local there): the rating fixtures.
export const RATING_CHARS = ['c1', 'c2', 'c5', 'c6', 'c9'];

/** Characters (same version, same role: symmetric age weights), one archetype {c1, c5, c9}, then the config. */
export function seedRatingData(test: Harness) {
    tx(test, 'internal', (ctx) => {
        for (const name of RATING_CHARS) {
            ctx.db.HsrCharacter.insert({
                name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Harmony' }, element: { tag: 'Fire' },
                role: { tag: 'Support' }, imageUrl: '', versionReleased: 2.0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
        const arch = ctx.db.Archetype.insert({
            id: 0, name: 'hypercarry', description: '',
            createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
        });
        for (const name of ['c1', 'c5', 'c9']) {
            ctx.db.HsrCharacterArchetype.insert({
                characterName: name, archetypeId: arch.id,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            });
        }
    });
    tx(test, 'internal', (ctx) => M.admin_seed_rating_config(ctx, {}));
}

/** A verified player with two accounts holding disjoint rosters of the same shape ({c1, c2} and {c5, c6}). */
export function twoAccountPlayer(test: Harness, name = 'multi'): { who: Actor; acct1: number; acct2: number } {
    const who = guest(test, name);
    linkDiscord(test, who, `discord-${name}`, name);
    tx(test, who, (ctx) => M.create_hsr_account(ctx, { uid: '600000001', displayLabel: 'main' }));
    tx(test, who, (ctx) => M.create_hsr_account(ctx, { uid: '600000002', displayLabel: 'alt' }));
    const [acct1, acct2] = accountsOf(test, who.userId).map((a) => a.id).sort((a, b) => a - b);
    tx(test, who, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: acct1, charactersJson: roster(['c1', 'c2']) }));
    tx(test, who, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: acct2, charactersJson: roster(['c5', 'c6']) }));
    return { who, acct1, acct2 };
}

// ─── Seed / bulk upsert ──────────────────────────────────────────────────────

/** admin_bulk_upsert as the owner identity (what the seed script's server token is). */
export function bulkUpsert(test: Harness, tableName: string, rows: object[]) {
    tx(test, 'internal', (ctx) => M.admin_bulk_upsert(ctx, { tableName, jsonData: JSON.stringify(rows) }));
}
