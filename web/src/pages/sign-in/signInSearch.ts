import { LOGIN_STATUSES, type LoginStatus } from '@shared/auth-flow';
import { type LoginSearch, parseLoginSearch } from '@/auth/loginSearch';

/** Search params of `/`: the login prompt (`login`, `next`) plus the return `status` (M5b). */
export type IndexSearch = LoginSearch & { status?: LoginStatus };

/**
 * `validateSearch` for `/`. `status` is kept only when it is one of the four return words the
 * function writes (`confirm`, `refused`, `cancelled`, `failed`); nothing else is read from the
 * URL (never a code or a token). Idempotent, every key always present (A169).
 */
export function parseIndexSearch(search: Record<string, unknown>): IndexSearch {
    const status = search.status;
    return {
        ...parseLoginSearch(search),
        status: (LOGIN_STATUSES as readonly unknown[]).includes(status)
            ? (status as LoginStatus)
            : undefined,
    };
}
