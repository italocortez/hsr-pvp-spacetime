import { describe, expect, it } from 'vitest';
import {
    AUTOSAVE_CEILING_MS,
    AUTOSAVE_IDLE_MS,
    type Autosave,
    createAutosave,
    edit,
    failed,
    forget,
    hold,
    isPending,
    moveKey,
    release,
    requestFlush,
    SAVE_LIMIT,
    SAVE_WINDOW_MS,
    SERVER_RETRY_LIMIT,
    setOnline,
    settle,
    statusOf,
    step,
    succeeded,
    versionOf,
} from './autosave';

// T-S14.3c: the autosave state machine with a fake clock (A194 items 3 to 6).

/** Runs `step` and returns the keys sent plus the new state. */
function run(s: Autosave, now: number) {
    return step(s, now);
}

describe('the wait', () => {
    it('due 60 s after the last edit; each edit restarts it', () => {
        let s = edit(createAutosave(), 'a', 0);
        let r = run(s, 0);
        expect(r.send).toEqual([]);
        expect(r.wakeAt).toBe(AUTOSAVE_IDLE_MS);
        s = edit(r.state, 'a', 30_000);
        r = run(s, 59_999);
        expect(r.send).toEqual([]);
        expect(r.wakeAt).toBe(90_000);
        r = run(r.state, 90_000);
        expect(r.send).toEqual(['a']);
    });

    it('the ceiling: 5 minutes after the first unsaved edit, even while edits go on', () => {
        let s = createAutosave();
        let t = 0;
        for (; t < AUTOSAVE_CEILING_MS; t += 50_000) {
            s = edit(s, 'a', t);
            const r = run(s, t);
            expect(r.send).toEqual([]);
            s = r.state;
        }
        expect(run(s, AUTOSAVE_CEILING_MS).send).toEqual(['a']);
    });

    it('the status follows: waiting from the last edit to the due time', () => {
        const s = edit(createAutosave(), 'a', 1_000);
        expect(statusOf(s, 'a', 2_000)).toEqual({
            kind: 'waiting',
            from: 1_000,
            due: 1_000 + AUTOSAVE_IDLE_MS,
        });
        expect(statusOf(s, 'b', 2_000)).toEqual({ kind: 'saved', everSaved: false });
    });
});

describe('flush', () => {
    it('makes one loadout due at once', () => {
        let s = edit(createAutosave(), 'a', 0);
        s = edit(s, 'b', 0);
        s = requestFlush(s, 'a');
        expect(run(s, 1).send).toEqual(['a']);
    });

    it('without a key flushes every dirty loadout; a clean one is not sent', () => {
        let s = edit(createAutosave(), 'a', 0);
        s = edit(s, 'b', 0);
        let r = run(requestFlush(s), 1);
        expect(r.send.sort()).toEqual(['a', 'b']);
        r = { ...r, state: succeeded(r.state, 'a', 1) };
        expect(run(requestFlush(r.state), 2).send).toEqual([]);
    });
});

describe('one in flight', () => {
    it('edits during a save keep the loadout dirty; the next save carries them', () => {
        let s = requestFlush(edit(createAutosave(), 'a', 0), 'a');
        let r = run(s, 0);
        expect(r.send).toEqual(['a']);
        const sent = versionOf(r.state, 'a');
        s = edit(r.state, 'a', 100);
        s = requestFlush(s, 'a');
        // In flight: not sent twice.
        expect(run(s, 200).send).toEqual([]);
        expect(statusOf(s, 'a', 200).kind).toBe('saving');
        s = succeeded(s, 'a', sent);
        expect(isPending(s, 'a')).toBe(true);
        r = run(s, 300);
        expect(r.send).toEqual(['a']);
        s = succeeded(r.state, 'a', versionOf(r.state, 'a'));
        expect(isPending(s, 'a')).toBe(false);
        expect(statusOf(s, 'a', 400)).toEqual({ kind: 'saved', everSaved: true });
    });

    it('after a save that missed later edits, the ceiling counts from the send', () => {
        let r = run(requestFlush(edit(createAutosave(), 'a', 0), 'a'), 0);
        let s = edit(r.state, 'a', 10);
        s = succeeded(s, 'a', 1);
        r = run(s, 10);
        expect(r.wakeAt).toBe(10 + AUTOSAVE_IDLE_MS);
    });
});

