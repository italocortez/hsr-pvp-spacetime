# Lobby -- Architecture

Last updated: 2026-11-06

## Overview

Lobbies are the per-match rooms where players draft characters and play games. Each lobby is either standalone (`create_lobby`) or tournament-linked (`create_tournament_lobby`, carrying `tournamentId` + `bracketMatchId` with `isTournamentControlled=true`). Lobbies advance through `LobbyStage`: Waiting -> Drafting -> Equipping -> Scoring -> (BetweenGames for best-of-N series) -> AwaitingResult -> Finished, with Shelved as a long-term pause branch. A self-rescheduling garbage-collection sweep (`run_lobby_gc`, backed by the `LobbyGcJob` scheduled table) fires every 15 minutes and hard-deletes idle lobbies (Waiting/Finished after 30 min idle; casual Shelved after 72h; active stages only once all members are offline). Players hold at most one active lobby membership at a time; every mutating entry point calls `ensureNotInLobby` (D-22) to enforce the one-lobby-per-user invariant.

Key membership model (D-24 / D-27): the host is inserted as a `LobbyMember` with `lobbySlot=Spectator` and `isReferee=true`. **Every** joiner also lands in the `Spectator` slot; team/coach placement happens afterward via `set_team_slot`. There is no `allowSpectators`/`maxSpectators` configuration — spectating is always allowed, capped by hardcoded limits (max 12 spectators, max 20 total members) enforced in `join_lobby` and `set_team_slot`.

Passwords live in the private `LobbyPassword` table (never broadcast). Anonymous play zeroes `senderUserId` at write time on cursor/chat events. `LobbyPreset` stores a full flat copy of the lobby config fields for save/restore. `LobbyMemberAccount` records which HSR account(s) each member uses for the match (private, D-02). Stand-ins (`TournamentStandIn`) track approved substitutes per bracket match.

Presence and disconnects (Phase S4 execution; A22a, A48): a member's `isOnline` follows the user's `UserPresence` rows (one per device, see `docs/auth/architecture.md`), so closing one device while another is connected changes nothing. `client_disconnected` only marks the member offline, stamps `disconnectedAt` (Standard/Deferred) and inserts a `RefereeTransferCheck` 15 s out; `run_referee_transfer_check` then moves the referee / captain / host flags and auto-pauses the draft only if the user is still offline. A reconnect (`client_connected`, or the explicit `join_lobby`) restores the member and cancels the pending check, so a page refresh moves no flag and pauses nothing.

## Table Relationships

```
Lobby (id: u32 autoInc PK)  [public: true]
  +-- joinCode: string  [unique]
  +-- hostUserId -> User.id  [btree: host_user_id]
  +-- teamBlueAlias: string / teamRedAlias: string
  +-- teamSize: u8
  +-- draftMode: DraftMode (Classic | Auction)
  +-- banMode: BanMode
  +-- standardTurnSeconds: u32 / reserveBankSeconds: u32
  +-- rosterDiffAdvantage / rosterThreshold / underThresholdAdvantage / aboveThresholdPenalty / deathPenalty: f32
  +-- matchType: MatchType (Casual | Ranked)
  +-- currentPlayerCount: u8  (denormalized for browser view per D-07)
  +-- characterBudget: f32 / lightconeBudget: f32 / minimumBidRaise: f32  (dual budgets per D-49)
  +-- allowMirrorPicks: bool / autoRandomPick: bool
  +-- refereeCanUndo / refereeCanPause / refereeCanSetCaptain / refereeCanKick: bool  (D-32)
  +-- allowPlayerPause: bool  (D-33)
  +-- refereeExclusiveConcede: bool  (D-92)
  +-- tournamentId: u32? -> Tournament.id  [btree: tournament_id]
  +-- bracketMatchId: u32? -> BracketMatch.id  [btree: bracket_match_id]
  +-- isTournamentControlled: bool
  +-- isAnonymousPlayers: bool / isAnonymousSpectators: bool
  +-- rosterVisibility: RosterVisibility / requireOwnership: bool / costSetId: u32 (0=default sentinel)
  +-- isPublic: bool   (password stored in LobbyPassword, never broadcast)
  +-- (A67(2), S8e: no series settings; bestOf / bestOfNAdvantage / refereeControlsShelving removed)
  +-- disconnectPolicy: DisconnectPolicy / disconnectForfeitSeconds: u32?
  +-- gameMode: GameMode
  +-- lastActivityAt: Timestamp  (drives GC idle checks)
  +-- stage: LobbyStage (Waiting | Drafting | Equipping | Scoring | AwaitingResult)  (A67(1): one game per lobby)
  +-- audit columns
  Indexes: host_user_id (btree), stage (btree), tournament_id (btree), bracket_match_id (btree)

  +-- LobbyMember (PK: [lobbyId, userId])  [PRIVATE since S3 (A37); members read view_my_lobby_members (S9)]
  |     lobbyId -> Lobby.id  [btree: lobby_id]
  |     userId -> User.id  [btree: user_id]
  |     isOnline: bool                       (follows UserPresence: false only once the user has no live device, A48)
  |     lobbySlot: LobbySlot (BluePlayer | BlueCoach | RedPlayer | RedCoach | Spectator)
  |     isReferee: bool   (admin powers within this lobby)
  |     isConfirmed: bool (ready-up per D-29)
  |     isCaptain: bool   (captain designation per D-30)
  |     voluntarilyLeft: bool                (D-31: player voluntarily left an active match)
  |     disconnectedAt: Timestamp?           (D-08: disconnect event time; A22a grace check and isForfeitEligible read it)
  |     disconnectPoolRemainingMs: u32       (D-10: remaining disconnect pool, init 300000 at draft start)
  |     joinSeq: u32                         (R4, S4: per-lobby join counter, host = 1 then max + 1; A22(5) order and S9 labels derive from it)
  |     lastCursorAt: Timestamp? / lastLineupAt: Timestamp?   (B-4 throttle stamps, written from S5)
  |     audit columns
  |     Indexes: lobby_id (btree), user_id (btree), by_lobby_and_user (btree, [lobbyId, userId])
  |
  +-- LobbyMemberAccount (PK: [lobbyId, userId, hsrAccountId])  [PRIVATE, no audit columns]
  |     lobbyId -> Lobby.id  [btree: lobby_id]
  |     userId -> User.id
  |     hsrAccountId -> HsrAccount.id
  |     D-02: never broadcast to opponents. Ephemeral: created at join, deleted at leave/close.
  |     Indexes: lobby_id (btree), by_lobby_and_user (btree, [lobbyId, userId]), by_account (btree, hsrAccountId)
  |
  +-- LobbyBan (PK: [lobbyId, bannedUserId])  [public: true]
  |     lobbyId -> Lobby.id  [btree: lobby_id]
  |     bannedUserId -> User.id
  |     bannedByUserId -> User.id
  |     audit columns
  |     Indexes: lobby_id (btree), by_lobby_and_user (btree, [lobbyId, bannedUserId])
  |
  +-- LobbyPassword (PK: lobbyId)  [PRIVATE]
  |     lobbyId -> Lobby.id  (1:1)
  |     passwordHash: string
  |     audit columns
  |     Intentionally NOT public -- never sent to any client.
  |
  +-- LobbyCursorEvent  [public: true, event: true -- broadcasts onInsert, then deletes immediately]
  |     lobbyId -> Lobby.id
  |     senderUserId: u32 -> User.id (0 = anonymous sentinel)
  |     anonymousLabel: string?
  |     x: f32 / y: f32 / timestamp: Timestamp
  |     audit columns
  |
  +-- LobbyPreset (id: u32 autoInc PK)  [public: true]
        name: string / isSystemPreset: bool
        creatorUserId -> User.id  [btree: creator_user_id]
        <full flat copy of Lobby config fields: teamSize, draftMode, banMode, gameMode, matchType,
         timers, budgets, roster handicaps, anonymity flags, rosterVisibility, requireOwnership,
         costSetId, disconnect settings, draft options, referee powers>
        audit columns

LobbyGcJob (scheduledId: u64 autoInc PK)  [PRIVATE, scheduled]
  scheduledAt: ScheduleAt
  Single self-rescheduling sweep row (NOT one per lobby). run_lobby_gc scans all Lobby rows,
  then requeues itself +15 min. Seeded once by seed_lobby_gc_job (server-only).

RefereeTransferCheck (scheduledId: u64 autoInc PK)  [PRIVATE, scheduled, no audit columns]  (S3 table, S4 behaviour)
  scheduledAt: ScheduleAt / lobbyId: u32 / userId: u32
  Indexes: by_lobby_and_user (btree, [lobbyId, userId])
  A22a: one row per (lobby, user), inserted by client_disconnected 15 s out for every active-stage membership
  of a user whose last device disconnected; deleted by client_connected (reconnect inside the window) or
  consumed by run_referee_transfer_check. Bound through `spacetimedb.reducer({ onSchedule: RefereeTransferCheck }, ...)`.

TournamentStandIn (PK: [bracketMatchId, userId])  [public: true]
  bracketMatchId -> BracketMatch.id  [btree: bracket_match_id]
  userId -> User.id
  approvedByUserId -> User.id
  audit columns
  Indexes: bracket_match_id (btree), by_match_and_user (btree, [bracketMatchId, userId])
```

