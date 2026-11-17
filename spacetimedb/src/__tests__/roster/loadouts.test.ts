// Roster: team builder loadouts on the account (save_loadout, delete_loadout, view_my_loadouts).
// Decisions: A190 items 1, 3, 15
// Contracts: docs/loadout/contract.md
// From S14.3s.
//
// T-S14.3s: the design's 18 scenarios (tmp/teambuilder/loadout-backend.md § 7.1) adapted to what was built, plus the
// canonical-text rule, the unknown-name refusals, the guest text, the shared allowance, the deletion cascade and the
// view for owner, other member, guest and an identity with no user. Every `it` cites its scenario of
// docs/loadout/contract.md. In-memory datastore on the TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { MAINTENANCE_TEXT } from '@module/helpers/identity/ensurePermissions';
import { MEMBERSHIP_ACTION_TEXT } from '@module/helpers/lobby/abuseControls';
import {
    LOADOUT_CODE_TEXT,
    LOADOUT_DUPLICATE_TEXT,
    LOADOUT_GONE_TEXT,
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
import { admin, fireDeletionJob, providerOf, verified } from '../fixtures/identity';
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

type Row = { slot: number; name: string; note: string; code: string };
type SaveArgs = { slot: number; isNew: boolean; name: string; note: string; code: string };

function world() {
    const test = newHarness();
    seedReferenceNames(test, CHARS, CONES);
    const a = verified(test, 'loadouta');
    return { test, a };
}

const rows = (test: Harness, who: Actor) => [...test.db.UserLoadout.user_id.filter(who.userId)];
const allRows = (test: Harness) => [...test.db.UserLoadout.iter()];
const args = (o: Partial<SaveArgs> = {}): SaveArgs => ({ slot: 0, isNew: true, name: 'Firefly Hyper', note: '', code: TEAM, ...o });
const saveBody = (o: Partial<SaveArgs> = {}) => (ctx: Ctx) => M.save_loadout(ctx, args(o));
const deleteBody = (slot: number) => (ctx: Ctx) => M.delete_loadout(ctx, { slot });

/** One accepted save; the clock moves 600 ms first so a long test stays inside the shared allowance (20 per 10 s). */
function save(test: Harness, who: Actor, o: Partial<SaveArgs> = {}) {
    advance(test, 600);
    tx(test, who, saveBody(o));
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
        expect(view<Row>(test, 'view_my_loadouts', a)).toEqual([{ slot: 0, name: 'Firefly Hyper', note: 'Break team', code: TEAM }]);
    });

    it('2. scenario "Update in place": a save with isNew false on slot 0 changes the row; still one row, created audit kept', () => {
        const { test, a } = world();
        save(test, a);
        const first = rows(test, a)[0];
        save(test, a, { isNew: false, name: 'Acheron', note: 'new note', code: TEAM2 });
        const stored = rows(test, a);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ id: first.id, slot: 0, name: 'Acheron', note: 'new note', code: TEAM2 });
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

    it('4. scenario "Slot taken": isNew on a taken slot is refused; the row is unchanged', () => {
        const { test, a } = world();
        save(test, a, { slot: 3 });
        expect(refusedSave(test, a, { slot: 3, name: 'Other', code: TEAM2 })).toBe(LOADOUT_SLOT_TAKEN_TEXT);
        expect(rows(test, a)).toHaveLength(1);
        expect(rows(test, a)[0]).toMatchObject({ name: 'Firefly Hyper', code: TEAM });
        expect(LOADOUT_SLOT_TAKEN_TEXT).toBe('That loadout slot is already in use. Your list was refreshed; save again.');
    });

    it('5. scenario "Loadout gone": isNew false on an empty slot is refused; nothing is written', () => {
        const { test, a } = world();
        expect(refusedSave(test, a, { slot: 4, isNew: false })).toBe(LOADOUT_GONE_TEXT);
        expect(rows(test, a)).toHaveLength(0);
        expect(LOADOUT_GONE_TEXT).toBe('That loadout no longer exists.');
    });

    it('6. scenario "Guest": a guest\'s save and delete are refused with the loadout text, not the roster text; no row', () => {
        const { test } = world();
        const g = guest(test, 'loadoutguest');
        expect(refusedSave(test, g, {})).toBe(LOADOUT_VERIFIED_TEXT);
        expect(rejection(test, g, deleteBody(0))).toBe(LOADOUT_VERIFIED_TEXT);
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
        expect(() => test.withReducerTx(auth, deleteBody(0))).toThrow('Unauthorized: No user linked to this identity.');
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
        expect(refusedSave(test, a, { slot: 0, isNew: false, name: 'Changed', note: 'changed', code: bad })).toBe('Unknown character "nobody".');
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
        tx(test, a, deleteBody(2));
        expect(rows(test, a).map((r) => r.slot)).toEqual([5]);
        tx(test, a, deleteBody(2)); // no error, no change
        expect(rows(test, a).map((r) => r.slot)).toEqual([5]);
        expect(rejection(test, a, deleteBody(10))).toBe(LOADOUT_SLOT_TEXT);
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
        expect(view<Row>(test, 'view_my_loadouts', b)).toEqual([{ slot: 0, name: 'B zero', note: '', code: TEAM2 }]);
        // B "updating" slot 1 finds no loadout of B's own; B deleting slot 0 removes B's row only.
        expect(refusedSave(test, b, { slot: 1, isNew: false })).toBe(LOADOUT_GONE_TEXT);
        tx(test, b, deleteBody(0));
        expect(rows(test, b)).toHaveLength(0);
        expect(rows(test, a).map((r) => r.name).sort()).toEqual(['A one', 'A zero']);
        expect(view<Row>(test, 'view_my_loadouts', a)).toHaveLength(2);
    });

    it('view: only slot, name, note and code reach the client; a guest and an identity with no user get no rows', () => {
        const { test, a } = world();
        save(test, a, { slot: 7, note: 'n' });
        const [row] = view<Row>(test, 'view_my_loadouts', a);
        expect(Object.keys(row).sort()).toEqual(['code', 'name', 'note', 'slot']);
        const g = guest(test, 'viewguest');
        expect(view<Row>(test, 'view_my_loadouts', g)).toEqual([]);
        expect(view<Row>(test, 'view_my_loadouts', ghost())).toEqual([]);
    });
});

