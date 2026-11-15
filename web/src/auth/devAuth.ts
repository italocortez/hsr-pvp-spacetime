import { type AuthSnapshot, setAuthSnapshot } from './authStore';

/*
 * Dev only (imported behind `import.meta.env.DEV` in main.tsx, so it is not in the production
 * bundle): lets the guards be checked from the console before login (M5) and the connection (M6).
 */

const PRESETS = {
    visitor: { ready: true },
    guest: {
        ready: true,
        user: { id: 1, role: { tag: 'User' }, isGuest: true, displayName: 'Guest 0001' },
    },
    member: {
        ready: true,
        user: { id: 2, role: { tag: 'User' }, isGuest: false, displayName: 'Trailblazer' },
    },
    moderator: {
        ready: true,
        user: { id: 3, role: { tag: 'Moderator' }, isGuest: false, displayName: 'March 7th' },
    },
    admin: {
        ready: true,
        user: { id: 4, role: { tag: 'Admin' }, isGuest: false, displayName: 'Nathyron' },
    },
    /** Not ready: the bar's neutral account placeholder (S14.1). */
    notReady: { ready: false },
} satisfies Record<string, AuthSnapshot>;

type DevAuthArg = AuthSnapshot | keyof typeof PRESETS;

declare global {
    interface Window {
        __devAuth?: (arg: DevAuthArg) => void;
    }
}

export function installDevAuth(): void {
    window.__devAuth = (arg) => {
        setAuthSnapshot(typeof arg === 'string' ? PRESETS[arg] : arg);
    };
}
