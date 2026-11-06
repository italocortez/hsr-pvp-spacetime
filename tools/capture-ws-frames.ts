/**
 * Capture WebSocket frame log against the maincloud test database, with v3
 * transport active (post-Phase 16.3 SDK upgrade). Verify-only baseline per
 * Phase 16.4 D-01 / D-04 — the "pre" measurement is unrecoverable; this
 * capture is the durable "maincloud-as-shipped" snapshot.
 *
 * Usage: npx tsx tools/capture-ws-frames.ts
 *
 * Output:
 *   .planning/phases/16.4-spacetimedb-v2-2-0-refactor-pass/transport-evidence/frames.jsonl
 *
 * Requires CAPTURE_WS_FIXTURE_TOKEN in .env.local (low-privilege guest token,
 * NOT the admin SPACETIMEDB_SERVER_TOKEN — admin token would skew bandwidth).
 */

import {
    readFileSync,
    writeFileSync,
    appendFileSync,
    mkdirSync,
    existsSync,
} from 'fs';
import { resolve, dirname } from 'path';
import WebSocket from 'ws';
import { DbConnection } from '../src/module_bindings';

function loadEnvFile(filename: string) {
    try {
        const content = readFileSync(resolve(process.cwd(), filename), 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const value = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key]) process.env[key] = value;
        }
    } catch {
        /* file missing, skip */
    }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

const fixtureToken = process.env.CAPTURE_WS_FIXTURE_TOKEN;
if (!fixtureToken) {
    console.error('CAPTURE_WS_FIXTURE_TOKEN not found in .env.local.');
    console.error(
        'Add a LOW-PRIVILEGE GUEST TOKEN (not admin SPACETIMEDB_SERVER_TOKEN).',
    );
    console.error('To generate a guest token:');
    console.error('  1. Run dev server: npm run dev');
    console.error('  2. Sign in as guest from the UI');
    console.error('  3. Copy SPACETIMEDB_TOKEN from browser localStorage');
    console.error('  4. Add to .env.local: CAPTURE_WS_FIXTURE_TOKEN=<paste>');
    process.exit(1);
}
if (!process.env.SPACETIMEDB_SERVER_TOKEN) {
    console.warn(
        '[CAPTURE] SPACETIMEDB_SERVER_TOKEN not set in environment — cannot verify CAPTURE_WS_FIXTURE_TOKEN is not the admin token. Continuing on caller responsibility.',
    );
} else if (fixtureToken === process.env.SPACETIMEDB_SERVER_TOKEN) {
    console.error(
        'CAPTURE_WS_FIXTURE_TOKEN must NOT equal SPACETIMEDB_SERVER_TOKEN.',
    );
    console.error(
        'Admin token would skew the bandwidth profile (per RESEARCH.md OQ-2).',
    );
    process.exit(1);
}

let host =
    process.env.SPACETIMEDB_HOST ??
    process.env.NEXT_PUBLIC_SPACETIMEDB_HOST ??
    'wss://maincloud.spacetimedb.com';
if (host.startsWith('https://')) host = host.replace('https://', 'wss://');
else if (host.startsWith('http://')) host = host.replace('http://', 'ws://');

let dbName: string;
try {
    const stConfig = JSON.parse(
        readFileSync(resolve(process.cwd(), 'spacetime.json'), 'utf-8'),
    );
    dbName = stConfig.database;
} catch {
    console.error('spacetime.json not found — run from project root');
    process.exit(1);
}

const FRAME_LOG =
    '.planning/phases/16.4-spacetimedb-v2-2-0-refactor-pass/transport-evidence/frames.jsonl';
if (!existsSync(dirname(FRAME_LOG))) mkdirSync(dirname(FRAME_LOG), { recursive: true });
writeFileSync(FRAME_LOG, ''); // truncate at start so each capture session is fresh

let observedProtocol: string | null = null;

/**
 * WebSocketFactory replacement. Replicates the SDK's `openWebSocket` URL
 * construction (verified at spacetimedb/dist/index.cjs:5033-5074), then opens
 * a `ws` WebSocket and wraps it as a `WebSocketAdapter`. Every frame is logged
 * to FRAME_LOG with `{ t, dir, size }`. Compression is forced OFF on this
 * builder (see `.withCompression('none')` below) so logged sizes match the
 * actual on-wire frame sizes (no leading compression-tag byte to strip).
 */
