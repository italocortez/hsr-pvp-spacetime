// Fixtures: HSR accounts and their characters, reference characters and light cones.
// From S8 (s8-fixtures.ts: insertHsrAccount), S10 (s10-c2-fixtures.ts: roster; s10-a1-fixtures.ts: setActive;
// s10-a2-fixtures.ts: ownedAccount); gathered by T-REORG2.
//
// Not a test file. Accounts and reference rows are written through the module's reducers or straight into the
// in-memory datastore outside any reducer; `test.db` is read only outside `tx` bodies. Nothing reaches maincloud.
import { AUDIT, M, tx, type Actor, type Harness } from './harness';

// ─── HSR accounts ────────────────────────────────────────────────────────────

/** An HSR account owned by `userId` (inserted directly). Returns its id. */
export function insertHsrAccount(test: Harness, userId: number, uid: string): number {
    return test.db.HsrAccount.insert({
        id: 0,
        userId,
        uid,
        region: 'eu',
        displayLabel: uid,
        isActive: true,
        isRosterPublic: true,
        isRatingPublic: true,
        isDuplicateUid: false,
        accountRating: 0,
        ...AUDIT(test),
    }).id;
}

/**
 * An HSR account of `userId` owning `chars` (names at E0, or name → eidolon), inserted directly. `active: false`
 * marks it inactive (join_lobby auto-selects the user's active account, D-04). Returns its id.
 */
export function ownedAccount(test: Harness, userId: number, uid: string, chars: string[] | Record<string, number>, active = true): number {
    const id = insertHsrAccount(test, userId, uid);
    if (!active) test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(id)!, isActive: false });
    const owned = Array.isArray(chars) ? Object.fromEntries(chars.map((c) => [c, 0])) : chars;
    for (const [characterName, eidolonLevel] of Object.entries(owned)) {
        test.db.HsrAccountCharacter.insert({ hsrAccountId: id, characterName, eidolonLevel, ...AUDIT(test) });
    }
    return id;
}

/** Flips HsrAccount.isActive on a row inserted by insertHsrAccount (which inserts active accounts). */
export function setActive(test: Harness, hsrAccountId: number, isActive: boolean) {
    test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(hsrAccountId)!, isActive });
}

// ─── Roster reducers ─────────────────────────────────────────────────────────

/** A JSON character batch for batch_upsert_characters (`[name, eidolon]` pairs; a bare name is E0). */
export const roster = (items: Array<string | [string, number]>) =>
    JSON.stringify(items.map((i) => (typeof i === 'string' ? { characterName: i, eidolonLevel: 0 } : { characterName: i[0], eidolonLevel: i[1] })));

/** create_hsr_account as `who`; returns the new account's id. */
export function createAccount(test: Harness, who: Actor, uid: string, displayLabel = ''): number {
    tx(test, who, (ctx) => M.create_hsr_account(ctx, { uid, displayLabel }));
    return [...test.db.HsrAccount.user_id.filter(who.userId)].find((a) => a.uid === uid)!.id;
}

export const account = (test: Harness, id: number) => test.db.HsrAccount.id.find(id) ?? undefined; // find() returns null when absent
export const accountsOf = (test: Harness, userId: number) => [...test.db.HsrAccount.user_id.filter(userId)];
/** The account's characters as { name: eidolon }. */
export const charsOf = (test: Harness, accountId: number) =>
    Object.fromEntries([...test.db.HsrAccountCharacter.hsr_account_id.filter(accountId)].map((c) => [c.characterName, c.eidolonLevel]));

// ─── Reference characters and light cones ─────────────────────────────────────

/** Reference characters with no rating config (role Dps, version 1.0). */
export function seedCharacters(test: Harness, names: string[]) {
    tx(test, 'internal', (ctx) => {
        for (const name of names) {
            ctx.db.HsrCharacter.insert({
                name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Hunt' }, element: { tag: 'Fire' },
                role: { tag: 'Dps' }, imageUrl: '', versionReleased: 1.0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
    });
}

/** Reference light cones (path Destruction). */
export function seedLightcones(test: Harness, names: string[]) {
    tx(test, 'internal', (ctx) => {
        for (const name of names) {
            ctx.db.HsrLightcone.insert({
                name, displayName: name, aliases: [], path: { tag: 'Destruction' }, rarity: 5, imageUrl: '', posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
    });
}

/**
 * T-S10f (roster audit #9): edit_draft_character_cost / _lightcone_cost require HsrCharacter / HsrLightcone rows.
 * Seeds the names that are not there yet (safe to call after seedCharacters / seedLightcones).
 */
export function seedReferenceNames(test: Harness, characters: string[], lightcones: string[] = []) {
    seedCharacters(test, characters.filter((n) => !test.db.HsrCharacter.name.find(n)));
    seedLightcones(test, lightcones.filter((n) => !test.db.HsrLightcone.name.find(n)));
}
