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

1. `create_tournament`: `ensureTournamentHost`. `update_tournament`: `owner`; stage Draft, Registration or CheckIn (`Tournament settings can only change before Seeding.`); `format` / `teamSize` differ from the row outside Draft → `Format and team size can only change in Draft.`; `isAnonymousDefault` differs outside Draft → `The anonymous setting can only change in Draft.` (A103, S10g); `maxParticipants` below the capacity count → rejected; Phase S10s execution (A122(17)): `maxParticipants` below 2 → `maxParticipants must be at least 2.` (create and update, fix pass F7).
2. Validation (`validateSettings`): name 1–100, description ≤ 2000, teamSize 1–3, enum tags (`validateEnumTag`), both bestOf ∈ {1, 3}, `winnerAdvantage < ceil(grandFinalBestOf / 2)`, `has3rdPlaceMatch` only where `allowsThirdPlace(format)`, `groupSize ≥ 2` for group formats, `groupAdvanceCount ∈ {1, 2}`, `maxAccountsPerPlayer ≤ 10`, timestamps in the future and ordered. Phase S10s execution (A122(17)): a date is `''` or digits (else `<field> must be a date in microseconds since the epoch (digits only), or empty.`); on update a date equal to the stored one is not re-checked against now.
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
5. `anonymousAlias` only in anonymous tournaments, 1–32 characters trimmed; Phase S10s execution (A122(20)): unique among the tournament's aliases (`ensureAliasAvailable`; fix pass F1: not compared with display names, A37).
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
2. `reject_participant`: before generation (`ensureBeforeGeneration`); a row awaiting approval or waitlisted, or (S10o, A118) the approved, non-Disqualified row of a guest user; otherwise `Participant is already approved; disqualify them instead.`; `removeEnrolment`.
3. `waitlist_promote` (D.8.6): Registration through Seeding until `bracketGeneratedAt` (`Bracket generated; use stand-ins.`); a free spot (`No free spot: the tournament is full.`); `isWaitlisted = false`, approval implied, `lockAccountsAtPromotion` (S10g, A104: the remembered accounts the player still owns, else all accounts; the remembered rows deleted), team refreshed. Phase S10s execution (A122(16)): in Seeding a solo player's Withdrawn team first returns to Forming (`reopenWithdrawnSoloTeam`), so the refresh makes it Ready.
4. `add_participant`: same window; the target exists, is not deleted and is verified; not enrolled (Disqualified blocks); a free spot; inserts an approved, non-waitlisted Registered row; solo auto-team; account locks.

### add_team_member(teamId, userId) (A26a)
`participants`; Registration, CheckIn or Seeding until `bracketGeneratedAt` (`ensureBeforeGeneration`: `Bracket generated; use stand-ins.`). The player is enrolled, not Disqualified, approved when required (`The player awaits approval.`), not waitlisted (`The player is on the waitlist; promote them first.`) and teamless (`The player is already on a team.`); the team is Forming or Ready (`Team is <status>.`) with room (`Team is already full.`). The player's pending requests are deleted; `refreshTeamStatus` afterwards.

