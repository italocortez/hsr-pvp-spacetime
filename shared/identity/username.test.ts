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
    isSignInFallbackUsername,
    matchUserReference,
    normalizeUsername,
    parseUserReference,
    RESERVED_USERNAMES,
    USERNAME_CHANGE_INTERVAL_MS,
    USERNAME_CHARACTERS_TEXT,
    USERNAME_DOUBLE_PERIOD_TEXT,
    USERNAME_EMPTY_TEXT,
    USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH,
    USERNAME_RESERVED_TEXT,
    USERNAME_TOO_LONG_TEXT,
    USERNAME_TOO_OFTEN_TEXT,
    USERNAME_TOO_SHORT_TEXT,
    userIdReference,
    usernameBaseFromProvider,
    usernameRuleError,
    usernameTakenText,
    userReferenceError,
    withUsernameSuffix,
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
        'modern', // starts with "mod" but not "mod_" or "mod."
        'staffy',
        'the.mod', // only prefixes are reserved, not a staff word inside a name
        'system2',
        'username', // T-S14.5s second fix pass: only "user_" is reserved
        'users',
        'my_user_1',
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
        ['Guest_1a2b3c4d', USERNAME_CHARACTERS_TEXT], // the old guest name form (guests are guest_<hex8> since the second S14.5s fix pass)
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
        // T-S14.5s fix pass (review M4): more reserved names and the staff lookalike prefixes; 'admins' was accepted
        // before and is now refused by the `admin` prefix.
        ['admins', USERNAME_RESERVED_TEXT],
        ['admin1', USERNAME_RESERVED_TEXT],
        ['admin_', USERNAME_RESERVED_TEXT],
        ['moderators', USERNAME_RESERVED_TEXT],
        ['mod_x', USERNAME_RESERVED_TEXT],
        ['staff.team', USERNAME_RESERVED_TEXT],
        ['support_bot', USERNAME_RESERVED_TEXT],
        ['official', USERNAME_RESERVED_TEXT],
        ['discord', USERNAME_RESERVED_TEXT],
        ['everyone', USERNAME_RESERVED_TEXT],
        ['here', USERNAME_RESERVED_TEXT],
        ['null', USERNAME_RESERVED_TEXT],
        ['undefined', USERNAME_RESERVED_TEXT],
        ['ipcbattlegrounds', USERNAME_RESERVED_TEXT],
        // T-S14.5s second fix pass (review M1): the sign-in fallback prefix is reserved.
        ['user_', USERNAME_RESERVED_TEXT],
        ['user_12345678', USERNAME_RESERVED_TEXT],
        ['user_12345678_2', USERNAME_RESERVED_TEXT],
        ['user_bob', USERNAME_RESERVED_TEXT],
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
        // T-S14.5s fix pass (A228 item 8): once per hour replaces 3 per hour.
        expect(USERNAME_CHANGE_INTERVAL_MS).toBe(3_600_000);
        expect(USERNAME_TOO_OFTEN_TEXT).toBe(
            'You can change your username once per hour. Try again later.',
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

// T-S14.5s fix pass (A228 item 2): the base a Discord sign-in derives.
describe('A228 item 2: usernameBaseFromProvider and withUsernameSuffix', () => {
    it.each([
        ['alice', 'alice'],
        ['Alice', 'alice'],
        ['  ErinX  ', 'erinx'],
        ['Mr Smith-Jones', 'mr_smith_jones'],
        ['a...b', 'a.b'],
        ['A'.repeat(40), 'a'.repeat(32)],
        ['name#1234', 'name_1234'],
    ])('%j becomes %j', (raw, base) => {
        expect(usernameBaseFromProvider(raw)).toBe(base);
        expect(usernameRuleError(base)).toBeNull();
    });

    it.each(['', 'x', 'Admin', 'SUPPORT', 'guest_1a2b3c4d', '___', '...', '日本語'])(
        '%j has no valid base (null: the module uses its fallback)',
        (raw) => {
            expect(usernameBaseFromProvider(raw)).toBeNull();
        },
    );

    it('a user_ handle has no valid base (the fallback prefix is reserved)', () => {
        expect(usernameBaseFromProvider('User_42')).toBeNull();
    });

    // T-S14.5s second fix pass (review M1): the module admits the fallback candidates by their shape.
    it.each(['user_1', 'user_12345678', 'user_12345678_2', 'user_00000000_9'])(
        '%j is a sign-in fallback name',
        (name) => {
            expect(isSignInFallbackUsername(name)).toBe(true);
        },
    );

    it.each([
        'user_',
        'user_123456789',
        'user_1234_1',
        'user_1234_10',
        'user_abc',
        'User_1234',
        'x_user_1',
    ])('%j is not a sign-in fallback name', (name) => {
        expect(isSignInFallbackUsername(name)).toBe(false);
    });

    it('a suffix keeps the name within 32 characters', () => {
        expect(withUsernameSuffix('neo', 2)).toBe('neo_2');
        expect(withUsernameSuffix('x'.repeat(32), 9)).toBe(`${'x'.repeat(30)}_9`);
    });
});

// T-S14.5s fix pass (A228 item 4): the user reference of the server scripts.
describe('A228 item 4: user references (username, id:<n>, discord:<id>)', () => {
    const accounts = [
        { id: 1, username: 'alice', discordId: '100000000000000001' },
        { id: 2, username: 'bob' },
        { id: 3, username: 'id:9' }, // an old name with a colon is shadowed by the prefixed form
    ];

    it('parses the three forms', () => {
        expect(parseUserReference('id:42')).toEqual({ kind: 'id', userId: 42 });
        expect(parseUserReference('discord:100000000000000001')).toEqual({
            kind: 'discord',
            discordId: '100000000000000001',
        });
        expect(parseUserReference('alice')).toEqual({ kind: 'username', username: 'alice' });
        expect(userIdReference(7)).toBe('id:7');
    });

    const BAD_REFERENCES = [
        '',
        'id:',
        'id:x',
        'id:-1',
        'id:4294967296',
        'discord:',
        'discord:123',
        'discord:1000000000000000000000',
    ];
    it.each(BAD_REFERENCES)('refuses %j', (ref) => {
        expect(userReferenceError(ref)).not.toBeNull();
        expect(() => parseUserReference(ref)).toThrow();
    });

    it('matches by id, Discord id or exact username', () => {
        expect(matchUserReference(accounts, 'id:2').map((a) => a.id)).toEqual([2]);
        const byDiscord = matchUserReference(accounts, 'discord:100000000000000001');
        expect(byDiscord.map((a) => a.id)).toEqual([1]);
        expect(matchUserReference(accounts, 'bob').map((a) => a.id)).toEqual([2]);
        expect(matchUserReference(accounts, 'Bob')).toEqual([]);
        expect(matchUserReference(accounts, 'id:9')).toEqual([]);
    });
});
