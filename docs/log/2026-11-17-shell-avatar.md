# Shell: the account disc centred in its slanted panel

**Date:** 2026-11-17 · **Step:** shell fix (no step id) · **Tests:** none changed (CSS only)

## Goal

On phones the signed-in account chip at the bar's right end showed its initial disc off-centre in the slanted panel. Centre it, with no change to the bar's height, the chip's size or the touch target.

## The user's words (2026-11-17)

"just 1 small fix on mobile on the nav bar, as you can see, the N that shows that I'm logged in is not actually center aligned, just need that center aligned."

## How it was reproduced

Dev server on 5205, Edge through `playwright-cli`, `/teambuilder`, `*.ufs.sh` blocked. The member state comes from the dev hook `window.__devAuth({ ready: true, user: { …, isGuest: false, displayName } })` (`web/src/auth/devAuth.ts`), applied after the real (visitor) snapshot settled. Measured in the page with `getBoundingClientRect`; the letter's ink with canvas `measureText` in the disc's computed font (JetBrains Mono 700 13px, loaded). Close-ups at 4x device scale.

"Visible centre" is the middle of the panel at mid-height: the 18px slant hides 9px of the left edge there, and the right edge is the screen edge.

## Measurements (disc centre minus target; negative is left or up)

| Width | Chip (w x h) | Disc vs bar centre (above the 6px band), before / after | Disc vs visible panel centre, before / after | Disc and name vs visible centre, before / after |
|---|---|---|---|---|
| 360 | 71 x 44 | 0 / 0 | -8 / 0 | (name hidden) |
| 390 | 71 x 44 | 0 / 0 | -8 / 0 | (name hidden) |
| 470 | 71 x 44 | 0 / 0 | -8 / 0 | (name hidden) |
| 560 | 71 x 44 | 0 / 0 | -8 / 0 | (name hidden) |
| 561 | 162 x 50 | 0 / 0 | n/a | -12 / 0 |
| 1440 | 162 x 50 | 0 / 0 | n/a | -12 / 0 |

Letter ink centre against the disc centre (all widths, same font): N +0.1 / -0.5, W -0.4 / -0.5, I -0.4 / -0.5, `?` +0.1 / -0.5, `ß` (kept lower case by `initialOf`) +0.1 / -0.5 (x / y px). Sub-pixel: left as is. A lower-case letter with a descender would sit 2px low, but `initialOf` upper-cases every letter whose capital is one character, so it does not occur in practice.

Visitor "Sign in": padding 26/18 (phones) and 40/32 (wider) already puts the label within 0.5px of the visible centre: unchanged.

## What changed

- `web/src/shell/AccountArea.module.css`, `.chipInner`: padding `0 var(--chip-end) 0 calc(var(--chip-end) + 9px)`, `--chip-end` 18px (14px below 560px). Before: `0 30px 0 15px`, phones `0 22px 0 15px` (the mockups). Sums unchanged, so the chip keeps 71px (phones) and its width beside the name (wider).
- Desktop had the same fault (disc and name 12px left of the visible centre), so it is fixed too: the content moves 12px right inside the same chip.
- `docs/frontend/pages.md`, Shell, account area: one line on the rule.

## Done-check

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint:ci` | pass |
| `npm test` | unit 1029 passed; module 2313 passed, 1 skipped, 15 todo; web 1336 passed |
| `npm run test:web -- --no-fsModuleCache` | 68 files, 1336 passed |
| Browser | Edge, 360 / 390 / 470 / 560 / 561 / 1440; `*.ufs.sh` blocked in every run, 0 completed |

Screenshots (local only): `tmp/pw/shell-avatar/{before,after}-bar-{390,470,1440}.png`, letter close-ups `*-letter-{W,I}-*.png`, visitor `*-visitor-*.png`; `test/frontend/screenshots/shell/bar-member-390.png`.

## Deviations

None.

## Doc checklist

| Folder | Answer |
|---|---|
| `docs/frontend/` | `pages.md` (Shell, one line) |
| other `docs/<feature>/` | skip: no backend change |

## Usage (harness figures)

| Phase | Agent | Tokens | Tool calls | Time |
|---|---|---|---|---|
| Build | Opus | 110,567 | 55 | 6 min |

Verified by the orchestrator: typecheck, lint, the web suite with a cold cache (1336), and the enlarged after-screenshot at 470 px. CSS only; no test changed.
