/*
 * Focus moved by code, not by the person (S14.4d-fix, review D S1). A dialog that places its first focus, or returns
 * focus after a close, is not the person's keyboard reaching a control: a control that reacts to keyboard focus (the
 * information popover opens its panel then) must not react to it. `focusQuietly` marks the element while its focus
 * event runs (focus events fire synchronously inside `focus()`); `isQuietFocus` asks, from inside that event.
 */

let quiet: Element | null = null;

/** `el.focus(options)`, marked as moved by code for the focus event it fires. */
export function focusQuietly(el: HTMLElement, options?: FocusOptions): void {
    const before = quiet;
    quiet = el;
    try {
        el.focus(options);
    } finally {
        quiet = before;
    }
}

/** True inside the focus event of a `focusQuietly` call on `el`. */
export function isQuietFocus(el: Element | null): boolean {
    return el !== null && quiet === el;
}
