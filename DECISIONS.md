# Decisions

The product and architecture decisions of `hsr-pvp-spacetime`, one entry per decision.

**Format.** Each entry has an **id**, a **date**, a **status** (`decided`, `agreed`, `recorded` or `deferred`), the **decision**, and where they apply **why**, **supersedes** and **where implemented** (step ids from `ROADMAP.md`; `—` when no single step owns it). `file:line` references tagged "(old repo)" point into the archived repo `italocortez/hsrpvp-spacetimedb-nextjs` at `471a481`. Names such as "Agent S", "Agent M" and "Agent B" refer to the planning deliverables (access/security/ops plan, migration plan, backend bug review) kept locally under `notes/migration/`; codes such as D-B1, CH-S3, TD-5 or F5 are item ids inside those deliverables or the tournament review.

**Append-only.** New decisions are appended at the end with the next free id. An entry is never edited after it lands: when a decision changes, a new entry states the change and names the entry it supersedes in its **supersedes** field. Sub-decisions keep their parent's number with a letter suffix (A22a) and are listed right after the parent.

**Opening section.** A1–A52 below were set by the user on 2026-11-05/06 during the migration planning and copied from the planning brief (environment notes and orchestrator process remarks left out). Sub-decisions that the brief kept inside their parent row (A22a, A26a, A33a, A34a, A41a) are split out as their own entries.

---

### A1 — New repository

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The project continues in a new repository: local `D:\GitsWork\hsr-pvp-spacetime`, GitHub `italocortez/hsr-pvp-spacetime`, **public**, branch `main`.
- **Where implemented:** M0

### A2 — Fresh history from the old repo's tip

- **Date:** 2026-11-06 · **Status:** agreed
- **Decision:** Fresh history: the first commit imports code from `italocortez/hsrpvp-spacetimedb-nextjs` @ `471a481` (tip of branch `feature_nath_claude` on 2026-11-06). The import includes the lifecycle fix `5ff8b53`, the skill fixes `76a1f33` and the scoring/todo design `471a481`. Had later commits landed before the import, the branch tip would have been used instead. The old repo stays as the archive.
- **Where implemented:** M0

### A3 — Frontend stack

- **Date:** 2026-11-06 · **Status:** agreed
- **Decision:** Vite + React + TypeScript + a typed router: TanStack Router preferred, React Router as the fallback.
- **Where implemented:** M3, M4 (TanStack Router kept by A44(4))

### A4 — No HeroUI; the mockups' design system becomes CSS variables

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** No HeroUI. The mockups' own design system (`DESIGN.md`) becomes CSS variables. Tailwind vs CSS Modules was left open for a recommendation (settled by A49: CSS Modules + `tokens.css`, no Tailwind).
- **Where implemented:** M3

### A5 — Hosting: Vercel Hobby, CLI deploys, no paid features

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** Hosting stays on **Vercel, Hobby (free) plan**: a static site plus at most one serverless function, for auth. **Deploys go through the Vercel CLI** using the project's `vercel-setup` / `vercel-deploy` / `vercel-logs` skills. **No paid features, ever**, so Hobby's non-commercial rule is satisfied.
- **Where implemented:** M7, M8

### A6 — SpacetimeDB upgrade in the new repo

- **Date:** 2026-11-06 · **Status:** agreed
- **Decision:** The SpacetimeDB 2.6.1 → 2.14.1 upgrade happens **in the new repo**, before the page ports.
- **Where implemented:** M1

### A7 — Lifecycle-hook export fix

- **Date:** 2026-11-05 · **Status:** decided (done)
- **Decision:** The lifecycle-hook bug (`clientConnected` / `clientDisconnected` not exported) was fixed in the old repo before the import (commit `5ff8b53`). Publishing the exported hooks is gated by A22(1).
- **Where implemented:** old repo `5ff8b53`, imported at M0; first publish gated by S4

### A8 — No GSD; lean docs

- **Date:** 2026-11-06 · **Status:** agreed
- **Decision:** No GSD workflow. Lean docs: `CLAUDE.md`, a short `ROADMAP.md`, `DECISIONS.md`, and feature contracts. Frontend work is added **as ideas come**, not as a pre-written roadmap.
- **Where implemented:** M0 (A51, A52 detail the replacement)

### A9 — Pending todos become GitHub Issues

- **Date:** 2026-11-06 · **Status:** agreed (confirm with the user before any issue is created)
- **Decision:** Pending todos become **GitHub Issues**. They are only drafted (in the local `BACKLOG-ISSUES.md`); nothing is created on GitHub without the user's confirmation.
- **Where implemented:** —

### A10 — Docs policy

- **Date:** 2026-11-06 · **Status:** agreed
- **Decision:** Version the product-defining docs (contracts, architecture, design, decisions, `CLAUDE.md`, skills); gitignore scratch (plans, session notes, logs, `tmp/`).
- **Where implemented:** M0 (`.gitignore`)

### A11 — Planning output is local

- **Date:** 2026-11-06 · **Status:** agreed
- **Decision:** The planning run produced plans only: no code, no repo creation, no commits. Its output lives in gitignored `notes/migration/` and was copied into the new repo's gitignored `notes/` (see A51(1)).
- **Where implemented:** —

### A12 — Toolchain: TypeScript 7.1 beta and Node 26 LTS

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** **TypeScript 7.1 beta** (the Go-native compiler), pinned exactly to `7.1.0-beta`; this is a hobby project, so the user accepts the beta risk; move to stable 7.1 when it ships. **Node 26 LTS.**
- **Where implemented:** M0 (pins, `.nvmrc`), M1

### A13 — One responsive page per screen

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** **One responsive page per screen, no separate mobile version.** The site must look good on mobile. Each page adapts through CSS breakpoints exactly as the mockups do, with no mobile-only routes, pages or component trees.
- **Supersedes:** the old repo's dual-DOM allowance (R4, see `docs/research/legacy-decisions.md`).
- **Where implemented:** S14 (every page port), M3 (breakpoint scale, A49a)

### A14 — Permissions are a core, reliable feature

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** **Permissions are a core, reliable feature.** Moving tables from public to private and serving them through views is accepted, even if it amounts to a backend redesign.
- **Where implemented:** S3, S9

### A15 — No hero video

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** **No hero video.** The new landing mockup uses a static image, so the video and its full-screen loader go away (`public/recording` is not imported).
- **Where implemented:** M0 (not imported), S14 (`index` port)

### A16 — Maincloud energy limit: 100,000 per month

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** **Maincloud energy limit: 100,000 energy (TeV) per month**: the Free tier plus a referral-program bonus, **not Pro** (consequences in A41).
- **Supersedes:** the stale figures 40,000 in the `spacetimedb` skill and 90,000 in `tools/energy-model.js` (and the 102,500 ceiling of the old v0.9 notes).
- **Where implemented:** M0 (`CLAUDE.md`), S12 (skill energy figures → 100k), `tools/energy-model.js` `MONTHLY_BUDGET 100000`

### A17 — Drop the Spine columns

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** **Drop `skelUrl`, `atlasUrl`, `atlasImgUrls` from `HsrCharacter`.** No animated (Spine) portraits for now; static images only.
- **Why:** removes per-row weight from the reference set and the Spine render tier.
- **Where implemented:** M0 (`data/seed/characters.json` without the Spine keys), S3 (schema)