### set_anonymous_alias(tournamentId, alias) (A36a)
Enrolled caller; tournament anonymous; Registration or CheckIn; alias 1–32 trimmed; Phase S10s execution (A122(20)): unique among the tournament's aliases (`ensureAliasAvailable`; fix pass F1: not compared with display names, A37); in a solo tournament the player's team is renamed to the alias (made unique with ` (2)`, ` (3)`, … when it equals another team's name). S10g: counted by `consumeTournamentAllowance` (audit #13).

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
Removed: `swap_seeds`, `advance_bracket_match`, `submit_and_advance_bracket`, `advance_group_to_elimination`, `admin_set_bracket_winner`. Added: `set_seed_order(tournamentId, teamIds)`, `advance_group_stage(tournamentId)`, `resolve_bracket_match(bracketMatchId, winnerTeamId, reason)`. Changed: `seed_bracket` (Ready teams, `ctx.random`; since S10p `fairShuffle`, A120), `generate_bracket` (A26a Withdraw, groups, `bracketGeneratedAt`), `rollback_bracket_match(bracketMatchId, reason)`. Reference: [brackets/architecture.md](../brackets/architecture.md).

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
| `create_tournament_lobby(bracketMatchId, abandonCurrentMatch?)` | a member of team1 / team2 of the match (A34), or `bracket` (organizer, Moderator+, assistant with canManageBracket); A140 (S10v): an approved stand-in alone is refused ("A stand-in cannot create the match lobby: a team member or tournament staff creates it."), a stand-in holding such a role creates through it; InProgress; match Ready; S8e (A67(5)): every lobby of the match settled (record Validated) and the Validated games below `bestOf` (`Lobby.bracket_match_id`) | Integrity set from the tournament (A33: teamSize, gameMode, matchType from countTowardsMmr, both anonymity flags, rosterVisibility, requireOwnership, costSetId, disconnectPolicy + disconnectForfeitSeconds, allowMirrorPicks (false when ranked, D-42), lineupFormat). Free set from the preset at `lobbyPresetId`, the system preset when that row is gone (A33a). name = tournament name + position key (≤ 50). Creator = host and referee (A34): a participant on its team's player seat (`autoSeatSlot`), staff on Spectator; `ensureNotInLobby` for both; `isCaptain` false (start_draft assigns). `joinCode` is ignored (server-generated, as before) |
| `approve_stand_in(bracketMatchId, teamId, userId)` | `participants`; Phase S10s execution (A122(19)): InProgress | `teamId` ∈ {team1Id, team2Id} and not Disqualified (S10s); the user exists, is not a guest, is not Disqualified in the tournament (Phase S10t execution, A128), and is not a member of the other team; one approval per (match, user); the row carries `teamId` (A35) |
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

## Phase S10n execution (DECISIONS.md A114)

- `create_tournament_lobby(bracketMatchId, abandonCurrentMatch?)`: the `joinCode` argument (accepted and ignored) is
  removed (A114(2)); the server generates the code as before. Players of the match join through `join_lobby` by that
  code or by the lobby id (A114(1)). `Tournament.lobbyPresetId` (A33a) is unchanged.

## Phase S10o execution (DECISIONS.md A118)

- **Entry point.** `reject_participant(tournamentId, userId)` is extended rather than a new reducer: it already removes
  an enrolment as a withdrawal (`removeEnrolment`) under the `participants` permission and the before-generation
  window, which is exactly the A118 path. When the row is approved and not waitlisted it now also accepts it if the
  target `User.isGuest` is true and the row's status is not `Disqualified`. No binding change.
- **Window.** `ensureBeforeGeneration`: Registration, CheckIn, and Seeding while `bracketGeneratedAt` is unset; after
  that the existing texts (`Bracket generated; use stand-ins.`, `Tournament is in <stage>; the field can change from
  Registration through Seeding only.`), so a guest's entry is then handled by `dq_participant` as before.
- **Effect (`removeEnrolment`, unchanged).** The enrolment row is deleted (no Disqualified row, so the guest may
  register again, and after signing in the verified account may too); the membership goes through `removeTeamMember`
  (captain handed to the next member by `transferTournamentCaptain`; an empty team deleted in Registration, marked
  Withdrawn from CheckIn on); the user's team requests, calendar invites for the tournament, account locks and
  remembered waitlist accounts are deleted. Capacity (`capacityCount`) drops by one. A withdrawal promotes nobody from
  the waitlist, and neither does this path: staff promote with `waitlist_promote`, which the freed spot now allows.
- **Unchanged.** A verified user's approved entry: `Participant is already approved; disqualify them instead.`; a
  caller without the permission: `This action needs the participants permission.`
- **A113(2).** Guests removed this way no longer count, so a settings change refused for them passes afterwards.

## Phase S10p execution (DECISIONS.md A120)

- **Random team formation (A36a).** `formRandomTeams` (`helpers/tournament/tournamentHelpers.ts`) orders the
  eligible opted-in solos (user-id order, as before) with `fairShuffle` (`shared/lobby-rules/timerDraw.ts`); formula, uniformity and its 2^32-orders limit: [lobby/architecture.md, Phase S10p execution](../lobby/architecture.md#phase-s10p-execution-decisionsmd-a120).
- **Key words.** `[SHUFFLE_DOMAIN.TeamFormation ('TEAM', 0x5445414d), tournament.id]`: a different domain word from
  random seeding (`SEED`, brackets/architecture.md), so the two draws never share a hash in one transaction.
  Teams, names, captains (first member) and the leftover rule are unchanged. No schema or binding change.

## Phase S10s execution (DECISIONS.md A121, A122, A124)

Triage batch 2 (`notes/audit-2026-11-09/low-findings-triage.md` L63 to L71), then a fix pass on the review
(`F1`, `F7`, `F8`, `F12`, `F13`) and A124. No schema or binding change.

- **Waitlist promotion in Seeding (A122(16), L63).** `waitlist_promote` calls `reopenWithdrawnSoloTeam`
  (`helpers/tournament/tournamentHelpers.ts`) before the team refresh: in a solo tournament (teamSize 1) in Seeding, the
  promoted player's team that CheckIn → Seeding made Withdrawn (it was not checked in: a waitlisted player's team is
  not eligible, so in practice it is not checked in, although `check_in_tournament` has no waitlist test) goes back to
  Forming, and `refreshTeamOf` makes it Ready (promotion implies approval, the one member is eligible). The team is then
  seeded and generated like any Ready team. The enrolment stays `Registered` (check-in is a CheckIn-stage act;
  `activateTeams` accepts Registered). Team tournaments keep the Withdrawn status (the whole team missed check-in).
- **create_tournament / update_tournament (A122(17), L64).** `validateSettings(ctx, args, stored?)`: a date argument is
  `''` or digits (`parseOptionalMicros`), else `registrationDeadline must be a date in microseconds since the epoch
  (digits only), or empty.` (same text with `scheduledStartAt`). On update a date equal to the stored one is not
  compared with now, so settings change after the deadline (or the start) has passed; a changed date must lie in the
  future (`… must be in the future.`), and the deadline stays before the start. `maxParticipants < 2` is refused
  (`maxParticipants must be at least 2.`) on create and on update (fix pass F7: the floor sits in `validateSettings`).
  On create every date given must still lie in the future.
- **Seeding by rating (A122(18), L65).** See [../brackets/architecture.md](../brackets/architecture.md) "Phase S10s
  execution".
- **Stand-ins (A122(19), L66).** `approve_stand_in` refuses unless the tournament is InProgress (`Stand-ins can only
  be approved while the tournament is in progress.`) and refuses a Disqualified `teamId` (`A disqualified team cannot
  get a stand-in.`). `deleteTournamentStandIns(ctx, tournamentId)` deletes every `TournamentStandIn` row of the
  tournament's bracket matches and the `TournamentPlayerAccount` rows of each stand-in with no `TournamentEnrolled` row
  in the tournament (the locks the D-26 lobby join snapshot wrote). It runs in `cascadeCleanupTournament` (cancel) and in
  `advance_tournament_stage(…, Completed)` after the placements. Enrolled players' locks: deleted at cancel as before,
  kept at Completed as before.
- **Aliases (A122(20), L69).** `ensureAliasAvailable(ctx, tournamentId, alias, selfUserId)` in `register_for_tournament`
  and `set_anonymous_alias`: refused (`That alias is already taken in this tournament. Choose another.`) when another
  enrolment of the tournament (any status, waitlisted and Disqualified included) has that alias, compared trimmed and
  case-insensitively; the caller's own alias is allowed. **Fix pass F1: the display-name half of A122(20) was
  withdrawn** for A37 / A103: comparing an alias with the other entrants' display names let anyone learn which public
  names are enrolled in an anonymous tournament (a refusal on a string that is not a visible alias is an entrant's
  name; refused calls roll back, so no throttle counted them). Aliases are public labels, so alias-against-alias
  uniqueness reveals nothing. The module generates no aliases; the generated labels (`Seat-<n>` in
  `view_tournament_participants`, `Player <n>` team names) are not aliases and are not checked; a team-name collision
  still gets the ` (2)` suffix.
- **New organizer, staff path (A121, L70).** `performUserDeletion` hands the deleted user's unfinished tournaments over
  first (`handOverOrganizedTournaments`, `helpers/identity/userDeletionHelper.ts`): to the longest-serving assistant with
  all three permissions (earliest `createdDate`, then the lower user id; not a guest, not pending deletion), whose
  assistant row is deleted; else to the acting user when they still exist, are not pending deletion and are Moderator+;
  else nothing changes. An heir who is also enrolled as a player keeps the enrolment. Not applied to a self-deletion
  (including the reconnect-ban path, see auth) or to a server deletion (A124, below). The ban and
  `admin_delete_row('User')` paths run it from `run_user_deletion`, whose actor is the job row's `createdById` (the
  Admin who asked, stored at request time). Moved rows: `Tournament.organizerId`; the `CalendarEvent` rows of the
  tournament's bracket matches organized by the deleted user (`organizerId`, so the cascade's
  `deleteAllCalendarDataForUser` keeps them; invites unchanged); any assistant row of the new organizer in that
  tournament is deleted. Everything else reads `organizerId` at call time (`hasTournamentPermission`, the staff views,
  `adminMatchTools`, `scoringHelpers`, the achievement award check). Not moved: the tournament's lobby preset and cost
  set keep their `creatorUserId` / `creatorId` (the deletion keeps them while the tournament is unfinished, A122(6)).
