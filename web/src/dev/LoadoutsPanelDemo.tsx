import { useState } from 'react';
import { LoadoutsPanel } from '@/pages/teambuilder/LoadoutsPanel';
import { DELETED_HERE } from '@/pages/teambuilder/useActiveLoadout';
import {
    BROWSER_FULL,
    type HeldInfo,
    type LoadoutItem,
    type LoadoutsState,
} from '@/pages/teambuilder/useLoadouts';
import styles from './SaveIndicatorDemo.module.css';

/*
 * Dev only (S14.3j): the real Loadouts card (`LoadoutsPanel`, its own CSS) in every state that shows a message, with a
 * made-up `loadouts` value per state, so each can be seen without an account or a second device. Rendered by the save
 * indicator demo (`/teambuilder#save-demo`), so it is behind the same `import.meta.env.DEV` import and not in the
 * production build. One card at a time (its dialogs open by themselves).
 */

const noop = () => {};
const item = (
    store: 'browser' | 'account',
    key: string,
    name: string,
    filled = 3,
    held: LoadoutItem['held'] = null,
): LoadoutItem => ({ key, name, note: '', code: '', store, filled, held });

const FIVE = ['Hyper Carry', 'Acheron mono', 'Firefly break', 'Feixiao FuA', 'Castorice'].map(
    (n, i) => item('browser', `b${i}`, n),
);
const TEN = [
    'Hyper Carry',
    'Acheron mono',
    'Firefly break',
    'Feixiao FuA',
    'Castorice',
    'Phainon',
    'Archer',
    'Saber',
    'The Herta',
    'Mydei',
].map((n, i) => item('account', String(i), n));

const AT = Date.now() - 3_600_000;
const CONFLICT: HeldInfo = {
    key: '0',
    kind: 'conflict',
    mine: { name: 'Hyper Carry', filled: 4, at: AT },
    theirs: { name: 'Hyper Carry', filled: 3 },
    differences: [
        { kind: 'note' },
        {
            kind: 'members',
            mine: ['Acheron', 'Pela', 'Silver Wolf', 'Huohuo'],
            theirs: ['Acheron', 'Jiaoqiu', 'Aventurine'],
        },
    ],
};
const DELETED: HeldInfo = {
    key: '0',
    kind: 'deleted',
    mine: { name: 'Hyper Carry', filled: 4, at: AT },
    theirs: null,
    differences: [],
};

type Fake = Record<string, unknown>;
const base: Fake = {
    active: { kind: 'working' },
    name: 'New Loadout',
    note: '',
    browser: [],
    account: null,
    accountReady: true,
    accountError: undefined,
    verified: false,
    known: true,
    storageOk: true,
    status: { kind: 'working', full: null, loading: false, empty: false },
    notice: null,
    dismissNotice: noop,
    held: null,
    otherHeld: [],
    keepMine: noop,
    takeAccountCopy: noop,
    saveAsNew: noop,
    discard: noop,
    beforeLink: null,
    forgetBeforeLink: noop,
    edited: noop,
    rename: noop,
    setNote: noop,
    switchTo: noop,
    create: () => null,
    duplicate: () => null,
    remove: async () => ({ kind: 'done' }),
    deleteVersion: () => null,
    copyToAccount: () => ({ ok: true, text: '' }),
};
/** A member with ten account loadouts, the first active. */
const member: Fake = {
    verified: true,
    account: TEN,
    active: { kind: 'account', key: '0' },
    name: 'Hyper Carry',
    status: { kind: 'account', autosave: { kind: 'saved', everSaved: true } },
};
const blocked = (reason: string) => ({
    kind: 'account',
    autosave: { kind: 'blocked', reason, message: null },
});

const STATES: Record<string, Fake> = {
    '1 conflict dialog': { ...member, held: CONFLICT, status: blocked('conflict') },
    '2 deleted, with changes (dialog)': { ...member, held: DELETED, status: blocked('deleted') },
    '3 deleted, no edits (notice dialog)': {
        ...member,
        active: { kind: 'working' },
        account: TEN.slice(1),
        notice: DELETED_HERE,
        status: { kind: 'working', full: null, loading: false, empty: false },
    },
    '4 refusal line (duplicate, browser full)': {
        browser: FIVE,
        active: { kind: 'browser', key: 'b0' },
        name: 'Hyper Carry',
        status: { kind: 'browser' },
        duplicate: () => BROWSER_FULL,
    },
    '5a full list, browser': {
        browser: FIVE,
        status: { kind: 'working', full: 'browser', loading: false, empty: false },
    },
    '5b full list, account': {
        ...member,
        active: { kind: 'account', key: 'u-new' },
        name: 'New Loadout',
        status: blocked('full'),
    },
    '6 other held loadouts': {
        ...member,
        otherHeld: [
            { name: 'Firefly break', kind: 'conflict' },
            { name: 'Castorice', kind: 'deleted' },
        ],
    },
    '7 account list failed': { ...member, account: [], accountReady: false, accountError: 'x' },
    '8 visitor sign-in line': {
        browser: FIVE.slice(0, 2),
        active: { kind: 'browser', key: 'b0' },
        name: 'Hyper Carry',
        status: { kind: 'browser' },
    },
    '9 storage off': {
        storageOk: false,
        status: { kind: 'working', full: null, loading: false, empty: false },
    },
    '10 link field after a failed copy': {
        browser: FIVE.slice(0, 2),
        active: { kind: 'browser', key: 'b0' },
        name: 'Hyper Carry',
        status: { kind: 'browser' },
    },
};

export default function LoadoutsPanelDemo() {
    const [state, setState] = useState<string | null>(null);
    const loadouts = state ? ({ ...base, ...STATES[state] } as unknown as LoadoutsState) : null;
    return (
        <div className={styles.buttons}>
            <span className={styles.groupLabel}>The Loadouts card, per message (S14.3j):</span>
            {Object.keys(STATES).map((s) => (
                <button key={s} type="button" onClick={() => setState(s)}>
                    {s}
                </button>
            ))}
            {loadouts && (
                <div
                    data-panel-demo=""
                    style={{ flex: '1 1 100%', inlineSize: 'min(560px, 100%)' }}
                >
                    <div style={{ inlineSize: 'min(560px, 100%)', display: 'grid' }}>
                        <LoadoutsPanel
                            key={state ?? ''}
                            loadouts={loadouts}
                            code="1.acheron-0._._._.as-c-0-3000-1500"
                            announce={noop}
                            onLoaded={noop}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
