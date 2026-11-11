# Tournaments

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Tournaments are multi-stage competitive events managed by Tournament Hosts and their assistants. A tournament moves through stages (Draft → Registration → CheckIn → Seeding → InProgress → Completed/Cancelled) with validated forward-only transitions. Players register as individuals; team formation happens through explicit join requests and captain acceptance (or auto-creation for solo tournaments). The bracket (generated in Seeding stage) drives match scheduling. Tournament lobbies inherit all settings from the parent tournament and are locked once created. Assistants can be granted granular permissions (validate results, override results, DQ participants, manage bracket, assign seeds). Match history is hidden until the tournament completes or is cancelled (D-91).

## Reducers

### Tournament Lifecycle

| Reducer | Permission | Description |
|---------|-----------|-------------|
| `create_tournament` | TournamentHost+ | Create tournament in Draft stage with all settings |
| `update_tournament` | TO/Assistant/Mod+ | Update settings (Draft or Registration stage only) _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| `advance_tournament_stage` | TO/Assistant/Mod+ | Forward-only stage transition with validation |
| `cancel_tournament` | TO/Assistant/Mod+ | Cancel from any non-terminal stage; cascade-deletes infrastructure; reveals match history (D-91) _Superseded in Phase S8d execution (DECISIONS.md A24(5)): see the cancel-cascade row in Phase History (teams, members, assistants and bracket matches are kept; requests, calendar events and player-account locks are deleted; no D-91 reveal)._ |

**Key validation for `create_tournament`:**
- Name: 1-100 chars; description: max 2000 chars
- `teamSize` must be 1, 2, or 3
- `defaultBestOf` must be 1, 3, 5, or 7
- `winnerAdvantage` must be 0-3
- `groupSize` must be at least 3
- `maxAccountsPerPlayer` must be 0-10
- `format`, `defaultGameMode`, `rosterVisibility`, `disconnectPolicy` must be valid enum tags
- `costSetId !== 0` requires a Published cost set to exist
- `scheduledStartAt` and `registrationDeadline` must be in the future; deadline must be before start

**Key validation for `advance_tournament_stage`:**
- Registration → Seeding: validates minimum team count, cleans up pending team requests
- CheckIn → Seeding: auto-removes unchecked-in participants, cleans up team requests
- Seeding → InProgress: validates bracket rows exist; bulk-sets Enrolled status to Active
- Any → Completed: triggers `revealTournamentHistory` (D-91)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Name out of range | "Tournament name must be 1-100 characters." |
| Description too long | "Description cannot exceed 2000 characters." |
| Invalid teamSize | "teamSize must be 1, 2, or 3." |
| Invalid defaultBestOf | "defaultBestOf must be 1, 3, 5, or 7." |
| Invalid winnerAdvantage | "winnerAdvantage must be 0-3." |
| Invalid groupSize | "groupSize must be at least 3." |
| Invalid maxAccountsPerPlayer | "maxAccountsPerPlayer must be 0-10." |
| Invalid format/gameMode/etc. | "Invalid {field}: \"...\". Must be one of: ..." |
| Cost set not found | "Cost set {id} not found." |
| Cost set not published | "Cost set {id} is not published." |
| scheduledStartAt in the past | "scheduledStartAt must be in the future." |
| registrationDeadline in the past | "registrationDeadline must be in the future." |
| deadline not before start | "registrationDeadline must be before scheduledStartAt." |
| Update during wrong stage | "Tournament can only be updated in Draft or Registration stage." |

---

### Registration and Enrollment

| Reducer | Permission | Description |
|---------|-----------|-------------|
| `register_for_tournament` | Any authenticated | Enroll in Registration/Seeding stage; handles waitlist; auto-creates team for solo tournaments; locks HSR accounts |
| `withdraw_from_tournament` | Self | Set status to Withdrawn; transfer/destroy team; clean up TPA rows |
| `approve_participant` | TO/Assistant/Mod+ | Set `approvedByToAt` for pending approval |
| `waitlist_promote` | TO/Assistant/Mod+ | Move waitlisted participant to active |
| `check_in_tournament` | Self | Set status Registered→CheckedIn during CheckIn stage |

**Key validation for `register_for_tournament`:**
- Tournament must be in Registration or Seeding stage
- Player must not already be enrolled
- `requireVerified` rejects guests
- `requireRoster` requires an active `HsrAccount`
- Full tournament (no waitlist) throws "Tournament is full."
- Full tournament (waitlist enabled) inserts with `isWaitlisted=true`

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Tournament not found | "Tournament not found." |
| Wrong stage | "Tournament is not accepting registrations." |
| Already registered | "You are already registered for this tournament." |
| Guest on verified-only tournament | "This tournament requires a verified account. Link your Discord first." |
| No active HSR account | "This tournament requires an active HSR account in your roster." |
| Full, no waitlist | "Tournament is full." |
| Withdraw wrong stage | "Cannot withdraw during this stage. Contact the organizer to be disqualified." |
| Already withdrawn | "Already withdrawn." |
| Check-in wrong stage | "Tournament is not in the CheckIn stage." |
| Not enrolled | "You are not enrolled in this tournament." |
| Already checked in | "You have already checked in." |
| Cannot check in (wrong status) | "Cannot check in: enrollment status is not Registered." |

---

### Team Management

| Reducer | Permission | Description |
|---------|-----------|-------------|
| `create_tournament_team` | Enrolled participant | Create team (Registration stage only, teamSize > 1) |
| `request_join_team` | Enrolled participant | Submit join request to existing team |
| `accept_team_request` | Team captain | Accept player; inserts TournamentTeamMember; cleans up player's other requests |
| `reject_team_request` | Team captain | Delete request row |
| `leave_tournament_team` | Team member | Delete own TournamentTeamMember; captain transfers or team destroyed |
| `disband_tournament_team` | Team captain | Destroy team + all member rows (Registration stage only) |

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Team not found | "Team not found." |
| Tournament wrong stage (create/disband) | "Teams can only be created/disbanded during the Registration stage." |
| Solo tournament team create | "Cannot create teams in a solo tournament." |
| Not enrolled | "You must be registered in the tournament before creating/joining a team." |
| Already on a team | "You are already on a team in this tournament." |
| Team name out of range | "Team name must be 1-50 characters." |
| Duplicate request | "You already have a pending request to join this team." |
| Team full on accept | "Team is already full." |
| Not captain | "Only the team captain can accept/reject join requests." / "Only the team captain can disband the team." |
| Not a team member | "You are not a member of this team." |

---

### Admin and Moderation

| Reducer | Permission | Description |
|---------|-----------|-------------|
| `dq_participant` | TO/Assistant/Mod+ | Disqualify; handle team cascade, active lobby concede/void, bracket auto-advance |
| `override_match_result` | TO/Assistant (tournament), Mod+ (non-tournament) | Override MatchResultRecord status (D-30, D-31, D-42) |
| `assign_tournament_assistant` | TO or Mod+ | Upsert assistant with granular permissions |
| `remove_tournament_assistant` | TO or Mod+ | Delete assistant row |
| `mod_promote_to_host` | Moderator+ | Promote User role to TournamentHost |
| `mod_demote_from_host` | Moderator+ | Demote TournamentHost to User |

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Participant not found for DQ | "Participant not found in this tournament." |
| Already disqualified | "Participant is already disqualified." |
| DQ withdrawn participant | "Cannot disqualify a participant who has already withdrawn." _Superseded in Phase S10g execution (backend audit 2026-11-09, dead branch)._ |
| Self-assign assistant | "You cannot assign yourself as a tournament assistant." |
| Target user not found | "Target user not found." |
| Assistant not found on remove | "Tournament assistant not found." |
| Promote non-User role | "Can only promote users with the \"User\" role to TournamentHost. Current role: {role}" |
| Demote non-TournamentHost | "Can only demote users with the \"TournamentHost\" role to User. Current role: {role}" |
| Self-promote/demote | "You cannot change your own role via this reducer." |

---

### Tournament Lobby

| Reducer | Permission | Description |
|---------|-----------|-------------|
| `create_tournament_lobby` | Match participant, TO, assistant, Mod+ | Create lobby linked to BracketMatch; inherits all tournament settings |
| `approve_stand_in` | TO/assistant/Mod+ | Insert TournamentStandIn row for a bracket match |

