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

TournamentWaitlistAccount (private; S10g, A104): same columns as TournamentPlayerAccount; a waitlisted registrant's chosen
  accounts, locked at promotion. Indexes: tournament_id, by_tournament_and_user, by_user.
```

## Reducer Flows

> **Phase S8b execution (2026-11-07).** The sections below, down to `dq_participant`, were rewritten for S8b: the
> A25 permission helper, the review §5.1 stage machine on the shared guards (`shared/bracket`, S8a), the A26 / A26a
> team and participant rules, team-level check-in, the D.8.6 waitlist window, A36b minimum MMR and the A36a naming,
> random teams and manual groups. Bracket reducers, lobbies, results and finalization are S8c / S8d and keep their
> pre-S8b flows (only their permission call changed). Scenarios: [contract.md](contract.md) "Phase S8b execution".

### Permission helper: ensureTournamentPermission(ctx, tournamentId, perm) (A25)

`helpers/tournament/tournamentPermissions.ts`; replaces `ensureTournamentAccess` (deleted). Returns `{ user, tournament }`.

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
| `advance_tournament_stage` Seeding → InProgress, `assign_team_group`, `clear_team_groups`, `generate_bracket`, `seed_bracket`, `set_seed_order`, `advance_group_stage`, `create_calendar_event` (tournament-linked) | `bracket` |
| `approve_participant`, `reject_participant`, `waitlist_promote`, `add_participant`, `add_team_member`, `dq_participant`, `check_in_tournament` with another team's `teamId` | `participants` |
| `resolve_bracket_match`, `rollback_bracket_match`, `override_match_result`, `finalize_match_result` (tournament authority path), `process_tournament_mmr` | `results` |
| `create_tournament` | `ensureTournamentHost` (D-B1), unchanged |
| `admin_cancel_idle_tournaments` | `ensureModerator` |

### Stage machine (review §5.1)

`advance_tournament_stage(tournamentId, nextStage)`. `validateStageTransition` (forward-only, CheckIn skippable, Cancelled from any non-terminal stage) runs first, then:

| Transition | Guard | Effects |
|---|---|---|
| Draft → Registration | `canOpenRegistration` (stage, A29); `ensureSelectableCostSet` (R2); group formats: `groupSize ≥ 2`, `groupAdvanceCount ∈ {1, 2}`; `defaultBestOf`, `grandFinalBestOf ∈ {1, 3}` (A28); `winnerAdvantage < ceil(grandFinalBestOf / 2)` (A27) | — |
| Registration → CheckIn | `checkInEnabled` (`Check-in is disabled for this tournament: move to Seeding.`) | Registration closes (A26a: the transition out of Registration): `closeRegistration` = delete pending team requests, `formRandomTeams` (A36a), refresh every team status; random teams then check in like any team |
| Registration → Seeding, CheckIn → Seeding | `canCloseRegistration` (from Registration only when check-in is off; ≥ 2 eligible teams after the effects) | `enterSeeding`: from Registration, `closeRegistration` first (all close effects at once); from CheckIn, Forming / Ready teams with no CheckedIn member → Withdrawn (members stay enrolled); then eligible teams → Ready, the others stay Forming with their members (A26a: staff may still promote, add or move players; teams still Forming at generation are Withdrawn by `generate_bracket`, S8c) |
| Seeding → InProgress (`owner` or `bracket`) | `validateSeedingToInProgress` → `canStartInProgress` (bracket generated, `bracketGeneratedAt ≥ lastSeedChangeAt`, every round-1 Winners / Group match holds a team; GroupInto* formats check the group rows only); group formats: every Ready team has `groupId` | `activateTeams`: Ready → Active; their members' Registered / CheckedIn enrolments → Active |
| InProgress → Completed | unchanged (S8d) | stage only (S8d adds the `TournamentFinalizeJob`) |
| any → Cancelled | not terminal | `cancelTournament` (same path as `cancel_tournament`) |

Eligible team (`isEligibleTeam`, shared): status Forming or Ready, exactly `teamSize` members, every member enrolled, not waitlisted, approved when `requireApproval`, status Registered or CheckedIn. A failing guard throws its `reason` as a `SenderError` (`ensureGuard`); the pure module's plain `Error`s are avoided by validating `groupSize` / `groupAdvanceCount` / the team count first.

### Team status machine (A26)

`Forming ⇄ Ready` follows `refreshTeamStatus` after every membership, approval or promotion change (participants never set it); `Ready → Active` at Seeding → InProgress; `Forming / Ready → Withdrawn` at CheckIn → Seeding when not checked in, by `withdraw_tournament_team`, when the last member leaves the team from CheckIn on (withdrawal or staff rejection), or (Forming) at bracket generation (A26a, S8c); Eliminated / Disqualified are set by the bracket and staff (S8c). A team is deleted only in Registration (disband, last member leaves or withdraws); never after registration closes (TD-18), except by the cancel cascade (unchanged until S8d).

### create_tournament / update_tournament (A28, A29, A32, A33, A33a, A36)

Arguments (both): `name, description, format, teamSize, maxParticipants, rosterVisibility, isAnonymousDefault, disconnectPolicy, disconnectForfeitSeconds?, costSetId, defaultBestOf, grandFinalBestOf, winnerAdvantage, groupSize, groupAdvanceCount, groupAssignmentMode, has3rdPlaceMatch, checkInEnabled, requireResultValidation, requireOwnership, allowMirrorPicks, lineupFormat, lobbyPresetId?, requireVerified, requireRoster, minimumMmr?, requireApproval, waitlistEnabled, scheduledStartAt, registrationDeadline, maxAccountsPerPlayer`. `create_tournament` adds `defaultGameMode, countTowardsMmr`; `update_tournament` adds `tournamentId`.

1. `create_tournament`: `ensureTournamentHost`. `update_tournament`: `owner`; stage Draft, Registration or CheckIn (`Tournament settings can only change before Seeding.`); `format` / `teamSize` differ from the row outside Draft → `Format and team size can only change in Draft.`; `isAnonymousDefault` differs outside Draft → `The anonymous setting can only change in Draft.` (A103, S10g); `maxParticipants` below the capacity count → rejected.
2. Validation (`validateSettings`): name 1–100, description ≤ 2000, teamSize 1–3, enum tags (`validateEnumTag`), both bestOf ∈ {1, 3}, `winnerAdvantage < ceil(grandFinalBestOf / 2)`, `has3rdPlaceMatch` only where `allowsThirdPlace(format)`, `groupSize ≥ 2` for group formats, `groupAdvanceCount ∈ {1, 2}`, `maxAccountsPerPlayer ≤ 10`, timestamps in the future and ordered.
3. Derived: `requireResultValidation = countTowardsMmr || argument`; `allowMirrorPicks = false` when `countTowardsMmr` (D-42); `disconnectForfeitSeconds` / `minimumMmr` 0 → unset; `requireVerified = forcesRequireVerified(…) || argument` and, on update, the guest-enrolment refusal (A113, see "Phase S10m execution").
4. `lobbyPresetId` (A33a, `ensureTournamentPreset`): omitted on create = the system preset; given = the system preset or one the organizer owns; omitted on update = unchanged. Cost-set guards as before (R2, D-D6).
5. `defaultGameMode` and `countTowardsMmr` are fixed after creation.

### cancel_tournament(tournamentId) / admin_cancel_idle_tournaments(idleDays)
1. `cancel_tournament`: `owner`; `cancelTournament` = `validateStageTransition(…, 'Cancelled')` + `cascadeCleanupTournament` (unchanged order) + stage Cancelled.
2. `admin_cancel_idle_tournaments(idleDays: u8)` (A24(6)): `ensureModerator`; `idleDays ≥ 1`; every tournament in Registration / CheckIn / Seeding / InProgress (`Tournament.stage` index) whose last activity is older than `idleDays` days (`ctx.timestamp`) goes through `cancelTournament`; last activity = `lastModifiedDate`, and for InProgress the newest `BracketMatch.lastModifiedDate` of the tournament too, so a tournament playing matches is never cancelled; logs the count. The stage set is wider than A24(6)'s "in-progress" wording (flagged to the user).

### register_for_tournament(tournamentId, hsrAccountIds?, anonymousAlias?, allowRandomTeamAssignment?)
1. Stage Registration only (`Tournament is not accepting registrations.`).
2. Existing row: Disqualified → `You were disqualified from this tournament.` (A26a(2)); otherwise already registered.
3. `requireVerified` rejects guests; `requireRoster` needs an active `HsrAccount`.
4. `minimumMmr` (A36b): guests → `Guests cannot join a tournament with a minimum MMR.`; rating = `MmrRating.by_user_mode_season[userId, defaultGameMode, <active season id>]?.rating ?? EloConfigTable(1).initialRating` (no config row → the finalization error); below → rejected. S10g (audit #6): the active season is the `Season` row with `isActive` (else 0), as the rating writer resolves it; `Tournament.seasonId` is not read.
5. `anonymousAlias` only in anonymous tournaments, 1–32 characters trimmed.
6. Capacity = rows neither waitlisted nor Disqualified (`capacityCount`, C-a11); full → waitlisted when `waitlistEnabled`, otherwise `Tournament is full.`
7. Insert `TournamentEnrolled` (Registered; `approvedByToAt` unset when `requireApproval`).
8. `teamSize = 1`: `createSoloTeam`, named by `soloTeamName` (A36a / A37): the display name in a non-anonymous tournament; in an anonymous one the alias, or a neutral `Player <n>` (n = the enrolment count, first free number) until `set_anonymous_alias`, so the display name never reaches the team name. Auto names are unique in the tournament (case-insensitive): a collision appends ` (2)`, ` (3)`, … (also for `add_participant`, whose target gets `Player <n>` in an anonymous tournament).
9. Not waitlisted: `lockPlayerAccounts` (`hsrAccountIds` must be the player's own; omitted = all accounts). Waitlisted: locks at promotion (A26a(4)); S10g (A104): given `hsrAccountIds` are remembered in `TournamentWaitlistAccount` (`rememberWaitlistAccounts`).
10. S10g (audit #13): `consumeTournamentAllowance` (see "Phase S10g execution").

### withdraw_from_tournament(tournamentId) / withdraw_tournament_team(teamId)
1. `withdraw_from_tournament`: Registration or CheckIn (else `Registration is closed; ask staff.`); a Disqualified row cannot withdraw (T23). `removeEnrolment`: `removeTeamMember` (captain transfer, member deleted; when the team is left empty it is deleted in Registration and marked Withdrawn from CheckIn on, TD-18; otherwise its status is refreshed: T2 fix), the user's requests in this tournament (by `user_id`, orphans included: T24), calendar invites, account locks, then the enrolment row (A26a(1)).
2. `withdraw_tournament_team`: the captain; Registration or CheckIn; team Forming or Ready → Withdrawn; requests to the team deleted; members stay enrolled and on the team.

### check_in_tournament(tournamentId, teamId?) (A26)
CheckIn stage; `teamId` omitted = the caller's team and the caller must captain it; given = its captain or `participants` staff. Team Forming or Ready and not yet checked in; every Registered member → CheckedIn. A team counts as checked in when a member is CheckedIn (`isTeamCheckedIn`). No per-member path and no no-show prune (`removeUncheckedInParticipants` deleted).

### approve_participant / reject_participant / waitlist_promote / add_participant (tournamentId, userId)
All `participants`.
1. `approve_participant`: sets `approvedByToAt`; refreshes the player's team.
2. `reject_participant`: before generation (`ensureBeforeGeneration`); only a row awaiting approval or waitlisted (`Participant is already approved; disqualify them instead.`); `removeEnrolment`.
3. `waitlist_promote` (D.8.6): Registration through Seeding until `bracketGeneratedAt` (`Bracket generated; use stand-ins.`); a free spot (`No free spot: the tournament is full.`); `isWaitlisted = false`, approval implied, `lockAccountsAtPromotion` (S10g, A104: the remembered accounts the player still owns, else all accounts; the remembered rows deleted), team refreshed.
4. `add_participant`: same window; the target exists, is not deleted and is verified; not enrolled (Disqualified blocks); a free spot; inserts an approved, non-waitlisted Registered row; solo auto-team; account locks.

### add_team_member(teamId, userId) (A26a)
`participants`; Registration, CheckIn or Seeding until `bracketGeneratedAt` (`ensureBeforeGeneration`: `Bracket generated; use stand-ins.`). The player is enrolled, not Disqualified, approved when required (`The player awaits approval.`), not waitlisted (`The player is on the waitlist; promote them first.`) and teamless (`The player is already on a team.`); the team is Forming or Ready (`Team is <status>.`) with room (`Team is already full.`). The player's pending requests are deleted; `refreshTeamStatus` afterwards.

### set_anonymous_alias(tournamentId, alias) (A36a)
Enrolled caller; tournament anonymous; Registration or CheckIn; alias 1–32 trimmed; in a solo tournament the player's team is renamed to the alias (made unique with ` (2)`, ` (3)`, … on a collision). S10g: counted by `consumeTournamentAllowance` (audit #13).

### Teams: create / request_join / accept / reject / leave / disband / rename (A26, A26a, A36a)
1. Registration only for every participant team edit (`ensureRegistration`), except `rename_tournament_team` (Registration or CheckIn).
2. Joining (`create_tournament_team` creator, `request_join_team` requester, `accept_team_request` target): enrolled, not Disqualified, approved when required, teamless (T13); waitlisted players may (A26a(4)).
3. `create_tournament_team(tournamentId, teamName)`: team tournaments; name via `normalizeTeamName` (1–40, trimmed, unique case-insensitive); status Forming; the creator's pending requests deleted.
4. `request_join_team(teamId)`: team Forming and below `teamSize`; one request per team.
5. `accept_team_request(teamId, userId)` / `reject_team_request`: captain only; accept re-checks room and the target, deletes all of the target's requests in the tournament, inserts the member, refreshes the status.
6. `leave_tournament_team(teamId)`: Registration (T10); not in solo tournaments; `removeTeamMember`.
7. `disband_tournament_team(teamId)`: captain (S10g, audit #15: `captainUserId` and a membership of the team, so a DQ'd ex-captain is refused); Registration; not in solo tournaments; `deleteTeam` (members, requests, team).
8. `rename_tournament_team(teamId, name)`: captain (same membership rule); Registration or CheckIn; not solo; `normalizeTeamName` excluding itself; a change is counted by `consumeTournamentAllowance` (S10g, audit #13).

### Manual groups: assign_team_group(tournamentId, teamId, groupIndex) / clear_team_groups(tournamentId) (A36a, A32)
`bracket`; Seeding; group format; `groupAssignmentMode = Manual`. Assign: a Ready team of the tournament; `groupIndex < groupCount(readyTeams, groupSize)`; writes `TournamentTeam.groupId` (0-based, as `insertGroupBracket`). Clear: unsets every `groupId`. A change stamps `Tournament.lastSeedChangeAt`. Group sizes are validated by `generate_bracket` (S8c: every Ready team grouped, exactly `groupCount` groups, each ≥ `groupSize`, sizes within one); generation clears and rewrites every `groupId`.

### assign_tournament_assistant(tournamentId, userId, canManageParticipants, canManageBracket, canResolveResults) / remove_tournament_assistant(tournamentId, userId)
`owner`. Assign upserts the row with the three A25 flags (existing row updated in place, as before); a guest target is rejected (`A tournament assistant must be a verified user.`, A113(6), S10m); assigning oneself is rejected (so an organizer cannot list themself; a Moderator may list the organizer, which grants nothing new). Remove deletes the row. `mod_promote_to_host` / `mod_demote_from_host` are unchanged (`ensureModerator`).

### dq_participant(tournamentId, userId, reason, dqWholeTeam?)
`participants` (A25). **Phase S8c execution:** the enrolment becomes Disqualified (row kept, A26a(2)); the player (with `dqWholeTeam` every member, enrolments Disqualified too) leaves the team, captain transferred (D-21); a team left non-empty gets `refreshTeamStatus` only before generation (after it the team keeps its status and plays with stand-ins, A26a(3)); a team left empty becomes **Disqualified** (no longer deleted). In Seeding after generation `lastSeedChangeAt` is stamped (regenerate). InProgress: every open match of the team is settled through `applyBracketResult` (decidedBy Dq) or, while the opponent is unknown, its slot becomes a BYE; rule and messages in [brackets/architecture.md](../brackets/architecture.md) "Phase S8c execution". Live lobby handling unchanged (D-25 / D-26; S8d). **Phase S10g:** the body is `disqualifyParticipant` (`helpers/tournament/disqualification.ts`), shared with user deletion (A94(2)); Registration through InProgress only (`Tournament is <stage>; participants can be disqualified from Registration through InProgress only.`, audit #8); every match the DQ settles has its unsettled lobbies voided except the live one, which is force-conceded (audit #2, A68(6)).

### Bracket reducers (Phase S8c execution)
Removed: `swap_seeds`, `advance_bracket_match`, `submit_and_advance_bracket`, `advance_group_to_elimination`, `admin_set_bracket_winner`. Added: `set_seed_order(tournamentId, teamIds)`, `advance_group_stage(tournamentId)`, `resolve_bracket_match(bracketMatchId, winnerTeamId, reason)`. Changed: `seed_bracket` (Ready teams, `ctx.random`), `generate_bracket` (A26a Withdraw, groups, `bracketGeneratedAt`), `rollback_bracket_match(bracketMatchId, reason)`. Reference: [brackets/architecture.md](../brackets/architecture.md).

### select_match_account(lobbyId, hsrAccountId) / deselect_match_account(lobbyId, hsrAccountId)
1. `getAuthenticatedUser(ctx)` -- must be active LobbyMember
2. Lobby must be in Waiting (A67(1), S8e)
3. Tournament path (additive, D-07): validate account against `TournamentPlayerAccount`; check `maxAccountsPerPlayer` cap; insert `LobbyMemberAccount`
4. Non-tournament path (replace, D-07): delete existing `LobbyMemberAccount` for user; insert new one (always exactly 1)
5. `deselect_match_account`: tournament path only; delete specific `LobbyMemberAccount` row
6. Phase 12.3 D-B-03: `select_match_account` carries a monotonic-upward post-insert hook that extends `MatchResultParticipant.accountRatingSnapshot` to `max(existing, newAccount.accountRating)` when an MRP row already exists (no longer reachable after S8e: selection is Waiting-only). `deselect_match_account` does NOT run the hook -- removing from selection cannot lower the max.

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

## Phase S8d execution (DECISIONS.md A24, A27, A33, A33a, A34, A35, A54, A56, A65)

Lobbies, the result hand-off and finalization at the terminal stage. Scenarios: [contract.md](contract.md) "Phase S8d
execution"; bracket side effects: [../brackets/architecture.md](../brackets/architecture.md); records:
[../match-results/architecture.md](../match-results/architecture.md).

| Reducer | Permission; stage | Behaviour |
|---|---|---|
| `create_tournament_lobby(bracketMatchId, joinCode)` | a member of team1 / team2 of the match or an approved stand-in of either (A34), or `bracket`; InProgress; match Ready; S8e (A67(5)): every lobby of the match settled (record Validated) and the Validated games below `bestOf` (`Lobby.bracket_match_id`) | Integrity set from the tournament (A33: teamSize, gameMode, matchType from countTowardsMmr, both anonymity flags, rosterVisibility, requireOwnership, costSetId, disconnectPolicy + disconnectForfeitSeconds, allowMirrorPicks (false when ranked, D-42), lineupFormat). Free set from the preset at `lobbyPresetId`, the system preset when that row is gone (A33a). name = tournament name + position key (≤ 50). Creator = host and referee (A34): a participant on its team's player seat (`autoSeatSlot`), staff on Spectator; `ensureNotInLobby` for both; `isCaptain` false (start_draft assigns). `joinCode` is ignored (server-generated, as before) |
| `approve_stand_in(bracketMatchId, teamId, userId)` | `participants` | `teamId` ∈ {team1Id, team2Id}; the user exists, is not a guest, and is not a member of the other team; one approval per (match, user); the row carries `teamId` (A35) |
| `revoke_stand_in(bracketMatchId, userId)` | `participants` | deletes the approval; a seat already held is not changed |
| `advance_tournament_stage(…, Completed)` | `owner`; InProgress | `ensureCanComplete`: format check (GroupInto*: elimination rows exist; GroupOnly: group rows only), then `canComplete` (every row Decided / Walkover / Void, no tournament lobby outside AwaitingResult); `assignFinalPlacements`; stage Completed; `startTournamentFinalization` |
| `advance_tournament_stage(…, Cancelled)` / `cancel_tournament` / `admin_cancel_idle_tournaments` | `owner` / Moderator+ | `cancelTournament`: `cascadeCleanupTournament` (below), stage Cancelled, `startTournamentFinalization` |
| `run_tournament_finalize` (scheduled, `TournamentFinalizeJob`) | internal | `runTournamentFinalizeTick` (below) |

**Placements (`helpers/tournament/tournamentFinalization.ts` `assignFinalPlacements`).** Competition ranking: placement = 1 +
the number of ranked teams strictly better. Elimination standing: champion (winner of the grand final, or of the last
Winners round in single elimination), then the final's loser, then the third-place match winner and loser, then the
match that eliminated the team (lost with no loser route): Losers rounds above Winners rounds, a later round above an
earlier one, so the losers-bracket final loser is third in double elimination (A29) and teams knocked out in the same
round share a placement. GroupOnly: the A30 group position (`groupStandings`); equal positions in different groups
share a placement. GroupInto*: elimination teams first, then the teams that did not qualify by group position.
Withdrawn and Disqualified teams get no placement. Team statuses are left as they are (A26 names no end state).

**Cancel cleanup (`cascadeCleanupTournament`, A24(5), review §5.1).** Deletes team requests, the bracket matches'
calendar events and `TournamentPlayerAccount`; **keeps** bracket matches, teams, team members and assistants (display
and the job's bracket order). Every tournament lobby except one parked in AwaitingResult with a Validated record is
voided (`voidTournamentLobby`: record Voided, lobby hard-deleted). The settled ones are finalized by the job, stats
counted, MMR skipped.

**Finalize job (`runTournamentFinalizeTick`, D.8.1).** `startTournamentFinalization` stamps
`finalizationStartedAt` and inserts `TournamentFinalizeJob { tournamentId, cursor: 0 }` scheduled now (none while a row
exists). A tick reads the tournament's surviving records in bracket order (`tournamentRecordsInBracketOrder`: group
matches, Winners, Losers, third place, grand final, each by roundNumber, matchNumber, id: every team's own matches stay
in play order) and takes the first K = 4. Empty batch: `rebuildLeaderboard` once when `countTowardsMmr` (SYSTEM actor),
`finalizedAt = now`, job rows deleted. Otherwise it **reschedules first** (next row, `cursor + batch`), then per record:
Validated → `runFinalization(ctx, record, SYSTEM_USER_ID, { tournamentMmr: countTowardsMmr && stage === Completed })`
(history with `tournamentId` / `bracketMatchId`, private (A37); MMR in step 11 with the real history id; stats;
achievements; `MatchLineupHistory` and the A56 deletes; `hardDeleteLobby`); any other status → deleted without effect
(`hardDeleteLobby` when its lobby still exists, else the row). `cursor` counts processed records; finalized records
are deleted, so each tick reads the first K survivors. A tick that throws rolls back whole; earlier ticks stay done.
`server_nuke_test_data` clears `TournamentFinalizeJob`. The final-tick leaderboard rebuild runs only for a Completed
MMR tournament (A24(5): no MMR on Cancelled).

**Restart (`admin_restart_tournament_finalize(tournamentId)`, Moderator+).** A tick that throws rolls back with its own
reschedule row, so the job stops. The reducer re-inserts a job row scheduled now (cursor 0, a progress counter only)
for a Completed or Cancelled tournament with `finalizedAt` unset and no job row; the next tick starts at the first
surviving record, since every record an earlier tick processed was finalized or deleted. Rejections: "Tournament not
found." · "Only a Completed or Cancelled tournament is finalized." · "This tournament is already finalized." · "The
finalize job of this tournament is still scheduled." Placements also count a walkover final / third-place match
(`eliminationKeys` reads Decided and Walkover rows).


## Phase S8e execution (DECISIONS.md A67(2)(5)(7)(8))

- **create_tournament_lobby (A67(5)).** Caller rule (A34) and D-22 unchanged. Rejections, in order after the caller
  check: tournament not InProgress; match not Ready ("<position> is <state>; a lobby needs a Ready match."); D-45: a
  lobby of the match (`Lobby.bracket_match_id`) whose record is not Validated (Waiting, playing, or parked with a
  Pending / Submitted / Disputed record): "A lobby for this bracket match is still in play."; the cap: the Validated
  records of the match (`MatchResultRecord.bracket_match_id`) reach `BracketMatch.bestOf`: "This bracket match has no
  games left (best of N)." A parked lobby with a Validated record does not block. The lobby copies no `bestOf`,
  head start or shelving setting (A67(2)); the integrity set (A33) is the tournament's, `lineupFormat` included.
- **Bracket tally.** Each settled game is handed to the bracket match (`recordGameSettled`, derived tally, decided at
  ceil(bestOf / 2)): [../brackets/architecture.md](../brackets/architecture.md) "Phase S8e execution".
- **Finalize job (A67(8)).** Unchanged in shape; a bracket match now has one record per game, so
  `tournamentRecordsInBracketOrder` orders the records of a match by creation time (`createdDate`, the start_draft
  insert), id only as a tie-break. Each Validated record is finalized on its own: history, stats and, in a Completed
  MMR tournament, MMR per game (A67(7): a Bo3 can move MMR three times). Placements and Cancelled semantics unchanged.
- **Cancel cleanup.** Unchanged: every lobby except one parked with a Validated record is voided.
- **dq_participant.** The live-lobby lookup covers Drafting / Equipping / Scoring only; the D-26 hard-delete branch of
  the removed stages is gone; a Ready match is settled with the derived tally (`matchGames`).

## Phase S8g execution (DECISIONS.md A70)

- **Seating by the match's colours (A70(1)).** `create_tournament_lobby` seats a participant on the player seat of the
  colour its team plays in this bracket match (`autoSeatSlot` → `allowedSlotsFor`, which reads `matchSides(match)`:
  `BracketMatch.blueTeamId`, default team1 = Blue). An approved stand-in (`TournamentStandIn.teamId`) sits on the
  colour of that team in the match. The colours are chosen per match with `set_match_sides(bracketMatchId, blueTeamId)`; the head start stays on team1 (A71(1))
  (`bracket`, until the first game; then rejected while a lobby of the match exists): [../brackets/architecture.md](../brackets/architecture.md) "Phase S8g execution".
- **dq_participant.** The force-concede of the DQ'd team's live lobby concedes the colour that team plays
  (`teamSideOf(match, teamId)`), not a fixed team1 = Blue.

## Phase S8f execution (DECISIONS.md A68)

- **dq_participant, player path (A68(6)).** A player DQ'd from a team that stays in the tournament is no longer removed
  from a live lobby (the D-25 kick is gone): the current game plays on with them, and the DQ bites from the next
  lobby of the match (no team membership, so `allowedSlotsFor` seats them as Spectator at most). The whole-team path
  (team emptied or `dqWholeTeam`) is unchanged: bracket settlement, force-concede of the live lobby with the team's
  colour, `writeMatchGames`.
- **create_tournament_lobby.** Optional `abandonCurrentMatch` (A68(4), see [../lobby/architecture.md](../lobby/architecture.md)
  "Phase S8f execution"); the lobby copies `maxSpectators` from the preset's free set (A68(8)).

## Phase S9a execution (DECISIONS.md A37, A44(1), A26a(2), A70(1), A71)

- **Arg views** (`anonymousView` with `{ tournamentId: u32 }`, no PK; subscribe `SELECT * FROM view_x(<id>)`):
  `view_tournament_participants` (enrolled rows minus Disqualified; `userId` 0 and label = alias or `Seat-<n>` by
  enrollment order when `isAnonymousDefault`), `view_tournament_teams` (`captainUserId` only when not anonymous),
  `view_tournament_team_members` (`userId` 0 + alias / seat when anonymous), `view_tournament_staff` (organizer and
  assistants with the three A25 flags; never anonymous).
- **Per-sender**: `view_my_tournament_enrollment` (own `TournamentEnrolled` rows), `view_my_team_requests` (sent, or to a
  team the caller captains; the captain gets the requester's id for `accept_team_request`), `view_my_stand_ins` (rows
  naming the caller or of the caller's teams; **new index `TournamentStandIn.user_id`**),
  `view_tournament_matches_for_me` (Ready / Pending matches of the caller's team with the opponent's name, the colours
  through `matchSides` and the tally; head start on team1, A71).
- `view_my_tournament_lobbies` rows carry the match's `blueTeamId` / `redTeamId` (`matchSides`, A70(1)).
  Catalogue: [../views/architecture.md](../views/architecture.md).

## Phase S10d execution (DECISIONS.md A91(2), A92(2)(3))

- `validateSettings` (`create_tournament`, `update_tournament`), after the enum check: `ensureNoActionAllowed(policy,
  true)` rejects NoAction ("The NoAction disconnect policy is only available for casual lobbies."), and
  `ensureForfeitSecondsInRange(disconnectForfeitSeconds)` rejects a set value outside 30-600 ("disconnectForfeitSeconds
  must be between 30 and 600 (0 keeps the default of 60)."); 0 / omitted keeps the default 60. Helpers in
  `helpers/lobby/disconnectHelpers.ts`.
- Deferred stays selectable for tournaments; `create_tournament_lobby` copies the tournament's policy and grace as
  before, and `update_lobby_settings` keeps them locked (A91(2)). Details: [../lobby/architecture.md](../lobby/architecture.md)
  "Phase S10d execution".

## Phase S10g execution (DECISIONS.md A94, A103, A104, A105; tournament audit 2026-11-09)

- **lock_tournament_accounts(tournamentId, hsrAccountIds: u32[])** (A104, audit #7). The caller holds an enrolment that
  is not Disqualified (approved, awaiting approval or waitlisted); stage Registration through InProgress (`Accounts can be
  locked from Registration until the tournament ends.`); `hsrAccountIds` not empty (`Name at least one account to
  lock.`) and the caller's own (`HSR account #<id> is not one of your accounts.`); the player's first game has not
  started (`Your first game of this tournament has started; accounts can no longer be locked.`); a waitlisted caller once
  promotion is impossible (bracket generated, or InProgress) → `The bracket has been generated; waitlisted players can
  no longer be promoted, so accounts cannot be locked.` (review F5).
  "Started" (`hasPlayedTournamentGame`, review F3: the player's own game, not the team's): (1) a `MatchResultParticipant`
  row of the player on a record of one of the tournament's bracket matches (`start_draft` writes one per non-coach Blue /
  Red member), or (2) a `BluePlayer` / `RedPlayer` `LobbyMember` row in a lobby of such a match past Waiting, or (3) a
  Voided record of a bracket match where the player's team sits in a slot or is the recorded winner / loser and that has
  no participant rows left. (3) exists because voiding (`voidTournamentLobby` → `hardDeleteLobby(…, keepResultRecord)`)
  keeps the record until the finalize job but deletes its participant and member rows: who played a voided or
  rolled-back game is no longer known, so it counts for every member of the team (a member who sat out only a voided
  game is locked out too). A member who sat out the team's other games can still lock. Effect: not waitlisted →
  `lockPlayerAccounts` (adds, never removes); waitlisted → `rememberWaitlistAccounts` always (first call included,
  review F5; ownership checked), applied by `lockAccountsAtPromotion`, which then locks the remembered accounts only.
  Counted by `consumeTournamentAllowance`.
