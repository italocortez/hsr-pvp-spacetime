# Views

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Views are server-side computed projections that replace direct table subscriptions for clients. They enforce three security layers: (1) per-user data scoping so clients only receive rows they are authorized to see, (2) anonymous identity enforcement that masks opponent user IDs in anonymous lobbies (D-92), and (3) history visibility gating that prevents tournament scouting by hiding match history until tournaments complete (D-93). Clients always subscribe to views, never raw tables -- no conditional branching on the frontend.

## Naming Convention

| Prefix | Scope | Examples |
|--------|-------|---------|
| `view_my_*` | Strictly scoped to the caller's own data or the caller's current lobbies | `view_my_lobbies`, `view_my_lobby_chat`, `view_my_match_steps` |
| `view_*` (no "my") | Caller's data **plus** publicly visible data | `view_match_history`, `view_match_participant_history` |
| `view_*` (anonymous) | No authentication required; accessible to all clients | `view_lobby_browser`, `view_public_hsr_accounts` (renamed from `view_public_accounts` in Phase 15.5 D-04) |

The `view_my_*` prefix guarantees the caller never sees another user's private data. Views without "my" combine caller-participated rows with publicly visible rows.

## Views

### view_lobby_browser

**Purpose:** Projected lobby list for the lobby browser UI -- excludes config details and Finished lobbies.

**Type:** `anonymousView` -- no authentication required.

**Row type:** `LobbyBrowserRow` (projected struct, not raw Lobby row).

**Flow:**
1. Scan Lobby table using `stage` btree index for 4 active stages (Waiting, Drafting, Equipping, Scoring)
2. Exclude all Finished lobbies (D-08)
3. Resolve `tournamentName` via `Tournament.id` PK lookup when `tournamentId` is set
4. Resolve `costSetName` via `CostSet.id` PK lookup when `costSetId > 0`
5. Return projected columns only: id, joinCode, gameMode, draftMode, matchType, currentPlayerCount, isTournamentControlled, isAnonymousPlayers, stage, isPublic, teamSize, tournamentName?, costSetName?

**Excluded data:** Timer settings, budget values, penalty settings, disconnect policy, audit columns (createdDate, updatedDate), rosterVisibility, hostId, all internal IDs except lobby id.

### view_my_lobbies

**Purpose:** Full Lobby rows for lobbies the caller is currently a member of.

**Type:** `view` -- requires authentication.

**Flow:**
1. Resolve `ctx.sender` -> `UserIdentity.identity` PK -> `userId`
2. Look up `LobbyMember.user_id` btree index for caller's memberships
3. Fetch each `Lobby.id` PK lookup (users are in at most 1-2 lobbies per enforcement rules)
4. Return full Lobby rows

**Returns:** Empty array if caller has no `UserIdentity` mapping.

### view_my_identity

**Purpose:** Caller's own `UserIdentity` row only.

**Type:** `view` -- requires authentication.

**Flow:**
1. PK lookup on `UserIdentity.identity` using `ctx.sender`
2. Return single row or undefined

**Returns:** `option(UserIdentity.rowType)` -- at most one row. Prevents identity enumeration by limiting broadcast to the caller's own mapping.

### view_my_profile

**Purpose:** Caller's own full `User` row.

**Type:** `view` -- requires authentication.

**Flow:**
1. Resolve `ctx.sender` -> `UserIdentity.identity` PK -> `userId`
2. PK lookup on `User.id`
3. Return single row or undefined

**Returns:** `option(User.rowType)`.

### view_my_cost_sets

**Purpose:** CostSet rows owned by the caller, for the TO cost set management workflow.

**Type:** `view` -- requires authentication.

**Flow:**
1. Resolve `ctx.sender` -> `UserIdentity` -> `User.id`
2. Filter `CostSet.creator_id` btree index by caller's user id
3. Return matching CostSet rows

### view_my_draft_character_costs / view_my_draft_lightcone_costs / view_my_draft_synergy_costs

**Purpose:** Draft cost tables (CostSetDraftCharacter, CostSetDraftLightcone, CostSetDraftSynergy) for cost sets owned by the caller. These tables are private (`public: false`), so views are the only client read path.

