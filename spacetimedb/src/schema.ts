import { schema, t } from 'spacetimedb/server';
import { User } from '@module/tables/identity/user';
import { UserPresence } from '@module/tables/identity/userPresence';
import { LinkRequest } from '@module/tables/identity/linkRequest';
import { DeletedUser } from '@module/tables/identity/deletedUser';
import { BanRecord } from '@module/tables/admin/banRecord';
import { UserIdentity } from '@module/tables/identity/userIdentity';
import { ServerIdentity } from '@module/tables/identity/serverIdentity';
import { HsrCharacter } from '@module/tables/roster/hsrCharacter';
import { HsrLightcone } from '@module/tables/roster/hsrLightcone';
import { HsrCharacterCost } from '@module/tables/roster/hsrCharacterCost';
import { HsrLightconeCost } from '@module/tables/roster/hsrLightconeCost';
import { HsrSynergyCost } from '@module/tables/roster/hsrSynergyCost';

// Roster Management
import { HsrAccount } from '@module/tables/roster/hsrAccount';
import { HsrAccountCharacter } from '@module/tables/roster/hsrAccountCharacter';
// Archetypes
import { Archetype } from '@module/tables/roster/archetype';
import { HsrCharacterArchetype } from '@module/tables/roster/hsrCharacterArchetype';

// Tournament System
import { Tournament } from '@module/tables/tournament/tournament';
import { TournamentEnrolled } from '@module/tables/tournament/tournamentEnrolled';
import { TournamentAssistant } from '@module/tables/tournament/tournamentAssistant';
import { TournamentStandIn } from '@module/tables/tournament/tournamentStandIn';

// Cost Set Management
import { CostSet } from '@module/tables/roster/costSet';
import { CostSetDraftCharacter } from '@module/tables/roster/costSetDraftCharacter';
import { CostSetDraftLightcone } from '@module/tables/roster/costSetDraftLightcone';
import { CostSetDraftSynergy } from '@module/tables/roster/costSetDraftSynergy';

// Tournament Teams
import { TournamentTeam } from '@module/tables/tournament/tournamentTeam';
import { TournamentTeamMember } from '@module/tables/tournament/tournamentTeamMember';
import { TournamentTeamRequest } from '@module/tables/tournament/tournamentTeamRequest';

// Bracket (group_phase_record dropped in S3, A23: group standings are computed by the shared rankGroup)
import { BracketMatch } from '@module/tables/tournament/bracketMatch';

// Match Results
import { MatchResultRecord } from '@module/tables/results/matchResult';
import { MatchResultGame } from '@module/tables/results/matchResultGame';
import { MatchResultParticipant } from '@module/tables/results/matchResultParticipant';
import { MatchResultGroupScore } from '@module/tables/results/matchResultGroupScore';
import { MatchResultAdjustment } from '@module/tables/results/matchResultAdjustment';
import { MatchLineup } from '@module/tables/draft/matchLineup';
import { PlayerRelationship } from '@module/tables/identity/playerRelationship';
import { MatchParticipantHistory } from '@module/tables/draft/matchParticipantHistory';

// MMR
import { MmrRating } from '@module/tables/stats/mmrRating';
import { MmrHistory } from '@module/tables/stats/mmrHistory';

// ELO Config
import { EloConfigTable } from '@module/tables/stats/eloConfig';
import { Leaderboard } from '@module/tables/stats/leaderboard';

// Account Rating Config
import { AccountRatingConfig } from '@module/tables/stats/accountRatingConfig';

// Player Stats
import { PlayerStat } from '@module/tables/stats/playerStats';
import { PlayerCharacterStat } from '@module/tables/stats/characterStats';

// Achievements
import { Achievement } from '@module/tables/stats/achievement';
import { UserAchievement } from '@module/tables/stats/userAchievement';
import { AchievementCriteria } from '@module/tables/stats/achievementCriteria';