- **Acting captain** (audit #15, review F4): `isActingCaptain` (`helpers/tournament/tournamentHelpers.ts`: `captainUserId`
  and a `TournamentTeamMember` row of that team) gates every captain-only reducer: `accept_team_request`,
  `reject_team_request`, `disband_tournament_team`, `withdraw_tournament_team`, `rename_tournament_team` and the captain
  path of `check_in_tournament` (a non-acting caller with `teamId` falls through to the `participants` permission
  check). A DQ'd ex-captain left on the team row is refused by all of them.
- **TournamentWaitlistAccount** (new private table): written by `register_for_tournament` (waitlisted with
  `hsrAccountIds`) and `lock_tournament_accounts`; read and deleted by `waitlist_promote` (`lockAccountsAtPromotion`);
  deleted by `removeEnrolment`, `activateTeams` (Seeding → InProgress: promotion ends at generation), the cancel cascade
  and user deletion. A waitlisted registrant with no row (no `hsrAccountIds` at registration and no later
  `lock_tournament_accounts` call) gets every account at promotion.
- **update_tournament** (A103, audit #9): `isAnonymousDefault` changes in Draft only.
- **Throttle** (audit #13): `consumeTournamentAllowance` (`helpers/lobby/abuseControls.ts`; `UserRateState.tournamentWindowStart`
  / `tournamentCount`): at most 10 tournament entry writes per fixed 60 s window per user, shared by
  `register_for_tournament`, `set_anonymous_alias`, `rename_tournament_team` (a real rename only) and
  `lock_tournament_accounts`; `You are changing your tournament entries too quickly. Please wait a minute.`
  `withdraw_from_tournament` is never counted, so a register / withdraw loop is held to ten cycles a minute.
- **User deletion** (A94): `delete_my_account` rejects the organizer of a tournament that is not Completed or Cancelled
  in both branches (`You organize a tournament that has not finished. Cancel it, or wait until it ends, before deleting
  your account.`). A live enrolment no longer blocks the verified branch (review F1); only its lobby guard stays.
  `performUserDeletion` first runs `settleTournamentTiesForDeletion`: per non-terminal tournament with
  a non-Disqualified enrolment, `removeEnrolment` before the bracket exists (`bracketGeneratedAt` unset) or
  `disqualifyParticipant(…, 'account deleted', dqWholeTeam false)` once it exists; then the user's team requests,
  assistant rows, stand-in rows, `TournamentPlayerAccount` and `TournamentWaitlistAccount` rows go. Audit actor: the
  deleting user, the admin, or `SYSTEM_USER_ID`. Details: [../auth/architecture.md](../auth/architecture.md).
- **Bracket corrections**: rollback after a Staff / Dq decision the tally gives (audit #3), override refused on a Dq
  decision or a staff decision against the tally (audit #4), group matches locked once the elimination bracket exists
  (audit #5): [../brackets/architecture.md](../brackets/architecture.md) "Phase S10g execution".
- **Views** (A105, audit #10, #11): staff views non-terminal + Moderator+, Admin arg views `view_admin_tournament*`,
  registrant accounts and matches-for-me narrowed: [../views/architecture.md](../views/architecture.md) "Phase S10g execution".
- **update_display_name** (audit #16): the solo team name goes through `soloTeamName` (unique, ` (2)` …).

## Phase S10l execution (DECISIONS.md A112)

`moveTournamentTiesToUser(ctx, fromGuestId, toUserId, actorId)` (`helpers/tournament/entryTransfer.ts`), called by
`server_link_provider` case 1b (a guest signs in to a provider account that already has a user) right before
`performUserDeletion` of the guest; actor `SYSTEM_USER_ID`, as the rest of the link path. No rate-limit allowance is
consumed (`consumeTournamentAllowance` is not called). No schema change. Per guest enrolment (index reads only:
`TournamentEnrolled.user_id`, `by_tournament_and_user`, `TournamentTeamMember.by_tournament_and_user`,
`TournamentTeamRequest.user_id` / `by_team_and_user`, `TournamentPlayerAccount.by_tournament_and_user`,
`TournamentWaitlistAccount.by_tournament_and_user`, `HsrAccount.user_id`, `Season.is_active`,
`MmrRating.by_user_mode_season`, `TournamentStandIn.user_id`, `BracketMatch.id`, `TournamentTeam.captain_user_id`):

- **Skipped** (stays with the guest): the tournament is Completed or Cancelled.
- **Not moved** (left to `settleTournamentTiesForDeletion`, A94(2): withdrawn before the bracket, disqualified after):
  the existing user has a `TournamentEnrolled` row in that tournament in any status (Disqualified included) or a
  `TournamentTeamMember` row there; `minimumMmr` and the existing user's rating is below it (the `ensureMinimumMmr`
  test: `MmrRating` for the tournament's game mode in the active season, else `EloConfig.initialRating`; no EloConfig
  row counts as below); `requireVerified` and the existing user is a guest; `requireRoster` and the existing user owns
  no active HSR account (the `register_for_tournament` check). The gates apply even though the guest registered
  without them: `update_tournament` lets the organizer set `minimumMmr`, `requireVerified` and `requireRoster` in
  Registration and CheckIn after guests enrolled (existing registrants are not re-checked), so a guest entry can sit in
  a tournament with any of them. The `requireVerified` test is defensive: the existing user always has a provider link.
  Since S10m (A113(1)(2)) those settings force `requireVerified` and the change is refused while guests are enrolled,
  so only rows written before A113 still carry a guest entry under these gates.
- **Moved**: the enrolment is re-keyed (`updateEnrolled`; status, alias, waitlist flag, approval, random-team opt-in and
  `createdDate` kept); the team membership is re-keyed and `captainUserId` follows when the guest was captain, also on
  a team the guest no longer belongs to (S10l review F7: a disqualified guest's emptied team keeps `captainUserId`;
  found through `TournamentTeam.captain_user_id`, so no team of an unfinished tournament names the deleted guest); a solo
  team (teamSize 1) of a non-anonymous tournament is renamed through `soloTeamName` (display name, ` (2)` uniqueness
  pass), an anonymous one keeps its alias / `Player <n>` name; the guest's pending `TournamentTeamRequest` rows to teams
  of that tournament are re-keyed (requests addressed to the guest's team are keyed by the requester and stay).
  `TournamentTeam.seedNumber`, `groupId`, status and the `BracketMatch` rows reference the team and are not touched.
- **Stand-in approvals of the existing user** (S10l review F2): `approve_stand_in` refuses a member of the other team
  only at approval time, so after the move the existing user's `TournamentStandIn` rows for bracket matches of that
  tournament in which their new team plays (team1 or team2) are deleted; otherwise `allowedSlotsFor` would give them
  both sides. Their stand-in rows for other matches stay.
- **Locks** (A112(2)): the guest's `TournamentPlayerAccount` and `TournamentWaitlistAccount` rows of the tournament are
  deleted; a non-waitlisted, non-Disqualified entry gets `lockPlayerAccounts(…, undefined)` (every HSR account of the
  existing user); a waitlisted entry gets no remembered choice (stale rows of the existing user deleted), so
  `waitlist_promote` locks every account through `lockAccountsAtPromotion`.
- **Stays with the guest id** and goes through the deletion as before: lobby memberships and `LobbyMemberAccount`
  selections (a Waiting row removed, a live player row kept away / abandoned, A68(7)); `MatchResultParticipant` rows
  and other records of games already played (the guest then has history references and is archived to `DeletedUser`,
  so `resolveUserLabel` still names it; the finalize job credits those games to the guest id, not the existing user);
  `TournamentAssistant` rows (rows written before S10m only: `assign_tournament_assistant` rejects guests since A113(6))
  and `TournamentStandIn` rows (`approve_stand_in` rejects guests), both deleted by A94(2). A Disqualified guest
  enrolment is moved like any other (status kept, no locks). Calendar invites of the tournament's bracket-match events
  move since S10m (A113(5), "Phase S10m execution").

## Phase S10m execution (DECISIONS.md A113)

No schema change; index reads only.

- **Forced `requireVerified`** (A113(1)): `forcesRequireVerified` (`reducers/tournament/tournamentManagement.ts`) is
  true when `countTowardsMmr`, `requireRoster`, `minimumMmr` set (non-zero), `requireOwnership`, or `rosterVisibility`
  is not `ClosedNoRating` (`RosterVisibility` = `OpenRoster | ClosedWithRating | ClosedNoRating`; the first two force
  it). `create_tournament` and `update_tournament` store `requireVerified = forced || argument`, the way
  `requireResultValidation` follows `countTowardsMmr`; `update_tournament` reads the stored `countTowardsMmr` (fixed
  after creation). With no trigger the organizer's value is stored, true or false.
- **Refusal while guests are enrolled** (A113(2)): in `update_tournament`, when the stored `requireVerified` would go
  from false to true, every `TournamentEnrolled` row of the tournament (`tournament_id` index) whose user
  (`User.id`) is a guest is counted, except Disqualified rows (they cannot play and no reducer removes them, so counting
  them would block the change for good); waitlisted and awaiting-approval rows count. A count above zero throws
  `These settings require verified accounts, and <n> guest player(s) are registered. Remove them first, or keep the
  settings that allow guests.` and nothing changes. An update that leaves the effective value as it is (off stays off,
  on stays on) is never refused. `register_for_tournament` already rejects guests under `requireVerified` (its check runs
  before the `minimumMmr` guest line, which is now unreachable for new tournaments).
- **Calendar invites move with the entry** (A113(5)): `moveEntry` (`helpers/tournament/entryTransfer.ts`) ends with
  `moveUserInvitesForTournament(ctx, guestId, existingUserId, tournamentId, SYSTEM_USER_ID)`
  ([../calendar/architecture.md](../calendar/architecture.md) "Phase S10m execution").
- **Assistants** (A113(6)): `assign_tournament_assistant` rejects a guest target with `A tournament assistant must be
  a verified user.` (the `approve_stand_in` style).
- **Sign-in during a live game** (A113(4)): `server_link_provider`, [../auth/architecture.md](../auth/architecture.md)
  "Phase S10m execution".

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
| Bracket reducers on the shared engine: + `set_seed_order`, `advance_group_stage`, `resolve_bracket_match`; − `swap_seeds`, `advance_bracket_match`, `submit_and_advance_bracket`, `advance_group_to_elimination`, `admin_set_bracket_winner`; `generate_bracket` withdraws still-Forming teams (A26a); `dq_participant` keeps the team (Disqualified) and settles through `applyBracketResult` (A23, A26a(2)) | Phase S8c execution | 2026-11-07 |
| `create_tournament_lobby` on the A33 / A33a / A34 / A27 rules, `approve_stand_in` with `teamId`, `revoke_stand_in`; Completed: format check + `canComplete` + placements + the chunked finalize job (K = 4, reschedule first, bracket order); Cancelled keeps bracket / teams, voids live lobbies, runs the same job without MMR (A24, A27, A33, A33a, A34, A35, A56) | Phase S8d execution | 2026-11-07 |
| `create_tournament_lobby`: D-45 = no unsettled lobby of the match, decided / capped matches rejected, no series settings copied; several records per bracket match in the finalize job, ordered by creation time; DQ settles with the derived tally (A67(2)(5)(7)(8)) | Phase S8e execution | 2026-11-08 |
| `create_tournament_lobby` / stand-in seating and the DQ force-concede read the match's colour mapping (`helpers/tournament/matchSides.ts`) | Phase S8g execution (DECISIONS.md A70) | 2026-11-08 |
| `set_match_sides(bracketMatchId, blueTeamId)`: the head start stays on team1 whatever the colours | Phase S8g execution (DECISIONS.md A71) | 2026-11-08 |
| `dq_participant` no longer kicks a DQ'd player from a live lobby (whole-team path unchanged); `create_tournament_lobby` takes `abandonCurrentMatch` and copies `maxSpectators` | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| Tournament arg views (participants, teams, team members, staff), per-sender enrollment / team requests / stand-ins / matches-for-me, `TournamentStandIn.user_id` index, colours on `view_my_tournament_lobbies` | Phase S9a execution (DECISIONS.md A37, A44(1), A26a(2), A70(1), A71) | 2026-11-08 |
| `create_tournament` / `update_tournament` reject NoAction and a `disconnectForfeitSeconds` outside 30-600 | Phase S10d execution (DECISIONS.md A92(2)(3)) | 2026-11-09 |
| User deletion settles tournament ties (withdraw before the bracket, DQ after) and an organizer of a live tournament cannot delete the account (A94); `isAnonymousDefault` Draft-only (A103); `lock_tournament_accounts` + `TournamentWaitlistAccount` (A104); staff views non-terminal + Moderator+, Admin arg views (A105); DQ stage guard and lobby voiding, minimum MMR on the active season, tournament entry throttle (audit #2, #6, #8, #13) | Phase S10g execution (DECISIONS.md A94, A103, A104, A105) | 2026-11-09 |
| A guest signing in to an existing account keeps its entries in unfinished tournaments (`moveTournamentTiesToUser`): enrolment, membership, captaincy and requests re-keyed, solo team renamed, locks rebuilt from the existing user's accounts; entries the existing user cannot hold are settled as a deletion | Phase S10l execution (DECISIONS.md A112) | 2026-11-10 |
| `requireVerified` forced on by `countTowardsMmr`, `requireRoster`, `minimumMmr`, `requireOwnership` or a roster visibility other than `ClosedNoRating`; `update_tournament` refuses to turn it on while non-Disqualified guest enrolments exist (count in the text); a moved entry takes the guest's match calendar invites; guests cannot be assistants | Phase S10m execution (DECISIONS.md A113) | 2026-11-10 |

---

*Last updated: 2026-11-09*
*Feature owner: Phase 04 / Phase 06 / Phase 08 / Phase 10.1 / Phase 10.4 / Phase 12.3*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
