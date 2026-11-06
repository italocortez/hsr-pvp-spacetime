# Frontend Performance on CPU-Constrained Machines

**Date:** 2026-11-05 · **Branch:** `feature_nath_claude` · **Type:** investigation only (no code changed)
**Question:** The app felt sluggish on a slower CPU. What makes pages slow there, ranked by measured impact, and what should we do about each cause?

Every claim is tagged **[measured]** (from a build, trace, or Lighthouse run in this investigation) or **[inferred]** (read from code, or extrapolated from measurements).

---

## 1. Headline numbers

Test machine: Ryzen 7 9800X3D. Lighthouse `benchmarkIndex` is 4,300–4,860, which is very fast. Browser: headless Edge 156. Lighthouse 12.8.2 ran with the desktop preset, devtools CPU throttling, network throttling off, and storage reset off. Throttling at 4x makes this machine about as fast as an ordinary laptop that is a few years old; a budget laptop is closer to 6–10x, so scale the 4x numbers roughly linearly **[inferred]**.

### Lighthouse: production build vs dev server, extensions off **[measured]**

| Build | CPU | Route | FCP | LCP | TBT | TTI | Speed Index | Main-thread work | Score |
|---|---|---|---|---|---|---|---|---|---|
| prod | 1x | `/` | 141 | 291 | 0 | 141 | 871 | 276 | 1.00 |
| prod | 1x | `/costs` | 58 | 58 | 0 | 58 | 422 | 189 | 1.00 |
| prod | 1x | `/teambuilder` | 70 | 70 | 0 | 70 | 188 | 336 | 1.00 |
| prod | **4x** | `/` | 470 | 987 | 209 | 941 | 1,592 | 1,392 | 0.77 (CLS 0.27) |
| prod | **4x** | `/costs` | 148 | 148 | 302 | 1,211 | 1,078 | 1,021 | 0.87 |
| prod | **4x** | `/teambuilder` | 186 | 186 | 424 | 1,450 | 649 | 1,298 | 0.81 |
| **dev** | 1x | `/teambuilder` | 104 | 104 | 427 | 1,291 | 622 | 1,009 | 0.81 |
| **dev** | **4x** | `/costs` | 260 | 260 | **3,663** | **5,000** | 4,387 | **4,914** | 0.61 |
| **dev** | **4x** | `/teambuilder` | 285 | 285 | **4,228** | **6,004** | 3,316 | **5,752** | 0.62 |

All times are in ms. These are warm-cache, single runs. Lighthouse cannot see the WebSocket traffic, so the CDP traces below cover the SpacetimeDB sync window more completely.

### Browser extensions (the user's real Edge setup) at 4x, prod **[measured]**

The first headless Edge profile signed itself into the user's Microsoft account and synced in the user's extensions (see §6). That gave a direct A/B on the same route, same build, same identity:

| Route (prod, 4x) | Main-thread busy | Blocking time* | FCP | Long tasks |
|---|---|---|---|---|
| `/costs` without extensions | 1,052 ms | 212 ms | 248 ms | 7 |
| `/costs` **with extensions** | **3,068 ms** | **492 ms** | **1,223 ms** | 12 |
| `/teambuilder` without extensions | 1,003 ms | 124 ms | 149 ms | 7 |
| `/teambuilder` **with extensions** | **2,904 ms** | **441 ms** | **999 ms** | 12 |

\* CDP-trace blocking time: the sum of (task − 50 ms) for tasks after FCP, over a 10 s window. It is comparable between rows but is not Lighthouse TBT.

### Bottom line

- In a **production build at 4x**, the public pages are usable but not snappy. Main-thread work is about 1.0–1.4 s per load, TTI is about 0.9–1.45 s, and there are 5–7 long tasks of 50–270 ms.
- **The dev server** multiplies main-thread work by about 4.5x and blocking time by about 10x. It also adds 0.5–5 s of on-demand compile on each route's first visit.
- **The user's synced extensions** (Dark Reader, Dashlane, Wappalyzer, Surfshark, uBlock) roughly **triple** main-thread work and push FCP from about 0.2 s to about 1.1 s at 4x.

---

## 2. How much of the slowness is dev mode? **[measured]**

