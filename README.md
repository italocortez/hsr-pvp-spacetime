# hsr-pvp-spacetime

A drafting and match interface for the PvP modes of Honkai: Star Rail: lobbies, pick/ban and auction drafts, match results and ratings, tournaments with brackets, team building, cost tables and match-day scheduling. Data is live and multiplayer through SpacetimeDB.

## Stack

- **Web:** Vite + React 18 + TypeScript 7.1 beta, TanStack Router, CSS Modules
- **Backend:** a SpacetimeDB 2.15.0 module written in TypeScript (maincloud)
- **Hosting:** Vercel Hobby, a static site plus one auth function (Discord link)

## Status

Migration in progress from the previous repo. `ROADMAP.md` tracks which steps have landed; `DECISIONS.md` records every product and architecture decision.

## Prerequisites

- Node 26 LTS (`.nvmrc`) and npm
- SpacetimeDB CLI 2.15.0 (`spacetime version use 2.15.0`)

## Setup

```bash
npm ci
npm run typecheck
npm test
```

`npm test` never contacts maincloud. Database scripts (`npm run stdb:*`) take `--target test|prod`; secrets live in gitignored `.env.<target>.local` files (key names in `.env.example`).

## Repo map

```
web/            Vite + React app (routes, features, styles, module_bindings)
spacetimedb/    SpacetimeDB module (src/, in-memory tests)
shared/         pure TS shared by web and module (targets, scoring, bracket)
api/            the Vercel auth function
scripts/stdb/   publish, bootstrap, seed, generate, describe, backup, restore
data/seed/      public reference data (characters, light cones, synergies, achievements)
test/           live integration residue and harness, frontend screenshots
docs/           feature contracts and architecture, research, execution logs
design/         local only, gitignored (A53): design system, UI decisions, frozen mockups and assets
tools/          energy model and capture tools
```

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See `LICENSE`.
