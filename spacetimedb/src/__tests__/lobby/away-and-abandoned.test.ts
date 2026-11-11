// Lobby: an away or abandoned member is refused by the lobby actions and cannot receive the referee or captain
//   flag.
// Decisions: A98, A122
// Contracts: docs/lobby/contract.md
// From S10h, S10q (s10h-lobby-rulings.test.ts, s10q-gap-coverage.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    expectReject,
    fireCheck,
    guest,
    joinAsSpectator,
    lobbyRow,
    member,
    newHarness,
    pendingCheck,
    refereeIds,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    rejection,
    snap,
    type Ctx,
} from '../fixtures/harness';
import { moderator, verified } from '../fixtures/identity';
import { H, playToScoring, recordScores, setRole, side } from '../fixtures/draft-and-scoring';
import { settingsFrom, abandon, chat, cursorEvents, join, leave } from '../fixtures/lobby';
import { seedElo } from '../fixtures/tournament-matches';
import { parkedLobby, playRanked } from '../fixtures/ranked';

// ─── Texts ───────────────────────────────────────────────────────────────────

const AWAY = 'You are away from this match. Return to it before acting.'; // A98, A146
const ABANDONED = 'You abandoned this match and can no longer act in it.'; // A98, A146
const A92_AWAY = 'You are away from this match. Return to it before acting.'; // A92(4), one wording since A146
const A92_ABANDONED = 'You abandoned this match and can no longer act in it.'; // A92(4), one wording since A146
const NO_RETURN = 'You left this match for another lobby and cannot return.'; // A68(4)

/** Every table a lobby action can write, as one snapshot. */
const LOBBY_TABLES = ['Lobby', 'LobbyMember', 'LobbyBan', 'LobbyPassword', 'LobbyMemberAccount', 'ChatMessage', 'MatchSession',
    'MatchSessionStep', 'MatchLineup', 'MatchResultRecord', 'MatchResultGame', 'MatchResultGroupScore', 'MatchResultAdjustment',
    'MatchResultParticipant', 'RefereeTransferCheck', 'UserRateState'] as const;
const worldSnap = (test: Harness) => snap(LOBBY_TABLES.map((t) => [...(test.db as any)[t].iter()]));

/** Sets LobbyMember fields directly (the table has no primary key: delete + insert the same row). */
function patchMember(test: Harness, lobbyId: number, userId: number, patch: Record<string, unknown>) {
    const row = member(test, lobbyId, userId);
    test.db.LobbyMember.delete(row);
    test.db.LobbyMember.insert({ ...row, ...patch } as any);
}

// ════════════════════════════════════════════════════════════════════════════
// 5. A98: away and abandoned members cannot act
// ════════════════════════════════════════════════════════════════════════════

type Call = [name: string, body: (ctx: Ctx) => unknown];

/**
 * A Classic 2v2 draft (host = spectator referee): a spectator `spec`, a banned spectator, a chat line from r1. b1 leaves
 * (away, A68(2)); the 15 s check fires and auto-pauses the draft; for 'abandoned' b1 then takes another lobby
 * (A68(4)). The Leave moved b1's flags (A22(5)), so the referee and captain flags and the host role are put back on b1
 * directly: every power-gated reducer then reaches its A98 check instead of its permission check.
 */
function a98World(state: 'away' | 'abandoned') {
    const test = newHarness();
    const s = setupLobby(test);
    const L = s.lobbyId;
    const spec = joinAsSpectator(s, 'spec');
    const banned = joinAsSpectator(s, 'banned');
    const bannedSeat = seatOf(test, L, banned.userId);
    tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: bannedSeat }));
    chat(test, s.a.r1, L, 'from r1');
    const messageId = [...test.db.ChatMessage.lobby_id.filter(L)].find((m) => m.content === 'from r1')!.id;

    const x = s.a.b1;
    leave(test, x, L);
    const check = pendingCheck(test, L, x.userId);
    advance(test, 15_000);
    fireCheck(test, check);
    expect(test.db.MatchSession.lobbyId.find(L)!.timerState.isPaused).toBe(true);
    if (state === 'abandoned') abandon(test, x);
    const row = member(test, L, x.userId);
    expect(row.leftAt).toBeDefined();
    expect(row.abandonedAt === undefined).toBe(state === 'away');

    patchMember(test, L, x.userId, { isReferee: true, isCaptain: true });
    test.db.Lobby.id.update({ ...lobbyRow(test, L), hostUserId: x.userId });
    advance(test, 3_000); // past the chat / lineup throttles
    return { test, s, L, x, spec, bannedSeat, messageId };
}

