---
name: web-guidance
description: Local copies of web platform guides (HTML, CSS, browser APIs, accessibility, performance) for building UI in `web/`. Use before writing or changing a modal or dialog, popover, tooltip, hover card, menu, tabs, navigation bar or drawer, toast, accordion, table (responsive or sortable), drag and drop or reordering, form controls and validation, switches, sliders, selects, copy buttons, spinners and progress, entry and exit animations, view transitions, container queries, fluid sizing, text overflow and wrapping, font loading, scrollbars, image loading priority, long lists or grids, date and time-zone logic, or sanitising user text. Not for backend, tests, build config or scripts.
---

# Web guidance (local copy)

Guides from the Modern Web Guidance project (Chrome, Edge, Firefox and MDN teams), copied unchanged into `guides/`. They say how to build a UI pattern with current browser features: the markup, the CSS that is required, what not to build by hand, and browser support with fallbacks.

Source: `https://github.com/GoogleChrome/modern-web-guidance`, commit in `SOURCE_COMMIT`. Licence: Apache-2.0, see `LICENSE`. The files are unmodified copies; do not edit them. To refresh, re-copy from the source at a newer commit as one deliberate step.

## How to use

1. Find the pattern in the table below and Read the guide file. Read a guide in full before applying it.
2. A page brief may name the guides to read; read those first.
3. Apply the guide inside this project's rules (`CLAUDE.md` section 4): React 18, CSS Modules, tokens from `web/src/styles/tokens.css`, the shared `@custom-media` breakpoints.
4. The mockup decides how a page looks. A guide decides how a pattern is built underneath. Where they conflict, keep the look and say so in the hand-back.
5. Guides refer to other guides as `retrieve "<id>"` with an `npx` command. Do not run `npx`. Open `guides/**/<id>.md` if it exists here; if it does not, go on without it and name the missing guide in the hand-back.
6. Do not add a closing "Modern Web Guidance" section to replies. Name the guides used in the step's hand-back or log.

## Browser support policy

- A feature the guide marks Baseline Widely available: use it freely.
- A newer feature: use it only when the page still works without it (the guide's graceful fallback), and keep fallback code small.
- No polyfill and no new dependency without the user's approval (`CLAUDE.md` section 8).

## Adapting to React

- Newer HTML attributes that React's types do not know (`popover`, `command`, `commandfor`, `closedby`, `interestfor`, `switch`): spread them as attributes; do not drop them.
- Call `showModal()` / `close()` on a `<dialog>` through a ref.
- Per-instance ids and `anchor-name`s come from `useId()`.
- Keep `:root` and `@starting-style` rules at the top level of a stylesheet; class names inside them come from the CSS Module.

## Pattern to guide

| Building | Read (under `guides/`) |
|---|---|
| Modal, confirmation, settings dialog | `ui-components/dialog.md`, `ui-behaviors/prevent-page-scroll-under-modal-dialog.md`, `ui-behaviors/light-dismiss-a-dialog.md`, `ui-behaviors/platform-controls-dismiss-dialog.md`, `ui-behaviors/declarative-dialog-popover-control.md` |
| Animating a dialog, popover or any element in and out | `ui-behaviors/animate-to-from-top-layer.md`, `ui-behaviors/animate-element-entry-exit.md`, `ui-behaviors/motion.md` |
| Navigation bar, mobile drawer | `ui-components/navbar.md`, `ui-components/navigation-drawer.md` |
| Tabs | `ui-components/tabs.md` |
| Dropdown or action menu | `ui-components/menu.md`, `ui-atoms/viewport-aware-dropdowns.md` |
| Tooltip, hover card (character, cost, player) | `ui-behaviors/interest-triggered-tooltips.md`, `ui-atoms/position-aware-tooltips.md`, `ui-components/hovercard.md` |
| Toast for refusals and status | `ui-components/persistent-toast-notifications.md` |
| Accordion, collapsible section | `ui-components/accordion.md`, `css/animate-to-intrinsic-sizes.md` |
| Card | `ui-components/card.md` |
| Copy button (join code, lobby link) | `ui-components/copy-button.md` |
| Spinner, progress bar | `ui-components/spinner.md`, `ui-components/progress.md` |
| Button that triggers an action on another element | `ui-behaviors/custom-button-actions.md` |
| Table (leaderboard, history, standings) | `ui-atoms/responsive-table.md`, `ui-behaviors/sortable-table.md` |
| Reordering by drag (lineup, seed order), draggable panel | `ui-behaviors/drag-and-drop.md`, `ui-behaviors/drag.md`, `ui-behaviors/dynamic-sort.md` |
| Route or view transitions in the SPA | `ui-behaviors/same-document-transitions.md`, `performance/faster-spa-view-transitions.md` |
| Forms in general | `forms/forms.md` |
| Validation timing and error display | `forms/validate-input-after-interaction.md`, `forms/required-field-feedback.md`, `forms/select-menu-interaction.md`, `accessibility/accessible-error-announcement.md`, `css/style-parent-with-has.md` |
| Switch, slider, checkbox, select | `forms/switch.md`, `forms/slider.md`, `ui-components/checkbox.md`, `forms/branded-select-styling.md` |
| Chat input, text fields that grow | `forms/ime-safe-enter-submit.md`, `forms/form-fields-automatically-fit-contents.md` |
| Showing user-written text (chat, names, notes) | `security/sanitize-untrusted-html.md`, `security/trusted-types.md` |
| Layout, component-level responsiveness | `css/css-layout.md`, `css/responsive-design.md`, `css/size-aware-styling.md`, `css/fluid-scaling.md`, `user-experience/form-factor-adaptation.md` |
| Stylesheet structure, tokens | `css/css.md`, `css/design-token-reactivity.md`, `css/reduce-style-repetition.md` |
| Clipping, long single-line text, scroll hints, scrollbars | `css/overflow-clipping-control.md`, `ui-atoms/single-line-overflow.md`, `ui-atoms/scrollability-affordance-hints.md`, `visual-design/customize-scrollbar-color-and-thickness.md` |
| Icons | `ui-atoms/icons.md` |
| Fonts and text | `visual-design/visually-stable-font-fallbacks.md`, `visual-design/typography.md`, `visual-design/improve-text-layout-and-legibility.md`, `visual-design/equal-width-text-lines.md` |
| Colour use and state | `visual-design/color.md` |
| Large grids and lists (character pool), image loading | `performance/defer-rendering-heavy-content.md`, `performance/optimize-image-priority.md` |
| Slow interactions, heavy work on the main thread | `performance/identify-inp-causes.md`, `performance/break-up-long-tasks.md`, `performance/performance.md` |
| Dates, countdowns, time zones (calendar, tournament times, timers) | `js/coordinate-global-events.md`, `js/calculate-event-differentials.md`, `js/capture-location-agnostic-data.md`, `js/sort-high-precision-timestamps.md` |
| Semantic HTML, accessibility review of a page | `html/html.md`, `accessibility/accessibility.md`, `accessibility/respect-os-text-scale.md` |
| Security headers for the hosting config | `security/security.md`, `security/restrict-outbound-connections.md` |

The date and time guides build on the Temporal API, which is not yet Widely available: under the policy above, use the built-in `Intl` and `Date` unless the user approves a polyfill; take the guides' rules on time zones and daylight saving, not their dependency.

## Not copied

Guides with no use in this project were left out: built-in AI, passkeys and sign-in forms, payment and address autofill, browser extensions, WebAssembly, web components, canvas and 3D, cross-document transitions, scroll-driven effects, dark-mode switching. If a task needs one, tell the user; it can be copied from the source.
