/*
 * The sign-in panel's wording and frame (M5b), apart from the panel itself so the frame shown
 * while the panel's chunk loads (`SignInFrame`, S14.1) needs no SDK code.
 */

/** Wording: the orchestrator's proposal (M5b), kept exactly for the user's ruling. */
export const SIGN_IN_TEXT = {
    eyebrow: 'Access // Sign in',
    chip: 'SYS://AUTH',
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

export const SIGN_IN_TITLE = 'Sign in — IPC Battlegrounds';

/** The splash frame's fixed parts (art and HUD lines). */
export const SIGN_IN_FRAME = {
    image: { src: '/standby.webp', width: 1920, height: 1080 },
    hudLabel: SIGN_IN_TEXT.chip,
    hudCoord: 'Sector 00 · Access',
    eyebrow: SIGN_IN_TEXT.eyebrow,
} as const;