/** Every guarded reducer family (docs/lobby/architecture.md "Phase S10h execution"), called by the away / abandoned member. */
function guardedCalls(w: ReturnType<typeof a98World>): Call[] {
    const { test, s, L, spec, bannedSeat, messageId } = w;
    const specSeat = seatOf(test, L, spec.userId);
    const r1Seat = seatOf(test, L, s.a.r1.userId);
    const b2Seat = seatOf(test, L, s.a.b2.userId);
    const settings = settingsFrom(test, L, { standardTurnSeconds: 90 });
    const blue = side('Blue');
    return [
        ['select_match_account', (ctx) => M.select_match_account(ctx, { lobbyId: L, hsrAccountId: 1 })],
        ['deselect_match_account', (ctx) => M.deselect_match_account(ctx, { lobbyId: L, hsrAccountId: 1 })],
        ['send_chat_message', (ctx) => M.send_chat_message(ctx, { lobbyId: L, content: 'still here?', metadata: '' })],
        ['delete_chat_message', (ctx) => M.delete_chat_message(ctx, { messageId })],
        ['set_team_slot (a seat)', (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: specSeat, lobbySlot: { tag: 'Spectator' } as any })],
        ['set_captain', (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: b2Seat })],
        ['kick_member', (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: specSeat })],
        ['ban_member', (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: specSeat })],
        ['unban_member', (ctx) => M.unban_member(ctx, { lobbyId: L, bannedJoinSeq: bannedSeat })],
        ['transfer_referee', (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: r1Seat })],
        ['reclaim_referee', (ctx) => M.reclaim_referee(ctx, { lobbyId: L })],
        ['transfer_host', (ctx) => M.transfer_host(ctx, { lobbyId: L, targetJoinSeq: r1Seat })],
        ['update_lobby_settings', (ctx) => M.update_lobby_settings(ctx, settings)],
        ['close_lobby', (ctx) => M.close_lobby(ctx, { lobbyId: L })],
        ['shuffle_teams', (ctx) => M.shuffle_teams(ctx, { lobbyId: L, mode: { tag: 'TeamSwap' } as any })],
        ['start_draft', (ctx) => M.start_draft(ctx, { lobbyId: L })],
        ['advance_stage', (ctx) => M.advance_stage(ctx, { lobbyId: L })],
        ['pick_character', (ctx) => M.pick_character(ctx, { lobbyId: L, characterName: 'nobody', eidolon: 0 })],
        ['ban_character', (ctx) => M.ban_character(ctx, { lobbyId: L, characterName: 'nobody' })],
        ['nominate_character', (ctx) => M.nominate_character(ctx, { lobbyId: L, characterName: 'nobody' })],
        ['place_bid', (ctx) => M.place_bid(ctx, { lobbyId: L, bidAmount: 1 })],
        ['pass_bid', (ctx) => M.pass_bid(ctx, { lobbyId: L })],
        ['timer_expiry_classic', (ctx) => M.timer_expiry_classic(ctx, { lobbyId: L })],
        ['timer_expiry_auction', (ctx) => M.timer_expiry_auction(ctx, { lobbyId: L })],
        ['undo_last_step', (ctx) => M.undo_last_step(ctx, { lobbyId: L })],
        ['pause_draft', (ctx) => M.pause_draft(ctx, { lobbyId: L })],
        ['resume_draft', (ctx) => M.resume_draft(ctx, { lobbyId: L })],
        ['equip_lightcone', (ctx) => M.equip_lightcone(ctx, { lobbyId: L, teamSide: blue, characterName: 'nobody', lightconeName: 'none', superimposition: 1 })],
        ['unequip_lightcone', (ctx) => M.unequip_lightcone(ctx, { lobbyId: L, teamSide: blue, characterName: 'nobody' })],
        ['arrange_lineup', (ctx) => M.arrange_lineup(ctx, { lobbyId: L, teamSide: blue, groups: '[]' })],
        ['set_eidolon', (ctx) => M.set_eidolon(ctx, { lobbyId: L, teamSide: blue, characterName: 'nobody', eidolon: 1 })],
        ['record_group_scores', (ctx) => M.record_group_scores(ctx, { lobbyId: L, teamSide: blue, values: [H(10), H(10)], deaths: 0 })],
        ['set_score_adjustment', (ctx) => M.set_score_adjustment(ctx, { lobbyId: L, teamSide: blue, value: H(1) })],
        ['confirm_game', (ctx) => M.confirm_game(ctx, { lobbyId: L, teamSide: blue })],
        ['close_game', (ctx) => M.close_game(ctx, { lobbyId: L })],
    ];
}

