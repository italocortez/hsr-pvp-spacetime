# Tournament -- Architecture

Last updated: 2026-04-12

## Overview

Tournaments manage the full lifecycle of competitive events: creation, registration, team formation, bracket generation, match play, and completion. The lifecycle advances through stages: Draft -> Registration -> [CheckIn ->] Seeding -> InProgress -> Completed (or Cancelled from any non-terminal stage). All participant references use `TournamentTeam.id` -- even solo players get an auto-created team on registration so bracket code treats all formats uniformly. `TournamentEnrolled` records enrollment and status; `TournamentTeamMember` records team assignment -- the two were split from a single `TournamentParticipant` table in Phase 10.1 to decouple enrollment from team management. `TournamentPlayerAccount` locks which HSR accounts a player uses in a tournament. `TournamentAssistant` grants staff-level access to non-organizers.

## Table Relationships

```
Tournament (id: u32 autoInc PK)  [public: true]
  +-- organizerId -> User.id  [btree: organizer_id]
  +-- name: string
  +-- description: string?
  +-- stage: TournamentStage (Draft | Registration | CheckIn | Seeding | InProgress | Completed | Cancelled)
  +-- format: BracketFormat (SingleElimination | DoubleElimination | GroupPhase | GroupIntoSingleElim | GroupIntoDoubleElim)
  +-- gameMode: GameMode
  +-- teamSize: u8
  +-- maxParticipants: u32
  +-- waitlistEnabled: bool
  +-- requireVerified: bool
  +-- requireRoster: bool
  +-- requireApproval: bool
  +-- checkInEnabled: bool
  +-- autoAdvanceBracket: bool
  +-- costSetId: u32 (0=default sentinel)
  +-- groupSize: u8 (target group size for round-robin; min 3)
  +-- has3rdPlaceMatch: bool
  +-- maxAccountsPerPlayer: u8 (D-10, D-33)
  +-- isPublic: bool
  +-- startAt: Timestamp?
  +-- audit columns

  +-- TournamentEnrolled (PK: [tournamentId, userId])  [public: true]
  |     tournamentId -> Tournament.id  [btree: tournament_id]
  |     userId -> User.id  [btree: user_id]
  |     status: ParticipantStatus (Registered | CheckedIn | Withdrawn | Disqualified | Active | Eliminated)
  |     isWaitlisted: bool
  |     approvedByToAt: Timestamp?
  |     anonymousAlias: string?
  |     allowRandomTeamAssignment: bool
  |     audit columns
  |
  +-- TournamentTeam (id: u32 autoInc PK)  [public: true]
  |     tournamentId -> Tournament.id  [btree: tournament_id]
  |     captainUserId -> User.id
  |     name: string
  |     seedNumber: u32?
  |     audit columns
  |
  |     +-- TournamentTeamMember (PK: [teamId, userId])  [public: true]
  |     |     teamId -> TournamentTeam.id  [btree: team_id]
  |     |     userId -> User.id
  |     |     tournamentId -> Tournament.id  [btree: tournament_id]
  |     |     isCaptain: bool
  |     |     audit columns
  |     |     Indexes: team_id (btree), tournament_id (btree), by_tournament_and_user (btree, [tournamentId, userId])
  |     |
  |     +-- TournamentTeamRequest (PK: [teamId, userId])  [public: true]
  |           teamId -> TournamentTeam.id  [btree: team_id]
  |           userId -> User.id
  |           audit columns
  |
  +-- TournamentAssistant (PK: [tournamentId, userId])  [public: true]
  |     tournamentId -> Tournament.id  [btree: tournament_id]
  |     userId -> User.id
  |     canManageRoster: bool
  |     canManageBracket: bool
  |     audit columns
  |
  +-- TournamentPlayerAccount (PK: [tournamentId, userId, hsrAccountId])  [public: true]
        tournamentId -> Tournament.id
        userId -> User.id
        hsrAccountId -> HsrAccount.id
        audit columns
        Indexes: by_tournament_and_user (btree, [tournamentId, userId]), by_user (btree, userId)
```

