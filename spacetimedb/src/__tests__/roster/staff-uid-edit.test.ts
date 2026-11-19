// Roster: a Moderator or Admin corrects the UID of a game account (mod_update_hsr_account_uid).
// Decisions: A226 (item 4), A142, A228 (item 5)
// Contracts: docs/roster/contract.md
// From S14.5s (T-task of the step). In-memory datastore only; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, guest, lobbyRow, newHarness, rejection, tx, type Actor, type Harness } from '../fixtures/harness';
import { admin, host, moderator, verified } from '../fixtures/identity';
import { account, insertHsrAccount } from '../fixtures/roster';
import { insertCharacter, selectAccount } from '../fixtures/draft-and-scoring';
import { classic } from '../fixtures/lobby';
import { openTournament, register } from '../fixtures/tournaments';

const NOT_STAFF = 'Forbidden: Requires Moderator or Admin privileges.';
const SUSPENDED_TEXT = 'Your account is suspended.';
// T-S14.5s fix pass (review M6): the lobby refusal names the UID, not the roster.
const LOCKED = (joinCode: string) =>
    `This account is selected in active lobby ${joinCode}; its UID cannot be changed until the player's membership in that lobby ends or the lobby closes.`;
const TOURNAMENT_LOCKED =
    'Cannot change the UID of an account locked in an active tournament. Wait for the tournament to complete or be cancelled.';

const editUid = (hsrAccountId: number, uid: string) => (ctx: any) => M.mod_update_hsr_account_uid(ctx, { hsrAccountId, uid });

/** A player with one account created through create_hsr_account (UID 700000001, Europe). */
function playerWithAccount(test: Harness, name = 'pat', uid = '700000001'): { who: Actor; id: number } {
    const who = verified(test, name);
    tx(test, who, (ctx) => M.create_hsr_account(ctx, { uid, displayLabel: '' }));
    const id = [...test.db.HsrAccount.user_id.filter(who.userId)].find((a) => a.uid === uid)!.id;
    return { who, id };
}

describe('A226 item 4: staff correct a game account\'s UID', () => {
    it('a Moderator sets a new UID: the region follows it, the audit columns name the Moderator', () => {
        const test = newHarness();
        const mod = moderator(test, 'mod');
        const { id } = playerWithAccount(test);
        tx(test, mod, editUid(id, '800000002'));
        expect(account(test, id)).toMatchObject({ uid: '800000002', region: 'Asia', lastModifiedById: mod.userId, isDuplicateUid: false });
    });

    it('an Admin may do it too', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const { id } = playerWithAccount(test);
        tx(test, boss, editUid(id, '600000003'));
        expect(account(test, id)).toMatchObject({ uid: '600000003', region: 'America', lastModifiedById: boss.userId });
    });

    it('a player, a Tournament Host, the owner and a guest are refused; nothing changes', () => {
        const test = newHarness();
        const { who, id } = playerWithAccount(test);
        const other = verified(test, 'other');
        const th = host(test, 'th');
        const g = guest(test, 'g1');
        for (const caller of [who, other, th, g]) {
            expect(rejection(test, caller, editUid(id, '800000002'))).toBe(NOT_STAFF);
        }
        expect(account(test, id)!.uid).toBe('700000001');
    });

    it('a suspended Moderator is refused', () => {
        const test = newHarness();
        const mod = moderator(test, 'mod');
        const { id } = playerWithAccount(test);
        // T-S14.5s fix pass: 'mod' is reserved, so the sign-in gave the fixture another name; address it by id (A228 item 4).
        tx(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: `id:${mod.userId}`, reason: '' }));
        expect(rejection(test, mod, editUid(id, '800000002'))).toBe(SUSPENDED_TEXT);
        expect(account(test, id)!.uid).toBe('700000001');
    });

    it('the creation\'s UID checks apply', () => {
        const test = newHarness();
        const mod = moderator(test, 'mod');
        const { id } = playerWithAccount(test);
        for (const bad of ['', '12345678', '1234567890', '80000000a', ' 800000002']) {
            expect(rejection(test, mod, editUid(id, bad)), bad).toBe('UID must be exactly 9 digits');
        }
        expect(rejection(test, mod, editUid(id, '100000000'))).toBe('Invalid UID: first digit must be 6, 7, 8, or 9');
        expect(account(test, id)!.uid).toBe('700000001');
    });

    it('an unknown account is refused', () => {
        const test = newHarness();
        const mod = moderator(test, 'mod');
        expect(rejection(test, mod, editUid(4242, '800000002'))).toBe('HSR account not found');
    });

    it('the same UID is a no-op (nothing written)', () => {
        const test = newHarness();
        const mod = moderator(test, 'mod');
        const { who, id } = playerWithAccount(test);
        tx(test, mod, editUid(id, '700000001'));
        expect(account(test, id)!.lastModifiedById).toBe(who.userId);
    });

    it('duplicates as on creation: a UID another account holds is allowed and both are flagged; the old UID\'s holders are recomputed', () => {
        const test = newHarness();
        const mod = moderator(test, 'mod');
        const a = playerWithAccount(test, 'pat', '700000001');
        const b = playerWithAccount(test, 'kim', '700000001'); // a duplicate pair from the start
        const c = playerWithAccount(test, 'lee', '800000009');
        expect([account(test, a.id)!.isDuplicateUid, account(test, b.id)!.isDuplicateUid]).toEqual([true, true]);

        tx(test, mod, editUid(b.id, '800000009'));
        expect(account(test, a.id)!.isDuplicateUid).toBe(false); // the old UID now has one holder
        expect([account(test, b.id)!.isDuplicateUid, account(test, c.id)!.isDuplicateUid]).toEqual([true, true]);
    });

    for (const stage of ['Waiting', 'Drafting'] as const) {
        it(`refused while the account is selected in a ${stage} lobby (S10w); nothing changes`, () => {
            const s = classic(stage === 'Waiting');
            expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe(stage);
            const mod = moderator(s.test, 'mod');
            insertCharacter(s.test, 'A', 5);
            const id = insertHsrAccount(s.test, s.a.b1.userId, '800000001');
            s.test.db.HsrAccount.id.update({ ...s.test.db.HsrAccount.id.find(id)!, isActive: false });
            selectAccount(s.test, s.lobbyId, s.a.b1.userId, id, { A: 0 });
            expect(rejection(s.test, mod, editUid(id, '700000005'))).toBe(LOCKED(lobbyRow(s.test, s.lobbyId).joinCode));
            expect(account(s.test, id)!.uid).toBe('800000001');
        });
    }
});