**Type:** `view` -- requires authentication.

**Flow:**
1. Resolve `ctx.sender` -> `UserIdentity` -> `User.id`
2. Get all CostSet rows owned by caller via `creator_id` index
3. For each owned cost set, filter the draft table's `cost_set_id` index
4. Return all matching draft rows

### view_my_player_stats

**Purpose:** Caller's own PlayerStat rows. PlayerStat table is private -- this view is the only client read path. (D-33)

**Type:** `view` -- requires authentication.

**Flow:**
1. Resolve `ctx.sender` -> `UserIdentity` -> `userId`
2. Filter `PlayerStat.by_user` btree index
3. Return matching rows

### view_my_character_stats

**Purpose:** Caller's own PlayerCharacterStat rows. Private table, view-only access. (D-33)

**Type:** `view` -- requires authentication.

**Flow:**
1. Resolve `ctx.sender` -> `UserIdentity` -> `userId`
2. Filter `PlayerCharacterStat.by_user` btree index
3. Return matching rows

### view_my_relationships

**Purpose:** Caller's own PlayerRelationship rows. Private table, view-only access. (D-33)

**Type:** `view` -- requires authentication.

**Flow:**
1. Resolve `ctx.sender` -> `UserIdentity` -> `userId`
2. Filter `PlayerRelationship.by_user` btree index
3. Return matching rows

### view_my_roster_visibility

**Purpose:** Roster data filtered by each lobby's rosterVisibility setting. Enforces D-10 through D-16 and D-18 (anonymous mode). (Updated Phase 10.4: D-15 selected-account filtering, D-18 anonymous override)

**Type:** `view` -- requires authentication.

**Row type:** `RosterVisibilityRow` (custom struct: lobbyId, memberUserId, hsrAccountId, characterName, eidolonLevel, accountRating?).

**Flow:**
1. Resolve `ctx.sender` -> caller's memberships
2. For each lobby membership, determine caller's team via `slotTeam()`
3. For each member in that lobby, apply visibility rules:
   - **Referee (D-14):** sees all rosters and ratings regardless of setting
   - **Self + own team:** always see full roster and rating
   - **Opponent visibility (D-11, D-12, D-13):**
     - OpenRoster: all rosters visible
     - ClosedWithRating: opponent roster hidden, `accountRating` visible via sentinel row
     - ClosedNoRating: opponent roster AND rating hidden
   - **D-18 anonymous override:** if `lobby.isAnonymousPlayers=true` AND caller is not referee AND not self AND not own team: force `ClosedNoRating` regardless of `rosterVisibility` setting
   - **Spectators (D-16):** follow opponent rules (not referee rules)
4. **D-15 selected-account filtering:** Character data fetched from `LobbyMemberAccount.by_lobby_and_user` rows only — not all accounts owned by the player. Only characters from selected account(s) returned.

**Note on D-18 anonymous mode fix:** Closes the security gap where `OpenRoster` lobbies with `isAnonymousPlayers=true` would expose opponent roster/rating data. The `LobbyMemberAccount` table being non-public (D-02) closes the account-ID leak; D-18 closes the character/rating leak via this view.

### view_my_roster (Phase 10.4)

**Purpose:** Caller's own HsrAccounts + characters. Replaces raw `HsrAccount` and `HsrAccountCharacter` subscriptions (D-20, D-22).

**Type:** `view` -- requires authentication.

**Row type:** `MyRosterAccountRow` (custom struct: accountId, uid, region, displayLabel, isActive, isRosterPublic, isRatingPublic, isDuplicateUid, accountRating, characterName?, eidolonLevel?).

**Flow:**
1. Resolve `ctx.sender` -> `userId`
2. Filter `HsrAccount.user_id` for caller's accounts
3. For each account, filter `HsrAccountCharacter.hsr_account_id`
4. Return flat rows (one per character). Accounts with no characters emit one row with characterName/eidolonLevel=undefined.

**Returns:** Empty if caller has no UserIdentity mapping.

### view_public_hsr_accounts (Phase 10.4 / renamed Phase 15.5 D-04)

**Purpose:** Public HSR accounts for profile browsing. Replaces raw `HsrAccount` subscription for public data (D-20, D-22).

