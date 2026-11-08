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
_Superseded in Phase S9a execution: see S9a-V1 (DECISIONS.md A37, A44(1))._

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
_Superseded in Phase S9a execution: see S9a-V2 (layer-0 projection; the full row is view_my_lobby)._

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
_Superseded in Phase S9a execution: see S9a-V3..V5 (DECISIONS.md A40, A68(10)): `LobbyMemberViewRow`._

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
_Superseded in Phase S9a execution: see S9a-V9 (DECISIONS.md A37): removed._

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
_Superseded in Phase S9a execution: see S9a-V9 (DECISIONS.md A37): removed._

**Purpose:** MatchParticipantHistory rows for visible matches only. (D-93)

**Type:** `view` -- requires authentication.

**Flow:**
1. Call `buildVisibleMatchIds()` shared helper (same gate as view_match_history)
2. For each visible match id, get participant rows via `by_match_history` index
3. Return full `MatchParticipantHistory` rows

### view_match_step_history
_Superseded in Phase S9a execution: see S9a-V9 (DECISIONS.md A37): removed._

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
_Superseded in Phase S9a execution (DECISIONS.md A37): the public history views are removed; see S9a-V9._

**Given:** MatchSessionHistory row with `isPubliclyVisible=true`. User C did not participate.
**When:** User C subscribes to `view_match_history`
**Then:** Match is included in results.

### History: Non-public match hidden from non-participant
_Superseded in Phase S9a execution (DECISIONS.md A37): the public history views are removed; see S9a-V9._

**Given:** MatchSessionHistory row with `isPubliclyVisible=false` (active tournament match). User C did not participate.
**When:** User C subscribes to `view_match_history`
**Then:** Match is NOT included in results.

### History: Participant sees their own non-public match
_Superseded in Phase S9a execution (DECISIONS.md A37): the public history views are removed; see S9a-V9._

**Given:** MatchSessionHistory row with `isPubliclyVisible=false`. User A participated (has MatchParticipantHistory row).
**When:** User A subscribes to `view_match_history`
**Then:** Match IS included in results (participant override).

### History: Tournament reveal makes matches public
_Superseded in Phase S9a execution (DECISIONS.md A37): the public history views are removed; see S9a-V9._

**Given:** Tournament completes. `revealTournamentHistory` sets `isPubliclyVisible=true` on all tournament matches. (D-84)
**When:** Any user subscribes to `view_match_history`
**Then:** All completed tournament matches now visible to everyone.

### History: Consistent gate across all three history views
_Superseded in Phase S9a execution (DECISIONS.md A37): the public history views are removed; see S9a-V9._

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

## Acceptance Scenarios (Phase S8e execution)

### S8e-V1 Step view without game numbers (A67(3))
**When** a member reads `view_my_match_steps`
**Then** each `AnonymousMatchStepRow` has `id, lobbyId, sequence, actorUserId, anonymousLabel, actorSlot, action, payload, timestamp` (no `gameNumber`); the step and game history views return rows without `gameNumber`

### S8e-V2 Lobby browser stages (A67(1))
**When** anyone reads `view_lobby_browser`
**Then** only Waiting, Drafting, Equipping and Scoring lobbies are listed (AwaitingResult excluded; no other stage exists)

## Acceptance Scenarios (Phase S9a execution)

### S9a-V1 Lobby browser carries no user id (A37, A44(1) D2, D-A4, D-A8, F17)
**Given** a public lobby "Scrim" hosted by Alice, a private lobby with an empty name, and an anonymous public lobby, all in Waiting
**When** anyone (no login needed) reads `view_lobby_browser`
**Then** the three rows carry no user id at all; "Scrim" shows `hostLabel = "Alice"` and its `joinCode`; the private one is named "Private lobby" and has no `joinCode`; the anonymous one shows `hostLabel = "Anonymous host"`; a public lobby with an empty name is named "Lobby <joinCode>"; each row carries the coach and spectator counts and `maxSpectators`. Lobbies in Drafting, Equipping and Scoring are listed as before (S8e-V2; spectators may join them, A68(8)); AwaitingResult is not.

### S9a-V2 Layer-0 list and full lobby row (PAGE-MAP D10, §A.4 P1, A68(4)(10))
**Given** Bob, a Red player who pressed Leave in Drafting (away)
**When** Bob reads `view_my_lobbies` and `view_my_lobby`
**Then** `view_my_lobbies` lists the lobby with `{ id, joinCode, name, stage, isAway = true }` and `view_my_lobby` returns its full `Lobby` row; once Bob abandons it for another lobby both views drop it.

### S9a-V3 Lobby row in an anonymous lobby (A37)
**Given** an anonymous-players lobby hosted by Alice (Blue), with Bob on Red
**When** Bob reads `view_my_lobby`
**Then** `hostUserId`, `createdById` and `lastModifiedById` are 0 (Alice is anonymized for Bob); Alice reads her own id; a spectator referee reads every real id. Bob's `view_my_lobby_members` marks Alice's seat `isHost = true` with `userId = 0` and label "Blue-1".

