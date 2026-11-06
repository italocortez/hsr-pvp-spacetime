# Views -- Architecture

Last updated: 2026-04-13

## Overview

Views are server-side read reducers that return filtered data to authenticated or anonymous callers. They enforce access control (visibility rules, anonymous play masking, private table access) that cannot be expressed via raw table subscriptions. All views in this project are defined in `spacetimedb/src/views/securityViews.ts` and `spacetimedb/src/views/anonymousViews.ts`. Authenticated views use `spacetimedb.view()` and require a connected identity; anonymous views use `spacetimedb.anonymousView()` and are callable without authentication. The anonymous play enforcement pattern (D-92) applies in views 10-20: real `userId` values are replaced with `0` and `anonymousLabel` is used when the lobby has `isAnonymousPlayers=true` or `isAnonymousSpectators=true`.

## View Definitions

### Security Views (securityViews.ts)

#### view_my_profile
- **Auth:** Authenticated (`getAuthenticatedUser`)
- **Returns:** `User` row for the caller
- **Purpose:** Caller reads their own profile (role, username, display name)

#### view_my_identity
- **Auth:** Authenticated
- **Returns:** `UserIdentity[]` rows for the caller
- **Purpose:** Caller reads their linked provider identities (Discord, guest)

#### view_admin_user_private
- **Auth:** Admin only (`ensureAdmin`)
- **Returns:** `UserPrivate` row for a target userId
- **Purpose:** Admin access to private user data (email, provider tokens)

#### view_my_roster
- **Auth:** Authenticated
- **Returns:** `{ accounts: HsrAccount[], characters: HsrAccountCharacter[] }` for the caller
- **Purpose:** Caller manages their own private roster

#### view_public_hsr_accounts
- **Auth:** Anonymous (`anonymousView`) — projection body is the privacy gate (isRosterPublic / isRatingPublic opt-ins); intentional anonymous exception per `docs/auth/architecture.md` Subscription Lifecycle section
- **Returns:** Flat `PublicHsrAccountRow[]` — one row per account-character pair where `isRosterPublic=true`; rating field emitted only when `isRatingPublic=true`
- **Purpose:** Pre-auth public profile browsing
- **Renamed:** Phase 15.5 (D-04) from `view_public_accounts` — `hsr_` in the name identifies the underlying HsrAccount table

#### view_tournament_registrant_accounts
- **Auth:** Authenticated; TO/Assistant/Mod+ for the tournament
- **Returns:** `TournamentPlayerAccount[]` + associated `HsrAccount` rows for a tournament
- **Purpose:** Tournament organizer views locked player account selections

#### view_my_roster_visibility
- **Auth:** Authenticated
- **Returns:** Opponent/ally `HsrAccount[]` + `HsrAccountCharacter[]` based on visibility rules
- **Visibility logic:**
  - Admin: always sees all
  - TO: sees participant rosters for their active tournament
  - Lobby member: sees co-members' rosters if `Lobby.isOpenRoster=true` or `isRosterPublic=true`
  - Everyone else: only `isRosterPublic=true` accounts
- **Purpose:** Draft preparation -- see which characters opponents own

#### view_my_cost_sets
- **Auth:** Authenticated
- **Returns:** `CostSet[]` owned by the caller (via `creator_id` index)
- **Purpose:** Tournament host manages their draft cost configurations

#### view_my_draft_character_costs
- **Auth:** Authenticated
- **Returns:** `CostSetDraftCharacter[]` for all cost sets owned by the caller
- **Purpose:** Edit character costs in draft cost sets

#### view_my_draft_lightcone_costs
- **Auth:** Authenticated
- **Returns:** `CostSetDraftLightcone[]` for all cost sets owned by the caller
- **Purpose:** Edit lightcone costs in draft cost sets

#### view_my_draft_synergy_costs
- **Auth:** Authenticated
- **Returns:** `CostSetDraftSynergy[]` for all cost sets owned by the caller
- **Purpose:** Edit synergy cost modifiers in draft cost sets

### Anonymous Views (anonymousViews.ts)

Views 10-20 apply anonymous enforcement (D-92): when `lobby.isAnonymousPlayers=true` or `isAnonymousSpectators=true`, the `userId` field is replaced with `0` and `anonymousLabel` is used.

#### view_my_lobby_chat
- **Auth:** LobbyMember for the caller
- **Returns:** `ChatMessage[]` for a lobby, with anonymous masking applied
- **Purpose:** Chat display -- hides real sender identity when lobby is anonymous

#### view_my_lobby_members
- **Auth:** LobbyMember for the caller
- **Returns:** `LobbyMember[]` for a lobby, with anonymous masking applied
- **Purpose:** Show who is in the lobby without revealing identities in anonymous mode

