import type { BlockReason } from '@shared/loadouts';
import { useEffect, useState } from 'react';
import { InfoPopover } from '@/components/InfoPopover/InfoPopover';
import {
    PILL_TEXT,
    RING_TEXT,
    reasonText,
    SAVE_TIP,
    SaveIndicator,
    type SaveView,
} from '@/pages/teambuilder/AutosaveRing';
import {
    AUTO_SAVES,
    EMPTY_WORKING,
    FULL_PILL,
    HeldDialog,
    NoticeDialog,
    STORAGE_OFF,
    STORAGE_OFF_PILL,
} from '@/pages/teambuilder/LoadoutsPanel';
import { DELETED_HERE } from '@/pages/teambuilder/useActiveLoadout';
import type { HeldInfo } from '@/pages/teambuilder/useLoadouts';
import LoadoutsPanelDemo from './LoadoutsPanelDemo';
import styles from './SaveIndicatorDemo.module.css';

/** S14.3j: the held choice's dialog with made-up copies (a conflict with long lines, and a deletion). */
const HELD_DEMO: Record<'conflict' | 'deleted', HeldInfo> = {
    conflict: {
        key: '0',
        kind: 'conflict',
        mine: { name: 'Hyper Carry', filled: 4, at: Date.now() - 3_600_000 },
        theirs: { name: 'Hyper Carry (phone)', filled: 3 },
        differences: [
            { kind: 'name', mine: 'Hyper Carry', theirs: 'Hyper Carry (phone)' },
            { kind: 'note' },
            {
                kind: 'members',
                mine: ['Acheron', 'Pela', 'Silver Wolf', 'Huohuo'],
                theirs: ['Acheron', 'Jiaoqiu', 'Aventurine'],
            },
            {
                kind: 'modes',
                mine: { gameMode: 'as', draftMode: 'classic', costSetId: 0 },
                theirs: { gameMode: 'aa', draftMode: 'auction', costSetId: 3 },
            },
        ],
    },
    deleted: {
        key: '1',
        kind: 'deleted',
        mine: { name: 'Hyper Carry', filled: 4, at: Date.now() - 3_600_000 },
        theirs: null,
        differences: [],
    },
};

/*
 * Dev only (S14.3g): every state of the team builder's save indicator without signing in or waiting a minute.
 * Opened by `/teambuilder#save-demo` on the dev server; TeamBuilderPage imports it behind `import.meta.env.DEV`,
 * so it is not in the production build (its marker `hsr-dev-save-demo` must not appear in web/dist).
 *
 * Top: each state held still, enlarged, with its label. Below: the whole sequence on a short loop (a 4 s wait instead
 * of 60 s), at real size beside a mock name and enlarged, plus buttons that drive each transition by hand (a press
 * pauses the loop).
 *
 * S14.3i: a button per problem (its pill shows by itself, as on the page) and per quiet state; the shared info
 * popover in both tones and both forms; and one trigger pinned to the viewport's bottom right corner (the edge case).
 */

const DEMO_MARK = 'hsr-dev-save-demo';
const WAIT_MS = 4000;

type Demo = { view: SaveView; saves: number; id: string };
type Change = (d: Demo) => Demo;

const waiting = (): SaveView => {
    const now = Date.now();
    return { kind: 'waiting', from: now, due: now + WAIT_MS, said: RING_TEXT.waiting };
};
const saving: SaveView = { kind: 'saving', said: RING_TEXT.saving };
const savedAccount: SaveView = { kind: 'saved', said: RING_TEXT.autoSaved, tip: SAVE_TIP.account };
const savedBrowser: SaveView = {
    kind: 'saved',
    said: 'Saved in this browser',
    tip: SAVE_TIP.browser,
};
/** A blocked account save, as the page builds it (accountView). */
const blockedView = (reason: BlockReason, id: string): SaveView => ({
    kind: 'problem',
    label: RING_TEXT.blocked,
    pill: PILL_TEXT[reason],
    reason: { id, text: reasonText(reason, null) },
});
const problemView = (id: string): SaveView => blockedView('offline', id);
const problem = problemView('demo-reason-live');

/** S14.3i: every problem and quiet state, as the page shows them. */
const REASONS = Object.keys(PILL_TEXT) as BlockReason[];
const OTHER_STATES: [string, SaveView][] = [
    ['Storage off', { kind: 'problem', label: STORAGE_OFF, pill: STORAGE_OFF_PILL }],
    ['Browser full (working)', { kind: 'problem', label: '', pill: FULL_PILL.browser }],
    ['Account full (working)', { kind: 'problem', label: '', pill: FULL_PILL.account }],
    ['Empty (quiet)', { kind: 'problem', label: EMPTY_WORKING, quiet: true }],
    ['Not stored yet (quiet)', { kind: 'problem', label: AUTO_SAVES, quiet: true }],
    [
        'Loading (quiet)',
        { kind: 'problem', label: 'Your account loadouts are loading.', quiet: true },
    ],
];

