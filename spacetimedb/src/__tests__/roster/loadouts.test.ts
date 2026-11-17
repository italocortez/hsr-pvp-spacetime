// Roster: team builder loadouts on the account (save_loadout, delete_loadout, view_my_loadouts).
// Decisions: A190 items 1, 3, 15
// Contracts: docs/loadout/contract.md
// From S14.3s.
//
// T-S14.3s: the design's 18 scenarios (tmp/teambuilder/loadout-backend.md § 7.1) adapted to what was built, plus the
// canonical-text rule, the unknown-name refusals, the guest text, the shared allowance, the deletion cascade and the
// view for owner, other member, guest and an identity with no user. Every `it` cites its scenario of
// docs/loadout/contract.md. In-memory datastore on the TestClock; nothing reaches maincloud.
// T-S14.3s-limit (A194 item 6): the save limit of its own (6 per account per minute, UserLoadoutRate) replaces the
// shared membership allowance; the former tests 14 ("Too fast", 20 per 10 s) and 14b (shared with the roster writes)
// asserted that allowance for loadouts and are replaced by the "save limit" block below.
// T-S14.3s-limit2 (review of S14.3s-limit): L7 to L10 add the limit as the last check, the unchanged window row on a
// too-fast refusal, no window row for a guest, and one window for two identities of one account.
// T-S14.3c-rev (A198): `isNew` is replaced by the base version `baseRev` (0 creates; above 0 updates the copy seen at
// that version) and delete_loadout takes `baseRev` too. The earlier tests keep their assertions with the new arguments
// (an update states the version it read; the view rows gain `rev`); the "versions" block below adds the version rules.
import { describe, expect, it } from 'vitest';
import { MAINTENANCE_TEXT } from '@module/helpers/identity/ensurePermissions';
import { MEMBERSHIP_ACTION_TEXT, MEMBERSHIP_CHANGES_PER_WINDOW } from '@module/helpers/lobby/abuseControls';
import {
    LOADOUT_SAVES_PER_WINDOW,
    LOADOUT_SAVE_WINDOW_MS,
    LOADOUT_TOO_FAST_TEXT,
    LOADOUT_CODE_TEXT,
    LOADOUT_CONFLICT_TEXT,
    LOADOUT_DUPLICATE_TEXT,
    LOADOUT_GONE_TEXT,
    LOADOUT_REV_MAX,
    LOADOUT_REV_MAX_TEXT,
    LOADOUT_NAME_EMPTY_TEXT,
    LOADOUT_NAME_TEXT,
    LOADOUT_NOTE_TEXT,
    LOADOUT_SLOT_TAKEN_TEXT,
    LOADOUT_SLOT_TEXT,
    LOADOUT_VERIFIED_TEXT,
} from '@module/helpers/roster/loadoutRules';
import {
    M,
    advance,
    guest,
    newHarness,
    rejection,
    snap,
    tx,
    type Actor,
    type Ctx,
    type Harness,
} from '../fixtures/harness';
import { addSecondIdentity, admin, fireDeletionJob, providerOf, verified } from '../fixtures/identity';
import { seedReferenceNames } from '../fixtures/roster';
import { makeGhost, view } from '../fixtures/views';

const CHARS = ['acheron', 'kafka', 'aglaea', 'firefly'];
const CONES = ['patience', 'whereaboutsshouldyouwish'];
const SETTINGS = 'as-c-0-3000-1500';
/** A canonical packed team (version 1): slots joined by '.', then the settings. */
const code = (slots: [string, string, string, string], settings = SETTINGS) => `1.${slots.join('.')}.${settings}`;
const TEAM = code(['firefly-0-whereaboutsshouldyouwish-1', 'kafka-6', '_', '_']);
const TEAM2 = code(['acheron-2-patience-5-250', '_', '_', '_'], 'moc-a-7-4000-2000');
const ghost = makeGhost('s14-3s-ghost-', 29_000n);

type Row = { slot: number; rev: number; name: string; note: string; code: string };
type SaveArgs = { slot: number; baseRev: number; name: string; note: string; code: string };

function world() {
    const test = newHarness();
    seedReferenceNames(test, CHARS, CONES);
    const a = verified(test, 'loadouta');
    return { test, a };
}

const rows = (test: Harness, who: Actor) => [...test.db.UserLoadout.user_id.filter(who.userId)];
const allRows = (test: Harness) => [...test.db.UserLoadout.iter()];
const args = (o: Partial<SaveArgs> = {}): SaveArgs => ({ slot: 0, baseRev: 0, name: 'Firefly Hyper', note: '', code: TEAM, ...o });
const saveBody = (o: Partial<SaveArgs> = {}) => (ctx: Ctx) => M.save_loadout(ctx, args(o));
const deleteBody = (slot: number, baseRev: number) => (ctx: Ctx) => M.delete_loadout(ctx, { slot, baseRev });
/** The current version of the caller's loadout in `slot` (0 when the slot is empty: a delete with it is a no-op). */
const revOf = (test: Harness, who: Actor, slot: number) => rows(test, who).find((r) => r.slot === slot)?.rev ?? 0;

const rateRow = (test: Harness, who: Actor) => test.db.UserLoadoutRate.userId.find(who.userId) ?? undefined;
const allRateRows = (test: Harness) => [...test.db.UserLoadoutRate.iter()];
const membershipCount = (test: Harness, who: Actor) => test.db.UserRateState.userId.find(who.userId)?.membershipCount;

/** One accepted save; the clock moves 10 s first so a long test stays inside the save limit (6 per 60 s). */
function save(test: Harness, who: Actor, o: Partial<SaveArgs> = {}) {
    advance(test, 10_000);
    tx(test, who, saveBody(o));
}

/** Fills the caller's save window: a fresh window, then six accepted saves at the same instant (slots 0 to 5, new). */
function fillWindow(test: Harness, who: Actor) {
    advance(test, LOADOUT_SAVE_WINDOW_MS);
    for (let slot = 0; slot < LOADOUT_SAVES_PER_WINDOW; slot++) tx(test, who, saveBody({ slot, name: `T${slot}` }));
}

