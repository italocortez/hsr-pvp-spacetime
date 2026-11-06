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
    BetweenGames: t.unit(),   // Brief post-game transition (series not won yet); bestOf=1 skips this
    Shelved: t.unit(),        // Long-term pause between games; casual=72h TTL, tournament persists until cancel
    AwaitingResult: t.unit(), // Match submitted, players freed — lobby alive for finalization
    Finished: t.unit(),       // Lobby closed/abandoned — GC cleans up after 30 min
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

export const MatchEndReason = t.enum('MatchEndReason', {
    Completed: t.unit(), // Normal completion — winnerTeamSide indicates who won (or undefined for draw)
    Draw: t.unit(),
    Concede: t.unit(),
});

export const ConcedeTrigger = t.enum('ConcedeTrigger', {
    Disconnect: t.unit(),
    VoluntaryLeave: t.unit(),
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
    ArrangeLineup: t.unit(),
    ConfirmLineup: t.unit(),
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
});

export const ValidationStatus = t.enum('ValidationStatus', {
    Pending: t.unit(),
    Confirmed: t.unit(),
    Disputed: t.unit(),
});

export const DisconnectPolicy = t.enum('DisconnectPolicy', {
    Standard: t.unit(),
    Deferred: t.unit(),
    NoAction: t.unit(),
});

export const RecurrenceType = t.enum('RecurrenceType', {
    Daily: t.unit(),
    Weekly: t.unit(),
    Monthly: t.unit(),
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

export const BanType = t.enum('BanType', {
    DiscordId: t.unit(),
});
