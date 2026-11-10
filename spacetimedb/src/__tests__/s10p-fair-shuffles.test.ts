// T-S10p: in-memory tests for step S10p (DECISIONS.md A120). The three shuffles that drew with ctx.random (random
// bracket seeding, the RandomSwap of shuffle_teams, the random team formation of A36a) use fairShuffle from
// shared/lobby-rules/timerDraw.ts, keyed by the transaction time, a domain word per site and the tournament or lobby
// id. The function's uniformity is tested next to it (timerDraw.test.ts); here each reducer's result is checked against
// the documented function at the harness clock (the TestClock is the transaction timestamp), plus the shape rules of
// each site. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { fairShuffle, SHUFFLE_DOMAIN, shuffleKeyAt } from '@shared/lobby-rules';
import { M, advance, member, newHarness, now, setupLobby, tx, type Harness, type Lobby } from './s4-fixtures';
import {
    advanceStage,
    enrollMany,
    enrolled,
    fullTeams,
    host,
    membersOf,
    membership,
    openTournament,
    seedBracket,
    seedingField,
    teamRow,
    teams,
} from './s8-fixtures';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Ready team ids by seedNumber. */
const bySeed = (test: Harness, tournamentId: number) =>
    teams(test, tournamentId).filter((t) => t.seedNumber !== undefined).sort((a, b) => a.seedNumber! - b.seedNumber!).map((t) => t.id);

/** The order seed_bracket('random') must write: fairShuffle of the Ready team ids in id order at the current clock. */
const expectedSeeds = (test: Harness, tournamentId: number, readyIds: number[]) =>
    fairShuffle([...readyIds].sort((a, b) => a - b), shuffleKeyAt(now(test), [SHUFFLE_DOMAIN.BracketSeeding, tournamentId]));

