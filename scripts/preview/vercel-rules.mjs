// M8: the parts of vercel.json the local preview imitates, as pure functions (no I/O).
//
// What Vercel documents and this file follows for a static output directory:
//   - the filesystem is checked first: an existing file is served as itself;
//   - then `rewrites`, in order; the first whose source matches serves its destination;
//   - every `headers` rule whose source matches the request path applies, in order; a later rule
//     wins on the same key (keys compared without case);
//   - a static file whose rules set no Cache-Control gets `public, max-age=0, must-revalidate`.
//
// Sources are read like path-to-regexp: a parenthesised group is a regular expression, everything
// else is literal. Only that subset is supported. Named parameters (`:id`, `:path*`), modifiers
// outside a group, `{ }` groups, capturing groups nested in a group, `has` / `missing` conditions,
// destinations with `$1` or `:name` or an external URL, and the top-level `redirects`, `routes`,
// `cleanUrls` and `trailingSlash` keys throw at compile time instead of being guessed.
//
// Unproven against Vercel (see docs/frontend/hosting.md, "Local preview"): case sensitivity
// (matched case-sensitively here), an optional trailing slash (not matched here), and which path
// (raw or decoded) Vercel tests a source against (the caller passes the decoded path), and how
// Vercel's matcher treats `(?:` `(?!` groups (passed to RegExp as written here).

/** Vercel's documented default for static files without a Cache-Control rule. */
export const DEFAULT_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/**
 * A source as a RegExp: groups are regex, everything else literal. Shared with check:patterns
 * gate 9, so its behaviour is the gate's: it does not refuse unsupported syntax (see
 * assertSupportedSource) and matches case-sensitively. Since the M8 fix pass a parenthesis inside
 * a character class no longer opens or closes a group (no committed source has one).
 * @param {string} source
 * @returns {RegExp}
 */
export function sourceToRegExp(source) {
    let out = '';
    for (let i = 0; i < source.length; i++) {
        if (source[i] !== '(') {
            out += source[i].replace(/[.*+?^${}|[\]\\]/g, '\\$&');
            continue;
        }
        const j = scanGroup(source, i).end;
        out += source.slice(i, j + 1);
        i = j;
    }
    return new RegExp(`^${out}$`);
}

/**
 * Scans the group that opens at `source[start]`: skips escapes and character classes (a `(` or
 * `)` inside `[...]` is not a group, M8 fix), and reports the index of the closing `)` (or
 * `source.length` when unclosed) and whether a capturing group sits inside it.
 * @param {string} source
 * @param {number} start
 */
function scanGroup(source, start) {
    let depth = 0;
    let nestedCapture = false;
    let j = start;
    for (; j < source.length; j++) {
        const c = source[j];
        if (c === '\\') j++;
        else if (c === '[') {
            for (j++; j < source.length && source[j] !== ']'; j++) {
                if (source[j] === '\\') j++;
            }
        } else if (c === '(') {
            if (depth > 0 && source[j + 1] !== '?') nestedCapture = true;
            depth++;
        } else if (c === ')' && --depth === 0) break;
    }
    return { end: j, nestedCapture };
}

/**
 * Throws on source syntax this reader does not support (it would otherwise be read literally).
 * @param {string} source
 * @param {string} where  e.g. `rewrites[0].source`, for the error text
 */
export function assertSupportedSource(source, where) {
    const fail = (why) => {
        throw new Error(
            `vercel.json ${where} "${source}": ${why} (not supported by the local preview)`,
        );
    };
    if (!source.startsWith('/')) fail('a source must start with "/"');
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === '(') {
            // path-to-regexp refuses a capturing group inside a group; (?: (?! (?= (?<! are fine.
            const { end, nestedCapture } = scanGroup(source, i);
            if (end >= source.length) fail('an unclosed group');
            if (nestedCapture) fail('a capturing group inside a group');
            i = end;
            continue;
        }
        if (c === ':') fail('a named parameter');
        if ('*+?'.includes(c)) fail(`the modifier "${c}" outside a group`);
        if ('{}'.includes(c)) fail('a "{ }" group');
        if (c === '\\') fail('an escape outside a group');
        if (c === ')') fail('an unopened group');
    }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Compiles a parsed vercel.json. Throws on anything outside the supported subset.
 * @param {unknown} config
 */
