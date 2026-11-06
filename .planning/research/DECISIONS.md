# v0.9 Milestone Planning Decisions

**Project:** HSR PVP — v0.9 Frontend Milestone
**Defined:** 2026-04-12 during milestone kickoff discussion
**Consumer:** Roadmapper, phase planners, execution agents

## Purpose

This file captures decisions made **during v0.9 milestone planning** that refine, supersede, or extend the architectural guidance in `notes/v09-frontend-subscription-strategy.md`. The notes remain the source-of-truth architectural document; this file records what changed or was added during the milestone-kickoff conversation.

**Precedence:** When this file conflicts with the notes, this file wins. When the notes cover something not discussed here, the notes apply unchanged.

---

## R1 — 27-phase structure with data/UX split

**Context:** Original notes proposed 7 phases. Expanded after discussion on phase granularity and build discipline.

**Decision:**
- **27 core phases, numbered 15–41** (continuing from v0.5 which ended at Phase 14).
- **Foundation phases (3):** 15 (backend pre-work), 16 (route + global foundation), 21 (authed base layer).
- **Feature phases split into data + UX pairs.** Each feature gets two phases — data/subscription wiring first, then heavy frontend UX work. Exception: Match Replay (40–41) and Historical (combined where reuse warrants).
- **Rationale:** Data phase proves the flow + establishes subscription placement; UX phase focuses exclusively on design, interactions, and polish without fighting data plumbing.

**Phase order (priority honored):**

| # | Phase | Type |
|---|-------|------|
| 15 | Backend pre-work (Spine columns + self-scoped historical views) | — |
| 16 | Route + global foundation | — |
| 17 | Cost tables — data | Data |
| 18 | Cost tables — UX | UX |
| 19 | Team builder — data | Data |
| 20 | Team builder — UX | UX |
| 21 | Authed base layer | — |
| 22 | Admin panel — data | Data |
| 23 | Admin panel — UX | UX |
| 24 | Profile (core) — data | Data |
| 25 | Profile (core) — UX | UX |
| 26 | Calendar — data | Data |
| 27 | Calendar — UX | UX |
| 28 | Lobby — data | Data |
| 29 | Lobby — UX | UX |
| 30 | Match Drafting — data | Data |
| 31 | Match Drafting — UX (pedestal) | UX |
| 32 | Match Post-Drafting — data | Data |
| 33 | Match Post-Drafting — UX | UX |
| 34 | Tournament — data | Data |
| 35 | Tournament — UX | UX |
| 36 | Leaderboards — data | Data |
| 37 | Leaderboards — UX + polish | UX |
| 38 | User & character stats — data | Data |
| 39 | User & character stats — UX | UX |
| 40 | Historical + replay — data | Data |
| 41 | Historical + replay — UX | UX |

**Tail priority:** Tournament → Leaderboards → User/character stats (second-to-last) → Historical + replay (last). Stats and history accessed through profile but deferred because they are not core loop.

---

## R2 — No Web Worker in v0.9

**Context:** Original notes included a Web Worker in Decision 2 for background Spine asset prefetch.

**Decision:** **Drop the Web Worker entirely for v0.9.** Service Worker stays (asset caching via fetch interception). Prefetch runs on main thread.

**Implementation:**
```ts
// lib/spine-prefetch.ts
export function prefetchSpineAssets(urls: string[]) {
  urls.forEach((url) => {
    requestIdleCallback(() => {
      fetch(url, { priority: 'low' }).catch(() => {});
    });
  });
}
```
Fire-and-forget `fetch()` inside `requestIdleCallback`. Response body never parsed by main thread. Service Worker intercepts + caches. Near-zero main-thread cost.

**Rationale:**
- Asset prefetch doesn't parse bytes — just triggers fetches that SW caches
- No heavy main-thread computation in this project (SpacetimeDB handles compute server-side)
- BSATN decode offload is explicitly out of scope per notes
- Adding a WW now is speculative future-proofing with no concrete workload