const factory = async (args: {
    url: URL;
    wsProtocol: string[];
    nameOrAddress: string;
    authToken?: string;
    compression: 'gzip' | 'brotli' | 'none';
    lightMode: boolean;
    confirmedReads?: boolean;
}): Promise<{
    readonly protocol: string;
    send(msg: Uint8Array): void;
    close(): void;
    onclose: ((ev: any) => void) | null;
    onopen: (() => void) | null;
    onmessage: ((msg: { data: Uint8Array }) => void) | null;
    onerror: ((msg: any) => void) | null;
}> => {
    // Mint temporary one-shot WS token from longer authToken (matches SDK).
    let temporaryAuthToken: string | undefined;
    if (args.authToken) {
        const tokenUrl = new URL('v1/identity/websocket-token', args.url);
        tokenUrl.protocol = args.url.protocol === 'wss:' ? 'https:' : 'http:';
        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${args.authToken}` },
        });
        if (!response.ok) {
            throw new Error(
                `Failed to mint WS token: ${response.status} ${response.statusText}`,
            );
        }
        const { token } = (await response.json()) as { token: string };
        temporaryAuthToken = token;
    }

    const databaseUrl = new URL(
        `v1/database/${args.nameOrAddress}/subscribe`,
        args.url,
    );
    if (temporaryAuthToken) {
        databaseUrl.searchParams.set('token', temporaryAuthToken);
    }
    const compressionTag =
        ({ gzip: 'Gzip', brotli: 'Brotli', none: 'None' } as const)[args.compression] ??
        'None';
    databaseUrl.searchParams.set('compression', compressionTag);
    if (args.lightMode) databaseUrl.searchParams.set('light', 'true');
    if (args.confirmedReads !== undefined) {
        databaseUrl.searchParams.set('confirmed', args.confirmedReads.toString());
    }

    const ws = new WebSocket(databaseUrl.toString(), args.wsProtocol);
    ws.binaryType = 'arraybuffer';

    ws.on('upgrade', (res: any) => {
        observedProtocol = res.headers['sec-websocket-protocol'] ?? null;
    });

    const logFrame = (
        direction: 'in' | 'out',
        data: ArrayBuffer | Uint8Array | string | Buffer,
    ) => {
        let size = 0;
        if (typeof data === 'string') {
            size = Buffer.byteLength(data);
        } else if (data instanceof ArrayBuffer) {
            size = data.byteLength;
        } else {
            // Buffer (Node) extends Uint8Array; both expose byteLength.
            size = (data as Uint8Array).byteLength;
        }
        appendFileSync(
            FRAME_LOG,
            JSON.stringify({ t: Date.now(), dir: direction, size }) + '\n',
        );
    };

    // Adapter shape per dist/sdk/ws.d.ts WebSocketAdapter interface.
    const adapter = {
        get protocol() {
            return ws.protocol ?? '';
        },
        send(msg: Uint8Array) {
            logFrame('out', msg);
            ws.send(msg);
        },
        close() {
            ws.close();
        },
        onclose: null as ((ev: any) => void) | null,
        onopen: null as (() => void) | null,
        onmessage: null as ((m: { data: Uint8Array }) => void) | null,
        onerror: null as ((m: any) => void) | null,
    };

    ws.onopen = () => adapter.onopen?.();
    ws.onclose = (ev: any) => adapter.onclose?.(ev);
    ws.onerror = (ev: any) => adapter.onerror?.(ev);
    ws.onmessage = (msg: any) => {
        const buf: ArrayBuffer | Buffer = msg.data;
        // Inbound is binary BSATN with a 1-byte compression tag (0=none, 1=brotli, 2=gzip).
        // We forced compression='none' so tag should always be 0; size we log is on-wire.
        logFrame('in', buf);
        const u8 =
            buf instanceof ArrayBuffer
                ? new Uint8Array(buf)
                : new Uint8Array(
                      (buf as Buffer).buffer,
                      (buf as Buffer).byteOffset,
                      (buf as Buffer).byteLength,
                  );
        // Strip the 1-byte compression tag so the SDK sees plain decompressed BSATN.
        const tag = u8[0];
        if (tag !== 0) {
            // none was forced; if the server still chose to compress, error loudly
            // rather than silently mis-decoding.
            adapter.onerror?.(
                new Error(`Unexpected compression tag ${tag}; expected 0 (none)`),
            );
            return;
        }
        const data = u8.subarray(1);
        adapter.onmessage?.({ data });
    };

    return adapter;
};

console.log(`[CAPTURE] Connecting to ${host} / ${dbName} ...`);
const t0 = Date.now();

DbConnection.builder()
    .withUri(host)
    .withDatabaseName(dbName)
    .withToken(fixtureToken)
    .withConfirmedReads(false)
    .withCompression('none')
    .withWSFn(factory as any)
    .onConnect(async (conn: any) => {
        console.log(
            `[CAPTURE] Connected. Protocol: ${observedProtocol ?? '(unknown)'}`,
        );

        // Deterministic session per CONTEXT.md D-04:
        // 1. Subscribe to 7 layer-0 reference tables.
        const layerZero = [
            'SELECT * FROM hsr_character',
            'SELECT * FROM hsr_lightcone',
            'SELECT * FROM hsr_character_cost',
            'SELECT * FROM hsr_lightcone_cost',
            'SELECT * FROM hsr_synergy_cost',
            'SELECT * FROM archetype',
            'SELECT * FROM hsr_character_archetype',
        ];
        const sub = conn.subscriptionBuilder().subscribe(layerZero);
        console.log('[CAPTURE] Subscribed to 7 layer-0 tables.');

        // 2. Wait 2s for initial sync flood.
        await new Promise((r) => setTimeout(r, 2000));

        // 3. Emit a no-op-safe reducer call (loginAsGuest is idempotent for an
        //    already-authed guest token; produces a small request/response pair
        //    that exercises the v3 batching boundary).
        try {
            await conn.reducers.loginAsGuest();
            console.log('[CAPTURE] No-op reducer call complete.');
        } catch (err) {
            console.warn(
                '[CAPTURE] Reducer call failed (non-fatal for capture):',
                err,
            );
        }

        // 4. Wait 1s for response + any tail frames.
        await new Promise((r) => setTimeout(r, 1000));

        // 5. Unsubscribe.
        sub.unsubscribe();
        console.log('[CAPTURE] Unsubscribed.');

        // 6. Wait 500ms for unsub frames.
        await new Promise((r) => setTimeout(r, 500));

        const elapsed = Date.now() - t0;
        console.log(
            `[CAPTURE] Session complete in ${elapsed}ms. Frame log: ${FRAME_LOG}`,
        );
        process.exit(0);
    })
    .onConnectError((_ctx: any, err: any) => {
        console.error('[CAPTURE] Connection failed:', err);
        process.exit(1);
    })
    .build();
