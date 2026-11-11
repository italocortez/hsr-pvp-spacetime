// Match session: one game per lobby; draft steps and edit reducers without game numbers.
// Decisions: A67
// Contracts: docs/match-session/contract.md
// From S8e (s8e-steps.test.ts).
//
// T-S8e: in-memory tests for the draft steps of the one game a lobby hosts (A67(1)(3); replaces T-S8d's
// s8d-series-steps, whose subject, whole-series steps (A65), is superseded). One lobby = one game: MatchSessionStep
// rows carry no gameNumber; undo, the ban restriction and the auto-resume read the lobby's steps; finalization archives
// them keyed (matchHistoryId, sequence); view_my_match_steps has no gameNumber; the trailing gameNumber argument of the
// edit reducers is gone. S7b hand-offs (equip_lightcone checks the caller's draft; unequip_lightcone) and the reducer
// surface are kept. Builders in s4 / s7 / s8d fixtures. Nothing reaches maincloud.
//
// Deleted from s8d-series-steps (subject gone): "game-1 steps survive advance_to_next_game", "undo at the start of
// game 2", "Auction: game 2 opens a fresh nomination phase", "finalization archives both games", the A65(4)
// earlier-game edit tests (scores / adjustments / eidolon / light cone / lineup on game 1 after game 2 started; the
// current-game message; gameNumber omitted = the current game). Admin edits of the closed game live in
// s7b-game-package (A60(7)).
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    priceBanNames,
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
    type Harness,
    priceCharacters,
    priceLightcones,
} from '../fixtures/harness';
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
    side,
    unequip,
} from '../fixtures/draft-and-scoring';
import { draftGame } from '../fixtures/tournament-matches';
import { teamDraft } from '@module/helpers/results/scoringHelpers';

const picksOf = (test: Harness, lobbyId: number) => steps(test, lobbyId).filter((x) => x.action.tag === 'Pick');

/** A Ranked lobby (one account per player, D-08): its close submits and parks it, so the live steps stay readable. */
const makeRanked = (test: Harness) => (l: { lobbyId: number; a: Record<string, { userId: number }> }) => {
    test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
    let accountId = 700;
    for (const name of ['b1', 'b2', 'r1', 'r2']) {
        test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[name].userId, hsrAccountId: accountId++ });
    }
};

type ArgsOf<F> = F extends (ctx: any, args: infer A) => any ? A : never;

// ─── A67(3): the lobby's steps ────────────────────────────────────────────────