**Key validation for `create_tournament_lobby`:**
- D-45: Only one non-Finished lobby per bracketMatchId at a time
- D-22: Caller must not already be in a lobby
- D-67: `matchType` derived from `tournament.countTowardsMmr` (true=Ranked, false=Casual)
- D-65: All settings inherited from Tournament (gameMode, teamSize, costSet, anonymous, rosterVisibility, disconnectPolicy)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Bracket match not found | "Bracket match not found." |
| Tournament not found | "Tournament not found." |
| Not authorized | "You are not authorized to create a lobby for this bracket match." |
| Duplicate lobby for bracket match | "A lobby already exists for this bracket match." |
| Stand-in already approved | "Stand-in already approved for this bracket match." |

## Phase 12.3 Additions

### Tournament.requireOwnership (Phase 12.3)

`Tournament.requireOwnership` is a boolean column (default `false`). When `true`,
character ownership validation during Classic draft picks checks that the picked
character is in the player's enrolled HSR account roster (via `TournamentPlayerAccount`
→ `HsrAccountCharacter`). This is distinct from `requireRoster`, which only gates
registration; `requireOwnership` gates individual draft picks.

### finalize_match_result Ordering Guard (D-H-01, Phase 12.3)

For tournament-controlled matches, `finalize_match_result` rejects unless the parent
tournament has reached `Completed` or `Cancelled`. The guard is unconditional:
- **MMR tournaments** (`countTowardsMmr=true`): blocked until terminal stage →
  `process_tournament_mmr` runs against surviving MRP rows → individual
  `finalize_match_result` calls succeed and clean up ephemeral data.
- **Casual tournaments** (`countTowardsMmr=false`): blocked until terminal stage →
  per-match `finalize_match_result` succeeds (no MMR step). Guard still applies
  to preserve bracket rollback capability.
- **Non-tournament matches**: unaffected; finalize freely once Validated.

Cross-reference: see `docs/match-results/contract.md` Phase 12.3 section.

## Acceptance Scenarios

### Tournament Creation
**Given:** User with TournamentHost role
**When:** `create_tournament` with valid settings
**Then:** Tournament inserted with stage=Draft, organizerId=caller

### Tournament Update (Draft)
**Given:** Tournament in Draft stage
**When:** `update_tournament` with new name, bestOf, has3rdPlaceMatch
**Then:** Fields update successfully, tournament remains in Draft

### Tournament Update (Registration)
**Given:** Tournament in Registration stage
**When:** `update_tournament` with new rosterVisibility, disconnectPolicy
**Then:** Fields update successfully, tournament remains in Registration

### Stage Advancement (full chain)
**Given:** Tournament in Draft
**When:** `advance_tournament_stage` called repeatedly: Draft→Registration→Seeding→InProgress→Completed
**Then:** Each transition succeeds in order

### Stage Advancement (blocked — insufficient participants)
**Given:** Tournament in Registration, 1 active participant
**When:** `advance_tournament_stage(id, "Seeding")`
**Then:** Throws "At least 2 active participants are required"

### Stage Advancement (blocked — no brackets generated)
**Given:** Tournament in Seeding, no BracketMatch rows exist
**When:** `advance_tournament_stage(id, "InProgress")`
**Then:** Throws "Bracket must be generated before advancing to InProgress"

### Cancel Tournament
**Given:** Tournament in Registration stage with teams, assistants, and pending requests
**When:** `cancel_tournament(id)`
**Then:** Stage changes to Cancelled. Cascade deletes: TournamentTeamRequest, GroupPhaseRecord, BracketMatch, TournamentPlayerAccount, TournamentTeam, TournamentAssistant, CalendarEvent + CalendarEventInvite (for all linked bracket matches). TournamentEnrolled rows preserved (audit trail). MatchResultRecord rows preserved (player history). _Superseded in Phase S8d execution (DECISIONS.md A24(5)): see the cancel-cascade row in Phase History (teams, members, assistants and bracket matches are kept; requests, calendar events and player-account locks are deleted; no D-91 reveal)._

### Cancel InProgress Tournament
**Given:** Tournament in InProgress with generated bracket, group standings, and match results
**When:** `cancel_tournament(id)`
**Then:** Stage=Cancelled. BracketMatch and GroupPhaseRecord rows deleted. CalendarEvent + CalendarEventInvite rows for linked bracket matches deleted. MatchResultRecord rows preserved. TournamentEnrolled rows preserved with their current status unchanged. _Superseded in Phase S8d execution (DECISIONS.md A24(5)): see the cancel-cascade row in Phase History (teams, members, assistants and bracket matches are kept; requests, calendar events and player-account locks are deleted; no D-91 reveal)._

### Player Registration
**Given:** Tournament in Registration, verified user with active roster
**When:** `register_for_tournament(id)`
**Then:** TournamentEnrolled row inserted with isWaitlisted=false, status=Registered

### Waitlist & Approval Flow
**Given:** Tournament with requireApproval=true, maxParticipants=2, waitlistEnabled=true
**When:** 3 players register
**Then:** First 2 get isWaitlisted=false, approvedByToAt=null (pending approval). Third gets isWaitlisted=true.
**When:** TO calls `approve_participant` on player 1
**Then:** approvedByToAt set to timestamp
**When:** TO calls `waitlist_promote` on waitlisted player
**Then:** isWaitlisted=false, approvedByToAt auto-set (implicit approval)

### Withdraw from Tournament
**Given:** Registered participant
**When:** `withdraw_from_tournament(id)`
**Then:** Participant row status set to Withdrawn (row preserved for audit). TournamentPlayerAccount rows deleted. TournamentTeamMember row deleted. Pending TournamentTeamRequest rows from this user deleted. CalendarEventInvite rows for this user on any CalendarEvents linked to this tournament's bracket matches deleted.

### Captain Withdrawal Auto-Transfers Captaincy
**Given:** Captain of a team with 2+ members, Player C has pending request
**When:** Captain calls `withdraw_from_tournament(tournamentId)`
**Then:** Captaincy transfers to lowest-userId remaining member. Captain's TournamentTeamMember row deleted, participant status=Withdrawn, TournamentPlayerAccount rows deleted. Player C's pending request preserved (team still exists).

### Solo Registration with Auto-Team
**Given:** Solo tournament (teamSize=1) in Registration
**When:** `register_for_tournament(id)`
**Then:** TournamentEnrolled row created. TournamentTeam auto-created (name=displayName). TournamentTeamMember row links participant to team.

### Registration with Account Locking (Phase 6)
**Given:** Player with 2 HSR accounts registers for tournament in Registration stage
**When:** `register_for_tournament(tournamentId)`
**Then:** TournamentEnrolled row created AND TournamentPlayerAccount rows created for ALL user HSR accounts (not just active). Accounts locked to this tournament for pick validation during matches. (D-21)
Note: TournamentEnrolled row does NOT contain hsrAccountId — that column was removed in Phase 10.4 (D-23). TournamentPlayerAccount is the sole source of truth for locked accounts.

### Account Selection in Tournament Lobby (Phase 10.4)
**Given:** Player enrolled in tournament with 2 locked accounts (TPA rows), in Waiting stage tournament lobby
**When:** `select_match_account(lobbyId, hsrAccountId)` called with a locked account
**Then:** LobbyMemberAccount row created for [lobbyId, userId, hsrAccountId]. If maxAccountsPerPlayer=1 (default), replaces existing selection. If maxAccountsPerPlayer=2+, row added additively. (D-05, D-07, D-11, Phase 10.4 execution) _Superseded in Phase S10 execution (DECISIONS.md A76)._

### Account Selection Exceeds maxAccountsPerPlayer
**Given:** Tournament with maxAccountsPerPlayer=1, player already has 1 LobbyMemberAccount row
**When:** `select_match_account(lobbyId, anotherHsrAccountId)`
**Then:** Throws error — player has reached the maximum number of accounts for this tournament. (D-11, Phase 10.4 execution) _Superseded in Phase S10 execution (DECISIONS.md A76)._

### Account Selection Non-Tournament (Replace Behavior)
**Given:** Non-tournament lobby, player with account A selected (LobbyMemberAccount row for account A)
**When:** `select_match_account(lobbyId, accountB.id)` called with a different owned account
**Then:** LobbyMemberAccount row for account A deleted, new row for account B inserted. Always max 1 account in non-tournament lobbies. (D-07, Phase 10.4 execution)

