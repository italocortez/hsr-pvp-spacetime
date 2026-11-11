# Views -- Architecture

Last updated: 2026-11-08

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
- **Superseded:** S9b (Moderator+, every linked user) and S11a (read from `User`, A77); see "Phase S11a execution"

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
- **S10g:** non-terminal tournaments only; neutral label when hidden; field-only rows for non-staff readers (see "Phase S10g execution")

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

#### view_published_cost_sets (Phase S11a execution, triage L91)
- **Auth:** Anonymous view (`anonymousView`, one shared result)
- **Returns:** `CostSet[]` with `isPublished = true` (via the `is_published` index; a locked set is listed with its flag)
- **Purpose:** `CostSet` is private since S11a; this is how every client reads the selectable sets (the reference set subscribes it in place of the table)

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

#### Calendar views
- **Auth:** Authenticated (per-sender)
- **Views:** `view_my_calendar_events`, `view_my_calendar_invites`, `view_my_availability`,
  `view_saved_calendar_availability`, `view_my_saved_calendars`, `view_event_attendees(eventId)` (S10ad)
  (`views/calendarViews.ts`). Events and invites are two
  separate views; the saved players' slots are `view_saved_calendar_availability` (no `view_saved_calendar_slots`
  exists). Rows and paths: "Phase S9b execution" below, as changed by "Phase S10ac execution" and "Phase S10ad
  execution".

#### view_admin_ban_records
- **Auth:** Admin only
- **Returns:** `BanRecord[]` -- all active bans
- **Purpose:** Admin ban management

#### view_admin_lobby_bans
- **Auth:** Moderator+ (staff-only full read); the host and referees read `view_my_lobby_bans`
- **Returns:** `AdminLobbyBanRow[]` for every lobby: lobbyId, bannedUserId, bannedJoinSeq (A74(2), S9c), labels, createdDate
- **Purpose:** View and manage per-lobby bans; the In-Cell grid lifts one with `unban_member(lobbyId, bannedJoinSeq)`

## Phase 15 -- Views layer reorg + new history views

<!-- Phase 15 D-01, D-02, D-03, D-04: domain-file split + new history views -->

### Domain-file reorg (D-01..D-04)

`securityViews.ts` (915 lines) and `anonymousViews.ts` (453 lines) -- which previously mixed by auth scope rather than by domain -- were split into 8 domain files matching the `tables/` directory layout:

| File | Views | Count |
|------|-------|-------|
| `lobbyViews.ts` | view_lobby_browser, view_my_lobbies, view_my_lobby_chat, view_my_lobby_members | 4 |
| `identityViews.ts` | view_my_identity, view_my_profile, view_public_hsr_accounts, view_admin_user_private | 4 |
| `costSetViews.ts` | view_my_cost_sets, view_my_draft_character_costs, view_my_draft_lightcone_costs, view_my_draft_synergy_costs (+ view_cost_set_missing S10i, view_published_cost_sets S11a) | 6 |
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

## Phase S8e execution (DECISIONS.md A67(1)(3))

- `view_my_match_steps`: `AnonymousMatchStepRow` loses `gameNumber` (`id, lobbyId, sequence, actorUserId,
  anonymousLabel, actorSlot, action, payload, timestamp`).
- The history views over `MatchSessionStepHistory` / `MatchResultGameHistory` return the table rows, which lose
  `gameNumber` (keys `[matchHistoryId, sequence]` / `matchHistoryId`).
- `view_lobby_browser`: unchanged list (Waiting, Drafting, Equipping, Scoring); the removed stages no longer exist.
- Views returning `Lobby` rows (`view_my_lobbies`, `view_my_tournament_lobbies`) lose `bestOf`, `bestOfNAdvantage`,
  `refereeControlsShelving` through the row type. S9 decides the subscription shapes.

## Phase S8f execution (DECISIONS.md A68)

- `view_my_lobbies` skips memberships with `abandonedAt` set (A68(4)(10)); an away row (`leftAt`) keeps its lobby
  listed. Views returning `Lobby` rows gain `maxSpectators` through the row type (A68(8)).
- `view_my_lobby_members` is unchanged here; the presence state (online / offline / away / gone) it should project is
  S9's (A68(10)).

## Phase S9a execution (DECISIONS.md A37, A40, A44, A48, A56, A60, A63, A67, A68, A70, A71)

Views part 1: lobby, match session, match results, tournament. S9b covers identity, stats, roster, calendar and
admin. No `.iter()` in any view a non-staff client can subscribe; admin views may read whole tables after the role check (S9b). Per-sender views return `[]` for an unknown sender and
fan out from the caller's memberships with abandoned rows excluded (`callerMemberships`, A68(4)). Behaviour:
[contract.md](contract.md) "Acceptance Scenarios (Phase S9a execution)"; the anonymity rules:
[../anonymous-play/contract.md](../anonymous-play/contract.md).

**Shared helper** `helpers/identity/viewAnonymity.ts`: `callerMemberships`, `lobbyAnonymousFor` (the lobby has an
anonymity flag and the caller is not a spectator referee, D-71), `hideUserId` / `maskUserId` (a current member
follows `shouldAnonymize`; in a lobby whose anonymity applies to the caller, an id that is no longer a member is
withheld too), `maskLobbyRow` (host and audit ids), `ratingVisible` (A40). `computeAnonymousLabel` now orders peers
by `joinSeq` (R4) instead of `createdDate`; same order, no millisecond ties. S10h (A97): superseded, the label is the
seat kind and seat number ("Blue Player #3", "Spectator #7"), computed from the member's own row
(`anonymousSeatLabel`, `docs/anonymous-play/architecture.md`).

### Catalogue (S9a)