> **Composite-PK update pattern:** `LobbyMember`, `LobbyBan`, and `LobbyMemberAccount` rows cannot be updated in place. All "updates" are `by_lobby_and_user.delete([...])` followed by `insert(updateWithAudit(...))`.

## Reducer Flows

Lobby-owned reducers live in `reducers/lobbyLifecycle.ts`, `lobbySettings.ts`, `lobbyPresets.ts`, `refereeManagement.ts`, `cursor.ts`, `lobbyGc.ts`, `accountSelection.ts`, `concede.ts` (concede / claim_forfeit / defer), `refereeTransfer.ts` (the A22a scheduled check), the lifecycle hooks in `index.ts`, and (tournament-linked) `tournamentLobby.ts`. Draft-stage transitions (`start_draft`, picks/bans) live in the draft feature, not here.

### create_lobby(config fields..., presetId, joinCode, password, name?, banRestriction?, lineupFormat?, hideMmr?, refereeExclusiveConcede?)
1. `getAuthenticatedUser(ctx)` -- reject guests.
2. D-31b: if `presetId > 0`, verify `LobbyPreset` exists (validation only -- preset values are NOT applied server-side).
3. D-22: `ensureNotInLobby` -- reject if caller has any active LobbyMember row.
4. Generate a server-side `joinCode` (`generateJoinCode`, 6 uppercase alnum, up to 10 retries; the arg is ignored for storage).
5. D-23: reject guest + `matchType=Ranked`; force `rosterVisibility=ClosedNoRating` for guests.
6. D-42: if `matchType=Ranked`, force `allowMirrorPicks=false`. Resolve `disconnectForfeitSeconds` (0 sentinel -> undefined).
7. Insert `Lobby` (`insertWithAudit`) with `stage=Waiting`, `currentPlayerCount=1`, `hostUserId`, `isTournamentControlled=false`, `lastActivityAt=now`.
8. D-24 / D-27: insert host as `LobbyMember` with `lobbySlot=Spectator`, `isReferee=true`, `isConfirmed=false`, `isOnline=true`, `joinSeq=1` (R4, S4).
9. D-02: if `!isPublic` and password provided, insert `LobbyPassword` row.