#### view_my_match_steps
- **Auth:** LobbyMember for the caller
- **Returns:** `MatchSessionStep[]` for a lobby, with `actorUserId` masked to `0` when anonymous
- **Purpose:** Real-time draft action feed with anonymous enforcement

#### view_my_match_participants
- **Auth:** LobbyMember for the caller
- **Returns:** `MatchResultParticipant[]` for the current match, with userId masked when anonymous
- **Purpose:** Show participant list during scoring without revealing identities

#### view_match_history
- **Auth:** Authenticated
- **Returns:** `MatchResultRecord[]` for a target userId (their match history)
- **Purpose:** Player profile match history display

#### view_match_participant_history
- **Auth:** Authenticated
- **Returns:** `MatchParticipantHistory[]` for a target matchResultId
- **Purpose:** View detailed participant data for a historical match

#### view_match_step_history
- **Auth:** Authenticated
- **Returns:** `MatchSessionStepHistory[]` for a target matchResultId
- **Purpose:** Replay draft actions for a historical match

#### view_my_calendar_events
- **Auth:** Authenticated
- **Returns:** `CalendarEvent[]` organized by the caller + `CalendarEventInvite[]` where caller is invitee
- **Purpose:** Caller's full calendar view

#### view_saved_calendar_slots
- **Auth:** Authenticated
- **Returns:** `AvailabilitySlot[]` for all users the caller has saved in `SavedCalendar` (where `isVisible=true`)
- **Purpose:** Common availability computation across saved calendars

#### view_admin_ban_records
- **Auth:** Admin only
- **Returns:** `BanRecord[]` -- all active bans
- **Purpose:** Admin ban management

#### view_admin_lobby_bans
- **Auth:** Admin only (or lobby host)
- **Returns:** `LobbyBan[]` for a specific lobbyId
- **Purpose:** View and manage per-lobby bans

## Phase 15 -- Views layer reorg + new history views

<!-- Phase 15 D-01, D-02, D-03, D-04: domain-file split + new history views -->

### Domain-file reorg (D-01..D-04)

`securityViews.ts` (915 lines) and `anonymousViews.ts` (453 lines) -- which previously mixed by auth scope rather than by domain -- were split into 8 domain files matching the `tables/` directory layout:

| File | Views | Count |
|------|-------|-------|
| `lobbyViews.ts` | view_lobby_browser, view_my_lobbies, view_my_lobby_chat, view_my_lobby_members | 4 |
| `identityViews.ts` | view_my_identity, view_my_profile, view_public_hsr_accounts, view_admin_user_private | 4 |
| `costSetViews.ts` | view_my_cost_sets, view_my_draft_character_costs, view_my_draft_lightcone_costs, view_my_draft_synergy_costs | 4 |
| `statsViews.ts` | view_my_player_stats, view_my_character_stats | 2 |
| `socialViews.ts` | view_my_relationships, view_my_roster_visibility, view_my_roster | 3 |
| `matchViews.ts` | view_my_match_steps, view_my_match_participants | 2 |
| `matchHistoryViews.ts` | view_match_history, view_match_participant_history, view_match_step_history + 5 new `view_my_*_history` | 8 |
| `tournamentViews.ts` | 7 existing tournament views | 7 |

**Reorg invariant (D-03)**: move-only. Every `spacetimedb.view(...)` call preserved verbatim; only import paths change. Re-export surface at `spacetimedb/src/index.ts` unchanged in aggregate (each view still appears once in the barrel). Binding count is `32 -> 37` solely because of the 5 new history views added in `matchHistoryViews.ts` -- no bindings were renamed or removed.

**Ordering rationale (D-04)**: the reorg landed BEFORE the new history views so `matchHistoryViews.ts` existed as the permanent home when the 5 new views were authored. Cross-reference `docs/match/architecture.md` for the filter patterns used by those 5 views.

### Filter-pattern registry

Two patterns cover every `view_my_*` view that filters on `ctx.sender`:

