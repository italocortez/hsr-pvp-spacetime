import { SenderError } from 'spacetimedb/server';

// ─── Shared validation for the tournament series and lobby-name fields ─────────────────────────────────
// One guard and one error string for the bestOf cap (backlog #8; A28), used by create/update_tournament (A67(2): the
// lobby and preset series settings are gone; the bracket match is the only series). Series math is unchanged:
// winsNeeded = ceil(bestOf / 2).

export const BEST_OF_ERROR = 'bestOf must be 1 or 3.';

/** A28: Tournament.defaultBestOf / grandFinalBestOf ∈ {1, 3}. */
export function ensureBestOf(bestOf: number): number {
    if (bestOf !== 1 && bestOf !== 3) throw new SenderError(BEST_OF_ERROR);
    return bestOf;
}


/** D-A8: lobby name, trimmed, at most 50 characters; empty is allowed (S9's view_lobby_browser labels it). */
export const LOBBY_NAME_MAX = 50;
export function normalizeLobbyName(name: string | undefined): string {
    const trimmed = (name ?? '').trim();
    if (trimmed.length > LOBBY_NAME_MAX) {
        throw new SenderError(`Lobby name must be at most ${LOBBY_NAME_MAX} characters.`);
    }
    return trimmed;
}

/** Ceil(bestOf / 2): the games a side must win to take the series. */
export const winsNeededFor = (bestOf: number) => Math.ceil(bestOf / 2);

/** A27 / review CH-T9: a head start must not decide the grand final before play. */
export function ensureWinnerAdvantage(winnerAdvantage: number, grandFinalBestOf: number): void {
    if (winnerAdvantage >= winsNeededFor(grandFinalBestOf)) {
        throw new SenderError(
            `winnerAdvantage must be less than ceil(grandFinalBestOf / 2) = ${winsNeededFor(grandFinalBestOf)}; ` +
            'a head start may not decide the grand final before play.',
        );
    }
}
