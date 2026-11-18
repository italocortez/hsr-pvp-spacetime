/*
 * The create-lobby dialog's wording (S14.4c): the mockup's (design/mockups/index.html Create Lobby) where it has words,
 * the builder's elsewhere, tabled in docs/frontend/pages.md "Create lobby (S14.4c)" for the user's ruling. The module's
 * refusal sentences are shown as the module sends them.
 */

export const CREATE_LOBBY_TEXT = {
    title: 'Create Lobby',
    close: 'Close',
    advanced: 'Advanced Settings',
    create: 'Create',
    creating: 'Creating…',
    notConnected: 'Not connected to the server. Try again in a moment.',
    refused: 'The server did not create the lobby. Try again.',
    // The A68(4) question (S1): asked before a Create that would give up a match the person left, or after the
    // module's prompt. Only its confirm button sends `abandonCurrentMatch`.
    abandonTitle: 'Give up your match?',
    abandonText: (lobby: string) =>
        `You left lobby ${lobby} mid-match. Creating this lobby gives that match up: you cannot return to it.`,
    keepMatch: 'Keep my match',
    abandonConfirm: 'Give it up and create',
    // Another lobby holds the person (taken in another tab or on another device while the dialog was open).
    heldElsewhere: (lobby: string) =>
        `You are already in lobby ${lobby}. Leave it before creating another.`,
    goToLobby: 'Go to your lobby',
    // "Play Now"'s line when the dialog closed without knowing the outcome (the draft is kept).
    unknown:
        'The connection dropped before the server answered, and no new lobby has arrived. Press Play Now to check: it opens the lobby if it was created.',
    internal:
        'The server hit an error and did not create the lobby. Press Play Now to try again; your settings are kept.',
    notShown:
        'The lobby was created, but it has not arrived here yet. Press Play Now in a moment to open it.',
    discardTitle: 'Discard this lobby?',
    discardText: 'The settings you chose will be lost.',
    keepEditing: 'Keep editing',
    discard: 'Discard',
    // "Play Now" on the landing page, before the dialog opens (the line for a chunk that does not load is in
    // createLobbyLoader.ts).
    preparingGuest: 'Creating your guest account…',
    connecting: 'Connecting…',
} as const;