| View | File | Scope | Row | Anonymity | Indexes |
|---|---|---|---|---|---|
| `view_lobby_browser` (re-created) | lobbyViews | anonymous shared | `LobbyBrowserRow` (PK `id`): name (empty → "Lobby <code>" / "Private lobby"), joinCode? (public only), hostLabel, game / draft / match type, ban mode + restriction, lineup format, roster visibility, disconnect policy, team size, player / coach / spectator counts, maxSpectators, isPublic, anonymity flags, isTournamentControlled, stage, createdDate, tournamentName?, costSetName? | no user id at all; "Anonymous host" when isAnonymousPlayers | `Lobby.stage` ×4, `LobbyMember.lobby_id`, `User.id`, `Tournament.id`, `CostSet.id` |
| `view_my_lobbies` (modified) | lobbyViews | per-sender | `MyLobbyListRow` (PK `id`): joinCode, name, stage, isAway | no user id | `UserIdentity.identity`, `LobbyMember.user_id`, `Lobby.id` |
| `view_my_lobby` (new) | lobbyViews | per-sender | `Lobby` row | hostUserId / createdById / lastModifiedById 0 when hidden for the caller | as above |
| `view_my_lobby_members` (modified) | lobbyViews | per-sender | `LobbyMemberViewRow` (PK `memberKey` = lobbyId << 32 \| joinSeq): lobbyId, joinSeq, userId, label, lobbySlot, presence, isHost, isReferee, isCaptain, isConfirmed, avatarCharacterName?, displayedAchievementId?, mmrByMode?, accountRating?, accountCount?, disconnectActionAt? (A92(9)) | anonymized seat: userId 0, `computeAnonymousLabel`, no avatar / title / MMR; ratings per `ratingVisible` | + `LobbyMember.lobby_id`, `User.id`, `UserPresence.user_id`, `Season.is_active`, `EloConfigTable.id`, `MmrRating.by_user_mode_season`, `LobbyMemberAccount.by_lobby_and_user`, `HsrAccount.id` |
| `view_my_lobby_chat` (kept) | lobbyViews | per-sender | `AnonymousChatRow` (PK `id`) | senderUserId 0 via `hideUserId` + the seat label (S10h, A97: `storedOrLiveLabel`, the label stored with the message, else the live one while the sender holds a row, else "A player"; review F6); System never | `ChatMessage.lobby_id`, `LobbyMember.by_lobby_and_user` |
| `view_my_lobby_bans` (new) | lobbyViews | per-sender, host or referee of the lobby | `LobbyBanViewRow`: lobbyId, bannedUserId, bannedJoinSeq, label, bannedByUserId?, createdDate | bannedByUserId withheld when the lobby's anonymity applies; `bannedJoinSeq` (S9c, A74(2)) is the seat `unban_member` takes | `LobbyBan.lobby_id` |
| `view_lobby_presets` (new) | lobbyViews | per-sender | `LobbyPresetViewRow` (PK `id`): every `LobbyPreset` column but the audit ones | system preset (SYSTEM) + own | `LobbyPreset.creator_user_id` ×2 |
| `view_my_match_session` (new) | matchViews | per-sender | `MatchSessionViewRow` (PK `lobbyId`): every `MatchSession` column but the audit ones | no user id | `MatchSession.lobbyId` |
| `view_my_match_steps` (kept) | matchViews | per-sender | `AnonymousMatchStepRow` (PK `id`), no gameNumber | actorUserId 0 + stored label via `hideUserId` | `MatchSessionStep.lobby_id` |
| `view_my_match_participants` (modified) | matchViews | per-sender | `AnonymousMatchParticipantRow` + `accountRatingSnapshot?` | userId 0 + label; snapshot per `ratingVisible` | `MatchResultRecord.lobby_id`, `MatchResultParticipant.match_result_id` |
| `view_my_lineups` (new) | matchViews | per-sender, both teams | `MatchLineupViewRow` (PK `id`): lobbyId, teamSide, groups, synergySurcharge, rosterCost, blueConfirmed, redConfirmed, closedAt? | no user id | `MatchLineup.by_lobby`, `MatchResultGame.match_result_id` |
| `view_my_match_result` (new) | matchResultViews | per-sender, live or parked | `MatchResultViewRow` (PK `id`): status, winner, concede and override fields, settledAt, `staffOverrideReason` (S11a, L49); no refereeUserId; `concedeSummary` only for a Moderator / Admin caller (A83, Phase S10c execution) | disputedByUserId / winnerOverrideById masked | `MatchResultRecord.lobby_id` |
| `view_my_match_result_games` (new) | matchResultViews | per-sender | `MatchResultGameViewRow` (PK `matchResultId`) with nested `groupScores[]` and `adjustments[]` | closedById / setById masked (S11a, L60: validationStatus / validatedByUserId removed) | `MatchResultGame.match_result_id`, `MatchResultGroupScore.by_result`, `MatchResultAdjustment.by_result` |
| `view_admin_stuck_games` (new) | matchResultViews | Moderator+ (else `[]`) | `StuckGameRow` (PK `lobbyId`): joinCode, stage, both flags, isTie, sinceAt | staff only | `User.id`, `Lobby.stage`, `MatchResultRecord.lobby_id`, `MatchResultGame.match_result_id` |
| `view_my_match_lineup_history` (new) | matchHistoryViews | per-sender, participated (Pattern B) | `MatchLineupHistory` row | revealed after the match (A37) | `MatchParticipantHistory.by_user`, `MatchLineupHistory.by_match_history` |
| `view_match_history`, `view_match_participant_history`, `view_match_step_history` | — | **removed** (A37) | — | — | — |
| `view_tournament_participants(tournamentId)` (new) | tournamentViews | anonymous arg view | `TournamentParticipantRow`: seat, teamId?, userId, label, status, isWaitlisted; Disqualified hidden (A26a(2)) | `isAnonymousDefault`: userId 0, label = alias or `Seat-<n>` (enrollment order) | `Tournament.id`, `TournamentEnrolled.tournament_id` / `by_tournament_and_user`, `TournamentTeamMember.by_tournament_and_user` |
| `view_tournament_teams(tournamentId)` (new) | tournamentViews | anonymous arg view | `TournamentTeamPublicRow`: id, name, status, seedNumber?, groupId?, finalPlacement?, captainUserId? | captainUserId only when not anonymous | `TournamentTeam.tournament_id` |
| `view_tournament_team_members(tournamentId)` (new) | tournamentViews | anonymous arg view | `TournamentTeamMemberPublicRow`: teamId, userId, label | userId 0 + alias / seat when anonymous | `TournamentTeam.tournament_id`, `TournamentTeamMember.team_id` |
| `view_tournament_staff(tournamentId)` (new) | tournamentViews | anonymous arg view | `TournamentStaffRow`: userId, label, isOrganizer, three A25 flags | staff are never anonymous | `TournamentAssistant.tournament_id` |
| `view_my_tournament_enrollment` (new) | tournamentViews | per-sender | `TournamentEnrolled` row | the caller's own | `TournamentEnrolled.user_id` |
| `view_my_team_requests` (new) | tournamentViews | per-sender: sent, or to a team the caller captains | `TeamRequestViewRow`: teamId, tournamentId, teamName, userId, label, isMine, createdDate | the captain gets the requester's id (the accept reducer takes it) and, since S9c (A73), the requester's display name in every tournament; the caller's own rows keep the alias / seat label when anonymous | `TournamentTeamRequest.user_id` / `team_id`, `TournamentTeam.captain_user_id` |
| `view_my_stand_ins` (new) | tournamentViews | per-sender: naming the caller, or of the caller's teams | `StandInViewRow` (PK `id`): bracketMatchId, teamId, userId, label | own team (teammates are real) | `TournamentStandIn.user_id` (**new index**) / `team_id` |
| `view_tournament_matches_for_me` (new) | tournamentViews | per-sender | `MatchForMeRow` (PK `bracketMatchId`): my / opponent team, opponent name, blue / red team (A70(1)), state, side, round, bestOf, team ids and tally (head start on team1, A71), scheduledAt | team ids only | `TournamentEnrolled.user_id`, `TournamentTeamMember.by_tournament_and_user`, `BracketMatch.tournament_id` |
| `view_my_tournament_lobbies` (modified) | tournamentViews | organizer / assistants | `TournamentLobbyRow` = `Lobby` columns + blueTeamId? / redTeamId? (`matchSides`) | staff: real ids | + `BracketMatch.id` |
| `view_my_tournament_match_results` (kept) | tournamentViews | organizer / assistants | `MatchResultRecord` row, without `refereeFullControl` (column dropped) | staff | unchanged |

Kept unchanged: the replay set (`view_my_match_session_history`, `_step_history`, `_participant_history`,
`_result_game_history`, `view_my_mmr_history`), `view_my_tournaments`, `view_my_tournament_enrolled`,
`view_my_tournament_teams`, `view_my_tournament_team_members`, `view_my_tournament_matches`,
`view_tournament_registrant_accounts`.