/** Runs each call as `who`; each must be rejected and leave the lobby tables untouched. Returns [name, message] pairs. */
function rejectionsOf(test: Harness, who: Actor, calls: Call[]): Array<[string, string]> {
    return calls.map(([name, body]) => {
        const before = worldSnap(test);
        const msg = rejection(test, who, body);
        expect(worldSnap(test), `${name} changed state`).toBe(before);
        return [name, msg];
    });
}

describe('A98: an away or abandoned member is rejected by every lobby action reducer', () => {
    for (const state of ['away', 'abandoned'] as const) {
        const text = state === 'away' ? AWAY : ABANDONED;

        it(`A98 ${state}: every guarded reducer (account selection, chat send / delete, seat, captain, kick / ban / unban, referee and host transfer, settings / close / shuffle, start / advance, draft and Auction actions, both expiries, undo / pause / resume, the four package edits, score entry, adjustment, confirm, close) is rejected with the A98 text and changes nothing`, () => {
            const w = a98World(state);
            const calls = guardedCalls(w);
            const got = rejectionsOf(w.test, w.x, calls);
            expect(got).toEqual(calls.map(([name]) => [name, text]));
        });

        it(`A98 / A92(4) ${state}: concede, claim and defer keep the A92(4) texts, now for a referee row too`, () => {
            const w = a98World(state);
            const calls: Call[] = [
                ['concede_match (referee path)', (ctx) => M.concede_match(ctx, { lobbyId: w.L, losingTeamSide: 1 })],
                ['claim_forfeit', (ctx) => M.claim_forfeit(ctx, { lobbyId: w.L, forfeitingTeamSide: 2 })],
                ['defer_match', (ctx) => M.defer_match(ctx, { lobbyId: w.L })],
            ];
            const got = rejectionsOf(w.test, w.x, calls);
            const a92 = state === 'away' ? A92_AWAY : A92_ABANDONED;
            expect(got).toEqual(calls.map(([name]) => [name, a92]));
        });

        it(`A98 ${state}: the Waiting-stage reducers (self-move, ready, unready, account selection, settings, close, shuffle, start) reject a ${state} row (patched: a Waiting Leave deletes the row, A68(5))`, () => {
            const test = newHarness();
            const s = setupLobby(test, { noStart: true });
            const L = s.lobbyId;
            const x = s.a.b1;
            const stamp = test.clock.now();
            patchMember(test, L, x.userId, { leftAt: stamp, ...(state === 'abandoned' ? { abandonedAt: stamp } : {}), isReferee: true });
            test.db.Lobby.id.update({ ...lobbyRow(test, L), hostUserId: x.userId });
            const settings = settingsFrom(test, L, { standardTurnSeconds: 90 });
            const calls: Call[] = [
                ['set_team_slot (self)', (ctx) => M.set_team_slot(ctx, { lobbyId: L, lobbySlot: { tag: 'Spectator' } as any })],
                ['confirm_ready', (ctx) => M.confirm_ready(ctx, { lobbyId: L })],
                ['unconfirm_ready', (ctx) => M.unconfirm_ready(ctx, { lobbyId: L })],
                ['select_match_account', (ctx) => M.select_match_account(ctx, { lobbyId: L, hsrAccountId: 1 })],
                ['update_lobby_settings', (ctx) => M.update_lobby_settings(ctx, settings)],
                ['close_lobby', (ctx) => M.close_lobby(ctx, { lobbyId: L })],
                ['shuffle_teams', (ctx) => M.shuffle_teams(ctx, { lobbyId: L, mode: { tag: 'TeamSwap' } as any })],
                ['start_draft', (ctx) => M.start_draft(ctx, { lobbyId: L })],
            ];
            const got = rejectionsOf(test, x, calls);
            expect(got).toEqual(calls.map(([name]) => [name, text]));
        });
    }

    it('A98 the away member returns through join_lobby and can act again (chat, captain, cursor); a second leave_lobby while away is accepted and changes nothing', () => {
        const w = a98World('away');
        const { test, L, x, s } = w;
        const stamp = member(test, L, x.userId).leftAt;
        leave(test, x, L); // leave_lobby is unaffected (A98): accepted, nothing moves
        expect(member(test, L, x.userId).leftAt).toEqual(stamp);

        join(test, x, L);
        expect(member(test, L, x.userId).leftAt).toBeUndefined();
        chat(test, x, L, 'back');
        expect([...test.db.ChatMessage.lobby_id.filter(L)].some((m) => m.content === 'back' && m.senderUserId === x.userId)).toBe(true);
        tx(test, x, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, s.a.b2.userId) }));
        expect(member(test, L, s.a.b2.userId).isCaptain).toBe(true);
        expect(cursorEvents(test, x, L)).toHaveLength(1);
    });

    it('A98 / A68(4) the abandoned member never can: join_lobby is refused with the A68(4) text and every action stays rejected; leave_lobby is accepted', () => {
        const w = a98World('abandoned');
        const { test, L, x } = w;
        leave(test, x, L);
        const msg = rejection(test, x, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: '' }));
        expect(member(test, L, x.userId).abandonedAt).toBeDefined();
        expect(msg).toBe(NO_RETURN);
        expect(rejection(test, x, (ctx) => M.send_chat_message(ctx, { lobbyId: L, content: 'let me in', metadata: '' }))).toBe(ABANDONED);
        expect(rejection(test, x, (ctx) => M.pause_draft(ctx, { lobbyId: L }))).toBe(ABANDONED);
    });

    it('A98 a Moderator who is not a member keeps the staff paths: transfer_host, the result authority (adjustment, close) and the Admin edit of the closed game', () => {
        const test = newHarness();
        const s = playToScoring(test, {
            beforeStart: (l: Lobby) => {
                // Ranked (direct row edit, as s9a makeRanked) so the close parks the record (Submitted) instead of finalizing it
                test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
                let accountId = 700;
                for (const m of test.db.LobbyMember.lobby_id.filter(l.lobbyId)) {
                    if (m.lobbySlot.tag === 'BluePlayer' || m.lobbySlot.tag === 'RedPlayer') {
                        test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: m.userId, hsrAccountId: accountId++ });
                    }
                }
            },
        });
        const L = s.lobbyId;
        leave(test, s.a.b1, L); // an away member in the lobby; the staff never needed a row
        const mod = moderator(test, 'mod');
        expect(member(test, L, mod.userId)).toBeUndefined();

        tx(test, mod, (ctx) => M.transfer_host(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, s.a.r1.userId) }));
        expect(lobbyRow(test, L).hostUserId).toBe(s.a.r1.userId);

        tx(test, mod, (ctx) => M.set_score_adjustment(ctx, { lobbyId: L, teamSide: side('Red'), value: H(1), reason: 'staff' }));
        expect([...test.db.MatchResultAdjustment.iter()].some((a) => a.setById === mod.userId)).toBe(true);

        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]);
        tx(test, mod, (ctx) => M.close_game(ctx, { lobbyId: L }));
        const record = [...test.db.MatchResultRecord.lobby_id.filter(L)][0];
        expect(record.status.tag).toBe('Submitted');
        const gameOf = () => [...test.db.MatchResultGame.match_result_id.filter(record.id)][0];
        expect(gameOf().closedById).toBe(mod.userId);

        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        tx(test, admin, (ctx) => M.record_group_scores(ctx, { lobbyId: L, teamSide: side('Blue'), values: [H(30), H(30)], deaths: 0 }));
        expect(gameOf().winnerTeamSide.tag).toBe('Red');
        expect(gameOf().closedAt).toBeDefined();
    });
});