- **Server deletion of an organizer (A124).** When the server identity deletes or bans the organizer, every tournament
  of that organizer that is not Completed or Cancelled goes through `cancelTournament` (the `cancel_tournament` path:
  `cascadeCleanupTournament` with live lobbies voided, match calendar events, requests, locks and stand-ins deleted,
  stage Cancelled, the A24(5) finalize job started; enrolments, teams, bracket and assistant rows kept for display). No
  assistant takes over. The signal is explicit (`performUserDeletion(…, { serverDeletion: true })`), set at three call
  sites only: `server_delete_user`; `run_user_deletion` for a job whose creator is the SYSTEM user (only
  `admin_ban_user` and `admin_delete_row('User')` write a job with an actor other than the user, and they act as SYSTEM
  exactly when the caller is the Owner or a Delegate); `admin_delete_row('UserIdentity')` sent as SYSTEM for a guest
  left without identity. Identity GC and `server_link_provider` also pass a SYSTEM actor but never set the flag, so they
  cancel nothing. Details: [../auth/architecture.md](../auth/architecture.md) "Phase S10s execution".
- **Staff views (A122(21), L71).** [../views/architecture.md](../views/architecture.md) "Phase S10s execution" (the
  seven staff views and `view_tournament_registrant_accounts`; `reducers/admin/adminMatchTools.ts` still accepts any
  assistant row, flags not read, and is left as is).

## Phase S10t execution (DECISIONS.md A128)

