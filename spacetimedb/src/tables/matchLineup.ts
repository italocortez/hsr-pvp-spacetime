import { table, t } from 'spacetimedb/server';
import { TeamSide } from '../types/enums';

/**
 * A21 synergy groups (S3): the live lineup of one team for one game, arranged by the captain or a referee
 * (arrange_lineup; throttled through AbuseConfig.lineupMinIntervalMs). Visible live to everyone in the lobby
 * through view_my_lineups (S9). A60 (S7b): there is no lineup confirmation any more (confirm_lineup, the flag column
 * and the ConfirmLineup step were removed); the captains confirm the whole game package with confirm_game
 * (MatchResultGame.blueConfirmed / redConfirmed), and the arrangement is editable until the game closes.
 * `groups` is a JSON string[][] of character names: 2 groups of 4 (halves) or 3 groups of 4 (thirds).
 * `synergySurcharge` = sum of the costModifier of every HsrSynergyCost pair placed in the same group
 * (hundredths); `rosterCost` = the team's live roster cost (cost-table values at the current eidolons in Classic,
 * winning bids plus eidolon extras in Auction, plus light cones and the surcharge), hundredths; refreshed by
 * arrange_lineup, equip_lightcone and set_eidolon (A21 tie-break 1 computes the same value live).
 */
export const matchLineupColumns = {
    id: t.u32().primaryKey().autoInc(),
    lobbyId: t.u32(),
    gameNumber: t.u8(),
    teamSide: TeamSide,
    groups: t.string(),
    synergySurcharge: t.u32(),
    rosterCost: t.u32(),
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
