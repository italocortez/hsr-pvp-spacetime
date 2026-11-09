// T-S10 batch C2: the roster live suite (test/backend/roster/{archetype-crud, roster-accounts, roster-characters,
// roster-migration, migrate-roster-rating, account-deletion-guard}) ported to the in-memory harness (SpacetimeDB
// test-utils; nothing reaches maincloud). Every it cites its clause of docs/roster/contract.md or
// docs/archetypes/contract.md (Error Cases rows, Acceptance Scenarios, Edge Cases; ROST-GUARD-01 = the Phase 12.3 D-G
// lobby guards, D-24 / D-25 = the Phase 10.4 deletion guards). LobbyMemberAccount rows come from join_lobby's
// auto-select of the active account; the TournamentPlayerAccount lock from register_for_tournament.
import { describe, expect, it } from 'vitest';
import { M, advance, guest, newHarness, setupLobby, tx, type Actor, type Harness } from './s4-fixtures';
import { host as tournamentHost, openTournament, register, setUserRole, verified } from './s8-fixtures';
import {
    HOUR_MS,
    account,
    accountsOf,
    charsOf,
    createAccount,
    rejection,
    roster,
    seedCharacters,
    seedRatingData,
} from './s10-c2-fixtures';

const CHARS = ['acheron', 'aglaea', 'kafka'];

function world() {
    const test = newHarness();
    seedCharacters(test, CHARS);
    const p = verified(test, 'rosterp');
    return { test, p };
}

