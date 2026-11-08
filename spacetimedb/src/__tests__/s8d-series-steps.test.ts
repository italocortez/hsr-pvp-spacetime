// T-S8d: in-memory tests for whole-series draft steps (A65, decided KEEP) and the S7b hand-offs, plus the S8d reducer
// surface. A65: advance_to_next_game keeps the earlier games' MatchSessionStep rows; the game-scoped readers (undo, ban
// restriction, auto-resume) filter by the current game; finalization archives every game; A65(4) / A60(7): an Admin
// may edit an earlier closed game (scores, adjustments, eidolons, light cones, lineups), everyone else the current
// game only. S7b hand-offs: equip_lightcone checks the caller's draft; unequip_lightcone. Builders in s4 / s7 /
// s8d fixtures. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    connect,
    disconnect,
    expectReject,
    fireCheck,
    guest,
    lobbyRow,
    newHarness,
    pendingCheck,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from './s4-fixtures';
import {
    H,
    blueNames,
    captain,
    confirmGame,
    equip,
    finishGame,
    gameRow,
    insertLightconeCost,
    lineup,
    playToScoring,
    record,
    recordScores,
    redNames,
    setRole,
    side,
} from './s7-fixtures';
import { teamDraft } from '../helpers/scoringHelpers';
import { draftGame } from './s8d-fixtures';

const CURRENT_ONLY = (n: number) => `Scores can only be entered for the current game (${n}).`;
const EARLIER_ADMIN = 'Only an Admin may edit an earlier game.';

const gameSteps = (test: Harness, lobbyId: number, gameNumber: number) => steps(test, lobbyId).filter((x) => x.gameNumber === gameNumber);
const picksOf = (test: Harness, lobbyId: number, gameNumber: number) => gameSteps(test, lobbyId, gameNumber).filter((x) => x.action.tag === 'Pick');

/** A casual Classic Bo3 (no bans), game 1 drafted and closed for Blue by the host referee, game 2 started (Drafting). */
function bo3AtGame2(test: Harness, lobby: Record<string, unknown> = {}): Lobby {
    const s = setupLobby(test, { lobby: { bestOf: 3, ...lobby } });
    draftGame(s, 'a');
    finishGame(s, 'Blue');
    expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
    tx(test, s.host, (ctx) => M.advance_to_next_game(ctx, { lobbyId: s.lobbyId }));
    expect(session(test, s.lobbyId).currentGameNumber).toBe(2);
    expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    return s;
}

function admin(test: Harness, name = 'admin'): Actor {
    const a = guest(test, name);
    setRole(test, a.userId, 'Admin');
    return a;
}

// ─── A65: steps survive the series ────────────────────────────────────────────

