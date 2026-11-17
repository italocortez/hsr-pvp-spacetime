import type { Loadout } from '@shared/loadouts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BROWSER_KEY, readBrowser, writeBrowser } from './loadoutStorage';

/*
 * The browser list (S14.3c; everyone, up to 5): `loadoutStorage.ts`. Every change reads the stored list fresh,
 * changes it and writes it at once, so two tabs do not drop each other's loadouts; a `storage` event from another
 * tab re-reads it. With storage off the list lives in memory for this visit.
 */

export function useBrowserLoadouts(storageOk: boolean) {
    const [list, setList] = useState<Loadout[]>(readBrowser);
    const latest = useRef(list);
    useLayoutEffect(() => {
        latest.current = list;
    });

    /** The list as it is now (for callbacks). */
    const read = useCallback(() => latest.current, []);

    const mutate = useCallback(
        (change: (list: Loadout[]) => Loadout[]) => {
            const base = storageOk ? readBrowser() : latest.current;
            const next = change(base);
            writeBrowser(next);
            latest.current = next;
            setList(next);
            return next;
        },
        [storageOk],
    );

    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === BROWSER_KEY || e.key === null) setList(readBrowser());
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    return { list, read, mutate };
}

export type BrowserApi = ReturnType<typeof useBrowserLoadouts>;
