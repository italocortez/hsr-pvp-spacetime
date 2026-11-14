// Identity: the shared merge (planProviderLink / applyProviderLink) called directly, and where a linker identity could
// gain a user mapping.
// Decisions: A46, A175, A176 (M5a3 rulings 2026-11-13)
// Contracts: docs/auth/contract.md; docs/auth/architecture.md "Shared merge", "Phase M5a3 execution"
//
// T-M5a3-fix: since M5a3 only confirm_link runs the merge (linker_present_code runs planProviderLink as a pre-check), and
// both refuse a caller that is not the live, unlinked guest that asked, so some branches of the merge are no longer
// reached through any reducer: the refresh of an already linked identity (Case 1c) and the non-guest sides of the
// re-point. They are kept and pinned here by calling the helpers directly inside a transaction. The two refusals
// "providerId is required" and "Identity not registered" are pinned directly and through the one reducer path that still
// reaches each. Item 4 (getAuthenticatedUser vs creation points): a linker identity never gets a UserIdentity row because
// every writer that creates one refuses it; rows are written directly to get past the registration reducers.
// Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { Identity } from 'spacetimedb';
import {
    applyProviderLink,
    IDENTITY_NOT_REGISTERED_TEXT,
    planProviderLink,
} from '@module/helpers/identity/providerLink';
import { LINKER_NOT_A_USER_TEXT } from '@module/helpers/identity/serverIdentities';
import {
    AUDIT,
    M,
    TEST_CLIENT_NONCE,
    TEST_CONFIRM_HASH,
    TestAuth,
    advance,
    discordId,
    guest,
    linkerAuth,
    newHarness,
    now,
    rejection,
    tx,
    type Actor,
    type Harness,
} from '../fixtures/harness';
import { addSecondIdentity, admin, freshAuth, identitiesOf, jobsFor, verified } from '../fixtures/identity';

const userOf = (test: Harness, userId: number) => test.db.User.id.find(userId);
const mappedTo = (test: Harness, identity: Identity) => test.db.UserIdentity.identity.find(identity)?.userId;

/** planProviderLink then applyProviderLink in one transaction, for `identity` (as the internal caller). */
function merge(test: Harness, identity: Identity, providerId: string, providerName: string) {
    return test.withReducerTx(TestAuth.internal(), (ctx) => {
        const plan = planProviderLink(ctx, { provider: 'discord', providerId, providerName }, () => identity);
        applyProviderLink(ctx, plan);
        return plan.kind;
    });
}

/** planProviderLink alone; returns the refusal text, or undefined when it planned. */
function planRefusal(test: Harness, input: { provider?: string; providerId: string; providerName: string }, identity: () => Identity) {
    try {
        test.withReducerTx(TestAuth.internal(), (ctx) =>
            planProviderLink(ctx, { provider: input.provider ?? 'discord', providerId: input.providerId, providerName: input.providerName }, identity));
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

describe('T-M5a3-fix: merge branches no reducer reaches since M5a3, called directly', () => {
    it('Case 1c, the refresh of an already linked identity: the provider name is updated, username and displayName kept, linkedAt kept for the same id', () => {
        const test = newHarness();
        const v = verified(test, 'refresh');
        const before = userOf(test, v.userId)!;
        advance(test, 60_000);
        expect(merge(test, v.identity, before.providerId!, 'Renamed')).toBe('upgrade');
        expect(userOf(test, v.userId)).toMatchObject({
            isGuest: false, username: before.username, displayName: before.displayName,
            loginMethod: 'discord', providerId: before.providerId, providerUsername: 'Renamed',
        });
        expect(userOf(test, v.userId)!.linkedAt).toEqual(before.linkedAt);
    });

    it('Case 1c with another provider id: the link moves to the new id and linkedAt is set to now; the names stay', () => {
        const test = newHarness();
        const v = verified(test, 'moved');
        const before = userOf(test, v.userId)!;
        advance(test, 60_000);
        expect(merge(test, v.identity, discordId('pid-moved-2'), 'Other')).toBe('upgrade');
        expect(userOf(test, v.userId)).toMatchObject({
            username: before.username, displayName: before.displayName, providerId: discordId('pid-moved-2'), providerUsername: 'Other',
        });
        expect(userOf(test, v.userId)!.linkedAt?.microsSinceUnixEpoch).toBe(now(test));
    });

    it('the non-guest re-point: a verified user\'s identity moves to the owner of the provider id; the old user is not deleted', () => {
        const test = newHarness();
        const from = verified(test, 'from');
        const to = verified(test, 'to');
        const toPid = userOf(test, to.userId)!.providerId!;
        expect(merge(test, from.identity, toPid, 'ignored')).toBe('repoint');
        expect(mappedTo(test, from.identity)).toBe(to.userId);
        expect(userOf(test, from.userId)).toBeDefined();
        expect(userOf(test, from.userId)!.deletedAt).toBeUndefined();
        expect(jobsFor(test, from.userId)).toHaveLength(0);
        expect(identitiesOf(test, from.userId)).toHaveLength(0);
    });
});

describe('T-M5a3-fix: the merge\'s input and mapping refusals', () => {
    it('"providerId is required" is the first refusal, before the identity is resolved; nothing is written', () => {
        const test = newHarness();
        const g = guest(test, 'empty-id');
        let resolved = false;
        const msg = planRefusal(test, { providerId: '', providerName: 'Name' }, () => { resolved = true; return g.identity; });
        expect(resolved).toBe(false);
        expect(msg).toBe('providerId is required');
        expect(userOf(test, g.userId)).toMatchObject({ isGuest: true, providerId: undefined });
    });

    it('"providerId is required" is still reached by linker_present_code for a non-Discord provider (the snowflake check covers Discord only); the code stays live', () => {
        const test = newHarness();
        const g = guest(test, 'other-provider');
        tx(test, g, (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE }));
        const code = test.db.LinkRequest.identity.find(g.identity)!.code;
        let msg = '';
        try {
            test.withReducerTx(linkerAuth(test), (ctx) => M.linker_present_code(ctx, {
                linkCode: code, provider: 'facebook', providerId: '', providerName: 'X', confirmHash: TEST_CONFIRM_HASH,
            }));
        } catch (e) {
            msg = e instanceof Error ? e.message : String(e);
        }
        expect(test.db.LinkRequest.code.find(code)!.usedAt).toBeUndefined();
        expect(msg).toBe('providerId is required');
    });

    it('"Identity not registered": an identity with no UserIdentity row is refused by the plan; nothing is written', () => {
        const test = newHarness();
        const { identity } = freshAuth(test, 'unmapped');
        const usersBefore = [...test.db.User.iter()].length;
        expect(planRefusal(test, { providerId: discordId('pid-unmapped'), providerName: 'N' }, () => identity)).toBe(IDENTITY_NOT_REGISTERED_TEXT);
        expect([...test.db.User.iter()]).toHaveLength(usersBefore);
        expect(test.db.UserIdentity.identity.find(identity)).toBeFalsy();
    });

    it('"Identity not registered" is still reached at presentation when the requesting identity\'s mapping was removed after the request (the guest lives on through another identity); the code stays live', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'two-devices');
        addSecondIdentity(test, g.userId, 'two-devices-b');
        tx(test, g, (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE }));
        const code = test.db.LinkRequest.identity.find(g.identity)!.code;
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'UserIdentity', primaryKeyJson: g.identity.toHexString() }));
        expect(test.db.UserIdentity.identity.find(g.identity)).toBeFalsy();
        let msg = '';
        try {
            test.withReducerTx(linkerAuth(test), (ctx) => M.linker_present_code(ctx, {
                linkCode: code, provider: 'discord', providerId: discordId('pid-two'), providerName: 'Two', confirmHash: TEST_CONFIRM_HASH,
            }));
        } catch (e) {
            msg = e instanceof Error ? e.message : String(e);
        }
        expect(test.db.LinkRequest.code.find(code)!.usedAt).toBeUndefined();
        expect(userOf(test, g.userId)).toMatchObject({ isGuest: true, providerId: undefined });
        expect(msg).toBe(IDENTITY_NOT_REGISTERED_TEXT);
    });
});

