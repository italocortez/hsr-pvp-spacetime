# Match History Views -- Architecture

Last updated: 2026-11-10 (Phase S10n)

## Overview

This feature covers the **self-scoped history views** that let an authenticated user read their own archived matches. Every view resolves `ctx.sender` server-side (via `UserIdentity.identity.find`) and returns only rows of matches where the resulting `userId` has a `MatchParticipantHistory` row. A37: history is private, and a match's real identities are revealed to its participants (no anonymous labels in these rows). The public history views (`view_match_history`, `view_match_participant_history`, `view_match_step_history`) were removed in S9a; Moderator+ access is S9b's admin view.

Phase S10n execution (DECISIONS.md A115): the five unbounded views of Phase 15 / S9a (`view_my_match_participant_history`, `view_my_match_session_history`, `view_my_match_session_step_history`, `view_my_match_result_game_history`, `view_my_match_lineup_history`) are removed. They returned every row of every match the caller ever played (audit 2026-11-09, results finding 10). In their place: a paged list (10 matches per page) with its count, and four per-match detail views that take the match history id. `view_my_mmr_history` is paged the same way.

All views live in `spacetimedb/src/views/matchHistoryViews.ts`. Views with arguments are subscribed with raw SQL only, one subscription per argument set (`SELECT * FROM view_my_match_history(0, '', '', '')`); they cannot have a primary key, so the generated `view_my_mmr_history` row no longer marks `id` as a primary key (insert / delete events only, as for every view here).

## Backing tables

```
MatchSessionHistory (id: u32 autoInc PK)  [public: false]
  +-- Indexes: id (PK), tournament_id (btree)
  +-- playedAt (the list order), gameMode, draftMode, matchType (filters), tournamentId
  +-- matchType: MatchType, winnerTeamSide?: TeamSide  (S10n fix pass: stored at finalization)
  +-- NO userId column -- reached via MatchParticipantHistory.by_user

MatchSessionStepHistory (logical key [matchHistoryId, sequence])
  +-- matchHistoryId -> MatchSessionHistory.id  [btree: by_match_history]

MatchParticipantHistory (logical key [userId, matchHistoryId])
  +-- userId -> User.id  [btree: by_user]
  +-- matchHistoryId -> MatchSessionHistory.id  [btree: by_match_history]   (S10n)
  +-- teamSide: TeamSide, displayName, isReferee/Coach/Captain

MmrHistory (id: u32 autoInc PK)
  +-- userId -> User.id  [btree: user_id]
  +-- matchHistoryId -> MatchSessionHistory.id  (no index: nothing reads rating rows by match)
  +-- gameMode, previousRating, newRating, delta, seasonId

MatchResultGameHistory (logical key [matchHistoryId]; one game per match, A67(3))
  +-- matchHistoryId -> MatchSessionHistory.id  [btree: by_match_history]
  +-- winnerTeamSide, team scores, deaths, adjusted results

MatchLineupHistory (id: u32 autoInc PK; one row per team, A56(1))
  +-- matchHistoryId -> MatchSessionHistory.id  [btree: by_match_history]
```