## Reducer Flows

### create_tournament(params)
1. `ensureTournamentHost(ctx)` -- requires TournamentHost+ role
2. Validate name, format, gameMode, teamSize, maxParticipants
3. If `costSetId > 0`: verify CostSet exists and `isPublished=true`
4. Insert `Tournament` row with `stage=Draft`

### update_tournament(tournamentId, params)
1. `ensureTournamentAccess(ctx, tournamentId)` -- organizer, assistant, or Moderator+
2. Tournament must be in Draft or Registration stage
3. Update allowed fields (name, description, settings); cannot change gameMode after registration opens
4. If updating `costSetId`: verify new CostSet is published

### advance_tournament_stage(tournamentId)
1. `ensureTournamentAccess(ctx, tournamentId)`
2. Stage must not be terminal (Completed or Cancelled)
3. Transition guards:
   - Registration -> Seeding (or Registration -> CheckIn if enabled): requires 2+ enrolled participants
   - CheckIn -> Seeding: auto-removes participants who did not check in; calls `cleanupTeamRequests()`
   - Seeding -> InProgress: requires BracketMatch rows to exist and first-round matches to have participants; sets all enrolled players to `status=Active`
   - InProgress -> Completed: final stage transition
4. Advance `Tournament.stage` to next stage in sequence

### cancel_tournament(tournamentId)
1. `ensureTournamentAccess(ctx, tournamentId)`
2. Tournament must not be terminal
3. Call `cascadeCleanupTournament(ctx, tournamentId)`:
   - Delete TournamentTeamRequest rows
   - Delete CalendarEvent + CalendarEventInvite rows linked to bracket matches (Phase 8, D-21)
   - Hard-delete shelved/active Lobby rows linked via `Lobby.bracketMatchId`
   - Delete GroupPhaseRecord rows
   - Delete BracketMatch rows
   - Delete TournamentPlayerAccount rows
   - Delete TournamentTeamMember rows
   - Delete TournamentTeam rows
   - Delete TournamentAssistant rows
   - Preserve TournamentEnrolled rows (audit trail) and MatchResultRecord rows (match history)
4. Set `Tournament.stage=Cancelled`

### register_for_tournament(tournamentId)
1. `getAuthenticatedUser(ctx)` -- reject guests
2. Tournament must be in Registration or Seeding stage
3. Duplicate check: reject if `TournamentEnrolled` row already exists for `[tournamentId, userId]`
4. `requireVerified` check: reject guests if enabled
5. `requireRoster` check: reject if no active `HsrAccount`
6. Capacity check: count non-waitlisted participants vs `maxParticipants`; if full and `waitlistEnabled=true`: set `isWaitlisted=true`; if full and `waitlistEnabled=false`: reject
7. `requireApproval` check: if true, `approvedByToAt=null`; if false, auto-approve
8. Insert `TournamentEnrolled` row with `status=Registered`
9. Solo auto-team (`teamSize=1`): auto-create `TournamentTeam` + `TournamentTeamMember` for captain

### check_in_tournament(tournamentId)
1. `getAuthenticatedUser(ctx)`
2. Tournament must be in CheckIn stage
3. Find `TournamentEnrolled` -- verify status is Registered; update to CheckedIn

### withdraw_from_tournament(tournamentId)
1. `getAuthenticatedUser(ctx)`
2. Tournament must be in Registration, CheckIn, or Seeding stage
3. Withdrawal cleanup (in order):
   - Captain transfer: if caller captains a team, call `transferTournamentCaptain()`; if no other members, disband team
   - Delete `TournamentTeamMember` row for caller
   - Delete all caller's pending `TournamentTeamRequest` rows in this tournament
   - Update `TournamentEnrolled.status=Withdrawn` (delete+insert composite PK pattern)
   - Delete all `TournamentPlayerAccount` rows for this user+tournament