/** Twenty roster writes at the current instant: one account created, then nineteen updates (the membership cap). */
function twentyRosterWrites(test: Harness, who: Actor) {
    tx(test, who, (ctx) => M.create_hsr_account(ctx, { uid: '800000001', displayLabel: 'Main' }));
    const hsrAccountId = [...test.db.HsrAccount.user_id.filter(who.userId)][0].id;
    for (let i = 0; i < MEMBERSHIP_CHANGES_PER_WINDOW - 1; i++) {
        tx(test, who, (ctx) => M.update_hsr_account(ctx, { hsrAccountId, displayLabel: `Main ${i}`, isRosterPublic: false, isRatingPublic: false }));
    }
}

/** Refused save: the state is unchanged and the message is returned (checked last). */
function refusedSave(test: Harness, who: Actor, o: Partial<SaveArgs>): string {
    advance(test, 600);
    const before = snap(allRows(test));
    const msg = rejection(test, who, saveBody(o));
    expect(snap(allRows(test))).toBe(before);
    return msg;
}

/** server_nuke_test_data reads ctx.env.STDB_TARGET; the harness has no module env, so the test database is simulated. */
function onTestDatabase(ctx: Ctx): Ctx {
    return new Proxy(ctx as object, {
        get(target, prop) {
            if (prop === 'env') return { STDB_TARGET: 'test' };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as Ctx;
}

// ─── Saving ──────────────────────────────────────────────────────────────────

describe('save_loadout', () => {
    it('1. scenario "Save a new loadout": one row with the trimmed name, the note and the code; the view returns it', () => {
        const { test, a } = world();
        save(test, a, { name: '  Firefly Hyper ', note: 'Break team', code: TEAM });
        const stored = rows(test, a);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ userId: a.userId, slot: 0, name: 'Firefly Hyper', note: 'Break team', code: TEAM });
        expect(stored[0].createdById).toBe(a.userId);
        expect(view<Row>(test, 'view_my_loadouts', a)).toEqual([{ slot: 0, rev: 1, name: 'Firefly Hyper', note: 'Break team', code: TEAM }]);
    });

    it('2. scenario "Update in place": a save based on the current version of slot 0 changes the row; still one row, created audit kept', () => {
        const { test, a } = world();
        save(test, a);
        const first = rows(test, a)[0];
        save(test, a, { baseRev: first.rev, name: 'Acheron', note: 'new note', code: TEAM2 });
        const stored = rows(test, a);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ id: first.id, slot: 0, rev: first.rev + 1, name: 'Acheron', note: 'new note', code: TEAM2 });
        expect(stored[0].createdDate).toEqual(first.createdDate);
        expect(stored[0].lastModifiedDate.microsSinceUnixEpoch).toBeGreaterThan(first.lastModifiedDate.microsSinceUnixEpoch);
    });

    it('3. scenario "Ten slots" / "Out of range": slots 0 to 9 save; slot 10 is refused with the slot text', () => {
        const { test, a } = world();
        for (let slot = 0; slot < 10; slot++) save(test, a, { slot, name: `Team ${slot + 1}` });
        expect(rows(test, a).map((r) => r.slot).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        for (const slot of [10, 255]) expect(refusedSave(test, a, { slot })).toBe(LOADOUT_SLOT_TEXT);
        expect(LOADOUT_SLOT_TEXT).toBe('Loadout slot must be between 1 and 10.');
        expect(view<Row>(test, 'view_my_loadouts', a)).toHaveLength(10);
    });

    it('4. scenario "Slot taken": a create (base 0) on a taken slot is refused; the row is unchanged', () => {
        const { test, a } = world();
        save(test, a, { slot: 3 });
        expect(refusedSave(test, a, { slot: 3, name: 'Other', code: TEAM2 })).toBe(LOADOUT_SLOT_TAKEN_TEXT);
        expect(rows(test, a)).toHaveLength(1);
        expect(rows(test, a)[0]).toMatchObject({ name: 'Firefly Hyper', code: TEAM });
        expect(LOADOUT_SLOT_TAKEN_TEXT).toBe('That loadout slot is already in use. Your list was refreshed; save again.');
    });

    it('5. scenario "Loadout gone": an update (base above 0) on an empty slot is refused; nothing is written', () => {
        const { test, a } = world();
        expect(refusedSave(test, a, { slot: 4, baseRev: 1 })).toBe(LOADOUT_GONE_TEXT);
        expect(rows(test, a)).toHaveLength(0);
        // S14.3c-rev (A198 item 3): was 'That loadout no longer exists.'
        expect(LOADOUT_GONE_TEXT).toBe('That loadout was deleted on another device.');
    });

    it('6. scenario "Guest": a guest\'s save and delete are refused with the loadout text, not the roster text; no row', () => {
        const { test } = world();
        const g = guest(test, 'loadoutguest');
        expect(refusedSave(test, g, {})).toBe(LOADOUT_VERIFIED_TEXT);
        expect(rejection(test, g, deleteBody(0, 0))).toBe(LOADOUT_VERIFIED_TEXT);
        expect(allRows(test)).toHaveLength(0);
        expect(LOADOUT_VERIFIED_TEXT).toBe(
            'Saving loadouts to your account needs a Discord-linked account. Your loadouts stay in this browser.');
        // The roster reducers keep their own text (ensureVerifiedUser's default).
        expect(rejection(test, g, (ctx) => M.create_hsr_account(ctx, { uid: '800000001', displayLabel: '' })))
            .toBe('Roster management requires a verified account. Link your Discord first.');
    });

    it('7. scenario "Unknown identity": an identity with no user is refused "Unauthorized: No user linked to this identity."', () => {
        const { test } = world();
        const auth = ghost();
        expect(() => test.withReducerTx(auth, saveBody())).toThrow('Unauthorized: No user linked to this identity.');
        expect(() => test.withReducerTx(auth, deleteBody(0, 0))).toThrow('Unauthorized: No user linked to this identity.');
        expect(allRows(test)).toHaveLength(0);
    });

    it('8. scenario "Name rules": 40 characters pass, 41 are refused; a blank name is refused; duplicate names are allowed', () => {
        const { test, a } = world();
        save(test, a, { slot: 0, name: 'x'.repeat(40) });
        save(test, a, { slot: 1, name: `  ${'y'.repeat(40)}  ` }); // trimmed first
        expect(rows(test, a).find((r) => r.slot === 1)!.name).toBe('y'.repeat(40));
        expect(refusedSave(test, a, { slot: 2, name: 'z'.repeat(41) })).toBe(LOADOUT_NAME_TEXT);
        expect(refusedSave(test, a, { slot: 2, name: '   ' })).toBe(LOADOUT_NAME_EMPTY_TEXT);
        expect(refusedSave(test, a, { slot: 2, name: '' })).toBe(LOADOUT_NAME_EMPTY_TEXT);
        save(test, a, { slot: 2, name: 'x'.repeat(40) }); // the same name as slot 0
        expect(rows(test, a)).toHaveLength(3);
        expect(LOADOUT_NAME_TEXT).toBe('Loadout name cannot exceed 40 characters.');
        expect(LOADOUT_NAME_EMPTY_TEXT).toBe('Loadout name cannot be empty.');
    });

    it('9. scenario "Note cap": 1,000 characters pass, 1,001 are refused', () => {
        const { test, a } = world();
        save(test, a, { slot: 0, note: 'n'.repeat(1000) });
        expect(rows(test, a)[0].note).toHaveLength(1000);
        expect(refusedSave(test, a, { slot: 1, note: 'n'.repeat(1001) })).toBe(LOADOUT_NOTE_TEXT);
        expect(LOADOUT_NOTE_TEXT).toBe('Loadout note cannot exceed 1000 characters.');
    });

    it('10. scenario "Code checks": over 400, unreadable, levels out of range and a character twice are refused; empty slots pass', () => {
        const { test, a } = world();
        const tooLong = code(['firefly-0', '_', '_', '_']) + 'x'.repeat(400);
        expect(refusedSave(test, a, { code: tooLong })).toBe(LOADOUT_CODE_TEXT);
        for (const bad of [
            '',
            'not a team',
            '2.firefly-0._._._.as-c-0-3000-1500', // unknown version
            code(['firefly-7', '_', '_', '_']), // eidolon 7
            code(['firefly-0-patience-0', '_', '_', '_']), // superimposition 0
            code(['firefly-0-patience-6', '_', '_', '_']), // superimposition 6
            code(['firefly-0', '_', '_', '_'], 'xx-c-0-3000-1500'), // unknown game mode
            '1.firefly-0._._.as-c-0-3000-1500', // three slots
        ]) {
            expect(refusedSave(test, a, { code: bad }), bad).toBe(LOADOUT_CODE_TEXT);
        }
        expect(refusedSave(test, a, { code: code(['firefly-0', 'kafka-0', 'firefly-6', '_']) })).toBe(LOADOUT_DUPLICATE_TEXT);
        expect(LOADOUT_CODE_TEXT).toBe('This team could not be read. Reload the page and try again.');
        expect(LOADOUT_DUPLICATE_TEXT).toBe('A team cannot hold the same character twice.');
        // An all-empty team is a valid loadout.
        save(test, a, { code: code(['_', '_', '_', '_']) });
        expect(rows(test, a)).toHaveLength(1);
    });

    it('10b. scenario "Unknown character" / "Unknown light cone": a name the reference tables lack is refused at save, nothing written', () => {
        const { test, a } = world();
        expect(refusedSave(test, a, { code: code(['nobody-0', '_', '_', '_']) })).toBe('Unknown character "nobody".');
        expect(refusedSave(test, a, { code: code(['firefly-0-nocone-1', '_', '_', '_']) })).toBe('Unknown light cone "nocone".');
        // EMPTY and SKIP are module sentinels, never team names (the grammar is lower case only).
        expect(refusedSave(test, a, { code: code(['EMPTY-0', '_', '_', '_']) })).toBe(LOADOUT_CODE_TEXT);
        expect(allRows(test)).toHaveLength(0);
    });

    it('10c. canonical text: only the one text a team encodes to is stored; other spellings of the same team are refused', () => {
        const { test, a } = world();
        save(test, a, { slot: 0, code: TEAM2 });
        expect(rows(test, a)[0].code).toBe(TEAM2);
        for (const variant of [
            code(['acheron-2-patience-5-0250', '_', '_', '_'], 'moc-a-7-4000-2000'), // leading zero in the bid
            code(['acheron-2-patience-5-0', '_', '_', '_'], 'moc-a-7-4000-2000'), // a zero bid written out
            code(['acheron-2-patience-5-250', '_', '_', '_'], 'moc-a-07-4000-2000'), // leading zero in the set id
            code(['acheron-2-patience-5-250', '_', '_', '_'], 'moc-a-7-04000-2000'), // leading zero in a budget
            code(['Acheron-2-patience-5-250', '_', '_', '_'], 'moc-a-7-4000-2000'), // upper case
            ` ${TEAM2}`, // surrounding space
        ]) {
            expect(refusedSave(test, a, { slot: 1, code: variant }), variant).toBe(LOADOUT_CODE_TEXT);
        }
        expect(rows(test, a)).toHaveLength(1);
    });

    it('11. scenario "All or nothing": a bad fourth slot leaves no partial write, also on an update', () => {
        const { test, a } = world();
        save(test, a, { slot: 0 });
        const bad = code(['acheron-0', 'kafka-0', 'aglaea-0', 'nobody-0']);
        expect(refusedSave(test, a, { slot: 0, baseRev: 1, name: 'Changed', note: 'changed', code: bad })).toBe('Unknown character "nobody".');
        expect(rows(test, a)[0]).toMatchObject({ name: 'Firefly Hyper', note: '', code: TEAM });
        expect(refusedSave(test, a, { slot: 1, code: bad })).toBe('Unknown character "nobody".');
        expect(rows(test, a)).toHaveLength(1);
    });
});

