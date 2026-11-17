# Team Builder Loadouts -- Architecture

Last updated: 2026-11-17 (S14.3s, save limit S14.3s-limit)

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

```
User (id: u32 autoInc PK)
  +-- UserLoadoutRate (userId: u32 PK)  [PRIVATE, name 'user_loadout_rate']  (S14.3s-limit)
        userId -> User.id (one row per user, created on the first accepted save)
        windowStart: timestamp (start of the current fixed 60 s window)
        saveCount: u32 (accepted saves in that window, at most 6)
        audit columns (the user is the actor)
```

- File: `spacetimedb/src/tables/roster/userLoadoutRate.ts`, registered in `schema.ts`. No view reads it; the bindings carry only its row type.
- Why a table of its own and not two columns on `UserRateState`: `UserRateState` is live on the test database, and a new column there would be a migration of a live table. A new private table is additive. `UserLoadout`'s own timestamps cannot count saves: one slot updated six times leaves one timestamp.

## Reducers

File: `spacetimedb/src/reducers/roster/userLoadouts.ts`. Rules and texts: `spacetimedb/src/helpers/roster/loadoutRules.ts`.

### save_loadout(slot: u8, isNew: bool, name: string, note: string, code: string)

1. `ensureVerifiedUser(ctx, LOADOUT_VERIFIED_TEXT)`: `getAuthenticatedUser` (no user, deleted account, maintenance mode) then the guest check with the loadout text.
2. (Removed in S14.3s-limit: the save no longer counts on `consumeMembershipAllowance`; see step 4b.)
3. `ensureLoadoutSlot` (0-9), `loadoutName` (trim, non-empty, 40), `ensureLoadoutNote` (1,000), `ensureLoadoutCode`:
   - length at most `TEAM_CODE_MAX` (400);
   - `decodeTeam(code, catalog)` from `@shared/teambuilder`, the catalog being two primary-key lookups (`HsrCharacter.name.find`, `HsrLightcone.name.find`); a decode failure is the unreadable-team text, except `duplicate`, which has its own;
   - `encodeTeam(decoded.team).code === code` (canonical text);
   - the first name the catalog does not know is refused (`Unknown character "x".` / `Unknown light cone "x".`).
4. `loadoutAt(ctx, user.id, slot)` (`by_user_and_slot`): `isNew` and found: refused; not `isNew` and not found: refused.
4b. `consumeLoadoutSaveAllowance(ctx, user.id)` (`helpers/roster/loadoutRules.ts`, `UserLoadoutRate`; see "Save limit"). Last check, so its refusal only reaches a save that would otherwise succeed.
5. `UserLoadout.id.update(updateWithAudit(...))` or `UserLoadout.insert(insertWithAudit(...))`.

### delete_loadout(slot: u8)

Step 1 as above, then `ensureLoadoutSlot`, then `UserLoadout.id.delete` of the caller's row in the slot; no row is a no-op. No rate limit (S14.3s-limit; see "Save limit").

### Save limit (S14.3s-limit)

DECISIONS.md A194 item 6 (closes A193 item 8), user ruling 2026-11-17: "6 saves per minute per account".

- Constants in `loadoutRules.ts`: `LOADOUT_SAVES_PER_WINDOW = 6`, `LOADOUT_SAVE_WINDOW_MS = 60_000`, refusal `LOADOUT_TOO_FAST_TEXT` ("Your loadout was not saved yet: too many saves in a short time. It will be saved in a moment."). Not `AbuseConfig` columns: an admin-editable value would change the shape of that live table.
- Fixed window, like the `UserRateState` neighbours (`consumeMembershipAllowance`, `consumeTournamentAllowance`): one primary-key read and one write per accepted save. The window opens at the first save after the previous one expired (`ctx.timestamp` only) and holds at most 6 accepted saves. A refused call rolls back and writes nothing; a save refused for any other reason does not count.
- New saves and updates both count. Saves no longer count on the membership allowance, and lobby, roster and calendar writes do not count on this limit.
- Worst burst: 12 accepted saves within a few seconds across a window edge (6 at the end of one window, 6 at the start of the next). It does not matter: every window still holds at most 6, so the monthly bound is unchanged, and the burst only echoes 12 rows to the caller's own subscription (about 43 kB at the worst row size). A sliding window would need six timestamps per user for no budget gain.
- `delete_loadout` counts on nothing. A delete only removes a row a counted save created, so a save, delete, save loop is held to 6 saves (and so at most about 6 effective deletes) a minute. A delete of an empty slot writes nothing, and a refused delete would cost the same single reducer call as that no-op, so a limit would add a write without saving energy.


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
| Any user deletion (`delete_my_account`, `server_delete_user`, `admin_delete_row` on User, a ban, identity GC, the guest re-point on sign-in) | the user's rows are deleted, and the user's `UserLoadoutRate` row (S14.3s-limit) | `performUserDeletion` (`helpers/identity/userDeletionHelper.ts`), next to the HsrAccount cascade |
| Test database wipe | `UserLoadout.clear()`, `UserLoadoutRate.clear()` | `server_nuke_test_data` (`reducers/identity/server.ts`) |
| A guest signs in to Discord | nothing: a guest has no rows | |
| A character or light cone deleted | nothing: the stored text keeps the name | |

