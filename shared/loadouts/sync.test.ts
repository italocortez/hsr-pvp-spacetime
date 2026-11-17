import { describe, expect, it } from 'vitest';
import {
    afterSave,
    asNew,
    CONFLICT_TEXT,
    type Draft,
    GONE_TEXT,
    isOwnSave,
    keepMine,
    type Outcome,
    outcomeOf,
    REV_MAX_TEXT,
    type Row,
    reconcile,
    SENT_KEEP,
    type Sent,
    SLOT_TAKEN_TEXT,
    TOO_FAST_PREFIX,
    withSent,
} from './sync';

// T-S14.3c-sync: the version rules of an account draft against its row and against each answer (DECISIONS.md A198).

const A = { name: 'Hyper', note: '', code: 'a' };
const B = { name: 'Hyper', note: '', code: 'b' };
const C = { name: 'Hyper', note: '', code: 'c' };

const draft = (over: Partial<Draft> = {}): Draft => ({
    ...B,
    baseRev: 3,
    at: 1,
    tab: 't',
    seen: 1,
    sent: [],
    held: null,
    keep: false,
    ...over,
});
const row = (content: { name: string; note: string; code: string }, rev: number): Row => ({
    ...content,
    rev,
});
const sent = (content: { name: string; note: string; code: string }, baseRev: number): Sent => ({
    ...content,
    baseRev,
});

class Named extends Error {
    constructor(
        readonly kind: string,
        message = kind,
    ) {
        super(message);
    }
    override get name() {
        return this.kind;
    }
}

describe('outcomeOf: the SDK by error name, the module by its exact sentence', () => {
    it.each([
        [new Named('NotConnectedError'), { kind: 'offline' }],
        [new Named('DisconnectedError'), { kind: 'offline' }],
        [new Named('UnknownCallResultError'), { kind: 'unknown' }],
        [new Named('InternalError', 'out of energy'), { kind: 'internal' }],
        [new Named('SenderError', `${TOO_FAST_PREFIX} in a short time.`), { kind: 'too-fast' }],
        [new Named('SenderError', SLOT_TAKEN_TEXT), { kind: 'slot-taken' }],
        [new Named('SenderError', GONE_TEXT), { kind: 'deleted' }],
        [new Named('SenderError', CONFLICT_TEXT), { kind: 'changed' }],
        [new Named('SenderError', REV_MAX_TEXT), { kind: 'retired' }],
        [new Named('SenderError', 'Unknown character "x".'), { kind: 'refused' }],
        ['a plain string', { kind: 'refused' }],
    ])('%s', (error, expected) => {
        expect(outcomeOf(error)).toMatchObject(expected);
    });
});

describe('reconcile: an existing loadout (base above 0)', () => {
    it('the row at the base: sent; the same draft object comes back', () => {
        const d = draft();
        const v = reconcile(d, row(A, 3));
        expect(v).toEqual({ kind: 'send', draft: d });
        if (v.kind === 'send') expect(v.draft).toBe(d);
    });

    it('the row holds the draft (an edit taken back, the same edit elsewhere): dropped', () => {
        expect(reconcile(draft(), row(B, 3))).toEqual({ kind: 'drop' });
        expect(reconcile(draft(), row(B, 9))).toEqual({ kind: 'drop' });
    });

    it('the row at another version (changed elsewhere, or stale rows on load): held as a conflict', () => {
        const v = reconcile(draft(), row(C, 4));
        expect(v).toMatchObject({ kind: 'hold', draft: { held: 'conflict' } });
    });

    it('no row (deleted elsewhere): held as deleted, never sent as new', () => {
        expect(reconcile(draft(), null)).toMatchObject({
            kind: 'hold',
            draft: { held: 'deleted' },
        });
    });

    it('a held conflict whose row then goes is a deletion', () => {
        const v = reconcile(draft({ held: 'conflict' }), null);
        expect(v).toMatchObject({ kind: 'hold', draft: { held: 'deleted' } });
    });

    it('held stays held, also when the row is back at the base (no release loop)', () => {
        const d = draft({ held: 'conflict' });
        expect(reconcile(d, row(A, 3))).toEqual({ kind: 'hold', draft: d });
        const gone = draft({ held: 'deleted' });
        // The slot reused by another loadout: still deleted (seen live), not a conflict.
        expect(reconcile(gone, row(C, 9))).toEqual({ kind: 'hold', draft: gone });
    });

    it('keep: sent on its own version whatever the row (the server says which it is)', () => {
        const d = keepMine(draft({ held: 'conflict' }));
        expect(reconcile(d, row(C, 4))).toEqual({ kind: 'send', draft: d });
    });
});

