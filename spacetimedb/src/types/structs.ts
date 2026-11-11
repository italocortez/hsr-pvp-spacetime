import { t } from 'spacetimedb/server';
import {
    DraftMode,
    BanMode,
    ActionType,
    TeamSide,
    LineupFormat,
} from './enums';

// -------------------- STRUCTS --------------------

export const LobbyConfigSnapshot = t.object('LobbyConfigSnapshot', {
    teamSize: t.u8(),               // 1, 2, or 3
    draftMode: DraftMode,
    banMode: BanMode,
    lineupFormat: LineupFormat,     // A21: halves or thirds, needed to replay the group arrangement
    standardTurnSeconds: t.u32(),
    reserveBankSeconds: t.u32(),
    confirmWindowSeconds: t.u32(),  // S10t (A131): the lobby's confirm window, archived with the timer settings
    characterBudget: t.f32(),
    lightconeBudget: t.f32(),

    // Balance Math (A21: fixed-point hundredths of the game mode's unit, never floats;
    // rosterThreshold is a roster cost in hundredths, 0 disables)
    rosterDiffAdvantage: t.i32(),
    rosterThreshold: t.u32(),
    underThresholdAdvantage: t.i32(),
    aboveThresholdPenalty: t.i32(),
    deathPenalty: t.i32(),
});

// S10aa (A149): both teams' reserves at the start of a turn that consumed reserve, keyed by the sequence of the step
// that ended that turn; undo_last_step restores the reserves from it (helpers/draft/turnClock.ts).
export const ReserveMark = t.object('ReserveMark', {
    sequence: t.u32(),
    teamBlueReserveMs: t.u32(),
    teamRedReserveMs: t.u32(),
});

// S10aa (A148): the clock model is in helpers/draft/turnClock.ts. teamBlue/RedReserveMs = each team's reserve at the
// start of the current turn; accumulatedPauseMs = the turn time left at turnStartAt (0 = a full turn); reserveUsedMs,
// inReserve and reserveMarks are new in S10aa (S11 clear publish).
export const TimerState = t.object('TimerState', {
    turnStartAt: t.timestamp(),
    teamBlueReserveMs: t.u32(),
    teamRedReserveMs: t.u32(),
    isPaused: t.bool(),
    accumulatedPauseMs: t.u32(),
    reserveUsedMs: t.u32(),
    inReserve: t.bool(),
    reserveMarks: t.array(ReserveMark),
});

export const DraftStep = t.object('DraftStep', {
    actionRequired: ActionType,
    teamTurn: TeamSide,
});

export const EidolonCost = t.object('EidolonCost', {
    e0: t.f32(),
    e1: t.f32(),
    e2: t.f32(),
    e3: t.f32(),
    e4: t.f32(),
    e5: t.f32(),
    e6: t.f32(),
});

export const SuperimpositionCost = t.object('SuperimpositionCost', {
    s1: t.f32(),
    s2: t.f32(),
    s3: t.f32(),
    s4: t.f32(),
    s5: t.f32(),
});

// -------------------- ACTION PAYLOADS --------------------
// Instead of a raw JSON string, we define a Sum Type (Tagged Union).
// This replaces the "JSON" column with a type-safe structure.

export const PickPayload = t.object('PickPayload', {
    characterName: t.string(),
    eidolon: t.u8(),
    costPaid: t.f32(),
});

export const BanPayload = t.object('BanPayload', {
    characterName: t.string(),
});

export const BidPayload = t.object('BidPayload', {
    amount: t.f32(),
    targetCharacter: t.string(),
    // S10u (A134): the S10t field previousAmount is removed (no undo restores an earlier holder; S11 clear-publish list).
});

export const AuctionSoldPayload = t.object('AuctionSoldPayload', {
    characterName: t.string(),
    winningAmount: t.f32(),
    winningTeam: TeamSide,    // Who actually got it
    eidolon: t.u8(),          // A61(3): the winning team's default eidolon (lowest owned, A64; E0 without ownership)
    eidolonCost: t.f32(),     // A61(5): the extra charged at the sale, max(0, cost[eidolon] - cost[e0])
    // S10t (A127, A132): what the sale took from the winning team's character budget (winningAmount + the part of
    // eidolonCost it covered) and from its light-cone budget (the rest of eidolonCost), as the exact difference of the
    // stored f32 budgets (f64 holds it without rounding). undo_last_step gives these back.
    charCharged: t.f64(),
    lcCharged: t.f64(),
});