**Type:** `anonymousView` -- no authentication required. Stays anonymous per Phase 15.5 D-05 (projection body IS the privacy gate — `isRosterPublic` / `isRatingPublic` filters are applied server-side, not via subscription timing).

**Row type:** `PublicHsrAccountRow` (custom struct: accountId, userId, uid, region, displayLabel, accountRating?, characterName?, eidolonLevel?). Renamed from `PublicAccountRow` in Phase 15.5 D-04 alongside the view rename.

**Flow:**
1. Iterate all `HsrAccount` rows via `iter()`
2. Filter: include only where `isRosterPublic=true`
3. For each account: include rating only if `isRatingPublic=true`
4. For each account: return flat rows with characters. Accounts with no characters emit one row with characterName/eidolonLevel=undefined.

**Returns:** Empty array if no public accounts exist.

### view_tournament_registrant_accounts (Phase 10.4)

**Purpose:** Locked accounts for tournaments the caller is enrolled in or organizes. Respects tournament's rosterVisibility. (D-22)

**Type:** `view` -- requires authentication.

**Row type:** `TournamentRegistrantAccountRow` (custom struct: tournamentId, userId, hsrAccountId, displayLabel, accountRating?, characterName?, eidolonLevel?).

**Flow:**
1. Resolve `ctx.sender` -> `userId`
2. Collect enrolled tournament IDs via `TournamentEnrolled.user_id`
3. Collect TO/assistant tournament IDs via `getMyTournamentIds` helper
4. For each tournament, get enrolled users via `TournamentEnrolled.tournament_id`
5. For each enrolled user, get TPA entries via `TournamentPlayerAccount.by_tournament_and_user`
6. For each TPA entry, determine visibility:
   - TO/assistant OR self: showRoster=true, showRating=true
   - Other registrant + OpenRoster: showRoster=true, showRating=true
   - Other registrant + ClosedWithRating: showRoster=false, showRating=true
   - Other registrant + ClosedNoRating: skip (no row returned)
7. Return flat rows with characters (if showRoster=true). Rating included if showRating=true.

**Returns:** Empty if caller has no UserIdentity mapping.

### view_my_lobby_chat

**Purpose:** ChatMessage rows for the caller's lobbies with anonymous enforcement. (D-92)

**Type:** `view` -- requires authentication.

**Row type:** `AnonymousChatRow` (custom struct with anonymousLabel field).

**Flow:**
1. Resolve `ctx.sender` -> `callerUserId`, get lobby memberships
2. For each lobby, get ChatMessage rows via `lobby_id` index
3. For each message, call `shouldAnonymize()` (skipped for `senderType=System`)
4. If anonymizing: set `senderUserId=0`, use pre-stored `anonymousLabel` from the message row
5. If not anonymizing: return real `senderUserId`, no `anonymousLabel`

### view_my_lobby_members

**Purpose:** LobbyMember rows for the caller's lobbies with anonymous enforcement. (D-92)

**Type:** `view` -- requires authentication.

**Row type:** `AnonymousLobbyMemberRow` (custom struct with displayName and anonymousLabel fields).

**Flow:**
1. Resolve `ctx.sender` -> `callerUserId`, get lobby memberships
2. For each lobby, get all LobbyMember rows via `lobby_id` index
3. For each member, call `shouldAnonymize()`
4. If anonymizing: set `userId=0`, set `displayName` to computed `anonymousLabel`, populate `anonymousLabel` field
5. If not anonymizing: return real `userId`, resolve `displayName` from `User.id.find()`

### view_my_match_steps

**Purpose:** MatchSessionStep rows for the caller's active lobbies with anonymous enforcement. (D-92)

**Type:** `view` -- requires authentication.

**Row type:** `AnonymousMatchStepRow` (custom struct with anonymousLabel field).

**Flow:**
1. Resolve `ctx.sender` -> `callerUserId`, get lobby memberships
2. For each lobby, get MatchSessionStep rows via `lobby_id` index
3. For each step, call `shouldAnonymize()` on `actorUserId`
4. If anonymizing: set `actorUserId=0`, use pre-stored `anonymousLabel` from step row
5. If not anonymizing: return real `actorUserId`, no `anonymousLabel`