## Egress and storage

How the caps count: `loadoutRules.ts` compares JavaScript `string.length`, so the name (40) and note (1,000) caps count UTF-16 code units, the same unit an HTML `maxlength` and the page's counter use. Stored and sent strings are UTF-8 (each with a 4-byte length prefix on the wire), so bytes per unit depend on the script: 1 for ASCII, 2 for most accented Latin, Greek and Cyrillic, 3 for CJK and the rest of the BMP, and 2 for a character outside the BMP (4 bytes, but 2 units). The worst case is therefore BMP text at 3 bytes per unit. The code is ASCII by its grammar, so its 400 is 400 bytes.

| Case | Name | Note | Code | Row on the wire (slot 1 B + 3 strings) | Ten loadouts (first load) |
|---|---|---|---|---|---|
| Typical | short ASCII | short or empty | a few characters | about 270 B | about 2.7 kB |
| Worst, Latin text at the caps | 40 B | 1,000 B | 400 B | about 1.45 kB | about 14.5 kB |
| Worst, CJK text at the caps | 120 B | 3,000 B | 400 B | about 3.55 kB (1 + 124 + 3,004 + 404) | about 35 kB |

One save sends back one row (up to about 3.55 kB, before compression). The stored row adds `id`, `userId` and the audit columns (about 32 B), so the worst stored row is about 3.6 kB and 1,000 members with ten full CJK loadouts each would hold about 36 MB; with ten typical loadouts each (about 300 B stored) they would hold about 3 MB. The table is private and the view per caller, so no write reaches another member. `UserLoadoutRate` holds one row of about 40 B per member who ever saved (about 40 kB for 1,000 members) and sends nothing.

### Abuse estimate (S14.3s-limit)

One scripted verified account that saves at the limit all month and keeps its subscription open. Per-call figures from the S14.3s review (M4): 840 TeV per million reducer calls; the echo of a worst-case row, about 3.55 kB, at 200 TeV per GB. A 30-day month has 43,200 one-minute windows.

| Case | Calls a month | Calls (TeV) | Echo (TeV) | Total | Share of 100,000 TeV |
|---|---|---|---|---|---|
| Before (shared allowance, 20 per 10 s) | about 5.2 million | about 4,350 | about 3,700 | about 8,050 | about 8 % |
| Saves at the limit (6 per minute) | 259,200 | about 218 | about 184 (0.92 GB) | about 400 | about 0.4 % |
| Save, delete, save loop (each save followed by a delete) | 518,400 | about 435 | about 368 | about 800 | about 0.8 % |
| Saves by updates only (review of S14.3s-limit, M1) | 259,200 | about 218 | about 368 (two rows per save) | about 590 | about 0.6 % |

The 0.4 % row assumes every save is an insert. An account has ten slots, so a script at the limit all month saves mostly by updating, and an update of a row in a subscribed view reaches the caller as the old row and the new row (a delete and an insert in one transaction update), so its echo is up to about 7.1 kB, not 3.55 kB. That case is about 590 TeV (0.6 %). This is reasoned from the wire format, not measured; the real bytes need the dev egress meter after a publish. The save, delete, save loop (0.8 %) already counts two rows per pair and stays the upper bound for every case.

The 12-save burst across a window edge does not raise these figures (at most 6 per window). Refused calls and deletes of empty slots are not bounded by any limit, here or anywhere in the module: each costs one reducer call (840 TeV per million) and returns only to the caller, the same as before this step.

## Tests

`spacetimedb/src/__tests__/roster/loadouts.test.ts` (in memory). Live residue: `view_my_loadouts` is in the per-sender list of `test/live/outsider-isolation.test.ts` (an unmapped identity receives no rows).

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| `UserLoadout` table, `save_loadout`, `delete_loadout`, `view_my_loadouts`; deletion cascade and wipe; optional message on `ensureVerifiedUser` | Phase S14.3s execution (DECISIONS.md A190 items 1, 3, 15) | 2026-11-17 |
| Size figures corrected: the caps count UTF-16 units, storage is UTF-8, worst row about 3.55 kB (CJK), ten loadouts about 35 kB | Phase S14.3s execution (review S1) | 2026-11-17 |
| Save limit of its own: private `UserLoadoutRate` (fixed 60 s window, 6 accepted saves per account), off the membership allowance; `delete_loadout` not limited; deletion cascade and wipe include the new table; abuse estimate about 0.4 % (saves) or 0.8 % (save and delete loop) of the budget | Phase S14.3s execution, S14.3s-limit (DECISIONS.md A194 item 6, closing A193 item 8) | 2026-11-17 |
| Abuse estimate gains the updates-only case (about 0.6 %, two rows echoed per update, reasoned not measured); 0.8 % stays the upper bound | Phase S14.3s execution, S14.3s-limit (review M1) | 2026-11-17 |

---

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
