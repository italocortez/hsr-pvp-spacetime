/*
 * Plain-text search params for the router (user decision 2026-11-12, A169): no JSON in the URL.
 * Every value reaches `validateSearch` as a string, or an array of strings when a key repeats;
 * validators convert text to numbers or flags themselves.
 */

type RawSearch = Record<string, string | string[]>;

/** `parseSearch`: `?a=1&b=x&b=y` gives `{ a: '1', b: ['x', 'y'] }`. */
export function parseSearch(searchStr: string): RawSearch {
    // No prototype, so a `__proto__` key is just a key.
    const out: RawSearch = Object.create(null);
    for (const [key, value] of new URLSearchParams(searchStr)) {
        const prev = out[key];
        if (prev === undefined) out[key] = value;
        else if (Array.isArray(prev)) prev.push(value);
        else out[key] = [prev, value];
    }
    return out;
}

/**
 * `stringifySearch`: keys sorted; `undefined`, `null`, empty strings and non-text values are left
 * out; an array is written as a repeated key (`?el=fire&el=ice`). Numbers and booleans are
 * written as their text.
 */
export function stringifySearch(search: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const key of Object.keys(search).sort()) {
        const value = search[key];
        for (const item of Array.isArray(value) ? value : [value]) {
            const text = toText(item);
            if (text !== undefined) params.append(key, text);
        }
    }
    const str = params.toString();
    return str ? `?${str}` : '';
}

function toText(value: unknown): string | undefined {
    if (typeof value === 'string') return value === '' ? undefined : value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
}