describe('A67(3): one game per lobby, steps without game numbers', () => {
    it('16 picks reach Equipping; no step carries gameNumber; sequences increase; the close logs one ConfirmGame', () => {
        const test = newHarness();
        const s = setupLobby(test, { beforeStart: makeRanked(test) });
        draftGame(s, 'a');
        expect(picksOf(test, s.lobbyId)).toHaveLength(16);
        const all = steps(test, s.lobbyId).sort((a, b) => a.sequence - b.sequence);
        expect(all.every((x) => !('gameNumber' in x))).toBe(true);
        expect(new Set(all.map((x) => x.sequence)).size).toBe(all.length);
        finishGame(s, 'Blue');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const confirms = steps(test, s.lobbyId).filter((x) => x.action.tag === 'ConfirmGame');
        expect(confirms).toHaveLength(1);
        expect(confirms[0].sequence).toBeGreaterThan(Math.max(...all.map((x) => x.sequence)));
    });

    it('undo_last_step with no step is rejected; after one pick it undoes only that pick', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expectReject(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }), /No steps to undo\.|Nothing to undo/);
        tx(test, captain(s, 'Blue'), (ctx) => (priceCharacters(ctx, s.lobbyId, ['first']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'first', eidolon: 0 })));
        tx(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }));
        expect(picksOf(test, s.lobbyId)).toHaveLength(0);
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Undo')).toHaveLength(1);
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
        expectReject(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }), /No steps to undo\.|Nothing to undo/);
    });

    it("the ban restriction counts the lobby's bans; another lobby's bans do not count", () => {
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
        const lobby = { banMode: { tag: 'Four' }, banRestriction: { tag: 'MaxOneDps' } };
        // An earlier lobby (other host, other players) in which Blue banned dps1.
        const other = setupLobby(test, { lobby, seats: [['ob1', 'BluePlayer'], ['ob2', 'BluePlayer'], ['or1', 'RedPlayer'], ['or2', 'RedPlayer']],
            actors: { host: guest(test, 'ohost') } });
        tx(test, captain(other, 'Blue'), (ctx) => (priceBanNames(ctx, other.lobbyId, ['dps1']), M.ban_character(ctx, { lobbyId: other.lobbyId, characterName: 'dps1' }))); // T-S10r (A122(7), L32): a ban names a priced character

        const s = setupLobby(test, { lobby });
        expect(session(test, s.lobbyId).draftSequence[0]).toMatchObject({ actionRequired: { tag: 'Ban' }, teamTurn: { tag: 'Blue' } });
        tx(test, captain(s, 'Blue'), (ctx) => (priceBanNames(ctx, s.lobbyId, ['dps2']), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'dps2' }))); // T-S10r (A122(7), L32): a ban names a priced character
        for (let guard = 0; guard < 30; guard++) {
            const sess = session(test, s.lobbyId);
            const step = sess.draftSequence[sess.turnIndex];
            if (step.actionRequired.tag === 'Ban' && step.teamTurn.tag === 'Blue') break;
            const who = captain(s, step.teamTurn.tag as 'Blue' | 'Red');
            const characterName = `b_${sess.turnIndex}`;
            tx(test, who, (ctx) => step.actionRequired.tag === 'Pick'
                ? (priceCharacters(ctx, s.lobbyId, [characterName]), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 }))
                : (priceBanNames(ctx, s.lobbyId, [characterName]), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName }))); // T-S10r (A122(7), L32): a ban names a priced character
        }
        expectReject(test, captain(s, 'Blue'), (ctx) => (priceBanNames(ctx, s.lobbyId, ['dps3']), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'dps3' })), /at most one DPS/); // T-S10r (A122(7), L32): a ban names a priced character
    });

    it('auto-resume on reconnect (join_lobby) reads the latest Pause of the lobby; a manual pause is not resumed', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), (ctx) => (priceCharacters(ctx, s.lobbyId, ['p']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'p', eidolon: 0 })));
        const quiet = [s.a.b1, s.a.b2].find((x) => x.userId !== captain(s, 'Blue').userId)!;
        disconnect(test, quiet);
        const row = pendingCheck(test, s.lobbyId, quiet.userId);
        advance(test, 20_000);
        fireCheck(test, row);
        const pause = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Pause');
        expect(pause).toHaveLength(1);
        expect(pause[0].payload).toMatchObject({ tag: 'Pause', value: { isAutoPause: true } });
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(true);
        connect(test, quiet);
        tx(test, quiet, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);

        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        tx(test, quiet, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(true);
    });

    it('finalization archives every live step plus the closing ConfirmGame, keyed (matchHistoryId, sequence), no gameNumber', () => {
        const test = newHarness();
        const s = setupLobby(test);
        draftGame(s, 'a');
        const live = steps(test, s.lobbyId);
        finishGame(s, 'Blue'); // casual: the close validates and finalizes inline
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(steps(test, s.lobbyId)).toHaveLength(0);
        const [history] = [...test.db.MatchSessionHistory.iter()];
        const archived = [...test.db.MatchSessionStepHistory.by_match_history.filter(history.id)];
        expect(archived.filter((x) => x.action.tag === 'Pick')).toHaveLength(16);
        expect(archived.length).toBe(live.length + 1);
        expect(archived.every((x) => !('gameNumber' in x))).toBe(true);
        const keys = archived.map((x) => `${x.matchHistoryId}:${x.sequence}`);
        expect(new Set(keys).size).toBe(archived.length); // the A67(3) PK [matchHistoryId, sequence] is unique
        const liveSeq = new Set(live.map((x) => x.sequence));
        expect(archived.filter((x) => liveSeq.has(x.sequence))).toHaveLength(live.length);
    });

    it('view_my_match_steps rows carry no gameNumber', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), (ctx) => (priceCharacters(ctx, s.lobbyId, ['v']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'v', eidolon: 0 })));
        const rows: any[] = (M as any).view_my_match_steps(test.viewContext(s.a.b1.auth), {});
        const mine = rows.filter((r) => r.lobbyId === s.lobbyId);
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.every((r) => !('gameNumber' in r))).toBe(true);
    });
});

// ─── A67(3): the removed gameNumber argument ──────────────────────────────────

