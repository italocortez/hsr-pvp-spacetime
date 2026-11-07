// T-S4: in-memory tests for the S4 lobby / draft fixes (BACKEND-BUGS F1, F3, F6, F7, F8, F9; DECISIONS A22(2)-(4)).
// Replaces the "NOT COVERED: requires clientDisconnected to fire" gap of test/backend/lobby/disconnect-concede.test.ts.
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    captainOf,
    connect,
    disconnect,
    expectReject,
    guest,
    lobbyRow,
    member,
    newHarness,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Lobby,
} from './s4-fixtures';

const NOT_ELIGIBLE = /Opposing team is not eligible for forfeit/;
const rejoin = (s: Lobby, who: Actor) =>
    tx(s.test, who, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
const actorOf = (s: Lobby, userId: number) => Object.values(s.a).find((x) => x.userId === userId)!;
const blueCaptain = (s: Lobby) => actorOf(s, captainOf(s.test, s.lobbyId, 'BluePlayer')!.userId);
const redCaptain = (s: Lobby) => actorOf(s, captainOf(s.test, s.lobbyId, 'RedPlayer')!.userId);

describe('F1 / A22(2): reconnect', () => {
    it('join_lobby by a disconnected member in Drafting: accepted, online, disconnectedAt cleared, pool charged', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const b1 = s.a.b1;
        disconnect(test, b1);
        expect(member(test, s.lobbyId, b1.userId).disconnectedAt).toBeDefined();
        advance(test, 5_000);

        rejoin(s, b1);
        const m = member(test, s.lobbyId, b1.userId);
        expect(m.isOnline).toBe(true);
        expect(m.disconnectedAt).toBeUndefined();
        expect(m.disconnectPoolRemainingMs).toBe(300_000 - 5_000);
    });

    it('join_lobby by a disconnected member in Waiting: accepted, online', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        disconnect(test, s.a.b1);
        expect(member(test, s.lobbyId, s.a.b1.userId).isOnline).toBe(false);

        rejoin(s, s.a.b1);
        const m = member(test, s.lobbyId, s.a.b1.userId);
        expect(m.isOnline).toBe(true);
        expect(m.disconnectedAt).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
    });

    it('client_connected alone restores the membership (Drafting and Waiting)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        disconnect(test, s.a.b2);
        advance(test, 3_000);
        connect(test, s.a.b2);
        const m = member(test, s.lobbyId, s.a.b2.userId);
        expect(m.isOnline).toBe(true);
        expect(m.disconnectedAt).toBeUndefined();
        expect(m.disconnectPoolRemainingMs).toBe(300_000 - 3_000);

        const test2 = newHarness();
        const w = setupLobby(test2, { noStart: true });
        disconnect(test2, w.a.r1);
        connect(test2, w.a.r1);
        expect(member(test2, w.lobbyId, w.a.r1.userId).isOnline).toBe(true);
    });

    it('claim_forfeit against a team whose player reconnected is rejected', () => {
        const test = newHarness();
        // Host plays Red, so there is no exclusive spectator referee and players may claim (D-81).
        const s = setupLobby(test, {
            hostSlot: 'RedPlayer',
            seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer']],
        });
        disconnect(test, s.a.b1);
        disconnect(test, s.a.b2);
        advance(test, 61_000); // past disconnectForfeitSeconds (60)

        // Blue is eligible at this point (the F7 test proves the success path with the same timing);
        // one Blue player reconnecting must close it.
        rejoin(s, s.a.b1);
        expectReject(test, s.a.r1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }), NOT_ELIGIBLE);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });
});

