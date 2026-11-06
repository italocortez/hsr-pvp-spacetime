import { table, t } from 'spacetimedb/server';
import { TournamentFormat, TournamentStage, GameMode, DisconnectPolicy, GroupAssignmentMode, RosterVisibility } from '../types/enums';

export const tournamentColumns = {
    id: t.u32().primaryKey().autoInc(),
    name: t.string(),
    description: t.string(),
    organizerId: t.u32(),
    format: TournamentFormat,
    stage: TournamentStage,
    defaultGameMode: GameMode,
    maxParticipants: t.u32(),
    teamSize: t.u8(),
    // Anonymous
    isAnonymousDefault: t.bool(),
    isAnonymousSpectators: t.bool(),
    // Roster visibility (replaces isOpenRoster)
    rosterVisibility: RosterVisibility,
    // Disconnect
    disconnectPolicy: DisconnectPolicy,
    // Check-in
    checkInEnabled: t.bool(),
    checkInPerRound: t.bool(),
    // Auto-forfeit
    autoForfeitEnabled: t.bool(),
    autoForfeitMinutes: t.u32(),
    // Bracket
    bracketRevealAt: t.timestamp().optional(),
    winnerAdvantage: t.u8(),
    groupAssignmentMode: GroupAssignmentMode,
    groupAdvanceCount: t.u8(),
    // Cost set
    costSetId: t.u32(),
    // Season
    seasonId: t.u32().optional(),
    // MMR
    countTowardsMmr: t.bool(),
    defaultBestOf: t.u8(),
    maxAccountsPerPlayer: t.u8(),
    groupSize: t.u8(),                    // min 3, target group size for round-robin
    has3rdPlaceMatch: t.bool(),           // controls 3rd place match generation
    autoAdvanceBracket: t.bool(),         // controls auto vs manual advancement
    // Lobby settings inherited by tournament lobbies
    requireOwnership: t.bool(),
    // Registration requirements
    requireVerified: t.bool(),
    requireRoster: t.bool(),
    minimumMmr: t.u32().optional(),
    requireApproval: t.bool(),
    waitlistEnabled: t.bool(),
    // Scheduling (informational only)
    scheduledStartAt: t.timestamp().optional(),
    registrationDeadline: t.timestamp().optional(),
    // Audit
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const Tournament = table({
    name: 'tournament',
    public: true,
    indexes: [
        { accessor: 'organizer_id', algorithm: 'btree', columns: ['organizerId'] },
        { accessor: 'stage', algorithm: 'btree', columns: ['stage'] },
    ],
}, tournamentColumns);
