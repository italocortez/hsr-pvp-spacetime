import type { AutosaveStatus, BlockReason } from '@shared/loadouts';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { ExclamationIcon } from '@/components/ExclamationIcon/ExclamationIcon';
import { InfoPopover } from '@/components/InfoPopover/InfoPopover';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './AutosaveRing.module.css';
import { FloppyIcon } from './TeamBuilderIcons';

/*
 * The save indicator beside the loadout's name (S14.3c ring; S14.3g, the user's sketch: a ring filling, then a
 * check, then a floppy disk; S14.3i, A210 items 6 to 8: always one icon and never any words beside the name). One
 * fixed 20px box whose layers cross-fade, so no state moves anything:
 *
 * - waiting (an account loadout with unsent edits): the ring fills over the wait on the scheduler's clock (60 s
 *   after the last edit, sooner when the 5 minute ceiling comes first) and starts again on each edit;
 * - saving: the ring completes (from where it stood) and holds full; a slow breathing starts only after 700 ms, so a
 *   save that returns at once never flickers: the full ring turns straight into the check;
 * - just saved: a check draws inside the ring, which turns green, with one small pop; it stays CHECK_HOLD_MS after
 *   the last save (a save while it shows extends it without replaying it: the coalescing rule for browser loadouts);
 * - at rest: the ring and check shrink away as the floppy grows in, muted;
 * - quiet (an empty working loadout, a team not stored yet, the account list loading): the circled "!", muted;
 * - problem: the circled "!" in the warning colour, and a pill with the reason that shows by itself once when the
 *   problem appears or its reason changes (the shared InfoPopover's `flash`), then closes while the mark stays.
 *
 * The box is the trigger of the shared info popover (S14.3i): its words show in a small pill above it on hover,
 * keyboard focus or tap (the plain `title` tooltip is gone). Opening that pill is its only reaction: no border, no
 * background, a slight brightening only. The words are also visually hidden text (`wordsId`), the name field's
 * description, exactly as before; announcements are the panel's, on a change of state only. The pill has no live
 * region, so nothing is said twice.
 *
 * Motion only on `opacity`, `scale` and stroke properties, only with `data-motion` (set when the person has not
 * asked for reduced motion) and inside the matching media query. A switch to another loadout shows its state at
 * once (`data-instant`: no transition, no replayed check).
 */

export const RING_TEXT = {
    waiting: 'Saving soon',
    saving: 'Saving…',
    autoSaved: 'Auto saved',
    saved: 'Saved to your account',
    blocked: 'Not saved yet',
} as const;

/** S14.3g: the indicator's words at rest, in its popover (invented texts; the `title` tooltip until S14.3i). */
export const SAVE_TIP = {
    account: 'Saved automatically',
    browser: 'Saved in this browser',
} as const;

/** S14.3i: the save spot's button name (the popover's trigger). */
export const SAVE_STATUS_LABEL = 'Save status';

/**
 * S14.3i: the pill sits above the save spot, end-aligned, clear of the name box beside it: the 20px icon is centred
 * in the box (40px, 44px on touch), so 12px reach the box's top edge and 4px more leave a gap. Above, because below
 * it would cover the card's actions; the right of the card head above it is empty.
 */
const PILL_GAP = 16;

/**
 * S14.3i: why a draft waits, as the problem pill says it: one short line (the full reason stays the name field's
 * description and the announcement). "See below" points at the card's own notice for the cases that need a choice.
 */
export const PILL_TEXT: Record<BlockReason, string> = {
    offline: 'Not saved: no connection',
    'too-fast': 'Not saved yet: many saves, saving in a moment',
    queued: 'Not saved yet: many saves, saving in a moment',
    refused: 'Not saved: refused by the server',
    full: 'Not saved: account full, see below',
    conflict: 'Changed on another device: see below',
    deleted: 'Deleted on another device: see below',
    retired: 'Cannot be saved again: see below',
    'server-error': 'Not saved: server error, trying again',
    'server-stopped': 'Not saved: server error, tried again after your next edit',
    'other-tab': 'Being changed in another tab',
};

