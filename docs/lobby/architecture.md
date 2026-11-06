# Lobby -- Architecture

Last updated: 2026-07-05

## Overview

Lobbies are the per-match rooms where players draft characters and play games. Each lobby is either standalone (`create_lobby`) or tournament-linked (`create_tournament_lobby`, carrying `tournamentId` + `bracketMatchId` with `isTournamentControlled=true`). Lobbies advance through `LobbyStage`: Waiting -> Drafting -> Equipping -> Scoring -> (BetweenGames for best-of-N series) -> AwaitingResult -> Finished, with Shelved as a long-term pause branch. A self-rescheduling garbage-collection sweep (`run_lobby_gc`, backed by the `LobbyGcJob` scheduled table) fires every 15 minutes and hard-deletes idle lobbies (Waiting/Finished after 30 min idle; casual Shelved after 72h; active stages only once all members are offline). Players hold at most one active lobby membership at a time; every mutating entry point calls `ensureNotInLobby` (D-22) to enforce the one-lobby-per-user invariant.

Key membership model (D-24 / D-27): the host is inserted as a `LobbyMember` with `lobbySlot=Spectator` and `isReferee=true`. **Every** joiner also lands in the `Spectator` slot; team/coach placement happens afterward via `set_team_slot`. There is no `allowSpectators`/`maxSpectators` configuration — spectating is always allowed, capped by hardcoded limits (max 12 spectators, max 20 total members) enforced in `join_lobby` and `set_team_slot`.

Passwords live in the private `LobbyPassword` table (never broadcast). Anonymous play zeroes `senderUserId` at write time on cursor/chat events. `LobbyPreset` stores a full flat copy of the lobby config fields for save/restore. `LobbyMemberAccount` records which HSR account(s) each member uses for the match (private, D-02). Stand-ins (`TournamentStandIn`) track approved substitutes per bracket match.

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
  +-- bestOf: u8 (1 = single game; 3/5/7 = series) / refereeControlsShelving: bool
  +-- disconnectPolicy: DisconnectPolicy / disconnectForfeitSeconds: u32?
  +-- gameMode: GameMode
  +-- lastActivityAt: Timestamp  (drives GC idle checks)
  +-- stage: LobbyStage (Waiting | Drafting | Equipping | Scoring | BetweenGames | Shelved | AwaitingResult | Finished)
  +-- audit columns
  Indexes: host_user_id (btree), stage (btree), tournament_id (btree), bracket_match_id (btree)

  +-- LobbyMember (PK: [lobbyId, userId])  [public: true]
  |     lobbyId -> Lobby.id  [btree: lobby_id]
  |     userId -> User.id  [btree: user_id]
  |     isOnline: bool
  |     lobbySlot: LobbySlot (BluePlayer | BlueCoach | RedPlayer | RedCoach | Spectator)
  |     isReferee: bool   (admin powers within this lobby)
  |     isConfirmed: bool (ready-up per D-29)
  |     isCaptain: bool   (captain designation per D-30)
  |     voluntarilyLeft: bool                (D-31: player voluntarily left an active match)
  |     disconnectedAt: Timestamp?           (D-08: disconnect event time)
  |     disconnectPoolRemainingMs: u32       (D-10: remaining disconnect pool, init 300000 at draft start)
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

TournamentStandIn (PK: [bracketMatchId, userId])  [public: true]
  bracketMatchId -> BracketMatch.id  [btree: bracket_match_id]
  userId -> User.id
  approvedByUserId -> User.id
  audit columns
  Indexes: bracket_match_id (btree), by_match_and_user (btree, [bracketMatchId, userId])
