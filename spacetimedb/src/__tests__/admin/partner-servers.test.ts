// Admin: the partner server list behind the landing page's partner tiles (public table, no audit columns).
// Decisions: user ruling 2026-11-17 (an admin-editable public table of invite code and name, no audit columns)
// Contracts: docs/admin/contract.md
// From S14.4p.
//
// T-S14.4p: the six reducers (admin_* behind ensureAdmin, server_* behind requireServer) share one rule set
// (helpers/admin/partnerServers.ts). Everything runs in the in-memory datastore; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    PARTNER_DESCRIPTION_TEXT,
    PARTNER_DUPLICATE_TEXT,
    PARTNER_INVITE_TEXT,
    PARTNER_LIMIT_TEXT,
    PARTNER_NAME_TEXT,
    PARTNER_NOT_FOUND_TEXT,
    PARTNER_SERVER_LIMIT,
} from '@module/helpers/admin/partnerServers';
import { SUSPENDED_TEXT } from '@module/helpers/identity/suspension';
import { M, linkerAuth, newHarness, rejection, snap, tx, type Actor, type Ctx, type Harness } from '../fixtures/harness';
import { ADMIN_ONLY, admin, moderator, verified } from '../fixtures/identity';

const NOT_SERVER = 'Forbidden: caller is not a registered server identity.';
const LINKER = (test: Harness) => ({ auth: linkerAuth(test) }) as Actor;

type Args = { name: string; invite: string; description: string; position: number };
const args = (over: Partial<Args> = {}): Args =>
    ({ name: 'Genius Society', invite: 'HbXErzYVQ5', description: 'Relic manipulators and build makers', position: 0, ...over });

const rows = (test: Harness) => [...test.db.PartnerServer.iter()].sort((a, b) => a.position - b.position || a.id - b.id);
const byCode = (test: Harness, code: string) => test.db.PartnerServer.inviteCode.find(code);

const serverAdd = (test: Harness, over: Partial<Args> = {}) =>
    tx(test, 'internal', (ctx) => M.server_add_partner_server(ctx, args(over)));

describe('partner servers: happy paths', () => {
    it('an Admin adds, updates and removes a partner server; the row holds exactly the five columns', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        tx(test, boss, (ctx) => M.admin_add_partner_server(ctx, args()));
        const added = byCode(test, 'HbXErzYVQ5')!;
        expect(Object.keys(added).sort()).toEqual(['description', 'id', 'inviteCode', 'name', 'position']);
        expect(added).toMatchObject({ name: 'Genius Society', description: 'Relic manipulators and build makers', position: 0 });

        tx(test, boss, (ctx) => M.admin_update_partner_server(ctx, {
            id: added.id, ...args({ name: 'Genius Society 2', invite: 'NewCode-1', description: '', position: 3 }),
        }));
        expect(byCode(test, 'HbXErzYVQ5')).toBeNull();
        expect(test.db.PartnerServer.id.find(added.id)).toEqual({
            id: added.id, name: 'Genius Society 2', inviteCode: 'NewCode-1', description: '', position: 3,
        });

        tx(test, boss, (ctx) => M.admin_remove_partner_server(ctx, { id: added.id }));
        expect(rows(test)).toEqual([]);
    });

    it('the server identity adds, updates and removes the same way', () => {
        const test = newHarness();
        serverAdd(test);
        const added = byCode(test, 'HbXErzYVQ5')!;
        tx(test, 'internal', (ctx) => M.server_update_partner_server(ctx, { id: added.id, ...args({ position: 7 }) }));
        expect(test.db.PartnerServer.id.find(added.id)!.position).toBe(7);
        tx(test, 'internal', (ctx) => M.server_remove_partner_server(ctx, { id: added.id }));
        expect(rows(test)).toEqual([]);
    });

    it('name and description are trimmed; an empty description is accepted; boundaries 50 and 80 pass', () => {
        const test = newHarness();
        serverAdd(test, { name: '  Spaced  ', description: '   ' });
        expect(byCode(test, 'HbXErzYVQ5')).toMatchObject({ name: 'Spaced', description: '' });
        serverAdd(test, { invite: 'ab', name: 'n'.repeat(50), description: 'd'.repeat(80) });
        expect(byCode(test, 'ab')).toMatchObject({ name: 'n'.repeat(50), description: 'd'.repeat(80) });
    });

    it('both link forms and a padded code are stored as the bare code', () => {
        const test = newHarness();
        serverAdd(test, { invite: 'https://discord.gg/AbC-123' });
        serverAdd(test, { invite: 'https://discord.com/invite/XyZ987' });
        serverAdd(test, { invite: '  padded-code  ' });
        serverAdd(test, { invite: 'x'.repeat(32) });
        expect(rows(test).map((r) => r.inviteCode)).toEqual(['AbC-123', 'XyZ987', 'padded-code', 'x'.repeat(32)]);
    });

    it('an update may keep its own invite (no duplicate refusal against itself)', () => {
        const test = newHarness();
        serverAdd(test);
        const id = byCode(test, 'HbXErzYVQ5')!.id;
        tx(test, 'internal', (ctx) => M.server_update_partner_server(ctx, { id, ...args({ invite: 'https://discord.gg/HbXErzYVQ5', name: 'Renamed' }) }));
        expect(test.db.PartnerServer.id.find(id)!.name).toBe('Renamed');
    });
});

