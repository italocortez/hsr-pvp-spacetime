import { Link, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AuthSnapshot } from '@/auth/authStore';
import { isStaff } from '@/auth/guards';
import { BrandLogo } from '@/components/BrandLogo/BrandLogo';
import { GearIcon } from '@/components/GearIcon/GearIcon';
import { AccountArea } from './AccountArea';
import styles from './NavBar.module.css';
import { type PhoneItem, PhoneMenu, useFocusHandover, useMenuForm } from './PhoneMenu';

/**
 * The bar's items, in the order of every mockup's `.centerNav` (design/mockups/*.html). Labels are
 * written in title case and shown in capitals by CSS. Only pages with a route are listed (the
 * mockups' active-lobby item needs the lobby room port).
 */
export const NAV_ITEMS = [
    { to: '/lobbies', label: 'Lobbies' },
    { to: '/teambuilder', label: 'Team Builder' },
    { to: '/costs', label: 'Cost Tables' },
    { to: '/tournaments', label: 'Tournaments' },
    { to: '/calendar', label: 'Calendar' },
] as const;

/** How far one chevron click scrolls the items (the mockups' value). */
const SCROLL_STEP = 150;

/** The panel's extra row for staff (the gear's target; the gear is not shown in the menu form). */
const ADMIN_ITEM = { to: '/admin', label: 'Admin' } as const;

/**
 * Fixed 56px bar (DESIGN.md 5.3, the mockups' `.navbar`): home mark, the page links, the admin
 * gear for staff, and the account area. One `nav` landmark ("Primary") holds the page links at
 * every width: above the switch point the items row (a horizontal scroller with chevrons when
 * they do not fit, as in the mockups) and the gear; at or below it (`--nav-menu` in
 * `styles/media.css`) the menu button with the current page's name and the panel (S14.1b,
 * `PhoneMenu`), the gear's target being a row of the panel. Only one form is rendered; when the
 * form switches with focus inside the navigation, focus moves to the new form (the Menu button,
 * or the current page's row link, else the first).
 */
export function NavBar({
    auth,
    onMenuInset,
}: {
    auth: AuthSnapshot;
    /** The open panel's height in px (0 when closed), so the reconnecting line can sit below it. */
    onMenuInset?: (px: number) => void;
}) {
    const menuForm = useMenuForm();
    const staff = isStaff(auth);
    const phoneItems: readonly PhoneItem[] = staff ? [...NAV_ITEMS, ADMIN_ITEM] : NAV_ITEMS;

    // Set by the form being replaced when focus was inside its nav; read once the new one is in.
    const headerRef = useRef<HTMLElement>(null);
    const handover = useRef(false);
    useLayoutEffect(() => {
        if (!handover.current) return;
        handover.current = false;
        const nav = headerRef.current?.querySelector('nav');
        const target = menuForm
            ? nav?.querySelector<HTMLElement>('button')
            : (nav?.querySelector<HTMLElement>('a[aria-current="page"]') ??
              nav?.querySelector<HTMLElement>('a'));
        target?.focus();
    }, [menuForm]);

    return (
        <header className={styles.bar} ref={headerRef}>
            <div className={styles.left}>
                <Link
                    to="/"
                    className={styles.home}
                    aria-label="IPC Battlegrounds"
                    activeOptions={{ exact: true, includeSearch: false }}
                >
                    <BrandLogo className={styles.logo} />
                </Link>
            </div>

            {menuForm ? (
                <PhoneMenu items={phoneItems} onInset={onMenuInset} handover={handover} />
            ) : (
                <ItemRow handover={handover} />
            )}

            <div className={styles.right}>
                {staff && !menuForm && (
                    <Link to="/admin" className={styles.gear} aria-label="Admin Console">
                        <GearIcon className={styles.gearIcon} />
                    </Link>
                )}
                <AccountArea auth={auth} />
            </div>
        </header>
    );
}

