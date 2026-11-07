import { SenderError } from 'spacetimedb/server';

// ─── Shared validation for the series / lobby-setting fields ───────────────────────────────────────────
// One guard and one error string for the bestOf cap (backlog #8; A28, A38(2)), used by create_lobby,
// update_lobby_settings, create/update_lobby_preset and create/update_tournament. Series math is unchanged:
// winsNeeded = ceil(bestOf / 2).

export const BEST_OF_ERROR = 'bestOf must be 1 or 3.';

/** A28 / A38(2): bestOf ∈ {1, 3} everywhere. Callers that keep the D-11 `0 → 1` sentinel map 0 first. */
export function ensureBestOf(bestOf: number): number {
    if (bestOf !== 1 && bestOf !== 3) throw new SenderError(BEST_OF_ERROR);
    return bestOf;
}

/**
 * A27 / backlog #7: the side that starts a Bo3 one game up. Forced to None when bestOf = 1 (a head start would
 * decide a single game before play). An absent argument means None.
 */
export function resolveAdvantage(bestOf: number, advantage: { tag: string } | undefined): { tag: 'None' | 'Blue' | 'Red' } {
    if (bestOf === 1 || !advantage) return { tag: 'None' };
    if (advantage.tag === 'Blue' || advantage.tag === 'Red' || advantage.tag === 'None') return { tag: advantage.tag };
    throw new SenderError('bestOfNAdvantage must be None, Blue or Red.');
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
