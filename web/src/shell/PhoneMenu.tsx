import { Link, useRouterState } from '@tanstack/react-router';
import {
    type MouseEvent,
    type RefObject,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { MenuIcon } from '@/components/MenuIcon/MenuIcon';
import mediaCss from '@/styles/media.css?raw';
import type { NAV_ITEMS } from './NavBar';
import styles from './NavBar.module.css';

/** The condition of `@custom-media <name> <condition>;` in `css`; throws when it is not defined. */
export function customMediaQuery(css: string, name: string): string {
    const found = new RegExp(`@custom-media\\s+${name}\\s+([^;]+);`).exec(css);
    if (!found?.[1]) throw new Error(`@custom-media ${name} is not defined`);
    return found[1].trim();
}

/**
 * The bar's switch point, read from `--nav-menu` in `styles/media.css` (the one line that moves
 * it): at or below it the bar renders the menu, above it the items row.
 */
export const NAV_MENU_QUERY = customMediaQuery(mediaCss, '--nav-menu');

function subscribeMenuForm(onChange: () => void): () => void {
    const query = globalThis.matchMedia?.(NAV_MENU_QUERY);
    query?.addEventListener?.('change', onChange);
    return () => query?.removeEventListener?.('change', onChange);
}

const readMenuForm = (): boolean => globalThis.matchMedia?.(NAV_MENU_QUERY).matches === true;

/** True in the menu form (false where `matchMedia` is missing: the row is the default). */
export function useMenuForm(): boolean {
    return useSyncExternalStore(subscribeMenuForm, readMenuForm, () => false);
}

/**
 * When the bar switches form, the form going away reports whether focus was inside its `nav`
 * (read in its layout cleanup, before its DOM is removed), so the bar can hand focus to the new
 * form instead of letting it drop to `body`.
 */
export function useFocusHandover(
    navRef: RefObject<HTMLElement | null>,
    handover?: { current: boolean },
): void {
    useLayoutEffect(() => {
        const nav = navRef.current;
        return () => {
            if (handover && nav?.contains(document.activeElement)) handover.current = true;
        };
    }, [navRef, handover]);
}

export type PhoneItem = { to: (typeof NAV_ITEMS)[number]['to'] | '/admin'; label: string };

/**
 * The item for `pathname`: an item is current on its own path and on any path below it
 * (`/lobbies/x` is Lobbies), as the router's default `aria-current` on the links; a mere prefix
 * is not (`/lobbiesx` is none).
 */
export function currentItem<T extends PhoneItem>(items: readonly T[], pathname: string) {
    return items.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
}

/**
 * The bar's navigation in the menu form (S14.1b): a disclosure (web-guidance navbar: site
 * navigation, not an application menu). A button named "Menu" with `aria-expanded` and
 * `aria-controls` reveals a list of plain router links, which stay in the Tab order (no menu
 * roles, no arrow keys). Beside it, the current page's name as plain text (hidden from assistive
 * technology: the page's `h1` and the current link's `aria-current` already say it).
 *
 * Opens on click, Enter or Space; a keyboard open focuses the first link, a pointer open leaves
 * focus on the button. Closes on choosing a link, Escape (focus back to the button when it was
 * inside), a press or focus outside, and any navigation; it unmounts (closed) when the bar
 * switches to the row or a splash replaces the shell. Choosing the page already shown (same
 * path, search and hash) closes it and returns focus to the button without a navigation; the
 * same path with another search or hash navigates to the bare path, as the row's link does, and
 * focus returns to the button. A row removed while focused (a lost role) hands focus to the
 * button. Not modal: nothing is inert.
 */
export function PhoneMenu({
    items,
    onInset,
    handover,
}: {
    items: readonly PhoneItem[];
    onInset?: (px: number) => void;
    handover?: { current: boolean };
}) {
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const href = useRouterState({ select: (s) => s.location.href });
    const current = currentItem(items, pathname);

    const [open, setOpen] = useState(false);
    const enterOnOpen = useRef(false);
    const refocusAfterNavigation = useRef(false);
    const rowLostFocus = useRef(false);
    const navRef = useRef<HTMLElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const panelId = useId();

    useFocusHandover(navRef, handover);

    // Any navigation (a link here, the back button, a link elsewhere) closes the panel.
    const lastHref = useRef(href);
    useEffect(() => {
        if (lastHref.current === href) return;
        lastHref.current = href;
        setOpen(false);
        if (refocusAfterNavigation.current) {
            refocusAfterNavigation.current = false;
            buttonRef.current?.focus();
        }
    }, [href]);

    // A row removed while it had focus and the panel stays open (a lost role): to the button.
    // When the panel closed in the same commit, its own rule places focus.
    useLayoutEffect(() => {
        if (!rowLostFocus.current) return;
        rowLostFocus.current = false;
        if (open) buttonRef.current?.focus();
    });

    // A keyboard open moves focus to the first link once the panel is shown.
    useEffect(() => {
        if (!open || !enterOnOpen.current) return;
        enterOnOpen.current = false;
        panelRef.current?.querySelector<HTMLElement>('a')?.focus();
    }, [open]);

    // A press or focus outside the nav closes it; Escape closes it and, when focus was inside,
    // returns focus to the button.
    useEffect(() => {
        if (!open) return;
        const outside = (event: Event) => {
            if (!navRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            const inside = navRef.current?.contains(document.activeElement) === true;
            setOpen(false);
            if (inside) buttonRef.current?.focus();
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('focusin', outside);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('focusin', outside);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    // The open panel's height goes to the shell (the reconnecting line sits below it); 0 when
    // closed or unmounted.
    useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!open || !panel || !onInset) return;
        const report = () => onInset(Math.ceil(panel.getBoundingClientRect().height));
        report();
        const observer =
            typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(report);
        observer?.observe(panel);
        return () => {
            observer?.disconnect();
            onInset(0);
        };
    }, [open, onInset]);

    const onButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
        if (open) {
            setOpen(false);
            return;
        }
        // `detail` is 0 for a click made with Enter or Space.
        enterOnOpen.current = event.detail === 0;
        setOpen(true);
    };

    const onLinkClick = (item: PhoneItem, event: MouseEvent<HTMLAnchorElement>) => {
        // A modified click (new tab or window) leaves the panel and this page alone.
        const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
        if (event.button !== 0 || modified) return;
        if (href === item.to) {
            // The page already shown, exactly: no navigation, back to the button.
            event.preventDefault();
            setOpen(false);
            buttonRef.current?.focus();
            return;
        }
        // The same page with another search or hash: the link goes to the bare path (as the
        // row's does); the announcer moves nothing for it, so focus returns to the button.
        if (pathname === item.to) refocusAfterNavigation.current = true;
        setOpen(false);
    };

    return (
        <nav className={styles.phone} aria-label="Primary" ref={navRef}>
            <button
                ref={buttonRef}
                type="button"
                className={styles.menuButton}
                aria-expanded={open}
                aria-controls={panelId}
                aria-label="Menu"
                onClick={onButtonClick}
            >
                <MenuIcon className={styles.menuIcon} />
            </button>
            {current && (
                <span className={styles.here} aria-hidden="true" data-current-page="">
                    {current.label}
                </span>
            )}
            <div ref={panelRef} id={panelId} className={styles.panel} hidden={!open}>
                {/* Links exist only while open: a closed panel holds nothing to find or focus. */}
                {open && (
                    <ul className={styles.panelList}>
                        {items.map((item) => (
                            <PanelRow
                                key={item.to}
                                item={item}
                                lostFocus={rowLostFocus}
                                onClick={(event) => onLinkClick(item, event)}
                            />
                        ))}
                    </ul>
                )}
            </div>
        </nav>
    );
}

function PanelRow({
    item,
    lostFocus,
    onClick,
}: {
    item: PhoneItem;
    lostFocus: { current: boolean };
    onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
    const rowRef = useRef<HTMLLIElement>(null);
    // Removed while its link has focus: tell the panel (read before the DOM goes).
    useLayoutEffect(() => {
        const row = rowRef.current;
        return () => {
            if (row?.contains(document.activeElement)) lostFocus.current = true;
        };
    }, [lostFocus]);
    return (
        <li ref={rowRef} className={styles.panelSlot}>
            <Link to={item.to} className={styles.panelLink} onClick={onClick}>
                <span className={styles.panelLabel}>
                    <span className={styles.itemBorder} aria-hidden="true" />
                    {item.label}
                </span>
            </Link>
        </li>
    );
}
