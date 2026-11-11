# Frontend subscriptions (carried decisions)

> Carried from the old repo. Where this conflicts with CLAUDE.md §Frontend or a page's view list in docs/frontend/pages.md (S14), those win.

Provenance: old repo `notes/v09-frontend-subscription-strategy.md` (2026-04-11), Decisions 1, 6, 9 and 10 only. Next.js file paths, route-group mechanics and the Spine / render-tier material (Decisions 2–5, 7) are dropped (A3, A17). Numbers are the old estimates; the energy budget is now 100,000 TeV/month (A16).

**Priorities, in order:** (1) bandwidth / egress, the dominant cost, (2) UX smoothness (no loading flashes, no jank during subscription bursts), (3) security (no trust in client-declared identity), (4) logical clarity of subscribe/drop lifecycles. When they conflict, bandwidth wins unless the UX cost is user-visible.

---

## Decision 1 — Public reference data delivery

Visitors open a SpacetimeDB WebSocket connection and subscribe directly to the public reference tables. There is no server-rendered data plane and no REST bridge: SpacetimeDB is the single data source for all app data, anonymous or authenticated.

| Table | ~Rows | ~Total (old estimate) |
|---|---|---|
| `hsr_character` | 82 | 31 KB (included Spine columns, now dropped by A17) |
| `hsr_lightcone` | 156 | 28 KB |
| `hsr_character_cost` | ~250 | 37 KB |
| `hsr_lightcone_cost` | ~470 | 70 KB |
| `hsr_synergy_cost` | ~200 | 24 KB |
| `cost_set` (S11a: private; read through `view_published_cost_sets`, the published rows only) | <20 | 2 KB |
| **Total** | | ~192 KB raw, ~70–100 KB on the wire |

**Why:** ~80 KB on the wire is smaller than one hero image; a second data plane for this volume would fragment the data model. Reference data changes only through admin reducers, rarely, and ordinary subscription updates propagate the changes with no bespoke cache invalidation.

**Notes:** the subscription is created once per session and kept regardless of auth state. Current rule (PAGE-MAP D10, CLAUDE.md): the **first route that needs** the reference set subscribes it and keeps it for the session; `/` and `/profile` never trigger it.

---

## Decision 6 — Subscription placement per layer

Each subscription lives at the highest layout that all its consumers share. Layouts own broad, long-lived subscriptions; pages own only entity-scoped subscriptions with parameterized filters.

| Layer | Subscriptions | Lifecycle |
|---|---|---|
| Global (app provider) | connection · `view_my_profile` (bootstrap) · `view_my_lobbies` · the public reference set (mounted on first need, see Decision 1) | app session |
| Authed zone | the signed-in user's own rows, through `view_my_*` views | logged-in session |
| Match zone | lobby, members, presets, active match session, through per-viewer views | lobby / draft navigation |
| Match entity | entity-scoped views (steps, results, chat for that lobby); match views only past the Waiting stage (PAGE-MAP D3) | single page mount |

**`view_my_profile` is global** because it is how the client discovers whether it is authenticated: it cannot be gated on being authenticated. The view filters by `ctx.sender`, so anonymous identities get 0 rows (effectively free) and signed-in identities get 1 row.

**Superseded:** the old decision subscribed the full `user` table for every signed-in client (cross-user names, avatars, calendars). PAGE-MAP D2 / A44(1) replace it: no page except the admin Users tab subscribes `User`; names and avatars are denormalized into the views that need them; exact lookups go through `view_user_by_username(username)`.

**Historical tables** (match results, MMR history, match-session history) grow without bound overall but are bounded per user: they are served only through self-scoped `view_my_*` views on the profile page, never at a layout level and never cross-user (A37).

**Asset delivery is a separate budget:** portraits and other images come from the image CDN (UploadThing), not from SpacetimeDB egress.

**Energy:** model changes with `tools/energy-model.js` (`node tools/energy-model.js --scenario current|growth|peak`) and keep its subscription assumptions in line with the placement above. If real usage approaches the ceiling, shed subscription weight first; there is no paid plan (A41).

---

## Decision 9 — Reference subscriptions stay on; gated panels use `useTable` `enabled`

Once mounted, the reference-data subscriptions stay on for the session, with no `enabled` prop: portrait warmup and page hydration depend on that data being live, and gating it would bring back the "first frame missing portraits" bug. Gated UI panels (admin tabs, modals) pass `{ enabled: <boolean> }` in the second argument of `useTable`.

**Why gated panels:** a hidden-but-mounted panel (for example the admin `User` tab kept mounted with `display: none`) would otherwise keep its subscription alive; gating recovers that egress.

**Notes:**
- `enabled` lives in the second-argument object next to `onInsert` / `onDelete` / `onUpdate`; it is not a third argument (verified on the old SDK's `useTable.d.ts`; re-verify after M1).
- `true → false` tears the subscription down; `false → true` re-establishes it.
- For a dynamic table accessor (an admin table explorer), `enabled` gates whichever table is selected; switching the key while enabled swaps subscriptions.

---

## Decision 10 — Reducer calls in React components use `useReducer(reducers.X)`

Inside React components or hooks, use `const callX = useReducer(reducers.X)` and call `callX(args)`. The hook returns a stable, typed, Promise-returning callback that queues until the connection is ready, which removes the per-site connection null-check and its readiness race.

**Why:** the old `getConnection()` / null-check pattern raced during connection setup (a click before the handshake silently did nothing or showed a "not connected" error). The queued Promise dispatches once connected and resolves or rejects once; the typed callback also removes the loose `as any` reducer accessor casts.

**Notes:**
- `.catch()` is the project's error pattern (see `docs/research/legacy-decisions.md`, v0.5 conventions); no `_then()` callbacks.
- For try/finally state (for example `setIsSubmitting`), chain `.then()/.catch()/.finally()`.
- Empty-parameter reducers are called as `callX()`, not `callX({})`: the SDK collapses the parameter type to `[]` and `{}` is a type error.
- `useProcedure(procedures.X)` is the equivalent hook for procedures; the module defines none today.
- Server-side code (the auth function) is not React and calls the connection's reducers directly.