function admin(test: Harness, name = 'rosteradmin'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

/** `who` joins a Waiting lobby as a Blue player; join_lobby auto-selects their active account. Returns the join code. */
function joinLobbyWithActiveAccount(test: Harness, who: Actor): { lobbyId: number; joinCode: string } {
    const s = setupLobby(test, { actors: { b1: who }, seats: [['b1', 'BluePlayer']], noStart: true });
    const joinCode = test.db.Lobby.id.find(s.lobbyId)!.joinCode;
    expect(joinCode.length).toBeGreaterThan(0); // so a "cites the join code" assertion cannot pass on ''
    return { lobbyId: s.lobbyId, joinCode };
}

const lmaOf = (test: Harness, accountId: number) => [...test.db.LobbyMemberAccount.by_account.filter(accountId)];
const archetype = (test: Harness, name: string) => test.db.Archetype.name.find(name) ?? undefined;
const assignments = (test: Harness) =>
    [...test.db.HsrCharacterArchetype.iter()].map((r) => `${r.characterName}:${r.archetypeId}`).sort();

// ─── Archetypes (docs/archetypes/contract.md; docs/roster/contract.md "Admin Permission Guards") ─────────────────

describe('admin permission guards', () => {
    const calls: Array<[string, (ctx: any) => unknown]> = [
        ['admin_upsert_archetype', (ctx) => M.admin_upsert_archetype(ctx, { name: 'x', description: '' })],
        ['admin_delete_archetype', (ctx) => M.admin_delete_archetype(ctx, { archetypeId: 1 })],
        ['admin_assign_character_archetypes', (ctx) => M.admin_assign_character_archetypes(ctx, { characterName: 'acheron', archetypeIdsJson: '[1]' })],
        ['admin_remove_character_archetypes', (ctx) => M.admin_remove_character_archetypes(ctx, { characterName: 'acheron', archetypeIdsJson: '[1]' })],
        ['admin_create_hsr_account', (ctx) => M.admin_create_hsr_account(ctx, { targetUserId: 1, uid: '800000001', displayLabel: '' })],
        ['admin_update_hsr_account', (ctx) => M.admin_update_hsr_account(ctx, { hsrAccountId: 1, displayLabel: 'x', isRosterPublic: true, isRatingPublic: true })],
        ['admin_delete_hsr_account', (ctx) => M.admin_delete_hsr_account(ctx, { hsrAccountId: 1 })],
        ['admin_batch_upsert_characters', (ctx) => M.admin_batch_upsert_characters(ctx, { hsrAccountId: 1, charactersJson: roster(['acheron']) })],
        ['admin_batch_remove_characters', (ctx) => M.admin_batch_remove_characters(ctx, { hsrAccountId: 1, characterNamesJson: '["acheron"]' })],
    ];

    it.each(calls)('scenario "Admin Permission Guards": a guest calling %s is rejected with "Forbidden: Requires Admin privileges."', (_name, body) => {
        const test = newHarness();
        seedCharacters(test, CHARS);
        const g = guest(test, 'rosterguest');
        expect(rejection(test, g, body)).toContain('Forbidden: Requires Admin privileges.');
    });
});

describe('archetypes', () => {
    it('admin_upsert_archetype: inserts a trimmed name; a second upsert by name updates the description only and keeps created* (flow 4-5)', () => {
        const { test } = world();
        const a = admin(test);
        tx(test, a, (ctx) => M.admin_upsert_archetype(ctx, { name: '  Sustain  ', description: 'first' }));
        const first = archetype(test, 'Sustain')!;
        expect(first.description).toBe('first');
        advance(test, HOUR_MS);
        tx(test, a, (ctx) => M.admin_upsert_archetype(ctx, { name: 'Sustain', description: 'second' }));
        const second = archetype(test, 'Sustain')!;
        expect(second.id).toBe(first.id);
        expect(second.description).toBe('second');
        expect(second.createdDate).toEqual(first.createdDate);
        expect(second.lastModifiedDate.microsSinceUnixEpoch).toBeGreaterThan(first.lastModifiedDate.microsSinceUnixEpoch);
        expect([...test.db.Archetype.iter()]).toHaveLength(1);
    });

    it('admin_upsert_archetype error "Empty name (after trim)": "Archetype name cannot be empty"', () => {
        const { test } = world();
        expect(rejection(test, admin(test), (ctx) => M.admin_upsert_archetype(ctx, { name: '   ', description: '' }))).toContain('Archetype name cannot be empty');
        expect([...test.db.Archetype.iter()]).toEqual([]);
    });

    it('admin_assign_character_archetypes: idempotent, all-or-nothing ("Archetype #{id} not found"), unknown character "Character not found"', () => {
        const { test } = world();
        const a = admin(test);
        tx(test, a, (ctx) => M.admin_upsert_archetype(ctx, { name: 'DoT', description: '' }));
        tx(test, a, (ctx) => M.admin_upsert_archetype(ctx, { name: 'Debuff', description: '' }));
        const [dot, debuff] = [archetype(test, 'DoT')!.id, archetype(test, 'Debuff')!.id];
        tx(test, a, (ctx) => M.admin_assign_character_archetypes(ctx, { characterName: 'kafka', archetypeIdsJson: JSON.stringify([dot, dot]) }));
        tx(test, a, (ctx) => M.admin_assign_character_archetypes(ctx, { characterName: 'kafka', archetypeIdsJson: JSON.stringify([dot]) }));
        expect(assignments(test)).toEqual([`kafka:${dot}`]);

        expect(rejection(test, a, (ctx) => M.admin_assign_character_archetypes(ctx, { characterName: 'kafka', archetypeIdsJson: JSON.stringify([debuff, 9999]) })))
            .toContain('Archetype #9999 not found');
        expect(assignments(test)).toEqual([`kafka:${dot}`]);
        expect(rejection(test, a, (ctx) => M.admin_assign_character_archetypes(ctx, { characterName: 'nobody', archetypeIdsJson: JSON.stringify([dot]) })))
            .toContain('Character not found');
    });

    it('admin_remove_character_archetypes: all-or-nothing, "Character \\"{name}\\" is not assigned to archetype #{id}"', () => {
        const { test } = world();
        const a = admin(test);
        tx(test, a, (ctx) => M.admin_upsert_archetype(ctx, { name: 'DoT', description: '' }));
        tx(test, a, (ctx) => M.admin_upsert_archetype(ctx, { name: 'Debuff', description: '' }));
        const [dot, debuff] = [archetype(test, 'DoT')!.id, archetype(test, 'Debuff')!.id];
        tx(test, a, (ctx) => M.admin_assign_character_archetypes(ctx, { characterName: 'kafka', archetypeIdsJson: JSON.stringify([dot]) }));
        const msg = rejection(test, a, (ctx) => M.admin_remove_character_archetypes(ctx, { characterName: 'kafka', archetypeIdsJson: JSON.stringify([dot, debuff]) }));
        expect(assignments(test)).toEqual([`kafka:${dot}`]);
        expect(msg).toContain(`Character "kafka" is not assigned to archetype #${debuff}`);
        tx(test, a, (ctx) => M.admin_remove_character_archetypes(ctx, { characterName: 'kafka', archetypeIdsJson: JSON.stringify([dot]) }));
        expect(assignments(test)).toEqual([]);
    });

    it('admin_delete_archetype cascades its character assignments; a missing id is rejected with "Archetype not found"', () => {
        const { test } = world();
        const a = admin(test);
        tx(test, a, (ctx) => M.admin_upsert_archetype(ctx, { name: 'DoT', description: '' }));
        tx(test, a, (ctx) => M.admin_upsert_archetype(ctx, { name: 'Debuff', description: '' }));
        const [dot, debuff] = [archetype(test, 'DoT')!.id, archetype(test, 'Debuff')!.id];
        tx(test, a, (ctx) => M.admin_assign_character_archetypes(ctx, { characterName: 'kafka', archetypeIdsJson: JSON.stringify([dot, debuff]) }));
        tx(test, a, (ctx) => M.admin_assign_character_archetypes(ctx, { characterName: 'acheron', archetypeIdsJson: JSON.stringify([dot]) }));
        tx(test, a, (ctx) => M.admin_delete_archetype(ctx, { archetypeId: dot }));
        expect(archetype(test, 'DoT')).toBeUndefined();
        expect(assignments(test)).toEqual([`kafka:${debuff}`]);
        expect(rejection(test, a, (ctx) => M.admin_delete_archetype(ctx, { archetypeId: dot }))).toContain('Archetype not found');
    });
});

// ─── HSR accounts ────────────────────────────────────────────────────────────

describe('HSR accounts', () => {
    it('scenario "Account Creation (happy path)": region Asia, active, isRosterPublic / isRatingPublic false, isDuplicateUid false', () => {
        const { test, p } = world();
        const id = createAccount(test, p, '800000099', 'Asia Account');
        expect(account(test, id)).toMatchObject({
            userId: p.userId, uid: '800000099', region: 'Asia', displayLabel: 'Asia Account',
            isActive: true, isRosterPublic: false, isRatingPublic: false, isDuplicateUid: false, accountRating: 0,
        });
    });

    it('create_hsr_account flow 3 + 6: 6 / 7 / 9 map to America / Europe / TW_HK_MO; only the first account auto-activates', () => {
        const { test, p } = world();
        const ids = ['600000001', '700000001', '900000001'].map((uid) => createAccount(test, p, uid, uid));
        expect(ids.map((id) => account(test, id)!.region)).toEqual(['America', 'Europe', 'TW_HK_MO']);
        expect(ids.map((id) => account(test, id)!.isActive)).toEqual([true, false, false]);
    });

    it('scenario "Auto-Label on Empty Display Name": "Account N"', () => {
        const { test, p } = world();
        createAccount(test, p, '800000001', 'first');
        const id = createAccount(test, p, '800000002', '   ');
        expect(account(test, id)!.displayLabel).toBe('Account 2');
    });

    it('scenario "Account Limit Enforcement": the 6th account is rejected with "Maximum 5"', () => {
        const { test, p } = world();
        for (let i = 1; i <= 5; i++) createAccount(test, p, `80000000${i}`);
        const msg = rejection(test, p, (ctx) => M.create_hsr_account(ctx, { uid: '800000006', displayLabel: 'Sixth' }));
        expect(accountsOf(test, p.userId)).toHaveLength(5);
        expect(msg).toContain('Maximum 5');
    });

    it('scenarios "UID Validation — Too Short" / edge case "UID with spaces": "UID must be exactly 9 digits"', () => {
        const { test, p } = world();
        for (const uid of ['8001234', '800 12345', '8000000001', '80000000a']) {
            expect(rejection(test, p, (ctx) => M.create_hsr_account(ctx, { uid, displayLabel: 'Bad' }))).toContain('UID must be exactly 9 digits');
        }
        expect(accountsOf(test, p.userId)).toEqual([]);
    });

    it('scenario "UID Validation — Bad Region" / edge case "UID starting with 0": "first digit must be 6, 7, 8, or 9"', () => {
        const { test, p } = world();
        for (const uid of ['100000001', '000000001', '500000001']) {
            expect(rejection(test, p, (ctx) => M.create_hsr_account(ctx, { uid, displayLabel: 'Bad' }))).toContain('first digit must be 6, 7, 8, or 9');
        }
        expect(accountsOf(test, p.userId)).toEqual([]);
    });

    it('create_hsr_account error "Guest caller": a verified-user rejection', () => {
        const test = newHarness();
        const g = guest(test, 'rosterguest');
        expect(rejection(test, g, (ctx) => M.create_hsr_account(ctx, { uid: '800000001', displayLabel: '' }))).toMatch(/verified/i);
        expect(accountsOf(test, g.userId)).toEqual([]);
    });

    it('scenario "Update Account Fields": label, isRosterPublic and isRatingPublic all change; UID and region are untouched', () => {
        const { test, p } = world();
        const id = createAccount(test, p, '800000001', 'old');
        tx(test, p, (ctx) => M.update_hsr_account(ctx, { hsrAccountId: id, displayLabel: '  Updated ', isRosterPublic: true, isRatingPublic: true }));
        expect(account(test, id)).toMatchObject({ displayLabel: 'Updated', isRosterPublic: true, isRatingPublic: true, uid: '800000001', region: 'Asia' });
    });

    it('scenario "Update Rejects Blank Label": "cannot be empty"; update_hsr_account error "Not account owner": a permission error', () => {
        const { test, p } = world();
        const other = verified(test, 'rosterother');
        const id = createAccount(test, p, '800000001', 'keep');
        expect(rejection(test, p, (ctx) => M.update_hsr_account(ctx, { hsrAccountId: id, displayLabel: '   ', isRosterPublic: true, isRatingPublic: true })))
            .toContain('cannot be empty');
        expect(rejection(test, other, (ctx) => M.update_hsr_account(ctx, { hsrAccountId: id, displayLabel: 'mine', isRosterPublic: true, isRatingPublic: true })))
            .toMatch(/not your account/i);
        expect(account(test, id)).toMatchObject({ displayLabel: 'keep', isRosterPublic: false, isRatingPublic: false });
    });

    it('the two public toggles drive view_public_hsr_accounts (Integration Points): hidden roster absent; a public roster shows its rating only when isRatingPublic', () => {
        const test = newHarness();
        seedRatingData(test);
        const p = verified(test, 'rosterpub');
        const id = createAccount(test, p, '800000001', 'pub');
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: roster(['c1', 'c2']) }));
        const rating = account(test, id)!.accountRating;
        expect(rating).toBeGreaterThan(0);
        const publicRows = () => ((M as any).view_public_hsr_accounts(test.anonymousViewContext(), {}) as any[]).filter((r) => r.accountId === id);
        const setFlags = (isRosterPublic: boolean, isRatingPublic: boolean) =>
            tx(test, p, (ctx) => M.update_hsr_account(ctx, { hsrAccountId: id, displayLabel: 'pub', isRosterPublic, isRatingPublic }));

        expect(publicRows()).toEqual([]);
        setFlags(true, false);
        expect(publicRows().map((r) => r.characterName).sort()).toEqual(['c1', 'c2']);
        expect(publicRows().every((r) => r.accountRating === undefined)).toBe(true);
        setFlags(true, true);
        expect(publicRows().every((r) => r.accountRating === rating)).toBe(true);
        setFlags(false, true);
        expect(publicRows()).toEqual([]);
    });

    it('scenarios "Set Active — Switch" and "Set Active — No-Op"', () => {
        const { test, p } = world();
        const a = createAccount(test, p, '800000001', 'A');
        const b = createAccount(test, p, '800000002', 'B');
        tx(test, p, (ctx) => M.set_active_hsr_account(ctx, { hsrAccountId: b }));
        expect([account(test, a)!.isActive, account(test, b)!.isActive]).toEqual([false, true]);
        tx(test, p, (ctx) => M.set_active_hsr_account(ctx, { hsrAccountId: b }));
        expect([account(test, a)!.isActive, account(test, b)!.isActive]).toEqual([false, true]);
    });

    it('scenario "Set Active — D-G Guard" (ROST-GUARD-01, WIDE): the active account bound to a live lobby blocks the switch; the error cites the join code', () => {
        const { test, p } = world();
        const a = createAccount(test, p, '800000001', 'A');
        const b = createAccount(test, p, '800000002', 'B');
        const { joinCode } = joinLobbyWithActiveAccount(test, p);
        expect(lmaOf(test, a)).toHaveLength(1);
        const msg = rejection(test, p, (ctx) => M.set_active_hsr_account(ctx, { hsrAccountId: b }));
        expect([account(test, a)!.isActive, account(test, b)!.isActive]).toEqual([true, false]);
        expect(msg).toContain(joinCode);
    });

    it('scenario "Delete with Cascade" + edge case "Delete active account when others exist": characters go; the oldest remaining account activates', () => {
        const { test, p } = world();
        const a = createAccount(test, p, '800000001', 'A');
        advance(test, 1000);
        const b = createAccount(test, p, '800000002', 'B');
        advance(test, 1000);
        const c = createAccount(test, p, '800000003', 'C');
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: a, charactersJson: roster(['acheron', 'kafka']) }));
        tx(test, p, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: a }));
        expect(account(test, a)).toBeUndefined();
        expect([...test.db.HsrAccountCharacter.hsr_account_id.filter(a)]).toEqual([]);
        expect([account(test, b)!.isActive, account(test, c)!.isActive]).toEqual([true, false]);
    });

    it('delete_hsr_account error "Not account owner": a permission error; nothing is deleted', () => {
        const { test, p } = world();
        const other = verified(test, 'rosterother');
        const id = createAccount(test, p, '800000001');
        expect(rejection(test, other, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: id }))).toMatch(/not your account/i);
        expect(account(test, id)).toBeDefined();
    });

    it('scenario "Duplicate UID Detection (recalcDuplicateUid)": both accounts flag on create; the survivor reverts on delete', () => {
        const { test, p } = world();
        const other = verified(test, 'rosterother');
        const mine = createAccount(test, p, '800000099');
        const theirs = createAccount(test, other, '800000099');
        expect([account(test, mine)!.isDuplicateUid, account(test, theirs)!.isDuplicateUid]).toEqual([true, true]);
        tx(test, other, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: theirs }));
        expect(account(test, mine)!.isDuplicateUid).toBe(false);
    });

    it('Admin proxy reducers: create for another user, update, batch upsert / remove and delete without ownership checks', () => {
        const { test, p } = world();
        const a = admin(test);
        tx(test, a, (ctx) => M.admin_create_hsr_account(ctx, { targetUserId: p.userId, uid: '700000001', displayLabel: '' }));
        const id = accountsOf(test, p.userId)[0].id;
        expect(account(test, id)).toMatchObject({ userId: p.userId, region: 'Europe', displayLabel: 'Account 1', isActive: true, createdById: a.userId });
        tx(test, a, (ctx) => M.admin_update_hsr_account(ctx, { hsrAccountId: id, displayLabel: 'staff', isRosterPublic: true, isRatingPublic: false }));
        expect(account(test, id)).toMatchObject({ displayLabel: 'staff', isRosterPublic: true, isRatingPublic: false });
        tx(test, a, (ctx) => M.admin_batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: roster([['acheron', 2], 'kafka']) }));
        expect(charsOf(test, id)).toEqual({ acheron: 2, kafka: 0 });
        tx(test, a, (ctx) => M.admin_batch_remove_characters(ctx, { hsrAccountId: id, characterNamesJson: '["kafka"]' }));
        expect(charsOf(test, id)).toEqual({ acheron: 2 });
        tx(test, a, (ctx) => M.admin_delete_hsr_account(ctx, { hsrAccountId: id }));
        expect(account(test, id)).toBeUndefined();
        expect(charsOf(test, id)).toEqual({});
    });
});

