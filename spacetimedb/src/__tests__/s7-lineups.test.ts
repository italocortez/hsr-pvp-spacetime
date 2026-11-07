// T-S7(b): in-memory tests for the S7 lineups (backlog #3, A21, A56), the eidolon snapshot (CH-S6, D.8.7), the
// format-driven character count (Thirds = 12 picks per team) and the hardDeleteLobby cleanup. TestClock throughout.
import { describe, expect, it } from 'vitest';
import { hardDeleteLobby } from '../reducers/lobbyGc';
import { M, advance, expectReject, newHarness, session, setupLobby, steps, tx } from './s4-fixtures';
import {
    H,
    arrange,
    blueNames,
    captain,
    confirm,
    draftAuction,
    draftClassic,
    equip,
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

    it('only the captain of that team or a referee arranges; throttled; arranging a confirmed lineup clears it', () => {
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
        confirm(s, blueCap, 'Blue');
        expect(lineup(test, s.lobbyId, 'Blue').isConfirmed).toBe(true);
        const confirmStep = steps(test, s.lobbyId).find((st) => st.action.tag === 'ConfirmLineup')!;
        expect(confirmStep.actorSlot.tag).toBe('Blue');
        expect(JSON.parse((confirmStep.payload.value as { groups: string }).groups)).toEqual(halves(blueNames()));

        // The spectator referee (host) may arrange either team; that clears Blue's confirmation.
        arrange(s, s.host, 'Blue', [blueNames().slice(4, 8), blueNames().slice(0, 4)]);
        expect(lineup(test, s.lobbyId, 'Blue').isConfirmed).toBe(false);
        expect(steps(test, s.lobbyId).filter((st) => st.action.tag === 'ArrangeLineup')).toHaveLength(0);
    });

    it('Auction: a lineup whose surcharge exceeds the remaining light-cone budget cannot be confirmed', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertSynergy(test, 'blue-1', 'blue-2', 500, 'Auction'); // 500 > 100 + 50 carried budget
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
        draftAuction(s, blueNames(), redNames());
        const blueCap = captain(s, 'Blue');

        arrange(s, blueCap, 'Blue', halves(blueNames())); // allowed while arranging
        expect(lineup(test, s.lobbyId, 'Blue').synergySurcharge).toBe(H(500));
        expectReject(test, blueCap, (ctx) => M.confirm_lineup(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' } }),
            /exceeds the remaining light-cone budget/);

        advance(test, 300);
        arrange(s, blueCap, 'Blue', [['blue-1', 'blue-3', 'blue-4', 'blue-5'], ['blue-2', 'blue-6', 'blue-7', 'blue-8']]);
        confirm(s, blueCap, 'Blue');
        expect(lineup(test, s.lobbyId, 'Blue').isConfirmed).toBe(true);
    });
});

describe('CH-S6 / D.8.7: eidolon snapshot', () => {
    it('requireOwnership on: the pick eidolon is the max over the selected accounts, the argument is ignored', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { requireOwnership: true } });
        const blueCap = captain(s, 'Blue');
        selectAccount(test, s.lobbyId, blueCap.userId, 900, { 'blue-1': 6 });
        selectAccount(test, s.lobbyId, blueCap.userId, 901, { 'blue-1': 3 });
        tx(test, blueCap, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 0 }));
        const pick = steps(test, s.lobbyId).find((st) => st.action.tag === 'Pick')!;
        expect((pick.payload.value as { eidolon: number }).eidolon).toBe(6);
    });

    it('requireOwnership off: the argument stands', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 4 }));
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
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: { tag: 'Red' }, value: 100 }));
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

describe('review fix: light cones equipped after confirm_lineup', () => {
    it('an equip after confirm updates the lineup roster cost and the submitted game uses it', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertLightconeCost(test, 'lc-1', 3);
        const s = setupLobby(test);
        draftClassic(s, blueNames(), redNames());
        for (const team of ['Blue', 'Red'] as const) {
            arrange(s, captain(s, team), team, halves(team === 'Blue' ? blueNames() : redNames()));
            confirm(s, captain(s, team), team);
        }
        equip(s, captain(s, 'Blue'), 'blue-1', 'lc-1');
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(3));
        expect(lineup(test, s.lobbyId, 'Blue').isConfirmed).toBe(true);

        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(5), H(5)]);
        const rec = record(test, s.lobbyId);
        tx(test, captain(s, 'Blue'), (ctx) => M.confirm_match_scores(ctx, { matchResultId: rec.id }));
        tx(test, captain(s, 'Red'), (ctx) => M.confirm_match_scores(ctx, { matchResultId: rec.id }));
        tx(test, s.host, (ctx) => M.submit_match_result(ctx, { matchResultId: rec.id }));
        const history = [...test.db.MatchSessionHistory.iter()][0];
        const gh = [...test.db.MatchResultGameHistory.by_match_history.filter(history.id)][0];
        expect(gh.tieBreakLevel).toBe(1); // Blue's light cone made Blue the costlier roster
        expect(gh.winnerTeamSide.tag).toBe('Red');
        const blueLineup = [...test.db.MatchLineupHistory.by_match_history.filter(history.id)].find((l) => l.teamSide.tag === 'Blue')!;
        expect(blueLineup.rosterCost).toBe(H(3));
    });

    it('Auction: an equip that would eat the confirmed lineup\'s reserved surcharge is rejected', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertSynergy(test, 'blue-1', 'blue-2', 100, 'Auction'); // LC budget after the auction: 100 + 50 = 150
        insertLightconeCost(test, 'lc-60', 60);
        insertLightconeCost(test, 'lc-50', 50);
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
        draftAuction(s, blueNames(), redNames());
        const blueCap = captain(s, 'Blue');
        arrange(s, blueCap, 'Blue', halves(blueNames()));
        confirm(s, blueCap, 'Blue');

        expectReject(test, blueCap, (ctx) =>
            M.equip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', lightconeName: 'lc-60', superimposition: 1 }),
            /synergy surcharge is reserved/);
        equip(s, blueCap, 'blue-1', 'lc-50'); // 50 + 100 = 150: fits exactly
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(150));
    });
});
