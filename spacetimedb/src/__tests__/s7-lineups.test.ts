// T-S7(b): in-memory tests for the S7 lineups (backlog #3, A21, A56), the eidolon snapshot (CH-S6, D.8.7), the
// format-driven character count (Thirds = 12 picks per team) and the hardDeleteLobby cleanup. TestClock throughout.
// T-S7b (A60): no lineup confirmation any more (confirm_lineup / MatchLineup.isConfirmed removed); the Auction surcharge
// gate sits at confirm_game; equips reset the game confirmations.
import { describe, expect, it } from 'vitest';
import { hardDeleteLobby } from '@module/reducers/lobby/lobbyGc';
import { M, advance, expectReject, lobbyRow, newHarness, session, setupLobby, steps, tx, priceCharacters } from './s4-fixtures';
import {
    H,
    arrange,
    blueNames,
    captain,
    confirmAndClose,
    confirmBoth,
    confirmGame,
    draftAuction,
    draftClassic,
    equip,
    game,
    halves,
    insertLightconeCost,
    insertRoster,
    insertSynergy,
    lineup,
    playToScoring,
    record,
    recordScores,
    redNames,
    selectAccount,
} from './s7-fixtures';

describe('backlog #3: synergy surcharge and who arranges', () => {
    it('The Herta + Argenti + Tribbie in one group = +8 (two pairs)', () => {
        const test = newHarness();
        const blue = ['the-herta', 'argenti', 'tribbie', ...blueNames(5)];
        insertRoster(test, [...blue, ...redNames()]);
        insertSynergy(test, 'the-herta', 'argenti', 4, 'Classic');
        insertSynergy(test, 'the-herta', 'tribbie', 4, 'Classic');
        const s = setupLobby(test);
        draftClassic(s, blue, redNames());

        arrange(s, captain(s, 'Blue'), 'Blue', [['the-herta', 'argenti', 'tribbie', 'blue-1'], ['blue-2', 'blue-3', 'blue-4', 'blue-5']]);
        expect(lineup(test, s.lobbyId, 'Blue').synergySurcharge).toBe(H(8));
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(8)); // no cost rows: the surcharge only

        advance(test, 300);
        arrange(s, captain(s, 'Blue'), 'Blue', [['the-herta', 'argenti', 'blue-1', 'blue-2'], ['tribbie', 'blue-3', 'blue-4', 'blue-5']]);
        expect(lineup(test, s.lobbyId, 'Blue').synergySurcharge).toBe(H(4));
    });

    it('only the captain of that team or a referee arranges; throttled; the referee arranges either team', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        const s = setupLobby(test);
        draftClassic(s, blueNames(), redNames());
        const blueCap = captain(s, 'Blue');
        const nonCaptain = [s.a.b1, s.a.b2].find((a) => a.userId !== blueCap.userId)!;

        expectReject(test, nonCaptain, (ctx) =>
            M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' }, groups: JSON.stringify(halves(blueNames())) }),
            'Only the Blue captain or a referee can arrange the lineup.');
        expectReject(test, captain(s, 'Red'), (ctx) =>
            M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' }, groups: JSON.stringify(halves(blueNames())) }),
            'Only the Blue captain or a referee can arrange the lineup.');

        // Invalid arrangements: a Red character, a wrong group size.
        expectReject(test, blueCap, (ctx) =>
            M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' }, groups: JSON.stringify(halves([...blueNames(7), 'red-1'])) }),
            /red-1 is not a drafted character/);

        arrange(s, blueCap, 'Blue', halves(blueNames()));
        expectReject(test, blueCap, (ctx) =>
            M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' }, groups: JSON.stringify(halves(blueNames())) }),
            /too frequent/);
        expect(JSON.parse(lineup(test, s.lobbyId, 'Blue').groups)).toEqual(halves(blueNames()));

        // The spectator referee (host) may arrange either team; no step is logged for an arrangement.
        arrange(s, s.host, 'Blue', [blueNames().slice(4, 8), blueNames().slice(0, 4)]);
        expect(JSON.parse(lineup(test, s.lobbyId, 'Blue').groups)).toEqual([blueNames().slice(4, 8), blueNames().slice(0, 4)]);
        advance(test, 300);
        arrange(s, s.host, 'Red', halves(redNames()));
        expect(lineup(test, s.lobbyId, 'Red')).toBeDefined();
        expect(steps(test, s.lobbyId).filter((st) => st.action.tag === 'ArrangeLineup')).toHaveLength(0);
    });

    it('Auction: a lineup whose surcharge exceeds the remaining budget can be arranged, but confirm_game is rejected (A60(4))', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertSynergy(test, 'blue-1', 'blue-2', 500, 'Auction'); // 500 > 100 + 50 carried budget
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
        draftAuction(s, blueNames(), redNames());
        const blueCap = captain(s, 'Blue');

        arrange(s, blueCap, 'Blue', halves(blueNames())); // allowed while arranging
        arrange(s, captain(s, 'Red'), 'Red', halves(redNames()));
        expect(lineup(test, s.lobbyId, 'Blue').synergySurcharge).toBe(H(500));
        recordScores(s, s.host, 'Blue', [H(5), H(5)]);
        recordScores(s, s.host, 'Red', [H(6), H(6)]);
        expectReject(test, blueCap, (ctx) => M.confirm_game(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' } }),
            'The synergy surcharge exceeds the remaining budget; rearrange the lineup.');

        advance(test, 300);
        arrange(s, blueCap, 'Blue', [['blue-1', 'blue-3', 'blue-4', 'blue-5'], ['blue-2', 'blue-6', 'blue-7', 'blue-8']]);
        confirmGame(s, blueCap, 'Blue');
        expect(game(test, record(test, s.lobbyId).id).blueConfirmed).toBe(true);
    });
});