### S9a-V4 Member row and presence state (A68(10), A48, R3, R4)
**Given** a lobby in Drafting with Blue-1 online on a second device only, Blue-2 disconnected, Red-1 away (`leftAt`) and Red-2 abandoned (`abandonedAt`)
**When** a member reads `view_my_lobby_members`
**Then** the presences are Online (a live `UserPresence` row counts even when the membership row says offline), Offline, Away and Gone; no row carries the cursor or lineup throttle stamps or audit columns; each row's key `memberKey` is unique across the caller's lobbies (a parked AwaitingResult lobby next to a live one).

### S9a-V5 Ratings on anonymized seats (A40)
**Given** an anonymous lobby with `rosterVisibility = ClosedWithRating` and `hideMmr = false`
**When** Bob (Red) reads `view_my_lobby_members`
**Then** the Blue seats show `userId = 0`, the label, `accountRating` (merged over the member's selected accounts) and `accountCount`, but no `mmrByMode`, avatar or title; Bob's teammates show everything. With `ClosedNoRating` the Blue seats carry no rating (own and teammates' still do); with `hideMmr = true` no seat carries `mmrByMode`.

### S9a-V6 Bans and presets (PAGE-MAP D4)
**When** the host or a referee reads `view_my_lobby_bans`
**Then** each ban of their lobby is listed with the banned user's name; a plain member gets nothing; in an anonymous lobby `bannedByUserId` is withheld.
**When** a user reads `view_lobby_presets`
**Then** the system preset and the user's own presets are returned without audit columns; another user's preset is never returned; `LobbyPreset` itself is private.

### S9a-V7 Live match views (PAGE-MAP D3, A60, A63, A56)
**Given** a lobby in Scoring where Blue confirmed the game
**When** a member reads `view_my_match_session`, `view_my_lineups`, `view_my_match_result` and `view_my_match_result_games`
**Then** the session row has no audit columns; both teams' lineups are listed with `blueConfirmed = true`, `redConfirmed = false`, no `closedAt`; the record row has status, winner and settlement fields and no referee id; the game row nests its group scores and adjustments; in an anonymous lobby every user id of an anonymized member (an adjustment's `setById`, the closer) reads 0.

### S9a-V8 Stuck ranked games are staff-only (A60(9), A63)
**Given** a ranked lobby in Scoring with one ready flag set, and another with both flags set on an unresolved level-4 tie
**When** a Moderator reads `view_admin_stuck_games`
**Then** both lobbies are listed with `isTie` false and true; a casual lobby or a closed game is not; a User reads `[]`.

### S9a-V9 Public history views are gone (A37)
**When** a client subscribes `view_match_history`, `view_match_participant_history` or `view_match_step_history`
**Then** the views do not exist; a participant reads their matches through the `view_my_*_history` set, which now includes `view_my_match_lineup_history` (A56(1)).

### S9a-V10 Tournament page arg views (A37, A26a(2), §A.4 P3)
**Given** an anonymous tournament (`isAnonymousDefault`) with one Disqualified participant
**When** anyone subscribes `SELECT * FROM view_tournament_participants(<id>)`, `view_tournament_teams(<id>)`, `view_tournament_team_members(<id>)` and `view_tournament_staff(<id>)`
**Then** participants and members carry `userId = 0` and the alias or `Seat-<n>` label (enrollment order); the DQ row is absent; teams carry no `captainUserId`; staff rows carry the organizer and assistants with real ids and their flags. In a non-anonymous tournament the ids and display names are real.

### S9a-V11 Per-sender tournament views (PAGE-MAP D9, A70(1), A71)
**When** an enrolled player reads `view_my_tournament_enrollment`, `view_my_team_requests`, `view_my_stand_ins` and `view_tournament_matches_for_me`
**Then** they get their own enrollment rows; the requests they sent plus those to the team they captain (with the requester's id and label); the stand-ins naming them or their team; and the Ready / Pending bracket matches of their team with the opponent's name, the blue and red team ids (unset choice = team1 Blue) and the tally with the head start on team1. Staff reading `view_my_tournament_lobbies` get each lobby with its match's blue / red team ids.

## Acceptance Scenarios (Phase S9b execution)

### S9b-V1 Profile row (S3 hand-off, PAGE-MAP profile)
**When** a signed-in user reads `view_my_profile`
**Then** one row keyed by their user id carries username, displayName, avatarCharacterName, displayedAchievementId, hasDiscordLinked, isGuest, role and, once a provider is linked, loginMethod / providerId / providerUsername; no presence, `deletedAt` or audit column. An unmapped identity reads no row. `view_my_identity` returns only `{ identity, userId }`.

### S9b-V2 Exact username lookup (A44(1), PAGE-MAP D7)
**When** anyone subscribes `SELECT * FROM view_user_by_username('<username>')`
**Then** the user with exactly that username is returned with id, username, display name, avatar and title; a different case, a prefix, an unknown name or a soft-deleted user returns no row.

### S9b-V3 Achievements of a user (A43, A40)
**When** anyone subscribes `SELECT * FROM view_user_achievements(<userId>)`
**Then** each of that user's titles is listed as `{ achievementId, awardedAt }`, with no awarder and no audit column.

### S9b-V4 Own stats and MMR (A40, A44(1) D1)
**When** a player reads `view_my_player_stats`, `view_my_character_stats` and `view_my_mmr_ratings`
**Then** only their own rows arrive, without `userId` and without audit columns (the finalizing user, who may be an anonymized opponent, never reaches the client); `view_my_mmr_ratings` has one row per mode and season with rating, matchesPlayed, the season's wins in that mode and `lastUpdatedAt`. Another user's rows and the private `MmrRating` table stay unreadable.

### S9b-V5 Relationships carry the other player's card (PAGE-MAP D2, A40 CH-M1)
**Given** Alice and Bob finished a ranked match as opponents
**When** Alice reads `view_my_relationships`
**Then** her row for Bob carries Bob's id, display name, avatar, title and his MMR per mode for the active season (the initial rating for a mode he never played), with the counters; no page needs a `User` subscription. After Bob's account is deleted the row keeps his archived name and no avatar, title or MMR.

### S9b-V6 Roster visibility on anonymized seats (A37, A40)
**Given** an anonymous-players lobby with `rosterVisibility = OpenRoster`; Bob (Red) and Alice (Blue) have selected accounts
**When** Bob reads `view_my_roster_visibility`
**Then** Alice's characters, eidolons and rating arrive with `memberUserId = 0`, `hsrAccountId = 0` and her `joinSeq`; Bob's own and his teammates' rows carry real ids. With `ClosedWithRating` Alice's seat yields one rating-only row per selected account (characterName '', eidolonLevel 0); with `ClosedNoRating` nothing. Any referee sees every roster (D-14); a seated referee still reads 0 for anonymized opponents' ids, a spectator referee reads real ids (D-71).

### S9b-V7 Public rosters through the index (S3 hand-off)
**When** anyone reads `view_public_hsr_accounts`
**Then** exactly the accounts whose owner set `isRosterPublic` are listed with the owner's id, one row per character, the rating only when `isRatingPublic`; the view reads them through the `is_roster_public` index.

### S9b-V8 Calendar views (A37, A45(4), PAGE-MAP calendar)
**Given** Carol organizes an event inviting Dave; Dave saved Erin's calendar (shown) and Frank's (hidden); a tournament match event exists for Dave's team
**When** Dave reads the calendar views
**Then** `view_my_calendar_events` lists Carol's event, the match event (even without an invite row) and Erin's own events, each once with the organizer's label, and none of Frank's; `view_my_calendar_invites` lists Dave's invite with Carol as inviter and no other invitee's row, while Carol reads every invite of her event with the invitees' labels and responses; `view_my_availability` lists Dave's slots; `view_saved_calendar_availability` lists Erin's slots with her label and not Frank's; `view_my_saved_calendars` lists Erin and Frank with labels, avatars and `isVisible`. No calendar row carries an audit column.

### S9b-V9 Admin views are staff-only (§A.4 P4, PAGE-MAP D6, A42, A48)
**When** a Moderator reads `view_admin_user_identities`, `view_admin_ban_records`, `view_admin_deleted_users`, `view_admin_presence`, `view_admin_lobby_bans`, `view_admin_abuse_config` and `view_admin_user_private`
**Then** every identity mapping, provider ban (with the banning admin's label), archived user, per-identity presence row (isOnline, lastLoginAt, lastSeenAt), lobby ban (real ids and labels, anonymous lobbies included), the abuse configuration with the guest kill switch (no audit columns) and every provider link are listed; a User or a guest reads `[]` from each.

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
| Scenarios S8e-V1..V2: step / history views without `gameNumber`; lobby browser over the live stages | Phase S8e execution (DECISIONS.md A67(1)(3)) | 2026-11-08 |
| Scenarios S9a-V1..V11: browser without user ids, layer-0 list + full lobby row, A37 masking of lobby / result ids, member presence state and A40 ratings, bans and presets, live match views, staff stuck-games view, public history views removed, tournament arg and per-sender views | Phase S9a execution (DECISIONS.md A37, A40, A44, A48, A56, A60, A63, A68, A70) | 2026-11-08 |
| S9a fix pass: `view_tournament_registrant_accounts` adds `seat` and masks `userId` / `hsrAccountId` (0) of other participants for a non-staff reader of an `isAnonymousDefault` tournament; spectators anonymized only under `isAnonymousSpectators` (anonymous-play contract "S9a fix pass") | Phase S9a execution (DECISIONS.md A37) | 2026-11-08 |
| Scenarios S9b-V1..V9: profile row, exact username lookup, a user's achievements, own stats and MMR without audit ids, relationships with the other player's card and MMR, roster visibility per A40 with masked ids, public rosters through the index, the five calendar views, the staff-only admin views | Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48) | 2026-11-08 |

---

*Last updated: 2026-04-17*
*Feature owner: Phase 9 / Phase 15.5*
