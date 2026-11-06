# HSRPVP Backend -- Frontend Handoff

Last updated: 2026-04-12

> **TL;DR:** The backend (v0.5) is complete. All 86 mapped requirements are implemented across 25 phases. You have 67 tables, ~156 reducer exports, 32 server-side views, and generated TypeScript bindings. The frontend (v1) needs to be built on top of this. This document routes you to everything you need.

---

## Backend Summary

- **SpacetimeDB SDK:** 2.6.1 (`spacetimedb/react` on the client, `spacetimedb/server` in the module) — upgraded from 2.1.0→2.2.0 (Phase 16.4) → 2.6.1 (Phase 16.5)
- **Tables:** 67 production table definitions (`spacetimedb/src/tables/`)
- **Reducers:** ~156 exports across 44 reducer source files (`spacetimedb/src/reducers/`)
- **Views:** 32 server-side named views (`securityViews.ts`: 24, `anonymousViews.ts`: 8)
- **Requirements:** All 86 mapped v0.5 requirements complete (89 total, 3 out of scope — TEAM-01, TEAM-02, TEAM-03). See `.planning/REQUIREMENTS.md` traceability table.
- **Tests:** 729 tests across 63 files — integration tests (`test/backend/**/*.test.ts`, excludes `*.unit.test.ts`) + unit tests (`*.unit.test.ts`).
- **Generated bindings:** 236 TypeScript files in `src/module_bindings/` — regenerate with `spacetime generate` after schema changes

---

## Feature Map

Each of the 19 feature areas has two canonical docs: `architecture.md` (tables, reducer flows, data model) and `contract.md` (acceptance scenarios, edge cases, error messages).

| Feature | Tables | Reducers | Docs |
|---------|--------|----------|------|
| Auth | 4 (User, UserIdentity, UserPrivate, ServerIdentity) | 8 | [arch](auth/architecture.md) / [contract](auth/contract.md) |
| Admin | 2 (BanRecord, UserDeletionJob) | 8 | [arch](admin/architecture.md) / [contract](admin/contract.md) |
| Roster | 5 (HsrAccount, HsrAccountCharacter, HsrAccountLightcone, Archetype, HsrCharacterArchetype) | 22 | [arch](roster/architecture.md) / [contract](roster/contract.md) |
| Archetypes | 2 (Archetype, HsrCharacterArchetype) | 4 | [arch](archetypes/architecture.md) / [contract](archetypes/contract.md) |
| Cost Sets | 6 (CostSet, 3 live + 3 draft tables) | 8 | [arch](cost-sets/architecture.md) / [contract](cost-sets/contract.md) |
| Tournament | 8 (Tournament, TournamentEnrolled, TournamentTeam, TournamentTeamMember, TournamentAssistant, TournamentPlayerAccount, TournamentTeamRequest, TournamentStandIn) | 29 | [arch](tournament/architecture.md) / [contract](tournament/contract.md) |
| Brackets | 2 (BracketMatch, GroupPhaseRecord) | 7 | [arch](brackets/architecture.md) / [contract](brackets/contract.md) |
| Match Session | 6 (MatchSession, MatchSessionStep, MatchSessionHistory, MatchSessionStepHistory, MatchParticipantHistory, LobbyCursorEvent) | 18 | [arch](match-session/architecture.md) / [contract](match-session/contract.md) |
| Lobby | 7 (Lobby, LobbyMember, LobbyMemberAccount, LobbyBan, LobbyPreset, LobbyPassword, LobbyGcJob) | 18 | [arch](lobby/architecture.md) / [contract](lobby/contract.md) |
| Match Results | 7 (MatchResultRecord, MatchResultGame, MatchResultParticipant, MatchResultGameHistory, ChatMessage, EloConfig) | 9 | [arch](match-results/architecture.md) / [contract](match-results/contract.md) |
| MMR | 4 (MmrRating, MmrHistory, Leaderboard, Season) | 7 | [arch](mmr/architecture.md) / [contract](mmr/contract.md) |
| Player Stats | 5 (PlayerStat, PlayerCharacterStat, GlobalCharacterStat, PlayerRelationship, AccountRatingConfig) | 0 direct (computed) | [arch](player-stats/architecture.md) / [contract](player-stats/contract.md) |
| Achievements | 3 (Achievement, AchievementCriteria, UserAchievement) | 7 | [arch](achievements/architecture.md) / [contract](achievements/contract.md) |
| Calendar | 4 (CalendarEvent, CalendarEventInvite, AvailabilitySlot, SavedCalendar) | 12 | [arch](calendar/architecture.md) / [contract](calendar/contract.md) |
| Anonymous Play | (views only -- no tables) | 0 direct | [arch](anonymous-play/architecture.md) / [contract](anonymous-play/contract.md) |
| Chat | 1 (ChatMessage) | 2 | [arch](chat/architecture.md) / [contract](chat/contract.md) |
| Views | (32 named views, no tables) | 32 views | [arch](views/architecture.md) / [contract](views/contract.md) |
| Smoke / GC | 3 (ServerIdentity, IdentityGcJob, GcResult) | 5 | [arch](smoke/architecture.md) / [contract](smoke/contract.md) |