describe('review F5 (A98): an away or abandoned member cannot receive the referee or the captain flag', () => {
    /** A Classic 2v2 draft (host = spectator referee); b1 leaves (away) and, for 'abandoned', then takes another lobby. */
    function awayTarget(state: 'away' | 'abandoned') {
        const test = newHarness();
        const s = setupLobby(test);
        const L = s.lobbyId;
        const x = s.a.b1;
        leave(test, x, L);
        const check = pendingCheck(test, L, x.userId);
        advance(test, 15_000);
        fireCheck(test, check);
        if (state === 'abandoned') abandon(test, x);
        expect(member(test, L, x.userId).abandonedAt === undefined).toBe(state === 'away');
        return { test, s, L, x };
    }

    for (const state of ['away', 'abandoned'] as const) {
        it(`review F5 ${state}: transfer_referee and set_captain to the ${state} seat are refused with the transfer_host text shape and change nothing`, () => {
            const { test, s, L, x } = awayTarget(state);
            const seat = seatOf(test, L, x.userId);
            const actors = [s.host, ...Object.values(s.a)];
            const referee = actors.find((a) => a.userId === refereeIds(test, L)[0])!;
            expect(lobbyRow(test, L).hostUserId).toBe(s.host.userId);
            const got = rejectionsOf(test, referee, [
                ['transfer_referee', (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: seat })],
            ]).concat(rejectionsOf(test, s.host, [
                ['set_captain', (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: seat })],
            ]));
            expect(got).toEqual([
                ['transfer_referee', `The member at seat ${seat} has left the match and cannot become the referee.`],
                ['set_captain', `The member at seat ${seat} has left the match and cannot become a captain.`],
            ]);
            expect(member(test, L, x.userId)).toMatchObject({ isReferee: false, isCaptain: false });
        });
    }
});

