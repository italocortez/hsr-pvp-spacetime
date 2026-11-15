import { createContext, useContext } from 'react';

/**
 * True below the app shell's `main` (S14.1): the shell already gives the page its one `main`
 * landmark and the brand mark in the bar, so a full-bleed layout rendered there (the standby
 * block) adds neither. Splash pages render outside the shell, where this is false.
 */
export const InShellContext = createContext(false);

export function useInShell(): boolean {
    return useContext(InShellContext);
}
