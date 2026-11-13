import { tables } from '@bindings/index';
import { BinaryWriter, ProductType } from 'spacetimedb';
import { router } from '@/router';
import { getCurrentConnection } from '@/stdb/connectionContext';
import styles from './wireStats.module.css';

/*
 * Dev egress meter (D-A7, CLAUDE.md §2: page PRs report these numbers). Dev only: main.tsx loads
 * it by dynamic import behind `import.meta.env.DEV`, so it is not in the production bundle
 * (check:patterns gate 3 looks for `__wireStats`).
 *
 * - Wire: `globalThis.WebSocket` is wrapped before the provider builds the connection; bytes and
 *   messages are counted for sockets to the SpacetimeDB host only (not Vite's HMR socket). It
 *   measures WebSocket message payload bytes as the page receives and sends them (the SDK asks
 *   for gzip, so these are mostly compressed). Not counted: the token request
 *   (`POST /v1/identity/websocket-token`), the WebSocket handshake, frame headers and TLS. How
 *   maincloud meters egress is not verified, so treat these as a lower bound of the bill.
 * - Cache: per table, the cached row count and an estimated size: each row serialized with the
 *   SDK's own BSATN serializer (`ProductType.makeSerializer` + `BinaryWriter`), uncompressed.
 *   Sizes are computed on demand (`__wireStats()`), or for the open panel only for a table whose
 *   row count changed since its last sizing (an in-place update of the same count keeps the old
 *   estimate until `__wireStats()` is called).
 * - Routes: bytes and messages since the current route was entered, plus the last routes.
 *
 * Console: `window.__wireStats()`. Panel: bottom-left, hidden with its button (remembered).
 */

type Counters = { bytesIn: number; bytesOut: number; msgsIn: number; msgsOut: number };
type RouteEntry = { path: string; enteredAt: number; start: Counters; end?: Counters };
type TableStat = { table: string; rows: number; estBytes: number };

const counters: Counters & { sockets: number } = {
    sockets: 0,
    bytesIn: 0,
    bytesOut: 0,
    msgsIn: 0,
    msgsOut: 0,
};
const routes: RouteEntry[] = [];
const ROUTE_HISTORY = 20;
const HIDDEN_KEY = 'wireStats.hidden';

declare global {
    interface Window {
        __wireStats?: () => WireStatsReport;
    }
}

function sizeOf(data: unknown): number {
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
    if (data instanceof Blob) return data.size;
    return 0;
}

function snapshotCounters(): Counters {
    const { bytesIn, bytesOut, msgsIn, msgsOut } = counters;
    return { bytesIn, bytesOut, msgsIn, msgsOut };
}

function diff(a: Counters, b: Counters): Counters {
    return {
        bytesIn: b.bytesIn - a.bytesIn,
        bytesOut: b.bytesOut - a.bytesOut,
        msgsIn: b.msgsIn - a.msgsIn,
        msgsOut: b.msgsOut - a.msgsOut,
    };
}

function wrapWebSocket(host: string): void {
    const Native = globalThis.WebSocket;
    class CountingWebSocket extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            if (!String(url).startsWith(host)) return;
            counters.sockets += 1;
            this.addEventListener('message', (event) => {
                counters.msgsIn += 1;
                counters.bytesIn += sizeOf(event.data);
            });
            const send = this.send.bind(this);
            this.send = (data) => {
                counters.msgsOut += 1;
                counters.bytesOut += sizeOf(data);
                send(data);
            };
        }
    }
    globalThis.WebSocket = CountingWebSocket;
}

// --- the cache --------------------------------------------------------------------------------

type TableRef = { rowType: Parameters<typeof ProductType.makeSerializer>[0]; sourceName: string };
type CacheTable = { count(): bigint | number; iter(): Iterable<unknown> };

// Canonical accessors only (camelCase); the bindings also list deprecated aliases.
const TABLE_ACCESSORS = Object.keys(tables).filter((k) => /^[a-z][A-Za-z0-9]*$/.test(k));
const serializers = new Map<string, ReturnType<typeof ProductType.makeSerializer>>();
const writer = new BinaryWriter(4096);

/** Last sizing per table: re-serialized only when its row count changes (or on demand). */
const sized = new Map<string, { rows: number; estBytes: number }>();