const PLAYER_SLOTS = new Set(['BluePlayer', 'RedPlayer']);
const SHUFFLE_SEATS: Array<[string, 'BluePlayer' | 'RedPlayer' | 'BlueCoach' | 'RedCoach' | 'Spectator']> = [
    ['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['rc', 'RedCoach'], ['sp', 'Spectator'],
];

const randomSwap = (s: Lobby) => tx(s.test, s.host, (ctx) => M.shuffle_teams(ctx, { lobbyId: s.lobbyId, mode: { tag: 'RandomSwap' } as any }));
const slotsOf = (s: Lobby, names: string[]) => Object.fromEntries(names.map((n) => [n, member(s.test, s.lobbyId, s.a[n].userId).lobbySlot.tag]));

/** The seats RandomSwap must deal: the players (by joinSeq) through fairShuffle at the current clock, Blue, Red, Blue, ... */
function expectedSwap(s: Lobby): Map<number, string> {
    const players = [...s.test.db.LobbyMember.lobby_id.filter(s.lobbyId)]
        .filter((m) => PLAYER_SLOTS.has(m.lobbySlot.tag))
        .sort((a, b) => a.joinSeq - b.joinSeq)
        .map((m) => m.userId);
    const pool = fairShuffle(players, shuffleKeyAt(now(s.test), [SHUFFLE_DOMAIN.RandomSwap, s.lobbyId]));
    return new Map(pool.map((userId, i) => [userId, i % 2 === 0 ? 'BluePlayer' : 'RedPlayer']));
}

// ════════════════════════════════════════════════════════════════════════════
// Random bracket seeding (C-a7)
// ════════════════════════════════════════════════════════════════════════════

describe('A120: seed_bracket random mode uses the fair shuffle', () => {
    it('A120: random seeding writes seeds 1..n as a permutation of the Ready teams, in the order fairShuffle gives for the transaction', () => {
        const { test, org, id, ts } = seedingField(8);
        advance(test, 1_234);
        const ready = ts.map((t) => t.teamId);
        const want = expectedSeeds(test, id, ready);
        seedBracket(test, org, id, 'random');
        const got = bySeed(test, id);
        expect([...got].sort((a, b) => a - b)).toEqual([...ready].sort((a, b) => a - b));
        expect(ready.map((t) => teamRow(test, t)!.seedNumber).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(got).toEqual(want);
    });

    it('A120: re-seeding at a later time draws again; the result follows the new timestamp', () => {
        const { test, org, id, ts } = seedingField(8);
        const ready = ts.map((t) => t.teamId);
        const orders = new Set<string>();
        for (let i = 0; i < 10; i++) {
            advance(test, 1_000);
            const want = expectedSeeds(test, id, ready);
            seedBracket(test, org, id, 'random');
            expect(bySeed(test, id)).toEqual(want);
            orders.add(want.join());
        }
        expect(orders.size).toBeGreaterThanOrEqual(2);
    });

    it('A120: two tournaments seeded at the same timestamp are each keyed by their own id', () => {
        const { test, org, id: a, ts: tsA } = seedingField(6);
        const org2 = host(test, 'org2');
        const b = openTournament(test, org2, { maxParticipants: 12 });
        const tsB = fullTeams(test, b, 6, 'u');
        advanceStage(test, org2, b, 'Seeding');
        const at = now(test);
        const readyA = tsA.map((t) => t.teamId);
        const readyB = tsB.map((t) => t.teamId);
        seedBracket(test, org, a, 'random');
        seedBracket(test, org2, b, 'random');
        expect(now(test)).toBe(at); // one timestamp for both calls
        expect(bySeed(test, a)).toEqual(expectedSeeds(test, a, readyA));
        expect(bySeed(test, b)).toEqual(expectedSeeds(test, b, readyB));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// shuffle_teams RandomSwap (A45(3))
// ════════════════════════════════════════════════════════════════════════════

describe('A120: shuffle_teams RandomSwap uses the fair shuffle', () => {
    it('A120: two players per team, dealt as fairShuffle gives; coaches and the spectator stay; captain flags cleared; everyone unconfirmed', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SHUFFLE_SEATS, noStart: true });
        // A captain flag on a Blue player, written directly, to see RandomSwap clear it.
        const cap = member(test, s.lobbyId, s.a.b1.userId);
        test.db.LobbyMember.by_lobby_and_user.delete([s.lobbyId, cap.userId]);
        test.db.LobbyMember.insert({ ...cap, isCaptain: true });
        advance(test, 777);
        const want = expectedSwap(s);
        randomSwap(s);

        const players = ['b1', 'b2', 'r1', 'r2'];
        const slots = slotsOf(s, players);
        for (const n of players) expect(slots[n]).toBe(want.get(s.a[n].userId));
        expect(Object.values(slots).filter((x) => x === 'BluePlayer')).toHaveLength(2);
        expect(Object.values(slots).filter((x) => x === 'RedPlayer')).toHaveLength(2);
        expect(slotsOf(s, ['bc', 'rc', 'sp', 'host'])).toEqual({ bc: 'BlueCoach', rc: 'RedCoach', sp: 'Spectator', host: 'Spectator' });
        for (const m of [...test.db.LobbyMember.lobby_id.filter(s.lobbyId)]) {
            expect(m.isCaptain).toBe(false);
            expect(m.isConfirmed).toBe(false);
        }
    });

    it('A120: repeated RandomSwaps at different timestamps give at least two distinct assignments, each the one fairShuffle gives', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SHUFFLE_SEATS, noStart: true });
        const assignments = new Set<string>();
        for (let i = 0; i < 12; i++) {
            advance(test, 1_000);
            const want = expectedSwap(s);
            randomSwap(s);
            const slots = slotsOf(s, ['b1', 'b2', 'r1', 'r2']);
            for (const n of ['b1', 'b2', 'r1', 'r2']) expect(slots[n]).toBe(want.get(s.a[n].userId));
            expect(slotsOf(s, ['bc', 'rc'])).toEqual({ bc: 'BlueCoach', rc: 'RedCoach' });
            assignments.add(JSON.stringify(slots));
        }
        expect(assignments.size).toBeGreaterThanOrEqual(2);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Random team formation (A36a)
// ════════════════════════════════════════════════════════════════════════════

describe('A120: random team formation (A36a) uses the fair shuffle', () => {
    for (const [teamSize, pool] of [[2, 5], [3, 7]] as const) {
        it(`A120: team size ${teamSize}, ${pool} opted-in solos: full teams in fairShuffle order, captain first, the remainder stays enrolled without a team`, () => {
            const test = newHarness();
            const org = host(test);
            const id = openTournament(test, org, { teamSize, maxParticipants: 12 });
            const solos = enrollMany(test, id, pool, 'r', { allowRandomTeamAssignment: true });
            const optedOut = enrollMany(test, id, 1, 'out');
            advance(test, 4_321);
            const sorted = solos.map((p) => p.userId).sort((a, b) => a - b);
            const order = fairShuffle(sorted, shuffleKeyAt(now(test), [SHUFFLE_DOMAIN.TeamFormation, id]));
            advanceStage(test, org, id, 'Seeding');

            const full = Math.floor(pool / teamSize);
            const formed = teams(test, id).filter((t) => /^Team \d+$/.test(t.name)).sort((a, b) => a.id - b.id);
            expect(formed).toHaveLength(full);
            formed.forEach((team, k) => {
                const want = order.slice(k * teamSize, (k + 1) * teamSize);
                expect(membersOf(test, team.id)).toEqual([...want].sort((a, b) => a - b));
                expect(team.captainUserId).toBe(want[0]);
            });
            for (const userId of order.slice(full * teamSize)) {
                expect(membership(test, id, userId)).toBeUndefined();
                expect(enrolled(test, id, userId)).toBeDefined();
            }
            expect(membership(test, id, optedOut[0].userId)).toBeUndefined();
        });
    }

    it('A120: formation and seeding in one tournament use different domain words, so their draws are keyed apart', () => {
        expect(SHUFFLE_DOMAIN.TeamFormation).not.toBe(SHUFFLE_DOMAIN.BracketSeeding);
        const ids = Array.from({ length: 8 }, (_, i) => i + 1);
        const at = 1_790_000_000_000_000n;
        expect(fairShuffle(ids, shuffleKeyAt(at, [SHUFFLE_DOMAIN.TeamFormation, 3])))
            .not.toEqual(fairShuffle(ids, shuffleKeyAt(at, [SHUFFLE_DOMAIN.BracketSeeding, 3])));
    });
});
