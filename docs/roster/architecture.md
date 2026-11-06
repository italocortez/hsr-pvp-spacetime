# Roster Management -- Architecture

Last updated: 2026-04-12

## Overview

Players create HSR account entries (up to 5), add owned characters with eidolon levels, control visibility, and migrate rosters between accounts. Admins can proxy all operations. Archetype tagging enables frontend diversity scoring. `HsrAccount` and `HsrAccountCharacter` are private tables -- clients access roster data via server-side views only.

## Table Relationships

```
User (id: u32 autoInc PK)
  +-- HsrAccount (id: u32 autoInc PK)  [PRIVATE]
  |     userId -> User.id  [btree: user_id]
  |     uid: string (9-digit region UID)
  |     region: string (derived from uid first digit)
  |     displayLabel: string
  |     isActive: bool (default preference; per-lobby selection overrides)
  |     isRosterPublic: bool
  |     isRatingPublic: bool
  |     isDuplicateUid: bool (auto-recalculated when accounts share a UID)
  |     audit columns
  |     Indexes: user_id (btree)
  |
  |     +-- HsrAccountCharacter (PK: [hsrAccountId, characterName])  [PRIVATE]
  |           hsrAccountId -> HsrAccount.id  [btree: hsr_account_id]
  |           characterName -> HsrCharacter.name
  |           eidolonLevel: u8 (0-6)
  |           audit columns
  |           Indexes: hsr_account_id (btree)

Archetype (id: u32 autoInc PK)  [public: true]
  +-- name: string (unique)
  +-- description: string
  +-- audit columns

  +-- HsrCharacterArchetype (PK: [characterName, archetypeId])  [public: true]
        characterName -> HsrCharacter.name
        archetypeId -> Archetype.id
        audit columns
```

## Reducer Flows

### create_hsr_account(uid, displayLabel)
1. `ensureVerifiedUser(ctx)` -- reject guests
2. `validateUid(uid)` -- 9-digit regex; valid region first digit (6/7/8/9)
3. `deriveRegion(uid)` -- maps first digit to region string
4. Check 5-account cap per user (via `user_id` index count)
5. Auto-default label to "Account N" if empty after trim
6. First account auto-activates (`isActive=true`)
7. Insert `HsrAccount`
8. `recalcDuplicateUid(ctx, uid, userId)` -- updates `isDuplicateUid` for all accounts sharing this UID

### update_hsr_account(hsrAccountId, displayLabel, isRosterPublic, isRatingPublic)
1. `ensureVerifiedUser(ctx)` -- ownership check (`account.userId === caller.id`)
2. Validate `displayLabel` not empty after trim
3. Update `displayLabel`, `isRosterPublic`, `isRatingPublic`
4. UID and region are immutable -- not accepted by this reducer

### set_active_hsr_account(hsrAccountId)
1. `ensureVerifiedUser(ctx)` -- ownership check
2. No-op if account is already active
3. Deactivate all other accounts for this user (iter via `user_id` index)
4. Activate target account (`isActive=true`)
5. Phase 12.3 D-G-01 (WIDE): rejects when the target account OR any of the caller's currently-active accounts is bound to a live `LobbyMemberAccount`. Error cites the conflicting lobby's joinCode.

### delete_hsr_account(hsrAccountId)
1. `ensureVerifiedUser(ctx)` -- ownership check
2. Deletion guard (D-24): reject if account has any `LobbyMemberAccount` rows (active lobby usage)
3. Deletion guard (D-24): reject if account has `TournamentPlayerAccount` rows for non-terminal tournaments (not Completed/Cancelled)
4. Cascade: delete all `HsrAccountCharacter` rows for this account (via `hsr_account_id` index)
5. Delete `HsrAccount` row
6. If was active: auto-activate oldest remaining account (sort by `createdDate` ascending)
7. `recalcDuplicateUid` for the deleted UID

### batch_upsert_characters(hsrAccountId, charactersJson)
1. `ensureVerifiedUser(ctx)` -- ownership check
2. Phase 12.3 D-G-01 (NARROW): rejects when the target `hsrAccountId` is bound to a live `LobbyMemberAccount`
3. Parse JSON array of `{ characterName, eidolonLevel }` objects
4. Phase 12.3 D-D-02: body is a thin wrapper delegating to `applyBatchUpsert` from `spacetimedb/src/helpers/rosterMutations.ts`
5. Helper: Phase 1 validate ALL entries (`characterName` exists in `HsrCharacter`; `eidolonLevel` in 0-6 range), Phase 2 upsert ALL via composite-PK delete+insert, then call `updateAccountRating`
6. Atomic: any validation failure rejects entire batch

### batch_remove_characters(hsrAccountId, characterNamesJson)
1. `ensureVerifiedUser(ctx)` -- ownership check
2. Phase 12.3 D-G-01 (NARROW): rejects when the target `hsrAccountId` is bound to a live `LobbyMemberAccount`
3. Parse JSON array of character name strings
4. Phase 12.3 D-D-02: body is a thin wrapper delegating to `applyBatchRemove` from `spacetimedb/src/helpers/rosterMutations.ts`
5. Helper: Phase 1 validate ALL names exist on this account, Phase 2 delete ALL matching `HsrAccountCharacter` rows, then call `updateAccountRating`
6. Atomic: any name not found rejects entire batch

