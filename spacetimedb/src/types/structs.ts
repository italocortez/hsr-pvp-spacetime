import { t } from 'spacetimedb/server';
import {
    DraftMode,
    BanMode,
    ActionType,
    TeamSide,
    RecurrenceType,
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

export const PlayerSnapshot = t.object('PlayerSnapshot', {
    userId: t.u32(),
    displayName: t.string(),
    avatarUrl: t.string(),
});

export const TimerState = t.object('TimerState', {
    turnStartAt: t.timestamp(),
    teamBlueReserveMs: t.u32(),
    teamRedReserveMs: t.u32(),
    isPaused: t.bool(),
    accumulatedPauseMs: t.u32(),
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
});

export const AuctionSoldPayload = t.object('AuctionSoldPayload', {
    characterName: t.string(),
    winningAmount: t.f32(),
    winningTeam: TeamSide,    // Who actually got it
    eidolon: t.u8(),          // A61(3): the winning team's default eidolon (highest owned, E0 without ownership)
    eidolonCost: t.f32(),     // A61(5): the extra charged at the sale, max(0, cost[eidolon] - cost[e0])
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
});

// A60(3)/(4): a game confirmation or close. confirmedSide = the side whose flag this step set (Spectator when both
// were set at once: a full-control referee or a staff close); closed = this step closed the game; the override
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
});

// -------------------- NEW STRUCTS --------------------
// GameScore (cycles / points / boss1 / boss2) was dropped in S3: no column used it, and A21 replaced
// the fixed boss columns with MatchResultGroupScore rows.

export const RecurrenceRule = t.object('RecurrenceRule', {
    recurrenceType: RecurrenceType,
    interval: t.u8(),
    dayOfWeek: t.u8().optional(),
    dayOfMonth: t.u8().optional(),
    endDate: t.timestamp().optional(),
});

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