describe('A65: game-1 steps survive advance_to_next_game', () => {
    it('game 1 rows kept (by gameNumber); game 2 drafts from turn 0 and reaches Equipping', () => {
        const test = newHarness();
        const s = bo3AtGame2(test);
        const game1Count = gameSteps(test, s.lobbyId, 1).length;
        expect(picksOf(test, s.lobbyId, 1)).toHaveLength(16);
        expect(gameSteps(test, s.lobbyId, 1).some((x) => x.action.tag === 'ConfirmGame')).toBe(true);
        expect(gameSteps(test, s.lobbyId, 2)).toHaveLength(0);
        expect(session(test, s.lobbyId).turnIndex).toBe(0); // Classic turn state is the session's, not the step count

        draftGame(s, 'b');
        expect(picksOf(test, s.lobbyId, 2)).toHaveLength(16);
        expect(gameSteps(test, s.lobbyId, 1)).toHaveLength(game1Count);
        // Sequences keep increasing across the series (getNextSequence is lobby-wide).
        const maxG1 = Math.max(...gameSteps(test, s.lobbyId, 1).map((x) => x.sequence));
        expect(Math.min(...gameSteps(test, s.lobbyId, 2).map((x) => x.sequence))).toBeGreaterThan(maxG1);
    });

    it('undo_last_step at the start of game 2 is rejected; after one game-2 pick it undoes only that pick', () => {
        const test = newHarness();
        const s = bo3AtGame2(test);
        const game1Before = gameSteps(test, s.lobbyId, 1).length;
        expectReject(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }), /No steps to undo\.|Nothing to undo in this game\./);

        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'g2-first', eidolon: 0 }));
        tx(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }));
        expect(picksOf(test, s.lobbyId, 2)).toHaveLength(0);
        expect(gameSteps(test, s.lobbyId, 2).filter((x) => x.action.tag === 'Undo')).toHaveLength(1);
        expect(gameSteps(test, s.lobbyId, 1)).toHaveLength(game1Before);
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
        expectReject(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }), /No steps to undo\.|Nothing to undo in this game\./);
    });

    it('the ban restriction counts the current game\'s bans only', () => {
        const test = newHarness();
        tx(test, 'internal', (ctx) => {
            for (const name of ['dps1', 'dps2', 'dps3']) {
                ctx.db.HsrCharacter.insert({
                    name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Destruction' }, element: { tag: 'Ice' },
                    role: { tag: 'Dps' }, imageUrl: '', versionReleased: 1.0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
                    createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                } as any);
            }
        });
        const s = setupLobby(test, { lobby: { bestOf: 3, banMode: { tag: 'Four' }, banRestriction: { tag: 'MaxOneDps' } } });
        expect(session(test, s.lobbyId).draftSequence[0]).toMatchObject({ actionRequired: { tag: 'Ban' }, teamTurn: { tag: 'Blue' } });
        tx(test, captain(s, 'Blue'), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'dps1' }));
        draftGame(s, 'a');
        finishGame(s, 'Blue');
        tx(test, s.host, (ctx) => M.advance_to_next_game(ctx, { lobbyId: s.lobbyId }));

        // Game 2: Blue's first ban is again its first DPS ban of this game (game 1's dps1 does not count).
        tx(test, captain(s, 'Blue'), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'dps2' }));
        // Draft on to Blue's next ban turn of game 2; that second DPS ban of game 2 is rejected.
        for (let guard = 0; guard < 30; guard++) {
            const sess = session(test, s.lobbyId);
            const step = sess.draftSequence[sess.turnIndex];
            if (step.actionRequired.tag === 'Ban' && step.teamTurn.tag === 'Blue') break;
            const who = captain(s, step.teamTurn.tag as 'Blue' | 'Red');
            const characterName = `b2_${sess.turnIndex}`;
            tx(test, who, (ctx) => step.actionRequired.tag === 'Pick'
                ? M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 })
                : M.ban_character(ctx, { lobbyId: s.lobbyId, characterName }));
        }
        expectReject(test, captain(s, 'Blue'), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'dps3' }), /at most one DPS/);
    });

    it('Auction: game 2 opens a fresh nomination phase despite game 1\'s AuctionSold rows', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { bestOf: 3, draftMode: { tag: 'Auction' } } });
        const auction = (prefix: string) => {
            let guard = 0;
            while (lobbyRow(test, s.lobbyId).stage.tag === 'Drafting' && guard++ < 40) {
                const nominator = session(test, s.lobbyId).nextNominatorTeam.tag as 'Blue' | 'Red';
                tx(test, captain(s, nominator), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: `${prefix}${guard}` }));
                tx(test, captain(s, nominator === 'Blue' ? 'Red' : 'Blue'), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
            }
        };
        auction('a');
        finishGame(s, 'Blue');
        tx(test, s.host, (ctx) => M.advance_to_next_game(ctx, { lobbyId: s.lobbyId }));
        const g2 = session(test, s.lobbyId);
        expect(g2.isAuctionPhase).toBe(true);
        expect(g2.currentNomination).toBeFalsy();
        expect(gameSteps(test, s.lobbyId, 1).filter((x) => x.action.tag === 'AuctionSold')).toHaveLength(16);
        auction('b');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        expect(gameSteps(test, s.lobbyId, 2).filter((x) => x.action.tag === 'AuctionSold')).toHaveLength(16);
    });

    it('auto-resume on reconnect (join_lobby) reads the latest Pause of the current game', () => {
        const test = newHarness();
        const s = bo3AtGame2(test);
        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'g2-p', eidolon: 0 }));
        const quiet = [s.a.b1, s.a.b2].find((x) => x.userId !== captain(s, 'Blue').userId)!;
        disconnect(test, quiet);
        const row = pendingCheck(test, s.lobbyId, quiet.userId);
        advance(test, 20_000);
        fireCheck(test, row);
        const pause = gameSteps(test, s.lobbyId, 2).filter((x) => x.action.tag === 'Pause');
        expect(pause).toHaveLength(1);
        expect(pause[0].payload).toMatchObject({ tag: 'Pause', value: { isAutoPause: true } });
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(true);
        connect(test, quiet);
        tx(test, quiet, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);

        // A manual pause is not resumed by a reconnect.
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        tx(test, quiet, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(true);
    });

    it('finalization archives both games (MatchSessionStepHistory gameNumber 1 and 2); the live rows are gone', () => {
        const test = newHarness();
        const s = bo3AtGame2(test);
        draftGame(s, 'b');
        const live = steps(test, s.lobbyId);
        finishGame(s, 'Blue'); // 2-0: the deciding close finalizes the casual series inline
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(steps(test, s.lobbyId)).toHaveLength(0);
        const [history] = [...test.db.MatchSessionHistory.iter()];
        const archived = [...test.db.MatchSessionStepHistory.by_match_history.filter(history.id)];
        const g1 = archived.filter((x) => x.gameNumber === 1);
        const g2 = archived.filter((x) => x.gameNumber === 2);
        expect(g1.filter((x) => x.action.tag === 'Pick')).toHaveLength(16);
        expect(g2.filter((x) => x.action.tag === 'Pick')).toHaveLength(16);
        // Every live step plus the deciding ConfirmGame is archived, keyed (game, sequence) as landed.
        expect(archived.length).toBe(live.length + 1);
        const liveSeq = new Set(live.map((x) => `${x.gameNumber}:${x.sequence}`));
        expect(archived.filter((x) => liveSeq.has(`${x.gameNumber}:${x.sequence}`))).toHaveLength(live.length);
    });

    it('view_my_match_steps rows carry gameNumber', () => {
        const test = newHarness();
        const s = bo3AtGame2(test);
        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'g2-v', eidolon: 0 }));
        // The exported view is callable with the harness's viewContext (as the caller b1, a lobby member).
        const rows: any[] = (M as any).view_my_match_steps(test.viewContext(s.a.b1.auth), {});
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => typeof r.gameNumber === 'number')).toBe(true);
        const games = new Set(rows.filter((r) => r.lobbyId === s.lobbyId).map((r) => r.gameNumber));
        expect(games).toEqual(new Set([1, 2]));
    });
});