**Reopen condition:** If Phase 31 (draft pedestal) or Phase 28 (match zone subs) shows measurable main-thread jank during subscription bursts or prefetch, a targeted WW addition is a single-file fix — not an architectural commitment.

**Supersedes:** Notes Decision 2 "Three-tier asset delivery via Service Worker + Web Worker" — now "via Service Worker" only.

---

## R3 — Minimal authed base subscription layer

**Context:** Original notes Decision 6 placed `user`, `hsr_account`, calendar, social, achievements, stats, `mmr_rating`, and `ban_record` subs at `(authed)/layout.tsx`.

**Decision:** `(authed)/layout.tsx` subscribes to **only** `user` and `hsr_account`. Every feature page owns its own subs (calendar on calendar page, achievements on profile, stats on stats page, etc.).

**Rationale:**
- Bandwidth: user viewing only profile shouldn't pay for calendar/social subs
- Matches user-expressed preference: "authed strategy should have a base layer to work with and then tune as we work on each feature"
- Aligns with notes' Architectural Priority #1 (bandwidth/egress first)

**Phase ownership:**
- Phase 21 (Authed base) wires minimal subs: `user`, `hsr_account`
- Each subsequent authed feature phase adds its own subs on its own page/layout
- Historical views remain profile-page-scoped (Decision 8 in notes unchanged)

**Supersedes:** Notes Decision 6 Authed row — scoped down to `user` + `hsr_account` only.

---

## R4 — Single-responsive-DOM default, dual-DOM on justification

**Context:** Original notes did not address mobile vs desktop DOM strategy. Discussion introduced hard constraint: **never render 2 DOMs unnecessarily or overload users**.

**Decision:** **Single responsive DOM is the default for every page.** Dual-DOM (sibling `.desktop.tsx` / `.mobile.tsx` via `<ViewportGate>` + `next/dynamic`) is used **only when mobile UX requires fundamentally different structure** — not mere resizing.

**Known dual-DOM pages (split from day one):**
- **Phase 31 Draft Pedestal** — stacked layout on mobile, pedestal resize, cursor-send disabled
- **Phase 35 Tournament brackets** — vertical round-swipe on mobile (horizontal shrink is anti-feature)
- **Phase 27 Calendar** — day-view default on mobile, week/month on desktop

**Default single-responsive pages:** cost tables, team builder, admin, profile, lobby, match post-drafting, leaderboards, stats, historical list, replay.

**XX.1 mobile phase convention (deferred, opportunistic):**
- Applied per UX phase as a decimal sibling (18.1, 20.1, 23.1, etc.)
- Three types:
  - **Promotion** (single → split): extract components, add sibling `.mobile.tsx`, add `<ViewportGate>`
  - **New mobile design** (already split, desktop-first shipped first)
  - **Mobile refinement** (polish pass)
- Inserted via `/gsd-insert-phase` when team decides
- v0.9 can ship desktop-complete with partial mobile coverage

**Rationale:**
- Bandwidth/performance: only one DOM in tree, unused chunk not downloaded
- Development velocity: desktop-first single-DOM is faster than forced dual-DOM
- Maintenance: fewer files, less duplication, when responsive works
- Promotion cost is bounded *if* component hygiene is maintained (see R8)

**New file/primitive requirement (Phase 16):**
- `<ViewportGate />` — dual-DOM consumer, `next/dynamic` imports `.desktop.tsx` / `.mobile.tsx` siblings
- `<ViewportWriter />` — ambient cookie writer (see R5)
- `lib/viewport/` — detection + cookie read/write helpers
- Pattern: page.tsx is thin `<ViewportGate>` wrapper; sibling files contain actual JSX

---

## R5 — Ambient viewport cookie writing

**Context:** Deep-link arrivals (shared lobby URL, tournament bracket link) bypass any "landing page sets the cookie" pattern.

