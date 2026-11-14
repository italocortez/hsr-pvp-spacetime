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

### A57 — Guest-lobby circuit breaker runs inline, not on a timer

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** Amends A42(2). The breaker is evaluated **inside `create_lobby`** when a guest creates a lobby, not by a scheduled reducer. A fixed-window counter in a new private table `AbuseCounter { key: string PK ('guest_lobby_create'), windowStart: timestamp, count: u32, audit (SYSTEM) }` counts guest **creations** (not surviving lobbies, so create-and-close loops are counted too). When a creation pushes the count past `AbuseConfig.guestLobbyBurstThreshold` inside `guestLobbyBurstWindowMinutes`, that creation **succeeds** (a throw would roll back the trip), the switch `guestLobbyCreationEnabled` goes off and one count-only `AdminAlert` is written in the same transaction; every later guest creation is rejected until an admin re-enables the switch. Cap under a burst: threshold + 1 lobbies. Threshold and window stay runtime-editable through `admin_update_abuse_config` (defaults 20 in 10 minutes, A42). `AbuseBreakerJob`, `run_abuse_breaker` and its `init` seed are removed; the T-S5 breaker tests are rewritten for the inline trip.
- **Why:** user decision 2026-11-06 after comparing the two designs: the timer reacts up to 5 minutes late (a script keeps creating lobbies, each pushed to every lobby-browser subscriber), costs about 8,600 idle reducer calls a month, and counts survivors only; inline reacts on the crossing creation, costs nothing when idle and counts creations. Nothing in the plan needs a periodic check that no user action triggers.
- **Supersedes:** A42(2) "a scheduled reducer every few minutes".
- **Where implemented:** S6 (the step that next edits `create_lobby`)

### A58 — Guest-lobby breaker default: 50 creations in 10 minutes

- **Date:** 2026-11-06 · **Status:** decided
- **Decision:** `AbuseConfig.guestLobbyBurstThreshold` defaults to **50** (was 20, the A42 example); `guestLobbyBurstWindowMinutes` stays 10. Both remain runtime-editable through `admin_update_abuse_config`. The switch the breaker trips (`guestLobbyCreationEnabled`) affects **only guest lobby creation**: verified users create normally, guests already in lobbies keep playing, joining and chat are untouched; an admin re-enables it with `admin_set_guest_lobby_creation(true)`.
- **Why:** user decision 2026-11-06: with the per-guest cap of 10 lobbies an hour, 50 in 10 minutes needs at least five identities acting together, which is script behaviour; a legitimate community evening stays far below it.
- **Supersedes:** the default value named in A42 and A57 (the mechanism is unchanged).
- **Where implemented:** S5 follow-up commit (default constant + tests), S6 (inline breaker keeps the value)

### A59 — Classic draft order for Thirds (12 picks per team)