// ─── Deleting ────────────────────────────────────────────────────────────────

describe('delete_loadout', () => {
    it('12. scenario "Delete" / "Delete twice": the row goes; deleting an empty slot is a no-op; slot 10 is refused', () => {
        const { test, a } = world();
        save(test, a, { slot: 2 });
        save(test, a, { slot: 5 });
        const seen = revOf(test, a, 2);
        tx(test, a, deleteBody(2, seen));
        expect(rows(test, a).map((r) => r.slot)).toEqual([5]);
        tx(test, a, deleteBody(2, seen)); // no error, no change
        expect(rows(test, a).map((r) => r.slot)).toEqual([5]);
        expect(rejection(test, a, deleteBody(10, 1))).toBe(LOADOUT_SLOT_TEXT);
        // The freed slot takes a new loadout (the page's undo is a new save on the same slot).
        save(test, a, { slot: 2, name: 'Again' });
        expect(rows(test, a)).toHaveLength(2);
    });
});

// ─── Ownership and the view ──────────────────────────────────────────────────

describe('view_my_loadouts and ownership', () => {
    it('13. scenario "Other members": B never sees A\'s rows; B\'s saves and deletes reach only B\'s own slots', () => {
        const { test, a } = world();
        const b = verified(test, 'loadoutb');
        save(test, a, { slot: 0, name: 'A zero' });
        save(test, a, { slot: 1, name: 'A one' });
        save(test, b, { slot: 0, name: 'B zero', code: TEAM2 });
        expect(view<Row>(test, 'view_my_loadouts', b)).toEqual([{ slot: 0, rev: 1, name: 'B zero', note: '', code: TEAM2 }]);
        // B "updating" slot 1 (A's slot 1 is at version 2) finds no loadout of B's own; B deleting slot 0 removes B's row only.
        expect(revOf(test, a, 1)).toBe(2);
        expect(refusedSave(test, b, { slot: 1, baseRev: 2 })).toBe(LOADOUT_GONE_TEXT);
        tx(test, b, deleteBody(0, 1));
        expect(rows(test, b)).toHaveLength(0);
        expect(rows(test, a).map((r) => r.name).sort()).toEqual(['A one', 'A zero']);
        expect(view<Row>(test, 'view_my_loadouts', a)).toHaveLength(2);
    });

    it('view: only slot, version, name, note and code reach the client; a guest and an identity with no user get no rows', () => {
        const { test, a } = world();
        save(test, a, { slot: 7, note: 'n' });
        const [row] = view<Row>(test, 'view_my_loadouts', a);
        expect(Object.keys(row).sort()).toEqual(['code', 'name', 'note', 'rev', 'slot']); // S14.3c-rev: + rev (no firstRev)
        const g = guest(test, 'viewguest');
        expect(view<Row>(test, 'view_my_loadouts', g)).toEqual([]);
        expect(view<Row>(test, 'view_my_loadouts', ghost())).toEqual([]);
    });
});

