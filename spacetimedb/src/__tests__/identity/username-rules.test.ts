// Identity: a verified user's own username change (rule, taken, guests, suspension, rate limit) and the Admin rename.
// Decisions: A226 (item 2), A122(1), A214
// Contracts: docs/auth/contract.md
// From S14.5s (T-task of the step). In-memory datastore only; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    USERNAME_CHARACTERS_TEXT,
    USERNAME_DOUBLE_PERIOD_TEXT,
    USERNAME_RESERVED_TEXT,
    USERNAME_TOO_OFTEN_TEXT,
    USERNAME_TOO_SHORT_TEXT,
    usernameTakenText,
} from '@shared/identity';
import { M, advance, guest, newHarness, rejection, tx, type Actor, type Harness } from '../fixtures/harness';
import { admin, verified } from '../fixtures/identity';

const SUSPENDED_TEXT = 'Your account is suspended.';
const GUEST_TEXT = 'Guest users cannot change their username. Link your Discord account first.';
const HOUR_MS = 60 * 60 * 1000;

const rename = (newUsername: string) => (ctx: any) => M.update_username(ctx, { newUsername });
const usernameOf = (test: Harness, who: Actor | number) => test.db.User.id.find(typeof who === 'number' ? who : who.userId)!.username;
const rateRow = (test: Harness, who: Actor) => test.db.UserUsernameRate.userId.find(who.userId) ?? undefined;
/** Writes a username straight on the row (a name from before the rule: an admin edit, a legacy Discord handle). */
const setUsername = (test: Harness, who: Actor, username: string) =>
    test.db.User.id.update({ ...test.db.User.id.find(who.userId)!, username });
const adminRename = (target: Actor, username: string) => (ctx: any) => {
    const row = ctx.db.User.id.find(target.userId);
    return M.admin_update_user(ctx, { userId: target.userId, displayName: row.displayName, username, roleTag: row.role.tag });
};

describe('A226 item 2: a verified user changes their own username', () => {
    it('a valid new name is stored trimmed; the old name is free at once for another account', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        const trin = verified(test, 'trin');
        tx(test, neo, rename('  the.one_1  '));
        expect(usernameOf(test, neo)).toBe('the.one_1');
        expect(test.db.User.username.find('neo')).toBeNull();
        tx(test, trin, rename('neo'));
        expect(usernameOf(test, trin)).toBe('neo');
    });

    it('each rule refusal names its case and changes nothing (no rate row)', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        const cases: Array<[string, string]> = [
            ['n', USERNAME_TOO_SHORT_TEXT],
            ['Neo2', USERNAME_CHARACTERS_TEXT],
            ['neo 2', USERNAME_CHARACTERS_TEXT],
            ['neo-2', USERNAME_CHARACTERS_TEXT],
            ['neo..2', USERNAME_DOUBLE_PERIOD_TEXT],
            ['admin', USERNAME_RESERVED_TEXT],
            ['system', USERNAME_RESERVED_TEXT],
            ['support', USERNAME_RESERVED_TEXT],
            ['guest', USERNAME_RESERVED_TEXT],
            ['guest_1a2b3c4d', USERNAME_RESERVED_TEXT],
        ];
        for (const [name, text] of cases) {
            expect(rejection(test, neo, rename(name)), name).toBe(text);
        }
        expect(rejection(test, neo, rename('   '))).toBe('Username cannot be empty');
        expect(rejection(test, neo, rename('n'.repeat(33)))).toBe('Username must be 32 characters or fewer');
        expect(usernameOf(test, neo)).toBe('neo');
        expect(rateRow(test, neo)).toBeUndefined();
    });

    it('a name another account holds is refused (one index read, exact match); nothing is counted', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        verified(test, 'trin');
        expect(rejection(test, neo, rename('trin'))).toBe(usernameTakenText('trin'));
        expect(usernameOf(test, neo)).toBe('neo');
        expect(rateRow(test, neo)).toBeUndefined();
    });

    it('the caller\'s own current name is a no-op: nothing written, nothing counted, even a name the rule refuses today', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        tx(test, neo, rename(' neo '));
        expect(rateRow(test, neo)).toBeUndefined();
        setUsername(test, neo, 'Neo-Legacy');
        tx(test, neo, rename('Neo-Legacy'));
        expect(usernameOf(test, neo)).toBe('Neo-Legacy');
        expect(rateRow(test, neo)).toBeUndefined();
    });

    it('a guest cannot change their username', () => {
        const test = newHarness();
        const g = guest(test, 'g1');
        const before = usernameOf(test, g);
        expect(rejection(test, g, rename('valid_name'))).toBe(GUEST_TEXT);
        expect(usernameOf(test, g)).toBe(before);
    });

    it('a suspended user cannot change their username', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        tx(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: 'neo', reason: '' }));
        expect(rejection(test, neo, rename('neo_2'))).toBe(SUSPENDED_TEXT);
        expect(usernameOf(test, neo)).toBe('neo');
    });
});

