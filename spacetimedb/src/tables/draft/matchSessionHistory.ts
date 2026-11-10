import { table, t } from 'spacetimedb/server';
import { DraftMode, GameMode, MatchEndReason, MatchType, TeamSide } from '@module/types/enums';
import { LobbyConfigSnapshot } from '@module/types/structs';

export const matchSessionHistoryColumns = {
    id: t.u32().primaryKey().autoInc(),
    lobbyCode: t.string(),       // Kept for reference (e.g. "X7K9P2")
    playedAt: t.timestamp(),

    draftMode: DraftMode,
    gameMode: GameMode,

    teamBlueAlias: t.string(),
    teamRedAlias: t.string(),

    snapshotConfig: LobbyConfigSnapshot, // The exact rules used (Snapshot)

    outcome: MatchEndReason,

    // Budget analysis (per D-88):
    teamBlueSpent: t.f32().optional(),
    teamRedSpent: t.f32().optional(),
    handicapApplied: t.i32().optional(), // A21: fixed-point hundredths

    // A24 / A37: tournament linkage replaces the D-84 public-visibility flag and the D-91 reveal scan.
    // History is never public; participants and Moderator+ read it through views (R5).
    tournamentId: t.u32().optional(),
    bracketMatchId: t.u32().optional(),
    voidedAt: t.timestamp().optional(),  // A24(3): set when a tournament rollback voids the match

    // A21 tie-break 4 / A39: the referee's override of an unresolved tie and who made it, kept for audit and replay.
    winnerOverride: TeamSide.optional(),
    winnerOverrideById: t.u32().optional(),
    winnerOverrideReason: t.string().optional(),

    // S10n (A115(1)): stored at finalization so the history list neither derives nor guesses them.
    // matchType: the record's match type (the lobby's, copied at start_draft; a rated tournament's lobby is Ranked, D-67),
    // the value finalization rates and counts stats by. winnerTeamSide: the record's final winner (concede, forfeit,
    // staff override and force-finalize included), the one finalization uses for stats and ratings; none = no winner.
    matchType: MatchType,
    winnerTeamSide: TeamSide.optional(),

    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchSessionHistory = table({
    name: 'match_session_history',
    public: false,
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
    ]
}, matchSessionHistoryColumns);