### A18 — Reference data is public and versioned

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** **Reference data is public and versioned** in the new repo: characters, light cones, costs and synergies (formerly the gitignored `test/data/*.json`), under `data/seed/`.
- **Where implemented:** M0 (`data/seed/`), M2 (seed script reads it)

### A19 — Event tables carry no audit columns

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** **Event tables carry no audit columns.** Remove them from `LobbyCursorEvent` in the backend reset. The skill's audit policy carries this exception.
- **Where implemented:** S3

### A20 — One pre-launch backend reset

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** **One pre-launch "backend reset" phase** in the new repo; the user stresses it **must be planned carefully: many moving parts**. Contents: the SDK upgrade, security fixes (`register_server`, test-only reducers, cursor throttle), the public → private redesign, the Spine column drop (A17), event-table audit columns (A19), the series-settings todos, merged rating, the cost-set coverage check, the cost-set staging-table decision, and the designed scoring foundation + synergy groups (A21). Sequenced in the access/security/ops plan.
- **Where implemented:** M1, M2, S3–S11

### A21 — Scoring design

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  - The **server computes the winner**, with a live frontend preview from a **shared formula module**.
  - Units: **cycles** for Memory of Chaos / Anomaly Arbitration, **points** for Apocalyptic Shadow.
  - Lineups are **8 characters in halves or 12 in thirds** (groups of 4). Results are entered **per group**; deaths as **one total**.
  - Roster cost = cost-table value (Classic) or budget spent (Auction).
  - Handicaps: roster diff, threshold, death penalty.
  - Tie-breaks: **lower roster cost → more 4★ → fewer 5★ eidolons**. If still tied, the **referee decides** via a `winnerOverride` field, accepted only on an unresolved tie and audited (authority refined by A39).
  - **Additional score modifiers:** freeform, signed, itemized bonus/penalty entries per team per game, each with a required reason; set by the referee or tournament organizer, applied before tie-breaks, and they reset captain confirmations when changed.
  - **Synergies are unordered pairs**; only the captain or a referee arranges the lineup.
  - Full spec in the three todos marked "Decided design (2026-11-06)" (old repo).
- **Where implemented:** S3 (tables), S7 (`shared/scoring/`, reducers), M0 (`data/seed/synergies.json` canonicalized as unordered pairs)

### A22 — Decisions after the backend bug review

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  1. The exported lifecycle hooks (A7) stay in source but are **not published until F1, F3 and F5 are fixed**; the first publish of the new repo must include those fixes.
  2. **All of the review's Critical and High findings** (F1–F9, T1–T9, R1, R2) are **in the A20 reset scope**.
  3. `pick` / `ban` / `nominate` / `bid` / `pass` **also reject while the draft is paused** (not only `timer_expiry_*`).
  4. F8 is fixed by **splitting the liveness guard**: `ensureNotConceded` for result reducers, `ensureMatchAlive` stays for draft/equip, so results can be submitted in `AwaitingResult`.
  5. **Referee disconnect** (closes the F5 question): when the referee disconnects, the flag moves to the first *online* candidate in this order: **the host → Blue players in join order → Red players in join order → spectators in join order → coaches**, skipping the leaver and anyone who `voluntarilyLeft`. Spectators and coaches disconnecting never pause the draft or move any flag (F5 fix).
- **Where implemented:** S4 (F-items spread over S4–S6 as sequenced)

### A22a — Referee transfer grace period

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The referee transfer is **not immediate**. `client_disconnected` schedules a `referee_transfer_check` scheduled-reducer row for **15 seconds** later; when it fires, the flag moves only if that referee is still offline (a page refresh reconnects within the window and keeps the flag). The same scheduled check is where the player auto-pause decision is made, so a refresh doesn't pause the draft either; both detailed in step S4.
- **Where implemented:** S3 (`RefereeTransferCheck` table), S4

### A23 — Tournament backend: partial rewrite in the reset

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** Basis: the tournament intent review (review TD-1 option c).
  - **Replace outright:** the bracket engine (the prototype moves into a shared pure module imported by both the module and the web app: exact slots, BYE walkovers), the result → bracket hand-off (A24), and the permission layer (A25).
  - **Keep** the tables, with the review's additions, and the registration, team and lifecycle reducers with local fixes (T2, T9, T10, T13, T17, T18, T23, T24).
  - **Delete** `submit_and_advance_bracket`, `advance_bracket_match`, `admin_set_bracket_winner` and the inline advancement in `dq_participant`.
  - **Group standings are computed, not stored:** `GroupPhaseRecord` is dropped; a shared pure `rankGroup(decidedGroupMatches, teams, rule)` runs on the server when advancing out of groups and in the web app for the live standings table; group membership lives on `TournamentTeam.groupId`.
  - The remaining review decisions (TD-3…TD-16, TD-18) are recorded as A25 onward.
- **Where implemented:** S3 (`GroupPhaseRecord` drop), S8 (`shared/bracket/`)

### A24 — Tournament finalization at the terminal stage

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The phase 12.3 vision (D-H-02) stands. Nothing derived (MMR, player/character stats, achievements, leaderboards, public history) is computed for a tournament match until the tournament reaches a terminal stage, so a mid-tournament rollback never has to reverse any of it.
  1. **"Result settled" is split from "match finalized":** when a tournament match result becomes Validated (casual: at submit; ranked: at staff validation; a concede counts as a settled result), the bracket advances through **one idempotent single-writer helper**; nothing else happens.
  2. The lobby **parks in `AwaitingResult`** with its `MatchResultRecord`, participants and session rows kept as the durable input (D-22 already exempts that stage; lobby GC already skips it).
  3. **Rollback during the tournament** reverts the bracket, marks the record `Voided` for audit, and hard-deletes the parked lobby so a replay lobby can be created.
  4. The **Completed transition finalizes everything**: MMR from the stored snapshots in bracket order, then per-match finalization writing history rows that are **readable by that match's participants and staff from that moment** (A37; history is never public). The `revealTournamentHistory` scan and `isPubliclyVisible` are removed. Casual tournament matches **no longer auto-finalize at submit** (they only validate there). Voided records are skipped for MMR and cleaned up. Per-match `finalize_match_result` is **removed from the reducer surface for tournament matches**, so the guard cannot drift again.
  5. **Cancelled:** same finalization, **stats are counted, MMR is not**.
  6. **Abandoned tournaments:** no scheduled GC; a **manually triggered admin reducer** (admin-panel button) cancels idle in-progress tournaments.
  7. **One transaction vs chunked** finalization at Completed: decided from SpacetimeDB's limits, data safety first (settled as chunked by D-D1, A43).
  - The review's `TournamentMmrInput` table is not needed; the surviving record is the input. This settles review **TD-17** (no MMR for cancelled) and shapes **TD-13 / TD-14** (override = rollback + re-apply through the single writer; `autoAdvanceBracket` is replaced by "advance on Validated").
- **Why:** a mid-tournament rollback must never have to reverse derived data.
- **Supersedes:** the narrowing in old-repo commit `bed8fee`; the per-match tournament finalization path.
- **Where implemented:** S8 (`admin_cancel_idle_tournaments`, `finalize_match_result` rejects tournament records)

