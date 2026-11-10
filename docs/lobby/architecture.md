# Lobby -- Architecture

Last updated: 2026-11-06

## Overview

Lobbies are the per-match rooms where players draft characters and play games. Each lobby is either standalone (`create_lobby`) or tournament-linked (`create_tournament_lobby`, carrying `tournamentId` + `bracketMatchId` with `isTournamentControlled=true`). Lobbies advance through `LobbyStage`: Waiting -> Drafting -> Equipping -> Scoring -> (BetweenGames for best-of-N series) -> AwaitingResult -> Finished, with Shelved as a long-term pause branch. A self-rescheduling garbage-collection sweep (`run_lobby_gc`, backed by the `LobbyGcJob` scheduled table) fires every 15 minutes and hard-deletes idle lobbies (Waiting/Finished after 30 min idle; casual Shelved after 72h; active stages only once all members are offline). Players hold at most one active lobby membership at a time; every mutating entry point calls `ensureNotInLobby` (D-22) to enforce the one-lobby-per-user invariant.

Key membership model (D-24 / D-27): the host is inserted as a `LobbyMember` with `lobbySlot=Spectator` and `isReferee=true`. **Every** joiner also lands in the `Spectator` slot; team/coach placement happens afterward via `set_team_slot`. There is no `allowSpectators`/`maxSpectators` configuration — spectating is always allowed, capped by hardcoded limits (max 12 spectators, max 20 total members) enforced in `join_lobby` and `set_team_slot`.

Seats (A74, S9c): every membership gets a seat number `LobbyMember.joinSeq` at insert (host = 1, then `Lobby.lastJoinSeq + 1`). A seat number names exactly one membership for the lobby's lifetime and is never reused. It is the only member key an anonymized caller sees (`view_my_lobby_members.joinSeq`), so the member-targeting reducers (`kick_member`, `ban_member`, `set_team_slot`, `set_captain`, `transfer_referee`) take `targetJoinSeq` and resolve it server-side with `resolveSeat(ctx, lobbyId, joinSeq)` (`helpers/lobby/lobbyHelpers.ts`, through `LobbyMember.lobby_id`; "No member sits at seat N of this lobby."), then run their existing logic on the resolved user id. `unban_member` takes the ban's `bannedJoinSeq`. No argument or rejection of these reducers names a user id (A74(4)).

Passwords live in the private `LobbyPassword` table (never broadcast). Cursor events name the sender by seat (`senderJoinSeq`, A96); chat stores the real sender and the views anonymize it. `LobbyPreset` stores a full flat copy of the lobby config fields for save/restore. `LobbyMemberAccount` records which HSR account(s) each member uses for the match (private, D-02). Stand-ins (`TournamentStandIn`) track approved substitutes per bracket match.

Presence and disconnects (Phase S4 execution; A22a, A48): a member's `isOnline` follows the user's `UserPresence` rows (one per device, see `docs/auth/architecture.md`), so closing one device while another is connected changes nothing. `client_disconnected` only marks the member offline, stamps `disconnectedAt` (Standard/Deferred) and inserts a `RefereeTransferCheck` 15 s out; `run_referee_transfer_check` then moves the referee / captain / host flags and auto-pauses the draft only if the user is still offline. A reconnect (`client_connected`, or the explicit `join_lobby`) restores the member and cancels the pending check, so a page refresh moves no flag and pauses nothing.

## Table Relationships

```
Lobby (id: u32 autoInc PK)  [PRIVATE; view_my_lobby / view_lobby_browser; staff view in S9b]
  +-- joinCode: string  [unique]
  +-- hostUserId -> User.id  [btree: host_user_id]
  +-- teamBlueAlias: string / teamRedAlias: string
  +-- teamSize: u8
  +-- draftMode: DraftMode (Classic | Auction)
  +-- banMode: BanMode
  +-- standardTurnSeconds: u32 / reserveBankSeconds: u32
  +-- rosterDiffAdvantage / rosterThreshold / underThresholdAdvantage / aboveThresholdPenalty / deathPenalty: f32
  +-- matchType: MatchType (Casual | Ranked)
  +-- currentPlayerCount: u8  (denormalized for browser view per D-07; away / abandoned rows still count, A68(1)(4))
  +-- maxSpectators: u8  (A68(8): 0-12, default 12; caps new joins into the Spectator slot; free set)
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
  +-- lastJoinSeq: u32  (A74(3), S9c: the last seat number handed out; host = 1; nextJoinSeq reads it, join_lobby writes the bump)
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
  |     leftAt: Timestamp?                   (A68(2): away; set by a player's Leave in a live stage, cleared only by a return through join_lobby)
  |     abandonedAt: Timestamp?              (A68(4): gone; set when the away player takes another lobby with abandonCurrentMatch; never cleared)
  |     disconnectedAt: Timestamp?           (D-08: disconnect event time; A22a grace check and isForfeitEligible read it)
  |     disconnectPoolRemainingMs: u32       (D-10: remaining disconnect pool, init 300000 at draft start)
  |     joinSeq: u32                         (R4, S4; A74(3), S9c: the seat number, host = 1 then Lobby.lastJoinSeq + 1, never reused; A22(5) order, S9 labels and the A74 seat targeting derive from it)
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
  +-- LobbyBan (PK: [lobbyId, bannedUserId])  [PRIVATE since S3 (A37); view_my_lobby_bans / view_admin_lobby_bans]
  |     lobbyId -> Lobby.id  [btree: lobby_id]
  |     bannedUserId -> User.id
  |     bannedByUserId -> User.id
  |     bannedJoinSeq: u32   (A74(2), S9c: the seat the member held when banned; unban_member resolves the ban by it)
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
  |     senderJoinSeq: u32 -> LobbyMember.joinSeq (A96: the seat, never the user id)
  |     x: f32 / y: f32 / timestamp: Timestamp
  |     no audit columns (A19)
  |
  +-- LobbyPreset (id: u32 autoInc PK)  [PRIVATE; read through view_lobby_presets (system preset + own), S9a]
        name: string / isSystemPreset: bool
        creatorUserId -> User.id  [btree: creator_user_id]
        <full flat copy of Lobby config fields: teamSize, draftMode, banMode, gameMode, matchType,
         timers, budgets, roster handicaps, anonymity flags, rosterVisibility, requireOwnership,
         costSetId, disconnect settings, draft options, referee powers, maxSpectators (A68(8))>
        audit columns

LobbyGcJob (scheduledId: u64 autoInc PK)  [PRIVATE, scheduled]
  scheduledAt: ScheduleAt
  Single self-rescheduling sweep row (NOT one per lobby). run_lobby_gc scans all Lobby rows,
  then requeues itself +15 min. Seeded once by seed_lobby_gc_job (server-only).

RefereeTransferCheck (scheduledId: u64 autoInc PK)  [PRIVATE, scheduled, no audit columns]  (S3 table, S4 behaviour)
  scheduledAt: ScheduleAt / lobbyId: u32 / userId: u32
  Indexes: by_lobby_and_user (btree, [lobbyId, userId])
  A22a: one row per (lobby, user), inserted 15 s out by markMemberOffline (helpers/lobby/disconnectHelpers.ts) for every
  active-stage membership of a user whose last device disconnected (client_disconnected) and for a player's Leave in
  a live stage (leave_lobby, A68(1)); deleted by client_connected for rows without leftAt (reconnect inside the
  window; a leaver's row keeps its check, A68(2)) or consumed by run_referee_transfer_check. Bound through
  `spacetimedb.reducer({ onSchedule: RefereeTransferCheck }, ...)`.

TournamentStandIn (PK: [bracketMatchId, userId])  [public: true]
  bracketMatchId -> BracketMatch.id  [btree: bracket_match_id]
  userId -> User.id
  approvedByUserId -> User.id
  audit columns
  Indexes: bracket_match_id (btree), by_match_and_user (btree, [bracketMatchId, userId])
```

> **Composite-PK update pattern:** `LobbyMember`, `LobbyBan`, and `LobbyMemberAccount` rows cannot be updated in place. All "updates" are `by_lobby_and_user.delete([...])` followed by `insert(updateWithAudit(...))`.

## Reducer Flows

Lobby-owned reducers live in `reducers/lobby/lobbyLifecycle.ts`, `lobbySettings.ts`, `lobbyPresets.ts`, `refereeManagement.ts`, `cursor.ts`, `lobbyGc.ts`, `accountSelection.ts`, `concede.ts` (concede / claim_forfeit / defer), `refereeTransfer.ts` (the A22a scheduled check), the lifecycle hooks in `index.ts`, and (tournament-linked) `tournamentLobby.ts`. Draft-stage transitions (`start_draft`, picks/bans) live in the draft feature, not here.

### create_lobby(config fields..., password, name?, banRestriction?, lineupFormat?, hideMmr?, refereeExclusiveConcede?, maxSpectators?, abandonCurrentMatch?)
1. `getAuthenticatedUser(ctx)` -- reject guests.
2. (S10n, A116: the `presetId` argument and its existence check are removed; the lobby form fills the arguments from the chosen preset.)
3. D-22 / A68(4): `ensureNotInLobby(ctx, userId, abandonCurrentMatch ?? false)` (see "Phase S8f execution" below). A68(8): `maxSpectators` (default 12) must be 0-12 ("maxSpectators must be between 0 and 12."); stored on the Lobby row.
4. Generate a server-side `joinCode` (`generateJoinCode`, 6 uppercase alnum, up to 10 retries; S10n, A114(2): there is no `joinCode` argument).
5. D-23: reject guest + `matchType=Ranked`; force `rosterVisibility=ClosedNoRating` for guests.
6. D-42: if `matchType=Ranked`, force `allowMirrorPicks=false`. Resolve `disconnectForfeitSeconds` (0 sentinel -> undefined).
7. Insert `Lobby` (`insertWithAudit`) with `stage=Waiting`, `currentPlayerCount=1`, `hostUserId`, `isTournamentControlled=false`, `lastActivityAt=now`, `lastJoinSeq=1` (A74(3)).
8. D-24 / D-27: insert host as `LobbyMember` with `lobbySlot=Spectator`, `isReferee=true`, `isConfirmed=false`, `isOnline=true`, `joinSeq=1` (R4, S4).
9. D-02: if `!isPublic` and password provided, insert `LobbyPassword` row (A99: an empty password on a private lobby is rejected first, see "Phase S10h execution").

