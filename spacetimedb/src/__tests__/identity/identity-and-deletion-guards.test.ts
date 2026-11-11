// Identity: server identities, provider-name clashes, admin_delete_row through the lobby removal paths, presence
//   rows, the SYSTEM user, malformed admin keys.
// Contracts: docs/auth/contract.md
// From S10e (s10e-lobby-identity.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    START,
    advance,
    captainOf,
    connect,
    disconnect,
    fireCheck,
    guest,
    joinAsSpectator,
    linkDiscord,
    lobbyRow,
    member,
    newHarness,
    pendingCheck,
    refereeIds,
    seatOf,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    AUDIT,
    rejection,
} from '../fixtures/harness';
import { verified, freshAuth, identitiesOf } from '../fixtures/identity';
import { DAY_MS } from '../fixtures/calendar';
import { insertCharacterCostLadder, insertRoster, selectAccount } from '../fixtures/draft-and-scoring';
import { joinLobby, settingsArgs, lmaRows, members, NO_PLAYER_REMOVAL } from '../fixtures/lobby';
import { byKey, duel, openMatchLobby } from '../fixtures/tournament-matches';

const SYSTEM_DELETE = 'The SYSTEM user cannot be deleted.';
const SYSTEM_CHANGE = 'The SYSTEM user cannot be changed.';
const BAD_JSON = (table: string) => `Invalid primary key for ${table}: expected JSON`;
const BAD_IDENTITY = 'Invalid primary key for UserIdentity: expected an identity hex string';
const NOT_ARRAY = 'jsonData must be a JSON array';
const LOBBY_ALIVE = (table: string, lobbyId: number) =>
    `Cannot delete a ${table} row of lobby #${lobbyId} while the lobby exists. Delete the Lobby row instead.`;
// S10e fix pass texts (review F1, F4, N9).
const TOURNAMENT_LOBBY = 'This is a tournament lobby: use rollback_bracket_match or the tournament result reducers (results permission).';
const RECORD_COUNTED = 'This lobby\'s match result is Validated or already processed: use admin_void_match or override_match_result.';
const SERVER_MAPPING = 'A server identity mapping cannot be deleted.';
const SYSTEM_MAPPING = 'A mapping of the SYSTEM user cannot be deleted.';
const systemUserId = (test: Harness) => test.db.User.username.find('SYSTEM')!.id;

