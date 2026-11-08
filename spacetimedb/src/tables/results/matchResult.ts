import { table, t } from 'spacetimedb/server';
import { MatchResultStatus, MatchType, MatchEndReason, TeamSide, ConcedeTrigger } from '@module/types/enums';

export const matchResultColumns = {
    id: t.u32().primaryKey().autoInc(),
    bracketMatchId: t.u32().optional(),
    lobbyId: t.u32(),
    isTournamentControlled: t.bool(),
    status: MatchResultStatus,              // A24(3): Voided marks a rolled-back tournament record for audit
    winnerTeamSide: TeamSide.optional(),   // WHO won: Blue/Red, undefined while unresolved — per D-30 (A31: never a draw)
    mmrProcessedAt: t.timestamp().optional(),
    refereeUserId: t.u32().optional(),
    disputedByUserId: t.u32().optional(),
    disputeReason: t.string().optional(),
    // A60(3): the captains' confirmations live on MatchResultGame (per game) since S7b; the record-level flags were removed.
    // S9a (user 2026-11-07): the referee full-control snapshot column is dropped; since A63 no reducer read it and the live seat decides neutrality.
    matchType: MatchType,
    matchEndReason: MatchEndReason.optional(), // HOW it ended: Completed/Concede — per D-31/D-32
    concedeTrigger: ConcedeTrigger.optional(),
    concedeSummary: t.string().optional(),
    concedeAtStage: t.string().optional(),
    // A21 tie-break step 4 / A39: the referee's decision on an unresolved tie, audited.
    winnerOverride: TeamSide.optional(),
    winnerOverrideById: t.u32().optional(),
    winnerOverrideReason: t.string().optional(),
    // A24(1): when the result became settled (Validated or concede) and the bracket advanced.
    settledAt: t.timestamp().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (A37): private; participants read view_my_match_result, staff view_admin_match_results / view_my_tournament_match_results (S9).
export const MatchResultRecord = table({
    name: 'match_result_record',
    public: false,
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
        { accessor: 'bracket_match_id', algorithm: 'btree', columns: ['bracketMatchId'] }, // New query path: derive tournamentId via bracketMatch.tournamentId (D-42)
    ],
}, matchResultColumns);