describe('review F8 (A98): Moderator and Admin powers never depend on presence', () => {
    for (const state of ['away', 'abandoned'] as const) {
        // A spectator's Leave deletes its row in every stage (A68(5)), so the staff member's away / abandoned row is
        // patched in. set_captain admits the host, an authorized referee or an Admin (D-30): a Moderator has no
        // captain power to keep, so the captain call is made by an Admin.
        it(`review F8 ${state}: a Moderator holding a ${state} row still kicks and bans; an Admin holding one still sets a captain`, () => {
            const test = newHarness();
            const s = setupLobby(test);
            const L = s.lobbyId;
            const kickMe = joinAsSpectator(s, 'kick-me');
            const banMe = joinAsSpectator(s, 'ban-me');
            const staff = joinAsSpectator(s, 'staff');
            setRole(test, staff.userId, 'Moderator');
            const stamp = test.clock.now();
            patchMember(test, L, staff.userId, { leftAt: stamp, ...(state === 'abandoned' ? { abandonedAt: stamp } : {}) });

            tx(test, staff, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, kickMe.userId) }));
            expect(member(test, L, kickMe.userId)).toBeUndefined();
            const banSeat = seatOf(test, L, banMe.userId);
            tx(test, staff, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: banSeat }));
            expect(member(test, L, banMe.userId)).toBeUndefined();
            expect([...test.db.LobbyBan.lobby_id.filter(L)].some((b) => b.bannedUserId === banMe.userId && b.bannedByUserId === staff.userId)).toBe(true);

            setRole(test, staff.userId, 'Admin');
            const blue = [s.a.b1, s.a.b2].find((p) => !member(test, L, p.userId).isCaptain)!;
            tx(test, staff, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, blue.userId) }));
            expect(member(test, L, blue.userId).isCaptain).toBe(true);
            expect(member(test, L, staff.userId).leftAt).toBeDefined(); // still away: the staff power did not need a return
        });
    }

    it('review F8: a User-role host holding an away row is still refused kick, ban and set_captain with the A98 text (the exemption is for staff only)', () => {
        const w = a98World('away');
        const specSeat = seatOf(w.test, w.L, w.spec.userId);
        const b2Seat = seatOf(w.test, w.L, w.s.a.b2.userId);
        const got = rejectionsOf(w.test, w.x, [
            ['kick_member', (ctx) => M.kick_member(ctx, { lobbyId: w.L, targetJoinSeq: specSeat })],
            ['ban_member', (ctx) => M.ban_member(ctx, { lobbyId: w.L, targetJoinSeq: specSeat })],
            ['set_captain', (ctx) => M.set_captain(ctx, { lobbyId: w.L, targetJoinSeq: b2Seat })],
        ]);
        expect(got.map(([, msg]) => msg)).toEqual([AWAY, AWAY, AWAY]);
    });
});