describe('the server limit', () => {
    it('never more than 6 sends in 60 s across loadouts: the seventh waits in the queue', () => {
        let s = createAutosave();
        for (let i = 0; i < SAVE_LIMIT + 1; i++) s = requestFlush(edit(s, `k${i}`, 0), `k${i}`);
        const r = run(s, 0);
        expect(r.send).toHaveLength(SAVE_LIMIT);
        const left = 'k6';
        expect(r.send).not.toContain(left);
        expect(statusOf(r.state, left, 0)).toMatchObject({ kind: 'blocked', reason: 'queued' });
        expect(r.wakeAt).toBe(SAVE_WINDOW_MS);
        let s2 = r.state;
        for (const k of r.send) s2 = succeeded(s2, k, 1);
        expect(run(s2, SAVE_WINDOW_MS - 1).send).toEqual([]);
        expect(run(s2, SAVE_WINDOW_MS).send).toEqual([left]);
    });

    it('a too-fast refusal is retried with backoff (10 s, 20 s, ...), the draft stays dirty', () => {
        let r = run(requestFlush(edit(createAutosave(), 'a', 0), 'a'), 0);
        let s = failed(r.state, 'a', 0, 'too-fast', 'Your loadout was not saved yet.');
        expect(statusOf(s, 'a', 0)).toMatchObject({ kind: 'blocked', reason: 'too-fast' });
        expect(isPending(s, 'a')).toBe(true);
        r = run(s, 9_999);
        expect(r.send).toEqual([]);
        expect(r.wakeAt).toBe(10_000);
        r = run(r.state, 70_000);
        expect(r.send).toEqual(['a']);
        s = failed(r.state, 'a', 70_000, 'too-fast');
        r = run(s, 70_000 + 19_999);
        expect(r.send).toEqual([]);
        expect(run(r.state, 90_000).send).toEqual(['a']);
    });

    it('a content refusal waits for the next edit', () => {
        let r = run(requestFlush(edit(createAutosave(), 'a', 0), 'a'), 0);
        const s = failed(r.state, 'a', 0, 'refused', 'Unknown character "x".');
        expect(statusOf(s, 'a', 1)).toEqual({
            kind: 'blocked',
            reason: 'refused',
            message: 'Unknown character "x".',
        });
        r = run(requestFlush(s, 'a'), 999_999);
        expect(r.send).toEqual([]);
        expect(r.wakeAt).toBeNull();
        const edited = edit(r.state, 'a', 1_000_000);
        expect(run(edited, 1_000_001).send).toEqual([]);
        expect(run(edited, 1_000_000 + AUTOSAVE_IDLE_MS).send).toEqual(['a']);
    });

    it('retry (the page moved it to a free slot) goes again at once', () => {
        const r = run(requestFlush(edit(createAutosave(), '3', 0), '3'), 0);
        const s = moveKey(failed(r.state, '3', 0, 'retry'), '3', '4');
        expect(run(s, 1).send).toEqual(['4']);
    });
});

describe('offline and back', () => {
    it('nothing is sent while offline; the status says so; back online it goes', () => {
        let s = setOnline(createAutosave(), false);
        s = requestFlush(edit(s, 'a', 0), 'a');
        let r = run(s, 0);
        expect(r.send).toEqual([]);
        expect(statusOf(r.state, 'a', 0)).toMatchObject({ kind: 'blocked', reason: 'offline' });
        s = edit(r.state, 'a', 1);
        r = run(s, 2);
        expect(r.send).toEqual([]);
        r = run(setOnline(r.state, true), AUTOSAVE_IDLE_MS + 1);
        expect(r.send).toEqual(['a']);
    });

    it('a call that could not be sent is retried after 10 s or when the connection is back', () => {
        let r = run(requestFlush(edit(createAutosave(), 'a', 0), 'a'), 0);
        const s = failed(r.state, 'a', 0, 'offline');
        r = run(s, 5_000);
        expect(r.send).toEqual([]);
        expect(run(setOnline(setOnline(r.state, false), true), 5_001).send).toEqual(['a']);
    });

    it('several drafts come back within the limit', () => {
        let s = setOnline(createAutosave(), false);
        for (let i = 0; i < 8; i++) s = requestFlush(edit(s, `k${i}`, 0), `k${i}`);
        const r = run(setOnline(run(s, 0).state, true), 1);
        expect(r.send).toHaveLength(SAVE_LIMIT);
    });
});

describe('forget', () => {
    it('a deleted loadout is never sent', () => {
        const s = forget(requestFlush(edit(createAutosave(), 'a', 0), 'a'), 'a');
        expect(run(s, 1).send).toEqual([]);
        expect(forget(s, 'zz')).toBe(s);
    });
});

// T-S14.3c-fix (review B2, S1, S6).
describe('hold and release (a conflict waits for the person)', () => {
    it('a held draft is never sent, also after edits, a flush or the ceiling; release sends it at once', () => {
        let s = hold(edit(createAutosave(), 'a', 0), 'a', 0);
        s = requestFlush(edit(s, 'a', 10_000));
        expect(run(s, AUTOSAVE_CEILING_MS + 1).send).toEqual([]);
        expect(statusOf(s, 'a', 1)).toEqual({ kind: 'blocked', reason: 'conflict', message: null });
        expect(run(release(s, 'a'), AUTOSAVE_CEILING_MS + 2).send).toEqual(['a']);
    });

    it('a draft found on load (no entry yet) is held as unsaved work', () => {
        const s = hold(createAutosave(), 'a', 0);
        expect(isPending(s, 'a')).toBe(true);
        expect(run(s, 1_000_000).send).toEqual([]);
    });
});

