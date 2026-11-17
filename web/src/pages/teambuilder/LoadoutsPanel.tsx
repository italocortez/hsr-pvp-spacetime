import {
    ACCOUNT_LOADOUT_LIMIT,
    BROWSER_LOADOUT_LIMIT,
    type Difference,
    type Hold,
    LOADOUT_NAME_MAX,
    loadoutName,
} from '@shared/loadouts';
import { Link, useRouterState } from '@tanstack/react-router';
import {
    type KeyboardEvent,
    type MouseEvent,
    type ReactNode,
    type RefObject,
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
} from 'react';
import { loginSearchFor } from '@/auth/loginSearch';
import hidden from '@/styles/visuallyHidden.module.css';
import { AutosaveRing, reasonText } from './AutosaveRing';
import styles from './LoadoutsPanel.module.css';
import {
    CaretIcon,
    CheckIcon,
    DuplicateIcon,
    LinkIcon,
    PencilIcon,
    TrashIcon,
    UploadIcon,
} from './TeamBuilderIcons';
import page from './TeamBuilderPage.module.css';
import type { LoadoutItem, LoadoutsState, Store } from './useLoadouts';

/*
 * The Loadouts card (S14.3c; design/mockups/teambuilder.html `section.controls`): the combined control (the
 * active loadout's name, always editable, and the caret that opens the switch menu), the save state under it, then
 * "+ New Loadout" and "Copy link". The mockup's Clear Team lives in the roster's head since S14.3a.
 *
 * The menu follows the web-guidance menu guide with the account menu's form (`shell/AccountArea.tsx`): React
 * state and explicit `menu` / `menuitem` / `menuitemradio` roles (the guide's fallback for browsers without
 * focusgroup), positioned under the box by CSS, not a popover. One Tab stop (the caret); Enter, Space or ArrowDown
 * opens and enters (a pointer open leaves focus on the caret); ArrowUp and ArrowDown move through every item, Home
 * and End to the ends; a printable key jumps to the next loadout whose name starts with it; Escape closes and
 * returns focus to the caret; Tab, a press or focus outside closes. Picking a loadout closes the menu.
 *
 * Delete asks first (A190 item 10): a native modal `<dialog>` (the dialog guide's rule 1), Cancel focused, Escape
 * cancels; focus goes back to the caret, since the menu item that opened it has gone.
 */

export const SIGN_IN_HINT = `Sign in with Discord to keep up to ${ACCOUNT_LOADOUT_LIMIT} loadouts on your account, on every device.`;
export const SAVED_IN_BROWSER = 'Saved in this browser';
/** S14.3e (A205): an empty team that is not a loadout yet; nothing waits to be saved. */
export const EMPTY_WORKING = 'Pick a character to start a loadout.';
export const LINK_COPIED = 'Link copied.';
export const LINK_NOT_COPIED =
    'The link could not be copied. It is selected below: copy it from there.';

type Props = {
    loadouts: LoadoutsState;
    /** The page's packed team, for the share link. */
    code: string | null;
    announce: (text: string) => void;
    /** A loadout was put on the page (the page lets go of its pick target). */
    onLoaded: () => void;
    /** A character's display name from its key (the held choice lists team members). */
    characterName?: (key: string) => string;
    /** S14.3d: the team picture's actions, under the share link. */
    picture?: ReactNode;
};

/** A delete waiting for its confirmation; `again`: the account copy was newer, the person is asked again. */
/** `seen`: an account loadout's version when the dialog opened (the delete states it; review M3). */
type Pending = {
    kind: Store;
    key: string;
    name: string;
    again?: boolean;
    seen?: number | null;
} | null;

