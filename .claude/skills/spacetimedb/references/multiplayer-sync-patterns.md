<!-- Sources:
  - LW7SH multiplayer sync patterns: https://lw7sh.itch.io/test-spacetimedb
-->

# Multiplayer Sync Patterns for SpacetimeDB

**Core principle: Don't sync positions. Sync time.**

There are two fundamental patterns for multiplayer state synchronization. Choose based on whether the entity's movement can be expressed as a formula.

---

## Pattern 1: Write once, compute anywhere

**Use when:** Entity behavior can be expressed as a deterministic formula from initial conditions.

**Use cases:** bullet movement, grenade arc, expanding AoE, DOT tick timer, cooldown timer, respawn countdown, enemy patrol route, moving platforms.

### How it works

When a player fires, the client **spawns the entity immediately** as a prediction — then sends the request to the server. The server validates, sanitizes, and **inserts once**. The insert includes a **timestamp** and a **lifetime**. From that moment, **anyone** can compute exact state at any point in time using the same formula. No position updates cross the network. Only insert and delete.

### The timestamp is not optional

It is the mechanism that makes everything else work. Without it, remote clients cannot catch up to the current position at spawn. The stored parameters — origin, direction, speed, lifetime, and the moment it was created — together form a formula that any participant can evaluate at any time:

```
pos(t) = origin + direction × speed × (t - fired_at)
```

The formula changes per use case — parabolic for grenades, radial for AoE, purely temporal for cooldown timers — but the principle is the same: **store enough to reconstruct, never stream.**

### Server-side: validate and insert once

```typescript
// SpacetimeDB reducer — validate inputs, store formula parameters
export const fire_bullet = spacetimedb.reducer({
  originX: t.f64(), originY: t.f64(),
  dirX: t.f64(), dirY: t.f64(),
  speed: t.f64(), lifetimeSecs: t.f64(),
}, (ctx, { originX, originY, dirX, dirY, speed, lifetimeSecs }) => {
  // Verify sender is a valid player
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) return;

  // Sanitize inputs
  const len = Math.sqrt(dirX * dirX + dirY * dirY) || 0.001;
  const clampedSpeed = Math.min(Math.max(speed, 0), 2000);
  const clampedLifetime = Math.min(Math.max(lifetimeSecs, 0.1), 10.0);

  // Insert with timestamp — this is what enables "compute anywhere"
  ctx.db.bullet.insert({
    id: 0n,
    owner: ctx.sender,
    originX,
    originY,
    dirX: dirX / len,
    dirY: dirY / len,
    speed: clampedSpeed,
    lifetimeSecs: clampedLifetime,
    firedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
  });
});
```

### Client-side: compute position from formula

```typescript
// Compute position at any point in time — no network needed
function positionAt(bullet: BulletRow, elapsedSecs: number): { x: number, y: number } {
  return {
    x: bullet.originX + bullet.dirX * bullet.speed * elapsedSecs,
    y: bullet.originY + bullet.dirY * bullet.speed * elapsedSecs,
  };
}
```

### Technique: Time catchup at spawn

Remote entities appear where they **should** be now — not where they were when fired.

When a remote bullet arrives via subscription, it has already been flying for some time. Compute its age from `firedAtMicros`, jump ahead to the correct position on the path, then advance by local delta only from that point forward.

```typescript
// When a new bullet row arrives via subscription
const nowMicros = BigInt(Date.now()) * 1000n;
const elapsedSecs = Number(nowMicros - bullet.firedAtMicros) / 1_000_000;
const currentPos = positionAt(bullet, elapsedSecs);
// Start rendering from currentPos, advance by local frame delta from here
```

### Technique: Client-side prediction

Do it on the client first, verify later.

The bullet appears on screen **before** the server call. The client calls `spawnPredictedBullet()` then `conn.reducers.fireBullet(...)` in the same frame. When the server insert syncs back, the client matches predictions in FIFO order and confirms. Position and elapsed time are **never reset** — the prediction was already correct because both sides use the same formula.