const toWait: Change = (d) => ({ ...d, view: waiting() });
const toSaving: Change = (d) => ({ ...d, view: saving });
const landAccount: Change = (d) => ({ ...d, view: savedAccount, saves: d.saves + 1 });
const landBrowser: Change = (d) => ({ ...d, view: savedBrowser, saves: d.saves + 1 });
const toProblem: Change = (d) => ({ ...d, view: problem });
const same: Change = (d) => d;
const switchLoadout: Change = (d) => ({
    ...d,
    id: d.id === 'a' ? 'b' : 'a',
    view: d.view.kind === 'saved' ? waiting() : savedAccount,
});

const BURST = 'Browser loadout: a burst of 4 saves (one check)';
const REST = 'Saved, at rest (floppy)';
/** The loop: [at ms, label, change]. */
const PLAN: [number, string, Change][] = [
    [0, 'Waiting to save (account; 4 s here, 60 s live)', toWait],
    [WAIT_MS, 'Saving (the ring holds full)', toSaving],
    [WAIT_MS + 500, 'Saved just now (check)', landAccount],
    [WAIT_MS + 2200, REST, same],
    [WAIT_MS + 3600, BURST, landBrowser],
    [WAIT_MS + 3900, BURST, landBrowser],
    [WAIT_MS + 4200, BURST, landBrowser],
    [WAIT_MS + 4500, BURST, landBrowser],
    [WAIT_MS + 6200, REST, same],
    [WAIT_MS + 7600, 'Problem: not saved yet (words stay)', toProblem],
    [WAIT_MS + 10600, 'Problem cleared: the wait resumes', toWait],
];
const LOOP_MS = WAIT_MS + 10600 + WAIT_MS + 1500;