- **A disqualified player is no stand-in (A128).** `approve_stand_in` (`reducers/tournament/tournamentLobby.ts`), after
  the guest check, reads the user's `TournamentEnrolled` row of the match's tournament (`by_tournament_and_user`) and
  refuses a Disqualified one (`A disqualified player cannot be a stand-in.`), for either team of the match. Every other
  status (Registered, CheckedIn, Active, Eliminated, Withdrawn) and no enrolment at all are accepted, as before. The
  A122(19) checks (InProgress, team not Disqualified) and the other-team membership check are unchanged.
  _The InProgress clause is superseded in Phase S10v execution (A136)._

## Phase S10v execution (DECISIONS.md A135, A136, A137, A138)

Stand-in rules and the stand-in bugs of `notes/audit-2026-11-09/standin-audit.md` (SI1 to SI16), plus the S10v review
fix passes (first review F1 to F16 with A137; second review G1 to G8 with A138). The lifecycle around a `TournamentStandIn` row lives in
`helpers/tournament/standIns.ts`; the scenarios are in `spacetimedb/src/__tests__/tournaments/stand-ins.test.ts`. No schema
change (no table, column or index); one new staff view. `lockPlayerAccounts` and `hasPlayedTournamentGame` moved
unchanged to the leaf module `helpers/tournament/accountLocks.ts` (re-exported by `tournamentHelpers.ts`) so the
stand-in helpers, called by the bracket writers, close no import cycle.

**Who can stand in, when, what is checked** (`approve_stand_in`, `reducers/tournament/tournamentLobby.ts:238`; permission
`participants` as before; checks in this order):