**Start here:** `docs/roster/` is the gold standard docs example and the simplest feature. Read it first to understand the doc format.

---

## Authentication Flow

```
1. App loads → DbConnection.builder().withConfirmedReads(false).build() → WebSocket to maincloud
2. No token → new SpacetimeDB identity created, stored in localStorage
3. User clicks LOG IN → loginAsGuest() reducer → User + UserIdentity rows created
4. Optional: Discord OAuth via NextAuth → POST /api/auth/link-discord → server_link_provider reducer
   - Stores discordId/discordUsername/email in UserPrivate (PRIVATE table, not broadcast)
5. view_my_profile delivers merged profile (User + UserPrivate) to client
6. On every connect: ban check via BanRecord table; banned users are disconnected immediately
```

**Session cookie pattern:** `stdb_session` cookie is set for SSR-safe auth display. Read `components/features/auth/hooks/useAuth.ts` for the full orchestration.

**Key auth tables:**
- `User` (public) — username, avatarCharacterName, displayedAchievementId
- `UserPrivate` (PRIVATE) — discordId, discordUsername, email; accessed only via `view_my_profile`
- `UserIdentity` (PRIVATE) — maps SpacetimeDB Identity to userId; accessed only via named views
- `BanRecord` (PRIVATE) — checked on connect; accessed only via `view_admin_user_private`

---

## Data Access Patterns

### Subscriptions (Reading Data)

SpacetimeDB tables auto-sync via WebSocket subscription. Public tables broadcast to all subscribers. Private tables (`public: false`) are never broadcast — they are only accessible via server-side named views.

```typescript
import { tables } from '@/src/module_bindings';

// Returns rows[], isReady
const [characters] = useTable(tables.HsrCharacter);
const [tournaments] = useTable(tables.Tournament);
```

**Private tables (never subscribed directly):**
`UserPrivate`, `BanRecord`, `UserIdentity`, `ServerIdentity`, `HsrAccount`, `HsrAccountCharacter`, `PlayerStat`, `PlayerCharacterStat`, `PlayerRelationship`, `GcResult`, `LobbyMemberAccount`

### Views (Filtered/Private Data)

32 server-side views replace raw table subscriptions for private or bandwidth-sensitive data. Views are the primary privacy mechanism — they filter rows to only what the current caller should see.

```typescript
// Subscribe to a view (same pattern as tables)
const profile = useTable(conn.db.view_my_profile);
const rosterAccounts = useTable(conn.db.view_my_roster);
const lobbyBrowser = useTable(conn.db.view_lobby_browser);
```

**Key views for frontend:**
| View | Purpose |
|------|---------|
| `view_my_profile` | Authenticated user's full profile (User + UserPrivate merged) |
| `view_my_roster` | Caller's HsrAccount rows + characters (replaces direct HsrAccount subscription) |
| `view_lobby_browser` | Public lobby listings with computed fields |
| `view_my_lobby_members` | Lobby members with anonymous labels applied |
| `view_my_match_steps` | Draft steps with anonymous character names applied |
| `view_my_tournaments` | Tournaments the caller is enrolled in |
| `view_public_hsr_accounts` | HSR accounts with public visibility flag applied |
| `view_match_history` | Archived match sessions for replay |
| `view_match_participant_history` | Participants from archived matches |

