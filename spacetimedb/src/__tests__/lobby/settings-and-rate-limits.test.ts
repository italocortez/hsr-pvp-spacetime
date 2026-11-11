// Lobby: settings ranges, alias and metadata caps, Ranked with a guest, the membership rate and preset ownership.
// Decisions: A122
// Contracts: docs/lobby/contract.md
// From S10e, S10r (s10e-lobby-identity.test.ts, s10r-triage-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    expectReject,
    guest,
    lobbyRow,
    member,
    newHarness,
    seatOf,
    session,
    setupLobby,
    tx,
    type Actor,
    type Harness,
} from '../fixtures/harness';
import { host, moderator, verified } from '../fixtures/tournament-builders';
import { byKey, duel, openMatchLobby } from '../fixtures/tournament-match-builders';
import {
    createLobby,
    joinLobby,
    presetArgs,
    presetNamed,
    settingsArgs,
    updatePresetArgs,
} from '../fixtures/preset-and-account-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { chatRows, leave, moveSlot, selfSlot } from '../fixtures/lobby-member-helpers';
import { admin } from '../fixtures/admin-and-turn-helpers';

const ALIAS_CAP = 'Team aliases must be at most 30 characters.';
const META_CAP = 'Message metadata exceeds 200 character limit.';
const TOO_FAST = 'You are changing lobbies or seats too quickly. Please wait a moment.';
const TEAM_SIZE = 'teamSize must be 1, 2, or 3.';
const RANGE = (name: string, min: number, max: number) => `${name} must be between ${min} and ${max}.`;
const AMOUNT = (name: string) => `${name} must be a number between 0 and 100000.`;
const HANDICAP = (name: string) => `${name} must be between -1000000 and 1000000 (hundredths).`; // S10e review N1
const THRESHOLD = 'rosterThreshold must be between 0 and 1000000 (hundredths).';
const RANKED_GUEST = 'A guest is in this lobby; guests cannot join Ranked lobbies.';

// ════════════════════════════════════════════════════════════════════════════
// 3. Lobby audit #5: alias and chat metadata caps
// ════════════════════════════════════════════════════════════════════════════

describe('lobby audit #5: team aliases (30) and chat metadata (200) are capped', () => {
    const A = (n: number) => 'a'.repeat(n);

    it('create_lobby: aliases of 30 accepted, 31 (Blue or Red) rejected with no lobby written (lobby audit #5)', () => {
        const test = newHarness();
        const ok = guest(test, 'ok');
        const id = createLobby(test, ok, { teamBlueAlias: A(30), teamRedAlias: A(30) });
        expect(lobbyRow(test, id).teamBlueAlias).toBe(A(30));
        expect(lobbyRow(test, id).teamRedAlias).toBe(A(30));
        for (const over of [{ teamBlueAlias: A(31) }, { teamRedAlias: A(31) }]) {
            const g = guest(test, `g-${Object.keys(over)[0]}`);
            const msg = rejection(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...over } as any));
            expect([...test.db.Lobby.host_user_id.filter(g.userId)]).toHaveLength(0);
            expect(msg).toBe(ALIAS_CAP);
        }
    });

    it('update_lobby_settings: aliases of 30 accepted, 31 rejected with the row unchanged (lobby audit #5)', () => {
        const test = newHarness();
        const h = guest(test, 'h');
        const id = createLobby(test, h);
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { teamBlueAlias: A(30), teamRedAlias: A(30) })));
        expect(lobbyRow(test, id).teamBlueAlias).toBe(A(30));
        for (const over of [{ teamBlueAlias: A(31) }, { teamRedAlias: A(31) }]) {
            const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { teamBlueAlias: 'x', ...over })));
            expect(lobbyRow(test, id).teamBlueAlias).toBe(A(30));
            expect(lobbyRow(test, id).teamRedAlias).toBe(A(30));
            expect(msg).toBe(ALIAS_CAP);
        }
    });

    it('send_chat_message: metadata of 200 accepted, 201 rejected; the documented shapes still pass (lobby audit #5, D-14)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const meta = (n: number) => {
            const base = '{"type":"text","pad":""}';
            return `${base.slice(0, -2)}${'x'.repeat(n - base.length)}"}`;
        };
        expect(meta(200)).toHaveLength(200);
        expect(JSON.parse(meta(201)).type).toBe('text');
        const send = (metadata: string) => (ctx: any) => M.send_chat_message(ctx, { lobbyId: s.lobbyId, content: 'hi', metadata });

        const accepted = ['', '{"type":"text"}', '{"type":"reply","replyToMessageId":4294967295}', '{"type":"emoji_only"}', meta(200)];
        for (const metadata of accepted) {
            const before = chatRows(test, s.lobbyId).length;
            tx(test, s.a.b1, send(metadata));
            expect(chatRows(test, s.lobbyId)).toHaveLength(before + 1);
            advance(test, 2_100);
        }
        const before = chatRows(test, s.lobbyId).length;
        const msg = rejection(test, s.a.b1, send(meta(201)));
        expect(chatRows(test, s.lobbyId)).toHaveLength(before);
        expect(msg).toBe(META_CAP);
    });
});

