// T-S10r: in-memory tests for step S10r (DECISIONS.md A122, rules 1 to 15; triage rows L1, L4, L16, L17, L21, L22,
// L32, L33, L34, L35, L40, L42, L44, L46, L51, L52, L89 of notes/audit-2026-11-09/low-findings-triage.md). Each item
// has a test of the new rule and one that the neighbouring allowed case still works. State is built through the
// module's reducers; roles, deletedAt, chat rows, Undo rows, cost-set flags and accounts are written straight into the
// in-memory datastore outside any reducer, like the earlier suites. `test.db` is read only outside `tx` bodies.
// TestClock; nothing reaches maincloud.
// T-S10r review fix pass (F4, F6, F9): character filter tests, the neutral L17 text, the L34 timer reset, L4 MmrHistory
// rows kept, an unpublished set held by a lobby kept.
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
    M,
    advance,
    ensureCharacterRef,
    expectReject,
    guest,
    lobbyRow,
    newHarness,
    now,
    priceBanNames,
    priceCharacters,
    seatOf,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from './s4-fixtures';
import { blueNames, captain, completeDraft } from './s7-fixtures';
import { createTournament, host, liveField, moderator, openTournament, register, setUserRole, verified } from './s8-fixtures';
import { byKey, deferredDuel, offlinePastGrace, openMatchLobby, seedElo, sidesOf } from './s8d-fixtures';
import { playRanked, rankedHook, validateAndFinalize } from './s10-a2-fixtures';
import { presetArgs, presetNamed, updatePresetArgs } from './s10-a1-fixtures';
import { createAchievement, fireDeletionJob } from './s10-c1-fixtures';

// ─── Texts ───────────────────────────────────────────────────────────────────

// S10r review F6: the four L17 reducers share the membership bucket but answer with a neutral text; joins and seat
// moves keep 'You are changing lobbies or seats too quickly. Please wait a moment.'.
const RATE_TEXT = 'You are doing that too quickly. Please wait a moment.';
const MOD_PRESET_TEXT = 'Moderators can only modify presets created by moderators, TOs, or themselves.';
const EMPTY_BAN_TEXT = 'EMPTY is not a character and cannot be banned.';
const NO_COST = (name: string) => `${name} has no cost in this lobby's cost set.`;
const COACH_PAUSE_TEXT = 'Coaches cannot pause the draft.';
const AUCTION_UNDO_TEXT = 'Undo is not available during the auction phase.';
const UNDO_CAP_TEXT = 'This game has reached the limit of 300 undo steps.';
const NO_AUTHORITY_TEXT = 'You do not have authority to finalize this match result.';
const HOST_AWARD_TEXT = 'Tournament hosts can only award manual achievements without an award limit.';

// ─── Builders ────────────────────────────────────────────────────────────────

const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds
const AUDIT0 = (ts: Timestamp) => ({ createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts });

const adminUpdate = (userId: number, displayName: string, username: string, roleTag = 'User') =>
    (ctx: any) => M.admin_update_user(ctx, { userId, displayName, username, roleTag });
const banBody = (s: Lobby, characterName: string) => (ctx: any) =>
    M.ban_character(ctx, { lobbyId: s.lobbyId, characterName });
const pricedBan = (s: Lobby, characterName: string) => (ctx: any) => {
    priceBanNames(ctx, s.lobbyId, [characterName]);
    return M.ban_character(ctx, { lobbyId: s.lobbyId, characterName });
};
const pricedPick = (s: Lobby, characterName: string) => (ctx: any) => {
    priceCharacters(ctx, s.lobbyId, [characterName]);
    return M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 });
};
const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });
const turnOf = (s: Lobby) => {
    const sess = session(s.test, s.lobbyId);
    return sess.draftSequence[sess.turnIndex];
};
const chatRows = (test: Harness, lobbyId: number) => [...test.db.ChatMessage.lobby_id.filter(lobbyId)];
const recordOf = (test: Harness, lobbyId: number) => [...test.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];