**Decision:** **Every page renders `<ViewportWriter />` on mount.** This component writes the `vp=desktop|mobile` cookie based on `matchMedia('(pointer: coarse) and (hover: none)')` + `window.innerWidth`. Cookie: 1-year, `SameSite=Lax`.

**SSR resolution order (Server Components):**
1. Read `vp` cookie (authoritative if set)
2. Fall back to `userAgent()` from `next/server` (educated guess for first-ever visits)
3. Fall back to desktop default (last resort)

**Effect:**
- New user lands on `/` → cookie set on mount → all subsequent SSRs correct
- Deep-link new user lands on `/draft/[id]` → SSR uses UA guess → client writes cookie → next navigation perfect
- Returning user → cookie already set → perfect SSR on first byte

**Phase ownership:** Phase 16 implements `<ViewportWriter />`, root-layout integration, SSR cookie reader, `userAgent()` fallback.

---

## R6 — Landing page as single responsive DOM

**Context:** Whether landing page needs dual-DOM treatment or can stay unified.

**Decision:** Landing (`/`) is a **single unified responsive DOM**. Tailwind breakpoints on a single tree — not hidden subtrees via `display:none`.

**Rule:** No hidden-on-mobile subtrees on the landing page. If a section needs to differ substantially on mobile, reorganize the markup to handle both widths naturally (flex direction changes, grid collapse, etc.).

**SEO justification:** Landing is the only SEO-critical surface. Unified HTML avoids duplicate content risk and keeps canonical URL clean.

**Phase 16 scope:** Audit existing `(landing-page)/` contents during rename to `(public)/`. Confirm no `hidden md:block` / `block md:hidden` toggle patterns. Refactor any such patterns to single-tree responsive design.

---

## R7 — Tournament brackets: fork `@g-loot/react-tournament-brackets`

**Context:** Research flagged this library as 5 years unmaintained. Discussion concluded consume-as-is is untenable.

**Decision:** **Fork day one in Phase 34** (Tournament — data). Strip aggressively.

**Strip list:**
- Remove `styled-components@5.x` dep → replace with Tailwind/CSS modules (drops hostile runtime CSS-in-JS, unblocks RSC)
- Remove `SVGViewer` → use our own pan/zoom (~30 LOC)
- Keep: core bracket-layout math (single + double elim positioning with winners/losers cross-link)
- Add: group-stage grid layout + hybrid composition for our formats

**Output:** ~600-800 LOC internal module at `lib/brackets/` (or `@hsrpvp/tournament-brackets` package). Published as part of this repo, not a separate npm package.

**Plan B (if fork becomes untenable during Phase 34):** Custom SVG + `d3-hierarchy` implementation (~500 LOC). Decision deferred to Phase 34 research flag.

**Rationale:**
- 5-year stall = dead upstream
- React 18→19 peer dep migration will require patching anyway
- `styled-components` is hostile to Server Components — needs removal to match our stack
- Backend already ships group/hybrid formats that the library doesn't support
- Fork bus-factor: we own it, we evolve it, we don't wait for upstream
- The tree-positioning math is the hard part; they've already debugged it

**Supersedes:** SUMMARY.md "MEDIUM maintenance confidence, Plan B is a custom d3 bracket" — now "MUST fork in Phase 34, Plan B is custom only if fork proves untenable".

---

## R8 — Component hygiene rules (enforcement mechanism for R4)

**Context:** R4 (single-DOM default, split on justification) only works cheaply if single → split promotion is mechanical. This requires component discipline.

**Decision:** Phase 16 establishes and documents these rules. Every subsequent UX phase enforces them. Violation blocks merge.