```

> **Composite-PK update pattern:** `LobbyMember`, `LobbyBan`, and `LobbyMemberAccount` rows cannot be updated in place. All "updates" are `by_lobby_and_user.delete([...])` followed by `insert(updateWithAudit(...))`.

## Reducer Flows

Lobby-owned reducers live in `reducers/lobbyLifecycle.ts`, `lobbySettings.ts`, `lobbyPresets.ts`, `refereeManagement.ts`, `cursor.ts`, `lobbyGc.ts`, `accountSelection.ts`, and (tournament-linked) `tournamentLobby.ts`. Draft-stage transitions (`start_draft`, picks/bans) live in the draft feature, not here.

### create_lobby(config fields..., presetId, joinCode, password)
1. `getAuthenticatedUser(ctx)` -- reject guests.
2. D-31b: if `presetId > 0`, verify `LobbyPreset` exists (validation only -- preset values are NOT applied server-side).
3. D-22: `ensureNotInLobby` -- reject if caller has any active LobbyMember row.
4. Generate a server-side `joinCode` (`generateJoinCode`, 6 uppercase alnum, up to 10 retries; the arg is ignored for storage).
5. D-23: reject guest + `matchType=Ranked`; force `rosterVisibility=ClosedNoRating` for guests.
6. D-42: if `matchType=Ranked`, force `allowMirrorPicks=false`. Resolve `disconnectForfeitSeconds` (0 sentinel -> undefined).
7. Insert `Lobby` (`insertWithAudit`) with `stage=Waiting`, `currentPlayerCount=1`, `hostUserId`, `isTournamentControlled=false`, `bestOf` (0 -> 1), `lastActivityAt=now`.
8. D-24 / D-27: insert host as `LobbyMember` with `lobbySlot=Spectator`, `isReferee=true`, `isConfirmed=false`, `isOnline=true`.
9. D-02: if `!isPublic` and password provided, insert `LobbyPassword` row.

### join_lobby(lobbyId, joinCode, password)
1. `getAuthenticatedUser(ctx)`.
2. D-03: resolve lobby by `id` (if `lobbyId>0`) else by `joinCode`; throw "Lobby not found." if neither resolves.
3. D-22 `ensureNotInLobby`; D-23 guest restrictions; D-21 `ensureNotBanned` (reject if a `LobbyBan` row exists).
4. **Reconnect path** (existing LobbyMember row): require an active stage (Drafting..AwaitingResult); D-38 reject if `voluntarilyLeft`; D-39 recompute `disconnectPoolRemainingMs`; delete+reinsert member `isOnline=true`, clear `disconnectedAt`; auto-resume the MatchSession timer if it was auto-paused; bump activity; return (no count change, no chat).
5. **New-join path**: require stage Waiting or Drafting; D-02 verify password against `LobbyPassword` if `!isPublic`.
6. Cap enforcement: reject if total members >= 20 ("Lobby is full (max 20 members)."); reject if spectators >= 12 ("Spectator slots are full (max 12)."). Hardcoded -- no config knob.
7. D-27: insert `LobbyMember` with `lobbySlot=Spectator`, `isReferee=false`, `isConfirmed=false`.
8. D-04 / D-09 / D-26: auto-insert `LobbyMemberAccount` for the user's active HSR account (tournament path validates/snapshots against `TournamentPlayerAccount`; approved stand-ins snapshot all their accounts into TPA first).
9. Increment `currentPlayerCount`, bump `lastActivityAt`, insert System `ChatMessage` "{name} joined the lobby."

### leave_lobby(lobbyId)
1. `getAuthenticatedUser(ctx)`; `ensureLobbyMember`; load lobby.
2. **Active stage** (Drafting/Equipping/Scoring/BetweenGames):
   - D-29 spectators/coaches: delete their `LobbyMemberAccount` rows, delete `LobbyMember`, decrement count, return.
   - D-31 players: delete `LobbyMemberAccount` rows; delete+reinsert member with `voluntarilyLeft=true`, `isOnline=false` (row KEPT for finalization; count unchanged).
   - D-34/35/36: `transferCaptain`, `transferReferee`, `transferHost` to the next eligible online team member (see flag-transfer priority below).
   - D-31/D-82: if the leaver's team has no remaining non-left members, `performConcede` (their team loses, reason `VoluntaryLeave`) -- UNLESS `refereeExclusiveConcede` + a third-party referee is present (then blocked; referee decides).
   - Insert System `ChatMessage` "{name} left the match."; return.
3. **Normal** (Waiting/AwaitingResult/Finished): delete `LobbyMemberAccount` rows; delete `LobbyMember`; compute new count.
4. If count==0 and stage Waiting: `hardDeleteLobby` (auto-close) and return.
5. D-19: if count==0 and stage Shelved: set count 0, do NOT delete (preserved for return).
6. Else update `currentPlayerCount`; insert System `ChatMessage` "{name} left the lobby."

### close_lobby(lobbyId)
1. `getAuthenticatedUser(ctx)`; load lobby.
2. D-21: `ensureHostOrAbove` (host or Moderator+).
3. D-20: `ensureStageIs(Waiting | Finished)`.
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
5. Insert System `ChatMessage` "{name} was banned from the lobby." (There is no `unban_member` reducer -- removing a ban is an admin data operation.)

### update_lobby_settings(lobbyId, config fields..., isPublic, password)
1. `getAuthenticatedUser(ctx)`; load lobby.
2. D-21 `ensureHostOrAbove`; D-28 `ensureStageIs(Waiting)`.
3. D-65: if `isTournamentControlled`, lock integrity fields (teamSize, gameMode, matchType, anonymity flags, rosterVisibility, requireOwnership, costSetId, disconnect settings, allowMirrorPicks) to existing values; QoL fields still update.
4. D-23 guest forcing (matchType=Casual, ClosedNoRating); D-42 Ranked -> `allowMirrorPicks=false`.
5. Update `Lobby` row (locked fields keep existing values); bump `lastActivityAt`.
6. Password: upsert `LobbyPassword` if `!isPublic` + password given; delete it if `isPublic`.
7. Reset readiness: every `isConfirmed=true` member is delete+reinserted with `isConfirmed=false`.

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

### transfer_referee(lobbyId, targetUserId) / reclaim_referee(lobbyId)
- `transfer_referee`: caller must currently be referee (`isReferee=true`); reject self-target; delete+reinsert caller `isReferee=false` and target `isReferee=true`. No stage gate.
- `reclaim_referee`: caller must be lobby host; find current referee (no-op if none or host already referee); delete+reinsert referee `isReferee=false` and host `isReferee=true`.
- There is no `assign_referee`/`remove_referee` reducer -- the host starts as referee (D-24) and the flag moves via transfer/reclaim/auto-transfer-on-leave.

### broadcast_cursor(lobbyId, x, y)
1. Map `ctx.sender` -> `UserIdentity`; silently return if unregistered. Look up caller's `LobbyMember`; silently return if not a member.
2. D-34: silently return if caller's slot is Spectator (coaches hold Blue/Red slots, so they still broadcast).
3. Insert `LobbyCursorEvent` (event table): `senderUserId = isAnonymousPlayers ? 0 : userId`, `anonymousLabel` set when anonymous, plus x/y/timestamp. No SenderErrors -- all failure modes are silent returns.

### run_lobby_gc / admin_gc_lobbies / seed_lobby_gc_job
- `run_lobby_gc` (scheduled): `performLobbyGc` scans all lobbies -- D-48 skip AwaitingResult; D-16 casual Shelved hard-deleted after 72h idle (tournament Shelved persists); D-17/D-47 active stages skipped while any member is online, else idle check; D-49 Waiting/Finished hard-deleted after 30 min idle. D-14 writes a `GcResult` audit row if anything was deleted. Requeues itself +15 min.
- `admin_gc_lobbies`: Moderator+ manual one-shot; same sweep, no self-requeue.
- `seed_lobby_gc_job`: server-identity-only (called from `post-publish.ts`); idempotent; inserts the first `LobbyGcJob` row to bootstrap the chain.

### select_match_account(lobbyId, hsrAccountId) / deselect_match_account(lobbyId, hsrAccountId)
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureLobbyMember`. D-06: stage must be Waiting or BetweenGames.
2. `select`: reject Spectator/Coach; validate the `HsrAccount` belongs to caller. Tournament path (D-04) is additive up to `Tournament.maxAccountsPerPlayer` and requires the account be locked in `TournamentPlayerAccount`; non-tournament path (D-07) replaces (max 1). D-B-03: bumps `accountRatingSnapshot` if a MatchResult already exists.
3. `deselect`: find and delete the matching `LobbyMemberAccount` row (throw if not selected). No snapshot hook.

