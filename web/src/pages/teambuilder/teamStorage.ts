import {
    DEFAULT_BUDGETS,
    decodeTeam,
    EMPTY_SLOTS,
    encodeTeam,
    type Team,
} from '@shared/teambuilder';

/*
 * The working team in browser storage (S14.3a): one draft, so a reload keeps the team. Stored as the packed team
 * text (`shared/teambuilder/teamCode.ts`), the same format as the share link and the account loadouts (S14.3s),
 * under a versioned key. Only the slots and the Auction budgets are read back as the draft: the draft mode, game
 * mode and cost set live in the address. Storage may be blocked or full (a private window, site data off): every
 * access is guarded and the page then works without it, for this visit only. A value that does not decode is
 * ignored and kept: nothing is written over it until the team is changed (a team link arriving counts as a change).
 *
 * The previous team (S14.3a fix, review S3): when a shared link replaces a different, non-empty working team, the
 * replaced team (with the modes it was saved under) is kept under a second key until the person restores it or
 * dismisses the notice that offers it.
 */

export const DRAFT_KEY = 'hsrpvp.teambuilder.draft.v1';
export const PREVIOUS_KEY = 'hsrpvp.teambuilder.previous.v1';

export type StoredDraft = Pick<Team, 'slots' | 'budgets'>;

export const EMPTY_DRAFT: StoredDraft = { slots: EMPTY_SLOTS, budgets: DEFAULT_BUDGETS };

function readTeam(key: string): Team | null {
    try {
        const text = localStorage.getItem(key);
        if (text === null) return null;
        const decoded = decodeTeam(text);
        return decoded.ok ? decoded.team : null;
    } catch {
        return null;
    }
}

function writeTeam(key: string, team: Team): void {
    try {
        const encoded = encodeTeam(team);
        if (encoded.ok) localStorage.setItem(key, encoded.code);
    } catch {
        // Blocked or full storage: the team lasts for this visit only.
    }
}

/** The stored draft with the modes it was written under, or null. */
export function readDraftTeam(): Team | null {
    return readTeam(DRAFT_KEY);
}

/**
 * The stored draft is there but this build cannot read it (a later text version after a rollback, say). The page
 * then starts empty and leaves the stored value alone until the person changes the team (review 2 M7).
 */
export function draftUnreadable(): boolean {
    try {
        const text = localStorage.getItem(DRAFT_KEY);
        return text !== null && !decodeTeam(text).ok;
    } catch {
        return false;
    }
}

export function readDraft(): StoredDraft {
    const team = readDraftTeam();
    return team ? { slots: team.slots, budgets: team.budgets } : EMPTY_DRAFT;
}

/** Writes the draft (with the settings it was made under); a failure is ignored. */
export function writeDraft(team: Team): void {
    writeTeam(DRAFT_KEY, team);
}

export function readPrevious(): Team | null {
    return readTeam(PREVIOUS_KEY);
}

export function writePrevious(team: Team): void {
    writeTeam(PREVIOUS_KEY, team);
}

export function clearPrevious(): void {
    try {
        localStorage.removeItem(PREVIOUS_KEY);
    } catch {
        // Blocked storage: nothing was kept.
    }
}