/** The items row above the switch point: the scroller with its pointer-only chevrons. */
function ItemRow({ handover }: { handover: { current: boolean } }) {
    const { listRef, canLeft, canRight, scrollBy } = useScroller();
    const navRef = useRef<HTMLElement>(null);
    useFocusHandover(navRef, handover);

    return (
        <>
            {/* Pointer aids only: keyboard users Tab through the links (the list scrolls the
                focused one into view) and touch users swipe, so the chevrons stay out of the Tab
                order and the accessibility tree, and a press never focuses them (focus stays
                where it was, never on a hidden control). */}
            <button
                type="button"
                className={`${styles.chevron} ${canLeft ? styles.chevronVisible : ''}`}
                tabIndex={-1}
                aria-hidden="true"
                onPointerDown={keepFocus}
                onMouseDown={keepFocus}
                onClick={() => scrollBy(-SCROLL_STEP)}
                data-chevron="left"
            >
                {'‹'}
            </button>

            <nav className={styles.nav} aria-label="Primary" ref={navRef}>
                <ul className={styles.items} ref={listRef}>
                    {NAV_ITEMS.map((item) => (
                        <li key={item.to} className={styles.itemSlot}>
                            <Link to={item.to} className={styles.item} onFocus={revealFocused}>
                                <span className={styles.itemBorder} aria-hidden="true" />
                                {item.label}
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>

            <button
                type="button"
                className={`${styles.chevron} ${canRight ? styles.chevronVisible : ''}`}
                tabIndex={-1}
                aria-hidden="true"
                onPointerDown={keepFocus}
                onMouseDown={keepFocus}
                onClick={() => scrollBy(SCROLL_STEP)}
                data-chevron="right"
            >
                {'›'}
            </button>
        </>
    );
}

const prefersReducedMotion = (): boolean =>
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * A focused item is scrolled wholly into the list (Chromium scrolls a focused element only when
 * it is fully hidden, so a partly visible one would stay a sliver), within the list's scroll
 * padding; `nearest` on both axes, so only the list moves, and only as far as needed.
 */
function revealFocused(event: { currentTarget: HTMLElement }): void {
    event.currentTarget.scrollIntoView?.({
        inline: 'nearest',
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
}

/** A press that must not move focus (the click still fires). */
function keepFocus(event: { preventDefault(): void }): void {
    event.preventDefault();
}

/** The items' scroll state for the chevrons (shown only while there is more on that side). */
function useScroller() {
    const listRef = useRef<HTMLUListElement>(null);
    const [canLeft, setCanLeft] = useState(false);
    const [canRight, setCanRight] = useState(false);

    const check = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        setCanLeft(list.scrollLeft > 0);
        setCanRight(list.scrollLeft < list.scrollWidth - list.clientWidth - 1);
    }, []);

    // The current page's item is scrolled into view (centred) when it is not wholly visible, so a
    // narrow screen still shows where you are. Only the list scrolls, never the page.
    const centreCurrent = useCallback(() => {
        const list = listRef.current;
        const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
        if (!list || !current) return;
        // The list is the items' offset parent (position: relative), so this ignores its scroll.
        const start = current.offsetLeft;
        const end = start + current.offsetWidth;
        if (start >= list.scrollLeft && end <= list.scrollLeft + list.clientWidth) return;
        list.scrollLeft = Math.max(0, start - (list.clientWidth - current.offsetWidth) / 2);
    }, []);

    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        check();
        // A resize or an orientation change re-centres the current item, then updates the
        // chevrons (the list's own size change covers both, the window events catch the rest).
        const resized = () => {
            centreCurrent();
            check();
        };
        list.addEventListener('scroll', check, { passive: true });
        window.addEventListener('resize', resized);
        window.addEventListener('orientationchange', resized);
        const observer =
            typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resized);
        observer?.observe(list);
        return () => {
            list.removeEventListener('scroll', check);
            window.removeEventListener('resize', resized);
            window.removeEventListener('orientationchange', resized);
            observer?.disconnect();
        };
    }, [check, centreCurrent]);

    // And on each navigation.
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on every navigation
    useEffect(() => {
        centreCurrent();
    }, [pathname, centreCurrent]);

    const scrollBy = useCallback((left: number) => {
        listRef.current?.scrollBy?.({ left, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }, []);

    return { listRef, canLeft, canRight, scrollBy };
}
