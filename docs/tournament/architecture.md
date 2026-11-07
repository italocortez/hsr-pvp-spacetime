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

> **Phase S8b execution (2026-11-07).** The sections below, down to `dq_participant`, were rewritten for S8b: the
> A25 permission helper, the review §5.1 stage machine on the shared guards (`shared/bracket`, S8a), the A26 / A26a
> team and participant rules, team-level check-in, the D.8.6 waitlist window, A36b minimum MMR and the A36a naming,
> random teams and manual groups. Bracket reducers, lobbies, results and finalization are S8c / S8d and keep their
> pre-S8b flows (only their permission call changed). Scenarios: [contract.md](contract.md) "Phase S8b execution".

### Permission helper: ensureTournamentPermission(ctx, tournamentId, perm) (A25)

`helpers/tournamentPermissions.ts`; replaces `ensureTournamentAccess` (deleted). Returns `{ user, tournament }`.

| perm | Organizer, Moderator+ | Assistant | Rejection text |
|---|---|---|---|
| `owner` | yes | never | `Only the organizer or a Moderator can change this tournament's settings, stages or staff.` |
| `participants` | yes | `canManageParticipants` | `This action needs the participants permission.` |
| `bracket` | yes | `canManageBracket` | `This action needs the bracket permission.` |
| `results` | yes | `canResolveResults` | `This action needs the results permission.` |

`hasTournamentPermission(ctx, user, tournament, perm)` is the non-throwing form (used by `check_in_tournament`).

| Reducer | perm |
|---|---|
| `update_tournament`, `advance_tournament_stage` (except Seeding → InProgress), `cancel_tournament`, `assign_tournament_assistant`, `remove_tournament_assistant` | `owner` |
| `advance_tournament_stage` Seeding → InProgress, `assign_team_group`, `clear_team_groups`, `generate_bracket`, `seed_bracket`, `swap_seeds`, `advance_group_to_elimination`, `create_calendar_event` (tournament-linked) | `bracket` |
| `approve_participant`, `reject_participant`, `waitlist_promote`, `add_participant`, `add_team_member`, `dq_participant`, `check_in_tournament` with another team's `teamId` | `participants` |
| `advance_bracket_match`, `rollback_bracket_match`, `override_match_result`, `finalize_match_result` (tournament authority path), `process_tournament_mmr` | `results` |
| `create_tournament` | `ensureTournamentHost` (D-B1), unchanged |
| `admin_cancel_idle_tournaments` | `ensureModerator` |

### Stage machine (review §5.1)

`advance_tournament_stage(tournamentId, nextStage)`. `validateStageTransition` (forward-only, CheckIn skippable, Cancelled from any non-terminal stage) runs first, then:

| Transition | Guard | Effects |
|---|---|---|
| Draft → Registration | `canOpenRegistration` (stage, A29); `ensureSelectableCostSet` (R2); group formats: `groupSize ≥ 2`, `groupAdvanceCount ∈ {1, 2}`; `defaultBestOf`, `grandFinalBestOf ∈ {1, 3}` (A28); `winnerAdvantage < ceil(grandFinalBestOf / 2)` (A27) | — |
| Registration → CheckIn | `checkInEnabled` (`Check-in is disabled for this tournament: move to Seeding.`) | Registration closes (A26a: the transition out of Registration): `closeRegistration` = delete pending team requests, `formRandomTeams` (A36a), refresh every team status; random teams then check in like any team |
| Registration → Seeding, CheckIn → Seeding | `canCloseRegistration` (from Registration only when check-in is off; ≥ 2 eligible teams after the effects) | `enterSeeding`: from Registration, `closeRegistration` first (all close effects at once); from CheckIn, Forming / Ready teams with no CheckedIn member → Withdrawn (members stay enrolled); then eligible teams → Ready, the others stay Forming with their members (A26a: staff may still promote, add or move players; teams still Forming at generation are Withdrawn by `generate_bracket`, S8c marker) |
| Seeding → InProgress (`owner` or `bracket`) | `validateSeedingToInProgress` → `canStartInProgress` (bracket generated, `bracketGeneratedAt ≥ lastSeedChangeAt`, every round-1 Winners / Group match holds a team; GroupInto* formats check the group rows only); group formats: every Ready team has `groupId` | `activateTeams`: Ready → Active; their members' Registered / CheckedIn enrolments → Active |
| InProgress → Completed | unchanged (S8d) | stage only (S8d adds the `TournamentFinalizeJob`) |
| any → Cancelled | not terminal | `cancelTournament` (same path as `cancel_tournament`) |

