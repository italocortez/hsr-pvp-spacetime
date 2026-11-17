import { describe, expect, it } from 'vitest';
import {
    adopt,
    createAutosave,
    edit,
    failed,
    SERVER_RETRY_LIMIT,
    sameWait,
    statusOf,
    step,
    type Wait,
    waitOf,
} from './autosave';
import {
    ADOPT_AFTER_MS,
    adoption,
    beatGone,
    beatGoneAt,
    type Draft,
    deleteBase,
    editBase,
    ownership,
    type Row,
    ringStatus,
    SENT_GRACE_MS,
    sendPending,
} from './sync';

// T-S14.3c-fix3: the decisions moved out of the page (review M8): which tab sends a draft, what a tab that takes one
// over inherits, which version an edit and a delete state, and what the ring says.

const C = { name: 'Hyper', note: '', code: 'b' };
const draft = (over: Partial<Draft> = {}): Draft => ({
    ...C,
    baseRev: 3,
    at: 1_000,
    tab: 't-a',
    seen: 1_000,
    sent: [],
    held: null,
    keep: false,
    ...over,
});
const row = (code: string, rev: number): Row => ({ name: 'Hyper', note: '', code, rev });

describe('ownership: only a gone owner loses its draft', () => {
    it('mine, released, gone, alive', () => {
        expect(ownership(draft({ tab: 't-me' }), 't-me', false)).toBe('mine');
        expect(ownership(draft({ tab: null }), 't-me', false)).toBe('take');
        expect(ownership(draft({ tab: 't-a' }), 't-me', true)).toBe('take');
        expect(ownership(draft({ tab: 't-a' }), 't-me', false)).toBe('wait');
    });
    it('heartbeat: the latest of the draft touch and the beat counts; a draft that waits long is not gone', () => {
        const seen = 0;
        expect(beatGone(seen, null, ADOPT_AFTER_MS - 1)).toBe(false);
        expect(beatGone(seen, null, ADOPT_AFTER_MS)).toBe(true);
        // A beat every 30 s keeps an owner whose draft was last touched an hour ago.
        expect(beatGone(seen, 3_600_000, 3_600_000 + 30_000)).toBe(false);
        expect(beatGoneAt(seen, 3_600_000)).toBe(3_600_000 + ADOPT_AFTER_MS);
        // An old beat (another visit's) does not hide a fresh draft touch.
        expect(beatGone(10_000, 0, 10_000 + 60_000)).toBe(false);
    });
});

describe('adoption: the taker inherits the waiting state (review S1) and waits for a send on its way (M4)', () => {
    it('a crashed owner: its ordinary wait goes on from the last edit', () => {
        const a = adoption(draft({ tab: 't-a' }), 50_000);
        expect(a).toEqual({ at: 1_000, wait: null, flush: false, notBefore: null });
        const s = adopt(createAutosave(), '0', a);
        expect(step(s, 60_999).send).toEqual([]);
        expect(step(s, 61_000).send).toEqual(['0']);
    });
    it('a released draft is due at once; one whose last send carries it waits SENT_GRACE_MS', () => {
        expect(adoption(draft({ tab: null }), 5_000).flush).toBe(true);
        const d = draft({ tab: null, sent: [{ ...C, baseRev: 3 }] });
        expect(sendPending(d)).toBe(true);
        expect(sendPending({ ...d, code: 'c' })).toBe(false);
        expect(sendPending({ ...d, baseRev: 4 })).toBe(false);
        const s = adopt(createAutosave(), '0', adoption(d, 5_000));
        expect(step(s, 5_000 + SENT_GRACE_MS - 1).send).toEqual([]);
        expect(step(s, 5_000 + SENT_GRACE_MS).send).toEqual(['0']);
    });
    it('a parked draft stays parked; a backoff keeps its time and its count', () => {
        const stopped: Wait = {
            reason: 'server-stopped',
            failures: 5,
            retryAt: null,
            message: null,
        };
        const s1 = adopt(createAutosave(), '0', {
            at: 0,
            wait: stopped,
            flush: true,
            notBefore: null,
        });
        expect(step(s1, 10 * 60_000).send).toEqual([]);
        expect(statusOf(s1, '0', 0)).toMatchObject({ kind: 'blocked', reason: 'server-stopped' });
        // An edit frees it, as in the tab that had it.
        expect(step(edit(s1, '0', 0), 60_000).send).toEqual(['0']);

        const backoff: Wait = {
            reason: 'server-error',
            failures: 4,
            retryAt: 90_000,
            message: null,
        };
        const s2 = adopt(createAutosave(), '0', {
            at: 0,
            wait: backoff,
            flush: true,
            notBefore: null,
        });
        expect(step(s2, 89_999).send).toEqual([]);
        const sent = step(s2, 90_000);
        expect(sent.send).toEqual(['0']);
        // The fifth failure in a row stops it, counting the tries of the tab that had it.
        const after = failed(sent.state, '0', 90_000, 'internal');
        expect(after.entries['0']?.failures).toBe(SERVER_RETRY_LIMIT);
        expect(statusOf(after, '0', 90_000)).toMatchObject({ reason: 'server-stopped' });
    });
    it('waitOf hands on only what belongs to the draft, not to this tab’s connection or queue', () => {
        let s = edit(createAutosave(), '0', 0);
        expect(waitOf(s, '0')).toBeNull();
        s = failed(step(s, 60_000).state, '0', 60_000, 'offline');
        expect(waitOf(s, '0')).toBeNull();
        s = failed(step(setOnlineBack(s), 80_000).state, '0', 80_000, 'too-fast', 'slow down');
        expect(waitOf(s, '0')).toEqual({
            reason: 'too-fast',
            failures: 2,
            retryAt: 100_000,
            message: 'slow down',
        });
        expect(sameWait(waitOf(s, '0'), { ...(waitOf(s, '0') as Wait) })).toBe(true);
        expect(sameWait(null, undefined)).toBe(true);
        expect(sameWait(waitOf(s, '0'), null)).toBe(false);
    });
});

