# Smoke & Server Lifecycle -- Architecture

Last updated: 2026-04-09

## Overview

The smoke subsystem handles server identity registration, online/offline heartbeats, and garbage collection of stale identity and lobby rows. `ServerIdentity` is a private singleton that authenticates server-to-server reducer calls. `GcResult` is an append-only audit log of GC runs. `IdentityGcJob` is a scheduled table that fires `run_identity_gc` on a configurable interval to clean up disconnected guest identities. `LobbyGcJob` (defined in the lobby subsystem) fires `lobby_gc` to auto-close abandoned lobbies. Post-publish bootstrap runs `register_server` and `seed_identity_gc_job` to initialize the server identity and GC schedule after a `--clear-database` redeploy.

## Table Relationships

```
ServerIdentity (id: u32 autoInc PK)  [PRIVATE]
  +-- identity: Identity (SpacetimeDB client identity)
  +-- serverDatetime: Timestamp (server clock, updated by heartbeat)
  +-- isOnline: bool
  +-- audit columns

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

### register_server(identityHex)
1. Called from `post-publish.ts` after `--clear-database` redeploy
2. Parses `identityHex` into a SpacetimeDB `Identity`
3. Upserts `ServerIdentity` row (delete existing if present, insert new)
4. Logs confirmation

### server_set_datetime(datetimeMs)
1. `ensureServerIdentity(ctx)` -- ctx.sender must match `ServerIdentity.identity`
2. Updates `ServerIdentity.serverDatetime` to provided timestamp
3. Used as heartbeat to confirm server clock alignment

### server_set_online(isOnline)
1. `ensureServerIdentity(ctx)`
2. Updates `ServerIdentity.isOnline` flag
3. Called on server startup (`isOnline=true`) and graceful shutdown (`isOnline=false`)

### seed_identity_gc_job(intervalMs)
1. `ensureServerIdentity(ctx)` OR `ensureAdmin(ctx)`
2. Delete any existing `IdentityGcJob` rows (cancel old schedule)
3. Insert new `IdentityGcJob` row with `scheduledAt = ctx.timestamp + intervalMs`
4. Called from `post-publish.ts` to initialize GC schedule after redeploy

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
| Post-publish bootstrap: register_server + seed_identity_gc_job called from post-publish.ts after --clear-database | Phase 01 execution | 2026-02-01 |
| GcResult audit log: append-only record of every GC run with counts (Phase 12.1) | Phase 12.1 execution | 2026-04-04 |
| IdentityGcJob scheduled table: self-rescheduling pattern (insert next job at end of run) | Phase 01 execution | 2026-02-01 |
| LobbyGcJob moved to lobby subsystem (Phase 12.1 GC restructuring) | Phase 12.1 execution | 2026-04-04 |
| admin_gc_identities / admin_gc_lobbies: on-demand GC for admin tooling | Phase 12.1 execution | 2026-04-04 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 01 / Phase 12.1*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