- **Pattern A -- Direct user-index filter**: for backing tables with a `userId` column, the view resolves `ctx.sender` to a `mapping.userId` via `UserIdentity.identity.find` and then filters the target table's btree index on `userId`. Examples: `view_my_character_stats`, `view_my_mmr_history`, `view_my_match_participant_history`.
- **Pattern B -- Participant-first iteration**: for backing tables WITHOUT a `userId` column (history tables keyed by `matchHistoryId`), the view first collects the caller's match IDs from `MatchParticipantHistory.by_user`, then fans out to the target table via its `by_match_history` index (or `id.find` for session history). Complexity is `O(user's matches)`, not `O(all matches)`. Examples: `view_my_match_session_history`, `view_my_match_session_step_history`, `view_my_match_result_game_history`; pre-split reference: `view_my_tournament_matches` at `securityViews.ts:710`.

### 5 new self-scoped history views (D-13)

Added to `matchHistoryViews.ts`, bindings at `src/module_bindings/view_my_*_history_table.ts`. All use `public: true` with server-side `ctx.sender` gating (matches the 23 existing `view_my_*` entries). See `docs/match/architecture.md` for per-view detail.

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Views use spacetimedb.view() for authenticated and spacetimedb.anonymousView() for unauthenticated callers | Phase 09 CONTEXT.md | 2026-03-28 |
| Anonymous enforcement in views (D-92): userId replaced with 0, anonymousLabel used when lobby is anonymous | Phase 09 CONTEXT.md | 2026-03-28 |
| HsrAccount and HsrAccountCharacter made private -- view_my_roster and view_public_accounts are the only client access paths (D-20) | Phase 10.4 execution | 2026-03-29 |
| view_my_roster_visibility: four-tier visibility (admin / TO / lobby member / public) | Phase 06 execution | 2026-02-28 |
| Cost set draft views (view_my_draft_*): resolve creatorId via iter() -- no cross-table index | Phase 03 execution | 2026-02-15 |
| view_match_history, view_match_participant_history, view_match_step_history: anonymous-safe historical access | Phase 09 execution | 2026-03-28 |
| view_my_calendar_events: combines organizer events + invitee events in one call | Phase 08 execution | 2026-03-28 |
| view_saved_calendar_slots: filters by isVisible=true on SavedCalendar | Phase 08 execution | 2026-03-28 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| Views layer split from 2 files into 8 domain files (lobbyViews, identityViews, costSetViews, statsViews, socialViews, matchViews, matchHistoryViews, tournamentViews); move-only invariant (D-01..D-04) | Phase 15 execution | 2026-04-13 |
| 5 new self-scoped history views added to matchHistoryViews.ts (D-13); binding count 32 -> 37; Pattern A vs Pattern B filter registry documented | Phase 15 execution | 2026-04-13 |
| view_user_directory flipped from anonymousView to authenticated-only spacetimedb.view() (D-06); dead .filter(u => !u.deletedAt) removed (D-09 eliminates ghosts at write path); ghost accumulation bounded by DeletedUser archive (D-05/D-09) | Phase 15.2 execution | 2026-04-15 |
| UAT (Test 4) revealed D-06's `spacetimedb.view()` flip does NOT reject anonymous subscribers at the framework level — per SpacetimeDB docs (https://spacetimedb.com/docs/functions/views/), `view` vs `anonymousView` differs only in whether `ctx.sender()` is exposed to the body, not in who can subscribe. The implementation comment at `identityViews.ts:47-49` overstated the behavior. `view_user_directory` has zero frontend subscribers; the actual pre-auth bandwidth leak is `useAuth.ts:38`'s unconditional `SELECT * FROM user` subscription. Phase 15.5 retires `view_user_directory` entirely and gates `useAuth.ts:38` behind auth state (seed: `.planning/seeds/phase-15.5-auth-gated-user-subscription.md`) | Phase 15.2 execution | 2026-04-16 |
| Phase 15.5: `view_user_directory` retired (dead code, zero client subscribers); `view_public_accounts` renamed to `view_public_hsr_accounts` (D-04) — `hsr_` names the source table. Both bindings dirs regenerated via single-shot `spacetime generate` after publish. Frontend subscription lifecycle codified in `docs/auth/architecture.md` Subscription Lifecycle section (D-05): Stage 1 `view_my_profile` always; Stage 2 raw User subscription gated on `currentUser != null \|\| hadUserIdOnMount.current \|\| hadSessionCookie.current` (gate signal swapped from `hadTokenOnMount` per Plan 02 D-01 deviation `790a39c` — SDK auto-persists anonymous identity tokens, so token presence is not proof of prior auth; `spacetimedb_user_id` is the correct post-auth signal). `view_lobby_browser` + `view_public_hsr_accounts` named as intentional anonymous exceptions (projection-based privacy) | Phase 15.5 execution | 2026-04-16 |
| Phase 15.5 verify-work: harmonized doc wording with shipped `useAuth.ts` identifier `hadUserIdOnMount`; `docs/views/contract.md` swept of stale `view_user_directory` subsection + `view_public_accounts` references | Phase 15.5 verify-work | 2026-04-17 |

---

*Last updated: 2026-04-17*
*Feature owner: Phase 03 / Phase 06 / Phase 08 / Phase 09 / Phase 10.4 / Phase 15*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