describe('F3 / A22(3): expiry and draft actions are gated', () => {
    it('a non-member cannot fire timer_expiry_classic', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const outsider = guest(test, 'outsider');
        advance(test, 31_000);
        expectReject(test, outsider, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }), /not a member/i);
        expect(steps(test, s.lobbyId)).toHaveLength(0);
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
    });

    it('Classic, paused: timer_expiry_classic, pick_character, ban_character → "Draft is paused."', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        advance(test, 31_000);

        expectReject(test, s.a.b1, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }), 'Draft is paused.');
        expectReject(test, blueCaptain(s), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'Acheron', eidolon: 0 }), 'Draft is paused.');
        expectReject(test, blueCaptain(s), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'Acheron' }), 'Draft is paused.');
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
    });

    it('Auction, paused: nominate_character, place_bid, pass_bid, timer_expiry_auction → "Draft is paused."', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
        expect(session(test, s.lobbyId).isAuctionPhase).toBe(true);
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        advance(test, 31_000);

        const cap = blueCaptain(s);
        expectReject(test, cap, (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'Acheron', eidolon: 0 }), 'Draft is paused.');
        expectReject(test, cap, (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }), 'Draft is paused.');
        expectReject(test, cap, (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }), 'Draft is paused.');
        expectReject(test, cap, (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }), 'Draft is paused.');
    });
});

describe('F6: host leaves mid-draft', () => {
    it('the host flag goes to the new host and is not written back to the leaver', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        tx(test, s.host, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));

        const lobby = lobbyRow(test, s.lobbyId);
        expect(lobby.hostUserId).not.toBe(s.host.userId);
        // transferReferee hands the flag to b1 (lowest eligible userId), then transferHost prefers the referee.
        expect(lobby.hostUserId).toBe(s.a.b1.userId);
        expect(lobby.stage.tag).toBe('Drafting');
        expect(member(test, s.lobbyId, s.host.userId).voluntarilyLeft).toBe(true);
    });
});

describe('F7: claim_forfeit forfeitingTeamSide', () => {
    it('exclusive referee: 0 and 3 rejected; 1 reaches the eligibility gate, then succeeds once Blue is gone 60 s', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const claim = (side: number) => (ctx: any) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: side });

        expectReject(test, s.host, claim(0), 'Referee must specify forfeitingTeamSide');
        expectReject(test, s.host, claim(3), /forfeitingTeamSide must be 0/);
        expectReject(test, s.host, claim(1), NOT_ELIGIBLE);
        expectReject(test, s.host, claim(2), NOT_ELIGIBLE);

        disconnect(test, s.a.b1);
        disconnect(test, s.a.b2);
        advance(test, 61_000);
        tx(test, s.host, claim(1));

        // A casual non-tournament concede finalizes inline: runFinalization hard-deletes the lobby.
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeNull();
    });
});