// ─── A65(4) / A60(7): earlier-game edits ──────────────────────────────────────

describe('A65(4): scores and adjustments on game 1 after game 2 started', () => {
    it('Admin: record_group_scores on game 1 accepted; the game recomputed and the tally rewritten', () => {
        const test = newHarness();
        const s = bo3AtGame2(test);
        const rec = record(test, s.lobbyId);
        expect(gameRow(test, rec.id, 1).winnerTeamSide.tag).toBe('Blue');
        expect([session(test, s.lobbyId).gamesWonBlue, session(test, s.lobbyId).gamesWonRed]).toEqual([1, 0]);
        const adm = admin(test);
        tx(test, adm, (ctx) => M.record_group_scores(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Blue'), values: [H(30), H(30)], deaths: 0 }));
        expect(gameRow(test, rec.id, 1).winnerTeamSide.tag).toBe('Red');
        expect([session(test, s.lobbyId).gamesWonBlue, session(test, s.lobbyId).gamesWonRed]).toEqual([0, 1]);
        expect(session(test, s.lobbyId).currentGameNumber).toBe(2);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');

        tx(test, adm, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Red'), value: H(100), reason: 'penalty' }));
        expect([...test.db.MatchResultAdjustment.iter()].length).toBeGreaterThan(0);
        expect(gameRow(test, rec.id, 1).winnerTeamSide.tag).toBe('Blue'); // Red's +100 cycles flips it back
        expect([session(test, s.lobbyId).gamesWonBlue, session(test, s.lobbyId).gamesWonRed]).toEqual([1, 0]);
    });

    it('Moderator, referee and captain rejected on game 1 with the current-game message; game 3 rejected for everyone', () => {
        const test = newHarness();
        const s = bo3AtGame2(test);
        const mod = guest(test, 'mod');
        setRole(test, mod.userId, 'Moderator');
        const adm = admin(test);
        const scores = (gameNumber: number) => ({ lobbyId: s.lobbyId, gameNumber, teamSide: side('Blue'), values: [H(30), H(30)], deaths: 0 });
        expectReject(test, captain(s, 'Blue'), (ctx) => M.record_group_scores(ctx, scores(1)), CURRENT_ONLY(2));
        expectReject(test, s.host, (ctx) => M.record_group_scores(ctx, scores(1)), CURRENT_ONLY(2));
        expectReject(test, mod, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Red'), value: H(1) }), CURRENT_ONLY(2));
        expectReject(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Red'), value: H(1) }), CURRENT_ONLY(2));
        expectReject(test, adm, (ctx) => M.record_group_scores(ctx, scores(3)), CURRENT_ONLY(2));
        expectReject(test, adm, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 3, teamSide: side('Red'), value: H(1) }), CURRENT_ONLY(2));
        expect(gameRow(test, record(test, s.lobbyId).id, 1).winnerTeamSide.tag).toBe('Blue');
    });
});

describe('A65(4): set_eidolon / equip_lightcone / unequip_lightcone / arrange_lineup with an earlier gameNumber', () => {
    function game2WithLightcone() {
        const test = newHarness();
        insertLightconeCost(test, 'lc-5', 5);
        const s = bo3AtGame2(test, { lightconeBudget: 50 });
        const g1Blue = tx(test, 'internal', (ctx) => teamDraft(ctx, s.lobbyId, 1, 'Blue').characters);
        return { test, s, g1Blue, adm: admin(test) };
    }

    it('Admin accepted on the closed game 1 (steps logged with gameNumber 1, no budget charged); non-admin rejected', () => {
        const { test, s, g1Blue, adm } = game2WithLightcone();
        const budgetBefore = session(test, s.lobbyId).teamBlueLcBudget;
        const c = g1Blue[0];

        expectReject(test, s.host, (ctx) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: c, eidolon: 2, gameNumber: 1 }), EARLIER_ADMIN);
        tx(test, adm, (ctx) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: c, eidolon: 2, gameNumber: 1 }));
        const eid = gameSteps(test, s.lobbyId, 1).filter((x) => x.action.tag === 'SetEidolon');
        expect(eid).toHaveLength(1);
        expect(tx(test, 'internal', (ctx) => teamDraft(ctx, s.lobbyId, 1, 'Blue').eidolons.find((e) => e.name === c)?.eidolon)).toBe(2);

        expectReject(test, captain(s, 'Blue'), (ctx) => M.equip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: c, lightconeName: 'lc-5', superimposition: 1, gameNumber: 1 }), EARLIER_ADMIN);
        tx(test, adm, (ctx) => M.equip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: c, lightconeName: 'lc-5', superimposition: 1, gameNumber: 1 }));
        expect(gameSteps(test, s.lobbyId, 1).filter((x) => x.action.tag === 'EquipLightcone')).toHaveLength(1);
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(budgetBefore); // earlier game: no budget

        expectReject(test, s.host, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: c, gameNumber: 1 }), EARLIER_ADMIN);
        tx(test, adm, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: c, gameNumber: 1 }));
        const un = gameSteps(test, s.lobbyId, 1).filter((x) => x.action.tag === 'UnequipLightcone');
        expect(un).toHaveLength(1);
        expect(un[0].payload).toMatchObject({ tag: 'UnequipLightcone', value: { characterName: c, lightconeName: 'lc-5', refunded: 5 } });
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(budgetBefore);

        const regrouped = [g1Blue.slice(4, 8), g1Blue.slice(0, 4)];
        expectReject(test, s.host, (ctx) => M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), groups: JSON.stringify(regrouped), gameNumber: 1 }), EARLIER_ADMIN);
        tx(test, adm, (ctx) => M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), groups: JSON.stringify(regrouped), gameNumber: 1 }));
        const groups = lineup(test, s.lobbyId, 'Blue', 1).groups as unknown;
        expect(typeof groups === 'string' ? JSON.parse(groups) : groups).toEqual(regrouped);

        // A later game, or a game that does not exist yet, is rejected even for an Admin.
        expectReject(test, adm, (ctx) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: c, eidolon: 3, gameNumber: 3 }),
            'Only a closed earlier game of the series can be edited.');
    });

    it('gameNumber omitted = the current game (game 2)', () => {
        const { test, s } = game2WithLightcone();
        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'g2-e', eidolon: 0 }));
        advance(test, 300);
        tx(test, s.host, (ctx) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'g2-e', eidolon: 1 }));
        const eid = steps(test, s.lobbyId).filter((x) => x.action.tag === 'SetEidolon');
        expect(eid).toHaveLength(1);
        expect(eid[0].gameNumber).toBe(2);
        // Passing the current game explicitly is the same path.
        advance(test, 300);
        tx(test, s.host, (ctx) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'g2-e', eidolon: 2, gameNumber: 2 }));
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'SetEidolon' && x.gameNumber === 2)).toHaveLength(2);
    });
});