/** How long the check stays after the last save, then it turns into the floppy (ms). */
export const CHECK_HOLD_MS = 1400;

/** Why a draft waits, as the page says it. A server text, when there is one, is used as it is. */
export function reasonText(reason: BlockReason, message: string | null): string {
    if (message) return message;
    switch (reason) {
        case 'offline':
            return 'No connection. Your changes are kept in this browser and saved when the connection is back.';
        case 'too-fast':
        case 'queued':
            return 'Many saves in a short time. Your changes are kept and saved in a moment.';
        case 'full':
            return 'Your account already holds 10 loadouts. Delete one to save this one.';
        case 'refused':
            return 'The server did not take this loadout. Your changes are kept in this browser.';
        case 'conflict':
            return 'Changed on another device too. Choose which copy to keep.';
        case 'deleted':
            return 'Deleted on another device. Choose what to do with your changes.';
        case 'retired':
            return 'This loadout cannot be saved again. Save it as a new loadout.';
        case 'server-error':
            return 'The server could not save this. Trying again in a moment.';
        case 'server-stopped':
            return 'The server could not save this. It is tried again after your next change or when the connection comes back.';
        case 'other-tab':
            return 'Being changed in another tab of this browser. That tab saves it.';
    }
}

/**
 * What the indicator shows. `said`: the hidden words (and the popover's, unless `tip` is given). A problem: `label`
 * and `reason` are the hidden words (an empty label adds none: a notice row in the card says it, S14.3i); `pill`
 * the popover's line (the label when absent).
 */
export type SaveView =
    | { kind: 'waiting'; from: number; due: number; said: string }
    | { kind: 'saving'; said: string }
    | { kind: 'saved'; said: string; tip: string }
    | {
          kind: 'problem';
          label: string;
          reason?: { id: string; text: string };
          /** A state that is not a fault (loading; a team not stored yet, S14.3h): the glyph muted, no pill by itself. */
          quiet?: boolean;
          pill?: string;
      };

/**
 * The view of an account loadout's autosave state. `reasonShown`: the reason is in a visible notice row of the card
 * (account full, S14.3i), which the name field's description includes, so it is not repeated in the hidden words.
 */
export function accountView(
    status: AutosaveStatus,
    reasonId: string,
    reasonShown = false,
): SaveView {
    switch (status.kind) {
        case 'saved': {
            const said = status.everSaved ? RING_TEXT.autoSaved : RING_TEXT.saved;
            return { kind: 'saved', said, tip: SAVE_TIP.account };
        }
        case 'saving':
            return { kind: 'saving', said: RING_TEXT.saving };
        case 'blocked':
            return {
                kind: 'problem',
                label: RING_TEXT.blocked,
                pill: PILL_TEXT[status.reason],
                ...(reasonShown
                    ? {}
                    : {
                          reason: {
                              id: reasonId,
                              text: reasonText(status.reason, status.message),
                          },
                      }),
            };
        default:
            return { kind: 'waiting', from: status.from, due: status.due, said: RING_TEXT.waiting };
    }
}

/** The account wrapper (its earlier name and props, kept for the ring's own tests and the panel). */
export function AutosaveRing({
    status,
    reasonId,
    loadoutId = 'one',
    saves = 0,
}: {
    status: AutosaveStatus;
    reasonId: string;
    loadoutId?: string;
    saves?: number;
}) {
    return (
        <SaveIndicator
            view={accountView(status, reasonId)}
            wordsId={`${reasonId}-words`}
            loadoutId={loadoutId}
            saves={saves}
            state={status.kind === 'blocked' ? 'blocked' : status.kind}
        />
    );
}

type Phase = 'ring' | 'saving' | 'check' | 'rest' | 'problem';

const ICON: Record<Phase, string> = {
    ring: 'ring',
    saving: 'ring-full',
    check: 'check',
    rest: 'floppy',
    problem: 'warning',
};

