import { table, t } from 'spacetimedb/server';
import { TournamentFormat, TournamentStage, GameMode, DisconnectPolicy, GroupAssignmentMode, RosterVisibility, LineupFormat } from '@module/types/enums';

// A33: the integrity set (teamSize, defaultGameMode, countTowardsMmr -> matchType, both anonymity flags,
// rosterVisibility, requireOwnership, costSetId, disconnectPolicy + disconnectForfeitSeconds, allowMirrorPicks,
// lineupFormat) lives here and is copied into every tournament lobby and locked; bestOf goes to the bracket match
// (A28 chain; A67(2): not to the lobby).
// The free set comes from the preset pointed to by lobbyPresetId (A33a).
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
    // Disconnect (A36: one optional forfeit timer replaces the old enabled/minutes pair)
    disconnectPolicy: DisconnectPolicy,
    disconnectForfeitSeconds: t.u32().optional(),
    // Check-in (A26: team-level, by the captain; A36: the per-round flag dropped)
    checkInEnabled: t.bool(),
    // Bracket (A36: the reveal timestamp and the auto-advance flag dropped; A24: advance on Validated)
    winnerAdvantage: t.u8(),              // A27: WB finalist head start in the grand final, < ceil(grandFinalBestOf / 2)
    groupAssignmentMode: GroupAssignmentMode,
    groupAdvanceCount: t.u8(),            // A36: 1 or 2
    // Cost set
    costSetId: t.u32(),
    // Season (A36: the active season, 0 for now; no season logic in this version)
    seasonId: t.u32(),
    // MMR
    countTowardsMmr: t.bool(),
    requireResultValidation: t.bool(),    // A36: forced true when countTowardsMmr; a submitted result waits for canResolveResults staff
    defaultBestOf: t.u8(),                // A28: {1, 3}
    grandFinalBestOf: t.u8(),             // A28: {1, 3}
    maxAccountsPerPlayer: t.u8(),
    groupSize: t.u8(),                    // A32: minimum group size (floor split, leftovers spread)
    has3rdPlaceMatch: t.bool(),           // A29: single elimination only
    // Lobby settings inherited by tournament lobbies (integrity set, A33)
    requireOwnership: t.bool(),
    allowMirrorPicks: t.bool(),
    lineupFormat: LineupFormat,           // A21
    lobbyPresetId: t.u32(),               // A33a: free-set starting values; defaults to the system preset
    // Registration requirements
    requireVerified: t.bool(),
    requireRoster: t.bool(),
    minimumMmr: t.u32().optional(),       // A36b basis
    requireApproval: t.bool(),
    waitlistEnabled: t.bool(),
    // Scheduling (informational only)
    scheduledStartAt: t.timestamp().optional(),
    registrationDeadline: t.timestamp().optional(),
    // Bracket bookkeeping (review 5.2): Seeding -> InProgress requires bracketGeneratedAt >= lastSeedChangeAt
    lastSeedChangeAt: t.timestamp().optional(),
    bracketGeneratedAt: t.timestamp().optional(),
    // D.8.1 chunked finalization (A24(7), D-D1): Running = started && !finalized, Done = finalizedAt set
    finalizationStartedAt: t.timestamp().optional(),
    finalizedAt: t.timestamp().optional(),
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