### Stand-In Account Snapshot at Lobby Join (Phase 10.4)
**Given:** Approved stand-in (TournamentStandIn row exists for bracketMatchId + userId), no TPA entries yet for this tournament _Superseded in Phase S10v execution (DECISIONS.md A135 to A138): see the Phase History rows for the stand-in rules._
**When:** Stand-in calls `join_lobby` for a tournament lobby linked to that bracketMatchId
**Then:** All stand-in's HSR accounts snapshotted into TournamentPlayerAccount. LobbyMemberAccount row auto-created with their active account. (D-26, Phase 10.4 execution)

### Withdrawal Cleans Up Account Locks
**Given:** Player registered for tournament with locked accounts
**When:** `withdraw_from_tournament(tournamentId)`
**Then:** Participant status=Withdrawn AND all TournamentPlayerAccount rows for this user+tournament deleted.

### Team Join Request
**Given:** Team tournament, Team A (1 member), Player B registered individually
**When:** Player B calls `request_join_team(teamId)`
**Then:** TournamentTeamRequest row created (row exists = pending)
**When:** Captain calls `accept_team_request(teamId, playerB)`
**Then:** Request row deleted. Player B's other pending requests in this tournament also deleted. TournamentTeamMember row created linking Player B to team.

### Team Reject Request
**Given:** TournamentTeamRequest exists
**When:** Captain calls `reject_team_request(teamId, playerB)`
**Then:** Request row deleted. Player B remains without a team (no TournamentTeamMember row created).

### Leave Tournament Team
**Given:** Non-captain team member
**When:** `leave_tournament_team(teamId)`
**Then:** Member's TournamentTeamMember row deleted

### Disband Tournament Team
**Given:** Captain of a team with 3 members
**When:** `disband_tournament_team(teamId)`
**Then:** Team row deleted. All TournamentTeamMember rows deleted. All pending requests deleted.

### Tournament Assistant Management
**Given:** Tournament organizer
**When:** `assign_tournament_assistant(tournamentId, userId, permissions...)`
**Then:** TournamentAssistant row inserted with specified permissions
**When:** `assign_tournament_assistant` called again with same userId, different permissions
**Then:** Permissions updated (upsert)
**When:** `remove_tournament_assistant(tournamentId, userId)`
**Then:** Assistant row deleted

### DQ Auto-Advance
> **Superseded (Phase S8c execution):** the open matches of a disqualified team are settled through `applyBracketResult` (decidedBy Dq) or, while the opponent is unknown, the slot becomes a BYE; no autoAdvanceBracket flag. See "DQ Settles the Bracket (Phase S8c execution)" and docs/brackets/contract.md S8c-15 / S8c-16.

**Given:** Tournament InProgress, autoAdvanceBracket=true, A vs B in bracket
**When:** `dq_participant(tournamentId, playerA)`
**Then:** A status=Disqualified. B auto-advances to next bracket match

### Moderator Promote to Host
**Given:** User with Moderator or Admin role, target user with User role
**When:** `mod_promote_to_host(targetUserId)`
**Then:** Target user's role changes from User to TournamentHost

### Moderator Demote from Host
**Given:** User with Moderator or Admin role, target user with TournamentHost role
**When:** `mod_demote_from_host(targetUserId)`
**Then:** Target user's role changes from TournamentHost to User

### Check-In Tournament
**Given:** Tournament in CheckIn stage, participant with status=Registered
**When:** `check_in_tournament(tournamentId)`
**Then:** Participant status changes to CheckedIn

### Check-In Already Checked In
**Given:** Participant with status=CheckedIn
**When:** `check_in_tournament(tournamentId)`
**Then:** Throws "You have already checked in"

### Check-In Wrong Stage
**Given:** Tournament NOT in CheckIn stage
**When:** `check_in_tournament(tournamentId)`
**Then:** Throws stage error

### Captain Transfer on Withdrawal
**Given:** Team captain with 2+ members
**When:** Captain calls `withdraw_from_tournament(tournamentId)`
**Then:** Captaincy transfers to lowest-userId remaining TournamentTeamMember. Captain's member row deleted, status=Withdrawn.

### Captain Transfer on DQ
**Given:** Team captain with 2+ members, tournament InProgress
**When:** `dq_participant(tournamentId, captainUserId)`
**Then:** Captain status=Disqualified. Captaincy transfers to lowest-userId remaining TournamentTeamMember.

### Last Member Leaves Team
> **Superseded (Phase S8c execution):** a team emptied by DQ is no longer deleted: it becomes Disqualified and stays for the bracket record (A26a(2), TD-18). Withdrawal keeps the S8b rules.

**Given:** Team with single remaining member
**When:** Last member calls `withdraw_from_tournament` or is DQ'd
**Then:** Team destroyed (TournamentTeam row + all TournamentTeamMember rows deleted)

### Stage Transition: Registration → CheckIn
**Given:** Tournament in Registration, checkInEnabled=true
**When:** `advance_tournament_stage(id, "CheckIn")`
**Then:** Stage changes to CheckIn

### Stage Transition: CheckIn → Seeding
**Given:** Tournament in CheckIn, some participants still status=Registered (unchecked-in)
**When:** `advance_tournament_stage(id, "Seeding")`
**Then:** Unchecked-in participants auto-removed. Stage changes to Seeding.

### Stage Transition: Registration → Seeding (skip CheckIn)
**Given:** Tournament in Registration, checkInEnabled=false
**When:** `advance_tournament_stage(id, "Seeding")`
**Then:** Stage changes to Seeding (CheckIn stage skipped)

### ParticipantStatus Lifecycle
**Given:** Participant with status=Registered
**When:** `check_in_tournament` → status=CheckedIn
**When:** Tournament advances to InProgress → status=Active (bulk update for all CheckedIn/Registered participants)
**When:** Final bracket loss → status=Eliminated

### Series Management: Advance to Next Game
**Given:** Active match series with gameNumber=1, draft state exists
**When:** `advance_to_next_game(matchSessionId)`
**Then:** Draft state reset, gameNumber incremented to 2

### Series Management: Shelve Series
**Given:** Active match series needing long pause
**When:** `shelve_series(matchSessionId)`
**Then:** Series transitions to Shelved status

### Series Management: Resume Series
**Given:** Shelved match series
**When:** `resume_series(matchSessionId)` with 1+ player per team present
**Then:** Series resumes from where it left off

### Phase 12.3: Tournament Ordering Guard Blocks Early Finalization (D-H-01)
**Given:** A tournament match where the parent tournament stage is InProgress
**When:** Moderator calls `finalize_match_result(matchResultId)`
**Then:** Throws ordering guard error — finalization blocked until tournament is Completed or Cancelled

### Phase 12.3: Tournament Ordering Guard Allows Finalization After Completion (D-H-01)
**Given:** Same tournament match; tournament has since advanced to Completed
**When:** Moderator calls `finalize_match_result(matchResultId)`
**Then:** Finalization proceeds — 19-step pipeline runs, stats written, lobby hard-deleted