**Rules:**
1. **Page files are thin.** `page.tsx` composes layout components; does not contain dense markup.
2. **Components are viewport-agnostic.** No `useIsMobile()` / `useWindowWidth()` hooks inside child components. Layout decisions belong to the parent that composes them.
3. **Tailwind responsive utilities allowed for sizing/spacing** (padding, gap, text size, column count). **Not allowed for structural reorganization** (reordering sections, swapping grid vs stack, hiding major blocks). Structural changes require either a single responsive layout that works at all widths, OR a dual-DOM split.
4. **State lives in hooks, not pages.** `useCostTableData()`, `useTeamBuilderState()`, etc. Page files consume, don't own.
5. **Component data inputs are layout-agnostic.** `<CostRow data={...} onSelect={...} />` — not `<CostRow mobile={...} />`.

**Promotion cost if rules honored:** ~30–60 min per page + mobile UX design time.
**Promotion cost if rules violated:** 2+ hours of refactor before promotion.

**PR review hook:** Code reviewer checks for `useIsMobile()` / `window.innerWidth` inside non-page files. Flag as violation.

---

## R9 — Five Phase 16 pre-decisions locked

**Context:** Research surfaced 5 open integration items that every feature phase depends on. Consolidated here.

**Decisions:**

1. **`experimental.typedRoutes: true`** — enabled **before** Phase 16 starts route-group renames, so stale `<Link>` paths fail at build time during migration.
2. **Next.js bump to ≥15.2.3** — required for CVE-2025-29927 (middleware bypass) patch. Lands **before** middleware ships. Current `^15.0.0` range may resolve to vulnerable version.
3. **Pattern E (sibling `.desktop.tsx` / `.mobile.tsx` + `next/dynamic`)** — the committed dual-DOM implementation approach. Phase 16 builds `<ViewportGate />` primitive.
4. **Middleware matcher shape: positive path list** — explicit list of authed paths. Negative lookahead rejected as error-prone. Must exclude `/sw.js`, `_next/*`, API routes.
5. **SSR default on cookie-less first-ever visit: desktop** — then client-side detection + `<ViewportGate>` swap if wrong. `userAgent()` from `next/server` used as educated guess fallback before desktop default.

**Phase ownership:** Phase 16 resolves and implements all five. No feature phase re-litigates them.

---

## R11 — Team builder persistence promoted into v0.9 scope

**Context:** Original notes' "Out of scope for v0.9" section listed "Team builder draft persistence" as deferred. v0.5 backend did not include a `team_builder_draft` table or related reducers.

**Decision:** **Team builder persistence moves INTO v0.9 scope.** Backend table + reducers added during Phase 19 (Team builder — data). Anonymous users use localStorage (unchanged); authenticated users use backend.

**Backend work (Phase 19):**
- New table `team_builder_draft` keyed by `userId` with draft composition data (characters, lightcones, cost set, game mode, optional name)
- Reducers: `save_team_draft`, `update_team_draft`, `delete_team_draft`, `list_my_team_drafts` (or server-side view `view_my_team_drafts`)
- User-scoped access — only owner can read/write own drafts
- Shared team builds (public URL) remain v1.x deferred (tracked as TEAM-03)

**Frontend work (Phase 20):**
- Team builder uses backend for authed users, localStorage for anon
- Sign-up / first authed-team-builder-visit prompts migration of localStorage drafts to backend
- User can list, load, rename, delete own saved drafts

**Rationale:**
- v0.5 "backend iteration window closes at v0.9" — last chance to add this cleanly
- Required functionality per user: "authed users should persist team-builder drafts to the backend"
- Backend work fits naturally into Phase 19's data-wiring scope

**Requirements affected:** PUB-10 (anon only), PUB-13 (backend table + reducers), PUB-14 (authed persistence), PUB-15 (list/load/rename/delete), PUB-16 (migration prompt).

**Supersedes:** Notes "Out of scope for v0.9" → "Team builder draft persistence" block. TEAM-01 and TEAM-02 deferred requirements removed from v1.x (now in v0.9).

---

## R10 — Phase 14 status (carried from v0.5)

**Context:** PROJECT.md Active section originally included "Test harness modernization for SDK 2.1.0 (Phase 14)".