describe('partner servers: refusals (nothing is written)', () => {
    it('bad name, description and invite are refused with their texts', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const cases: Array<[string, Partial<Args>, string]> = [
            ['empty name', { name: '' }, PARTNER_NAME_TEXT],
            ['blank name', { name: '   ' }, PARTNER_NAME_TEXT],
            ['51-character name', { name: 'n'.repeat(51) }, PARTNER_NAME_TEXT],
            ['81-character description', { description: 'd'.repeat(81) }, PARTNER_DESCRIPTION_TEXT],
            ['empty invite', { invite: '' }, PARTNER_INVITE_TEXT],
            ['one character', { invite: 'a' }, PARTNER_INVITE_TEXT],
            ['33 characters', { invite: 'x'.repeat(33) }, PARTNER_INVITE_TEXT],
            ['underscore', { invite: 'ab_cd' }, PARTNER_INVITE_TEXT],
            ['space inside', { invite: 'ab cd' }, PARTNER_INVITE_TEXT],
            ['other host', { invite: 'https://evil.example/HbXErzYVQ5' }, PARTNER_INVITE_TEXT],
            ['http link', { invite: 'http://discord.gg/HbXErzYVQ5' }, PARTNER_INVITE_TEXT],
            ['query string', { invite: 'https://discord.gg/HbXErzYVQ5?x=1' }, PARTNER_INVITE_TEXT],
            ['extra path', { invite: 'https://discord.com/invite/HbXErzYVQ5/more' }, PARTNER_INVITE_TEXT],
            ['link without a code', { invite: 'https://discord.gg/' }, PARTNER_INVITE_TEXT],
            ['javascript', { invite: 'javascript:alert(1)' }, PARTNER_INVITE_TEXT],
            ['no scheme', { invite: 'discord.gg/HbXErzYVQ5' }, PARTNER_INVITE_TEXT],
        ];
        for (const [label, over, text] of cases) {
            expect(rejection(test, boss, (ctx) => M.admin_add_partner_server(ctx, args(over))), label).toBe(text);
            expect(rejection(test, 'internal', (ctx) => M.server_add_partner_server(ctx, args(over))), label).toBe(text);
        }
        expect(rows(test)).toEqual([]);
    });

    it('the same rules apply on update; the row is unchanged', () => {
        const test = newHarness();
        serverAdd(test);
        const before = byCode(test, 'HbXErzYVQ5')!;
        for (const [over, text] of [
            [{ name: '' }, PARTNER_NAME_TEXT],
            [{ description: 'd'.repeat(81) }, PARTNER_DESCRIPTION_TEXT],
            [{ invite: 'https://example.com/x' }, PARTNER_INVITE_TEXT],
        ] as Array<[Partial<Args>, string]>) {
            expect(rejection(test, 'internal', (ctx) => M.server_update_partner_server(ctx, { id: before.id, ...args(over) }))).toBe(text);
        }
        expect(snap(test.db.PartnerServer.id.find(before.id))).toBe(snap(before));
    });

    it('a duplicate invite code is refused on add (link or bare) and on update', () => {
        const test = newHarness();
        serverAdd(test);
        serverAdd(test, { invite: 'Other', name: 'Other' });
        expect(rejection(test, 'internal', (ctx) => M.server_add_partner_server(ctx, args({ name: 'Copy' })))).toBe(PARTNER_DUPLICATE_TEXT);
        expect(rejection(test, 'internal', (ctx) => M.server_add_partner_server(ctx, args({ invite: 'https://discord.com/invite/HbXErzYVQ5' }))))
            .toBe(PARTNER_DUPLICATE_TEXT);
        const other = byCode(test, 'Other')!;
        expect(rejection(test, 'internal', (ctx) => M.server_update_partner_server(ctx, { id: other.id, ...args() }))).toBe(PARTNER_DUPLICATE_TEXT);
        expect(rows(test)).toHaveLength(2);
        expect(byCode(test, 'Other')!.name).toBe('Other');
    });

    it(`at most ${PARTNER_SERVER_LIMIT} rows: the next add is refused; after a removal one fits again`, () => {
        const test = newHarness();
        for (let i = 0; i < PARTNER_SERVER_LIMIT; i++) serverAdd(test, { invite: `code-${i}`, name: `Server ${i}`, position: i });
        expect(rows(test)).toHaveLength(PARTNER_SERVER_LIMIT);
        expect(rejection(test, 'internal', (ctx) => M.server_add_partner_server(ctx, args({ invite: 'one-more' })))).toBe(PARTNER_LIMIT_TEXT);
        const boss = admin(test, 'boss');
        expect(rejection(test, boss, (ctx) => M.admin_add_partner_server(ctx, args({ invite: 'one-more' })))).toBe(PARTNER_LIMIT_TEXT);
        expect(rows(test)).toHaveLength(PARTNER_SERVER_LIMIT);
        // An update at the limit is not an add.
        const first = byCode(test, 'code-0')!;
        tx(test, 'internal', (ctx) => M.server_update_partner_server(ctx, { id: first.id, ...args({ invite: 'code-0', name: 'Renamed' }) }));
        tx(test, 'internal', (ctx) => M.server_remove_partner_server(ctx, { id: first.id }));
        serverAdd(test, { invite: 'one-more' });
        expect(rows(test)).toHaveLength(PARTNER_SERVER_LIMIT);
    });

    it('update and remove of an unknown id are refused', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        expect(rejection(test, boss, (ctx) => M.admin_update_partner_server(ctx, { id: 999, ...args() }))).toBe(PARTNER_NOT_FOUND_TEXT);
        expect(rejection(test, boss, (ctx) => M.admin_remove_partner_server(ctx, { id: 999 }))).toBe(PARTNER_NOT_FOUND_TEXT);
        expect(rejection(test, 'internal', (ctx) => M.server_update_partner_server(ctx, { id: 999, ...args() }))).toBe(PARTNER_NOT_FOUND_TEXT);
        expect(rejection(test, 'internal', (ctx) => M.server_remove_partner_server(ctx, { id: 999 }))).toBe(PARTNER_NOT_FOUND_TEXT);
        expect(rows(test)).toEqual([]);
    });
});

