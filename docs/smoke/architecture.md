# Smoke & Server Lifecycle -- Architecture

Last updated: 2026-11-06

## Overview

The smoke subsystem handles server identity registration, the test-only server utilities, and garbage collection of stale identity and lobby rows. `ServerIdentity` is a private table of trusted server identities: one **Owner** (the publisher, registered by `init`) and the **Delegates** the owner registers (the bootstrap / Vercel auth token). It authenticates server-to-server reducer calls. `GcResult` is an append-only audit log of GC runs. `IdentityGcJob` is a scheduled table that fires `run_identity_gc` on a configurable interval to clean up disconnected guest identities. `LobbyGcJob` (defined in the lobby subsystem) fires `lobby_gc` to auto-close abandoned lobbies. After a wipe publish, `init` registers the Owner and the SYSTEM user; `scripts/stdb/bootstrap.ts --target <t>` registers a fresh Delegate, writes its token to `.env.<t>.local`, and seeds game data and the GC schedule. The module declares the env value `STDB_TARGET` (`test` | `prod`); the test-only reducers reject unless it is `test`.

## Table Relationships

```
ServerIdentity (identity: Identity PK)  [PRIVATE]
  +-- kind: ServerIdentityKind (Owner | Delegate)
  +-- label: string ('owner', 'vercel-auth-<target>')
  +-- registeredAt: Timestamp

Module env (schema settings, not a table):
  STDB_TARGET: 'test' | 'prod'   (supplied at publish time; cleared by --delete-data)

GcResult (id: u32 autoInc PK)  [public: true]
  +-- gcType: GcType (Identity | Lobby)
  +-- deletedCount: u32
  +-- checkedCount: u32
  +-- ranAt: Timestamp
  +-- audit columns

IdentityGcJob (scheduledId: u64 autoInc PK)  [PRIVATE]
  +-- scheduledAt: Timestamp
  +-- scheduledReducer: string (= "run_identity_gc")
  +-- data: IdentityGcJobData
        .intervalMs: u64 (how often to reschedule)
```

## Reducer Flows

### init -- lifecycle hook (first publish and every `--delete-data` republish)
1. If `ServerIdentity` is empty: insert `ctx.sender` (the publisher) as `kind=Owner`, `label='owner'`
2. Insert the SYSTEM user (`username='SYSTEM'`, role Admin, id from autoInc; audit actor `SYSTEM_USER_ID=0`)
3. Insert `UserIdentity` linking the owner identity to the SYSTEM row
4. Seed the `AbuseConfig` singleton (id 1, D-B5 defaults, SYSTEM actor), only when absent, on every init (Phase S5 execution, A42; docs/admin/architecture.md "Abuse controls"). Phase S6 execution (A57): no breaker job; the guest-lobby breaker runs inline in `create_lobby`
5. Seed the system lobby preset "Tournament default" (`isSystemPreset`, owner `SYSTEM_USER_ID`), only when absent, on every init (Phase S6 execution, A33a / CH-S4)

### Guards (reducers/server.ts)
- `requireServer(ctx)`: `ctx.sender` has any `ServerIdentity` row (Owner or Delegate). Used by `server_link_provider`, `server_set_role`, `server_delete_user` and the test-only reducers.
- `requireOwner(ctx)`: the row's `kind` is `Owner`. Used by the delegate reducers.
- `requireTestDatabase(ctx)`: `ctx.env.STDB_TARGET === 'test'`, else "Not a test database." First line of `server_set_datetime`, `server_set_online`, `server_set_mmr`, `server_nuke_test_data` (default-deny: a database published without the value rejects too).

### server_register_delegate(identityHex, label) -- Owner only
1. `requireOwner(ctx)`; parse `identityHex`; reject an identity already registered or already linked to a user
2. Insert `ServerIdentity` (`kind=Delegate`, `label`) and a `UserIdentity` row linking it to the SYSTEM user (so `ensureAdmin` passes for seeding)

### server_revoke_delegate(identityHex) -- Owner only
1. `requireOwner(ctx)`; reject unknown identities and the Owner row
2. Delete the delegate's `ServerIdentity` row and its `UserIdentity` row

