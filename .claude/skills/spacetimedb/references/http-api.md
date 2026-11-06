<!-- Sources (v2.14.1 tag commit a0bf6be10a146b03acbe3f4f9ad7fe20f114988d — upstream moved these from 00300-resources/00200-reference/00200-http-api/ after 1a1fe78):
  - Authorization: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00300-resources/00200-http-api/00100-authorization.md
  - Identity: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00300-resources/00200-http-api/00200-identity.md
  - Database: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00300-resources/00200-http-api/00300-database.md
  - MCP: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00300-resources/00150-mcp.md
  - Route table cross-checked in crates/client-api/src/routes/database.rs at v2.6.1 (052c83fe) and v2.14.1 (a0bf6be)
-->

# SpacetimeDB HTTP API Reference

Base URL: `https://maincloud.spacetimedb.com` (maincloud) or `http://localhost:3000` (local)

**This API is server-side:** what works is decided by maincloud's server version, not the project's SDK (2.6.1). Endpoints marked with a version below exist on current servers; a module still needs the matching SDK to *use* features like environment declarations. Upstream describes these endpoints as intended for management, debugging, and developer use — they are not optimized like the WebSocket protocol the SDKs use.

## Authorization

Endpoints take Bearer token auth:
```
Authorization: Bearer <token>
```

The header is optional on every `/v1/database` endpoint: without it the server allocates a fresh **anonymous identity** for the request. Anonymous callers can read public info, run SQL over public tables, and call reducers (the module sees that anonymous identity as `ctx.sender`). Owner-only operations (delete, logs, renaming, environment) are rejected. Publishing anonymously creates a database owned by a throwaway identity, which is almost never what you want.

Tokens can be obtained via:
1. **OpenID Connect** — SpacetimeDB derives identity from `sub` and `iss` claims of any OIDC-compliant JWT
2. **HTTP endpoint** — `POST /v1/identity` returns a new identity + token (cluster-specific)
3. **WebSocket** — anonymous connection auto-generates identity + token via `IdentityToken` message

---

## Connectivity

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/v1/ping` | No | Health check — verify connectivity |

---

## Identity Endpoints (`/v1/identity`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/v1/identity` | No | Generate new identity + token |
| POST | `/v1/identity/websocket-token` | Yes | Short-lived token for untrusted contexts (embedded URLs) |
| GET | `/v1/identity/public-key` | No | Fetch public key for token verification (PEM format) |
| GET | `/v1/identity/:identity/databases` | No | List databases owned by identity — returns `{ "identities": [...] }` (database identities; older docs said `addresses`) |
| GET | `/v1/identity/:identity/verify` | Yes | Verify identity/token pair (204=valid, 400=mismatch, 401=invalid) |

### Generate identity
```bash
curl -X POST https://maincloud.spacetimedb.com/v1/identity
# Response: { "identity": "hex-string", "token": "jwt-string" }
```

### Verify identity
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://maincloud.spacetimedb.com/v1/identity/$IDENTITY/verify
# 204 No Content = valid
```

---

## Database Endpoints (`/v1/database`)

### Publishing & Management

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/v1/database` | Yes | Publish unnamed database (body: WASM binary) |
| **PUT** | `/v1/database/:name_or_identity` | Yes (owner) | Publish to named database (`?clear=true` to reset). **PUT, not POST** — the route has been `PUT` since at least 2.6.1; older docs said POST |
| GET | `/v1/database/:name_or_identity` | No | Get database info (identity, owner, host type, WASM hash) |
| DELETE | `/v1/database/:name_or_identity` | Yes (owner) | Delete database (irreversible) |
| GET | `/v1/database/:name_or_identity/identity` | No | Get database identity as hex string |
| GET | `/v1/database/:name_or_identity/schema` | No | Get schema as JSON RawModuleDef (`?version=9`). Handy read-only check, e.g. which reducers have a `lifecycle` |

### Environment (v2.12.0+ server; module must declare env via SDK 2.12+)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/v1/database/:name_or_identity/environment` | Owner/publisher | Declarations + stored keys (never values) + `module_hash` |
| PUT | `/v1/database/:name_or_identity/environment?expected_module_hash=…` | Owner/publisher | Replace whole environment (JSON `{ "KEY": "value" }`); 409 if the module changed |
| PATCH | `/v1/database/:name_or_identity/environment?expected_module_hash=…` | Owner/publisher | Set some keys; delete via `spacetime-environment-remove: KEY1, KEY2` header |

