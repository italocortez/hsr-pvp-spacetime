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

### Guards (reducers/identity/server.ts)
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
1. Fired by SpacetimeDB scheduler from `IdentityGcJob.scheduledAt`; S11a (triage L11): any other caller is refused before any read ("Forbidden: run_identity_gc is a scheduled reducer and runs only from the scheduler.", `ensureScheduler`, `ctx.senderAuth.isInternal`)
2. Scan all `UserIdentity` rows grouped by user; orphan mappings are deleted; a verified user loses identities idle 90 days (never the newest, never while online, never server identities or SYSTEM mappings)
3. Guest users (Phase S10h execution, A95(1)): a guest idle 30 days with no match history at all is deleted through `performUserDeletion`, at most 500 per run (a scheduled run that reaches the cap requeues in one hour, not seven days: S10h review F4); full rule in `docs/auth/architecture.md`
4. Insert `GcResult` row: `gcType=Identity`, counts of checked and deleted rows
5. Reschedule: insert new `IdentityGcJob` row with `scheduledAt = ctx.timestamp + intervalMs`

### admin_gc_identities()
1. `ensureAdmin(ctx)` -- Admin only
2. Runs same logic as `run_identity_gc` but on-demand (no reschedule); S11a (triage L6): when `IdentityGcJob` holds no row (the chain stopped), it inserts the next run 7 days out
3. Returns result via `GcResult` insert

### admin_gc_lobbies()
1. `ensureAdmin(ctx)` -- Admin only
2. Scan all `Lobby` rows in non-terminal stages (not Closed)
3. For each: check if host identity is disconnected and GC timeout has elapsed
4. Trigger `hardDeleteLobby` for eligible stale lobbies
5. Insert `GcResult` row: `gcType=Lobby`, counts
6. S11a (triage L6): when `LobbyGcJob` holds no row (the chain stopped), insert the next `run_lobby_gc` 15 min out

## Phase S10s execution (DECISIONS.md A122(23); triage L99 to L102)

Scripts and tools only; no module, schema or binding change. Scenarios: [contract.md](contract.md) (unchanged).

- **Prod token source (L99).** `scripts/stdb/_env.ts` `targetEnvRecord` is now `mergeTargetEnv(target, process.env,
  fileEnv)`: the shell environment merged with `.env.<target>.local`, the file winning. For `prod`, `STDB_SERVER_TOKEN`
  is taken from `.env.prod.local` only: a value exported in the shell is dropped, so a privileged prod script with no
  token in the prod file fails fast (`STDB_SERVER_TOKEN is missing for target "prod"…`) instead of sending a test token.
  For `test` the shell value stays a fallback when `.env.test.local` has none (CI and one-off runs against test1 may
  export it; a token from another target reaching test1 is the harmless direction).
- **Prod flag allow-list (L100).** `shared/stdb-targets.ts` `assertNoForbiddenProdFlags(args)` (called by
  `publish.ts` and by `_spawn.ts` for every prod command) accepts only the exact flags of `ALLOWED_PROD_FLAGS`:
  `--server` followed by `maincloud`, `--no-config`, `--module-path` followed by a value that is not a flag,
  `--yes=migrate`, `--json`; any other argument starting with `-` (`--yes=migrate,delete-data`, `--yes=break-clients`,
  `-y`, `--delete-data`, an unknown flag) is refused with `argument "<arg>" is forbidden against prod.`; positional
  arguments pass. `FORBIDDEN_PROD_FLAGS` stays as the grep list.
- **Delegate rotation order (L101).** `scripts/stdb/bootstrap.ts` steps 3-4 go through `rotateDelegate`
  (`scripts/stdb/_delegate.ts`): `server_register_delegate` for the new identity, then the new token and identity are
  written to `.env.<target>.local`, then `server_revoke_delegate` of the identity the file held before (best effort, a
  failure is logged). A failure before the revoke leaves the previous delegate registered, so the token the auth
  function holds keeps working. Unit-tested with fakes (`test/backend/scripts/delegate-rotation.unit.test.ts`).
- **Energy model (L102).** `tools/energy-model.js` no longer sizes the `PlayerSnapshot` struct (removed from the module
  in S10j; the line was not used by any formula).

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
| `run_identity_gc` / `admin_gc_identities` delete guest users idle 30 days with no match history (A95(1), 500 per run; `GcResult.details.guests`); the run description above corrected to the code | Phase S10h execution (DECISIONS.md A95) | 2026-11-10 |
| Prod token only from `.env.prod.local`; prod CLI flags checked against an allow-list (`--yes=migrate` the only confirmation); bootstrap registers and saves the new delegate before revoking the old one; the energy model drops `PlayerSnapshot` | Phase S10s execution (DECISIONS.md A122(23)) | 2026-11-10 |
| Scheduled reducers refuse every caller but the scheduler (`ensureScheduler`, L11); `admin_gc_identities` / `admin_gc_lobbies` restart a stopped job chain (L6); `server_nuke_test_data` clears `LobbyCursorStamp`; `stdb:guest-switch` script (L12); energy model: `user`, `leaderboard`, `availability_slot` sized to the current schema | Phase S11a execution | 2026-11-11 |

---

*Last updated: 2026-11-11 (S11a part 2)*
*Feature owner: Phase 01 / Phase 12.1*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