// ─── S7b hand-offs: equip_lightcone draft check, unequip_lightcone ────────────

describe('S7b hand-offs: equip_lightcone checks the draft; unequip_lightcone', () => {
    function scoring() {
        const test = newHarness();
        insertLightconeCost(test, 'lc-7', 7);
        const s = playToScoring(test, { lobby: { lightconeBudget: 50 } });
        return { test, s };
    }

    it('equip_lightcone on a character outside the caller\'s team draft is rejected', () => {
        const { test, s } = scoring();
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            M.equip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: redNames()[0], lightconeName: 'lc-7', superimposition: 1 }),
            `${redNames()[0]} is not in your team's draft of this game.`);
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            M.equip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: 'nobody', lightconeName: 'lc-7', superimposition: 1 }),
            "nobody is not in your team's draft of this game.");
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'EquipLightcone')).toHaveLength(0);
    });

    it('unequip refunds the light-cone budget, logs UnequipLightcone, teamDraft drops the light cone, confirmations reset', () => {
        const { test, s } = scoring();
        const blue = captain(s, 'Blue');
        const c = blueNames()[0];
        expectReject(test, blue, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: c }), `${c} has no light cone equipped.`);

        const start = session(test, s.lobbyId).teamBlueLcBudget; // Classic: the light-cone budget plus the unspent character budget
        equip(s, blue, c, 'lc-7');
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(start - 7);
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(7));
        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]);
        confirmGame(s, blue, 'Blue');
        const recId = record(test, s.lobbyId).id;
        expect(gameRow(test, recId).blueConfirmed).toBe(true);

        // Red's captain cannot unequip a Blue character (the caller's own draft only).
        expectReject(test, captain(s, 'Red'), (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: c }), `${c} is not in your team's draft of this game.`);
        tx(test, blue, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: c }));
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(start);
        const un = steps(test, s.lobbyId).filter((x) => x.action.tag === 'UnequipLightcone');
        expect(un).toHaveLength(1);
        expect(un[0].payload).toMatchObject({ tag: 'UnequipLightcone', value: { characterName: c, lightconeName: 'lc-7', refunded: 7 } });
        expect(un[0].actorSlot.tag).toBe('Blue');
        expect(tx(test, 'internal', (ctx) => teamDraft(ctx, s.lobbyId, 1, 'Blue').lightconeCosts)).toEqual(
            expect.not.arrayContaining([expect.objectContaining({ lightconeName: 'lc-7' })]));
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(0);
        const g = gameRow(test, recId);
        expect([g.blueConfirmed, g.redConfirmed]).toEqual([false, false]);
        expectReject(test, blue, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: c }), `${c} has no light cone equipped.`);
    });

    it('unequip removes the latest of two equips on the same character (one at a time)', () => {
        const { test, s } = scoring();
        insertLightconeCost(test, 'lc-3', 3);
        const blue = captain(s, 'Blue');
        const c = blueNames()[1];
        const start = session(test, s.lobbyId).teamBlueLcBudget;
        equip(s, blue, c, 'lc-7');
        equip(s, blue, c, 'lc-3');
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(start - 10);
        tx(test, blue, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, characterName: c }));
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(start - 7);
        const un = steps(test, s.lobbyId).filter((x) => x.action.tag === 'UnequipLightcone');
        expect(un[0].payload).toMatchObject({ value: { lightconeName: 'lc-3', refunded: 3 } });
    });
});

// ─── The reducer surface (S8d) ────────────────────────────────────────────────

describe('S8d reducer surface', () => {
    it('present: validate_match_result, revoke_stand_in, unequip_lightcone, run_tournament_finalize, create_tournament_lobby, approve_stand_in', () => {
        for (const name of ['validate_match_result', 'revoke_stand_in', 'unequip_lightcone', 'run_tournament_finalize', 'create_tournament_lobby', 'approve_stand_in']) {
            expect(name in M, name).toBe(true);
            expect(typeof (M as any)[name], name).toBe('function');
        }
    });

    it('removed: process_tournament_mmr', () => {
        expect('process_tournament_mmr' in M).toBe(false);
        expect((M as any).process_tournament_mmr).toBeUndefined();
    });
});