### server_set_datetime(tableName, primaryKey, field, timestampMicros) -- test only
1. `requireTestDatabase(ctx)`, `requireServer(ctx)`
2. Overwrites a timestamp column on `user_identity` (lastSeenAt / createdDate) or `lobby` (createdDate) to test time-dependent behavior

### server_set_online(userId, isOnline) -- test only
1. `requireTestDatabase(ctx)`, `requireServer(ctx)`
2. Forces `User.isOnline` (maincloud disconnect detection is too slow for test windows)

### seed_identity_gc_job(intervalMs)
1. `ensureServerIdentity(ctx)` OR `ensureAdmin(ctx)`
2. Delete any existing `IdentityGcJob` rows (cancel old schedule)
3. Insert new `IdentityGcJob` row with `scheduledAt = ctx.timestamp + intervalMs`
4. Called from `scripts/stdb/bootstrap.ts` (and `seed.ts`) to initialize the GC schedule after a wipe

### run_identity_gc() -- scheduled reducer
1. Fired by SpacetimeDB scheduler from `IdentityGcJob.scheduledAt`
2. Scan all `UserIdentity` rows; find identities where the SpacetimeDB connection is disconnected
3. For disconnected guest identities with no match history references: delete `UserIdentity` row and associated `User` row (soft or hard based on `hasHistoryReferences`)
4. Insert `GcResult` row: `gcType=Identity`, counts of checked and deleted rows
5. Reschedule: insert new `IdentityGcJob` row with `scheduledAt = ctx.timestamp + intervalMs`

### admin_gc_identities()
1. `ensureAdmin(ctx)` -- Admin only
2. Runs same logic as `run_identity_gc` but on-demand (no reschedule)
3. Returns result via `GcResult` insert

### admin_gc_lobbies()
1. `ensureAdmin(ctx)` -- Admin only
2. Scan all `Lobby` rows in non-terminal stages (not Closed)
3. For each: check if host identity is disconnected and GC timeout has elapsed
4. Trigger `hardDeleteLobby` for eligible stale lobbies
5. Insert `GcResult` row: `gcType=Lobby`, counts

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| ServerIdentity is private singleton -- authenticates server-to-server calls via ctx.sender identity | Phase 01 execution | 2026-02-01 |
| Post-publish bootstrap: first-come server registration + seed_identity_gc_job called from post-publish.ts after --clear-database (registration replaced in M2) | Phase 01 execution | 2026-02-01 |
| GcResult audit log: append-only record of every GC run with counts (Phase 12.1) | Phase 12.1 execution | 2026-04-04 |
| IdentityGcJob scheduled table: self-rescheduling pattern (insert next job at end of run) | Phase 01 execution | 2026-02-01 |
| LobbyGcJob moved to lobby subsystem (Phase 12.1 GC restructuring) | Phase 12.1 execution | 2026-04-04 |
| admin_gc_identities / admin_gc_lobbies: on-demand GC for admin tooling | Phase 12.1 execution | 2026-04-04 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| `init` registers the Owner + SYSTEM user; owner-only `server_register_delegate` / `server_revoke_delegate`; module env `STDB_TARGET` gates the test-only reducers; `scripts/stdb/bootstrap.ts` replaces post-publish.ts | Phase M2 execution | 2026-11-06 |
| `init` seeds `AbuseConfig` and the `AbuseBreakerJob` chain (no bootstrap call needed); `server_nuke_test_data` clears `UserRateState` / `AdminAlert` and keeps the `AbuseBreakerJob` chain and keeps `AbuseConfig` | Phase S5 execution (DECISIONS.md A42, A43) | 2026-11-06 |
| `init` no longer seeds a breaker job (inline breaker, A57) and seeds the system lobby preset (A33a); `server_nuke_test_data` clears `AbuseCounter` and re-seeds the system preset after clearing `LobbyPreset` | Phase S6 execution (DECISIONS.md A57, A33a) | 2026-11-06 |

---

*Last updated: 2026-11-06*
*Feature owner: Phase 01 / Phase 12.1*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