export function compileRules(config) {
    if (!isObject(config)) throw new Error('vercel.json is not a JSON object');
    for (const key of ['routes', 'redirects', 'cleanUrls', 'trailingSlash']) {
        if (config[key] !== undefined) {
            throw new Error(`vercel.json "${key}" is not supported by the local preview`);
        }
    }
    const conditionCheck = (rule, where) => {
        for (const key of ['has', 'missing']) {
            if (rule[key] !== undefined) {
                throw new Error(
                    `vercel.json ${where} has a "${key}" condition (not supported by the local preview)`,
                );
            }
        }
    };

    const rawRewrites = config.rewrites ?? [];
    if (!Array.isArray(rawRewrites)) throw new Error('vercel.json "rewrites" is not an array');
    const rewrites = rawRewrites.map((r, i) => {
        const where = `rewrites[${i}]`;
        if (!isObject(r) || typeof r.source !== 'string' || typeof r.destination !== 'string') {
            throw new Error(`vercel.json ${where} is malformed`);
        }
        conditionCheck(r, where);
        assertSupportedSource(r.source, `${where}.source`);
        if (!r.destination.startsWith('/') || /[$:]/.test(r.destination)) {
            throw new Error(
                `vercel.json ${where}.destination "${r.destination}": only a fixed local path is supported by the local preview`,
            );
        }
        return { re: sourceToRegExp(r.source), source: r.source, destination: r.destination };
    });

    const rawHeaders = config.headers ?? [];
    if (!Array.isArray(rawHeaders)) throw new Error('vercel.json "headers" is not an array');
    const headerRules = rawHeaders.map((rule, i) => {
        const where = `headers[${i}]`;
        const ok =
            isObject(rule) &&
            typeof rule.source === 'string' &&
            Array.isArray(rule.headers) &&
            rule.headers.every(
                (h) => isObject(h) && typeof h.key === 'string' && typeof h.value === 'string',
            );
        if (!ok) throw new Error(`vercel.json ${where} is malformed`);
        conditionCheck(rule, where);
        assertSupportedSource(rule.source, `${where}.source`);
        return { re: sourceToRegExp(rule.source), headers: rule.headers };
    });

    /**
     * What to serve for a (decoded) request path: the file itself, a rewrite destination, or 404.
     * `fileExists(path)` answers for a site path such as `/index.html`.
     * @param {string} pathname
     * @param {(path: string) => boolean} fileExists
     */
    function resolve(pathname, fileExists) {
        const candidates = pathname.endsWith('/')
            ? [`${pathname}index.html`]
            : [pathname, `${pathname}/index.html`];
        for (const file of candidates) {
            if (fileExists(file)) return { kind: 'file', file };
        }
        for (const r of rewrites) {
            if (r.re.test(pathname)) {
                return fileExists(r.destination)
                    ? { kind: 'rewrite', file: r.destination, source: r.source }
                    : { kind: 'notFound' };
            }
        }
        return { kind: 'notFound' };
    }

    /**
     * Headers for a request path: every matching rule in order, a later rule wins per key (the
     * last writer's spelling of the key is kept). `staticFile: false` (a 404) skips the default
     * Cache-Control.
     * @param {string} pathname
     * @param {{ staticFile?: boolean }} [options]
     * @returns {Record<string, string>}
     */
    function headersFor(pathname, { staticFile = true } = {}) {
        /** @type {Map<string, [string, string]>} */
        const merged = new Map();
        for (const rule of headerRules) {
            if (!rule.re.test(pathname)) continue;
            for (const { key, value } of rule.headers) merged.set(key.toLowerCase(), [key, value]);
        }
        if (staticFile && !merged.has('cache-control')) {
            merged.set('cache-control', ['Cache-Control', DEFAULT_CACHE_CONTROL]);
        }
        return Object.fromEntries(merged.values());
    }

    return { resolve, headersFor };
}