### A25 — Tournament assistant permissions: three flags

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** `TournamentAssistant` carries three flags: `canManageParticipants` (approvals, waitlist promotion, check-in, DQ, stand-ins, adding participants), `canManageBracket` (seeding, generation, group → elimination advancement, creating tournament lobbies) and `canResolveResults` (validating ranked results, staff corrections, rollback). **Only the organizer and Moderator+** may cancel the tournament, edit its settings or rules, or manage assistants. One helper, `ensureTournamentPermission(ctx, tournamentId, 'owner' | 'participants' | 'bracket' | 'results')`, replaces `ensureTournamentAccess`; every tournament reducer names its permission (review TD-3).
- **Supersedes:** the old five assistant flags; `ensureTournamentAccess`.
- **Where implemented:** S3 (columns), S8

### A26 — Participant and team status, low friction

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-4 option b)
  - `TournamentTeam.status` ∈ {Forming, Ready, Active, Eliminated, Withdrawn, Disqualified} is the single gate for seeding, team edits, lobby seats and bracket placement.
  - **Participants never set it:** Forming → Ready when the team has `teamSize` eligible members; Ready → Active at Seeding → InProgress; the bracket sets Eliminated; staff set Disqualified; a captain withdrawing the team sets Withdrawn.
  - Individual `TournamentEnrolled` statuses stay informational (phase 10.1 D-41).
  - **Check-in is team-level, done by the team captain** (or staff) in one click; per-member check-in and per-member no-show pruning are removed; absent members are covered by the per-match stand-in mechanism.
  - **Players are auto-seated** on their team's side when joining a tournament lobby (TD-12, A35).
  - The tournament page states what's missing ("waiting for one more member", "awaiting approval", "check in before…"), served by a view.
  - A team still Forming at registration close becomes Withdrawn, but its members stay enrolled so the organizer can re-place them.
  - **Waitlist promotion stays manual only:** staff see the waitlist in registration order (the row's audit creation timestamp) and promote with `waitlist_promote`, which must check a spot is free; promotion implies approval.
- **Supersedes:** per-member check-in and no-show pruning.
- **Where implemented:** S3 (status column), S8

### A26a — Withdrawn and disqualified rows

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  1. A withdrawal before registration closes **deletes** the `TournamentEnrolled` row (plus team membership, `TournamentPlayerAccount` locks, requests and calendar invites, as before), so the spot frees and the player may register again.
  2. **Disqualified rows are kept**, excluded from capacity, hidden from the public participant list, shown to staff, and they **block re-registration**.
  3. **No self-withdrawal after registration closes**; staff disqualify, or the team plays with a stand-in; rows and teams stay for the bracket record (TD-18).
  4. **Waitlisted players may create or join a team** while waiting (the team stays Forming, "waiting for X to be promoted"); their **`TournamentPlayerAccount` rows are created at promotion, not at registration**.
  - Capacity = rows that are neither waitlisted nor disqualified.
  - **Definitions:** "registration closes" = the transition out of the `Registration` stage (to `CheckIn` or `Seeding`). Self-withdrawal is allowed in `Registration` and `CheckIn` (row deleted), never from `Seeding` on. Team edits by participants stop when registration closes. Staff may still promote from the waitlist, add a participant, or move an enrolled player into a short team **until the bracket is generated**; teams still Forming at that point are Withdrawn (A26).
- **Supersedes:** the "already registered" rejection of withdrawn players and the capacity count that included them (`tournamentRegistration.ts:28-32,50-52`, old repo).
- **Where implemented:** S8

### A27 — Grand final: single match, winners-bracket head start

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-5 option a) Single match, no bracket reset; the winners-bracket finalist gets a head start. The bracket engine places the WB finalist in slot 1 (= Blue) and the LB finalist in slot 2 (= Red); `create_tournament_lobby` copies `BracketMatch.winnerAdvantage` and `start_draft` seeds `gamesWonBlue = winnerAdvantage`. **Validation:** `winnerAdvantage < ceil(grandFinalBestOf / 2)`, otherwise the final would be decided before play (review CH-T9); with the {1, 3} bestOf cap a head start exists only in a Bo3 final, as 1 game. **Also binding:** the account lock (`TournamentPlayerAccount`) only lists usable accounts and blocks deleting them during the tournament; it never blocks joining other tournaments. The open "eidolon/superimposition snapshot at draft time" item (A21 todo) is folded into the same design, since locked accounts can still be edited mid-tournament.
- **Supersedes:** the hardcoded `gamesWonBlue = 0` (`draftClassic.ts:151`, old repo).
- **Where implemented:** S6 (`start_draft` seeding), S8

### A28 — Series length

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-15 option b) `Tournament.defaultBestOf` for every bracket match plus `Tournament.grandFinalBestOf` for the grand final, **both capped to {1, 3}**; the cap applies to lobbies and presets too (A38(2)). The phase 10.1 inheritance chain is unchanged: Tournament → `BracketMatch.bestOf` → `Lobby.bestOf` → `MatchSession.seriesBestOf`. No per-round override table now; it can be added later as rows that override the default without touching the chain.
- **Where implemented:** S3 (columns), S6 (cap), S8

### A29 — Third-place match only in single elimination

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-6 option a) `create_tournament` / `update_tournament` reject `has3rdPlaceMatch = true` for DoubleElimination and GroupIntoDoubleElim; the engine never generates a third-place match there, and third place is the losers-bracket final loser. The bracket prototype already asserts this.
- **Where implemented:** S8

### A30 — Group ranking rule

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-7 option a) **Points → head-to-head (only when exactly two teams are tied) → game differential across the group (from the stored series score on `BracketMatch`) → seed.** Implemented once as the pure, unit-tested `rankGroup` comparator (A23). **Normalize the codebase to it:** one vocabulary for the rule everywhere (helper and variable names, enum/column names, error messages, the brackets contract and architecture docs); the two conflicting contract passages (`docs/brackets/contract.md:241` vs `:317`, old repo) and the phase 4 wording are replaced, not annotated.
- **Supersedes:** the conflicting contract passages.
- **Where implemented:** S8, S12 (docs)

### A31 — No draws anywhere

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-8 option b) Every match, group or elimination, produces a winner through the A21 chain (adjusted result → tie-breaks → referee `winnerOverride`). Group standings count wins only. The shared scoring module has no group-specific branch.
- **Supersedes:** the W2/D1/L0 scheme and the `draws` column (dropped); phase 10.1 D-34 "draw blocks advancement" becomes moot; the `winnerId = 0` draw sentinel.
- **Where implemented:** S3, S7, S8

### A32 — Group sizing: `groupSize` is a minimum

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-9 option a) Group count = `floor(teams / groupSize)` (at least 1), leftover teams spread one per group, so no group is smaller than `groupSize` and groups differ by at most one team. The phase 4 wording "no group smaller than groupSize" is the one kept.
- **Supersedes:** the `ceil` in `helpers/bracketGeneration.ts:457` (old repo).
- **Where implemented:** S8

### A33 — Tournament match settings: two tiers

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  - **Integrity set** = columns on `Tournament`, copied into every tournament lobby and **locked** there by `update_lobby_settings` (D-65, `lobbySettings.ts:73-110`, old repo): teamSize, gameMode, matchType (from `countTowardsMmr`), both anonymity flags, rosterVisibility, requireOwnership, costSetId, disconnectPolicy + forfeit timer, allowMirrorPicks, bestOf (via the bracket, A28), **plus `lineupFormat`** (new column; already locked in tournament lobbies per the A21 todo).
  - **Free set** = everything else (draftMode, banMode, timers, budgets, minimumBidRaise, handicaps, modifiers, referee power flags, player pause, shelving control, exclusive concede), **editable per lobby in Waiting** by the lobby host or Moderator+, so staff can adapt a single match.
  - The organizer's options menu shows the integrity set up front. Who hosts a tournament lobby: A34.