// T-S14.5s fix pass (A228 item 5, review S4 and test gaps 3, 4).
describe('A228 item 5: a UID correction is refused for an account locked by an unfinished tournament', () => {
    it('a registration lock refuses a Moderator and an Admin alike; after the tournament is Cancelled the change passes', () => {
        const test = newHarness();
        const mod = moderator(test, 'mod');
        const boss = admin(test, 'boss');
        const { who, id } = playerWithAccount(test);
        const org = host(test, 'org');
        const tournamentId = openTournament(test, org);
        register(test, who, tournamentId);
        expect([...test.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, who.userId])].map((r) => r.hsrAccountId)).toEqual([id]);

        expect(rejection(test, mod, editUid(id, '800000002'))).toBe(TOURNAMENT_LOCKED);
        expect(rejection(test, boss, editUid(id, '800000002'))).toBe(TOURNAMENT_LOCKED);
        expect(account(test, id)!.uid).toBe('700000001');

        tx(test, org, (ctx) => M.cancel_tournament(ctx, { tournamentId }));
        tx(test, mod, editUid(id, '800000002'));
        expect(account(test, id)!.uid).toBe('800000002');
    });

    it('another account of the same player is not locked by that tournament', () => {
        const test = newHarness();
        const mod = moderator(test, 'mod');
        const { who, id } = playerWithAccount(test);
        tx(test, who, (ctx) => M.create_hsr_account(ctx, { uid: '600000001', displayLabel: '' }));
        const second = [...test.db.HsrAccount.user_id.filter(who.userId)].find((a) => a.uid === '600000001')!.id;
        const org = host(test, 'org');
        register(test, who, openTournament(test, org), { hsrAccountIds: [id] });
        expect(rejection(test, mod, editUid(id, '800000002'))).toBe(TOURNAMENT_LOCKED);
        tx(test, mod, editUid(second, '600000009'));
        expect(account(test, second)!.uid).toBe('600000009');
    });

    it('during maintenance mode a Moderator is refused; an Admin is not', () => {
        const test = newHarness();
        const mod = moderator(test, 'mod');
        const boss = admin(test, 'boss');
        const { id } = playerWithAccount(test);
        tx(test, 'internal', (ctx) => M.server_set_maintenance(ctx, { on: true }));
        expect(rejection(test, mod, editUid(id, '800000002'))).toMatch(/maintenance/i);
        expect(account(test, id)!.uid).toBe('700000001');
        tx(test, boss, editUid(id, '800000002'));
        expect(account(test, id)!.uid).toBe('800000002');
    });
});