describe('F8 / A22(4): result reducers in AwaitingResult', () => {
    function toAwaitingResult() {
        const test = newHarness();
        const s = setupLobby(test);
        for (let i = 0; i < 3; i++) tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const record = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0];
        expect(record.status.tag).toBe('Pending');
        return { test, s, recordId: record.id };
    }
    const scores = (matchResultId: number) => ({
        matchResultId,
        gameNumber: 1,
        winnerTeamSide: 'Blue',
        teamBlueCyclesUsed: 10,
        teamRedCyclesUsed: 12,
        teamBlueScore: undefined,
        teamRedScore: undefined,
        teamBlueBoss1Score: undefined,
        teamBlueBoss2Score: undefined,
        teamRedBoss1Score: undefined,
        teamRedBoss2Score: undefined,
        teamBlueScreenshotUrl: undefined,
        teamRedScreenshotUrl: undefined,
    });

    it('record_game_scores, confirm_match_scores, submit_match_result do not fail with "Match has ended."', () => {
        const { test, s, recordId } = toAwaitingResult();
        // The host is the spectator referee with refereeFullControl: one caller covers all three.
        tx(test, s.host, (ctx) => M.record_game_scores(ctx, scores(recordId)));
        tx(test, s.host, (ctx) => M.confirm_match_scores(ctx, { matchResultId: recordId }));
        expect(test.db.MatchResultGame.match_result_id.filter(recordId)).toBeDefined();
        tx(test, s.host, (ctx) => M.submit_match_result(ctx, { matchResultId: recordId, winnerId: s.a.b1.userId }));
        // Casual: submit validates and finalizes inline, which deletes the record and the lobby.
        expect(test.db.MatchResultRecord.id.find(recordId)).toBeNull();
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeNull();
    });

    it('after a concede the three fail with "Match has been conceded."', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const recordId = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0].id;
        for (let i = 0; i < 2; i++) tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Scoring');
        // A casual concede finalizes inline and deletes the lobby; a tournament-controlled one stays in AwaitingResult
        // (D-80). The flag is set directly on the row (no bracket: bracketMatchId stays undefined).
        test.db.Lobby.id.update({ ...lobbyRow(test, s.lobbyId), isTournamentControlled: true });
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 1 }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(test.db.MatchResultRecord.id.find(recordId)?.status.tag).toBe('Pending');

        expectReject(test, s.host, (ctx) => M.record_game_scores(ctx, scores(recordId)), 'Match has been conceded.');
        expectReject(test, s.host, (ctx) => M.confirm_match_scores(ctx, { matchResultId: recordId }), 'Match has been conceded.');
        expectReject(test, s.host, (ctx) => M.submit_match_result(ctx, { matchResultId: recordId, winnerId: s.a.b1.userId }), 'Match has been conceded.');
    });
});

describe('F9: undo skips the audit rows and keeps sequences unique', () => {
    it('Pick, pause, undo → "Nothing to undo right now."; resume, undo → the Pick goes, Pause and Undo stay', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const { lobbyId } = s;
        tx(test, blueCaptain(s), (ctx) => M.pick_character(ctx, { lobbyId, characterName: 'Acheron', eidolon: 0 }));
        expect(session(test, lobbyId).turnIndex).toBe(1);
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId }));

        expectReject(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId }), 'Nothing to undo right now.');

        tx(test, s.host, (ctx) => M.resume_draft(ctx, { lobbyId }));
        tx(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId }));

        const all = steps(test, lobbyId);
        expect(all.filter((x) => x.action.tag === 'Pick')).toHaveLength(0);
        expect(all.filter((x) => x.action.tag === 'Pause')).toHaveLength(1);
        const undo = all.filter((x) => x.action.tag === 'Undo');
        expect(undo).toHaveLength(1);
        expect(undo[0].payload).toMatchObject({ tag: 'Undo', value: { originalSequenceId: 0 } });
        expect(session(test, lobbyId).turnIndex).toBe(0);
        const seqs = all.map((x) => x.sequence);
        expect(new Set(seqs).size).toBe(seqs.length);

        // The same character can be picked again after the undo (the turn is Blue's again).
        tx(test, blueCaptain(s), (ctx) => M.pick_character(ctx, { lobbyId, characterName: 'Acheron', eidolon: 0 }));
        const seqs2 = steps(test, lobbyId).map((x) => x.sequence);
        expect(new Set(seqs2).size).toBe(seqs2.length);
    });

    it('undo during the auction phase is rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' }, banMode: { tag: 'Four' } } });
        const { lobbyId } = s;
        // Auction ban order: Blue, Red, Red, Blue.
        const bans: Array<[() => Actor, string]> = [
            [() => blueCaptain(s), 'Acheron'],
            [() => redCaptain(s), 'Aventurine'],
            [() => redCaptain(s), 'Boothill'],
            [() => blueCaptain(s), 'Castorice'],
        ];
        for (const [who, name] of bans) tx(test, who(), (ctx) => M.ban_character(ctx, { lobbyId, characterName: name }));
        expect(session(test, lobbyId).isAuctionPhase).toBe(true);

        expectReject(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId }), 'Undo is not available during the auction phase.');
        expect(steps(test, lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(4);
    });
});