// ════════════════════════════════════════════════════════════════════════════
// 9. Identity audit #1: identity GC never collects server identities or SYSTEM mappings
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit #1: identity GC and the server identities', () => {
    /** A verified user on two devices, both offline; `second` is 10 days newer. */
    function twoDevices(test: Harness, name: string) {
        const first = verified(test, name);
        const second = guest(test, `${name}-2`);
        linkDiscord(test, second, test.db.UserPrivate.userId.find(first.userId)!.providerId, name);
        advance(test, 10 * DAY_MS);
        connect(test, second);
        disconnect(test, first);
        disconnect(test, second);
        return { first, second };
    }
    const has = (test: Harness, identity: any) => !!test.db.UserIdentity.identity.find(identity);

    it('keeps every ServerIdentity identity and every SYSTEM mapping however old; still removes an ordinary stale identity (identity audit #1)', () => {
        const test = newHarness();
        const sys = systemUserId(test);
        const owner = [...test.db.ServerIdentity.iter()].find((r) => r.kind.tag === 'Owner')!.identity;
        // A SYSTEM mapping without a ServerIdentity row, as old as the owner's.
        const extra = freshAuth(test, 'system-extra').identity;
        test.db.UserIdentity.insert({ identity: extra, userId: sys, lastSeenAt: START, ...AUDIT(test) });
        advance(test, DAY_MS);
        const delegate = freshAuth(test, 'delegate').identity;
        tx(test, 'internal', (ctx) => M.server_register_delegate(ctx, { identityHex: delegate.toHexString(), label: 'bootstrap' }));

        const guarded = twoDevices(test, 'guarded'); // its older identity gets a ServerIdentity row
        test.db.ServerIdentity.insert({ identity: guarded.first.identity, kind: { tag: 'Delegate' } as any, label: 'x', registeredAt: test.clock.now() });
        const plain = twoDevices(test, 'plain');

        advance(test, 91 * DAY_MS);
        tx(test, 'internal', (ctx) => M.admin_gc_identities(ctx, {}));

        expect(has(test, owner)).toBe(true);
        expect(has(test, delegate)).toBe(true);
        expect(has(test, extra)).toBe(true);
        expect(identitiesOf(test, sys)).toHaveLength(3);
        expect(has(test, guarded.first.identity)).toBe(true);
        expect(has(test, guarded.second.identity)).toBe(true);
        expect(has(test, plain.first.identity)).toBe(false); // D-07 / D-11 unchanged for an ordinary user
        expect(has(test, plain.second.identity)).toBe(true);
        // The owner still passes the admin gate after the run.
        tx(test, 'internal', (ctx) => M.admin_update_abuse_config(ctx, { guestLobbyBurstThreshold: 51 }));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Identity audit #3: server_link_provider and a taken username
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit #3: a guest upgrade with a provider name another user holds', () => {
    const link = (test: Harness, a: Actor, providerId: string, providerName: string) => (ctx: any) =>
        M.server_link_provider(ctx, { callerIdentityHex: a.identity.toHexString(), provider: 'discord', providerId, providerName });
    const userOf = (test: Harness, a: Actor) => test.db.User.id.find(a.userId)!;

    it('a taken name links with the first free name_2, name_3 ...; the display name is the provider name (identity audit #3)', () => {
        const test = newHarness();
        const bob = verified(test, 'bob');
        expect(userOf(test, bob).username).toBe('bob');
        const g2 = guest(test, 'g2');
        tx(test, 'internal', link(test, g2, 'p-g2', 'bob'));
        expect(userOf(test, g2)).toMatchObject({ username: 'bob_2', displayName: 'bob', isGuest: false });
        const g3 = guest(test, 'g3');
        tx(test, 'internal', link(test, g3, 'p-g3', 'bob'));
        expect(userOf(test, g3).username).toBe('bob_3');
        expect(userOf(test, bob).username).toBe('bob');
    });

    it('the provider name is trimmed and cut to 32; a 32-character collision keeps the result within 32; blank is rejected (identity audit #3)', () => {
        const test = newHarness();
        const long = 'x'.repeat(40);
        const g1 = guest(test, 'g1');
        tx(test, 'internal', link(test, g1, 'p-1', `  ${long}  `));
        expect(userOf(test, g1)).toMatchObject({ username: 'x'.repeat(32), displayName: 'x'.repeat(32) });
        expect(test.db.UserPrivate.userId.find(g1.userId)?.providerUsername).toBe('x'.repeat(32));

        const g2 = guest(test, 'g2');
        tx(test, 'internal', link(test, g2, 'p-2', long));
        expect(userOf(test, g2).username).toBe(`${'x'.repeat(30)}_2`);

        const g3 = guest(test, 'g3');
        const msg = rejection(test, 'internal', link(test, g3, 'p-3', '   '));
        expect(userOf(test, g3).isGuest).toBe(true);
        expect(msg).toBe('providerName is required');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Identity audit #4: admin_delete_row on lobby rows
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit #4: admin_delete_row goes through the lobby removal paths', () => {
    const del = (tableName: string, primaryKeyJson: string) => (ctx: any) => M.admin_delete_row(ctx, { tableName, primaryKeyJson });

    /** A Drafting lobby with a ban, a password, a selected account, a chat line, a session, a result record and a pick. */
    function busyLobby(test: Harness) {
        insertRoster(test, ['c1', 'c2']);
        for (const c of ['c1', 'c2']) insertCharacterCostLadder(test, c, 'Classic', [1, 1, 1, 1, 1, 1, 1]);
        const s = setupLobby(test, {
            beforeStart: (l) => {
                const x = guest(test, 'x');
                joinLobby(test, x, l.lobbyId);
                tx(test, l.host, (ctx) => M.ban_member(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, x.userId) }));
                tx(test, l.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(l.lobbyId, { isPublic: false, password: 'pw' })));
                for (const n of ['b1', 'b2', 'r1', 'r2']) tx(test, l.a[n], (ctx) => M.confirm_ready(ctx, { lobbyId: l.lobbyId }));
                selectAccount(test, l.lobbyId, l.a.b1.userId, 900, { c1: 0 });
            },
        });
        tx(test, s.a.b1, (ctx) => M.send_chat_message(ctx, { lobbyId: s.lobbyId, content: 'gl', metadata: '' }));
        const blueCaptain = captainOf(test, s.lobbyId, 'BluePlayer')!.userId;
        const captain = Object.values(s.a).find((a) => a.userId === blueCaptain)!;
        tx(test, captain, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'c1', eidolon: 0 }));
        return s;
    }

    const lobbyChildren = (test: Harness, lobbyId: number) => {
        const byLobby = (rows: Iterable<any>) => [...rows].filter((r) => r.lobbyId === lobbyId).length;
        return {
            ChatMessage: byLobby(test.db.ChatMessage.iter()),
            LobbyBan: byLobby(test.db.LobbyBan.iter()),
            LobbyMember: byLobby(test.db.LobbyMember.iter()),
            LobbyMemberAccount: byLobby(test.db.LobbyMemberAccount.iter()),
            LobbyPassword: byLobby(test.db.LobbyPassword.iter()),
            MatchLineup: byLobby(test.db.MatchLineup.iter()),
            MatchSession: byLobby(test.db.MatchSession.iter()),
            MatchSessionStep: byLobby(test.db.MatchSessionStep.iter()),
            MatchResultRecord: byLobby(test.db.MatchResultRecord.iter()),
        };
    };
    const resultChildren = (test: Harness, recordIds: number[]) => {
        const byRecord = (rows: Iterable<any>) => [...rows].filter((r) => recordIds.includes(r.matchResultId)).length;
        return {
            MatchResultParticipant: byRecord(test.db.MatchResultParticipant.iter()),
            MatchResultGame: byRecord(test.db.MatchResultGame.iter()),
            MatchResultGroupScore: byRecord(test.db.MatchResultGroupScore.iter()),
            MatchResultAdjustment: byRecord(test.db.MatchResultAdjustment.iter()),
        };
    };

    it('Lobby in Drafting: the D-19 cascade leaves no row in any child table the lobby GC clears (identity audit #4)', () => {
        const test = newHarness();
        const s = busyLobby(test);
        const before = lobbyChildren(test, s.lobbyId);
        for (const table of ['ChatMessage', 'LobbyBan', 'LobbyMember', 'LobbyMemberAccount', 'LobbyPassword', 'MatchSession', 'MatchSessionStep', 'MatchResultRecord'] as const) {
            expect(before[table], `${table} set up`).toBeGreaterThan(0);
        }
        const recordIds = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)].map((r) => r.id);
        expect(resultChildren(test, recordIds).MatchResultParticipant).toBeGreaterThan(0);

        tx(test, 'internal', del('Lobby', String(s.lobbyId)));

        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(Object.values(lobbyChildren(test, s.lobbyId)).every((n) => n === 0), JSON.stringify(lobbyChildren(test, s.lobbyId))).toBe(true);
        expect(Object.values(resultChildren(test, recordIds)).every((n) => n === 0), JSON.stringify(resultChildren(test, recordIds))).toBe(true);
    });

    it('LobbyMember: the removed host\'s flags move (A22(5)), the count drops and the removed player\'s account rows go (identity audit #4)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        selectAccount(test, s.lobbyId, s.a.b2.userId, 900, { c1: 0 });
        const count = lobbyRow(test, s.lobbyId).currentPlayerCount;
        expect(count).toBe(members(test, s.lobbyId).length);

        tx(test, 'internal', del('LobbyMember', JSON.stringify({ lobbyId: s.lobbyId, userId: s.host.userId })));
        expect(member(test, s.lobbyId, s.host.userId)).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count - 1);

        tx(test, 'internal', del('LobbyMember', JSON.stringify({ lobbyId: s.lobbyId, userId: s.a.b2.userId })));
        expect(member(test, s.lobbyId, s.a.b2.userId)).toBeUndefined();
        expect(lmaRows(test, s.lobbyId, s.a.b2.userId)).toHaveLength(0);
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count - 2);
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(members(test, s.lobbyId).length);
    });

    it('Lobby: a tournament lobby is refused and nothing is deleted (S10e review F1, D.8.3)', () => {
        const f = duel();
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        const test = f.test;
        expect(lobbyRow(test, s.lobbyId).isTournamentControlled).toBe(true);
        const before = lobbyChildren(test, s.lobbyId);
        expect(before.MatchResultRecord).toBe(1);
        const msg = rejection(test, 'internal', del('Lobby', String(s.lobbyId)));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeTruthy();
        expect(lobbyChildren(test, s.lobbyId)).toEqual(before);
        expect(msg).toBe(TOURNAMENT_LOBBY);
    });

    it('Lobby: a lobby whose record is Validated, or already processed, is refused and nothing is deleted (S10e review F1, D-56)', () => {
        for (const mark of ['Validated', 'processed'] as const) {
            const test = newHarness();
            const s = setupLobby(test);
            const record = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0];
            test.db.MatchResultRecord.id.update(mark === 'Validated'
                ? { ...record, status: { tag: 'Validated' } as any }
                : { ...record, status: { tag: 'Submitted' } as any, mmrProcessedAt: test.clock.now() });
            const before = lobbyChildren(test, s.lobbyId);
            const msg = rejection(test, 'internal', del('Lobby', String(s.lobbyId)));
            expect(test.db.Lobby.id.find(s.lobbyId), mark).toBeTruthy();
            expect(lobbyChildren(test, s.lobbyId), mark).toEqual(before);
            expect(msg, mark).toBe(RECORD_COUNTED);
        }
    });

    it('LobbyMember: a seated player is refused in Drafting (row kept); a spectator row is still removed (S10e review F4, A68(6))', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const spec = joinAsSpectator(s, 'spec');
        const count = lobbyRow(test, s.lobbyId).currentPlayerCount;
        const key = (userId: number) => JSON.stringify({ lobbyId: s.lobbyId, userId });

        const msg = rejection(test, 'internal', del('LobbyMember', key(s.a.b2.userId)));
        expect(member(test, s.lobbyId, s.a.b2.userId)).toBeDefined();
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count);
        expect(msg).toBe(NO_PLAYER_REMOVAL);

        tx(test, 'internal', del('LobbyMember', key(spec.userId)));
        expect(member(test, s.lobbyId, spec.userId)).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count - 1);
    });

    it('MatchSession / MatchSessionStep: refused while the lobby exists, allowed for orphans (identity audit #4)', () => {
        const test = newHarness();
        const s = busyLobby(test);
        const stepId = steps(test, s.lobbyId)[0].id;
        for (const [table, key] of [['MatchSession', String(s.lobbyId)], ['MatchSessionStep', String(stepId)]] as const) {
            const msg = rejection(test, 'internal', del(table, key));
            expect(test.db.MatchSession.lobbyId.find(s.lobbyId)).toBeTruthy();
            expect(test.db.MatchSessionStep.id.find(stepId)).toBeTruthy();
            expect(msg).toBe(LOBBY_ALIVE(table, s.lobbyId));
        }

        test.db.Lobby.id.delete(s.lobbyId); // an orphaned session and step (raw delete, as before S10e)
        tx(test, 'internal', del('MatchSessionStep', String(stepId)));
        expect(test.db.MatchSessionStep.id.find(stepId)).toBeFalsy();
        tx(test, 'internal', del('MatchSession', String(s.lobbyId)));
        expect(test.db.MatchSession.lobbyId.find(s.lobbyId)).toBeFalsy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Identity audit #5: identity rows and presence
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit #5: an identity goes with its presence row', () => {
    const delIdentity = (hex: string) => (ctx: any) => M.admin_delete_row(ctx, { tableName: 'UserIdentity', primaryKeyJson: hex });

    it('admin_delete_row(\'UserIdentity\'): the mapping and its live presence row go; the user and its other identity stay (identity audit #5)', () => {
        const test = newHarness();
        const desk = verified(test, 'u');
        const phone = guest(test, 'u-phone');
        linkDiscord(test, phone, test.db.UserPrivate.userId.find(desk.userId)!.providerId, 'u');
        expect(phone.userId).toBe(desk.userId);
        connect(test, phone);
        expect(test.db.UserPresence.identity.find(phone.identity)?.isOnline).toBe(true);

        tx(test, 'internal', delIdentity(phone.identity.toHexString()));
        expect(test.db.UserIdentity.identity.find(phone.identity)).toBeFalsy();
        expect(test.db.UserPresence.identity.find(phone.identity)).toBeFalsy();
        expect(test.db.User.id.find(desk.userId)).toBeTruthy();
        expect(test.db.UserIdentity.identity.find(desk.identity)).toBeTruthy();
    });

    it('a malformed key is rejected with its text; an unknown identity is "Row not found" (identity audit #5, #14)', () => {
        const test = newHarness();
        const before = [...test.db.UserIdentity.iter()].length;
        const msg = rejection(test, 'internal', delIdentity('not-a-hex'));
        expect([...test.db.UserIdentity.iter()]).toHaveLength(before);
        expect(msg).toBe(BAD_IDENTITY);
        expect(rejection(test, 'internal', delIdentity(freshAuth(test, 'nobody').identity.toHexString()))).toBe('Row not found');
    });

    it('a guest left with no identity is deleted, and the same browser can log in as a guest again (identity audit #5)', () => {
        const test = newHarness();
        const g = guest(test, 'lonely');
        tx(test, 'internal', delIdentity(g.identity.toHexString()));
        expect(test.db.User.id.find(g.userId)).toBeFalsy();
        expect(test.db.UserPresence.identity.find(g.identity)).toBeFalsy();

        tx(test, g, (ctx) => M.login_as_guest(ctx, {}));
        const again = test.db.UserIdentity.identity.find(g.identity);
        expect(again).toBeTruthy();
        expect(again!.userId).not.toBe(g.userId);
    });

    it('the deleted identity was the user\'s only live one: the Drafting membership goes offline (stamped) and the 15 s check is pending; it moves the captaincy (S10e review F5, A22a)', () => {
        const test = newHarness();
        const b1 = verified(test, 'b1');
        const s = setupLobby(test, { actors: { b1 } });
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(b1.userId);
        expect(member(test, s.lobbyId, b1.userId).isOnline).toBe(true);
        expect(identitiesOf(test, b1.userId)).toHaveLength(1);

        tx(test, 'internal', delIdentity(b1.identity.toHexString()));
        expect(test.db.User.id.find(b1.userId)).toBeTruthy();
        const m = member(test, s.lobbyId, b1.userId);
        expect(m.isOnline).toBe(false);
        expect(m.disconnectedAt?.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch); // Standard policy
        const check = pendingCheck(test, s.lobbyId, b1.userId);
        advance(test, 15_000);
        fireCheck(test, check);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.a.b2.userId);
    });

    it('a user who keeps another live identity stays online; nothing is scheduled (S10e review F5)', () => {
        const test = newHarness();
        const desk = verified(test, 'u');
        const phone = guest(test, 'u-phone');
        linkDiscord(test, phone, test.db.UserPrivate.userId.find(desk.userId)!.providerId, 'u');
        connect(test, phone);
        const s = setupLobby(test, { actors: { b1: desk } });
        tx(test, 'internal', delIdentity(phone.identity.toHexString()));
        expect(member(test, s.lobbyId, desk.userId).isOnline).toBe(true);
        expect([...test.db.RefereeTransferCheck.by_lobby_and_user.filter([s.lobbyId, desk.userId])]).toHaveLength(0);
    });

    it('a server identity mapping and a SYSTEM mapping are refused; both stay (S10e review N9, identity audit #1)', () => {
        const test = newHarness();
        const sys = systemUserId(test);
        const owner = [...test.db.ServerIdentity.iter()].find((r) => r.kind.tag === 'Owner')!.identity;
        const extra = freshAuth(test, 'system-extra').identity; // a SYSTEM mapping without a ServerIdentity row
        test.db.UserIdentity.insert({ identity: extra, userId: sys, lastSeenAt: START, ...AUDIT(test) });
        for (const [identity, text] of [[owner, SERVER_MAPPING], [extra, SYSTEM_MAPPING]] as const) {
            const msg = rejection(test, 'internal', delIdentity(identity.toHexString()));
            expect(test.db.UserIdentity.identity.find(identity)).toBeTruthy();
            expect(msg).toBe(text);
        }
        expect(identitiesOf(test, sys)).toHaveLength(2);
    });

    it('server_revoke_delegate deletes the delegate\'s presence row with its mapping (identity audit #5)', () => {
        const test = newHarness();
        const d = freshAuth(test, 'delegate');
        tx(test, 'internal', (ctx) => M.server_register_delegate(ctx, { identityHex: d.identity.toHexString(), label: 'vercel' }));
        test.withReducerTx(d.auth, (ctx) => M.client_connected(ctx, {}));
        expect(test.db.UserPresence.identity.find(d.identity)?.isOnline).toBe(true);

        tx(test, 'internal', (ctx) => M.server_revoke_delegate(ctx, { identityHex: d.identity.toHexString() }));
        expect(test.db.ServerIdentity.identity.find(d.identity)).toBeFalsy();
        expect(test.db.UserIdentity.identity.find(d.identity)).toBeFalsy();
        expect(test.db.UserPresence.identity.find(d.identity)).toBeFalsy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Identity audit LOW #9 and #14: the SYSTEM user; malformed admin payloads
// ════════════════════════════════════════════════════════════════════════════

describe('identity audit LOW #9: the SYSTEM user cannot be deleted or changed', () => {
    it('admin_delete_row(\'User\'), admin_update_user, server_delete_user and server_set_role reject SYSTEM; the row is unchanged (identity audit #9)', () => {
        const test = newHarness();
        const sys = systemUserId(test);
        const snap = () => {
            const u = test.db.User.id.find(sys)!;
            return `${u.username}|${u.displayName}|${u.role.tag}|${u.deletedAt === undefined}`;
        };
        const before = snap();
        const cases: Array<[(ctx: any) => unknown, string]> = [
            [(ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(sys) }), SYSTEM_DELETE],
            [(ctx) => M.admin_update_user(ctx, { userId: sys, displayName: 'x', username: 'x', roleTag: 'User' }), SYSTEM_CHANGE],
            [(ctx) => M.server_delete_user(ctx, { username: 'SYSTEM' }), SYSTEM_DELETE],
            [(ctx) => M.server_set_role(ctx, { username: 'SYSTEM', roleTag: 'User' }), SYSTEM_CHANGE],
        ];
        for (const [body, text] of cases) {
            const msg = rejection(test, 'internal', body);
            expect(snap()).toBe(before);
            expect(msg).toBe(text);
        }
        expect(before).toBe('SYSTEM|SYSTEM|Admin|true');
        expect([...test.db.UserDeletionJob.iter()]).toHaveLength(0);
        expect(identitiesOf(test, sys)).toHaveLength(1);
        // Another user is still editable.
        const u = guest(test, 'u');
        tx(test, 'internal', (ctx) => M.admin_update_user(ctx, { userId: u.userId, displayName: 'Renamed', username: 'renamed', roleTag: 'User' }));
        expect(test.db.User.id.find(u.userId)?.username).toBe('renamed');
    });
});

describe('identity audit LOW #14: malformed admin keys and payloads get their texts', () => {
    it('admin_delete_row with a malformed JSON key names the table; admin_bulk_upsert answers unparsable and non-array payloads (identity audit #14)', () => {
        const test = newHarness();
        for (const table of ['LobbyMember', 'HsrCharacterCost', 'HsrLightconeCost', 'HsrCharacterArchetype', 'MatchSessionStepHistory']) {
            expect(rejection(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: table, primaryKeyJson: '{bad' })), table).toBe(BAD_JSON(table));
            // S10e review N3: valid JSON that is not an object gets the same text.
            for (const key of ['null', '5', '"x"']) {
                expect(rejection(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: table, primaryKeyJson: key })), `${table} ${key}`).toBe(BAD_JSON(table));
            }
        }
        for (const jsonData of ['not json', '{}', '"x"']) {
            expect(rejection(test, 'internal', (ctx) => M.admin_bulk_upsert(ctx, { tableName: 'HsrCharacter', jsonData })), jsonData).toBe(NOT_ARRAY);
        }
    });
});