| Check | Rule | Refusal |
|---|---|---|
| When (A136, SI17) | Seeding with `bracketGeneratedAt` set, or InProgress | `Stand-ins can be approved once the bracket is generated, until the tournament ends.` |
| Team size (A135(5)) | not a solo tournament (`teamSize` 1) | `A solo tournament cannot field a stand-in: a team member must play every game.` |
| Match (SI13) | state Pending or Ready, neither slot a BYE (Decided, Walkover, Void refused) | `Stand-ins can only be approved for a match that is still open (Pending or Ready).` |
| Team | team1 or team2 of the match, not Disqualified | as before |
| User | exists and `deletedAt` unset (deleted, banned) | `Target user not found.` |
| Verified | no guest (also after an A112 sign-in: the guest row is refused, the existing user is judged on its own) | `A stand-in must be a verified user.` |
| Staff (A135(2), A137(2), SI7) | not the organizer, no `TournamentAssistant` row in the tournament (any flags, all off included), whoever approves | `Tournament staff (the organizer and the assistants) cannot be a stand-in.` |
| Self (A137(1), review F8) | the target is not the caller, whatever the caller's role (Moderator, Admin) | `You cannot approve yourself as a stand-in.` |
| A128 | enrolment not Disqualified | as before |
| Other team | not a member of the match's other team | as before |
| Still in (A135(3), SI8) | not a member (`TournamentTeamMember`) of a team of the tournament whose status is Forming, Ready or Active | `A player whose team is still in the tournament cannot be a stand-in.` |
| Entry (A135(1), A137(4), SI6) | `ensureEntryRequirements(ctx, tournament, user, 'standIn')` (`tournamentHelpers.ts:243`), shared with `register_for_tournament`: `requireVerified`; `requireRoster` or `requireOwnership` need an active HSR account (A137(4): registration too); `minimumMmr` against the rating in the tournament's game mode and active season | `The stand-in needs an active HSR account in their roster for this tournament.` / `This tournament needs an MMR of at least N; the stand-in's rating is below it.` |
| Duplicate | one row per user and match | as before |

Review F5: no stand-in refusal prints private data. The rating refusal names the floor, never the user's rating (A40 /
A45). The account refusal tells staff only that an active account is missing. Registration texts are unchanged
(`register_for_tournament` shows the registrant their own rating), and `requireOwnership` now refuses a registration
without an active account with the roster text `This tournament requires an active HSR account in your roster.`

"Still in" is read from the team status only: enrolment statuses stay Registered / CheckedIn / Active (the code never
writes Eliminated or Withdrawn on an enrolment). So refused: a member of a Ready team in Seeding (enrolment Registered or
CheckedIn) and of an Active team in InProgress, the losers bracket included. Accepted: a member of an Eliminated team, of
a Withdrawn team (missed check-in, emptied), a user enrolled without a team, and a user who is not enrolled. A Moderator
or Admin who is not staff of this tournament may stand in when someone else approves them (A137(1)). No cap on approvals
(A135(5)); no rating ceiling (A135(7)).

After the insert: an invite to the match's calendar event when one exists (SI16, skipped when the event is at its
9-invite cap; the event still shows through the approval). No account lock (review F7, below).

**The rules hold after approval too** (A135(2), A135(3); review F1, F2, F3). Every path that makes a user's own team still
in again, or makes the user staff, removes the user's approvals in the tournament through `removeStandIn`:
- a roll-back that un-eliminates a team (`rollbackBracketResult`, `bracketResults.ts:150`, `removeTeamMembersStandIns`);
  note (review G4): the removal runs before a roll-back re-decides the match from its games, so a roll-back that ends
  with the same team eliminated again still removes its members' approvals; staff approve again;
- an A112 entry transfer onto a team that is Forming / Ready / Active (`entryTransfer.ts:111`; on a team that is out,
  only the approvals for matches that team plays go, as before);
- `assign_tournament_assistant` (`tournamentAdmin.ts:254`; the assignment is accepted) and the A121 organizer hand-over
  (`userDeletionHelper.ts:121`).
Team membership itself never changes after generation (team reducers need Registration or the D.8.6 window), and
approvals exist only after it, so these are the paths.

**Creating the match lobby (A140).** A stand-in approval does not allow `create_tournament_lobby`
(`reducers/tournament/tournamentLobby.ts:68`): the creator is a member of one of the two teams (seated on its team's
side) or `bracket` staff (organizer, assistant with canManageBracket, Moderator, Admin; seated as a Spectator
referee). A plain stand-in gets `A stand-in cannot create the match lobby: a team member or tournament staff creates
it.`; a stand-in holding such a role (a Moderator or Admin approved by someone else; tournament staff cannot be
stand-ins) creates through the role and is seated like any staff creator.

**Scope.** Unchanged: one bracket match, every game (lobby) of it; never the next match, in single or double
elimination (a team routed to the losers bracket needs a new approval).

**Seats** (A138, which supersedes the automatic take-over of A135(4) and A137(3)'s second sentence; at least one member,
A135(5) / SI11):
- No automatic seat moves. `join_lobby` seats a member or an approved stand-in into a free player seat of its side as
  before S10v (`autoSeatSlot`); a side that is full seats the joiner as Spectator, member or not, and nobody is moved.
- A member's own request for a player seat of a full side is refused as full (`Blue team is full (max N players).`),
  like anyone's. The host (and staff, as before S10v) moves people by hand: the stand-in to Spectator first, then the
  member in.
- The team captain (`TournamentTeam.captainUserId`, still a member, present in the lobby) may move an approved stand-in
  of their own team to Spectator (`isCaptainMovingOwnStandIn`, `lobbySettings.ts:306`), and that move skips the spectator
  cap (review F9). Kept by A138 (at the time a stand-in could create the lobby and be its host; since A140 the
  creator is a member or staff, and the move stays as the captain's own way to free a seat). Any other move of another member still needs the host, a Moderator or an Admin, under the
  cap.
- Note (review F13, narrowed by A140): only a stand-in creating through a role (a Moderator or Admin approved by
  someone else) can be the lobby's host; that creator is seated as a Spectator referee like any staff creator and keeps
  the flags when seated or moved; staff can use `transfer_host`. Note (review G3, known, not changed): a member disqualified while host and referee of
  a Waiting lobby is moved to Spectator (F6) but keeps both flags, so they can still move players and start the game;
  staff use `transfer_host` / `reclaim_referee`.
- Nothing changes once the game has started: a member joining a Drafting / Equipping / Scoring lobby watches, the
  stand-in keeps the seat and plays that game. The next game of a series is a new lobby, where the rule applies again.
- `start_draft` (`reducers/draft/draftClassic.ts:127`, `sideHasTeamMember`): in a tournament lobby each side's seated
  non-coach players include at least one member of the team that plays it, else `Blue team needs at least one of its own
  members seated as a player; stand-ins cannot play without one.` (Red likewise; review F12: a member seated as coach
  only does not count). `start_draft` is the only start gate of a lobby. So a solo tournament cannot field a stand-in
  at all, which is why `approve_stand_in` refuses it up front.
- SI1: `allowedSlotsFor` (`shared/lobby-rules/allowedSlots.ts`) never gives a member of one team of the match the other
  side, even when a stand-in row names them for it; `placeEntrant` (`bracketStore.ts`) deletes such rows when a team is
  placed into a match (`removeConflictingStandIns`).
- Review F6: `disqualifyParticipant` moves every disqualified member out of the player and coach seats of the Waiting
  lobbies of the tournament (`unseatInTournamentLobbies`, `disqualification.ts:141`); a live game keeps the seat (A68(6)).

**Removal of an approval** (`removeStandIn`: the row; the user moved to Spectator in every Waiting lobby of the match
where the seat is no longer allowed; the user's invite to the match event unless a member of one of its teams; then the
lock release below):
- `revoke_stand_in` (`tournamentLobby.ts:326`, SI4): a game already running keeps the seat (its result is recorded with
  whoever sat); Waiting lobbies are unseated.
- Disqualification (SI5, `disqualifyParticipant`): every approval of each disqualified user in the tournament.
- A slot that changes team (SI14): `unplaceEntrant` (roll-back, re-resolve) and `setSlotBye` remove the approvals of the
  team that left the match, so a stale row no longer blocks approving the same user for the new team.
- The F1 / F2 / F3 paths above.
- Unchanged: user deletion (A94), regeneration (`deleteBracket`, which now also releases the approvals' locks), and
  Completed / Cancelled (`deleteTournamentStandIns`).

**Lock lifecycle** (SI2, SI3, SI12; review F7, F10, F11, G1, G8). The rule: a stand-in's accounts are locked only by
the stand-in's own action, never by the approval, and never once the stand-in has played a game of the tournament
(A104).
- Approval: no lock (review F7). A user approved who never takes part holds no lock and can delete accounts freely.
- `participateAsStandIn` (`helpers/tournament/standIns.ts`) is the one snapshot: when the user is an approved stand-in
  of the lobby's match, holds no lock in the tournament and has not played a game of it (`hasPlayedTournamentGame`,
  review G1), every owned account is locked; then, when nothing is selected in that lobby, the active account is
  selected if locked, else the first locked one (review G8, as `join_lobby` D-04). Its four entry points, each the
  stand-in's own act:
  1. creating the lobby (`create_tournament_lobby`, `tournamentLobby.ts:207`; review F11). Since A140 this applies
     only to a stand-in who creates through a role (Moderator / Admin, approved by someone else): they are seated as a
     Spectator referee like any staff creator, and the creation takes the snapshot as a Spectator join does;
  2. joining it (`join_lobby`, the D-26 block, any seat, `lobbyLifecycle.ts`);
  3. taking a player seat themself (`set_team_slot`, self move);
  4. confirming ready while holding a player seat (`confirm_ready`, `lobbySettings.ts:428`; review G1).
  Entry 4 means no seated stand-in reaches a start without passing through the snapshot: a host move resets the
  confirmation and `start_draft` needs every Blue and Red player confirmed. The snapshot alone does not guarantee an
  account (the user may own none, may have deleted it after approval, or may have played already, A104). What holds
  at the start (review N1, N5): in a ranked / MMR-counted tournament (D-08 gate) and in a tournament with
  `requireOwnership` (the N1 gate below), no seated player, member or stand-in, starts without a selected match
  account; in a plain tournament (unrated, no ownership) accounts are not needed and a player without one, stand-in
  included, starts as before.
- Review N1 start gate (`reducers/draft/draftClassic.ts`, after the D-08 gate): in a tournament lobby whose tournament
  has `requireOwnership`, every seated non-coach Blue / Red player needs at least one `LobbyMemberAccount` row, else
  `The player at seat N has no account selected for this match. All players must select an account before starting a
  match that requires ownership.` (named by seat number, as D-08, so nothing is revealed in an anonymous lobby). It
  covers a stand-in who deleted the account after approval and a player who deselected after confirming; a played
  user with no lock cannot select and so cannot be started either. Casual lobbies and tournaments without
  `requireOwnership` are unchanged.
- SI2 therefore holds for a creator (since A140 only a Moderator or Admin stand-in creating through the role), for a stand-in approved while watching who takes the seat, and for one seated by
  the host (locked and selected when they confirm): they can play and the game can start without leaving and
  rejoining.
- `lock_tournament_accounts` (`reducers/tournament/tournamentRegistration.ts:311`, A135(8) / SI3): a caller with no
  enrolment who holds an approval on an open match (Pending / Ready) of the tournament adds locks under the A104 limit
  (refused once their first game of the tournament has started); otherwise `You are not registered for this tournament.`
- Released (`releaseStandInLocksIfUnused`) when the user holds no approval on an open match of the tournament and has
  not played: on revoke, on any removal above, when the match is decided (`applyBracketResult`,
  `releaseDecidedMatchStandIns`; the row stays so a roll-back keeps the approval), and at regeneration.
  Review G1: when the locks go, the user's account selections (`LobbyMemberAccount`) in Waiting lobbies of the
  tournament go with them, so a selection never outlives its lock (a live lobby is never touched). "Has played" is
  A104's `hasPlayedTournamentGame`, three rules: (1) a result-record participant of a bracket match of the tournament
  (`start_draft` writes one per seated player); (2) a player seat in such a lobby past Waiting; (3) for a team member
  only, a Voided record (no participant rows left) of a bracket match the member's team played: a voided game counts
  for every member of that team. Rule 3 reads team membership, so it never applies to a stand-in.
- Review F10, enrolled users: an entrant's own enrolment locks are never released by the stand-in path. For a user
  enrolled in the tournament the release applies only when every lock they hold was created at or after their first
  known approval in the tournament (the earliest `createdDate` of their approval rows, the row being removed included):
  the user held no lock when approved (waitlisted, enrolled without a team or without an account), so the locks came
  through the stand-in path. Limits, since no column records a lock's origin: a lock such a user adds themself after
  the approval is treated as a stand-in lock; an approval revoked before a later one is no longer known.
  Review G2 confirmed both limits and found them bounded: a release always needs "no open approval and has not
  played", so no lock that covers a seat or a played game is lost; in the first case the user can lock again, in the
  second the lock ends with the tournament. The proper fix is an origin column on `TournamentPlayerAccount`
  (schema change): an S11 candidate.
- Note (review F14): a rolled-back deciding game deletes its participant rows, so a stand-in who played only that game
  no longer counts as having played; a later revoke releases their locks. Harmless (the game no longer counts).
- At Completed and Cancelled `deleteTournamentStandIns` sweeps every `TournamentPlayerAccount` row of the tournament
  whose user has no enrolment (a stand-in revoked earlier who had played included); enrolled players' locks behave as
  before. Note (review F16): the table has no tournament index, so this is one full scan of the lock table per
  tournament end, growing with the history of finished tournaments (private table, no egress). A `tournamentId` index
  on `TournamentPlayerAccount` is an S11 candidate (a one-column prefix scan of `by_tournament_and_user` fails in the
  in-memory datastore; unverified on maincloud).

**Staff view** (A135(6), SI15): `view_my_tournament_stand_ins` (no arguments; [../views/architecture.md](../views/architecture.md)
"Phase S10v execution"): one row per approval in the staff set's tournaments (organizer, an assistant holding at least
one permission (L71), Moderator+; non-terminal), with the stand-in's and the approver's display names and `approvedAt`
(the row's `createdDate`). Opponents still see nothing: `view_my_stand_ins` is unchanged.

**Visibility for the stand-in** (SI16): `view_tournament_matches_for_me` adds the open matches of the caller's approvals
(`myTeamId` = the team stood in for, InProgress only); `view_my_calendar_events` adds the events of those matches.
Review F4: approvals never make the match's calendar event fail. `create_calendar_event` invites the members first, then
the manual invitees, then the match's stand-ins only while room is left under the 9-invite cap; the others see the
event through `view_my_calendar_events` ([../calendar/architecture.md](../calendar/architecture.md)).

Note (review G7, calendar): a stand-in also invited by hand loses that invite at revoke (the removal does not know
why the invite exists); stand-ins left out at the cap are not invited when a revoke frees room (they still see the
event); approvals deleted at the tournament end or by user deletion are raw deletes, so an invite to a past event of
a finished tournament can remain.

**Known limitations for the owner** (S10v review 3; no code):
- N2 (narrowed by A140): a plain stand-in can no longer create the match lobby, so a stand-in is its host only when
  they created it through a role (a Moderator or Admin approved as stand-in by someone else). Such a host keeps host and
  referee after taking a seat, being moved to Spectator, or a revoke, and can move and kick players; the start gate
  still prevents a game without a member. The way out is `transfer_host` (and `reclaim_referee`) or other staff
  (`close_lobby`, a staff referee).
- N3: a member who joins when stand-ins hold the side's seats joins as Spectator (A138) and counts against
  `maxSpectators`: with the spectator seats full the team's own member is refused entry ("Spectator slots are full (max
  N)."), and the captain's uncapped move cannot be made from outside the lobby. The host frees a spectator seat or
  kicks a stand-in. The same happens at `87f5d27` for a side full of members.
- N4 (older behaviour, not this step): a game whose record `override_match_result` sets to Rejected no longer counts as
  played: its participant rows are deleted and rule 3 of `hasPlayedTournamentGame` tests Voided only. Afterwards the
  players of that game may lock accounts again (A104), and a stand-in's later revoke releases their locks. A104
  follow-up: count Rejected like Voided.

**Anonymous tournaments.** Unchanged labels: opponents see the stand-in as a seat label ("Blue Player #n"), no name; SI9
(the stand-in sees its side's real names) stays as A135 states.

## Phase S10ac execution (DECISIONS.md A157(12))

`BracketMatch.scheduledAt` (optional timestamp; the column existed and was never written) now holds the start of the
match's calendar event: `create_calendar_event` with a `bracketMatchId` writes it, `update_calendar_event` moves it
when the start changes (an end-only change leaves it), and every deletion of the event clears it through
`deleteCalendarEventWithInvites` (`delete_calendar_event`, the D-21 / D-22 cascades of cancel, rollback, staff resolve,
disqualification and bracket regeneration, user deletion, the lazy calendar clean-up and the A157(10) sweep). Helper
`setBracketMatchSchedule(ctx, bracketMatchId, startAt, actorId?)` in `helpers/calendar/calendarCascade.ts`: the two
calendar reducers stamp the audit columns with the caller; the deletion paths change the column only. A match whose
row is already gone is skipped. Readers: `view_tournament_matches_for_me.scheduledAt` (unchanged column) and the public
`bracket_match` table. Details in [../calendar/architecture.md](../calendar/architecture.md) "Phase S10ac execution".

## Phase S10ad execution (DECISIONS.md A160(6), A161(3))

Retention keeps the match's time: when the lazy calendar clean-up or the `run_identity_gc` sweep removes a match event
90 days after its end, `BracketMatch.scheduledAt` stays (`deleteCalendarEventWithInvites(..., { keepSchedule: true })`).
A person's delete or move of the event and a user deletion clear or move it while the event exists. The bracket
cascades (staff resolve of a Ready match, `rollback_bracket_match`, `cancel_tournament`, a disqualification that settles
a Ready match, bracket regeneration) go through `deleteCalendarEventForBracketMatch`, which clears a set `scheduledAt`
whether or not an event is still there (A161(3), review F1): a match rolled back after retention is Ready again with
no time. A match without a time is not written. Details in [../calendar/architecture.md](../calendar/architecture.md)
"Phase S10ad execution".

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
| `create_tournament_lobby` loses its ignored `joinCode` argument | Phase S10n execution (DECISIONS.md A114) | 2026-11-10 |
| `reject_participant` also removes a guest's approved, non-Disqualified entry before the bracket exists (withdrawal path, no Disqualified row); verified players and post-generation unchanged | Phase S10o execution (DECISIONS.md A118) | 2026-11-10 |
| A36a random team formation: `fairShuffle` keyed by the transaction time, `SHUFFLE_DOMAIN.TeamFormation` and the tournament id replaces `ctx.random.shuffle`; pool order (user id), team building and leftovers unchanged; `seed_bracket` random likewise (brackets) | Phase S10p execution (DECISIONS.md A120) | 2026-11-10 |
| Promotion in Seeding re-opens a solo player's Withdrawn team; `update_tournament` keeps unchanged past dates, digits-only dates, at least 2 participants; stand-in approvals need InProgress and a non-Disqualified team and end (with the stand-ins' locks) at Completed / Cancelled; aliases unique and not another entrant's display name; a staff deletion or ban of the organizer hands the tournament to the longest-serving full assistant or the acting staff member; no-permission assistants read no staff view | Phase S10s execution (DECISIONS.md A121, A122) | 2026-11-10 |
| `approve_stand_in` refuses a user whose enrolment in the tournament is Disqualified | Phase S10t execution (DECISIONS.md A128) | 2026-11-10 |
| Fix pass: alias uniqueness among aliases only (display-name comparison withdrawn, A37 / A103); the 2-participant floor on create too; a server deletion or ban of an organizer cancels the unfinished tournaments through the cancel path (A124) | Phase S10s execution (DECISIONS.md A122, A124) | 2026-11-10 |
| `approve_stand_in` from bracket generation on (Seeding after generation, InProgress) | Phase S10v execution (DECISIONS.md A136) | 2026-11-10 |
| Stand-ins: registration checks (`ensureEntryRequirements`), no tournament staff, no player whose team is still in, open match only, no solo stand-in; members first in Waiting seats (replaced by A138: no automatic moves) and the captain moves a stand-in out; `start_draft` needs a member per side; locks at the stand-in's own participation (fix pass; first built at approval), `lock_tournament_accounts` for approved stand-ins, release on revoke / removal / decided match, sweep at the end; approvals removed on DQ, slot change and conflicting placement, revoke unseats; staff view `view_my_tournament_stand_ins`; stand-in matches and events visible to the stand-in | Phase S10v execution (DECISIONS.md A135) | 2026-11-10 |
| Fix pass: no self-approval (A137(1)); host moves of a member into a full side refused, members displace only by their own join or request (A137(3)); `requireOwnership` needs an active account at registration too (A137(4)); no lock at approval, the snapshot at the stand-in's own first participation (create, join, own seat move); approvals removed when the user's team is still in again (roll-back, A112 transfer) or the user becomes staff; stand-ins never block the match event; no rating in the stand-in refusal; a disqualified member unseated in Waiting; captain's stand-in move uncapped; enrolled users' stand-in-path locks released by the stand-in rules; start-gate text "seated as a player" | Phase S10v execution (DECISIONS.md A137; S10v review F1-F16) | 2026-11-10 |
| Second fix pass: no automatic stand-in displacement (A138; the captain's manual move kept); the stand-in snapshot also at `confirm_ready` in a player seat, never after the user has played (A104), first-locked-account fallback; selections deleted with released locks; `canHoldEntry` reads `requireOwnership` | Phase S10v execution (DECISIONS.md A138; S10v review G1-G8) | 2026-11-10 |
| `start_draft` refuses a tournament lobby with `requireOwnership` while a seated Blue / Red player has no selected match account; known limitations N2 to N4 documented | Phase S10v execution (S10v review 3, N1-N5) | 2026-11-10 |
| `create_tournament_lobby`: a stand-in approval no longer allows creating the match lobby (members of the two teams and `bracket` staff, Moderator+ as before; a stand-in with such a role creates through it, seated as a Spectator referee) | Phase S10v execution (DECISIONS.md A140) | 2026-11-10 |
| `BracketMatch.scheduledAt` is written from the match's calendar event (create, start change) and cleared when the event is deleted | Phase S10ac execution (DECISIONS.md A157(12)) | 2026-11-11 |
| Retention of a match event (lazy clean-up, sweep) keeps `BracketMatch.scheduledAt` | Phase S10ad execution (DECISIONS.md A160(6)) | 2026-11-11 |
| Fix pass: the bracket cascades clear a set `scheduledAt` also when retention already removed the event | Phase S10ad execution (DECISIONS.md A161(3)) | 2026-11-11 |

---

*Last updated: 2026-11-11 (S10ad)*
*Feature owner: Phase 04 / Phase 06 / Phase 08 / Phase 10.1 / Phase 10.4 / Phase 12.3*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
