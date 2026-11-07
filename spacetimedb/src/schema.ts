import { schema, t } from 'spacetimedb/server';
import { User } from './tables/user';
import { UserPresence } from './tables/userPresence';
import { UserPrivate } from './tables/userPrivate';
import { LinkRequest } from './tables/linkRequest';
import { DeletedUser } from './tables/deletedUser';
import { BanRecord } from './tables/banRecord';
import { UserIdentity } from './tables/userIdentity';
import { ServerIdentity } from './tables/serverIdentity';
import { HsrCharacter } from './tables/hsrCharacter';
import { HsrLightcone } from './tables/hsrLightcone';
import { HsrCharacterCost } from './tables/hsrCharacterCost';
import { HsrLightconeCost } from './tables/hsrLightconeCost';
import { HsrSynergyCost } from './tables/hsrSynergyCost';

// Roster Management
import { HsrAccount } from './tables/hsrAccount';
import { HsrAccountCharacter } from './tables/hsrAccountCharacter';
// Archetypes
import { Archetype } from './tables/archetype';
import { HsrCharacterArchetype } from './tables/hsrCharacterArchetype';

// Tournament System
import { Tournament } from './tables/tournament';
import { TournamentEnrolled } from './tables/tournamentEnrolled';
import { TournamentAssistant } from './tables/tournamentAssistant';
import { TournamentStandIn } from './tables/tournamentStandIn';

// Cost Set Management
import { CostSet } from './tables/costSet';
import { CostSetDraftCharacter } from './tables/costSetDraftCharacter';
import { CostSetDraftLightcone } from './tables/costSetDraftLightcone';
import { CostSetDraftSynergy } from './tables/costSetDraftSynergy';

// Tournament Teams
import { TournamentTeam } from './tables/tournamentTeam';
import { TournamentTeamMember } from './tables/tournamentTeamMember';
import { TournamentTeamRequest } from './tables/tournamentTeamRequest';

// Bracket (group_phase_record dropped in S3, A23: group standings are computed by the shared rankGroup)
import { BracketMatch } from './tables/bracketMatch';

// Match Results
import { MatchResultRecord } from './tables/matchResult';
import { MatchResultGame } from './tables/matchResultGame';
import { MatchResultParticipant } from './tables/matchResultParticipant';
import { MatchResultGroupScore } from './tables/matchResultGroupScore';
import { MatchResultAdjustment } from './tables/matchResultAdjustment';
import { MatchLineup } from './tables/matchLineup';
import { PlayerRelationship } from './tables/playerRelationship';
import { MatchParticipantHistory } from './tables/matchParticipantHistory';

// MMR
import { MmrRating } from './tables/mmrRating';
import { MmrHistory } from './tables/mmrHistory';

// ELO Config
import { EloConfigTable } from './tables/eloConfig';
import { Leaderboard } from './tables/leaderboard';

// Account Rating Config
import { AccountRatingConfig } from './tables/accountRatingConfig';

// Player Stats
import { PlayerStat } from './tables/playerStats';
import { PlayerCharacterStat } from './tables/characterStats';

// Achievements
import { Achievement } from './tables/achievement';
import { UserAchievement } from './tables/userAchievement';
import { AchievementCriteria } from './tables/achievementCriteria';

// Calendar
import { AvailabilitySlot } from './tables/availabilitySlot';
import { SavedCalendar } from './tables/savedCalendar';
import { CalendarEvent } from './tables/calendarEvent';
import { CalendarEventInvite } from './tables/calendarEventInvite';

// Chat
import { ChatMessage } from './tables/chatMessage';

// Lobby System
import { Lobby } from './tables/lobby';
import { LobbyMember } from './tables/lobbyMember';
import { LobbyBan } from './tables/lobbyBan';
import { LobbyPreset } from './tables/lobbyPreset';
import { LobbyPassword } from './tables/lobbyPassword';
import { LobbyMemberAccount } from './tables/lobbyMemberAccount';
import { LobbyCursorEvent } from './tables/lobbyCursorEvent';

// Active Game
import { MatchSession } from './tables/matchSession';
import { MatchSessionStep } from './tables/matchSessionStep';

// History
import { MatchSessionHistory } from './tables/matchSessionHistory';
import { MatchSessionStepHistory } from './tables/matchSessionStepHistory';