**Known scans outside the view bodies.** `computeLobbyMemberRating` (the merged rating of a member with several
selected accounts, backlog #10) reads the `HsrCharacter` reference table in full through `computeRosterRating`; a
member with one account reads the stored `HsrAccount.accountRating`. `views/identityViews.ts` still scans
`HsrAccount` and `UserPrivate` (S9b). (Resolved in S9b; `UserPrivate` no longer exists since S11a, A77.)

### S9a fix pass (DECISIONS.md A37)

| View | Change |
|---|---|
| every lobby view (through `shouldAnonymize`) | the target's seat kind picks the toggle: spectator target `isAnonymousSpectators`, player / coach target `isAnonymousPlayers` (spectator callers included) |
| `view_lobby_browser` | "Anonymous host" when the host's own seat kind is anonymous (+ `LobbyMember.by_lobby_and_user`) |
| `view_my_lobby_chat` | System member-event lines (`metadata {event, subjectUserId}`) rendered per reader by `renderSystemChat`: subject label = display name if visible, else stored label / live seat label (only when none was stored) / "A player" (review F6); metadata `subjectUserId = 0` when hidden (+ `LobbyMember.by_lobby_and_user`, `User.id`) |
| `view_my_lobby_bans` | `bannedUserId = 0`, label "Banned player" when `hideUserId` holds for the banned user (a banned user holds no member row while banned) |
| `view_my_lobby_members` | no-op `Math.round` on `accountRating` removed |
| `view_my_match_steps` | `anonymousLabel` computed at read time (`anonymousLabelOr`: live seat label, else the stored label, else "<Side> player") |
| `view_my_match_participants` | a hidden participant without a member row reads "<Side> player", never "Unknown" |
| `view_tournament_registrant_accounts` (modified) | row + `seat`; in an `isAnonymousDefault` tournament a non-staff reader (not TO, assistant or Moderator+) gets other participants' rows with `userId = 0` and `hsrAccountId = 0` (+ `User.id`) |

Not changed, with the reason: `view_tournament_staff` keeps the three A25 flags and `view_lobby_browser` keeps
`lineupFormat` / `stage` / `createdDate` (the T-S9a column lists pin them; review #6 / #7 open with the user);
`view_my_lobby` keeps the full `Lobby` row with `lastActivityAt` (PAGE-MAP lobbyroom lists the full row, review #12);
`view_my_lobby_bans` needs no row id: S9c adds `bannedJoinSeq` (unique with `lobbyId`), which identifies the ban to the
client and to `unban_member` (A74(2)). A tournament `Seat-<n>` is the
enrollment rank and renumbers after a withdrawal (no stored enrollment counter; the alias is the stable label).

## Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48)

Views part 2: identity / profile, stats, roster, calendar, admin. The rule: no `.iter()` in any view a non-staff client can
subscribe; admin views may read whole tables after the role check (the two S9a hand-off scans in `identityViews.ts` are
gone). The six staff listings (`adminViews.ts` and `view_admin_user_private`) call `.iter()` only after the Moderator+
check (`staffCaller`; A37 exemption for admin views: small tables, tab-gated), so a non-staff subscriber's read set is
the caller's own identity and user rows. An unbounded index `Range` is not a substitute: it walks the whole index at
the cost of a scan. New helpers in
`helpers/identity/viewAnonymity.ts`: `callerUserId`, `staffCaller`, `MMR_GAME_MODES`, `mmrByModeOf` (the member row's
MMR reading, shared). New files `views/calendarViews.ts`, `views/adminViews.ts`. Behaviour:
[contract.md](contract.md) "Acceptance Scenarios (Phase S9b execution)".

### Catalogue (S9b)

| View | File | Scope | Row | Anonymity | Indexes |
|---|---|---|---|---|---|
| `view_my_identity` (modified) | identityViews | per-sender | `MyIdentityRow`: identity, userId (no audit columns, no lastSeenAt) | own | `UserIdentity.identity` |
| `view_my_profile` (modified) | identityViews | per-sender, layer 0 | `MyProfileRow` (PK `id`; now an array of at most one row): username, displayName, avatarCharacterName, displayedAchievementId?, hasDiscordLinked, isGuest, role, loginMethod?, providerId?, providerUsername? | own; no presence, deletedAt or audit columns | `UserIdentity.identity`, `User.id`, `UserPrivate.userId` |
| `view_public_hsr_accounts` (modified) | identityViews | anonymous shared | `PublicHsrAccountRow` (unchanged columns) | owner identified by choice (public roster) | `HsrAccount.is_roster_public` (**new index**), `HsrAccountCharacter.hsr_account_id` |
| `view_admin_user_private` (modified) | identityViews | Moderator+ (else `[]`) | `AdminUserPrivateRow` (PK `userId`): loginMethod, providerId, providerUsername (no audit columns) | staff | full read (staff-only) |
| `view_user_by_username(username)` (new) | identityViews | anonymous arg view | `UserByUsernameRow`: userId, username, displayName, avatarCharacterName, displayedAchievementId?; exact match, soft-deleted → `[]` | `User` is public (private since S11a, A77: the view stays the exact-match search) | `User.username` (unique) |
| `view_user_achievements(userId)` (new) | identityViews | anonymous arg view | `UserAchievementViewRow`: achievementId, awardedAt | no awarder, no audit ids (A40 residual risk = timing) | `UserAchievement.by_user` |
| `view_my_player_stats` (modified) | statsViews | per-sender | `MyPlayerStatRow`: mode, draft, match type, team size, season, matchesPlayed, wins, losses, matchesSpectated | no userId, no audit ids (the writer stamps the finalizing user) | `PlayerStat.by_user` |
| `view_my_character_stats` (modified) | statsViews | per-sender | `MyCharacterStatRow`: characterName + the stat key + the eight counters | as above | `PlayerCharacterStat.by_user` |
| `view_my_mmr_ratings` (new) | statsViews | per-sender | `MyMmrRatingRow`: gameMode, seasonId, rating, matchesPlayed, wins (the season's PlayerStat wins in that mode), lastUpdatedAt | own | `MmrRating.user_id`, `PlayerStat.by_user` |
| `view_my_relationships` (modified) | socialViews | per-sender | `MyRelationshipRow`: otherUserId, otherDisplayName, otherAvatarCharacterName?, otherDisplayedAchievementId?, otherMmrByMode? (active season, A40), the key and the four counters | other party identified (finished matches); no audit ids | `PlayerRelationship.by_user`, `User.id`, `DeletedUser.id`, `Season.is_active`, `EloConfigTable.id`, `MmrRating.by_user_mode_season` |
| `view_my_roster_visibility` (modified) | socialViews | per-sender | `RosterVisibilityRow`: lobbyId, **joinSeq**, memberUserId, hsrAccountId, characterName, eidolonLevel, accountRating? | A40 replaces the D-18 override; `memberUserId` / `hsrAccountId` 0 when `hideUserId`; full access for self, teammates and the spectator referee only (S9c, A75: a seated referee is a player) | `LobbyMember.user_id` / `lobby_id` / `by_lobby_and_user`, `LobbyMemberAccount.by_lobby_and_user`, `HsrAccount.id`, `HsrAccountCharacter.hsr_account_id` |
| `view_my_roster` (kept) | socialViews | per-sender | unchanged | own | `HsrAccount.user_id` |
| `view_my_calendar_events` (new) | calendarViews | per-sender | `MyCalendarEventRow` (PK `id`): organizerId, organizerLabel, title, description?, startAt, endAt, bracketMatchId? | organizer identified; no invitee list | `CalendarEvent.organizer_id` / `id` / `bracket_match_id`, `CalendarEventInvite.invitee_user_id`, `TournamentEnrolled.user_id`, `TournamentTeamMember.by_tournament_and_user`, `BracketMatch.tournament_id`, `SavedCalendar.user_id` |
| `view_my_calendar_invites` (new) | calendarViews | per-sender: own invites + invites of own events | `MyCalendarInviteRow` (PK `inviteKey` = eventId << 32 \| inviteeUserId): eventId, inviteeUserId, inviteeLabel, inviteStatus, respondedAt?, inviterLabel | an invitee never sees other invitees | `CalendarEventInvite.invitee_user_id` / `event_id`, `CalendarEvent.organizer_id` / `id` |
| `view_my_availability` (new) | calendarViews | per-sender | `MyAvailabilityRow` (PK `id`): startAt, endAt, isRecurring, recurrenceRule, expiresAt | own | `AvailabilitySlot.user_id` |
| `view_saved_calendar_availability` (new) | calendarViews | per-sender: visible saved calendars | `SavedCalendarAvailabilityRow` (PK `id`): userId, userLabel + the slot columns | A45(4): public between players | `SavedCalendar.user_id`, `AvailabilitySlot.user_id` |
| `view_my_saved_calendars` (new) | calendarViews | per-sender | `MySavedCalendarRow` (PK `targetUserId`): targetLabel, targetAvatarCharacterName?, isVisible | — | `SavedCalendar.user_id`, `User.id` |
| `view_admin_user_identities` (new) | adminViews | Moderator+ | `AdminUserIdentityRow` (PK `identity`): userId, lastSeenAt | staff | full read (staff-only) |
| `view_admin_ban_records` (new) | adminViews | Moderator+ | `AdminBanRecordRow` (PK `id`): loginMethod, providerId, reason, bannedByUserId, bannedByLabel, createdDate | staff | full read (staff-only) |
| `view_admin_deleted_users` (new) | adminViews | Moderator+ | `AdminDeletedUserRow` (PK `id`): displayName, isGuest, deletedAt | staff | full read (staff-only) |
| `view_admin_presence` (new) | adminViews | Moderator+ | `AdminPresenceRow` (PK `identity`): userId, isOnline, lastLoginAt, lastSeenAt | staff | full read (staff-only) |
| `view_admin_lobby_bans` (new) | adminViews | Moderator+ | `AdminLobbyBanRow`: lobbyId, bannedUserId, bannedJoinSeq (S9c, A74(2)), bannedUserLabel, bannedByUserId, bannedByLabel, createdDate | staff read real ids | full read (staff-only) |
| `view_admin_abuse_config` (new) | adminViews | Moderator+ | `AdminAbuseConfigRow` (PK `id`): every `AbuseConfig` column but the audit ones (incl. `guestLobbyCreationEnabled`, `maintenanceMode`) | staff | `AbuseConfig.id` |

Not built: `view_admin_lobbies`, `view_admin_match_results`, `view_admin_match_history` (Appendix B lists them, but
PAGE-MAP's adminpanel section, authoritative by A44(1), does not). No `view_leaderboard` (A44(2)): `Leaderboard` stays a
public table of at most 20 rows per category. The catalogue is 63 views: Appendix B's 62 minus the three trimmed admin
views, plus `view_admin_stuck_games` (A60), `view_my_match_lineup_history` (A56), `view_my_mmr_ratings` and
`view_user_by_username` (A44(1) D1 / D7; Appendix B predates them).

## Phase S10g execution (DECISIONS.md A105; tournament audit #10, #11)

`views/tournamentViews.ts`. Shared helpers: `staffTournamentIds` (replaces `getMyTournamentIds`), `organizedOrAssistedLiveIds`,
`adminTournamentIds`, and one row builder per staff view, used by both sets below.

| View | Auth | Rows | Indexes |
|---|---|---|---|
| `view_my_tournaments`, `view_my_tournament_enrolled`, `_teams`, `_team_members`, `_matches`, `_match_results`, `_lobbies` (modified, A105(1)) | per-sender: organizer, assistant (any row, flags not read; S10s, A122(21): a row with at least one permission), **Moderator / Admin** (new) | as before, for tournaments that are **not Completed or Cancelled** only; a Moderator+ caller gets every such tournament | Moderator+: `Tournament.stage` btree, one filter per non-terminal stage (Draft, Registration, CheckIn, Seeding, InProgress); others: `Tournament.organizer_id`, `TournamentAssistant.user_id` + `Tournament.id`; then the per-view indexes as before |
| `view_admin_tournament(tournamentId)`, `view_admin_tournament_enrolled(tournamentId)`, `view_admin_tournament_teams(tournamentId)`, `view_admin_tournament_team_members(tournamentId)`, `view_admin_tournament_matches(tournamentId)`, `view_admin_tournament_match_results(tournamentId)`, `view_admin_tournament_lobbies(tournamentId)` (new, A105(2)) | per-sender arg views (`spacetimedb.view(opts, { tournamentId: u32 }, …)`); **Admin** only: the role is checked (`UserIdentity.identity` → `User.id`) before any tournament row is read; anyone else, or an unknown id, gets `[]` | the same row types as the seven staff views, for that one tournament, terminal stages included | `Tournament.id` + the per-view indexes |
| `view_tournament_registrant_accounts` (modified, audit #10) | per-sender | (a) a hidden row (`isAnonymousDefault`, non-staff reader, not the caller's own) carries `displayLabel = Seat-<seat> account <k>` (k = 1-based order among that player's locked accounts) instead of the owner's free-text label; (b) Completed and Cancelled tournaments are skipped for every reader; (c) a non-staff reader gets another participant's rows only while the reader's own enrolment is in the field (not Disqualified, not waitlisted, approved) and only for participants in the field; the caller's own rows always; staff (organizer, assistant, Moderator+) every registrant | the organizer / assistant path now reads non-terminal tournaments only (`organizedOrAssistedLiveIds`) |
| `view_tournament_matches_for_me` (modified, audit #11) | per-sender | only tournaments in **InProgress** (a cancelled or completed tournament keeps its Ready / Pending rows for good) | + `Tournament.id` |

Egress: the staff views no longer grow with an organizer's finished tournaments; a Moderator+ subscriber receives every
live tournament's rows (A105(1)). The Admin arg views are subscribed one tournament at a time.

## Phase S10i execution (DECISIONS.md A107(2))

**`view_cost_set_missing(costSetId)`** (`views/costSetViews.ts`, arg view; subscribe as
`SELECT * FROM view_cost_set_missing(7)`): the entries the "push cost set live" dialog shows before `publish_cost_set`.
Rows `CostSetMissingRow { costSetId, draftMode, kind ('Character' | 'Lightcone'), name }`: per draft mode the set's
draft prices at all, every `HsrCharacter` / `HsrLightcone` row with no draft row (`missingCostEntries`,
`helpers/roster/costSetCompleteness.ts`; a set published before S10i without draft rows is read from its live rows).
Permission first: the caller's `User` must be the set's creator or Moderator+; anyone else, an unmapped identity and an
unknown id get no rows, and nothing else is read. The reference tables are read whole (`iter`) after that check; the
view is per caller and per set, so it re-evaluates only for its subscribers. Egress: one short row per missing entry,
at most (characters + light cones) x 2 draft modes, about 480 rows for the current seed, and 0 once the set is complete.

Since S10i the draft rows of a published set stay after publish (A107(3)), so `view_my_draft_*_costs` also return the
editable copy of the caller's published sets.

## Phase S10n execution (DECISIONS.md A115)

`views/matchHistoryViews.ts`. The five unbounded replay views are removed: `view_my_match_participant_history`,
`view_my_match_session_history`, `view_my_match_session_step_history`, `view_my_match_result_game_history`,
`view_my_match_lineup_history` (their bindings were deleted by `npm run stdb:generate`; no other module code or script
read them). Per-view detail, row shapes and costs: `docs/match/architecture.md`.

| View | Scope | Row | Reads |
|---|---|---|---|
| `view_my_match_history(page, gameMode, draftMode, matchType)` (new) | per-sender, the caller's matches, 10 per page, newest first by `playedAt` (id only as tie-break) | `MatchHistoryListRow`: the session columns without audit, the stored `matchType` and `winnerTeamSide?`, the caller's `teamSide` / `displayName` / flags, `won?`, `previousRating?` / `newRating?` / `ratingDelta?` | `MatchParticipantHistory.by_user`, `MatchSessionHistory.id`, `MmrHistory.user_id` |
| `view_my_match_history_count(gameMode, draftMode, matchType)` (new) | per-sender | `MatchHistoryCountRow { total }`, one row (none for an unmapped identity) | as the list, without `MmrHistory` |
| `view_my_match_history_participants(matchHistoryId)` (new) | per-sender, participants of that match only | `MatchParticipantHistory` rows, every participant of the match | `MatchParticipantHistory.by_match_history` (**new index**) |
| `view_my_match_history_steps(matchHistoryId)` (new) | same gate | `MatchSessionStepHistory` rows by `sequence` | gate + `MatchSessionStepHistory.by_match_history` |
| `view_my_match_history_games(matchHistoryId)` (new) | same gate | `MatchResultGameHistory` rows | gate + `MatchResultGameHistory.by_match_history` |
| `view_my_match_history_lineups(matchHistoryId)` (new) | same gate | `MatchLineupHistory` rows | gate + `MatchLineupHistory.by_match_history` |
| `view_my_mmr_history(page, gameMode)` (modified) | per-sender, 10 per page, newest first by `createdDate` | `MmrHistory` row (unchanged; as an argument view it has no primary key) | `MmrHistory.user_id` |

Filters are strings, `''` = any (a SQL literal has no spelling for an absent optional argument); an unknown tag matches
nothing; a page past the end is empty. History rows keep the A37 rule: no anonymous labels, the real identities go to the
match's participants. Schema changes (S11 clear-publish list): index `MatchParticipantHistory.by_match_history`; columns
`MatchSessionHistory.matchType` and `MatchSessionHistory.winnerTeamSide?` (fix pass, review F1 / F2).

Fix pass (review F1 / F2): the list's `matchType`, `winnerTeamSide` and `won` and the match-type filter read the two
columns finalization now stores (the record's match type and its final winner, so a concede, a forfeit, a staff
override or a force-finalize is reflected). The derivation of the first pass is gone: no `Tournament` read, no
rating-row probe (the `MmrHistory.match_history_id` index is removed again), no tournament-gone fallback, no game-row
winner. `won` is true when the caller's side is the stored winner, false when it is the other side, none when the match
has no winner.

## Phase S10s execution (DECISIONS.md A121, A122)

- **Staff views (A122(21), L71).** The assistant path of the seven staff views (`organizedOrAssistedLiveIds`,
  `views/tournamentViews.ts`) counts an assistant row only when it holds at least one of `canManageParticipants`,
  `canManageBracket`, `canResolveResults`; an assistant with all three off reads no staff view. The views are not
  gated one by one: teams and matches serve more than one permission (participants manage teams, bracket staff seed and
  group them; bracket and results staff both work on matches), so the rule is "any permission". Organizer and
  Moderator+ paths unchanged. After A121 a staff deletion can change `Tournament.organizerId`; the views read it at
  call time, so the new organizer's views follow. Fix pass F8: the same `organizedOrAssistedLiveIds` feeds
  `view_tournament_registrant_accounts`, so a no-permission assistant also loses the staff reading of registrant
  accounts (real ids, every registrant, rosters whatever the roster visibility); with one permission it is kept.
  `reducers/admin/adminMatchTools.ts` still accepts any assistant row (flags not read) and is left as is.
- **Calendar view (A122(22), L87).** `view_my_calendar_events` path (c) (the caller's teams' bracket matches) reads
  `Tournament.id` per enrolment and skips a tournament that is Completed or Cancelled; paths (a), (b), (d) unchanged
  (a match event the caller organizes or is invited to still shows through them).

## Phase S10v execution (DECISIONS.md A135(6); audit SI15, SI16)

- **`view_my_tournament_stand_ins` (staff, no arguments, `views/tournamentViews.ts`).** Row `StaffStandInRow`: `id` (PK,
  the `TournamentStandIn` id), `tournamentId`, `bracketMatchId`, `teamId`, `userId`, `userLabel`, `approvedByUserId`,
  `approvedByLabel`, `approvedAt` (the row's `createdDate`). The tournament set is `staffTournamentIds`, the same as the
  seven staff views: organizer, an assistant holding at least one permission (L71), Moderator+; non-terminal
  tournaments only. Reads `BracketMatch.tournament_id` then `TournamentStandIn.bracket_match_id`; labels through
  `resolveUserLabel` (staff see real identities, A37). Players, opponents included, get no rows. Egress: a separate
  view rather than columns on `view_my_stand_ins`, so only staff download approvals and the players' rows keep their
  size; about 60 bytes plus two names per approval, approvals per tournament in the tens at most. No Admin arg twin.
- **`view_tournament_matches_for_me` (SI16).** Besides the caller's teams' open matches, the open matches (Pending /
  Ready) of the caller's approvals (`TournamentStandIn.user_id`), InProgress tournaments only, `myTeamId` = the team
  stood in for; one row per match (PK `bracketMatchId`). Rows only for stand-ins, one per approval.
- **`view_my_calendar_events` path (c') (SI16).** The events of the bracket matches the caller is approved for
  (`TournamentStandIn.user_id` → `BracketMatch.id` → `CalendarEvent.bracket_match_id`), same stage rule as (c) (not
  Completed / Cancelled). At most one event per approval.
- `view_my_stand_ins` is unchanged (the stand-in and the members of the team stood in for; no approver).

## Phase S10ac execution (DECISIONS.md A157)

The calendar views follow the calendar mockup. The S9b table rows above for the four views below are superseded by
this list. Labels and avatars come from one per-call cache (`userCards`: `User.displayName` / `avatarCharacterName`;
a deleted user gets the archived label and no avatar). Still index-only.

- **`view_my_calendar_events`** (`MyCalendarEventRow`, PK `id`): + `organizerAvatarCharacterName?` (A157(12)),
  + `isBusyBlock` (bool). Paths (a) own, (b) invited, (c) team match, (c') stand-in match as before, in full; (b) for an
  invite the caller Declined: the row without `description` (A157(8)); a caller who removed their own invite no longer
  reaches the event through (b). Path (d) (visible saved calendars) now sends **busy blocks** only (A157(6)): `id`,
  organizer id / label / avatar, `startAt`, `endAt`, `isBusyBlock: true`, `title: ''`, no `description`, no
  `bracketMatchId`; an event also reached through (a)..(c') is sent once, in full.
- **`view_my_calendar_invites`** (`MyCalendarInviteRow`, PK `inviteKey`): + `inviteeAvatarCharacterName?`,
  + `inviterAvatarCharacterName?` (A157(12)). New path (c) (A157(5)): for each invite the caller holds, every invite
  of that event when the attendee list is visible to the caller: a personal event always; a match event when its
  tournament's `isAnonymousDefault` is false, or the caller holds the `bracket` permission there
  (`hasTournamentPermission`: Moderator+, the tournament organizer, a `canManageBracket` assistant); a match event
  whose bracket match or tournament is gone: own row only. Extra indexes read: `BracketMatch.id`, `Tournament.id`,
  `TournamentAssistant.by_tournament_and_user`, `User.id`. The organizer path (b) is unchanged. **Path (c) superseded
  by Phase S10ad execution (A161(1)):** removed; the list moved to `view_event_attendees(eventId)`.
- **`view_my_availability`** (`MyAvailabilityRow`): `id`, `startAt`, `endAt`, `kind` (`SlotKind`); `isRecurring`,
  `recurrenceRule`, `expiresAt` removed (A157(1), A157(3)).
- **`view_saved_calendar_availability`** (`SavedCalendarAvailabilityRow`): `id`, `userId`, `userLabel`, `startAt`,
  `endAt`, `kind`; the same three columns removed. Blocked slots are sent too (the mockup's "Other's Blocked").
- `view_my_saved_calendars` unchanged.

Size effect (BSATN, per row): a slot row loses 23 bytes (`isRecurring` 1, `RecurrenceRule` 14, `expiresAt` 8) and
gains 1 (`kind`): own slot about 44 → 22 B, saved slot about 62 → 40 B. An event row gains the avatar (1 + 4 + name,
about 10 to 20 B) and 1 B for `isBusyBlock`; a busy block drops the title and notes (up to 1.1 KB of ASCII, 3.4 KB of
CJK per event, with the caps). An invite row gains two avatars (about 20 to 40 B). Row counts: the invite view grows
for invitees only: up to 8 more rows per personal event the caller is invited to (9 invitees at most), the same for a
match event of a non-anonymous tournament; the organizer's own rows are unchanged; saved and outsider readers get no
invite rows. The event and slot views keep their row counts.

## Phase S10ad execution (DECISIONS.md A160, A161)

A160(5) (the attendee list only while the event has not ended) is **not built**: a view cannot read the time.
`ViewCtx` is `{ sender, db, env, from }` and `AnonymousViewCtx` is `{ db, env, from }` (SDK 2.14.1
`dist/server/views.d.ts:15-25`); a view is re-evaluated when the tables it reads change, never on the clock. A161(1)
replaces it, and the delivery of A157(5), with a view per opened event:

- **`view_my_calendar_invites`**: path (c) of S10ac is removed. Rows: (a) the caller's own invites, (b) every invite of
  the events the caller organizes. An invitee no longer receives the other invitees' rows. Indexes read:
  `CalendarEventInvite.invitee_user_id` / `event_id`, `CalendarEvent.organizer_id` / `id`, `User.id`,
  `DeletedUser.id` (no more `BracketMatch`, `Tournament` or `TournamentAssistant` reads).
- **`view_event_attendees(eventId: u32)`** (new, `views/calendarViews.ts`, a view with an argument): the
  `CalendarEventInvite` rows of one event. Row `EventAttendeeRow`: `inviteeUserId`, `inviteeLabel`,
  `inviteeAvatarCharacterName?`, `inviteStatus`, `respondedAt?` (the invitee columns of `MyCalendarInviteRow`; the
  event id is the argument, the inviter is not sent). No primary key (views with arguments cannot have one): an answer
  arrives as a delete plus an insert. Readers (`canReadAttendees`):
  - the event's organizer;
  - personal event: a holder of an invite to it (any answer; one who removed their own invite is no longer one);
  - match event: a holder of the `bracket` permission of the match's tournament (`hasTournamentPermission`:
    Moderator+, the tournament organizer, a `canManageBracket` assistant), with or without an invite; an invitee when
    `Tournament.isAnonymousDefault` is false;
  - anyone else, an unknown id, a deleted event, a match event whose match or tournament is gone (except for the
    organizer), a client that never logged in: no rows, no error.
  Index-only: `CalendarEvent.id`, `CalendarEventInvite.by_event_and_invitee` / `event_id`, `BracketMatch.id`,
  `Tournament.id`, `TournamentAssistant.by_tournament_and_user`, `User.id`, `DeletedUser.id`. Subscribe as
  `SELECT * FROM view_event_attendees(42)`.
- **Calendar page:** `view_my_calendar_invites` is subscribed always (with the other calendar views);
  `view_event_attendees` only for the event that is open, dropped when it closes, one argument set at a time
  (unsubscribe the old id before subscribing the next, SKILL "Subscription swap best practice"). Tiles of events one
  is invited to show the organizer's avatar only (from `view_my_calendar_events`; accepted by the user in A161(1)).

Size effect: `view_my_calendar_invites` goes back to one row per invite the caller holds plus the organizer's rows.
The S10ac review's M3 case (one invitee, 5 organizers x 40 events, 9 invitees each) drops from 1800 rows (about
139 KB) to 200 rows (about 16 KB at about 80 B per row with avatars); per organizer the worst case drops from 900 to
100 rows. Live fan-out of one answer in this view: the organizer and the answering invitee (2 readers, as before
S10ac, against 10). `view_event_attendees` adds at most 9 rows per opened event, about 45 B each (id 4, label 4 + 12,
avatar 1 + 4 + 11, status 1, respondedAt 1 + 8), so about 0.4 KB per open; each answer or reschedule changes rows
only for the clients that have that event open.

Through the data: Pending invites are removed by the calendar clean-ups 7 days after the event's end (A160(4), timing
A161(2); [../calendar/architecture.md](../calendar/architecture.md) "Phase S10ad execution"), so from then on the
organizer path (b) and `view_event_attendees` carry the answered invites only; a slot owner holds at most 10 Available
and 10 Blocked slots per UTC week (A160(1)), which bounds `view_my_availability` and
`view_saved_calendar_availability` (about 560 rows per owner at most, against no bound before).

## Phase S11a execution (DECISIONS.md A77, A162)

### A77: `User` is private; where its fields reach a client now

`User` is `public: false` and holds the former `UserPrivate` columns ([../auth/architecture.md](../auth/architecture.md)
"Phase S11a execution"). Views still read it server-side; no client subscribes it (no generated accessor). Every field
a client could read from the public table before, and what delivers it now:

| `User` field (public before S11a) | The user themself | Other players (pages, PAGE-MAP D2) | Staff (Moderator+) |
|---|---|---|---|
| `id` | `view_my_identity`, `view_my_profile` | the `userId` columns of the context views (lobby members, chat, steps, participants, tournament views, calendar views, relationships, `view_user_by_username`, `Leaderboard`), masked where A37 applies | `view_admin_users` |
| `username` | `view_my_profile` | `view_user_by_username(username)` (exact search only) | `view_admin_users` |
| `displayName` | `view_my_profile` | denormalized labels: `view_my_lobby_members.label`, `view_lobby_browser.hostLabel`, chat and System lines, `view_my_relationships.otherDisplayName`, the calendar labels, the tournament labels, `view_user_by_username`, **`Leaderboard.displayName` (new)** | `view_admin_users`, the labels of the admin views |
| `avatarCharacterName` | `view_my_profile` | `view_my_lobby_members`, `view_my_relationships`, the calendar views (organizer, invitee, inviter, saved target), `view_user_by_username`, **`Leaderboard.avatarCharacterName` (new)** | `view_admin_users` |
| `displayedAchievementId` | `view_my_profile` | `view_my_lobby_members`, `view_my_relationships`, `view_user_by_username` (titles list: the public `UserAchievement` table / `view_user_achievements(userId)`) | `view_admin_users` |
| `isGuest` | `view_my_profile` | not delivered (A77) | `view_admin_users`, `view_admin_deleted_users` (archive) |
| `role` | `view_my_profile` | not delivered (A77); tournament staff rights through `view_tournament_staff` flags, not the role | `view_admin_users` |
| `hasDiscordLinked` (dropped, derived from `loginMethod`) | `view_my_profile` | not delivered | `view_admin_users`, `view_admin_user_private` |
| `deletedAt` | not projected | not delivered (a deleted user reads as the archived label) | `view_admin_users`, `view_admin_deleted_users` |
| audit columns | not projected | not delivered | `view_admin_users` |
| provider columns (from `UserPrivate`) | `view_my_profile` (`linkedAt` not sent) | not delivered | `view_admin_user_private` (`linkedAt` not sent) |

- **`view_admin_users`** (new, `views/identityViews.ts`, Moderator+ through `staffCaller`, else `[]`): every `User` row,
  row `AdminUserRow` (PK `id`): id, username, displayName, isGuest, role, hasDiscordLinked (derived: `loginMethod` is
  `'discord'`), avatarCharacterName, displayedAchievementId?, deletedAt?, createdById, createdDate, lastModifiedById,
  lastModifiedDate: the columns the Users tab read from the public table (the mockup's hidden-by-default audit columns
  included). Staff-only full read after the role check (A37 admin exemption). Replaces PAGE-MAP D6's `User`
  subscription.
- **`view_my_profile`**, **`view_admin_user_private`**: row shapes kept (A77(2)); the provider fields come from the
  `User` row; `view_admin_user_private` emits one row per user with `loginMethod` and `providerId` set (as the
  `UserPrivate` rows were), so guests give none.
- **`view_user_by_username`** stays the exact-match search (A77(1)); with `User` private it is the only way to resolve a
  username, and for a known username it gives id, display name, avatar and title, nothing else.
- **Leaderboard** (A77(1), implementer's choice of denormalized columns over a `view_leaderboard`, as PAGE-MAP §3 lists):
  the public `Leaderboard` table gains `displayName` and `avatarCharacterName` (after `userId`), written by
  `rebuildLeaderboard` and rewritten by `syncLeaderboardCard` after `update_display_name`, `update_avatar` and
  `admin_update_user` (`helpers/stats/leaderboardRebuild.ts`; `Leaderboard.by_user`, SYSTEM actor). A view was not
  chosen: the table has no season index, so a view would scan it, and a table subscription costs nothing to evaluate.
- Not added: `view_user_by_id(userId)` (A77(1): only if a page needs one; no planned page needs it, see below).

**Exposure review.** Every public table and view was checked for what A77 hides (provider id and name, role, guest
flag, ban and deletion state, rate state, private rating); the in-memory sweep `__tests__/identity/user-private.test.ts`
reads every exported view as a verified outsider, a lobby member and invitee, a guest and an unmapped identity:

| Exposure | Status |
|---|---|
| the public `User` table (every field above, to any raw client) | closed by A77 (private) |
| `view_my_profile` provider fields, role, guest flag | the caller's own row only (A46, unchanged) |
| `view_admin_*` (provider link, ban records, deletion archive, presence, role) | Moderator+ only (A37), unchanged |
| `view_user_by_username` returns `[]` for a soft-deleted user | deletion state inferable during the 5 s soft-delete window only; kept (A77(1) keeps the view as built) |
| archived labels (`resolveUserLabel`) of deleted users in history and label columns | a deleted account is recognizable by its label; inherent to D-09, not covered by A77 |
| `Leaderboard` rows of a user deleted after the last rebuild keep the name until the next rebuild | the rebuild skips deleted users (results audit #9); no decision covers removing rows at deletion; reported |
| `UserAchievement` public table: `userId`, `awardedById` and audit ids (who awarded a title) | A43 keeps it public; not covered by A77; reported |
| `Tournament.organizerId` and the audit ids of public tables (`createdById`, `lastModifiedById`) | user ids, no private data; not covered by A77 |
| MMR in `view_my_lobby_members.mmrByMode` / `view_my_relationships` / `Leaderboard` | A40 / A44(2) rules (rating visibility), not A77; unchanged |
| rate state (`UserRateState`), ban records, presence | private tables, read by staff views only; unchanged |

**Planned pages and the fields they lose.** The leaderboard page (PAGE-MAP §3, no mockup) needed names and avatars:
added above. The tournament list (no mockup) reads the public `Tournament` table, whose `organizerId` resolved to a
name through `User` before; after A77 the organizer's name comes from `view_tournament_staff(tournamentId)`, one
tournament at a time: a list that shows every organizer's name would need a denormalized column or a view (reported,
not built). Every other page in PAGE-MAP already reads its names through views (D2).

**Size and egress.** No non-staff subscription changes size: pages never subscribed `User` (D2). A raw client can no
longer download the table (about 85 B per user: id 4, two names about 16 each, flags 3, avatar about 14, title 5,
deletedAt 1 to 9, audit 24). `view_admin_users` sends the same about 85 B per user to a Moderator+ subscriber, only
while the tab is open (gated). `view_admin_user_private` rows are unchanged; it now re-evaluates on any `User` write
instead of `UserPrivate` writes (server compute for staff subscribers, no row change unless a provider field changes).
`view_my_profile` is unchanged in shape and size and reads one table instead of two. `Leaderboard` rows grow by the two
strings, about 30 B (4 + about 12 for the name, 4 + about 10 for the avatar): at most 80 rows per season, about
+2.4 KB per subscriber; a rename or new avatar of a ranked player rewrites at most 4 rows (delete + insert each).

### A162: calendar views (calendar architecture "Phase S11a execution")

- `view_event_attendees` (`canReadAttendees`): an **Admin** reads the list of every event, personal events included
  (A162(3)); on a **match event** the event's organizer reads the list only while holding the tournament's `bracket`
  permission (`hasTournamentPermission`), otherwise they are treated as anyone else (an invitee reads it when the
  tournament is not anonymous; A162(1)); a match event whose match or tournament is gone: the organizer only, as before.
  Personal events: organizer and invitees, unchanged.
- `view_my_calendar_invites` path (b) (all invites of the caller's events): for a match event only while the caller
  holds the `bracket` permission (a match event whose link is gone keeps the old rule); without it the caller keeps
  what path (a) gives, their own invite. New index reads for the caller's match events: `BracketMatch.id`,
  `Tournament.id`, `TournamentAssistant.by_tournament_and_user` (and `User.id`, once per call).
- Size: `view_event_attendees` adds at most 9 rows (about 45 B each) per event an Admin opens; a former-staff creator
  loses the rows. `view_my_calendar_invites` rows only shrink (a former-staff creator's match-event rows go).

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
| `view_my_match_steps` and the step / game history views without `gameNumber`; lobby rows without the series settings (A67(1)(3)) | Phase S8e execution | 2026-11-08 |
| `view_my_lobbies` drops abandoned memberships; lobby rows carry `maxSpectators` | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| S9a catalogue: browser re-created (no user id), `view_my_lobbies` trimmed to the layer-0 row, new `view_my_lobby`, `view_my_lobby_bans`, `view_lobby_presets`, `view_my_match_session`, `view_my_lineups`, `view_my_match_result`, `view_my_match_result_games`, `view_admin_stuck_games`, `view_my_match_lineup_history`, four tournament arg views and four per-sender tournament views; member row with presence state, ratings per A40; public history views removed; `viewAnonymity` helper; labels ordered by `joinSeq` | Phase S9a execution (DECISIONS.md A37, A40, A44, A48, A56, A60, A63, A67, A68, A70, A71) | 2026-11-08 |
| S9a fix pass: seat-kind toggles in `shouldAnonymize`, browser host label, per-reader System chat lines, masked banned user, read-time step labels, no "Unknown" label, `view_tournament_registrant_accounts` masked + `seat` | Phase S9a execution (DECISIONS.md A37) | 2026-11-08 |
| S9b catalogue: `view_my_profile` re-shaped (PK row, no presence / audit), `view_my_identity` trimmed, `view_public_hsr_accounts` index-only, `view_admin_user_private` a staff-only full read, new `view_user_by_username`, `view_user_achievements`, `view_my_mmr_ratings`, five calendar views, six admin views; stats and relationship rows without audit ids, relationships with the other player's card + MMR, roster visibility per A40 with `joinSeq` and masked ids | Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48) | 2026-11-08 |
| S9c: `view_my_lobby_bans` and `view_admin_lobby_bans` carry `bannedJoinSeq` (the seat `unban_member` takes); `view_my_lobby` / `view_my_tournament_lobbies` carry the new `Lobby.lastJoinSeq` through the spread Lobby columns | Phase S9c execution (DECISIONS.md A74) | 2026-11-08 |
| S9c: `view_my_roster_visibility` full access for the spectator referee only (D-14 narrowed; `ratingVisible` and `hideUserId` already used the spectator test) | Phase S9c execution (DECISIONS.md A75) | 2026-11-08 |
| S9c: `view_my_team_requests` labels a request to the caller's team with the requester's display name in every tournament | Phase S9c execution (DECISIONS.md A73) | 2026-11-08 |
| S10d: `view_my_lobby_members` gains the last column `disconnectActionAt?` (timestamp): for a seated player whose row is offline, away or abandoned (`isMemberRowAway`, the reducers' row test) in a live stage under Standard / Deferred, the instant the forfeit claim / defer becomes available on that seat (`disconnectThresholdMicros`); no user id, so anonymity is unchanged; details in [../lobby/architecture.md](../lobby/architecture.md) "Phase S10d execution" | Phase S10d execution (DECISIONS.md A92(9)) | 2026-11-09 |
| S10g: staff views non-terminal + Moderator+, seven Admin-only arg views `view_admin_tournament*(tournamentId)`, registrant accounts neutral label / terminal skip / field-only rows, matches-for-me InProgress only | Phase S10g execution (DECISIONS.md A105; tournament audit #10, #11) | 2026-11-09 |
| S10h: every anonymous label a view emits (`view_my_lobby_members.label`, `view_my_lobby_chat.anonymousLabel`, the member-event System lines, `view_my_match_steps` / `view_my_match_participants` / `view_my_lobby_bans` through `anonymousLabelOr`) is the A97 seat label "<Seat kind> #<joinSeq>"; `view_my_lobby_chat` uses `anonymousLabelOr` (live seat label, else stored, else "A player") instead of the stored label alone; `view_admin_abuse_config` gains the three A95(2) columns through the spread `AbuseConfig` columns. The leaver fallbacks ("<Side> player", "Banned player") are unchanged | Phase S10h execution (DECISIONS.md A95, A97) | 2026-11-10 |
| Fix pass: `view_my_lobby_chat` (sender label and member-event lines) prefers the stored label and reads the live seat label only when none was stored (`storedOrLiveLabel`), so a rejoin does not relabel a former membership's lines | Phase S10h execution (S10h review F6; DECISIONS.md A97) | 2026-11-10 |
| `view_cost_set_missing(costSetId)` for the set's owner and Moderator+; draft views keep a published set's draft | Phase S10i execution (DECISIONS.md A107(2)(3)) | 2026-11-10 |
| Paged history (A115): `view_my_match_history` + `_count`, per-match `view_my_match_history_participants` / `_steps` / `_games` / `_lineups`, `view_my_mmr_history(page, gameMode)`; the five unbounded `view_my_match_*_history` views removed; two history indexes | Phase S10n execution (DECISIONS.md A115) | 2026-11-10 |
| Fix pass: the list reads the stored `MatchSessionHistory.matchType` / `.winnerTeamSide` (match type, winner, won, match-type filter); derivation and `MmrHistory.match_history_id` removed | Phase S10n execution (S10n review F1 / F2; DECISIONS.md A115) | 2026-11-10 |
| Staff views: an assistant row with no permission grants nothing (A122(21)); `view_my_calendar_events` skips Completed / Cancelled tournaments on the team-match path (A122(22)) | Phase S10s execution (DECISIONS.md A121, A122) | 2026-11-10 |
| `view_my_tournament_stand_ins` (staff, no arguments: approvals with approver and time); `view_tournament_matches_for_me` adds the stand-in's open matches; `view_my_calendar_events` adds the events of the stand-in's matches | Phase S10v execution (DECISIONS.md A135(6); audit SI15, SI16) | 2026-11-10 |

| Calendar views follow the mockup: avatars next to labels; busy blocks for savers; Declined invitees without notes; invitees read the attendee list (not on anonymous tournaments' match events, staff excepted); slot rows carry `kind`, recurrence columns removed | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| Calendar views unchanged; the attendee-list cut-off at an event's end (A160(5)) not built, since a view cannot read the time | Phase S10ad execution (DECISIONS.md A160) | 2026-11-11 |
| Fix pass: new `view_event_attendees(eventId)` (the attendee list of one opened event; organizer, invitees of a personal event, invitees of a non-anonymous tournament's match event, `bracket` permission holders); `view_my_calendar_invites` path (c) removed, an invitee gets their own row only | Phase S10ad execution (DECISIONS.md A161) | 2026-11-11 |
| `User` private (A77): new `view_admin_users` (Moderator+); `view_my_profile` / `view_admin_user_private` read the merged `User` row (shapes kept, `hasDiscordLinked` derived); `Leaderboard` carries `displayName` / `avatarCharacterName`; exposure review | Phase S11a execution (DECISIONS.md A77) | 2026-11-11 |
| `view_published_cost_sets` (anonymous, `CostSet.is_published`; `CostSet` private, L91); `view_my_match_result` gains `staffOverrideReason` (L49); `view_my_match_result_games` loses `validationStatus` / `validatedByUserId` (L60); `view_my_match_steps` no longer reads a stored step label (L39) | Phase S11a execution (part 2) | 2026-11-11 |
| A match event's organizer reads the attendee list and the organizer rows of `view_my_calendar_invites` only with the bracket permission; an Admin reads every attendee list | Phase S11a execution (DECISIONS.md A162) | 2026-11-11 |
---

*Last updated: 2026-11-11 (S11a)*
*Feature owner: Phase 03 / Phase 06 / Phase 08 / Phase 09 / Phase 10.4 / Phase 15*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