Eligible team (`isEligibleTeam`, shared): status Forming or Ready, exactly `teamSize` members, every member enrolled, not waitlisted, approved when `requireApproval`, status Registered or CheckedIn. A failing guard throws its `reason` as a `SenderError` (`ensureGuard`); the pure module's plain `Error`s are avoided by validating `groupSize` / `groupAdvanceCount` / the team count first.

### Team status machine (A26)

`Forming ⇄ Ready` follows `refreshTeamStatus` after every membership, approval or promotion change (participants never set it); `Ready → Active` at Seeding → InProgress; `Forming / Ready → Withdrawn` at CheckIn → Seeding when not checked in, by `withdraw_tournament_team`, when the last member leaves the team from CheckIn on (withdrawal or staff rejection), or (Forming) at bracket generation (A26a, S8c); Eliminated / Disqualified are set by the bracket and staff (S8c). A team is deleted only in Registration (disband, last member leaves or withdraws); never after registration closes (TD-18), except by the cancel cascade (unchanged until S8d).

### create_tournament / update_tournament (A28, A29, A32, A33, A33a, A36)

Arguments (both): `name, description, format, teamSize, maxParticipants, rosterVisibility, isAnonymousDefault, disconnectPolicy, disconnectForfeitSeconds?, costSetId, defaultBestOf, grandFinalBestOf, winnerAdvantage, groupSize, groupAdvanceCount, groupAssignmentMode, has3rdPlaceMatch, checkInEnabled, requireResultValidation, requireOwnership, allowMirrorPicks, lineupFormat, lobbyPresetId?, requireVerified, requireRoster, minimumMmr?, requireApproval, waitlistEnabled, scheduledStartAt, registrationDeadline, maxAccountsPerPlayer`. `create_tournament` adds `defaultGameMode, countTowardsMmr`; `update_tournament` adds `tournamentId`.

1. `create_tournament`: `ensureTournamentHost`. `update_tournament`: `owner`; stage Draft, Registration or CheckIn (`Tournament settings can only change before Seeding.`); `format` / `teamSize` differ from the row outside Draft → `Format and team size can only change in Draft.`; `maxParticipants` below the capacity count → rejected.
2. Validation (`validateSettings`): name 1–100, description ≤ 2000, teamSize 1–3, enum tags (`validateEnumTag`), both bestOf ∈ {1, 3}, `winnerAdvantage < ceil(grandFinalBestOf / 2)`, `has3rdPlaceMatch` only where `allowsThirdPlace(format)`, `groupSize ≥ 2` for group formats, `groupAdvanceCount ∈ {1, 2}`, `maxAccountsPerPlayer ≤ 10`, timestamps in the future and ordered.
3. Derived: `requireResultValidation = countTowardsMmr || argument`; `allowMirrorPicks = false` when `countTowardsMmr` (D-42); `disconnectForfeitSeconds` / `minimumMmr` 0 → unset.
4. `lobbyPresetId` (A33a, `ensureTournamentPreset`): omitted on create = the system preset; given = the system preset or one the organizer owns; omitted on update = unchanged. Cost-set guards as before (R2, D-D6).
5. `defaultGameMode` and `countTowardsMmr` are fixed after creation.

### cancel_tournament(tournamentId) / admin_cancel_idle_tournaments(idleDays)
1. `cancel_tournament`: `owner`; `cancelTournament` = `validateStageTransition(…, 'Cancelled')` + `cascadeCleanupTournament` (unchanged order) + stage Cancelled.
2. `admin_cancel_idle_tournaments(idleDays: u8)` (A24(6)): `ensureModerator`; `idleDays ≥ 1`; every tournament in Registration / CheckIn / Seeding / InProgress (`Tournament.stage` index) whose last activity is older than `idleDays` days (`ctx.timestamp`) goes through `cancelTournament`; last activity = `lastModifiedDate`, and for InProgress the newest `BracketMatch.lastModifiedDate` of the tournament too, so a tournament playing matches is never cancelled; logs the count. The stage set is wider than A24(6)'s "in-progress" wording (flagged to the user).

