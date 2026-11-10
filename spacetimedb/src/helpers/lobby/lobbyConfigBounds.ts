import { SenderError } from 'spacetimedb/server';

// ─── Lobby configuration bounds (S10e, lobby audit #10) ─────────────────────────────────────────────────────────
// One range check for the numeric settings a lobby and a lobby preset carry, called by create_lobby,
// update_lobby_settings (the values it will store) and create_lobby_preset / update_lobby_preset. Tournament lobbies
// copy these values from a preset (validated here on write) or from the tournament (create_tournament checks teamSize).
//
//   teamSize               1, 2 or 3 (the contract's values; create_tournament uses the same rule and text)
//   standardTurnSeconds    10 - 600   (a 0 s turn expires the moment it starts)
//   reserveBankSeconds     0 - 1800
//   characterBudget, lightconeBudget, minimumBidRaise   finite, 0 - 100000 (f32 arguments: NaN / ±Infinity rejected)
//   rosterDiffAdvantage, underThresholdAdvantage, aboveThresholdPenalty, deathPenalty
//                          -1000000 - 1000000 hundredths (A21 fixed point, i32 columns; S10e review N1: negative
//                          values stay accepted, as before S10e, only the magnitude is bounded)
//   rosterThreshold        0 - 1000000 hundredths (a roster cost, u32 column: no sign; 0 disables the threshold pair)

export const TURN_SECONDS_MIN = 10;
export const TURN_SECONDS_MAX = 600;
export const RESERVE_SECONDS_MAX = 1800;
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

/** S10e (lobby audit #5): team aliases are capped (the lobby name is 0-50, D-A8); they ride on every Lobby row update. */
export const TEAM_ALIAS_MAX_LENGTH = 30;

export function ensureTeamAliases(blue: string, red: string): void {
    if (blue.length > TEAM_ALIAS_MAX_LENGTH || red.length > TEAM_ALIAS_MAX_LENGTH) {
        throw new SenderError(`Team aliases must be at most ${TEAM_ALIAS_MAX_LENGTH} characters.`);
    }
}