const setOnlineBack = (s: ReturnType<typeof createAutosave>) => ({ ...s, online: true });

describe('editBase and deleteBase: the version the person has seen (review M8, M3)', () => {
    it('an edit: the draft’s base, else the row’s while the page shows it, else the loaded version, else the row’s', () => {
        const r = { rev: 5, code: 'x' };
        expect(editBase({ draft: 3, row: r, loaded: null })).toBe(3);
        expect(editBase({ draft: null, row: r, loaded: { code: 'x', rev: 2 } })).toBe(5);
        expect(editBase({ draft: null, row: r, loaded: { code: 'y', rev: 2 } })).toBe(2);
        expect(editBase({ draft: null, row: r, loaded: { code: 'y', rev: null } })).toBe(5);
        expect(editBase({ draft: null, row: r, loaded: null })).toBe(5);
        expect(editBase({ draft: null, row: null, loaded: null })).toBe(0);
    });
    it('a delete: the draft’s base, else the row’s; a new loadout once its create landed; none when deleted', () => {
        expect(deleteBase(null, row('b', 4))).toBe(4);
        expect(deleteBase(null, null)).toBeNull();
        expect(deleteBase(draft({ baseRev: 3 }), row('z', 4))).toBe(3);
        expect(deleteBase(draft({ held: 'deleted' }), row('z', 4))).toBeNull();
        expect(deleteBase(draft({ baseRev: 0 }), null)).toBeNull();
        expect(deleteBase(draft({ baseRev: 0 }), row('z', 9))).toBeNull();
        const created = draft({ baseRev: 0, sent: [{ ...C, baseRev: 0 }] });
        expect(deleteBase(created, row('b', 9))).toBe(9);
    });
});

describe('ringStatus: never "saved" over a draft that is not confirmed (review S2)', () => {
    const base = { me: 't-me', scheduled: null, row: row('a', 3), live: true, now: 5_000 };
    it('another tab’s draft reads as that tab’s', () => {
        expect(ringStatus({ ...base, draft: draft({ tab: 't-a' }) })).toEqual({
            kind: 'blocked',
            reason: 'other-tab',
            message: null,
        });
    });
    it('a released draft with no schedule here: offline, or waiting; never saved', () => {
        const d = draft({ tab: null });
        expect(ringStatus({ ...base, draft: d, live: false })).toMatchObject({
            kind: 'blocked',
            reason: 'offline',
        });
        expect(ringStatus({ ...base, draft: d })).toMatchObject({ kind: 'waiting', from: 1_000 });
        // Even when this tab's scheduler still holds a clean entry from before.
        expect(
            ringStatus({ ...base, draft: d, scheduled: { kind: 'saved', everSaved: true } }),
        ).toMatchObject({ kind: 'waiting' });
        expect(ringStatus({ ...base, draft: { ...d, held: 'conflict' } })).toMatchObject({
            reason: 'conflict',
        });
    });
    it('saved only with no draft, or when the account copy holds it; this tab’s schedule for its own draft', () => {
        expect(ringStatus({ ...base, draft: null })).toEqual({ kind: 'saved', everSaved: false });
        expect(ringStatus({ ...base, draft: draft({ tab: null }), row: row('b', 3) })).toEqual({
            kind: 'saved',
            everSaved: false,
        });
        expect(
            ringStatus({ ...base, draft: draft({ tab: 't-me' }), scheduled: { kind: 'saving' } }),
        ).toEqual({ kind: 'saving' });
    });
});