/** One state held still (the check is kept up by a save every second: the coalescing rule keeps it drawn). */
function Still({
    label,
    view,
    keepChecked = false,
}: {
    label: string;
    view: SaveView;
    keepChecked?: boolean;
}) {
    const [saves, setSaves] = useState(0);
    const [wait, setWait] = useState(view);
    useEffect(() => {
        if (!keepChecked) return;
        setSaves(1);
        const t = setInterval(() => setSaves((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, [keepChecked]);
    // The waiting tile starts a fresh wait every 5 s.
    useEffect(() => {
        if (view.kind !== 'waiting') return;
        const t = setInterval(() => setWait(waiting()), WAIT_MS + 1000);
        return () => clearInterval(t);
    }, [view.kind]);
    return (
        <figure className={styles.tile}>
            <div className={styles.big}>
                <SaveIndicator
                    view={view.kind === 'waiting' ? wait : view}
                    loadoutId="still"
                    saves={saves}
                />
            </div>
            <figcaption>{label}</figcaption>
        </figure>
    );
}

export default function SaveIndicatorDemo() {
    const [demo, setDemo] = useState<Demo>({ view: savedAccount, saves: 0, id: 'a' });
    const [looping, setLooping] = useState(true);
    const [step, setStep] = useState('At rest');
    const [held, setHeld] = useState<HeldInfo | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    useEffect(() => {
        if (!looping) return;
        const timers: ReturnType<typeof setTimeout>[] = [];
        const run = () => {
            for (const [at, label, change] of PLAN)
                timers.push(
                    setTimeout(() => {
                        setStep(label);
                        setDemo(change);
                    }, at),
                );
            timers.push(setTimeout(run, LOOP_MS));
        };
        run();
        return () => {
            for (const t of timers) clearTimeout(t);
        };
    }, [looping]);

    const manual = (label: string, change: Change) => () => {
        setLooping(false);
        setStep(label);
        setDemo(change);
    };

    const indicator = <SaveIndicator view={demo.view} loadoutId={demo.id} saves={demo.saves} />;
    return (
        <section
            className={styles.demo}
            data-dev={DEMO_MARK}
            aria-label="Save indicator demo (dev only)"
        >
            <h2 className={styles.title}>Save indicator demo (dev only)</h2>
            <div className={styles.tiles}>
                <Still label="Waiting to save" view={waiting()} />
                <Still label="Saving" view={saving} />
                <Still label="Saved just now" view={savedAccount} keepChecked />
                <Still label="Saved, at rest" view={savedAccount} />
                <Still label="Problem" view={problemView('demo-reason-still')} />
            </div>

            <div className={styles.live}>
                {/* The enlarged copy first: of the two pills that open together, the real-size one stays
                    (one open at a time; the later one wins). */}
                <div className={styles.big}>{indicator}</div>
                <div className={styles.real}>
                    <span className={styles.mockName}>Hyper Carry</span>
                    {indicator}
                </div>
                <p className={styles.step}>
                    {looping ? 'Loop: ' : 'By hand: '}
                    {step}
                </p>
            </div>

            <div className={styles.buttons}>
                <button type="button" onClick={() => setLooping((l) => !l)}>
                    {looping ? 'Pause loop' : 'Resume loop'}
                </button>
                <button type="button" onClick={manual('Edit: a new 4 s wait', toWait)}>
                    Edit (new wait)
                </button>
                <button type="button" onClick={manual('Saving', toSaving)}>
                    Save starts
                </button>
                <button type="button" onClick={manual('Save landed', landAccount)}>
                    Save lands
                </button>
                <button type="button" onClick={manual('Browser save', landBrowser)}>
                    Browser save
                </button>
                <button type="button" onClick={manual('Problem', toProblem)}>
                    Problem
                </button>
                <button
                    type="button"
                    onClick={manual(
                        'Switched to another loadout (nothing replayed)',
                        switchLoadout,
                    )}
                >
                    Switch loadout
                </button>
            </div>

            <div className={styles.buttons}>
                <span className={styles.groupLabel}>Problems (the pill shows by itself):</span>
                {REASONS.map((r) => (
                    <button
                        key={r}
                        type="button"
                        onClick={manual(`Problem: ${r}`, (d) => ({
                            ...d,
                            view: blockedView(r, 'demo-reason-live'),
                        }))}
                    >
                        {r}
                    </button>
                ))}
                {OTHER_STATES.map(([label, view]) => (
                    <button
                        key={label}
                        type="button"
                        onClick={manual(label, (d) => ({ ...d, view }))}
                    >
                        {label}
                    </button>
                ))}
            </div>

            <div className={styles.buttons}>
                <span className={styles.groupLabel}>The held choice (S14.3j):</span>
                <button type="button" onClick={() => setHeld(HELD_DEMO.conflict)}>
                    Held dialog: changed
                </button>
                <button type="button" onClick={() => setHeld(HELD_DEMO.deleted)}>
                    Held dialog: deleted
                </button>
                <HeldDialog
                    held={held}
                    open={held !== null}
                    characterName={(key) => key}
                    onPick={(pick) => {
                        setStep(`Held choice: ${pick}`);
                        setHeld(null);
                    }}
                    onDismiss={() => {
                        setStep('Held choice: closed without a choice');
                        setHeld(null);
                    }}
                />
                <button type="button" onClick={() => setNotice(DELETED_HERE)}>
                    Notice dialog: deleted here
                </button>
                <NoticeDialog
                    text={notice}
                    open={held === null}
                    onDismiss={() => {
                        setStep('Notice dismissed');
                        setNotice(null);
                    }}
                />
            </div>

            <LoadoutsPanelDemo />

            <div className={styles.popovers}>
                <span className={styles.groupLabel}>The shared info popover:</span>
                <span className={styles.sample}>
                    Quiet panel
                    <InfoPopover
                        label="About the quiet panel"
                        heading="Character Budget"
                        list={[
                            <>
                                <strong>Classic</strong>: picks and bans in turn.
                            </>,
                            <>
                                <strong>Auction</strong>: the highest bid wins.
                            </>,
                        ]}
                        foot="Ignored entirely in Classic mode."
                    >
                        In Auction draft mode, the spending allowance each team has for bidding on
                        characters.
                    </InfoPopover>
                </span>
                <span className={styles.sample}>
                    Warning panel
                    <InfoPopover
                        label="About the warning panel"
                        tone="warning"
                        heading="Not saved yet"
                        foot="Your changes are kept in this browser."
                    >
                        No connection. They are saved when the connection is back.
                    </InfoPopover>
                </span>
                <span className={styles.sample}>
                    Quiet pill
                    <InfoPopover label="About the quiet pill" form="pill">
                        Saved automatically
                    </InfoPopover>
                </span>
                <span className={styles.sample}>
                    Warning pill
                    <InfoPopover label="About the warning pill" form="pill" tone="warning">
                        Not saved: no connection
                    </InfoPopover>
                </span>
            </div>

            {/* The edge case: a trigger at the viewport's bottom right corner (the panel flips up and shifts left). */}
            <span className={styles.corner}>
                <InfoPopover
                    label="About the corner"
                    heading="At the corner"
                    list={['Flips above: no room below.', 'Shifts left: 8px from the edge.']}
                    foot="Bottom right of the viewport."
                >
                    This panel prefers below and start-aligned.
                </InfoPopover>
            </span>
        </section>
    );
}