describe('lobby audit #6: the membership rate (20 changes per 10 s per user)', () => {
    it('20 seat changes inside 10 s pass, the 21st is rejected with the row unchanged, a new window passes (lobby audit #6)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, seats: [['m', 'Spectator']] });
        const m = s.a.m;
        advance(test, 10_000); // the join opened a window; start a fresh one
        for (let i = 0; i < 20; i++) {
            tx(test, m, selfSlot(s.lobbyId, i % 2 === 0 ? 'BluePlayer' : 'Spectator'));
            advance(test, 100);
        }
        expect(member(test, s.lobbyId, m.userId).lobbySlot.tag).toBe('Spectator');
        const msg = rejection(test, m, selfSlot(s.lobbyId, 'BluePlayer'));
        expect(member(test, s.lobbyId, m.userId).lobbySlot.tag).toBe('Spectator');
        expect(msg).toBe(TOO_FAST);

        advance(test, 10_000);
        tx(test, m, selfSlot(s.lobbyId, 'BluePlayer'));
        expect(member(test, s.lobbyId, m.userId).lobbySlot.tag).toBe('BluePlayer');
    });

    it('20 join + leave cycles pass (only the 20 joins count), the 21st join is rejected, a new window passes (lobby audit #6, S10e review N8)', () => {
        const test = newHarness();
        const h = guest(test, 'h');
        const lobbyId = createLobby(test, h);
        const g = guest(test, 'g');
        for (let i = 0; i < 20; i++) {
            joinLobby(test, g, lobbyId);
            leave(test, g, lobbyId);
            advance(test, 200);
        }
        expect(test.db.UserRateState.userId.find(g.userId)?.membershipCount).toBe(20);
        const msg = rejection(test, g, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' }));
        expect(member(test, lobbyId, g.userId)).toBeUndefined();
        expect(msg).toBe(TOO_FAST);
        advance(test, 10_000);
        joinLobby(test, g, lobbyId);
        expect(member(test, lobbyId, g.userId)).toBeDefined();
    });

    it('a Leave at a full window is never rejected and consumes nothing, in Waiting (row removed) and in Drafting (away) (S10e review N8)', () => {
        const test = newHarness();
        // Waiting: a spectator fills the window with 20 seat moves, then leaves.
        const w = setupLobby(test, { noStart: true, seats: [['m', 'Spectator']] });
        const m = w.a.m;
        advance(test, 10_000);
        for (let i = 0; i < 20; i++) tx(test, m, selfSlot(w.lobbyId, i % 2 === 0 ? 'BluePlayer' : 'Spectator'));
        leave(test, m, w.lobbyId);
        expect(member(test, w.lobbyId, m.userId)).toBeUndefined();
        expect(test.db.UserRateState.userId.find(m.userId)?.membershipCount).toBe(20);
        expect(rejection(test, m, (ctx) => M.join_lobby(ctx, { lobbyId: w.lobbyId, joinCode: '', password: '' }))).toBe(TOO_FAST);

        // Drafting: a player fills the window with 20 returns (each counted), then leaves once more: away, no rejection.
        const live = newHarness();
        const d = setupLobby(live, { lobby: { disconnectPolicy: { tag: 'NoAction' } } });
        const p = d.a.b2;
        advance(live, 10_000);
        for (let i = 0; i < 20; i++) {
            leave(live, p, d.lobbyId);
            joinLobby(live, p, d.lobbyId); // a return (leftAt cleared), counted
        }
        expect(live.db.UserRateState.userId.find(p.userId)?.membershipCount).toBe(20);
        leave(live, p, d.lobbyId);
        expect(member(live, d.lobbyId, p.userId).leftAt).toBeDefined();
        expect(live.db.UserRateState.userId.find(p.userId)?.membershipCount).toBe(20);
        expect(rejection(live, p, (ctx) => M.join_lobby(ctx, { lobbyId: d.lobbyId, joinCode: '', password: '' }))).toBe(TOO_FAST);
        expect(member(live, d.lobbyId, p.userId).leftAt).toBeDefined();
    });

    it('a plain reconnect (join_lobby on a present row) is not counted: it passes with the window full, which stays full (lobby audit #6)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, seats: [['m', 'Spectator']] });
        const m = s.a.m;
        advance(test, 10_000);
        for (let i = 0; i < 20; i++) tx(test, m, selfSlot(s.lobbyId, i % 2 === 0 ? 'BluePlayer' : 'Spectator'));
        joinLobby(test, m, s.lobbyId); // reconnect: no rejection
        joinLobby(test, m, s.lobbyId);
        expect(member(test, s.lobbyId, m.userId)).toBeDefined();
        expect(rejection(test, m, selfSlot(s.lobbyId, 'BluePlayer'))).toBe(TOO_FAST);
    });

    it('a host moving other members is charged to the host, not to the members moved (lobby audit #6)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, seats: [['a', 'Spectator'], ['b', 'Spectator']] });
        advance(test, 10_000);
        const aSeat = seatOf(test, s.lobbyId, s.a.a.userId);
        const bSeat = seatOf(test, s.lobbyId, s.a.b.userId);
        for (let i = 0; i < 20; i++) tx(test, s.host, moveSlot(s.lobbyId, aSeat, i % 2 === 0 ? 'BluePlayer' : 'Spectator'));
        const msg = rejection(test, s.host, moveSlot(s.lobbyId, bSeat, 'RedPlayer'));
        expect(member(test, s.lobbyId, s.a.b.userId).lobbySlot.tag).toBe('Spectator');
        expect(msg).toBe(TOO_FAST);
        // The moved members' own allowance is untouched.
        tx(test, s.a.a, selfSlot(s.lobbyId, 'RedPlayer'));
        tx(test, s.a.b, selfSlot(s.lobbyId, 'BluePlayer'));
        expect(member(test, s.lobbyId, s.a.a.userId).lobbySlot.tag).toBe('RedPlayer');
        expect(member(test, s.lobbyId, s.a.b.userId).lobbySlot.tag).toBe('BluePlayer');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Lobby audit #10: settings ranges
// ════════════════════════════════════════════════════════════════════════════

type BoundCase = [field: string, value: number, error?: string];

const BOUND_CASES: BoundCase[] = [
    ['teamSize', 0, TEAM_SIZE], ['teamSize', 1], ['teamSize', 3], ['teamSize', 4, TEAM_SIZE],
    ['standardTurnSeconds', 9, RANGE('standardTurnSeconds', 10, 600)], ['standardTurnSeconds', 10], ['standardTurnSeconds', 600],
    ['standardTurnSeconds', 601, RANGE('standardTurnSeconds', 10, 600)],
    ['reserveBankSeconds', -1, RANGE('reserveBankSeconds', 0, 1800)], ['reserveBankSeconds', 0], ['reserveBankSeconds', 1800],
    ['reserveBankSeconds', 1801, RANGE('reserveBankSeconds', 0, 1800)],
    ...(['characterBudget', 'lightconeBudget', 'minimumBidRaise'] as const).flatMap((f): BoundCase[] => [
        [f, -1, AMOUNT(f)], [f, 0], [f, 100_000], [f, 100_001, AMOUNT(f)],
        [f, Number.NaN, AMOUNT(f)], [f, Number.POSITIVE_INFINITY, AMOUNT(f)], [f, Number.NEGATIVE_INFINITY, AMOUNT(f)],
    ]),
    ...(['rosterDiffAdvantage', 'underThresholdAdvantage', 'aboveThresholdPenalty', 'deathPenalty'] as const)
        // S10e review N1: negative handicaps (i32 columns) accepted again; the magnitude is bounded both ways.
        .flatMap((f): BoundCase[] => [
            [f, -1_000_001, HANDICAP(f)], [f, -1_000_000], [f, -1], [f, 0], [f, 1_000_000], [f, 1_000_001, HANDICAP(f)],
        ]),
    // rosterThreshold is a roster cost (u32 column, no sign): 0 to 1000000.
    ['rosterThreshold', 0], ['rosterThreshold', 1_000_000], ['rosterThreshold', 1_000_001, THRESHOLD],
];

/** One rejected and one accepted value per setting, for update_lobby_settings and the preset reducers. */
const SAMPLE_REJECTED: BoundCase[] = [
    ['teamSize', 4, TEAM_SIZE],
    ['standardTurnSeconds', 0, RANGE('standardTurnSeconds', 10, 600)],
    ['reserveBankSeconds', 1801, RANGE('reserveBankSeconds', 0, 1800)],
    ['characterBudget', Number.NaN, AMOUNT('characterBudget')],
    ['lightconeBudget', -1, AMOUNT('lightconeBudget')],
    ['minimumBidRaise', Number.POSITIVE_INFINITY, AMOUNT('minimumBidRaise')],
    ['rosterThreshold', 1_000_001, THRESHOLD],
    ['deathPenalty', -1_000_001, HANDICAP('deathPenalty')],
];
const SAMPLE_ACCEPTED = {
    teamSize: 3, standardTurnSeconds: 600, reserveBankSeconds: 0, characterBudget: 100_000, deathPenalty: 1_000_000,
    aboveThresholdPenalty: -500, // S10e review N1
};

describe('lobby audit #10: lobby settings are range-checked', () => {
    it('create_lobby: each bound one below, at and one above (NaN / ±Infinity for the f32 budgets); a rejection writes no lobby (lobby audit #10)', () => {
        const test = newHarness();
        let n = 0;
        for (const [field, value, error] of BOUND_CASES) {
            const g = guest(test, `c-${n++}`);
            if (error) {
                const msg = rejection(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, [field]: value } as any));
                expect([...test.db.Lobby.host_user_id.filter(g.userId)], `${field}=${value}`).toHaveLength(0);
                expect(msg, `${field}=${value}`).toBe(error);
            } else {
                const id = createLobby(test, g, { [field]: value });
                expect((lobbyRow(test, id) as any)[field], `${field}=${value}`).toBe(value);
            }
        }
    });

    it('update_lobby_settings: a sample of each setting rejected with the row unchanged; in-range values stored (lobby audit #10)', () => {
        const test = newHarness();
        const h = guest(test, 'h');
        const id = createLobby(test, h);
        for (const [field, value, error] of SAMPLE_REJECTED) {
            const before = (lobbyRow(test, id) as any)[field];
            const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { [field]: value })));
            expect((lobbyRow(test, id) as any)[field], field).toBe(before);
            expect(msg, field).toBe(error);
        }
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, SAMPLE_ACCEPTED)));
        expect(lobbyRow(test, id)).toMatchObject(SAMPLE_ACCEPTED);
    });

    it('create_lobby_preset and update_lobby_preset: the same samples rejected; in-range values stored (lobby audit #10)', () => {
        const test = newHarness();
        for (const [field, value, error] of SAMPLE_REJECTED) {
            const msg = rejection(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs(`bad-${field}`, { [field]: value })));
            expect(presetNamed(test, `bad-${field}`), field).toBeUndefined();
            expect(msg, field).toBe(error);
        }
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('good', SAMPLE_ACCEPTED)));
        const preset = presetNamed(test, 'good')!;
        expect(preset).toMatchObject(SAMPLE_ACCEPTED);

        for (const [field, value, error] of SAMPLE_REJECTED) {
            const msg = rejection(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(preset.id, 'good', { ...SAMPLE_ACCEPTED, [field]: value })));
            expect(presetNamed(test, 'good'), field).toMatchObject(SAMPLE_ACCEPTED);
            expect(msg, field).toBe(error);
        }
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(preset.id, 'good', { teamSize: 1, standardTurnSeconds: 10 })));
        expect(presetNamed(test, 'good')).toMatchObject({ teamSize: 1, standardTurnSeconds: 10 });
    });

    it('start_draft rejects a team with more players than teamSize after the size was lowered (lobby audit #10)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true }); // 2v2
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { teamSize: 1 })));
        expect(lobbyRow(test, s.lobbyId).teamSize).toBe(1);
        for (const n of ['b1', 'b2', 'r1', 'r2']) tx(test, s.a[n], (ctx) => M.confirm_ready(ctx, { lobbyId: s.lobbyId }));
        const msg = rejection(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
        expect(test.db.MatchSession.lobbyId.find(s.lobbyId)).toBeFalsy();
        expect(msg).toBe('Blue team has 2 players; the team size is 1.');
    });

    it('a tournament lobby still builds and starts its draft (lobby audit #10)', () => {
        const f = duel();
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(lobbyRow(f.test, s.lobbyId).isTournamentControlled).toBe(true);
        expect(session(f.test, s.lobbyId)).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Lobby LOW #24: no switch to Ranked with a guest in the lobby
// ════════════════════════════════════════════════════════════════════════════

describe('lobby audit LOW #24: update_lobby_settings to Ranked with a guest member', () => {
    it('rejected while a guest holds a member row; accepted once the guest left (lobby audit #24, D-23)', () => {
        const test = newHarness();
        const h = verified(test, 'h');
        const id = createLobby(test, h);
        const g = guest(test, 'g');
        joinLobby(test, g, id);
        const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { matchType: { tag: 'Ranked' } })));
        expect(lobbyRow(test, id).matchType.tag).toBe('Casual');
        expect(msg).toBe(RANKED_GUEST);

        leave(test, g, id);
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, settingsArgs(id, { matchType: { tag: 'Ranked' } })));
        expect(lobbyRow(test, id).matchType.tag).toBe('Ranked');
    });
});