| Metric (4x, `/teambuilder`) | prod | dev | dev ÷ prod |
|---|---|---|---|
| Main-thread work (Lighthouse) | 1,298 ms | 5,752 ms | **4.4x** |
| TBT (Lighthouse) | 424 ms | 4,228 ms | **10x** |
| TTI (Lighthouse) | 1,450 ms | 6,004 ms | **4.1x** |
| JS shipped (resource size) | ~0.9 MB raw / 255 KB gz | ~19 MB (`main-app.js` 7.4 MB, two `layout.js` 4.1 + 3.6 MB, `page.js` 5.6 MB) | ~20x |
| CDP: time in tasks touching the SpacetimeDB SDK | 325 ms | 2,053 ms | 6.3x |

Dev-only overhead also includes **on-demand compilation the first time each route is visited**. On this fast machine: `/` 5.2 s (2,701 modules), `/costs` 1.5 s, `/teambuilder` 0.55 s, and `/api/auth/[...nextauth]` 0.6 s, which delays the first session fetch to 1.15 s. On a CPU 4x slower, that is about 20 s for the first page **[inferred]**.

The dev profile is dominated by React development builds. `jsxDEV` alone is 299 ms self time at 4x, plus `runWithFiberInDEV`, Strict Mode double renders (`[useAuth] render` logs 40 times on a dev `/teambuilder` load vs 18 in prod), and the Next dev overlay. Note that App Router runs Next's vendored React 19 (`react-dom-client.development.js`) even though `package.json` pins React 18. React 19 dev mode is noticeably more expensive when a debugger/DevTools is attached **[measured in trace; DevTools effect inferred]**.

