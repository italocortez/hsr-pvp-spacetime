// Roster: displayLabel length and isDuplicateUid after a user deletion.
// Contracts: docs/roster/contract.md
// From S10f (s10f-draft-results.test.ts).
import { describe, expect, it } from 'vitest';
import { M, newHarness, tx, rejection } from '../fixtures/harness';
import { verified } from '../fixtures/identity';
import { account, createAccount } from '../fixtures/roster';

// ════════════════════════════════════════════════════════════════════════════
// Roster #5, #6, #9, #10
// ════════════════════════════════════════════════════════════════════════════

describe('Roster #5: displayLabel at most 32 characters (roster architecture S10f)', () => {
    const LONG = 'Display label cannot exceed 32 characters';
    const L32 = 'x'.repeat(32);
    const L33 = 'x'.repeat(33);

    it('create_hsr_account / update_hsr_account: 32 pass (trimmed), 33 rejected with the text (roster audit #5)', () => {
        const test = newHarness();
        const p = verified(test, 'p');
        expect(rejection(test, p, (ctx) => M.create_hsr_account(ctx, { uid: '800000001', displayLabel: L33 }))).toBe(LONG);
        expect([...test.db.HsrAccount.user_id.filter(p.userId)]).toHaveLength(0);
        const id = createAccount(test, p, '800000001', `  ${L32}  `);
        expect(account(test, id)!.displayLabel).toBe(L32);
        const upd = (label: string) => (ctx: any) => M.update_hsr_account(ctx, { hsrAccountId: id, displayLabel: label, isRosterPublic: false, isRatingPublic: false });
        expect(rejection(test, p, upd(L33))).toBe(LONG);
        tx(test, p, upd('y'.repeat(32)));
        expect(account(test, id)!.displayLabel).toBe('y'.repeat(32));
    });

    it('admin_create_hsr_account / admin_update_hsr_account: the same cap (roster audit #5)', () => {
        const test = newHarness();
        const p = verified(test, 'p');
        expect(rejection(test, 'internal', (ctx) => M.admin_create_hsr_account(ctx, { targetUserId: p.userId, uid: '800000002', displayLabel: L33 }))).toBe(LONG);
        tx(test, 'internal', (ctx) => M.admin_create_hsr_account(ctx, { targetUserId: p.userId, uid: '800000002', displayLabel: L32 }));
        const [acct] = [...test.db.HsrAccount.user_id.filter(p.userId)];
        expect(acct.displayLabel).toBe(L32);
        const upd = (label: string) => (ctx: any) => M.admin_update_hsr_account(ctx, { hsrAccountId: acct.id, displayLabel: label, isRosterPublic: false, isRatingPublic: false });
        expect(rejection(test, 'internal', upd(L33))).toBe(LONG);
        expect(account(test, acct.id)!.displayLabel).toBe(L32);
        tx(test, 'internal', upd('z'.repeat(32)));
        expect(account(test, acct.id)!.displayLabel).toBe('z'.repeat(32));
    });
});

describe('Roster #6: user deletion recomputes isDuplicateUid (roster architecture S10f)', () => {
    it('after deleting a user who shared a UID, the other holder\'s duplicate flag is cleared (roster audit #6)', () => {
        const test = newHarness();
        const a = verified(test, 'a');
        const b = verified(test, 'b');
        createAccount(test, a, '800000001');
        const theirs = createAccount(test, b, '800000001');
        expect(account(test, theirs)!.isDuplicateUid).toBe(true);
        tx(test, a, (ctx) => M.delete_my_account(ctx, {}));
        expect([...test.db.HsrAccount.user_id.filter(a.userId)]).toHaveLength(0);
        expect(account(test, theirs)!.isDuplicateUid).toBe(false);
    });
});