// ─── Characters ──────────────────────────────────────────────────────────────

describe('account characters', () => {
    function withAccount() {
        const w = world();
        return { ...w, id: createAccount(w.test, w.p, '800000001', 'main') };
    }
    const upsert = (test: Harness, who: Actor, id: number, json: string) =>
        tx(test, who, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: json }));

    it('scenarios "Batch Upsert — Insert" and "Batch Upsert — Update Eidolon"', () => {
        const { test, p, id } = withAccount();
        upsert(test, p, id, roster([['acheron', 2], ['aglaea', 0]]));
        expect(charsOf(test, id)).toEqual({ acheron: 2, aglaea: 0 });
        upsert(test, p, id, roster([['acheron', 6]]));
        expect(charsOf(test, id)).toEqual({ acheron: 6, aglaea: 0 });
    });

    it('scenario "Batch Upsert — Atomic Reject": "Invalid character"; the valid entry is not inserted', () => {
        const { test, p, id } = withAccount();
        const msg = rejection(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: roster(['kafka', 'NonExistentCharacter']) }));
        expect(charsOf(test, id)).toEqual({});
        expect(msg).toContain('Invalid character');
    });

    it('scenario "Batch Upsert — Eidolon Out of Range": E7 and E-1 are rejected with "eidolon level"; E0 and E6 are the bounds', () => {
        const { test, p, id } = withAccount();
        for (const e of [7, -1]) {
            expect(rejection(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: roster([['acheron', e]]) })))
                .toContain('eidolon level');
        }
        expect(charsOf(test, id)).toEqual({});
        upsert(test, p, id, roster([['acheron', 0], ['kafka', 6]]));
        expect(charsOf(test, id)).toEqual({ acheron: 0, kafka: 6 });
    });

    it('scenario "Batch Upsert — Empty Array": "non-empty"', () => {
        const { test, p, id } = withAccount();
        expect(rejection(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: '[]' }))).toContain('non-empty');
    });

    it('scenarios "Batch Remove — Happy Path" and "Batch Remove — Atomic Reject" ("not found"; nothing is deleted)', () => {
        const { test, p, id } = withAccount();
        upsert(test, p, id, roster(['acheron', 'aglaea']));
        tx(test, p, (ctx) => M.batch_remove_characters(ctx, { hsrAccountId: id, characterNamesJson: '["aglaea"]' }));
        expect(charsOf(test, id)).toEqual({ acheron: 0 });
        const msg = rejection(test, p, (ctx) => M.batch_remove_characters(ctx, { hsrAccountId: id, characterNamesJson: '["acheron","GhostCharacter"]' }));
        expect(charsOf(test, id)).toEqual({ acheron: 0 });
        expect(msg).toContain('not found');
    });

    it('batch_upsert / batch_remove error "Not account owner": a permission error', () => {
        const { test, p, id } = withAccount();
        upsert(test, p, id, roster(['acheron']));
        const other = verified(test, 'rosterother');
        expect(rejection(test, other, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: roster(['kafka']) }))).toMatch(/not your account/i);
        expect(rejection(test, other, (ctx) => M.batch_remove_characters(ctx, { hsrAccountId: id, characterNamesJson: '["acheron"]' }))).toMatch(/not your account/i);
        expect(charsOf(test, id)).toEqual({ acheron: 0 });
    });

    it('scenarios "Batch Upsert — D-G Guard" and "Batch Remove — D-G Guard" (ROST-GUARD-01, NARROW): the bound account is locked, the error cites the join code; another account is not', () => {
        const { test, p, id } = withAccount();
        const spare = createAccount(test, p, '800000002', 'spare');
        upsert(test, p, id, roster(['acheron']));
        const { joinCode } = joinLobbyWithActiveAccount(test, p);
        expect(lmaOf(test, id)).toHaveLength(1);
        const up = rejection(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: roster(['kafka']) }));
        const rm = rejection(test, p, (ctx) => M.batch_remove_characters(ctx, { hsrAccountId: id, characterNamesJson: '["acheron"]' }));
        expect(charsOf(test, id)).toEqual({ acheron: 0 });
        expect(up).toContain(joinCode);
        expect(rm).toContain(joinCode);
        upsert(test, p, spare, roster(['kafka']));
        expect(charsOf(test, spare)).toEqual({ kafka: 0 });
    });
});