- **Supersedes:** review TD-10 (withdrawn).
- **Where implemented:** S3 (columns), S8

### A33a — Free-set starting values: the system preset

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The hardcoded tournament-lobby constants (`tournamentLobby.ts:109-146`, old repo) become a **built-in default `LobbyPreset`**: system-owned, seeded at bootstrap (same bootstrap path as the server identity, detailed in step S6), not deletable. `Tournament` gets a `lobbyPresetId` that defaults to it; the organizer may **swap it for one of their own presets** while the tournament is editable. `create_tournament_lobby` copies the free fields from the pointed preset at creation time; if that preset no longer exists, the built-in default is used.
- **Where implemented:** S3 (`lobbyPresetId`), S6 (system preset), S8

### A34 — Tournament lobby creation and referee

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-11 option b, D-64 kept) Any participant of the bracket match, or staff, may create the lobby; **the creator is host and referee**, because staff are not always available to open every match. A staff creator is seated as a spectator referee and the one-lobby-at-a-time rule applies to them unchanged. Staff who join later can take the referee flag through the existing `transfer_referee` / `reclaim_referee` reducers. The free settings (A33) stay editable by the host or Moderator+, as in casual lobbies.
- **Where implemented:** S8

### A34a — Referee powers stay unconditional

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** Referee powers stay unconditional for a player-referee: no special restrictions on concede, kick or undo (the `winnerOverride` exception is A39).
- **Why:** this is a community-run project; bad sport is handled by talking to staff, who have `resolve_bracket_match` / rollback (A24) to correct outcomes.
- **Where implemented:** S8 (no change to the powers)

### A35 — Seat enforcement in tournament lobbies

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-12 option a) `join_lobby` and `set_team_slot` allow only: members of `BracketMatch.team1Id` and its approved stand-ins on **Blue**; members of `team2Id` and its stand-ins on **Red**; everyone else, staff included, as **Spectator** (coach slots follow the same team rule). Players are auto-seated on join (A26). The bracket credits the result by that fixed mapping (Blue = team1, Red = team2), so a win can no longer be credited to the wrong team. Staff who want to play must be enrolled on a team like anyone else. Helper: `allowedSlotsFor(ctx, lobby, userId)` in one place, used by both reducers.
- **Where implemented:** S8

### A36 — Tournament columns

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** (review TD-16)
  - **Drop:** `checkInPerRound`, `bracketRevealAt`, `autoAdvanceBracket` (replaced by "advance on Validated", A24).
  - **Keep as needed features:** `TournamentEnrolled.allowRandomTeamAssignment` (random team formation for solos, phase 4 D), `TournamentEnrolled.anonymousAlias` (anonymous solo alias + team naming, phase 4 `04-CONTEXT.md:59-63`, old repo), `Tournament.groupAssignmentMode` (Manual mode); build timing in A36a.
  - **Finish:** `checkInEnabled` and `groupAdvanceCount` (1 or 2) become create/update settings; the `autoForfeitEnabled` / `autoForfeitMinutes` pair is **replaced by one `disconnectForfeitSeconds: t.u32().optional()`** in the integrity set, same shape as `Lobby` and `LobbyPreset`; **`seasonId` = the active season, 0 for now** (season handling is not designed yet; no season logic in this version); the `minimumMmr` registration check is built (rating basis: A36b).
  - **Validation gate under its real name:** `Tournament.requireResultValidation: t.bool()`, forced `true` when `countTowardsMmr`, default `false` for casual; when true, a submitted result waits in Submitted for a `canResolveResults` staff member before the bracket advances (A24 step 1), and a captain's dispute blocks validation.
  - **Schema-change rule:** SpacetimeDB auto-migrates a column **added at the end with a default value**; only drops, type changes and non-defaulted additions need a wipe. Keeping planned columns is therefore a convenience, not a necessity.
- **Supersedes:** the `autoForfeitEnabled` / `autoForfeitMinutes` pair.
- **Where implemented:** S3, S8

### A36a — Build timing for the kept tournament features

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** All three are built in the reset: anonymous alias + team naming (per `04-CONTEXT.md:59-63`, old repo: solo team = display name, anonymous solo = free alias, team = captain's choice, plus a rename reducer); **random team formation** for opted-in solo players at registration close (deterministic via `ctx.random`, respecting waitlist / approval / team status); and **manual group assignment** during Seeding with size validation before generation (A32).
- **Where implemented:** S8

### A36b — Minimum-MMR basis

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The player's `MmrRating` for the tournament's game mode in the active season (only one season exists). No account-rating floor. **Guests cannot join a minimum-MMR tournament.** Verified players are always ratable: `MmrRating` rows are created only at a player's first finalized ranked match (`finalizationHelpers.ts:36,142,158`, old repo), not at Discord verification, so a verified player without a row is evaluated at the configured **initial rating (`EloConfig.initialRating`, 1000)**. Rule: `isGuest` → rejected; otherwise `(ratingRow?.rating ?? initialRating) >= minimumMmr`.
- **Where implemented:** S8

### A37 — Anonymity is a first-class requirement

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The backend and pages are designed **with anonymity in mind from the start**, for ordinary lobbies and tournaments alike.
  - Binding rule: **no row readable by a client may carry a user id for an anonymous context, including the audit columns `createdById` / `lastModifiedById`.**
  - Source tables that hold identities in lobby, match, tournament and calendar contexts become private; views return the anonymous label (team slot + join order, never derived from the id) to everyone except the player themself, teammates where the design allows, and staff; the identity link stays in private tables for stats and MMR.
  - **Match history is no longer public:** `MatchSessionHistory` / `MatchParticipantHistory` / `MatchSessionStepHistory` are private; a user may read only the rows of matches they played in (plus Moderator+); within those rows the real identities of that match are **revealed after the match** to its participants. No public match-history or opponent-history pages; a profile shows per-match history only to its owner.
  - **Aggregates stay public:** MMR leaderboards, win/loss counts, player and character stats, achievements; only the per-match rows are private.
  - Verify the existing lobby anonymity paths (`helpers/anonymousHelpers.ts`, `anonymousLabels.ts`, the `view_my_*` views) and close every raw-table leak (review F13, C-c8 / CH-T5), with a test that subscribes as an outsider and proves nothing identifying arrives.
- **Why:** the community asked for it for years, to stop **pre-tournament scouting of closed-roster matches**.
- **Supersedes:** `isPubliclyVisible` and the D-91 reveal.
- **Where implemented:** S3 (private tables), S9 (views), S11 (outsider test, task T-S11)

### A38 — Four extrapolations confirmed

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  1. **A concede advances the bracket immediately** as a settled result; staff correct abuse through rollback (A24).
  2. **The bestOf cap {1, 3} applies to casual lobbies and presets too**, not only tournaments (A28).
  3. **Aggregates stay public:** leaderboards, win/loss counts, stats, achievements; only per-match history rows are private (A37).
  4. **A player-host may edit the free settings of a tournament lobby** (A33 free set, handicaps included); every settings change resets both teams' ready confirmations, as before.
- **Supersedes:** phase 10.1 D-80 "concede never auto-advances" (reversed by (1)).
- **Where implemented:** S6 (cap), S8 (concede advance)

### A39 — Tie-break override authority

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** `winnerOverride` on an unresolved tie is accepted only from a referee **not seated on either team**, or from staff (`canResolveResults`, organizer, Moderator+). In a player-refereed **tournament** lobby the record stays `Disputed` until staff resolve it. In a **casual** lobby a player-referee's override is accepted anyway and audited (`winnerOverrideById`). All other referee powers remain unconditional (A34a).
- **Supersedes:** refines A21 (step 4, referee decides) and A34a; accepts Agent S CH-S3.
- **Where implemented:** S7

### A40 — Ratings and anonymity

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  - Ratings are shown **exact** wherever roster visibility allows them (`OpenRoster` / `ClosedWithRating`), on anonymized seats too.
  - **Accepted residual risk**, documented in the anonymous-play contract: matching an exact rating against a public listing can defeat anonymity; the project does not try to prevent it. The award-timing correlation of public achievements is part of the same accepted risk.
  - Mitigation (1): the **public leaderboard shows only the top 20 players per mode**, from a scheduled rebuild (kept for energy reasons; shape in A44(2)/A45(1)); the full `MmrRating` table is **private** so nobody can bulk-list ratings, but **MMR is allowed wherever the UI shows a specific player**: lobby seats, the right-click profile card, the profile's ally/nemesis card (served by `view_my_relationships` with the other player's MMR denormalized into the row, so PAGE-MAP CH-M1 is resolved as "keep the mockup"), and a player's own profile.
  - Mitigation (2): new lobby setting **`hideMmr: t.bool()`** (free set, A33, default false): when the host turns it on, seats and cards in that lobby show the account rating but not MMR.
  - **Profile card in the lobby** (right-click a member, `lobbyroom.html`): served by the per-viewer `view_my_lobby_members` row, never by the user or ratings tables; an anonymized seat's card shows label, team, ready/captain/referee flags, ratings per that row's rules, and the roster only under `OpenRoster`; it withholds name, avatar, title and user id (so no profile link exists). Identified seats get the full card.