describe('reconcile: a new loadout (base 0)', () => {
    it('an empty slot: sent (created)', () => {
        const d = draft({ baseRev: 0 });
        expect(reconcile(d, null)).toEqual({ kind: 'send', draft: d });
    });

    it('another loadout in its slot: moved (never written over it)', () => {
        const d = draft({ baseRev: 0 });
        expect(reconcile(d, row(A, 7))).toEqual({ kind: 'move', draft: d });
    });

    it('a row equal to it: dropped (two identical new loadouts are one)', () => {
        expect(reconcile(draft({ baseRev: 0 }), row(B, 7))).toEqual({ kind: 'drop' });
    });
});

describe('own saves (sent): recognised by the row, after a lost answer or a reload', () => {
    it('an update landed (base + 1, the sent content): rebased; the rest still to send', () => {
        const d = draft({ ...C, sent: [sent(B, 3)] });
        const v = reconcile(d, row(B, 4));
        expect(v).toMatchObject({ kind: 'send', draft: { baseRev: 4, sent: [], code: 'c' } });
    });

    it('it landed and the draft is that content: dropped', () => {
        expect(reconcile(draft({ sent: [sent(B, 3)] }), row(B, 4))).toEqual({ kind: 'drop' });
    });

    it('a create landed (any version): rebased on it, not moved', () => {
        const d = draft({ ...C, baseRev: 0, sent: [sent(B, 0)] });
        expect(reconcile(d, row(B, 12))).toMatchObject({ kind: 'send', draft: { baseRev: 12 } });
    });

    it('a row that only looks like it (wrong version) is not this page’s: conflict', () => {
        const d = draft({ ...C, sent: [sent(B, 3)] });
        expect(reconcile(d, row(B, 5))).toMatchObject({
            kind: 'hold',
            draft: { held: 'conflict' },
        });
        expect(isOwnSave(d, row(B, 5))).toBe(false);
    });

    it('an unchanged save (the row at its base held it): forgotten', () => {
        const d = draft({ ...C, sent: [sent(A, 3)] });
        const v = reconcile(d, row(A, 3));
        expect(v).toMatchObject({ kind: 'send', draft: { sent: [] } });
    });

    it('its own save ends a hold that the row explained', () => {
        const d = draft({ ...C, held: 'conflict', sent: [sent(B, 3)] });
        expect(reconcile(d, row(B, 4))).toMatchObject({
            kind: 'send',
            draft: { baseRev: 4, held: null },
        });
    });

    it('at most SENT_KEEP remembered', () => {
        let d = draft();
        for (let i = 0; i < SENT_KEEP + 2; i++) d = withSent(d, sent({ ...A, code: `x${i}` }, 3));
        expect(d.sent).toHaveLength(SENT_KEEP);
        expect(d.sent[0]?.code).toBe('x2');
    });

    it('idempotent: reconcile on its own result gives the same', () => {
        const cases: [Draft, Row | null][] = [
            [draft({ ...C, sent: [sent(B, 3)] }), row(B, 4)],
            [draft(), row(C, 4)],
            [draft(), null],
            [draft({ baseRev: 0 }), row(A, 2)],
            [draft({ ...C, sent: [sent(A, 3)] }), row(A, 3)],
        ];
        for (const [d, r] of cases) {
            const first = reconcile(d, r);
            if (first.kind === 'drop') continue;
            const again = reconcile(first.draft, r);
            expect(again.kind).toBe(first.kind);
            if (again.kind !== 'drop') expect(again.draft).toBe(first.draft);
        }
    });
});

