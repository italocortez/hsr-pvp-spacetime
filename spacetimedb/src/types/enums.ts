import { t } from 'spacetimedb/server';

export const Role = t.enum('Role', {
    Admin: t.unit(),
    Moderator: t.unit(),
    TournamentHost: t.unit(),
    User: t.unit(),
});

export const Path = t.enum('Path', {
    Abundance: t.unit(),
    Destruction: t.unit(),
    Erudition: t.unit(),
    Harmony: t.unit(),
    Hunt: t.unit(),
    Nihility: t.unit(),
    Preservation: t.unit(),
    Remembrance: t.unit(),
    Elation: t.unit(),
});

export const Element = t.enum('Element', {
    Fire: t.unit(),
    Ice: t.unit(),
    Imaginary: t.unit(),
    Lightning: t.unit(),
    Physical: t.unit(),
    Quantum: t.unit(),
    Wind: t.unit(),
});

export const CharRole = t.enum('CharRole', {
    Dps: t.unit(),
    Sustain: t.unit(),
    Support: t.unit(),
});

export const GameMode = t.enum('GameMode', {
    MemoryOfChaos: t.unit(),
    ApocalypticShadow: t.unit(),
    AnomalyArbitration: t.unit(),
});

export const DraftMode = t.enum('DraftMode', {
    Classic: t.unit(),
    Auction: t.unit(),
});

export const BanMode = t.enum('BanMode', {
    None: t.unit(),
    Four: t.unit(),
    Six: t.unit(),
});

export const LobbyStage = t.enum('LobbyStage', {
    Waiting: t.unit(),
    Drafting: t.unit(),
    Equipping: t.unit(),
    Scoring: t.unit(),
    AwaitingResult: t.unit(), // Match submitted, players freed — lobby alive for finalization
    // A67(1): the series and terminal stages are removed; a lobby hosts exactly one game.
});

// LobbySlot — unified team + role for lobby members.
// Replaces the former TeamLabel + ParticipationRole two-column design.
// Spectators are always spectators; coaches and players must be Blue or Red.
export const LobbySlot = t.enum('LobbySlot', {
    BluePlayer: t.unit(),
    BlueCoach: t.unit(),
    RedPlayer: t.unit(),
    RedCoach: t.unit(),
    Spectator: t.unit(),
});

// TeamSide — pure team identifier for match tables, step actors, results.
// NOT used for lobby member slots (use LobbySlot for that).
export const TeamSide = t.enum('TeamSide', {
    Spectator: t.unit(),
    Blue: t.unit(),
    Red: t.unit(),
});

// A68(10) (S9a): the seat state the member views project. Gone = abandonedAt set (A68(4)); Away = leftAt set (A68(2));
// otherwise Online when the membership or any of the user's presence rows is live (A48), else Offline.
export const MemberPresence = t.enum('MemberPresence', {
    Online: t.unit(),
    Offline: t.unit(),
    Away: t.unit(),
    Gone: t.unit(),
});

// A31: no draws anywhere. The server computes a winner for every match (A21 chain ending in the
// referee's winnerOverride), so the former Draw variant is gone.
export const MatchEndReason = t.enum('MatchEndReason', {
    Completed: t.unit(), // Normal completion — winnerTeamSide names the winner
    Concede: t.unit(),
});

export const ConcedeTrigger = t.enum('ConcedeTrigger', {
    Disconnect: t.unit(),
    VoluntaryLeave: t.unit(), // a player's own concede_match; leave_lobby no longer writes it (A68(3): no auto-concede). Kept for history rows.
    RefereeDecision: t.unit(),
});

export const MatchType = t.enum('MatchType', {
    Casual: t.unit(),
    Ranked: t.unit(),
});

export const ActionType = t.enum('ActionType', {
    Pick: t.unit(),
    Ban: t.unit(),
    Nominate: t.unit(),
    Bid: t.unit(),
    AuctionSold: t.unit(),
    Pause: t.unit(),
    Undo: t.unit(),
    EquipLightcone: t.unit(),
    SetEidolon: t.unit(),    // A60 (S7b); ConfirmLineup removed (A60(8))
    ConfirmGame: t.unit(),   // A60 (S7b)
    UnequipLightcone: t.unit(), // S7b hand-off (landed in S8d): removes the latest light cone of a character, refunded
});

export const TournamentStage = t.enum('TournamentStage', {
    Draft: t.unit(),
    Registration: t.unit(),
    CheckIn: t.unit(),     // Optional check-in stage between Registration and Seeding (D-35)
    Seeding: t.unit(),
    InProgress: t.unit(),
    Completed: t.unit(),
    Cancelled: t.unit(),
});

export const RosterVisibility = t.enum('RosterVisibility', {
    OpenRoster: t.unit(),
    ClosedWithRating: t.unit(),
    ClosedNoRating: t.unit(),
});

export const TournamentFormat = t.enum('TournamentFormat', {
    SingleElimination: t.unit(),
    DoubleElimination: t.unit(),
    GroupOnly: t.unit(),
    GroupIntoSingleElim: t.unit(),
    GroupIntoDoubleElim: t.unit(),
});

export const MatchResultStatus = t.enum('MatchResultStatus', {
    Pending: t.unit(),
    Submitted: t.unit(),
    Disputed: t.unit(),
    Validated: t.unit(),
    Rejected: t.unit(),
    Voided: t.unit(),      // A24(3): a mid-tournament rollback keeps the record for audit and marks it Voided
});