describe('A226 item 2: the short-term limit (3 changes per hour per account)', () => {
    it('three changes pass, the fourth in the same hour is refused and changes nothing; an hour after the window opened it passes', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        tx(test, neo, rename('neo_1'));
        advance(test, 1_000);
        tx(test, neo, rename('neo_2'));
        advance(test, 1_000);
        tx(test, neo, rename('neo_3'));
        expect(rateRow(test, neo)!.changeCount).toBe(3);
        advance(test, HOUR_MS - 3_000);
        expect(rejection(test, neo, rename('neo_4'))).toBe(USERNAME_TOO_OFTEN_TEXT);
        expect(usernameOf(test, neo)).toBe('neo_3');
        advance(test, 1_000); // the window opened exactly one hour ago
        tx(test, neo, rename('neo_4'));
        expect(usernameOf(test, neo)).toBe('neo_4');
        expect(rateRow(test, neo)!.changeCount).toBe(1);
    });

    it('a refused change (taken, rule, no-op) counts nothing; the limit is per account', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        const trin = verified(test, 'trin');
        tx(test, neo, rename('neo_1'));
        rejection(test, neo, rename('trin'));
        rejection(test, neo, rename('Bad'));
        tx(test, neo, rename('neo_1'));
        expect(rateRow(test, neo)!.changeCount).toBe(1);
        tx(test, neo, rename('neo_2'));
        tx(test, neo, rename('neo_3'));
        expect(rejection(test, neo, rename('neo_4'))).toBe(USERNAME_TOO_OFTEN_TEXT);
        tx(test, trin, rename('trin_1'));
        expect(usernameOf(test, trin)).toBe('trin_1');
    });

    it('the window row goes with the account', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        tx(test, neo, rename('neo_1'));
        expect(rateRow(test, neo)).toBeDefined();
        tx(test, neo, (ctx) => M.delete_my_account(ctx, {}));
        expect(rateRow(test, neo)).toBeUndefined();
        expect(test.db.User.username.find('neo_1')).toBeNull();
    });
});

describe('A226 item 2: names from before the rule (no rewrite) and case', () => {
    it('a Discord link still takes the provider name as it comes (upper case included): existing behaviour, not rewritten', () => {
        const test = newHarness();
        const erin = verified(test, 'ErinX');
        expect(usernameOf(test, erin)).toBe('ErinX');
    });

    it('the unique index is case-sensitive: a lowercase twin of a mixed-case name is not "taken" (the residue the step reports)', () => {
        const test = newHarness();
        verified(test, 'ErinX');
        const neo = verified(test, 'neo');
        tx(test, neo, rename('erinx'));
        expect(usernameOf(test, neo)).toBe('erinx');
    });

    it('no new name can look like a guest name or the SYSTEM user: the guest_ prefix and "system" are reserved, upper case is refused', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        const g = guest(test, 'g1');
        const guestName = usernameOf(test, g);
        expect(guestName).toMatch(/^Guest_[0-9a-f]{8}$/);
        expect(rejection(test, neo, rename(guestName))).toBe(USERNAME_CHARACTERS_TEXT);
        expect(rejection(test, neo, rename(guestName.toLowerCase()))).toBe(USERNAME_RESERVED_TEXT);
        expect(rejection(test, neo, rename('SYSTEM'))).toBe(USERNAME_CHARACTERS_TEXT);
        expect(rejection(test, neo, rename('system'))).toBe(USERNAME_RESERVED_TEXT);
    });
});

describe('A226 item 2: admin_update_user follows the same rule for a changed username', () => {
    it('a changed name follows the rule (upper case, reserved, too short refused); a valid one is stored', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const neo = verified(test, 'neo');
        expect(rejection(test, boss, adminRename(neo, 'NEO'))).toBe(USERNAME_CHARACTERS_TEXT);
        expect(rejection(test, boss, adminRename(neo, 'moderator'))).toBe(USERNAME_RESERVED_TEXT);
        expect(rejection(test, boss, adminRename(neo, 'n'))).toBe(USERNAME_TOO_SHORT_TEXT);
        tx(test, boss, adminRename(neo, 'neo.fixed'));
        expect(usernameOf(test, neo)).toBe('neo.fixed');
    });

    it('the current name passes unchanged, so the display name or role of a legacy-named user can still be edited', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const neo = verified(test, 'neo');
        setUsername(test, neo, 'Neo Legacy');
        tx(test, boss, (ctx) => M.admin_update_user(ctx, { userId: neo.userId, displayName: 'Renamed', username: 'Neo Legacy', roleTag: 'User' }));
        expect(test.db.User.id.find(neo.userId)).toMatchObject({ username: 'Neo Legacy', displayName: 'Renamed' });
    });

    it('staff renames do not count on the player\'s limit', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const neo = verified(test, 'neo');
        for (const name of ['neo_1', 'neo_2', 'neo_3', 'neo_4']) tx(test, boss, adminRename(neo, name));
        expect(usernameOf(test, neo)).toBe('neo_4');
        expect(rateRow(test, neo)).toBeUndefined();
        tx(test, neo, rename('neo_5'));
        expect(usernameOf(test, neo)).toBe('neo_5');
    });
});
