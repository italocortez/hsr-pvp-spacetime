import { resolveBrowserEnv } from '@shared/stdb-targets';
import { describe, expect, it, vi } from 'vitest';
import { signOut } from './signOut';

/* T-M5b: signOut forgets the stored token and reloads (a new anonymous identity). */

describe('signOut', () => {
    it('deletes the stored token of the target database, then reloads', () => {
        const key = resolveBrowserEnv(import.meta.env).tokenStorageKey;
        localStorage.setItem(key, 'stored-token');
        localStorage.setItem('other', 'kept');
        const reload = vi.fn(() => {
            expect(localStorage.getItem(key)).toBeNull();
        });
        signOut({ reload });
        expect(reload).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('other')).toBe('kept');
        localStorage.clear();
    });

    it('blocked storage still reloads', () => {
        const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        const reload = vi.fn();
        signOut({ tokenStorageKey: 'k', reload });
        expect(reload).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});