### approve_participant(tournamentId, targetUserId) / waitlist_promote(tournamentId, targetUserId)
1. `ensureTournamentAccess(ctx, tournamentId)`
2. `approve_participant`: find `TournamentEnrolled` -- set `approvedByToAt=ctx.timestamp`
3. `waitlist_promote`: find waitlisted participant; set `isWaitlisted=false`

### create_tournament_team(tournamentId, teamName)
1. `getAuthenticatedUser(ctx)` -- must be enrolled in tournament
2. Tournament must be in Registration stage
3. Insert `TournamentTeam` row with `captainUserId=caller.id`
4. Insert `TournamentTeamMember` row for captain (`isCaptain=true`)

### request_join_team(teamId) / accept_team_request(teamId, userId) / reject_team_request(teamId, userId)
1. `request_join_team`: caller must be enrolled; tournament in Registration; insert `TournamentTeamRequest`
2. `accept_team_request`: caller must be team captain; check `tournament.teamSize` member count cap; delete request; delete caller's other pending requests in this tournament; insert `TournamentTeamMember`
3. `reject_team_request`: captain deletes the request row

### leave_tournament_team(teamId) / disband_tournament_team(teamId)
1. `leave_tournament_team`: non-captain only; delete `TournamentTeamMember` row
2. `disband_tournament_team`: captain only; delete all `TournamentTeamMember` rows; delete all `TournamentTeamRequest` rows for this team; delete `TournamentTeam` row

### assign_tournament_assistant(tournamentId, targetUserId, permissions) / remove_tournament_assistant(tournamentId, targetUserId)
1. `ensureTournamentAccess(ctx, tournamentId)` -- organizer or Moderator+
2. `assign_tournament_assistant`: upsert `TournamentAssistant` row with permission flags
3. `remove_tournament_assistant`: delete `TournamentAssistant` row by `[tournamentId, targetUserId]`

### dq_participant(tournamentId, targetUserId)
1. `ensureTournamentAccess(ctx, tournamentId)` -- TO/Assistant/Moderator+
2. Three cases:
   - Captain DQ: `transferTournamentCaptain()` to next member (D-21); team survives
   - Last member DQ: delete team; auto-advance opponent on any active BracketMatch (D-27)
   - DQ during active lobby (Drafting/Equipping/Scoring): kick player; if last member: force-concede match (D-25)
3. Set `TournamentEnrolled.status=Disqualified`

### select_match_account(lobbyId, hsrAccountId) / deselect_match_account(lobbyId, hsrAccountId)
1. `getAuthenticatedUser(ctx)` -- must be active LobbyMember
2. Lobby must be in Waiting or BetweenGames stage
3. Tournament path (additive, D-07): validate account against `TournamentPlayerAccount`; check `maxAccountsPerPlayer` cap; insert `LobbyMemberAccount`
4. Non-tournament path (replace, D-07): delete existing `LobbyMemberAccount` for user; insert new one (always exactly 1)
5. `deselect_match_account`: tournament path only; delete specific `LobbyMemberAccount` row
6. Phase 12.3 D-B-03: `select_match_account` carries a monotonic-upward post-insert hook that extends `MatchResultParticipant.accountRatingSnapshot` to `max(existing, newAccount.accountRating)` when an MRP row already exists (BetweenGames stage). `deselect_match_account` does NOT run the hook -- removing from selection cannot lower the max.

### Phase 12.3: finalize_match_result tournament-ordering guard

A stage guard rejects tournament-controlled match finalization until the parent
tournament reaches `Completed` or `Cancelled`. Without this guard, an admin
finalizing an individual MMR-tournament match mid-tournament would silently lose
the match's MMR input -- `runFinalization` step 18 unconditionally deletes
`MatchResultRecord` + `MatchResultParticipant` rows, which is exactly the data
`process_tournament_mmr` reads at tournament-end.