// ─── Save limit (T-S14.3s-limit) ─────────────────────────────────────────────

describe('save limit (S14.3s-limit, A194 item 6)', () => {
    it('L1. scenario "Too many saves": six saves (new and updates) pass, the seventh is refused with the loadout text and writes nothing', () => {
        const { test, a } = world();
        advance(test, LOADOUT_SAVE_WINDOW_MS);
        for (let slot = 0; slot < 3; slot++) tx(test, a, saveBody({ slot, name: `New ${slot}` }));
        for (let i = 0; i < 3; i++) tx(test, a, saveBody({ slot: 0, baseRev: revOf(test, a, 0), name: `Update ${i}` }));
        expect(rateRow(test, a)).toMatchObject({ saveCount: LOADOUT_SAVES_PER_WINDOW });
        const before = snap(allRows(test), allRateRows(test));
        expect(rejection(test, a, saveBody({ slot: 5, name: 'Seventh new' }))).toBe(LOADOUT_TOO_FAST_TEXT);
        expect(rejection(test, a, saveBody({ slot: 0, baseRev: revOf(test, a, 0), name: 'Seventh update' }))).toBe(LOADOUT_TOO_FAST_TEXT);
        expect(snap(allRows(test), allRateRows(test))).toBe(before);
        expect(rows(test, a).find((r) => r.slot === 0)!.name).toBe('Update 2');
        expect(LOADOUT_SAVES_PER_WINDOW).toBe(6);
        expect(LOADOUT_SAVE_WINDOW_MS).toBe(60_000);
        expect(LOADOUT_TOO_FAST_TEXT).toBe(
            'Your loadout was not saved yet: too many saves in a short time. It will be saved in a moment.');
    });

    it('L2. scenario "Too many saves": the window reopens 60 s after it opened; the save then counts as the first of a new window', () => {
        const { test, a } = world();
        fillWindow(test, a);
        const opened = rateRow(test, a)!.windowStart.microsSinceUnixEpoch;
        advance(test, LOADOUT_SAVE_WINDOW_MS - 1);
        expect(rejection(test, a, saveBody({ slot: 6 }))).toBe(LOADOUT_TOO_FAST_TEXT);
        advance(test, 1);
        tx(test, a, saveBody({ slot: 6 }));
        const row = rateRow(test, a)!;
        expect(row.saveCount).toBe(1);
        expect(row.windowStart.microsSinceUnixEpoch).toBe(opened + BigInt(LOADOUT_SAVE_WINDOW_MS) * 1000n);
        expect(rows(test, a)).toHaveLength(7);
    });

    it('L3. scenario "Too many saves": two accounts have separate limits', () => {
        const { test, a } = world();
        const b = verified(test, 'loadoutlimitb');
        fillWindow(test, a);
        expect(rejection(test, a, saveBody({ slot: 6 }))).toBe(LOADOUT_TOO_FAST_TEXT);
        for (let slot = 0; slot < LOADOUT_SAVES_PER_WINDOW; slot++) tx(test, b, saveBody({ slot }));
        expect(rows(test, b)).toHaveLength(6);
        expect(rateRow(test, a)!.saveCount).toBe(6);
        expect(rateRow(test, b)!.saveCount).toBe(6);
        expect(rejection(test, b, saveBody({ slot: 6 }))).toBe(LOADOUT_TOO_FAST_TEXT);
    });

    it('L4. scenario "Separate from the lobby and roster allowance": saves do not count on the membership allowance', () => {
        const { test, a } = world();
        advance(test, 10_000); // a fresh membership window (the sign-in may have used some of it)
        const membershipBefore = membershipCount(test, a);
        fillWindow(test, a); // moves the clock 60 s: a fresh membership window too
        expect(membershipCount(test, a)).toBe(membershipBefore);
        // All twenty roster writes still fit in the membership window the six saves fell in.
        twentyRosterWrites(test, a);
        expect(membershipCount(test, a)).toBe(MEMBERSHIP_CHANGES_PER_WINDOW);
    });

    it('L4b. scenario "Separate from the lobby and roster allowance": a full membership window leaves the six saves untouched', () => {
        const { test, a } = world();
        advance(test, LOADOUT_SAVE_WINDOW_MS);
        twentyRosterWrites(test, a);
        expect(rateRow(test, a)).toBeUndefined();
        for (let slot = 0; slot < LOADOUT_SAVES_PER_WINDOW; slot++) tx(test, a, saveBody({ slot }));
        expect(rows(test, a)).toHaveLength(6);
        expect(rejection(test, a, saveBody({ slot: 6 }))).toBe(LOADOUT_TOO_FAST_TEXT);
        // The roster write is refused by its own allowance, with its own text.
        expect(rejection(test, a, (ctx) => M.create_hsr_account(ctx, { uid: '800000002', displayLabel: 'Alt' })))
            .toBe(MEMBERSHIP_ACTION_TEXT);
    });

    it('L5. scenario "Delete has no rate limit": deletes count on nothing, pass at the save limit, and a no-op delete writes nothing', () => {
        const { test, a } = world();
        advance(test, 10_000);
        fillWindow(test, a);
        const membershipBefore = membershipCount(test, a);
        const rateBefore = snap(allRateRows(test));
        // More deletes than either allowance holds, at one instant: real ones first, then no-ops.
        // S14.3c-rev: each delete states the version it saw (0 once the slot is empty).
        for (let i = 0; i < MEMBERSHIP_CHANGES_PER_WINDOW + 5; i++) tx(test, a, deleteBody(i % 10, revOf(test, a, i % 10)));
        expect(rows(test, a)).toHaveLength(0);
        expect(snap(allRateRows(test))).toBe(rateBefore);
        expect(membershipCount(test, a)).toBe(membershipBefore);
        // A save, delete, save loop is held by its saves: the freed slot cannot be refilled in this window.
        expect(rejection(test, a, saveBody({ slot: 0 }))).toBe(LOADOUT_TOO_FAST_TEXT);
        // Slot range still checked.
        expect(rejection(test, a, deleteBody(10, 0))).toBe(LOADOUT_SLOT_TEXT);
    });

    it('L6. scenario "Too many saves": a save refused for another reason does not count', () => {
        const { test, a } = world();
        advance(test, LOADOUT_SAVE_WINDOW_MS);
        tx(test, a, saveBody({ slot: 0 }));
        expect(rejection(test, a, saveBody({ slot: 0 }))).toBe(LOADOUT_SLOT_TAKEN_TEXT);
        expect(rejection(test, a, saveBody({ slot: 1, name: '' }))).toBe(LOADOUT_NAME_EMPTY_TEXT);
        expect(rateRow(test, a)!.saveCount).toBe(1);
    });

    // T-S14.3s-limit2: the review's should-fix S1 and minor M2, M3.

    it('L7. scenario "Too many saves": with a full window, a save wrong for another reason gets its own text, never the too-fast text (the limit is the last check)', () => {
        const { test, a } = world();
        fillWindow(test, a);
        const before = snap(allRows(test), allRateRows(test));
        const taken = rejection(test, a, saveBody({ slot: 0, name: 'Taken' }));
        const gone = rejection(test, a, saveBody({ slot: 6, baseRev: 1 }));
        const blank = rejection(test, a, saveBody({ slot: 6, name: '   ' }));
        expect(snap(allRows(test), allRateRows(test))).toBe(before);
        // A save that is right in every other way meets the limit.
        expect(rejection(test, a, saveBody({ slot: 6 }))).toBe(LOADOUT_TOO_FAST_TEXT);
        expect(taken).toBe(LOADOUT_SLOT_TAKEN_TEXT);
        expect(gone).toBe(LOADOUT_GONE_TEXT);
        expect(blank).toBe(LOADOUT_NAME_EMPTY_TEXT);
    });

    it('L8. scenario "Too many saves": a save refused as too fast leaves the save window row unchanged', () => {
        const { test, a } = world();
        fillWindow(test, a);
        const rateBefore = snap(allRateRows(test));
        const row = rateRow(test, a)!;
        advance(test, 1_000);
        expect(rejection(test, a, saveBody({ slot: 6 }))).toBe(LOADOUT_TOO_FAST_TEXT);
        expect(snap(allRateRows(test))).toBe(rateBefore);
        expect(rateRow(test, a)).toMatchObject({ saveCount: LOADOUT_SAVES_PER_WINDOW, windowStart: row.windowStart });
    });

    it('L9. scenario "Guest": a guest\'s refused save creates no save window row', () => {
        const { test } = world();
        const g = guest(test, 'loadoutlimitguest');
        expect(refusedSave(test, g, {})).toBe(LOADOUT_VERIFIED_TEXT);
        expect(rateRow(test, g)).toBeUndefined();
        expect(allRateRows(test)).toHaveLength(0);
    });

    it('L10. scenario "Too many saves": two identities of one account share one window', () => {
        const { test, a } = world();
        const extra = addSecondIdentity(test, a.userId, 'loadoutlimit-second-device');
        const second: Actor = { sub: 'loadoutlimit-second-device', auth: extra.auth, identity: extra.identity, userId: a.userId };
        advance(test, LOADOUT_SAVE_WINDOW_MS);
        for (let slot = 0; slot < LOADOUT_SAVES_PER_WINDOW; slot++) {
            tx(test, slot % 2 === 0 ? a : second, saveBody({ slot, name: `T${slot}` }));
        }
        expect(allRateRows(test)).toHaveLength(1);
        expect(rateRow(test, a)!.saveCount).toBe(LOADOUT_SAVES_PER_WINDOW);
        expect(rejection(test, second, saveBody({ slot: 6 }))).toBe(LOADOUT_TOO_FAST_TEXT);
        expect(rejection(test, a, saveBody({ slot: 6 }))).toBe(LOADOUT_TOO_FAST_TEXT);
        expect(rows(test, a)).toHaveLength(LOADOUT_SAVES_PER_WINDOW);
    });
});