function tableStats(fresh: boolean): TableStat[] {
    const conn = getCurrentConnection();
    if (!conn) return [];
    const db = conn.db as unknown as Record<string, CacheTable | undefined>;
    const refs = tables as unknown as Record<string, TableRef>;
    const out: TableStat[] = [];
    for (const accessor of TABLE_ACCESSORS) {
        const handle = db[accessor];
        const ref = refs[accessor];
        if (!handle || !ref) continue;
        const rows = Number(handle.count());
        if (rows === 0) {
            sized.delete(accessor);
            continue;
        }
        const last = sized.get(accessor);
        if (!fresh && last?.rows === rows) {
            out.push({ table: ref.sourceName, rows, estBytes: last.estBytes });
            continue;
        }
        let serialize = serializers.get(accessor);
        if (!serialize) {
            serialize = ProductType.makeSerializer(ref.rowType);
            serializers.set(accessor, serialize);
        }
        writer.clear();
        for (const row of handle.iter()) serialize(writer, row);
        sized.set(accessor, { rows, estBytes: writer.offset });
        out.push({ table: ref.sourceName, rows, estBytes: writer.offset });
    }
    return out.sort((a, b) => b.estBytes - a.estBytes);
}

// --- routes -----------------------------------------------------------------------------------

function enterRoute(path: string): void {
    const now = snapshotCounters();
    const last = routes.at(-1);
    if (last?.path === path) return;
    if (last && !last.end) last.end = now;
    routes.push({ path, enteredAt: Date.now(), start: now });
    if (routes.length > ROUTE_HISTORY) routes.shift();
}

// --- report -----------------------------------------------------------------------------------

export type WireStatsReport = {
    total: Counters & { sockets: number };
    route: { path: string; sinceEntered: Counters } | null;
    previousRoutes: { path: string; whileThere: Counters }[];
    cache: TableStat[];
    cacheTotal: { rows: number; estBytes: number };
};

function report(fresh = true): WireStatsReport {
    const now = snapshotCounters();
    const current = routes.at(-1);
    const cache = tableStats(fresh);
    return {
        total: { ...counters },
        route: current ? { path: current.path, sinceEntered: diff(current.start, now) } : null,
        previousRoutes: routes
            .slice(0, -1)
            .map((r) => ({ path: r.path, whileThere: diff(r.start, r.end ?? now) })),
        cache,
        cacheTotal: cache.reduce(
            (acc, t) => ({ rows: acc.rows + t.rows, estBytes: acc.estBytes + t.estBytes }),
            { rows: 0, estBytes: 0 },
        ),
    };
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`);

function render(r: WireStatsReport): string {
    const lines = [
        `wire  in ${kb(r.total.bytesIn)} (${r.total.msgsIn} msg)  out ${kb(r.total.bytesOut)} (${r.total.msgsOut} msg)  sockets ${r.total.sockets}`,
    ];
    if (r.route) {
        const s = r.route.sinceEntered;
        lines.push(
            `route ${r.route.path}  in ${kb(s.bytesIn)} (${s.msgsIn})  out ${kb(s.bytesOut)} (${s.msgsOut})`,
        );
    }
    lines.push(`cache ${r.cacheTotal.rows} rows  ~${kb(r.cacheTotal.estBytes)} BSATN`);
    for (const t of r.cache) lines.push(`  ${t.table}  ${t.rows} rows  ~${kb(t.estBytes)}`);
    return lines.join('\n');
}

// --- panel ------------------------------------------------------------------------------------

function readHidden(): boolean {
    try {
        return localStorage.getItem(HIDDEN_KEY) === '1';
    } catch {
        return false;
    }
}

function writeHidden(hidden: boolean): void {
    try {
        localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0');
    } catch {
        // Storage blocked: the choice lasts until reload.
    }
}

function mountPanel(): void {
    const panel = document.createElement('aside');
    panel.className = styles.panel ?? '';
    panel.setAttribute('aria-label', 'Dev egress meter');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = styles.toggle ?? '';
    const body = document.createElement('pre');
    body.className = styles.body ?? '';
    panel.append(toggle, body);
    document.body.append(panel);

    let hidden = readHidden();
    const paint = () => {
        toggle.textContent = hidden ? 'wire' : 'hide';
        toggle.setAttribute('aria-expanded', String(!hidden));
        body.hidden = hidden;
        if (!hidden) body.textContent = render(report(false));
    };
    toggle.addEventListener('click', () => {
        hidden = !hidden;
        writeHidden(hidden);
        paint();
    });
    paint();
    setInterval(() => {
        if (!hidden) paint();
    }, 1000);
}

/** Wraps WebSocket for `host`, tracks routes, installs `window.__wireStats()` and the panel. */
export function installWireStats(host: string): void {
    wrapWebSocket(host);
    enterRoute('(boot)');
    router.subscribe('onResolved', ({ toLocation }) => enterRoute(toLocation.pathname));
    window.__wireStats = () => {
        const r = report();
        console.info(render(r));
        return r;
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
    } else mountPanel();
}
