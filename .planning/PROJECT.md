# HSRPVP — Honkai Star Rail PVP Platform

## What This Is

A competitive Honkai Star Rail PVP platform where players draft characters, compete in matches and tournaments, track their performance, and manage their in-game rosters. Built on SpacetimeDB for real-time multiplayer sync with a Next.js frontend. The platform aims to replace external tournament tools (like Challonge) with a purpose-built, HSR-native competitive experience.

## Core Value

Players can organize, play, and track competitive HSR matches and tournaments in one place — from drafting to scoring to leaderboards — without relying on external tools.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ Guest login and Discord OAuth account linking — existing
- ✓ SpacetimeDB real-time WebSocket connection with token persistence — existing
- ✓ User profiles with display name, username, and avatar — existing
- ✓ Role-based access control (admin, user, server identity) — existing
- ✓ Game data tables for HSR characters and lightcones — existing
- ✓ Character/lightcone cost tables with eidolon/superimposition costs per game mode — existing
- ✓ Synergy cost tables with source/target modifiers per game mode — existing
- ✓ Lobby creation and membership tracking — existing
- ✓ Match session with step-by-step pick/ban recording — existing
- ✓ Match history archival (MatchSessionHistory + MatchSessionStepHistory) — existing
- ✓ Real-time cursor broadcasting in lobbies (LobbyCursorEvent) — existing
- ✓ Admin bulk upsert and row deletion for cost management — existing
- ✓ Guest account cleanup via UserDeletionJob — existing
- ✓ Team composition builder — existing (needs verification)
- ✓ Roster management (accounts, characters, lightcones, visibility, account rating) — Validated in Phase 2
- ✓ Tournament lifecycle (creation, registration, teams, referee, cost sets, stage transitions) — Validated in Phase 3
- ✓ Bracket generation and advancement (single/double/group/hybrid, seeding, auto-advance) — Validated in Phase 4
- ✓ Schema normalization (Blue/Red naming, MatchResultParticipant confirmation, MatchType/MatchOutcome enums) — Validated in Phase 04.1
- ✓ Match results and MMR (score submission, ELO calculation, leaderboard, bracket advancement via finalization) — Validated in Phase 5
- ✓ Anonymous play enforcement (label computation, cursor anonymization, roster/stat visibility, tournament account locking) — Validated in Phase 6
- ✓ Player statistics (win/loss/spectated tracking, character stats, global character stats, match replay archival, auto-finalize casual) — Validated in Phase 6
- ✓ Achievements and titles (flexible criteria definitions, auto-award during finalization, manual award, profile title display) — Validated in Phase 7
- ✓ Calendar and scheduling (recurring availability slots, saved calendars, calendar events with invites, tournament match scheduling, cross-feature cascade deletions) — Validated in Phase 8
- ✓ Mouse tracking (XY cursor broadcast, spectator/coach visibility, coach pick restriction) — Validated in Phase 9
- ✓ Chat (ephemeral per-lobby messages, rolling window cleanup, rich content structure) — Validated in Phase 9
- ✓ Lobby browser (view_lobby_browser, filter support, visibility controls) — Validated in Phase 9
- ✓ Disconnect handling (configurable per-lobby/tournament, timer+forfeit, graceful rejoin) — Validated in Phase 10
- ✓ Cost table parity (HsrLightconeCost gains gameMode composite key) — Validated in Phase 10
- ✓ Match schema rework (series support, best-of-N, shelve/resume, MatchSessionHistory consolidation) — Validated in Phase 10.1
- ✓ Tournament organizer views (view_to_dashboard, view_to_bracket_matches) — Validated in Phase 10.3
- ✓ Account selection per match (multi-account per match, LobbyMemberAccount, drop TournamentEnrolled.hsrAccountId) — Validated in Phase 10.4
- ✓ Test suite stabilization (shared helpers, cleanup hygiene, cross-file isolation) — Validated in Phase 10.5
- ✓ Account rating matrix (vertical + horizontal dimensions, admin config, auto-recalc) — Validated in Phase 11
- ✓ Auth security hardening (UserPrivate isolation, view-based profile, ban enforcement, identity cleanup) — Validated in Phase 12
- ✓ Identity garbage collection (scheduled cleanup of stale UserIdentity rows, 90-day TTL) — Validated in Phase 12.1
- ✓ SDK upgrade audit (2.0.3 → 2.1.0, view exports, .catch() error handling, confirmed reads) — Validated in Phase 12.2
- ✓ MMR rating snapshot (account rating captured at match start via `MRP.accountRatingSnapshot`, monotonic-upward hook in `select_match_account`, tournament-stage ordering guard, roster mutation guards) — Validated in Phase 12.3
- ✓ Documentation normalization (standardized architecture/contract templates, full hydration, codebase docs regen, FRONTEND-HANDOFF rewrite, ERD update) — Validated in Phase 13
- ✓ Audit spread type helper refactor (insertWithAudit/updateWithAudit typed helpers across 57 files; ~228 `as any` eliminated = 55% of backend baseline; two-tier API with 9 preserved auditInsert primitives + ~30 P4 composite-PK carry sites; 1 Rule 1 latent bug fix in seriesManagement TimerState; zero behavior change) — Validated in Phase 15.3 (shipped to maincloud 2026-04-18)