describe('A67(3): the edit reducers take no gameNumber', () => {
    it('type level: set_eidolon / equip_lightcone / unequip_lightcone / arrange_lineup / record_group_scores / set_score_adjustment', () => {
        expectTypeOf<ArgsOf<typeof M.set_eidolon>>().not.toHaveProperty('gameNumber');
        expectTypeOf<ArgsOf<typeof M.equip_lightcone>>().not.toHaveProperty('gameNumber');
        expectTypeOf<ArgsOf<typeof M.unequip_lightcone>>().not.toHaveProperty('gameNumber');
        expectTypeOf<ArgsOf<typeof M.arrange_lineup>>().not.toHaveProperty('gameNumber');
        expectTypeOf<ArgsOf<typeof M.record_group_scores>>().not.toHaveProperty('gameNumber');
        expectTypeOf<ArgsOf<typeof M.set_score_adjustment>>().not.toHaveProperty('gameNumber');
        expectTypeOf<ArgsOf<typeof M.set_eidolon>>().toHaveProperty('characterName');
    });

    it('a stray gameNumber key is ignored: the edit lands on the lobby\'s one game', () => {
        const test = newHarness();
        const s = playToScoring(test);
        tx(test, s.host, (ctx) => M.record_group_scores(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), values: [H(5), H(5)], deaths: 0, gameNumber: 7 } as any));
        const rec = record(test, s.lobbyId);
        expect([...test.db.MatchResultGroupScore.by_result.filter(rec.id)]).toHaveLength(2);
        expect([...test.db.MatchResultGame.match_result_id.filter(rec.id)]).toHaveLength(1);
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

    it('equip_lightcone on a character outside the named team\'s draft is rejected (A78(2))', () => {
        const { test, s } = scoring();
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            (priceLightcones(ctx, s.lobbyId, ['lc-7']), M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: redNames()[0], lightconeName: 'lc-7', superimposition: 1 })),
            `${redNames()[0]} is not in the Blue team's draft of this game.`);
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            (priceLightcones(ctx, s.lobbyId, ['lc-7']), M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'nobody', lightconeName: 'lc-7', superimposition: 1 })),
            "nobody is not in the Blue team's draft of this game.");
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'EquipLightcone')).toHaveLength(0);
    });

    it('unequip refunds the light-cone budget, logs UnequipLightcone, teamDraft drops the light cone, confirmations reset (A78)', () => {
        const { test, s } = scoring();
        const blue = captain(s, 'Blue');
        const c = blueNames()[0];
        expectReject(test, blue, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: c }), `${c} has no light cone equipped.`);

        const start = session(test, s.lobbyId).teamBlueLcBudget; // Classic: the light-cone budget plus the unspent character budget
        equip(s, blue, 'Blue', c, 'lc-7');
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(start - 7);
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(7));
        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]);
        confirmGame(s, blue, 'Blue');
        const recId = record(test, s.lobbyId).id;
        expect(gameRow(test, recId).blueConfirmed).toBe(true);

        // A78(2): the Red captain names its own side; the character is not in Red's draft.
        expectReject(test, captain(s, 'Red'), (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), characterName: c }), `${c} is not in the Red team's draft of this game.`);
        advance(test, 300); // A78(3): the Blue captain's equip stamped the lineup throttle
        unequip(s, blue, 'Blue', c);
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(start);
        const un = steps(test, s.lobbyId).filter((x) => x.action.tag === 'UnequipLightcone');
        expect(un).toHaveLength(1);
        expect(un[0].payload).toMatchObject({ tag: 'UnequipLightcone', value: { characterName: c, lightconeName: 'lc-7', refunded: 7 } });
        expect(un[0].actorSlot.tag).toBe('Blue');
        expect(tx(test, 'internal', (ctx) => teamDraft(ctx, s.lobbyId, 'Blue').lightconeCosts)).toEqual(
            expect.not.arrayContaining([expect.objectContaining({ lightconeName: 'lc-7' })]));
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(0);
        const g = gameRow(test, recId);
        expect([g.blueConfirmed, g.redConfirmed]).toEqual([false, false]);
        advance(test, 300);
        expectReject(test, blue, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: c }), `${c} has no light cone equipped.`);
    });

    it('unequip removes the latest of two equips on the same character (one at a time)', () => {
        const { test, s } = scoring();
        insertLightconeCost(test, 'lc-3', 3);
        const blue = captain(s, 'Blue');
        const c = blueNames()[1];
        const start = session(test, s.lobbyId).teamBlueLcBudget;
        equip(s, blue, 'Blue', c, 'lc-7');
        advance(test, 300); // A78(3): lineup throttle between two edits by the same member
        equip(s, blue, 'Blue', c, 'lc-3');
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(start - 10);
        advance(test, 300);
        unequip(s, blue, 'Blue', c);
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(start - 7);
        const un = steps(test, s.lobbyId).filter((x) => x.action.tag === 'UnequipLightcone');
        expect(un[0].payload).toMatchObject({ value: { lightconeName: 'lc-3', refunded: 3 } });
    });
});

// ─── The reducer surface (S8d, S8e) ───────────────────────────────────────────

describe('reducer surface (S8d, S8e)', () => {
    it('present: validate_match_result, revoke_stand_in, unequip_lightcone, run_tournament_finalize, create_tournament_lobby, approve_stand_in', () => {
        for (const name of ['validate_match_result', 'revoke_stand_in', 'unequip_lightcone', 'run_tournament_finalize', 'create_tournament_lobby', 'approve_stand_in']) {
            expect(name in M, name).toBe(true);
            expect(typeof (M as any)[name], name).toBe('function');
        }
    });

    it('removed: process_tournament_mmr (S8d); advance_to_next_game, shelve_series, resume_series (A67(1))', () => {
        for (const name of ['process_tournament_mmr', 'advance_to_next_game', 'shelve_series', 'resume_series']) {
            expect(name in M, name).toBe(false);
            expect((M as any)[name], name).toBeUndefined();
        }
    });
});