// ─── Allowance and maintenance ───────────────────────────────────────────────

describe('allowance and maintenance', () => {
    it('14. scenario "Too fast": the 21st write inside 10 s is refused with the shared text; nothing is written; then accepted again', () => {
        const { test, a } = world();
        advance(test, 10_000); // a fresh window (the sign-in may have used some of it)
        for (let i = 0; i < 20; i++) tx(test, a, saveBody({ slot: i % 10, isNew: i < 10, name: `T${i}` }));
        const before = snap(allRows(test));
        expect(rejection(test, a, saveBody({ slot: 0, isNew: false, name: 'late' }))).toBe(MEMBERSHIP_ACTION_TEXT);
        expect(rejection(test, a, deleteBody(0))).toBe(MEMBERSHIP_ACTION_TEXT);
        expect(snap(allRows(test))).toBe(before);
        advance(test, 10_000);
        tx(test, a, saveBody({ slot: 0, isNew: false, name: 'late' }));
        expect(rows(test, a).find((r) => r.slot === 0)!.name).toBe('late');
    });

    it('14b. the allowance is shared with the roster writes: 20 roster writes leave no room for a save', () => {
        const { test, a } = world();
        advance(test, 10_000);
        tx(test, a, (ctx) => M.create_hsr_account(ctx, { uid: '800000001', displayLabel: 'Main' }));
        const hsrAccountId = [...test.db.HsrAccount.user_id.filter(a.userId)][0].id;
        for (let i = 0; i < 19; i++) {
            tx(test, a, (ctx) => M.update_hsr_account(ctx, { hsrAccountId, displayLabel: `Main ${i}`, isRosterPublic: false, isRatingPublic: false }));
        }
        expect(rejection(test, a, saveBody())).toBe(MEMBERSHIP_ACTION_TEXT);
        expect(rows(test, a)).toHaveLength(0);
    });

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
        tx(test, a, (ctx) => M.delete_my_account(ctx, {}));
        expect([...test.db.UserLoadout.user_id.filter(userId)]).toHaveLength(0);
        expect(rows(test, b)).toHaveLength(1);
    });

    it('16. scenario "Account deleted": server_delete_user removes every loadout of the user', () => {
        const { test, a } = world();
        withLoadouts(test, a);
        const username = test.db.User.id.find(a.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect([...test.db.UserLoadout.user_id.filter(a.userId)]).toHaveLength(0);
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
    });

    it('17. scenario "Test wipe": server_nuke_test_data clears the table', () => {
        const { test, a } = world();
        withLoadouts(test, a, 2);
        tx(test, 'internal', (ctx) => M.server_nuke_test_data(onTestDatabase(ctx), { confirmation: 'NUKE_TEST_DATA' }));
        expect(allRows(test)).toHaveLength(0);
    });

    it('18. scenario "Reference removed later": deleting a character through admin_delete_row leaves the loadout unchanged and readable', () => {
        const { test, a } = world();
        save(test, a, { code: TEAM });
        const boss = admin(test, 'loadoutref');
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'HsrCharacter', primaryKeyJson: 'kafka' }));
        expect(view<Row>(test, 'view_my_loadouts', a)).toEqual([{ slot: 0, name: 'Firefly Hyper', note: '', code: TEAM }]);
        // A new save of the same text is now refused (validation at save time keeps new junk out).
        expect(refusedSave(test, a, { slot: 0, isNew: false })).toBe('Unknown character "kafka".');
    });
});