See `docs/views/architecture.md` for the full list of all 32 views.

### Reducer Calls (Writing Data)

Reducers are transactional server-side functions. They **do not return data** — results are read via table subscriptions after the reducer completes.

```typescript
import { DbConnection } from '@/src/module_bindings';

const conn = getConnection(); // from useSpacetimeDB()

// Phase 12.2: reducer calls return Promise<void> -- use .catch() for errors
conn.reducers.create_tournament({
  name: "Weekly Cup",
  format: "SingleElimination",
  // ...
}).catch(err => console.error('create_tournament failed:', err));

// Table subscription auto-updates with new tournament row
```

### Client Bindings

Generated via `spacetime generate` from the published module. Located in `src/module_bindings/` (236 files):
- One file per table: `{table_name}_table.ts`
- One file per reducer: `{reducer_name}_reducer.ts`
- 32 view binding files: `view_{name}_table.ts`

Regenerate after any schema change: `npx spacetime generate --lang typescript --out-dir src/module_bindings`

---

## Key Conventions for Frontend

### Enums Are Tag Objects

SpacetimeDB enums arrive as `{ tag: 'EnumVariant' }` objects, not plain strings.

```typescript
// Correct
tournament.stage.tag === 'Registration'
matchResult.status.tag === 'Completed'

// Wrong
tournament.stage === 'Registration'
```

### Timestamps

SpacetimeDB `Timestamp` values are microseconds since epoch as `bigint`.

```typescript
const date = new Date(Number(ts.__timestamp_micros_since_unix_epoch) / 1000);
```

### Optional = Sentinel

- Missing `u32` FK → `0` (sentinel value, not null)
- Missing string → empty string `""`
- Optional SpacetimeDB fields use `.optional()` in schema and `undefined` in TypeScript

### Identity vs userId

- `Identity` = opaque 32-byte hex string, SpacetimeDB's internal identifier
- `userId` = `u32` auto-increment, the application's user identifier
- `UserIdentity` maps between them (PRIVATE — access via views only)
- **Always use `userId` for application logic**, never raw `Identity`

### Anonymous Play Labels

Labels for anonymous players are computed server-side in `anonymousLabels.ts`. The frontend just displays what `view_my_lobby_members` and `view_my_match_steps` return — do not compute labels on the client.

### Roster Visibility

Roster visibility (public/private) is server-enforced at the view layer. `view_public_hsr_accounts` and `view_my_roster` handle the filtering. The frontend never needs to manually check `isRosterPublic`.

### Roster Mutation Guards (Phase 12.3)

The following reducers reject if the caller has an active `LobbyMemberAccount` row (i.e., the caller is currently in a match):
- `set_active_hsr_account`
- `batch_upsert_characters`
- `batch_remove_characters`
- `migrate_roster`

Show the user a clear error message if these fail while they are in a lobby. Error message format: `"Cannot modify roster or switch account while in an active match"`.

### Tournament Lifecycle

Stage machine (forward-only):

```
Draft -> Registration -> [CheckIn ->] Seeding -> InProgress -> Completed
                                                             -> Cancelled (from any non-terminal stage)
```

### Match Lifecycle (Lobby Stages)

```
Waiting -> Drafting -> Equipping -> Scoring -> AwaitingResult -> Completed
```

### Best-of-N Series

Series management uses `advance_to_next_game`, `shelve_series`, and `resume_series`. The `MatchResultRecord` tracks the current series state. See `docs/match-session/architecture.md` for the full series flow.

### Reducer Error Handling (Phase 12.2)

All reducer calls return `Promise<void>`. Errors surface via `.catch()`:

```typescript
conn.reducers.joinLobby(lobbyId).catch(err => {
  // err.message contains the SenderError string from the backend
  showToast(err.message);
});
```

---

## Existing Frontend Pages