The guard is unconditional:
- **MMR tournaments** (`countTowardsMmr: true`): blocked until terminal stage ->
  `process_tournament_mmr` runs against surviving MRP rows -> individual
  `finalize_match_result` calls succeed and clean up the ephemeral data.
- **Casual tournaments** (`countTowardsMmr: false`): blocked until terminal stage
  -> per-match `finalize_match_result` succeeds (no MMR step because
  `process_tournament_mmr` rejects with `countTowardsMmr=false`). The guard still
  applies to preserve bracket rollback capability, which applies to casual
  tournaments too.
- **Non-tournament matches** (`isTournamentControlled: false`): unaffected;
  finalize freely once validated.

Bracket rollback itself is NOT implemented in Phase 12.3 -- the guard makes it
possible by keeping ephemeral data alive until tournament end. Implementing
"invalidate this bracket match and redo downstream" is a future phase.

Tournament derivation (`BracketMatch -> Tournament.tournamentId`) reuses the same
path as the existing authority check at `matchFinalization.ts:39-50`. Defensive
handling: an MRR with `isTournamentControlled: true` but missing `bracketMatchId`
is rejected with the same error message (Pitfall 4 resolution).

Cross-reference: see `docs/match-results/architecture.md` Phase 12.3 section for
the full MMR snapshot lifecycle context.

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Forward-only stage lifecycle: Draft -> Registration -> [CheckIn ->] Seeding -> InProgress -> Completed | Phase 04 CONTEXT.md | 2026-02-20 |
| TournamentParticipant split into TournamentEnrolled (enrollment) + TournamentTeamMember (team membership) -- decouples enrollment from team assignment (D-20) | Phase 10.1 execution | 2026-03-25 |
| Solo tournaments auto-create TournamentTeam + TournamentTeamMember on register_for_tournament | Phase 04 execution | 2026-02-20 |
| TournamentEnrolled preserved on cancellation -- audit trail of who registered | Phase 04 CONTEXT.md | 2026-02-20 |
| ParticipantStatus enum: Registered / CheckedIn / Withdrawn / Disqualified / Active / Eliminated (D-35 through D-41) | Phase 10.1 execution | 2026-03-25 |
| Status fields are informational only -- no reducer gating on status values | Phase 10.1 execution | 2026-03-25 |
| TournamentTeamRequest: transactional table -- row existence = pending request | Phase 04 execution | 2026-02-20 |
| seedNumber moved to TournamentTeam (not TournamentEnrolled) -- seeding is team-level | Phase 04 execution | 2026-02-20 |
| cancel_tournament cascade order: requests -> calendar events -> shelved lobbies -> standings -> bracket -> accounts -> team members -> teams -> assistants | Phase 08 execution | 2026-03-28 |
| TournamentPlayerAccount: locks HSR accounts per tournament; sole source of truth for locked accounts (D-23) | Phase 06 execution | 2026-02-28 |
| maxAccountsPerPlayer on Tournament controls additive LobbyMemberAccount cap for tournament path (D-10, D-33) | Phase 10.4 execution | 2026-03-29 |
| Stand-in TPA creation: TournamentPlayerAccount snapshotted at join_lobby for approved stand-ins (D-26) | Phase 10.4 execution | 2026-03-29 |
| ensureTournamentAccess: organizer OR TournamentAssistant row OR Moderator+ | Phase 04 execution | 2026-02-20 |
| costSetId=0 sentinel; costSetId>0 must reference published CostSet | Phase 03 execution | 2026-02-15 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| Phase 12.3 | finalize_match_result tournament-ordering guard (D-H-01): unconditional rejection of tournament-controlled finalize until tournament stage is Completed or Cancelled, preserves MMR batch processing and bracket rollback window |

---

*Last updated: 2026-04-12*
*Feature owner: Phase 04 / Phase 06 / Phase 08 / Phase 10.1 / Phase 10.4 / Phase 12.3*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
