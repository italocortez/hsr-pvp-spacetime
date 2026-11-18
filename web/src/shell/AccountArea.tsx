import { Link, useRouterState } from '@tanstack/react-router';
import {
    type KeyboardEvent,
    type MouseEvent,
    type ReactNode,
    useEffect,
    useId,
    useRef,
    useState,
} from 'react';
import type { AuthSnapshot } from '@/auth/authStore';
import { loginSearchFor } from '@/auth/loginSearch';
import { signOut } from '@/auth/signOut';
import { openSignInDialog, preloadSignInDialog } from '@/pages/sign-in/signInDialogState';
import styles from './AccountArea.module.css';

/** The menu's actions, an object so tests can spy on them. `signOut` is SDK-free (entry chunk). */
export const accountActions = {
    signOut: (): void => signOut(),
};

/**
 * A plain click on "Sign in" opens the sign-in dialog over the page (S14.4b, A221 R1) instead of following the link.
 * A modified or middle click still opens the full-screen panel (`/?login=1&next=…`) in a new tab or window.
 */
function openDialogInstead(event: MouseEvent<HTMLAnchorElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
    event.preventDefault();
    openSignInDialog(event.currentTarget);
}

/**
 * The bar's account area (S14.1), one fixed-size slot in every auth state so nothing moves when
 * the profile arrives: a neutral placeholder while auth is not ready; "Sign in" for a visitor or
 * a guest (a link to `/?login=1&next=<this page>` whose plain click opens the sign-in dialog,
 * S14.4b); for a member the account chip (the mockups' `.accountChip`, initials in place of the
 * avatar) opening a menu with Profile and Sign out.
 */
export function AccountArea({ auth }: { auth: AuthSnapshot }) {
    const href = useRouterState({ select: (s) => s.location.href });
    const member = auth.user && !auth.user.isGuest ? auth.user : undefined;

    let content: ReactNode;
    if (!auth.ready) {
        content = <span className={styles.placeholder} aria-hidden="true" data-account="pending" />;
    } else if (member) {
        content = <AccountMenu name={member.displayName?.trim() || 'Account'} />;
    } else {
        content = (
            <Link
                className={styles.signIn}
                to="/"
                search={loginSearchFor(href)}
                // The dialog replaces the panel here: no route preload on hover, the dialog's chunk instead.
                preload={false}
                aria-haspopup="dialog"
                onClick={openDialogInstead}
                onPointerEnter={preloadSignInDialog}
                onFocus={preloadSignInDialog}
            >
                Sign in
            </Link>
        );
    }
    return (
        <div className={styles.slot} data-account-slot="">
            {content}
        </div>
    );
}

/**
 * The first character of `name` as the reader sees it (a grapheme: an emoji sequence, a letter
 * with its combining marks), upper-cased unless that would make it more than one character
 * (`ß` upper-cases to "SS"); `?` for a blank name. The avatar fallback.
 */
export function initialOf(name: string): string {
    const first = firstGrapheme(name.trim());
    if (!first) return '?';
    const upper = first.toLocaleUpperCase();
    return Array.from(upper).length === Array.from(first).length ? upper : first;
}

function firstGrapheme(text: string): string | undefined {
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
        for (const { segment } of segments) return segment;
        return undefined;
    }
    // No Segmenter: one whole code point (never half of a surrogate pair).
    return Array.from(text)[0];
}

/**
 * A menu button (web-guidance `menu`: one Tab stop on the trigger; arrow keys, Home and End
 * inside; Escape closes and returns focus to the trigger; Tab leaves and closes; a keyboard open
 * focuses the first item, a pointer open leaves focus on the trigger). Built on React state and
 * explicit `menu` / `menuitem` roles (the guide's fallback for browsers without focusgroup), not
 * the Popover API: the menu is positioned absolutely under the chip, so it needs no anchor
 * positioning (which the guide lists as missing in Chromium and Firefox) and no script placement.
 */
function AccountMenu({ name }: { name: string }) {
    const [open, setOpen] = useState(false);
    const enterOnOpen = useRef(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const baseId = useId();
    const triggerId = `${baseId}-trigger`;
    const menuId = `${baseId}-menu`;

    // A navigation (the Profile item, a bar link, the back button) closes the menu.
    const href = useRouterState({ select: (s) => s.location.href });
    const lastHref = useRef(href);
    useEffect(() => {
        if (lastHref.current === href) return;
        lastHref.current = href;
        setOpen(false);
    }, [href]);

    const items = () =>
        Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

    // A keyboard open enters the menu once it is shown.
    useEffect(() => {
        if (!open || !enterOnOpen.current) return;
        enterOnOpen.current = false;
        menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [open]);

    // Focus or a press outside the menu and its trigger closes it (no trap).
    useEffect(() => {
        if (!open) return;
        const outside = (event: Event) => {
            if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('focusin', outside);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('focusin', outside);
        };
    }, [open]);

    const closeToTrigger = () => {
        setOpen(false);
        triggerRef.current?.focus();
    };

    const onTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
        if (open) {
            setOpen(false);
            return;
        }
        // `detail` is 0 for a click made with Enter or Space.
        enterOnOpen.current = event.detail === 0;
        setOpen(true);
    };

    const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        if (open) items()[0]?.focus();
        else {
            enterOnOpen.current = true;
            setOpen(true);
        }
    };

    const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const list = items();
        const current = list.indexOf(document.activeElement as HTMLElement);
        let next: number | undefined;
        if (event.key === 'ArrowDown') next = (current + 1) % list.length;
        else if (event.key === 'ArrowUp') next = (current - 1 + list.length) % list.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = list.length - 1;
        else if (event.key === ' ' && event.target instanceof HTMLAnchorElement) {
            // Space activates a command like Enter (menu guide); a link has no Space action.
            event.preventDefault();
            event.target.click();
            return;
        } else if (event.key === 'Tab') {
            setOpen(false);
            return;
        }
        if (next === undefined) return;
        event.preventDefault();
        list[next]?.focus();
    };

    // Escape closes the open menu wherever focus is in the account area (the trigger after a
    // pointer open, or an item) and returns focus to the trigger.
    const onWrapKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        closeToTrigger();
    };

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: a key listener for the menu's own controls
        <div className={styles.menuWrap} ref={wrapRef} onKeyDown={onWrapKeyDown}>
            <button
                ref={triggerRef}
                id={triggerId}
                type="button"
                className={styles.chip}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={menuId}
                onClick={onTriggerClick}
                onKeyDown={onTriggerKeyDown}
            >
                <span className={styles.chipInner}>
                    <span className={styles.avatar} aria-hidden="true">
                        {initialOf(name)}
                    </span>
                    <span className={styles.chipName}>{name}</span>
                </span>
            </button>
            <div
                ref={menuRef}
                id={menuId}
                role="menu"
                aria-labelledby={triggerId}
                className={styles.menu}
                hidden={!open}
                onKeyDown={onMenuKeyDown}
            >
                {/* Items exist only while open: a closed menu holds nothing to find or focus. */}
                {open && <MenuItems onClose={() => setOpen(false)} />}
            </div>
        </div>
    );
}

function MenuItems({ onClose }: { onClose: () => void }) {
    return (
        <>
            <Link
                to="/profile"
                role="menuitem"
                tabIndex={-1}
                className={styles.menuItem}
                onClick={onClose}
            >
                Profile
            </Link>
            <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={styles.menuItem}
                onClick={() => {
                    onClose();
                    accountActions.signOut();
                }}
            >
                Sign out
            </button>
        </>
    );
}
