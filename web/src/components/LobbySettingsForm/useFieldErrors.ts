import { useEffect, useRef, useState } from 'react';

/*
 * The error timing, focus and read-out of a form section (S14.4c, lifted for S14.4d's Advanced Settings): one hook for
 * any list of fields, so a second section or dialog reuses the rules of the main dialog (web-guidance
 * accessible-error-announcement.md, validate-input-after-interaction.md).
 *
 * - A field's error shows once the person has left or changed it (`touch`), and every error after a submit
 *   (`submitCount` above 0).
 * - A field is `aria-invalid="false"` until its error shows, then `true` with the error listed in `aria-describedby`.
 * - An error that appears on leaving or changing a field is read out through one polite region (`announcement`) half a
 *   second later, so it does not talk over the next field. The region is cleared once that error no longer shows, so
 *   the same error shown again is read again.
 * - After a failed submit the first invalid field of `fields` (in their order) takes focus instead; its error is read
 *   with it. Only fields inside `containerRef` with `data-field="<key>"` are found: a field of another section is that
 *   section's to focus.
 */

export const ANNOUNCE_DELAY_MS = 500;

export type FieldErrorsOptions<F extends string> = {
    /** The section's fields, in the order focus looks for the first invalid one. */
    fields: readonly F[];
    /** Each field's label, for the read-out ("Lobby Password: …"). */
    labels: Readonly<Record<F, string>>;
    /** Every current error, keyed by field (other keys are ignored). */
    errors: Readonly<Partial<Record<string, string>>>;
    /** Submits tried so far: above 0 shows every error; a new value moves focus to the first invalid field. */
    submitCount: number;
    /** Makes each field's error id (`${idPrefix}-${key}-error`). */
    idPrefix: string;
    /**
     * S14.4d: set when the host decides which section takes focus (two sections, one submit). Each new value above 0
     * moves focus to the first invalid field of `fields`, also on the first render (a section that mounts to show its
     * errors, as Advanced Settings opened by Create); 0 asks for nothing. While set, a submit alone moves no focus here.
     */
    focusRequest?: number;
};

export function useFieldErrors<F extends string>({
    fields,
    labels,
    errors,
    submitCount,
    idPrefix,
    focusRequest,
}: FieldErrorsOptions<F>) {
    const [touched, setTouched] = useState<ReadonlySet<F>>(() => new Set());
    const [announcement, setAnnouncement] = useState('');
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const containerRef = useRef<HTMLFieldSetElement>(null);

    useEffect(() => () => clearTimeout(timer.current), []);

    const errorId = (key: F) => `${idPrefix}-${key}-error`;
    const shows = (key: F) => errors[key] !== undefined && (submitCount > 0 || touched.has(key));

    /** Marks a field as left or changed: its error, if any, shows from now on. */
    const touch = (key: F) => {
        if (!touched.has(key)) setTouched((t) => new Set(t).add(key));
    };

    const shownNow = fields.filter(shows).map((k) => `${labels[k]}: ${errors[k]}`);
    const shownKey = JSON.stringify(shownNow);
    const before = useRef<{ shown: readonly string[]; submits: number }>({
        shown: [],
        submits: submitCount,
    });
    const shownLatest = useRef<readonly string[]>([]);
    const announced = useRef('');
    useEffect(() => {
        const now = JSON.parse(shownKey) as string[];
        shownLatest.current = now;
        const fresh = now.find((line) => !before.current.shown.includes(line));
        const bySubmit = before.current.submits !== submitCount;
        before.current = { shown: now, submits: submitCount };
        // The line read last no longer applies: clear the region, so the same error later is read again.
        if (announced.current !== '' && !now.includes(announced.current)) {
            announced.current = '';
            setAnnouncement('');
        }
        if (bySubmit || fresh === undefined) return;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            if (!shownLatest.current.includes(fresh)) return;
            announced.current = fresh;
            setAnnouncement(fresh);
        }, ANNOUNCE_DELAY_MS);
    }, [shownKey, submitCount]);

    // A failed submit: the first invalid field takes focus (in the order of `fields`).
    const lastSubmit = useRef(submitCount);
    useEffect(() => {
        if (submitCount === lastSubmit.current) return;
        lastSubmit.current = submitCount;
        if (focusRequest !== undefined) return;
        const first = fields.find((k) => errors[k] !== undefined);
        if (!first) return;
        containerRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus();
    }, [submitCount, errors, fields, focusRequest]);

    // The host's request (S14.4d). After the commit's other effects: a dialog that opens with this section places its
    // own first focus in the same commit, and this one must come after it.
    const lastRequest = useRef(0);
    useEffect(() => {
        if (focusRequest === undefined || focusRequest === lastRequest.current) return;
        lastRequest.current = focusRequest;
        if (focusRequest === 0) return;
        const first = fields.find((k) => errors[k] !== undefined);
        if (!first) return;
        queueMicrotask(() =>
            containerRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus(),
        );
    }, [focusRequest, errors, fields]);

    /** The props that tie a control to its error. */
    const errorProps = (key: F) => ({
        'aria-invalid': shows(key),
        'aria-describedby': shows(key) ? errorId(key) : undefined,
        'data-field': key as string,
    });

    return { shows, touch, errorId, errorProps, announcement, containerRef };
}