describe('afterSave: every answer', () => {
    const s3 = sent(B, 3);
    const d = withSent(draft(), s3);
    const run = (o: Outcome, r: Row | null, from: Draft = d, s: Sent = s3) =>
        afterSave(from, s, o, r);

    it('ok: saved; the send stays until its row shows it', () => {
        const r = run({ kind: 'ok' }, row(A, 3));
        expect(r).toEqual({ draft: d, next: 'saved', message: null });
    });

    it('ok after Keep: the keep is spent', () => {
        expect(run({ kind: 'ok' }, null, { ...d, keep: true }).draft?.keep).toBe(false);
    });

    it('unknown (answer lost): kept with its send, to recognise its row later', () => {
        expect(run({ kind: 'unknown' }, null)).toEqual({
            draft: d,
            next: 'unknown',
            message: null,
        });
    });

    it.each([
        [{ kind: 'offline' } as const, 'offline'],
        [{ kind: 'internal' } as const, 'internal'],
        [{ kind: 'too-fast', text: 'slow down' } as const, 'too-fast'],
        [{ kind: 'refused', text: 'Unknown character "x".' } as const, 'refused'],
    ])('%o: the send is forgotten (known not written)', (o, next) => {
        const r = run(o, row(A, 3));
        expect(r.next).toBe(next);
        expect(r.draft?.sent).toEqual([]);
        if ('text' in o) expect(r.message).toBe(o.text);
    });

    it('changed, the row holds the draft (its own earlier save, or the same edit): settled, no conflict', () => {
        expect(run({ kind: 'changed' }, row(B, 4))).toMatchObject({ draft: null, next: 'settled' });
    });

    it('changed, the row is an earlier send of this draft: rebased and sent again', () => {
        const two = withSent(withSent(draft({ ...C }), sent(B, 3)), sent(C, 3));
        const r = afterSave(two, sent(C, 3), { kind: 'changed' }, row(B, 4));
        expect(r).toMatchObject({ next: 'retry', draft: { baseRev: 4, sent: [] } });
    });

    it('changed by another device: held as a conflict', () => {
        expect(run({ kind: 'changed' }, row(C, 4))).toMatchObject({
            next: 'hold',
            draft: { held: 'conflict', sent: [] },
        });
    });

    it('changed, the view not yet showing it: held (the row, when it comes, decides)', () => {
        expect(run({ kind: 'changed' }, row(A, 3))).toMatchObject({
            next: 'hold',
            draft: { held: 'conflict' },
        });
    });

    it('changed after Keep: sent again at once on the version the view shows', () => {
        const kept = withSent(keepMine(draft({ held: 'conflict' })), s3);
        expect(afterSave(kept, s3, { kind: 'changed' }, row(C, 6))).toMatchObject({
            next: 'retry',
            draft: { baseRev: 6, keep: false, held: null },
        });
        // The view still shows the old version: held again, never a loop of sends.
        expect(afterSave(kept, s3, { kind: 'changed' }, row(A, 3))).toMatchObject({
            next: 'hold',
            draft: { held: 'conflict', keep: false },
        });
    });

    it('deleted: held as deleted (Keep on a reused slot ends here too)', () => {
        expect(run({ kind: 'deleted' }, null)).toMatchObject({
            next: 'hold',
            draft: { held: 'deleted' },
        });
        expect(run({ kind: 'deleted' }, row(C, 9), { ...d, keep: true })).toMatchObject({
            next: 'hold',
            draft: { held: 'deleted', keep: false },
        });
    });

    it('retired: held with the server text', () => {
        expect(run({ kind: 'retired', text: REV_MAX_TEXT }, row(A, 3))).toMatchObject({
            next: 'hold',
            message: REV_MAX_TEXT,
            draft: { held: 'retired' },
        });
    });

    describe('slot taken (a create)', () => {
        const s0 = sent(B, 0);
        const n = withSent(draft({ baseRev: 0 }), s0);
        it('another loadout there: move', () => {
            expect(afterSave(n, s0, { kind: 'slot-taken' }, row(A, 5))).toMatchObject({
                next: 'move',
            });
        });
        it('its own earlier create (answer lost) holds the draft: settled', () => {
            const lost = withSent(n, s0);
            expect(afterSave(lost, s0, { kind: 'slot-taken' }, row(B, 5))).toMatchObject({
                next: 'settled',
                draft: null,
            });
        });
        it('its own earlier create, edited since: rebased, sent again as an update', () => {
            const edited = withSent(withSent(draft({ ...C, baseRev: 0 }), s0), sent(C, 0));
            expect(afterSave(edited, sent(C, 0), { kind: 'slot-taken' }, row(B, 5))).toMatchObject({
                next: 'retry',
                draft: { baseRev: 5 },
            });
        });
        it('the view not showing the row yet: move anyway (the server said taken)', () => {
            expect(afterSave(n, s0, { kind: 'slot-taken' }, null)).toMatchObject({ next: 'move' });
        });
    });
});

describe('the choices', () => {
    it('Save as a new loadout: base 0, no sends, no hold', () => {
        expect(asNew(draft({ held: 'deleted', sent: [sent(A, 3)], keep: true }))).toMatchObject({
            baseRev: 0,
            sent: [],
            held: null,
            keep: false,
        });
    });
});