/** A verified Admin (role written on the row). */
function admin(test: Harness, name = 'adm'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

/**
 * Fills the lobby's chat to 50 rows with direct inserts whose createdDate runs against the id: the first row inserted
 * (lowest id of the batch) is the newest, the last one (highest id) the oldest, older than everything already there.
 * Returns the id of the oldest row by time.
 */
function fillChatTo50(test: Harness, lobbyId: number): number {
    const have = chatRows(test, lobbyId).length;
    const count = 50 - have;
    const base = test.clock.now().microsSinceUnixEpoch;
    let oldestId = -1;
    for (let i = 0; i < count; i++) {
        const ts = new Timestamp(base - BigInt((i + 1) * 1_000_000) - 3_600_000_000n);
        const row = test.db.ChatMessage.insert({
            id: 0, lobbyId, senderUserId: 0, senderType: { tag: 'System' } as any, content: `filler ${i}`,
            metadata: undefined, anonymousLabel: undefined, ...AUDIT0(ts),
        } as any);
        oldestId = row.id;
    }
    return oldestId;
}

/** Inserts `n` Undo audit rows for the lobby (sequences far above the draft's). */
function insertUndoRows(test: Harness, lobbyId: number, n: number) {
    const ts = test.clock.now();
    for (let i = 0; i < n; i++) {
        test.db.MatchSessionStep.insert({
            id: 0, lobbyId, sequence: 10_000 + i, actorUserId: 0, anonymousLabel: undefined, actorSlot: { tag: 'Spectator' } as any,
            action: { tag: 'Undo' } as any, payload: { tag: 'Undo', value: { originalSequenceId: 0 } } as any, timestamp: ts, ...AUDIT0(ts),
        } as any);
    }
}

/** A standalone Ranked Classic lobby in Drafting where any seated player may concede (no referee exclusivity); a concede finalizes inline (D-37). */
function rankedDrafting(test: Harness): Lobby {
    seedElo(test); // a standalone concede finalizes inline (MMR for Ranked)
    return setupLobby(test, {
        lobby: { refereeExclusiveConcede: false },
        beforeStart: rankedHook(test),
    });
}

// ════════════════════════════════════════════════════════════════════════════
// L1: admin_update_user
// ════════════════════════════════════════════════════════════════════════════

describe('A122(1), L1: admin_update_user applies the player rename rules, renames the solo team, refuses a user pending deletion', () => {
    it('A122(1) L1: an empty or blank display name, an empty username and names over 32 characters are rejected with the rename texts', () => {
        const test = newHarness();
        const p = verified(test, 'neo');
        expectReject(test, 'internal', adminUpdate(p.userId, '   ', 'neo'), 'Display name cannot be empty');
        expectReject(test, 'internal', adminUpdate(p.userId, 'Neo', '  '), 'Username cannot be empty');
        expectReject(test, 'internal', adminUpdate(p.userId, 'N'.repeat(33), 'neo'), 'Display name must be 32 characters or fewer');
        expectReject(test, 'internal', adminUpdate(p.userId, 'Neo', 'n'.repeat(33)), 'Username must be 32 characters or fewer');
        expect(test.db.User.id.find(p.userId)!.displayName).toBe('neo');
    });

    it('A122(1) L1: a user pending deletion (deletedAt set) is refused', () => {
        const test = newHarness();
        const p = verified(test, 'neo');
        test.db.User.id.update({ ...test.db.User.id.find(p.userId)!, deletedAt: test.clock.now() });
        expectReject(test, 'internal', adminUpdate(p.userId, 'Neo', 'neo'), `User #${p.userId} is pending deletion.`);
    });

    it('A122(1) L1: a valid edit stores the trimmed names and renames the solo team of an active non-anonymous solo tournament', () => {
        const test = newHarness();
        const org = host(test, 'org');
        const tid = openTournament(test, org, { teamSize: 1 });
        const p = verified(test, 'neo');
        register(test, p, tid);
        const team = [...test.db.TournamentTeam.captain_user_id.filter(p.userId)][0];
        expect(team.name).toBe('neo');
        tx(test, 'internal', adminUpdate(p.userId, '  Trinity  ', '  trinity  ', 'TournamentHost'));
        const user = test.db.User.id.find(p.userId)!;
        expect([user.displayName, user.username, user.role.tag]).toEqual(['Trinity', 'trinity', 'TournamentHost']);
        expect(test.db.TournamentTeam.id.find(team.id)!.name).toBe('Trinity');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L4: admin delete of a MatchSessionHistory row
// ════════════════════════════════════════════════════════════════════════════

describe('A122(2), L4: deleting a match history row removes its participant, step, game and lineup history rows', () => {
    const childCounts = (test: Harness, id: number) => [
        [...test.db.MatchParticipantHistory.by_match_history.filter(id)].length,
        [...test.db.MatchSessionStepHistory.by_match_history.filter(id)].length,
        [...test.db.MatchResultGameHistory.by_match_history.filter(id)].length,
        [...test.db.MatchLineupHistory.by_match_history.filter(id)].length,
    ];
    const actorsFor = (test: Harness, prefix: string) =>
        Object.fromEntries(['host', 'b1', 'b2', 'r1', 'r2'].map((n) => [n, guest(test, `${prefix}-${n}`)]));

    it('A122(2) L4: the deleted match loses all four kinds of child rows and keeps its MmrHistory rows; another finalized match keeps its own', () => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const first = playRanked(test, 'Blue', { actors: actorsFor(test, 'one') });
        validateAndFinalize(test, first.s, first.recId, mod, 'Blue');
        const second = playRanked(test, 'Red', { actors: actorsFor(test, 'two') });
        validateAndFinalize(test, second.s, second.recId, mod, 'Red');
        const [h1, h2] = [...test.db.MatchSessionHistory.iter()].map((h) => h.id).sort((a, b) => a - b);
        for (const id of [h1, h2]) expect(childCounts(test, id).every((n) => n > 0)).toBe(true);
        const keep = childCounts(test, h2);
        const mmrOf = (id: number) => [...test.db.MmrHistory.iter()].filter((r) => r.matchHistoryId === id).length;
        const mmrBefore = mmrOf(h1);
        expect(mmrBefore).toBeGreaterThan(0);

        tx(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'MatchSessionHistory', primaryKeyJson: String(h1) }));
        expect(test.db.MatchSessionHistory.id.find(h1)).toBeFalsy();
        expect(childCounts(test, h1)).toEqual([0, 0, 0, 0]);
        expect(test.db.MatchSessionHistory.id.find(h2)).toBeTruthy();
        expect(childCounts(test, h2)).toEqual(keep);
        // A122(2): the rating itself is not reverted, so the user's MmrHistory rows of the deleted match stay.
        expect(mmrOf(h1)).toBe(mmrBefore);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L16: system chat lines go through the shared 50-message trim
// ════════════════════════════════════════════════════════════════════════════

describe('A122(3), L16: every system chat line keeps the 50-message window and drops the oldest message by time', () => {
    it('A122(3) L16: a concede line in a full chat removes the oldest row by createdDate (not the lowest id); the lobby stays at 50', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        const { test } = f;
        const lowestId = Math.min(...chatRows(test, s.lobbyId).map((r) => r.id));
        const oldestByTime = fillChatTo50(test, s.lobbyId);
        expect(oldestByTime).toBeGreaterThan(lowestId);
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const rows = chatRows(test, s.lobbyId);
        expect(rows).toHaveLength(50);
        expect(rows.some((r) => r.id === oldestByTime)).toBe(false);
        expect(rows.some((r) => r.id === lowestId)).toBe(true);
        expect(rows.some((r) => r.content.startsWith('Match conceded.'))).toBe(true);
    });

    it('A122(3) L16: the defer line trims the same way', () => {
        const { f, s } = deferredDuel();
        const { test } = f;
        offlinePastGrace(test, s.a.b2);
        const lowestId = Math.min(...chatRows(test, s.lobbyId).map((r) => r.id));
        const oldestByTime = fillChatTo50(test, s.lobbyId);
        tx(test, f.org, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }));
        const rows = chatRows(test, s.lobbyId);
        expect(rows).toHaveLength(50);
        expect(rows.some((r) => r.id === oldestByTime)).toBe(false);
        expect(rows.some((r) => r.id === lowestId)).toBe(true);
        expect(rows.some((r) => r.content === 'Match deferred to admin/TO resolution.')).toBe(true);
    });

    it('A122(3) L16: the stage-change line of advance_stage (Equipping → Scoring) trims the same way', () => {
        const test = newHarness();
        const s = setupLobby(test);
        completeDraft(s);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        const lowestId = Math.min(...chatRows(test, s.lobbyId).map((r) => r.id));
        const oldestByTime = fillChatTo50(test, s.lobbyId);
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        const rows = chatRows(test, s.lobbyId);
        expect(rows).toHaveLength(50);
        expect(rows.some((r) => r.id === oldestByTime)).toBe(false);
        expect(rows.some((r) => r.id === lowestId)).toBe(true);
        expect(rows.some((r) => r.content === 'Lineups set. Stage: Scoring')).toBe(true);
    });

    it('A122(3) L16: below the window a system line deletes nothing', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        const { test } = f;
        const before = chatRows(test, s.lobbyId).map((r) => r.id);
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        const after = chatRows(test, s.lobbyId).map((r) => r.id);
        expect(after).toHaveLength(before.length + 1);
        expect(before.every((id) => after.includes(id))).toBe(true);
    });
});

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

// ════════════════════════════════════════════════════════════════════════════
// L22 + L89: user deletion removes presets and unpublished cost sets
// ════════════════════════════════════════════════════════════════════════════

describe('A122(6), L22, L89: user deletion removes the user\'s presets and unpublished cost sets, keeping referenced ones', () => {
    it('A122(6) L22 L89: unreferenced preset and draft set deleted (set rows too); a preset and a set an unfinished tournament points at kept; a published set kept', () => {
        const test = newHarness();
        const org = host(test, 'org');
        tx(test, org, (ctx) => M.create_lobby_preset(ctx, presetArgs('P-free')));
        tx(test, org, (ctx) => M.create_lobby_preset(ctx, presetArgs('P-held')));
        const freeId = presetNamed(test, 'P-free')!.id;
        const heldId = presetNamed(test, 'P-held')!.id;
        const mkSet = (name: string) => {
            tx(test, org, (ctx) => M.create_cost_set(ctx, { name, sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
            return [...test.db.CostSet.creator_id.filter(org.userId)].find((c) => c.name === name)!.id;
        };
        const draftFree = mkSet('draft-free');
        const draftHeld = mkSet('draft-held');
        const published = mkSet('published');
        test.db.CostSet.id.update({ ...test.db.CostSet.id.find(published)!, isPublished: true, isDraft: false });
        expect([...test.db.CostSetDraftCharacter.cost_set_id.filter(draftFree)].length).toBeGreaterThan(0);

        // An unfinished (Draft stage) tournament points at P-held and at draft-held.
        const tid = createTournament(test, org, { lobbyPresetId: heldId });
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(tid)!, costSetId: draftHeld });

        // S10s re-alignment (A124): a deletion sent as the SYSTEM user now cancels the organizer's tournaments, which would
        // end the reference this test needs; a staff Admin deletes instead (A121 hands the tournament to that Admin).
        const boss = admin(test);
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(org.userId) }));
        fireDeletionJob(test, org.userId);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
        expect(test.db.Tournament.id.find(tid)!.stage.tag).toBe('Draft');

        expect(test.db.LobbyPreset.id.find(freeId)).toBeFalsy();
        expect(test.db.LobbyPreset.id.find(heldId)).toBeTruthy();
        expect(test.db.CostSet.id.find(draftFree)).toBeFalsy();
        expect([...test.db.CostSetDraftCharacter.cost_set_id.filter(draftFree)]).toHaveLength(0);
        expect([...test.db.CostSetDraftLightcone.cost_set_id.filter(draftFree)]).toHaveLength(0);
        expect(test.db.CostSet.id.find(draftHeld)).toBeTruthy();
        expect(test.db.CostSet.id.find(published)).toBeTruthy();
        // The system preset is untouched.
        expect([...test.db.LobbyPreset.iter()].some((p) => p.isSystemPreset)).toBe(true);
    });

    it('A122(6) L89: an unpublished set a lobby still points at is kept', () => {
        const test = newHarness();
        const org = host(test, 'org');
        tx(test, org, (ctx) => M.create_cost_set(ctx, { name: 'draft-in-lobby', sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
        const setId = [...test.db.CostSet.creator_id.filter(org.userId)].find((c) => c.name === 'draft-in-lobby')!.id;
        // Another user's lobby on the set (a set unpublished after the lobby selected it; written directly).
        const other = setupLobby(test, { noStart: true });
        test.db.Lobby.id.update({ ...lobbyRow(test, other.lobbyId), costSetId: setId });
        tx(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(org.userId) }));
        fireDeletionJob(test, org.userId);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
        expect(test.db.CostSet.id.find(setId)).toBeTruthy();
        expect([...test.db.CostSetDraftCharacter.cost_set_id.filter(setId)].length).toBeGreaterThan(0);
    });

    it('A122(6) L22: a preset whose tournament has finished (Cancelled) is no longer held and goes with its creator', () => {
        const test = newHarness();
        const org = host(test, 'org');
        tx(test, org, (ctx) => M.create_lobby_preset(ctx, presetArgs('P-old')));
        const id = presetNamed(test, 'P-old')!.id;
        const tid = createTournament(test, org, { lobbyPresetId: id });
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(tid)!, stage: { tag: 'Cancelled' } as any });
        tx(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(org.userId) }));
        fireDeletionJob(test, org.userId);
        expect(test.db.LobbyPreset.id.find(id)).toBeFalsy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L32: ban names
// ════════════════════════════════════════════════════════════════════════════

describe('A122(7), L32: a ban names a real character of the lobby\'s pool; EMPTY is not a manual ban', () => {
    it('A122(7) L32: a manual EMPTY ban and a name without a cost row in the lobby\'s cost set are rejected; the turn stays', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' } } });
        expectReject(test, captain(s, 'Blue'), banBody(s, 'EMPTY'), EMPTY_BAN_TEXT);
        expectReject(test, captain(s, 'Blue'), banBody(s, 'ghost'), NO_COST('ghost'));
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(0);
    });

    it('A122(7) L32: a priced character is banned; the timer\'s empty ban is SKIP and a manual EMPTY pick still goes through', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' } } });
        priceCharacters(test, s.lobbyId, ['kafka']);
        tx(test, captain(s, 'Blue'), banBody(s, 'kafka'));
        // Red's ban turn expires (autoRandomPick off): the SKIP sentinel, system actor.
        advance(test, TURN_MS);
        tx(test, s.host, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
        const bans = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban').map((x) => (x.payload.value as any).characterName);
        expect(bans).toEqual(['kafka', 'SKIP']);
        expect(turnOf(s)).toMatchObject({ actionRequired: { tag: 'Pick' }, teamTurn: { tag: 'Blue' } });
        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'EMPTY', eidolon: 0 }));
        const pick = steps(test, s.lobbyId).find((x) => x.action.tag === 'Pick')!;
        expect((pick.payload.value as any).characterName).toBe('EMPTY');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L33: a coach cannot pause
// ════════════════════════════════════════════════════════════════════════════

describe('A122(8), L33: a coach cannot pause the draft', () => {
    const SEATS: Array<[string, 'BluePlayer' | 'BlueCoach' | 'RedPlayer']> = [
        ['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'],
    ];

    it('A122(8) L33: the coach\'s pause is rejected and uses none of the team\'s three pauses', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        expectReject(test, s.a.bc, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }), COACH_PAUSE_TEXT);
        const sess = session(test, s.lobbyId);
        expect([sess.timerState.isPaused, sess.pausesUsedBlue]).toEqual([false, 0]);
    });

    it('A122(8) L33: a player of the same team still pauses (one of three); the coach cannot resume that pause', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        tx(test, s.a.b2, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        const sess = session(test, s.lobbyId);
        expect([sess.timerState.isPaused, sess.pausesUsedBlue]).toEqual([true, 1]);
        expectReject(test, s.a.bc, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }),
            'Only the referee or the player who paused can resume the draft.');
        tx(test, s.a.b2, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L34: undo of the last Auction ban
// ════════════════════════════════════════════════════════════════════════════

describe('A122(9), L34: the last ban of the Auction ban phase can be undone', () => {
    const AUCTION_FOUR = { draftMode: { tag: 'Auction' }, banMode: { tag: 'Four' } };
    function banAll(s: Lobby, names: string[]) {
        for (const name of names) {
            tx(s.test, captain(s, turnOf(s).teamTurn.tag as 'Blue' | 'Red'), pricedBan(s, name));
        }
    }

    it('A122(9) L34: before any nomination the undo deletes the fourth ban, reopens its turn with a fresh timer and clears the auction phase; the team bans again', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION_FOUR });
        banAll(s, ['ban-a', 'ban-b', 'ban-c', 'ban-d']);
        const fourth = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban').sort((a, b) => b.sequence - a.sequence)[0];
        expect(session(test, s.lobbyId)).toMatchObject({ isAuctionPhase: true, turnIndex: 4 });

        advance(test, 5_000);
        tx(test, s.host, undoBody(s));
        const sess = session(test, s.lobbyId);
        expect([sess.isAuctionPhase, sess.turnIndex]).toEqual([false, 3]);
        // The turn timer restarts at the undo.
        expect(sess.timerState.turnStartAt.microsSinceUnixEpoch).toBe(now(test));
        expect(sess.timerState.accumulatedPauseMs).toBe(0);
        const bans = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban').map((x) => (x.payload.value as any).characterName);
        expect(bans.sort()).toEqual(['ban-a', 'ban-b', 'ban-c']);
        const undoRow = steps(test, s.lobbyId).find((x) => x.action.tag === 'Undo')!;
        expect((undoRow.payload.value as any).originalSequenceId).toBe(fourth.sequence);
        expect(turnOf(s)).toMatchObject({ actionRequired: { tag: 'Ban' }, teamTurn: fourth.actorSlot });

        banAll(s, ['ban-e']);
        expect(session(test, s.lobbyId)).toMatchObject({ isAuctionPhase: true, turnIndex: 4 });
    });

    // S10s re-alignment (A125): the window now ends at the first bid, not the first nomination; this test bids first.
    it('A122(9) L34 / A125: once a bid exists the undo is refused and the bans stay', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION_FOUR });
        banAll(s, ['ban-a', 'ban-b', 'ban-c', 'ban-d']);
        const nominator = session(test, s.lobbyId).nextNominatorTeam.tag as 'Blue' | 'Red';
        tx(test, captain(s, nominator), (ctx) => {
            priceCharacters(ctx, s.lobbyId, ['nominee']);
            return M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'nominee' });
        });
        tx(test, captain(s, nominator === 'Blue' ? 'Red' : 'Blue'), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }));
        expectReject(test, s.host, undoBody(s), AUCTION_UNDO_TEXT);
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(4);
        expect(session(test, s.lobbyId).isAuctionPhase).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L35: Undo rows count toward the cap
