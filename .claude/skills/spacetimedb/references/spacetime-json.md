<!-- Sources:
  - SpacetimeDB CLI reference (v2.14.1 tag; upstream moved it from 00300-resources/01000-reference/ after 1a1fe78): https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00300-resources/00100-cli-reference/00300-spacetime-json.md
  - Environment-variable config: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00200-core-concepts/00100-databases/00700-environment-variables.md
  - Publish flags cross-checked against the installed 2.6.1 CLI (`spacetime publish --help`)
-->

# spacetime.json Configuration Reference

The `spacetime.json` file provides project-level configuration for the SpacetimeDB CLI, eliminating repetitive flags for `publish`, `generate`, and `dev`. Commands that act on an already-published database (`spacetime call`, `sql`, `logs`) also resolve their database/server from it. From CLI v2.10.1 (#5883), `spacetime list`, `rename`, and `mcp` use the config's `server` too, when it is unambiguous; before that they fell back to the CLI's global default server. This repo's active CLI is 2.6.1, so pass `-s maincloud` explicitly to those commands.

**Version tags:** fields and flags marked `(vX+)` are post-2.6.1. The CLI rejects or ignores them until the CLI is upgraded — don't add them to `spacetime.json` yet.

---

## Field Reference

| Field | Type | Inherited | Purpose |
|-------|------|-----------|---------|
| `database` | string | No | Database name/identity (required) |
| `module-path` | string | Yes* | Source module directory path |
| `bin-path` | string | Yes* | Precompiled WASM binary location |
| `js-path` | string | Yes* | Bundled JavaScript file path |
| `server` | string | Yes | Server nickname, domain, or URL |
| `build-options` | string | Yes | Flags passed to build command |
| `break-clients` | boolean | Yes | Allow breaking changes |
| `num-replicas` | number | Yes | Database replica count |
| `anonymous` | boolean | Yes | Use anonymous identity |
| `organization` | string | Yes | Organization name/identity |
| `generate` | array | No | Bindings generation targets |
| `children` | array | No | Child database entities |
| `dev` | object | No | Dev server config (root-level only) |
| `parent` | string | Yes | Existing database (name/identity) to make this one's parent at creation (post-2.6.1) |
| `dependencies` | array | No | Receiver-binding inputs for async inter-database calls — `{ name, module-path \| database, out-dir? }` (v2.14+) |
| `env` | object | Yes (merged by key) | Non-secret defaults for declared database environment values (v2.12+). Secrets go in process env or `spacetime.local.json`, never the checked-in file |

*`module-path`, `bin-path`, and `js-path` are mutually exclusive. When a child specifies one, the others don't inherit from parent.

---

## Generate Configuration

Each entry in the `generate` array requires:
- `language`: `typescript`, `csharp`, `rust`, `unrealcpp`
- `out-dir`: Output directory

Language-specific options:
- **C#**: `namespace`
- **Unreal C++**: `unreal-module-name`, `uproject-dir`
- **All**: `include-private` (boolean — include private tables in generated bindings)
- **TypeScript**: `import-extension`: `none` (default) | `js` | `ts` (v2.14+). Only for `moduleResolution: "nodenext"` or direct TS execution in Node, Bun, or Deno; not needed for Next.js
- **All**: `bindings`: `client` (default) | `module` (post-2.6.1). `module` generates receiver bindings for async inter-database calls; dependencies listed under `dependencies` get module bindings automatically, defaulting to `<module-path>/src/remote_bindings`

---

## Children and Inheritance

Child databases inherit all fields marked "Yes" above. Never inherited: `database`, `generate`, `children`, `dev`, `dependencies`.

### Source conflict rule
When a child specifies `module-path`, `bin-path`, or `js-path`, the other two sources don't inherit from parent.

---

## spacetime dev

The `dev` field (root-level only) specifies the client dev server:

```json
{ "dev": { "run": "pnpm dev" } }
```

**Execution sequence:**
1. Build all configured modules
2. Generate bindings for all databases
3. Publish all databases
4. Run client dev server
5. Watch for changes and repeat

Flags: `--run` overrides `dev.run`, `--server` overrides server, `--skip-publish` and `--skip-generate` skip those steps.

**Auto-generation:** Running `spacetime dev` without a config file generates `spacetime.json` (server + module path) and `spacetime.local.json` (database name).

---

## Database Selection with Glob Patterns

When `spacetime.json` exists, the database name argument selects targets:
- No argument: operates on all databases
- Specific name: `spacetime publish world-highlands`
- Glob pattern: `spacetime publish "world-*"`

---

## Flag Overrides

| Scope | Flags |
|-------|-------|
| **Global** (all databases) | `--server`, `--break-clients`, `--delete-data[=always\|on-conflict\|never]`, `--yes[=all\|remote\|migrate\|break-clients\|skip-login\|delete-data]` (there is **no** `--force` flag; older docs listed one by mistake) |
| **Per-database** (error if multiple selected) | `--module-path`, `--bin-path`, `--js-path`, `--build-options`, `--num-replicas` |
| **Per-generate-entry** (error if multiple entries) | `--lang`, `--out-dir`, `--namespace`, `--unreal-module-name`, `--uproject-dir` |

Use `--no-config` to ignore `spacetime.json` entirely.

**Targeting a database that isn't the one in `spacetime.json` (e.g. prod when the config names test):**
- Pass the name **and** `--no-config`. `call`, `subscribe` and `describe` never fall back: naming another database errors with "not in the config file… pass --no-config". `sql` falls back only when given 2 or more positional arguments. Source: CLI `crates/cli/src/subcommands/db_arg_resolution.rs` (PR #4358).
- Verified 2026-11-06: `spacetime describe hsr-spacetimedb-test1 --json` from this repo failed with "Invalid describe arguments" while `spacetime.json` named another database. `spacetime describe hsr-spacetimedb-test1 --json --no-config` worked.
- Scripts that target test or prod should always pass both explicitly, never rely on the config default.

---

## Environment and Local Overrides

| File | Purpose | Git-tracked |
|------|---------|-------------|
| `spacetime.json` | Project defaults | Yes |
| `spacetime.{env}.json` | Environment config | Yes |
| `spacetime.local.json` | User overrides | No |
| `spacetime.{env}.local.json` | User + env overrides | No |

Environment set via `--env` flag. `spacetime dev` implicitly uses `--env dev`.

**Priority (highest to lowest):**
1. CLI flags (explicit only)
2. `spacetime.{env}.local.json`
3. `spacetime.{env}.json`
4. `spacetime.local.json`
5. `spacetime.json`
6. Built-in defaults

Higher-priority files **replace** entire keys (no merging).

---

## Config File Discovery

CLI searches from current directory upward until `spacetime.json` is found or root is reached. All paths are relative to the config file's directory.

## Editor Support

Format uses JSON5 (comments + trailing commas). For VSCode:
```json
{ "files.associations": { "spacetime.json": "jsonc" } }
```
