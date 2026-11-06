# Roadmap

Migration from the old repo, one step at a time with a user gate after each. Step details: `notes/migration/MIGRATION-PLAN.md` §3 (M steps) and `notes/migration/ACCESS-SECURITY-OPS.md` §D.3 (S steps), both local and gitignored. Decisions: `DECISIONS.md`.

Each executed step writes its log to `docs/log/<date>-<step>.md` (goal, decisions implemented, files changed, done-check and test results, deviations, doc checklist) and updates its Status here.

**Hard user gates** (never proceed without the user): every `spacetime publish`; the test1 wipe (S11); the first prod publish (S13); every Vercel deploy, previews included; every `git push`; any dependency not already pinned; any deviation from a decision.

| Step | What | Depends on | Status |
|---|---|---|---|
| M0 | Import `471a481`, npm-workspace layout, `.gitignore`, CLAUDE.md, skills, DECISIONS.md, `design/`, `data/seed/` | — | done 2026-11-06 (`docs/log/2026-11-06-m0.md`) |
| M1 | SDK 2.14.1, Node 26, TS 7.1 beta; regenerate bindings; `shared/` build spike | M0 | pending |
| M2 | Env scheme: `shared/stdb-targets.ts`, `scripts/stdb/*`, `init` owner/delegate, test-only reducer guards; root `tsconfig.json` covering `scripts/` (Node types) added to `npm run typecheck` | M1 | pending |
| S3 | Every schema change in one commit (A17, A19, A21, A25–A36, A45, A48 tables and columns) | M2 | pending |
| S4 | Lobby/lifecycle fixes F1–F9, paused-draft rejects, A22a referee check, A48 multi-device presence | S3 | pending |
| S5 | Abuse throttles, caps, guest kill switch, circuit breaker (A42) | S4 | pending |
| S6 | Series settings, presets and system preset, bestOf cap, cost-set guards, merged rating, Ban Restriction, new reducers (A33a, A45) | S5 | pending |
| S7 | Scoring foundation in `shared/scoring/`, tie-break chain, override authority, server-resolved eidolon (A21, A39, A43) | S6 | pending |
| S8 | Tournament partial rewrite: `shared/bracket/`, permissions, team status, single-writer advancement, finalize at Completed (A23–A36b, A38) | S7 | pending |
| S9 | Views catalogue and anonymity rules (A37, A40, A44) | S8 | pending |
| S10 | In-memory test harness and rewritten suites; `npm test` with no maincloud contact | S9 | pending |
| M3 | Vite shell: tokens, base and media CSS, fonts, standby/404 | S10 | pending |
| M4 | Router and guards (TanStack Router, typed links) | M3 | pending |
| M9 | Test strategy wiring and CI workflow | M4 | pending |
| M6 | Provider, subscription layer, dev egress meter | M9 | pending |
| M7 | `vercel.json`, CSP and headers, `.vercelignore` (A50), `robots.txt` | M6 | pending |
| M8 (preview) | New Vercel project, env per environment, first preview deploy | M7 | pending |
| M5 | Auth: link-code flow + Vercel function (A46), spike first | M8 (preview) | pending |
| M10 | Asset service worker and preloading | M5 | pending |
| S11 | Wipe test1, bootstrap, generate, live residue once (user gate) | M10 | pending |
| S12 | Contract/architecture updates, DECISIONS.md, skill refresh (A51, A52) | S11 | pending |
| S13 | First prod publish, bootstrap, lock, first admin (user gate); M8 production deploy follows | S12 | pending |
| S14.1 | Port: shell + `standby` (404, maintenance) | S13 | pending |
| S14.2 | Port: `costs` | S14.1 | pending |
| S14.3 | Port: `teambuilder` | S14.2 | pending |
| S14.4 | Port: `index` (landing, auth modal, create-lobby modal) | S14.3 | pending |
| S14.5 | Port: `profile` | S14.4 | pending |
| S14.6 | Port: `lobbies` | S14.5 | pending |
| S14.7 | Port: `lobbyroom` (Waiting stage) | S14.6 | pending |
| S14.8 | Port: `calendar` | S14.7 | pending |
| S14.9 | Port: `adminpanel` | S14.8 | pending |
| S14.10+ | Missing pages as mockups land: match flow, tournaments + bracket, leaderboard, replay viewer, editors | S14.9 | pending |
