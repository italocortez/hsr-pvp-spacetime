import { table, t } from 'spacetimedb/server';
import { BracketSide, BracketMatchState, BracketDecision } from '../types/enums';

// A23 (review 5.2): exact-slot, single-writer bracket. positionKey ('W-R1-M1', 'L-R2-M1', 'GF', 'TP',
// 'G0-R1-M1') is the engine's stable address; nextWinnerSlot / nextLoserSlot (1 or 2) name the slot the
// winner / loser fills in the next match; team1 = Blue, team2 = Red in the lobby (A35); the WB finalist is
// slot 1 of the grand final (A27). state + decidedBy replace checkInRequired and resultStatus; gameMode
// is read from Tournament.defaultGameMode (integrity set, A33). Public: team ids only, no user ids (R1).
export const bracketMatchColumns = {
    id: t.u32().primaryKey().autoInc(),
    tournamentId: t.u32(),
    positionKey: t.string(),
    bracketSide: BracketSide,
    roundNumber: t.u32(),
    matchNumber: t.u32(),
    groupId: t.u32().optional(),
    team1Id: t.u32().optional(),
    team2Id: t.u32().optional(),
    team1IsBye: t.bool(),
    team2IsBye: t.bool(),
    nextWinnerMatchId: t.u32().optional(),
    nextWinnerSlot: t.u8(),
    nextLoserMatchId: t.u32().optional(),
    nextLoserSlot: t.u8(),
    bestOf: t.u8(),
    winnerAdvantage: t.u8(),
    scheduledAt: t.timestamp().optional(),
    state: BracketMatchState,
    winnerTeamId: t.u32().optional(),
    loserTeamId: t.u32().optional(),
    decidedBy: BracketDecision.optional(),
    team1Games: t.u8(),                   // series score: A30 game differential + display
    team2Games: t.u8(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const BracketMatch = table({
    name: 'bracket_match',
    public: true,
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'by_tournament_and_position', algorithm: 'btree', columns: ['tournamentId', 'positionKey'] },
        // lobby_id index removed (D-43): relationship now navigated via Lobby.bracketMatchId with bracket_match_id btree on Lobby
    ],
}, bracketMatchColumns);