export function LoadoutsPanel({
    loadouts,
    code,
    announce,
    onLoaded,
    characterName = (key) => key,
    picture,
}: Props) {
    const ids = useId();
    const nameRef = useRef<HTMLInputElement>(null);
    const caretRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDialogElement>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const [field, setField] = useState(loadouts.name);
    const [focused, setFocused] = useState(false);
    const [line, setLine] = useState<string | null>(null);
    const [pending, setPending] = useState<Pending>(null);
    const status = loadouts.status;

    // The field follows the active loadout's name, except while it is being typed in.
    useEffect(() => {
        if (!focused) setField(loadouts.name);
    }, [loadouts.name, focused]);

    const say = useCallback(
        (text: string, visible = false) => {
            announce(text);
            setLine(visible ? text : null);
        },
        [announce],
    );

    // A change of save state is announced once (never the wait itself), and only within one loadout: a switch to
    // another loadout says nothing about its state (review M7).
    const activeId =
        loadouts.active.kind === 'working'
            ? 'working'
            : `${loadouts.active.kind}:${loadouts.active.key}`;
    const stateKey =
        status.kind === 'account'
            ? status.autosave.kind === 'blocked'
                ? `blocked:${status.autosave.reason}`
                : status.autosave.kind === 'saved'
                  ? `saved:${status.autosave.everSaved}`
                  : status.autosave.kind
            : status.kind;
    const lastKey = useRef({ id: activeId, state: stateKey });
    useEffect(() => {
        const prev = lastKey.current;
        lastKey.current = { id: activeId, state: stateKey };
        if (prev.id !== activeId || prev.state === stateKey || status.kind !== 'account') return;
        const s = status.autosave;
        if (s.kind === 'saved' && s.everSaved && prev.state === 'saving') announce('Auto saved.');
        else if (s.kind === 'blocked')
            announce(`Not saved yet. ${reasonText(s.reason, s.message)}`);
    }, [activeId, stateKey, status, announce]);

    // A new loadout or a copy: the name field takes focus with its text selected, once it shows the new name.
    const [selectAsked, setSelectAsked] = useState(0);
    const selectDone = useRef(0);
    useEffect(() => {
        if (selectAsked === selectDone.current || field !== loadouts.name) return;
        selectDone.current = selectAsked;
        nameRef.current?.focus();
        nameRef.current?.select();
    }, [selectAsked, field, loadouts.name]);
    const focusName = () => setSelectAsked((n) => n + 1);

    const onNew = () => {
        const refused = loadouts.create();
        if (refused) {
            say(refused, true);
            return;
        }
        onLoaded();
        say('New loadout. Name it here.');
        focusName();
    };

    // ── Share link.
    const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const linkRef = useRef<HTMLInputElement>(null);
    const shareUrl = code ? `${window.location.origin}/teambuilder?team=${code}` : null;
    useEffect(
        () => () => {
            if (copyTimer.current) clearTimeout(copyTimer.current);
        },
        [],
    );
    const onCopyLink = async () => {
        if (!shareUrl) return;
        if (copyTimer.current) clearTimeout(copyTimer.current);
        setCopied(null);
        let ok = false;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
            await navigator.clipboard.writeText(shareUrl);
            ok = true;
        } catch {
            ok = false;
        }
        // Next frame, so a repeat of the same words is read again (copy-button guide).
        requestAnimationFrame(() => setCopied(ok ? 'ok' : 'failed'));
        if (ok) copyTimer.current = setTimeout(() => setCopied(null), 4000);
    };
    // No clipboard (refused, or not offered): the link shows in a field, focused and selected, to copy by hand.
    useEffect(() => {
        if (copied !== 'failed') return;
        linkRef.current?.focus();
        linkRef.current?.select();
    }, [copied]);

    // ── Delete.
    const askDelete = (item: LoadoutItem) => {
        const ref = { kind: item.store, key: item.key };
        setPending({ ...ref, name: item.name, seen: loadouts.deleteVersion(ref) });
    };
    useEffect(() => {
        const d = dialogRef.current;
        if (!pending || !d || d.open) return;
        if (typeof d.showModal === 'function') d.showModal();
        else d.setAttribute('open', '');
        // The safe action takes focus (React keeps no autofocus attribute for the dialog to find).
        cancelRef.current?.focus();
    }, [pending]);
    const onDialogClose = async () => {
        const d = dialogRef.current;
        const choice = d?.returnValue ?? '';
        if (d) d.returnValue = '';
        const target = pending;
        setPending(null);
        caretRef.current?.focus();
        if (choice !== 'delete' || !target) return;
        const result = await loadouts.remove({ kind: target.kind, key: target.key }, target.seen);
        if (result.kind === 'error') say(result.text, true);
        else if (result.kind === 'changed') {
            // The account copy was newer than the one shown: it is on the page now; ask again (A198). The second
            // ask states no version of its own: the newer copy may still be on its way, and it is the one shown.
            onLoaded();
            say(DELETE_CHANGED);
            setPending({ ...target, again: true, seen: undefined });
        } else {
            onLoaded();
            say(`${target.name} deleted.`);
        }
    };

    const working = status.kind === 'working';
    const statusId = `${ids}-status`;

    return (
        <section className={`${page.section} ${page.loadouts}`} aria-labelledby={`${ids}-head`}>
            <div className={page.sectionHead}>
                <h2 id={`${ids}-head`} className={page.chapter}>
                    <strong>Loadouts</strong>
                </h2>
            </div>
            <div className={styles.body}>
                <LoadoutMenuBox
                    loadouts={loadouts}
                    field={field}
                    nameRef={nameRef}
                    caretRef={caretRef}
                    statusId={statusId}
                    onField={(v) => {
                        setField(v);
                        loadouts.rename(v);
                    }}
                    onFocus={() => setFocused(true)}
                    onBlur={() => {
                        setFocused(false);
                        const clean = loadoutName(field);
                        setField(clean);
                        if (clean !== field) loadouts.rename(clean);
                    }}
                    onPick={(item) => {
                        loadouts.switchTo({ kind: item.store, key: item.key });
                        onLoaded();
                        setLine(null);
                        announce(`${item.name} loaded.`);
                    }}
                    onDuplicate={(item) => {
                        const refused = loadouts.duplicate({ kind: item.store, key: item.key });
                        if (refused) say(refused, true);
                        else {
                            onLoaded();
                            say('Copy made. It is the active loadout now.');
                            focusName();
                        }
                    }}
                    onDelete={askDelete}
                    onCopyToAccount={(item) => {
                        const r = loadouts.copyToAccount(item.key);
                        say(r.text, !r.ok);
                    }}
                />

                <div id={statusId} className={styles.status}>
                    {status.kind === 'account' ? (
                        <AutosaveRing status={status.autosave} reasonId={`${ids}-reason`} />
                    ) : status.kind === 'browser' ? (
                        <span className={styles.browserSaved}>
                            <CheckIcon className={styles.browserCheck} />
                            {loadouts.storageOk
                                ? SAVED_IN_BROWSER
                                : 'Browser storage is off: kept for this visit only'}
                        </span>
                    ) : (
                        <span className={styles.workingState}>
                            {status.full === 'browser'
                                ? `Not saved: this browser holds ${BROWSER_LOADOUT_LIMIT} loadouts. Delete one to save this team.`
                                : status.full === 'account'
                                  ? `Not saved: your account holds ${ACCOUNT_LOADOUT_LIMIT} loadouts. Delete one to save this team.`
                                  : status.loading
                                    ? 'Your account loadouts are loading.'
                                    : status.empty
                                      ? EMPTY_WORKING
                                      : 'Not saved yet. Your first change saves it as a loadout.'}
                        </span>
                    )}
                </div>

                <div className={styles.actions}>
                    <button type="button" className={styles.button} onClick={onNew}>
                        <span aria-hidden="true">+</span> New Loadout
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        onClick={onCopyLink}
                        disabled={!shareUrl}
                        data-copied={copied === 'ok' ? '' : undefined}
                    >
                        {copied === 'ok' ? (
                            <CheckIcon className={styles.buttonIcon} />
                        ) : (
                            <LinkIcon className={styles.buttonIcon} />
                        )}
                        Copy link
                    </button>
                </div>
                <p
                    role="status"
                    className={styles.copyStatus}
                    data-show={copied ? '' : undefined}
                    data-failed={copied === 'failed' ? '' : undefined}
                >
                    {copied === 'ok' ? LINK_COPIED : copied === 'failed' ? LINK_NOT_COPIED : ''}
                </p>
                {copied === 'failed' && shareUrl && (
                    <label className={styles.linkField}>
                        <span>Link to this team</span>
                        <input
                            ref={linkRef}
                            type="text"
                            readOnly
                            value={shareUrl}
                            onFocus={(e) => e.currentTarget.select()}
                        />
                    </label>
                )}
                {picture}

                {line && <p className={styles.line}>{line}</p>}
                {loadouts.notice && (
                    <p className={styles.notice}>
                        <span>{loadouts.notice}</span>
                        <button
                            type="button"
                            className={styles.noticeButton}
                            onClick={loadouts.dismissNotice}
                        >
                            Dismiss
                        </button>
                    </p>
                )}
                {loadouts.held && (
                    <HeldChoice
                        held={loadouts.held}
                        characterName={characterName}
                        onKeep={(key) => {
                            loadouts.keepMine(key);
                            announce('Your changes are kept and saved.');
                        }}
                        onTake={(key) => {
                            loadouts.takeAccountCopy(key);
                            onLoaded();
                            announce('The account copy is back.');
                        }}
                        onSaveNew={(key) => {
                            loadouts.saveAsNew(key);
                            announce('Your changes are saved as a new loadout.');
                        }}
                        onDiscard={(key) => {
                            loadouts.discard(key);
                            onLoaded();
                            announce('Your changes are discarded.');
                        }}
                    />
                )}
                {otherLines(loadouts.otherHeld).map((text) => (
                    <p key={text} className={styles.line}>
                        {text}
                    </p>
                ))}
                {loadouts.accountError && (
                    <p className={styles.line}>
                        Your account loadouts could not be loaded. Your browser loadouts still work.
                    </p>
                )}
                {loadouts.known && !loadouts.verified && <SignInHint />}
                {working && !loadouts.storageOk && (
                    <p className={styles.quiet}>
                        Browser storage is off: loadouts last for this visit only.
                    </p>
                )}
            </div>

            <dialog
                ref={dialogRef}
                className={styles.dialog}
                aria-labelledby={`${ids}-dialog-title`}
                aria-describedby={`${ids}-dialog-text`}
                onClose={onDialogClose}
            >
                {pending && (
                    <form
                        method="dialog"
                        className={styles.dialogBody}
                        onSubmit={(e) => {
                            // What `method="dialog"` does, done by hand so the chosen button's value is the
                            // dialog's return value in every engine (jsdom included).
                            e.preventDefault();
                            const by = (e.nativeEvent as SubmitEvent)
                                .submitter as HTMLButtonElement | null;
                            dialogRef.current?.close(by?.value ?? '');
                        }}
                    >
                        <h2 id={`${ids}-dialog-title`} className={styles.dialogTitle}>
                            Delete {pending.name}?
                        </h2>
                        <p id={`${ids}-dialog-text`} className={styles.dialogText}>
                            {pending.again && `${DELETE_CHANGED} `}
                            {pending.kind === 'account'
                                ? 'It is removed from your account, on every device. This cannot be undone.'
                                : 'It is removed from this browser. This cannot be undone.'}
                        </p>
                        <div className={styles.dialogActions}>
                            <button
                                ref={cancelRef}
                                type="submit"
                                value="cancel"
                                className={styles.button}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                value="delete"
                                className={`${styles.button} ${styles.danger}`}
                            >
                                Delete
                            </button>
                        </div>
                    </form>
                )}
            </dialog>
        </section>
    );
}

