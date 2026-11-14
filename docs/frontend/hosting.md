# Hosting (M7)

Vercel Hobby, static site, CLI deploys only (A5, A50). This page covers `vercel.json`, `.vercelignore`, `web/public/robots.txt` and the maintenance status file `web/public/status.json`. Nothing here is deployed yet: the preview runs on this machine (M8, see "Local preview"); the login function (M5b) runs locally through the dev and preview servers, see "Login function (M5b)".

## `vercel.json` (repo root)

| Block | Value | Why |
|---|---|---|
| `framework` | `null` | plain static output; no framework preset guesses the build |
| `installCommand` | `npm ci` | the lockfile is the source of truth |
| `buildCommand` | `npm run build -w web` | Vite build of the `web` workspace (needs `VITE_STDB_TARGET`, see CLAUDE.md §5) |
| `outputDirectory` | `web/dist` | Vite's output |
| `functions` | **left out (M5b decision)** | Vercel builds every file under `api/` as a function without configuration; the block only sets per-function options (memory, duration, included files). Worst case of the callback: three outbound calls in a row (Discord token, Discord user, the module), each with a 5 s timeout, so up to 15 s plus the function's own time; start makes none. The plan's default duration limit for a function is **unverified** (it must be above 15 s, or the callback can be cut off before it answers); check it at the first deploy and add a `maxDuration` entry only if needed. The Node version comes from `engines.node` in the root `package.json` (`26.x`); whether Vercel offers Node 26 for functions is unverified until the first deploy. |
| `rewrites` | see below | client-side routes load the app |
| `headers` | see below | caching and security headers |

### Rewrite rule

```
/((?!api/|assets/|sw\.js|robots\.txt|favicon|status\.json)(?!(?:.*/)?\.)(?!.*\.[^/]*$).*)  to  /index.html
```

Vercel checks the filesystem first, so an existing file is always served as itself; the rewrite only handles paths with no file. The negative lookahead keeps these paths out of it, so a missing one is a real 404 instead of the HTML page:

- `/api/`: the login function (`/api/auth/discord/start`, `/callback`, M5b);
- `/assets/`: hashed build files. A missing hashed file must be a 404: an HTML answer to a script request breaks the page with a MIME error instead of a clear failure;
- `/sw.js`, `/robots.txt`, `/favicon*`, `/status.json`: fixed files whose absence must be visible (a missing status file answered with HTML would still fail open, but the 404 is the honest answer);
- any path whose last segment has a file extension (`/foo.png`, `/elements/missing.webp`): a missing static file is a 404, not the page with 200;
- any path with a segment that starts with a dot (`/.env`, `/.well-known/security.txt`, `/.git/config`).

Deep links (`/lobby/123`, `/standby`, `/costs`) still load the app. Limit: a future route whose last segment can hold a dot (a user name like `/u/john.doe`, a lobby id like `1.5`) would 404 and needs its own rewrite.

### Cache rules

| Path | `Cache-Control` | Why |
|---|---|---|
| `/assets/(.*)` | `public, max-age=31536000, immutable` | file names carry a content hash; Vercel applies `immutable` on its own only to Next.js paths, so the rule is needed |
| `/sw.js` | `public, max-age=0, must-revalidate` | a stale worker would outlive a deploy |
| `/index.html` | `public, max-age=0, must-revalidate` | it names the current hashed assets. Paths rewritten to it (`/lobby/123`) get Vercel's default for static files, which is the same value |
| `/status.json` | `no-store` | see "Maintenance status file" |
| everything else | Vercel default (`public, max-age=0, must-revalidate`) | images in `web/public/`, `robots.txt`, the favicon |

The cache rules do not overlap, so no rule depends on which of two values wins.

### Security headers (every path)

| Header | Value |
|---|---|
| `Content-Security-Policy` | table below |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

### Content Security Policy