describe('CH-S6 / D.8.7: eidolon snapshot', () => {
    it('requireOwnership on: the pick eidolon is the max over the selected accounts, the argument is ignored', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { requireOwnership: true } });
        const blueCap = captain(s, 'Blue');
        selectAccount(test, s.lobbyId, blueCap.userId, 900, { 'blue-1': 6 });
        selectAccount(test, s.lobbyId, blueCap.userId, 901, { 'blue-1': 3 });
        tx(test, blueCap, (ctx) => (priceCharacters(ctx, s.lobbyId, ['blue-1']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 0 })));
        const pick = steps(test, s.lobbyId).find((st) => st.action.tag === 'Pick')!;
        expect((pick.payload.value as { eidolon: number }).eidolon).toBe(6);
    });

    it('requireOwnership off: the argument stands', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), (ctx) => (priceCharacters(ctx, s.lobbyId, ['blue-1']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 4 })));
        const pick = steps(test, s.lobbyId).find((st) => st.action.tag === 'Pick')!;
        expect((pick.payload.value as { eidolon: number }).eidolon).toBe(4);
    });
});

describe('A21: the lineup format is the character count', () => {
    it('a Classic Thirds lobby drafts 12 per team and arranges 3 groups of 4', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(12), ...redNames(12)]);
        const s = setupLobby(test, { lobby: { lineupFormat: { tag: 'Thirds' } } });
        const seq = session(test, s.lobbyId).draftSequence;
        expect(seq.filter((st) => st.teamTurn.tag === 'Blue' && st.actionRequired.tag === 'Pick')).toHaveLength(12);
        expect(seq.filter((st) => st.teamTurn.tag === 'Red' && st.actionRequired.tag === 'Pick')).toHaveLength(12);
        draftClassic(s, blueNames(12), redNames(12));
        const b = blueNames(12);
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' }, groups: JSON.stringify(halves(b)) }),
            'A Thirds lineup has 3 groups.');
        arrange(s, captain(s, 'Blue'), 'Blue', [b.slice(0, 4), b.slice(4, 8), b.slice(8, 12)]);
        expect(JSON.parse(lineup(test, s.lobbyId, 'Blue').groups)).toHaveLength(3);
    });

    it('an Auction Thirds lobby ends the auction at 12 characters per team', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' }, lineupFormat: { tag: 'Thirds' } } });
        draftAuction(s, blueNames(12), redNames(12));
        expect(session(test, s.lobbyId).blueCharactersWon).toBe(12);
        expect(session(test, s.lobbyId).redCharactersWon).toBe(12);
    });
});

