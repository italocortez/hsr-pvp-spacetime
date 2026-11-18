# Legacy reference folder removed (2026-11-17)

## Goal

Delete `web/src/lib/legacy/`, the verbatim reference copies from the old Next.js app, now that the features that used them (team builder, costs page) are ported, and remove the configuration that existed only to exclude it.

## Decision

The user, 2026-11-17: "i agree on deleting the legacy folder".

## Search before deleting

No file in `web/`, `shared/`, `spacetimedb/`, `api/`, `scripts/` or `test/` imported or read the folder. The only references were the four exclusions listed below, one comment, and two doc mentions.

## Files deleted

- `web/src/lib/legacy/DataHelpers.ts`
- `web/src/lib/legacy/LoadoutManager.ts`
- `web/src/lib/legacy/README.md`
- `web/src/lib/legacy/types/enums.ts`
- `web/src/lib/legacy/types/structs.ts`
- `web/src/lib/legacy/types/tableColumns.ts`

## Config lines removed

| File | Removed |
|---|---|
| `web/tsconfig.json` | `"exclude": ["src/lib/legacy/**"]` (its only entry, so the key went) |
| `web/vitest.config.ts` | `'src/lib/legacy/**'` from `test.exclude` (`src/module_bindings/**` kept) |
| `biome.json` | `"!web/src/lib/legacy/**"` from `files.includes` |
| `scripts/ci/check-patterns.mjs` | the `web/src/lib/legacy/` skip in gate 1 and its mention in the comment (bindings skip kept) |
| `scripts/ci/lint.mjs` | `lib/legacy` in the header comment |

## Docs

- `docs/frontend/component-hygiene.md`: the `web/src/lib/` row now says the reference copies were removed on 2026-11-17 by the user's ruling.
- `docs/frontend/pages.md`: the pointer to `LoadoutManager.ts` dropped from the "Not read" line.

## Checks

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint:ci` | pass (1 pre-existing warning in `shared/bracket/engine.test.ts`) |
| `npm test` | unit 1029; module 2313 passed, 1 skipped, 15 todo; web 1336 (unchanged) |
| `npm run test:web -- --no-fsModuleCache` | 1336 passed |
| web build (`VITE_STDB_TARGET=test`) | pass; entry chunk 177.14 kB (unchanged) |
| `npm run check:patterns` | all eleven gates pass |

## Doc checklist

| Folder | Answer |
|---|---|
| `docs/frontend/` | component-hygiene and pages updated (see above) |
| feature `architecture.md` / `contract.md` | skip: no backend or behaviour change |

## Usage (harness figures)

| Phase | Agent | Tokens | Tool calls | Time |
|---|---|---|---|---|
| Build | Opus | 66,443 | 26 | 2 min |

Verified by the orchestrator: typecheck and lint; the implementer ran the full suites, the build and the eleven pattern gates (unit 1029; module 2313 passed, 1 skipped, 15 todo; web 1336; entry chunk unchanged). Left open: the spacetimedb skill file still describes the folder (lines 234 and 717), together with other stale lines about the frontend; for the doc clean-up step.