| Directive | Sources | Reason per source |
|---|---|---|
| `default-src` | `'self'` | anything not listed below comes only from the site |
| `script-src` | `'self'` | the built bundle; `web/dist/index.html` has no inline script (check:patterns gate 8) |
| | `'unsafe-eval'` | the SDK builds its BSATN codecs with `Function(...)` (`spacetimedb` 2.15.0 `src/lib/algebraic_type.ts` lines 466 to 786; 12 such calls in the built main chunk, plus one for a Node-only `import()` that the browser never reaches). Without it, building the connection throws `EvalError` and the page renders nothing (checked, M7 log) |
| `style-src` | `'self'` | the built CSS files |
| | `'unsafe-inline'` | kept from the plan (Chart.js not checked yet). Today's app works without it: see Proposals |
| `img-src` | `'self'` | `web/public/` images |
| | `data:` `blob:` | kept from the plan: inline and generated images (none in the app yet) |
| | `https://*.ufs.sh` | media on UploadThing (A15) |
| | `https://cdn.discordapp.com` | Discord avatars (M5) |
| `font-src` | `'self'` | self-hosted fonts (no Google Fonts, check:patterns gate 4) |
| `connect-src` | `'self'` | `/status.json` and the login function's `POST /api/auth/discord/start` (M5b: no change needed; the navigation to Discord is a top-level `location.assign`, which no directive restricts, and Discord's redirect back is a top-level navigation to the site) |
| | `wss://maincloud.spacetimedb.com` | the SpacetimeDB socket |
| | `https://maincloud.spacetimedb.com` | the token exchange (`POST /v1/identity/websocket-token`) whenever a token is stored |
| | `https://*.ufs.sh` | the service worker's CORS fetches of UploadThing media (M10) |
| `worker-src` | `'self'` | `/sw.js` |
| `manifest-src` | `'self'` | a future web manifest |
| `frame-ancestors` | `'none'` | no site may frame this one (clickjacking) |
| `base-uri` | `'self'` | no injected `<base>` |
| `form-action` | `'self'` | forms post only to the site |
| `object-src` | `'none'` | no plugins |

`check:patterns` gate 9 fails when `vercel.json` does not parse or is not an object; when an entry of `headers` or `rewrites` is malformed; when no header rule, or more than one, sets a CSP, or the one that does is not `/(.*)` or carries a `has` or `missing` condition; when a CSP directive appears twice; when `script-src` lacks `'unsafe-eval'`; when `connect-src` lacks either maincloud origin (directives, keywords and origins compared without case); when `/status.json` is not served `no-store` or its rule has a `has` or `missing` condition; when a top-level `routes` key exists; when the index rewrite has a `has` or `missing` condition; when a rewrite before the index rewrite takes `/lobby/123`; and when the rewrites to `/index.html` do not behave as documented, tested as a RegExp against a table (`/` and `/lobby/123` must match; `/assets/x.js`, `/status.json`, `/foo.png`, `/.env`, `/api/x`, `/sw.js`, `/favicon.svg`, `/a/.b/c` must not). Gate 8 checks `<script>` tags only (not inline event handlers or `javascript:` URLs): HTML comments are dropped, each tag's attributes are parsed, and a script without a non-empty `src` is inline (so `<script title="a src=b">` and `src=""` count); `application/ld+json` data blocks, with or without parameters, are allowed. `vite dev` sends none of these headers.

Gate 9 does not check: rewrite sources with named parameters (`:id`, `:path*`), which its pattern reader does not support; later header rules overriding `Cache-Control` for a path; `redirects`; cleanUrls, trailingSlash and other top-level options.

## `.vercelignore`

Excludes, per A50: `docs/`, `design/`, `test/`, `notes/`, `backups/`, `tools/`, `spacetimedb/`, `data/`, `.planning/`, `.claude/`, and `*.md` outside `web/`. Added at M7: `tmp/`, `scripts/` (the web build does not use it; the root `package.json` has no install script), `.github/`, `.vscode/`, `.playwright-cli/`, `.playwright/`, `.mcp.json`, `web/dist/`, and every `.env*` file except the committed, secret-free `.env.example` and `web/.env.development`. The build keeps what it needs: `web/` (sources), `api/` (the login function, M5b), `shared/` (imported as `@shared`, and by `api/`), the root `package.json` and `package-lock.json`, `tsconfig.base.json` (extended by `web/tsconfig.json`), `.npmrc`.

