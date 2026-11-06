# Legacy decisions (old repo)

Decisions from the old repo's planning files that still carry weight. Everything else in those files was Next.js- or GSD-specific and was dropped (MIGRATION-PLAN §2.6). Current decisions live in `DECISIONS.md`; where the two conflict, `DECISIONS.md` wins.

---

## R7 — Tournament brackets: fork `@g-loot/react-tournament-brackets`

> Provenance: old repo `.planning/research/DECISIONS.md` R7, defined 2026-04-12 (v0.9 milestone kickoff), imported at `471a481`.

> **Superseded by DECISIONS.md A44(5):** do not fork the library (ISC on npm, LGPL-2.1 on GitHub); the bracket view is a custom SVG layout over `shared/bracket/` once the tournament mockup exists. Kept for its rationale (dead upstream, layout math is the hard part).

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

---

## R8 — Component hygiene rules

> Provenance: old repo `.planning/research/DECISIONS.md` R8, defined 2026-04-12, imported at `471a481`. The living version is `docs/frontend/component-hygiene.md`.

> Read with the new stack: there is no dual-DOM (A13, one responsive page per screen) and no Tailwind (A49, CSS Modules + `tokens.css`); rule 3 applies to responsive CSS in modules the same way.

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

## v0.5 conventions (carry forward)

> Provenance: old repo `.planning/STATE.md` lines 55–64, imported at `471a481`. Note: `winnerId=0 sentinel for draw` is obsolete under A31 (no draws) and A21 (`submit_match_result` drops `winnerId`, step S7).

- costSetId=0 sentinel for default cost set
- teamGroupId=0 sentinel in reducer args (u32 not optional)
- winnerId=0 sentinel for draw
- Flat columns over config structs for filterable data
- UserPrivate isolation — profile data only via `view_my_profile`
- `.catch()` reducer error pattern (no `_then()` callbacks)
- BigInt micros as strings for timestamp params in reducers
- Sentinel values for optional u8/u32 reducer params (255/0)

---

## v0.9 architectural commitments kept

> Provenance: old repo `.planning/STATE.md` lines 52–53, imported at `471a481`. The other v0.9 commitments (R2, R4, R7, R8, R9, the 102,500 energy ceiling) are superseded by `DECISIONS.md` (A3, A13, A16, A44, A49). The Spine tier wording is removed per A17.

- **Single data plane** — SpacetimeDB subscriptions only. No SSR data plane, no REST bridge.
- **Browser support** — Chrome/Edge/Firefox; Safari supported defensively.
