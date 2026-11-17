# Team Builder Loadouts -- Architecture

Last updated: 2026-11-17 (S14.3s)

## Overview

A verified member's saved team builder loadouts (DECISIONS.md A190 items 1, 3, 15). One private table, two reducers, one per-caller view. The code lives in the roster domain folders (`tables/roster/`, `reducers/roster/`, `helpers/roster/`); the view has its own file. Behaviour, texts and scenarios: [contract.md](contract.md).

## Table

```
User (id: u32 autoInc PK)
  +-- UserLoadout (id: u32 autoInc PK)  [PRIVATE, name 'user_loadout']
        userId -> User.id                [btree: user_id]
        slot: u8 (0-9; unique per user by the reducer's check)
        name: string (trimmed, 1-40 UTF-16 units)
        note: string (0-1,000 UTF-16 units)
        code: string (the packed team text of shared/teambuilder, version 1, at most 400; ASCII only)
        audit columns (createdById, createdDate, lastModifiedById, lastModifiedDate)
        Indexes: user_id (btree), by_user_and_slot (btree: userId, slot)
```

- File: `spacetimedb/src/tables/roster/userLoadout.ts`, registered in `schema.ts`.
- `id` is the handle for `.id.update` / `.id.delete`; it never reaches a client.
- (userId, slot) uniqueness is not engine-enforced (a multi-column key is not); `save_loadout` checks it before every insert through `by_user_and_slot`.
- Characters and light cones are referenced inside `code` by key name (`HsrCharacter.name`, `HsrLightcone.name`), never by id, so a loadout survives a reseed. No foreign key: a reference row deleted later is not cascaded.

## Reducers

File: `spacetimedb/src/reducers/roster/userLoadouts.ts`. Rules and texts: `spacetimedb/src/helpers/roster/loadoutRules.ts`.

### save_loadout(slot: u8, isNew: bool, name: string, note: string, code: string)

1. `ensureVerifiedUser(ctx, LOADOUT_VERIFIED_TEXT)`: `getAuthenticatedUser` (no user, deleted account, maintenance mode) then the guest check with the loadout text.
2. `consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT)` (`helpers/lobby/abuseControls.ts`, `UserRateState`; A122(4)).
3. `ensureLoadoutSlot` (0-9), `loadoutName` (trim, non-empty, 40), `ensureLoadoutNote` (1,000), `ensureLoadoutCode`:
   - length at most `TEAM_CODE_MAX` (400);
   - `decodeTeam(code, catalog)` from `@shared/teambuilder`, the catalog being two primary-key lookups (`HsrCharacter.name.find`, `HsrLightcone.name.find`); a decode failure is the unreadable-team text, except `duplicate`, which has its own;
   - `encodeTeam(decoded.team).code === code` (canonical text);
   - the first name the catalog does not know is refused (`Unknown character "x".` / `Unknown light cone "x".`).
4. `loadoutAt(ctx, user.id, slot)` (`by_user_and_slot`): `isNew` and found: refused; not `isNew` and not found: refused.
5. `UserLoadout.id.update(updateWithAudit(...))` or `UserLoadout.insert(insertWithAudit(...))`.

### delete_loadout(slot: u8)

Steps 1 and 2 as above, then `ensureLoadoutSlot`, then `UserLoadout.id.delete` of the caller's row in the slot; no row is a no-op.

Both reducers take the caller only from `ctx.sender`, return nothing and use no clock, random value or network.

## View

`view_my_loadouts` (`spacetimedb/src/views/loadoutViews.ts`, exported from `index.ts`), public, no arguments.

- Row `MyLoadoutRow { slot: u8 primaryKey, name, note, code }`. The primary key gives the client `onUpdate` on a save; the generated bindings show it on the row type (`view_my_loadouts_table.ts`), and the `constraints` list stays empty, as for the other views with a key.
- Body: `callerUserId(ctx)` (UserIdentity), `User.id.find` (a guest gets `[]`), `UserLoadout.user_id.filter(userId)`. Index only, no scan.

## Shared code

`shared/teambuilder` (the barrel; `teamCode.ts`, `team.ts`, plus `teamCost.ts` which imports `@shared/scoring`): pure TypeScript with no `spacetimedb` or `react` import, resolved by the CLI bundler one segment deep like the other `@shared/<folder>` imports of the module. No change to `shared/` in S14.3s.

## Lifecycle

| Event | Effect | Where |
|---|---|---|
| Any user deletion (`delete_my_account`, `server_delete_user`, `admin_delete_row` on User, a ban, identity GC, the guest re-point on sign-in) | the user's rows are deleted | `performUserDeletion` (`helpers/identity/userDeletionHelper.ts`), next to the HsrAccount cascade |
| Test database wipe | `UserLoadout.clear()` | `server_nuke_test_data` (`reducers/identity/server.ts`) |
| A guest signs in to Discord | nothing: a guest has no rows | |
| A character or light cone deleted | nothing: the stored text keeps the name | |

## Egress and storage

How the caps count: `loadoutRules.ts` compares JavaScript `string.length`, so the name (40) and note (1,000) caps count UTF-16 code units, the same unit an HTML `maxlength` and the page's counter use. Stored and sent strings are UTF-8 (each with a 4-byte length prefix on the wire), so bytes per unit depend on the script: 1 for ASCII, 2 for most accented Latin, Greek and Cyrillic, 3 for CJK and the rest of the BMP, and 2 for a character outside the BMP (4 bytes, but 2 units). The worst case is therefore BMP text at 3 bytes per unit. The code is ASCII by its grammar, so its 400 is 400 bytes.

| Case | Name | Note | Code | Row on the wire (slot 1 B + 3 strings) | Ten loadouts (first load) |
|---|---|---|---|---|---|
| Typical | short ASCII | short or empty | a few characters | about 270 B | about 2.7 kB |
| Worst, Latin text at the caps | 40 B | 1,000 B | 400 B | about 1.45 kB | about 14.5 kB |
| Worst, CJK text at the caps | 120 B | 3,000 B | 400 B | about 3.55 kB (1 + 124 + 3,004 + 404) | about 35 kB |

One save sends back one row (up to about 3.55 kB, before compression). The stored row adds `id`, `userId` and the audit columns (about 32 B), so the worst stored row is about 3.6 kB and 1,000 members with ten full CJK loadouts each would hold about 36 MB; with ten typical loadouts each (about 300 B stored) they would hold about 3 MB. The table is private and the view per caller, so no write reaches another member.

## Tests

`spacetimedb/src/__tests__/roster/loadouts.test.ts` (in memory). Live residue: `view_my_loadouts` is in the per-sender list of `test/live/outsider-isolation.test.ts` (an unmapped identity receives no rows).

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| `UserLoadout` table, `save_loadout`, `delete_loadout`, `view_my_loadouts`; deletion cascade and wipe; optional message on `ensureVerifiedUser` | Phase S14.3s execution (DECISIONS.md A190 items 1, 3, 15) | 2026-11-17 |
| Size figures corrected: the caps count UTF-16 units, storage is UTF-8, worst row about 3.55 kB (CJK), ten loadouts about 35 kB | Phase S14.3s execution (review S1) | 2026-11-17 |

---

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