| Route | Layout | Auth Required | Status |
|-------|--------|---------------|--------|
| `/` | landing-page | No | Working — video hero, features carousel, contact section |
| `/costs` | landing-page | No | Working — cost table browser |
| `/teambuilder` | landing-page | No | Working — team composition builder |
| `/lobby` | authenticated | Yes | Stub — placeholder only |
| `/profile` | authenticated | Yes | Working — Discord link, avatar, logout |
| `/admin-view` | authenticated | Yes (Admin) | Working — table explorer, bulk upsert, user manager |
| `/draft/[matchId]` | game | Yes | Stub — draft picking placeholder |

---

## Project Planning References

| What | File |
|------|------|
| Full requirements | [.planning/REQUIREMENTS.md](../.planning/REQUIREMENTS.md) |
| Roadmap & phase status | [.planning/ROADMAP.md](../.planning/ROADMAP.md) |
| Current state | [.planning/STATE.md](../.planning/STATE.md) |
| Architecture overview | [.planning/codebase/ARCHITECTURE.md](../.planning/codebase/ARCHITECTURE.md) |
| Tech stack | [.planning/codebase/STACK.md](../.planning/codebase/STACK.md) |
| Project structure | [.planning/codebase/STRUCTURE.md](../.planning/codebase/STRUCTURE.md) |
| Schema diagram | [notes/erd-mermaid.md](../notes/erd-mermaid.md) |

---

## Code Locations

| What | Path | Notes |
|------|------|-------|
| Backend tables | `spacetimedb/src/tables/` | 67 table definitions |
| Backend reducers | `spacetimedb/src/reducers/` | 44 reducer files, ~156 exports |
| Backend views | `spacetimedb/src/views/` | 32 named views (securityViews.ts: 24, anonymousViews.ts: 8) |
| Backend helpers | `spacetimedb/src/helpers/` | ELO calc, bracket gen, stats, audit, roster mutations |
| Backend enums | `spacetimedb/src/types/enums.ts` | Role, GameMode, DraftMode, TournamentStage, BracketFormat, etc. |
| Generated bindings | `src/module_bindings/` | 236 files — regenerate with `spacetime generate` |
| Frontend components | `components/features/` | Feature-grouped components |
| Pages | `app/` | Next.js App Router pages |
| Auth system | `components/features/auth/` | AuthProvider, useAuth, LoginForm |
| Connection config | `lib/spacetimedb.ts` | Host + DB name |
| Providers stack | `app/providers.tsx` | SpacetimeDB → Auth → GameData |
| Design tokens | `app/tokens.css` | 89 CSS custom properties |

---

## Development Entry Points

1. **Start here:** `docs/roster/` — simplest feature, gold standard docs format, best example of table/reducer/view patterns
2. **Auth first:** `docs/auth/architecture.md` — understand identity, UserPrivate, view_my_profile before building any authenticated UI
3. **Core gameplay loop:** `docs/lobby/`, `docs/match-session/`, `docs/tournament/` — the three main interaction surfaces
4. **Schema overview:** `notes/erd-mermaid.md` — paste into [mermaid.live](https://mermaid.live) for a visual schema map with all 67 tables

---

## For AI Agents

Routing guide for AI agents reading this file:

- **Feature data model:** Read `docs/{feature}/architecture.md`
- **Expected behavior and edge cases:** Read `docs/{feature}/contract.md`
- **Reducer params (exact types):** Read `src/module_bindings/{reducer_name}_reducer.ts`
- **Table schemas:** Read `src/module_bindings/{table_name}_table.ts`
- **Auth flow:** Read `components/features/auth/hooks/useAuth.ts`
- **Data subscriptions:** Read `components/features/game-data/components/GameDataProvider.tsx`
- **Connection setup:** Read `app/providers.tsx` and `lib/spacetimedb.ts`
- **Project requirements:** Read `.planning/REQUIREMENTS.md`
- **Phase completion status:** Read `.planning/ROADMAP.md`
- **Design tokens:** Read `app/tokens.css`
- **SpacetimeDB patterns:** Read `.claude/skills/spacetimedb/SKILL.md`
- **Architecture overview:** Read `.planning/codebase/ARCHITECTURE.md`

---

*Last updated: 2026-04-12*
*Backend complete as of Phase 14 (test harness modernized for SDK 2.1.0). All v0.5 requirements implemented.*
