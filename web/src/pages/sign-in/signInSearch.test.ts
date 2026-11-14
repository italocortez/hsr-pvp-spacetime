import { describe, expect, it } from 'vitest';
import { parseIndexSearch } from './signInSearch';

/* T-M5b: `/` reads only `login`, `next` and `status` from the URL. */

describe('parseIndexSearch', () => {
    it.each(['confirm', 'refused', 'cancelled', 'failed'])('keeps status=%s', (status) => {
        expect(parseIndexSearch({ login: '1', status })).toEqual({
            login: 1,
            next: undefined,
            status,
        });
    });

    it.each([['other'], [''], [['confirm', 'confirm']], [1]])('drops status %j', (status) => {
        expect(parseIndexSearch({ login: '1', status }).status).toBeUndefined();
    });

    it('ignores every other key (no code or token is read from the URL)', () => {
        const out = parseIndexSearch({
            login: '1',
            next: '/profile',
            code: 'x',
            token: 'y',
            state: 'z',
        });
        expect(Object.keys(out).sort()).toEqual(['login', 'next', 'status']);
    });

    it('is idempotent (the router re-validates its own output)', () => {
        const once = parseIndexSearch({ login: '1', next: '/profile', status: 'confirm' });
        expect(parseIndexSearch(once)).toEqual(once);
    });
});