const REDUCE = '(prefers-reduced-motion: reduce)';
const reducedNow = () => globalThis.matchMedia?.(REDUCE).matches === true;

/** True while the person has asked for reduced motion (followed live). */
function useReducedMotion(): boolean {
    const [reduced, setReduced] = useState(reducedNow);
    useEffect(() => {
        const query = globalThis.matchMedia?.(REDUCE);
        if (!query?.addEventListener) return;
        const on = () => setReduced(query.matches);
        query.addEventListener('change', on);
        return () => query.removeEventListener('change', on);
    }, []);
    return reduced;
}

/**
 * The indicator. `loadoutId`: which loadout it speaks for (a change shows the new state at once). `saves`: bumped by
 * the caller each time a save lands; each bump shows the check (or keeps it up). `state`: the `data-state` value.
 * `view` null: nothing is shown, but the indicator stays mounted (the panel always gives a view since S14.3i).
 * `wordsId`: the id of the hidden words (the name field's description).
 */
export function SaveIndicator({
    view,
    loadoutId,
    saves,
    state = view?.kind,
    wordsId,
}: {
    view: SaveView | null;
    loadoutId: string;
    saves: number;
    state?: string;
    wordsId?: string;
}) {
    const reduced = useReducedMotion();
    const kind = view?.kind ?? 'none';

    // S14.3i: the problem pill shows by itself once per occurrence: when a problem appears, or its line or the
    // loadout changes while one shows. A re-render with the same problem counts nothing.
    const flashKey =
        view?.kind === 'problem' && !view.quiet ? `${loadoutId}\n${view.pill ?? view.label}` : null;
    const [flash, setFlash] = useState({ key: null as string | null, n: 0 });
    if (flashKey !== flash.key)
        setFlash({ key: flashKey, n: flashKey === null ? flash.n : flash.n + 1 });

    // What the box remembers, worked out while rendering (React's "adjust state on a change of props"), so the
    // first frame of a landed save already shows the check (never a frame of the floppy before it).
    // `hold`: one per save that landed; the check goes CHECK_HOLD_MS after the last one.
    const [mem, setMem] = useState({
        id: loadoutId,
        saves,
        kind,
        check: false,
        instant: false,
        hold: 0,
    });
    let next = mem;
    if (saves !== mem.saves) {
        // A save landed: the check shows, or stays up longer (no replay while it shows).
        next = {
            ...mem,
            id: loadoutId,
            saves,
            kind,
            check: true,
            instant: false,
            hold: mem.hold + 1,
        };
    } else if (loadoutId !== mem.id) {
        // Another loadout: its state at once (no transition), nothing replayed.
        next = { ...mem, id: loadoutId, kind, check: false, instant: true };
    } else if (kind !== mem.kind) {
        // A change of state animates; a new edit after a save takes the check away (the ring comes back).
        next = { ...mem, kind, instant: false, check: mem.check && kind === 'saved' };
    }
    if (next !== mem) setMem(next);

    useEffect(() => {
        if (mem.hold === 0) return;
        const timer = setTimeout(() => setMem((m) => ({ ...m, check: false })), CHECK_HOLD_MS);
        return () => clearTimeout(timer);
    }, [mem.hold]);

    const phase: Phase =
        view === null
            ? 'rest'
            : view.kind === 'problem'
              ? 'problem'
              : view.kind === 'waiting'
                ? 'ring'
                : view.kind === 'saving'
                  ? 'saving'
                  : next.check
                    ? 'check'
                    : 'rest';
    const instant = next.instant;

    // Where the last wait stood, so a save that starts early completes the ring from there (a switch forgets it).
    const lastWait = useRef<{ from: number; due: number } | null>(null);
    if (view?.kind === 'waiting') lastWait.current = { from: view.from, due: view.due };
    else if (next.instant) lastWait.current = null;

    if (view === null) return null;
    const problem = view.kind === 'problem';
    const warning = problem && !view.quiet;
    const words =
        view.kind === 'saved'
            ? view.tip
            : view.kind === 'problem'
              ? (view.pill ?? view.label)
              : view.said;
    return (
        <span
            className={styles.wrap}
            data-state={state}
            data-tone={problem ? (view.quiet ? 'quiet' : 'warning') : undefined}
        >
            {/* The hidden words first: the text of the indicator starts with them, the pill's line after. */}
            <span id={wordsId} className={hidden.visuallyHidden}>
                {view.kind === 'problem' ? (
                    <>
                        {view.label && <span data-save-problem="">{view.label}</span>}
                        {view.reason && (
                            <span id={view.reason.id} data-save-problem="">
                                {view.reason.text}
                            </span>
                        )}
                    </>
                ) : (
                    <span data-save-said="">{view.said}</span>
                )}
            </span>
            <InfoPopover
                label={SAVE_STATUS_LABEL}
                form="pill"
                tone={warning ? 'warning' : 'quiet'}
                side="above"
                align="end"
                gap={PILL_GAP}
                flash={flashKey === null ? 0 : flash.n}
                className={styles.trigger}
                trigger={
                    <span
                        className={styles.mark}
                        data-save-icon={ICON[phase]}
                        data-phase={phase}
                        data-motion={reduced ? undefined : ''}
                        data-instant={instant ? '' : undefined}
                        aria-hidden="true"
                    >
                        <svg
                            className={styles.glyph}
                            viewBox="0 0 24 24"
                            fill="none"
                            aria-hidden="true"
                        >
                            <circle className={styles.track} cx="12" cy="12" r="9" />
                            {view.kind === 'waiting' ? (
                                <RingFill
                                    key={`${view.from}-${view.due}`}
                                    from={view.from}
                                    due={view.due}
                                />
                            ) : (
                                <RingFull
                                    key="full"
                                    last={lastWait.current}
                                    animate={phase === 'saving'}
                                />
                            )}
                            <path
                                className={styles.tick}
                                d="M7.75 12.4 10.6 15.25 16.4 9.1"
                                pathLength={1}
                            />
                        </svg>
                        <FloppyIcon className={styles.floppy} />
                        <ExclamationIcon className={styles.warn} />
                    </span>
                }
            >
                {words}
            </InfoPopover>
        </span>
    );
}

