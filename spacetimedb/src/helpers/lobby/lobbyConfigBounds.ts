import { SenderError } from 'spacetimedb/server';

// ─── Lobby configuration bounds (S10e, lobby audit #10) ─────────────────────────────────────────────────────────
// One range check for the numeric settings a lobby and a lobby preset carry, called by create_lobby,
// update_lobby_settings (the values it will store) and create_lobby_preset / update_lobby_preset. Tournament lobbies
// copy these values from a preset (validated here on write) or from the tournament (create_tournament checks teamSize).
//
//   teamSize               1, 2 or 3 (the contract's values; create_tournament uses the same rule and text)
//   standardTurnSeconds    10 - 600   (a 0 s turn expires the moment it starts)
//   reserveBankSeconds     0 - 1800
//   confirmWindowSeconds   0 - 300, default 60 (S10t, A131; 0 = no confirm window: the last pick or sale moves the
//                          lobby to Equipping in the same call); resolveConfirmWindowSeconds, an optional argument
//   characterBudget, lightconeBudget, minimumBidRaise   finite, 0 - 100000 (f32 arguments: NaN / ±Infinity rejected);
//                          in an Auction lobby characterBudget and minimumBidRaise above 0 (S14.4s, ensureAuctionAmounts)
//   rosterDiffAdvantage, underThresholdAdvantage, aboveThresholdPenalty, deathPenalty
//                          -1000000 - 1000000 hundredths (A21 fixed point, i32 columns; S10e review N1: negative
//                          values stay accepted, as before S10e, only the magnitude is bounded)
//   rosterThreshold        0 - 1000000 hundredths (a roster cost, u32 column: no sign; 0 disables the threshold pair)

export const TURN_SECONDS_MIN = 10;
export const TURN_SECONDS_MAX = 600;
export const RESERVE_SECONDS_MAX = 1800;
export const CONFIRM_WINDOW_SECONDS_DEFAULT = 60;
export const CONFIRM_WINDOW_SECONDS_MAX = 300;
export const BUDGET_MAX = 100_000;
export const HANDICAP_MAX_HUNDREDTHS = 1_000_000;

export interface LobbyConfigNumbers {
    teamSize: number;
    standardTurnSeconds: number;
    reserveBankSeconds: number;
    characterBudget: number;
    lightconeBudget: number;
    minimumBidRaise: number;
    rosterDiffAdvantage: number;
    rosterThreshold: number;
    underThresholdAdvantage: number;
    aboveThresholdPenalty: number;
    deathPenalty: number;
}

function ensureIntRange(name: string, value: number, min: number, max: number, unit = ''): void {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new SenderError(`${name} must be between ${min} and ${max}${unit}.`);
    }
}

function ensureAmount(name: string, value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > BUDGET_MAX) {
        throw new SenderError(`${name} must be a number between 0 and ${BUDGET_MAX}.`);
    }
}

/** Throws a SenderError naming the first setting out of range. */
export function ensureLobbyConfigInRange(c: LobbyConfigNumbers): void {
    if (c.teamSize !== 1 && c.teamSize !== 2 && c.teamSize !== 3) {
        throw new SenderError('teamSize must be 1, 2, or 3.');
    }
    ensureIntRange('standardTurnSeconds', c.standardTurnSeconds, TURN_SECONDS_MIN, TURN_SECONDS_MAX);
    ensureIntRange('reserveBankSeconds', c.reserveBankSeconds, 0, RESERVE_SECONDS_MAX);
    ensureAmount('characterBudget', c.characterBudget);
    ensureAmount('lightconeBudget', c.lightconeBudget);
    ensureAmount('minimumBidRaise', c.minimumBidRaise);
    for (const name of ['rosterDiffAdvantage', 'underThresholdAdvantage', 'aboveThresholdPenalty', 'deathPenalty'] as const) {
        ensureIntRange(name, c[name], -HANDICAP_MAX_HUNDREDTHS, HANDICAP_MAX_HUNDREDTHS, ' (hundredths)');
    }
    ensureIntRange('rosterThreshold', c.rosterThreshold, 0, HANDICAP_MAX_HUNDREDTHS, ' (hundredths)');
}

/** S14.4s (user ruling 2026-11-18): the two Auction refusals of ensureAuctionAmounts. */
export const AUCTION_CHARACTER_BUDGET_TEXT = 'characterBudget must be above 0 in an Auction lobby.';
export const AUCTION_MINIMUM_RAISE_TEXT = 'minimumBidRaise must be above 0 in an Auction lobby.';

/**
 * S14.4s (user ruling 2026-11-18): an Auction lobby needs a character budget and a minimum bid raise above 0 (a budget
 * of 0 buys nothing with a price; a raise of 0 lets a bid repeat the current one). Classic does not use them, so a
 * Classic lobby is not checked. Called wherever a lobby's settings are set: create_lobby, update_lobby_settings (the
 * draft mode it will store) and create_tournament_lobby (the preset's values). S14.4t (user ruling 2026-11-18): also
 * wherever a preset is saved or attached: create_lobby_preset, update_lobby_preset (the values they store) and
 * ensureTournamentPreset (create_tournament / update_tournament naming a preset). Rows stored before S14.4t are not
 * rewritten; create_tournament_lobby keeps its check as the safety net.
 */
export function ensureAuctionAmounts(draftModeTag: string, c: { characterBudget: number; minimumBidRaise: number }): void {
    if (draftModeTag !== 'Auction') return;
    if (!(c.characterBudget > 0)) throw new SenderError(AUCTION_CHARACTER_BUDGET_TEXT);
    if (!(c.minimumBidRaise > 0)) throw new SenderError(AUCTION_MINIMUM_RAISE_TEXT);
}

/**
 * S10t (A131): the confirm window of an optional argument: omitted = `fallback` (the default 60 on create, the stored
 * value on update); an integer 0-300 ("confirmWindowSeconds must be between 0 and 300.").
 */
export function resolveConfirmWindowSeconds(value: number | undefined, fallback: number): number {
    const resolved = value ?? fallback;
    ensureIntRange('confirmWindowSeconds', resolved, 0, CONFIRM_WINDOW_SECONDS_MAX);
    return resolved;
}

/** S10e (lobby audit #5): team aliases are capped (the lobby name is 0-50, D-A8); they ride on every Lobby row update. */
export const TEAM_ALIAS_MAX_LENGTH = 30;

export function ensureTeamAliases(blue: string, red: string): void {
    if (blue.length > TEAM_ALIAS_MAX_LENGTH || red.length > TEAM_ALIAS_MAX_LENGTH) {
        throw new SenderError(`Team aliases must be at most ${TEAM_ALIAS_MAX_LENGTH} characters.`);
    }
}
