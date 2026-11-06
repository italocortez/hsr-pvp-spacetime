import { table, t } from 'spacetimedb/server';
import { MatchResultStatus, MatchType, MatchEndReason, TeamSide, ConcedeTrigger } from '../types/enums';

export const matchResultColumns = {
    id: t.u32().primaryKey().autoInc(),
    bracketMatchId: t.u32().optional(),
    lobbyId: t.u32(),
    isTournamentControlled: t.bool(),
    status: MatchResultStatus,
    winnerTeamSide: TeamSide.optional(),   // WHO won: Blue/Red/undefined (draw or unresolved) — per D-30
    mmrProcessedAt: t.timestamp().optional(),
    refereeUserId: t.u32().optional(),
    disputedByUserId: t.u32().optional(),
    disputeReason: t.string().optional(),
    blueConfirmed: t.bool(),
    redConfirmed: t.bool(),
    refereeFullControl: t.bool(),
    matchType: MatchType,
    matchEndReason: MatchEndReason.optional(), // HOW it ended: Completed/Draw/Concede — per D-31/D-32
    concedeTrigger: ConcedeTrigger.optional(),
    concedeSummary: t.string().optional(),
    concedeAtStage: t.string().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchResultRecord = table({
    name: 'match_result_record',
    public: true,
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
        { accessor: 'bracket_match_id', algorithm: 'btree', columns: ['bracketMatchId'] }, // New query path: derive tournamentId via bracketMatch.tournamentId (D-42)
    ],
}, matchResultColumns);
