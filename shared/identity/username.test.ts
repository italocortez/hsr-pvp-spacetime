// Identity: the shared rule for a new username, and the module's use of the very same function.
// Decisions: A226 (item 2)
// Contracts: docs/auth/contract.md
// From S14.5s (T-task of the step). Pure: no database, nothing reaches maincloud.

import {
    checkNewUsername,
    USERNAME_MAX_LENGTH as MODULE_USERNAME_MAX_LENGTH,
} from '@module/helpers/identity/usernames';
import {
    isReservedUsername,
    normalizeUsername,
    RESERVED_USERNAMES,
    USERNAME_CHANGE_WINDOW_MS,
    USERNAME_CHANGES_PER_WINDOW,
    USERNAME_CHARACTERS_TEXT,
    USERNAME_DOUBLE_PERIOD_TEXT,
    USERNAME_EMPTY_TEXT,
    USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH,
    USERNAME_RESERVED_TEXT,
    USERNAME_TOO_LONG_TEXT,
    USERNAME_TOO_OFTEN_TEXT,
    USERNAME_TOO_SHORT_TEXT,
    usernameRuleError,
    usernameTakenText,
} from '@shared/identity';
import { describe, expect, it } from 'vitest';

describe("A226 item 2: usernameRuleError accepts Discord's form", () => {
    it.each([
        'ab',
        'alice',
        'alice_01',
        'a.b.c',
        '_lead',
        'trail.',
        '.dot',
        '0123456789',
        'x'.repeat(32),
        'guestbook', // starts with "guest" but not "guest_"
        'my_guest_name',
        'admins',
        'system2',
    ])('accepts %j', (name) => {
        expect(usernameRuleError(name)).toBeNull();
    });

    it('trims the input first, as the module stores it', () => {
        expect(usernameRuleError('  alice  ')).toBeNull();
        expect(normalizeUsername('  alice  ')).toBe('alice');
    });
});

describe('A226 item 2: usernameRuleError refuses with one text per case, checked in order', () => {
    it.each([
        ['', USERNAME_EMPTY_TEXT],
        ['   ', USERNAME_EMPTY_TEXT],
        ['x'.repeat(33), USERNAME_TOO_LONG_TEXT],
        ['X'.repeat(33), USERNAME_TOO_LONG_TEXT], // length before characters
        ['a', USERNAME_TOO_SHORT_TEXT],
        ['A', USERNAME_TOO_SHORT_TEXT],
        ['Alice', USERNAME_CHARACTERS_TEXT],
        ['ALICE', USERNAME_CHARACTERS_TEXT],
        ['ali ce', USERNAME_CHARACTERS_TEXT],
        ['ali-ce', USERNAME_CHARACTERS_TEXT],
        ['alice!', USERNAME_CHARACTERS_TEXT],
        ['élan', USERNAME_CHARACTERS_TEXT],
        ['al#1234', USERNAME_CHARACTERS_TEXT],
        ['Guest_1a2b3c4d', USERNAME_CHARACTERS_TEXT], // the guest name form is upper case
        ['SYSTEM', USERNAME_CHARACTERS_TEXT],
        ['a..b', USERNAME_DOUBLE_PERIOD_TEXT],
        ['..', USERNAME_DOUBLE_PERIOD_TEXT],
        ['a...b', USERNAME_DOUBLE_PERIOD_TEXT],
        ['system', USERNAME_RESERVED_TEXT],
        ['admin', USERNAME_RESERVED_TEXT],
        ['administrator', USERNAME_RESERVED_TEXT],
        ['moderator', USERNAME_RESERVED_TEXT],
        ['mod', USERNAME_RESERVED_TEXT],
        ['staff', USERNAME_RESERVED_TEXT],
        ['support', USERNAME_RESERVED_TEXT],
        ['guest', USERNAME_RESERVED_TEXT],
        ['guest_', USERNAME_RESERVED_TEXT],
        ['guest_1a2b3c4d', USERNAME_RESERVED_TEXT],
        ['guest_anything', USERNAME_RESERVED_TEXT],
    ])('refuses %j', (name, text) => {
        expect(usernameRuleError(name)).toBe(text);
    });

    it("the reserved list holds at least the ruling's names, and the guest_ prefix", () => {
        for (const name of [
            'system',
            'admin',
            'administrator',
            'moderator',
            'mod',
            'staff',
            'support',
            'guest',
        ]) {
            expect(RESERVED_USERNAMES).toContain(name);
        }
        expect(isReservedUsername('guest_x')).toBe(true);
        expect(isReservedUsername('guests')).toBe(false);
    });

    it('the texts and limits', () => {
        expect([USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH]).toEqual([2, 32]);
        expect(USERNAME_EMPTY_TEXT).toBe('Username cannot be empty');
        expect(USERNAME_TOO_LONG_TEXT).toBe('Username must be 32 characters or fewer');
        expect(USERNAME_TOO_SHORT_TEXT).toBe('Username must be at least 2 characters');
        expect(USERNAME_CHARACTERS_TEXT).toBe(
            'Username can use only lowercase letters a to z, digits, underscore and period',
        );
        expect(USERNAME_DOUBLE_PERIOD_TEXT).toBe('Username cannot contain two periods in a row');
        expect(USERNAME_RESERVED_TEXT).toBe('That username is reserved');
        expect(usernameTakenText('alice')).toBe('Username "alice" is already taken.');
        expect([USERNAME_CHANGES_PER_WINDOW, USERNAME_CHANGE_WINDOW_MS]).toEqual([3, 3_600_000]);
        expect(USERNAME_TOO_OFTEN_TEXT).toBe(
            'You can change your username 3 times per hour. Try again later.',
        );
    });
});

describe('A226 item 2: the module runs the same function', () => {
    it.each(['', 'a', 'Alice', 'a..b', 'admin', 'guest_1', 'x'.repeat(33)])(
        'checkNewUsername(%j) throws the shared text',
        (name) => {
            const text = usernameRuleError(name);
            expect(text).not.toBeNull();
            expect(() => checkNewUsername(name)).toThrow(text ?? '');
        },
    );

    it('checkNewUsername returns the trimmed name when the rule accepts it', () => {
        expect(checkNewUsername('  alice.b  ')).toBe('alice.b');
    });

    it("the module's USERNAME_MAX_LENGTH is the shared one", () => {
        expect(MODULE_USERNAME_MAX_LENGTH).toBe(USERNAME_MAX_LENGTH);
    });
});
