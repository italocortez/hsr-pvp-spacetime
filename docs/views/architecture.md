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
| `view_my_match_result` (new) | matchResultViews | per-sender, live or parked | `MatchResultViewRow` (PK `id`): status, winner, concede and override fields, settledAt; no refereeUserId; `concedeSummary` only for a Moderator / Admin caller (A83, Phase S10c execution) | disputedByUserId / winnerOverrideById masked | `MatchResultRecord.lobby_id` |
| `view_my_match_result_games` (new) | matchResultViews | per-sender | `MatchResultGameViewRow` (PK `matchResultId`) with nested `groupScores[]` and `adjustments[]` | validatedByUserId / closedById / setById masked | `MatchResultGame.match_result_id`, `MatchResultGroupScore.by_result`, `MatchResultAdjustment.by_result` |
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
`HsrAccount` and `UserPrivate` (S9b).

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
| `view_user_by_username(username)` (new) | identityViews | anonymous arg view | `UserByUsernameRow`: userId, username, displayName, avatarCharacterName, displayedAchievementId?; exact match, soft-deleted → `[]` | `User` is public | `User.username` (unique) |
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

---

*Last updated: 2026-11-10 (S10v)*
*Feature owner: Phase 03 / Phase 06 / Phase 08 / Phase 09 / Phase 10.4 / Phase 15*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