`web/dist/`: a source upload builds it again on Vercel, so a local copy would only add stale files. `vercel build` runs on the local tree and writes `.vercel/output`, which `vercel deploy --prebuilt` uploads; whether `vercel build` reads `.vercelignore` at all is unverified, and excluding `web/dist/` cannot hurt it because it rebuilds the folder before copying it.

Note for M8: the file only matters for deploys that upload sources. The standard deploy (A50) is `vercel build` locally, then `vercel deploy --prebuilt`, which uploads only `.vercel/output`. If a remote build is ever used, `spacetimedb/` is an npm workspace named in the root `package.json` and in the lockfile; `npm ci --dry-run --offline` without that folder passes, but a real install without it is unproven.

## `robots.txt`

`web/public/robots.txt`: all agents; `Disallow: /lobby/`, `/admin`, `/api/` (plan Appendix A). **Orchestrator's addition, for the user to rule on:** `Disallow: /profile`, `/calendar`, `/tournaments`, signed-in pages that only redirect a crawler. Landing, costs and team builder stay indexable. No sitemap line yet. Firewall rules (Bot Protection, AI crawlers, the `/api/*` rate limit) are dashboard settings at M8.

## Maintenance status file

`web/public/status.json`, shipped as `{ "maintenance": false }`; served as `/status.json` in dev and in production. Closes A171 item 1.