### view_my_match_participants

**Purpose:** MatchResultParticipant rows for the caller's active lobby matches with anonymous enforcement. (D-92)

**Type:** `view` -- requires authentication.

**Row type:** `AnonymousMatchParticipantRow` (custom struct with anonymousLabel field).

**Flow:**
1. Resolve `ctx.sender` -> `callerUserId`, get lobby memberships
2. For each lobby, find `MatchResultRecord` via `lobby_id` index
3. Get participants via `match_result_id` index
4. For each participant, call `shouldAnonymize()` on `userId`
5. If anonymizing: set `userId=0`, compute `anonymousLabel` via `computeAnonymousLabel()`
6. If not anonymizing: return real `userId`, no `anonymousLabel`

### view_match_history

**Purpose:** MatchSessionHistory rows visible to the caller -- prevents tournament scouting. (D-93)

**Type:** `view` -- requires authentication. No "my" prefix because scope includes publicly visible matches.

**Flow:**
1. Call `buildVisibleMatchIds()` shared helper
2. Scan MatchSessionHistory via 3 `game_mode` btree filter calls (one per GameMode)
3. Include row if its id is in the visible set
4. Return full `MatchSessionHistory` rows

**Visibility gate (buildVisibleMatchIds):**
- Resolve `ctx.sender` -> `callerUserId` (if authenticated)
- Collect match IDs where caller is a participant via `MatchParticipantHistory.by_user` index
- Scan all MatchSessionHistory rows via GameMode btree filters
- A match is visible if `isPubliclyVisible === true` OR caller participated
- Deduplication via Set

### view_match_participant_history

**Purpose:** MatchParticipantHistory rows for visible matches only. (D-93)

**Type:** `view` -- requires authentication.

**Flow:**
1. Call `buildVisibleMatchIds()` shared helper (same gate as view_match_history)
2. For each visible match id, get participant rows via `by_match_history` index
3. Return full `MatchParticipantHistory` rows

### view_match_step_history

**Purpose:** MatchSessionStepHistory rows (draft replay data) for visible matches only. (D-93)

**Type:** `view` -- requires authentication.

**Flow:**
1. Call `buildVisibleMatchIds()` shared helper (same gate as view_match_history)
2. For each visible match id, get step rows via `by_match_history` index
3. Return full `MatchSessionStepHistory` rows

## Acceptance Scenarios

### Security: Caller sees only their own lobbies

**Given:** User A is a member of Lobby 1. User B is a member of Lobby 2.
**When:** User A subscribes to `view_my_lobbies`
**Then:** User A receives only Lobby 1. Lobby 2 is not included.

### Security: Caller sees only their own identity

**Given:** User A and User B both have UserIdentity rows.
**When:** User A subscribes to `view_my_identity`
**Then:** User A receives only their own UserIdentity row.

### Security: Caller sees only their own stats

**Given:** User A has PlayerStat rows. User B has PlayerStat rows.
**When:** User A subscribes to `view_my_player_stats`
**Then:** User A receives only their own PlayerStat rows.

### Security: Lobby browser excludes non-active lobbies

**Given:** 3 lobbies exist: Lobby 1 (Waiting), Lobby 2 (Finished — abandoned/closed, not from finalization which cascade-deletes), Lobby 3 (AwaitingResult).
**When:** Any client subscribes to `view_lobby_browser`
**Then:** Only Lobby 1 is returned. Lobby 2 (Finished) and Lobby 3 (AwaitingResult) are excluded. Only Waiting, Drafting, Equipping, and Scoring stages are shown.

### Security: Lobby browser excludes config details

**Given:** Lobby exists with timer, budget, penalty, and disconnect settings configured.
**When:** Client subscribes to `view_lobby_browser`
**Then:** Response contains only projected fields (id, joinCode, gameMode, etc.). No timer/budget/penalty/disconnect/audit columns.

### Security: Unauthenticated caller sees anonymous views