/** A delete refused because the account copy was newer (S14.3c-sync). */
export const DELETE_CHANGED =
    'This loadout was changed on another device. The newer copy is on the page now.';

/** The card's lines for held loadouts that are not the active one. */
export function otherLines(held: readonly { name: string; kind: Hold }[]): string[] {
    const changed = held.filter((h) => h.kind === 'conflict').map((h) => h.name);
    const gone = held.filter((h) => h.kind !== 'conflict').map((h) => h.name);
    const out: string[] = [];
    if (changed.length === 1)
        out.push(
            `Changed on another device too: ${changed[0]}. Open it to choose which copy to keep.`,
        );
    if (changed.length > 1)
        out.push(
            `Changed on another device too: ${changed.join(', ')}. Open each to choose which copy to keep.`,
        );
    if (gone.length > 0)
        out.push(
            `Deleted on another device, with changes here: ${gone.join(', ')}. Open ${gone.length === 1 ? 'it' : 'each'} to choose what to do with them.`,
        );
    return out;
}

const whenFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const characters = (n: number) => `${n} of 4 characters`;
const listed = (names: string[]) => (names.length === 0 ? 'no characters' : names.join(', '));

const GAME_MODE_SHORT: Record<string, string> = { as: 'AS', moc: 'MoC', aa: 'AA' };
const modesText = (m: { gameMode: string; draftMode: string; costSetId: number }) =>
    `${GAME_MODE_SHORT[m.gameMode] ?? m.gameMode} ${m.draftMode === 'auction' ? 'Auction' : 'Classic'}${m.costSetId > 0 ? `, cost set ${m.costSetId}` : ''}`;