- **Supersedes:** Agent S CH-S7 / R3 and CH-S1 (overridden).
- **Where implemented:** S3 (`hideMmr`, `MmrRating` private), S9 (views)

### A41 — Maincloud plan correction: Free tier

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The account is on the **Free tier**; the 100,000 TeV/month comes from a referral-program bonus, not from Pro. Consequences (checked against spacetimedb.com/pricing and the maincloud docs on 2026-11-06):
  - **No pay-as-you-go** exists on Free, so the cap is hard; behaviour at 0 energy is undocumented, so abuse must be made expensive for the attacker.
  - The database **auto-pauses after one week of inactivity** and resumes on the next connection; scheduled reducers, GC, the referee check and the circuit breaker do not run while paused, which is acceptable.
  - **No point-in-time backups** on Free, so there is no data rollback after launch beyond "same commit proven on test1 first" (backups: A41a).
  - **Energy monitoring: the user checks the dashboard themself.**
  - **The referral bonus is permanent:** 100,000 TeV every month, not a one-time credit, so the A16 budget stands and no 2,500-TeV fallback check is needed.
- **Supersedes:** corrects the plan basis behind A16 (any Pro assumption); Agent S D-B6 (PAYG, moot); Agent S D-B3 / B-11 weekly energy check (dropped); Agent S §C.6's assumed 7-day point-in-time recovery.
- **Where implemented:** — (operating constraint; `CLAUDE.md` §2)

### A41a — Backups: monthly local dump, restore reducer

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** A **local script run by hand (monthly)** through the owner's login dumps every user-data table (not reference data, which lives in the repo; not event tables) via the owner's SQL access into a gitignored `backups/<db>/<timestamp>/` folder as **gzipped JSON Lines, one file per table**, plus a manifest (module commit, timestamp, row counts); a few MB, under 1 TeV. **Restore** = wipe → publish the manifest's module commit → bootstrap → a server-only `server_restore_table(tableName, rowsJson)` reducer (owner only, batched) re-inserts the rows in the module's own types; identities restore as values, so player tokens stay valid. **Known trap:** auto-increment sequences may not advance past explicitly inserted ids on 2.14.1; the restore procedure must verify and, if needed, advance each sequence past the highest restored id before the database reopens.
- **Why:** JSON over Parquet because the restore reducer consumes the same shape with no conversion layer or dependency.
- **Where implemented:** backup/restore scripts (`scripts/stdb/backup`, `restore`, `stdb:backup:<t>`), S13 companion

### A42 — Guests keep creating casual lobbies

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** Guest lobbies are created and listed normally. Controls instead of a restriction:
  1. **Kill switch** `AbuseConfig.guestLobbyCreationEnabled: t.bool()`, toggled by an admin reducer and a button in the admin panel; when off, `create_lobby` rejects guests ("Guest lobby creation is temporarily disabled"); guests already in lobbies are unaffected.
  2. **Automatic circuit breaker:** a scheduled reducer every few minutes counts guest-created lobbies in the last window and trips the switch itself above a tunable threshold (e.g. 20 in 10 min), writing an `AdminAlert` row (public table, counts only, no user ids), so the module reacts even when nobody is watching; an admin re-enables it.
  3. **Alerting:** a module cannot send email or call out (reducers have no network), and Vercel Hobby cron runs only once per day (±59 min), so the notifier is an external **GitHub Actions scheduled workflow** (free on the public repo, every 15 min) that reads `AdminAlert` through the HTTP SQL API with a throwaway identity (public table, no server rights, negligible energy) and, when an unacknowledged alert exists with no open issue for it, **opens a GitHub Issue** (label `abuse-alert`, counts in the body) with the workflow's built-in `GITHUB_TOKEN`, so **GitHub emails the repo owner** with no SMTP credentials or extra secrets. Acknowledging the alert in the admin panel stops further issues.
  - Caveats: GitHub disables scheduled workflows after 60 days without repository activity; the breaker itself does not depend on the notifier. Per-identity caps (Agent S B-7) still apply.
- **Why:** user's choice of alert channel: email, preferably from GitHub.
- **Supersedes:** Agent S D-B1 option b (no guest lobbies).
- **Where implemented:** S3 (`AbuseConfig`, `AdminAlert`), S5, `abuse-alert.yml` workflow (S13 companion)

### A43 — Agent S's remaining recommendations accepted

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  - Accepted as a block: D-A1, D-A3, D-A4, D-A5, D-A6, D-A7, D-A8; D-B2, D-B4, D-B5 (the lobby-creation cap applies to guests too, per A42, not "0 guests"); D-C1, D-C2, D-C3, D-C4, D-C5, D-C6; D-D1 (chunked), D-D2, D-D3, D-D4, D-D5, D-D6.
  - Challenge **CH-S6: the server resolves a pick's eidolon** (and superimposition once light cones have ownership data) **from the selected accounts whenever `requireOwnership` is on, ignoring the client argument**, so a player cannot declare E0 to pay less and play E6.
  - Superseded by earlier entries: D-A2 (A40: achievements public), D-B1 (A42: guests create lobbies; **guests still cannot create presets or cost sets**, which the existing organizer-role guards enforce), D-B3 (A41: the user watches the dashboard), D-B6 (A41: Free tier, no PAYG).
  - D-C3 answered: **the old Next.js app is not hosted anywhere**, so there is no old Vercel project to retire; the new Vercel project is `hsr-pvp-spacetime` (Agent M D-M10). Re-claiming and locking the two released database names remains cheap hygiene, not a necessity.