// ─── Migration ───────────────────────────────────────────────────────────────

describe('migrate_roster', () => {
    function twoAccounts() {
        const w = world();
        const source = createAccount(w.test, w.p, '800000001', 'source');
        const target = createAccount(w.test, w.p, '800000002', 'target');
        return { ...w, source, target };
    }
    const migrate = (test: Harness, who: Actor, sourceAccountId: number, targetAccountId: number, mode: string) =>
        tx(test, who, (ctx) => M.migrate_roster(ctx, { sourceAccountId, targetAccountId, mode }));

    it('scenario "Migrate — Copy": the target gains the source\'s characters (a conflicting eidolon is overwritten); the source is unchanged', () => {
        const { test, p, source, target } = twoAccounts();
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: source, charactersJson: roster([['acheron', 3], ['aglaea', 1]]) }));
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: target, charactersJson: roster([['acheron', 6], ['kafka', 0]]) }));
        migrate(test, p, source, target, 'copy');
        expect(charsOf(test, target)).toEqual({ acheron: 3, aglaea: 1, kafka: 0 });
        expect(charsOf(test, source)).toEqual({ acheron: 3, aglaea: 1 });
    });

    it('scenario "Migrate — Move": the target has the source\'s characters; the source has none', () => {
        const { test, p, source, target } = twoAccounts();
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: source, charactersJson: roster([['acheron', 3], ['aglaea', 1]]) }));
        migrate(test, p, source, target, 'move');
        expect(charsOf(test, target)).toEqual({ acheron: 3, aglaea: 1 });
        expect(charsOf(test, source)).toEqual({});
    });

    it('scenarios "Migrate — Same Account Rejected" ("same account") and "Migrate — Invalid Mode" (contains "copy")', () => {
        const { test, p, source, target } = twoAccounts();
        expect(rejection(test, p, (ctx) => M.migrate_roster(ctx, { sourceAccountId: source, targetAccountId: source, mode: 'copy' }))).toContain('same account');
        expect(rejection(test, p, (ctx) => M.migrate_roster(ctx, { sourceAccountId: source, targetAccountId: target, mode: 'invalid' }))).toContain('copy');
    });

    it('migrate_roster error "Not owner of both": a permission error; the other user\'s account is untouched', () => {
        const { test, p, source } = twoAccounts();
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: source, charactersJson: roster(['acheron']) }));
        const other = verified(test, 'rosterother');
        const foreign = createAccount(test, other, '700000001');
        expect(rejection(test, p, (ctx) => M.migrate_roster(ctx, { sourceAccountId: source, targetAccountId: foreign, mode: 'copy' }))).toMatch(/not your account/i);
        expect(charsOf(test, foreign)).toEqual({});
    });

    it('migrate_roster flow 4 (D-D-04): copy recomputes the TARGET accountRating to the source\'s; the source rating is unchanged', () => {
        const test = newHarness();
        seedRatingData(test);
        const p = verified(test, 'rosterrate');
        const source = createAccount(test, p, '800000001');
        const target = createAccount(test, p, '800000002');
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: source, charactersJson: roster(['c1', 'c5']) }));
        const sourceRating = account(test, source)!.accountRating;
        expect(sourceRating).toBeGreaterThan(0);
        expect(account(test, target)!.accountRating).toBe(0);
        migrate(test, p, source, target, 'copy');
        expect(account(test, target)!.accountRating).toBe(sourceRating);
        expect(account(test, source)!.accountRating).toBe(sourceRating);
    });

    it('migrate_roster flow 5 (D-D-04): move recomputes BOTH ratings (target = the source\'s former rating, source 0)', () => {
        const test = newHarness();
        seedRatingData(test);
        const p = verified(test, 'rosterrate');
        const source = createAccount(test, p, '800000001');
        const target = createAccount(test, p, '800000002');
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: source, charactersJson: roster(['c1', 'c5']) }));
        const sourceRating = account(test, source)!.accountRating;
        migrate(test, p, source, target, 'move');
        expect(account(test, target)!.accountRating).toBe(sourceRating);
        expect(account(test, source)!.accountRating).toBe(0);
    });

    it('an empty source is a no-op: no error, no rows, ratings unchanged', () => {
        const test = newHarness();
        seedRatingData(test);
        const p = verified(test, 'rosterrate');
        const source = createAccount(test, p, '800000001');
        const target = createAccount(test, p, '800000002');
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: target, charactersJson: roster(['c2']) }));
        const targetRating = account(test, target)!.accountRating;
        migrate(test, p, source, target, 'move');
        expect(charsOf(test, target)).toEqual({ c2: 0 });
        expect([account(test, source)!.accountRating, account(test, target)!.accountRating]).toEqual([0, targetRating]);
    });

    it('scenario "Migrate — D-G Guard" (ROST-GUARD-01), source bound: "migrate characters from this account", "Leave the lobby first", the join code', () => {
        const { test, p, source, target } = twoAccounts(); // source is the first, active account
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: source, charactersJson: roster(['acheron']) }));
        const { joinCode } = joinLobbyWithActiveAccount(test, p);
        const msg = rejection(test, p, (ctx) => M.migrate_roster(ctx, { sourceAccountId: source, targetAccountId: target, mode: 'copy' }));
        expect(charsOf(test, target)).toEqual({});
        expect(msg).toContain('migrate characters from this account');
        expect(msg).toContain('Leave the lobby first');
        expect(msg).toContain(joinCode);
    });

    it('scenario "Migrate — D-G Guard" (ROST-GUARD-01), target bound: "migrate characters to this account", the join code', () => {
        const { test, p, source, target } = twoAccounts();
        tx(test, p, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: source, charactersJson: roster(['acheron']) }));
        tx(test, p, (ctx) => M.set_active_hsr_account(ctx, { hsrAccountId: target }));
        const { joinCode } = joinLobbyWithActiveAccount(test, p);
        expect(lmaOf(test, target)).toHaveLength(1);
        const msg = rejection(test, p, (ctx) => M.migrate_roster(ctx, { sourceAccountId: source, targetAccountId: target, mode: 'move' }));
        expect(charsOf(test, source)).toEqual({ acheron: 0 });
        expect(msg).toContain('migrate characters to this account');
        expect(msg).toContain(joinCode);
    });
});

