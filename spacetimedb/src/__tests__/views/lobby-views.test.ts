// Views: the lobby views (member ratings and presence, my lobbies, the browser, presets, bans).
// Decisions: A40, A48, A68
// Contracts: docs/views/contract.md
// From S9a (s9a-views.test.ts).
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
    Lobby as LobbyBinding,
    LobbyBanViewRow,
    LobbyBrowserRow,
    LobbyMemberViewRow,
    LobbyPresetViewRow,
    MyLobbyListRow,
} from '@bindings/types';
import type { tables as bindingTables } from '@bindings/index';
import { lobbyColumns } from '@module/tables/lobby/lobby';
import { computeLobbyMemberRating } from '@module/helpers/stats/accountRating';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    connect,
    disconnect,
    guest,
    lobbyRow,
    member,
    newHarness,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
    AUDIT,
} from '../fixtures/harness';
import { host as tournamentHost, verified, displayName } from '../fixtures/identity';
import { seatLabel, leave, PRESET_ARGS } from '../fixtures/lobby';
import {
    ANON,
    AUDIT_KEYS,
    COLS,
    USER_ID_KEY,
    expectOnlyColumns,
    keysOf,
    lobbyOf,
    rowFor,
    seatsOf,
    shared,
    view,
    selectRatedAccount,
} from '../fixtures/views';
import { seedElo } from '../fixtures/tournament-matches';
import { parkedLobby } from '../fixtures/ranked';

const createCasual = (test: Harness, who: Actor, over: Record<string, unknown> = {}) =>
    tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...over } as any));
const hostedBy = (test: Harness, who: Actor) => [...test.db.Lobby.iter()].filter((l) => l.hostUserId === who.userId);

/** Sets a LobbyMember flag directly (the table has no primary key: delete + insert the same row). */
function patchMember(test: Harness, lobbyId: number, userId: number, patch: Record<string, unknown>) {
    const row = member(test, lobbyId, userId);
    test.db.LobbyMember.delete(row);
    test.db.LobbyMember.insert({ ...row, ...patch } as any);
}


const ratingOf = (test: Harness, lobbyId: number, userId: number) =>
    Math.round(tx(test, 'internal', (ctx) => computeLobbyMemberRating(ctx, lobbyId, userId)));

// ════════════════════════════════════════════════════════════════════════════
// Ratings (A40)
// ════════════════════════════════════════════════════════════════════════════