### register_for_tournament(tournamentId, hsrAccountIds?, anonymousAlias?, allowRandomTeamAssignment?)
1. Stage Registration only (`Tournament is not accepting registrations.`).
2. Existing row: Disqualified → `You were disqualified from this tournament.` (A26a(2)); otherwise already registered.
3. `requireVerified` rejects guests; `requireRoster` needs an active `HsrAccount`.
4. `minimumMmr` (A36b): guests → `Guests cannot join a tournament with a minimum MMR.`; rating = `MmrRating.by_user_mode_season[userId, defaultGameMode, seasonId]?.rating ?? EloConfigTable(1).initialRating` (no config row → the finalization error); below → rejected.
5. `anonymousAlias` only in anonymous tournaments, 1–32 characters trimmed.
6. Capacity = rows neither waitlisted nor Disqualified (`capacityCount`, C-a11); full → waitlisted when `waitlistEnabled`, otherwise `Tournament is full.`
7. Insert `TournamentEnrolled` (Registered; `approvedByToAt` unset when `requireApproval`).
8. `teamSize = 1`: `createSoloTeam`, named by `soloTeamName` (A36a / A37): the display name in a non-anonymous tournament; in an anonymous one the alias, or a neutral `Player <n>` (n = the enrolment count, first free number) until `set_anonymous_alias`, so the display name never reaches the team name. Auto names are unique in the tournament (case-insensitive): a collision appends ` (2)`, ` (3)`, … (also for `add_participant`, whose target gets `Player <n>` in an anonymous tournament).
9. Not waitlisted: `lockPlayerAccounts` (`hsrAccountIds` must be the player's own; omitted = all accounts). Waitlisted: locks at promotion (A26a(4)).

### withdraw_from_tournament(tournamentId) / withdraw_tournament_team(teamId)
1. `withdraw_from_tournament`: Registration or CheckIn (else `Registration is closed; ask staff.`); a Disqualified row cannot withdraw (T23). `removeEnrolment`: `removeTeamMember` (captain transfer, member deleted; when the team is left empty it is deleted in Registration and marked Withdrawn from CheckIn on, TD-18; otherwise its status is refreshed: T2 fix), the user's requests in this tournament (by `user_id`, orphans included: T24), calendar invites, account locks, then the enrolment row (A26a(1)).
2. `withdraw_tournament_team`: the captain; Registration or CheckIn; team Forming or Ready → Withdrawn; requests to the team deleted; members stay enrolled and on the team.

### check_in_tournament(tournamentId, teamId?) (A26)
CheckIn stage; `teamId` omitted = the caller's team and the caller must captain it; given = its captain or `participants` staff. Team Forming or Ready and not yet checked in; every Registered member → CheckedIn. A team counts as checked in when a member is CheckedIn (`isTeamCheckedIn`). No per-member path and no no-show prune (`removeUncheckedInParticipants` deleted).

### approve_participant / reject_participant / waitlist_promote / add_participant (tournamentId, userId)
All `participants`.
1. `approve_participant`: sets `approvedByToAt`; refreshes the player's team.
2. `reject_participant`: before generation (`ensureBeforeGeneration`); only a row awaiting approval or waitlisted (`Participant is already approved; disqualify them instead.`); `removeEnrolment`.
3. `waitlist_promote` (D.8.6): Registration through Seeding until `bracketGeneratedAt` (`Bracket generated; use stand-ins.`); a free spot (`No free spot: the tournament is full.`); `isWaitlisted = false`, approval implied, `lockPlayerAccounts` (all accounts), team refreshed.
4. `add_participant`: same window; the target exists, is not deleted and is verified; not enrolled (Disqualified blocks); a free spot; inserts an approved, non-waitlisted Registered row; solo auto-team; account locks.

### add_team_member(teamId, userId) (A26a)
`participants`; Registration, CheckIn or Seeding until `bracketGeneratedAt` (`ensureBeforeGeneration`: `Bracket generated; use stand-ins.`). The player is enrolled, not Disqualified, approved when required (`The player awaits approval.`), not waitlisted (`The player is on the waitlist; promote them first.`) and teamless (`The player is already on a team.`); the team is Forming or Ready (`Team is <status>.`) with room (`Team is already full.`). The player's pending requests are deleted; `refreshTeamStatus` afterwards.

### set_anonymous_alias(tournamentId, alias) (A36a)
Enrolled caller; tournament anonymous; Registration or CheckIn; alias 1–32 trimmed; in a solo tournament the player's team is renamed to the alias (made unique with ` (2)`, ` (3)`, … on a collision).

### Teams: create / request_join / accept / reject / leave / disband / rename (A26, A26a, A36a)
1. Registration only for every participant team edit (`ensureRegistration`), except `rename_tournament_team` (Registration or CheckIn).
2. Joining (`create_tournament_team` creator, `request_join_team` requester, `accept_team_request` target): enrolled, not Disqualified, approved when required, teamless (T13); waitlisted players may (A26a(4)).
3. `create_tournament_team(tournamentId, teamName)`: team tournaments; name via `normalizeTeamName` (1–40, trimmed, unique case-insensitive); status Forming; the creator's pending requests deleted.
4. `request_join_team(teamId)`: team Forming and below `teamSize`; one request per team.
5. `accept_team_request(teamId, userId)` / `reject_team_request`: captain only; accept re-checks room and the target, deletes all of the target's requests in the tournament, inserts the member, refreshes the status.
6. `leave_tournament_team(teamId)`: Registration (T10); not in solo tournaments; `removeTeamMember`.
7. `disband_tournament_team(teamId)`: captain; Registration; not in solo tournaments; `deleteTeam` (members, requests, team).
8. `rename_tournament_team(teamId, name)`: captain; Registration or CheckIn; not solo; `normalizeTeamName` excluding itself.

### Manual groups: assign_team_group(tournamentId, teamId, groupIndex) / clear_team_groups(tournamentId) (A36a, A32)
`bracket`; Seeding; group format; `groupAssignmentMode = Manual`. Assign: a Ready team of the tournament; `groupIndex < groupCount(readyTeams, groupSize)`; writes `TournamentTeam.groupId` (0-based, as `insertGroupBracket`). Clear: unsets every `groupId`. A change stamps `Tournament.lastSeedChangeAt`. Group sizes are validated by `generate_bracket` (S8c).

### assign_tournament_assistant(tournamentId, userId, canManageParticipants, canManageBracket, canResolveResults) / remove_tournament_assistant(tournamentId, userId)
`owner`. Assign upserts the row with the three A25 flags (existing row updated in place, as before); assigning oneself is rejected (so an organizer cannot list themself; a Moderator may list the organizer, which grants nothing new). Remove deletes the row. `mod_promote_to_host` / `mod_demote_from_host` are unchanged (`ensureModerator`).

### dq_participant(tournamentId, userId, reason)
`participants` (A25). The rest of the flow is unchanged until S8c (advancement through `applyBracketResult`):
- Captain DQ: `transferTournamentCaptain()` to next member (D-21); team survives
- Last member DQ: delete team; auto-advance opponent on any active BracketMatch (D-27)
- DQ during active lobby (Drafting/Equipping/Scoring): kick player; if last member: force-concede match (D-25)
- Set `TournamentEnrolled.status=Disqualified`

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
| `ensureTournamentPermission(ctx, id, 'owner' \| 'participants' \| 'bracket' \| 'results')` replaces `ensureTournamentAccess`; every tournament reducer names its permission (A25) | Phase S8b execution | 2026-11-07 |
| Stage machine on the shared guards (`canOpenRegistration`, `canCloseRegistration`, `canStartInProgress`); registration closes on the transition out of Registration (requests deleted, random teams formed); entering Seeding: unchecked-in teams Withdrawn on the CheckIn path, eligible teams Ready, the others stay Forming until generation (A24(6) idle cancel, A26, A26a, A36a, review §5.1) | Phase S8b execution | 2026-11-07 |
| Team status Forming ⇄ Ready derived by `refreshTeamStatus` (`isEligibleTeam`); Ready → Active at InProgress; status gating replaces "informational only" for teams (A26) | Phase S8b execution | 2026-11-07 |
| Check-in is team-level (`check_in_tournament(tournamentId, teamId?)`); `removeUncheckedInParticipants` and the per-member path deleted (A26, review T2) | Phase S8b execution | 2026-11-07 |
| Withdrawal deletes the enrolment (Registration / CheckIn only); capacity excludes waitlisted and Disqualified rows; Disqualified blocks re-registration; waitlist promotion until generation with account locks at promotion; `add_participant`, `reject_participant`, `withdraw_tournament_team` (A26a, D.8.6, C-a11, T23, T24) | Phase S8b execution | 2026-11-07 |
| `minimumMmr` check (A36b), alias + `rename_tournament_team` + `set_anonymous_alias`, manual groups `assign_team_group` / `clear_team_groups` (A36a) | Phase S8b execution | 2026-11-07 |
| create / update arguments: the A36 set (`checkInEnabled`, `groupAdvanceCount`, `disconnectForfeitSeconds`, `requireResultValidation`, `grandFinalBestOf`, `groupAssignmentMode`, `lineupFormat`, `allowMirrorPicks`, `minimumMmr?`, `lobbyPresetId?`) with A28 / A29 / A32 validation | Phase S8b execution | 2026-11-07 |

---

*Last updated: 2026-04-12*
*Feature owner: Phase 04 / Phase 06 / Phase 08 / Phase 10.1 / Phase 10.4 / Phase 12.3*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