// ─── Versions (T-S14.3c-rev, A198) ───────────────────────────────────────────

describe('versions (S14.3c-rev, A198)', () => {
    /** A second identity of the same account: another device. */
    function secondDevice(test: Harness, a: Actor, sub = 'loadoutrev-second-device'): Actor {
        const extra = addSecondIdentity(test, a.userId, sub);
        return { sub, auth: extra.auth, identity: extra.identity, userId: a.userId };
    }

    it('V1. scenario "Versions": the first loadout starts at 1, every save raises it by exactly 1, the view sends it', () => {
        const { test, a } = world();
        save(test, a, { slot: 0 });
        expect(revOf(test, a, 0)).toBe(1);
        expect(rows(test, a)[0].firstRev).toBe(1);
        for (const [i, base] of [1, 2, 3].entries()) {
            save(test, a, { slot: 0, baseRev: base, name: `Edit ${i}` });
            expect(revOf(test, a, 0)).toBe(base + 1);
        }
        expect(rows(test, a)[0].firstRev).toBe(1); // kept through updates
        expect(view<Row>(test, 'view_my_loadouts', a)).toEqual([{ slot: 0, rev: 4, name: 'Edit 2', note: '', code: TEAM }]);
        expect(rateRow(test, a)!.revFloor).toBe(4);
    });

    it('V2. scenario "Versions": a later new loadout starts one above the highest version the account was given; other accounts count apart', () => {
        const { test, a } = world();
        const b = verified(test, 'loadoutrevb');
        save(test, a, { slot: 0 });
        save(test, a, { slot: 0, baseRev: 1, name: 'Edit' }); // slot 0 at 2
        save(test, a, { slot: 3 });
        expect(revOf(test, a, 3)).toBe(3);
        expect(rows(test, a).find((r) => r.slot === 3)!.firstRev).toBe(3);
        save(test, b, { slot: 3 });
        expect(revOf(test, b, 3)).toBe(1);
    });

    it('V3. scenario "Changed on another device": a save based on an older version is refused with the conflict text and writes nothing', () => {
        const { test, a } = world();
        save(test, a);
        save(test, a, { baseRev: 1, name: 'Second' }); // now 2
        advance(test, 600);
        const before = snap(allRows(test), allRateRows(test));
        expect(rejection(test, a, saveBody({ baseRev: 1, name: 'Stale' }))).toBe(LOADOUT_CONFLICT_TEXT);
        // A base the server never gave (above the current version) is a conflict too.
        expect(rejection(test, a, saveBody({ baseRev: 9, name: 'Future' }))).toBe(LOADOUT_CONFLICT_TEXT);
        expect(snap(allRows(test), allRateRows(test))).toBe(before);
        expect(rows(test, a)[0]).toMatchObject({ rev: 2, name: 'Second' });
        expect(LOADOUT_CONFLICT_TEXT).toBe('That loadout was changed on another device.');
    });

    it('V4. scenario "Deleted on another device": a save based on a version of a loadout whose slot is now empty is refused with the deleted text', () => {
        const { test, a } = world();
        save(test, a, { slot: 2 });
        save(test, a, { slot: 2, baseRev: 1, name: 'Edited' }); // 2
        tx(test, a, deleteBody(2, 2));
        expect(refusedSave(test, a, { slot: 2, baseRev: 2, name: 'Unsent edit' })).toBe(LOADOUT_GONE_TEXT);
        expect(refusedSave(test, a, { slot: 8, baseRev: 1 })).toBe(LOADOUT_GONE_TEXT); // never used
        expect(rows(test, a)).toHaveLength(0);
        // "Save as a new loadout": a create in that slot passes.
        save(test, a, { slot: 2, baseRev: 0, name: 'Unsent edit' });
        expect(rows(test, a)).toHaveLength(1);
    });

    it('V5. scenario "Slot taken": a create on a taken slot is refused and the row keeps its version', () => {
        const { test, a } = world();
        save(test, a, { slot: 1 });
        save(test, a, { slot: 1, baseRev: 1, name: 'Edited' });
        expect(refusedSave(test, a, { slot: 1, baseRev: 0, name: 'Other' })).toBe(LOADOUT_SLOT_TAKEN_TEXT);
        expect(rows(test, a)[0]).toMatchObject({ rev: 2, name: 'Edited' });
    });

    it('V6. scenario "Two devices": both read version 2 and save; one wins, the other is refused; its retry on the new version wins', () => {
        const { test, a } = world();
        const phone = secondDevice(test, a);
        save(test, a);
        save(test, a, { baseRev: 1, name: 'Read by both' }); // 2
        const seen = view<Row>(test, 'view_my_loadouts', phone)[0].rev;
        expect(seen).toBe(2);
        advance(test, 1_000);
        tx(test, a, saveBody({ baseRev: seen, name: 'Laptop' }));
        expect(rejection(test, phone, saveBody({ baseRev: seen, name: 'Phone' }))).toBe(LOADOUT_CONFLICT_TEXT);
        expect(rows(test, a)[0]).toMatchObject({ rev: 3, name: 'Laptop' });
        // "Keep my changes": the phone resends on the version it now sees.
        const fresh = view<Row>(test, 'view_my_loadouts', phone)[0].rev;
        tx(test, phone, saveBody({ baseRev: fresh, name: 'Phone' }));
        expect(rows(test, a)[0]).toMatchObject({ rev: 4, name: 'Phone' });
        expect(rows(test, a)).toHaveLength(1);
    });

    it('V7. scenario "Slot reused": a page holding version 3 of a deleted loadout never matches the new loadout in that slot', () => {
        const { test, a } = world();
        const phone = secondDevice(test, a);
        save(test, a, { slot: 0, name: 'Old' });
        save(test, a, { slot: 0, baseRev: 1, name: 'Old', note: 'v2' });
        save(test, a, { slot: 0, baseRev: 2, name: 'Old', note: 'v3' });
        const oldPage = revOf(test, a, 0);
        expect(oldPage).toBe(3);
        // The phone deletes it and creates a different loadout in the same slot, then saves it a few times.
        tx(test, phone, deleteBody(0, 3));
        save(test, phone, { slot: 0, name: 'Fresh idea' });
        const fresh = rows(test, a)[0];
        expect(fresh.rev).toBeGreaterThan(oldPage);
        expect(fresh.firstRev).toBe(fresh.rev);
        for (let i = 0; i < 4; i++) save(test, phone, { slot: 0, baseRev: revOf(test, a, 0), name: 'Fresh idea', note: `fresh ${i}` });
        expect(revOf(test, a, 0)).not.toBe(oldPage);
        // The old page's save is told the loadout it held was deleted; its delete is a no-op that keeps "Fresh idea".
        expect(refusedSave(test, a, { slot: 0, baseRev: oldPage, name: 'Old', note: 'unsent' })).toBe(LOADOUT_GONE_TEXT);
        const before = snap(allRows(test), allRateRows(test));
        tx(test, a, deleteBody(0, oldPage));
        expect(snap(allRows(test), allRateRows(test))).toBe(before);
        expect(rows(test, a)[0]).toMatchObject({ name: 'Fresh idea', note: 'fresh 3' });
    });

    it('V8. scenario "Versions": version refusals do not count on the save limit and leave the rate row untouched, also with a full window', () => {
        const { test, a } = world();
        fillWindow(test, a); // slots 0 to 5, versions 1 to 6
        const before = snap(allRows(test), allRateRows(test));
        expect(rejection(test, a, saveBody({ slot: 0, baseRev: 9, name: 'Stale' }))).toBe(LOADOUT_CONFLICT_TEXT);
        expect(rejection(test, a, saveBody({ slot: 7, baseRev: 2 }))).toBe(LOADOUT_GONE_TEXT);
        expect(rejection(test, a, saveBody({ slot: 1, baseRev: 0 }))).toBe(LOADOUT_SLOT_TAKEN_TEXT);
        expect(rejection(test, a, deleteBody(0, 9))).toBe(LOADOUT_CONFLICT_TEXT);
        expect(snap(allRows(test), allRateRows(test))).toBe(before);
        // A fresh window: the refusals left all six saves.
        advance(test, LOADOUT_SAVE_WINDOW_MS);
        tx(test, a, saveBody({ slot: 0, baseRev: 1, name: 'After' }));
        expect(rateRow(test, a)!.saveCount).toBe(1);
    });

    it('V9. check order: a stale base is reported as a conflict before a content error; on the current base the content error shows', () => {
        const { test, a } = world();
        save(test, a);
        save(test, a, { baseRev: 1, name: 'Second' });
        expect(refusedSave(test, a, { baseRev: 1, name: '   ' })).toBe(LOADOUT_CONFLICT_TEXT);
        expect(refusedSave(test, a, { baseRev: 2, name: '   ' })).toBe(LOADOUT_NAME_EMPTY_TEXT);
        expect(refusedSave(test, a, { slot: 4, baseRev: 1, code: 'not a team' })).toBe(LOADOUT_GONE_TEXT);
    });

    it('V10. scenario "Unchanged save": a save equal to the stored row writes nothing, keeps the version and passes with a full window', () => {
        const { test, a } = world();
        fillWindow(test, a);
        const before = snap(allRows(test), allRateRows(test));
        // Same name after trimming, same note and code, current version.
        tx(test, a, saveBody({ slot: 0, baseRev: 1, name: '  T0 ' }));
        expect(snap(allRows(test), allRateRows(test))).toBe(before);
        expect(revOf(test, a, 0)).toBe(1);
        // Any difference is a write, which here meets the full window.
        expect(rejection(test, a, saveBody({ slot: 0, baseRev: 1, name: 'T0', note: 'x' }))).toBe(LOADOUT_TOO_FAST_TEXT);
        // On a stale base the same content is still a conflict.
        advance(test, LOADOUT_SAVE_WINDOW_MS);
        tx(test, a, saveBody({ slot: 0, baseRev: 1, name: 'T0', note: 'x' }));
        expect(rejection(test, a, saveBody({ slot: 0, baseRev: 1, name: 'T0', note: 'x' }))).toBe(LOADOUT_CONFLICT_TEXT);
    });

    it('V11. scenario "Delete with a version": the current version deletes; an older one is refused and keeps the row; gone or base 0 is a no-op', () => {
        const { test, a } = world();
        const phone = secondDevice(test, a);
        save(test, a, { slot: 3 });
        save(test, phone, { slot: 3, baseRev: 1, name: 'Phone edit' }); // 2
        const rateBefore = snap(allRateRows(test));
        expect(rejection(test, a, deleteBody(3, 1))).toBe(LOADOUT_CONFLICT_TEXT);
        expect(rows(test, a)[0]).toMatchObject({ slot: 3, rev: 2, name: 'Phone edit' });
        const before = snap(allRows(test));
        tx(test, a, deleteBody(3, 0)); // a page that never saw it
        tx(test, a, deleteBody(6, 4)); // an empty slot
        expect(snap(allRows(test))).toBe(before);
        tx(test, a, deleteBody(3, 2));
        expect(rows(test, a)).toHaveLength(0);
        tx(test, a, deleteBody(3, 2)); // a second delete
        expect(snap(allRateRows(test))).toBe(rateBefore); // deletes never touch the rate row
    });

    it('V12. scenario "Version at its top": the u32 top refuses an update and a create instead of wrapping; nothing is written', () => {
        const { test, a } = world();
        save(test, a, { slot: 0 });
        const row = rows(test, a)[0];
        test.db.UserLoadout.id.update({ ...row, rev: LOADOUT_REV_MAX });
        expect(refusedSave(test, a, { slot: 0, baseRev: LOADOUT_REV_MAX, name: 'More' })).toBe(LOADOUT_REV_MAX_TEXT);
        test.db.UserLoadoutRate.userId.update({ ...rateRow(test, a)!, revFloor: LOADOUT_REV_MAX });
        const before = snap(allRateRows(test));
        expect(refusedSave(test, a, { slot: 1 })).toBe(LOADOUT_REV_MAX_TEXT);
        expect(snap(allRateRows(test))).toBe(before);
        expect(rows(test, a)).toHaveLength(1);
        expect(LOADOUT_REV_MAX).toBe(4_294_967_295);
        expect(LOADOUT_REV_MAX_TEXT).toBe('This loadout cannot be saved again. Save it as a new loadout.');
    });
});

