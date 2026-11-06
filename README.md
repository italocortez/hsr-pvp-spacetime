# hsrpvp-spacetimedb

A drafting interface for different PvP modes for the game Honkai Star Rail.

Built with **Next.js**, **SpacetimeDB**, and **NextAuth** (Discord OAuth).

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [npm](https://www.npmjs.com/)
- [SpacetimeDB CLI](https://spacetimedb.com/docs/getting-started)
- [Rust](https://rustup.rs/) (required by SpacetimeDB CLI)
- A [Discord application](https://discord.com/developers/applications) for OAuth

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in:

- `NEXT_PUBLIC_SPACETIMEDB_DB_NAME` / `SPACETIMEDB_DB_NAME` — your database name
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` — from your Discord app
- `NEXTAUTH_SECRET` — a random string (generate with `openssl rand -base64 32`)
- `NEXTAUTH_URL` — `http://localhost:3000` for local dev

### 3. Login to SpacetimeDB

```bash
spacetime login
```

### 4. Publish the SpacetimeDB module

```bash
spacetime publish <your-db-name> --module-path spacetimedb
```

### 5. Generate client bindings

```bash
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb
```

### 6. Register the server identity

This creates a trusted identity for the Next.js API server (used for anti-spoofing on Discord account linking).

```bash
npx tsx scripts/register-server.ts
```

Copy the printed `SPACETIMEDB_SERVER_TOKEN=...` value into your `.env.local`.

> This only needs to be run once per database. If you clear-publish the database, you'll need to run it again.

### 7. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Common Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js dev server |
| `spacetime publish <db-name> --module-path spacetimedb` | Publish module (keeps data) |
| `spacetime publish <db-name> --clear-database -y --module-path spacetimedb` | Clear database and republish |
| `spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb` | Regenerate client bindings |
| `spacetime logs <db-name>` | View server-side logs |
| `npx tsx scripts/register-server.ts` | Register server identity (once per database) |
| `npx tsx scripts/manage-user.ts set-role <username> <role>` | Change a user's role (Admin, TournamentHost, User) |
| `npx tsx scripts/manage-user.ts delete <username>` | Delete a user |

## Using Game Data

`GameDataProvider` (in `features/game-data/components/GameDataProvider.tsx`) subscribes to the following SpacetimeDB tables globally via `useTable()`:

| Table | Field in context | Type |
|-------|-----------------|------|
| `HsrCharacter` | `characters` | `HsrCharacterRow[]` |
| `HsrLightcone` | `lightcones` | `HsrLightconeRow[]` |
| `HsrCharacterCost` | `characterCosts` | `HsrCharacterCostRow[]` |
| `HsrLightconeCost` | `lightconeCosts` | `HsrLightconeCostRow[]` |
| `HsrSynergyCost` | `synergyCosts` | `HsrSynergyCostRow[]` |

Since the provider wraps the entire app (in `app/providers.tsx`), the data is available on every page. The arrays are kept in sync with the server in real-time — whenever a row is inserted, updated, or deleted on the backend, the corresponding array updates automatically and the component re-renders with the new data. **Do not gate rendering behind a loading flag**, as that would flash a loading state on every server update. Instead, just render the data directly and let empty arrays handle the initial state naturally:

```tsx
import { useGameData } from '@/features/game-data/components/GameDataProvider';

export default function MyComponent() {
  const { characters } = useGameData();

  // No loading gate — renders an empty list initially,
  // then fills in automatically as data arrives and stays in sync.
  return (
    <ul>
      {characters.map((c) => (
        <li key={c.name}>{c.displayName} — {c.element.tag} / {c.path.tag}</li>
      ))}
    </ul>
  );
}
```

You can destructure only the tables you need:

```tsx
// Only need lightcones
const { lightcones } = useGameData();

// Only need costs
const { characterCosts, synergyCosts } = useGameData();
```

> `isReady` is still available if you need to distinguish "no data yet" from "genuinely empty table" (e.g. showing a skeleton on first load). But most components should just render the arrays directly.

> **Note:** Do NOT call `useTable(tables.HsrCharacter)` directly in components — use `useGameData()` instead to avoid duplicate subscriptions.

## v0.5 Roadmap — Backend Milestone

Backend-only milestone: all SpacetimeDB tables, reducers, helpers, and edge case handling. No frontend UI in scope — that's v1.

| # | Phase | Goal | Key Requirements |
|---|-------|------|------------------|
| 1 | **Schema Foundation** | All enums, structs, and table schemas defined before any reducer | TournamentStage, TournamentFormat, MatchResultStatus, ValidationStatus, DisconnectPolicy, RecurrenceType, RosterVisibility enums; Score, RecurrenceRule, EloConfig structs |
| 2 | **Roster Management** | Players record owned characters/lightcones with server-enforced visibility | Multi-account support, eidolon/superimposition levels, public/private visibility (overridden by tournament settings), account rating |
| 3 | **Tournament System** | Tournament lifecycle, teams, registration, referees | TO role approval, single/double elim + group phase formats, self-signup + team signup, referee assignment, coach role, anonymous/roster/disconnect settings |
| 4 | **Bracket Generation** | Pre-generated bracket rows with FK advancement | Single elim, double elim (winners + losers brackets), group phase round-robin, auto-advance on confirmed result, manual + MMR seeding |
| 5 | **Match Results & MMR** | Score submission, screenshot verification, ELO in one transaction | Game-mode-specific scoring (cycles/score), Imgur screenshots, mutual confirm (casual) / ref validation (tournament), tiered K-factor ELO, per-mode + global MMR, leaderboard |
| 6 | **Anonymous Play & Stats** | Server-enforced anonymous mode + full player statistics | Anonymous labels at write layer (not UI), per-player win/loss/character stats, Best Ally/Nemesis, match replay support |
| 7 | **Achievements & Titles** | Achievement definitions, auto-award, profile titles | Admin-defined criteria, auto-trigger on match validation, manual award by admin/TO, selectable profile title |
| 8 | **Calendar & Scheduling** | Recurring availability, shared calendars, auto-sync | Daily/weekly/monthly recurrence, 5-player calendar view, common availability finder, event invites, TO scheduling |
| 9 | **Mouse/Chat/Lobby** | Cursor broadcast, ephemeral chat, lobby browser | Full XY cursor for all roles (coach can view only), event-table chat with cleanup, lobby filtering by mode/status |
| 10 | **Disconnect & Cost** | Configurable disconnect behavior + cost table parity | Pause/timer/forfeit policy, rejoin logic, liveness guards in every pick/ban reducer, lightcone gameMode composite key |

**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10

## Project Structure

```
├── app/                    # Next.js app router (route groups: landing-page, lobby, game, admin)
├── features/               # Feature modules (auth, profile, lobby, etc.)
├── lib/                    # Shared utilities (spacetimedb client/server config)
├── src/module_bindings/    # Generated SpacetimeDB client bindings (do not edit)
├── spacetimedb/            # SpacetimeDB server module
│   └── src/
│       ├── schema.ts       # Table definitions
│       ├── index.ts        # Reducer exports + lifecycle hooks
│       ├── tables/         # Table definitions (User, UserIdentity, Lobby, etc.)
│       ├── reducers/       # Reducers (auth, profile, server, lobby, cursor, etc.)
│       ├── helpers/        # Shared helpers (permissions, etc.)
│       └── types/          # Shared types (enums, structs)
├── scripts/                # Setup & admin scripts (register-server, manage-user)
└── .env.example            # Template for environment variables
```