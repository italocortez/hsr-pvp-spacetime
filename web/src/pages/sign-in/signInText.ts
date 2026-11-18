/*
 * The sign-in panel's wording and frame (M5b), apart from the panel itself so the frame shown
 * while the panel's chunk loads (`SignInFrame`, S14.1) needs no SDK code.
 */

/** Wording: the orchestrator's proposal (M5b), kept exactly for the user's ruling. */
export const SIGN_IN_TEXT = {
    eyebrow: 'Access // Sign in',
    lede: 'Sign in with Discord to get access to all our lobby, tournament and calendar features!',
    button: 'Sign in with Discord',
    notConfigured: 'Sign-in is not configured on this machine.',
    confirmButton: 'Link this account',
    cancel: 'Cancel',
    failedLede: 'Nothing was changed. You can try again.',
    tooLong: 'The sign-in took too long. Please try again.',
    changed: 'The sign-in changed in another tab. Please try again.',
    unknown: 'The connection dropped. The result is unknown: reload and check before trying again.',
    tryAgain: 'Try again',
} as const;

/**
 * The sign-in dialog's wording (S14.4b): the mockup's (`design/mockups/index.html` sign-in dialog) where the decided
 * wording has none, the panel's where it has. Table in docs/frontend/pages.md "Sign-in dialog (S14.4b)".
 */
export const SIGN_IN_DIALOG_TEXT = {
    title: 'Enter the Battlegrounds',
    lede: SIGN_IN_TEXT.lede,
    discord: SIGN_IN_TEXT.button,
    or: 'or',
    guest: 'Continue as Guest',
    fine: 'Guest accounts are kept in this browser only.',
    close: 'Close sign-in',
    playingAs: (name: string) => `You are playing as ${name}.`,
    createdTitle: 'Guest account created',
    createdMeta: 'You’re in. This guest account is kept in this browser only.',
    enter: 'Enter Battlegrounds',
    connecting: 'Connecting to the server…',
    openingDiscord: 'Opening Discord…',
    creatingGuest: 'Creating your guest account…',
    loadFailed: 'Sign-in could not be loaded. Check your connection and try again.',
} as const;

export const SIGN_IN_TITLE = 'Sign in — IPC Battlegrounds';

/** The splash frame's fixed parts (art and eyebrow). */
export const SIGN_IN_FRAME = {
    image: { src: '/standby.webp', width: 1920, height: 1080 },
    eyebrow: SIGN_IN_TEXT.eyebrow,
} as const;