// ─── Maintenance ─────────────────────────────────────────────────────────────

describe('maintenance', () => {
    it('15. scenario "Maintenance": a non-Admin is refused with the maintenance text; an Admin may save', () => {
        const { test, a } = world();
        const boss = admin(test, 'loadoutboss');
        tx(test, boss, (ctx) => M.admin_update_abuse_config(ctx, { maintenanceMode: true } as any));
        expect(refusedSave(test, a, {})).toBe(MAINTENANCE_TEXT);
        save(test, boss, { name: 'Admin team' });
        expect(rows(test, boss)).toHaveLength(1);
    });
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

describe('lifecycle', () => {
    function withLoadouts(test: Harness, who: Actor, n = 4) {
        for (let slot = 0; slot < n; slot++) save(test, who, { slot });
        expect(rows(test, who)).toHaveLength(n);
    }

    it('16. scenario "Account deleted": delete_my_account removes every loadout of the user; another user keeps theirs', () => {
        const { test, a } = world();
        const b = verified(test, 'loadoutkeep');
        withLoadouts(test, a);
        withLoadouts(test, b, 1);
        const userId = a.userId;
        expect(rateRow(test, a)).toBeDefined();
        tx(test, a, (ctx) => M.delete_my_account(ctx, {}));
        expect([...test.db.UserLoadout.user_id.filter(userId)]).toHaveLength(0);
        expect(rows(test, b)).toHaveLength(1);
        // S14.3s-limit: the save window goes with the account; the other user's stays.
        expect(test.db.UserLoadoutRate.userId.find(userId) ?? undefined).toBeUndefined();
        expect(rateRow(test, b)).toBeDefined();
    });

    it('16. scenario "Account deleted": server_delete_user removes every loadout of the user', () => {
        const { test, a } = world();
        withLoadouts(test, a);
        const username = test.db.User.id.find(a.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect([...test.db.UserLoadout.user_id.filter(a.userId)]).toHaveLength(0);
        expect(rateRow(test, a)).toBeUndefined(); // S14.3s-limit
    });

    it('16. scenario "Account deleted": a ban, through the scheduled run_user_deletion, removes every loadout of the user', () => {
        const { test, a } = world();
        const boss = admin(test, 'loadoutbanner');
        withLoadouts(test, a);
        const providerId = providerOf(test, a)!; // read outside the tx body (test.db inside one crashes the datastore)
        tx(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId, reason: 'abuse' }));
        expect(rows(test, a)).toHaveLength(4); // soft-deleted first; the rows go with the job
        expect(refusedSave(test, a, { slot: 9 })).toBe('Unauthorized: This account has been deleted.');
        fireDeletionJob(test, a.userId);
        expect([...test.db.UserLoadout.user_id.filter(a.userId)]).toHaveLength(0);
        expect(rateRow(test, a)).toBeUndefined(); // S14.3s-limit
    });

    it('17. scenario "Test wipe": server_nuke_test_data clears the table and the save windows', () => {
        const { test, a } = world();
        withLoadouts(test, a, 2);
        expect(allRateRows(test)).toHaveLength(1);
        tx(test, 'internal', (ctx) => M.server_nuke_test_data(onTestDatabase(ctx), { confirmation: 'NUKE_TEST_DATA' }));
        expect(allRows(test)).toHaveLength(0);
        expect(allRateRows(test)).toHaveLength(0);
    });

    it('18. scenario "Reference removed later": deleting a character through admin_delete_row leaves the loadout unchanged and readable', () => {
        const { test, a } = world();
        save(test, a, { code: TEAM });
        const boss = admin(test, 'loadoutref');
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'HsrCharacter', primaryKeyJson: 'kafka' }));
        expect(view<Row>(test, 'view_my_loadouts', a)).toEqual([{ slot: 0, rev: 1, name: 'Firefly Hyper', note: '', code: TEAM }]);
        // A new save of the same text is now refused (validation at save time keeps new junk out; the unchanged-save
        // no-op of S14.3c-rev comes after the content checks, so it does not let the stale text through either).
        expect(refusedSave(test, a, { slot: 0, baseRev: 1 })).toBe('Unknown character "kafka".');
    });
});