S10n schema (S11 clear-publish list): index `MatchParticipantHistory.by_match_history` (the detail views read one match's participants: membership check and the participants view; without it a full scan), and two columns on `MatchSessionHistory` before the audit columns (fix pass, review F1 / F2): `matchType: MatchType` and `winnerTeamSide?: TeamSide`. `runFinalization` (`helpers/results/finalizationHelpers.ts`, step 7, the only insert) writes them from the record it finalizes: `matchType` is the record's match type (the lobby's, copied at `start_draft`; a rated tournament's lobby is Ranked, D-67), the value finalization rates and counts stats by; `winnerTeamSide` is the record's final winner (a concede, a forfeit, a staff override or a force-finalize is already on it), the one finalization uses for stats and ratings. Finalization refuses a record without a winner (A31), so every row it writes has one; the column stays optional. The `MmrHistory.match_history_id` index of the first S10n pass is removed: the match-type filter no longer probes rating rows.

## View Definitions

Filters are `t.string()` arguments: `''` means any, otherwise the enum tag (`GameMode`, `DraftMode`, `MatchType`); an unknown tag matches nothing. A view argument is passed as a SQL literal, and the documented literal types are integers, strings, hex and booleans, so an optional (`Option`) argument has no SQL spelling: the filters use the `''` sentinel instead. `page` is a `u32` starting at 0; a page past the end returns no rows. Order: newest first by time, the id only as the tie-break between equal times (CLAUDE.md §3.4).

### view_my_match_history(page, gameMode, draftMode, matchType)

- **Returns:** `MatchHistoryListRow[]`, at most 10, one per match: `matchHistoryId`, the `MatchSessionHistory` columns without the audit columns (`lobbyCode`, `playedAt`, `draftMode`, `gameMode`, `teamBlueAlias`, `teamRedAlias`, `snapshotConfig`, `outcome`, `teamBlueSpent`, `teamRedSpent`, `handicapApplied`, `tournamentId`, `bracketMatchId`, `voidedAt`, `winnerOverride`, `winnerOverrideById`, `winnerOverrideReason`), the stored `matchType: MatchType` and `winnerTeamSide?: TeamSide` (the record's final winner; none when the match has no winner), the caller's own participant fields (`teamSide`, `displayName`, `isReferee`, `isCoach`, `isCaptain`), `won?: bool` (true when the caller's side is the stored winner, false when the winner is the other side, none when there is no winner) and, when the match rated the caller, `previousRating?`, `newRating?`, `ratingDelta?` from their `MmrHistory` row.
- **Order:** `MatchSessionHistory.playedAt` descending, `id` descending on a tie.
- **Match type and winner (stored):** read from `MatchSessionHistory.matchType` / `.winnerTeamSide`; the match-type filter compares the stored tag. Nothing is derived (the first S10n pass read `Tournament.countTowardsMmr`, probed rating rows and took the archived game's winner, which a concede or a staff decision made wrong: review F1 / F2).
- **Cost per evaluation:** one `MatchParticipantHistory.by_user` scan (the caller's n matches), n `MatchSessionHistory.id.find`, one `MmrHistory.user_id` scan (the caller's rating rows), a sort of n. No other user's rows are read to build the list. No index on a history table can remove the sort: the order is per user by `playedAt`, which lives on the session row, not on the participant row (a denormalised `playedAt` column on `MatchParticipantHistory` would, and is out of scope: no column change).
- **Egress:** at most 10 rows per subscription; a new finalization re-evaluates it.

### view_my_match_history_count(gameMode, draftMode, matchType)

- **Returns:** one `MatchHistoryCountRow { total: u32 }` for a mapped caller (0 when nothing matches); no row for an unmapped identity. Same filters and the same match reads as the list, without the page and without the rating rows.

### view_my_match_history_participants / _steps / _games / _lineups(matchHistoryId)

- **Gate:** the caller has a `MatchParticipantHistory` row in that match (`MatchParticipantHistory.by_match_history.filter(matchHistoryId)`, the match's few participants); otherwise `[]`. A spectator-only user, an outsider, a player of another match and an unmapped identity read nothing.
- **Returns:** today's row shapes, the table rows: `MatchParticipantHistory` (every participant of the match), `MatchSessionStepHistory` (sorted by `sequence`), `MatchResultGameHistory`, `MatchLineupHistory` (one per team).
- **Cost:** one `by_match_history` probe for the gate plus one for the rows.

### view_my_mmr_history(page, gameMode)

- **Returns:** `MmrHistory[]`, at most 10, the caller's own rows (`MmrHistory.user_id`), filtered by game mode (`''` = any).
- **Order:** `createdDate` descending (when the rating was written; a tournament's ratings are written at its completion), `id` descending on a tie.
- **Cost:** O(caller's rating rows) plus a sort.

## Filter Pattern Reference

**Pattern A (direct user-index filter)** -- used when backing table has a `userId` column with a btree index. Single filter call; server cost proportional to caller's row count. Used by `view_my_mmr_history` and the list's seed read.

**Per-match gate (S10n)** -- the detail views no longer fan out over every match of the caller (the old Pattern B, participant-first iteration); they take one match id, check the caller's participant row in that match through `MatchParticipantHistory.by_match_history`, then read that match's rows through the target table's `by_match_history` index.

**Why not denormalize `userId` onto the session tables?** Explicitly rejected in D-18. Would avoid the join but requires backfill and reducer updates everywhere sessions are written. Revisit only if energy budget shows participant-first iteration as a hot spot.

## Phase S10n execution

- A115(1)(2): `view_my_match_history` and `view_my_match_history_count` added; filters as `''` sentinels (no SQL spelling for an absent optional argument); the first pass derived the match type (Tournament.countTowardsMmr, else rating rows); the fix pass stores it (below).
- A115(3): `view_my_match_history_participants`, `_steps`, `_games`, `_lineups` added. The participants view returns every participant of the match (A37: the identities are revealed to its participants; the step rows already carried every actor's id and name), where the removed `view_my_match_participant_history` returned the caller's own row of each match (that row is now part of the list row).
- A115(4): the five unbounded views removed (their bindings deleted by the generator); `view_my_mmr_history` takes `(page, gameMode)`.
- Indexes added: `MatchParticipantHistory.by_match_history` (`MmrHistory.match_history_id` was added in the first pass and removed in the fix pass).
- Fix pass (review F1 / F2): `MatchSessionHistory.matchType` and `.winnerTeamSide` stored at finalization; the list's `matchType`, `winnerTeamSide`, `won` and the match-type filter read them; the derivation (the `Tournament` read, the rating-row probe, the tournament-gone fallback, the game-row winner) is removed. The count view no longer reads rating rows.
- Behaviour: `docs/views/contract.md` (not changed during execution).

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| 5 self-scoped history views added to matchHistoryViews.ts; 1:1 naming with backing tables (view_my_match_session_history, view_my_match_session_step_history, view_my_match_participant_history, view_my_mmr_history, view_my_match_result_game_history) (D-13) | Phase 15 execution | 2026-04-13 |
| Pattern A (direct userId index filter) for MmrHistory + MatchParticipantHistory; Pattern B (participant-first iteration) for the 3 tables without userId (D-17, D-18, D-19) | Phase 15 execution | 2026-04-13 |
| All 5 views public: true with server-side ctx.sender gating (matches 23 existing view_my_* conventions) (D-15) | Phase 15 execution | 2026-04-13 |
| ROADMAP.md + REQUIREMENTS.md FOUND-02 canonicalised from 4 abbreviated names to 5 backing-table-aligned names (D-14) | Phase 15 execution | 2026-04-13 |
| Cross-user isolation regression guard: test/backend/views/matchHistoryViews/isolation.test.ts with 18 assertions covering invariants I1 (userId match), I2 (subset of backing-table SQL), I3 (fresh user sees empty), I4 (no cross-user leakage) (D-20, FOUND-02 #4) | Phase 15 execution | 2026-04-13 |
| Phase 16 route-group restructure (frontend-only — no view / table / reducer change): `(authenticated)/(game)/draft/[matchId]/` collapsed into `(authed)/(match)/draft/[matchId]/`. The `(match)` route-group nested under `(authed)` isolates match-scoped layouts from sibling authed routes; the public URL `/draft/{matchId}` is unchanged (route groups are URL-transparent). None of the `view_my_match_*` views, their backing tables, or their ctx.sender gating are affected — this doc's scope is backend views/tables only, and the route rename is cross-referenced here solely for the `Feature owner` line to reflect Phase 16's frontend touch | Phase 16 execution | 2026-04-18 |
| Paged and filtered history (A115): `view_my_match_history(page, gameMode, draftMode, matchType)` + `view_my_match_history_count`, per-match `view_my_match_history_participants` / `_steps` / `_games` / `_lineups(matchHistoryId)`, `view_my_mmr_history(page, gameMode)`; the five unbounded `view_my_match_*_history` views removed; indexes `MatchParticipantHistory.by_match_history` and `MmrHistory.match_history_id` | Phase S10n execution (DECISIONS.md A115) | 2026-11-10 |
| Fix pass (review F1 / F2): `MatchSessionHistory.matchType` + `.winnerTeamSide` stored at finalization and read by the list (match type, winner, won, match-type filter); derivation removed; `MmrHistory.match_history_id` removed | Phase S10n execution (DECISIONS.md A115) | 2026-11-10 |

---

*Last updated: 2026-11-10*
*Feature owner: Phase 15 / Phase 16 (frontend route restructure only) / Phase S10n (paged history)*

**Behavior specification** (acceptance scenarios, edge cases, phase history): no `docs/match/contract.md` exists; the history views' scenarios are in [../views/contract.md](../views/contract.md).