// ─── Account-deletion guard (D-24, D-25) ─────────────────────────────────────

describe('account deletion guard', () => {
    it('scenario "Delete Blocked by Active Lobby Usage": the auto-selected account cannot be deleted; after leaving (no LobbyMemberAccount row) it can', () => {
        const { test, p } = world();
        const id = createAccount(test, p, '800000001');
        const { lobbyId } = joinLobbyWithActiveAccount(test, p);
        expect(lmaOf(test, id)).toHaveLength(1);
        const msg = rejection(test, p, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: id }));
        expect(account(test, id)).toBeDefined();
        expect(msg).toMatch(/Cannot delete an account .*active lobby/);
        expect(msg).toContain('Leave the lobby first');

        tx(test, p, (ctx) => M.leave_lobby(ctx, { lobbyId }));
        expect(lmaOf(test, id)).toEqual([]);
        tx(test, p, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: id }));
        expect(account(test, id)).toBeUndefined();
    });

    it('scenario "Admin Delete Blocked by Same Guards" (lobby, D-25): admin_delete_hsr_account is refused the same way, then succeeds after the leave', () => {
        const { test, p } = world();
        const a = admin(test);
        const id = createAccount(test, p, '800000001');
        const { lobbyId } = joinLobbyWithActiveAccount(test, p);
        const msg = rejection(test, a, (ctx) => M.admin_delete_hsr_account(ctx, { hsrAccountId: id }));
        expect(account(test, id)).toBeDefined();
        expect(msg).toMatch(/Cannot delete an account .*active lobby/);
        tx(test, p, (ctx) => M.leave_lobby(ctx, { lobbyId }));
        tx(test, a, (ctx) => M.admin_delete_hsr_account(ctx, { hsrAccountId: id }));
        expect(account(test, id)).toBeUndefined();
    });

    it('scenarios "Delete Blocked by Active Tournament" + "Admin Delete Blocked by Same Guards" (D-24, D-25): a registration lock blocks both deletes until the tournament is Cancelled', () => {
        const { test, p } = world();
        const a = admin(test);
        const id = createAccount(test, p, '800000001');
        const org = tournamentHost(test);
        const tournamentId = openTournament(test, org);
        register(test, p, tournamentId);
        expect([...test.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, p.userId])].map((r) => r.hsrAccountId)).toEqual([id]);

        const own = rejection(test, p, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: id }));
        const staff = rejection(test, a, (ctx) => M.admin_delete_hsr_account(ctx, { hsrAccountId: id }));
        expect(account(test, id)).toBeDefined();
        for (const msg of [own, staff]) expect(msg).toMatch(/Cannot delete an account locked in an active tournament/);

        tx(test, org, (ctx) => M.cancel_tournament(ctx, { tournamentId }));
        tx(test, p, (ctx) => M.delete_hsr_account(ctx, { hsrAccountId: id }));
        expect(account(test, id)).toBeUndefined();
    });
});