Series settings and cost-set guards (Phase S6 execution; DECISIONS.md A27, A28, A38(2), A40, A45(2)/(5), D-A8; backlog #2, #6-#9), before the insert:
- The six new arguments are optional (an omitted key takes the default): `name` (trimmed, 0-50 chars, default '' — the lobby browser view labels an empty name in S9; no host name is stored, so anonymous lobbies leak nothing), `banRestriction` (NoRestriction), `lineupFormat` (Halves), `hideMmr` (false), `bestOfNAdvantage` (None), `refereeExclusiveConcede` (true, A45(5); it was hardcoded true before).
- `bestOf`: the D-11 sentinel maps 0 to 1, then `ensureBestOf` (helpers/tournament/seriesSettings.ts) rejects anything but 1 or 3 with "bestOf must be 1 or 3.". `bestOfNAdvantage` is forced to None when bestOf = 1 (`resolveAdvantage`). **Superseded (S8e, A67(2)):** `bestOf`, `refereeControlsShelving` and `bestOfNAdvantage` are no longer arguments or columns; `resolveAdvantage` is deleted.
- `lineupFormat`: both values are accepted. The A21 rule "8 characters → Halves, 12 → Thirds" has no other source in the schema today (every draft sequence fields 8 characters per team, `teamSize` is players), so the format itself is the character count; the 12-character draft is S7's.
  - Phase S7 execution (A21): the format drives the draft. Halves = 8 characters per team, Thirds = 12 (`charactersPerTeam` in `shared/scoring`): `initSessionForGame` builds the Classic sequence with `lobby.lineupFormat` and the Auction ends at 8 / 12 won per team; lineups (`arrange_lineup` / `confirm_lineup`) have 2 or 3 groups of 4, arranged and confirmed only by the team captain or a referee. Details: `docs/match-session/architecture.md` "Phase S7 execution".
  - Phase S7b execution (DECISIONS.md A59, A60): `confirm_lineup` was removed (no lineup confirmation; captains confirm the whole game with `confirm_game`, see `docs/match-results/architecture.md` "Game package"); lineups stay editable in Equipping and Scoring until the game closes. Classic Thirds uses the A59 orders (`docs/match-session/draft-order.md`).
- `ensureCostSetUsable(costSetId, gameMode, draftMode)` (helpers/draft/costSetGuards.ts): id 0 passes (Phase S10i execution, review F2 / A108(2): the selectability part only; set 0 must hold the coverage rows below like any other set); otherwise the set must exist, be published and not locked, and hold at least one `HsrCharacterCost` and one `HsrLightconeCost` row for the tuple (D-D6 loose coverage; synergies never reject). Error: "This cost set has no costs for {gameMode} × {draftMode}. Pick another set or ask its owner to extend it."

Abuse guards (Phase S5 execution; DECISIONS.md A42, A43; ACCESS-SECURITY-OPS B-7), after step 5 and before the insert, values read from `AbuseConfig` (id 1) at call time:
- A42(1) kill switch: a guest caller is rejected with "Guest lobby creation is temporarily disabled" while `guestLobbyCreationEnabled` is false. `join_lobby` has no such check, so guests already in lobbies are unaffected.
- A57 / A58 inline breaker (Phase S6 execution): right after the kill-switch check, a guest creation bumps `AbuseCounter['guest_lobby_create']` (`recordGuestLobbyCreation`); the creation that pushes the window count past `guestLobbyBurstThreshold` (default 50 in 10 minutes) succeeds and turns the switch off with one `AdminAlert` in the same transaction (docs/admin/architecture.md "Abuse controls").
- B-7 hourly cap (D-B5, guests included per A43): `consumeLobbyCreateAllowance` (`helpers/lobby/abuseControls.ts`) keeps a fixed one-hour window in `UserRateState` (`lobbyWindowStart`, `lobbyCreates`; row created on first use) and rejects once `lobbyCreatesPerHour` creates fell in the window. D-22 (one lobby at a time) is unchanged.

### join_lobby(lobbyId, joinCode, password, abandonCurrentMatch?)
1. `getAuthenticatedUser(ctx)`.
2. D-03: resolve lobby by `id` (if `lobbyId>0`) else by `joinCode`; throw "Lobby not found." if neither resolves.
3. **Reconnect / return path** (existing LobbyMember row; F1 / Phase S4 execution: evaluated BEFORE the one-lobby check, which counts the row being rejoined and used to reject every reconnect; `abandonCurrentMatch` is ignored here): require a reconnect stage (Waiting, Drafting, Equipping, Scoring, AwaitingResult; A67(1)); A68(4) reject an abandoned row ("You left this match for another lobby and cannot return."); D-39 recompute `disconnectPoolRemainingMs`; delete+reinsert member `isOnline=true`, clear `disconnectedAt` and `leftAt` (A68(2): the only path that clears `leftAt`); auto-resume the MatchSession timer if it was auto-paused (A85(1): only when the caller is a seated player and no seated player is still away, see "Phase S10c execution"); bump activity; a returning away player (the row had `leftAt`) gets the System chat line "{name} is back."; return (no count change).
4. **New-join path** only: D-22 / A68(4) `ensureNotInLobby(ctx, userId, abandonCurrentMatch ?? false)`; D-23 guest restrictions; D-21 `ensureNotBanned` (reject if a `LobbyBan` row exists).
5. D-04 / A68(8): require stage Waiting, Drafting, Equipping or Scoring (AwaitingResult: "Cannot join a lobby in stage: AwaitingResult"); D-02 verify password against `LobbyPassword` if `!isPublic`.
6. Cap enforcement: reject if total members >= 20 ("Lobby is full (max 20 members)."); a join that can only be watching is rejected when the lobby already has `maxSpectators` spectators ("Spectator slots are full (max N)." with N = `Lobby.maxSpectators`, A68(8)): every live-stage join, and a Waiting join of a tournament lobby that auto-seated to Spectator. A casual Waiting joiner lands on Spectator as a seat candidate (D-27) and is not counted against `maxSpectators` (Phase S8f fix pass: the setting caps watchers, not seat candidates; the 20-member cap still applies). Only new joins are tested: members already in the Spectator slot are unaffected by a later lower setting.
7. D-27: insert `LobbyMember` with `lobbySlot` = the A26 / A35 auto-seat in Waiting (casual lobbies: Spectator) and Spectator in a live stage, `isReferee=false`, `isConfirmed=false`, `leftAt` / `abandonedAt` unset, `joinSeq = nextJoinSeq(lobby)` = `Lobby.lastJoinSeq + 1` (R4; A74(3), S9c: a departed member's number is never handed out again).
8. D-04 / D-09 / D-26: auto-insert `LobbyMemberAccount` for the user's active HSR account (tournament path validates/snapshots against `TournamentPlayerAccount`; approved stand-ins snapshot all their accounts into TPA first).
9. Increment `currentPlayerCount`, bump `lastActivityAt`, write `lastJoinSeq = joinSeq` (A74(3); the same Lobby update, no second write), insert System `ChatMessage` "{name} joined the lobby."

### leave_lobby(lobbyId)
1. `getAuthenticatedUser(ctx)`; `ensureLobbyMember`; load lobby.
2. **A player in a live stage** (Drafting / Equipping / Scoring; A68(1)): the Leave is a disconnect. A row that is already away or abandoned is left as it is (no-op, so the clock keeps its first stamp). Otherwise `markMemberOffline(ctx, lobby, member, callerId, { leftAt: now })` (the body `client_disconnected` runs per membership): `isOnline=false`, `disconnectedAt=now` under Standard / Deferred (never NoAction), one `RefereeTransferCheck` 15 s out, plus `leftAt=now`. The row, its `LobbyMemberAccount` rows and `currentPlayerCount` are kept; no flag moves here (the 15 s check moves them if the player is still away, A68(7)); no automatic concede (A68(3)); System `ChatMessage` "{name} left the match."; bump `lastActivityAt`.
3. **Every other Leave** (a player in Waiting / AwaitingResult; a spectator or coach in any stage, A68(5)): `removeMemberRow` (below); an emptied Waiting lobby is hard-deleted (auto-close). System `ChatMessage` "{name} left the lobby." outside the live stages (a spectator's or coach's leave during the match stays silent, as before).

`removeMemberRow(ctx, lobbyId, userId, actorId)` (`helpers/lobby/memberRemoval.ts`, S8f fix pass 2; was private to lobbyLifecycle.ts) is the one row-removal path of `leave_lobby`, `kick_member`, `ban_member` and `performUserDeletion` (outside a player's live-stage row, below): `transferFlagsOnRemoval` (captain, referee, host, while the row still exists), delete the member's `LobbyMemberAccount` rows, delete the `LobbyMember` row, re-read the `Lobby` row (the host may have moved), then hard-delete an emptied Waiting lobby or decrement `currentPlayerCount` (floored at 0) and bump `lastActivityAt`.

### close_lobby(lobbyId)
1. `getAuthenticatedUser(ctx)`; load lobby.
2. D-21: `ensureHostOrAbove` (host or Moderator+).
3. D-20: `ensureStageIs(Waiting)` (A67(1): the unused terminal stage is gone).
4. D-19: `hardDeleteLobby` -- cascade delete (order): MatchResultParticipant -> MatchResultGame -> MatchResultRecord -> ChatMessage -> LobbyMemberAccount -> LobbyMember -> LobbyBan -> LobbyPassword -> MatchSessionStep -> MatchSession -> Lobby (LobbyCursorEvent auto-expires).

### kick_member(lobbyId, targetJoinSeq)
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureLobbyMember` (caller) and the permission check (step 2); then A74(1) `resolveSeat(ctx, lobbyId, targetJoinSeq)` ("No member sits at seat N of this lobby."), the target is its row. Guard order: lobby → caller checks → seat.
2. Permission `canKickOrBan`: host, Admin, Moderator, or referee with `refereeCanKick`.
3. Reject kicking self or host (on the resolved user id); the target is a member by construction.
4. A68(6): in Drafting / Equipping / Scoring a target in a player slot is rejected ("Players cannot be removed once the draft has started; the match ends by result, concede or forfeit."); spectators and coaches may be removed in every stage; in Waiting and AwaitingResult any member.
5. `removeMemberRow`: flags transferred (A68(7)), `LobbyMemberAccount` rows and the member row deleted, `currentPlayerCount` decremented.
6. Insert System `ChatMessage` "{name} was kicked from the lobby." (No LobbyBan.)

### ban_member(lobbyId, targetJoinSeq)
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureLobbyMember` (caller) and the permission check; then A74(1) `resolveSeat` (as kick). Guard order: lobby → caller checks → seat.
2. Permission `canKickOrBan` (same as kick); reject self or host.
3. A68(6): the kick stage rule. A74(2): the target always holds a row (present or away); a user without a row cannot be banned (no preventive ban).
4. Insert `LobbyBan` row (`bannedUserId`, `bannedByUserId=caller`, `bannedJoinSeq` = the target's seat).
5. `removeMemberRow` (as kick).
6. Insert System `ChatMessage` "{name} was banned from the lobby." (Phase S6 execution: `unban_member` lifts a ban, below.)

### unban_member(lobbyId, bannedJoinSeq) (Phase S6 execution, A45(3); A74(2))
1. `getAuthenticatedUser(ctx)`; load lobby (any stage).
2. Permission: the host, Moderator+ (membership not required), or a member who is referee while `refereeCanKick` is on; else "Only the host, moderators, admins, or an authorized referee can lift a lobby ban."
3. Find the ban through `LobbyBan.lobby_id` by `bannedJoinSeq`; reject when none ("No ban is recorded for seat N of this lobby."); delete `(lobbyId, ban.bannedUserId)` (`by_lobby_and_user`). No chat message, no Lobby write (bans are private, so nothing else changes on the wire).

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
- Phase S8f execution (A68(8)): optional `maxSpectators` (0-12, omitted = unchanged; "maxSpectators must be between 0 and 12."), a free-set field, editable in tournament lobbies too. A lower value never evicts a member already in the Spectator slot; it caps later joins.

### set_team_slot(lobbyId, targetJoinSeq?, lobbySlot)
1. `getAuthenticatedUser(ctx)`; load lobby; when `targetJoinSeq` is given and the caller holds no `LobbyMember` row here, `ensureHostOrAbove` first (a non-member can only be moving someone else); then A74(1) `targetJoinSeq` omitted = the caller (self-move), else `resolveSeat` (a seat that resolves to the caller is the self-move too); D-28 `ensureStageIs(Waiting)`. Guard order: lobby → caller checks → seat.
2. Permission: moving someone else requires `ensureHostOrAbove`; self-move requires membership. `ensureLobbyMember` (target).
3. Coach guard: assigning a coach slot to a non-coach requires host or referee.
4. Cap enforcement (when team/coach status changes): 1 coach per team, `teamSize` players per team, `Lobby.maxSpectators` spectators ("Spectator slots are full (max N).", A68(8); was a hard 12) for a tournament lobby only: a casual Waiting lobby's Spectator slot holds seat candidates and is not capped (Phase S8f fix pass, the same rule as `join_lobby`).
5. Delete+reinsert target `LobbyMember` with new `lobbySlot` and `isConfirmed=false`; bump activity.

### confirm_ready(lobbyId) / unconfirm_ready(lobbyId)
1. `getAuthenticatedUser(ctx)`; load lobby; D-28 `ensureStageIs(Waiting)`; `ensureLobbyMember`.
2. Delete+reinsert caller `LobbyMember` with `isConfirmed=true` (confirm) or `false` (unconfirm).
3. Phase S10r execution (A122(4)): each call counts on the caller's membership allowance (`consumeMembershipAllowance`) before the write.

### set_captain(lobbyId, targetJoinSeq)
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureLobbyMember` (caller) and the permission check; then A74(1) `resolveSeat`. Guard order: lobby → caller checks → seat.
2. D-30 permission: host OR (referee AND `refereeCanSetCaptain`) OR Admin+.
3. `ensureLobbyMember` (target); reject if target is Spectator or Coach.
4. Demote existing captain(s) on target's team; promote target (`isCaptain=true`) via delete+reinsert.

### create_lobby_preset / update_lobby_preset / delete_lobby_preset(presetId, ...)
1. `getAuthenticatedUser(ctx)`.
2. D-31b permission: `create` requires TournamentHost+ (TO/Mod/Admin). `update`/`delete` use `ensureCanMutatePreset` -- system presets are Admin-only; non-system editable by Admin, the owner, or a Moderator whose target's creator is a Moderator or a TournamentHost (Phase S10r execution, A122(5): an Admin's preset needs an Admin).
3. Validate `name` length 1-50; resolve `disconnectForfeitSeconds` (0 -> undefined).
4. `create`: insert `LobbyPreset` (`isSystemPreset=false`, `creatorUserId=user.id`). `update`: `updateWithAudit` all config fields. `delete`: delete row.
5. B-7 (Phase S5 execution): `create` counts the caller's presets on `creator_user_id` and rejects at `AbuseConfig.maxPresetsPerUser` (D-B5: 10). Guests never reach this check (TournamentHost+ guard, A43).
6. Phase S6 execution (backlog #6, #2; A28, A45(2)) — the three series arguments are removed in S8e (A67(2)): optional arguments `bestOf`, `refereeControlsShelving`, `bestOfNAdvantage`, `lineupFormat`, `banRestriction`, `hideMmr` (create: defaults 1 / true / None / Halves / NoRestriction / false; update: omitted keeps the stored value). `ensureBestOf` and the None-for-Bo1 rule as in `create_lobby`. Cost set: `create` runs `ensureCostSetUsable`; `update` runs it when `costSetId` changes, else `ensureCostSetCovers` when gameMode / draftMode change.
7. Phase S6 execution (A33a): `delete_lobby_preset` rejects the system preset for everyone, Admins included ("The system lobby preset cannot be deleted."); `update_lobby_preset` on it stays Admin-only (`ensureCanMutatePreset`).
8. Phase S8f execution (A68(8)): optional `maxSpectators` (create: default 12; update: omitted keeps the stored value), validated 0-12 ("maxSpectators must be between 0 and 12."). The system preset carries 12.

### System lobby preset (helpers/lobby/systemPreset.ts; Phase S6 execution, A33a / CH-S4)
`seedSystemLobbyPreset(ctx)` runs in `init` (and after `server_nuke_test_data` clears `LobbyPreset`), idempotent: one row with `isSystemPreset = true`, `creatorUserId = SYSTEM_USER_ID (0)` (so it never counts against a user's preset cap), name "Tournament default". Free-set values = the constants `create_tournament_lobby` hardcodes (reducers/tournament/tournamentLobby.ts): Classic, ban mode Four, NoRestriction, turn 60 s, reserve 120 s, handicaps 0, character / light-cone budget 0, minimum raise 20, autoRandomPick false, referee may undo / pause / set captain, not kick, player pause on, exclusive concede on, referee controls shelving on, hideMmr false. Integrity-set columns are placeholders the tournament overrides in a tournament lobby: teamSize 1, MemoryOfChaos, Casual, public, not anonymous, OpenRoster, no ownership, cost set 0, Standard disconnect, no forfeit timer, no mirror picks, Halves, bestOf 1, advantage None. `create_tournament` points `Tournament.lobbyPresetId` at it; S8's `create_tournament_lobby` copies the free set from the pointed preset.

### shuffle_teams(lobbyId, mode: ShuffleMode) (lobbySettings.ts; Phase S6 execution, A45(3))
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureHostOrAbove`; `ensureStageIs(Waiting)`.
2. `TeamSwap`: every BluePlayer/BlueCoach becomes RedPlayer/RedCoach and vice versa; captain flags stay (each captain stays with their team).
3. `RandomSwap`: the non-coach Blue + Red players (ordered by `joinSeq`) are shuffled with `fairShuffle` (A120, Phase S10p: keyed by the transaction time, `SHUFFLE_DOMAIN.RandomSwap` and the lobby id; was `ctx.random.shuffle`) and dealt Blue, Red, Blue, ...; coaches and spectators stay; captain flags are cleared (`start_draft` assigns them, D-30).
4. One pass over the members: new slot, `isConfirmed=false`, cleared captain flag (delete + reinsert only for rows that change); bump `lastActivityAt`.

### transfer_referee(lobbyId, targetJoinSeq) / reclaim_referee(lobbyId)
- `transfer_referee`: caller must be a member and currently referee (`isReferee=true`); then A74(1) `resolveSeat` (this reducer has no Lobby lookup, so the seat is resolved after the caller checks; guard order: caller checks → seat); the resolved row is the target; reject self-target ("You are already the referee."); delete+reinsert caller `isReferee=false` and target `isReferee=true`. No stage gate.
- `reclaim_referee`: A68(7): when no member holds the flag, any member who calls takes it (non-members: "You are not a member of this lobby."). Otherwise the caller must be the lobby host (or seated `results` staff in a tournament lobby, D.8.4); no-op if the caller already holds it; delete+reinsert referee `isReferee=false` and caller `isReferee=true`.
- There is no `assign_referee`/`remove_referee` reducer -- the host starts as referee (D-24) and the flag moves via transfer/reclaim/the A68(7) transfers.

### broadcast_cursor(lobbyId, x, y)
1. Map `ctx.sender` -> `UserIdentity`; silently return if unregistered. Look up caller's `LobbyMember`; silently return if not a member, or (A98) if the row is away or abandoned.
2. D-34: silently return if caller's slot is Spectator (coaches hold Blue/Red slots, so they still broadcast).
3. Insert `LobbyCursorEvent` (event table): `senderJoinSeq = member.joinSeq` (A96, every lobby), plus x/y/timestamp. No SenderErrors -- all failure modes are silent returns.

B-4 (Phase S5 execution; ACCESS-SECURITY-OPS §B.5, D-B5), between steps 2 and 3:
- Bounds: silently return unless `0 <= x <= 1` and `0 <= y <= 1` (NaN fails the test too).
- Throttle: silently return when `now - LobbyMember.lastCursorAt < AbuseConfig.cursorMinIntervalMs` (default 50 ms = 20 Hz).
- Stamp: delete + reinsert the member row with `lastCursorAt = now` and the audit columns untouched (not a user edit). The event insert carries no audit columns (A19).

### run_lobby_gc / admin_gc_lobbies / seed_lobby_gc_job
- `run_lobby_gc` (scheduled): `performLobbyGc` scans all lobbies -- D-48 skip AwaitingResult; every other stage (Waiting, Drafting, Equipping, Scoring) is skipped while any member is online (D-47, extended to Waiting by A68(9); an away or abandoned row counts as offline), else hard-deleted after 30 min idle on `lastActivityAt` (A67(1), S8e: the D-16 72 h rule and the D-17 between-games rule are gone with their stages). D-14 writes a `GcResult` audit row if anything was deleted. Requeues itself +15 min.
- `admin_gc_lobbies`: Moderator+ manual one-shot; same sweep, no self-requeue.
- `seed_lobby_gc_job`: server-identity-only (called from `scripts/stdb/bootstrap.ts`); idempotent; inserts the first `LobbyGcJob` row to bootstrap the chain.

### select_match_account(lobbyId, hsrAccountId) / deselect_match_account(lobbyId, hsrAccountId)
1. `getAuthenticatedUser(ctx)`; load lobby; `ensureLobbyMember`. D-06: stage must be Waiting (A67(1); "Account selection is only allowed during the Waiting stage." / "Account deselection …"). A69(3) (S8e fix pass 2): the D-B-03 snapshot ratchet is gone; the snapshot is taken once at `start_draft` (A66) and selection changes nothing after it (selection is Waiting-only, before any `MatchResultParticipant` exists).
2. `select`: reject Spectator/Coach; validate the `HsrAccount` belongs to caller. Tournament path (D-04) is additive up to `Tournament.maxAccountsPerPlayer` and requires the account be locked in `TournamentPlayerAccount`; non-tournament path (D-07) replaces (max 1). ~~D-B-03: bumps `accountRatingSnapshot` if a MatchResult already exists. Phase S6 execution (backlog #10): the bump is `max(snapshot, computeLobbyMemberRating(...))`, the merged rating of the member's current selection (one account: its stored rating), instead of the newly selected account's own rating.~~ (removed, A69(3); see step 1).
3. `deselect`: find and delete the matching `LobbyMemberAccount` row (throw if not selected). No snapshot hook.

### create_tournament_lobby(bracketMatchId, abandonCurrentMatch?) / approve_stand_in(bracketMatchId, userId)
- `create_tournament_lobby`: resolve BracketMatch + Tournament; D-64 authorize (Moderator+, organizer, `TournamentAssistant`, or a team member of `team1Id`/`team2Id`); D-45 reject a duplicate non-Finished lobby for the match; D-22 / A68(4) `ensureNotInLobby(ctx, userId, abandonCurrentMatch ?? false)`; `maxSpectators` copied from the preset's free set (A68(8)); D-67 `matchType` from `countTowardsMmr`; insert `Lobby` with `isTournamentControlled=true` inheriting tournament fields + hardcoded tournament defaults; D-24/D-27 insert creator as `Spectator` + `isReferee=true`, `joinSeq=1` (R4, S4); `Lobby.lastJoinSeq=1` (A74(3), S9c).
- `approve_stand_in`: resolve BracketMatch + Tournament; D-68 authorize (Moderator+, organizer, or assistant); validate target user; reject duplicate; insert `TournamentStandIn` (PK `[bracketMatchId, userId]`, `approvedByUserId=caller`). There is no `remove_stand_in` reducer.

### claim_forfeit(lobbyId, forfeitingTeamSide) (concede.ts; F7, Phase S4 execution)
1. `getAuthenticatedUser(ctx)`; `ensureLobbyMember`; load lobby; stage must be Drafting / Equipping / Scoring (A67(1)).
2. D-81: with `refereeExclusiveConcede` and a third-party (Spectator) referee present, only that referee may call; otherwise spectators and coaches are rejected. D-15: `disconnectPolicy` must be Standard.
3. F7: `forfeitingTeamSide` 0 = the team opposing the caller's slot (rejected for the exclusive referee, who has no team: "Referee must specify forfeitingTeamSide: 1=Blue, 2=Red."), 1 = Blue, 2 = Red; any other value is rejected.
4. D-16: `isForfeitEligible(targetTeam)` stays the gate (every non-coach player of that team offline with `disconnectedAt` set and pool depleted or `disconnectForfeitSeconds` elapsed; A68(3): away and abandoned rows count as offline players, with the stamp of their Leave; a team with no player rows is never eligible); then `performConcede` (trigger RefereeDecision for a referee, Disconnect otherwise). `concede_match` is unchanged; `defer_match`'s summary lists away / abandoned players with the other offline players (A68(3)). No reducer concedes automatically (A68(3)): `performConcede`'s callers are `concede_match`, `claim_forfeit` and `dq_participant`'s whole-team settlement.

### client_connected / client_disconnected (index.ts; lobby side, Phase S4 execution)
- `client_connected`: after the presence upsert (`docs/auth/architecture.md`), for every `LobbyMember` of the user **without `leftAt` / `abandonedAt`** (A68(2): an away row stays offline and keeps its pending check; the user may be browsing the site): delete pending `RefereeTransferCheck` rows (`by_lobby_and_user`); if the row is offline, delete+reinsert with `isOnline=true`, `disconnectedAt` cleared and `disconnectPoolRemainingMs` decremented by the offline time (`handleDisconnectPoolUpdate`, D-10/D-11). Idempotent (F1). `join_lobby`'s reconnect branch does the same explicitly, clears `leftAt` and additionally auto-resumes an auto-paused draft.
- `client_disconnected`: marks the identity's presence row offline; if the user still has another live `UserPresence` row, stops (A48). Otherwise for every membership without `leftAt` / `abandonedAt` (those are already offline): `markMemberOffline` (helpers/lobby/disconnectHelpers.ts): `isOnline=false`; in an active stage (Drafting, Equipping, Scoring; A67(1) `ACTIVE_STAGES`) one `RefereeTransferCheck { lobbyId, userId, scheduledAt: now + 15 s }` (a stale pending row for the pair is replaced); `disconnectedAt=now` in every live stage (Drafting, Equipping, Scoring: the D-08 forfeit clock; never under NoAction). No flag transfer, no pause (A22a, F5).

### run_referee_transfer_check(arg: RefereeTransferCheck) (refereeTransfer.ts; scheduled, A22a)
1. Re-read `Lobby` and the `LobbyMember`; no-op if either is gone (the scheduler consumed the row).
2. "Still offline" = the row has `leftAt` / `abandonedAt` (A68(2): regardless of presence), or `LobbyMember.isOnline=false` and no live `UserPresence` row of the user (A48).
3. `decideRefereeTransfer` (`shared/lobby-rules`): `transfer` only if still offline, still `isReferee` and the stage is active; `moveRefereeFlag` writes the two rows with the SYSTEM_USER_ID audit actor.
4. Still offline and active stage: `transferCaptain` (online teammate first, then any teammate), then `transferHost` (online candidates only, `onlineOnly`) on the re-read lobby; both in the A22(5) order.
5. Drafting only: `decideAutoPause` -> insert the auto-Pause step (`actorUserId=0`, `isAutoPause=true`, `timeRemainingMs` as in `pause_draft`, `sequence = getNextSequence` per F9) and set `timerState.isPaused=true`. Phase S10f execution (F10): the timer write is `pausedTimerState` (`helpers/draft/turnClock.ts`), the same freeze as `pause_draft` (`turnStartAt = now`, `accumulatedPauseMs` = the remaining time); auto-pauses are not subject to the manual pause throttle.

### Flag-transfer priority (flagTransferHelpers.ts, shared/lobby-rules/refereeTransfer.ts)
One order for every flag (A22(5), A68(7); D-35's lowest-user-id rule is retired): **host → Blue players → Red players → spectators → Blue coach → Red coach**, each tier by `joinSeq` (`pickSuccessor` in the pure core). The leaver and rows with `leftAt` / `abandonedAt` are never candidates. The captain's candidates are the players of the leaver's team. Flags never return automatically to the original holder.

**Row removals** (A68(7): leave in Waiting / AwaitingResult, a spectator's or coach's leave in any stage, kick, ban, user deletion) run `transferFlagsOnRemoval(ctx, lobbyId, leavingUserId)` = `transferCaptain`, `transferReferee`, `transferHost`: **online candidates first, then any remaining member**, so a lobby with members always has a host and a referee. With no other member the flag stays (an empty Waiting lobby is deleted). **User deletion** (`performUserDeletion`, S8f fix pass 2, A68(6)(7)): per membership of the deleted user, a row in Waiting / AwaitingResult, a spectator or coach row in any stage, or a row whose lobby is gone goes through `removeMemberRow` exactly as a leave (flags, `LobbyMemberAccount` rows, row, `currentPlayerCount`, emptied Waiting lobby hard-deleted). A player row in Drafting / Equipping / Scoring (only an admin deletion reaches it; `delete_my_account` refuses an away or live membership) is kept (A68(6)): `transferFlagsOnRemoval`, then the row becomes away and abandoned (`isOnline = false`, `leftAt` and `abandonedAt` = now unless already set, `disconnectedAt` = now under Standard / Deferred unless already set), so it counts as an offline player for the forfeit test (A68(3)) and is never a flag candidate again (`hasLeft`). No `RefereeTransferCheck` is scheduled (the flags have already moved). The pure predicates `memberHasLeft` and `slotTeam` live in `helpers/lobby/memberPredicates.ts` (no imports; re-exported by `lobbyHelpers.ts`) so `flagTransferHelpers.ts` no longer imports `lobbyHelpers.ts` (the module's one import cycle, removed).

**Disconnects and live-stage Leaves** (Phase S4 execution; A22(5), A22a, F5, A68(1)) move nothing at once. `run_referee_transfer_check` fires 15 s later and, only if the member is still offline (away rows always are):
- **Referee** -> `pickRefereeSuccessor`: the first **online** candidate in the order above; no candidate = the flag stays.
- **Host** -> `transferHost(..., { onlineOnly: true })`: the first online candidate, else the flag stays.
- **Captain** -> `transferCaptain`: an online teammate first, then any teammate (as before, the captain always moves to a teammate when one exists).
- **Auto-pause** -> only an offline team player (never a spectator, coach or spectator-referee), only in Drafting, only under Standard/Deferred, only when not already paused. A leaver counts as offline (A68(1)).
- `reclaim_referee` fills an unheld referee flag with the calling member (A68(7)).

## Phase S8d execution (DECISIONS.md A26, A34, A35; ACCESS-SECURITY-OPS §D.8.4, §D.8.5)

- **Seat enforcement (A35, D.8.5).** `set_team_slot` calls `ensureSeatAllowed(ctx, lobby, targetUserId, slot)`
  (`helpers/tournament/tournamentLobbySides.ts`, over `allowedSlotsFor`): in a tournament lobby a slot outside the target's
  allowed set is rejected, "This seat is not available to you in this tournament lobby."; casual lobbies allow every
  slot. `shuffle_teams` rejects tournament lobbies: "Seats in a tournament lobby follow the bracket (A35); shuffling
  is not available." (a shuffle would seat team1 on Red while the hand-off credits Blue = team1).
  _Superseded in Phase S8g execution (DECISIONS.md A70)._
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
- **Tournament lobby (A67(5)).** `create_tournament_lobby(bracketMatchId)` (the `joinCode` argument removed in S10n, A114(2)): caller rule (A34) and D-22
  unchanged; the match must be Ready; D-45 rejects while any lobby of the match is not settled (its record not
  Validated) with "A lobby for this bracket match is still in play."; a parked lobby with a Validated record does not
  block; the cap rejects when the Validated records of the match reach `BracketMatch.bestOf`: "This bracket match has
  no games left (best of N).". The lobby copies no `bestOf` / head start. Details: `docs/tournament/architecture.md`.
- `hardDeleteLobby(ctx, lobbyId, keepResultRecord = false)`: with `keepResultRecord` the record row survives (the
  caller marked it Voided, A24(3)); its children are deleted as usual.


## Phase S8g execution (DECISIONS.md A70)

- **Seat enforcement by the match's colours (A35, A70(1)).** `allowedSlotsFor` feeds the shared core the team that
  plays Blue in the bracket match (`matchSides(match)`: `BracketMatch.blueTeamId`, default team1) as its `team1*`
  inputs and the Red team as `team2*`; the rule itself is unchanged (a team's players and approved stand-ins on its
  colour, everyone else Spectator). Auto-seat follows. The colours are set per match with `set_match_sides` before
  the first lobby: [../brackets/architecture.md](../brackets/architecture.md) "Phase S8g execution".
- **Shuffle guard.** `shuffle_teams` still rejects tournament lobbies, now with "Seats in a tournament lobby follow
  the bracket's sides (A35 / A70); shuffling is not available." (a shuffle would break the match's colour mapping).
  _The S8d sentence above ("follow the bracket (A35)", "seat team1 on Red while the hand-off credits Blue = team1") is superseded in Phase S8g execution (DECISIONS.md A70)._

## Phase S8f execution (DECISIONS.md A68)

Membership lifecycle after A68 (details in the reducer flows above):

| Situation | Waiting | Drafting / Equipping / Scoring | AwaitingResult |
|---|---|---|---|
| Player presses Leave | row + LMA deleted, flags transferred (A68(7)) | **disconnect**: row kept offline, `leftAt` set, clock + 15 s check (A68(1)(2)) | row + LMA deleted, flags transferred |
| Spectator / coach presses Leave | row deleted, flags transferred | row deleted, flags transferred (A68(5)) | row deleted, flags transferred |
| Player closes the tab | offline | offline, clock + 15 s check (A22a) | offline |
| Return | reconnect | reconnect; an away row returns through `join_lobby` ("… is back."); an abandoned row never | reconnect |
| Kick / ban | any member but the host | spectators and coaches only (A68(6)) | any member but the host |
| New join | auto-seat (A26 / A35); tournament Spectator capped by `maxSpectators`, casual seat candidates not | Spectator only, capped by `maxSpectators` (A68(8)) | closed |
| GC | everyone offline + 30 min idle (A68(9)) | everyone offline + 30 min idle | never |

- **Away and abandoned (A68(2)(4)).** `leftAt` marks a player who pressed Leave in a live stage: offline whatever the presence rows say (`memberHasLeft`), skipped by `client_connected` / `client_disconnected`, never a flag candidate, an offline player for the forfeit test (`isForfeitEligible`, `defer_match`'s summary, `claim_forfeit`'s summary), still counted in `currentPlayerCount`. `abandonedAt` is added when that player takes another lobby with `abandonCurrentMatch`; the row stays an offline player of its team and keeps every stamp, but no longer counts for D-22, cannot return and drops out of `view_my_lobbies`.
- **One lobby at a time (D-22, A68(4)(5)).** `membershipHold` (helpers/lobby/lobbyHelpers.ts) classifies each membership: `free` (lobby gone or AwaitingResult, or the row abandoned), `away` (a `leftAt` row in a live stage) or `held` (anything else, spectator and coach rows included). `ensureNotInLobby(ctx, userId, abandonCurrentMatch)`: a `held` row rejects with "You are already in a lobby. Leave it before creating or joining another."; an `away` row rejects without the flag with "You left lobby {joinCode} mid-match. Joining here means you cannot return to it." and, with it, gets `abandonedAt = now` (`leftAt`, `isOnline = false`, `disconnectedAt` kept) before the caller proceeds; just before that write `transferFlagsOnRemoval` moves any host / captain / referee flag the 15 s check left on the away row (no online candidate then) in the A22(5) order, online first then any (A68(4)(7); under NoAction this is the only path that frees a stuck host or referee). `delete_my_account` rejects on any non-`free` row ("Leave your lobby before deleting your account.").
- **No automatic forfeit (A68(3)).** The D-31 auto-concede and its D-82 branch are removed from `leave_lobby`; `ConcedeTrigger.VoluntaryLeave` stays in the enum (a player's own `concede_match` still writes it; history rows reference it).
- **DQ (A68(6)).** `dq_participant` no longer removes a DQ'd player from a live lobby; the whole-team settlement is unchanged ([../tournament/architecture.md](../tournament/architecture.md)).
- **Views.** `view_my_lobbies` skips abandoned rows (A68(10)); the presence state of `view_my_lobby_members` is S9's.

## Phase S9a execution (DECISIONS.md A37, A40, A44(1), A48, A68(10))

- **`LobbyPreset` is private**; `view_lobby_presets` (per-sender) returns the system preset (`creatorUserId = SYSTEM`,
  `isSystemPreset`) plus the caller's own presets, every column but the audit ones (index `creator_user_id`).
- **`view_lobby_browser`** (anonymous shared) lists the live-stage lobbies, public and private, with no user id: an
  empty `name` reads "Lobby <joinCode>" (public) or "Private lobby" (private), `joinCode` only on public lobbies (F17),
  `hostLabel` = the host's display name or "Anonymous host" (D-A4), coach / spectator counts and `maxSpectators`.
- **`view_my_lobby_members`** row: `memberKey` (PK, lobbyId << 32 | joinSeq), `lobbyId`, `joinSeq`, `userId` (0 when
  anonymized), `label`, `lobbySlot`, `presence` (`MemberPresence`: Gone if `abandonedAt`, Away if `leftAt`, else Online
  when the row or any `UserPresence` row of the user is live, A48, else Offline), `isHost`, `isReferee`, `isCaptain`,
  `isConfirmed`, `avatarCharacterName?` / `displayedAchievementId?` (identified seats), `mmrByMode?` (identified, not
  `hideMmr`), `accountRating?` (`computeLobbyMemberRating`, merged) / `accountCount?` (A40 roster visibility),
  `disconnectActionAt?` (A92(9), set when the row is offline, away or abandoned by `isMemberRowAway`). No throttle
  stamps, no audit columns.
- **`view_my_lobby`** returns the full `Lobby` row (host and audit ids masked per A37); **`view_my_lobbies`** is the
  layer-0 row `{ id, joinCode, name, stage, isAway }`; **`view_my_lobby_bans`** lists the bans of lobbies the caller
  hosts or referees. Catalogue: [../views/architecture.md](../views/architecture.md).

## Phase S9a execution, fix pass (DECISIONS.md A37)

- `shouldAnonymize` (`helpers/identity/anonymousHelpers.ts`): the target's seat kind picks the toggle, a spectator target `isAnonymousSpectators`, a player or coach target `isAnonymousPlayers` (spectator callers included); exemptions unchanged (self, teammates, spectator referee).
- `view_lobby_browser`: `hostLabel = "Anonymous host"` when the host's own seat kind is anonymous (one `LobbyMember.by_lobby_and_user` lookup; no member row: either flag).
- Member-event System chat (`join_lobby`, `leave_lobby`, `kick_member`, `ban_member`) through `postMemberEventChat` (`helpers/lobby/memberEventChat.ts`), rendered per reader by `view_my_lobby_chat`; see [chat architecture](../chat/architecture.md) "System messages".
- `view_my_lobby_bans`: `bannedUserId = 0` and label "Banned player" when `hideUserId` holds for the banned user (a banned user holds no member row while banned, so there is no seat label to show). Resolved in S9c (A74(2)): the row carries `bannedJoinSeq` (unique with `lobbyId`), which identifies the ban to the client and to `unban_member`.

## Phase S9c execution (DECISIONS.md A74)

- Seat targeting: the six reducers' arguments and `resolveSeat` (the "Seats" paragraph at the top and each reducer above). Guard order: lobby → the caller's membership and permission checks → seat, so a stranger never learns which seats are occupied (`transfer_referee` has no Lobby lookup: caller checks → seat; `set_team_slot` with a seat and a non-member caller runs `ensureHostOrAbove` before the seat).
- `Lobby.lastJoinSeq` (written 1 by `create_lobby` and `create_tournament_lobby`, bumped by `join_lobby` in the Lobby update it already makes) replaces the `max(joinSeq) + 1` scan. `view_my_lobby` and `view_my_tournament_lobbies` spread the Lobby columns and carry `lastJoinSeq` too.
- `LobbyBan.bannedJoinSeq` (written by `ban_member`); `view_my_lobby_bans` and `view_admin_lobby_bans` carry it.
- `view_my_lobby_members`: the no-op `Math.round` on `accountRating` removed (the helper returns an integer, A40 exact).

## Phase S10c execution (DECISIONS.md A85)

- **`join_lobby` auto-resume (A85(1)).** The reconnect branch lifts an auto-pause (Drafting, paused, latest Pause step
  `isAutoPause`) only when the caller's row is a seated player (`isSeatedPlayer`, `helpers/lobby/lobbyHelpers.ts`: a
  Blue / Red player seat, not a coach, not a spectator) and, after the caller's own row is written back online,
  `anySeatedPlayerAway(ctx, lobbyId)` is false: no seated player of either team is away / abandoned
  (`memberHasLeft`) or offline (`isOnline` false and no live `UserPresence` row), the same "still offline" test as
  `run_referee_transfer_check`. Otherwise the draft stays paused; the rest of the reconnect branch is unchanged.
- **Other paths.** `client_connected` restores memberships and cancels pending checks but never resumes a draft
  (unchanged, consistent with A85(1)); the only other path that lifts a pause is `resume_draft` (A85(2), see
  [../match-session/architecture.md](../match-session/architecture.md)). The disconnect pool, forfeit grace and
  `claim_forfeit` are unchanged (A85(3)).
  _The "`client_connected` ... never resumes a draft" sentence is superseded in Phase S10d execution (DECISIONS.md A92(7))._

## Phase S10d execution (DECISIONS.md A91, A92)

- **Policy and grace rules (A91(2), A92(2)(3); `helpers/lobby/disconnectHelpers.ts`).**
  `ensureNotDeferredOutsideTournament(tag)`: "The Deferred disconnect policy is only available for tournaments and
  their lobbies." in `create_lobby`, `update_lobby_settings` on a lobby that is not tournament-controlled (the locked
  branch ignores the argument), `create_lobby_preset` and `update_lobby_preset` (system preset included).
  `ensureNoActionAllowed(tag, isRankedOrTournament)`: "The NoAction disconnect policy is only available for casual
  lobbies." in `create_lobby` (Ranked), `update_lobby_settings` (unlocked, the effective `matchType` Ranked),
  `create_tournament` / `update_tournament` (always; see [../tournament/architecture.md](../tournament/architecture.md)).
  Presets are not checked for NoAction (A92(3) names lobbies and tournaments). `ensureForfeitSecondsInRange(s)`:
  `disconnectForfeitSeconds` 0 / unset keeps the default 60, otherwise 30-600 ("disconnectForfeitSeconds must be
  between 30 and 600 (0 keeps the default of 60).") in the same six writers. `create_tournament_lobby` copies the
  tournament's values unchanged, so a tournament lobby may still be Deferred.
- **`start_draft` (A92(1)).** Rejects while `anySeatedPlayerAway` (a seated player offline, away or abandoned):
  "All Blue and Red players must be online before starting." (draft feature, `draftClassic.ts`).
- **Waiting flag check (A92(5)).** `markMemberOffline` also schedules the 15 s `RefereeTransferCheck` in Waiting when
  the member is the host or holds the referee flag (no `disconnectedAt`, no pause). `decideRefereeTransfer` accepts
  `FLAG_CHECK_STAGES` = Waiting + `ACTIVE_STAGES` (`shared/lobby-rules`); `run_referee_transfer_check` moves the
  referee (first online candidate, A22(5) order) and, in Waiting, the host (`onlineOnly`); the captain transfer and the
  auto-pause stay live-stage / Drafting rules. `client_connected` cancels the pending check as in the live stages.
  **Narrowed in S10e (A93(1)):** the host half is gone; see "Phase S10e execution" below.
- **Live pool (A92(6)).** `disconnectThresholdMicros(lobby, player)` = the earlier of `disconnectedAt + grace`
  (`disconnectForfeitSeconds ?? 60`) and `disconnectedAt + disconnectPoolRemainingMs`; `isPastDisconnectThreshold`
  (offline / away / abandoned, stamped, `now >=` threshold) is the per-player test of `isForfeitEligible` (every player
  of the team) and of `defer_match` (any seated player).
- **`defer_match` precondition (A91(1)).** Besides the existing guards, a caller other than the exclusive spectator
  referee needs one seated player of either team past the threshold: "Defer needs a seated player who has been
  disconnected past the forfeit grace or whose disconnect pool is spent." No automatic park (A91(3)); a parked
  lobby is cleared by hand (A91(4), no code).
- **Away callers (A92(4)).** `concede_match`, `claim_forfeit`, `defer_match`: after the spectator / coach guards
  (the exclusive spectator referee is never away, `isThirdPartyReferee` skips such rows) `ensureSeatPresent` rejects an
  abandoned row ("You left this match for another lobby and cannot act on it.") and an away row ("You are away from
  this match. Return to it first.").
- **One lift of an auto-pause (A92(7), G10).** `liftAutoPauseOnReturn(ctx, lobby, member, actorId)`
  (`disconnectHelpers.ts`) holds the A85(1) test and the clock write (`isPaused = false`, `turnStartAt = now`;
  `accumulatedPauseMs` untouched, F10 later). Callers: the `join_lobby` reconnect branch and `client_connected`
  (per restored membership, after the row is written back online). Phase S10f execution (F10): the clock write is
  `resumedTimerState` (`helpers/draft/turnClock.ts`), the same write as `resume_draft`; the auto-pause froze the
  remaining time in `accumulatedPauseMs`, so the turn resumes with the time it had (docs/match-session/architecture.md,
  "Phase S10f execution").
- **Manual pause (A92(8)).** No code: a comment at the auto-pause decision in `run_referee_transfer_check` records the
  accepted behaviour.
- **`view_my_lobby_members.disconnectActionAt` (A92(9)).** Optional timestamp, last column: for a seated player whose
  row is offline, away or abandoned (`isMemberRowAway`, the same row test `isPastDisconnectThreshold` applies for
  `claim_forfeit` / `defer_match`; not the `presence` column, which also reads `UserPresence` on other identities) in a
  live stage under Standard / Deferred, `disconnectThresholdMicros` (when the forfeit
  claim, Standard, or the defer, Deferred, becomes available on that seat); otherwise none. It names no user and
  derives from the seat's own stamp and the lobby settings, so anonymity is unchanged; it changes only on a
  disconnect or a return.

## Phase S10e execution (DECISIONS.md A93; lobby and identity / admin audit findings)

- **Waiting disconnect moves the referee flag only (A93(1)).** `markMemberOffline` schedules the 15 s
  `RefereeTransferCheck` in Waiting only when the row holds the referee flag; a host who is not the referee schedules
  nothing. `run_referee_transfer_check` still moves the referee flag in `FLAG_CHECK_STAGES` (Waiting + live), but the
  captain and host transfers run in `ACTIVE_STAGES` only, so the host role never moves on a disconnect in Waiting.
  Leave in Waiting still hands the host role on (`removeMemberRow`, A68(7)); no room is closed for an away host, GC's
  everyone-offline + 30 min rule is unchanged (A93(2)).
- **Offline host or referee at the start (A93(4), fix pass F2).** `start_draft` calls
  `scheduleChecksForOfflineStaff(ctx, lobby)` (`disconnectHelpers.ts`) as the lobby enters Drafting: every member row
  that is the host or holds the referee flag and is offline, away or abandoned gets one `RefereeTransferCheck` 15 s out,
  unless one is already pending for it (a referee who dropped in Waiting keeps that check). The check then moves the
  host role and the referee flag as for a disconnect after the start. Nothing is stamped or paused here.
- **`transfer_host(lobbyId, targetJoinSeq)` (A93(3), `refereeManagement.ts`).** Caller: the host, or Moderator+
  (no membership needed): "Only the host, moderators, or admins can hand over the host role." Then `resolveSeat`
  (A74). Target rules: "The member at seat N is already the host."; an away or abandoned row (`memberHasLeft`): "The
  member at seat N has left the match and cannot become the host." Any stage of an existing lobby. Writes
  `Lobby.hostUserId` (+ `lastActivityAt`), audit actor the caller; the referee flag does not move.
- **Captain flag follows the seat (audit #3).** `set_team_slot` clears `isCaptain` when the target changes team, moves
  between a player and a coach seat, or moves to Spectator; `start_draft` names a captain for a team without one (D-30).
- **Input caps (audit #5).** `teamBlueAlias` / `teamRedAlias` at most 30 characters in `create_lobby` and
  `update_lobby_settings` (`ensureTeamAliases`, `helpers/lobby/lobbyConfigBounds.ts`): "Team aliases must be at most
  30 characters." Chat metadata: see `docs/chat/architecture.md`.
- **Chat window and membership rate (audit #6).** Every member-event System line (`postMemberEventChat`) and the
  "Draft has started!" line trim the lobby to the D-13 window first (`trimChatForInsert`, `helpers/lobby/chatWindow.ts`,
  oldest first by `createdDate`). `consumeMembershipAllowance(ctx, userId)` (`abuseControls.ts`) counts a user's
  membership changes in a fixed 10 s window of `UserRateState` (`membershipWindowStart`, `membershipCount`), at most 20
  per window: a new join and a return (`isReturn`) through `join_lobby`, and every `set_team_slot` call (counted on the
  caller). A plain reconnect is not counted. Fix pass (review N8): `leave_lobby` is never counted nor rejected, in any
  branch, so a user at the cap can always leave; a join / leave loop is held by its joins. Rejection: "You are changing lobbies or seats too quickly. Please wait a
  moment." Constants `MEMBERSHIP_WINDOW_MS` / `MEMBERSHIP_CHANGES_PER_WINDOW`, not `AbuseConfig` columns.
- **`start_draft` texts and team size (audits #9, #10).** The account / character rejections name the seat ("The player
  at seat N has no account selected ..."), never a user id. A team with more players than `teamSize`: "{Blue|Red} team
  has N players; the team size is M."
- **Settings ranges (audit #10).** `ensureLobbyConfigInRange` (`lobbyConfigBounds.ts`) in `create_lobby`,
  `update_lobby_settings` (the values it stores; a tournament lobby's locked `teamSize` is the lobby's own),
  `create_lobby_preset`, `update_lobby_preset`: `teamSize` 1-3 ("teamSize must be 1, 2, or 3."), `standardTurnSeconds`
  10-600, `reserveBankSeconds` 0-1800 ("{name} must be between {min} and {max}."), `characterBudget` /
  `lightconeBudget` / `minimumBidRaise` finite 0-100000 ("{name} must be a number between 0 and 100000."), the four
  signed handicaps `rosterDiffAdvantage`, `underThresholdAdvantage`, `aboveThresholdPenalty`, `deathPenalty` (i32)
  -1000000 to 1000000 hundredths ("{name} must be between -1000000 and 1000000 (hundredths)."; fix pass N1: negative
  values accepted again, as before S10e), `rosterThreshold` (u32, a roster cost) 0-1000000 ("rosterThreshold must be
  between 0 and 1000000 (hundredths).").
- **Ranked with a guest seated (audit #24).** `update_lobby_settings` switching a lobby to Ranked rejects while any
  member row belongs to a guest: "A guest is in this lobby; guests cannot join Ranked lobbies."
- **Abandoned rows keep their accounts; the roster guards ignore them (audit #12, fix pass F3).** The account locks
  stay: an abandoned row (`ensureNotInLobby` with `abandonCurrentMatch`, or `performUserDeletion` for a live-stage
  player) keeps its `LobbyMemberAccount` rows, so the team's ownership pool (`teamOwnedEidolons`), the eidolon pricing
  (`resolveOwnedEidolon`, `teamDefaultEidolon`) and the timer auto-pick pool are unchanged mid-draft. The roster guards
  that say "Leave the lobby first" read `accountLobbyLocks(ctx, hsrAccountId)` (`lobbyHelpers.ts`): the account's
  `LobbyMemberAccount` rows minus those whose membership row has `abandonedAt` (an orphan row with no membership still
  locks). Readers: `set_active_hsr_account`, `delete_hsr_account`, `batch_upsert_characters`,
  `batch_remove_characters`, `migrate_roster` (both sides) in `reducers/roster/roster.ts`, and
  `admin_delete_hsr_account` (`rosterAdmin.ts`). An away row (`leftAt` only) still locks: the player may return.
  `releaseMemberAccounts(ctx, lobbyId, userId)` deletes a membership's rows and is called by `removeMemberRow` only.
- **Admin removal paths (identity audit #4).** `admin_delete_row('Lobby')` runs `hardDeleteLobby`;
  `admin_delete_row('LobbyMember')` runs `removeMemberRow`. Fix pass: a tournament lobby and a lobby whose record is
  Validated or processed are refused (F1); a seated player row is refused in Drafting / Equipping / Scoring /
  AwaitingResult (F4, A68(6)); a deleted last live identity takes the user's memberships offline through
  `markMemberOffline` (F5). Texts in `docs/admin/architecture.md`.
- **Dead code removed.** `join_lobby`'s reconnect-stage list (every stage is one), the `stage !== 'Waiting'` operand of
  `set_team_slot`'s spectator cap (the reducer is Waiting-only), the second `ensureLobbyMember` in `set_team_slot` /
  `set_captain`, the Admin line of `canKickOrBan`; `create_lobby` logs the generated join code.

## Phase S10h execution (DECISIONS.md A96, A97, A98, A99)

- **A98: away and abandoned members cannot act.** Helpers in `helpers/lobby/lobbyHelpers.ts`:
  `ensureMemberPresent(member)` (abandoned first, since an abandoned row keeps its `leftAt`),
  `ensurePresentMember(ctx, lobbyId, userId)` (`ensureLobbyMember` + presence) and
  `ensurePresentIfMember(ctx, lobbyId, userId)` (the caller's row, when they hold one, must be present; for reducers a
  non-member may call). Texts: away "You are away from this lobby. Return to it before acting." (`AWAY_MEMBER_TEXT`),
  abandoned "You left this match for another lobby and can no longer act in it." (`ABANDONED_MEMBER_TEXT`). An away
  member regains everything through `join_lobby`; an abandoned one never does. Moderator / Admin powers that do not
  depend on membership are unaffected: `ensureHostOrAbove` checks the host's row only when the caller is not
  Moderator+; `ensureRefereeOrAbove` checks the referee's row only when the caller is not Moderator+; the result staff
  set (`resultAuthority`: Moderator+, tournament organizer, results assistant) is not checked. Review F8 (fix pass):
  Moderator and Admin powers never depend on presence. `ensureMemberPresentUnlessStaff(ctx, lobbyId, user)` returns
  the caller's row (which must exist, "You are not a member of this lobby.", as before) and checks presence only when
  the caller is not Moderator+; `kick_member`, `ban_member` and `set_captain` use it, so a Moderator / Admin who holds
  an away or abandoned row keeps those powers (in `set_captain` the staff power is the Admin's, D-30).
  `set_team_slot` skips the caller's presence check for Moderator+ when a seat is given (`ensureHostOrAbove` admits
  them). The A85(2) `resume_draft` test no longer repeats the presence check (`ensurePresentMember` already ran).
  Guarded (caller): `select_match_account`, `deselect_match_account`; `send_chat_message`, `delete_chat_message`
  (host / referee path); `broadcast_cursor` (dropped silently, like every other cursor rejection: the stream is
  fire-and-forget at up to 20 Hz); `close_lobby`, `update_lobby_settings`, `shuffle_teams` (through
  `ensureHostOrAbove`); `kick_member`, `ban_member` (`ensureMemberPresentUnlessStaff`); `unban_member` (host / referee path);
  `set_team_slot` (the caller's row; a self-move by `ensurePresentMember`); `confirm_ready`, `unconfirm_ready`,
  `set_captain`; `transfer_referee`, `reclaim_referee` (both branches), `transfer_host` (host path); `start_draft`,
  `advance_stage` (through `ensureRefereeOrAbove`); `pick_character`, `ban_character`, `timer_expiry_classic`,
  `nominate_character`, `place_bid`, `pass_bid`, `timer_expiry_auction`, `undo_last_step`, `pause_draft`,
  `resume_draft`; `equip_lightcone`, `unequip_lightcone`, `arrange_lineup`, `set_eidolon`, `record_group_scores`
  (through `ensureCaptainOrReferee`; the A60(7) Admin path is unaffected); `set_score_adjustment`, `close_game`
  (through `resultAuthority`); `confirm_game`; `concede_match`, `claim_forfeit`, `defer_match` (the A92(4)
  `ensureSeatPresent` check and its texts, now run right after the membership check for every caller, a referee
  or coach row included).
  Not guarded, on purpose: `join_lobby`, `leave_lobby` (A98); `create_lobby`, `create_tournament_lobby` (no row
  in the lobby; `ensureNotInLobby` governs them); `dispute_match_result` (a right of the match participant on the
  submitted record, `MatchResultParticipant`, not a lobby membership power; it stays unguarded on purpose: a
  participant who left the lobby, or was moved out of it, keeps the right to contest a record that names them, and
  the reducer neither reads nor needs a `LobbyMember` row; this is a deviation from "every action reducer" for the
  user to confirm); `validate_match_result`, `approve_stand_in`, `revoke_stand_in`, `set_match_sides` (tournament
  staff, not membership); the preset reducers (no lobby); the scheduled and admin reducers
  (`run_referee_transfer_check`, `run_lobby_gc`, `admin_*`).
  `finalize_match_result` (review F9, corrected): it rejects tournament records and admits Moderator+ or the
  record's `refereeUserId` (the referee snapshot taken at the start of the draft). The referee path is a membership
  power: a caller who is not Moderator+ and holds an away or abandoned `LobbyMember` row in the record's lobby is
  rejected with the A98 texts (`ensurePresentIfMember`); a referee with no row left keeps the snapshot authority, as
  before; the staff path is unchanged. **Superseded by Phase S10r execution (A122(14)):** `refereeUserId` is no longer
  read and the snapshot fallback is gone; the caller must be Moderator+ or hold the referee flag on a present
  `LobbyMember` row of the record's lobby (no row: staff only). See [../match-results/architecture.md](../match-results/architecture.md) "Phase S10r execution".
  Targets (review F5): `transfer_referee` and `set_captain` reject an away or abandoned target with the
  `transfer_host` text shape: "The member at seat N has left the match and cannot become the referee." / "... cannot
  become a captain." (`memberHasLeft`, after the seat is resolved; `set_captain` after its spectator / coach checks);
  `transfer_host` keeps its A93(3) target rule ("... cannot become the host.").
  In Waiting a Leave deletes the row (A68(5)), so away and abandoned rows exist only from Drafting on; the Waiting-only
  reducers carry the guard for consistency.
- **A99: a private lobby needs a password.** `create_lobby` rejects `isPublic = false` with an empty `password`
  ("A private lobby needs a password.", `PRIVATE_LOBBY_PASSWORD_TEXT`), before any other check of the call.
  `update_lobby_settings` rejects `isPublic = false` with an empty `password` when the lobby has no `LobbyPassword`
  row. An empty `password` argument means "no new password": a lobby that already has a row keeps it (the upsert
  runs only for a non-empty argument, as before). A switch to public still deletes the row. Presets cannot produce
  a private lobby: `create_lobby` takes no preset (S10n, A116: the client fills the arguments, so the check above
  applies) and `create_tournament_lobby` always writes `isPublic = true`.
- **A96: cursor events carry the seat.** `LobbyCursorEvent` columns: `lobbyId`, `senderJoinSeq` (the sender's
  `LobbyMember.joinSeq`), `x`, `y`, `timestamp`; `senderUserId` and `anonymousLabel` are gone, in anonymous and
  identified lobbies alike. A member's client maps the seat to a name or seat label through `view_my_lobby_members`
  (`joinSeq`, `label`). The table stays `public: true`: the restriction to members is not implemented (below).
  Schema note (review F10): the cursor event drops two columns (fine for an event table, which holds no rows), and
  the three A95(2) `AbuseConfig` columns (`docs/admin/architecture.md`) sit before the audit columns with no column
  defaults; neither is an additive migration, so both ship with the S11 clear-publish.
- **A96: restricting the stream to members, what 2.14.1 offers.** Checked: the installed SDK
  (`node_modules/spacetimedb` 2.14.1), the `spacetimedb` skill and `docs/research/`. (1) Views: a view reads committed
  state, and an event table's rows are deleted in the transaction that wrote them, so a view over
  `LobbyCursorEvent` always sees nothing (skill `references/how-to-guides.md` "Event Tables": "views can't wrap event
  tables"). (2) Row-level security: `spacetimedb.clientVisibilityFilter.sql(sql)` exists in the SDK
  (`dist/server/schema.d.ts:289`, `dist/server/index.mjs:9147`; it pushes `rowLevelSecurity` entries into the module
  definition). Upstream, at the commit the skill pins (v2.14.1), the event tables page says row-level security
  applies to event tables with the same semantics as regular tables, but the RLS page labels the feature
  experimental and unstable ("the API may change or be removed") and to be used only where views cannot help; this
  repo's skill forbids it (`references/how-to-guides.md` "Row Level Security", `references/api-guide.md` §7). (3)
  Nothing else in the SDK filters an event table per client. So a mechanism exists but it is experimental and
  forbidden here, and no stable mechanism exists: the stream stays public and carries only the lobby id, the seat
  number and the position (x, y, timestamp). The route is the user's call (A96).
- **A97: anonymous labels from the seat.** `anonymousSeatLabel(member)` (`helpers/identity/anonymousLabels.ts`):
  `<kind> #<joinSeq>` with kind `Blue Player`, `Red Player`, `Blue Coach`, `Red Coach` or `Spectator`, for example
  "Spectator #7", "Blue Player #3", "Blue Coach #5". `computeAnonymousLabel(ctx, lobbyId, userId)` returns it for the
  user's row (no peer is read any more). The number never changes and is never reused, so the label survives
  departures; it changes only when the member changes seat kind in Waiting. Chat and view details:
  `docs/chat/architecture.md`, `docs/anonymous-play/architecture.md`.
  Review F6 / F7 (fix pass): a stored chat line keeps the label of the membership it was written under.
  `view_my_lobby_chat` (sender label) and the member-event rendering (`renderSystemChat`) prefer the label stored with
  the line and read the live seat label only when none was stored (`storedOrLiveLabel`,
  `helpers/identity/viewAnonymity.ts`); a member who left and rejoined holds a new seat, and their old lines keep the
  old label. `memberEventLabel` (`helpers/lobby/memberEventChat.ts`) stores the subject's seat label in every lobby,
  as `send_chat_message` does for Player messages, so a line written while the lobby was identified still has a
  label after it turns anonymous in Waiting. Cost: a Waiting seat-kind move shows "Spectator #3" on older lines and
  "Blue Player #3" on newer ones (the number ties them).

## Phase S10n execution (DECISIONS.md A114, A116)

- **A114(2): the creator sends no code.** `create_lobby` and `create_tournament_lobby` no longer take `joinCode` (it
  was accepted and ignored); the code is always `generateJoinCode`'s.
- **A114(1): two ways in, both kept.** `join_lobby(lobbyId, joinCode, password, abandonCurrentMatch?)` is unchanged: the
  lobby list passes the lobby id, a typed code passes the code; a private lobby checks the password on both paths.
- **A116: no preset number.** `create_lobby` no longer takes `presetId`, and its "Preset not found." check is gone. A
  preset is applied by the lobby form, which sends the final settings. `LobbyPreset`, `view_lobby_presets`, the preset
  reducers and `Tournament.lobbyPresetId` (A33a, read by `create_tournament_lobby`) are unchanged.
- Bindings: `create_lobby_reducer.ts` loses two fields, `create_tournament_lobby_reducer.ts` one.

## Phase S10p execution (DECISIONS.md A120)

- **RandomSwap.** `shuffle_teams` mode `RandomSwap` orders the non-coach Blue + Red players (`joinSeq` order, as
  before) with `fairShuffle(items, key)` (`shared/lobby-rules/timerDraw.ts`), the shuffle of all three A120 sites (this paragraph is the one reference; the brackets and tournament docs link here): a Fisher-Yates pass over a copy of the input, for i = n - 1 down to 1, `j = floor(murmur3Words([tsLo, tsHi, domain, id, i]) * (i + 1) / 2^32)`, swap i and j (`tsLo` / `tsHi` = the transaction timestamp in microseconds, both 32-bit words; `domain` = a `SHUFFLE_DOMAIN` word; `id` = the tournament or lobby id). Each step's index is uniform over its i + 1 positions within a relative bias of (i + 1) / 2^32. The steps share the hash state after the timestamp and key words, so the whole order is a function of one 32-bit state: at most 2^32 orders are reachable for a given site and id (all of them up to n = 12; from n = 13 some orders cannot occur). A generator seeded from the timestamp alone, as `ctx.random` was, has the same limit. Measured: for each of the three domain words and three timestamp families (jittered, consecutive microseconds, round seconds), over 240,000 timestamps every one of the 24 orders of 4 elements is within 2.8% of 1/24, and over 160,000 every element of 16 lands in every position within 3.2% of 1/16 (sampling noise; `shared/lobby-rules/timerDraw.test.ts`). Why not `ctx.random`: its host seed skews the first outputs (S10o review F1; see match-session/architecture.md, Phase S10o).
- **Key words.** `[SHUFFLE_DOMAIN.RandomSwap ('SWAP', 0x53574150), lobbyId]`. The input is the join order, not the
  current seats, so each call depends only on its transaction time; repeated swaps at different times redeal.
  Dealing (Blue, Red, Blue, ...), coaches, spectators, cleared captains and the confirmation reset are unchanged.
  No schema or binding change.

## Phase S10r execution (DECISIONS.md A122)

- **Per-user allowance (A122(4), L17).** `confirm_ready`, `unconfirm_ready`, `shuffle_teams` and `transfer_host` count on the existing membership bucket (`consumeMembershipAllowance`, `helpers/lobby/abuseControls.ts`: `UserRateState.membershipWindowStart` / `membershipCount`, 20 changes per fixed 10 s window, shared with joins, returns and `set_team_slot`), after their guards and before the write. The caller is counted (for `shuffle_teams` and `transfer_host` the host or the Moderator who acts). Over the cap these four answer "You are doing that too quickly. Please wait a moment." (`MEMBERSHIP_ACTION_TEXT`, passed through the new optional `message` parameter of `consumeMembershipAllowance`; S10r review F6); joins, returns and seat moves keep "You are changing lobbies or seats too quickly. Please wait a moment.". The bucket fits because each of these calls rewrites member or lobby rows every member, and for the lobby row the lobby list, receives. No new column.
- **Preset permissions (A122(5), L21).** `ensureCanMutatePreset` (`reducers/lobby/lobbyPresets.ts`): a Moderator edits or deletes a non-system preset of their own or one whose creator's role is Moderator or TournamentHost (`isRoleAtLeast(creator, 'TournamentHost') && !isRoleAtLeast(creator, 'Admin')`); an Admin's preset is refused with the existing text "Moderators can only modify presets created by moderators, TOs, or themselves.". Admins unchanged.
- **User deletion and presets (A122(6), L22).** `performUserDeletion` deletes the user's lobby presets, keeping one an unfinished tournament points at (`Tournament.lobbyPresetId`). Lobbies hold no preset reference (A116). Details in [../auth/architecture.md](../auth/architecture.md) "Phase S10r execution".

## Phase S10s execution (DECISIONS.md A122)

- **Membership bucket, wider use (A122(4), L93).** The twelve calendar reducers and the seven player roster writes now
  count on the same `consumeMembershipAllowance` bucket with `MEMBERSHIP_ACTION_TEXT` (20 calls per fixed 10 s window
  per user, shared with joins, returns, seat moves and the four S10r calls). A user who edits the calendar or the roster
  in the same 10 s as lobby actions shares the 20. Details: [../calendar/architecture.md](../calendar/architecture.md)
  and [../roster/architecture.md](../roster/architecture.md) "Phase S10s execution". No new column.

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
| Tournament seating reads the bracket match's colour mapping; shuffle guard message names A70 | Phase S8g execution (DECISIONS.md A70) | 2026-11-08 |
| Membership lifecycle: `voluntarilyLeft` replaced by `leftAt` / `abandonedAt`; a player's live-stage Leave runs `markMemberOffline` (shared with `client_disconnected`); no auto-concede, no rejoin ban; `abandonCurrentMatch` on `create_lobby` / `join_lobby` / `create_tournament_lobby`; kick / ban of players only before the draft (and in AwaitingResult), LMA rows deleted; one flag-transfer order (A22(5), online first then any) for every row removal; spectator joins in the live stages capped by the new `maxSpectators` (Lobby, LobbyPreset, system preset 12); GC presence test for Waiting; `reclaim_referee` fills an unheld flag; `view_my_lobbies` drops abandoned rows | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| `LobbyPreset` private + `view_lobby_presets`; `view_lobby_browser` without user ids (name label, joinCode only when public, hostLabel, counts); `view_my_lobby_members` row with `presence` (A68(10)) and A40 ratings; `view_my_lobby`, layer-0 `view_my_lobbies`, `view_my_lobby_bans` | Phase S9a execution (DECISIONS.md A37, A40, A44(1), A48, A68(10)) | 2026-11-08 |
| S9a fix pass: spectator targets follow `isAnonymousSpectators`; browser host label per the host's seat kind; member-event chat lines rendered per reader; banned user masked in `view_my_lobby_bans`; `Lobby` header marked private | Phase S9a execution (DECISIONS.md A37) | 2026-11-08 |
| Seat targeting: `kick_member`, `ban_member`, `set_captain`, `transfer_referee` take `targetJoinSeq`, `set_team_slot` an optional `targetJoinSeq` (omitted = self), `unban_member` takes `bannedJoinSeq`; `resolveSeat`; `Lobby.lastJoinSeq` replaces the `max + 1` join counter (seat numbers never reused); `LobbyBan.bannedJoinSeq`; no preventive ban of a non-member | Phase S9c execution (DECISIONS.md A74) | 2026-11-08 |
| `join_lobby` auto-resume only for a seated player's return and only when no seated player of either team is still offline, away or abandoned (`isSeatedPlayer`, `anySeatedPlayerAway`) | Phase S10c execution (DECISIONS.md A85) | 2026-11-09 |
| Deferred only in tournaments, NoAction only casual, forfeit grace 30-600 s; `start_draft` needs every seated player online; Waiting 15 s check for host / referee; live pool test; `defer_match` precondition; away / abandoned callers rejected by concede / claim / defer; `liftAutoPauseOnReturn` shared by `join_lobby` and `client_connected`; `view_my_lobby_members.disconnectActionAt` | Phase S10d execution (DECISIONS.md A91, A92) | 2026-11-09 |
| Fix pass: `maxSpectators` caps watchers, not seat candidates (casual Waiting joins and `set_team_slot` moves into Spectator are not counted; live-stage joins and tournament Waiting spectators are); `ensureNotInLobby` runs `transferFlagsOnRemoval` on the away row before writing `abandonedAt` | Phase S8f execution (DECISIONS.md A68(4)(7)(8)) | 2026-11-08 |
| Waiting disconnect moves the referee flag only; `transfer_host`; captain flag cleared on a team / coach / spectator move; alias cap 30; member-event and start lines inside the chat window; membership rate (20 changes / 10 s, `UserRateState`); `start_draft` names seats and rejects teams over `teamSize`; `ensureLobbyConfigInRange` in create / update / presets; Ranked rejected with a guest seated; abandon releases `LobbyMemberAccount` rows; admin row deletes through `hardDeleteLobby` / `removeMemberRow` | Phase S10e execution (DECISIONS.md A93; audit 2026-11-09) | 2026-11-09 |
| Fix pass: abandoned rows keep their `LobbyMemberAccount` rows and the roster guards ignore them (`accountLobbyLocks`); `start_draft` schedules the 15 s check for an offline host or referee; `leave_lobby` outside the membership rate; signed handicaps -1000000 to 1000000 again (`rosterThreshold` 0-1000000); admin lobby / member deletes guarded | Phase S10e execution (review F1-F5, N1, N8; DECISIONS.md A93(4), A68(6)) | 2026-11-09 |
| A98 present-member guard on every lobby action reducer (`ensurePresentMember` / `ensurePresentIfMember`, two texts); A99 a private lobby needs a password (create and the switch to private); A96 `LobbyCursorEvent.senderJoinSeq` replaces `senderUserId` / `anonymousLabel` (member restriction not available on 2.14.1, reported); A97 seat labels | Phase S10h execution (DECISIONS.md A96, A97, A98, A99) | 2026-11-09 |
| Fix pass: `transfer_referee` / `set_captain` refuse an away or abandoned target (F5); stored chat labels preferred over live ones, member-event lines store the label in every lobby (F6, F7); `ensureMemberPresentUnlessStaff` for kick / ban / captain and the `set_team_slot` staff exemption (F8); `finalize_match_result` referee path guarded, `dispute_match_result` unguarded on purpose (F9); A96 RLS statement corrected (F2); `AbuseConfig` clear-publish note (F10) | Phase S10h execution (S10h review F2, F5-F10; DECISIONS.md A96, A97, A98) | 2026-11-10 |
| `create_lobby` loses `joinCode` and `presetId` (with the "Preset not found." check), `create_tournament_lobby` loses `joinCode`; the server always generates the code; `join_lobby` unchanged | Phase S10n execution (DECISIONS.md A114, A116) | 2026-11-10 |
| `shuffle_teams` RandomSwap: `fairShuffle` keyed by the transaction time, `SHUFFLE_DOMAIN.RandomSwap` and the lobby id replaces `ctx.random.shuffle`; join order, dealing, coaches and captain clearing unchanged | Phase S10p execution (DECISIONS.md A120) | 2026-11-10 |
| `confirm_ready`, `unconfirm_ready`, `shuffle_teams`, `transfer_host` count on the membership allowance; a Moderator edits only Moderator and host presets; user deletion removes the user's unreferenced presets | Phase S10r execution (DECISIONS.md A122) | 2026-11-10 |
| The membership allowance also counts the calendar reducers and the player roster writes | Phase S10s execution (DECISIONS.md A122) | 2026-11-10 |

---

*Last updated: 2026-11-10 (S10s)*
*Feature owner: Phase 05 / Phase 09 / Phase 10.1 / Phase 10.4 / Phase 12.1 / Phase 16*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