describe('T-M5a3-fix (item 4): a linker identity never gets a UserIdentity row; the writers that create one refuse it', () => {
    /** A Linker row written directly (no server_register_linker), as a restored or hand-edited table would hold. */
    function directLinker(test: Harness, sub: string): Actor {
        const { auth, identity } = freshAuth(test, sub);
        test.db.ServerIdentity.insert({ identity, kind: { tag: 'Linker' }, label: sub, registeredAt: test.clock.now() } as any);
        return { sub, auth, identity, userId: -1 };
    }

    it('login_as_guest refuses a linker row written directly and creates no user, mapping or presence', () => {
        const test = newHarness();
        const l = directLinker(test, 'direct-linker');
        const usersBefore = [...test.db.User.iter()].length;
        expect(rejection(test, l, (ctx) => M.login_as_guest(ctx, {}))).toBe(LINKER_NOT_A_USER_TEXT);
        expect(test.db.UserIdentity.identity.find(l.identity)).toBeFalsy();
        expect(test.db.UserPresence.identity.find(l.identity)).toBeFalsy();
        expect([...test.db.User.iter()]).toHaveLength(usersBefore);
    });

    it('server_register_delegate refuses a linker identity (it would map it to the SYSTEM user): "Already registered."', () => {
        const test = newHarness();
        const l = directLinker(test, 'linker-as-delegate');
        expect(rejection(test, 'internal', (ctx) => M.server_register_delegate(ctx, { identityHex: l.identity.toHexString(), label: 'x' })))
            .toBe('Already registered.');
        expect(test.db.UserIdentity.identity.find(l.identity)).toBeFalsy();
        expect(test.db.ServerIdentity.identity.find(l.identity)!.kind.tag).toBe('Linker');
    });

    it('server_register_linker refuses an identity with a UserIdentity row written directly (here mapped to the SYSTEM user)', () => {
        const test = newHarness();
        const { identity } = freshAuth(test, 'mapped-directly');
        const systemId = test.db.User.username.find('SYSTEM')!.id;
        test.db.UserIdentity.insert({ identity, userId: systemId, lastSeenAt: test.clock.now(), ...AUDIT(test) } as any);
        expect(rejection(test, 'internal', (ctx) => M.server_register_linker(ctx, { identityHex: identity.toHexString(), label: 'x' })))
            .toBe('Identity is already linked to a user; mint a fresh identity for the linker.');
        expect(test.db.ServerIdentity.identity.find(identity)).toBeFalsy();
    });
});
