/*
 * The maintenance status file (A171 item 1, M7): `web/public/status.json`, served as
 * `/status.json` next to the app and read before the connection is built. While it says
 * `{ "maintenance": true }` the app builds no connection (no socket, no retries, no database
 * energy) and shows the maintenance splash. Everything else fails open: a missing file, a non-200
 * answer, a body that is not JSON or not the expected shape, a network error or a timeout all
 * mean "not in maintenance". Hosting rules: docs/frontend/hosting.md.
 */

export const STATUS_FILE_PATH = '/status.json';

/** Orchestrator's choice (M7 brief): a slow status file must not hold the connection up for long. */
export const STATUS_FILE_TIMEOUT_MS = 3000;

/** `?maintenance=skip` on any URL ignores the status file for the rest of the tab (staff only). */
export const MAINTENANCE_SKIP_PARAM = 'maintenance';
export const MAINTENANCE_SKIP_VALUE = 'skip';
export const MAINTENANCE_SKIP_KEY = 'hsr-pvp:maintenance-skip';

/**
 * True only for an object whose `maintenance` field is exactly boolean `true`. Other fields
 * (`message`, anything new) are ignored.
 */
export function parseMaintenance(body: unknown): boolean {
    return (
        typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        (body as { maintenance?: unknown }).maintenance === true
    );
}

type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'json'>>;

/**
 * Reads the status file once, uncached, and resolves true only when it says maintenance. Never
 * rejects: any failure, no answer within `timeoutMs`, or an abort through `signal` resolves false.
 */
export function fetchMaintenance(
    fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
    timeoutMs: number = STATUS_FILE_TIMEOUT_MS,
    signal?: AbortSignal,
): Promise<boolean> {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const read = async () => {
        const response = await fetchImpl(STATUS_FILE_PATH, {
            cache: 'no-store',
            signal: controller.signal,
        });
        if (response.status !== 200) return false;
        return parseMaintenance(await response.json());
    };
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            controller.abort();
            resolve(false);
        }, timeoutMs);
        read()
            .then(resolve, () => resolve(false))
            .finally(() => clearTimeout(timer));
    });
}

/**
 * True when this tab ignores the status file: the URL carries `?maintenance=skip` (which sets the
 * flag), or an earlier URL in this tab did. The module stays the authority: during maintenance it
 * still refuses every non-Admin connection, which then ends on the offline splash. A blocked
 * storage only means the flag lasts while the parameter is in the URL.
 */
export function maintenanceSkipped(search: string = globalThis.location?.search ?? ''): boolean {
    if (new URLSearchParams(search).get(MAINTENANCE_SKIP_PARAM) === MAINTENANCE_SKIP_VALUE) {
        try {
            globalThis.sessionStorage?.setItem(MAINTENANCE_SKIP_KEY, '1');
        } catch {
            // Storage blocked: the parameter itself still counts.
        }
        return true;
    }
    try {
        return globalThis.sessionStorage?.getItem(MAINTENANCE_SKIP_KEY) === '1';
    } catch {
        return false;
    }
}