describe('partner servers: callers', () => {
    it('a verified user and a Moderator are refused the admin reducers and the server reducers', () => {
        const test = newHarness();
        serverAdd(test);
        const id = byCode(test, 'HbXErzYVQ5')!.id;
        for (const who of [verified(test, 'plain'), moderator(test, 'mod')]) {
            expect(rejection(test, who, (ctx) => M.admin_add_partner_server(ctx, args({ invite: 'new-one' })))).toBe(ADMIN_ONLY);
            expect(rejection(test, who, (ctx) => M.admin_update_partner_server(ctx, { id, ...args({ name: 'X' }) }))).toBe(ADMIN_ONLY);
            expect(rejection(test, who, (ctx) => M.admin_remove_partner_server(ctx, { id }))).toBe(ADMIN_ONLY);
            expect(rejection(test, who, (ctx) => M.server_add_partner_server(ctx, args({ invite: 'new-one' })))).toBe(NOT_SERVER);
            expect(rejection(test, who, (ctx) => M.server_update_partner_server(ctx, { id, ...args({ name: 'X' }) }))).toBe(NOT_SERVER);
            expect(rejection(test, who, (ctx) => M.server_remove_partner_server(ctx, { id }))).toBe(NOT_SERVER);
        }
        expect(rows(test).map((r) => r.name)).toEqual(['Genius Society']);
    });

    it('an Admin is refused the server reducers', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        expect(rejection(test, boss, (ctx) => M.server_add_partner_server(ctx, args()))).toBe(NOT_SERVER);
        expect(rows(test)).toEqual([]);
    });

    it('the Linker identity is refused all six', () => {
        const test = newHarness();
        serverAdd(test);
        const id = byCode(test, 'HbXErzYVQ5')!.id;
        const linker = LINKER(test);
        for (const call of [
            (ctx: any) => M.admin_add_partner_server(ctx, args({ invite: 'new-one' })),
            (ctx: any) => M.admin_update_partner_server(ctx, { id, ...args({ name: 'X' }) }),
            (ctx: any) => M.admin_remove_partner_server(ctx, { id }),
        ]) {
            // A Linker has no UserIdentity row, so the admin gate finds no user.
            expect(rejection(test, linker, call)).toBe('Unauthorized: No user linked to this identity.');
        }
        expect(rejection(test, linker, (ctx) => M.server_add_partner_server(ctx, args({ invite: 'new-one' })))).toBe(NOT_SERVER);
        expect(rejection(test, linker, (ctx) => M.server_update_partner_server(ctx, { id, ...args({ name: 'X' }) }))).toBe(NOT_SERVER);
        expect(rejection(test, linker, (ctx) => M.server_remove_partner_server(ctx, { id }))).toBe(NOT_SERVER);
        expect(rows(test).map((r) => r.name)).toEqual(['Genius Society']);
    });

    it('a suspended Admin is refused; lifted, the same Admin may edit again', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const username = test.db.User.id.find(boss.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username, reason: '' }));
        expect(rejection(test, boss, (ctx) => M.admin_add_partner_server(ctx, args()))).toBe(SUSPENDED_TEXT);
        expect(rows(test)).toEqual([]);
        tx(test, 'internal', (ctx) => M.server_lift_suspension(ctx, { username }));
        tx(test, boss, (ctx) => M.admin_add_partner_server(ctx, args()));
        expect(rows(test)).toHaveLength(1);
    });
});

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

describe('partner servers: test wipe', () => {
    it('S14.4-fix1, scenario S14.4p-P6: server_nuke_test_data wipes the users and keeps every partner row unchanged', () => {
        const test = newHarness();
        const player = verified(test, 'player');
        serverAdd(test);
        serverAdd(test, { invite: 'second-1', name: 'Second', description: '', position: 1 });
        const before = rows(test);
        expect(test.db.User.id.find(player.userId)).not.toBeNull();

        tx(test, 'internal', (ctx) => M.server_nuke_test_data(onTestDatabase(ctx), { confirmation: 'NUKE_TEST_DATA' }));

        // The wipe ran (the player's account is gone) and the partner list is exactly as it was.
        expect(test.db.User.id.find(player.userId)).toBeNull();
        expect(rows(test)).toEqual(before);
    });
});
