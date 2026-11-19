// Identity: a verified user's own username change (rule, taken, guests, suspension, rate limit) and the Admin rename.
// Decisions: A226 (item 2), A122(1), A214, A228 (items 2, 3, 4, 8; guest names lowercase, user ruling of 2026-11-18)
// Contracts: docs/auth/contract.md
// From S14.5s (T-task of the step). In-memory datastore only; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
    USERNAME_CHARACTERS_TEXT,
    USERNAME_DOUBLE_PERIOD_TEXT,
    USERNAME_RESERVED_TEXT,
    USERNAME_TOO_OFTEN_TEXT,
    USERNAME_TOO_SHORT_TEXT,
    usernameTakenText,
} from '@shared/identity';
import { M, advance, discordId, guest, newHarness, rejection, tx, type Actor, type Harness } from '../fixtures/harness';
import { admin, linked, verified } from '../fixtures/identity';

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

// T-S14.5s fix pass (A228 item 8): once per hour replaces 3 per hour; the window row became `lastChangeAt`.
describe('A228 item 8: one change per hour per account', () => {
    it('a second change within the hour is refused and changes nothing; exactly one hour after the last change it passes', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        tx(test, neo, rename('neo_1'));
        const first = rateRow(test, neo)!;
        expect(first.lastChangeAt.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch);
        expect([first.createdById, first.lastModifiedById]).toEqual([neo.userId, neo.userId]);
        advance(test, HOUR_MS - 1);
        expect(rejection(test, neo, rename('neo_2'))).toBe(USERNAME_TOO_OFTEN_TEXT);
        expect(usernameOf(test, neo)).toBe('neo_1');
        advance(test, 1); // exactly one hour after the last change
        tx(test, neo, rename('neo_2'));
        expect(usernameOf(test, neo)).toBe('neo_2');
        const second = rateRow(test, neo)!;
        expect(second.lastChangeAt.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch);
        expect(second.createdDate.microsSinceUnixEpoch).toBe(first.createdDate.microsSinceUnixEpoch); // audit kept
    });

    it('a clock that does not advance keeps the second change refused (no fixed-window boundary)', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        tx(test, neo, rename('neo_1'));
        expect(rejection(test, neo, rename('neo_2'))).toBe(USERNAME_TOO_OFTEN_TEXT);
        expect(rejection(test, neo, rename('neo_3'))).toBe(USERNAME_TOO_OFTEN_TEXT);
        expect(usernameOf(test, neo)).toBe('neo_1');
    });

    it('a refused change (taken, rule, no-op) records nothing; the limit is per account', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        const trin = verified(test, 'trin');
        rejection(test, neo, rename('trin'));
        rejection(test, neo, rename('Bad'));
        tx(test, neo, rename('neo'));
        expect(rateRow(test, neo)).toBeUndefined();
        tx(test, neo, rename('neo_1'));
        tx(test, neo, rename('neo_1')); // its own name again: a no-op, not refused by the limit
        expect(rejection(test, neo, rename('neo_2'))).toBe(USERNAME_TOO_OFTEN_TEXT);
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

// T-S14.5s fix pass (A228 items 2, 3): the two tests that pinned the old behaviour (a Discord link keeps upper case;
// a lowercase twin of a mixed-case name is free) now pin the new rule.
describe('A228 items 2, 3: usernames are lowercase', () => {
    it('a Discord link stores the provider name lowercased; the display name keeps it as it comes', () => {
        const test = newHarness();
        const erin = verified(test, 'ErinX');
        expect(usernameOf(test, erin)).toBe('erinx');
        expect(test.db.User.id.find(erin.userId)!.displayName).toBe('ErinX');
    });

    it('the lowercase twin of a name signed in with capitals is taken', () => {
        const test = newHarness();
        verified(test, 'ErinX');
        const neo = verified(test, 'neo');
        expect(rejection(test, neo, rename('erinx'))).toBe(usernameTakenText('erinx'));
        expect(usernameOf(test, neo)).toBe('neo');
    });

    // T-S14.5s second fix pass (A228, user ruling of 2026-11-18): guest names are lowercase `guest_<hex8>`.
    it('no new name can look like a guest name or the SYSTEM user: the guest_ prefix and "system" are reserved, upper case is refused', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        const g = guest(test, 'g1');
        const guestName = usernameOf(test, g);
        expect(guestName).toMatch(/^guest_[0-9a-f]{8}$/);
        expect(rejection(test, neo, rename(guestName))).toBe(USERNAME_RESERVED_TEXT);
        expect(rejection(test, neo, rename(`G${guestName.slice(1)}`))).toBe(USERNAME_CHARACTERS_TEXT); // the old form
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

    it('the Admin\'s "taken" text is the player\'s (review M6: one sentence)', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const neo = verified(test, 'neo');
        verified(test, 'trin');
        expect(rejection(test, boss, adminRename(neo, 'trin'))).toBe(usernameTakenText('trin'));
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

// T-S14.5s fix pass: review test gaps 1 (the link path against the rule) and 5 (maintenance).
describe('A228 item 2: a Discord sign-in derives a name that follows the rule', () => {
    const signIn = (test: Harness, sub: string, providerName: string) => linked(test, sub, discordId(`pid-${sub}`), providerName);
    const fallbackOf = (sub: string) => `user_${discordId(`pid-${sub}`).slice(-8)}`;

    it('characters outside the rule become underscores, runs of periods collapse, the name is capped at 32', () => {
        const test = newHarness();
        expect(usernameOf(test, signIn(test, 's1', 'Mr Smith-Jones'))).toBe('mr_smith_jones');
        expect(usernameOf(test, signIn(test, 's2', 'a...b'))).toBe('a.b');
        expect(usernameOf(test, signIn(test, 's3', 'Z'.repeat(32)))).toBe('z'.repeat(32));
    });

    it('a reserved, too short or letterless handle gets the fallback user_<last 8 digits of the Discord id>', () => {
        const test = newHarness();
        for (const [sub, handle] of [['r1', 'Admin'], ['r2', 'support'], ['r3', 'guest_1a2b3c4d'], ['r4', 'x'], ['r5', '___'], ['r6', 'élan']] as const) {
            const name = usernameOf(test, signIn(test, sub, handle));
            if (handle === 'élan') {
                expect(name).toBe('_lan'); // one letter outside a to z becomes an underscore; the rest passes
            } else {
                expect(name, handle).toBe(fallbackOf(sub));
            }
        }
    });

    it('a taken name gets the first free _2 ... suffix; a member\'s chosen name is never taken over', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        expect(usernameOf(test, signIn(test, 't1', 'Neo'))).toBe('neo_2');
        expect(usernameOf(test, signIn(test, 't2', 'neo'))).toBe('neo_3');
        expect(usernameOf(test, neo)).toBe('neo');
    });

    it('a reserved suffix is never produced: when every suffix of the base is taken the fallback base is used', () => {
        const test = newHarness();
        verified(test, 'alpha');
        for (let n = 2; n <= 9; n++) verified(test, `alpha_${n}`);
        expect(usernameOf(test, signIn(test, 'full', 'Alpha'))).toBe(fallbackOf('full'));
    });

    // T-S14.5s second fix pass (review M1): the `user_` prefix is reserved for player choice.
    it('the fallback prefix user_ is reserved: no player can take a fallback name, the sign-in still produces it', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        const boss = admin(test, 'boss');
        const squatted = fallbackOf('victim');
        expect(rejection(test, neo, rename(squatted))).toBe(USERNAME_RESERVED_TEXT);
        expect(rejection(test, neo, rename(`${squatted}_2`))).toBe(USERNAME_RESERVED_TEXT);
        expect(rejection(test, boss, adminRename(neo, squatted))).toBe(USERNAME_RESERVED_TEXT);
        tx(test, neo, rename('username')); // only the prefix with its underscore is reserved
        expect(usernameOf(test, signIn(test, 'victim', 'Admin'))).toBe(squatted);
        expect(usernameOf(test, signIn(test, 'u42', 'user_42'))).toBe(fallbackOf('u42')); // a user_ handle takes the fallback
    });

    it('a taken fallback name gets the first free _2 suffix', () => {
        const test = newHarness();
        const first = signIn(test, 'f1', 'Admin');
        const fallback = usernameOf(test, first);
        // Another account already holds the fallback of 'f2' (an old name from before the rule).
        const holder = verified(test, 'holder');
        setUsername(test, holder, fallbackOf('f2'));
        expect(usernameOf(test, signIn(test, 'f2', 'Admin'))).toBe(`${fallbackOf('f2')}_2`);
        expect(usernameOf(test, first)).toBe(fallback);
    });

    it('update_username is refused for a non-Admin during maintenance mode', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        tx(test, 'internal', (ctx) => M.server_set_maintenance(ctx, { on: true }));
        expect(rejection(test, neo, rename('neo_1'))).toMatch(/maintenance/i);
        expect(usernameOf(test, neo)).toBe('neo');
        expect(rateRow(test, neo)).toBeUndefined();
    });
});

// T-S14.5s fix pass (A228 item 3, review S2).
describe('A228 item 3: server_lowercase_usernames lowercases every name once', () => {
    const lower = (ctx: any) => M.server_lowercase_usernames(ctx, {});

    // T-S14.5s second fix pass (review S1): the collision order is by account age (createdDate, the id only as a
    // tie-break), and an already lowercase name is never renamed. The two cases are pinned separately.
    /** Sets the account's createdDate `offsetMs` from now (ids are not ordered; age is the order). */
    const setCreated = (test: Harness, who: Actor, offsetMs: number) => {
        const row = test.db.User.id.find(who.userId)!;
        const micros = test.clock.now().microsSinceUnixEpoch + BigInt(offsetMs) * 1000n;
        test.db.User.id.update({ ...row, createdDate: new Timestamp(micros) });
    };

    it('among mixed-case names that differ only by case, the earliest account keeps the plain name, whatever the ids', () => {
        const test = newHarness();
        const lowId = verified(test, 'lowid');
        const highId = verified(test, 'highid');
        const third = verified(test, 'third');
        expect(lowId.userId).toBeLessThan(highId.userId);
        setUsername(test, lowId, 'Mixed.Case');
        setUsername(test, highId, 'MIXED.case');
        setUsername(test, third, 'MiXeD.cAsE');
        setCreated(test, highId, -3_000); // the earliest account holds the higher id
        setCreated(test, lowId, -2_000);
        setCreated(test, third, -2_000); // same moment as lowId: the lower id breaks the tie
        tx(test, 'internal', lower);
        expect(usernameOf(test, highId)).toBe('mixed.case');
        const [first, second] = lowId.userId < third.userId ? [lowId, third] : [third, lowId];
        expect(usernameOf(test, first)).toBe('mixed.case_2');
        expect(usernameOf(test, second)).toBe('mixed.case_3');
        expect(test.db.User.id.find(highId.userId)!.lastModifiedById).toBe(0); // audit actor: SYSTEM
    });

    it('an already lowercase holder keeps its name even when the mixed-case account is older, and when it is newer', () => {
        const test = newHarness();
        const oldMixed = verified(test, 'oldmixed');
        const newLower = verified(test, 'erinx');
        setUsername(test, oldMixed, 'ErinX');
        setCreated(test, oldMixed, -5_000);
        const newMixed = verified(test, 'newmixed');
        const oldLower = verified(test, 'neo.x');
        setUsername(test, newMixed, 'Neo.X');
        setCreated(test, oldLower, -5_000);
        tx(test, 'internal', lower);
        expect(usernameOf(test, newLower)).toBe('erinx'); // newer, already lowercase: kept
        expect(usernameOf(test, oldMixed)).toBe('erinx_2'); // older, but its name needed lowercasing
        expect(usernameOf(test, oldLower)).toBe('neo.x');
        expect(usernameOf(test, newMixed)).toBe('neo.x_2');
    });

    // T-S14.5s second fix pass (A228, user ruling of 2026-11-18): guest names are lowercased too.
    it('SYSTEM is left as it is; an old guest name Guest_<hex8> is lowercased; an old name keeps its other characters; nothing counts on the limit', () => {
        const test = newHarness();
        const g = guest(test, 'g1');
        const freshName = usernameOf(test, g);
        expect(freshName).toMatch(/^guest_[0-9a-f]{8}$/);
        const oldGuestName = `G${freshName.slice(1)}`;
        setUsername(test, g, oldGuestName); // a guest from before the ruling
        const legacy = verified(test, 'legacy');
        setUsername(test, legacy, 'Old Name!');
        tx(test, 'internal', lower);
        expect(usernameOf(test, g)).toBe(freshName);
        expect(test.db.User.id.find(g.userId)!.isGuest).toBe(true);
        expect(test.db.User.username.find('SYSTEM')).toBeDefined();
        expect(usernameOf(test, legacy)).toBe('old name!');
        expect(rateRow(test, legacy)).toBeUndefined();
    });

    it('idempotent: a second run writes nothing', () => {
        const test = newHarness();
        const a = verified(test, 'aa');
        setUsername(test, a, 'AA');
        tx(test, 'internal', lower);
        const after = test.db.User.id.find(a.userId)!;
        advance(test, 1_000);
        tx(test, 'internal', lower);
        expect(test.db.User.id.find(a.userId)!.lastModifiedDate.microsSinceUnixEpoch).toBe(after.lastModifiedDate.microsSinceUnixEpoch);
    });

    it('only a server identity may run it', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        expect(rejection(test, boss, lower)).toBe('Forbidden: caller is not a registered server identity.');
    });
});

// T-S14.5s fix pass (A228 item 4, review S3).
describe('A228 item 4: the server reducers address a user by username, id:<n> or discord:<id>', () => {
    const roleOf = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.role.tag;

    it('id:<n>, discord:<id> and the username all reach the same account', () => {
        const test = newHarness();
        const neo = linked(test, 'neo-dev', discordId('pid-neo'), 'neo');
        tx(test, 'internal', (ctx) => M.server_set_role(ctx, { username: `id:${neo.userId}`, roleTag: 'Moderator' }));
        expect(roleOf(test, neo)).toBe('Moderator');
        tx(test, 'internal', (ctx) => M.server_set_role(ctx, { username: `discord:${discordId('pid-neo')}`, roleTag: 'TournamentHost' }));
        expect(roleOf(test, neo)).toBe('TournamentHost');
        tx(test, 'internal', (ctx) => M.server_set_role(ctx, { username: 'neo', roleTag: 'User' }));
        expect(roleOf(test, neo)).toBe('User');
        tx(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: `id:${neo.userId}`, reason: '' }));
        tx(test, 'internal', (ctx) => M.server_lift_suspension(ctx, { username: `discord:${discordId('pid-neo')}` }));
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username: `id:${neo.userId}` }));
        expect(test.db.User.username.find('neo')).toBeNull();
    });

    it('after a rename the id still names the first account, the old name the new holder', () => {
        const test = newHarness();
        const alice = verified(test, 'alice');
        const mallory = verified(test, 'mallory');
        tx(test, alice, rename('alice_2'));
        tx(test, mallory, rename('alice'));
        tx(test, 'internal', (ctx) => M.server_set_role(ctx, { username: `id:${alice.userId}`, roleTag: 'Moderator' }));
        expect([roleOf(test, alice), roleOf(test, mallory)]).toEqual(['Moderator', 'User']);
    });

    it('a malformed or unknown reference is refused and changes nothing', () => {
        const test = newHarness();
        const neo = verified(test, 'neo');
        const set = (username: string) => (ctx: any) => M.server_set_role(ctx, { username, roleTag: 'Admin' });
        expect(rejection(test, 'internal', set('id:abc'))).toBe('"id:abc" is not a valid user id reference (id:<n>).');
        expect(rejection(test, 'internal', set('discord:12'))).toBe('"discord:12" is not a valid Discord id reference (discord:<17 to 20 digits>).');
        expect(rejection(test, 'internal', set('id:4242'))).toBe('User "id:4242" not found');
        expect(rejection(test, 'internal', set(`discord:${discordId('pid-nobody')}`))).toBe(`User "discord:${discordId('pid-nobody')}" not found`);
        expect(rejection(test, 'internal', set('nobody'))).toBe('User "nobody" not found');
        expect(roleOf(test, neo)).toBe('User');
    });
});