**Given:** An unauthenticated client connects.
**When:** Client subscribes to `view_lobby_browser` or `view_public_hsr_accounts`
**Then:** Both views return data (`anonymousView` type — no auth required). Privacy is enforced inside the view body (lobby browser excludes config columns + Finished lobbies; `view_public_hsr_accounts` filters to `isRosterPublic=true` rows with rating projected only when `isRatingPublic=true`).

Phase 15.5 retired `view_user_directory` (was dead code with zero client subscribers; the cosmetic Phase 15.2 D-06 `view` flip turned out to be a runtime no-op per SpacetimeDB docs). Post-15.5: User directory data comes from a `SELECT * FROM user` subscription gated behind the frontend Stage 2 condition in `useAuth.ts` — see `docs/auth/architecture.md` Subscription Lifecycle.

### Security: Unauthenticated caller gets nothing from per-user views

**Given:** An unauthenticated client connects.
**When:** Client subscribes to `view_my_lobbies`
**Then:** Returns empty -- no `ctx.sender` resolution possible.

### Anonymous: Non-anonymous lobby returns real data

**Given:** Lobby with `isAnonymousPlayers=false`, `isAnonymousSpectators=false`. Players A (Blue) and B (Red) are members.
**When:** Player A subscribes to `view_my_lobby_members`
**Then:** Both members returned with real `userId` and `displayName`. No `anonymousLabel` set.

### Anonymous: Opponent userId masked in anonymous lobby

**Given:** Lobby with `isAnonymousPlayers=true`. Players A (Blue-1) and B (Red-1) are members.
**When:** Player A subscribes to `view_my_lobby_members`
**Then:** Player A's row: real `userId`, real `displayName`. Player B's row: `userId=0`, `displayName="Red-1"`, `anonymousLabel="Red-1"`.

### Anonymous: Own identity never anonymized

**Given:** Lobby with `isAnonymousPlayers=true`. Player A is Blue-1.
**When:** Player A subscribes to `view_my_lobby_members`
**Then:** Player A's own row always has real `userId` and real `displayName`, regardless of anonymous settings.

### Anonymous: Same team sees real identities (D-70)

**Given:** Lobby with `isAnonymousPlayers=true`, teamSize=2. Players A and B on Blue team.
**When:** Player A subscribes to `view_my_lobby_members`
**Then:** Player B's row has real `userId` and real `displayName` (same team = not anonymized).

### Anonymous: Spectator sees all players anonymized (D-70)

**Given:** Lobby with `isAnonymousPlayers=true`. Spectator S watches. Players A (Blue) and B (Red).
**When:** Spectator S subscribes to `view_my_lobby_members`
**Then:** Both Player A and Player B rows have `userId=0` with anonymous labels.

### Anonymous: Spectator referee sees real identities (D-71)

**Given:** Lobby with `isAnonymousPlayers=true`. Referee R is a spectator with `isReferee=true`.
**When:** Referee R subscribes to `view_my_lobby_members`
**Then:** All members returned with real `userId` and real `displayName`.

### Anonymous: System messages never anonymized

**Given:** Lobby with `isAnonymousPlayers=true`. System message exists with `senderType=System`.
**When:** Player subscribes to `view_my_lobby_chat`
**Then:** System message has real `senderUserId`, no `anonymousLabel`.

### Anonymous: Chat uses pre-stored label

**Given:** Lobby with `isAnonymousPlayers=true`. ChatMessage row has `anonymousLabel="Red-1"` stored at write time.
**When:** Opponent subscribes to `view_my_lobby_chat`
**Then:** Message returned with `senderUserId=0`, `anonymousLabel="Red-1"` (from stored value, not recomputed).

### Anonymous: Match steps anonymize opponent actors

**Given:** Lobby with `isAnonymousPlayers=true`. Step row has `actorUserId=5` (opponent) with pre-stored `anonymousLabel="Red-1"`.
**When:** Blue player subscribes to `view_my_match_steps`
**Then:** Step returned with `actorUserId=0`, `anonymousLabel="Red-1"`.

### Anonymous: Match participants anonymize opponents

**Given:** Lobby with `isAnonymousPlayers=true`. MatchResultParticipant for opponent userId=5.
**When:** Blue player subscribes to `view_my_match_participants`
**Then:** Opponent participant returned with `userId=0`, `anonymousLabel` computed via `computeAnonymousLabel()`.