**Resolution:** Phase 14 was completed during v0.5 (see MILESTONES.md — "Phase 14: Test Harness Modernization (2/2 plans) — completed 2026-04-12"). No carry-over work. PROJECT.md Active section updated accordingly.

---

## Binding commitments from original notes that REMAIN unchanged

To prevent loss, explicit preservation:

- **Energy budget ceiling:** 102,500/month on maincloud (hard)
- **Architectural priorities:** bandwidth → UX → security → clarity
- **Browser support:** Chrome/Edge/Firefox (desktop + Android). Safari defensively gated to `image-only` tier with dismissible warning banner.
- **Single data plane:** SpacetimeDB subscriptions only. No SSR data plane. No REST bridge.
- **Public reference subs (Decision 1):** 6 tables subscribed at global level in `providers.tsx`.
- **Pedestal rendering (Decision 3):** Layered single-canvas (portrait `<img>` + single WebGL canvas). NO double-buffer. Same canvas reused across pick/ban transitions.
- **Spine schema prerequisites (Decision 4):** `hsr_character` gains `skelUrl`, `atlasUrl`, `atlasImgUrls` columns in Phase 15.
- **Route groups (Decision 5):** `(public)` → `(authed)` → `(authed)/(match)` nesting.
- **`getRenderTier()` (Decision 7):** Correctness + performance separation. Capability cache with 7-day TTL + VERSION bump. User override via localStorage.
- **Self-scoped historical views (Decision 8):** `view_my_match_history`, `view_my_mmr_history`, `view_my_session_history`, `view_my_participant_history` — server-filtered by `ctx.sender`. Phase 15 backend work.
- **Asset hosting split (Decision 3 sub):** UploadThing (`ufs.sh`) for architectural assets (portraits, Spine). Imgur for user-uploaded match screenshots.
- **`stdb_session` cookie:** Display-only for SSR NavBar hydration. Not an auth boundary. SpacetimeDB token in `localStorage` is authoritative.
- **Out of scope:** Team builder persistence to backend (localStorage-only for v0.9), SpacetimeDB SDK in Web Worker, real-time voice/video, mobile native app, payment/monetization.

---

## Open items for phase-time research (not resolved here)

1. **Spine `skeleton.scaleY = -1`** — Phase 31 must fix camera projection or document + test skinning. Notes flag this as known-bad workaround.
2. **Cursor broadcast throttle rate** — 30 Hz inferred, not locked. Phase 30 discussion confirms with real-device feel testing.
3. **Imgur rate-limit fallback** — Discord-bot storage plan exists but unscoped. Flag for Phase 32 discussion.
4. **Vercel preview Discord OAuth callback URLs** — dynamic whitelist or `returnTo` validator. Flag for Phase 21.
5. **FullStory 5k events/month sampling strategy** — low priority, flag for Phase 31 (pedestal telemetry) when telemetry is wired.
6. **React 19 peer confirmation for forked `@g-loot/react-tournament-brackets`** — Phase 34 fork work answers this.
7. **Recurring availability slot algorithm + DST + overlap computation** — Phase 26 research flag.

---

## Consumption by downstream phases

- **Roadmapper:** Use this file + notes + SUMMARY.md to derive the roadmap. Phase numbering 15–41 fixed. Feature pair pattern fixed. XX.1 convention established.
- **Phase 15 planner:** Scoped by notes Decision 4 + Decision 8. Self-contained backend phase.
- **Phase 16 planner:** Scoped by R4, R5, R6, R8, R9 in this file + notes Decision 5. Largest foundation phase.
- **Phase 21 planner:** Scoped by R3 (minimal authed base).
- **Every UX phase planner:** Must state up front whether this page is single-DOM or dual-DOM (per R4), honor R8 component hygiene, consume `<ViewportGate>` if split.
- **Phase 34 planner:** R7 fork-and-strip is non-negotiable scope.
