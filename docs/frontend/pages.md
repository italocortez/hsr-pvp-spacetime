# Pages

One entry per ported page: route, files, mockup, breakpoint snaps, guides used, Safari notes. Shared building blocks are listed once, under the first page that introduced them.

## Standby (M3)

- **Route:** `/` and `/standby` (temporary path switch in `web/src/App.tsx` until M4). Query `?module=<name>` shows the champagne module pill and sets the title to `<name> — Standby — IPC Battlegrounds`; the name is rendered as text only and cut to 40 code points (a surrogate pair is never split). The pill reads "Requested module: <name>" to screen readers through a visually hidden ": ".
- **Files:** `web/src/pages/standby/StandbyPage.tsx`, `StandbyPage.module.css` (module pill only), `useRequestedModule.ts`; shared `web/src/components/SplashLayout/` (art, scrims, brand, HUD chip slot, text column, CTA, bottom HUD), `BrandLogo/`, `HudChip/`, `IpcButton/`; `web/src/lib/useDocumentTitle.ts`. Art: `web/public/standby.webp` (identical to `design/assets/standby.webp`).
- **Mockup:** `design/mockups/standby.html`.
- **Breakpoint snaps:** 960px to `--bp-lg` (1040), 540px to `--bp-sm` (560). Neither breaks at the snapped width; no page-local media.
- **Deviations from the mockup:** font sizes in `rem` (same px at the default root size); `min-block-size` instead of a fixed CTA height; the CTA fill and ring are clipped pseudo-elements so the element's focus ring is not clipped; `100dvh` instead of `100vh`; the brand link's accessible name is `aria-label="IPC Battlegrounds"` (its visible text) instead of "Return home"; the HUD dot pulse runs only under `prefers-reduced-motion: no-preference`; body `line-height: 1.5` (the mockup leaves the browser default); `text-wrap: balance` on the headline and `text-wrap: pretty` on the lede; body `overflow-x: clip` instead of `hidden`.
- **Mockup defects fixed here** (M3 review):
  - Brand word and HUD chip touched or overlapped below about 390px (1px gap at 375, overlap at 360 and 320; the longer 404 chip touched at 390). At `--bp-xs` (480) and below the brand word is hidden; the logo mark stays and the link keeps its name. Measured brand-to-chip gap, standby / 404: 320: 111 / 95px, 360: 151 / 135px, 375: 166 / 150px, 390: 181 / 165px.
  - At `--bp-lg` on short screens (844 x 390 landscape) the text column slid under the brand. `.overlay` now has 88px top padding there; short screens scroll.
  - The bottom HUD showed two separators in a row at `--bp-sm` once the coordinate was hidden; its separator now hides with it.
  - The module pill broke mid-word at 320px ("TOURNAMEN / TS"). It now wraps between label and name (`flex-wrap: wrap`), and the name uses `overflow-wrap: break-word`.
  - The mockup's `*::before` / `*::after` box-sizing applies again (an earlier `:where()` wrapper dropped the pseudo-elements and enlarged the CTA arrow head).
- **Guides used:** `css/css.md`, `css/design-token-reactivity.md`, `css/responsive-design.md`, `visual-design/visually-stable-font-fallbacks.md`, `visual-design/typography.md`, `html/html.md`, `accessibility/accessibility.md`, `ui-behaviors/motion.md`.
- **Safari notes:** `text-wrap: balance | pretty` and `dvh` degrade to normal wrapping and `vh`-like sizing on older Safari. Safari does not support `ascent-override`, `descent-override` or `line-gap-override`, so there the fallback fonts are width-matched only (`size-adjust`) and line boxes may shift slightly when the web font arrives. Only the latin subset is loaded (all browsers): characters outside it render in the fallback.

## Not found (M3)

- **Route:** any path other than `/` and `/standby`. Title `<What> not found — IPC Battlegrounds`.
- **Files:** `web/src/pages/not-found/NotFoundPage.tsx` (no CSS of its own: it renders `SplashLayout`). Art: `web/public/standby.webp`, shown exactly as on standby (user ruling, M3): the 404 screens share the standby art and only the wording changes.
- **Wording prop:** `what?: string`, default `"Page"`, names the missing thing. It fills the headline ("<What> *not found.*"), the title, and the lede ("The IPC has no record of this <what in lower case>. Check the link, or head back to base."). The default page case keeps "this route" in the lede. Eyebrow `Error // 404`, chip `SYS://NO SIGNAL`, bottom HUD and the CTA back to `/` do not change.
- **Mockup:** none; same pattern as standby.
- **Unused asset:** `web/public/not-found-image.webp` (a grey "No image available" placeholder) is no longer referenced; removing it is left to the user.
- **Contrast** equals standby's, since art and scrims are the same. Worst case (text colour against the brightest art pixel behind each element, text shadows not counted), 404 / standby: at 1440, brand word 3.22 / 3.22, HUD chip 2.89 / 2.89, eyebrow 2.37 / 2.34, lede 3.69 / 3.54; at 390, HUD chip 1.39 / 1.44, eyebrow 4.17 / 3.68, lede 9.28 / 8.99. These small-text values are below 4.5:1 on both pages; the mockup's multi-layer text shadows carry the legibility. This is a property of the standby design, not of the 404 page, and is open for a later design pass.

## Fonts (M3)

- Self-hosted from `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` 5.3.0, latin subset only: Inter weight axis normal + italic, JetBrains Mono weight axis upright. Declared in `web/src/styles/fonts.css` under the token names `Inter` / `JetBrains Mono`.
- `font-display: swap` with metric-matched local fallbacks (`Inter Fallback` = Arial, `JetBrains Mono Fallback` = Courier New), inserted second in the two font tokens.
- Fallback metrics were measured in Chromium against the loaded web fonts: Inter is 6.81% wider than Arial on a 16px sample line, JetBrains Mono 0.02% narrower than Courier New; ascent/descent are the web fonts' hhea values (Inter 1984/494 per 2048 em, JetBrains Mono 1.02/0.30 em) divided by `size-adjust`. With them, the 16px sample line in the fallback is within 0.1% of Inter's width at the same line height.
- `font-size-adjust: from-font` (the guide's first option) is not used: during loading the fallback is the first available font, so `from-font` reads the fallback's own aspect and adjusts nothing.
