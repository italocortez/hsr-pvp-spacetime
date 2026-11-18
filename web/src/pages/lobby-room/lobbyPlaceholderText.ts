/*
 * The lobby placeholder's wording (S14.4c): the builder's, tabled in docs/frontend/pages.md "Create lobby (S14.4c)".
 * There is no mockup for this page; the lobby room (S14.7, design/mockups/lobbyroom.html) replaces it.
 */

export const LOBBY_PLACEHOLDER_TEXT = {
    eyebrow: 'Lobby',
    // The eyebrow per stage: "Waiting room" only while the lobby waits for its match.
    eyebrowWaiting: 'Lobby // Waiting room',
    eyebrowLive: 'Lobby // Match in progress',
    eyebrowResult: 'Lobby // Awaiting result',
    title: (name: string) => `${name} — Lobby — IPC Battlegrounds`,
    titleGeneric: 'Lobby — IPC Battlegrounds',
    unnamed: (code: string) => `Lobby ${code}`,
    // No page of the site takes a join code yet (the lobbies page and the lobby room bring joining).
    lede: 'The lobby room is still being built, and joining by code comes with it: no page takes the code yet. Leave this lobby to create another one.',
    ledeLive:
        'The lobby room is still being built. This match is under way: if you leave, you are away from it until it ends, and creating another lobby asks you to give it up.',
    ledeResult:
        'The lobby room is still being built. This match is waiting for its result; you can create another lobby meanwhile.',
    loading: 'Connecting to the server…',
    missing: 'This lobby is not one of yours, or it no longer exists.',
    joinCode: 'Join code',
    copy: 'Copy',
    copyWhat: 'the join code',
    copiedShort: 'Copied!',
    copyFailedShort: 'Copy failed',
    copied: (code: string) => `Copied the join code ${code} to the clipboard`,
    copyFailed: (code: string) => `Could not copy the join code ${code}`,
    host: 'Host',
    hostUnknown: '…',
    you: (label: string) => `${label} (you)`,
    leave: 'Leave lobby',
    leaving: 'Leaving…',
    notConnected: 'Not connected to the server. Try again in a moment.',
    failed: 'The lobby could not be left. Try again.',
} as const;