### create_tournament_lobby(bracketMatchId, joinCode) / approve_stand_in(bracketMatchId, userId)
- `create_tournament_lobby`: resolve BracketMatch + Tournament; D-64 authorize (Moderator+, organizer, `TournamentAssistant`, or a team member of `team1Id`/`team2Id`); D-45 reject a duplicate non-Finished lobby for the match; D-22 `ensureNotInLobby`; D-67 `matchType` from `countTowardsMmr`; insert `Lobby` with `isTournamentControlled=true` inheriting tournament fields + hardcoded tournament defaults; D-24/D-27 insert creator as `Spectator` + `isReferee=true`.
- `approve_stand_in`: resolve BracketMatch + Tournament; D-68 authorize (Moderator+, organizer, or assistant); validate target user; reject duplicate; insert `TournamentStandIn` (PK `[bracketMatchId, userId]`, `approvedByUserId=caller`). There is no `remove_stand_in` reducer.

### Flag-transfer priority (flagTransferHelpers.ts)
Used by `leave_lobby` auto-transfer. All candidates filtered to online, non-spectator, non-coach, non-left members:
- **Captain** -> lowest-userId teammate on the same team.
- **Referee** -> current host first, else lowest-userId eligible member.
- **Host** -> current referee first, else lowest-userId eligible member.

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

---

*Last updated: 2026-07-05*
*Feature owner: Phase 05 / Phase 09 / Phase 10.1 / Phase 10.4 / Phase 12.1 / Phase 16*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