/** What differs between the two copies, in plain words (second review N5). */
export function differenceLines(
    diffs: readonly Difference[],
    characterName: (key: string) => string,
): string[] {
    return diffs.map((d) => {
        switch (d.kind) {
            case 'name':
                return `Name: “${d.mine}” here, “${d.theirs}” on your account.`;
            case 'note':
                return 'The note differs.';
            case 'members':
                return `Team: ${listed(d.mine.map(characterName))} here; ${listed(d.theirs.map(characterName))} on your account.`;
            case 'order':
                return 'The same characters in another order.';
            case 'lightcones':
                return 'Different light cones.';
            case 'levels':
                return 'Different eidolons or superimpositions.';
            case 'modes':
                return `Modes: ${modesText(d.mine)} here, ${modesText(d.theirs)} on your account.`;
            default:
                return 'Different Auction budgets or bids.';
        }
    });
}

/**
 * The choice for a held loadout (S14.3c-sync): changed on another device (both copies and what differs; "Keep my
 * changes" or "Use the account copy"), or deleted on another device / not savable any more ("Save as a new loadout"
 * or "Discard my changes"). Nothing is saved until one is pressed.
 */
function HeldChoice({
    held,
    characterName,
    onKeep,
    onTake,
    onSaveNew,
    onDiscard,
}: {
    held: NonNullable<LoadoutsState['held']>;
    characterName: (key: string) => string;
    onKeep: (key: string) => void;
    onTake: (key: string) => void;
    onSaveNew: (key: string) => void;
    onDiscard: (key: string) => void;
}) {
    const id = useId();
    const { mine, theirs, key, kind } = held;
    const edited = `edited ${whenFormat.format(mine.at)}`;
    const changed = kind === 'conflict';
    const title = changed
        ? `${mine.name} was also changed on another device.`
        : kind === 'deleted'
          ? 'This loadout was deleted on another device.'
          : 'This loadout cannot be saved again.';
    const diffs = differenceLines(held.differences, characterName);
    return (
        // biome-ignore lint/a11y/useSemanticElements: a labelled group of two choices, not a form fieldset
        <div role="group" aria-labelledby={id} className={styles.conflict}>
            <p id={id} className={styles.conflictTitle}>
                {title}
            </p>
            <ul className={styles.conflictList}>
                <li>
                    In this browser: {mine.name}, {characters(mine.filled)}, {edited}.
                </li>
                {theirs ? (
                    <li>
                        On your account: {theirs.name}, {characters(theirs.filled)}, changed on
                        another device (time not known).
                    </li>
                ) : (
                    <li>On your account: nothing in its place.</li>
                )}
            </ul>
            {changed && diffs.length > 0 && (
                <>
                    <p className={styles.conflictHint}>What differs:</p>
                    <ul className={styles.conflictList}>
                        {diffs.map((line) => (
                            <li key={line}>{line}</li>
                        ))}
                    </ul>
                </>
            )}
            <p className={styles.conflictHint}>Nothing is saved until you choose.</p>
            <div className={styles.conflictActions}>
                {changed ? (
                    <>
                        <button
                            type="button"
                            className={styles.noticeButton}
                            onClick={() => onKeep(key)}
                        >
                            Keep my changes
                        </button>
                        <button
                            type="button"
                            className={styles.noticeButton}
                            onClick={() => onTake(key)}
                        >
                            Use the account copy
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            className={styles.noticeButton}
                            onClick={() => onSaveNew(key)}
                        >
                            Save as a new loadout
                        </button>
                        <button
                            type="button"
                            className={styles.noticeButton}
                            onClick={() => onDiscard(key)}
                        >
                            Discard my changes
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

function SignInHint() {
    const href = useRouterState({ select: (s) => s.location.href });
    return (
        <p className={styles.quiet}>
            {SIGN_IN_HINT}{' '}
            <Link to="/" search={loginSearchFor(href)} className={styles.signIn}>
                Sign in with Discord
            </Link>
        </p>
    );
}

const heldMark = (kind: Hold) =>
    kind === 'conflict'
        ? 'Changed on another device: choose a copy'
        : 'Deleted on another device: choose what to keep';

type BoxProps = {
    loadouts: LoadoutsState;
    field: string;
    nameRef: RefObject<HTMLInputElement>;
    caretRef: RefObject<HTMLButtonElement>;
    statusId: string;
    onField: (value: string) => void;
    onFocus: () => void;
    onBlur: () => void;
    onPick: (item: LoadoutItem) => void;
    onDuplicate: (item: LoadoutItem) => void;
    onDelete: (item: LoadoutItem) => void;
    onCopyToAccount: (item: LoadoutItem) => void;
};

/** The name field and the switch menu (the mockup's `.loadoutBox`). */
function LoadoutMenuBox({
    loadouts,
    field,
    nameRef,
    caretRef,
    statusId,
    onField,
    onFocus,
    onBlur,
    onPick,
    onDuplicate,
    onDelete,
    onCopyToAccount,
}: BoxProps) {
    const ids = useId();
    const [open, setOpen] = useState(false);
    const enterOnOpen = useRef(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const triggerId = `${ids}-trigger`;
    const menuId = `${ids}-menu`;

    const items = () =>
        Array.from(
            menuRef.current?.querySelectorAll<HTMLElement>(
                '[role="menuitem"], [role="menuitemradio"]',
            ) ?? [],
        );

    // A keyboard open enters the menu at the active loadout (or the first item).
    useEffect(() => {
        if (!open || !enterOnOpen.current) return;
        enterOnOpen.current = false;
        const menu = menuRef.current;
        const first =
            menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
            menu?.querySelector<HTMLElement>('[role="menuitemradio"], [role="menuitem"]');
        first?.focus();
    }, [open]);

    // A press or focus outside the box closes the menu (no trap).
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

    const closeToTrigger = (pointer = false) => {
        setOpen(false);
        // biome-ignore lint/suspicious/noExplicitAny: focusVisible is newer than the DOM types
        caretRef.current?.focus({ focusVisible: !pointer } as any);
    };

    const onTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
        if (open) {
            setOpen(false);
            return;
        }
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
        else if (event.key === 'Tab') {
            setOpen(false);
            return;
        } else if (
            event.key.length === 1 &&
            /\S/.test(event.key) &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
        ) {
            // Type-ahead: the next loadout whose name starts with the key, after the current item, wrapping.
            const picks = list.filter((el) => el.getAttribute('role') === 'menuitemradio');
            const key = event.key.toLocaleLowerCase();
            const from = picks.indexOf(document.activeElement as HTMLElement);
            for (let i = 1; i <= picks.length; i++) {
                const el = picks[(Math.max(from, -1) + i) % picks.length];
                const name = el?.dataset.name?.toLocaleLowerCase() ?? '';
                if (name.startsWith(key)) {
                    event.preventDefault();
                    el?.focus();
                    return;
                }
            }
            return;
        }
        if (next === undefined) return;
        event.preventDefault();
        list[next]?.focus();
    };

    const onWrapKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        closeToTrigger();
    };

    const act =
        (
            run: (item: LoadoutItem) => void,
            item: LoadoutItem,
            refocus: 'caret' | 'none' = 'caret',
        ) =>
        (event: MouseEvent<HTMLButtonElement>) => {
            const pointer = event.detail > 0;
            setOpen(false);
            if (refocus === 'caret') closeToTrigger(pointer);
            run(item);
        };

    const active = loadouts.active;
    const account = loadouts.account;
    const isActive = (item: LoadoutItem) =>
        active.kind !== 'working' && active.kind === item.store && active.key === item.key;

    const group = (
        title: string,
        count: string,
        list: LoadoutItem[],
        store: Store,
        empty: string,
    ) => (
        // biome-ignore lint/a11y/useSemanticElements: a group of menu items (menu guide), not a form fieldset
        <div role="group" aria-labelledby={`${ids}-${store}`} className={styles.menuGroup}>
            <div id={`${ids}-${store}`} className={styles.menuLabel}>
                {title} <span className={styles.menuCount}>{count}</span>
            </div>
            {list.length === 0 && <p className={styles.menuEmpty}>{empty}</p>}
            {list.map((item) => {
                const on = isActive(item);
                return (
                    <div
                        key={`${store}-${item.key}`}
                        className={styles.menuRow}
                        data-active={on ? '' : undefined}
                    >
                        <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={on}
                            tabIndex={-1}
                            className={styles.menuPick}
                            data-name={item.name}
                            onClick={act(onPick, item)}
                        >
                            <CheckIcon className={styles.menuCheck} />
                            <span className={styles.menuName}>{item.name}</span>
                            {item.held && (
                                <span
                                    className={styles.menuMark}
                                    aria-hidden="true"
                                    title={heldMark(item.held)}
                                >
                                    !
                                </span>
                            )}
                            <span className={styles.menuMeta} aria-hidden="true">
                                {item.filled}/4
                            </span>
                            <span className={hidden.visuallyHidden}>
                                , {item.filled} of 4 slots
                                {item.held && `, ${heldMark(item.held).toLowerCase()}`}
                            </span>
                        </button>
                        {store === 'browser' && account !== null && (
                            <button
                                type="button"
                                role="menuitem"
                                tabIndex={-1}
                                className={styles.menuAct}
                                aria-label={`Copy ${item.name} to my account`}
                                title="Copy to my account"
                                onClick={act(onCopyToAccount, item)}
                            >
                                <UploadIcon />
                            </button>
                        )}
                        <button
                            type="button"
                            role="menuitem"
                            tabIndex={-1}
                            className={styles.menuAct}
                            aria-label={`Duplicate ${item.name}`}
                            title="Duplicate"
                            onClick={act(onDuplicate, item, 'none')}
                        >
                            <DuplicateIcon />
                        </button>
                        <button
                            type="button"
                            role="menuitem"
                            tabIndex={-1}
                            className={styles.menuAct}
                            data-danger=""
                            aria-label={`Delete ${item.name}`}
                            title="Delete"
                            onClick={act(onDelete, item, 'none')}
                        >
                            <TrashIcon />
                        </button>
                    </div>
                );
            })}
        </div>
    );

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: a key listener for the menu's own controls
        <div className={styles.box} ref={wrapRef} onKeyDown={onWrapKeyDown}>
            <PencilIcon className={styles.pencil} />
            <input
                ref={nameRef}
                id={`${ids}-name`}
                type="text"
                className={styles.nameInput}
                value={field}
                maxLength={LOADOUT_NAME_MAX}
                spellCheck={false}
                autoComplete="off"
                placeholder="Name this loadout"
                aria-label="Rename active loadout"
                aria-describedby={statusId}
                onChange={(e) => onField(e.currentTarget.value)}
                onFocus={onFocus}
                onBlur={onBlur}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                    }
                }}
            />
            <button
                ref={caretRef}
                id={triggerId}
                type="button"
                className={styles.caret}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={menuId}
                aria-label="Switch loadout"
                title="Switch loadout"
                onClick={onTriggerClick}
                onKeyDown={onTriggerKeyDown}
            >
                <CaretIcon className={styles.caretIcon} />
            </button>
            <div
                ref={menuRef}
                id={menuId}
                role="menu"
                aria-label="Saved loadouts"
                className={styles.menu}
                hidden={!open}
                onKeyDown={onMenuKeyDown}
            >
                {open && (
                    <>
                        {account !== null &&
                            group(
                                'On your account',
                                `${account.length} of ${ACCOUNT_LOADOUT_LIMIT}`,
                                account,
                                'account',
                                loadouts.accountReady ? 'None yet.' : 'Loading…',
                            )}
                        {(account === null || loadouts.browser.length > 0) &&
                            group(
                                account === null ? 'Saved loadouts' : 'In this browser',
                                `${loadouts.browser.length} of ${BROWSER_LOADOUT_LIMIT}`,
                                loadouts.browser,
                                'browser',
                                'None yet. Your first character pick saves the team here.',
                            )}
                    </>
                )}
            </div>
        </div>
    );
}