Series settings and cost-set guards (Phase S6 execution; DECISIONS.md A27, A28, A38(2), A40, A45(2)/(5), D-A8; backlog #2, #6-#9), before the insert:
- The six new arguments are optional (an omitted key takes the default): `name` (trimmed, 0-50 chars, default '' — the lobby browser view labels an empty name in S9; no host name is stored, so anonymous lobbies leak nothing), `banRestriction` (NoRestriction), `lineupFormat` (Halves), `hideMmr` (false), `bestOfNAdvantage` (None), `refereeExclusiveConcede` (true, A45(5); it was hardcoded true before).
- `bestOf`: the D-11 sentinel maps 0 to 1, then `ensureBestOf` (helpers/seriesSettings.ts) rejects anything but 1 or 3 with "bestOf must be 1 or 3.". `bestOfNAdvantage` is forced to None when bestOf = 1 (`resolveAdvantage`). **Superseded (S8e, A67(2)):** `bestOf`, `refereeControlsShelving` and `bestOfNAdvantage` are no longer arguments or columns; `resolveAdvantage` is deleted.
- `lineupFormat`: both values are accepted. The A21 rule "8 characters → Halves, 12 → Thirds" has no other source in the schema today (every draft sequence fields 8 characters per team, `teamSize` is players), so the format itself is the character count; the 12-character draft is S7's.
  - Phase S7 execution (A21): the format drives the draft. Halves = 8 characters per team, Thirds = 12 (`charactersPerTeam` in `shared/scoring`): `initSessionForGame` builds the Classic sequence with `lobby.lineupFormat` and the Auction ends at 8 / 12 won per team; lineups (`arrange_lineup` / `confirm_lineup`) have 2 or 3 groups of 4, arranged and confirmed only by the team captain or a referee. Details: `docs/match-session/architecture.md` "Phase S7 execution".
  - Phase S7b execution (DECISIONS.md A59, A60): `confirm_lineup` was removed (no lineup confirmation; captains confirm the whole game with `confirm_game`, see `docs/match-results/architecture.md` "Game package"); lineups stay editable in Equipping and Scoring until the game closes. Classic Thirds uses the A59 orders (`docs/match-session/draft-order.md`).
- `ensureCostSetUsable(costSetId, gameMode, draftMode)` (helpers/costSetGuards.ts): id 0 passes; otherwise the set must exist, be published and not locked, and hold at least one `HsrCharacterCost` and one `HsrLightconeCost` row for the tuple (D-D6 loose coverage; synergies never reject). Error: "This cost set has no costs for {gameMode} × {draftMode}. Pick another set or ask its owner to extend it."

Abuse guards (Phase S5 execution; DECISIONS.md A42, A43; ACCESS-SECURITY-OPS B-7), after step 5 and before the insert, values read from `AbuseConfig` (id 1) at call time:
- A42(1) kill switch: a guest caller is rejected with "Guest lobby creation is temporarily disabled" while `guestLobbyCreationEnabled` is false. `join_lobby` has no such check, so guests already in lobbies are unaffected.
- A57 / A58 inline breaker (Phase S6 execution): right after the kill-switch check, a guest creation bumps `AbuseCounter['guest_lobby_create']` (`recordGuestLobbyCreation`); the creation that pushes the window count past `guestLobbyBurstThreshold` (default 50 in 10 minutes) succeeds and turns the switch off with one `AdminAlert` in the same transaction (docs/admin/architecture.md "Abuse controls").
- B-7 hourly cap (D-B5, guests included per A43): `consumeLobbyCreateAllowance` (`helpers/abuseControls.ts`) keeps a fixed one-hour window in `UserRateState` (`lobbyWindowStart`, `lobbyCreates`; row created on first use) and rejects once `lobbyCreatesPerHour` creates fell in the window. D-22 (one lobby at a time) is unchanged.

### join_lobby(lobbyId, joinCode, password)
1. `getAuthenticatedUser(ctx)`.
2. D-03: resolve lobby by `id` (if `lobbyId>0`) else by `joinCode`; throw "Lobby not found." if neither resolves.
3. **Reconnect path** (existing LobbyMember row; F1 / Phase S4 execution: evaluated BEFORE the one-lobby check, which counts the row being rejoined and used to reject every reconnect): require a reconnect stage (Waiting, Drafting, Equipping, Scoring, AwaitingResult; A67(1)); D-38 reject if `voluntarilyLeft`; D-39 recompute `disconnectPoolRemainingMs`; delete+reinsert member `isOnline=true`, clear `disconnectedAt`; auto-resume the MatchSession timer if it was auto-paused; bump activity; return (no count change, no chat).
4. **New-join path** only: D-22 `ensureNotInLobby`; D-23 guest restrictions; D-21 `ensureNotBanned` (reject if a `LobbyBan` row exists).
5. Require stage Waiting or Drafting; D-02 verify password against `LobbyPassword` if `!isPublic`.
6. Cap enforcement: reject if total members >= 20 ("Lobby is full (max 20 members)."); reject if spectators >= 12 ("Spectator slots are full (max 12)."). Hardcoded -- no config knob.
7. D-27: insert `LobbyMember` with `lobbySlot=Spectator`, `isReferee=false`, `isConfirmed=false`, `joinSeq = max(joinSeq in lobby) + 1` (R4, S4).
8. D-04 / D-09 / D-26: auto-insert `LobbyMemberAccount` for the user's active HSR account (tournament path validates/snapshots against `TournamentPlayerAccount`; approved stand-ins snapshot all their accounts into TPA first).
9. Increment `currentPlayerCount`, bump `lastActivityAt`, insert System `ChatMessage` "{name} joined the lobby."

### leave_lobby(lobbyId)
1. `getAuthenticatedUser(ctx)`; `ensureLobbyMember`; load lobby.
2. **Active stage** (Drafting/Equipping/Scoring; A67(1)):
   - D-29 spectators/coaches: delete their `LobbyMemberAccount` rows, delete `LobbyMember`, decrement count, return.
   - D-31 players: delete `LobbyMemberAccount` rows; delete+reinsert member with `voluntarilyLeft=true`, `isOnline=false` (row KEPT for finalization; count unchanged).
   - D-34/35/36: `transferCaptain`, `transferReferee`, `transferHost` to the next eligible online team member (see flag-transfer priority below). F6 (Phase S4 execution): the `Lobby` row is re-read after the transfers; `performConcede` and the final `lastActivityAt` update spread the fresh row, so a transferred host is not handed back to the leaver.
   - D-31/D-82: if the leaver's team has no remaining non-left members, `performConcede` (their team loses, reason `VoluntaryLeave`) -- UNLESS `refereeExclusiveConcede` + a third-party referee is present (then blocked; referee decides).
   - Insert System `ChatMessage` "{name} left the match."; return.
3. **Normal** (Waiting/AwaitingResult): delete `LobbyMemberAccount` rows; delete `LobbyMember`; compute new count.
4. If count==0 and stage Waiting: `hardDeleteLobby` (auto-close) and return.
5. (A67(1), S8e: the D-19 count-0 exemption of the removed long-pause stage is gone.)
6. Else update `currentPlayerCount`; insert System `ChatMessage` "{name} left the lobby."

### close_lobby(lobbyId)
1. `getAuthenticatedUser(ctx)`; load lobby.
2. D-21: `ensureHostOrAbove` (host or Moderator+).
3. D-20: `ensureStageIs(Waiting)` (A67(1): the unused terminal stage is gone).
4. D-19: `hardDeleteLobby` -- cascade delete (order): MatchResultParticipant -> MatchResultGame -> MatchResultRecord -> ChatMessage -> LobbyMemberAccount -> LobbyMember -> LobbyBan -> LobbyPassword -> MatchSessionStep -> MatchSession -> Lobby (LobbyCursorEvent auto-expires).

### kick_member(lobbyId, targetUserId)
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureLobbyMember` (caller).
2. Permission `canKickOrBan`: host, Admin, Moderator, or referee with `refereeCanKick`.
3. Reject kicking self or host; validate target is a member.
4. Delete target `LobbyMember`; decrement `currentPlayerCount` (floored at 0).
5. Insert System `ChatMessage` "{name} was kicked from the lobby." (No LobbyBan, no account cleanup.)

### ban_member(lobbyId, targetUserId)
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureLobbyMember` (caller).
2. Permission `canKickOrBan` (same as kick); reject self or host.
3. Insert `LobbyBan` row (`bannedUserId`, `bannedByUserId=caller`).
4. If target is currently a member: delete `LobbyMember`, decrement count.
5. Insert System `ChatMessage` "{name} was banned from the lobby." (Phase S6 execution: `unban_member` lifts a ban, below.)

### unban_member(lobbyId, userId) (Phase S6 execution, A45(3))
1. `getAuthenticatedUser(ctx)`; load lobby (any stage).
2. Permission: the host, Moderator+ (membership not required), or a member who is referee while `refereeCanKick` is on; else "Only the host, moderators, admins, or an authorized referee can lift a lobby ban."
3. Reject when no `LobbyBan` row exists ("This user is not banned from the lobby."); delete it (`by_lobby_and_user`). No chat message, no Lobby write (bans are private, so nothing else changes on the wire).

### update_lobby_settings(lobbyId, config fields..., isPublic, password)
1. `getAuthenticatedUser(ctx)`; load lobby.
2. D-21 `ensureHostOrAbove`; D-28 `ensureStageIs(Waiting)`.
3. D-65: if `isTournamentControlled`, lock integrity fields (teamSize, gameMode, matchType, anonymity flags, rosterVisibility, requireOwnership, costSetId, disconnect settings, allowMirrorPicks) to existing values; QoL fields still update.
4. D-23 guest forcing (matchType=Casual, ClosedNoRating); D-42 Ranked -> `allowMirrorPicks=false`.
5. Update `Lobby` row (locked fields keep existing values); bump `lastActivityAt`.
6. Password: upsert `LobbyPassword` if `!isPublic` + password given; delete it if `isPublic`.
7. Reset readiness: every `isConfirmed=true` member is delete+reinserted with `isConfirmed=false`.

Phase S6 execution (backlog #2, #6, #7, #9; DECISIONS.md A28, A33, A38(2)/(4), A40, A45(2)) — **S8e (A67(2)): `bestOf`, `refereeControlsShelving` and `bestOfNAdvantage` are removed from the arguments and from the lock list; the integrity set adds only `lineupFormat` to D-65**: new optional arguments `bestOf`, `refereeControlsShelving`, `lineupFormat`, `bestOfNAdvantage`, `banRestriction`, `hideMmr`, `name` (an omitted key keeps the lobby's value; `refereeExclusiveConcede` was already an argument).
- Integrity set (locked in tournament lobbies): the D-65 list plus `bestOf`, `lineupFormat` and `bestOfNAdvantage` (A27: the head start comes from the bracket, copied by S8). Unlike the D-65 fields, which silently keep the tournament's value, an explicit **change** of any of the three is rejected ("bestOf is set by the tournament bracket and cannot be changed in a tournament lobby." / "lineupFormat is set by the tournament ..."); passing the current value is accepted.
- Free set (host or Moderator+, Waiting, tournament lobbies included): `refereeControlsShelving`, `banRestriction`, `hideMmr`, `refereeExclusiveConcede`, `name`, plus the existing free fields.
- `bestOf`: 0 → 1, then `ensureBestOf`; `bestOfNAdvantage` forced None when the resulting bestOf is 1.
- Cost set: a changed `costSetId` runs `ensureSelectableCostSet`; a change of `costSetId`, `gameMode` or `draftMode` runs `ensureCostSetCovers` on the resulting tuple.
- Step 7 (confirmation reset) covers every change, the new fields included.

### set_team_slot(lobbyId, targetUserId, lobbySlot)
1. `getAuthenticatedUser(ctx)`; load lobby; D-28 `ensureStageIs(Waiting)`.
2. Permission: moving someone else requires `ensureHostOrAbove`; self-move requires membership. `ensureLobbyMember` (target).
3. Coach guard: assigning a coach slot to a non-coach requires host or referee.
4. Cap enforcement (when team/coach status changes): 1 coach per team, `teamSize` players per team, 12 spectators.
5. Delete+reinsert target `LobbyMember` with new `lobbySlot` and `isConfirmed=false`; bump activity.

### confirm_ready(lobbyId) / unconfirm_ready(lobbyId)
1. `getAuthenticatedUser(ctx)`; load lobby; D-28 `ensureStageIs(Waiting)`; `ensureLobbyMember`.
2. Delete+reinsert caller `LobbyMember` with `isConfirmed=true` (confirm) or `false` (unconfirm).

### set_captain(lobbyId, targetUserId)
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureLobbyMember` (caller).
2. D-30 permission: host OR (referee AND `refereeCanSetCaptain`) OR Admin+.
3. `ensureLobbyMember` (target); reject if target is Spectator or Coach.
4. Demote existing captain(s) on target's team; promote target (`isCaptain=true`) via delete+reinsert.

### create_lobby_preset / update_lobby_preset / delete_lobby_preset(presetId, ...)
1. `getAuthenticatedUser(ctx)`.
2. D-31b permission: `create` requires TournamentHost+ (TO/Mod/Admin). `update`/`delete` use `ensureCanMutatePreset` -- system presets are Admin-only; non-system editable by Admin, the owner, or a Moderator whose target's creator is Moderator+/TournamentHost+.
3. Validate `name` length 1-50; resolve `disconnectForfeitSeconds` (0 -> undefined).
4. `create`: insert `LobbyPreset` (`isSystemPreset=false`, `creatorUserId=user.id`). `update`: `updateWithAudit` all config fields. `delete`: delete row.
5. B-7 (Phase S5 execution): `create` counts the caller's presets on `creator_user_id` and rejects at `AbuseConfig.maxPresetsPerUser` (D-B5: 10). Guests never reach this check (TournamentHost+ guard, A43).
6. Phase S6 execution (backlog #6, #2; A28, A45(2)) — the three series arguments are removed in S8e (A67(2)): optional arguments `bestOf`, `refereeControlsShelving`, `bestOfNAdvantage`, `lineupFormat`, `banRestriction`, `hideMmr` (create: defaults 1 / true / None / Halves / NoRestriction / false; update: omitted keeps the stored value). `ensureBestOf` and the None-for-Bo1 rule as in `create_lobby`. Cost set: `create` runs `ensureCostSetUsable`; `update` runs it when `costSetId` changes, else `ensureCostSetCovers` when gameMode / draftMode change.
7. Phase S6 execution (A33a): `delete_lobby_preset` rejects the system preset for everyone, Admins included ("The system lobby preset cannot be deleted."); `update_lobby_preset` on it stays Admin-only (`ensureCanMutatePreset`).

### System lobby preset (helpers/systemPreset.ts; Phase S6 execution, A33a / CH-S4)
`seedSystemLobbyPreset(ctx)` runs in `init` (and after `server_nuke_test_data` clears `LobbyPreset`), idempotent: one row with `isSystemPreset = true`, `creatorUserId = SYSTEM_USER_ID (0)` (so it never counts against a user's preset cap), name "Tournament default". Free-set values = the constants `create_tournament_lobby` hardcodes (reducers/tournamentLobby.ts): Classic, ban mode Four, NoRestriction, turn 60 s, reserve 120 s, handicaps 0, character / light-cone budget 0, minimum raise 20, autoRandomPick false, referee may undo / pause / set captain, not kick, player pause on, exclusive concede on, referee controls shelving on, hideMmr false. Integrity-set columns are placeholders the tournament overrides in a tournament lobby: teamSize 1, MemoryOfChaos, Casual, public, not anonymous, OpenRoster, no ownership, cost set 0, Standard disconnect, no forfeit timer, no mirror picks, Halves, bestOf 1, advantage None. `create_tournament` points `Tournament.lobbyPresetId` at it; S8's `create_tournament_lobby` copies the free set from the pointed preset.

### shuffle_teams(lobbyId, mode: ShuffleMode) (lobbySettings.ts; Phase S6 execution, A45(3))
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureHostOrAbove`; `ensureStageIs(Waiting)`.
2. `TeamSwap`: every BluePlayer/BlueCoach becomes RedPlayer/RedCoach and vice versa; captain flags stay (each captain stays with their team).
3. `RandomSwap`: the non-coach Blue + Red players (ordered by `joinSeq`) are shuffled with `ctx.random.shuffle` and dealt Blue, Red, Blue, ...; coaches and spectators stay; captain flags are cleared (`start_draft` assigns them, D-30).
4. One pass over the members: new slot, `isConfirmed=false`, cleared captain flag (delete + reinsert only for rows that change); bump `lastActivityAt`.

### transfer_referee(lobbyId, targetUserId) / reclaim_referee(lobbyId)
- `transfer_referee`: caller must currently be referee (`isReferee=true`); reject self-target; delete+reinsert caller `isReferee=false` and target `isReferee=true`. No stage gate.
- `reclaim_referee`: caller must be lobby host; find current referee (no-op if none or host already referee); delete+reinsert referee `isReferee=false` and host `isReferee=true`.
- There is no `assign_referee`/`remove_referee` reducer -- the host starts as referee (D-24) and the flag moves via transfer/reclaim/auto-transfer-on-leave.

### broadcast_cursor(lobbyId, x, y)
1. Map `ctx.sender` -> `UserIdentity`; silently return if unregistered. Look up caller's `LobbyMember`; silently return if not a member.
2. D-34: silently return if caller's slot is Spectator (coaches hold Blue/Red slots, so they still broadcast).
3. Insert `LobbyCursorEvent` (event table): `senderUserId = isAnonymousPlayers ? 0 : userId`, `anonymousLabel` set when anonymous, plus x/y/timestamp. No SenderErrors -- all failure modes are silent returns.

B-4 (Phase S5 execution; ACCESS-SECURITY-OPS §B.5, D-B5), between steps 2 and 3:
- Bounds: silently return unless `0 <= x <= 1` and `0 <= y <= 1` (NaN fails the test too).
- Throttle: silently return when `now - LobbyMember.lastCursorAt < AbuseConfig.cursorMinIntervalMs` (default 50 ms = 20 Hz).
- Stamp: delete + reinsert the member row with `lastCursorAt = now` and the audit columns untouched (not a user edit). The event insert carries no audit columns (A19).

### run_lobby_gc / admin_gc_lobbies / seed_lobby_gc_job
- `run_lobby_gc` (scheduled): `performLobbyGc` scans all lobbies -- D-48 skip AwaitingResult; D-47 active stages (Drafting, Equipping, Scoring) skipped while any member is online, else idle check; D-49 Waiting hard-deleted after 30 min idle (A67(1), S8e: the D-16 72 h rule and the D-17 between-games rule are gone with their stages). D-14 writes a `GcResult` audit row if anything was deleted. Requeues itself +15 min.
- `admin_gc_lobbies`: Moderator+ manual one-shot; same sweep, no self-requeue.
- `seed_lobby_gc_job`: server-identity-only (called from `scripts/stdb/bootstrap.ts`); idempotent; inserts the first `LobbyGcJob` row to bootstrap the chain.

### select_match_account(lobbyId, hsrAccountId) / deselect_match_account(lobbyId, hsrAccountId)
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureLobbyMember`. D-06: stage must be Waiting (A67(1); "Account selection is only allowed during the Waiting stage." / "Account deselection …"). A69(3) (S8e fix pass 2): the D-B-03 snapshot ratchet is gone; the snapshot is taken once at `start_draft` (A66) and selection changes nothing after it (selection is Waiting-only, before any `MatchResultParticipant` exists).
2. `select`: reject Spectator/Coach; validate the `HsrAccount` belongs to caller. Tournament path (D-04) is additive up to `Tournament.maxAccountsPerPlayer` and requires the account be locked in `TournamentPlayerAccount`; non-tournament path (D-07) replaces (max 1). ~~D-B-03: bumps `accountRatingSnapshot` if a MatchResult already exists. Phase S6 execution (backlog #10): the bump is `max(snapshot, computeLobbyMemberRating(...))`, the merged rating of the member's current selection (one account: its stored rating), instead of the newly selected account's own rating.~~ (removed, A69(3); see step 1).
3. `deselect`: find and delete the matching `LobbyMemberAccount` row (throw if not selected). No snapshot hook.

### create_tournament_lobby(bracketMatchId, joinCode) / approve_stand_in(bracketMatchId, userId)
- `create_tournament_lobby`: resolve BracketMatch + Tournament; D-64 authorize (Moderator+, organizer, `TournamentAssistant`, or a team member of `team1Id`/`team2Id`); D-45 reject a duplicate non-Finished lobby for the match; D-22 `ensureNotInLobby`; D-67 `matchType` from `countTowardsMmr`; insert `Lobby` with `isTournamentControlled=true` inheriting tournament fields + hardcoded tournament defaults; D-24/D-27 insert creator as `Spectator` + `isReferee=true`, `joinSeq=1` (R4, S4).
- `approve_stand_in`: resolve BracketMatch + Tournament; D-68 authorize (Moderator+, organizer, or assistant); validate target user; reject duplicate; insert `TournamentStandIn` (PK `[bracketMatchId, userId]`, `approvedByUserId=caller`). There is no `remove_stand_in` reducer.

### claim_forfeit(lobbyId, forfeitingTeamSide) (concede.ts; F7, Phase S4 execution)
1. `getAuthenticatedUser(ctx)`; `ensureLobbyMember`; load lobby; stage must be Drafting / Equipping / Scoring (A67(1)).
2. D-81: with `refereeExclusiveConcede` and a third-party (Spectator) referee present, only that referee may call; otherwise spectators and coaches are rejected. D-15: `disconnectPolicy` must be Standard.
3. F7: `forfeitingTeamSide` 0 = the team opposing the caller's slot (rejected for the exclusive referee, who has no team: "Referee must specify forfeitingTeamSide: 1=Blue, 2=Red."), 1 = Blue, 2 = Red; any other value is rejected.
4. D-16: `isForfeitEligible(targetTeam)` stays the gate (every non-coach player of that team offline with `disconnectedAt` set and pool depleted or `disconnectForfeitSeconds` elapsed); then `performConcede` (trigger RefereeDecision for a referee, Disconnect otherwise). `concede_match` and `defer_match` are unchanged.

### client_connected / client_disconnected (index.ts; lobby side, Phase S4 execution)
- `client_connected`: after the presence upsert (`docs/auth/architecture.md`), for every `LobbyMember` of the user: delete pending `RefereeTransferCheck` rows (`by_lobby_and_user`); if the row is offline, delete+reinsert with `isOnline=true`, `disconnectedAt` cleared and `disconnectPoolRemainingMs` decremented by the offline time (`handleDisconnectPoolUpdate`, D-10/D-11). Idempotent (F1). `join_lobby`'s reconnect branch does the same explicitly and additionally auto-resumes an auto-paused draft.
- `client_disconnected`: marks the identity's presence row offline; if the user still has another live `UserPresence` row, stops (A48). Otherwise for every membership: `isOnline=false`; in an active stage (Drafting, Equipping, Scoring; A67(1) `ACTIVE_STAGES`) one `RefereeTransferCheck { lobbyId, userId, scheduledAt: now + 15 s }` (a stale pending row for the pair is replaced); `disconnectedAt=now` in every live stage (Drafting, Equipping, Scoring: the D-08 forfeit clock; never under NoAction). No flag transfer, no pause (A22a, F5).

### run_referee_transfer_check(arg: RefereeTransferCheck) (refereeTransfer.ts; scheduled, A22a)
1. Re-read `Lobby` and the `LobbyMember`; no-op if either is gone (the scheduler consumed the row).
2. "Still offline" = `LobbyMember.isOnline=false` and no live `UserPresence` row of the user (A48).
3. `decideRefereeTransfer` (`shared/lobby-rules`): `transfer` only if still offline, still `isReferee` and the stage is active; `moveRefereeFlag` writes the two rows with the SYSTEM_USER_ID audit actor.
4. Still offline and active stage: `transferCaptain` (D-34), then `transferHost` (D-36) on the re-read lobby.
5. Drafting only: `decideAutoPause` -> insert the auto-Pause step (`actorUserId=0`, `isAutoPause=true`, `timeRemainingMs` as in `pause_draft`, `sequence = getNextSequence` per F9) and set `timerState.isPaused=true`.

### Flag-transfer priority (flagTransferHelpers.ts, shared/lobby-rules/refereeTransfer.ts)
`leave_lobby` (a player leaving voluntarily) keeps the D-34/35/36 helpers. All candidates filtered to online, non-spectator, non-coach, non-left members:
- **Captain** -> lowest-userId teammate on the same team.
- **Referee** -> current host first, else lowest-userId eligible member.
- **Host** -> current referee first, else lowest-userId eligible member.

**Disconnects** (Phase S4 execution; A22(5), A22a, F5) move nothing in the hook. `run_referee_transfer_check` fires 15 s after the user's last device disconnected and, only if the member is still offline:
- **Referee** -> `pickRefereeSuccessor`: the host if online, else Blue players, Red players, spectators, Blue coach, Red coach, each tier by `joinSeq`; the leaver, offline members and `voluntarilyLeft` are skipped; no candidate = the flag stays (GC handles the orphan).
- **Captain / Host** -> the D-34 / D-36 helpers above, with the same grace, while the lobby is still in an active stage.
- **Auto-pause** -> only an offline team player (never a spectator, coach or spectator-referee), only in Drafting, only under Standard/Deferred, only when not already paused.

## Phase S8d execution (DECISIONS.md A26, A34, A35; ACCESS-SECURITY-OPS §D.8.4, §D.8.5)

- **Seat enforcement (A35, D.8.5).** `set_team_slot` calls `ensureSeatAllowed(ctx, lobby, targetUserId, slot)`
  (`helpers/tournamentLobbySides.ts`, over `allowedSlotsFor`): in a tournament lobby a slot outside the target's
  allowed set is rejected, "This seat is not available to you in this tournament lobby."; casual lobbies allow every
  slot. `shuffle_teams` rejects tournament lobbies: "Seats in a tournament lobby follow the bracket (A35); shuffling
  is not available." (a shuffle would seat team1 on Red while the hand-off credits Blue = team1).
- **Auto-seat (A26).** `join_lobby` has no slot argument; in a tournament lobby in Waiting the new member gets
  `autoSeatSlot`: the player slot of its team (member or approved stand-in) while that side has fewer than `teamSize`
  non-coach members, otherwise Spectator; coaches are never auto-seated. Casual lobbies and later stages: Spectator.
  The 12-spectator cap applies only to a Spectator join.
- **Referee reclaim (D.8.4).** `reclaim_referee` also accepts, in a tournament lobby, a member of the lobby holding the
  `results` permission (assistant with `canResolveResults`, organizer, Moderator+); the flag moves to the caller.
  Casual lobbies: host only.
- **Auto-resume (S7b hand-off).** The reconnect branch of `join_lobby` resumes an auto-paused draft when the latest
  **Pause** step of the current game is an auto-pause (a later SetEidolon or other step no longer hides it).
- **Tournament lobby settings.** `update_lobby_settings` keeps the integrity set locked (verified: `bestOf`,
  `lineupFormat`, `bestOfNAdvantage` rejected on change; the D-65 fields silently kept); the free set stays editable
  by the host or Moderator+ in Waiting (A38(4)). S8e: only `lineupFormat` remains of the three (A67(2)).

## Phase S8e execution (DECISIONS.md A67(1)(2)(5))

- **Stages.** `LobbyStage` = Waiting → Drafting → Equipping → Scoring → AwaitingResult. The between-games stage, the
  long-pause stage and the writerless terminal stage are removed with every branch that named them:
  `leave_lobby` (active stages = Drafting, Equipping, Scoring; the D-19 count-0 branch is gone), `join_lobby`
  reconnect stages (Waiting, Drafting, Equipping, Scoring, AwaitingResult), `close_lobby` (Waiting only),
  `concede_match` / `claim_forfeit` / `defer_match` ("… only available during Drafting, Equipping, or Scoring."),
  `select_match_account` / `deselect_match_account` (Waiting only), `ensureMatchAlive` / `ensureNotConceded`,
  `isCostSetInUse` (every lobby counts), `delete_my_account`'s lobby guard, `dq_participant` (live stages only; the
  D-26 hard-delete branch is gone), `ACTIVE_STAGES` (`shared/lobby-rules`) and `DISCONNECT_CLOCK_STAGES` (`index.ts`),
  both Drafting, Equipping, Scoring. The membership semantics (D-31, D-38, kick, transfers, GC presence) are
  unchanged here; S8f (A68) revisits them.
- **GC.** `performLobbyGc`: D-48 AwaitingResult skipped; D-47 live stages need everyone offline + 30 min idle; D-49
  Waiting 30 min idle. The D-16 72 h rule and the D-17 rule are deleted.
- **Series reducers deleted.** `advance_to_next_game`, `shelve_series`, `resume_series` (`reducers/seriesManagement.ts`
  is gone) and their bindings.
- **No series settings.** `Lobby` / `LobbyPreset` lose `bestOf`, `bestOfNAdvantage`, `refereeControlsShelving`;
  `create_lobby`, `update_lobby_settings`, `create_lobby_preset`, `update_lobby_preset` lose the three arguments; the
  system preset loses the three values; the tournament-lobby lock list keeps `lineupFormat` only. `AdvantageSide` and
  `resolveAdvantage` are deleted; `ensureBestOf` / `ensureWinnerAdvantage` stay for the tournament (A28 chain).
- **Tournament lobby (A67(5)).** `create_tournament_lobby(bracketMatchId, joinCode)`: caller rule (A34) and D-22
  unchanged; the match must be Ready; D-45 rejects while any lobby of the match is not settled (its record not
  Validated) with "A lobby for this bracket match is still in play."; a parked lobby with a Validated record does not
  block; the cap rejects when the Validated records of the match reach `BracketMatch.bestOf`: "This bracket match has
  no games left (best of N).". The lobby copies no `bestOf` / head start. Details: `docs/tournament/architecture.md`.
- `hardDeleteLobby(ctx, lobbyId, keepResultRecord = false)`: with `keepResultRecord` the record row survives (the
  caller marked it Voided, A24(3)); its children are deleted as usual.


## Phase History

| Decision | Source | Date |
|----------|--------|------|
| One-lobby-per-user: LobbyMember.user_id btree + ensureNotInLobby (D-22) enforces single active membership | Phase 05 CONTEXT.md | 2026-02-25 |
| isAnonymousPlayers / isAnonymousSpectators: real userId zeroed at write time (D-92) | Phase 09 CONTEXT.md | 2026-03-28 |
| LobbyBan uses composite PK [lobbyId, bannedUserId] with bannedByUserId -- row existence = banned state | Phase 05 execution | 2026-02-25 |
| LobbyPreset: full flat config copy, TournamentHost+ to create, hierarchical mutate permission (D-31b) | Phase 09 execution | 2026-03-28 |
| TournamentStandIn: approved substitutes keyed by [bracketMatchId, userId], snapshotted into TPA at join | Phase 10.4 execution | 2026-03-29 |
| LobbyMemberAccount: per-match account selection table, non-public (D-02) -- tournament path additive, non-tournament path replace | Phase 10.4 execution | 2026-03-29 |
| select_match_account / deselect_match_account: additive for tournament (maxAccountsPerPlayer), replace for non-tournament | Phase 10.4 execution | 2026-03-29 |
| BracketMatch.lobbyId removed; relationship inverted -- Lobby.bracketMatchId with btree index | Phase 10.1 execution | 2026-03-25 |
| GC restructured to a single self-rescheduling sweep (run_lobby_gc, LobbyGcJob = scheduledId + scheduledAt only); scans all lobbies every 15 min, per-stage idle rules (D-16/17/47/48/49); seed_lobby_gc_job bootstraps | Phase 12.1 execution | 2026-04-04 |
| hardDeleteLobby cascade order: MatchResult* -> ChatMessage -> LobbyMemberAccount -> LobbyMember -> LobbyBan -> LobbyPassword -> MatchSessionStep -> MatchSession -> Lobby | Phase 12.1 execution | 2026-04-04 |
| LobbySlot enum (BluePlayer/BlueCoach/RedPlayer/RedCoach/Spectator) replaces TeamLabel+ParticipationRole; host & all joiners start as Spectator (D-24/D-27); team placement via set_team_slot | Phase 09 execution | 2026-03-29 |
| refereeControlsShelving flag: allows referee to call advance_to_next_game / shelve_series / resume_series | Phase 10.1 execution | 2026-03-25 |
| Referee lifecycle: host starts as referee (D-24); moved via transfer_referee / reclaim_referee / auto-transfer on leave. No assign/remove_referee reducer | Phase 09 execution | 2026-03-29 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| Phase 16 route-group rename: frontend lobby page moved from `app/(authenticated)/lobby/page.tsx` -> `app/(authed)/lobby/page.tsx`. Backend unchanged -- pure file-path change | Phase 16 execution | 2026-04-18 |
| Full schema/reducer reconciliation against shipped code: removed nonexistent columns (maxSpectators, allowSpectators, timerDurationSeconds/timerPausedAt/timerResumedOffset, currentGame, blueScore/redScore, isPrivate, password, gcJobId) and reducers (transfer_host, assign/remove_referee, unban_member, remove_stand_in, set_ready, send_cursor_event); added the real column set, LobbyPassword/LobbyMemberAccount/LobbyCursorEvent(event) shapes, and current reducer roster. Matches contract.md | Doc correction | 2026-07-05 |
| F1: `join_lobby` evaluates the reconnect branch before `ensureNotInLobby`; Waiting is a reconnect stage; `client_connected` restores every membership (isOnline, disconnectedAt cleared, pool via `handleDisconnectPoolUpdate`) and deletes the pending `RefereeTransferCheck` rows | Phase S4 execution (DECISIONS.md A22(2), A22a) | 2026-11-06 |
| A22a / A48 / F5: `client_disconnected` only marks the member offline (`disconnectedAt` for Standard/Deferred) and schedules `RefereeTransferCheck` 15 s out, and only when the user has no other live `UserPresence` row; `run_referee_transfer_check` moves referee (A22(5) order by `joinSeq`, SYSTEM actor) / captain / host and auto-pauses for offline team players only; decision core in `shared/lobby-rules/refereeTransfer.ts` (tests `refereeTransfer.test.ts`, T-S4(a)) | Phase S4 execution (DECISIONS.md A22(5), A22a, A48) | 2026-11-06 |
| F6: `leave_lobby` re-reads the Lobby row after `transferHost` before `performConcede` and the final update | Phase S4 execution (DECISIONS.md A22(2)) | 2026-11-06 |
| F7: `claim_forfeit(lobbyId, forfeitingTeamSide)`: 0 derives the opposing team, 1 = Blue, 2 = Red; non-zero required for the exclusive referee; `isForfeitEligible` stays the gate | Phase S4 execution (DECISIONS.md A22(2)) | 2026-11-06 |
| B-4: `broadcast_cursor` drops out-of-range x/y and calls inside `AbuseConfig.cursorMinIntervalMs` (per member, `LobbyMember.lastCursorAt`, no audit bump) | Phase S5 execution (DECISIONS.md A43, D-B5) | 2026-11-06 |
| B-7 / A42: `create_lobby` rejects guests while `guestLobbyCreationEnabled` is off and caps every user (guests included) at `lobbyCreatesPerHour` through `UserRateState`; `create_lobby_preset` caps at `maxPresetsPerUser` | Phase S5 execution (DECISIONS.md A42, A43) | 2026-11-06 |
| R4: `LobbyMember.joinSeq` assigned at insert (host = 1, then max + 1) in `create_lobby`, `join_lobby`, `create_tournament_lobby`; `LobbyMember` documented as private (S3, A37) | Phase S4 execution (DECISIONS.md A22(5), A37) | 2026-11-06 |
| `create_lobby` gains optional `name`, `banRestriction`, `lineupFormat`, `hideMmr`, `bestOfNAdvantage`, `refereeExclusiveConcede`; bestOf {1, 3} guard with the 0 → 1 sentinel; advantage None for Bo1; cost-set selectability + loose coverage | Phase S6 execution (DECISIONS.md A27, A28, A38(2), A40, A45(2), A45(5), D-A8; backlog #2, #8) | 2026-11-06 |
| `update_lobby_settings` series / free-set fields; bestOf + lineupFormat join the tournament lock list (explicit change rejected); free set editable in tournament lobbies; cost-set guards on change | Phase S6 execution (DECISIONS.md A33, A38(4); backlog #2, #9) | 2026-11-06 |
| Presets store and validate the series fields + banRestriction / lineupFormat / hideMmr; system preset seeded in `init`, never deletable, Admin-only edit | Phase S6 execution (DECISIONS.md A33a, A45(2); backlog #6) | 2026-11-06 |
| New reducers `shuffle_teams(lobbyId, mode)` and `unban_member(lobbyId, userId)` | Phase S6 execution (DECISIONS.md A45(3)) | 2026-11-06 |
| Inline guest-lobby breaker in `create_lobby` (AbuseCounter fixed window, default 50 in 10 minutes) | Phase S6 execution (DECISIONS.md A57, A58) | 2026-11-06 |
| `select_match_account` ratchet uses the merged rating of the current selection | Phase S6 execution (backlog #10) | 2026-11-06 |
| `lineupFormat` drives the character count (Thirds = 12 per team) and the lineup groups; lineups arranged / confirmed by the captain or a referee only | Phase S7 execution (DECISIONS.md A21; backlog #3) | 2026-11-06 |
| Seat enforcement in `set_team_slot`, auto-seat in `join_lobby` (tournament lobbies), `reclaim_referee` for seated `results` staff, auto-resume reads the latest Pause step of the current game, `hardDeleteLobby` keepResultRecord flag | Phase S8d execution (DECISIONS.md A24(3), A26, A35; D.8.4, D.8.5) | 2026-11-07 |
| One game per lobby: series stages, series reducers and series settings removed; stage lists shrink to the live stages; GC D-16 / D-17 gone; D-45 = one unsettled lobby per bracket match + decided / cap rejections | Phase S8e execution (DECISIONS.md A67(1)(2)(5)) | 2026-11-08 |
| `select_match_account` loses the D-B-03 snapshot ratchet (dead since selection is Waiting-only); the snapshot is taken once at `start_draft` | Phase S8e execution (DECISIONS.md A69(3)) | 2026-11-08 |

---

*Last updated: 2026-11-08*
*Feature owner: Phase 05 / Phase 09 / Phase 10.1 / Phase 10.4 / Phase 12.1 / Phase 16*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
