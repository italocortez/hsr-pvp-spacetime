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

- **Route:** any path the route tree does not match (the router's `defaultNotFoundComponent`). Title `<What> not found — IPC Battlegrounds`.
- **Files:** `web/src/pages/not-found/NotFoundPage.tsx` (no CSS of its own: it renders `SplashLayout`). Art: `web/public/standby.webp`, shown exactly as on standby (user ruling, M3): the 404 screens share the standby art and only the wording changes.
- **Wording prop:** `what?: string`, default `"Page"`, names the missing thing. It fills the headline ("<What> *not found.*"), the title, and the lede ("The IPC has no record of this <what in lower case>. Check the link, or head back to base."). The default page case keeps "this route" in the lede. Eyebrow `Error // 404`, chip `SYS://NO SIGNAL`, bottom HUD and the CTA back to `/` do not change.
- **Mockup:** none; same pattern as standby.
- **Unused asset:** `web/public/not-found-image.webp` (a grey "No image available" placeholder) is no longer referenced; removing it is left to the user.
- **Contrast** equals standby's, since art and scrims are the same. Worst case (text colour against the brightest art pixel behind each element, text shadows not counted), 404 / standby, after the A168 top-bar scrim: at 1440, brand word 8.76 / 8.80, HUD chip 6.80 / 6.80, eyebrow 2.37 / 2.34, lede 3.69 / 3.54; at 390, HUD chip 4.78 / 4.93, eyebrow 4.17 / 3.68, lede 9.28 / 8.99. The eyebrow and the 1440 lede stay below 4.5:1 on both pages, where the mockup's multi-layer text shadows carry the legibility; open for a later design pass.

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
| `_admin.tsx` | layout | Moderator and above | `<Outlet />` |
| `_admin/admin.tsx` | `/admin` | Moderator and above | standby, module "Admin Console" |

Profile sub-routes (achievements, roster, stats, replays) come with the profile page.

**Guards** (`web/src/auth/guards.ts`, run in the layouts' `beforeLoad`; UX only, the module is the authority):

- Auth comes from `web/src/auth/authStore.ts`: `{ ready, user?: { id, role, isGuest } }`. Until M6 it is a ready visitor (no user). `App.tsx` passes it as router context and calls `router.invalidate()` when it changes, so the guards re-run (a member signed out on `/profile` lands on `/?login=1&next=%2Fprofile`).
- Not ready: the guard lets the route through and the layout renders nothing (the void background) until ready.
- `_authed`: no user goes to `/?login=1&next=<path>`. Guests count as signed in.
- `_admin`: as `_authed`; a user below Moderator goes to `/` with no search. Role order mirrors the module (`web/src/auth/roles.ts`, from `spacetimedb/src/helpers/identity/ensurePermissions.ts`).

**The `next` rule** (`safeNextPath` in `web/src/auth/loginSearch.ts`): kept only when it is a string of at most 2048 characters that starts with `/` and not `//`, and contains no control character (U+0000 to U+001F, U+007F) and no backslash anywhere. Browsers strip tab, CR and LF from URLs (`/<TAB>/host` becomes `//host`) and read `\` as `/`, hence the last two conditions. Anything else is dropped from the validated search, and the router rewrites the address bar itself when a validator returns `undefined` for a key that was present (`/?next=https://evil.example` becomes `/`, `/?login=1&next=/%5Cevil.example` becomes `/?login=1`). Validators always return their keys (possibly `undefined`): the router merges the raw search under the validated one, so an omitted key would let the rejected raw value through.

**Unknown search keys** are kept in the URL and in the merged search, so `useSearch()` is not an allow-list: read only the keys a route's validator returns.

**Placeholders**: every route not built yet renders `StandbyPage` with its module name; the page is replaced when its step lands. Unknown paths render `NotFoundPage` through `defaultNotFoundComponent` (no `$.tsx` catch-all: unmatched paths already reach it).

**Dev helper**: in dev only, `window.__devAuth('visitor' | 'guest' | 'member' | 'moderator' | 'admin' | snapshot)` sets the auth snapshot to check the guards before login (M5) and the connection (M6). It is not in the production build (`rg __devAuth web/dist` finds nothing).

**Known quirk**: the default search serialisation is JSON. A numeric `?module=123` or boolean `?module=true` on `/standby` is rewritten to `?module=%22123%22` / `?module=%22true%22` (the router re-serialises the validated string as JSON); the pill still shows `123` / `true`. `?module=null` and object values (`?module={"a":1}`) are dropped.

**For M5 and M6:**

- Re-run `safeNextPath` at the moment of use, not only in the validator.
- Navigate to `next` only through the router (`router.navigate` / `redirect`), never `window.location` or a raw href.
- Validate `next` again after the Discord round trip, and in the auth function before it writes any `Location` header.
- Pages under a guard must tolerate one render without a user after sign-out (the redirect follows the invalidate).
- Loaders under `_authed` must not assume a user while auth is not ready (the guard lets them through then).
- Set a neutral document title while auth is not ready (the layout renders nothing, so the previous page's title stays).
- The lobby route should validate `$lobbyId` and show `NotFoundPage` with `what="Lobby"` for a bad one.
- Decide the search serialisation (JSON default or plain strings) before the first real page with search params.

## Fonts (M3)

- Self-hosted from `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` 5.3.0, latin subset only: Inter weight axis normal + italic, JetBrains Mono weight axis upright. Declared in `web/src/styles/fonts.css` under the token names `Inter` / `JetBrains Mono`.
- `font-display: swap` with metric-matched local fallbacks (`Inter Fallback` = Arial, `JetBrains Mono Fallback` = Courier New), inserted second in the two font tokens.
- Fallback metrics were measured in Chromium against the loaded web fonts: Inter is 6.81% wider than Arial on a 16px sample line, JetBrains Mono 0.02% narrower than Courier New; ascent/descent are the web fonts' hhea values (Inter 1984/494 per 2048 em, JetBrains Mono 1.02/0.30 em) divided by `size-adjust`. With them, the 16px sample line in the fallback is within 0.1% of Inter's width at the same line height.
- `font-size-adjust: from-font` (the guide's first option) is not used: during loading the fallback is the first available font, so `from-font` reads the fallback's own aspect and adjusts nothing.