- **Read:** before the connection is built (`web/src/stdb/MaintenanceGate.tsx`, reader in `statusFile.ts`), with `cache: 'no-store'` and a 3 s timeout. While it loads, public routes render and guarded routes stay blank, as while connecting.
- **Stable tree:** one permanent `ConnectionScope` wraps the app; the SDK provider is rendered beside it, not around it, only while the gate is open, and hands its connection up. The app mounts once per page load: the status answer and a maintenance change do not remount it (typed input and focus survive). Consequence: the SDK's own React hooks (`useTable`, `useReducer`, `useSpacetimeDB`) have no provider above the app; the app reads the connection through `useStdbConnection` and the hooks in `web/src/stdb/`. Only `StdbProvider.tsx` imports `spacetimedb/react`.
- **`"maintenance": true`** (exactly the boolean): no connection is built, so no socket, no retries and no database energy. The maintenance splash shows; its Retry reads the file again and connects once maintenance is over.
- **Fail open:** a missing file, a non-200 answer, a body that is not JSON or not an object, a network error or a timeout all mean "not in maintenance".
- **While the connection is in trouble:** `reconnecting` (a connected tab whose socket dropped: the SDK retries inside the same connection and never reports `failed`) and `failed` that is not maintenance (the offline splash). Reads follow the trouble episode, from the change into trouble until it ends, not the reason text (60 s and 30 s are the orchestrator's choice):
  - offline (`failed`) tabs: the first read at once, or as soon as 30 s have passed since the previous read; then every 60 s;
  - reconnecting tabs: the first read 30 s after the drop (and not sooner than 30 s after the previous read), so a short blip that recovers reads nothing; then every 60 s while it lasts, whatever the reason text does;
  - a reconnecting episode that turns into `failed` may read once more as soon as the 30 s gap allows, then back to every 60 s;
  - hidden tabs (`document.hidden`) skip these re-reads and read when they become visible, if a read is due (the 30 s gap still holds). The page-load read and Retry clicks are not affected;
  - at most one read in flight.
  A `true` answer sets the maintenance status and closes the gate: the SDK provider is released, which disconnects and ends both the reconnect loop and the manager's rebuilds. A `false` answer changes nothing visible (no splash while reconnecting). Recovery to `connected` ends the episode, stops the timer and aborts a read in flight; a read that lands after that is ignored.
- **Retry clicks:** every Retry reads the file at once and aborts a read in flight. On the maintenance splash that read decides whether to connect. On the offline splash it runs in parallel with the rebuild (the rebuild does not wait), so maintenance shows at once instead of after the 30 s gap. A tab on the maintenance splash recovers only through a Retry click or a reload; it does not poll.
- **No silent state:** if a late SDK event moves the status off the maintenance splash while the gate is closed by a `true` answer, and there was no Retry click since, the maintenance status is set again at once, without a read. In any other closed state without a pending read, the file is read once the 30 s gap allows, so the app never sits with no splash and no connection. Unmounting aborts a read in flight and forgets it, so a late answer cannot write the status.
- **Ignored fields:** `message` is not rendered yet (the fixed wording stays); unknown fields are ignored.
- **Caching:** `no-store`. The reader counts any non-200 answer as "not in maintenance", so no conditional request or 304 may sit in the path, and no browser or proxy copy may outlive a switch.
- **Format:** UTF-8 without a byte order mark (`check:patterns` gate 9 parses the built copy with `JSON.parse`, which rejects a BOM).
- **Service worker (M10):** the worker must never cache `/status.json` (today's `sw.js` only intercepts UploadThing hosts; keep it that way for this file), or a tab could miss the switch.

### Switching maintenance on and off

Turning it on (the file first, then the module, so visitors meet the splash instead of refused sockets and rebuilds):

1. Set `web/public/status.json` to `{ "maintenance": true }`, build and deploy. `check:patterns` gate 9 fails on that build (it requires `false` in `web/dist/status.json`), so turning maintenance on is a deliberate deploy from a commit that CI marks red. Keep the commit on its own branch, or deploy the local build without committing.
2. Open the deployed site in a fresh tab and check that the maintenance splash shows and no socket opens.
3. Turn the module's maintenance on (B-8). The module drops the sockets of tabs that are still connected; they go to `reconnecting` (no splash) and read the file 30 s after the drop, which shows the maintenance splash and stops their reconnect loop. Tabs on the offline splash read at once or within 30 s, then every 60 s. Hidden tabs wait until they are visible.

Ending it (the reverse order: the module first, so tabs that connect find it open):

1. Turn the module's maintenance off.
2. Set the file back to `{ "maintenance": false }`, build, deploy, and check in a fresh tab that `/` connects. Open tabs connect on their next Retry.

### Staff bypass

`?maintenance=skip` on any URL sets a `sessionStorage` flag (`hsr-pvp:maintenance-skip`) and the tab then ignores the status file. The module stays the authority: during maintenance it still lets only Admins connect (B-8), so anyone else who uses the parameter gets the refused socket and the offline splash. There is no link to it in the UI. Orchestrator's choice, for the user to rule on.

## Local preview (M8)

User decision 2026-11-13: every Vercel deploy is treated as production; the preview is the built app on this machine, against the **test** database. Nothing is deployed.

```
npm run preview                               # build for test, then serve web/dist on http://127.0.0.1:4173/
npm run preview -- --port 5000                # another port (plain digits, 1 to 65535)
npm run preview -- --no-build                 # serve the existing web/dist, after the target check
npm run preview -- --no-build --maintenance   # maintenance rehearsal
```

- **Code:** `scripts/preview/`: `vercel-rules.mjs` (pure rules), `serve.mjs` (the server), `preview.mjs` (the entry). Plain Node, no dependency. `web/package.json` no longer has its own `preview` script, and `web/vite.config.ts` refuses `vite preview` for every target with a message pointing here: it ignores `vercel.json` and would serve a prod build on localhost.
- **Build:** `vercel.json` is read and its rules compiled first (unsupported syntax stops the command before any build). Then `buildCommand` runs with `VITE_STDB_TARGET=test` set in the child's environment, over any value in the parent (no shell syntax, Windows and Linux alike); a missing `buildCommand` is an error (use `--no-build`). The built bundle goes through the same target check as `--no-build`.
- **Test only:** there is no target flag (`--target`, `--prod`, `--env` exit with code 2). `--no-build` first reads the target out of the bundle and refuses (exit code 1) a bundle built for prod, a bundle with no marker, an empty `web/dist`, or a bundle whose test entry is not `hsr-spacetimedb-test1`. The marker is the `import.meta.env` object Vite inlines where the app passes the whole object (`resolveBrowserEnv(import.meta.env)` in `main.tsx` and `StdbProvider.tsx`): `VITE_STDB_TARGET:"test"`. The database names alone prove nothing: both are in every bundle (the `STDB_DATABASES` map). The check fails closed: if a refactor reads only `import.meta.env.VITE_STDB_TARGET`, Vite inlines the bare string, the marker disappears and `--no-build` refuses until the check is updated. It guards against mistakes, not against a hand-edited bundle. **While running**, every answer that serves the app page (`/index.html` directly or through the rewrite) repeats the full check, with no cache (about 5 ms on the real dist, measured at M8); a bundle that no longer targets test, or a dist that cannot be read, makes the app page answer 503 (`no-store`, the refusal text) until the bundle is test again. Other answers (assets, images) are not checked. Both checks read every `.js`, `.mjs`, `.cjs` and `.html` file in dist, extension matched without case.
- **Server:** binds `127.0.0.1` only; `GET` and `HEAD` only (others 405); reads `vercel.json` at start and throws at start on what it does not support (named parameters, modifiers or `{ }` outside a group, nested capturing groups, `has`, `missing`, `redirects`, `routes`, `cleanUrls`, `trailingSlash`, destinations that are not a fixed local path). A file is served only when the decoded path names it exactly: no `:` or `\` (Windows stream names and separators), no path that leaves `web/dist` lexically or through a symlink or junction, and the real path on disk must spell the request with the same case (`/INDEX.HTML` is not `/index.html` on Windows either). A path that is not a file follows the rules (rewrite or 404), so `--maintenance` cannot be bypassed by a case variant. Any stat or realpath failure (a link loop, no access) counts as "not a file"; any other error inside a request answers 500 and the server keeps running. A request target that is absolute or starts with `//` is a 400. `/api/auth/discord/start` and `/callback` run the login function (M5b, "Login function (M5b)" below); every other path under `/api/` answers 404 with a note; `/api` itself follows the rules. One log line per request (method, path, status).
- **What it imitates:** filesystem first, then rewrites in order; every matching header rule in order, a later rule wins per key; `public, max-age=0, must-revalidate` on static files without a Cache-Control rule; header rules also apply to 404 answers, without the default cache value. `check:patterns` gate 9 reads rewrite sources with the same function (`sourceToRegExp`), so the gate and the preview cannot drift apart. Since the M8 fix pass a parenthesis inside a character class (`[(]`) is not read as a group (no committed source has one).
- **Maintenance rehearsal:** `--maintenance` answers `/status.json` with `{ "maintenance": true }` (`no-store`) from memory; `web/public/status.json` and `web/dist/status.json` are not touched, so gate 9 stays green. The banner says so. Checked at M8: the maintenance splash shows, no socket opens, no maincloud request.
- **What it cannot prove** (stays on the list below for the first real deploy): Vercel's own matching details (case sensitivity, trailing slashes, which path form it tests a source against, and whether its matcher handles `(?:` and `(?!` groups in a source the way JavaScript's RegExp does here), headers Vercel adds or drops on its own, HTTPS and HSTS behaviour, compression, the 404 page and headers Vercel really sends, the firewall, functions, environment variables per environment, and the deployment file list.

## Login function (M5b)

Two Vercel functions, `api/auth/discord/start.ts` and `callback.ts` (Web-standard method handlers; logic in `api/_lib/`). Behaviour, cookies, logs and the HTTP reducer call: [../auth/architecture.md](../auth/architecture.md) "Phase M5b execution".

**Secrets and settings in the Vercel project (Production):** `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `AUTH_SECRET` (32+ random characters, not one character repeated, its own prod value), `STDB_LINK_TOKEN` (from `.env.prod.local` after `npm run stdb:bootstrap:prod`), `STDB_TARGET=prod` (the function's target; the deployed function refuses any other value, A174; `VITE_STDB_TARGET=prod` stays for the build), and `AUTH_ORIGIN` (not a secret: the site's public origin, scheme and host only, for example `https://example.com`; start accepts only this `Origin` and builds the Discord `redirect_uri` from it, never from the request's URL). Never `STDB_SERVER_TOKEN`, and never a `VITE_` name for any of them (gate 10). Values are trimmed; a missing, whitespace-only or invalid value makes both routes answer 500 with a generic body and log the missing key names.

**On this machine** (A175 item 1, A174): `npm run dev` (a dev-only Vite plugin, `web/vite-plugin-local-auth.ts`) and `npm run preview` (`scripts/preview/serve.mjs`, the handlers loaded through `tsx`) mount the two routes with the config from `.env.test.local` and the test database only (any other target: 503). Both print what is mounted and the missing key names. Missing Discord keys locally: start answers `not_configured` with the key names and the page shows "Sign-in is not configured on this machine." The local runner needs no `AUTH_ORIGIN`: it answers only a loopback `Host` and uses its own address.

**Build path (fix pass):** `web/vite.config.ts` adds the dev plugin only for `vite` serve (never for a build), and the plugin loads `scripts/local-auth/localAuth.ts` through `tsx` inside `configureServer`, from a path string, not an import. A Vercel build therefore never resolves `scripts/` (excluded by `.vercelignore`). Proofs: a unit test loads the config with Vite's own loader for `build` and for serve and checks that no bundled dependency is under `scripts/`; check:patterns gate 10 fails on any static import chain from `web/vite.config.ts` into `scripts/`.

**The local Discord stand-in and the preview:** the page leaves only for `https://discord.com` in a production build; the looser loopback rule exists only in dev builds (gate 3 checks it is absent from `web/dist`). `npm run preview` serves a production build, so a stubbed flow through the preview stops at "Sign-in failed." before leaving; the stub check runs on `npm run dev`, and the preview needs the real Discord keys.

**Redirect addresses to register in the Discord application** (OAuth2, Redirects; checked in Edge, both hosts work):

| Server | Address |
|---|---|
| `npm run dev` | `http://localhost:5173/api/auth/discord/callback` |
| `npm run preview` | `http://127.0.0.1:4173/api/auth/discord/callback` |
| Production | `<AUTH_ORIGIN>/api/auth/discord/callback` (`https://<production domain>/…`) |

The address must match the page's own origin exactly: opening the dev server as `127.0.0.1:5173` (or the preview as `localhost:4173`, or another `--port`) needs that address registered too. The dev server listens on `localhost` (IPv6 `::1` here) and the preview on `127.0.0.1`; `Secure` and `__Host-` cookies worked on both in Edge.

## To do

- **M5 (resolved at M5b):** the `functions` block is not needed (see the table above); the login function runs locally on dev and preview. Still open: Node 26 for functions and the function duration limit against the 15 s worst case (first deploy).
- **Open points of the login function (M5b fix pass, documented, not fixed):**
  - No rate limit on `/api/` yet: add a firewall rule for `/api/auth/*` at the first deploy.
  - Cookies on `localhost` are shared across ports (cookies are scoped by host, not port): the dev server and the preview on the same host see each other's sign-in cookies. Local only.
  - A browser clock more than 2 minutes off breaks the confirm step: ahead, the pending row looks expired ("took too long"); behind, the page offers an expired row and the module refuses the confirmation.
  - The local env reader keeps quotes around a pasted value (`KEY="x"` reads `"x"` with the quotes); paste values bare (`.env.example` says so).
- **M10:** the service worker never caches `/status.json`.
- **First real Vercel deploy** (M8 moved the preview to this machine, see "Local preview"; the items below stay unproven until a deploy): `vercel link`, environment variables (`VITE_STDB_TARGET` per environment); confirm on the deploy with `curl -sI` and the browser: every header above, the rewrite and the 404s, `immutable` on `/assets/*`, `no-store` on `/status.json`, zero CSP violations; whether Vercel puts the `immutable` header on a 404 for a missing asset (the local imitation does); the 404s for missing extension paths and dot-paths; whether Vercel's source matcher treats the `(?:` and `(?!` groups of the index rewrite as JavaScript's RegExp does (the preview and gate 9 assume so; the 404 checks above would show a difference); the deployment file list (A50 done-check).

## Proposals (not applied)

1. **`style-src 'self'`** without `'unsafe-inline'`: the built app loaded `/`, `/costs`, the `/profile` redirect and a not-found page with zero CSP violations under it. React sets `style` props through the CSSOM, which CSP does not block, and Vite links every stylesheet. Revisit when Chart.js or another library that injects `<style>` arrives.
2. **`Cross-Origin-Opener-Policy: same-origin`**: isolates the window from cross-origin popups. Check against the Discord sign-in flow (M5) first.
3. **`X-Frame-Options: DENY`**: only for old browsers that ignore `frame-ancestors`; low value.
4. **A maintenance rule without a red commit:** let gate 9 accept `true` only when a CI variable or the commit message says so, so a maintenance deploy can come from a green commit.
