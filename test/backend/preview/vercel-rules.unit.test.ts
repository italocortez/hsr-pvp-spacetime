// T-M8: scripts/preview/vercel-rules.mjs, the vercel.json rules the local preview imitates (filesystem first, then
// rewrites; every matching header rule, later wins per key; Vercel's default Cache-Control for static files). Reads the
// committed vercel.json; pure functions only, no I/O beyond that read and no network.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    compileRules,
    DEFAULT_CACHE_CONTROL,
    sourceToRegExp,
} from '../../../scripts/preview/vercel-rules.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VERCEL = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const rules = compileRules(VERCEL);

/** The site's files, as a set of site paths. */
const DIST = new Set([
    '/index.html',
    '/assets/index-abc.js',
    '/status.json',
    '/robots.txt',
    '/favicon.svg',
    '/standby.webp',
]);
const exists = (p: string) => DIST.has(p);

describe('T-M8 resolve: the rewrite table of docs/frontend/hosting.md and gate 9', () => {
    it.each([
        ['/', { kind: 'file', file: '/index.html' }],
        ['/index.html', { kind: 'file', file: '/index.html' }],
        ['/assets/index-abc.js', { kind: 'file', file: '/assets/index-abc.js' }],
        ['/status.json', { kind: 'file', file: '/status.json' }],
        ['/standby.webp', { kind: 'file', file: '/standby.webp' }],
    ])('an existing file is served as itself: %s', (path, expected) => {
        expect(rules.resolve(path, exists)).toEqual(expected);
    });

    it.each(['/lobby/123', '/standby', '/costs', '/profile'])(
        'a client route loads the app: %s',
        (path) => {
            expect(rules.resolve(path, exists)).toEqual({
                kind: 'rewrite',
                file: '/index.html',
                source: VERCEL.rewrites[0].source,
            });
        },
    );

    it.each([
        '/assets/x.js',
        '/foo.png',
        '/elements/missing.webp',
        '/.env',
        '/.well-known/security.txt',
        '/.git/config',
        '/a/.b/c',
        '/api/x',
        '/sw.js',
        '/favicon.ico',
    ])('a missing file, a dot-path or /api/ is a 404, never the page: %s', (path) => {
        expect(rules.resolve(path, exists)).toEqual({ kind: 'notFound' });
    });

    it('a missing /status.json is a 404, not the page (the reader fails open on it)', () => {
        const noStatus = (p: string) => p !== '/status.json' && exists(p);
        expect(rules.resolve('/status.json', noStatus)).toEqual({ kind: 'notFound' });
    });

    it('a rewrite whose destination is missing is a 404', () => {
        expect(rules.resolve('/lobby/123', () => false)).toEqual({ kind: 'notFound' });
    });

    it('gate 9 and the preview read sources the same way (one shared function)', () => {
        const gate = readFileSync(join(ROOT, 'scripts', 'ci', 'check-patterns.mjs'), 'utf8');
        expect(gate).toContain("import { sourceToRegExp } from '../preview/vercel-rules.mjs';");
        expect(gate).not.toContain('const sourceToRegExp');
        const re = sourceToRegExp(VERCEL.rewrites[0].source);
        expect(['/', '/lobby/123'].every((p) => re.test(p))).toBe(true);
        expect(
            [
                '/assets/x.js',
                '/status.json',
                '/foo.png',
                '/.env',
                '/api/x',
                '/sw.js',
                '/favicon.svg',
                '/a/.b/c',
            ].some((p) => re.test(p)),
        ).toBe(false);
    });
});