describe('settle (the account copy already holds the draft)', () => {
    it('the pending save is cancelled; nothing is sent; the ring is back to saved', () => {
        const s = settle(edit(createAutosave(), 'a', 0), 'a');
        expect(run(s, AUTOSAVE_CEILING_MS).send).toEqual([]);
        expect(statusOf(s, 'a', 1)).toEqual({ kind: 'saved', everSaved: false });
        expect(statusOf(settle(edit(createAutosave(), 'b', 0), 'b', true), 'b', 1)).toEqual({
            kind: 'saved',
            everSaved: true,
        });
    });

    it('a save in flight is left to report', () => {
        const r = run(requestFlush(edit(createAutosave(), 'a', 0), 'a'), 0);
        expect(settle(r.state, 'a')).toBe(r.state);
    });
});

// T-S14.3c-sync (second review N4; A198).
describe('a server runtime failure (InternalError): bounded', () => {
    it('retried after 10, 20, 40, 60 s with its own reason, then stopped until an edit', () => {
        let s = requestFlush(edit(createAutosave(), 'a', 0), 'a');
        let now = 0;
        const sends: number[] = [];
        for (let i = 0; i < 20; i++) {
            const r = run(s, now);
            if (r.send.length) {
                sends.push(now);
                s = failed(r.state, 'a', now, 'internal');
            } else s = r.state;
            if (r.wakeAt === null && !r.send.length) break;
            now = r.wakeAt ?? now;
        }
        expect(sends).toEqual([0, 10_000, 30_000, 70_000, 130_000]);
        expect(SERVER_RETRY_LIMIT).toBe(5);
        expect(statusOf(s, 'a', now)).toEqual({
            kind: 'blocked',
            reason: 'server-stopped',
            message: null,
        });
        expect(run(s, 10_000_000).send).toEqual([]);
        // An edit: a fresh wait and five more tries.
        const edited = edit(s, 'a', 10_000_000);
        expect(run(edited, 10_000_000 + AUTOSAVE_IDLE_MS).send).toEqual(['a']);
    });

    it('while retrying the status says so (not "no connection")', () => {
        const r = run(requestFlush(edit(createAutosave(), 'a', 0), 'a'), 0);
        expect(statusOf(failed(r.state, 'a', 0, 'internal'), 'a', 1)).toEqual({
            kind: 'blocked',
            reason: 'server-error',
            message: null,
        });
    });

    it('stopped: a reconnect sends it again at once', () => {
        let s = requestFlush(edit(createAutosave(), 'a', 0), 'a');
        for (let i = 0; i < SERVER_RETRY_LIMIT; i++) {
            const t = i * 1_000_000;
            const r = run(s, t);
            expect(r.send).toEqual(['a']);
            s = failed(r.state, 'a', t, 'internal');
        }
        expect(statusOf(s, 'a', 0)).toMatchObject({ reason: 'server-stopped' });
        expect(run(setOnline(setOnline(s, false), true), 9_000_000).send).toEqual(['a']);
    });
});

describe('hold reasons (A198)', () => {
    it('deleted and retired are held like a conflict; release ends any of them', () => {
        for (const reason of ['deleted', 'retired'] as const) {
            const s = hold(edit(createAutosave(), 'a', 0), 'a', 0, reason, 'why');
            expect(statusOf(s, 'a', 1)).toEqual({ kind: 'blocked', reason, message: 'why' });
            expect(run(requestFlush(s), AUTOSAVE_CEILING_MS + 1).send).toEqual([]);
            expect(run(release(s, 'a'), 1).send).toEqual(['a']);
        }
    });

    it('holding again for the same reason keeps its message; a save in flight is not held', () => {
        const s = hold(edit(createAutosave(), 'a', 0), 'a', 0, 'retired', 'server text');
        expect(hold(s, 'a', 5, 'retired')).toBe(s);
        const flying = run(requestFlush(edit(createAutosave(), 'b', 0), 'b'), 0).state;
        expect(hold(flying, 'b', 1, 'conflict')).toBe(flying);
    });
});

describe('a result not known (the connection dropped in flight)', () => {
    it('shown as no connection, retried when the connection is back, and with backoff while it stays', () => {
        let r = run(requestFlush(edit(createAutosave(), 'a', 0), 'a'), 0);
        const s = failed(
            r.state,
            'a',
            0,
            'unknown',
            'Connection lost before the call was acknowledged',
        );
        expect(statusOf(s, 'a', 1)).toEqual({ kind: 'blocked', reason: 'offline', message: null });
        expect(run(s, 9_999).send).toEqual([]);
        r = run(s, 10_000);
        expect(r.send).toEqual(['a']);
        // Twice: 20 s.
        const twice = failed(r.state, 'a', 10_000, 'unknown');
        expect(run(twice, 29_999).send).toEqual([]);
        expect(run(twice, 30_000).send).toEqual(['a']);
        // The connection back: at once.
        expect(run(setOnline(setOnline(twice, false), true), 10_001).send).toEqual(['a']);
    });
});