// ════════════════════════════════════════════════════════════════════════════

describe('A122(10), L35: Undo rows count toward the edit-step cap (300 per game)', () => {
    it('A122(10) L35: with 300 Undo rows in the game the next undo is refused and the pick stays', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), pricedPick(s, 'p1'));
        insertUndoRows(test, s.lobbyId, 300);
        expectReject(test, s.host, undoBody(s), UNDO_CAP_TEXT);
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Pick')).toHaveLength(1);
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
    });

    it('A122(10) L35: with 299 Undo rows the undo is accepted (the 300th row)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), pricedPick(s, 'p1'));
        insertUndoRows(test, s.lobbyId, 299);
        tx(test, s.host, undoBody(s));
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Undo')).toHaveLength(300);
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L40: the archived spent budget of a match that ended during the draft
// ════════════════════════════════════════════════════════════════════════════

describe('A122(11), L40: a match that ended during the draft archives the budget actually spent', () => {
    // The archived value is read from the session budgets (D-88). Auction sales move them; Classic picks do not (pick
    // costs are in neither budget). A Classic match that ends during the draft therefore archives 0; a finished one
    // archives what moved after the D-50 carryover (light-cone equips and eidolon changes), as before S10r.

    it('A122(11) L40: Auction, Blue buys a 7-cost character and concedes mid-auction: history shows Blue 7, Red 0 (not the whole character budget)', () => {
        const test = newHarness();
        seedElo(test);
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' }, refereeExclusiveConcede: false }, beforeStart: rankedHook(test) });
        expect(session(test, s.lobbyId)).toMatchObject({ isAuctionPhase: true, nextNominatorTeam: { tag: 'Blue' } });
        tx(test, captain(s, 'Blue'), (ctx) => {
            priceCharacters(ctx, s.lobbyId, ['c7'], 7);
            return M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'c7' });
        });
        tx(test, captain(s, 'Red'), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        expect(session(test, s.lobbyId).teamBlueCharBudget).toBe(93);
        tx(test, s.a.b1, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 })); // finalized inline (D-37)
        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1);
        expect([history[0].teamBlueSpent, history[0].teamRedSpent]).toEqual([7, 0]);
    });

    it('A122(11) L40: Classic, conceded in Drafting before the carryover: no team is shown as having spent its character budget', () => {
        const test = newHarness();
        const s = rankedDrafting(test);
        priceCharacters(test, s.lobbyId, ['c7'], 7);
        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'c7', eidolon: 0 }));
        tx(test, s.a.b1, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 })); // finalized inline (D-37)
        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1);
        expect([history[0].teamBlueSpent, history[0].teamRedSpent]).toEqual([0, 0]);
    });

    it('A122(11) L40: a Classic match drafted to the end (carryover done) archives the same value as before the fix', () => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Blue', { afterStart: (l) => priceCharacters(test, l.lobbyId, blueNames(), 2) });
        const sess = session(test, s.lobbyId);
        const lobby = lobbyRow(test, s.lobbyId);
        expect([sess.teamBlueCharBudget, sess.teamRedCharBudget]).toEqual([0, 0]);
        validateAndFinalize(test, s, recId, mod, 'Blue');
        const history = [...test.db.MatchSessionHistory.iter()];
        // D-88 before S10r: characterBudget + lightconeBudget - teamXLcBudget (the carryover left the char budget at 0).
        expect(history[0].teamBlueSpent).toBe(lobby.characterBudget + lobby.lightconeBudget - sess.teamBlueLcBudget);
        expect(history[0].teamRedSpent).toBe(lobby.characterBudget + lobby.lightconeBudget - sess.teamRedLcBudget);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L42: achievement criteria fields and tags
// ════════════════════════════════════════════════════════════════════════════

describe('A122(12), L42: add_achievement_criteria rejects unknown fields and unknown filter tags', () => {
    const criteria = (achievementId: number, over: Record<string, unknown>) => (ctx: any) => M.add_achievement_criteria(ctx, {
        achievementId, statTable: 'PlayerStat', statField: 'matchesPlayed', operator: { tag: 'LessThan' } as any, thresholdValue: 1,
        filterGameMode: undefined, filterCharacterName: undefined, filterMatchType: undefined, ...over,
    } as any);

    it('A122(12) L42: a field the table does not carry, a mistyped game mode and a mistyped match type are rejected; nothing is stored', () => {
        const test = newHarness();
        const id = createAchievement(test, 'internal', 'auto', false);
        expectReject(test, 'internal', criteria(id, { statField: 'timesFaced' }), /Invalid statField "timesFaced" for PlayerStat/);
        expectReject(test, 'internal', criteria(id, { statTable: 'MmrRating', statField: 'ratng' }), /Invalid statField "ratng" for MmrRating/);
        expectReject(test, 'internal', criteria(id, { filterGameMode: 'MemoryOfChoas' }), /Invalid filterGameMode "MemoryOfChoas"/);
        expectReject(test, 'internal', criteria(id, { filterMatchType: 'ranked' }), /Invalid filterMatchType "ranked"/);
        expect([...test.db.AchievementCriteria.by_achievement.filter(id)]).toHaveLength(0);
    });

    it('A122(12) L42 (review F4): a character filter that names no character is rejected', () => {
        const test = newHarness();
        const id = createAchievement(test, 'internal', 'auto', false);
        expectReject(test, 'internal', criteria(id, { statTable: 'PlayerCharacterStat', statField: 'wins', filterCharacterName: 'Kafak' }),
            'Invalid filterCharacterName "Kafak". No such character.');
        expect([...test.db.AchievementCriteria.by_achievement.filter(id)]).toHaveLength(0);
    });

    it('A122(12) L42 (review F4): an existing character is accepted as a filter; an empty name is stored as no filter', () => {
        const test = newHarness();
        ensureCharacterRef(test, 'Kafka');
        const id = createAchievement(test, 'internal', 'auto', false);
        tx(test, 'internal', criteria(id, { statTable: 'PlayerCharacterStat', statField: 'wins', filterCharacterName: 'Kafka' }));
        tx(test, 'internal', criteria(id, { statTable: 'PlayerCharacterStat', statField: 'losses', filterCharacterName: '' }));
        const rows = [...test.db.AchievementCriteria.by_achievement.filter(id)].sort((a, b) => a.id - b.id);
        expect(rows.map((r) => r.filterCharacterName)).toEqual(['Kafka', undefined]);
    });

    it('A122(12) L42: valid fields per table and real GameMode / MatchType tags are accepted', () => {
        const test = newHarness();
        const id = createAchievement(test, 'internal', 'auto', false);
        tx(test, 'internal', criteria(id, { statField: 'wins', filterGameMode: 'MemoryOfChaos', filterMatchType: 'Ranked' }));
        tx(test, 'internal', criteria(id, { statTable: 'PlayerCharacterStat', statField: 'timesFaced' }));
        tx(test, 'internal', criteria(id, { statTable: 'MmrRating', statField: 'rating' }));
        expect([...test.db.AchievementCriteria.by_achievement.filter(id)]).toHaveLength(3);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L44: the rating config
// ════════════════════════════════════════════════════════════════════════════

describe('A122(12), L44: admin_update_elo_config rejects a divisor of 0 and inverted thresholds', () => {
    it('A122(12) L44: spreadDivisor 0 and newThreshold above midThreshold (alone or after a merge) are rejected; the row is unchanged', () => {
        const test = newHarness();
        seedElo(test);
        const before = test.db.EloConfigTable.id.find(1)!;
        expectReject(test, 'internal', (ctx) => M.admin_update_elo_config(ctx, { spreadDivisor: 0 } as any), 'spreadDivisor must be greater than 0.');
        expectReject(test, 'internal', (ctx) => M.admin_update_elo_config(ctx, { newThreshold: 101 } as any),
            'newThreshold must not be greater than midThreshold.');
        expectReject(test, 'internal', (ctx) => M.admin_update_elo_config(ctx, { newThreshold: 50, midThreshold: 40 } as any),
            'newThreshold must not be greater than midThreshold.');
        const after = test.db.EloConfigTable.id.find(1)!;
        expect([after.spreadDivisor, after.newThreshold, after.midThreshold]).toEqual([before.spreadDivisor, before.newThreshold, before.midThreshold]);
    });

    it('A122(12) L44: a positive divisor and equal thresholds are accepted', () => {
        const test = newHarness();
        seedElo(test);
        tx(test, 'internal', (ctx) => M.admin_update_elo_config(ctx, { spreadDivisor: 3, newThreshold: 100 } as any));
        const row = test.db.EloConfigTable.id.find(1)!;
        expect([row.spreadDivisor, row.newThreshold, row.midThreshold]).toEqual([3, 100, 100]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L46: hosts award only manual achievements
// ════════════════════════════════════════════════════════════════════════════

describe('A122(13), L46: a tournament host awards only manual achievements', () => {
    function hostWithPlayer() {
        const test = newHarness();
        const org = host(test, 'org');
        const tid = openTournament(test, org, { teamSize: 1 });
        const p = verified(test, 'player');
        register(test, p, tid);
        return { test, org, p };
    }

    it('A122(13) L46: an automatic achievement and a capped manual one are refused to the host', () => {
        const { test, org, p } = hostWithPlayer();
        const auto = createAchievement(test, 'internal', 'auto', false);
        const capped = createAchievement(test, 'internal', 'capped', true, 5);
        expectReject(test, org, (ctx) => M.manual_award_achievement(ctx, { achievementId: auto, targetUserId: p.userId }), HOST_AWARD_TEXT);
        expectReject(test, org, (ctx) => M.manual_award_achievement(ctx, { achievementId: capped, targetUserId: p.userId }), HOST_AWARD_TEXT);
        expect([...test.db.UserAchievement.by_user.filter(p.userId)]).toHaveLength(0);
    });

    it('A122(13) L46: the host awards an uncapped manual achievement; a Moderator still awards an automatic and a capped one', () => {
        const { test, org, p } = hostWithPlayer();
        const manual = createAchievement(test, 'internal', 'manual', true);
        const auto = createAchievement(test, 'internal', 'auto', false);
        const capped = createAchievement(test, 'internal', 'capped', true, 5);
        tx(test, org, (ctx) => M.manual_award_achievement(ctx, { achievementId: manual, targetUserId: p.userId }));
        const mod = moderator(test);
        tx(test, mod, (ctx) => M.manual_award_achievement(ctx, { achievementId: auto, targetUserId: p.userId }));
        tx(test, mod, (ctx) => M.manual_award_achievement(ctx, { achievementId: capped, targetUserId: p.userId }));
        expect([...test.db.UserAchievement.by_user.filter(p.userId)]).toHaveLength(3);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L51: who finalizes
// ════════════════════════════════════════════════════════════════════════════

describe('A122(14), L51: finalizing a result is a power of the lobby\'s referee and staff, not of whoever closed the game', () => {
    /**
     * A standalone Ranked game closed by the host referee (the record's refereeUserId = the closer, Submitted), the
     * referee flag then handed to r1, and the record validated by a Moderator (override_match_result).
     */
    function validatedAfterHandOver() {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Blue');
        expect(test.db.MatchResultRecord.id.find(recId)!.refereeUserId).toBe(s.host.userId);
        const seat = seatOf(test, s.lobbyId, s.a.r1.userId);
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seat }));
        tx(test, mod, (ctx) => M.override_match_result(ctx, { matchResultId: recId, newStatusTag: 'Validated', winnerTeamSideTag: 'Blue', reason: 'reviewed' }));
        return { test, s, recId, mod };
    }

    it('A122(14) L51: the member who closed the game but no longer holds the referee flag cannot finalize; the lobby\'s referee can', () => {
        const { test, s, recId } = validatedAfterHandOver();
        expectReject(test, s.host, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }), NO_AUTHORITY_TEXT);
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(0);
        tx(test, s.a.r1, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }));
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);
    });

    it('A122(14) L51: a captain without the flag cannot finalize; a Moderator who is not in the lobby can', () => {
        const { test, s, recId, mod } = validatedAfterHandOver();
        expectReject(test, captain(s, 'Blue'), (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }), NO_AUTHORITY_TEXT);
        tx(test, mod, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }));
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L52: a seated referee conceding their own team
// ════════════════════════════════════════════════════════════════════════════

describe('A122(15), L52: a seated referee conceding their own team is a surrender', () => {
    it('A122(15) L52: the Blue captain created the match lobby (seated referee) and concedes Blue: concedeTrigger VoluntaryLeave', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const creator = sidesOf(f, m.id).blue.captain;
        const s = openMatchLobby(f, m.id, { creator });
        const { test } = f;
        const row = [...test.db.LobbyMember.by_lobby_and_user.filter([s.lobbyId, creator.userId])][0];
        expect([row.isReferee, row.lobbySlot.tag]).toEqual([true, 'BluePlayer']);
        tx(test, creator, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 }));
        const rec = recordOf(test, s.lobbyId);
        expect([rec.winnerTeamSide!.tag, rec.concedeTrigger!.tag]).toEqual(['Red', 'VoluntaryLeave']);
    });

    it('A122(15) L52: the unseated (Spectator) referee concedes a team: RefereeDecision', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        tx(f.test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        const rec = recordOf(f.test, s.lobbyId);
        expect([rec.winnerTeamSide!.tag, rec.concedeTrigger!.tag]).toEqual(['Blue', 'RefereeDecision']);
    });
});