describe('T-M8 headersFor: every matching rule, later wins per key, Vercel default cache', () => {
    const cache = (path: string, staticFile = true) =>
        rules.headersFor(path, { staticFile })['Cache-Control'];

    it('/status.json is no-store', () => {
        expect(cache('/status.json')).toBe('no-store');
    });

    it('a real asset is immutable for a year', () => {
        expect(cache('/assets/index-abc.js')).toBe('public, max-age=31536000, immutable');
    });

    it('/index.html and /sw.js revalidate', () => {
        expect(cache('/index.html')).toBe('public, max-age=0, must-revalidate');
        expect(cache('/sw.js')).toBe('public, max-age=0, must-revalidate');
    });

    it('a rewritten route and a plain file get the default cache value', () => {
        expect(DEFAULT_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate');
        expect(cache('/lobby/123')).toBe(DEFAULT_CACHE_CONTROL);
        expect(cache('/robots.txt')).toBe(DEFAULT_CACHE_CONTROL);
    });

    it('sources are anchored at the end: /status.jsonx and /sw.jsx get no status or sw rule', () => {
        expect(cache('/status.jsonx', false)).toBeUndefined();
        expect(cache('/sw.jsx', false)).toBeUndefined();
        expect(cache('/index.htmlx', false)).toBeUndefined();
        expect(cache('/x/status.json', false)).toBeUndefined();
    });

    it('rule matching is case-sensitive (unproven against Vercel)', () => {
        expect(cache('/STATUS.JSON', false)).toBeUndefined();
        expect(cache('/Assets/x.js', false)).toBeUndefined();
        expect(cache('/SW.JS', false)).toBeUndefined();
        expect(rules.resolve('/ASSETS/x', exists)).toMatchObject({ kind: 'rewrite' });
    });

    it('a 404 gets no default cache value, but the rules that match its path still apply', () => {
        expect(cache('/foo.png', false)).toBeUndefined();
        expect(cache('/assets/x.js', false)).toBe('public, max-age=31536000, immutable');
    });

    it('the security headers of the catch-all rule are on every path, merged after the cache rule', () => {
        const headers = rules.headersFor('/assets/index-abc.js');
        expect(Object.keys(headers)).toEqual([
            'Cache-Control',
            'Content-Security-Policy',
            'Strict-Transport-Security',
            'X-Content-Type-Options',
            'Referrer-Policy',
            'Permissions-Policy',
        ]);
        expect(headers['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-eval'");
    });

    it('a later rule wins on the same key, compared without case; the later spelling is kept', () => {
        const merged = compileRules({
            headers: [
                {
                    source: '/(.*)',
                    headers: [
                        { key: 'X-A', value: 'first' },
                        { key: 'X-B', value: 'b' },
                    ],
                },
                { source: '/x', headers: [{ key: 'x-a', value: 'second' }] },
                { source: '/y', headers: [{ key: 'x-a', value: 'not this path' }] },
            ],
        }).headersFor('/x');
        expect(merged).toEqual({
            'x-a': 'second',
            'X-B': 'b',
            'Cache-Control': DEFAULT_CACHE_CONTROL,
        });
    });

    it('a rule that sets cache-control in any case replaces the default', () => {
        const merged = compileRules({
            headers: [{ source: '/x', headers: [{ key: 'cache-control', value: 'no-cache' }] }],
        }).headersFor('/x');
        expect(merged).toEqual({ 'cache-control': 'no-cache' });
    });
});

describe('T-M8 compileRules: unsupported syntax throws at start instead of being guessed', () => {
    const rewrite = (extra: object) => ({
        rewrites: [{ source: '/x', destination: '/index.html', ...extra }],
    });

    it('accepts the committed vercel.json', () => {
        expect(() => compileRules(VERCEL)).not.toThrow();
    });

    it.each(['routes', 'redirects', 'cleanUrls', 'trailingSlash'])(
        'the top-level "%s" key',
        (key) => {
            expect(() =>
                compileRules({ ...VERCEL, [key]: key === 'cleanUrls' ? true : [] }),
            ).toThrow(new RegExp(`"${key}" is not supported`));
        },
    );

    it.each(['has', 'missing'])('a "%s" condition on a rewrite or a header rule', (key) => {
        expect(() => compileRules(rewrite({ [key]: [] }))).toThrow(
            new RegExp(`"${key}" condition`),
        );
        expect(() => compileRules({ headers: [{ source: '/x', headers: [], [key]: [] }] })).toThrow(
            new RegExp(`"${key}" condition`),
        );
    });

    it.each([
        ['/lobby/:id', /named parameter/],
        ['/:path*', /named parameter/],
        ['/blog{/x}', /"\{ \}" group/],
        ['/(.*)?', /modifier "\?"/],
        ['/a*', /modifier "\*"/],
        ['/((a))', /capturing group inside a group/],
        ['/(a', /unclosed group/],
        ['/a)', /unopened group/],
        ['x', /must start with/],
    ])('the source %s', (source, why) => {
        expect(() => compileRules({ rewrites: [{ source, destination: '/index.html' }] })).toThrow(
            why,
        );
        expect(() => compileRules({ headers: [{ source, headers: [] }] })).toThrow(why);
    });

    it('a parenthesis inside a character class is not a group (accepted, and read as one group)', () => {
        for (const source of ['/((?!a)[(].*)', '/(a[)]b)', '/([()]+)', '/(a[\\]()]b)']) {
            expect(() => compileRules(rewrite({ source })), source).not.toThrow();
        }
        expect(sourceToRegExp('/(a[)]b)').source).toBe('^\\/(a[)]b)$');
        expect(sourceToRegExp('/(a[)]b)').test('/a)b')).toBe(true);
        expect(sourceToRegExp('/((?!a)[(].*)').test('/(x')).toBe(true);
        // An escaped parenthesis inside a group is neither a group nor its end.
        for (const source of ['/(a\\)b)', '/(a\\(b)', '/(\\((?!x).*)']) {
            expect(() => compileRules(rewrite({ source })), source).not.toThrow();
        }
        expect(sourceToRegExp('/(a\\)b)').source).toBe('^\\/(a\\)b)$');
        expect(sourceToRegExp('/(a\\)b)').test('/a)b')).toBe(true);
        expect(sourceToRegExp('/(a\\(b)').test('/a(b')).toBe(true);
        // A real nested capturing group is still refused.
        expect(() => compileRules(rewrite({ source: '/([a](b))' }))).toThrow(
            /capturing group inside a group/,
        );
    });

    it('the lookaheads and non-capturing groups of the committed source are accepted', () => {
        expect(() =>
            compileRules(rewrite({ source: '/((?!a/)(?:b|c)(?=d)(?<!e).*)' })),
        ).not.toThrow();
    });

    it.each(['https://example.com/x', '/user/$1', '/:path', 'index.html'])(
        'a destination that is not a fixed local path: %s',
        (destination) => {
            expect(() => compileRules(rewrite({ destination }))).toThrow(/only a fixed local path/);
        },
    );

    it('malformed config', () => {
        expect(() => compileRules(null)).toThrow(/not a JSON object/);
        expect(() => compileRules({ rewrites: {} })).toThrow(/"rewrites" is not an array/);
        expect(() => compileRules({ headers: [{ source: '/x', headers: [{ key: 1 }] }] })).toThrow(
            /headers\[0\] is malformed/,
        );
    });
});