describe('A56(3): hardDeleteLobby deletes the scoring rows', () => {
    it('group scores, adjustments and lineups go with the lobby', () => {
        const test = newHarness();
        const s = playToScoring(test);
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
        tx(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Red' }, value: 100 }));
        const recId = record(test, s.lobbyId).id;
        expect(test.db.MatchLineup.count()).toBe(2n);
        expect(test.db.MatchResultGroupScore.count()).toBe(2n);
        expect(test.db.MatchResultAdjustment.count()).toBe(1n);

        tx(test, 'internal', (ctx) => hardDeleteLobby(ctx, s.lobbyId));
        expect(test.db.MatchLineup.count()).toBe(0n);
        expect(test.db.MatchResultGroupScore.count()).toBe(0n);
        expect(test.db.MatchResultAdjustment.count()).toBe(0n);
        expect(test.db.MatchResultRecord.id.find(recId)).toBeNull();
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeNull();
    });
});

describe('review fix: light cones equipped after a confirmation (A60(2))', () => {
    it('an equip after both confirmations resets both flags, refreshes the roster cost, and the closed game uses it', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertLightconeCost(test, 'lc-1', 3);
        const s = setupLobby(test);
        draftClassic(s, blueNames(), redNames());
        for (const team of ['Blue', 'Red'] as const) {
            arrange(s, captain(s, team), team, halves(team === 'Blue' ? blueNames() : redNames()));
        }
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(5), H(5)]);
        const rec = record(test, s.lobbyId);
        // Identical scores and rosters: a level-4 tie, so both confirmations leave the game open (A60(3)).
        confirmBoth(s);
        expect(game(test, rec.id).blueConfirmed && game(test, rec.id).redConfirmed).toBe(true);

        advance(test, 300); // A78(3): the Blue captain's arrange_lineup stamped the lineup throttle
        equip(s, captain(s, 'Blue'), 'Blue', 'blue-1', 'lc-1'); // allowed in Scoring (A60(1))
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(3));
        const g = game(test, rec.id);
        expect(g.blueConfirmed).toBe(false); // every edit resets both flags (A60(2))
        expect(g.redConfirmed).toBe(false);
        expect(g.tieBreakLevel).toBe(1);
        expect(g.winnerTeamSide.tag).toBe('Red');

        confirmAndClose(s); // A63: both ready, a captain submits; the casual Bo1 finalizes
        const history = [...test.db.MatchSessionHistory.iter()][0];
        const gh = [...test.db.MatchResultGameHistory.by_match_history.filter(history.id)][0];
        expect(gh.tieBreakLevel).toBe(1); // Blue's light cone made Blue the costlier roster
        expect(gh.winnerTeamSide.tag).toBe('Red');
        const blueLineup = [...test.db.MatchLineupHistory.by_match_history.filter(history.id)].find((l) => l.teamSide.tag === 'Blue')!;
        expect(blueLineup.rosterCost).toBe(H(3));
    });

    it('Auction: a team that spends its light-cone budget below its surcharge cannot confirm until it rearranges', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertSynergy(test, 'blue-1', 'blue-2', 100, 'Auction'); // LC budget after the auction: 100 + 50 = 150
        insertLightconeCost(test, 'lc-60', 60);
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
        draftAuction(s, blueNames(), redNames());
        const blueCap = captain(s, 'Blue');
        arrange(s, blueCap, 'Blue', halves(blueNames()));
        arrange(s, captain(s, 'Red'), 'Red', halves(redNames()));
        recordScores(s, s.host, 'Blue', [H(5), H(5)]);
        recordScores(s, s.host, 'Red', [H(6), H(6)]);

        // No reservation any more (A60(8)): the equip goes through and leaves 90 < the 100 surcharge.
        advance(test, 300); // A78(3): the Blue captain's arrange_lineup stamped the lineup throttle
        equip(s, blueCap, 'Blue', 'blue-1', 'lc-60');
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(90);
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(160));
        expectReject(test, blueCap, (ctx) => M.confirm_game(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' } }),
            'The synergy surcharge exceeds the remaining budget; rearrange the lineup.');
        // The full-control referee cannot close it either (the gate covers both teams).
        expectReject(test, s.host, (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }),
            'The synergy surcharge exceeds the remaining budget; rearrange the lineup.');

        advance(test, 300);
        arrange(s, blueCap, 'Blue', [['blue-1', 'blue-3', 'blue-4', 'blue-5'], ['blue-2', 'blue-6', 'blue-7', 'blue-8']]);
        confirmGame(s, blueCap, 'Blue');
        expect(game(test, record(test, s.lobbyId).id).blueConfirmed).toBe(true);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
    });
});