// Season
import { Season } from './tables/season';

// Global Stats
import { GlobalCharacterStat } from './tables/globalCharacterStat';

// Tournament Player Accounts
import { TournamentPlayerAccount } from './tables/tournamentPlayerAccount';

// Match Result Game History
import { MatchResultGameHistory } from './tables/matchResultGameHistory';

// GC Audit
import { GcResult } from './tables/gcResult';

// Scheduled Jobs
import { UserDeletionJob } from './tables/userDeletionJob';
import { LobbyGcJob } from './tables/lobbyGcJob';
import { IdentityGcJob } from './tables/identityGcJob';
import { RefereeTransferCheck } from './tables/refereeTransferCheck';
import { TournamentFinalizeJob } from './tables/tournamentFinalizeJob';
import { AbuseBreakerJob } from './tables/abuseBreakerJob';

// Abuse controls (S3; §B.5, A42)
import { AbuseConfig } from './tables/abuseConfig';
import { UserRateState } from './tables/userRateState';
import { AdminAlert } from './tables/adminAlert';

const spacetimedb = schema({
    // User / Auth
    User,
    UserPresence,
    UserPrivate,
    DeletedUser,
    BanRecord,
    UserIdentity,
    ServerIdentity,
    LinkRequest,

    // Static Assets
    HsrCharacter,
    HsrLightcone,

    // Economy
    HsrCharacterCost,
    HsrLightconeCost,
    HsrSynergyCost,

    // Roster Management
    HsrAccount,
    HsrAccountCharacter,
    // Archetypes
    Archetype,
    HsrCharacterArchetype,

    // Tournament System
    Tournament,
    TournamentEnrolled,
    TournamentAssistant,
    TournamentStandIn,

    // Cost Set Management
    CostSet,
    CostSetDraftCharacter,
    CostSetDraftLightcone,
    CostSetDraftSynergy,

    // Tournament Teams
    TournamentTeam,
    TournamentTeamMember,
    TournamentTeamRequest,

    // Bracket
    BracketMatch,

    // Match Results
    MatchResultRecord,
    MatchResultGame,
    MatchResultParticipant,
    MatchResultGroupScore,
    MatchResultAdjustment,
    MatchLineup,
    PlayerRelationship,

    // MMR
    MmrRating,
    MmrHistory,

    // ELO Config
    EloConfigTable,
    Leaderboard,

    // Account Rating Config
    AccountRatingConfig,

    // Player Stats
    PlayerStat,
    PlayerCharacterStat,

    // Achievements
    Achievement,
    UserAchievement,
    AchievementCriteria,

    // Calendar
    AvailabilitySlot,
    SavedCalendar,
    CalendarEvent,
    CalendarEventInvite,

    // Chat
    ChatMessage,

    // Lobby System
    Lobby,
    LobbyMember,
    LobbyBan,
    LobbyPreset,
    LobbyPassword,
    LobbyMemberAccount,
    LobbyCursorEvent,

    // Active Game
    MatchSession,
    MatchSessionStep,

    // History
    MatchSessionHistory,
    MatchSessionStepHistory,
    MatchParticipantHistory,
    MatchResultGameHistory,

    // Season
    Season,

    // Global Stats
    GlobalCharacterStat,

    // Tournament Player Accounts
    TournamentPlayerAccount,

    // GC Audit
    GcResult,

    // Scheduled Jobs
    UserDeletionJob,
    LobbyGcJob,
    IdentityGcJob,
    RefereeTransferCheck,
    TournamentFinalizeJob,
    AbuseBreakerJob,

    // Abuse controls
    AbuseConfig,
    UserRateState,
    AdminAlert,
}, {
    // Module environment (SpacetimeDB 2.12+, D-C1): supplied from the publisher's process environment at
    // publish time (scripts/stdb/publish.ts spawns the CLI with STDB_TARGET=<target>), preserved across
    // publishes, cleared by --delete-data. Read as ctx.env.STDB_TARGET ('test' | 'prod'). The test-only
    // server_* reducers are default-deny: anything but 'test' (including a publish that forgot it) rejects.
    env: {
        STDB_TARGET: t.enum('StdbTarget', ['test', 'prod']),
    },
});

export default spacetimedb;