// Calendar
import { AvailabilitySlot } from '@module/tables/calendar/availabilitySlot';
import { SavedCalendar } from '@module/tables/calendar/savedCalendar';
import { CalendarEvent } from '@module/tables/calendar/calendarEvent';
import { CalendarEventInvite } from '@module/tables/calendar/calendarEventInvite';

// Chat
import { ChatMessage } from '@module/tables/lobby/chatMessage';

// Lobby System
import { Lobby } from '@module/tables/lobby/lobby';
import { LobbyMember } from '@module/tables/lobby/lobbyMember';
import { LobbyBan } from '@module/tables/lobby/lobbyBan';
import { LobbyPreset } from '@module/tables/lobby/lobbyPreset';
import { LobbyPassword } from '@module/tables/lobby/lobbyPassword';
import { LobbyMemberAccount } from '@module/tables/lobby/lobbyMemberAccount';
import { LobbyCursorEvent } from '@module/tables/lobby/lobbyCursorEvent';
import { LobbyCursorStamp } from '@module/tables/lobby/lobbyCursorStamp';

// Active Game
import { MatchSession } from '@module/tables/draft/matchSession';
import { MatchSessionStep } from '@module/tables/draft/matchSessionStep';

// History
import { MatchSessionHistory } from '@module/tables/draft/matchSessionHistory';
import { MatchSessionStepHistory } from '@module/tables/draft/matchSessionStepHistory';

// Season
import { Season } from '@module/tables/tournament/season';

// Global Stats
import { GlobalCharacterStat } from '@module/tables/stats/globalCharacterStat';

// Tournament Player Accounts
import { TournamentPlayerAccount } from '@module/tables/tournament/tournamentPlayerAccount';
import { TournamentWaitlistAccount } from '@module/tables/tournament/tournamentWaitlistAccount';

// Match Result Game History
import { MatchResultGameHistory } from '@module/tables/results/matchResultGameHistory';
import { MatchLineupHistory } from '@module/tables/draft/matchLineupHistory';

// GC Audit
import { GcResult } from '@module/tables/admin/gcResult';

// Scheduled Jobs
import { UserDeletionJob } from '@module/tables/identity/userDeletionJob';
import { LobbyGcJob } from '@module/tables/lobby/lobbyGcJob';
import { IdentityGcJob } from '@module/tables/identity/identityGcJob';
import { RefereeTransferCheck } from '@module/tables/lobby/refereeTransferCheck';
import { TournamentFinalizeJob } from '@module/tables/tournament/tournamentFinalizeJob';

// Abuse controls (S3; §B.5, A42)
import { AbuseConfig } from '@module/tables/admin/abuseConfig';
import { AbuseCounter } from '@module/tables/admin/abuseCounter';
import { UserRateState } from '@module/tables/identity/userRateState';
import { AdminAlert } from '@module/tables/admin/adminAlert';

const spacetimedb = schema({
    // User / Auth
    User,
    UserPresence,
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
    LobbyCursorStamp,       // S11a (L19): the cursor throttle stamp, off LobbyMember; private, no view reads it

    // Active Game
    MatchSession,
    MatchSessionStep,

    // History
    MatchSessionHistory,
    MatchSessionStepHistory,
    MatchParticipantHistory,
    MatchResultGameHistory,
    MatchLineupHistory,     // A56: archived lineups, written by runFinalization

    // Season
    Season,

    // Global Stats
    GlobalCharacterStat,

    // Tournament Player Accounts
    TournamentPlayerAccount,
    TournamentWaitlistAccount, // A104 (S10g): a waitlisted registrant's chosen accounts, private

    // GC Audit
    GcResult,

    // Scheduled Jobs
    UserDeletionJob,
    LobbyGcJob,
    IdentityGcJob,
    RefereeTransferCheck,
    TournamentFinalizeJob,

    // Abuse controls
    AbuseConfig,
    AbuseCounter,
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
