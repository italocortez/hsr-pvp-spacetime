// Admin: another Admin's role is changed only by the server, never from the app.
// Decisions: A216 (user ruling 2026-11-17), A215 (the server acts as SYSTEM)
// Contracts: docs/admin/contract.md
// From suspension-s1 (fix pass, item 10).
//
// T-suspension-s1: admin_update_user refuses a role change whose target is another Admin; an Admin's own role change
// and every non-role edit of an Admin stay as before; server_set_role still changes an Admin's role (not SYSTEM's).
// mod_promote_to_host / mod_demote_from_host already refuse any target that is not User / TournamentHost. Everything
// runs in the in-memory datastore; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { ADMIN_ROLE_SERVER_ONLY_TEXT } from '@module/reducers/admin/admin';
import { M, newHarness, rejection, tx, type Actor, type Harness } from '../fixtures/harness';
import { admin, moderator, verified } from '../fixtures/identity';

const userOf = (test: Harness, a: Actor) => test.db.User.id.find(a.userId)!;
const update = (userId: number, displayName: string, username: string, roleTag: string) =>
    (ctx: any) => M.admin_update_user(ctx, { userId, displayName, username, roleTag });

describe('A216: an Admin cannot change another Admin\'s role from the app', () => {
    it('demoting another Admin (to each lower role) is refused; the row is unchanged', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const other = admin(test, 'other');
        const before = userOf(test, other);
        for (const role of ['Moderator', 'TournamentHost', 'User']) {
            expect(rejection(test, boss, update(other.userId, before.displayName, before.username, role)), role)
                .toBe(ADMIN_ROLE_SERVER_ONLY_TEXT);
        }
        expect(userOf(test, other).role.tag).toBe('Admin');
        expect(userOf(test, other).lastModifiedDate).toEqual(before.lastModifiedDate);
    });

    it('a non-role edit of another Admin still works (role sent unchanged)', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const other = admin(test, 'other');
        const u = userOf(test, other);
        tx(test, boss, update(other.userId, 'Renamed Admin', u.username, 'Admin'));
        expect(userOf(test, other).displayName).toBe('Renamed Admin');
        expect(userOf(test, other).role.tag).toBe('Admin');
    });

    it('an Admin may still change their own role', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const u = userOf(test, boss);
        tx(test, boss, update(boss.userId, u.displayName, u.username, 'Moderator'));
        expect(userOf(test, boss).role.tag).toBe('Moderator');
    });

    it('an Admin still promotes and demotes non-Admins, including promoting to Admin', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const mod = moderator(test, 'mod');
        const user = verified(test, 'usr');
        const m = userOf(test, mod);
        const v = userOf(test, user);
        tx(test, boss, update(mod.userId, m.displayName, m.username, 'User'));
        tx(test, boss, update(user.userId, v.displayName, v.username, 'Admin'));
        expect(userOf(test, mod).role.tag).toBe('User');
        expect(userOf(test, user).role.tag).toBe('Admin');
        // the freshly promoted Admin is now protected as well
        expect(rejection(test, boss, update(user.userId, v.displayName, v.username, 'User'))).toBe(ADMIN_ROLE_SERVER_ONLY_TEXT);
    });

    it('server_set_role demotes an Admin other than SYSTEM; SYSTEM stays refused', () => {
        const test = newHarness();
        const other = admin(test, 'other');
        const username = userOf(test, other).username;
        tx(test, 'internal', (ctx) => M.server_set_role(ctx, { username, roleTag: 'User' }));
        expect(userOf(test, other).role.tag).toBe('User');
        expect(rejection(test, 'internal', (ctx) => M.server_set_role(ctx, { username: 'SYSTEM', roleTag: 'User' })))
            .toBe('The SYSTEM user cannot be changed.');
    });
});
