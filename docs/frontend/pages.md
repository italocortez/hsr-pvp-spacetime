# Pages

One entry per ported page: route, files, mockup, breakpoint snaps, guides used, Safari notes. Shared building blocks are listed once, under the first page that introduced them.

## Standby (M3)

- **Route:** `/` and `/standby`, plus the route placeholders listed under Routes (M4). Query `?module=<name>` on `/standby` (or the placeholder's `module` prop) shows the champagne module pill and sets the title to `<name> — Standby — IPC Battlegrounds`; the name is rendered as text only and cut to 40 code points (a surrogate pair is never split). The pill reads "Requested module: <name>" to screen readers through a visually hidden ": ".
- **Files:** `web/src/pages/standby/StandbyPage.tsx`, `StandbyPage.module.css` (module pill only), `useRequestedModule.ts`, `standbySearch.ts` (the `/standby` search validator); shared `web/src/components/SplashLayout/` (art, scrims, brand, HUD chip slot, text column, CTA, bottom HUD), `BrandLogo/`, `HudChip/`, `IpcButton/`; `web/src/lib/useDocumentTitle.ts`. Art: `web/public/standby.webp` (identical to `design/assets/standby.webp`).
- **Mockup:** `design/mockups/standby.html`.
- **Breakpoint snaps:** 960px to `--bp-lg` (1040), 540px to `--bp-sm` (560). Neither breaks at the snapped width; no page-local media.
- **Deviations from the mockup:** font sizes in `rem` (same px at the default root size); `min-block-size` instead of a fixed CTA height; the CTA fill and ring are clipped pseudo-elements so the element's focus ring is not clipped; `100dvh` instead of `100vh`; the brand link's accessible name is `aria-label="IPC Battlegrounds"` (its visible text) instead of "Return home"; the HUD dot pulse runs only under `prefers-reduced-motion: no-preference`; body `line-height: 1.5` (the mockup leaves the browser default); `text-wrap: balance` on the headline and `text-wrap: pretty` on the lede; body `overflow-x: clip` instead of `hidden`.
- **Top-bar legibility** (user decision 2026-11-12, A168; applies to standby and 404 through `SplashLayout`):
  - A top-bar scrim, `--scrim-top` on `.scrimEdges`: void at 58% from 0 to 48px, fading out by 120px, so the art below the top bar is unchanged.
  - The brand word is one step brighter (`--text-body`) and carries the HUD text shadow.
  - Worst-case contrast (text against the brightest art pixel behind it, shadows not counted), before and after:

    | Element | Width | Before | After |
    |---|---|---|---|
    | HUD chip | 1440 | 2.89 | 6.80 |
    | HUD chip | 390 | 1.39 to 1.44 | 4.78 to 4.93 |
    | Brand word | 1440 | 3.22 | 8.76 to 8.80 |
    | Brand word | 390 | hidden | hidden |

  - **Open:** the eyebrow is not changed and stays below 4.5:1 (1.40 to 2.56; 4.17 on the 404 page at 390).
- **Mockup defects fixed here** (M3 review):
  - Brand word and HUD chip touched or overlapped below about 390px (1px gap at 375, overlap at 360 and 320; the longer 404 chip touched at 390). At `--bp-xs` (480) and below the brand word is hidden; the logo mark stays and the link keeps its name. Measured brand-to-chip gap, standby / 404: 320: 111 / 95px, 360: 151 / 135px, 375: 166 / 150px, 390: 181 / 165px.
  - At `--bp-lg` on short screens (844 x 390 landscape) the text column slid under the brand. `.overlay` now has 88px top padding there; short screens scroll.
  - The bottom HUD showed two separators in a row at `--bp-sm` once the coordinate was hidden; its separator now hides with it.
  - The module pill broke mid-word at 320px ("TOURNAMEN / TS"). It now wraps between label and name (`flex-wrap: wrap`), and the name uses `overflow-wrap: break-word`.
  - The mockup's `*::before` / `*::after` box-sizing applies again (an earlier `:where()` wrapper dropped the pseudo-elements and enlarged the CTA arrow head).
- **Guides used:** `css/css.md`, `css/design-token-reactivity.md`, `css/responsive-design.md`, `visual-design/visually-stable-font-fallbacks.md`, `visual-design/typography.md`, `html/html.md`, `accessibility/accessibility.md`, `ui-behaviors/motion.md`.
- **Safari notes:** `text-wrap: balance | pretty` and `dvh` degrade to normal wrapping and `vh`-like sizing on older Safari. Safari does not support `ascent-override`, `descent-override` or `line-gap-override`, so there the fallback fonts are width-matched only (`size-adjust`) and line boxes may shift slightly when the web font arrives. Only the latin subset is loaded (all browsers): characters outside it render in the fallback.

## Not found (M3)

- **Route:** any path the route tree does not match (the router's `defaultNotFoundComponent`, with `notFoundMode: 'root'`), including unknown paths under a guarded area (`/admin/zzz`, `/profile/zzz`), for every visitor and without a sign-in redirect (user ruling, M4: "straight 404"). Title `<What> not found — IPC Battlegrounds`.
- **Files:** `web/src/pages/not-found/NotFoundPage.tsx` (no CSS of its own: it renders `web/src/components/ErrorSplash/`, shared with the no-access page, which wraps `SplashLayout` with the standby art and the `Error // <code>` eyebrow). Art: `web/public/standby.webp`, shown exactly as on standby (user ruling, M3): the 404 screens share the standby art and only the wording changes.
- **Wording prop:** `what?: string`, default `"Page"`, names the missing thing. It fills the headline ("<What> *not found.*"), the title, and the lede ("The IPC has no record of this <what in lower case>. Check the link, or head back to base."). The default page case keeps "this route" in the lede. Eyebrow `Error // 404`, chip `SYS://NO SIGNAL`, bottom HUD and the CTA back to `/` do not change.
- **Mockup:** none; same pattern as standby.
- **Contrast** equals standby's, since art and scrims are the same. Worst case (text colour against the brightest art pixel behind each element, text shadows not counted), 404 / standby, after the A168 top-bar scrim: at 1440, brand word 8.76 / 8.80, HUD chip 6.80 / 6.80, eyebrow 2.37 / 2.34, lede 3.69 / 3.54; at 390, HUD chip 4.78 / 4.93, eyebrow 4.17 / 3.68, lede 9.28 / 8.99. The eyebrow and the 1440 lede stay below 4.5:1 on both pages, where the mockup's multi-layer text shadows carry the legibility; open for a later design pass.

## No access (M4)

- **Route:** `/admin` (the `_admin` layout) for a signed-in user below Moderator, guests included (user ruling, M4: "a no access page"). Rendered in place by the layout component, so the URL stays `/admin`; a visitor still gets the sign-in redirect. Title `Access denied — IPC Battlegrounds`.
- **Files:** `web/src/pages/no-access/NoAccessPage.tsx` (no CSS of its own) on `web/src/components/ErrorSplash/`; the layout body is `web/src/auth/StaffOutlet.tsx`.
- **Wording:** eyebrow `Error // 403`, headline "Access *denied.*", lede "This area is for IPC staff. If you think this is a mistake, contact an admin.", chip `SYS://RESTRICTED`, bottom HUD `Sector 00 · Restricted`, CTA back to `/`.
- **Live role changes:** the layout reads the auth store, so member to moderator (or back) switches between this page and the admin route without a reload.
- **Mockup:** none; same pattern as the 404 page. Contrast equals the 404 page's (same art, scrims and element positions).
- **Screenshots:** `test/frontend/screenshots/no-access/no-access-{1440,390}.png`, taken from the dev server (the production preview has no way to sign in) with the router devtools hidden by an injected style (`#root > :not(main) { display: none }`).

## Routes (M4)

TanStack Router, file-based: route files in `web/src/routes/`, the generated tree in `web/src/routeTree.gen.ts` (committed, written by the Vite plugin on `dev` and `build`). Router in `web/src/router.tsx`: `defaultPreload: 'intent'`, `defaultPreloadStaleTime: 0`, scroll restoration, route code splitting (one chunk per route).

| Route file | Path | Guard | Renders now |
|---|---|---|---|
| `__root.tsx` | root | none | `<Outlet />`; router devtools in dev only (lazy, not in the build) |
| `index.tsx` | `/` | none | `StandbyPage` without a module; search `{ login?: 1; next?: string }` |
| `standby.tsx` | `/standby` | none | `StandbyPage`; search `{ module?: string }` |
| `costs.tsx` | `/costs` | none | standby, module "Cost Tables" |
| `teambuilder.tsx` | `/teambuilder` | none | standby, module "Team Builder" |
| `lobbies.tsx` | `/lobbies` | none | standby, module "Lobbies" |
| `_authed.tsx` | layout | signed in | `<Outlet />` |
| `_authed/profile.tsx` | `/profile` | signed in | standby, module "Profile" |
| `_authed/lobby.$lobbyId.tsx` | `/lobby/$lobbyId` | signed in | standby, module "Lobby Room" |
| `_authed/calendar.tsx` | `/calendar` | signed in | standby, module "Calendar" |
| `_authed/tournaments.tsx` | `/tournaments` | signed in | standby, module "Tournaments" |
| `_admin.tsx` | layout | signed in; Moderator and above to see the route | `<Outlet />` for staff, `NoAccessPage` in place for other users |
| `_admin/admin.tsx` | `/admin` | as `_admin` | standby, module "Admin Console" |

Profile sub-routes (achievements, roster, stats, replays) come with the profile page.

**Guards** (`web/src/auth/guards.ts`; UX only, the module is the authority):

- Auth comes from `web/src/auth/authStore.ts`: `{ ready, user?: { id, role, isGuest } }` (`id` is the `u32` of `view_my_profile`, a number). Since M6 it starts not ready and Layer 0 feeds it (`web/src/stdb/layer0.ts`): `view_my_profile` applied with no row is a visitor, with a row a user, and later row changes follow; a failed connection sets it back to not ready. `App.tsx` passes it as router context and calls `router.invalidate()` when it changes, so the guards re-run (a member signed out on `/profile` lands on `/?login=1&next=%2Fprofile`).
- Not ready: the guard lets the route through and the layout renders nothing (the void background) under the neutral title `IPC Battlegrounds` until ready (`web/src/auth/NotReady.tsx`). Both guarded layouts also render nothing while ready without a user (the one render between a sign-out and its redirect), so pages under them always have a user (M6).
- `_authed` (`beforeLoad`): no user goes to `/?login=1&next=<path>`. Guests count as signed in.
- `_admin`: the same `beforeLoad` for visitors. The role check is in the layout component (`StaffOutlet`), not the guard: a user below Moderator sees the no-access page at `/admin`, no redirect. Because the check is only in the render, the route chain still runs for any signed-in user: child `beforeLoad`s, loaders and code chunks under `_admin` load for guests and members too. **Loaders and `beforeLoad` under `_admin` must check `isStaff(context.auth)` themselves; admin chunks are public code.**
- Why not a guard: a role check thrown from `_admin`'s `beforeLoad` and shown by its `errorComponent` does stop the chain (tested in the M4 fix pass: as guest no `admin.tsx` request, no child `beforeLoad` or loader; preload quiet; live role flips work both ways). But the installed router renders a route in error status by throwing the error inside React, so every 403 render logs a page error, React's "The above error occurred" and the router's "Error in route match". That fails the clean-console rule, so it was not kept.
- Unknown paths under a guarded area are not guarded: `notFoundMode: 'root'` sends them to the root's 404 before any layout runs (`/admin/zzz`, `/profile/zzz`, `/lobby`, `/lobby/` show the 404 for visitor, guest and admin alike). Without it, the partly matching layout took them and a visitor was sent to sign in. Role order mirrors the module (`web/src/auth/roles.ts`, from `spacetimedb/src/helpers/identity/ensurePermissions.ts`).

**The `next` rule** (`safeNextPath` in `web/src/auth/loginSearch.ts`): kept only when it is a string of at most 2048 characters that starts with `/` and not `//`, and contains no control character (U+0000 to U+001F, U+007F) and no backslash anywhere. Browsers strip tab, CR and LF from URLs (`/<TAB>/host` becomes `//host`) and read `\` as `/`, hence the last two conditions. Anything else is dropped from the validated search, and the router rewrites the address bar itself when a validator returns `undefined` for a key that was present (`/?next=https://evil.example` becomes `/`, `/?login=1&next=/%5Cevil.example` becomes `/?login=1`). Validators always return their keys (possibly `undefined`): the router merges the raw search under the validated one, so an omitted key would let the rejected raw value through.

**Unknown search keys** are kept in the URL and in the merged search, so `useSearch()` is not an allow-list: read only the keys a route's validator returns.

**Placeholders**: every route not built yet renders `StandbyPage` with its module name; the page is replaced when its step lands. Unknown paths render `NotFoundPage` through `defaultNotFoundComponent` (no `$.tsx` catch-all: unmatched paths already reach it).

**Dev helper**: in dev only, `window.__devAuth('visitor' | 'guest' | 'member' | 'moderator' | 'admin' | snapshot)` sets the auth snapshot to check the guards before login (M5) and the connection (M6). It is not in the production build (`rg __devAuth web/dist` finds nothing).

**Search params are plain text** (user decision 2026-11-12, A169): `parseSearch` / `stringifySearch` in `web/src/lib/searchParams.ts`, built on `URLSearchParams` (the router's `parseSearchWith` / `stringifySearchWith` were not used: their decoder turns `123` and `true` into a number and a boolean, and their encoder writes one value per key and keeps empty values). Every value reaches `validateSearch` as a string, or an array of strings when a key repeats; `?module=123` and `?module=true` stay as written, never `%22`-quoted. When the router writes a URL, keys are sorted, `undefined` and empty values are left out, and an array becomes a repeated key (`?el=fire&el=ice`). Pages convert text to numbers or flags themselves, in their validators. Validators must be idempotent: the router re-runs them on already-validated values when it builds a location (so `/`'s validator accepts both the text `"1"` and the number `1` for `login`). A repeated `next` or `module` is dropped. The router rewrites the address bar only for values a validator drops or changes (`/?login=2` becomes `/`). Things the writer itself normalises stay as typed: empty values (`?module=` shows no pill), bare keys, key order, `%20` versus `+`; all harmless.

**For M5 and M6:**

- Re-run `safeNextPath` at the moment of use, not only in the validator.
- Navigate to `next` only through the router (`router.navigate` / `redirect`), or resolve it with `new URL(next, location.origin)`; never `window.location` with a raw value, a raw href, or hand-normalised text.
- Every route with search params needs a validator: numbers written to the URL come back as text.
- Validate `next` again after the Discord round trip, and in the auth function before it writes any `Location` header.
- Pages under a guard must tolerate one render without a user after sign-out (the redirect follows the invalidate). **Done (M6):** both guarded layouts render nothing without a user.
- Loaders under `_authed` must not assume a user while auth is not ready (the guard lets them through then). **M6:** no loader exists yet; the rule stands for the first one.
- Set a neutral document title while auth is not ready (the layout renders nothing, so the previous page's title stays). **Done (M6):** `NotReady`.
- The lobby route should validate `$lobbyId` and show `NotFoundPage` with `what="Lobby"` for a bad one.

## Connection splashes (M6)

- **When:** the root layout (`web/src/stdb/ConnectionGate.tsx`) renders one of them in place of every route once the connection status is `failed`. `connecting` and `reconnecting` block nothing. The URL stays. `failed` (with auth back to not ready) comes from:
  - the SDK reporting it will not retry a connection (a failed first connection, a terminal reconnect error);
  - a Layer 0 subscription error (`view_my_profile` or `view_my_lobbies`, first result or a replay): the app closes that connection, so Retry builds a new one and subscribes again;
  - the SDK closing the connection itself (it calls its own `disconnect()` on an error for an already applied subscription). A close counts as the app's own only when the connection is no longer the current one (`ConnectionScope` clears it before the provider's manager closes it 0 ms later);
  - a stored token the server refuses at the token exchange (401 or 403): the token is deleted and Retry reloads the page, because the provider's manager keeps the old token for its rebuilds.
  - The auth store is only replaced when it was not already not ready, so a rebuild that fails again does not re-run the guards.
- **Files:** `web/src/pages/connection/OfflinePage.tsx`, `MaintenancePage.tsx` on `web/src/components/ConnectionSplash/` (`SplashLayout` with the standby art and a Retry button, `IpcActionButton`, in place of the link back to base; `SplashLayout` gained an `action` prop).
- **Wording** (orchestrator proposal, for the user to rule on): offline: eyebrow `Error // Offline`, headline "Connection *lost.*", lede "The link to the IPC servers is down. Check your connection and try again.", chip `SYS://OFFLINE`, bottom HUD `Sector 00 · Offline`, title `Connection lost — IPC Battlegrounds`. Maintenance: eyebrow `Status // Maintenance`, headline "Under *maintenance.*", lede "The site is in maintenance. Please try again later.", chip `SYS://MAINTENANCE`, bottom HUD `Sector 00 · Maintenance`, title `Under maintenance — IPC Battlegrounds`.
- **Retry** reconnects without a page reload: it hands the SDK provider a fresh connection builder (a reload only after a refused token). The Retry button is the CTA without the leading arrow (the arrow means "go somewhere"; Retry stays on the page).
- **Screenshots:** `test/frontend/screenshots/connection/{offline,maintenance}-{1440,390}.png` (dev server; offline reached by failing the token request, maintenance forced with `window.__devConnection`; devtools and the egress panel hidden).
- **Rule: dev never runs against prod** (user decision 2026-11-13). `npm run dev` with `VITE_STDB_TARGET=prod` (process environment first, then the env files) stops at start in `web/vite.config.ts` with "Dev mode cannot run against the prod database. Set VITE_STDB_TARGET=test."; `main.tsx` repeats the check (`web/src/stdb/assertDevTarget.ts`) before any connection or dev helper exists. A production build with the prod target, and `vite preview` of it, are unaffected.
- **Decided and planned (user, 2026-11-13):**
  - **Maintenance:** the refusal never reaches the browser (the server upgrades the socket, then drops it without a close frame or reason when `client_connected` throws), so the client shows the offline splash while the SDK provider's manager keeps rebuilding (backoff 1 s doubling to 30 s, up to 2 attempts a minute per open tab). Decided: keep the offline splash for now; a static status file is planned at M7. The maintenance splash and its classification are ready for it.
  - **Bundle:** the SDK and the generated bindings take the main chunk from 165 kB (55 gzip) to 457 kB (111 gzip); lazy-loading the connection layer is planned for the app shell step.
  - **Cost tables:** not subscribed yet (the module has no single active cost set). Direction: the default cost set plus the lobby's own set; final decision at the costs page port (no code now).
- **Open questions (for the user):**
  - **M5 token swap.** The provider keeps a live connection and its token; a signed-in token needs the provider unmounted for a tick (past the manager's 0 ms release) or a page reload.
  - **CSP for M7.** `connect-src` must allow `wss://maincloud.spacetimedb.com` (the socket) and `https://maincloud.spacetimedb.com` (the token exchange, `POST /v1/identity/websocket-token`, whenever a token is stored).
- **Dev helpers:** `window.__devConnection('offline' | 'maintenance' | 'reconnecting' | 'connected' | 'retry')`; the egress meter `window.__wireStats()` and its panel. Neither is in the production build (check:patterns gate 3).

## Fonts (M3)

- Self-hosted from `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` 5.3.0, latin subset only: Inter weight axis normal + italic, JetBrains Mono weight axis upright. Declared in `web/src/styles/fonts.css` under the token names `Inter` / `JetBrains Mono`.
- `font-display: swap` with metric-matched local fallbacks (`Inter Fallback` = Arial, `JetBrains Mono Fallback` = Courier New), inserted second in the two font tokens.
- Fallback metrics were measured in Chromium against the loaded web fonts: Inter is 6.81% wider than Arial on a 16px sample line, JetBrains Mono 0.02% narrower than Courier New; ascent/descent are the web fonts' hhea values (Inter 1984/494 per 2048 em, JetBrains Mono 1.02/0.30 em) divided by `size-adjust`. With them, the 16px sample line in the fallback is within 0.1% of Inter's width at the same line height.
- `font-size-adjust: from-font` (the guide's first option) is not used: during loading the fallback is the first available font, so `from-font` reads the fallback's own aspect and adjusts nothing.