Publishing can also carry values: repeat a `spacetime-environment: KEY=VALUE` header per value, and use `spacetime-environment-remove: *` to replace the whole store. A missing required value → `400` with `{"EnvironmentError":{"MissingRequiredEnvironment":{"keys":[...]}}}`.

### HTTP handlers and MCP

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| ANY | `/v1/database/:name_or_identity/route/{*path}` | Module-defined | Module-defined HTTP routes (`spacetimedb.httpHandler` / `httpRouter`, unstable; repo defines none) |
| POST | `/v1/mcp` | Optional | MCP JSON-RPC, host-wide (v2.10.0+ on maincloud; unstable) — see `how-to-guides.md` § MCP |
| POST | `/v1/database/:name_or_identity/mcp` | Optional | MCP JSON-RPC scoped to one database |

### Database Naming

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/v1/database/:name_or_identity/names` | No | List database names |
| POST | `/v1/database/:name_or_identity/names` | Yes | Add a name (body: string) |
| PUT | `/v1/database/:name_or_identity/names` | Yes | Replace all names (body: JSON array) |

### Operations

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/v1/database/:name_or_identity/call/:reducer` | Optional | Invoke a reducer **or procedure** (body: JSON array of args). `?confirmed=` defaults `true` |
| POST | `/v1/database/:name_or_identity/sql` | Optional | Execute SQL queries (semicolon-separated); anonymous callers see public tables only |
| GET | `/v1/database/:name_or_identity/logs` | Yes (owner) | Stream logs (`?num_lines=N&follow=true`) |

**Confirmed HTTP calls wait for durability (server v2.13.0+, #6101/#6154):** with the default `confirmed=true`, `/call` reports success only once the transaction is durable (procedures also wait after each successful `withTx`). The wait has a 5 s deadline — on timeout the call returns **`504 Gateway Timeout` with an unknown outcome** (the reducer may have committed; don't blindly retry non-idempotent calls). Pass `?confirmed=false` when the guarantee isn't needed. (This repo's Route Handlers use the WebSocket SDK via `getServerConnection()`, not `/call`, so this matters only for new HTTP integrations.)

### WebSocket

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/v1/database/:name_or_identity/subscribe` | Yes | WebSocket connection |

WebSocket protocols: `v1.bsatn.spacetimedb` (binary, recommended) or `v1.json.spacetimedb` (JSON)

---

## Common Usage Examples

### Call a reducer via HTTP
```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '["arg1", 42]' \
  https://maincloud.spacetimedb.com/v1/database/my-db/call/my_reducer
```

### Run SQL query
```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -d "SELECT * FROM user WHERE id = 1" \
  https://maincloud.spacetimedb.com/v1/database/my-db/sql
```

### Stream logs
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://maincloud.spacetimedb.com/v1/database/my-db/logs?num_lines=100&follow=true"
```

### Publish module
```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/wasm" \
  --data-binary @module.wasm \
  "https://maincloud.spacetimedb.com/v1/database/my-db"
```

---

## Using from Next.js API Routes

The HTTP API is useful for server-side operations in Next.js API routes where you can't use the WebSocket SDK:

```typescript
// app/api/example/route.ts
const SPACETIMEDB_URL = 'https://maincloud.spacetimedb.com';
const DB_NAME = 'my-database';

// Get auth token from CLI: spacetime login show --token
const TOKEN = process.env.SPACETIMEDB_TOKEN;

// Query data server-side
export async function GET() {
  const res = await fetch(`${SPACETIMEDB_URL}/v1/database/${DB_NAME}/sql`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: 'SELECT * FROM user LIMIT 10',
  });
  const data = await res.json();
  return Response.json(data);
}

// Call reducer server-side
export async function POST(request: Request) {
  const body = await request.json();
  const res = await fetch(
    `${SPACETIMEDB_URL}/v1/database/${DB_NAME}/call/my_reducer`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([body.arg1, body.arg2]),
    }
  );
  return new Response(null, { status: res.status });
}
```