---

## Pattern 2: Stream and interpolate

**Use when:** Entity behavior is driven by unpredictable input that changes every frame and cannot be expressed as a formula.

**Use cases:** player movement, player jumping, aiming direction, vehicle steering, cursor position.

### How it works

The owner sends state to the server N times per second. The server **validates each update** before writing. Other clients **interpolate** smoothly between received updates. This is the expensive pattern — **~20 writes/sec per entity** — but it is the only option when behavior cannot be expressed as a formula.

### Server-side: validate and update

```typescript
export const update_player_position = spacetimedb.reducer({
  posX: t.f64(), posY: t.f64(),
}, (ctx, { posX, posY }) => {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) return;
  if (player.health <= 0) return;  // Dead players can't move

  ctx.db.player.identity.update({
    ...player,
    posX,
    posY,
  });
});
```

### Client-side: send at fixed rate (owner)

```typescript
// Owner sends position updates at a fixed rate (e.g., 20 Hz)
const SYNC_RATE_MS = 50; // 20 Hz
let syncTimer = 0;

function onFrame(deltaMs: number, localPosition: { x: number, y: number }) {
  syncTimer += deltaMs;
  if (syncTimer < SYNC_RATE_MS) return;
  syncTimer = 0;
  conn.reducers.updatePlayerPosition({ posX: localPosition.x, posY: localPosition.y });
}
```

### Client-side: interpolate (remote players)

```typescript
// Remote players interpolate toward the latest server position
const LERP_SPEED = 10; // Adjust for smoothness vs responsiveness

function updateRemotePlayer(
  currentPos: { x: number, y: number },
  targetPos: { x: number, y: number },
  deltaSecs: number
): { x: number, y: number } {
  const t = Math.min(LERP_SPEED * deltaSecs, 1);
  return {
    x: currentPos.x + (targetPos.x - currentPos.x) * t,
    y: currentPos.y + (targetPos.y - currentPos.y) * t,
  };
}
```

---

## How the two patterns work together

**This is what makes write-once projectiles work against moving targets.**

Since player positions are already being synced by the database (e.g. 20 Hz), a bullet performing local collision checks each frame is testing against **reasonably current positions**. The projectile does not need to know about the network. Two patterns, zero coupling.

---

## Validation spectrum

Start minimal, add checks when needed.

Begin with **no cheat checks**. Add kill switches for the most abusive first:

| Level | Check | When to add |
|-------|-------|-------------|
| Precondition/ownership | `bullet.owner === ctx.sender` | Always — from day one |
| Basic state check | `player.health > 0` | Always — prevents dead-state exploits |
| Server recomputation | Recompute hit from stored formula | When cheating is observed |
| Full simulation | Server re-simulates entire trajectory | Rarely worth the cost |

Full simulation is rarely worth the cost. The sweet spot is usually precondition checks + server recomputation on suspicious events.

---

## Full lifecycle: fire, hit, kill, respawn

Three perspectives of the same events, showing how write-once (formula) and streamed (interpolated) patterns combine:

**Player A's screen (fires the bullet):**
1. Fire input → spawn predicted bullet locally (green/write-once)
2. Server confirms insert → prediction matched, assign server ID
3. Bullet hits Player B locally → call `validateHit` reducer
4. Server confirms kill → show kill confirmation

**Server (source of truth):**
1. Receive fire_bullet → validate + insert bullet row
2. Send confirm_id back to Player A
3. Receive validate_hit → check bullet exists, check positions, apply HP reduction
4. Player B HP ≤ 0 → trigger death + schedule respawn

**Player B's screen (gets hit):**
1. Bullet row arrives via subscription → time catchup to current position
2. Bullet renders flying toward them (same formula, offset by network delay)
3. Death event arrives → play death animation
4. Respawn timer completes → respawn

The bullet runs the same code on all clients — offset by network delay, caught up at spawn, same trajectory. Synchronization means it looks local. It's position-free: no hits to predict, fully deterministic.