describe('A40 ratings on member rows', () => {
    /** A Waiting lobby where b1 has one rated account, b2 two, r1 one; r2 none; an MMR row for b1 (MoC, pre-season). */
    function rated(lobby: Record<string, unknown>) {
        const test = newHarness();
        seedElo(test); // EloConfig.initialRating = 1000 for a mode never played (interpretation 12)
        // a verified host: D-23 forces ClosedNoRating on a guest host's lobby
        const s = setupLobby(test, { lobby, noStart: true, actors: { host: verified(test, 'host') } });
        expect(lobbyRow(test, s.lobbyId).rosterVisibility.tag).toBe(((lobby.rosterVisibility as any)?.tag) ?? 'OpenRoster');
        selectRatedAccount(test, s.lobbyId, s.a.b1, 'b1-acc', 1234);
        selectRatedAccount(test, s.lobbyId, s.a.b2, 'b2-acc1', 900);
        selectRatedAccount(test, s.lobbyId, s.a.b2, 'b2-acc2', 1100);
        selectRatedAccount(test, s.lobbyId, s.a.r1, 'r1-acc', 777);
        test.db.MmrRating.insert({
            userId: s.a.b1.userId, gameMode: { tag: 'MemoryOfChaos' }, rating: 1500, matchesPlayed: 3,
            globalCompositeRating: undefined, seasonId: 0, ...AUDIT(test),
        } as any);
        const rows = (who: Actor) => view<LobbyMemberViewRow>(test, 'view_my_lobby_members', who);
        return { test, s, rows };
    }

    it('mmrByMode on an identified seat when hideMmr is off: the active-season rating per mode, initialRating for a mode never played', () => {
        const { s, rows } = rated({});
        const b1 = rows(s.a.r1).find((r) => r.userId === s.a.b1.userId)!;
        expect(b1.mmrByMode).toEqual([1500, 1000, 1000]);
    });

    it('hideMmr = true: no seat carries mmrByMode (the caller\'s own included); the account rating stays', () => {
        const { test, s, rows } = rated({ hideMmr: true });
        const all = rows(s.a.b1);
        expect(all.every((r) => r.mmrByMode === undefined)).toBe(true);
        expect(all.find((r) => r.userId === s.a.b1.userId)!.accountRating).toBe(ratingOf(test, s.lobbyId, s.a.b1.userId));
    });

    it('OpenRoster: accountRating / accountCount on every seat (anonymized included) equal computeLobbyMemberRating and the selected-account count', () => {
        const { test, s, rows } = rated({ ...ANON, rosterVisibility: { tag: 'OpenRoster' } });
        const red = rows(s.a.r1);
        for (const [who, count] of [[s.a.b1, 1], [s.a.b2, 2]] as const) {
            const row = rowFor(red, seatLabel(test, s.lobbyId, who.userId)); // T-S10h (A97)
            expect(row.userId).toBe(0);
            expect(row.mmrByMode).toBeUndefined(); // anonymized: no MMR (A40)
            expect(row.accountRating).toBe(ratingOf(test, s.lobbyId, who.userId));
            expect(row.accountCount).toBe(count);
        }
        expect(rowFor(red, seatLabel(test, s.lobbyId, s.a.b1.userId)).accountRating).toBe(1234);
        const r2 = red.find((r) => r.userId === s.a.r2.userId)!;
        expect(r2.accountCount).toBe(0);
    });

    it('S9a-A3 / S9a-V5: ClosedWithRating shows the exact rating and count on an anonymized seat, without MMR, avatar or title', () => {
        const { test, s, rows } = rated({ ...ANON, rosterVisibility: { tag: 'ClosedWithRating' } });
        const blue1 = rowFor(rows(s.a.r1), seatLabel(test, s.lobbyId, s.a.b1.userId)); // T-S10h (A97)
        expect(blue1.userId).toBe(0);
        expect(blue1.accountRating).toBe(1234);
        expect(blue1.accountRating).toBe(ratingOf(test, s.lobbyId, s.a.b1.userId));
        expect(blue1.accountCount).toBe(1);
        expect(blue1.mmrByMode).toBeUndefined();
        expect(blue1.avatarCharacterName).toBeUndefined();
        expect(blue1.displayedAchievementId).toBeUndefined();
        // an identified teammate carries everything
        const mate = rows(s.a.r1).find((r) => r.userId === s.a.r2.userId)!;
        expect(mate.mmrByMode).toEqual([1000, 1000, 1000]);
        expect(mate.accountRating).toBeDefined();
    });

    it('ClosedNoRating: opponents carry no rating; the caller\'s own and a teammate\'s do; the spectator referee reads every rating (interpretation 7)', () => {
        const { test, s, rows } = rated({ rosterVisibility: { tag: 'ClosedNoRating' } });
        const red = rows(s.a.r1);
        for (const who of [s.a.b1, s.a.b2]) {
            const row = red.find((r) => r.userId === who.userId)!;
            expect(row.accountRating, who.sub).toBeUndefined();
            expect(row.accountCount, who.sub).toBeUndefined();
        }
        expect(red.find((r) => r.userId === s.a.r1.userId)!.accountRating).toBe(777);
        expect(red.find((r) => r.userId === s.a.r2.userId)!.accountRating).toBe(ratingOf(test, s.lobbyId, s.a.r2.userId));
        const ref = rows(s.host);
        expect(ref.find((r) => r.userId === s.a.b1.userId)!.accountRating).toBe(1234);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Presence (A68(10), A48)
// ════════════════════════════════════════════════════════════════════════════

describe('A68(10) / A48: view_my_lobby_members presence state', () => {
    it('S9a-V4: Online (connected), Online (membership offline, live presence row), Offline, Away after a live Leave, Gone after abandonCurrentMatch', () => {
        const test = newHarness();
        const s = setupLobby(test); // Drafting
        connect(test, s.a.b1);
        patchMember(test, s.lobbyId, s.a.b2.userId, { isOnline: false }); // the guest login left a live UserPresence row
        expect([...test.db.UserPresence.user_id.filter(s.a.b2.userId)].some((p) => p.isOnline)).toBe(true);
        disconnect(test, s.a.r1);
        leave(test, s.a.r2, s.lobbyId);
        expect([...test.db.UserPresence.user_id.filter(s.a.r2.userId)].some((p) => p.isOnline)).toBe(true);

        const presenceOf = (who: Actor) =>
            view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.b1).find((r) => r.userId === who.userId)!.presence.tag;
        expect(presenceOf(s.a.b1)).toBe('Online');
        expect(presenceOf(s.a.b2)).toBe('Online');
        expect(presenceOf(s.a.r1)).toBe('Offline');
        expect(presenceOf(s.a.r2)).toBe('Away');

        createCasual(test, s.a.r2, { abandonCurrentMatch: true });
        expect(presenceOf(s.a.r2)).toBe('Gone');
    });

    it('the member row has no isOnline / displayName / lastCursorAt / lastLineupAt / audit keys; memberKey = lobbyId << 32 | joinSeq', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const rows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.b1);
        for (const row of rows) {
            expect(keysOf(row)).toEqual([...COLS.member].sort());
            for (const k of ['isOnline', 'displayName', 'lastCursorAt', 'lastLineupAt', ...AUDIT_KEYS]) expect(k in row, k).toBe(false);
            expect(row.memberKey).toBe((BigInt(row.lobbyId) << 32n) | BigInt(row.joinSeq));
        }
        expect(new Set(rows.map((r) => r.memberKey)).size).toBe(rows.length);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_my_lobby / view_my_lobbies (PAGE-MAP D10; §A.4 P1; A68(4)(10))
// ════════════════════════════════════════════════════════════════════════════

describe('view_my_lobby / view_my_lobbies', () => {
    it('a member reads the full Lobby row (no password column) and the layer-0 row', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { isPublic: false, password: 'secret' }, seats: [], noStart: true });
        const [full] = view<LobbyBinding>(test, 'view_my_lobby', s.host);
        expectOnlyColumns(full, Object.keys(lobbyColumns));
        expect(Object.keys(full).filter((k) => /password/i.test(k))).toEqual([]);
        expect(full.id).toBe(s.lobbyId);
        expect(full.hostUserId).toBe(s.host.userId);
        const [small] = view<MyLobbyListRow>(test, 'view_my_lobbies', s.host);
        expect(keysOf(small)).toEqual([...COLS.myLobbies].sort());
        expect(small).toMatchObject({ id: s.lobbyId, joinCode: lobbyRow(test, s.lobbyId).joinCode, isAway: false });
        expect(small.stage.tag).toBe('Waiting');
    });

    it('S9a-V2: an away membership is listed (isAway = true) in both views; an abandoned one is dropped from both', () => {
        const test = newHarness();
        const s = setupLobby(test);
        leave(test, s.a.r1, s.lobbyId);
        expect(view<MyLobbyListRow>(test, 'view_my_lobbies', s.a.r1)).toEqual([expect.objectContaining({ id: s.lobbyId, isAway: true })]);
        expect(view<LobbyBinding>(test, 'view_my_lobby', s.a.r1).map((l) => l.id)).toEqual([s.lobbyId]);
        createCasual(test, s.a.r1, { abandonCurrentMatch: true });
        const fresh = hostedBy(test, s.a.r1)[0].id;
        expect(view<MyLobbyListRow>(test, 'view_my_lobbies', s.a.r1).map((l) => l.id)).toEqual([fresh]);
        expect(view<LobbyBinding>(test, 'view_my_lobby', s.a.r1).map((l) => l.id)).toEqual([fresh]);
    });

    it('a Waiting-stage spectator reads the lobby in both views', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: [['b1', 'BluePlayer'], ['spec', 'Spectator']], noStart: true });
        expect(view<LobbyBinding>(test, 'view_my_lobby', s.a.spec).map((l) => l.id)).toEqual([s.lobbyId]);
        expect(view<MyLobbyListRow>(test, 'view_my_lobbies', s.a.spec).map((l) => l.id)).toEqual([s.lobbyId]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_lobby_browser (S9a-V1; F17, D-A4, D-A8, A68(8); interpretation 2)
// ════════════════════════════════════════════════════════════════════════════

describe('view_lobby_browser (anonymous shared)', () => {
    function browserWorld() {
        const test = newHarness();
        const named = lobbyOf(test, 'n', { lobby: { name: 'Scrim', maxSpectators: 5 }, noStart: true,
            seats: [['nb1', 'BluePlayer'], ['nc', 'BlueCoach'], ['ns1', 'Spectator'], ['ns2', 'Spectator']] });
        const priv = lobbyOf(test, 'v', { lobby: { isPublic: false, password: 'secret' }, seats: [], noStart: true });
        // a spectator host is hidden only under isAnonymousSpectators (S9a fix pass; aligned in the T-S9a follow-up)
        const anon = lobbyOf(test, 'a', { lobby: { ...ANON, isAnonymousSpectators: true, name: 'Masked' }, seats: [], noStart: true });
        const empty = lobbyOf(test, 'e', { seats: [], noStart: true });
        const drafting = lobbyOf(test, 'd');
        // T-S10d (A91(2)): parked through a submitted Ranked game instead of a standalone Deferred defer.
        const parked = parkedLobby(test, { seats: seatsOf('k'), actors: { host: guest(test, 'khost') } });
        expect(lobbyRow(test, parked.lobbyId).stage.tag).toBe('AwaitingResult');
        const rows = shared<LobbyBrowserRow>(test, 'view_lobby_browser');
        const byId = (s: Lobby) => rows.find((r) => r.id === s.lobbyId);
        return { test, rows, byId, named, priv, anon, empty, drafting, parked };
    }

    it('a public Waiting lobby: its name, joinCode, the host\'s display name, coach / spectator counts and maxSpectators', () => {
        const { test, byId, named } = browserWorld();
        const row = byId(named)!;
        expect(row.name).toBe('Scrim');
        expect(row.joinCode).toBe(lobbyRow(test, named.lobbyId).joinCode);
        expect(row.hostLabel).toBe(displayName(test, named.host));
        expect(row.coachCount).toBe(1);
        expect(row.spectatorCount).toBe(3); // the host (exclusive spectator referee) + two spectators
        expect(row.maxSpectators).toBe(5);
        expect(row.currentPlayerCount).toBe(lobbyRow(test, named.lobbyId).currentPlayerCount);
        expect(row.stage.tag).toBe('Waiting');
    });

    it('interpretation 2: a private lobby is listed without a joinCode; its empty name reads "Private lobby" (never the code)', () => {
        const { test, byId, priv } = browserWorld();
        const row = byId(priv)!;
        expect(row.joinCode).toBeUndefined();
        expect(row.name).toBe('Private lobby');
        expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
            .not.toContain(lobbyRow(test, priv.lobbyId).joinCode);
        expect(row.isPublic).toBe(false);
    });

    it('D-A4: an anonymous lobby (players and spectators, spectator host) reads hostLabel "Anonymous host"; no row carries a user id or the host\'s name', () => {
        const { test, rows, byId, anon } = browserWorld();
        expect(byId(anon)!.hostLabel).toBe('Anonymous host');
        expect(JSON.stringify(byId(anon), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
            .not.toContain(displayName(test, anon.host));
        for (const row of rows) expect(Object.keys(row).filter((k) => USER_ID_KEY.test(k))).toEqual([]);
    });

    it('D-A8: a public lobby with an empty name reads "Lobby <joinCode>"', () => {
        const { test, byId, empty } = browserWorld();
        expect(byId(empty)!.name).toBe(`Lobby ${lobbyRow(test, empty.lobbyId).joinCode}`);
    });

    it('S8e-V2 / A68(8): a Drafting lobby is listed (spectators may join it); an AwaitingResult lobby is not', () => {
        const { byId, drafting, parked } = browserWorld();
        expect(byId(drafting)?.stage.tag).toBe('Drafting');
        expect(byId(parked)).toBeUndefined();
    });

    it('egress: the row carries exactly the documented columns, no series fields (A67(2))', () => {
        const { rows } = browserWorld();
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(keysOf(row)).toEqual([...COLS.browser].sort());
            for (const k of ['bestOf', 'bestOfNAdvantage', 'refereeControlsShelving']) expect(k in row).toBe(false);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_lobby_presets (S9a-V6; A33a; LobbyPreset private)
// ════════════════════════════════════════════════════════════════════════════

describe('view_lobby_presets', () => {
    it('the system preset plus the caller\'s own presets, without audit columns; another user\'s preset and a non-system SYSTEM preset are absent', () => {
        const test = newHarness();
        const alice = tournamentHost(test, 'alice');
        const bob = tournamentHost(test, 'bob');
        tx(test, alice, (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'alice-1' } as any));
        tx(test, alice, (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'alice-2' } as any));
        tx(test, bob, (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'bob-1' } as any));
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'system-owned, not the system preset' } as any));
        const rows = view<LobbyPresetViewRow>(test, 'view_lobby_presets', alice);
        expect(rows.filter((r) => r.isSystemPreset)).toHaveLength(1);
        expect(rows.filter((r) => !r.isSystemPreset).map((r) => r.name).sort()).toEqual(['alice-1', 'alice-2']);
        for (const row of rows) for (const k of AUDIT_KEYS) expect(k in row, k).toBe(false);
        expect(view<LobbyPresetViewRow>(test, 'view_lobby_presets', bob).map((r) => r.name)).not.toContain('alice-1');
    });

    it('LobbyPreset is private: the generated client bindings expose view_lobby_presets and no lobby_preset table (type-level)', () => {
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('lobbyPreset');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('lobby_preset');
        expectTypeOf<typeof bindingTables>().toHaveProperty('viewLobbyPresets');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_my_lobby_bans (S9a-V6; PAGE-MAP D4)
// ════════════════════════════════════════════════════════════════════════════

describe('view_my_lobby_bans', () => {
    function banned(lobby: Record<string, unknown> = {}, opts: SetupOpts = {}) {
        const test = newHarness();
        const s = setupLobby(test, { lobby, noStart: true, ...opts });
        const target = guest(test, 'target');
        tx(test, target, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, target.userId) }));
        return { test, s, target };
    }

    it('the host (the referee) reads the lobby\'s bans with the banned user\'s name; a plain member reads nothing', () => {
        const { test, s, target } = banned();
        const rows = view<LobbyBanViewRow>(test, 'view_my_lobby_bans', s.host);
        expect(rows).toHaveLength(1);
        expect(keysOf(rows[0])).toEqual([...COLS.ban].sort());
        expect(rows[0]).toMatchObject({ lobbyId: s.lobbyId, bannedUserId: target.userId, bannedByUserId: s.host.userId });
        expect(rows[0].label).toBe(displayName(test, target));
        expect(view(test, 'view_my_lobby_bans', s.a.b1)).toEqual([]);
    });

    it('a referee who is not the host reads the bans', () => {
        const { test, s } = banned();
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        expect(view(test, 'view_my_lobby_bans', s.a.r1)).toHaveLength(1);
    });

    it('anonymous lobby: a player referee does not read bannedByUserId of the host who banned', () => {
        const { test, s } = banned(ANON, { hostSlot: 'BluePlayer', seats: [['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        const [row] = view<LobbyBanViewRow>(test, 'view_my_lobby_bans', s.a.r1);
        expect(row.bannedByUserId).toBeUndefined();
    });

    // Module finding (A37 leak, contradicts interpretation 5): the banned user is no longer a member, so in an anonymous
    // lobby their id is withheld from anyone but a spectator referee everywhere else; view_my_lobby_bans emits the real
    // bannedUserId and resolveUserLabel's display name to a player referee. (unban_member takes the user id: a design
    // question for the user.)
    it('A37: anonymous lobby: a player referee reads neither the real id nor the display name of a banned (former) member', () => {
        const { test, s, target } = banned(ANON, { hostSlot: 'BluePlayer', seats: [['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        const [row] = view<LobbyBanViewRow>(test, 'view_my_lobby_bans', s.a.r1);
        expect(row.bannedUserId).toBe(0);
        expect(row.label).not.toBe(displayName(test, target));
    });
});
