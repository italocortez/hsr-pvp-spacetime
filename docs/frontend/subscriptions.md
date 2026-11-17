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

**Measured (S14.2, test1, 2026-11-16, dev egress meter, a cold visit to `/costs`):** the rows and sizes are the client cache (rows serialized with the SDK's BSATN serializer, uncompressed); the wire figure is what the socket received, Layer 0 included.

| Source | Query | Rows | Cache size |
|---|---|---|---|
| `hsr_character` | whole table | 83 | 15.0 kB |
| `hsr_lightcone` | whole table | 156 | 30.0 kB |
| `archetype` | whole table | 12 | 0.5 kB |
| `hsr_character_archetype` | whole table | 110 | 4.4 kB |
| `view_published_cost_sets` | whole view | 0 (none published on test1) | 0 |
| `hsr_character_cost` | `cost_set_id = 0` | 498 | 34.7 kB |
| `hsr_lightcone_cost` | `cost_set_id = 0` | 936 | 65.9 kB |
| `hsr_synergy_cost` | `cost_set_id = 0` | 60 | 3.9 kB |
| **Total** | | 1,855 | 154.5 kB raw; **40.8 kB on the wire** (4 messages in, 1 out of 627 B) |

**The cost tables (user ruling 2026-11-16, S14.2):** the reference set subscribes the **default cost set** only: the three cost tables filtered on `cost_set_id = 0` (the sentinel; it has no `cost_set` row), asked for by a route that needs costs (`useReferenceSet({ costs: true })`; the costs page today, the team builder next) and then kept for the session like the rest. A **published custom set** is never part of it: the page that shows it subscribes `cost_set_id = N` for the three tables as a route subscription, dropped when the pick changes or the route is left. The queries are always disjoint (never `0 OR N`), and every reader filters cached rows by `costSetId`, because one client table holds every subscribed set. The queries are plain SQL text in `web/src/stdb/costQueries.ts` (pinned to the SDK's query builder output by a test), so a page chunk does not pull the SDK in.

**The team builder (S14.3a)** uses exactly these groups and the same custom-set route subscription (`stdb/useCustomCostSet.ts`, shared with the costs page): a cold visit to `/teambuilder` measured 41,434 B in (4 messages), 627 B out; a visit after `/costs` 0 B. It subscribes nothing else.

**Saved loadouts (S14.3c)** add one route subscription on `/teambuilder`: `SELECT * FROM view_my_loadouts` (`LOADOUTS_QUERY` in `web/src/pages/teambuilder/useLoadouts.ts`, through `useRouteSubscriptions`). It exists only while the visitor is a verified (Discord-linked) member (`useAuth().user` with `isGuest === false`, from `view_my_profile`): visitors and guests subscribe nothing new. It is dropped on route leave and on sign-out (the query list becomes empty), and replayed by the provider after a reconnect while the route is open. The view is per caller with no arguments and keyed by `slot` (rows arrive as updates); rows are read from the cache with `useRows`. Size from the backend's figures (docs/loadout/architecture.md): ten typical loadouts about 2.7 kB on first load, worst about 35 kB; each save echoes one row (an update two). Not measured yet with the dev egress meter (the browser check could not sign in).

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
