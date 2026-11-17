import { ADOPT_AFTER_MS, BEAT_MS, beatGone, beatGoneAt } from '@shared/loadouts';
import { readBeats, writeBeat } from './loadoutStorage';

/*
 * Which team builder tabs of this browser are still open (S14.3c fix 3, review S1). A tab takes over another tab's
 * account draft only once that tab is really gone, never because the draft has waited a long time.
 *
 * - Web Locks (`navigator.locks`, current Chromium and Firefox): each tab holds a lock named after its id for as
 *   long as its page is mounted. The browser frees it when the tab closes, navigates away or crashes. A tab that
 *   finds a draft owned by another tab asks for that tab's lock: the request is granted only when the owner is gone,
 *   and `onGone` runs then. No timer, no storage write.
 * - No Web Locks: a heartbeat in storage (`PRESENCE_KEY`), written every `BEAT_MS`; a tab whose beat and draft
 *   have both been still for `ADOPT_AFTER_MS` counts as gone. A background tab's timers are slowed to about once a
 *   minute at worst, which stays under that.
 */

const LOCK_PREFIX = 'hsrpvp.teambuilder.tab.';

export type Presence = {
    /** The owner `tab` of a draft last touched at `seen` is known to be gone. */
    gone(tab: string, seen: number, now: number): boolean;
    /** When it will count as gone with no news (heartbeat only); null: `onGone` says it. */
    goneAt(tab: string, seen: number): number | null;
    stop(): void;
};

type LockManagerLike = Pick<LockManager, 'request'>;

function lockManager(): LockManagerLike | null {
    const l = (globalThis.navigator as Navigator | undefined)?.locks as LockManagerLike | undefined;
    return l && typeof l.request === 'function' ? l : null;
}

const ignore = () => {};

/** Starts this tab's presence; `onGone` runs when a watched owner is found gone (Web Locks only). */
export function startPresence(me: string, onGone: () => void): Presence {
    const locks = lockManager();
    if (locks) {
        const stopAll = new AbortController();
        let release: () => void = ignore;
        locks
            .request(
                `${LOCK_PREFIX}${me}`,
                { signal: stopAll.signal },
                () =>
                    new Promise<void>((resolve) => {
                        release = resolve;
                    }),
            )
            .catch(ignore);
        const watched = new Set<string>();
        const goneTabs = new Set<string>();
        const watch = (tab: string) => {
            if (watched.has(tab)) return;
            watched.add(tab);
            locks
                .request(`${LOCK_PREFIX}${tab}`, { signal: stopAll.signal }, () => {
                    // Granted: the owner no longer holds it. Released at once by returning.
                    goneTabs.add(tab);
                    onGone();
                })
                .catch(ignore);
        };
        return {
            gone: (tab) => {
                watch(tab);
                return goneTabs.has(tab);
            },
            goneAt: () => null,
            stop: () => {
                release();
                stopAll.abort();
            },
        };
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const beat = () => {
        const now = Date.now();
        writeBeat(me, now, now - 2 * ADOPT_AFTER_MS);
        // A chain of timeouts (not an interval): one beat at a time, whatever the browser's throttling.
        timer = setTimeout(beat, BEAT_MS);
    };
    beat();
    return {
        gone: (tab, seen, now) => beatGone(seen, readBeats()[tab] ?? null, now),
        goneAt: (tab, seen) => beatGoneAt(seen, readBeats()[tab] ?? null),
        stop: () => {
            if (timer) clearTimeout(timer);
            writeBeat(me, null, Date.now() - 2 * ADOPT_AFTER_MS);
        },
    };
}