/** The ring's arc: a circle of path length 100, drawn by its dash offset (100 empty, 0 full). */
const RING_PROPS = {
    cx: '12',
    cy: '12',
    r: '9',
    pathLength: 100,
    transform: 'rotate(-90 12 12)',
} as const;

/**
 * The fill on the scheduler's clock (fix pass, review S2): the animation runs over the whole wait (`due - from`)
 * and starts where the wait stands when the element mounts (a negative delay of the time already gone). Both are
 * worked out once per wait, so a re-render (a pool search, a filter) writes the same values and the fill never
 * jumps or fills early. `--ring-at`: where it stood then, the still ring under reduced motion.
 */
function RingFill({ from, due }: { from: number; due: number }) {
    const [style] = useState(() => {
        const total = Math.max(1, due - from);
        const gone = Math.min(total, Math.max(0, Date.now() - from));
        return {
            '--ring-ms': `${total}ms`,
            '--ring-delay': `-${gone}ms`,
            '--ring-at': `${Math.round((1 - gone / total) * 1000) / 10}`,
        } as CSSProperties;
    });
    return <circle className={styles.arc} data-fill="" style={style} {...RING_PROPS} />;
}

/** The full ring (saving, check, rest). Saving completes it from where the last wait stood (`--ring-from`). */
function RingFull({
    last,
    animate,
}: {
    last: { from: number; due: number } | null;
    animate: boolean;
}) {
    const [style] = useState(() => {
        if (!last || !animate) return { '--ring-from': '0' } as CSSProperties;
        const total = Math.max(1, last.due - last.from);
        const gone = Math.min(total, Math.max(0, Date.now() - last.from));
        return { '--ring-from': `${Math.round((1 - gone / total) * 1000) / 10}` } as CSSProperties;
    });
    return <circle className={styles.arc} data-full="" style={style} {...RING_PROPS} />;
}