### Active

<!-- Current scope: v0.9 Frontend milestone. v0.5 backend is complete. -->

## Current Milestone: v0.9 Frontend

**Goal:** Complete frontend coverage of the v0.5 backend — every feature surfaced through a Next.js App Router frontend with SpacetimeDB subscriptions as the single data plane. Subscription architecture is the foundation; pages are built on top of each subscription layer.

**Target features:**
- Backend pre-work: Spine asset columns on `hsr_character` + self-scoped historical views
- Route-group subscription lifecycle: global → public → authed → match → entity
- Three-tier asset delivery: portraits, Spine animations, image-only fallback (Service Worker + Web Worker)
- Public pages: cost tables, team builder (consuming anon reference subs)
- Authed pages: profile (with historical data), admin panel
- Match zone: lobby list, lobby detail, live draft with Spine pedestal
- Tournament flows: creation, registration, brackets, stage management
- Leaderboards + MMR visualization
- Render capability detection (`getRenderTier()` — Chrome/Edge/Firefox supported, Safari defensively gated)

**Architectural decisions:** See `notes/v09-frontend-subscription-strategy.md` (8 binding decisions).

**Priority order:** cost tables → team builder → admin panel → profile page → lobby/matches → tournaments → leaderboards.

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- HoYoverse API roster import — unclear if API supports it, defer to future milestone
- Computer vision screenshot roster import — high complexity, future milestone
- Season implementation for leaderboards — schema supports it, UI/logic deferred
- Real-time voice/video chat — out of platform scope
- Mobile native app — web-first
- Payment/monetization — not needed for competitive platform
- Chat message persistence — ephemeral by design, no replay of chat

## Context

- **v0.5 shipped** (2026-04-12): 67 tables, ~156 reducers, 32 server-side views, 728 integration tests across 23 phases
- 28,040 LOC backend TypeScript, 23,450 LOC tests, 6,678 LOC frontend (landing page)
- SpacetimeDB SDK 2.1.0 with TypeScript backend, Next.js 15 frontend with HeroUI
- SpacetimeDB handles all persistent state and real-time sync via WebSocket subscriptions
- Privacy enforced via PRIVATE tables + 32 named views (no raw private table subscriptions)
- Trusted server identity pattern for privileged operations (Discord linking, role management)
- Audit columns (createdAt/By, updatedAt/By) standard on all tables
- UserPrivate isolation (Phase 12): profile data accessed only via view_my_profile
- All reducer calls use .catch() pattern (Phase 12.2), no _then() callbacks
- 19 feature doc sets normalized (architecture.md + contract.md) with standardized templates (Phase 13)
- Frontend/UI is the next milestone (v1)

## Constraints