### migrate_roster(sourceAccountId, targetAccountId, mode)
1. `ensureVerifiedUser(ctx)` -- both accounts must belong to same user
2. Validate `sourceAccountId !== targetAccountId`
3. Phase 12.3 D-G-01: rejects when EITHER source OR target account is bound to a live `LobbyMemberAccount`
4. Phase 12.3 D-D-03: copy mode calls `applyBatchUpsert` on target (validates + upserts + recomputes target rating); move mode additionally calls `applyBatchRemove` on source (deletes + recomputes source rating)
5. Phase 12.3 D-D-04 (latent bug fix): previously never called `updateAccountRating` on either account, leaving stale ratings until another mutation triggered a recompute. The helper-based implementation closes this gap.

### Admin proxy reducers
All mirror user variants with `ensureAdmin(ctx)` and `targetUserId` parameter (no ownership checks):
- `admin_create_hsr_account(targetUserId, uid, displayLabel)`
- `admin_update_hsr_account(hsrAccountId, displayLabel, isRosterPublic, isRatingPublic)`
- `admin_delete_hsr_account(hsrAccountId)` -- same deletion guard as user variant (D-24)
- `admin_batch_upsert_characters(hsrAccountId, charactersJson)`
- `admin_batch_remove_characters(hsrAccountId, characterNamesJson)`

### Phase 12.3: rosterMutations.ts helpers and lobby guards

New file `spacetimedb/src/helpers/rosterMutations.ts` exports two helpers that
centralize the "mutate characters + recompute accountRating" sequence previously
duplicated across `batch_upsert_characters`, `batch_remove_characters`, and
`migrate_roster`:

- `applyBatchUpsert(ctx, accountId, items, actingUserId)` -- validates items against
  HsrCharacter + eidolon 0..6, upserts `HsrAccountCharacter` rows via composite-PK
  delete+insert with audit columns, then calls `updateAccountRating`.
- `applyBatchRemove(ctx, accountId, names, actingUserId)` -- validates all names
  exist, deletes them, then calls `updateAccountRating`.

Both helpers take pre-validated inputs (Pitfall 5): the calling reducer owns
auth and account-ownership checks; the helper owns content validation and the
mutate+recompute sequence. `migrate_roster` previously did the mutations inline
without calling `updateAccountRating`, leaving both source and target with stale
ratings until another mutation triggered a recompute -- D-D-04 closed this latent bug.

**D-G-01 lobby guards** (defense-in-depth UX layer on top of the Phase 12.3 MMR snapshot):
Four reducers reject when the caller has an active `LobbyMemberAccount` binding:
- `set_active_hsr_account` -- WIDE predicate: rejects when the target account OR
  any of the caller's currently-active accounts is bound to a lobby.
- `batch_upsert_characters`, `batch_remove_characters` -- NARROW predicate:
  rejects when the specific target `hsrAccountId` is bound to a lobby.
- `migrate_roster` -- rejects when EITHER source or target is bound to a lobby.

All four reuse the existing `LobbyMemberAccount.by_account` index; no new index
was introduced. Error messages cite the conflicting lobby's `joinCode` (fallback:
lobby id). The guards exist for UX clarity -- the snapshot from Phase 12.3's D-A
capture already makes the MMR system correct even if every guard were bypassed
by an admin reducer.

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| 5-account cap per user | Phase 02 CONTEXT.md | 2026-02-10 |
| isDuplicateUid auto-recalculated on create/delete via recalcDuplicateUid helper | Phase 02 execution | 2026-02-10 |
| HsrAccount and HsrAccountCharacter made private (no public:true) -- clients use views only (D-20) | Phase 10.4 execution | 2026-03-29 |
| Deletion guard: blocked if LobbyMemberAccount or non-terminal TournamentPlayerAccount rows exist (D-24) | Phase 10.4 execution | 2026-03-29 |
| Archetype system: admin-managed Archetype table + HsrCharacterArchetype junction; used for diversity scoring | Phase 02 execution | 2026-02-10 |
| admin_upsert_archetype uses id.update() not name.update() -- unique index accessor lacks update() | Phase 02 execution | 2026-02-10 |
| migrate_roster copy vs move modes | Phase 02 execution | 2026-02-10 |
| Visibility: isRosterPublic / isRatingPublic; lobby/tournament can force open-roster override | Phase 02 CONTEXT.md | 2026-02-10 |
| HsrAccountLightcone cascade not yet implemented -- lightcone reducers descoped from Phase 2 | Phase 02 execution | 2026-02-10 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| Phase 12.3 | Helper extraction (rosterMutations.ts with applyBatchUpsert / applyBatchRemove), migrate_roster rating-recompute fix (D-D-04 latent bug), four D-G lobby guards on set_active / batch_upsert / batch_remove / migrate_roster |

---

*Last updated: 2026-04-12*
*Feature owner: Phase 02 / Phase 10.4 / Phase 12.3*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