**If the slow-machine test used `npm run dev`, roughly 75–80% of main-thread time and about 90% of blocking time was dev-mode overhead.** Production on the same CPU would be around 1–1.5 s to interactive, not 5–6 s **[measured at 4x on this machine; the slow machine's own factor is unknown]**.

---

## 3. Ranked causes

"Every page" means the cost sits in the root layout/providers. "Route" means it applies only there. Impact figures are per page load at 4x CPU in production unless stated otherwise.

### #1. Dev server instead of a production build (environment, every page): about +4 s main thread, about +3.5 s TBT at 4x **[measured]**

See §2.

- **Fix (quick win):** test performance only against `npm run build && npm start`, or a Vercel preview. For day-to-day dev on slow machines, try `next dev --turbopack` (stable in 15.5) to cut compile time **[inferred]**. Keep DevTools closed while judging feel.
- **Expected impact:** removes about 75–80% of perceived main-thread cost and all compile stalls.

### #2. Browser extensions in the user's synced Edge profile (environment, every page): about +1.9 s main thread at 4x **[measured]**

Self-time attributed per extension on `/teambuilder` at 4x:

| Extension | Self time |
|---|---|
| Dark Reader | 573 ms |
| Dashlane | 334 ms |
| Wappalyzer | 222 ms |
| Surfshark | 169 ms |
| uBlock Origin | 21 ms |

On top of that, about 500 ms of extra style, layout and paint is triggered by extension DOM and style rewriting. FCP goes from 149 ms to 999 ms. Because these extensions follow the Microsoft account, the slow machine very likely has the same set.

- **Fix (quick win, outside the app):** judge performance in an InPrivate window or a clean profile. Add `localhost` and the app domain to Dark Reader's and Dashlane's site-exclusion lists. Real users with Dark Reader pay this too; nothing in the app can prevent it.
- **Expected impact:** about 65% less main-thread work on the user's own browser.

### #3. Shared client runtime boot and hydration (every page): about 600–700 ms of the 1.0–1.3 s main thread at 4x **[measured]**

- **Script work.** Script evaluate+compile is 294–352 ms (of which `v8.compile` is 185–212 ms) across 22–26 scripts. Lighthouse bootup is 435–616 ms.
  - The Next runtime chunk `255-*.js` (React scheduler, hydration) is 238–277 ms.
  - `react-dom` is 130–147 ms.
  - The generated bindings chunk `788-*.js` (whole `src/module_bindings`: 240 files, 745 KB source, 129 KB minified) is **58–73 ms just to evaluate**.
  - The SDK chunk is 87–208 ms; the higher number includes sync work.
- **Payload per route** (build analysis, union of layout and page chunks):

  | Route | JS (raw / gz) | CSS (raw / gz) |
  |---|---|---|
  | `/` | 689 KB / 178 KB | 259 KB / 37 KB |
  | `/costs` | 695 / 181 KB | 274 / 40 KB |
  | `/teambuilder` | 912 / 255 KB (chart.js adds ~70 KB gz) | 274 / 40 KB |
  | `/profile` | 702 / 184 KB | 250 / 35 KB |
  | `/admin-view` | 1,273 / 333 KB | 245 / 34 KB |

  Next's printed "First Load JS" (102–327 KB) under-reports because it omits layout chunks.
- **Client components.** 48 of 58 `.tsx` files are `'use client'`. `(public)/layout.tsx` is a client component only so it can render `DeletionBanner`.
- **Fixes:**
  - **Medium:** keep `next-auth/react` (`964-*.js`, 31 KB raw) off public pages, or load it lazily. `SessionProvider` currently fetches `/api/auth/session` on every page load **[measured request]**.
  - **Larger refactor:** split or trim `module_bindings` so public pages don't evaluate the whole schema. This needs codegen or SDK support **[inferred]**.
  - **Expected impact:** about 10–20% of boot cost (≈60–120 ms at 4x) **[inferred]**. Most of this bucket is the fixed price of Next, React and the SDK.

### #4. SpacetimeDB layer-0 initial sync and the re-render cascade (every page, including `/`, which uses none of the data): 227–370 ms main thread at 4x, 19–35% of all main-thread work **[measured]**

What arrives:

- 7 reference tables plus `view_my_profile`: 88 characters, 158 lightcones, 265 character-cost rows, 472 lightcone-cost rows, 69 synergies, 12 archetypes and 110 character-archetype rows, **1,174 rows** in total.
- In the browser (gzip, `compression=Gz`) this is only about **28.5 KB** on the wire, in two frames (e.g. 18.2 KB + 10.2 KB). The ~114 KB frames in the 16.4 capture were uncompressed. **Bandwidth is not the problem; CPU is.**

CDP CPU-sampled attribution at 4x, prod. "Tasks touching the SDK" means whole tasks in which any sample has an SDK frame, including the React renders flushed in the same task:

| Route | Tasks touching SDK | SDK self | Bindings | React | App code | Style/layout | Long tasks among them |
|---|---|---|---|---|---|---|---|
| `/` | 227 ms | 108 | 9 | 19 | 66 | 10 | 74, 72 ms |
| `/costs` | 370 ms | 133 | 14 | 61 | 85 | 56 | 95, 82, 88 ms |
| `/teambuilder` | 325 ms | 118 | 30 | 59 | 48 | 53 | 78, 97, 86 ms |
| `/costs` at 1x | 47 ms | 18 | — | — | — | — | none |

Within SDK self time, about 30–40 ms at 4x is the SDK building codecs at runtime with `new Function` (`makeDeserializer`/`makeSerializer`) **[measured]**.

Amplifier: `GameDataProvider` (`components/features/game-data/components/GameDataProvider.tsx:125-145`) **[inferred from code; partly measured]**.

- It rebuilds `charactersData`, `lightconesData` and `synergiesData` and a new context `value` on **every** render, with no `useMemo`.
- It does that with an O(items × rows) `filter` per item (`DataHelpers.ts:6,46`).
- Each of the 7 `useTable` stores and every SpacetimeDB context change re-renders it, and the new array identities then:
  - invalidate every downstream `useMemo` (`useCharacterFilters`, `useCharacterCostTable`, `useLoadouts.resolveTeam`);
  - defeat `memo(CharacterCard)`, because each card gets a new `character` object.
- A micro-benchmark with the real row counts shows one derivation costs 0.47 ms warm / 1.8 ms cold at 1x (≈1.9–7 ms at 4x) **[measured]**. In the dev trace, `GameDataProvider` is 72 ms inclusive and `CharacterCard` 151 ms inclusive at 4x **[measured, dev]**.

Fixes:

- **Quick win:** memoize `GameDataProvider`. Do one O(rows) group-by for the cost maps, `useMemo` each derived array keyed on its row arrays, and `useMemo` the context value. Optionally split raw rows and derived data into separate contexts. **Expected:** removes most of the React/app share of the sync window (≈100–150 ms → ≈30–50 ms at 4x) and later spurious cascades **[inferred]**.
- **Medium:** subscribe only to the cost rows the UI uses. The skill's bandwidth rules say "Cost tables: subscribe only to the active `costSetId`", but all rows are subscribed today. `getLightconeCost` uses only `MemoryOfChaos` rows (`DataHelpers.ts:45`), so about two thirds of the 472 lightcone-cost rows (≈27% of all layer-0 rows) are decoded and then ignored **[inferred]**. Use a `useTable(... .where(...))` filter if the query builder supports the column, otherwise a view. **Expected:** SDK decode/cache work drops roughly in proportion to rows, up to about −30% **[inferred]**.
- **Medium (design tradeoff):** on `/` only, start the layer-0 subscription after LCP/idle (`requestIdleCallback`) instead of during hydration. This moves about 230 ms (4x) out of the landing page's critical window. It conflicts with decision D-05 ("subscriptions fire on connect regardless of route") and the planned portrait prefetch, so it needs a discussion first.
- **Larger refactor:** host the `DbConnection` in a Web Worker and post plain derived data to the main thread. That moves the 108–140 ms SDK self time and its GC off the main thread. It is a big change because `spacetimedb/react` assumes a main-thread connection. The 2.14 upgrade (`.planning/research/SPACETIMEDB-UPGRADE-2.14.md`) changes `useTable` resubscription behaviour but lists no client decode speedups.

### #5. Style, layout and paint (every page, worst on `/` and `/costs`) **[measured]**

V8 "(program)" self time, which covers native style, layout, paint, parse and compile, is 600–900 ms at 4x per load.

- **`/`:** the first layout of only 383 objects takes **205 ms at 4x**, followed by an 85 ms relayout. Other routes' first layouts take 39–48 ms. The cause was not isolated. Likely suspects are the emoji glyphs in `FeaturesSection` (system color-emoji font fallback) and the full-viewport hero with huge `clamp(3.5rem,10vw,8rem)` uppercase text **[inferred]**.
- **`/costs`:** the table layout is 86 ms for 2,330 layout objects. The 88 rows are all rendered, with an inline `filter: drop-shadow` per rarity badge (`CharacterCostTable.tsx:137`).
- **Client navigation `/` → `/teambuilder`:** 496 ms main thread at 4x, long tasks of 102 and 115 ms, and a 77 ms layout of 596 objects. 110 requests fire (route chunks plus about 100 images).
- **Global CSS** is 238 KB raw / 31 KB gz and render-blocking on every page. About **70% of its rule bytes are HeroUI theme rules**, because `app/globals.css:3` tells Tailwind to scan the whole `@heroui/theme/dist/**`. Parse is only 7–10 ms at 4x, so this is mostly transfer and render-blocking, with a little style-matching cost.

Fixes:

- **Quick win:** narrow the `@source` to the 7 HeroUI components actually used (button, chip, input, modal, select, table, tabs). **Expected:** global CSS about 238 KB → ~80 KB raw **[inferred]**.
- **Medium:** profile the `/` first layout (try temporarily replacing the emoji icons with SVG). Use `content-visibility: auto` on below-the-fold landing sections and on long tables. Replace the per-cell `filter: drop-shadow` with `text-shadow`.

### #6. Landing-page hero video (route `/`, but it is the entry page) **[measured]**

`public/recording/landing-page-loop.mov` facts:

- 5.46 MB, H.264 Main@L4.2, 2206×946, 7.5 s loop, about 5.8 Mbps.
- Includes an AAC track even though the video is muted.
- **`moov` atom at the end of the file** (no faststart), so the browser makes extra range requests before it can play (observed: 3 MB + 23 KB + 194 KB range requests).
- `preload="auto"`.
- A full-screen "LOADING ASSETS" overlay stays up until `canplaythrough` (`HeroSection.tsx:22-40,45`).

Measured effects:

- **Visual completeness:** Speed Index 871 ms vs LCP 291 ms (1x, warm). The first-ever cold load, with extensions on, had SI 6.1 s.
- **Continuous decode:** after load, home idles at about 0.5 CPU-s per 10 s (renderer 0.21 s + GPU 0.29 s, ~5% of a core) on this machine. `/costs` and `/teambuilder` idle near 0. On a slow machine, or one without hardware decode for this odd 2206-px width, that becomes a constant background load while the user reads the page **[inferred]**.
- **Layout shift:** CLS 0.27 at 4x, from the hero `<h1>` shifting on web-font swap.

Fixes:

- **Quick win:**
  - Re-encode to 1280–1920 px wide, faststart, no audio, about 1.5–2 Mbps (≈1.5 MB).
  - Add a `poster` and remove the full-screen loader gate (show the poster instead).
  - Use `preload="metadata"`.
  - Pause when off-screen (`IntersectionObserver`) and under `prefers-reduced-motion`.
  - Show a still image when `getRenderTier()` returns `image-only` (`lib/render-tier.ts` already exists).
- **Expected:** SI on `/` drops to around LCP (≈300 ms at 1x), the idle decode CPU goes away when hidden, and transfer falls from 5.4 MB to ~1.5 MB.

### #7. `/teambuilder` specifics: portraits, chart.js, duplicate auth hook (route) **[measured]**

- **Portraits.** 83 portraits load from `*.ufs.sh` (webp, median 48 KB, max ~100 KB) at full resolution. They are about 4.8 MB decoded, and Lighthouse estimates **3.99 MB of savings** (about 85% per image) because they display much smaller. They are raw `<img>` tags without width/height, `loading="lazy"` or `decoding="async"` (`CharacterCard.tsx:158`). Decoding cost 33 decodes and about 32 ms on worker threads here; it scales with core count and speed on slow machines **[measured here, scaling inferred]**.
- **chart.js** plus its datalabels plugin is about 200 KB raw / 70 KB gz and is evaluated before first render.
- **Duplicate auth hook.** `app/(public)/teambuilder/page.tsx:25` calls `useAuth()` directly instead of `useAuthContext()`. That creates a second auth state machine (`useSession`, two `useReducer`s, render logging), and its `currentUser` can never resolve because only the provider's instance gets `setProfileReady` **[inferred from code]**.
- **Fixes:**
  - **Medium:** serve resized portraits (a CDN transform or pre-generated ~160–200 px webp) and add `width`/`height`, `loading="lazy"` and `decoding="async"`.
  - **Medium:** load `CostBreakdownChart` with `next/dynamic` after first paint.
  - **Quick win:** switch to `useAuthContext()`.
- **Expected:** about 4 MB less image transfer and decode on this route, and roughly 50–100 ms less blocking at 4x on first render **[inferred]**.

### #8. `HeroUIProvider` wraps the whole app (every page): about 30–40 ms at 4x **[measured, medium-confidence attribution]**

Only `/admin-view` (and its `DeleteConfirmModal`) uses HeroUI, but `app/providers.tsx` mounts `HeroUIProvider`, and with it react-aria's I18n/Overlay providers, on every page.

- The dev trace shows `@react-aria/i18n useDefaultLocale` at 38 ms self (4x).
- The prod trace shows a function in the react-aria chunk `895-*.js` at 31–40 ms self (4x).
- framer-motion and the HeroUI component code (411 KB raw / 125 KB gz) are correctly split into `/admin-view` only **[measured]**.

- **Fix (medium):** move `HeroUIProvider` into `app/(authed)/admin-view/layout.tsx`.
- **Expected:** about 30–40 ms less at 4x on every non-admin page, and one fewer chunk.

### #9. Smaller items **[measured counts; costs inferred to be small]**

- **Render-path logging.** `[useAuth] render` logs an object on every render (`useAuth.ts:62`). Counts: 10 on a prod `/` load plus soft navigation; 18 on a prod `/teambuilder` load, where the duplicate `useAuth()` instance from #7 doubles it; 40 on a dev `/teambuilder` load. Other providers also log. This is cheap with DevTools closed and noticeably costly with DevTools open; the dev trace shows `useAuth` at 38 ms self, mostly this log. **Quick win:** remove the log, or add `compiler.removeConsole: { exclude: ['error','warn'] }` for production builds.
- **Wasted prefetch.** For anonymous users, the NavBar "LOBBIES" link prefetches `/lobby`, which middleware redirects with a 307, and the router then fetches `/` again. **Quick win:** `prefetch={false}` for authed-only links when not authenticated.
- **CLS 0.27 on `/` at 4x** comes from the hero title's font swap (Inter at 8rem, uppercase). **Quick win:** reserve the title's height. Inter's fallback metrics already come from `next/font`; consider `display: 'optional'` for this one usage.

---

## 4. Checked and not the problem

- **Spine skeletal animation:** **not present** in the codebase. There are no Spine imports or `workers/` directory **[measured by grep]**. It exists only as a plan (`notes/v09-frontend-subscription-strategy.md`, Decision 2/3). When it lands, it must stay behind `getRenderTier()` as designed, because it will be the heaviest CPU item in the match zone **[inferred]**.
- **Service worker** (`public/sw.js`): cache-first for `*.ufs.sh` images only. It does no prefetch (the planned Web Worker portrait prefetch is not implemented) and showed negligible cost in traces **[measured]**.
- **framer-motion / HeroUI component code:** only in the `/admin-view` chunk, not on public pages **[measured]**.
- **Network bytes for SpacetimeDB:** about 28.5 KB gz per load. CPU decode matters; bandwidth does not **[measured]**.
- **Memory:** JS heap is 8–11 MB on public pages in prod and 82 MB in dev **[measured]**.

---

## 5. Not measured, and how to measure later

| Gap | How to measure |
|---|---|
| **Authed routes** (`/lobby`, `/profile`, `/admin-view`, `/draft/[id]`). Statically: `/lobby` and `/draft` are stubs. Every authed page adds `SELECT * FROM user` (`app/(authed)/layout.tsx:56`). Per notes, the full user table is about 750 KB per client at 5k users, which is about 3x today's whole layer-0 payload, so decode cost would scale by roughly the same factor **[inferred]**. `/admin-view` ships 333 KB gz JS. | Log in once (Discord) in a persistent profile, then reuse the scratch tracer (`cdp-trace.mjs`, see §7) or `lighthouse --port --disable-storage-reset` against that browser. Seed a realistic `user` row count first. |
| **The actual slow machine.** | Run the same Lighthouse command there and read `environment.benchmarkIndex`. Divide it into ≈4,600 to get the real multiplier. Run it in InPrivate once and in the normal profile once to see the extension cost. |
| **Interaction latency (INP)**: typing in filters, clicking cards, drag-reorder in the team roster. | Lighthouse timespan mode or a DevTools Performance recording at 4x. Watch for whole-pool re-renders (`CharacterPool` computes `isCharacterSelectable` and `find` per card per render). |
| **Video decode on hardware without H.264 acceleration.** | Task Manager CPU/GPU columns with `/` idle; compare against `/costs`. |
| **Headed vs headless.** All runs were headless Edge. GPU and compositor behaviour, especially for video, can differ. | Repeat the idle-CPU check in a normal window. |
| **Repeatability.** Most rows are single runs. | Run 3–5 times per cell and report medians before using these as regression baselines. |

---

## 6. Side effects of this investigation

- **Page loads:** 18 browser loads (Lighthouse: 7 prod + 3 dev; CDP tracer: 7 prod + 1 dev), plus 6 server-only `curl` warm-up requests that open no WebSocket.
- **SpacetimeDB identities:** **2 anonymous identities** were created, one per origin because the token lives in per-origin `localStorage`:
  - `c20026a7…` for `localhost:3100`. Reuse across all runs on that origin was verified from console logs.
  - `c2003dbc…` for `localhost:3101`.
- **Rows:** **0 rows created or modified.**
  - `clientConnected` (`spacetimedb/src/index.ts:113`) writes only when a `UserIdentity` mapping exists.
  - No page called `loginAsGuest` or any other reducer; the auto-register path requires a next-auth session.
- **Egress:** about 0.5 MB (≈28.5 KB gz × 18 loads).
- **Edge implicit sign-in:** the first headless Edge launch on a fresh `--user-data-dir` **implicitly signed into the Windows Microsoft account and turned on sync**, which pulled in the user's extensions and account data. The first two loads ran this way (one Lighthouse run, one trace, both on `localhost:3100`). Edge history sync may have recorded those visits. All later launches used `--disable-sync --disable-extensions`, except one deliberate with-extensions run that kept `--disable-sync`. The scratch profile, which held the synced copy, was **deleted** at the end.
- **`.next/`:** the old build output was replaced by a fresh production build and then by dev-server output. This is gitignored and regenerable. `npm run dev` is unaffected; `npm start` needs `npm run build` first.
- **Repository:** no source, `package.json` or lockfile changes; no installs into the repo (Lighthouse ran via the npx cache). This report is the only file added.
- **Processes:** all servers and browsers were stopped. Ports 3100, 3101 and 9333 were verified free.

---

## 7. Method and reproducibility

1. **Static pass.** Providers and layouts, `'use client'` boundaries, `useTable`/context usage, CSS and assets, service worker, and the SDK source (`node_modules/spacetimedb/dist/react/index.mjs`: `useTable` snapshots once per transaction event; the provider context changes on each connection-state change).
2. **Bundle.** `next build` (Next 15.5.15). Per-route chunk unions came from `.next/app-build-manifest.json`, with gzip-9 sizes; chunks were attributed to libraries by signature strings.
3. **Runtime.**
   - Lighthouse 12.8.2 (`npx`) against headless Edge 156 started with a fixed `--user-data-dir` and `--remote-debugging-port`. Flags: `--port --preset=desktop --throttling-method=devtools --throttling.cpuSlowdownMultiplier=N`, network throttling at 0, `--disable-storage-reset --save-assets`.
   - A raw-CDP tracer (Node's built-in WebSocket) recorded traces with `disabled-by-default-v8.cpu_profiler` sampling, WebSocket frames, console output, and `SystemInfo.getProcessInfo` CPU deltas for idle measurements.
   - Analysis attributed CPU samples by script URL (SDK / bindings / react-dom / Next runtime / app / extension) and attributed whole tasks to SpacetimeDB if any sample in them had an SDK frame.

Scratch artifacts (not committed) are in `C:/Users/Nathyron/AppData/Local/Temp/claude/bf1569215458d3e3/a544ae80-db2d-4960-a17b-66f4bbfc9bf3/scratchpad/perf/`:

- `lh/*.report.{json,html}`: Lighthouse reports, traces and devtools logs. Files prefixed `WITHEXT-` were run with extensions.
- `traces/*.trace.json` and `*.meta.json`: CDP traces and run metadata.
- `scripts/`:
  - `lh.sh`: Lighthouse runner.
  - `cdp-trace.mjs`: tracer.
  - `nav-trace.mjs`: client-navigation tracer.
  - `analyze.cjs`: long tasks, category self time, SpacetimeDB task attribution.
  - `events.cjs`: style/layout breakdown.
  - `topfn.cjs`: top functions.
  - `ws.cjs`: WebSocket frames.
  - `lhsum.cjs`: Lighthouse summary.
  - `css.cjs`: CSS composition.
  - `bench-gamedata.cjs`: `GameDataProvider` derivation micro-benchmark.

---

## 8. Recommended order of work

1. **Today, no code:** measure with a production build in an InPrivate window (#1, #2). This resets expectations about what is actually slow.
2. **Quick wins, about one session:**
   - Memoize `GameDataProvider` (#4).
   - Fix the hero video: re-encode, poster, remove the loader gate, pause off-screen (#6).
   - Narrow the HeroUI `@source` (#5).
   - Use `useAuthContext` in teambuilder (#7).
   - Remove render-path logging and the anonymous `/lobby` prefetch (#9).
3. **Medium:**
   - Move `HeroUIProvider` into the admin layout (#8).
   - Resized, lazy portraits and a lazily loaded chart (#7).
   - Filter cost-table subscriptions to the rows the UI uses (#4).
   - Investigate the landing page's 205 ms first layout (#5).
4. **Larger, only if 2–3 aren't enough:**
   - Move SpacetimeDB decoding to a worker (#4).
   - Split module bindings (#3).
   - Keep next-auth off public pages (#3).
