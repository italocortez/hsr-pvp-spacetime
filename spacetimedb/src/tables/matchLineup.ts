import { table, t } from 'spacetimedb/server';
import { TeamSide } from '../types/enums';

/**
 * A21 synergy groups (S3): the live lineup of one team for one game, arranged by the captain or a referee
 * (arrange_lineup / confirm_lineup, S7; throttled through AbuseConfig.lineupMinIntervalMs). Visible live to
 * everyone in the lobby through view_my_lineups (S9); the confirmed arrangement is also logged as the
 * ConfirmLineup step for replay.
 * `groups` is a JSON string[][] of character names: 2 groups of 4 (halves) or 3 groups of 4 (thirds).
 * `synergySurcharge` = sum of the costModifier of every HsrSynergyCost pair placed in the same group
 * (hundredths); `rosterCost` = the team's roster cost at confirmation (cost-table values in Classic,
 * budget spent in Auction, plus the surcharge), hundredths — the stored computation A21 tie-break 1 reads.
 */
export const matchLineupColumns = {
    id: t.u32().primaryKey().autoInc(),
    lobbyId: t.u32(),
    gameNumber: t.u8(),
    teamSide: TeamSide,
    groups: t.string(),
    synergySurcharge: t.u32(),
    rosterCost: t.u32(),
    isConfirmed: t.bool(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchLineup = table({
    name: 'match_lineup',
    public: false,
    indexes: [
        { accessor: 'by_lobby_game', algorithm: 'btree', columns: ['lobbyId', 'gameNumber'] },
    ],
}, matchLineupColumns);