// A61(1): nominations are at E0; the eidolon is resolved for the winning team at the sale.
export const NominatePayload = t.object('NominatePayload', {
    characterName: t.string(),
});

export const UndoPayload = t.object('UndoPayload', {
    originalSequenceId: t.u32(), // The ID of the step we are reverting
});

export const PausePayload = t.object('PausePayload', {
    timeRemainingMs: t.u32(),        // Snapshot of the clock when paused
    isAutoPause: t.bool(),           // True if system paused (disconnect), False if manual
});

export const EquipLightconePayload = t.object('EquipLightconePayload', {
    characterName: t.string(),     // Which character slot to equip on
    lightconeName: t.string(),     // Which LC to equip
    superimposition: t.u8(),       // S level
    costPaid: t.f32(),             // LC cost deducted from LC budget
});

// S7b hand-off (landed in S8d): unequip_lightcone removes the latest light cone still equipped on characterName; refunded = that
// equip's costPaid, returned to the side's light-cone budget (current game).
export const UnequipLightconePayload = t.object('UnequipLightconePayload', {
    characterName: t.string(),
    lightconeName: t.string(),
    refunded: t.f32(),
});

export const ArrangeLineupPayload = t.object('ArrangeLineupPayload', {
    positions: t.string(),         // JSON string of position array (order of characters)
});

// A60(1): an eidolon edit of a drafted character (S7b; ConfirmLineupPayload was removed, A60(8)).
// costPaid = the character's roster cost contribution after the edit, in the draft mode's terms: Classic = the
// cost-set price at the new level; Auction = the eidolon extra at the new level, max(0, cost[e] - cost[e0]) (A61(6)),
// which the roster cost adds to AuctionSold.winningAmount.
export const SetEidolonPayload = t.object('SetEidolonPayload', {
    characterName: t.string(),
    eidolon: t.u8(),
    previousEidolon: t.u8(),
    costPaid: t.f32(),
    // S10t (A132): what this edit took from the team's character and light-cone budgets (Auction; negative = a refund,
    // which a lowering edit gives to the light-cone budget; 0 in Classic), as the exact difference of the stored f32
    // budgets. undo_last_step gives them back when it removes the character's pick or sale with its edits.
    charCharged: t.f64(),
    lcCharged: t.f64(),
});

// A60(3)/(4): a game confirmation or close. confirmedSide = the side whose flag this step set (on a close: the closer's
// team side, or Spectator for a close by a spectator referee or other staff, A63); closed = this step closed the game; the override
// fields carry a staff close's tie decision.
export const ConfirmGamePayload = t.object('ConfirmGamePayload', {
    confirmedSide: TeamSide,
    closed: t.bool(),
    winnerOverride: TeamSide.optional(),
    winnerOverrideReason: t.string().optional(),
});

// The "Polymorphic" Enum containing the specific payloads
export const StepPayload = t.enum('StepPayload', {
    Pick: PickPayload,
    Ban: BanPayload,
    Bid: BidPayload,
    AuctionSold: AuctionSoldPayload,
    Nominate: NominatePayload,
    Undo: UndoPayload,
    Pause: PausePayload,
    EquipLightcone: EquipLightconePayload,
    ArrangeLineup: ArrangeLineupPayload,
    SetEidolon: SetEidolonPayload,     // A60 (S7b)
    ConfirmGame: ConfirmGamePayload,   // A60 (S7b)
    UnequipLightcone: UnequipLightconePayload, // S7b hand-off (unequip_lightcone)
});

// -------------------- NEW STRUCTS --------------------
// GameScore (cycles / points / boss1 / boss2) was dropped in S3: no column used it, and A21 replaced
// the fixed boss columns with MatchResultGroupScore rows.

// RecurrenceRule removed in S10ac (A157(3)): every availability slot is one dated interval.

export const EloConfig = t.object('EloConfig', {
    kFactorNew: t.u8(),
    kFactorMid: t.u8(),
    kFactorVet: t.u8(),
    newThreshold: t.u32(),
    midThreshold: t.u32(),
    initialRating: t.u32(),
    sizeBonus: t.u32(),
    spreadDivisor: t.u8(),
    maxAccountBonus: t.u32(),
});
