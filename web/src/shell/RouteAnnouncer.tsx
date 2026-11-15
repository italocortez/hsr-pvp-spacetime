import { type AnyRouter, useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import styles from './RouteAnnouncer.module.css';

/** How long the document title must stay the same to count as settled, and the most checks. */
const SETTLE_MS = 16;
const MAX_CHECKS = 60;

/**
 * Focus and announcement after a client-side navigation (S14.1, carried from the S12 list).
 * When the resolved page changes (another route match: another path, or `/` to the sign-in panel
 * at `/?login=1`, which is a match of its own through the route's loader dependency; or another
 * page title), focus moves to the page's `h1` (made focusable with `tabindex="-1"`), or to its
 * `main` when it has none, without scrolling (scroll restoration keeps its position), and the new
 * document title is announced in one polite live region.
 *
 * The page is read only once it has settled: the router is idle (no other load in flight, whose
 * pending screen would show its own title), a `main` exists and the document title has stayed
 * the same over two checks `SETTLE_MS` apart (a page that sets its title a render later is
 * waited for), up to `MAX_CHECKS` checks in all, waiting for the router included. At the cap a
 * page with a `main` is read as it is; without one (or with the router still busy) nothing is
 * read, focused or announced. A navigation that a later one replaces is dropped.
 *
 * The first load does neither, and "first load" lasts until the viewer's first input (a key
 * press, a pointer press, or a click: a screen reader in browse mode activates a link with a
 * synthetic click and no key or pointer event): a guard's redirect that follows the profile's
 * arrival (a visitor's hard load of `/lobby/123` lands on the sign-in panel a moment later) is
 * part of loading the page, not a navigation the viewer made.
 */
export function RouteAnnouncer() {
    const router = useRouter();
    const href = useRouterState({ select: (s) => s.resolvedLocation?.href });
    const [message, setMessage] = useState('');
    const seen = useRef<{ page: string; title: string } | null>(null);
    const interacted = useRef(false);
    const firstHref = useRef<string | undefined>(undefined);
    const leftFirst = useRef(false);

    useEffect(() => {
        const mark = () => {
            interacted.current = true;
        };
        const events = ['pointerdown', 'keydown', 'click'] as const;
        for (const name of events) document.addEventListener(name, mark, { capture: true });
        return () => {
            for (const name of events) {
                document.removeEventListener(name, mark, { capture: true });
            }
        };
    }, []);

    useEffect(() => {
        if (href === undefined) return;
        // Still the first location (keyed by address, so StrictMode's second effect run in dev
        // counts as the same load), until the first resolved location that differs from it.
        if (firstHref.current === undefined) firstHref.current = href;
        else if (href !== firstHref.current) leftFirst.current = true;
        const first = !leftFirst.current;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let lastTitle: string | undefined;
        let checks = 0;
        const check = () => {
            const state = router.state;
            // Replaced by a later navigation: its own effect reads that page.
            if (state.resolvedLocation?.href !== href) return;
            // Another navigation is loading (its pending screen may already show, with its own
            // title): this page is not read until the router is idle again, and if that load
            // resolves elsewhere, the check above drops it. These checks count toward the cap
            // too, so a load that never ends cannot keep this loop alive; at the cap this page
            // is given up unread.
            if (state.status !== 'idle') {
                lastTitle = undefined;
                if (++checks < MAX_CHECKS) timer = setTimeout(check, SETTLE_MS);
                return;
            }
            const title = document.title;
            const hasMain = document.querySelector('main') !== null;
            const settled = hasMain && title === lastTitle;
            if (!settled && ++checks < MAX_CHECKS) {
                lastTitle = title;
                timer = setTimeout(check, SETTLE_MS);
                return;
            }
            // At the cap with no `main` (no page to focus): nothing is recorded or announced.
            if (!hasMain) return;
            const page = pageOf(state);
            const previous = seen.current;
            seen.current = { page, title };
            // The first load (and anything before the viewer's first input): no focus move, no
            // announcement. (A first page left before it settled was never recorded.)
            if (first || !interacted.current) return;
            if (previous && previous.page === page && previous.title === title) return;
            focusPageStart();
            setMessage(title);
        };
        timer = setTimeout(check, 0);
        return () => clearTimeout(timer);
    }, [href, router]);

    return (
        // A bare polite region (no `status` role): a page's own status line stays the only one.
        <div
            className={styles.announcer}
            aria-live="polite"
            aria-atomic="true"
            data-route-announcer=""
        >
            {message}
        </div>
    );
}

/** The resolved page: its match ids (route, path and loader dependencies), not search or hash. */
function pageOf(state: AnyRouter['state']): string {
    return state.matches.map((m) => m.id).join('\n');
}

/** Focuses the page's `h1`, or its `main`, without scrolling. */
function focusPageStart(): void {
    const main = document.querySelector<HTMLElement>('main');
    const target = main?.querySelector<HTMLElement>('h1') ?? main;
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
}