describe('review F9 (A98): finalize_match_result by a referee whose row is away or abandoned', () => {
    /** A standalone Ranked lobby parked in AwaitingResult (host = spectator referee = the record's refereeUserId), Validated by a Moderator. */
    function validated() {
        const test = newHarness();
        seedElo(test);
        const s = parkedLobby(test);
        const mod = moderator(test, 'mod');
        const record = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0];
        expect(record.refereeUserId).toBe(s.host.userId);
        tx(test, mod, (ctx) => M.override_match_result(ctx, { matchResultId: record.id, newStatusTag: 'Validated', winnerTeamSideTag: 'Blue', reason: 'reviewed' }));
        return { test, s, mod, recId: record.id };
    }

    for (const state of ['away', 'abandoned'] as const) {
        // An AwaitingResult Leave deletes the row (A68(5)), so the referee's away / abandoned row is patched in.
        it(`review F9 ${state}: the referee (not staff) is refused with the A98 text and nothing changes; a Moderator then finalizes`, () => {
            const { test, s, mod, recId } = validated();
            const stamp = test.clock.now();
            patchMember(test, s.lobbyId, s.host.userId, { leftAt: stamp, ...(state === 'abandoned' ? { abandonedAt: stamp } : {}) });
            const got = rejectionsOf(test, s.host, [['finalize_match_result', (ctx) => M.finalize_match_result(ctx, { matchResultId: recId })]]);
            expect(got).toEqual([['finalize_match_result', state === 'away' ? AWAY : ABANDONED]]);
            expect(test.db.MatchResultRecord.id.find(recId)!.status.tag).toBe('Validated');

            tx(test, mod, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }));
            expect(test.db.MatchResultRecord.id.find(recId)).toBeFalsy();
        });
    }

    it('review F9: a present referee still finalizes (control)', () => {
        const { test, s, recId } = validated();
        tx(test, s.host, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }));
        expect(test.db.MatchResultRecord.id.find(recId)).toBeFalsy();
    });
});

const NO_AUTHORITY_TEXT = 'You do not have authority to finalize this match result.';
const AWAY_TEXT = 'You are away from this match. Return to it before acting.';

/** The lobby row of `userId`, re-written with `over` (LobbyMember is updated by delete + insert, as the module does). */
function rewriteMember(test: Harness, lobbyId: number, userId: number, over: Record<string, unknown>) {
    const row = member(test, lobbyId, userId)!;
    test.db.LobbyMember.by_lobby_and_user.delete([lobbyId, userId]);
    test.db.LobbyMember.insert({ ...row, ...over } as any);
}

// ════════════════════════════════════════════════════════════════════════════
// Gap 6. A122(14), L51 (S10r review F5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 6, A122(14) L51: finalize_match_result by an away referee and by a caller with no member row (S10r review F5)', () => {
    /** A standalone Ranked game closed by the host referee and validated by a Moderator (override_match_result). */
    function validatedRanked() {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Blue');
        tx(test, mod, (ctx) => M.override_match_result(ctx, { matchResultId: recId, newStatusTag: 'Validated', winnerTeamSideTag: 'Blue', reason: 'reviewed' }));
        expect(member(test, s.lobbyId, s.host.userId)!.isReferee).toBe(true);
        return { test, s, recId, mod };
    }
    const finalizeBody = (recId: number) => (ctx: any) => M.finalize_match_result(ctx, { matchResultId: recId });

    it('A122(14), A98 (F5: an away referee): the lobby\'s referee whose row is away is refused with the away text; a Moderator then finalizes (engineered: in AwaitingResult leave_lobby removes the row, so leftAt is set on the row)', () => {
        const { test, s, recId, mod } = validatedRanked();
        rewriteMember(test, s.lobbyId, s.host.userId, { leftAt: test.clock.now() });
        expect(member(test, s.lobbyId, s.host.userId)).toMatchObject({ isReferee: true });

        expectReject(test, s.host, finalizeBody(recId), AWAY_TEXT);
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(0);
        tx(test, mod, finalizeBody(recId));
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);
    });

    it('A122(14) (F5: no member row): a verified user who is not in the lobby and the former referee who left it (row removed) are refused; staff without a row (a Moderator) finalize', () => {
        const { test, s, recId, mod } = validatedRanked();
        const outsider = verified(test, 'outsider');
        expectReject(test, outsider, finalizeBody(recId), NO_AUTHORITY_TEXT);
        tx(test, s.host, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        expect(member(test, s.lobbyId, s.host.userId)).toBeFalsy();
        expectReject(test, s.host, finalizeBody(recId), NO_AUTHORITY_TEXT);
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(0);
        expect(member(test, s.lobbyId, mod.userId)).toBeFalsy();
        tx(test, mod, finalizeBody(recId));
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);
    });
});