- **Supersedes:** Agent S D-A2, D-B1, D-B3, D-B6 (as listed).
- **Where implemented:** S2–S9 per item (CH-S6 in S7; D-D1 in S8; D-C items in M2/S13)

### A44 — Reconciliation of the three planning deliverables

- **Date:** 2026-11-06 · **Status:** recorded
- **Decision:**
  1. **Subscriptions:** PAGE-MAP §0.2 (Agent M's D1–D10) is authoritative over Agent S's "Views per page" where they differ: no page except the admin Users tab subscribes the `User` table; names and avatars are denormalized into the views that need them; the S9 view catalogue gains `view_my_mmr_ratings` (per-sender, one row per mode), `view_user_by_username(username)` (exact lookup, index-only), `view_tournament_matches_for_me` and `view_my_stand_ins` on the tournament page, `view_my_lobby_bans` + `view_lobby_presets` on the lobby room; match views and cursor events subscribe only when the lobby stage is past Waiting; reference tables mount once per session, never on `/`.
  2. **Leaderboard shape:** the `Leaderboard` table stays public and `rebuildLeaderboard` writes **only the top 20 rows per category**; `MmrRating` is private; no `view_leaderboard` view is needed (confirmed by A45(1)).
  3. **Auth:** Agent M's §4.6 is the auth plan: option (b), one Vercel function pair + a `LinkRequest` code flow, with a user-run 30-minute SpacetimeAuth probe that could flip it to (a); the `LinkRequest` table and reducers are shared by both, so S3 is not blocked. `ctx.senderAuth.jwt` exists even in the 2.6.1 SDK; SpacetimeAuth's discovery document advertises `provider_id`, `login_method`, `preferred_username` (the probe outcome is A46).
  4. **TanStack Router stays** (A3) with exact pins and `npm ci`; the May 2026 supply-chain incident (84 malicious versions, 2026-05-11; all-clear 2026-05-15) is remediated, but "publishing now uses provenance" is **not** supported by the postmortem (it lists provenance as a gap), so exact pins and lockfile review are the real control.
  5. **Bracket library:** `@g-loot/react-tournament-brackets` is ISC on npm but LGPL-2.1 on GitHub; do not fork it; the bracket view is a custom SVG layout over `shared/bracket/` once the tournament mockup exists.
- **Supersedes:** Agent S's "Views per page" where it differs from PAGE-MAP §0.2 (including the `User` rows by id); old-repo R7 "fork the bracket library" (by (5)); Agent S's `view_leaderboard` (by (2)).
- **Where implemented:** S9 (1, 2), M6 (1), M5 (3), M0/M4 (4), S8/S14 (5)

### A45 — Schema-level decisions from the page map

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** All in the reset:
  1. **Leaderboard:** `Leaderboard` stays public and `rebuildLeaderboard` writes only the **top 20 rows per category**; `MmrRating` private (A40, A44).
  2. **Ban Restriction is built**, not dropped: new lobby setting `banRestriction` with the mockup's four options (`#inpBanRestrict` in `index.html` / `lobbies.html` / `lobbyroom.html`): **No restriction, Max 1 DPS, Max 2 DPS, Max 1 per role**, using `HsrCharacter.role`; free set (A33), stored in presets, enforced server-side in `ban_character` **per team** and respected by the timer-expiry auto-ban; `view_lobby_browser` exposes it.
  3. **Three new reducers:** `shuffle_teams(lobbyId, mode)` (random swap / team swap; host or Moderator+, Waiting only, one confirmation reset); `unban_member(lobbyId, userId)` (host, referee with `refereeCanKick`, or Moderator+; also exposed to the admin In-Cell Edit); `delete_my_account()` for verified users (guards: not in a lobby, not enrolled in a live tournament; cascades through `performUserDeletion`; `delete_guest_account` folds into it).
  4. **Calendars are public between players:** no consent flag; a saved player's availability is visible to any saver, as before.
  5. **`refereeExclusiveConcede` becomes a `create_lobby` argument** (default true, preset-able), still editable in Waiting (A38(4) tiering).
- **Where implemented:** S3 (columns), S6 (Ban Restriction, new reducers), S9 (`view_lobby_browser`)

### A46 — Auth: the Vercel function, SpacetimeAuth deferred

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  - **SpacetimeAuth probe results** (run by the user with OIDC Debugger against `hsr-spacetimedb-test1`; no personal values recorded): `iss = https://auth.spacetimedb.com/oidc`; `aud` = the client id; `sub` = `user_…`; `project_id` present; **`login_method = "discord"` and `provider_id` = the Discord user id (17-digit snowflake)**, so D-08 ban-by-Discord-id works from the signed token with no bridge; `preferred_username`, `picture` (Discord CDN avatar), `email` + `email_verified: true` present; `name` / `given_name` / `family_name` null; `auth_time`, `nonce`, RS256. **ID-token lifetime = 900 s (15 min)**, below the 1-hour rule, so a switch would still need the code spike "step 2 (a)" (connection kept past 15 min; reconnect with a fresh token through `withTokenProvider` + silent renew; `offline_access` is in `scopes_supported`). SpacetimeAuth is enabled on the test database, so it is available on the Free tier.
  - **Hosted login page** offers Google, GitHub, Discord, Twitch, Kick (documented) **plus two built-in methods the docs don't list: email magic link and "Anonymous login".** Its title shows the SpacetimeAuth project name (the old database name at the time). The user wants **anonymous + Discord only**; whether magic link can be disabled and how far the page can be themed is a dashboard question.
  - **Module-side policy regardless of the page:** a token whose `login_method` is not `discord` is not a verified user (rejected at link time).
  - **Open probe:** if a SpacetimeAuth anonymous login that later continues with Discord keeps the same `sub`, the guest → verified merge is unnecessary for SpacetimeAuth-born guests.
  - **Decision: the Vercel function (Agent M §4.6 option b) is the auth approach.** SpacetimeAuth is **deferred until it leaves beta with user management**; the probe results are what the later switch needs (a `login_with_provider` reducer plus `iss` / `aud` checks, no schema change).
  - **Generalize the provider identity now anyway:** `UserPrivate.discordId` → `loginMethod` + `providerId`, `BanRecord` keyed the same way; policy Discord-only at launch.
  - Clean-up for the user: remove the `oidcdebugger.com` redirect URI from the SpacetimeAuth client and disable the Discord provider (or SpacetimeAuth itself) on `hsr-spacetimedb-test1` so nothing can log in through it.
- **Why:** SpacetimeAuth's user directory stores each player's Discord username and **email** and offers **no user deletion** in the dashboard, the CLI (`spacetime auth` has only `config` / `idp` / `client`) or the docs, so a player's deletion request could not be honored; with the function, the database holds only the Discord id and username and `delete_my_account` (A45) removes everything.
- **Supersedes:** chosen over A47 (SpacetimeAuth configuration, deferred) and Agent M §4.6 option (a).
- **Where implemented:** M5 (function + link-code flow), S3 (`loginMethod` + `providerId`)

### A47 — SpacetimeAuth configuration and identity model (deferred reference design)

- **Date:** 2026-11-06 · **Status:** deferred
- **Decision:** Kept as the reference design for a future switch to SpacetimeAuth; not adopted (A46 chose the Vercel function).
  - Available settings (from the dashboard's Settings tab): Display Name, Favicon URL, Text / Background / Primary / Box / Border colors, **EMAIL LOGIN** and **ANONYMOUS LOGIN** toggles, Steam keys; tabs Overview, Clients, Users, Roles, Identity Providers, Settings; no custom CSS.
  - **Proposed configuration (to confirm):** Display Name = the site's name; **Email login OFF; Anonymous login OFF** (guests stay anonymous SDK identities created in the app's own modal, no redirect); Discord the only enabled provider, so the hosted page is a single "continue with Discord" pass-through in the site's colors.
  - **Identity model:** identity = blake3(`iss` | `sub`), stable per SpacetimeAuth user; `UserIdentity` maps it to the `User` row; a new `login_with_provider` reducer on first connect with a SpacetimeAuth token creates/updates `User` + `UserPrivate` from the claims (`login_method`, `provider_id`, `preferred_username`, `picture`), replacing the Vercel bridge; `ctx.senderAuth.jwt` is checked for `iss` and `aud`. Guest = anonymous SDK identity; verified = `login_method === 'discord'`; any other method refused.
  - **Wipes:** auth users live in the SpacetimeAuth project, so a wipe only drops our rows; the same login yields the same identity and a fresh `User`; backups (A41a) restore `UserIdentity` by identity value.
  - **One SpacetimeAuth project per database** (test1, prod), one Discord application for both (same callback URL).
  - **Rules unchanged:** `User.role`, flags, bans keyed on our rows and `providerId`; SpacetimeAuth's own Roles unused; emails stay in SpacetimeAuth's directory, never in our database. The guest → verified link-code merge is still needed because guests are SDK identities.
- **Where implemented:** — (deferred)

### A48 — Multi-device presence

- **Date:** 2026-11-06 · **Status:** recorded (requirement for S4/S9)
- **Decision:** One user may hold several identities (one per device; `server_link_provider` re-points a new device's guest identity to the existing user, `server.ts:128-134`, old repo; identity GC keeps identities 90 days idle, the newest always). Per-user views already give every device the same live rows. **Bug:** `client_disconnected` (`index.ts:162-168`, old repo) and the lobby-member loop mark the *user* offline when *any* identity disconnects, so closing one device while another is connected shows the player offline and, after the A22a grace, moves their flags. **Fix:** `UserPresence` (Agent S D-A1) carries a connection count per user (or one row per identity); `isOnline` = count > 0; `LobbyMember.isOnline` follows the user; the 15-second `RefereeTransferCheck` and auto-pause fire only when the user has no live connection left. Note: a second connection on the **same** token is a 2.10.2 session takeover (the old connection's lifecycle runs, then the new one is accepted), which is the page-refresh case the grace period already covers.
- **Where implemented:** S3 (`UserPresence`), S4, S9

### A49 — Bootstrap defaults accepted

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** Agent M's defaults:
  - D-M1 npm-workspace layout `web/` + `spacetimedb/` + `shared/`;
  - D-M2 one committed bindings copy at `web/src/module_bindings/`;
  - D-M3 drop `spacetimedb/dist` and the 788 tracked `spacetimedb/node_modules` files;
  - D-M4 TanStack Router, exact pins, `npm ci`, lockfile review;
  - D-M5 CSS Modules + `tokens.css` from `DESIGN.md`, no Tailwind;
  - D-M6 Biome;
  - D-M7 React 18 now, 19 + compiler later;
  - D-M9 a hand-written asset service worker + idle portrait warmup, no `vite-plugin-pwa`;
  - D-M11 the project's own `vercel-*` skills, the marketplace plugin disabled;
  - D-M12 self-hosted fonts.
  - D-M13 (design files in git) and the breakpoint scale: A49a.
- **Supersedes:** A4's open Tailwind vs CSS Modules question (CSS Modules).
- **Where implemented:** M0 (layout, pins), M3 (styles, fonts), M10 (service worker)

### A49a — Design files in git; breakpoint scale

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  - D-M13 accepted: `design/DESIGN.md`, `design/mockups/*.html` (the ten files, including `match-classic.html` and `standby.html`), `design/assets/**` and `design/UI-DECISIONS.md` (curated Open Design memory notes) are **committed**; in a public repo the mockups become public, as the old repo's assets were (say so before copying if one must stay private). Screenshots, `.file-versions/`, `*.artifact.json` and `lc-data.js` stay out.
  - **New mockups:** the user keeps designing in Open Design; when a page's port starts, its HTML + referenced assets are copied into `design/mockups/` and `DESIGN.md` is re-synced, by a small `scripts/design/import-mockup.ts <page>` that reads the Open Design project folder read-only and skips the clutter; the repo copy is the frozen reference the port is checked against.
  - **Breakpoints:** the six-step scale **480 / 560 / 768 / 1040 / 1120 / 1320** (PAGE-MAP CH-M4); each port snaps its values to the nearest step and records the snaps in the PR; a layout that visibly breaks at a snapped width keeps its original value as a page-local custom media query.
- **Where implemented:** M0 (`design/`), M3 (`media.css`), S14 (import script, per-page snaps)

### A50 — Vercel ships only the built app

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  - `vercel.json`: `outputDirectory: web/dist`, `buildCommand: npm run build -w web`, functions only `api/**`.
  - **`.vercelignore`** excludes `docs/`, `design/`, `test/`, `notes/`, `backups/`, `tools/`, `spacetimedb/`, `data/`, `.planning/`, `.claude/`, and `*.md` outside `web/`, so they are never uploaded.
  - **Standard deploy = prebuilt:** `vercel build` locally, then `vercel deploy --prebuilt` (and `--prod` from `main` after S13), uploading only `.vercel/output`; this also keeps the TS 7.1 beta toolchain off Vercel's build image.
  - **Done-check on every deploy** (M7/M8 and the `vercel-deploy` skill): the deployment file list contains only the built assets, `index.html`, `sw.js`, `robots.txt`, the favicon set and the two functions; static output ≤ ~1 MB excluding fonts; no media in `web/public/` beyond the favicon set (media stays on UploadThing, A15).
- **Where implemented:** M7, M8 (and M0 for the layout it assumes)

### A51 — Paper trail and test strategy

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  1. **The planning brief, the five deliverables and the prototypes are not versioned:** they live in the gitignored `notes/migration/` as the implementation instructions.
  2. **Versioned trail, lean:** `DECISIONS.md` is an **append-only log**, one entry per decision (id, date, decision, why, supersedes, where implemented), opened with a curated copy of the planning decisions (environment notes and the orchestrator section left out); every `docs/<feature>/contract.md` and `architecture.md` is kept, with Phase History rows citing decision ids and reset/migration steps (S4, M3…) instead of GSD phases, under the existing doc rules (architecture updated on every backend change; contracts updated after execution with an execution tag; test files only by explicit task); **one execution log per step** under `docs/log/<date>-<step>.md`, written by the executing session: goal, decisions implemented, files changed, done-check and test results, deviations; `ROADMAP.md` tracks step status.
  3. **Test suite redesigned** (Agent S D-D2 / §D.5, Agent M §5): pure logic in `shared/` (vitest), module reducers and views in the SDK's in-memory harness, a live residue of ≤ 10 files on test1 once per release, web component tests with fixtures, screenshot pairs per page, E2E by hand before a prod publish.
- **Where implemented:** M0 (`DECISIONS.md`, `ROADMAP.md`), every step (`docs/log`), M9 + S10 (tests), S12 (contracts)

### A52 — Planning workflow after GSD

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The **`grill-me` skill replaces GSD's discuss/plan phases** (installed by the user; nothing depends on its internals). The new `CLAUDE.md` keeps the *substance* of every GSD-bound rule and drops the GSD triggers:
  - (a) "Autonomous execution" becomes a plain "when executing an agreed step" section: commits on the feature branch, builds, tests and seed scripts need no prompt; deletions, force operations, pushes, deploys, publishes and real problems do.
  - (b) The gitignore guardrail stays verbatim minus the `files_modified` / pre-execution-audit wording.
  - (c) The Playwright self-check loop stays, with screenshots under `test/frontend/screenshots/<page>/` and no GSD pointers.
  - (d) "Never modify contracts during execution; update after with an execution tag" stays; enforcement = the per-step `docs/log` entry's doc checklist.
  - (e) The UAT one-test-at-a-time format stays as a manual procedure ("during a UAT session").
  - (f) The skills table drops the GSD rows and adds `grill-me` for planning.
  - Skills trimmed on import: `uat/SKILL.md` "GSD Integration" table and GSD command mentions; `uat/references/uat-verification-guide.md` (GSD verify command, GSD UAT paths); `workflow-doc-template.md` provenance examples (now cite decision ids / steps); `spacetimedb/SKILL.md` Phase 16.4 pointers replaced by inline text.
  - Not imported: the GSD tooling under `.claude/` (`get-shit-done`, `agents`, `commands`, `hooks`, `gsd-file-manifest.json`, `context-library`), the old `.claude/settings.json` hooks (`gsd-session-state.sh` and the GSD-versioned security hooks), and `.planning/` except the research files listed in the migration plan (now under `docs/research/`).
- **Supersedes:** the old repo's GSD workflow (`.claude/CLAUDE.md` autonomous-execution, Playwright and enforcement sections).
- **Where implemented:** M0 (`CLAUDE.md`, skill trims, `.claude/settings.json`)

### A53 — `design/` stays local for now

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The `design/` folder (`DESIGN.md`, `UI-DECISIONS.md`, the ten frozen mockups and their assets) is **not versioned for now**: it is gitignored and kept on the developer's machine as a mirror of the Open Design project, which remains the source. Page ports still check against the local copy (PAGE-MAP recipe step 3), `web/src/styles/tokens.css` is still derived from the local `DESIGN.md`, and the §11 deltas per page still go into the local file. Revisit when the port is further along or the duplication is resolved (for example icons served from the CDN or an SVG sprite, A50 M7 done-check).
- **Why:** 24 of its asset files duplicate `web/public/`, and the mockups add 2.4 MB of reference material to a public repo that Open Design already holds.
- **Supersedes:** the "committed" part of A49a (D-M13). The six-step breakpoint scale and the later `scripts/design/import-mockup.ts` idea stand; the script now refreshes the local mirror instead of a repo copy.
- **Where implemented:** M0 follow-up commit (`.gitignore`, `git rm --cached design`).

### A54 — One result record per lobby; the consolidation belongs to S8

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** A lobby has **one** `MatchResultRecord`. The old code's `performConcede` and `defer_match` insert a second record (Validated/Concede, resp. Deferred) next to the Pending record `start_draft` creates. That was a phase-10 sequencing accident, not a design: no plan, decision or contract chose it, and the phase context says the reducers "need to create records mid-draft" as if none existed. **S8 consolidates:** concede and defer update the Pending record in place; `admin_force_finalize`, `process_tournament_mmr` and the dispute guard read that one record explicitly; the finalization participant fallback (D-75) becomes the rule for concedes (live `LobbyMember` roster, not the start-of-draft copy). **S4 only** makes `ensureMatchAlive` / `ensureNotConceded` scan every record of the lobby, so a concede is detected either way. The user chose S8 because the defects are tournament-only (a casual concede finalizes inline and deletes both rows) and S8 rewrites that lifecycle.
- **Why:** F8's guard split (A22(4)) removed the blanket AwaitingResult rejection, so the concede check has to actually see the concede; the T-S4 in-memory test was the first to ask it to. Updating the record in S4 would have shifted audit stamps, `playedAt`, the participant roster and BetweenGames game rows (S7/S8 territory).
- **Supersedes:** nothing (the two-record shape was never decided).
- **Where implemented:** S4 (guard scan), S8 (consolidation)

### A55 — `MatchResultAdjustment.reason` is optional

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** The `MatchResultAdjustment` table stays (A21 asks for itemized, signed modifiers per team per game, each with its own author and audit trail, which columns on `MatchResultGame` cannot hold), but its `reason` column becomes **optional**. The referee may add a bonus or penalty without typing a justification; `set_score_adjustment` (S7) accepts an empty or missing reason.
- **Why:** user review of the S3 schema (2026-11-06): a mandatory free-text reason is friction at the table, and the itemized rows already carry who set what and when.
- **Supersedes:** the "each with a required reason" clause of A21.
- **Where implemented:** S5 follow-up commit (column), S7 (`set_score_adjustment` argument optional)

### A56 — Match replay history: lineups archived, group scores and adjustments not

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:**
  1. **`MatchLineup` gets a history copy.** New `MatchLineupHistory` (`matchHistoryId`, `gameNumber`, `teamSide`, `groups`, `synergySurcharge`, `rosterCost`, audit) written by finalization next to the step, game and participant history rows; the replay view includes it. The lineup is how a strategy was played, so it belongs to the replay. This also settles S3 review L4: `rosterCost` survives on the lineup history row, no extra columns on `MatchResultGameHistory`.
  2. **No history for `MatchResultGroupScore` or `MatchResultAdjustment`.** The replay needs the final results, not the per-group inputs or the itemized modifiers. `MatchResultGameHistory` already carries the adjusted result, deaths and the tie-break level per team; S7 additionally writes the **raw team total** (sum of the group scores before handicaps and modifiers) into the existing per-team `cyclesUsed` / `score` columns of `MatchResultGame`, so the history row shows raw vs adjusted without itemization.
  3. **Deletion, not GC.** Group scores, adjustments and lineups are deleted with the result record on both exits a match has: the finalization cleanup (`runFinalization`, and the S8 chunked tournament finalization) and the lobby GC hard-delete (`hardDeleteLobby`). They never outlive their match, so no scheduled job of their own.
- **Why:** user decision 2026-11-06 after reviewing the S3 scoring tables: the itemized adjustment rows stay for the live match (future community modifier presets), but the replay core is picks, bans, lineups, spend and final results.
- **Supersedes:** nothing; refines A21 storage.
- **Where implemented:** S7 (`MatchLineupHistory`, deletions on both exits, raw totals), S8 (tournament finalize path), S9 (replay view)