- **Date:** 2026-11-07 · **Status:** decided
- **Decision:** The Classic draft sequence for `lineupFormat = Thirds` is fixed per ban mode. Notation: Blue/Red per step, a `·` at every colour change, bans in brackets; this notation is the one used in docs and in the UI's draft-order display.
  - **None (24 steps):** `B · RR · B · R · BB · RR · BB · RR · BB · R · B · R · B · R · BB · RR` — the Halves order, then `B R B R B B R R`.
  - **Four (28 steps):** `[B] · [R] · B · RR · B · [R] · [B] · R · BB · RR · BB · RR · BB · RR · BB · RR · BB · R` — the Halves order, then two more `R B B R` rounds (today's implementation, unchanged).
  - **Six (30 steps):** `[B] · [R] · B · RR · B · [R] · [B] · R · BB · R · [B] · [R] · BB · RR · BB · RR · BB · RR · B · R · B · R` — the Halves order with two more `B B R R` rounds inserted after the third ban pair, before the `B R B R` closer.
  Rules the three orders share: the first eight picks and every ban position are the Halves order of the same ban mode (ban pairs before the first pick, after four picks, and for Six after eight picks); 12 picks per team; no run longer than two; Blue picks first and Red picks last. Thirds adds no bans. Auction is unaffected (ban-only prefix, `charactersPerTeam` counts the sale).
- **Why:** user decision 2026-11-07. `docs/match-session/draft-order.md` (the user's spec) defines only the 8-pick orders; S7's `THIRDS_EXTRA_PICKS` appended `R B B R R B B R` to every mode as an implementation choice (A21 fixes only the count). The user chose each ending: None closes with a pair each after a short alternation, Four stays a pure snake, Six keeps its alternating closer; a candidate None order with 25 picks (13 Blue) was rejected on the count.
- **Supersedes:** the S7 implementation choice for `THIRDS_EXTRA_PICKS` (None and Six change; Four is already this order).
- **Where implemented:** the next step that edits `spacetimedb/src/helpers/draftSequences.ts` (the S7 follow-up proposed for the lineup-lock and tie decisions, otherwise S8): per-mode Thirds sequences, `docs/match-session/draft-order.md` gains the Thirds section in this notation, and a T-task asserts the three sequences step by step.

### A60 — Game package: edit windows, per-game confirmation and close, automatic series submission

- **Date:** 2026-11-07 · **Status:** decided
- **Decision:**
  1. **Edit windows**, both draft modes, while the game is open: eidolons in Drafting, Equipping and Scoring (Classic: once the character is picked; Auction: once it is sold); light cones and lineup arrangement in Equipping and Scoring; group scores and adjustments as today (no stage check), for the current open game only. Under `requireOwnership` an eidolon edit may only choose a level the team owns on its selected match accounts; otherwise 0–6. Every eidolon level has its own cost-set price, so an edit recomputes the roster cost dynamically (Classic: the character's cost becomes the cost at the new level; Auction: the team pays or is refunded the difference through its pool, A61), then the synergy surcharge and the handicaps, exactly as light cones and synergies already do. Eidolon edits use the lineup throttle (`AbuseConfig.lineupMinIntervalMs`).
  2. **Every edit by either side recomputes the game and resets both captains' confirmations** of that game. Nobody is confirmed against a package they have not seen.
  3. **One confirmation per game per captain** (`confirm_game`) covering lineup, light cones, eidolons and scores. The second confirmation **closes the game**: winner computed through the A21 chain, series tally updated, stage → BetweenGames or AwaitingResult. A spectator referee with `refereeFullControl` closes a game alone (both sides at once), carrying the series-level rule over. `MatchResultGame` gains `blueConfirmed`, `redConfirmed` and a closed marker; **every edit reducer rejects a closed game**, including in the window between a close and the next draft (the game counter moves only when the next draft starts). Nothing in a closed game changes when the series moves on.
  4. **Staff close.** The seated lobby referee, Moderator+, or tournament staff with result authority (organizer, assistant with `canResolveResults`) may close a game without both confirmations. A level-4 tie closes only with `winnerOverride`, from the same set; A39's seating rule applies at this point (in a tournament lobby a referee seated on a team cannot close a tie; in a casual lobby the override is accepted and audited). Auction: a game cannot be confirmed or closed while a team's synergy surcharge plus spend exceeds its pool (this replaces the S7 reservation guard in `equip_lightcone`).
  5. **Equipping → Scoring stays a host signal with no gate** (resolves the D-58 "host can force" question: there is nothing to force). Drafting → Equipping is unchanged (auto on draft completion, manual `advance_stage`, D-50 rollover).
  6. **Automatic series submission.** The close of the deciding game performs today's `submit_match_result` path with nothing left to decide: Casual validates and finalizes inline (D-04 / D-37), Ranked → `Submitted` for the staff backlog (force-finalize), tournament lobbies follow their routing. The submission keeps no override arguments; `MatchSessionHistory.winnerOverride*` is written by the close.
  7. **Admin edits after a close.** Admins (role Admin, not Moderator) may edit a closed game — scores, adjustments, eidolons, light cones, lineup — while the series is not finalized (record status Pending or Submitted). The edit recomputes the game and the series tally, the game stays closed, confirmations are not reset, the audit columns record the admin. After finalization (MMR applied) nothing is editable; force-finalize and the dispute route are the tools.
  8. **Removed:** `confirm_lineup`, `MatchLineup.isConfirmed`, the `ConfirmLineup` step; `confirm_match_scores` and `MatchResultRecord.blueConfirmed` / `redConfirmed`; the Scoring branch of `advance_stage`; the surcharge reservation in `equip_lightcone`; the `winnerOverride*` arguments of `submit_match_result`. **New step kinds** `SetEidolon` and `ConfirmGame` (the replay shows them). The backward stage transition discussed during the S7 review is not needed.
  9. **Stalemates.** Casual lobbies: no rule (no MMR; the players agree, concede or leave). Ranked and tournament lobbies: the staff close, plus an admin view of ranked lobbies stuck in Scoring with a one-sided confirmation (S9, staff-only subscription). No timer for now; it stays a backlog option if staff load shows the need.
- **Why:** user decision 2026-11-07. Players should be able to correct mistakes until the result is signed; everyone in the lobby sees every edit, so a captain who disagrees withholds confirmation or disputes; a signed game is immutable; the host no longer closes games; the stage machine stops pretending to lock anything (score entry never had a stage check). Classic keeps its cost-difference handicaps; the edit windows only add the ability to change inputs before signing.
- **Supersedes:** the D-58 gating question carried on the ROADMAP S8 row; the locus of A39 (authority unchanged, applied at game close instead of at submission); the S7 review fix "surcharge reserved for a confirmed lineup"; the series-level confirmation (`confirm_match_scores`); the S7 `submit_match_result` override; the "revert to Equipping" idea from the S7 review.
- **Where implemented:** S7b (new step between S7 and S8; Fable implements, Opus reviews; T-S7b rewrites the S7 confirmation / submission / advance tests)

### A61 — Auction eidolon economics

- **Date:** 2026-11-07 · **Status:** decided
- **Decision:**
  1. **Nominations and bids are at E0.** The base cost is the cost set's `e0`; `nominate_character` loses its `eidolon` argument and `NominatePayload.eidolon` is dropped. Amends D-47 / D-53: the nomination is still the first bid, at the E0 base cost.
  2. **Ownership on bids.** With `requireOwnership` on, a team may nominate or bid only on a character that at least one of its members' selected match accounts owns (`LobbyMemberAccount`). Auction enforced nothing before (S7 review #9).
  3. **Default eidolon** = the highest level the winning team owns across its selected accounts (mirrors Classic's `resolveOwnedEidolon`); E0 without ownership. The **extra** = max(0, cost[e_default] − cost[e0]) from the lobby's cost set.
  4. **Guard** (ownership lobbies): a nomination or bid is accepted only if amount + extra ≤ remaining character budget + remaining light-cone budget. Bids themselves stay capped by the character budget, as today, so a depleted team cannot bid.
  5. **At the sale the extra is charged immediately**, from the character budget first and the remainder from the light-cone budget; the character budget floors at 0 (never negative, so EMPTY nominations at cost 0 stay possible for a depleted team) and the total never goes negative. Both sale paths (last pass and timer expiry) apply it; the D-50 rollover carries the non-negative leftover.
  6. **Eidolon edits** (A60 window) pay or refund the difference through the same path: character budget first during the auction, the merged pool after the rollover; rejected when the difference exceeds the remaining total. Under ownership only owned levels.
  7. **Roster cost** = winning amount + eidolon extra (hundredths), feeding tie-break 1 and the handicaps. `AuctionSoldPayload` gains `eidolonCost`; later changes are `SetEidolon` steps, so the replay shows the sale eidolon and every change.
  8. **No overdraft penalty mechanism.** The existing threshold pair (`rosterThreshold`, `underThresholdAdvantage`, `aboveThresholdPenalty`) is the host's soft budget; the total budget is the hard one. The S14 auction screen shows each team's effective cost (bid + mandatory extra) live.
  9. Classic is unchanged apart from A60's eidolon edit (no budget; the roster cost is the cost at the chosen level).
- **Why:** user decision 2026-11-07. Crediting the winning team with the nominator's eidolon was wrong (review #9); in the game the eidolon is the account's, so the extra is owed on the win and must be visible at bid time; an overdraft can happen at most once per team (the character budget is then empty) and costs light cones, which is penalty enough; a hard total keeps budgets meaningful; the threshold pair already exists for score penalties. A dedicated eidolon stage was rejected: the extra and the light cones draw from one pool and are guarded when spent, so order does not matter.
- **Supersedes:** D-47 / D-53 base cost at the nominator's eidolon; the S7 eidolon resolution in `nominate_character`; the review #9 proposal (winner's eidolon snapshot at sale time), refined into this rule.
- **Where implemented:** S7b

### A62 — Synergy pair uniqueness key

- **Date:** 2026-11-07 · **Status:** decided
- **Decision:** `HsrSynergyCost` uniqueness is **(costSetId, gameMode, draftMode, canonical alphabetical pair)**: the same two characters may carry different modifiers per game mode, draft mode and cost set, and a reversed duplicate within one key cannot exist. **Re-submitting an existing key updates its modifier** (not an error); the same pair twice in one bulk payload is rejected. This is what S6 / S7 implemented (`reducers/admin.ts`, `reducers/costSetManagement.ts`).
- **Why:** user confirmation 2026-11-07 of the implemented reading of BACKLOG-ISSUES "reject a pair that exists in either order": the rejection is about duplicates inside a key, the re-submit of a key is an edit.
- **Supersedes:** the literal "reject" wording of that backlog item for the re-submit case.
- **Where implemented:** S6 / S7 (already in place); no code change

### A63 — Game submission is an explicit click after both captains are ready

- **Date:** 2026-11-07 · **Status:** decided
- **Decision:**
  1. `confirm_game(lobbyId, teamSide)` only sets that side's ready flag (`MatchResultGame.blueConfirmed` / `redConfirmed`). It never closes a game, tie or not. Callers: the captain of that side (a referee who is that captain confirms as the captain). Preconditions as in A60(3): the side's lineup arranged, both sides' group scores complete, the Auction pool gate for that team; a side cannot confirm twice; every edit of the game clears both flags (A60(2)).
  2. `close_game(lobbyId, winnerOverride?, winnerOverrideReason?)` is the **submit** of a game. Once both flags are set, the captain of either team or a lobby referee may call it (the UI shows a "submit result" button to those people at that moment). Without both flags only the A60(4) staff set may call it (lobby referee, Moderator+, tournament organizer or an assistant with `canResolveResults`): that is the staff close. A level-4 tie closes only with `winnerOverride`, from the staff set only (a captain cannot decide a tie); A39's seating rule applies as in A60(4).
  3. The close of the deciding game still submits the series automatically (A60(6)); there is no further series-level click.
  4. The full-control spectator referee's shortcut (one confirmation setting both flags) is removed: the referee closes the game directly. `MatchResultRecord.refereeFullControl` stays as a column (set at `start_draft`) for the views; no reducer reads it any more.
  5. The `ConfirmGame` step keeps its payload: a confirmation logs `closed: false` with `confirmedSide` = the side; a close logs `closed: true`, `actorSlot` / `confirmedSide` = the closer's team side (a captain) or `Spectator` (staff), plus the override fields when used.
- **Why:** user decision 2026-11-07, on seeing the S7b implementation: an action called "confirm" must not close a game by itself, and the referee must not have two different ways to end a game; two ready flags plus one explicit submit is the model the UI shows (the old `confirm_match_scores` + `submit_match_result` shape, now per game). The server already has both captains' signatures, so the click adds no information, but it makes the moment of closing deliberate.
- **Supersedes:** A60(3) "the second confirmation closes the game" and "a spectator referee with `refereeFullControl` closes a game alone (both sides at once)"; the design log's rejected alternative "keeping a referee click for the series submission" is partly reinstated (the click is per game and belongs to either captain or the referee, not to the referee alone). A60(4), (6) and the rest of A60 are unchanged.
- **Where implemented:** S7b follow-up commit (Opus implements, Opus adjusts the T-S7b tests, Fable reviews)

### A64 — Auction default eidolon at the sale is the lowest owned level

- **Date:** 2026-11-07 · **Status:** decided
- **Decision:**
  1. With `requireOwnership` on, the default eidolon resolved at an Auction sale (A61(3)) is the **lowest** level the winning team owns for the character across the selected match accounts of its player seats; the extra charged at the sale is `max(0, cost[e_min] − cost[e0])`, which is 0 when one of those accounts owns E0. The bid-time guard (A61(4)) and the reservation of the committed bid during a nomination (S7b review fix) use the same lowest-owned extra. Without ownership the default stays E0 and the extra 0.
  2. Higher owned levels are bought afterwards through `set_eidolon` (A60(1), A61(6)), paying the delta from the pool like any other spend (character budget first while it exists, then light cones); a downgrade refunds to the light-cone budget (the S7b rule, confirmed by the user).
  3. Classic is unchanged: `pick_character` records the highest owned level (`resolveOwnedEidolon`) and the roster cost at that level; `set_eidolon` may move it to any owned level.
- **Why:** user decision 2026-11-07 (evening): the mandatory extra should be the smallest playable one, so a team allocates the rest of its pool deliberately between eidolon upgrades and light cones and the UI can list the owned versions it could switch to; the lowest owned level is always playable, so the guard stays sound; refunds become a correction path rather than a budget lever. This reverses the rejection of "lowest owned as the default" recorded in `docs/log/2026-11-07-design-a59-a62.md` (then rejected to mirror Classic); Classic has no budget to allocate, so it keeps the conservative default.
- **Supersedes:** A61(3) "the highest level the winning team owns"; the design log's rejected alternative "Lowest owned eidolon as the default".
- **Where implemented:** S7b follow-up commit (Opus implements, Opus adjusts the T-S7b tests, Fable reviews)

### A65 — Draft steps are kept for the whole series

- **Date:** 2026-11-07 · **Status:** decided
- **Decision:**
  1. `MatchSessionStep` rows stay in the live table for every game of a series until finalization. `advance_to_next_game` no longer deletes the finished game's steps. The rows already carry `gameNumber`; no new table and no new column.
  2. Every game-scoped reader of the live steps filters by `gameNumber` (the current game, or the game an Admin is editing): the Classic and Auction draft state, the undo (which never crosses into an earlier game), the ban restriction, the eidolon and light-cone edits, the `client_connected` latest-Pause lookup, the tie-breaks. Lobby-wide readers stay lobby-wide: the sequence counter (sequences keep increasing across the series; the archive key tolerates both), the user-deletion guard, the lobby GC and the finalization read.
  3. Finalization archives every game's steps into `MatchSessionStepHistory`, whose primary key `[matchHistoryId, gameNumber, sequence]` was designed for it (D-13) but only ever received the last game. The live rows are deleted after the archive as today, and by the lobby GC on the other exits. The replay of a finished match therefore has every game. The live step view carries `gameNumber` so the client shows one game at a time (S9 decides the subscription shape).
  4. A60(7) Admin edits reach any closed game of the series, not only the current one: `record_group_scores` and `set_score_adjustment` accept an earlier `gameNumber` on the Admin path; `set_eidolon`, `equip_lightcone`, `unequip_lightcone` and `arrange_lineup` take an optional trailing `gameNumber` that only an Admin may set to an earlier closed game (default: the current game). The edit recomputes that game and the series tally per A60(7).
- **Why:** user decision 2026-11-07 ("keep"): an Admin can correct an earlier game and the replay gets every game; the cost is a larger live step table per lobby (a few dozen rows per game, gone at finalization) and a per-game filter in the readers and the view. The S7 "current game only" limit (`ensureCurrentGame`) existed only because the earlier games' steps had been deleted.
- **Supersedes:** the S7 interpretation "Admin edits reach the current game only" (`docs/match-results/architecture.md`, the `ensureCurrentGame` edge case in the contract) and the `advance_to_next_game` step deletion (D-13 era). Nothing in A60 changes.
- **Also accepted** (S8b interpretations the user was shown on 2026-11-07 and did not overrule): (a) A26a wins over A26 for still-Forming teams: they survive the registration close and are withdrawn at bracket generation; (b) `admin_cancel_idle_tournaments` covers every non-terminal stage (Registration through InProgress), wider than A24(6)'s "in-progress".
- **Where implemented:** S8d (Opus implements, Fable reviews, T-S8d tests)

### A66 — A concede's roster is the start-of-draft participant copy, like every other result

- **Date:** 2026-11-07 · **Status:** decided
- **Decision:**
  1. The participants of a conceded match are the `MatchParticipant` rows `start_draft` wrote, exactly as for a played match. The D-75 fallback (read the live `LobbyMember` roster) stays what it was: a fallback used only when no participant rows exist, which no reducer path produces any more.
  2. Leavers count: a player who was seated at `start_draft` and left the lobby before the result settled is still a participant of the conceded match (a loser when on the conceding side).
- **Why:** user decision 2026-11-07, on the S8d review. A54 asked for the live roster because, in the old code, a concede finalized at once, so the live roster at that moment was the roster that played. After A24(2) a tournament lobby parks in AwaitingResult until the tournament completes, seats are frozen after Waiting (A35), and players may leave the parked lobby; a live read at job time would drop players who played. The start-of-draft copy is the only durable roster, and it is the one every other result already uses.
- **Supersedes:** A54's clause "the finalization participant fallback (D-75) becomes the rule for concedes (live `LobbyMember` roster, not the start-of-draft copy)". The rest of A54 (one record per lobby; concede and defer update the Pending record; explicit readers) stands and is implemented in S8d.
- **Also corrected:** A65(2) names `client_connected` as the site of the latest-Pause auto-resume lookup; the lookup lives in `join_lobby`'s reconnect branch (`reducers/lobbyLifecycle.ts`) and was fixed there. No behaviour difference.
- **Where implemented:** S8d (already in the working tree; Fable-reviewed)

### A67 — One lobby per game; the bracket match is the only series

- **Date:** 2026-11-08 · **Status:** decided (user, over the orchestrator's recommendation to keep BetweenGames and drop only Shelved)
- **Decision:**
  1. **A lobby hosts exactly one game.** Stages: Waiting → Drafting → Equipping → Scoring → AwaitingResult. `BetweenGames` and `Shelved` are removed from `LobbyStage` together with `Finished` (no writer); `advance_to_next_game`, `shelve_series` and `resume_series` are deleted. Casual players who want a best-of-3 play three lobbies.
  2. **No series settings on lobbies or presets.** `bestOf`, `bestOfNAdvantage` and `refereeControlsShelving` leave `Lobby`, `LobbyPreset`, `create_lobby`, `update_lobby_settings`, the preset reducers and the system preset. `AdvantageSide` goes if nothing else uses it.
  3. **No game numbering inside a match.** `MatchSession` loses `seriesBestOf`, `gamesWonBlue`, `gamesWonRed`, `currentGameNumber`. `gameNumber` leaves `MatchSessionStep`, `MatchSessionStepHistory` (PK `[matchHistoryId, sequence]`), `MatchLineup`, `MatchLineupHistory`, `MatchResultAdjustment`, `MatchResultGroupScore`, `MatchResultGame` (PK `matchResultId`, one row per record) and `MatchResultGameHistory` (PK `matchHistoryId`). `MatchResultGame` stays a separate 1:1 table for now (smallest diff; merging it into the record is an optional later cleanup). The optional trailing `gameNumber` argument added by A65(4) is removed from `set_eidolon`, `equip_lightcone`, `unequip_lightcone`, `arrange_lineup`, `record_group_scores`, `set_score_adjustment`; Admin edits of the closed game until finalization (A60(7)) stay. `view_my_match_steps` loses `gameNumber`.
  4. **The bracket match is the series.** `BracketMatch.bestOf` (inheritance chain of A28 unchanged: `Tournament.defaultBestOf` / `grandFinalBestOf` → `BracketMatch.bestOf`) is the game cap. `team1Games` / `team2Games` become the running tally, written only by the single writer (`helpers/bracketResults.ts`) and **derived**, never incremented blindly: tally = head start (team1 gets `winnerAdvantage`, A27) + the Validated records of the match won by that team. A game's settlement (validation or concede) hands the record to the bracket; the writer recomputes the tally and, when a side reaches `ceil(bestOf / 2)`, decides the match (`applyBracketResult` with the tally and `decidedBy`). Rollback of a decided match undoes the deciding record only (void + lobby deleted, as today); earlier Validated games stay and the tally is recomputed. Overrides recompute the same way.
  5. **One live lobby per bracket match, one game per lobby.** `create_tournament_lobby(bracketMatchId)` keeps its caller rule (a participant of the match or `bracket` staff, A34) and D-45 (one lobby that is not settled at a time), and additionally rejects when the match is decided ("This bracket match is decided.") or when the Validated games already reach `bestOf` (the cap). After a game settles, its lobby parks in AwaitingResult (A24(2), unchanged) and the next lobby may be created.
  6. **Concede = this game.** `concede_match` settles the lobby's record; the bracket match ends only when the tally decides it or staff resolve it (`resolve_bracket_match`, unchanged). No series-level concede.
  7. **Stats and MMR per game.** Every lobby is a match for history, PlayerStat, relationships, character stats and MMR. In an MMR tournament a Bo3 therefore moves MMR up to three times (user confirmed 2026-11-08: "Yes MMR would move 3 times"). Casual best-of-3 = three unrelated lobbies, no running score, no head start, no rematch helper yet (user confirmed 2026-11-08).
  8. **Finalization unchanged in shape.** The S8d job finalizes every Validated record of the tournament in bracket order (several per match now); `resolve_bracket_match` voids only the unsettled lobby of the match and keeps every Validated game record; placements read bracket state as before.
- **Why:** user decision 2026-11-08: "I still feel like a new lobby per game is the best option personally, this is my decision, even if we have to scope again things that we did and need a rewrite for it." The lifecycle review (scratchpad `lobby-lifecycle-review.md`) had shown that BetweenGames and Shelved carried four of the fourteen membership findings plus the resume gate, the 72 h GC rule and the one-lobby lock. The user judged the series machinery over-engineered as a whole and chose one game per lobby, accepting the user-side cost (a new lobby, join and seating per game) and the rewrite of S6–S8d work. Orchestrator's recorded dissent: keeping BetweenGames as an ordinary live stage would have kept the Bo3 room at near-zero code cost; overruled.
- **Supersedes:** A65 (whole-series steps) entirely; A27's "start_draft seeds `gamesWonBlue = winnerAdvantage`" (the head start now pre-credits `team1Games`; the validation `winnerAdvantage < ceil(bestOf / 2)` stays); A28's "the cap applies to lobbies and presets too" (no `bestOf` on lobbies or presets; the tournament chain stays); A60's "the deciding close auto-submits the series" (the close of the game submits the game); A56's per-game lineup history (per lobby); the S6 series settings (backlog #2, #6, #7, #9: `bestOf`, `bestOfNAdvantage`, `refereeControlsShelving`, series presets); contract rules D-10, D-15, D-16, D-19, D-93 and the Shelved GC rule. A54 (one record per lobby) and A66 (concede roster) are unaffected.
- **Where implemented:** S8e (module rewrite + T-S8e), S8f (membership lifecycle fixes), S9 (views), S14 (pages)

### A68 — Lobby membership rules: Leave is a disconnect; no automatic forfeit; players are never removed after the draft starts; flags always held

- **Date:** 2026-11-08 · **Status:** decided (user rulings on the 2026-11-08 lifecycle review, `docs/log/2026-11-08-lobby-lifecycle-review.md`)
- **Decision:**
  1. **Leave in a live stage is a disconnect.** In Drafting, Equipping and Scoring (the only live stages after A67) `leave_lobby` by a player does what `client_disconnected` does for that membership: `isOnline = false`, `disconnectedAt` stamped under Standard / Deferred (never under NoAction), the 15 s `RefereeTransferCheck` scheduled, the pool draining while away (D-10 unchanged). The row is kept and the player may return at any time through `join_lobby`'s reconnect branch while the lobby exists. D-38's rejoin ban and D-31's auto-concede on the last Leave are removed.
  2. **Away marker.** `LobbyMember.voluntarilyLeft` is replaced by `leftAt: timestamp?` ("out of the room", not a ban). `client_connected` does not restore a row with `leftAt` (the user may be browsing the site); only an explicit return through `join_lobby` clears it. The 15 s check and every forfeit test treat a `leftAt` row as offline regardless of the user's presence rows (A48 presence stands in for the membership flag only for rows without `leftAt`). This closes the loophole where a leaver who stays on, or reloads, the site would count as online and reset the clock.
  3. **No automatic forfeit, ever.** The last player of a team leaving or disconnecting never concedes the match. Absence runs only through the existing machinery: under Standard any player of the other team, or the exclusive referee naming the side, may `claim_forfeit` once every player of the team is offline and the grace (default 60 s) has elapsed or the pool is empty (D-16); under Deferred the other team may `defer_match` to staff; the exclusive / third-party referee may `concede_match` for a side at any time; under NoAction nothing happens until someone concedes. `isForfeitEligible` counts away and abandoned rows (4) as offline players (today it filters `voluntarilyLeft` rows out, which could leave a team with "no players" and unforfeitable). User, 2026-11-08: "I dont want to automatically forfeit. If the last member of a team disconnect, i still want the disconnect pool to drain … the other team would have the option to win by forfeit after a bit (or due to the referee's action)."
  4. **An away player may join another lobby, at the cost of the first.** D-22 (one lobby at a time) counts an away row, but `create_lobby`, `join_lobby` and `create_tournament_lobby` accept it when the caller confirms: a new boolean argument `abandonCurrentMatch` (default false). Without it the reducer rejects with the prompt text the client shows: "You left lobby {code} mid-match. Joining here means you cannot return to it." With it, the away row becomes **abandoned** (`abandonedAt` set; `leftAt` kept): the player can never return to that match ("You left this match for another lobby and cannot return."), the row still counts as an offline player for the forfeit test and the flag transfers (so the team can be forfeited rather than stranded; the start-of-draft participant copy keeps the credit, A66), it no longer counts for D-22 and `view_my_lobbies` stops listing that lobby. User, 2026-11-08: "If a player left, they can still rejoin to that match and if they try to join another lobby, we should be able to prompt them". `delete_my_account` follows the same D-22 test (an away membership blocks deletion; an abandoned one does not).
  5. **Spectators and coaches watch one match at a time and are free the moment they leave.** D-22 binds them while they hold a row (today's rule, unchanged). Their Leave deletes the row in every stage (today: active stages only); nothing about them is kept; they may join another lobby at once. User: "spectators are enforced to only be able to watch 1 game at a time, but the moment they leave, they are released from that rule."
  6. **Players are never removed after the draft starts.** `kick_member` / `ban_member`: in Waiting (and AwaitingResult, where the game is over) any member may be removed: row and `LobbyMemberAccount` rows deleted, `LobbyBan` row for a ban (D-21), flags transferred (7). After `start_draft`, only spectators and coaches may be kicked or banned; a kick or ban of a player is rejected ("Players cannot be removed once the draft has started; the match ends by result, concede or forfeit."). `dq_participant` no longer kicks a DQ'd player out of a live lobby (D-25 branch removed): the current game plays on with them, and the DQ takes effect from the next lobby (team membership gone, `allowedSlotsFor` seats nobody who is not on a team); a DQ'd *team*'s match is settled through the bracket as today (walkover; unsettled lobby voided). User: "Kick or ban should only happen before the game starts for players and spectators and only appply for spectators after the draft starts."
  7. **A lobby with members always has a host and a referee.** Every row removal in every stage (leave in Waiting / AwaitingResult, spectator / coach leave, kick, ban, DQ before the draft, user deletion) transfers host, captain and referee when the leaver held them, candidates in the A22(5) order (host → Blue players → Red players → spectators → coaches, by `joinSeq`), online first, then any remaining member; an away player loses the flags through the 15 s check as today. D-35's lowest-user-id rule is retired. `reclaim_referee` gives the flag to the caller when nobody holds it. Flags never return automatically to the original holder. User: "For every removal thats fine."
  8. **Spectators may join while a match runs, up to the lobby's spectator count.** New members join as Spectator in Drafting, Equipping and Scoring (D-04 extended) and in Waiting, subject to the 20-member total cap and to a new lobby / preset setting `maxSpectators: u8` (0–12, default 12; 0 = no spectators; today's hard cap of 12 becomes the upper bound; `create_lobby` / `update_lobby_settings` / preset reducers; the system preset keeps 12; tournament lobbies take it from the preset's free set). The join rejection names the limit ("Spectator slots are full (max N)."). Members already holding the Spectator slot as staff (host, referee) are unaffected by a later lower setting. AwaitingResult stays closed to new joins. User: "spectators can join during drafting equipping and scoring if spectators are allowed." / "is there not a way to set how many spectators in a match?"
  9. **GC.** Waiting lobbies apply the D-47 presence test before the 30 min idle rule, like active stages; away and abandoned rows count as offline.
  10. **Views (S9).** Member views project a presence state (online / offline / away / gone) instead of `isOnline` alone, so the room can grey a seat and label it; `view_my_lobbies` lists a lobby the user is away from (it is still their match) and drops abandoned ones.
- **Why:** the review found that closing the tab was always safer than pressing Leave, that a host leaving before the draft left a headless room, that kicks could strand a match, that referee succession depended on how the referee left, and that kicks and bans leaked account locks. The user chose: Leave = disconnect with the grace and the forfeit claim as the only exits; a leaver keeps the seat until they themselves take another lobby; spectators are never bound; players are never removed from a running match by staff.
- **Supersedes:** D-31 (auto-concede on the last Leave; the `voluntarilyLeft` path), D-38 (no rejoin after a voluntary leave), D-22's absolute form (an away player may switch lobby with `abandonCurrentMatch`), D-35 (lowest-user-id succession) in favour of the A22(5) order, D-04's "Drafting only" for spectator joins, D-25's mid-match DQ kick, D-49's unconditional 30 min rule for Waiting, the "kick at any stage" reading of D-21 / D-32. A22 / A22a (15 s check, clock stages) and A66 stand; A67 defines the stage set.
- **Where implemented:** S8f (after S8e), S9 (views), S14 (controls and copy: the Leave confirmation "You can come back until the match ends; your team can be forfeited while nobody is online", the away / gone seat states, the "join here and give up lobby {code}?" prompt, the forfeit claim button when eligible, the spectator count (0–12) in lobby settings and that many spectator cells in the room)

### A69 — Head start on the bracket row; Admin edits of a closed game end at validation; A67 dead code removed in S8e

- **Date:** 2026-11-08 · **Status:** decided (user rulings on the S8e report)
- **Decision:**
  1. **The A27 head start is awarded at the bracket level.** `BracketMatch.team1Games` starts at `winnerAdvantage` when the match is generated (team1 = the winner-bracket side, A35: Blue = team1); no result record represents the head start, and the stored tally equals the derived one (`winnerAdvantage` + Validated games, A67(4)) from generation on. User: "a game should be awarded at the bracket level in my opinion, is there no way deal with that without adding fake rows?" (no fake rows: the bracket row carries it).
  2. **Admin edits of a closed game (A60(7)) are allowed while the record is Pending or Submitted.** Once the result is Validated (official; a tournament record has moved the bracket) or Finalized, the game editors (`set_eidolon`, `equip_lightcone`, `unequip_lightcone`, `arrange_lineup`, `record_group_scores`, `set_score_adjustment`) reject everyone, Admins included; corrections go through `override_match_result` (A24 TD-13 / TD-14), which reverts and recomputes the bracket (A67(4)). This narrows A60(7)'s "until finalization". User: "we can agree that admins cannot edit finalized matches" (read by the orchestrator as: a validated result is final for the editors; the user may correct this reading).
  3. **Dead code left by A67 is removed in S8e** rather than handed to S8f: the `select_match_account` snapshot ratchet (selection is Waiting-only), the Pending branch of `recomputeAfterAdminEdit` (the close always submits), the unreachable rejections of `ensureOpenGame` (the record lookup rejects first; it now carries the precise message), the "Shelve" comment in `defer_match`. The two defensive D-45 guards in `create_tournament_lobby` ("no games left", "decided by its games") stay: direct row edits (`admin_delete_row`) can still produce the states they reject. User: "we can remove the unnecessary reducers".
- **Why:** the first failing S8e test showed the public bracket row at 0–0 for a grand final with a head start until its first game settled, while the derived tally read 1–0; the user wants the head start visible on the bracket without a synthetic record. On Admin edits, a Validated tournament record has already advanced the bracket, so editing it in place would desynchronise the tally; the override path is the one that reverts first.
- **Supersedes:** A60(7)'s "until finalization" wording (now: until validation); the S8e review hand-off of the dead code to S8f.
- **Where implemented:** S8e (fix pass 2 and T-S8e follow-up)

### A70 — Every bracket match chooses its colours; the head start is assigned by colour; both editable until the first game is played

- **Date:** 2026-11-08 · **Status:** decided (user request after the S8e report)
- **Decision:**
  1. **Colours are chosen per bracket match, for every match of the tournament.** `BracketMatch` gets `blueTeamId: u32?`: the team that plays Blue in every lobby of this match (the other plays Red). Unset means A35's default (team1 = Blue, team2 = Red); a value that is no longer one of the match's two teams (a slot replaced after a DQ or a rollback) also falls back to the default. `allowedSlotsFor` (seating, A35), the result credit (`recordWinnerTeamId`), the tally (`matchGames`), the DQ losing side, the concede hand-off and the shuffle guard read the match's colour mapping instead of the fixed one. Seat enforcement itself is unchanged: a team's players and approved stand-ins may only sit on their team's colour; everyone else spectates. User, 2026-11-08: "the selection of which wants red or blue … should be an option for every match in the tournament."
  2. **The head start is assigned by colour.** `BracketMatch` gets `headStartSide: TeamSide` (Blue or Red; default Blue, which under the default mapping is the winners' bracket finalist, A27). The tally starts at `winnerAdvantage` on the team that holds that colour and 0 on the other; `insertBracket` writes it (A69(1) generalised). Matches with `winnerAdvantage = 0` ignore the field.
  3. **One reducer, `set_match_sides(bracketMatchId, blueTeamId, headStartSide)`.** Caller: the organizer or an assistant with the `bracket` permission (A25). Allowed on a Ready match (both teams known) of a tournament that is not Completed / Cancelled, **until the first game is played**: rejected once any `MatchResultRecord` of the match is Pending, Submitted, Disputed or Validated ("The sides can no longer be changed: a game of this match has started."); Voided and Rejected records do not block. Rejected while a lobby of the match exists ("Close the open lobby of this match before changing its sides."), because its members are seated by colour. `blueTeamId` must be one of the match's two teams; `headStartSide` must be Blue or Red. The reducer rewrites `team1Games` / `team2Games` through `writeMatchGames`; audited like every bracket write (SYSTEM never; the caller's id). Colours are fixed for the whole match: every lobby of a Bo3 uses the same mapping (a per-game side swap is not part of this decision).
  4. **Presentation.** The public `BracketMatch` row carries both fields, so the bracket view shows "Blue leads 1–0" with the team names, and tournament staff get two selectors (who plays Blue, which colour has the head start) enabled until the first game starts (S14).
- **Why:** Blue has first pick, and some teams prefer Red; the team that earned the head start should be able to take Red without losing it, and any two teams should be able to agree on colours before their match. The selection is expressed in colours because that is how the teams decide. User, 2026-11-08: "we need to give the option to select who gets the advantage, it can be edited at any moment until the first game is played"; "whoever gets to the grand final can decide if they wanna play red or blue. Blue team always has first pick but some ppl prefer red team."
- **Supersedes:** A35's fixed mapping (now the match's default, overridable before the first game; seat enforcement stands); A27's fixed recipient (the amount and its bound stand); A69(1)'s "team1Games = winnerAdvantage" (now: on the team holding `headStartSide`).
- **Where implemented:** S8g (backend step after S8e: two columns, the reducer, the mapping sites, bindings, docs, T-S8g), S9 (view), S14 (selectors)

### A71 — The head start stays with the winners' bracket finalist; colours never move it

- **Date:** 2026-11-08 · **Status:** decided (user ruling on the S8g test failures)
- **Decision:**
  1. **A27 stands in full.** The grand final head start (`winnerAdvantage`) belongs to slot 1, the team routed in from the winners' bracket (team1), whatever colours the two teams pick. The stored tally is team-based: `team1Games` starts at `winnerAdvantage` and `team2Games` at 0 (A69(1) as written), and a colour choice never changes either number. Colours affect only seating and which colour's win credits which team.
  2. **No head start by colour.** `BracketMatch.headStartSide` and the `headStartSide` argument of `set_match_sides` are removed; the reducer is `set_match_sides(bracketMatchId, blueTeamId)`. The bracket view derives "Blue leads 1–0" from the tally and the colour mapping; nothing is stored for it.
  3. **A slot change voids the colour choice.** When a slot of a match changes (placement, un-placement on a rollback, a BYE after a DQ), `blueTeamId` is reset to unset, because the choice was made for the old pairing, and the stored tally is rewritten so it equals the derived one. The read-side fallback of A70(1) (a stale `blueTeamId` reads as the default) stays as a defence.
- **Why:** the S8g tests showed the colour-based head start (A70(2)) moving the stored tally to the other team when staff put the head start colour on the losers' bracket finalist's team, and going stale when a finalist changed. User, 2026-11-08: "the point should go to whichever got it from the winner brackets into the grand final right? colors should be independant of whoever team picks blue or red, the score for team1 and team2 should not change … it is an architectural bug tho." The guard order of `set_match_sides` ("a game has started" before "a lobby exists") is fixed in the same pass as an architecture bug (user ruling).
- **Supersedes:** A70(2) entirely and the `headStartSide` parts of A70(3) and A70(4); A70(1) (colours per match, every match, stale fallback) stands.
- **Where implemented:** S8g fix pass (same step), S9 (view derives the leading colour), S14 (one selector: who plays Blue)

### A72 — Module layout: domain folders and the `@module` alias

- **Date:** 2026-11-08 · **Status:** decided (user request; grouping and import style approved)
- **Decision:**
  1. `spacetimedb/src/tables`, `reducers` and `helpers` are grouped into the same nine domain folders, mirroring `docs/<feature>/`: `identity`, `lobby`, `draft`, `results`, `tournament`, `stats`, `roster`, `calendar`, `admin`. `views/` (one file per domain) and `types/` stay flat; `index.ts` and `schema.ts` stay at the root. A new file goes into the folder of the feature whose contract describes it; a new domain gets a folder in all three places.
  2. Every cross-folder import inside `spacetimedb/src` (module files, tests under `src/__tests__/`) uses the alias form `@module/<kind>/<domain>/<file>` (`@module/views/<file>`, `@module/types/<file>`, `@module/schema`); same-folder imports may stay `./x`. Relative `../` imports are not used in the module.
  3. The CLI bundler (Rolldown) matches a tsconfig `paths` wildcard against one path segment only, so the alias is declared **per folder** in `tsconfig.base.json` (`"@module/<kind>/<domain>/*": ["./spacetimedb/src/<kind>/<domain>/*"]`, plus `@module/views/*`, `@module/types/*`, `@module/index`, `@module/schema`), inherited by the module and root projects through `extends`; `test/tsconfig.json` keeps its own `paths` block (it also declares `@/`) and mirrors the entries relative to `test/`; each vitest config has a single `'@module'` alias (vite resolves the full path). A new domain folder needs its entries in `tsconfig.base.json` and `test/tsconfig.json`; a missing entry fails `npm run typecheck` and `spacetime build` loudly (vitest alone would not notice).
  4. Code outside the module (`test/`, `scripts/`) keeps relative or `@shared` imports; `shared/` never imports the module.
- **Why:** the three folders had grown to 43 / 48 / 78 flat files. User, 2026-11-08: "could we do a small mechanical refactor to create subfolders that make sense and group files inside them?"; on imports: "do whatever is gonna be easier for future agents and less prone to errors" — a location-independent alias beats counting `..` across nested folders, and the per-folder declaration is the price of the bundler's one-segment matching (the same limit that made `@shared` folders use barrels, S4).
- **Supersedes:** nothing (a layout convention; A53 covers `design/`).
- **Where implemented:** S8h (mechanical: `git mv`, import rewrites, configs, architecture docs' path citations, CLAUDE.md §1); T-S8h (test imports, `test/` configs)

### A73 — Team requests identify the requester to the captain, in every tournament

- **Date:** 2026-11-08 · **Status:** decided (user ruling on the S9a open item)
- **Decision:**
  1. `view_my_team_requests` shows a captain who is asking to join their team: the requester's real `userId` **and** real display name (`resolveUserLabel`), whatever the tournament's anonymity setting. The requester's own rows (`isMine`) are unchanged. `accept_team_request` / `reject_team_request` keep taking the requester's user id.
  2. This is an A37 clarification, not an exception: team formation is a social act between people who are about to play together, before any match exists; the anonymity rules (`isAnonymousDefault`, seat labels) apply to opponents and spectators once the bracket is seeded. Team members see each other identified anyway (A37 teammates).
- **Why:** S9a left the row half-way (real id, anonymized label), which the review flagged. User, 2026-11-08: "For 1, keep the requested identified."
- **Supersedes:** nothing (clarifies A37 for the team-request flow).
- **Where implemented:** S9c (view label, docs)

### A74 — Lobby members are targeted by seat number; the server translates the seat to the user id

- **Date:** 2026-11-08 · **Status:** decided (user ruling on the S9a open item)
- **Decision:**
  1. **One argument, one path.** `kick_member`, `ban_member`, `set_team_slot`, `set_captain` and `transfer_referee` take `targetJoinSeq: u32` (the seat number `view_my_lobby_members.joinSeq`, the only member key an anonymized caller sees) instead of a user id. The reducer resolves the seat to the lobby's `LobbyMember` row with that `joinSeq` (`resolveSeat(ctx, lobbyId, joinSeq)`, through `LobbyMember.lobby_id`; "No member sits at seat N of this lobby." when none does) and continues with the resolved user id through the existing logic: every permission check, stage rule, message, flag transfer, chat event and audit stamp is unchanged. No reducer keeps a user-id variant. `set_team_slot`'s `targetJoinSeq` is optional: omitted means the caller's own seat (the self-move), so a client never looks up its own seat number.
  2. **Bans record the seat.** `LobbyBan` gains `bannedJoinSeq: u32`, the seat the member held when banned. `ban_member` therefore requires a member row (present or away, A68(2)); the preventive ban of a user who holds no row is gone: a ban exists to stop a rejoin, and a user without a row is banned when they come back. `unban_member(lobbyId, bannedJoinSeq)` resolves the ban row by `(lobbyId, bannedJoinSeq)` through `LobbyBan.lobby_id` ("No ban is recorded for seat N of this lobby.") and deletes it; its permission rule (A45(3)) is unchanged. `view_my_lobby_bans` and `view_admin_lobby_bans` carry `bannedJoinSeq`; the admin In-Cell `lobby_ban` grid lifts a ban through the same reducer.
  3. **Seat numbers are never reused within a lobby.** `Lobby` gains `lastJoinSeq: u32` (the host's seat is 1 at creation); `nextJoinSeq` reads and bumps it instead of `max(joinSeq) + 1` over the current members, so a departed member's seat number is never given to a later joiner: a seat number names exactly one membership for the lifetime of the lobby, and a ban's seat stays unambiguous.
  4. **Anonymity (A37).** No argument or rejection text of these reducers names a user id; rejections cite the seat number. The S9a chat events and labels are unchanged.
- **Why:** since S9a an anonymized host or referee cannot know a member's user id, so the six reducers were uncallable from an anonymous lobby. User, 2026-11-08: "yes, by seat number, but it would be better that the server translates it to user id so we dont do a different path."
- **Supersedes:** the `targetUserId` / `userId` arguments of the six reducers (D-21, D-27, D-28, D-30, A45(3) as to their argument shape); the "Ban Non-Member" preventive ban; R4's `max + 1` join counter (the counter semantics stand).
- **Where implemented:** S9c (reducers, the two columns, the two ban views, bindings, docs; T-S9c rewrites the call sites in the in-memory suites and marks the live ones for S10)

### A75 — Only the spectator referee sees every roster

- **Date:** 2026-11-08 · **Status:** decided (user ruling on the S9b open item)
- **Decision:**
  1. In `view_my_roster_visibility` the referee exemption of D-14 ("any referee sees every roster and rating") applies to the **spectator referee** only, as D-71 (identities) and A40's member row (exact ratings) already do. A referee who sits on a team is a player: self and teammates in full, opponents per the lobby's `rosterVisibility` (OpenRoster → roster and rating; ClosedWithRating → rating only; ClosedNoRating → nothing).
- **Why:** a seated referee could read the opponents' characters, eidolons and exact rating under `ClosedNoRating` through the roster view while the member row withheld the rating from the same caller (S9b review #1). User, 2026-11-08: "For 3, also agree."
- **Supersedes:** D-14's "any referee" (narrowed).
- **Where implemented:** S9c (one condition in the view, docs)

### A76 — S10 triage: the contracts adopt the implementation's wording and shapes

- **Date:** 2026-11-09 · **Status:** decided (user ruling on the S10 test failures)
- **Decision:**
  1. The 25 in-memory tests that failed at S10 (23 in `s10-calendar`, 2 in `s10-identity`) differed from the code in rejection text only; every state assertion passed. The tests assert the implementation's texts; `docs/calendar/contract.md` and `docs/auth/contract.md` record those texts as Phase S10 execution rows and mark the superseded lines in place. No module code changes.
  2. The calendar parameter shapes stay as implemented: `invite_to_event(eventId, inviteeUserId)` invites one user per call; `create_calendar_event`, `update_availability_slot` and `update_calendar_event` take every field (`''` / `0` for "none", `inviteeUserIds` a comma-separated string) and the update reducers replace the row.
  3. Applied by the orchestrator under the same rule to the other wording drift the S10 ports reported (the tests already follow the code; any row may be vetoed): tournament cancel / update texts and the Waiting-only, additive account-selection texts (`docs/tournament/contract.md`); the kick / ban scenarios by seat (A74, `docs/chat/contract.md`); the D-34 spectator cursor drop (`docs/lobby/contract.md`); the D-08 `start_draft` text (`docs/match-session/contract.md`); `server_link_discord` → `server_link_provider` (A46, `docs/admin/contract.md`).
  4. Left open, contract lines unmarked: the `equip_lightcone` / `unequip_lightcone` permission (contract: captain or sole player; code: any player seat of the team) and the event cap counting every organized event after the 90-day cleanup rather than "active" events.
- **Why:** user, 2026-11-09: "well contract then". The texts have been live since S3–S9b and are what the older in-memory suites assert; the contract strings predate the implementation and no decision row fixed them; changing the code would be cosmetic churn plus a re-alignment of passing suites.
- **Supersedes:** the quoted rejection texts and the optional-parameter tables of the calendar and auth contracts (marked in place).
- **Where implemented:** S10 (T-S10 align; Phase S10 execution rows in seven contracts)

### A77 — `User` becomes a private table; `UserPrivate` merges into it

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. `User` is `public: false`. No client subscribes it. The admin Users tab reads a new Moderator+ view `view_admin_users`; the leaderboard gets its names through a labelled view (`view_leaderboard`) or denormalized columns (implementer's choice, recorded in the step log); a lookup by id (`view_user_by_id(userId)`) is added if a page needs one. `view_user_by_username` stays the exact-match search.
  2. `UserPrivate` is merged into `User`: `loginMethod`, `providerId`, `providerUsername` and a `linkedAt` timestamp (the link time that `UserPrivate`'s audit columns carried) move onto the user row together with the two provider indexes; `hasDiscordLinked` is dropped and derived in the views that expose it. `view_my_profile` and `view_admin_user_private` keep their row shapes.
  3. The live test harness (`test/shared/connection.ts`) resolves a guest's user id through `view_my_identity` instead of scanning `User`; the residue test "User is public today" asserts the refusal instead.
- **Why:** user, 2026-11-09: "we can put user private and merge UserPrivate into User". PAGE-MAP D2 already moved every page off `User`; a public directory still lets any raw client enumerate every UID, role and soft-delete flag; the split into `UserPrivate` existed only because `User` was public.
- **Supersedes:** PAGE-MAP D6 ("full `User` subscription is legitimate" on the admin Users tab), the "public today" note of the S10 residue, CR-01's two-table split (Phase 12), the CLAUDE.md §4 sentence naming the admin Users tab as the one `User` subscriber.
- **Where implemented:** S11 (schema change, lands with the clear-publish; T-task for the identity suites and the live harness)

### A78 — Game-package edits: captain or referee, with an explicit team side

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. `set_eidolon`, `equip_lightcone`, `unequip_lightcone` and `arrange_lineup` share one caller rule on the open game: the captain of that team or any lobby referee (`ensureCaptainOrReferee`). A non-captain teammate, a coach and a non-referee spectator are rejected. The Admin path on a closed game (A60(7), A69(2)) is unchanged.
  2. `equip_lightcone` and `unequip_lightcone` take a `teamSide` argument (second, after `lobbyId`, as `set_eidolon`); the character must be in that team's draft. This removes the "first team that holds the character" lookup of the Admin path, which could not reach Red's copy under `allowMirrorPicks`.
  3. `equip_lightcone` and `unequip_lightcone` use the lineup throttle (`AbuseConfig.lineupMinIntervalMs`) on the open path, like `set_eidolon` and `arrange_lineup`.
- **Why:** user, 2026-11-09: "lightcone and eidolons should be captain or referee editable just like lineups". One rule for the whole package; the referee could fix eidolons and lineups but not light cones; every edit recomputes the game and resets both confirmations, so the unthrottled light-cone path was a fan-out gap (B-4).
- **Supersedes:** A60(1) as implemented in S7b for the callers of `set_eidolon` ("a player seat of that team or any lobby referee"); the "any player seat of the team" rule of the light-cone reducers; closes the first open item of A76(4).
- **Where implemented:** S10b

### A79 — Calendar event cap: 40 not-yet-ended, 100 retained

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. `create_calendar_event` rejects when the caller organizes 40 events that have not ended (`endAt >= now`), counted after the lazy cleanup. Finished events no longer count against this cap.
  2. A second ceiling: at most 100 events per organizer in total (ended or not, after the cleanup).
  3. `create_calendar_event` rejects an `endAt` in the past. `update_calendar_event` rejects a changed `endAt` that lies in the past; an update that leaves `endAt` as it is stays allowed (editing a finished event's title or description).
  4. The 90-day cleanup (D-07) and the one-week slot cleanup (D-27) are unchanged.
- **Why:** user, 2026-11-09: "i agree with the second option" and "I agree on your event cap with 100 as ceiling". Phase 08 D-06 said "40 active events"; the code counted every event for 90 days after it ended, which blocks a tournament organizer on finished matches. The guards and the ceiling keep a caller from cycling short events to pile up retained rows in other players' calendar views.
- **Supersedes:** A76's wording "counts every event the caller organizes after the 90-day cleanup" and the text "Maximum 40 calendar events per user."; closes the second open item of A76(4).
- **Where implemented:** S10b

### A80 — `start_draft` and `advance_stage` are referee powers

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. `start_draft` and `advance_stage` accept the lobby member who holds the referee flag, or a Moderator or Admin. The host as such no longer qualifies; a host who gave the flag away takes it back with `reclaim_referee` (unchanged), and an unheld flag is taken by any member (A68(7)).
  2. No lobby setting gates these two (unlike `refereeCanPause` / `refereeCanUndo` / `refereeCanKick` / `refereeCanSetCaptain`): they are the referee's own job. Lobby settings, `close_lobby` and the other host actions stay with the host.
  3. Everything else in the two reducers is unchanged (stage rules, D-50 rollover, readiness checks, A60(5): Equipping → Scoring has no gate).
- **Why:** user, 2026-11-09: "start draft or advance stage should be referee powers". The referee already pauses, undoes, edits the package (A78), closes games (A60(4)) and triggers concedes; a referee who is not the host could run the whole match except starting it and moving it between stages.
- **Supersedes:** the host rule of `start_draft` (D-era) and of `advance_stage` (D-58 / D-59; A60(5)'s wording "a host signal" becomes "a referee signal").
- **Where implemented:** S10b

### A81 — Auction: a full team sits out

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. A team that already holds `charactersPerTeam` characters in the current game neither nominates nor bids: `nominate_character` and `place_bid` reject it, and the nomination rotation (D-46) and the timer's auto-nomination skip it.
  2. While one team is full, the other team nominates and the nominated character is sold to it at once at its base cost, with no bidding round. The nominating team's existing budget checks apply unchanged.
  3. The auction ends when both teams hold `charactersPerTeam` characters (unchanged).
- **Why:** user, 2026-11-09: "For 4, I agree with recomendation". Backend closing audit, draft slice finding 4: the rotation kept handing the nomination to a full team, which could win a ninth character; the lineup could then never be valid and only a staff close ended the game.
- **Supersedes:** the match-session contract edge case "Auction sold when only one team needs characters: normal flow".
- **Where implemented:** S10c

### A82 — Auction character stats follow the winning team

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. For an `AuctionSold` step, the owning side is the sale's `winningTeam`, never the step's actor (the passer, or the system on a timer sale).
  2. Every player of the winning team (the non-coach participants of that side) gets the "played" stat for the character; every player of the other team gets the "faced" stat; the global character stat is written once, with the win flag of the owning side.
  3. No stat row is ever written for the system user or for a spectator side.
  4. Classic picks are unchanged (the picker gets "played").
- **Why:** user, 2026-11-09: "For 5, every player of the winning team". Audit, results slice finding 1: stats went to the passer, so the public win rate of auctioned characters was inverted.
- **Supersedes:** the actor rule of finalization step 16 for `AuctionSold` (D-54 wording).
- **Where implemented:** S10c

### A83 — The concede summary is staff-only

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** `MatchResult.concedeSummary` keeps its text (D-71: audit trail with user ids). Member-facing views return it only to a Moderator or Admin; every other caller gets no value, in anonymous and identified lobbies alike.
- **Why:** user, 2026-11-09: "For 6, do the recommendation". Audit, results slice finding 2: the text carried real user ids to every member of an anonymous lobby.
- **Supersedes:** nothing; narrows `view_my_match_result`.
- **Where implemented:** S10c

### A84 — Re-resolving a bracket match is refused while the next match is live

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** a re-resolve, rollback or override that would remove a team from a downstream match is rejected when that downstream match is Decided (unchanged) or has any lobby still alive or any match record that is Pending, Submitted, Disputed or Validated. Staff void or roll back the downstream match first. Nothing is voided automatically.
- **Why:** user, 2026-11-09: "For 7, do recomendation". Audit, tournament slice finding 1: the replacement team inherited the games the removed team had played.
- **Supersedes:** the "Decided only" refusal of `unplaceEntrant`.
- **Where implemented:** S10c

### A85 — Lifting a disconnect auto-pause

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. Re-entering the room (`join_lobby` reconnect branch) lifts an auto-pause only when the caller is a seated player (not a coach, not a spectator) and, after the caller's own return, no seated player of either team is still offline, away or abandoned.
  2. `resume_draft` on an auto-pause is open to the referee (unchanged) and to any seated player of either team. Coaches and spectators who do not hold the referee flag are rejected. A manual pause keeps D-62 (the referee or the player who paused).
  3. The disconnect pool, the forfeit grace and `claim_forfeit` are unchanged.
- **Why:** user, 2026-11-09: "We can reply on a player's good sport, we can limit this to referee's and seated players (both sides), not coaches or spectators", then "yeah lets do the split" (the automatic path stays tied to the away player's return because the page calls `join_lobby` on every reload). Audit, lobby slice finding 1.
- **Supersedes:** D-11 / D-39's "any reconnect resumes"; extends D-62 for auto-pauses.
- **Where implemented:** S10c

### A86 — A timer auto-pick of a real character is priced like a manual pick

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** when a Classic turn expires and `autoRandomPick` picks a real character, the pick is priced from the lobby's cost row exactly as `pick_character` prices it: at eidolon 0 when ownership is not required, at the highest owned eidolon of the acting team's account when it is (`resolveOwnedEidolon`), and only characters that team may legally pick are drawn. The `EMPTY` placeholder (setting off, or nothing pickable) stays at cost 0.
- **Why:** user, 2026-11-09: "for the timer auto-pick, I agree with your recommendation". Audit, draft slice finding 6: a captain who let every turn expire got eight real characters at roster cost 0, the largest possible handicap in their favour.
- **Supersedes:** the match-session contract line that gives the timer pick `costPaid = 0` for a real character (it stays true for `EMPTY`).
- **Where implemented:** S10d

### A87 — Mirror picks: once per team

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** with `allowMirrorPicks`, a team may pick a character the other team already picked, but no team picks the same character twice. Without the setting nothing changes (a picked character is gone for both). The rule holds on every pick path (manual, timer auto-pick, Auction nomination and sale where mirror applies).
- **Why:** user, 2026-11-09: "a team can only pick a character once, the enemy team can pick it again, but only once!". Audit, draft slice finding 10.
- **Supersedes:** nothing; closes a gap in the mirror rule.
- **Where implemented:** S10d

### A88 — A team-seated tournament referee keeps score adjustments and the staff close

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** A39 stays limited to the `winnerOverride` on an unresolved tie. A referee seated on a team in a tournament lobby may still call `set_score_adjustment` for either team and close the game as staff (A34a, A60(4)). No code change; adjustments stay audited.
- **Why:** user, 2026-11-09: "yes, we will rely on good sportsmanship here". Audit, results slice finding 5 asked for a direction.
- **Supersedes:** nothing; clarifies A39 against A34a.
- **Where implemented:** S10d (contract note only)

### A89 — Tournament staff manage tournament-linked calendar events

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** for a calendar event linked to a bracket match (`bracketMatchId` set), `update_calendar_event`, `delete_calendar_event` and the invite reducers accept the event's organizer, an Admin, the tournament's organizer and any tournament staff holding the `bracket` permission (the permission that creates such events). Personal events are unchanged (organizer or Admin).
- **Why:** user, 2026-11-09: "yes, they can". Audit, roster / calendar slice finding 7: an event scheduled by an assistant locked the tournament's organizer out, and D-19 blocked a replacement.
- **Supersedes:** the "Organizer or Admin" caller rule of the calendar contract for tournament-linked events.
- **Where implemented:** S10d

### A90 — `update_calendar_event` enforces the active cap

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** an update that moves an ended event's `endAt` back to now or later is rejected when the event's organizer already has 40 not-yet-ended events ("Maximum 40 active calendar events per user."). Updates that keep an event active, or keep it ended, are not counted again.
- **Why:** user, 2026-11-09: "we should be consistent here so I vote yes". S10b review F2: the 40-active cap of A79 could be passed through update, up to the 100 ceiling.
- **Supersedes:** nothing; completes A79(1).
- **Where implemented:** S10d

### A91 — Deferring a match

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. `defer_match` requires at least one seated player (not a coach) who is offline, away or abandoned and whose forfeit grace (`disconnectForfeitSeconds`) has passed or whose disconnect pool is empty (the live drain, A92(6)). An exclusive spectator referee (D-81) may defer without that precondition.
  2. The `Deferred` policy is selectable only for tournaments and their lobbies. `create_lobby`, `update_lobby_settings` on a lobby that is not tournament-controlled, `create_lobby_preset` and `update_lobby_preset` reject it.
  3. The automatic park at an empty pool from the original notes (Phase 10 D-10, Deferred branch) is retired: nothing ends or parks a match automatically (A68).
  4. A parked lobby (AwaitingResult) is cleared by a Moderator or Admin by hand (`admin_force_finalize` / `admin_void_match`), or by tournament staff through the result reducers. No automatic clean-up.
- **Why:** user, 2026-11-09: "lets go with your recommendation for deferring then" and "I agree wiuth your recomendations"; on parked lobbies: "i think is okay to let moderators or admins clear them by hand". Original intent (old repo Phase 10 notes): Deferred is "for tournament matches where TOs control outcomes"; defer is the exit of players waiting on a disconnected opponent. The code let any seated player park a healthy match, in casual lobbies too.
- **Supersedes:** D-20 / D-63's unconditional defer; the Deferred branch of D-10.
- **Where implemented:** S10d

### A92 — Disconnect rules, second pass

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. `start_draft` is rejected while a seated player (not a coach) is offline or away.
  2. `disconnectForfeitSeconds` is 30 to 600 wherever it is set (lobby, preset, tournament); unset keeps the default 60.
  3. The `NoAction` policy is for casual lobbies only: rejected for Ranked lobbies and for tournaments.
  4. A seated player whose row is away cannot `concede_match`, `claim_forfeit` or `defer_match` until they return through `join_lobby`; an abandoned row never can.
  5. In the Waiting stage a host or referee who disconnects is subject to the same 15 s transfer check as in the live stages (A22(5) order, online first).
  6. Forfeit eligibility uses the live pool: a player is past the pool when `pool - (now - disconnectedAt) <= 0`, not only when a stored pool is 0.
  7. `client_connected` lifts an auto-pause under the same test as A85(1) (a seated player returns and no seated player is still away).
  8. A disconnect during a manual pause stays as it is: no auto-pause is added, and the pauser (or the referee) resumes by D-62. Accepted behaviour, not a defect: the forfeit clock and the pool still run for the away player, the captain role moves to a present teammate, and the resume is a deliberate press.
  9. `view_my_lobby_members` shows, for a seated player who is offline, away or abandoned in a live stage, the instant from which the forfeit claim (Standard) or the defer (Deferred) becomes available, so the room page can enable the button.
- **Why:** user, 2026-11-09: "I agree wiuth your recomendations but I wanna explore more number 6", then, on the manual-pause case, "I would prefer not second pauses as this may look like a bug" and "yeah i agree with this final implemntation". Source: the disconnect policy review of 2026-11-09 (D2, G1, G4 to G7, G9, G11).
- **Supersedes:** nothing wholesale; narrows A22a (Waiting), D-12 / D-13 (pool test), and the policy choices of `create_lobby` and `create_tournament`.
- **Where implemented:** S10d

### A93 — The host in the waiting room, and a host hand-over

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. In the Waiting stage a disconnect moves the referee flag only: 15 s after the referee (host or not) disconnects, the flag goes to an online member in the A22(5) order, so the match can be started (A80). The host role does not move on a disconnect in Waiting, in casual, ranked and tournament lobbies alike.
  2. No room is closed because its host is away. The existing clean-up stays the only automatic removal: every member offline and 30 minutes idle (D-47, A68(9)).
  3. New reducer `transfer_host(lobbyId, targetJoinSeq)`: the host hands the host role to another member of the lobby who is present (not away, not abandoned), by seat (A74). Available in every stage in which the lobby is alive. A Moderator or Admin may call it too.
  4. Unchanged: a host who presses Leave in Waiting passes the role to the next member (A68(7)); in the live stages the host role moves with the 15 s check as before (D.8.2).
- **Why:** user, 2026-11-09: "if the host drops in waiting room, shouldn't we just drop the room? nothing had started yet", then "i forgot we had a 30m room cleanup for idles and everyone offline, even hosts right? wouldn't we want to work around that one then?", then "yeah i agree with the new version". S10d review F4: as built for A92(5), tournament staff who dropped for 15 s in Waiting lost the host role to a player and nothing returned it.
- **Supersedes:** the host half of A92(5).
- **Where implemented:** S10e

### A94 — User deletion and tournaments

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. The organizer of a tournament that is not Completed or Cancelled cannot delete their own account (`delete_my_account` rejects, verified and guest branch alike).
  2. Every other deletion path (`performUserDeletion` from self-deletion, ban, admin and server deletion) settles the user's tournament ties first: in a tournament whose bracket does not exist yet the user is withdrawn (the enrolment path of `withdraw_from_tournament`, including solo team, membership and account locks); once the bracket exists the user is disqualified (the `dq_participant` path). Pending team requests, assistant rows and stand-in approvals of the user are deleted.
- **Why:** user, 2026-11-09: "deleting a user with tournament ties: agree". Audit, identity finding 2 and tournament finding 14: a deleted player kept an enrolment, a team and a captaincy; an organizer could delete their account mid-tournament.
- **Supersedes:** nothing; completes the deletion cascade.
- **Where implemented:** S10g

### A95 — Guest retention and a guest creation limit

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. The weekly identity clean-up deletes a guest user that has been idle for 30 days and has no match history at all (no participant row in any live or archived match). A guest with any match history is kept.
  2. Guest creation (`login_as_guest`) gets a counter with a threshold and an admin alert, modelled on the guest lobby breaker (A57 / A58); thresholds live in `AbuseConfig`.
- **Why:** user, 2026-11-09: "a guess idle for 30 days is fine as long as there is no match history at all". Audit, identity finding 7: guests were never collected and creation was unlimited.
- **Supersedes:** D-06's "identity GC skips guests" for the idle, history-free case.
- **Where implemented:** S10h

### A96 — Cursor events carry the seat, not the user

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** `LobbyCursorEvent` rows identify the sender by the lobby seat number (`joinSeq`), never by user id, in anonymous and identified lobbies alike. The stream is restricted to the lobby's members if SpacetimeDB 2.14.1 offers a supported way to do so for an event table; if it does not, the orchestrator reports back before any other route is chosen.
- **Why:** user, 2026-11-09: "cursor stream: i agree on that". Audit, lobby finding 8: any connected client could read every lobby's cursor stream with real user ids.
- **Supersedes:** the `senderUserId` column of the cursor event (S11 clear-publish).
- **Where implemented:** S10h

### A97 — Anonymous labels come from the seat number

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** an anonymized member's label is built from the seat kind and the seat number (`joinSeq`), for example "Spectator #7" or "Blue Player #3", in views and in stored chat labels. The seat number never changes and is never reused (A74), so a label names one membership for the lobby's lifetime.
- **Why:** user, 2026-11-09: "anonymous labels: that's fine!". Audit, lobby finding 7: position-based labels shifted when an earlier peer left, so old chat lines pointed at the wrong person.
- **Supersedes:** the position-based label of `anonymousLabels.ts`.
- **Where implemented:** S10h

### A98 — Away and abandoned members cannot act

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** a member whose row is away (`leftAt`) or abandoned (`abandonedAt`) is rejected by every action reducer of that lobby: draft and Auction actions, post-draft edits, score entry and confirmations, pause / resume / undo, chat, cursor, seat and captain changes, referee and host transfers, kick / ban, settings. An away member regains everything by returning through `join_lobby`; an abandoned member never does. `leave_lobby` and `join_lobby` themselves are unaffected. Moderator and Admin powers that do not depend on membership are unaffected.
- **Why:** user, 2026-11-09: "away and abandoned: correct". Audit, lobby finding 2; extends A92(4).
- **Supersedes:** nothing; completes A68(2)(4).
- **Where implemented:** S10h

### A99 — A private lobby needs a password

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** `create_lobby` with `isPublic = false` and an empty password is rejected, and so is switching a lobby to private while it has no password.
- **Why:** user, 2026-11-09: "private lobby without a password: correct". Audit, lobby finding 11: such a lobby could never be joined.
- **Where implemented:** S10h

### A100 — No advance out of an unfinished draft

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** `advance_stage` from Drafting is rejected until both teams hold all their characters (`charactersPerTeam`, `EMPTY` placeholders count).
- **Why:** user, 2026-11-09: "advancing out of an unfinished draft: correct". Audit, draft finding 7: an early advance left a lineup that could never be valid.
- **Where implemented:** S10h

### A101 — Light-cone costs come from the lobby's own cost set and draft mode

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** `equip_lightcone` (and every other light-cone price lookup, including the Auction auto-ban pool) reads the rows of the lobby's cost set, game mode and draft mode. There is no silent fallback to the default cost set: the coverage guard (`doesCostSetCover`) and the lookup read the same rows, and a missing row is handled by one rule for characters and light cones alike (a selectable cost set covers what its lobby needs; a missing row rejects the action with a clear text).
- **Why:** user, 2026-11-09: "light cone cost in auction: correct on that". Audit, draft finding 9 and roster finding 8.
- **Supersedes:** the Classic-rows lookup and the fallback to set 0.
- **Where implemented:** S10h

### A102 — The global rating is per season

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** `globalCompositeRating` is computed from, and written to, the user's `MmrRating` rows of the current season only.
- **Why:** user, 2026-11-09: "global rating: yes thats right". Audit, results finding 4.
- **Where implemented:** S10h

### A103 — A tournament's anonymous setting is fixed after Draft

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** `update_tournament` accepts a change of `isAnonymousDefault` in the Draft stage only, like format and team size.
- **Why:** user, 2026-11-09: "tournament settings: yes that's fine!". Audit, tournament finding 9: flipping it after registration left display names in solo team names.
- **Where implemented:** S10g

### A104 — Locking game accounts after registration

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** a registered (approved or waitlisted) player may add account locks for a tournament until their first game of that tournament has started; locks are never removed that way. The rest is unchanged and confirmed: registration locks the accounts named, or all of the player's accounts when none are named (a player owns at most 5); per match the player selects, in the Waiting stage, one or more of their locked accounts up to the tournament's `maxAccountsPerPlayer`; an account that is not locked cannot be selected. A waitlisted registrant's chosen accounts are remembered for promotion.
- **Why:** user, 2026-11-09: "they also select which account or accounts they play with on a given match as long as they all were locked during the signup, right?" (yes), after the recommendation to allow late locking until the first tournament game. Audit, tournament finding 7: a player who registered before adding an account could never start a match.
- **Where implemented:** S10g

### A105 — Tournament staff views

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. The staff views (`view_my_tournaments`, `_enrolled`, `_teams`, `_team_members`, `_matches`, `_match_results`, `_lobbies`) return only tournaments that are not Completed or Cancelled, for the organizer, the assistants, and Moderators and Admins.
  2. An Admin-only set of views sees everything, finished and cancelled tournaments included. To bound egress it takes the tournament id as an argument.
- **Why:** user, 2026-11-09: "yes, make one for admin only that sees everything tho.". Audit, tournament finding 12.
- **Where implemented:** S10g

### A106 — A Classic timer auto-pick credits the whole team

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:** when the Classic turn timer auto-picks a real character, every player of the acting team (the non-coach participants of that side) gets the played stat for it, with that side's win flag; the other team gets the faced stat and the global stat is written once. Same rule as an Auction sale (A82(2)). A manual Classic pick still credits the picker only (A82(4)); `EMPTY` and `SKIP` write nothing.
- **Why:** user, 2026-11-09: "for the auto picker on classic, yes, credit every player on the team that got it". S10f review F5: the timer pick has no picker, so nobody received the played stat.
- **Supersedes:** nothing; fills the case A82 left open.
- **Where implemented:** S10h

### A107 — Cost sets: completeness at publish, patch in place

- **Date:** 2026-11-09 · **Status:** decided
- **Decision:**
  1. Every character and light-cone price is read from the lobby's own cost set, game mode and draft mode. Nothing is read from the default set as a substitute (A101).
  2. Completeness is settled when a cost set goes live. For each draft mode the set already prices, publishing checks the draft against the reference tables (`HsrCharacter`, `HsrLightcone`). The owner sees the missing entries first (a view of the draft's missing rows, for the "push cost set live" dialog). `publish_cost_set` takes a confirmation flag: with gaps and no confirmation it is refused with the counts; with confirmation the missing entries are written at cost 0 in the draft and the live copy. A draft mode the set does not price at all is not filled, and lobbies of that mode cannot select the set (coverage guard unchanged in intent, reading the same rows as the lookups).
  3. A published set can be patched in place: its draft copy stays editable and publishing again upserts the draft rows into the live rows under the same id, with the same missing-rows confirmation. Tournaments, presets and lobbies that point at the set get the new prices without being changed.
  4. A patch is refused while any lobby using that set is in Drafting, Equipping or Scoring, with a text giving the count. Waiting rooms and tournaments between games do not block it.
  5. A character or light cone added to the reference data after a set went live is not filled automatically. Until the owner patches the set, picking, nominating or equipping it in a lobby on that set is refused with a text saying it has no cost in this lobby's cost set, and the timer's auto-pick never draws it.
  6. History is unaffected: finished and closed games keep the costs stored on their steps and lineups (`costPaid`, `rosterCost`, `synergySurcharge`); nothing in the history tables or views reads the cost tables.
- **Why:** user, 2026-11-09: "characters and lightcones should always be read from its cost set."; "before we publish it, it needs to confirm we have every character and lightcone in it and if it doesn't, thats when we fill it out with cost 0 but we need to show that to whoever clicks the \"push cost set live\" button"; "would prefer character scannot be picked in lobbies on olrder sets"; "I agree with you recommendation on filling" (only the draft modes the set prices); on patching in place with the live-match guard: "updating the cost set wont damage the history right? that's snapshot. If so, yes I agree with your suggestion".
- **Supersedes:** A101's "a missing row rejects the action" as the general rule (it remains only for entries added after publish, clause 5); the frozen-after-publish rule of `publish_cost_set` ("clone to make a new draft" stays available but is no longer the only way to change a live set).
- **Where implemented:** S10h

### A108 — The default cost set carries Auction prices; no price defaults in reducers

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:**
  1. The seed data of the default cost set (id 0) prices every character and light cone for Auction with the same values as Classic, in all three game modes (`data/seed/characters.json`, `data/seed/lightcones.json`). Synergy rows keep their explicit Auction values.
  2. No reducer applies a default price or a cross-mode fallback. A lobby reads its own cost set, game mode and draft mode (A107(1)); an entry with no row there cannot be picked, nominated or equipped (A107(5)), on the default set as on any other.
  3. A new cost set is always a copy of the default set or of a published set, so it starts with both Classic and Auction prices; a host who edits only the Classic prices keeps a set that works in both modes.
- **Why:** user, 2026-11-10: "for auction, write down the cost set for auction with the same prices as classic. Dont make anything default on the reducers, just fill out the missing data at the seed data." S10i found that the seed priced Classic only, which the old silent defaults had hidden (a missing character row cost 0, light cones fell back to Classic rows).
- **Supersedes:** nothing; completes A107 for the default set.
- **Where implemented:** S10i

### A109 — Guest creation breaker: manual re-enable, default 300, server-side switch

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:**
  1. The breaker of A95(2) stays as built: the count resets every window, but once a window crosses the threshold `guestCreationEnabled` is turned off and stays off until someone turns it back on. Re-enabling is a deliberate action, not automatic.
  2. The default threshold is 300 new guests per 10 minutes (was 100).
  3. New server reducer `server_set_guest_creation(enabled)`, callable by a server identity (Owner or Delegate, the same guard as the other `server_*` reducers), so the switch can be turned on or off without a signed-in Admin session; it resets the counter when it re-enables, like `admin_set_guest_creation`.
- **Why:** user, 2026-11-10: "turning the switch back on I would prefer it to be an action item tho" and "could we be able to turn that switch off through a server reducer in case i'm not logged in? the default can be 300.". S10h review F3: while the switch is off a new browser cannot start a session, Discord sign-in included, so an Admin without an existing session needs a path that does not depend on logging in.
- **Supersedes:** the default of 100 in A95(2).
- **Where implemented:** S10i

### A110 — Character "played" stats follow ownership

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** for every way a team gets a character (a manual Classic pick, a Classic timer auto-pick, an Auction sale), the played stat is decided by ownership, not by who made the call:
  1. Each non-coach player of the owning team who owns the character on any of their HSR accounts (selected for the match or not) gets the played stat, with that side's win flag.
  2. If no player of the team is recorded as owning it and the team has exactly one player, that player gets it.
  3. If no player of the team is recorded as owning it and the team has two or more players, nobody gets it.
  4. The other team's faced stat and the global character stat are written as before; `EMPTY` and `SKIP` write nothing; no row for the system user.
  5. Ownership is read when the match is finalized; later roster changes do not rewrite stats.
- **Why:** user, 2026-11-10: "do you think we can have a way to only record character stats if the user owns the character at all even if they didnt chose the account that has it on the match that it got credit from (due to a team mate picking it) ? in an effort to have good data integrity for stats", then "I agree with your proposal for one player and two-or-more players". Only the captain can make a manual pick, so crediting the picker gave the captain every character of a 2v2 or 3v3 team.
- **Supersedes:** A82(2) and A106 (whole team credited) and A82(4) (the picker credited) for the played stat.
- **Where implemented:** S10k

### A111 — Cursor events stay public for now; the row filter is tested at S11

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:**
  1. The `LobbyCursorEvent` table stays readable by any connected client. After A96 a row carries only the lobby id, the seat number, a position and a time; nothing in it identifies a person. The site subscribes to its own lobby only.
  2. At S11, on the live test database, the platform's row filter (`clientVisibilityFilter`, labelled experimental and unstable upstream, and barred by the repo's `spacetimedb` skill today) is tested for this one table: whether it restricts cursor events to the lobby's members, and at what cost. The result goes to the user, who then decides whether to adopt it and lift the skill's rule for this table.
- **Why:** user, 2026-11-10: "also for cursor events, i accept that we can do A and then B later" (A = accept as is, B = test the row filter at the test database step). S10h review F2: a filter mechanism exists in SDK 2.14.1 and upstream says it applies to event tables, but no stable mechanism does; views cannot read event tables.
- **Supersedes:** nothing; closes the open half of A96.
- **Where implemented:** recorded in S10k; the test is part of S11

### A112 — Signing in to an existing account keeps the guest's tournament entry

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** when a guest signs in with a provider account that already has a user (`server_link_provider`, the case where the identity is re-pointed to the existing user and the guest user is deleted):
  1. Before the guest is deleted, each of the guest's enrolments in a tournament that is not Completed or Cancelled is moved to the existing user: the enrolment with its status, seed, alias and waitlist place, the solo team or the team membership and captaincy, and pending team requests. Bracket slots follow the team and are not rewritten. A solo team is renamed for the new owner by the usual naming rule.
  2. Account locks are rebuilt from the existing user's own game accounts (all of them, as at a registration that names none), because the guest's game accounts are deleted with the guest. A waitlisted entry carries no chosen accounts across.
  3. If the existing user already has an enrolment in that tournament, or cannot hold the entry (disqualified from it, or the tournament requires something the existing user lacks, such as a game account when a roster is required), the guest's entry is not moved and is settled as in a deletion (A94(2)).
  4. Everything else of the guest is deleted as before. Lobby memberships are not moved by this row.
- **Why:** user, 2026-11-10: "lets go with option A" (move the entry to the existing account). S10g review F2: after A94 a returning player who registered as a fresh guest and then signed in lost the entry (withdrawn or disqualified), although they had not left.
- **Supersedes:** A94(2) for this one deletion path.
- **Where implemented:** S10l

### A113 — "Require verified" is forced on where a guest cannot play; sign-in and guest clean-ups

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:**
  1. A tournament's `requireVerified` is stored as true, whatever the caller sent, when any of these holds: `countTowardsMmr`; `requireRoster`; `minimumMmr` is set; `requireOwnership`; `rosterVisibility` is anything other than the closed, no-rating value. Otherwise the organizer chooses.
  2. A change to a tournament that would turn `requireVerified` on (directly or through clause 1) is refused while guest enrolments exist in it, with a text giving their number; the organizer removes them first or leaves the setting off.
  3. Stats of games a guest played before signing in stay on the guest account (accepted; nothing is rewritten).
  4. Signing in to an existing account (the A112 path) is refused while the guest is seated as a player in a lobby that is in Drafting, Equipping or Scoring; the text asks them to finish the game first.
  5. When an entry moves (A112), the guest's calendar invites for that tournament's match events are re-pointed to the existing user.
  6. A guest cannot be made a tournament assistant.
  7. A guest session's entry going to whichever account signs in on that browser is accepted as it is (the organizer's control is `requireVerified`).
- **Why:** user, 2026-11-10: "well, im thinking if should account raiting tournaments should allow guests or not, i think not"; "the stats of the games played on the guest account can stay on the guess account, we dont have to move those"; "should we have a way to make required verified be true based on other tournament settings that would make it mandatory to have verified accounts?" and, on the proposal (the four settings, roster visibility, refusing the change while guests are registered), "yeah i agree with this". Clauses 4 to 6 are the three small fixes proposed with it; clause 7 is the orchestrator's recommendation, not objected to. Guests cannot own a game account (`create_hsr_account` requires a verified user) and are refused by ranked lobbies, so each setting in clause 1 already made a guest unable to play.
- **Supersedes:** nothing; narrows A112 (clause 4) and the registration rules.
- **Where implemented:** S10m

### A114 — Joining a lobby: by code or from the lobby list; the creator sends no code

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:**
  1. A lobby is joined in two ways, both through `join_lobby`: by typing its join code, or by selecting it in the lobby list (the page passes the lobby id). Both stay.
  2. The join code is always generated by the server. `create_lobby` and `create_tournament_lobby` no longer take a `joinCode` argument (it was accepted and ignored).
  3. The `presetId` argument of `create_lobby` is unchanged in this row.
- **Why:** user, 2026-11-10: "i would like the lobby code to be the way people join matches or when they click on join through the UI after selecting a lobby to join". S10j listed the ignored create-time argument.
- **Supersedes:** the `joinCode` parameter of the two create reducers in the lobby and tournament contracts.
- **Where implemented:** S10n

### A115 — Match history is paginated and filterable

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:**
  1. The caller's match list is served 10 matches per page, newest first by the time the match was played (never by id), through a view that takes the page number and optional filters (game mode, draft mode, match type).
  2. A companion view gives the number of matches for the same filters, so the page can show its page controls.
  3. The detail of one match (steps, lineups, games, participants) is served per match, by a view that takes the match history id and returns rows only when the caller took part in that match.
  4. The unbounded views that returned every step, lineup and game of every match the caller ever played are replaced by these. Rating history keeps its own view, bounded the same way (10 per page).
  5. Deferred: the tournament stats timing (ownership read at tournament completion) and the reserve time setting stay as they are; the user confirmed both on 2026-11-10 ("we can leave it"; "the reserve time i also agreee wit hthat recomendation").
- **Why:** user, 2026-11-10: "Match History is okay to do that in my opinion, maybe we could have a view that paginates the return data every 10 matches or add filders to it". Audit, results finding 10: the five history views returned every row of every match the caller ever played.
- **Supersedes:** the unbounded `view_my_match_*_history` views (S9b).
- **Where implemented:** S10n

### A116 — `create_lobby` takes no preset number

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** `create_lobby` no longer takes a `presetId` argument (the server only checked that the preset existed and copied nothing from it). A preset is applied by the lobby form, which fills its fields from the preset the player picked and sends the final settings. Presets themselves, `view_lobby_presets`, the preset reducers and the server-side use of `Tournament.lobbyPresetId` for tournament lobbies (A33a) are unchanged.
- **Why:** user, 2026-11-10: "yeah we can drop the preset number then". S10j listed the ignored argument; this completes A114(3).
- **Supersedes:** the `presetId` parameter of `create_lobby` in the lobby contract.
- **Where implemented:** S10n

### A117 — The random auto-pick needs accounts only where the lobby requires ownership

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:**
  1. `start_draft`'s `autoRandomPick` check (every seated player has a selected game account with characters, D-43b) applies only when the lobby requires ownership. In a lobby that does not, the draft starts without it, guests included.
  2. The pool is unchanged: with ownership required, the acting team's owned and priced characters; without it, every character priced in the lobby's cost set and draft mode.
  3. A player who gets a character they do not have asks the referee to undo the pick (`undo_last_step`, as today) and the turn is played again. The random draw must not repeat itself after an undo: a re-rolled turn can land on a different character.
- **Why:** user, 2026-11-10: "Is there to make the random autopick tied behavior tied to match settings that require an account or not? If its a lobby that allows guest, it cannot be ranked, so we can actually just randomly pick from the pool of characters, if they dont have the character, they can undo the pick and roll it again". Found while checking the guest flow: a guest cannot have a game account, so any lobby or tournament preset with `autoRandomPick` on could never start a draft with a guest seated.
- **Supersedes:** D-43b's unconditional account check at `start_draft`; the fixed draw of the timer pick (a function of the turn and the lobby only).
- **Where implemented:** S10o

### A118 — An organizer can remove a guest's approved entry without a disqualification

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** before the bracket exists, tournament staff with the participants permission can remove the approved entry of a guest user as a withdrawal (enrolment, solo team or membership, requests and locks removed; no Disqualified row, capacity freed), so the guest can register again once verified. After the bracket exists, and for verified players, the rules are unchanged (disqualification).
- **Why:** user, 2026-11-10: "i agree on your #1 suggestion". S10m review F3: to turn on a setting guests cannot meet (A113(2)) an organizer had to disqualify approved guests, and the permanent Disqualified row moved to the account the guest later signed in to (A112).
- **Supersedes:** nothing; adds a path next to `reject_participant` and `dq_participant`.
- **Where implemented:** S10o

### A119 — A guest who loses their browser loses the guest account

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** a guest account lives in the browser that created it. If its data is cleared or the device changes, the account and anything tied to it (a tournament entry included) is unreachable unless it is reconnected by hand through admin tools or server functions; no self-service recovery is built. The tournament pages tell a registering guest that the entry lives in this browser and that signing in keeps it.
- **Why:** user, 2026-11-10: "if they clear the browser data, we can assume that guest account will remain unreachable unless we manually connect it through admin tools or server functions, nothing we can do about that" and "agree on the notes you said".
- **Where implemented:** recorded; the page note is for M6 / M7

### A120 — Every random draw of the module uses the fair draw

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** the three remaining users of `ctx.random` move to the mixed-hash draw of A117 (`shared/lobby-rules/timerDraw.ts`): random bracket seeding (`bracketGeneration.ts`), the RandomSwap of `shuffle_teams` (`lobbySettings.ts`) and the random team formation of A36a (`tournamentHelpers.ts`). A shuffle is a Fisher-Yates pass whose every index comes from the mixed hash, keyed by the transaction time and values of the acting state (the tournament or lobby id and a per-position counter). No module code draws with `ctx.random` afterwards.
- **Why:** user, 2026-11-10: "for the decisions, we can move the same fair draw". S10o review F1: the host seeds `ctx.random` from the transaction timestamp through a sign-filled 32-bit value, which skews the first outputs (one position of 80 came up 4.1% of the time against an ideal 1.25%).
- **Supersedes:** the `ctx.random` shuffles of C-a7 (bracket seeding), `shuffle_teams` RandomSwap and A36a.
- **Where implemented:** S10p

### A121 — A tournament whose organizer is deleted or banned gets a new organizer

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** when staff delete or ban the organizer of a tournament that is not Completed or Cancelled, the tournament passes to the longest-serving assistant who holds all three permissions (that assistant row is removed and the user becomes the organizer). If no such assistant exists, the Moderator or Admin who performed the deletion or ban becomes the organizer. A deletion performed by the server identity with no staff user behind it leaves the tournament as it is today (Moderator and above manage it). The organizer still cannot self-delete (A94).
- **Why:** user, 2026-11-10: "pass the assistant or make the admin/moderator the new organizer". Triage item L70: the tournament kept pointing at the deleted user and only a Moderator could advance or cancel it.
- **Orchestrator's reading (not the user's words):** "the assistant" is taken as the longest-serving one with all three permissions; "the admin/moderator" as the staff member who performed the action; the server-identity fallback is added because no staff user exists there.
- **Supersedes:** nothing; completes A94.
- **Where implemented:** S10s

### A122 — The 31 "fix now" items of the closing triage are fixed before M3

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** the items marked "fix now" in `notes/audit-2026-11-09/low-findings-triage.md` (L1, L4, L16, L17, L21, L22, L32, L33, L34, L35, L40, L42, L44, L46, L51, L52, L63, L64, L65, L66, L69, L70, L71, L86, L87, L89, L93, L99, L100, L101, L102) are fixed as the list states them. Rules the fixes introduce:
  1. L1: `admin_update_user` applies the same name rules as a player's own rename, renames the solo team, and refuses a user pending deletion.
  2. L4: an admin delete of a match history row removes its participant, step, game and lineup history rows.
  3. L16: every system chat line goes through the 50-message trim, which drops the oldest message by time.
  4. L17, L93: `confirm_ready`, `unconfirm_ready`, `shuffle_teams`, `transfer_host` and the calendar and roster writes use the per-user allowance.
  5. L21: a Moderator edits or deletes only presets created by Moderators and hosts.
  6. L22, L89: user deletion removes the user's lobby presets and unpublished cost sets; a preset or set still referenced by an unfinished tournament or a live lobby is kept.
  7. L32: a ban must name a real character of the lobby's pool; `EMPTY` is not a manual ban.
  8. L33: a coach cannot pause.
  9. L34: the last ban of the Auction ban phase can be undone.
  10. L35: undo rows count toward a cap.
  11. L40: a match that ended during the draft archives the budget actually spent.
  12. L42, L44: achievement criteria and the rating config reject unknown fields, unknown tags, a divisor of 0 and inverted thresholds.
  13. L46: a tournament host awards only manual achievements.
  14. L51: finalizing a result is a power of the lobby's referee and staff, not of whoever closed the game.
  15. L52: a seated referee conceding their own team is a surrender.
  16. L63: a solo player promoted from the waitlist during Seeding is seeded.
  17. L64: `update_tournament` after the registration deadline refuses only a change of the deadline to the past; a bad date gives a readable error; at least 2 participants.
  18. L65: seeding by rating reads the active season.
  19. L66: stand-in approvals and their locks end with the tournament; an approval needs a running tournament and a team that is not disqualified.
  20. L69: an anonymous alias is unique in its tournament and cannot equal another entrant's display name.
  21. L71: an assistant with no permission reads no staff view.
  22. L86, L87: every calendar action runs the clean-up; the calendar view skips finished tournaments.
  23. L99, L100, L101: the prod target takes its token only from its own env file; the prod publish guard is an allow-list; `bootstrap` saves the new delegate before revoking the old one.
- **Why:** user, 2026-11-10: "lets run the fixes now then". The numbered rules are the orchestrator's reading of each list entry; the user triages anything a review flags.
- **Where implemented:** S10r (L1 to L52, L89), S10s (L63 to L102, A121)

### A123 — The last ban of a draft can always be undone

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** the referee can undo the last ban, in Classic and in the Auction ban phase. A122(9) stands as built in S10r: in Auction the undo works after the last ban until the first nomination, where nothing has been nominated, bid or bought.
- **Why:** user, 2026-11-10: "we should always be able to undo the last ban". The user was told that the triage row for L34 had misread the contract (the S4 entry F9 refused this undo because no budget rollback existed) and confirmed the behaviour.
- **Supersedes:** the S4 contract entry "Undo During the Auction Phase" for the window before the first nomination.
- **Open:** whether the window should stay open after a nomination exists (an undo that first cancels a nomination without bids) is not decided.
- **Where implemented:** S10r

### A124 — A server deletion of a tournament organizer cancels the tournament

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** when the server identity (Owner or Delegate, with no staff user behind the action) deletes or bans a user who organizes a tournament that is not Completed or Cancelled, the tournament is cancelled with the normal cancel effects. No assistant takes over on this path. The hand-over of A121 (assistant first, else the acting Moderator or Admin) applies only when a staff user performs the action.
- **Why:** user, 2026-11-10: "if the server deletes a user that was a tournament organizer we cancel the tournament, yes".
- **Supersedes:** the last clause of A121 ("a deletion performed by the server identity ... leaves the tournament as it is today").
- **Where implemented:** S10s

### A125 — In Auction the undo window stays open until the first bid

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** while a game's auction phase has no bid and no sale yet, the referee can still undo: a first undo cancels the open first nomination (manual or the timer's), giving the turn back to the nominator with a fresh timer; a further undo removes the last ban as in A123. Once a bid or a sale exists, undo is refused with the existing text. No budget or won count has moved inside the window, so nothing is rolled back.
- **Why:** user, 2026-11-10: "for the undo nomination, Extend to the first bid". Closes the open point of A123.
- **Orchestrator's reading (not the user's words):** "first bid" means the first bid step placed after a nomination; if a nomination itself commits the nominator to an opening price, that commitment is released by the undo.
- **Supersedes:** the window end of A122(9) and A123 (first nomination).
- **Where implemented:** S10s

### A126 — Alias uniqueness compares aliases only

- **Date:** 2026-11-10 · **Status:** decided (orchestrator's correction of A122(20), reported to the user)
- **Decision:** an anonymous alias must be unique among the aliases of its tournament (trimmed, case-insensitive). It is not compared with other entrants' display names. A tournament needs at least 2 participants at creation as well as on update (A122(17) applied to both).
- **Why:** S10s review F1: comparing an alias with entrants' display names let anyone who is not enrolled test a display name and learn whether that player is enrolled in an anonymous tournament, against A37 and A103. The display-name half of A122(20) was the orchestrator's wording of triage item L69, not the user's.
- **Supersedes:** the display-name clause of A122(20).
- **Where implemented:** S10s

### A127 — Undo removes the last draft step, whatever it is, until the draft is finished

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** while a game's draft is running, the referee's `undo_last_step` removes the last step and returns to the state before it, one step per call, in every draft mode and phase: a ban, a pick, a nomination, a bid, a sale (manual or made by the timer). Each undo restores exactly what the step changed (turn, timer, open nomination, highest bid and bidder, budgets, rosters, won counts, the next nominator). Undo stops when the draft is finished: the equip and eidolon stage is separate and is not undone by it. The cap of 300 Undo rows per game (A122(10)) stays.
- **Why:** user, 2026-11-10: "wait, after the bids are set, why would the undo not work? undo is always remove the last action ... cant undo just do step by step?" and "yeah i want undo to work on any step to go to the previous one, it would stop working after draft is finished, since the equiping part and eidolon selection is indant of it".
- **Supersedes:** the refusal "Undo is not available during the auction phase." (S4 contract entry F9), and the window ends of A122(9), A123 and A125.
- **Where implemented:** S10t

### A128 — A disqualified player cannot be a stand-in

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** `approve_stand_in` refuses a user whose own enrolment in that tournament is Disqualified. The checks of A122(19) (tournament in progress, team not disqualified) stay.
- **Why:** user, 2026-11-10: "a disqualifier player cannot be a stadn in for a team". S10s hand-off: only the team was checked.
- **Where implemented:** S10t

### A129 — The move from the draft to equipping is a manual step

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** the last pick (Classic) or the last sale (Auction) no longer moves the lobby to Equipping. The lobby stays in Drafting with the draft complete, no turn running and no turn timer, until `advance_stage` is called by whoever holds that power today (the referee, A80); the budget roll-over happens at that call. While the lobby waits there, `undo_last_step` works as on any other step (A127), so a wrong last pick or sale can be taken back. Timer picks and timer sales follow the same rule.
- **Why:** user, 2026-11-10: "what if we make moving to equipping a manual click, so if players are good with their picks, they have the opportunity to undo".
- **Supersedes:** the automatic Drafting → Equipping transition of the last pick and the last sale (D-50 roll-over at the last step); completes A127 ("undo stops when the draft is finished": the draft is finished when the stage is advanced).
- **Where implemented:** S10t

### A130 — A 60-second confirm window after the last draft step, then equipping starts by itself

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** after the last pick or the last sale the lobby stays in Drafting for a confirm window of 60 seconds. During the window the referee can undo (A127) or move to Equipping at once with `advance_stage`. When the 60 seconds have passed, the move to Equipping happens by itself, with the same budget roll-over. Like the turn timers, the expiry is a client-called reducer that the server validates against the elapsed time. An undo of the last step ends the window; finishing the draft again starts a fresh one. A paused draft holds the window as it holds a turn.
- **Why:** user, 2026-11-10: "we could put a small timer of like 60s that auto moves to equipping but you can click the a button to move automatically to equipping, better?". It removes the stall of A129 when the referee is away.
- **Orchestrator's reading (not the user's words):** 60 seconds is a constant, not a lobby setting; the pause rule and the fresh window after an undo.
- **Supersedes:** the "until `advance_stage` is called" clause of A129 (the wait is now bounded).
- **Where implemented:** S10t

### A131 — The confirm window is a lobby setting, default 60 seconds

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** the length of the confirm window of A130 is a lobby setting, stored and edited where the lobby's turn timer settings are (lobby settings, presets, tournament lobbies through their preset), default 60 seconds.
- **Why:** user, 2026-11-10: "the timer could be a setting for a lobby, default 60s".
- **Orchestrator's reading (not the user's words):** allowed range 0 to 300 seconds; 0 means no window (equipping starts with the last step, as before A129); the setting is locked once the draft has started, like the other timer settings.
- **Supersedes:** the fixed constant of A130.
- **Schema:** one new settings column wherever the turn timer settings live (joins the S11 clear-publish list).
- **Where implemented:** S10t

### A132 — Undo removes character steps; an eidolon choice goes with its character

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** the steps `undo_last_step` walks are the character steps of the draft: ban, pick, nomination, bid, sale. An eidolon selection made during the draft is not a step of its own for undo. Undoing the pick or the sale of a character removes that character together with every eidolon selection made on it, and gives back what those selections cost. An eidolon selection on another character is neither undone nor disturbed by an undo, even when it is the most recent action.
- **Why:** user, 2026-11-10: "undo is removing steps in the draft, undo would remove a character, it doenst have to remove eidolons selections that happen during draft. If a character was selected and set to eidolon 5 and we undo, we are removing the step of selecting the character, which in consequence also removes the eidolon selected."
- **Supersedes:** the SetEidolon entry of A127's step list as built first in S10t.
- **Where implemented:** S10t

### A133 — In Auction a team at 0 character budget cannot pay eidolon costs from the light-cone budget

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** during the draft of an Auction game, an eidolon cost may spill from the character budget into the light-cone budget only when the team's character budget is above 0 before the charge. A team whose character budget is 0 cannot raise an eidolon. So each team dips into the light-cone budget at most once per draft, with the charge that empties its character budget.
  1. A sale is one charge: the winning bid and the default eidolon cost of that character together. If the team had character budget before the sale, the eidolon part may spill even when the bid alone empties the character budget.
  2. Lowering an eidolon still refunds to the light-cone budget, never to the character budget.
  3. The rule ends when the draft ends: in Equipping and later the budgets are merged and eidolon edits pay from the pool as today.
- **Why:** user, 2026-11-10: "if the budget is already 0, does do we still draw from the lightcone budget and it would allow more than one draw from it? like if you have 0 already on character budget, not allow it to draw from lightcone, just if you have positive budget on character" and, on the three points, "i agree with what you put there".
- **Supersedes:** A61(5) and A61(6) where they let a team at 0 character budget pay an eidolon cost entirely from the light-cone budget during the auction.
- **Where implemented:** S10u

### A134 — In the auction phase an undo goes back to the nomination: the whole round is removed

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** in the auction phase the unit of undo is the nomination round (the nomination, its bids, and its sale if it was sold). An undo pressed while a round is open removes the nomination and all its bids; an undo pressed after a sale removes the sale together with its nomination and bids and gives back what the sale charged (A132). Either way the draft returns to the moment before that nomination: no open nomination, nobody holds a bid, the same team nominates again with a fresh timer. No undo ever restores an earlier bidder as holder, so the refusal "Cannot undo this bid: the previous bidder can no longer cover their bid." is removed. Bans and Classic picks are undone one step at a time as before.
- **Why:** user, 2026-11-10: "wouldnt it be better that undo just moves the bid phase to a renomination? so we just reset the budget as how it was right before the nomination". It removes the stalled-holder cases of S10t (review 2 G2 and the reopened bid after a sale undo).
- **Orchestrator's reading (not the user's words):** bids charge no budget, so removing a round needs no budget change; eidolon selections on other characters made during the round stay with their costs (A132); selections on the character of an undone sale go with it (A132).
- **Supersedes:** the bid-by-bid undo of A127 inside the auction phase and the bid refusal added in S10t.
- **Where implemented:** S10u

### A135 — Stand-in rules

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** (ids from `notes/audit-2026-11-09/standin-audit.md`)
  1. SI6: a stand-in must pass the same checks as a registration in that tournament (verified account, minimum rating, a game account where one is required, and the other entry requirements).
  2. SI7: staff of the tournament (the organizer and its assistants) cannot be a stand-in in it.
  3. SI8: a player whose own team is still in the tournament cannot be a stand-in. A player whose team is eliminated or withdrawn, and a user who is not enrolled, can.
  4. SI10: team members come first. A member always has the seat ahead of a stand-in.
  5. SI11: there is no fixed number of stand-ins, but at least one real member of the team must play in each game.
  6. SI15: tournament staff can see the stand-in approvals.
  7. SI19: no rating ceiling for stand-ins; items 1 and 3 are the limit.
  8. SI3: a stand-in can lock a game account added later, within the normal lock limit.
- **Why:** user, 2026-11-10: "SI6, yes, same checks as registration. For SI7, staff itself cannot be stand in. SI8, not while their own team is still in. SI9, SI8 solves this i think. SI10, Yes, members first. For SI11, only at least 1 real member must play. SI15, yes, staff can view. ... SI19 I agree with your recomendation. SI3, yes, within the normal lock limit".
- **Orchestrator's reading (not the user's words):** item 4 is built as: a member joining a Waiting lobby whose side is held by a stand-in takes the seat and the stand-in moves to Spectator, and the team captain can move a stand-in out; item 5 means a solo tournament (team size 1) cannot field a stand-in; SI9 (a stand-in sees the real names of the team it joins in an anonymous tournament) remains for eliminated players and outsiders, which is inherent to playing together; SI17 (approval between bracket generation and the start) is still open.
- **Where implemented:** S10v

### A136 — Stand-ins can be approved once the bracket exists

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** `approve_stand_in` is accepted from the moment the bracket is generated (Seeding after generation, and InProgress), not only once the tournament is InProgress. It stays refused before the bracket exists and in a Completed or Cancelled tournament. The message "Bracket generated; use stand-ins." is then true.
- **Why:** user, 2026-11-10: "for si17, lets go for option A". Audit item SI17: between bracket generation and the start, staff could neither promote from the waitlist nor approve a stand-in.
- **Supersedes:** the "tournament in progress" clause of A122(19).
- **Where implemented:** S10v

### A137 — Stand-in details: no self-approval, host moves are manual, ownership tournaments need a game account at registration too

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:**
  1. Nobody can approve themself as a stand-in, whatever their role (a Moderator or Admin who is not staff of the tournament included).
  2. An assistant with every permission switched off still counts as staff of the tournament and cannot be a stand-in (A135(2) as built).
  3. A host (or staff) moving a team member into a full side does not push a stand-in out: the host first moves the stand-in out, then moves the member in. The automatic take-over of A135(4) applies only to the member's own join and the member's own seat request.
  4. In a tournament that requires ownership, a stand-in needs an active game account, and a registration needs one too (`register_for_tournament` gains the same check).
- **Why:** user, 2026-11-10: "for #1, yes i approvee your recommendation, #2 yes, #3 well a host would need to manually drag the stand in out and then move the member in through the UI. For #4 correct on your recommendation".
- **Where implemented:** S10v

### A138 — No automatic seat moves for stand-ins: the host moves people by hand

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** nobody is moved out of a seat automatically. A team member who joins or asks for a seat on a side that is full does not take a stand-in's seat: the member is seated as a spectator like anyone else and the host moves people by hand. Automatic seating on join into a free seat stays. The only refusal about stand-ins in the lobby is the start gate: a game cannot start with a side whose seated players are all stand-ins (A135(5)).
- **Why:** user, 2026-11-10: "let a host handle the moves of people in the lobby. Only refuse if its a full team of stand ins, we dont need automatic moves, we can keep the automatic seatting but moves should be manual, otherwise it removes agency from a player and makes it feel like something is 'bugged'".
- **Orchestrator's reading (not the user's words):** the team captain's manual move of a stand-in of their own team to Spectator is kept, because a stand-in who created the lobby is its host and would otherwise be the only one able to free the seat; staff moves stay as today.
- **Supersedes:** the automatic take-over of A135(4) as built in S10v, and the second sentence of A137(3).
- **Where implemented:** S10v

### A139 — A disqualified member who hosts a waiting lobby keeps the host flags

- **Date:** 2026-11-10 · **Status:** decided (leave as is)
- **Decision:** nothing is built to take the host or referee flag from a member who is disqualified while hosting a Waiting tournament lobby. The disqualification already decides the team's match and moves the member out of the player seat; if a game is played anyway, staff invalidate it afterwards.
- **Why:** user, 2026-11-10: "why is a disqualifiying member hosting a room? if he is already disqualified, i think the best course is either let them play the lobby and then later we invalidate it. either way, players would know that person is disqualified and would drop from that lobby". S10v review 2, G3.
- **Where implemented:** no change

### A140 — A stand-in cannot create the match lobby

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** a stand-in approval does not give the right to create the lobby of a tournament match. The lobby is created by a member of one of the two teams or by someone whose role allows it by itself (tournament staff, Moderator, Admin). A stand-in who also holds such a role (for example an Admin) can still create it through that role.
- **Why:** user, 2026-11-10: "stand in should not be able to create tournament matches unless they have some higher power that would overwrite that (like an admin for example)". S10v review 3, N2: a stand-in who created the lobby was its host and referee and could move or kick the team's own members.
- **Supersedes:** the part of the stand-in rules that let an approved stand-in call `create_tournament_lobby`.
- **Where implemented:** S10v

### A141 — A full lobby refuses a team member like anyone else

- **Date:** 2026-11-10 · **Status:** decided (leave as is)
- **Decision:** a member of a match's team gets no exception to the lobby's limits. When the side's seats and the spectator seats are full, the member's join is refused until the host frees a place.
- **Why:** user, 2026-11-10: "if the lobby is full, then they cannot join yet, let the host handle that by himself, they would be communicating outside the web anyway to say they cannot join because its full". S10v review 3, N3.
- **Where implemented:** no change

### A142 — A game account in use by a live lobby cannot be edited, by anyone

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** while a game account is selected in an active lobby, its roster cannot be edited: the refusal that already applies to the owner's own edits (D-24, `accountLobbyLocks`) also applies to the Admin roster tools. In the same spirit an Admin cannot change or delete a cost row of a cost set while a lobby on that set has a game live (A107(4) already refuses a patch of the set). This removes the outside edits that could raise an eidolon cost between a bid and its sale. The sale fallback of S10u (the highest affordable level, down to E0) stays as the safety net for what cannot be refused: the deletion or ban of a seated user, and the roster of a member who abandoned the match (whose account is deliberately released, S10e).
- **Why:** user, 2026-11-10: "for the eidolon issue, can we just not allow edits to a given game account if its being used in a lobby at that very moment?". S10u review 2, G2.
- **Orchestrator's reading (not the user's words):** the cost-row part and keeping the fallback for the two remaining routes.
- **Where implemented:** S10w

### A143 — Account locks record their origin; the lock table gets an index by tournament

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** at S11 `TournamentPlayerAccount` gains a column that records where a lock came from (the player's own entry, or taking part as a stand-in), and an index by tournament. The release of stand-in locks then reads the origin instead of comparing lock time with approval time, and the end-of-tournament sweep reads only that tournament's rows.
- **Why:** user, 2026-11-10: "yeah i agree". S10v review 2 (G2) and review 1 (F16): the time-based release keeps a lock too long after a revoke and re-approval, and releases an entrant's own later lock; the sweep scans the whole table.
- **Where implemented:** S11 (schema change, with the clear publish)

### A144 — A disqualified guest does not block the verified-accounts settings

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** when `update_tournament` would turn the effective `requireVerified` on (A113(2)), only guest enrolments that are not Disqualified count. A tournament whose only guest entries are disqualified accepts the change; the disqualified guest stays disqualified.
- **Why:** user, 2026-11-10: "go with option A". A disqualified entry is permanent and no reducer removes it, so counting it would lock the organizer out of the setting for the rest of the tournament. S10m review F5 and the S10q diagnostic.
- **Supersedes:** the wording "while guest enrolments exist" of A113(2), for Disqualified rows.
- **Where implemented:** S10m (code, unchanged); the S10q diagnostic test is rewritten in S10x

### A145 — The eight behaviours pinned by the S10q tests are accepted

- **Date:** 2026-11-10 · **Status:** decided
- **Decision:** the behaviours the S10q tests pin where earlier rows were silent stand as built:
  1. A110: when the only owner of a picked character is deleted before the tournament completes, on a side of two or more, nobody is credited the played stat.
  2. A110: a player who abandoned the match and owns the character is still credited.
  3. A112: a guest that still has a second identity is not deleted at sign-in, so its tournament entry stays with the guest.
  4. A113(4): such a guest seated in a live game is not refused the sign-in.
  5. A113(1): the minimum rating is gated by the number alone. There is no separate on/off switch: an empty value and 0 both mean no minimum, are stored the same way (unset), and force nothing.
  6. A115(4): rating rows written at the same instant list the higher id first.
  7. A124: the scheduled identity clean-up deleting a guest who organizes a tournament does not cancel it.
  8. A124: a guest organizer signing in to an existing account does not cancel it.
  Items 3, 4, 7 and 8 need a state the module never creates (a guest with a second identity; a guest organizer); their tests stay as tripwires.
- **Why:** user, 2026-11-10, on item 5: "if we are turning on and off a boolean to allow minimum raiting, then 0 is redudant. If the number itself is the only gate to allow minimum raiting or not, then its fine being 0. The others I accept".
- **Where implemented:** no change (S10q tests)

### A146 — One wording for the away and abandoned refusals; "abandoned" when the player left the match

- **Decision:** a member who left the match for another lobby (membership abandoned) is refused with "You abandoned this match and can no longer act in it." A member who is only away (disconnected or stepped out, can still return) is refused with "You are away from this match. Return to it before acting." Every reducer uses these two texts; the separate wordings in concede / defer are removed. The away wording is the orchestrator's choice, shown to the user before the step.
- **Why:** user, 2026-11-10, after the two wordings were reported: "would prefer the word abandoned if they actually left the match".
- **Where implemented:** S10y

### A147 — The rejoin refusal of an abandoned member also says "abandoned"

- **Decision:** `join_lobby` refuses a member whose row is abandoned with "You abandoned this match and cannot return." (before: "You left this match for another lobby and cannot return."). Extends A146 to the one text it left.
- **Why:** user, 2026-11-11, on the orchestrator's proposal of that text: "lets do that small change in wording you said".
- **Where implemented:** S10z

### A148 — Reserve time works: after the turn time, the acting team's turn is kept alive by its reserve

- **Decision:** each team has a reserve bank per game, starting at the lobby's `reserveBankSeconds`. Whenever a team is on the clock (ban, pick, nomination, and the team that must answer a bid, in Classic and Auction alike) and its turn time reaches 0, its reserve drains instead and the turn stays with that team. A turn ended by an action charges only the overtime (time used beyond the turn time) to the acting team's reserve; time left on the turn clock is not banked. The reserve is never refilled during a game. When the turn time and the acting team's reserve are both at 0, the expiry is accepted and the turn is auto-played as the lobby setting says (random character or EMPTY). A team with reserve 0 has only the turn time on each turn. A pause freezes both clocks. `reserveBankSeconds` 0 means no reserve (the behaviour before this row). The confirm window (A129) has no reserve. Reference for the behaviour: the beta draft at `D:\GitsWork\hsr_draft_nath` (`DraftingInterface.tsx`, `DraftTimer.tsx`).
- **Why:** user, 2026-11-11: "Reserve time is a feature that should work. ... If the reserve time reaches 0, it just means that for each turn, a team can only use the existing turn's timer to decide what to do. On a normal match, if the normal turn timer runs out, it will eat the reserve time to keep the current team's turn. If the reserve time is gone and the timer reachers 0 - and depending if we have pick random character or the empty character on - we will just auto play the turn for the team." On Auction the user chose "Everywhere a team is on the clock".
- **Where implemented:** S10aa

### A149 — An undo gives back the reserve the undone steps consumed

- **Decision:** after an undo, each team's reserve is what it was at the start of the turn the draft returns to, and that turn restarts with a full turn clock (as the beta draft does). Reserve consumed by the turn in progress when the undo was called is returned as well.
- **Why:** user, 2026-11-11, chose "Give it back" over "Spent stays spent".
- **Where implemented:** S10aa (payload fields go to maincloud with the S11 clear publish)

### A150 — A turn action is refused once no time is left, with 1 second of tolerance

- **Decision:** `pick_character`, `ban_character`, `nominate_character`, `place_bid` and `pass_bid` are refused when the turn time and the acting team's reserve are both exhausted and more than 1 second has passed since that moment. Within the 1 second the action is accepted and the reserve ends at 0. The expiry reducers keep their strict rule (refused before 0). A paused clock never refuses.
- **Why:** user, 2026-11-11, chose "Refuse with 1 s tolerance" (timer review F2: a pick 45 s after 0 was accepted).
- **Where implemented:** S10aa

### A151 — An automatic pause is lifted by hand, never by the reconnect itself

- **Decision:** when a dropped player returns, the automatic pause stays. The returned player or a referee resumes it with `resume_draft`. Supersedes the automatic lift of A92(7).
- **Why:** user, 2026-11-11, chose "Stay paused until resumed by hand" (timer review F5: a player returned with 1 second left and the clock ran at once).
- **Where implemented:** S10aa

### A152 — A manual pause has no time limit

- **Decision:** unchanged behaviour, now ruled: a manual pause ends only when the pauser or a referee resumes it.
- **Why:** user, 2026-11-11: "a manual pause never ends byu itself that's fine i think, there is no global pause timer anyway".
- **Where implemented:** no change

### A153 — An automatic pause is resumed by the dropped player's own team or a referee, not by the opponent

- **Decision:** `resume_draft` on an automatic pause is accepted from a referee and from a present seated player of the team whose player's absence caused the pause (the returned player included). A seated player of the other team is refused. Narrows A85(2); the manual-pause rule (pauser or referee) is unchanged. No second automatic pause is armed after such a resume (unchanged).
- **Why:** user, 2026-11-11, on the orchestrator's recommendation to restrict it to "the returned player, their team and the referee" because an opponent could restart the clock while the dropped player was still away and drain that team's turn and reserve: "on point 1 i agree on your recommendation".
- **Where implemented:** S10aa (fix pass)

### A154 — A pause taken after all time is gone stays allowed

- **Decision:** a pause on a turn whose turn time and reserve are both spent is accepted and freezes 1 ms; after the resume the 1 second tolerance of A150 counts again. Accepted as is: the gain is about 1 second per pause (3 pauses per team, 10 seconds apart), it exists only until any client calls the expiry, and a pause taken with 1 second left gives the same result. Pauses in general are unchanged: a team may pause on its own turn.
- **Why:** user, 2026-11-11: "on point 2, just keep it tbh" (S10aa review F1 describes the case).
- **Where implemented:** no change (pinned by a test in S10aa)

### A155 — On an automatic pause, a referee seated on the other team counts as a player

- **Decision:** `resume_draft` on an automatic pause is refused for a caller seated as a player on the team that does not own the pause, even when that caller holds the referee flag (for example after the 15 s check moved the flag to them). A referee who is not seated on the other team (spectator, coach seat, or a player of the paused team) resumes as before. The flag holder's other powers and the forfeit rules are unchanged: in a lobby without a separate referee the waiting player still claims the forfeit after the grace. Completes A153.
- **Why:** user, 2026-11-11. The second S10aa review showed that in a 1v1 hosted by a player the opponent received the referee flag and could resume. The orchestrator recommended option (b); the user asked "for option 1 B, what if the opponent never comes back? will the other person still be able to call a forfeit in their favor?", was shown that the forfeit claim is untouched, and answered the proposed rulings 1(b) and 2(a) with "yeah lets just keep 2 with option A".
- **Where implemented:** S10ab

### A156 — The pause nobody online can lift is accepted

- **Decision:** when every member was offline at the moment of the referee's own check, the paused team is absent and a separate referee with exclusive concede rights stays offline, a returning opponent cannot resume, claim or close. Accepted: the match was left by everyone; the referee, a player of the paused team, staff or the lobby clean-up ends it.
- **Why:** user, 2026-11-11: "well for the option 2, isnt that everyone drops? because if they are offline... that means they disconnected from the match" and "yeah lets just keep 2 with option A".
- **Where implemented:** no change

### A157 — Calendar: the backend follows the calendar mockup; the user accepted the review's recommendations

- **Decision:** rulings on `notes/audit-2026-11-09/calendar-review.md` (2026-11-11), each as the orchestrator recommended it unless marked:
  1. **Blocked slots.** An availability slot has a kind, Available or Blocked. Both availability views carry it. An event whose time overlaps one of the organizer's own Blocked slots is refused (the mockup's "Events can't overlap a blocked slot"; making it a server rule for the organizer's own slots is the orchestrator's reading).
  2. **Cap.** At most 10 availability slots per week per user; a slot counts in the week its start falls in (weeks start Monday 00:00 UTC, the server stores no user time zone: orchestrator's reading). Ended slots do not count. The old total of 10 and the 7-day count of ended slots are gone; the 6-month window stays.
  3. **Recurrence is removed**: the recurrence columns, arguments and rules go; every slot is one dated interval. With it the question of recurrence across daylight saving is closed.
  4. **Reschedule.** Changing an event's start or end sets every invite of that event back to Pending.
  5. **Attendee list.** An invitee of a personal event sees all invites of that event with their answers. For a tournament match event of an anonymous tournament the list stays with the organizer and staff.
  6. **Saved players' events.** A saver receives a saved player's events as busy blocks: start and end only, no title, no notes.
  7. **Guests and users pending deletion** cannot be saved or invited.
  8. **Leaving.** An invitee may remove their own invite; the event then stops arriving. A Declined invite keeps the event arriving so the answer can change, but without the notes (orchestrator's refinement of "stop sending declined events", because the mockup lets an answer change; told to the user).
  9. **Past dates.** Creating a slot or an event with a start in the past is refused; so is moving one to a past start. Supersedes the end-only check of A79(3).
  10. **Old rows.** The existing scheduled clean-up also removes ended slots and expired events of users who do not return, in bounded batches.
  11. **Input checks (bugs B1, B6).** Every time argument is parsed by one validator (digits only, a sane range, `SenderError` on anything else); a slot lasts at most 24 hours and an event at most 7 days (orchestrator's bounds); an event starts at most 12 months ahead; the title limit counts characters, not UTF-16 units.
  12. **From the mockup, included by the orchestrator and told to the user:** event and invite rows carry the avatar character name next to each label; `update_calendar_event` accepts the full invitee set so one save is one call; a tournament match event writes its start to the bracket match's `scheduledAt` and clears it when the event is deleted.
- **Why:** user, 2026-11-11: "for calendar, as recommended and recurrance can go".
- **Where implemented:** S10ac (schema changes reach maincloud with the S11 clear publish)

### A158 — S11 is split: the live publish to test1 comes before the frontend, the page checks stay at the end

- **Decision:** S11a (carried schema work and fixes, wipe of test1, publish, bootstrap, seed, generate, live tests once) runs right after the calendar step, so the frontend connects to a real database from M6 on. S11b (the two-tabs checks and anything that needs pages) stays after M10. Every gate of S11 is unchanged: the wipe, each publish and the live test run need the user's approval at that moment.
- **Why:** user, 2026-11-11, on the orchestrator's recommendation (test1 still holds the old project's module; a first live connection eight steps later would bring every surprise at once): "lets do the split".
- **Where implemented:** ROADMAP.md

### A159 — The `uat` skill and the UAT format are retired

- **Decision:** the `uat` skill folder and section 10 of `CLAUDE.md` are removed. Kept: the test and contract rules of `CLAUDE.md` sections 6 and 7; the contract template, now `docs/contract-template.md`; the post-publish, harness-limit and guided walk-through notes, now in `test/README.md`.
- **Why:** user, 2026-11-11: "i feel like we have deviated from that workflow" and "retire what we dont need from uat skill and its sections on claude.md (what we won't use)". The manual session was not used in the migration; in-memory tests and independent reviews replaced it.
- **Where implemented:** CLAUDE.md, `test/README.md`, `docs/contract-template.md`

### A160 — Calendar: rulings on the S10ac review

- **Decision:** on the rule questions of `notes/audit-2026-11-09/s10ac-review.md`:
  1. **Weekly cap (Q1).** 10 Available slots and 10 Blocked slots per user per UTC week, counted separately. A slot that has ended still counts in its week, so the cap bounds the rows. Replaces the shared cap of A157(2).
  2. **Leaving a match event (Q2).** Unchanged: a team member or stand-in keeps seeing their match event.
  3. **Blocked slot onto an event (Q3).** Creating, moving or switching a slot to Blocked is refused when it overlaps an event the user organizes that has not ended; the same rule in both directions as A157(1). Tournament match events stay exempt.
  4. **Guests in match events (Q4).** Unchanged: guests are invited automatically and cannot answer. New: once an event has ended, its invites that are still Pending are removed, for every invitee, so no dead rows stay.
  5. **Attendee list (Q5).** The full list of an event's invites goes to an invitee only while the event has not ended.
  6. **Bracket time (Q6).** When retention (the lazy clean-up or the weekly sweep) removes an old match event, the bracket match keeps its `scheduledAt`. A deletion or move by a person, and a cascade from the bracket, still clear or move it.
  7. **Targets (Q7).** An organizer cannot invite themselves; the SYSTEM user cannot be invited or saved.
  8. **Week (Q8).** The week stays UTC.
  Also: a title must contain at least one visible character.
- **Why:** user, 2026-11-11: "everything else is good"; on Q1 "keep 10 slots for available and 10 slots for blocked"; on Q4 "we can keep it as is, is there a way to clear that pending invite anyway so we dont keep dead rows? like if the event time has ended, then pending invites should be cleared"; on Q6 "yeah we can leave it" (the orchestrator's recommendation to leave the time in the bracket).
- **Where implemented:** S10ad

### A161 — Calendar: the attendee list loads per opened event; pending invites go 7 days after the end

- **Decision:** on the S10ad review (`notes/audit-2026-11-09/s10ad-review.md`):
  1. **Attendee list.** A view cannot read the clock, so A160(5) is not built. Instead a view with an argument returns the invites of one event, and the page subscribes it only for the event that is open. Who may read it follows A157(5): the event's organizer; an invitee of a personal event; for a match event every invitee unless the tournament is anonymous, then only holders of the bracket permission. Holders of the bracket permission may read a match event's list also without an invite (orchestrator's addition: they may edit it; review L8). `view_my_calendar_invites` no longer sends an invitee the other invitees' rows: an invitee gets their own row, the organizer gets all rows of their events. Consequence accepted by the user: tiles of events one is invited to show the organizer's avatar only. Replaces the delivery of A157(5) and A160(5).
  2. **Pending invites** of an ended event are removed 7 days after its end, not at the end, so an event or match moved to a later time within a week keeps everyone. Replaces the timing of A160(4).
  3. **Bracket time.** A bracket cascade (staff resolve, rollback, cancel, disqualification, regeneration) clears a match's `scheduledAt` whether or not its calendar event still exists (review F1; A160(6) already said a cascade clears it).
  4. Accepted as is: moving a running event's end resets the answers (A157(4)), which are then removed with the rule above; received invites have no cap per user.
- **Why:** user, 2026-11-11. On loading the attendee list on the page side: "yeah lets try C". After the review showed that a filtered subscription on the existing view is unproven on this version and that a small view with an argument gives the same result, and on the 7 days: "i agree wit hyour recomendations here".
- **Where implemented:** S10ad

### A162 — Calendar: rulings on the second S10ad review

- **Decision:**
  1. For a tournament match event, the event's organizer reads the attendee list and may edit the event only while holding the bracket permission of that tournament; a creator who is no longer staff has no more rights on it than any other user in their position.
  2. Moving an event more than 7 days after its end stays allowed; unanswered invitees may already have been removed (documented).
  3. An Admin reads the attendee list of every event.
  4. Unchanged: a team member without an invite row does not read their match event's attendee list.
- **Why:** user, 2026-11-11, on the orchestrator's recommendations (1(b), 2(a), 3(b), 4(a)): "I agree with your recomendations".
- **Where implemented:** S11a

### A163 — S11a rulings before the first publish

- **Decision:** on the open questions of `notes/audit-2026-11-09/s11a-review.md`:
  1. **Leaderboard and deleted users.** When a user is deleted (own request, ban, staff or server deletion), the leaderboard of the active season is rebuilt without them and their rows of past seasons are deleted. No name or avatar of a deleted account stays on the public leaderboard.
  2. **Match events of former staff.** When a user loses the bracket permission of a tournament (assistant removed, the bracket flag turned off, a Moderator demoted), the match events of that tournament they organize are handed to the tournament organizer.
  3. **Maintenance mode.** While it is on, an Admin can connect and work; every other user is refused, and a non-Admin who is still connected cannot change anything.
  4. **Lobby passwords.** No limit on guesses. A password holds only the characters A to Z, a to z and 0 to 9 and is at most 20 characters long. Replaces the 64-character cap of S11a part 2; the stored value stays a salted hash.
  5. The unused generated file `web/src/module_bindings/cost_set_table.ts` is deleted.
  6. The module is published to test1 with the scheduler guard in place; the first live check is one scheduled run. If the live scheduler is refused, the guard is emptied and the module republished without a wipe.
- **Why:** user, 2026-11-12: "I agree on your 6 recomendations but one thing to add, we dont need a limit on lobby password guess. Password should have a character limit that only accepts alphanumerical characters and the limit should be 20 characters".
- **Where implemented:** S11a

### A164 — Confirmations after S11a; target browsers

- **Decision:**
  1. The hand-over of match events (A163(2)) also applies to Completed and Cancelled tournaments, as built.
  2. During maintenance `broadcast_cursor` from a non-Admin is dropped silently, as built; every other reducer answers with the maintenance text.
  3. Target browsers: current Chromium browsers and current Firefox first. Safari is not a focus now and is handled later. The browser support policy in the `web-guidance` skill follows this; no polyfill or new dependency without approval.
- **Why:** user, 2026-11-12: "old tournament events can also be dropped manually by the creator or whoever is in there to free up slots so that's fine. for choise 2, i agree, for choise 3, I want it to work on Chromium, Firefox first and we worry about safari later but that's not my main focus."
- **Where implemented:** no code change; `.claude/skills/web-guidance/SKILL.md`

### A165 — SpacetimeDB upgraded to 2.15.0

- **Decision:** the module package `spacetimedb` and the CLI move from 2.14.1 to 2.15.0 (exact pin). None of the new optional module packages of 2.15 (Agents, Auth, Files, PostHog) is adopted; the Auth package would reopen A46 and is not taken.
- **Why:** user, 2026-11-12, before the frontend work: "spacetime db 2.15 is out i would like to upgrate to it".
- **Where implemented:** `docs/log/2026-11-12-sdk-2-15.md`

### A166 — Frontend package versions: newest that does not break us

- **Date:** 2026-11-12 · **Status:** decided
- **Decision:** Frontend packages are installed at the newest version that does not break the project, still as exact pins. For M3 this gave `vite` 8.3.8 and `@vitejs/plugin-react` 6.3.0 in place of the plan's 8.3.6 and 6.2.1. React stays on 18.3.1 (A49 D-M7 stands). Orchestrator's own choices in M3, told to the user: the two React type packages (`@types/react` 18.3.31, `@types/react-dom` 18.3.7) were added because TypeScript needs them; M3 opens no database connection (the roadmap puts the connection at M6, the old plan's "logs the identity hex" check moves there); a build without `VITE_STDB_TARGET` fails instead of shipping a page that throws; mockup defects found by the review (overlaps on narrow and short screens, a doubled separator, a mid-word break) are fixed in this repo; the 404 page shows its placeholder image at 10% over the void colour until real artwork exists; token names `--radius-panel` and `--radius-modal` for the 12px and 16px radii of `DESIGN.md` 11.3.
- **Why:** user, 2026-11-12: "just use the latest versions of anything that is not going to break us".
- **Where implemented:** M3, `docs/log/2026-11-12-m3.md`

### A167 — 404 pages use the standby artwork; the wording names what is missing

- **Date:** 2026-11-12 · **Status:** decided
- **Decision:** Every not-found page shows the standby artwork, presented as on the standby page. Only the wording changes with what is missing ("Page not found.", later a lobby, a tournament and so on). The dimmed placeholder treatment of A166 is removed; `web/public/not-found-image.webp` is no longer referenced. Orchestrator's choice: one optional `what` prop on `NotFoundPage` (default "Page"), no list of kinds ahead of the pages that need them.
- **Why:** user, 2026-11-12: "the stand by image should be used for the 404 pages, we just change the wording depending on what is missing".
- **Supersedes:** the 404 placeholder treatment in A166.
- **Where implemented:** M3 follow-up, `web/src/pages/not-found/NotFoundPage.tsx`, `docs/frontend/pages.md`

### A168 — Splash pages: darker top band and brighter site name

- **Date:** 2026-11-12 · **Status:** decided
- **Decision:** On the splash pages (standby, not found) the artwork gets a dark band at the top edge (58% void colour over the top 48px, gone by 120px) and the site name in the top bar uses the body text colour with the label text shadow. Chosen from A/B screenshots. The art below the top bar is unchanged. The eyebrow line over the art stays as the mockup has it (below 4.5:1 in the worst case) and is open.
- **Why:** user, 2026-11-12, on the orchestrator's recommendation of option B: "I like your recommendation, lets keep that".
- **Where implemented:** `web/src/components/SplashLayout/SplashLayout.module.css`, `docs/frontend/pages.md`

### A169 — Routes: straight 404, a no-access page, plain-text addresses

- **Date:** 2026-11-12 · **Status:** decided
- **Decision:**
  1. An unknown address under a guarded area (for example `/admin/zzz`) shows the 404 page at once for everyone, without the sign-in redirect.
  2. A signed-in user below Moderator who opens `/admin` sees a no-access page at the same address instead of returning silently to `/`. A visitor is still sent to sign in. Orchestrator's choices: wording "Access denied." with "This area is for IPC staff. If you think this is a mistake, contact an admin.", on the standby artwork like the 404 page (A167).
  3. Search parameters are written as plain text in the address bar, never in the router's JSON style. A list repeats its key (`?el=fire&el=ice`). Pages convert text to numbers in their own validators.
- **Why:** user, 2026-11-12: "straight 404 for 1. For 2, a no access page, for 3, explain more to me", then, after the explanation with examples: "i like the plain text persion".
- **Where implemented:** M4 follow-up: `web/src/router.tsx`, `web/src/auth/StaffOutlet.tsx`, `web/src/pages/no-access/`, `web/src/lib/searchParams.ts`, `docs/frontend/pages.md`

### A170 — CI scope, import pattern, footer icons

- **Date:** 2026-11-13 · **Status:** decided
- **Decision:**
  1. CI (`.github/workflows/ci.yml`) is a signal only: no branch protection, no required checks. It lints the frontend and shared code now (`lint:ci`: `web/`, `shared/`, `scripts/ci/`); the old findings in the module, scripts and older tests are cleaned later (S12), one section at a time. CI holds no secret and never touches a database, the live suite, a deploy or a publish.
  2. Standalone SVG files stay out of the lint; their accessibility is handled, and linted, in the code that uses them.
  3. Import pattern: one named alias per section. `./file` inside a folder; across folders `@/` in `web/` only and `@module/` in the module; `@shared/` and `@bindings/` from anywhere; no `../../` chains across folders. The generated bindings are never rewritten by hand. The live tests' leftover `@/src/module_bindings` alias is replaced by `@bindings/` now; the module's parent-relative imports move to `@module/` at S12.
  4. Footer "built with" icons are SpacetimeDB, TypeScript and React; the Next.js icon is removed and a React icon supplied by the user is added.
- **Why:** user, 2026-11-13: "i agree on your recomendations for CI"; "agree on the linter part"; "as long as we are not rewriting the auto generative code that spacetime db does, i'm okay with your suggestions for a cleaner import pattern"; "we could use the footer icons in our site, we use spacetimedb, typescript and react only so the next js icon is not needed".
- **Where implemented:** M9, `docs/log/2026-11-13-m9.md`, `CLAUDE.md` sections 1, 4, 5, 6

### A171 — M6 follow-ups: maintenance message, first download, dev guard, cost tables

- **Date:** 2026-11-13 · **Status:** decided
- **Decision:**
  1. Maintenance: the offline splash stays for now (the server drops a refused socket without a reason, so the browser cannot tell maintenance from an outage). A static status file that the site reads before connecting is planned at M7; it shows the maintenance message and stops the retries without database energy. B-8 (maintenance refuses non-Admin connections) stands.
  2. First download size: loading the connection after the first paint is planned for the app shell step, measured against the real landing page.
  3. Dev mode refuses to start against the prod target ("Dev mode cannot run against the prod database. Set VITE_STDB_TARGET=test."). A production build with the prod target is unaffected.
  4. Cost tables in the reference set: the default cost set plus a lobby's own set; the final decision is taken when the costs page is ported. No code now.
- **Why:** user, 2026-11-13, on the orchestrator's four recommendations after the M6 review: "i agree with your recommendation".
- **Where implemented:** `web/src/stdb/assertDevTarget.ts`, `web/vite.config.ts`, `docs/frontend/pages.md`; items 1, 2 and 4 at M7, the app shell step and the costs page

### A172 — M7: hosting config and the maintenance status file

- **Date:** 2026-11-13 · **Status:** implemented; the items marked "orchestrator" await the user's ruling
- **Decision:**
  1. M7 goes ahead as proposed (hosting config, security headers, robots file, maintenance status file, deploy ignore list). Nothing is deployed.
  2. Orchestrator: `robots.txt` disallows `/lobby/`, `/admin`, `/api/` (plan Appendix A) and also `/profile`, `/calendar`, `/tournaments`; the rest is indexable.
  3. Orchestrator: `web/public/status.json` ships as `{ "maintenance": false }`; CI (`check:patterns` gate 9) is red while it says `true`, so switching maintenance on is a deliberate deploy. Order: deploy the file, check the splash, then switch the module; the reverse when ending.
  4. Orchestrator: `?maintenance=skip` makes a tab ignore the status file so an Admin can get in; the module still refuses everyone else (B-8).
  5. Orchestrator: status re-reads never closer than 30 s without a click, every 60 s during an outage, 30 s after a drop for a reconnecting tab, none while the tab is hidden; Retry reads at once on both splashes.
  6. Orchestrator: the SDK provider sits beside the app (so the status answer never remounts it). Pages use `useStdbConnection` and the hooks in `web/src/stdb/`, not the SDK's own React hooks. To be ruled on before the first page calls a reducer.
  7. The `functions` block of `vercel.json` waits for M5; `'unsafe-eval'` stays in `script-src` (required by the SDK, proven).
- **Why:** user, 2026-11-13, on the orchestrator's M7 outline: "lets go with it then". Items 2 to 6 were chosen by the orchestrator during the step and reported to the user.
- **Where implemented:** `vercel.json`, `.vercelignore`, `web/public/{robots.txt,status.json}`, `web/src/stdb/{statusFile.ts,MaintenanceGate.tsx,StdbProvider.tsx}`, `scripts/ci/check-patterns.mjs`, `docs/frontend/hosting.md`, `docs/log/2026-11-13-m7.md`

### A173 — Pages use the repo's own connection hooks

- **Date:** 2026-11-13 · **Status:** decided
- **Decision:** Pages reach the database through the hooks in `web/src/stdb/` (`useStdbConnection`, `useRouteSubscriptions`, the reference set), not through the SDK's `useTable` / `useReducer`. The SDK's subscriptions, local cache and generated bindings are used untouched, so live updates work the same way. Two small hooks are built with the first page that needs them: one that reads a route's rows into React, and one reducer-call wrapper that refuses at once when there is no connection (no silent queue).
- **Why:** user, 2026-11-13, after the comparison with code examples and the explanation of live updates and route leave: "okay this makes sense". Confirms A172 item 6. A172 items 2 to 5 still await a ruling.
- **Where implemented:** `web/src/stdb/`; the two new hooks at the first page port

### A174 — Vercel is production only; the preview is local

- **Date:** 2026-11-13 · **Status:** decided
- **Decision:**
  1. The project plans as if the Vercel free tier gives no preview: every Vercel deploy is treated as a production deploy. The preview is a localhost server of the built app against the test database (`npm run preview`, M8).
  2. Env scheme change: on Vercel `VITE_STDB_TARGET` is `prod` only; `test` lives on localhost (`.env.development`, `npm run preview`). `vite preview` is refused (orchestrator's addition after review: it would serve any target).
  3. The login function (M5) is tested on localhost, not on a Vercel address.
  4. Open, orchestrator's recommendation, not yet ruled on: a first real Vercel deploy as a maintenance smoke test (status file on, no database reached) before launch, to prove the hosting rules on real Vercel. It needs the user's login and deploy approval.
  5. Noted: the pricing page (read 2026-11-13) neither confirms nor denies previews on Hobby; it does say password protection is not available, so any deploy has a public address.
- **Why:** user, 2026-11-13: "right now vercel free tier has no previews, so everything will go to prod, our preview will have to be a localhost server of the app"; then "okay lets go with m8 now then".
- **Supersedes:** the "Vercel Preview = test" part of the env scheme (M2) and the preview deploy of M8 in the migration plan.
- **Where implemented:** `scripts/preview/`, `web/vite.config.ts`, `docs/frontend/hosting.md`, `CLAUDE.md` section 5, `docs/log/2026-11-13-m8.md`

### A175 — M5: login on localhost, one Discord application, link-code rules

- **Date:** 2026-11-13 · **Status:** items 1 to 3 decided; items 4 to 7 implemented as the orchestrator's choices; items 8 to 10 open
- **Decision:**
  1. The login functions run locally through the repo's own dev and preview servers; no `vercel dev`, no Vercel account for testing.
  2. One Discord application serves test and prod; a localhost redirect address is added to it. Consequence noted to the user: the Discord client secret in `.env.test.local` is also the live one; the signing secret and the server token still differ per environment.
  3. `.env.example` is reworked inside M5 (Vercel is prod only; test login values live in `.env.test.local`; which keys bootstrap writes and which the user pastes).
  4. Orchestrator: the link code's secrecy comes from a browser nonce (`request_link_code({ clientNonce })`, 32 CSPRNG bytes), because the host seeds `ctx.random` from the transaction time.
  5. Orchestrator: a refused merge for a live code throws its own text (ban, game in progress, account changed) and the code stays valid until it expires; unknown, used and expired codes share one text.
  6. Orchestrator: `server_link_provider` (identity argument) stays for tests and the live harness; the auth function only calls `server_link_by_code`.
  7. Orchestrator: on the by-code path a Discord id must be 17 to 20 digits; provider names lose control characters and are cut on a code point boundary.
  8. Open: an optional second lock (the browser that finished Discord holds a one-time token the requesting identity must present; two more columns on `link_request`). Orchestrator recommends it, before the first prod publish.
  9. Open: a code requested before maintenance still links during it. Orchestrator recommends leaving it.
  10. Open: with guest creation switched off, a new browser cannot sign in (A109 accepted this for the old flow). Orchestrator recommends leaving it for now and revisiting before launch.
- **Why:** user, 2026-11-13: "i agree with #1 and #2, but what about #3? you mean create a new discord application for test? i would prefer not"; "okay add the .env.example rework there". Items 4 to 7 came out of the build and its review and were reported to the user.
- **Where implemented:** `spacetimedb/src/helpers/identity/{linkCode,providerLink}.ts`, `spacetimedb/src/reducers/identity/{auth,server}.ts`, `spacetimedb/src/views/identityViews.ts`, `docs/auth/architecture.md`, `docs/log/2026-11-13-m5a.md`; items 1 to 3 at M5b

### A176 — The second lock on sign-in (two-step link)

- **Date:** 2026-11-13 · **Status:** item 1 decided and implemented; items 2 to 4 open
- **Decision:**
  1. Sign-in by code takes two steps in the module. The auth function presents the code after Discord confirmed the user (`server_link_by_code`, which now only stores a pending link and the hash of a one-time token, with a 2-minute window). The requesting identity then confirms with the token (`confirm_link`); only then is the merge applied. Four optional columns were appended to `link_request` (A175 item 8 spoke of two). A link can no longer complete during maintenance, which settles A175 item 9. Orchestrator's choices: the 2-minute window, no attempt counter, a new request drops a pending one, the view shows the pending Discord name but never the id or the hash and hides rows the caller can no longer use.
  2. Open (review finding, older than this step): the server token the auth function would hold is an Admin-level credential (direct link through `server_link_provider`, `server_set_role`, the SYSTEM mapping). Orchestrator recommends a narrow server identity for the function that can only present a code, and switching `server_link_provider` off outside the test database.
  3. Open: signing in to an account whose deletion is pending succeeds (unchanged old behaviour; a ban is refused).
  4. Open: A175 item 10 (guest-creation switch blocks new-browser sign-ins).
- **Why:** user, 2026-11-13, after the explanation of the attack and the two locks: "alright lets do it".
- **Where implemented:** `spacetimedb/src/tables/identity/linkRequest.ts`, `spacetimedb/src/helpers/identity/{linkCode,providerLink}.ts`, `spacetimedb/src/reducers/identity/{auth,server}.ts`, `spacetimedb/src/views/identityViews.ts`, `docs/auth/architecture.md` ("Phase M5a2 execution", "Requirements for M5b")

### A177 — The login function gets a narrow key; the old direct link is removed

- **Date:** 2026-11-13 · **Status:** items 1 to 4 decided and implemented; item 5 open
- **Decision:**
  1. The auth function holds a narrow server identity, a "linker", that can only present a sign-in code (`linker_present_code`, renamed from `server_link_by_code`; Owner and Delegate are refused there). Its key is `STDB_LINK_TOKEN`; the Admin-level `STDB_SERVER_TOKEN` stays with the scripts and never goes to Vercel. Settles A176 item 2.
  2. The old direct link `server_link_provider` is removed. Tests and the live harness sign in through the three real steps. Supersedes A175 item 6. Test files were edited under the test task this ruling approved; expectations changed only where they pinned the removed reducer's surface or a path that no longer exists (a second sign-in on a linked account is now refused).
  3. Signing in to an account whose deletion is pending is left as it is (the deletion job runs 5 seconds after it is scheduled). Settles A176 item 3.
  4. The guest-creation switch blocking sign-in from a new browser is left for now. Settles A175 item 10 and A176 item 4 until launch preparation.
  5. Open (review finding, corrected by the orchestrator after first describing the narrow key as a larger reduction than it is): a holder of the link token can still sign in as any Discord-linked account, staff included, by presenting its own guest's code with that account's Discord id. The narrow key removed the direct powers only. Orchestrator recommends accepting this for test1 and adding new-device approval for staff accounts before the first prod publish.
  6. Orchestrator's choice: bootstrap keeps the existing linker across runs and mints a new one only when none exists or with `--rotate-linker`, so a re-run cannot break a deployed function.
- **Why:** user, 2026-11-13: "For #1 I agree, for #2 the account will be deleted anyway so it doesnt really matter if they sign back ... For #4, yeah leave it for now"; "yeah lets just use the new way, the old sign in does not need to stay".
- **Where implemented:** `spacetimedb/src/helpers/identity/serverIdentities.ts`, `spacetimedb/src/reducers/identity/{auth,server}.ts`, `scripts/stdb/{bootstrap,_delegate,_env}.ts`, `shared/stdb-targets.ts`, the test fixtures, `docs/auth/architecture.md`, `docs/log/2026-11-13-m5a.md`