- **Tech stack**: SpacetimeDB TypeScript backend, Next.js frontend — established, no changes
- **Reducers**: Must be deterministic — no network, filesystem, timers, or random
- **Data access**: All reads via table subscriptions, never reducer return values
- **Image hosting**: Imgur for match screenshot uploads (external dependency)
- **Auth**: SpacetimeDB identity + Discord OAuth via NextAuth — established pattern
- **Game modes**: Memory of Chaos, Apocalyptic Shadow, Anomaly Arbitration — each with different scoring

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Manual roster entry first | HoYoverse API availability uncertain; manual is reliable | Implemented (Phase 2) |
| Imgur for screenshot hosting | Avoids storing images in SpacetimeDB; public URLs sufficient for verification | Implemented (Phase 5) |
| Ephemeral chat via event table | Keeps match data lean; chat not needed for replay | Implemented (Phase 9) |
| Per-game-mode MMR with equal-weight global | Reflects different skill sets per mode while giving one composite rank | Implemented (Phase 5) |
| Tournament settings override user roster visibility | Tournament integrity > personal preference | Implemented (Phase 6) |
| Role-based TO access | Prevents spam tournaments while allowing community organizing | Implemented (Phase 3) |
| Configurable disconnect behavior | Different contexts (casual vs tournament) need different handling | Implemented (Phase 10) |
| Backend-only milestone | Solid table design first, UI in separate milestone | ✓ Good — v0.5 shipped 2026-04-12 |
| UserPrivate isolation | Profile data only via view_my_profile; no direct table subscription | Implemented (Phase 12) |
| .catch() reducer error pattern | Replaces _then() callbacks after SDK 2.1.0 upgrade | Implemented (Phase 12.2) |
| Matrix-based account rating | Vertical (eidolon depth) + horizontal (archetype coverage) with admin-tunable config | Implemented (Phase 11) |
| Flat columns over config structs | Filterable data uses flat columns; LobbyConfig can be reworked | Convention |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-04 after Phase 16.5 SpacetimeDB v2.6.1 upgrade + test-suite validation. Toolchain + both SDK pins bumped v2.2.0→v2.6.1, 240 client binding files regenerated, sole repo-affecting change one PR #4940 optional-key annotation widening in `achievementManagement.ts` (typecheck-gated, zero runtime delta). Full suite green under 2.6.1: `test:typecheck` + 197/197 unit + 619/619 live-maincloud integration (~63.5min). D-02 changelog audit (SK-1..SK-9) captured in the `spacetimedb` skill; maincloud `test1` republished in-place under the 2.6.1 CLI (no `--delete-data`). Verification 19/19, code review clean. Follow-up noted: `SELECT 1 AS ok` fails under 2.6.1's stricter SQL parser (behavior change the D-02 audit missed; doesn't affect the test suite). Next: Phase 17 (cost-tables data layer).*

<!-- Phase 16.4 history -->
*2026-05-03 after Phase 16.4 SpacetimeDB v2.2.0 refactor pass. Adopted v2.2.0 surfaces opportunistically: `ctx.db.X.clear()` replaced 50 manual iter+delete sites in `server_nuke_test_data` (SC#1); `spacetime:publish:migrate` sibling script added (SC#3); v3 WebSocket transport baseline captured at `transport-evidence/` showing 796:1 egress dominance (SC#4); `useTable({ enabled })` adopted at admin panels (SC#5); `useReducer(reducers.X)` adopted at 5 React component sites (SC#6). Plan 02 `isInternal` guards on 3 scheduled reducers were reverted by Plan 07 hotfix after SDK source-level diagnostic revealed v2.2.0's `senderAuth.isInternal` is always false — engine-level "no such reducer" rejection is the operational defense (SC#2 audit value preserved as durable deliverable). Energy-model byte-identical pre/post (SC#8). No B-tree #4733 candidates found (SC#9). 41 commits across 7 plans. 10 code-review findings deferred to UAT evaluation per `deferred-items.md` (3 in-scope items fixed: WR-04 `loginAsGuest({})` no-arg adoption, WR-05 token-equality guard fail-open fix, WR-08 `useTable [rows, isReady]` tuple destructure). Next: Phase 17 (cost-tables data layer).*