### Phase 12.3: requireOwnership Blocks Unowned Character Pick
**Given:** Tournament with requireOwnership=true; player enrolled with account that has only "Kafka" in their roster
**When:** Player tries to pick "Jingliu" (not in their enrolled account's HsrAccountCharacter rows)
**Then:** Pick rejected with ownership error — character not in player's enrolled HSR account

### Series Length Capped to 1 or 3 (Phase S6 execution, A28, A38(2))
**Given:** A TournamentHost+
**When:** They call `create_tournament` or `update_tournament` with `defaultBestOf = 5`
**Then:** Rejected: "bestOf must be 1 or 3." (replaces the 1/3/5/7 whitelist). `grandFinalBestOf` equals `defaultBestOf` at creation until its own argument lands (S8).

### Grand-Final Head Start Must Not Decide the Final (Phase S6 execution, A27, review CH-T9)
**Given:** A TournamentHost+
**When:** They create a tournament with `defaultBestOf = 1`, `winnerAdvantage = 1`; or `defaultBestOf = 3`, `winnerAdvantage = 2`
**Then:** Both are rejected ("winnerAdvantage must be less than ceil(grandFinalBestOf / 2) ..."); `defaultBestOf = 3`, `winnerAdvantage = 1` is accepted. `update_tournament` validates against the stored `grandFinalBestOf`.

### Lobby Preset Defaults to the System Preset (Phase S6 execution, A33a)
**Given:** A freshly initialized database
**When:** A TournamentHost+ creates a tournament; later, in Draft or Registration, calls `update_tournament` with `lobbyPresetId` = a preset the organizer owns, then 9999, then the system preset id
**Then:** The new tournament's `lobbyPresetId` is the system preset; the swap to the organizer's own preset is stored; 9999 is rejected ("Lobby preset not found."); a preset owned by someone else is rejected ("The tournament can only use the system preset or one of the organizer's own presets."); the system preset is accepted again. Outside Draft / Registration `update_tournament` is rejected as before. Omitting `lobbyPresetId` keeps the stored value. The cost set must be selectable and cover `defaultGameMode` × the preset's draft mode (docs/cost-sets/contract.md).

### Permission Matrix (Phase S8b execution, A25)
**Given:** A tournament with its organizer, a Moderator, and assistants each holding one of `canManageParticipants`, `canManageBracket`, `canResolveResults`
**When:** Each calls `update_tournament`, `advance_tournament_stage`, `cancel_tournament`, `assign_tournament_assistant`; `approve_participant`, `waitlist_promote`, `add_participant`, `reject_participant`, `dq_participant`; `assign_team_group`, `advance_tournament_stage(Seeding → InProgress)`, `generate_bracket`; `rollback_bracket_match`, `override_match_result`
**Then:** The organizer and the Moderator may call everything. An assistant may call only the reducers of its flag: participants → approvals, promotion, adding, rejecting, DQ, staff check-in; bracket → groups, seeding, generation, Seeding → InProgress; results → result reducers. Settings, other stage changes, cancel and assistant management are `owner` only: "Only the organizer or a Moderator can change this tournament's settings, stages or staff."; a missing flag answers "This action needs the <participants|bracket|results> permission."

### Registration Closes: Random Teams, Forming Teams Kept (Phase S8b execution, A26, A26a, A36a)
**Given:** A team tournament (teamSize 2, check-in off) in Registration with one full team, one team of one member, two teamless players who opted in (`allowRandomTeamAssignment`), one teamless player who did not, and a pending join request
**When:** The organizer advances to Seeding
**Then:** The request is deleted; the two opted-in players form "Team 1" (captain = the first member after a `ctx.random` shuffle) and it becomes Ready; the full team becomes Ready; the one-member team stays Forming with its member (A26a: staff may still promote, add or move players into it with `add_team_member` until the bracket is generated, when `generate_bracket` withdraws teams still Forming, S8c); the third teamless player stays enrolled without a team. With fewer than 2 eligible teams the advance is rejected ("At least 2 eligible teams are needed (n).") and nothing changes. From Registration with check-in on: "Check-in is enabled: move to CheckIn first." With check-in on, registration closes at Registration → CheckIn instead: the requests are deleted and the random teams are formed then, and those teams must check in like any other team.

### Team-Level Check-In (Phase S8b execution, A26)
**Given:** A tournament in CheckIn with teams A and B
**When:** A's captain calls `check_in_tournament(tournamentId)`; A's other member calls it; A's captain calls it again; then the organizer advances to Seeding
**Then:** Every member of A is CheckedIn; the non-captain is rejected ("Only the team captain can check the team in."); the repeat is rejected ("Team is already checked in."). At Seeding, B (not checked in) becomes Withdrawn with its members still enrolled; nobody is deleted. If the last member of a team withdraws during CheckIn, the team is kept and marked Withdrawn (TD-18); in Registration it is deleted. Staff with the participants permission may pass `teamId` to check a team in. Registration → CheckIn is rejected when `checkInEnabled` is false.

### Staff Fill a Short Team (Phase S8b execution, A26a)
**Given:** A team tournament (teamSize 2) in Seeding with two Ready teams, a Forming team of one member and a teamless approved player
**When:** A captain calls `add_team_member(formingTeam, player)`; staff add the player to a Ready (full) team; staff with the participants permission add the player to the Forming team; after generation staff try again
**Then:** The captain is rejected ("This action needs the participants permission."); the full team is rejected ("Team is already full."); the Forming team gets the player and becomes Ready; after generation: "Bracket generated; use stand-ins." A waitlisted player must be promoted first; a player on a team, awaiting approval or Disqualified is rejected.

### Waitlist Promotion Window (Phase S8b execution, D.8.6, A26a(4))
**Given:** A full tournament (`maxParticipants` 2, waitlist on) with one waitlisted player
**When:** Staff call `waitlist_promote` while the tournament is full; a registered player withdraws; staff promote again; later the bracket is generated (`bracketGeneratedAt` set) and staff try to promote or add a player
**Then:** The first promotion is rejected ("No free spot: the tournament is full."); after the withdrawal (the row is deleted, freeing the spot) the promotion succeeds, implies approval and creates the player's `TournamentPlayerAccount` locks; after generation both calls are rejected ("Bracket generated; use stand-ins."). Waitlisted players have no account locks before promotion. Capacity never counts waitlisted or Disqualified rows.

### Minimum MMR (Phase S8b execution, A36b)
**Given:** A tournament with `minimumMmr = 1200` on MemoryOfChaos, `EloConfig.initialRating = 1000`
**When:** A guest registers; a verified player with no `MmrRating` row registers; the organizer lowers `minimumMmr` to 900 and the verified player registers again
**Then:** The guest is rejected ("Guests cannot join a tournament with a minimum MMR.") even when `requireVerified` is off; the verified player is evaluated at 1000 and rejected ("This tournament needs an MMR of at least 1200 (yours: 1000)."); at 900 the registration succeeds. A player with a row is evaluated at their rating for the tournament's game mode and season. _Superseded in Phase S10m execution (DECISIONS.md A113)._

### Withdrawal and Re-Registration (Phase S8b execution, A26a)
**Given:** A tournament in Registration
**When:** A team captain withdraws; the player registers again; staff disqualify another player who then tries to register again; a player tries to withdraw in Seeding
**Then:** The withdrawal deletes the enrolment, membership (captaincy to the lowest-userId member, the team deleted when empty), account locks, requests and calendar invites; re-registration succeeds. The disqualified player is rejected ("You were disqualified from this tournament.") and cannot withdraw. In Seeding: "Registration is closed; ask staff." A captain may pull the whole team with `withdraw_tournament_team` in Registration or CheckIn: the team becomes Withdrawn, its members stay enrolled.

### Team Status Follows Eligibility (Phase S8b execution, A26)
**Given:** A team tournament with `requireApproval`
**When:** A captain's team reaches `teamSize` members, one of whom awaits approval; staff approve that member; a member leaves
**Then:** The team stays Forming, becomes Ready on the approval, and returns to Forming when the member leaves. Participants never set the status; a team at `teamSize` rejects join requests ("Team is already full."); team edits (create, join, accept, reject, leave, disband) are Registration only; leaving or disbanding a solo team is rejected (withdraw instead).

### Rename and Alias (Phase S8b execution, A36a)
**Given:** An anonymous solo tournament and a team tournament, both in Registration
**When:** A player registers in the solo tournament with `anonymousAlias = " Ghost "`; another calls `set_anonymous_alias("Shade")`; a captain renames their team to a name another team already uses (any case), then to a fresh one; a solo player calls `rename_tournament_team`
**Then:** The solo teams are named "Ghost" and "Shade"; an anonymous solo player without an alias (or added by staff) gets a neutral "Player <n>" until they set one, never their display name (A37); a non-anonymous solo team is named after the display name; auto names that collide get " (2)", " (3)", … (also when an alias collides); the duplicate is rejected ("Another team in this tournament already uses that name."), the fresh name (1–40 characters, trimmed) is stored; the solo rename is rejected ("A solo team is named after its player."). Aliases are 1–32 characters, anonymous tournaments only, before Seeding; renames are allowed in Registration and CheckIn.

### Manual Group Assignment (Phase S8b execution, A36a, A32)
**Given:** A GroupOnly tournament with `groupSize = 2`, `groupAssignmentMode = Manual`, in Seeding with 4 Ready teams
**When:** A bracket-permission assistant assigns a team to group 1, then to group 2, then calls `clear_team_groups`; the organizer tries the same with `groupAssignmentMode = Auto`
**Then:** Group 1 is stored in `TournamentTeam.groupId` and `lastSeedChangeAt` is stamped; group 2 is rejected ("groupIndex must be below 2 …"); clearing unsets every `groupId`; in Auto mode both are rejected ("Group assignment is automatic for this tournament."). The size rules run at `generate_bracket` (S8c).

### Idle Tournaments Cancelled by Moderators (Phase S8b execution, A24(6))
**Given:** A tournament in Seeding last modified 2 days ago and another modified today
**When:** A Moderator calls `admin_cancel_idle_tournaments(1)`; a non-Moderator calls it
**Then:** The idle tournament is cancelled through the `cancel_tournament` path; the fresh one is untouched; an InProgress tournament whose newest bracket match changed within the window counts as active and is untouched; the non-Moderator is rejected. Draft, Completed and Cancelled tournaments are never touched.

### Tournament Settings at Creation (Phase S8b execution, A28, A29, A32, A33, A36)
**Given:** A TournamentHost+
**When:** They create a tournament with `format = DoubleElimination`, `has3rdPlaceMatch = true`; with `grandFinalBestOf = 1`, `winnerAdvantage = 1`; with a group format and `groupSize = 1`; with `groupAdvanceCount = 3`; with `countTowardsMmr = true`, `requireResultValidation = false`, `allowMirrorPicks = true`
**Then:** The first four are rejected (third place only in single elimination; the head-start rule against `grandFinalBestOf`; "groupSize must be at least 2."; "groupAdvanceCount must be 1 or 2."); the ranked one is stored with `requireResultValidation = true` and `allowMirrorPicks = false`. `update_tournament` takes the same set; format and team size change only in Draft, the rest until Seeding, and `maxParticipants` never below the registered count.

## Edge Cases

| Case | Expected Behavior |
|------|-------------------|
| Register full tournament, waitlist off | Throws "Tournament is full" |
| Register full tournament, waitlist on | Inserted with isWaitlisted=true |
| Register duplicate | Throws "Already registered" |
| Register on Draft stage | Throws stage error |
| Captain tries to leave team (solo captain) | Throws "Captain cannot leave. Use disband." |
| Disband during InProgress | Throws "Teams can only be disbanded during Registration" |
| Advance Draft → InProgress (skip) | Throws stage transition error |
| Advance backward (Seeding → Registration) | Throws stage transition error |
| Cancel completed tournament | Throws "Cannot cancel terminal state" _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Cancel already-cancelled tournament | Throws "Cannot cancel terminal state" _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Advance Registration → Seeding with pending team requests | `cleanupTeamRequests()` deletes all pending TournamentTeamRequest rows for the tournament. Teams with no accepted members are NOT deleted — only requests are cleaned up. |
| DQ already withdrawn participant | Throws "Cannot disqualify a participant who has already withdrawn" _Superseded in Phase S10g execution (backend audit 2026-11-09, dead branch)._ |
| DQ already disqualified participant | Throws "Participant is already disqualified" |
| Update tournament during InProgress | Throws "Can only update during Draft or Registration" _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Update cancelled tournament | Throws "Can only update during Draft or Registration" _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Withdraw when already withdrawn | Throws "Already withdrawn" |
| Captain withdraws from tournament (team has other members) | Captaincy transfers to lowest-userId remaining member, captain marked Withdrawn |
| Last member withdraws from team | Team destroyed (team row + all TournamentTeamMember rows deleted) |
| Cancel tournament with no infrastructure rows | Stage=Cancelled, no errors (cascade is no-op on empty tables) |
| Accept request when user has requests to other teams | Accepted request deleted, other pending requests also deleted |
| Self-assign as tournament assistant | Throws "You cannot assign yourself" |
| Promote already-TournamentHost | Throws "Can only promote users with the User role" |
| Demote a User-role player | Throws "Can only demote users with the TournamentHost role" |
| Self-promote/demote via mod reducer | Throws "You cannot change your own role" |
| Promote Admin-role user | Throws "Can only promote users with the User role. Current role: Admin" |
| Non-moderator calls promote/demote | Throws "Requires Moderator or Admin privileges" |

## Integration Points

| This Feature | Connects To | Direction |
|-------------|------------|-----------|
| Tournament.costSetId | CostSet.id | Reads |
| Tournament.maxAccountsPerPlayer | select_match_account limit | Reads (Phase 10.4) |
| TournamentPlayerAccount | HsrAccount.id | Reads/Writes |
| LobbyMemberAccount | TournamentPlayerAccount (validation) | Reads (Phase 10.4) |
| TournamentTeamMember.teamId | TournamentTeam.id | Reads/Writes |
| BracketMatch.tournamentId | Tournament.id | Phase 4 writes |
| MatchResultRecord.tournamentId | Tournament.id | Phase 3 writes |
| MmrRating | Auto-seeding | Phase 4 reads |

### Generation Withdraws Forming Teams (Phase S8c execution, A26a)
**Given:** A tournament in Seeding with seeded Ready teams and a team still Forming (its members enrolled)
**When:** Staff with the bracket permission call `generate_bracket`
**Then:** The Forming team becomes Withdrawn and its members stay enrolled; the bracket is built from the Ready teams; `bracketGeneratedAt` is stamped, which closes the promote / add / move window ("Bracket generated; use stand-ins."). Details: docs/brackets/contract.md S8c-4 to S8c-10.

### DQ Settles the Bracket (Phase S8c execution, A23, A26a(2))
**Given:** An InProgress tournament; team T in an open bracket match
**When:** Staff with the participants permission call `dq_participant(tournamentId, userId, reason, dqWholeTeam?)` for T's last member, or for any member with `dqWholeTeam = true`
**Then:** Every disqualified member's enrolment is Disqualified (rows kept); T becomes Disqualified (row kept); T's open matches are settled for the opponents (decidedBy Dq) or turned into BYE slots while the opponent is unknown. A DQ that leaves members on the team only removes that player (captain transferred; before generation the team status is refreshed, after it the team keeps its status and plays with stand-ins). In Seeding after generation the DQ stamps `lastSeedChangeAt`, so the bracket must be regenerated before InProgress.

## Acceptance Scenarios (Phase S8d execution)

### S8d-T1 A participant creates the match lobby (A34, A35, A27)
**Given** an InProgress tournament, a Ready bracket match, the caller a member of team1
**When** the caller calls `create_tournament_lobby(bracketMatchId)`
**Then** a Waiting lobby exists with the tournament's integrity set, the preset's free set, `bestOf` from the match, `bestOfNAdvantage` Blue when `winnerAdvantage > 0`; the caller is host and referee on `BluePlayer`

### S8d-T2 Staff create the lobby as a spectator referee (A34)
**Given** an assistant with `canManageBracket`, not in any lobby
**When** the assistant creates the lobby
**Then** the assistant is host and referee on `Spectator`; a second lobby for the match is rejected: "A lobby already exists for this bracket match."; a user already in a lobby is rejected by the one-lobby rule

### S8d-T3 Lobby creation preconditions
**When** the match is not Ready, the tournament is not InProgress, or the caller is neither a participant nor `bracket` staff
**Then** rejected: "<key> is <state>; a lobby needs a Ready match." · "Tournament is not in progress." · "You are not authorized to create a lobby for this bracket match."

### S8d-T4 A deleted preset falls back to the system preset (A33a)
**Given** `Tournament.lobbyPresetId` names a deleted preset
**When** a lobby is created
**Then** its free set equals the system preset's values

### S8d-T5 Stand-ins (review §5.4)
**When** `participants` staff call `approve_stand_in(matchId, team1Id, userId)`
**Then** the row carries `teamId = team1Id`; the user may sit on Blue. A member of team2, a guest, a team that does not play the match, or a duplicate is rejected; `revoke_stand_in` deletes the row ("No stand-in approval for this user in this bracket match." when none) _Superseded in Phase S10v execution (DECISIONS.md A135 to A138): see the Phase History rows for the stand-in rules._

### S8d-T6 Completed: format check and placements (A24(4))
**Given** a single-elimination tournament with every match settled and every tournament lobby parked in AwaitingResult
**When** the organizer advances to Completed
**Then** champion 1, final loser 2, third-place winner 3 (or both semifinal losers 3 without a third-place match), `finalizationStartedAt` set, one `TournamentFinalizeJob { cursor: 0 }`. A GroupInto* tournament without elimination rows is rejected: "The elimination stage has not been generated yet (advance_group_stage)."; a live (non-AwaitingResult) lobby: "N tournament lobby(ies) still open."

### S8d-T7 The finalize job (D.8.1)
**Given** a Completed MMR tournament with 6 Validated records and 1 Voided record
**When** the job runs
**Then** each tick processes at most 4 records in bracket order and reschedules first; Validated records get history rows (with `tournamentId` / `bracketMatchId`), stats, MMR (`MmrHistory.matchHistoryId` = the history row) and their lobby deleted; the Voided record is deleted without effect; the last tick rebuilds the leaderboard once and sets `finalizedAt`

### S8d-T8 Cancelled counts stats, never MMR (A24(5))
**Given** an InProgress MMR tournament with one parked Validated record and one live lobby
**When** the organizer cancels
**Then** the live lobby is voided (record Voided, lobby deleted); bracket matches, teams and assistants stay; the job finalizes the parked record with stats and no `MmrHistory` row

### Edge cases (Phase S8d execution)

| Case | Expected | Notes |
|---|---|---|
| Cancel cascade (supersedes "Cancel Tournament" / "Cancel InProgress Tournament" above) | BracketMatch, TournamentTeam, TournamentTeamMember, TournamentAssistant kept; requests, calendar events, player-account locks deleted | review §5.1, A24(5) |
| Withdrawn / Disqualified teams at Completed | no `finalPlacement` | placements rank the others |
| Job tick for a tournament row that is gone | ends silently | the job row was consumed |
| A second start of the job | no second job row | `finalizationStartedAt` re-stamped |


## Acceptance Scenarios (Phase S8e execution)

### S8e-T1 One game in play per bracket match (A67(5), D-45)
**Given** a Ready bracket match with a lobby that is not settled (Waiting, playing, or AwaitingResult with a Submitted / Disputed record)
**When** anyone calls `create_tournament_lobby` for the match
**Then** rejected: "A lobby for this bracket match is still in play."; once that lobby's record is Validated (the lobby parks) the next lobby can be created

### S8e-T2 Decided and capped matches take no lobby (A67(5))
**When** `create_tournament_lobby` is called for a decided match, or for a match whose Validated games reach `bestOf`
**Then** rejected: "<position> is Decided; a lobby needs a Ready match." / "This bracket match has no games left (best of N)."

### S8e-T3 The lobby carries no series settings (A67(2))
**When** the lobby is created
**Then** it has the integrity and free sets as before, and no `bestOf`, head start or shelving setting

### S8e-T4 Several records per match in the finalize job (A67(8))
**Given** a Bo3 match played over three lobbies, each parked with a Validated record
**When** the tournament is Completed
**Then** the job finalizes the three records in bracket order, within the match by creation time; MMR moves once per game in an MMR tournament (A67(7))

## Acceptance Scenarios (Phase S8f execution)

### S8f-T1 A DQ'd player plays the current game on (A68(6))
**Given** a tournament lobby in Drafting, Equipping or Scoring, and player P on team A, which keeps other members
**When** staff call `dq_participant(tournamentId, P)` (without `dqWholeTeam`)
**Then** P's enrolment is Disqualified and P leaves team A, but P's `LobbyMember` row in the live lobby is untouched and the game plays on; in the next lobby of the match P is not on a team, so P can only spectate; a DQ that empties team A (or `dqWholeTeam`) still settles the bracket and force-concedes the live lobby with team A's colour

### S8f-T2 An away creator gives up the match (A68(4))
**Given** a participant who pressed Leave in a live lobby ABC123
**When** they call `create_tournament_lobby` for another bracket match without `abandonCurrentMatch`
**Then** rejected: "You left lobby ABC123 mid-match. Joining here means you cannot return to it."; with `abandonCurrentMatch = true` the lobby is created and their row in ABC123 becomes abandoned

## Acceptance Scenarios (Phase S9c execution)

### S9c-T1 A team request identifies the requester to the captain (A73)
**Given** an `isAnonymousDefault` team tournament in Registration; Player B asks to join Team A
**When** Team A's captain reads `view_my_team_requests`
**Then** the request carries Player B's real `userId` and display name (not the alias or `Seat-<n>`), in every tournament; `accept_team_request` / `reject_team_request` keep taking that id; Player B's own row is unchanged

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Stages forward-only, no Paused | Phase 3 CONTEXT.md | 2026-03-17 |
| TournamentTeamRequest transactional (no isPending) | Phase 3 review | 2026-03-17 |
| Role hierarchy: Admin>Mod>TO>User | Phase 3 CONTEXT.md | 2026-03-17 |
| winnerAdvantage u8 replaces bool | Phase 3 CONTEXT.md | 2026-03-17 |
| Cost set lock→unpublish→delete lifecycle | Phase 3 CONTEXT.md | 2026-03-17 |
| Solo players auto-create TournamentTeam | Phase 4 CONTEXT.md | 2026-03-17 |
| BracketSide enum (5 variants) | Phase 4 CONTEXT.md | 2026-03-17 |
| Grand finals: single match + advantage | Phase 4 CONTEXT.md | 2026-03-17 |
| 3rd place match via has3rdPlaceMatch | Phase 4 CONTEXT.md | 2026-03-17 |
| autoAdvanceBracket toggle | Phase 4 CONTEXT.md | 2026-03-17 |
| seedNumber on TournamentTeam (not Participant) | Phase 4 CONTEXT.md | 2026-03-18 |
| GroupPhaseRecord.teamId (renamed from participantTeamId) | Phase 4 CONTEXT.md | 2026-03-18 |
| MatchResultParticipant for 2v2/3v3 | Phase 4 CONTEXT.md | 2026-03-18 |
| Team name rules by format + anonymous | Phase 4 CONTEXT.md | 2026-03-17 |
| Groups: Win=2, Draw=1, Loss=0 | Phase 4 CONTEXT.md | 2026-03-17 |
| Rollback: one step, MMR reversal Phase 5 | Phase 4 CONTEXT.md | 2026-03-17 |
| Tournament update, cancel, withdraw, waitlist/approval scenarios | Phase 3 execution | 2026-03-19 |
| Team reject, leave, disband scenarios | Phase 3 execution | 2026-03-19 |
| Tournament assistant assign/remove/self-block | Phase 3 execution | 2026-03-19 |
| Moderator promote/demote with role guards | Phase 3 execution | 2026-03-19 |
| Withdraw preserves row (status=Withdrawn), double-withdraw guard | Phase 3 execution | 2026-03-19 |
| bestOf cap {1, 3} on `defaultBestOf` (grand final follows); `winnerAdvantage < ceil(grandFinalBestOf / 2)` replaces the 0-3 range; `Tournament.lobbyPresetId` = system preset at creation, swappable through the optional `update_tournament` argument while editable; cost-set guards | Phase S6 execution (DECISIONS.md A27, A28, A33a, A38(2); backlog #2, #7, #8) | 2026-11-06 |
| Lobbies (creator host + referee, integrity / free sets, A27 advantage), stand-ins with `teamId` and `revoke_stand_in`, Completed (format check, placements, finalize job) and Cancelled (bracket / teams kept, live lobbies voided, stats without MMR); scenarios S8d-T1..T8 | Phase S8d execution (DECISIONS.md A24, A27, A33, A33a, A34, A35) | 2026-11-07 |

| Stage guard: Seeding->InProgress requires bracket rows | Phase 4 execution | 2026-03-18 |
| server_set_mmr reducer for test seeding | Phase 4 UAT | 2026-03-19 |
| participantTeamId -> teamId in GroupPhaseRecord references | Phase 04.1 execution | 2026-03-20 |
| TournamentPlayerAccount locks all HSR accounts at registration (D-21) | Phase 6 CONTEXT.md | 2026-03-21 |
| TPA rows cleaned up on withdrawal | Phase 6 execution | 2026-03-22 |
| requireOwnership inherited from tournament.requireRoster (D-19) | Phase 6 CONTEXT.md | 2026-03-21 |
| cancel_tournament cascade-deletes infrastructure rows (teams, bracket, standings, assistants, player accounts, requests) | Retroactive cleanup | 2026-03-28 |
| withdraw_from_tournament auto-disbands captain's team, cleans up pending requests | Retroactive cleanup | 2026-03-28 |
| accept_team_request cleans up user's other pending requests in tournament | Retroactive cleanup | 2026-03-28 |
| Registration→Seeding cleans up pending team requests | Retroactive cleanup | 2026-03-28 |
| Registration→Seeding cleanup edge case: teams with no accepted members preserved | Phase 9 execution | 2026-03-29 |
| TournamentEnrolled and MatchResultRecord preserved on cancellation (audit trail / player history) | Retroactive cleanup | 2026-03-28 |
| cancel_tournament cascade-deletes CalendarEvent + CalendarEventInvite via bracketMatchId FK (not tournamentId — events link to bracket matches, not tournaments directly) | Phase 08 CONTEXT.md (D-21) | 2026-03-28 |
| withdraw_from_tournament deletes player's CalendarEventInvite rows for tournament's scheduled matches | Phase 08 CONTEXT.md (D-24) | 2026-03-28 |
| TournamentParticipant split into TournamentEnrolled + TournamentTeamMember; teamGroupId removed from enrollment | Phase 10.1 execution | 2026-04-03 |
| GroupStanding renamed to GroupPhaseRecord | Phase 10.1 execution | 2026-04-03 |
| register_for_tournament no longer takes teamGroupId — enrollment and team assignment fully decoupled | Phase 10.1 execution | 2026-04-03 |
| check_in_tournament reducer: CheckIn stage + Registered status → CheckedIn | Phase 10.1 execution | 2026-04-03 |
| Captain transfer on withdrawal/DQ: captaincy to lowest-userId remaining member | Phase 10.1 execution | 2026-04-03 |
| Last member leaves/DQ'd: team destroyed | Phase 10.1 execution | 2026-04-03 |
| CheckIn stage transitions: Registration→CheckIn (when enabled), CheckIn→Seeding (auto-remove unchecked-in), Registration→Seeding (skip when disabled) | Phase 10.1 execution | 2026-04-03 |
| ParticipantStatus lifecycle: Registered→CheckedIn→Active→Eliminated | Phase 10.1 execution | 2026-04-03 |
| Series management: advance_to_next_game, shelve_series, resume_series | Phase 10.1 execution | 2026-04-03 |
| TournamentEnrolled.hsrAccountId removed — TournamentPlayerAccount is sole source of truth for locked accounts (D-23) | Phase 10.4 execution | 2026-04-04 |
| Tournament.maxAccountsPerPlayer column added (u8, default 1) — controls per-match account selection limit (D-10, D-33) | Phase 10.4 execution | 2026-04-04 |
| select_match_account: tournament path additive (up to maxAccountsPerPlayer), non-tournament path replace (always 1) | Phase 10.4 execution | 2026-04-04 |
| Stand-in TPA snapshot conditional on bracketMatchId being truthy | Phase 10.4 execution | 2026-04-04 | _Superseded in Phase S10v execution (DECISIONS.md A135 to A138): see the Phase History rows for the stand-in rules._
| view_tournament_registrant_accounts new view: locked accounts per tournament respecting rosterVisibility | Phase 10.4 execution | 2026-04-04 |
| Full hydration from codebase; Feature Overview and Reducers section added | Phase 13 normalization | 2026-04-09 |
| Phase 12.3 execution | D-H-01 finalize_match_result ordering guard: tournament-controlled matches blocked until tournament reaches Completed or Cancelled (unconditional — applies to both MMR and casual tournaments); Tournament.requireOwnership column (bool, default false) gates per-pick character ownership checks | 2026-04-12 |
| Permission matrix: ensureTournamentPermission owner / participants / bracket / results replaces the all-or-nothing assistant check | Phase S8b execution (DECISIONS.md A25) | 2026-11-07 |
| Registration closes at the move to Seeding: requests deleted, unchecked-in teams Withdrawn, random teams for opted-in solos, eligible teams Ready, others stay Forming until generation (A26a); add_team_member for staff; team-level check-in replaces per-member check-in and the no-show prune | Phase S8b execution (DECISIONS.md A26, A26a, A36a) | 2026-11-07 |
| Withdrawal deletes the enrolment (Registration / CheckIn only), Disqualified blocks re-registration, capacity excludes waitlisted and Disqualified rows, waitlist promotion until generation with locks at promotion, add_participant, reject_participant, withdraw_tournament_team | Phase S8b execution (DECISIONS.md A26a; ACCESS-SECURITY-OPS D.8.6) | 2026-11-07 |
| Minimum MMR (guests rejected, row-less players at the initial rating); rename / alias; manual groups; idle-tournament cancel | Phase S8b execution (DECISIONS.md A36b, A36a, A24(6)) | 2026-11-07 |
| `generate_bracket` withdraws teams still Forming; `dq_participant` keeps the emptied team as Disqualified and settles its open matches through `applyBracketResult` (optional `dqWholeTeam`); scenarios "Generation Withdraws Forming Teams", "DQ Settles the Bracket" | Phase S8c execution (DECISIONS.md A23, A26a) | 2026-11-07 |
| create / update arguments: grandFinalBestOf, groupAdvanceCount, groupAssignmentMode, checkInEnabled, requireResultValidation, allowMirrorPicks, lineupFormat, disconnectForfeitSeconds, optional minimumMmr and lobbyPresetId; A29 / A32 validation | Phase S8b execution (DECISIONS.md A28, A29, A32, A33, A33a, A36) | 2026-11-07 |
| Scenarios S8e-T1..T4: D-45 = one unsettled lobby per bracket match, decided / capped rejections, no series settings on the lobby, several records per match in the job; supersedes S8d-T1 (`bestOf` / `bestOfNAdvantage` copied) and the S8d-T2 duplicate-lobby message | Phase S8e execution (DECISIONS.md A67(2)(5)(7)(8)) | 2026-11-08 |
| Scenarios S8f-T1..T2: a DQ'd player plays the live game on (D-25 mid-match kick removed); `create_tournament_lobby` with `abandonCurrentMatch` | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| Scenario S9c-T1: a captain reads the requester's display name on a team request in every tournament (A37 clarification) | Phase S9c execution (DECISIONS.md A73) | 2026-11-08 |
| Rejection texts as implemented (tests `s10-tournament`, `s10-account-selection`): `cancel_tournament` on a terminal stage — "Cannot cancel a tournament that is already Completed." / "… already Cancelled."; `update_tournament` outside Draft / Registration / CheckIn — "Tournament settings can only change before Seeding." (A36); `select_match_account` — "Account selection is only allowed during the Waiting stage.", "Spectators cannot select match accounts.", "Coaches cannot select match accounts.", "This account is not locked for this tournament. Use a registered tournament account.", "This account is already selected for this match.", "Maximum accounts per player reached for this tournament." (the tournament path is additive and rejects at the limit for every `maxAccountsPerPlayer`, including 1: no replacement); `deselect_match_account` — "Account deselection is only allowed during the Waiting stage.", "This account is not selected for this match." | Phase S10 execution (DECISIONS.md A76) | 2026-11-09 |
| `create_tournament` / `update_tournament`: `disconnectPolicy` is Standard or Deferred (NoAction rejected: "The NoAction disconnect policy is only available for casual lobbies."); `disconnectForfeitSeconds` is 30 to 600, 0 or unset meaning 60 | Phase S10d execution (DECISIONS.md A92(2), A92(3)) | 2026-11-09 |
| `update_tournament`: `isAnonymousDefault` changes in Draft only ("The anonymous setting can only change in Draft.") | Phase S10g execution (DECISIONS.md A103) | 2026-11-09 |
| `lock_tournament_accounts(tournamentId, hsrAccountIds)`: a registered player who is not disqualified adds account locks from Registration through InProgress, until their own first game of the tournament has started ("Your first game of this tournament has started; accounts can no longer be locked."); locks are only added. A waitlisted player's chosen accounts (at registration or through this reducer) are remembered and locked at promotion; with none chosen, all are locked; the call is refused once the bracket is generated. A voided game counts for every member of the team that played it. Other texts: "Accounts can be locked from Registration until the tournament ends.", "Name at least one account to lock.", "You are not registered for this tournament.", "You were disqualified from this tournament.", "HSR account #<id> is not one of your accounts." | Phase S10g execution (DECISIONS.md A104) | 2026-11-09 | _Superseded in Phase S10v execution (DECISIONS.md A135 to A138): see the Phase History rows for the stand-in rules._
| Staff views (`view_my_tournaments`, `_enrolled`, `_teams`, `_team_members`, `_matches`, `_match_results`, `_lobbies`) return tournaments that are not Completed or Cancelled, to the organizer, the assistants (any flags), Moderators and Admins. Admin-only views `view_admin_tournament`, `view_admin_tournament_enrolled`, `_teams`, `_team_members`, `_matches`, `_match_results`, `_lobbies` take a tournament id and return any tournament, finished ones included; any other caller gets no rows | Phase S10g execution (DECISIONS.md A105) | 2026-11-09 | _Superseded in Phase S10s execution (DECISIONS.md A122(21)): an assistant needs at least one permission; with none, the staff views and `view_tournament_registrant_accounts` return nothing._
| `dq_participant` is accepted from Registration through InProgress only ("Tournament is <stage>; participants can be disqualified from Registration through InProgress only.") and also removes the Waiting and parked lobbies of the matches it settles; the team's live lobby is still force-conceded. The minimum-MMR check reads the active season. Captain-only reducers (accept, reject, disband, rename, withdraw, team check-in) require the captain to still be a member of the team | Phase S10g execution (backend audit 2026-11-09, tournament findings 2, 6, 8, 15) | 2026-11-09 |
| `view_tournament_registrant_accounts`: other seats of an anonymous tournament carry a neutral label ("Seat-<n> account <k>") and no owner label, user id or account id; finished tournaments return nothing; a reader who is not in the field sees only their own rows; staff see every registrant. `view_tournament_matches_for_me` returns InProgress tournaments only | Phase S10g execution (backend audit 2026-11-09, tournament findings 10, 11) | 2026-11-09 |
| Tournament entry changes are rate-limited: 10 `register_for_tournament` / `set_anonymous_alias` / `rename_tournament_team` (when the name changes) / `lock_tournament_accounts` calls per user per 60 s ("You are changing your tournament entries too quickly. Please wait a minute."); withdrawing is never counted or refused | Phase S10g execution (backend audit 2026-11-09, tournament finding 13) | 2026-11-09 |
| A guest's tournament entry moves at sign-in: the enrolment (status, alias, registration order kept, a Disqualified entry included), the team membership and captaincy, and the guest's own team requests are re-pointed to the existing user; a solo team is renamed for the new owner; bracket rows are untouched. The guest's account locks are replaced by locks on all of the existing user's game accounts (a waitlisted entry carries none). Not moved, and settled as a deletion (withdrawn before the bracket, disqualified after): the existing user already has an entry or a membership in that tournament, has no active game account where a roster is required, or is below the tournament's minimum rating. The existing user's stand-in approvals for matches their new team plays are removed. Games already played stay credited to the removed guest; a game in progress at sign-in keeps the guest's seat as left | Phase S10l execution (DECISIONS.md A112) | 2026-11-10 _Superseded in Phase S10m execution (DECISIONS.md A113)._ |
| `requireVerified` is forced on, whatever is sent, when the tournament counts towards rating, requires a roster, has a minimum MMR above 0, requires ownership, or has a roster visibility of OpenRoster or ClosedWithRating; only ClosedNoRating with none of the others leaves it to the organizer. A guest registering for such a tournament gets "This tournament requires a verified account. Link your Discord first." An update that would turn `requireVerified` on while guests are enrolled (Disqualified rows not counted) is refused: "These settings require verified accounts, and <n> guest player(s) are registered. Remove them first, or keep the settings that allow guests." | Phase S10m execution (DECISIONS.md A113) | 2026-11-10 |
| A guest cannot be made a tournament assistant ("A tournament assistant must be a verified user."). When an entry moves at sign-in (A112), the guest's calendar invites for that tournament's match events move to the existing user; a sign-in to an existing account is refused while the guest is a seated player in a running game (see the auth contract) | Phase S10m execution (DECISIONS.md A113) | 2026-11-10 |
| `reject_participant` also removes the approved entry of a guest before the bracket exists (Registration, CheckIn, Seeding before generation), as a withdrawal: no Disqualified row, the spot is freed, the guest can register again. An approved verified player, a guest upgraded in place, and an entry that is already Disqualified still get "Participant is already approved; disqualify them instead."; after the bracket exists the usual texts apply | Phase S10o execution (DECISIONS.md A118) | 2026-11-10 |
| An anonymous alias is unique among the aliases of its tournament, trimmed and case-insensitive ("That alias is already taken in this tournament. Choose another."); it is not compared with display names | Phase S10s execution (DECISIONS.md A122(20), A126) | 2026-11-10 |
| `create_tournament` and `update_tournament` need at least 2 participants; on update a date equal to the stored one is not compared with now, a changed date must be in the future, and a non-digit date gives a readable error | Phase S10s execution (DECISIONS.md A122(17), A126) | 2026-11-10 |
| A solo player promoted from the waitlist during Seeding, before the bracket exists, gets the team re-opened and Ready; team tournaments unchanged | Phase S10s execution (DECISIONS.md A122(16)) | 2026-11-10 |
| `approve_stand_in` needs a tournament in progress and a team that is not disqualified; stand-in rows, and the locks of stand-ins who are not enrolled, are removed when the tournament completes or is cancelled | Phase S10s execution (DECISIONS.md A122(19)) | 2026-11-10 | _Superseded in Phase S10v execution (DECISIONS.md A135 to A138): see the Phase History rows for the stand-in rules._
| When staff delete or ban the organizer of an unfinished tournament, the longest-serving assistant holding all three permissions becomes the organizer, else the acting Moderator or Admin; when the server identity does it, the tournament is cancelled | Phase S10s execution (DECISIONS.md A121, A124) | 2026-11-10 |
| `approve_stand_in` refuses a user whose own enrolment in the tournament is Disqualified ("A disqualified player cannot be a stand-in.") | Phase S10t execution (DECISIONS.md A128) | 2026-11-10 |
| `approve_stand_in`: staff with the participants permission, from bracket generation until the tournament ends, for an open match (Pending or Ready, no bye) of a team that is not disqualified. Refused: the caller themself; the organizer and any assistant of the tournament; a guest; a user who fails the registration requirements (verified account, active game account under `requireRoster` or `requireOwnership`, minimum rating: the text does not print the rating); a member of a team that is still in (Forming, Ready, Active); a disqualified player; a member of the other team of the match; any stand-in in a solo tournament. No cap on approvals | Phase S10v execution (DECISIONS.md A135, A136, A137) | 2026-11-10 |
| An approval is removed (with the unseat in Waiting lobbies, the invite and the release of unused locks) by `revoke_stand_in`, a disqualification, the user becoming an assistant or the organizer, the user's own team becoming active again (roll-back, entry transfer), a slot of the match changing team, and at Completed or Cancelled. Staff see approvals in `view_my_tournament_stand_ins`; the stand-in sees the match in `view_tournament_matches_for_me` and its calendar event | Phase S10v execution (DECISIONS.md A135) | 2026-11-10 |
| A stand-in's accounts are locked at their own first participation in a lobby of the match (creating it, joining, taking a seat, confirming ready), not at approval, and not once they have played a game of the tournament; `lock_tournament_accounts` accepts an approved stand-in within the A104 limit. `register_for_tournament` needs an active game account under `requireOwnership` as under `requireRoster` | Phase S10v execution (DECISIONS.md A135, A137) | 2026-11-10 |
| A stand-in approval alone does not allow `create_tournament_lobby` ("A stand-in cannot create the match lobby: a team member or tournament staff creates it."): a member of one of the two teams creates it, or the organizer, an assistant with the bracket permission, a Moderator or an Admin; a Moderator or Admin who is an approved stand-in creates through the role and is seated as Spectator. The stand-in lock entry point "creating the lobby" applies to that role case only | Phase S10v execution (DECISIONS.md A140) | 2026-11-10 |
| `BracketMatch.scheduledAt` is the start of the match's calendar event: written when staff create the event, moved with it, cleared when the event is deleted _Superseded in Phase S10ad execution (DECISIONS.md A160(6), A161(3))._ | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| `BracketMatch.scheduledAt` survives the retention of its calendar event (90 days after the end); a staff resolve, rollback, cancel, disqualification or regeneration clears it also when the event is gone | Phase S10ad execution (DECISIONS.md A160(6), A161(3)) | 2026-11-11 |

---

*Last updated: 2026-11-07*
*Feature owner: Phase 3 / Phase 12.3*