export const DisconnectPolicy = t.enum('DisconnectPolicy', {
    Standard: t.unit(),
    Deferred: t.unit(),
    NoAction: t.unit(),
});

// S10ac (A157(1), A157(3)): an availability slot is Available or Blocked; recurrence (RecurrenceType) is removed.
export const SlotKind = t.enum('SlotKind', {
    Available: t.unit(),
    Blocked: t.unit(),
});


export const ParticipantStatus = t.enum('ParticipantStatus', {
    Registered: t.unit(),
    CheckedIn: t.unit(),
    Active: t.unit(),
    Eliminated: t.unit(),
    Disqualified: t.unit(),
    Withdrawn: t.unit(),
});

// ParticipantType removed — redundant with teamGroupId (Phase 3 UAT decision)

export const AchievementRarity = t.enum('AchievementRarity', {
    Rare: t.unit(),
    Epic: t.unit(),
    Legendary: t.unit(),
});

export const ComparisonOperator = t.enum('ComparisonOperator', {
    GreaterOrEqual: t.unit(),
    GreaterThan: t.unit(),
    Equal: t.unit(),
    LessThan: t.unit(),
    LessOrEqual: t.unit(),
});

export const ChatSenderType = t.enum('ChatSenderType', {
    Player: t.unit(),
    System: t.unit(),
});

export const GroupAssignmentMode = t.enum('GroupAssignmentMode', {
    Auto: t.unit(),
    Manual: t.unit(),
});

export const InviteStatus = t.enum('InviteStatus', {
    Pending: t.unit(),
    Accepted: t.unit(),
    Declined: t.unit(),
    Tentative: t.unit(),
});

export const BracketSide = t.enum('BracketSide', {
    Winners: t.unit(),
    Losers: t.unit(),
    GrandFinals: t.unit(),
    ThirdPlace: t.unit(),
    Group: t.unit(),
});

// BanType was dropped in S3 (A46): BanRecord.loginMethod is a string that mirrors the token's
// `login_method` claim ('discord' today), so a new provider needs no enum variant and no wipe.

// ServerIdentity row kind (M2, ACCESS-SECURITY-OPS §C.4): the publisher is registered as Owner by `init`;
// the owner registers Delegate identities (bootstrap, seeding, the manage-user script) with server_register_delegate,
// and (M5a3) the Linker identity of the Vercel auth function with server_register_linker. A Linker may only present a
// sign-in code (linker_present_code); it has no UserIdentity and every other reducer refuses it. Variant appended last.
export const ServerIdentityKind = t.enum('ServerIdentityKind', {
    Owner: t.unit(),
    Delegate: t.unit(),
    Linker: t.unit(),
});

// ─── S3 backend reset enums ──────────────────────────────────────────────────

// A21: lineups are 8 characters in halves (4+4) or 12 in thirds (4+4+4); the format is a lobby
// setting (preset-able) and part of the tournament integrity set (A33).
export const LineupFormat = t.enum('LineupFormat', {
    Halves: t.unit(),
    Thirds: t.unit(),
});

// A67(2): the lobby head-start side enum is removed; the head start is BracketMatch.winnerAdvantage (A27).

// A26: the single gate for seeding, team edits, lobby seats and bracket placement. Participants never set it.
export const TeamStatus = t.enum('TeamStatus', {
    Forming: t.unit(),
    Ready: t.unit(),
    Active: t.unit(),
    Eliminated: t.unit(),
    Withdrawn: t.unit(),
    Disqualified: t.unit(),
});

// A23 (review 5.2): exact-slot, single-writer bracket. Pending = slots not yet filled, Ready = both
// teams known, Walkover = decided by a BYE, Void = both slots BYE (never played),
// Decided = result settled. A rollback returns a match to Ready or Pending; a cancel leaves states as they are.
export const BracketMatchState = t.enum('BracketMatchState', {
    Pending: t.unit(),
    Ready: t.unit(),
    Walkover: t.unit(),
    Void: t.unit(),
    Decided: t.unit(),
});

// A23/A24/A38(1): how a Decided bracket match was settled.
export const BracketDecision = t.enum('BracketDecision', {
    Played: t.unit(),
    Concede: t.unit(),
    Dq: t.unit(),
    Staff: t.unit(),
});

// A45(2): the mockup's four ban-restriction options, enforced per team in ban_character using HsrCharacter.role.
export const BanRestriction = t.enum('BanRestriction', {
    NoRestriction: t.unit(),
    MaxOneDps: t.unit(),
    MaxTwoDps: t.unit(),
    MaxOnePerRole: t.unit(),
});

// A45(3): shuffle_teams modes, the lobby room's Random Swap / Team Swap buttons (lobbyroom.html #randomSwap, #teamSwap).
export const ShuffleMode = t.enum('ShuffleMode', {
    RandomSwap: t.unit(),
    TeamSwap: t.unit(),
});

// A143 (S11a): where a TournamentPlayerAccount lock came from: the player's own entry (registration, promotion,
// lock_tournament_accounts while enrolled, an A112 entry transfer) or taking part as a stand-in (the participation
// snapshot, lock_tournament_accounts by an approved stand-in without an enrolment).
export const AccountLockOrigin = t.enum('AccountLockOrigin', {
    Entry: t.unit(),
    StandIn: t.unit(),
});