### Anonymous Label Format

**Given:** Lobby with anonymous mode. Members joined in order: Blue player 1, Blue player 2, Red player 1, Coach Blue.
**When:** Labels computed via `computeAnonymousLabel()`
**Then:** Labels are: "Blue-1", "Blue-2", "Red-1", "Coach-Blue". Labels are deterministic based on team side and join order (createdDate ascending).

### History: Publicly visible match accessible to non-participant

**Given:** MatchSessionHistory row with `isPubliclyVisible=true`. User C did not participate.
**When:** User C subscribes to `view_match_history`
**Then:** Match is included in results.

### History: Non-public match hidden from non-participant

**Given:** MatchSessionHistory row with `isPubliclyVisible=false` (active tournament match). User C did not participate.
**When:** User C subscribes to `view_match_history`
**Then:** Match is NOT included in results.

### History: Participant sees their own non-public match

**Given:** MatchSessionHistory row with `isPubliclyVisible=false`. User A participated (has MatchParticipantHistory row).
**When:** User A subscribes to `view_match_history`
**Then:** Match IS included in results (participant override).

### History: Tournament reveal makes matches public

**Given:** Tournament completes. `revealTournamentHistory` sets `isPubliclyVisible=true` on all tournament matches. (D-84)
**When:** Any user subscribes to `view_match_history`
**Then:** All completed tournament matches now visible to everyone.

### History: Consistent gate across all three history views

**Given:** Match X is visible (either public or participant). Match Y is hidden.
**When:** User subscribes to `view_match_history`, `view_match_participant_history`, and `view_match_step_history`
**Then:** All three views return data for Match X. None return data for Match Y. The `buildVisibleMatchIds()` helper ensures consistency.

### Roster: OpenRoster shows all rosters (D-11)

**Given:** Lobby with `rosterVisibility=OpenRoster`. Players A (Blue) and B (Red).
**When:** Player A subscribes to `view_my_roster_visibility`
**Then:** Both Player A's and Player B's full character roster returned with ratings.

### Roster: ClosedWithRating hides roster, shows rating (D-12)

**Given:** Lobby with `rosterVisibility=ClosedWithRating`. Opponent B has 3 characters and accountRating=1500.
**When:** Player A subscribes to `view_my_roster_visibility`
**Then:** Player A sees own full roster. For opponent B: one sentinel row per account (characterName='', eidolonLevel=0, accountRating=1500). No character data.

### Roster: ClosedNoRating hides everything (D-13)

**Given:** Lobby with `rosterVisibility=ClosedNoRating`. Opponent B exists.
**When:** Player A subscribes to `view_my_roster_visibility`
**Then:** Player A sees own full roster. No rows returned for opponent B at all.

### Roster: Referee sees all (D-14)