// ─── Texts ───────────────────────────────────────────────────────────────────

// S10r review F6: the four L17 reducers share the membership bucket but answer with a neutral text; joins and seat
// moves keep 'You are changing lobbies or seats too quickly. Please wait a moment.'.
const RATE_TEXT = 'You are doing that too quickly. Please wait a moment.';
const MOD_PRESET_TEXT = 'Moderators can only modify presets created by moderators, TOs, or themselves.';

// ════════════════════════════════════════════════════════════════════════════
// L17: the per-user allowance on confirm_ready, unconfirm_ready, shuffle_teams, transfer_host
// ════════════════════════════════════════════════════════════════════════════

describe('A122(4), L17: confirm_ready, unconfirm_ready, shuffle_teams and transfer_host use the per-user membership allowance', () => {
    /** Calls `body` until it throws (at most `max` times); returns the number of accepted calls and the error. */
    function untilRejected(test: Harness, who: Actor, body: (i: number) => (ctx: any) => unknown, max = 40) {
        for (let i = 0; i < max; i++) {
            try {
                tx(test, who, body(i));
            } catch (e) {
                return { accepted: i, error: (e as Error).message };
            }
        }
        return { accepted: max, error: '' };
    }

    it('A122(4) L17: a ready / unready loop is rejected within one 10 s window; after the window it is accepted again', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const { lobbyId } = s;
        const r = untilRejected(test, s.a.b1, (i) => (ctx) =>
            i % 2 === 0 ? M.unconfirm_ready(ctx, { lobbyId }) : M.confirm_ready(ctx, { lobbyId }));
        expect(r.accepted).toBeGreaterThan(0);
        expect(r.accepted).toBeLessThan(20);
        expect(r.error).toContain(RATE_TEXT);
        // Another member's allowance is their own.
        tx(test, s.a.r1, (ctx) => M.unconfirm_ready(ctx, { lobbyId }));
        advance(test, 10_000);
        tx(test, s.a.b1, (ctx) => M.confirm_ready(ctx, { lobbyId }));
    });

    it('A122(4) L17: shuffle_teams is held to 20 per 10 s for the host, and transfer_host draws on the same allowance', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const { lobbyId } = s;
        const r = untilRejected(test, s.host, () => (ctx) => M.shuffle_teams(ctx, { lobbyId, mode: { tag: 'TeamSwap' } as any }));
        expect(r.accepted).toBe(20);
        expect(r.error).toContain(RATE_TEXT);
        const seat = seatOf(test, lobbyId, s.a.b1.userId);
        expectReject(test, s.host, (ctx) => M.transfer_host(ctx, { lobbyId, targetJoinSeq: seat }), RATE_TEXT);
        expect(lobbyRow(test, lobbyId).hostUserId).toBe(s.host.userId);
        advance(test, 10_000);
        tx(test, s.host, (ctx) => M.transfer_host(ctx, { lobbyId, targetJoinSeq: seat }));
        expect(lobbyRow(test, lobbyId).hostUserId).toBe(s.a.b1.userId);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L21: Moderators and Admin presets
// ════════════════════════════════════════════════════════════════════════════

describe('A122(5), L21: a Moderator edits or deletes only presets created by Moderators and hosts', () => {
    it('A122(5) L21: a Moderator cannot update or delete an Admin\'s preset; an Admin can', () => {
        const test = newHarness();
        const adm = admin(test);
        const mod = moderator(test);
        tx(test, adm, (ctx) => M.create_lobby_preset(ctx, presetArgs('Admin preset')));
        const id = presetNamed(test, 'Admin preset')!.id;
        expectReject(test, mod, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(id, 'Renamed')), MOD_PRESET_TEXT);
        expectReject(test, mod, (ctx) => M.delete_lobby_preset(ctx, { presetId: id }), MOD_PRESET_TEXT);
        expect(presetNamed(test, 'Admin preset')).toBeTruthy();
        tx(test, adm, (ctx) => M.delete_lobby_preset(ctx, { presetId: id }));
        expect(presetNamed(test, 'Admin preset')).toBeFalsy();
    });

    it('A122(5) L21: a Moderator still edits and deletes a tournament host\'s and another Moderator\'s preset', () => {
        const test = newHarness();
        const th = host(test, 'th');
        const mod = moderator(test);
        const mod2 = moderator(test, 'mod2');
        tx(test, th, (ctx) => M.create_lobby_preset(ctx, presetArgs('TH preset')));
        tx(test, mod2, (ctx) => M.create_lobby_preset(ctx, presetArgs('Mod preset')));
        const thId = presetNamed(test, 'TH preset')!.id;
        tx(test, mod, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(thId, 'TH preset 2')));
        expect(test.db.LobbyPreset.id.find(thId)!.name).toBe('TH preset 2');
        tx(test, mod, (ctx) => M.delete_lobby_preset(ctx, { presetId: thId }));
        const modId = presetNamed(test, 'Mod preset')!.id;
        tx(test, mod, (ctx) => M.delete_lobby_preset(ctx, { presetId: modId }));
        expect(test.db.LobbyPreset.id.find(thId)).toBeFalsy();
        expect(presetNamed(test, 'Mod preset')).toBeFalsy();
    });
});
