# Match History Views -- Architecture

Last updated: 2026-04-13

## Overview

This feature covers the 5 **self-scoped history views** that let authenticated users read their own historical match records without client-side filtering. Every view resolves `ctx.sender` server-side (via `UserIdentity.identity.find`) and returns only rows where the resulting `userId` participated in the match. The views are the subscription targets for Phase 24+ profile pages, Phase 40 historical replay, and Phase 41 match-detail views.

These views were added in Phase 15 as the data-plane half of the `FOUND-02` requirement (the client-side plumbing is owned by downstream feature phases). They live alongside the pre-existing `view_match_history`, `view_match_participant_history`, `view_match_step_history` (which apply anonymous-safe masking for scouting-style reads) in `spacetimedb/src/views/matchHistoryViews.ts`. The `view_my_*` prefix distinguishes strict self-scope from visibility-filtered scouting.

## Backing tables

All 5 views read from the 5 `*_history` tables populated by `matchFinalization` when a lobby transitions out of `AwaitingResult`:

```
MatchSessionHistory (id: u32 autoInc PK)  [public: true]
  +-- Indexes: id (PK)
  +-- NO userId column -- filtered via MatchParticipantHistory.by_user

MatchSessionStepHistory (id: u32 autoInc PK)
  +-- matchHistoryId -> MatchSessionHistory.id  [btree: by_match_history]
  +-- NO userId column

MatchParticipantHistory (PK: [userId, matchHistoryId])
  +-- userId -> User.id  [btree: by_user]
  +-- matchHistoryId -> MatchSessionHistory.id  [btree: by_match_history]
  +-- teamSide: TeamSide, displayName, isReferee/Coach/Captain

MmrHistory (id: u32 autoInc PK)
  +-- userId -> User.id  [btree: user_id]
  +-- matchHistoryId -> MatchSessionHistory.id  [btree: match_history_id]
  +-- gameMode, previousRating, newRating, delta, seasonId

MatchResultGameHistory (id: u32 autoInc PK)
  +-- matchHistoryId -> MatchSessionHistory.id  [btree: by_match_history]
  +-- gameNumber, winnerTeamSide, team scores
  +-- NO userId column
```

## View Definitions

### view_my_mmr_history (Pattern A)

- **Auth:** Authenticated; `public: true` with server-side `ctx.sender` gating
- **Backing table:** `mmr_history`
- **Filter:** `MmrHistory.user_id.filter(mapping.userId)` -- direct btree index
- **Returns:** `MmrHistory[]` rows where `userId === caller.userId`
- **Complexity:** O(caller's MMR events)

### view_my_match_participant_history (Pattern A)

- **Auth:** Authenticated; `public: true`
- **Backing table:** `match_participant_history`
- **Filter:** `MatchParticipantHistory.by_user.filter(mapping.userId)` -- direct btree index
- **Returns:** `MatchParticipantHistory[]` rows where caller was a participant
- **Complexity:** O(caller's matches)

### view_my_match_session_history (Pattern B)

- **Auth:** Authenticated; `public: true`
- **Backing table:** `match_session_history`
- **Filter (participant-first iteration):**
  1. Collect caller's `matchHistoryId`s via `MatchParticipantHistory.by_user.filter`
  2. Lookup each `MatchSessionHistory.id.find(matchId)` row
- **Returns:** `MatchSessionHistory[]` rows for matches the caller participated in
- **Complexity:** O(caller's matches), not O(all matches)

### view_my_match_session_step_history (Pattern B)

- **Auth:** Authenticated; `public: true`
- **Backing table:** `match_session_step_history`
- **Filter (participant-first iteration):**
  1. Collect caller's `matchHistoryId`s via `MatchParticipantHistory.by_user.filter`
  2. For each match, `MatchSessionStepHistory.by_match_history.filter(matchId)`
- **Returns:** draft step rows for matches the caller participated in
- **Complexity:** O(caller's matches × average steps-per-match)

### view_my_match_result_game_history (Pattern B)

- **Auth:** Authenticated; `public: true`
- **Backing table:** `match_result_game_history`
- **Filter (participant-first iteration):**
  1. Collect caller's `matchHistoryId`s via `MatchParticipantHistory.by_user.filter`
  2. For each match, `MatchResultGameHistory.by_match_history.filter(matchId)`
- **Returns:** per-game score rows for matches the caller participated in
- **Complexity:** O(caller's matches × games-per-match), typically 1-5

## Filter Pattern Reference

**Pattern A (direct user-index filter)** -- used when backing table has a `userId` column with a btree index. Single filter call; server cost proportional to caller's row count. Reference implementation: `view_my_character_stats` (securityViews.ts:378 pre-split; `statsViews.ts` post-split).

**Pattern B (participant-first iteration)** -- used when backing table has NO `userId` column and can only be joined through `MatchParticipantHistory`. Two-stage: seed match-ID set via `by_user`, fan out via each target table's `by_match_history` index. Complexity is `O(caller's matches)`, not `O(all matches)` -- acceptable at the 100-user / ~156-match scale projected for v0.9. Reference implementation: `view_my_tournament_matches` (securityViews.ts:710 pre-split; `tournamentViews.ts` post-split).

**Why not denormalize `userId` onto the session tables?** Explicitly rejected in D-18. Would avoid the join but requires backfill and reducer updates everywhere sessions are written. Revisit only if energy budget shows participant-first iteration as a hot spot.

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| 5 self-scoped history views added to matchHistoryViews.ts; 1:1 naming with backing tables (view_my_match_session_history, view_my_match_session_step_history, view_my_match_participant_history, view_my_mmr_history, view_my_match_result_game_history) (D-13) | Phase 15 execution | 2026-04-13 |
| Pattern A (direct userId index filter) for MmrHistory + MatchParticipantHistory; Pattern B (participant-first iteration) for the 3 tables without userId (D-17, D-18, D-19) | Phase 15 execution | 2026-04-13 |
| All 5 views public: true with server-side ctx.sender gating (matches 23 existing view_my_* conventions) (D-15) | Phase 15 execution | 2026-04-13 |
| ROADMAP.md + REQUIREMENTS.md FOUND-02 canonicalised from 4 abbreviated names to 5 backing-table-aligned names (D-14) | Phase 15 execution | 2026-04-13 |
| Cross-user isolation regression guard: test/backend/views/matchHistoryViews/isolation.test.ts with 18 assertions covering invariants I1 (userId match), I2 (subset of backing-table SQL), I3 (fresh user sees empty), I4 (no cross-user leakage) (D-20, FOUND-02 #4) | Phase 15 execution | 2026-04-13 |
| Phase 16 route-group restructure (frontend-only — no view / table / reducer change): `(authenticated)/(game)/draft/[matchId]/` collapsed into `(authed)/(match)/draft/[matchId]/`. The `(match)` route-group nested under `(authed)` isolates match-scoped layouts from sibling authed routes; the public URL `/draft/{matchId}` is unchanged (route groups are URL-transparent). None of the `view_my_match_*` views, their backing tables, or their ctx.sender gating are affected — this doc's scope is backend views/tables only, and the route rename is cross-referenced here solely for the `Feature owner` line to reflect Phase 16's frontend touch | Phase 16 execution | 2026-04-18 |

---

*Last updated: 2026-04-18*
*Feature owner: Phase 15 / Phase 16 (frontend route restructure only)*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md) -- to be authored post-execution per project rule.