**Given:** Lobby with `rosterVisibility=ClosedNoRating`. Referee R is a spectator.
**When:** Referee R subscribes to `view_my_roster_visibility`
**Then:** All members' full rosters and ratings visible regardless of setting.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Caller has no UserIdentity mapping | All per-user views return empty array/undefined | New connection before `register_user` |
| Caller is member of 0 lobbies | `view_my_lobbies`, `view_my_lobby_*` views return empty | Normal state between lobbies |
| Lobby has no ChatMessage rows | `view_my_lobby_chat` returns empty for that lobby | Early lobby state |
| Lobby has no MatchSessionStep rows | `view_my_match_steps` returns empty for that lobby | Pre-draft state |
| Lobby has no MatchResultRecord | `view_my_match_participants` skips that lobby | Pre-match state |
| CostSet with costSetId=0 (default) | `view_lobby_browser` shows `costSetName=undefined` | Default cost set has no CostSet row |
| Tournament name lookup fails | `view_lobby_browser` shows `tournamentName=undefined` | Defensive: tournament deleted but lobby lingers |
| Anonymous lobby with `isAnonymousSpectators=false` | Spectators not anonymized unless `isAnonymousSpectators` is true | Two independent toggles |
| All matches are non-public and caller never participated | `view_match_history` returns empty | Valid during active tournaments |
| `buildVisibleMatchIds()` with unauthenticated caller | Only `isPubliclyVisible=true` matches returned | participatedIds is empty |
| Same match visible via both public AND participation | Included once (Set deduplication) | No duplicate rows |
| ClosedWithRating opponent has no HSR accounts | No sentinel row returned for that opponent | Nothing to project |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `view_my_lobbies` | LobbyMember.user_id index | Membership lookup | Reads |
| `view_lobby_browser` | Tournament.id, CostSet.id | Name resolution | Reads |
| `view_my_cost_sets` | CostSet.creator_id index | Ownership filter | Reads |
| `view_my_draft_*_costs` | CostSetDraft*.cost_set_id index | Draft table access | Reads |
| `view_my_player_stats` | PlayerStat.by_user index | Private table access | Reads |
| `view_my_character_stats` | PlayerCharacterStat.by_user index | Private table access | Reads |
| `view_my_relationships` | PlayerRelationship.by_user index | Private table access | Reads |
| `view_my_roster_visibility` | HsrAccount.user_id, HsrAccountCharacter.hsr_account_id | Roster data | Reads |
| `view_my_lobby_chat` | ChatMessage.lobby_id index | Chat rows | Reads |
| `view_my_lobby_members` | LobbyMember.lobby_id index, User.id | Member + name resolution | Reads |
| `view_my_match_steps` | MatchSessionStep.lobby_id index | Step rows | Reads |
| `view_my_match_participants` | MatchResultRecord.lobby_id, MatchResultParticipant.match_result_id | Participant rows | Reads |
| `view_match_history` | MatchSessionHistory.game_mode index, MatchParticipantHistory.by_user | History + participation | Reads |
| `view_match_participant_history` | MatchParticipantHistory.by_match_history index | Participant history | Reads |
| `view_match_step_history` | MatchSessionStepHistory.by_match_history index | Step replay | Reads |
| `shouldAnonymize()` | LobbyMember.by_lobby_and_user index, Lobby.isAnonymousPlayers | Anonymization decision | Reads |
| `computeAnonymousLabel()` | LobbyMember.lobby_id index, slotTeam/slotIsCoach helpers | Label generation | Reads |
| `buildVisibleMatchIds()` | MatchParticipantHistory.by_user, MatchSessionHistory.game_mode | Shared visibility gate | Reads |
| `revealTournamentHistory` | Sets `isPubliclyVisible=true` on MatchSessionHistory | Tournament completion | Writes (external) |
| `view_my_roster` | HsrAccount.user_id + HsrAccountCharacter.hsr_account_id | Private table access | Reads |
| `view_public_hsr_accounts` | HsrAccount.iter() + HsrAccountCharacter.hsr_account_id | Public roster access | Reads |
| `view_tournament_registrant_accounts` | TournamentEnrolled.user_id, TournamentPlayerAccount.by_tournament_and_user, getMyTournamentIds | Locked account access | Reads |
| `view_my_roster_visibility` | LobbyMemberAccount.by_lobby_and_user (Phase 10.4) | Selected-account filtering | Reads |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Security views (1-9): per-user scoping via ctx.sender | Phase 5 execution | 2026-03-20 |
| Private stat tables (PlayerStat, PlayerCharacterStat) with view-only access (D-33) | Phase 5 execution | 2026-03-20 |
| Roster visibility rules (D-10 through D-16) | Phase 6 CONTEXT.md | 2026-03-21 |
| Lobby browser excludes Finished lobbies (D-08) | Phase 5 execution | 2026-03-20 |
| Anonymous enforcement views (D-92): view_my_lobby_chat, view_my_lobby_members, view_my_match_steps, view_my_match_participants | Phase 9 execution | 2026-03-29 |
| HsrAccount and HsrAccountCharacter made private — view_my_roster + view_public_accounts replace raw subscriptions (D-20, D-22) | Phase 10.4 execution | 2026-04-04 |
| view_my_roster_visibility filtered by LobbyMemberAccount (D-15) — only selected account characters returned | Phase 10.4 execution | 2026-04-04 |
| view_my_roster_visibility D-18 anonymous override: isAnonymousPlayers forces ClosedNoRating for opponents | Phase 10.4 execution | 2026-04-04 |
| view_tournament_registrant_accounts new view: locked TPA accounts per tournament rosterVisibility | Phase 10.4 execution | 2026-04-04 |
| shouldAnonymize() helper: same-team real, spectator anonymized, referee real (D-69/D-70/D-71) | Phase 9 execution | 2026-03-29 |
| computeAnonymousLabel(): deterministic team-side + join-order labels | Phase 9 execution | 2026-03-29 |
| Pre-stored anonymousLabel on ChatMessage and MatchSessionStep rows (consistency over recomputation) | Phase 9 execution | 2026-03-29 |
| System messages never anonymized (senderType=System bypass) | Phase 9 execution | 2026-03-29 |
| History visibility views (D-93): view_match_history, view_match_participant_history, view_match_step_history | Phase 9 execution | 2026-03-29 |
| buildVisibleMatchIds() shared helper for consistent visibility gate across 3 history views | Phase 9 execution | 2026-03-29 |
| isPubliclyVisible flag set at tournament completion via revealTournamentHistory (D-84) | Phase 9 execution | 2026-03-29 |
| GameMode btree filter (3 calls) to avoid .iter() anti-pattern in history views | Phase 9 execution | 2026-03-29 |
| "my" prefix naming convention: strictly caller-scoped vs. combined public+personal | Phase 9 execution | 2026-03-29 |
| view_user_directory as stepping stone: returns all User rows until frontend migration | Phase 9 execution | 2026-03-29 |
| anonymousView type for unauthenticated access (lobby browser, user directory) | Phase 9 execution | 2026-03-29 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
| view_user_directory declaratively flipped from `anonymousView` to `view` (D-06) as a marker for Phase 16's frontend subscription lifecycle; `UserDirectoryRow` projection unchanged (D-07); `view_my_profile` dropped `isPrivate` field (D-08, aligned with User.isPrivate removal) | Phase 15.2 execution | 2026-04-15 |
| UAT verify-work (Test 4) established that `spacetimedb.view()` vs `spacetimedb.anonymousView()` does NOT gate subscription at the wire — per official docs, the difference is only whether `ctx.sender()` is exposed to the body. D-06's "framework-level rejection" claim in the implementation comment was factually wrong. No client ever subscribed to `view_user_directory`, so the effective behavior change is zero. View scheduled for deletion in Phase 15.5 alongside frontend subscription gating on `useAuth.ts` | Phase 15.2 execution | 2026-04-16 |
| `view_user_directory` retired and `UserDirectoryRow` row type removed — fully delivers on Phase 15.2's deletion-scheduling note. Behavior contract change: any code referencing `view_user_directory` is now incorrect — User directory data comes from a `SELECT * FROM user` subscription gated behind the frontend Stage 2 condition in `useAuth.ts` (see `docs/auth/architecture.md` Subscription Lifecycle) | Phase 15.5 execution | 2026-04-16 |
| `view_public_accounts` renamed to `view_public_hsr_accounts` (D-04) — keeps the `public` prefix marking anonymous intent, adds `hsr_` to make the projected source table (`HsrAccount`) explicit. `PublicAccountRow` row type renamed to `PublicHsrAccountRow`. Anonymous registration + projection body unchanged from Phase 10.4 — pure identifier rename. Stays anonymous per Phase 15.5 D-05: the projection body is the privacy gate (filters by `isRosterPublic` / `isRatingPublic` flags), not subscription timing. Naming-Convention table, Integration Surface table, and the "Unauthenticated caller sees anonymous views" security scenario all updated | Phase 15.5 execution | 2026-04-16 |
| Phase 15.5 verify-work sweep: `### view_user_directory` subsection removed from Views section; `view_public_accounts` references swept to `view_public_hsr_accounts` in the Naming-Convention table, the security scenario, and the Integration Surface table. Historical Phase 9, 10.4, 15.2 Phase History rows left untouched (CLAUDE.md rule — no rewriting historical entries) | Phase 15.5 verify-work | 2026-04-17 |

---

*Last updated: 2026-04-17*
*Feature owner: Phase 9 / Phase 15.5*
