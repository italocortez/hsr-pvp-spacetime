// T-S8a: in-memory tests for the S8a single-writer bracket helpers (bracketStore, bracketResults,
// tournamentStandings, tournamentLobbySides). Tournament / TournamentTeam rows are inserted directly (no reducer
// uses the helpers yet); every helper call runs inside `tx(test, 'internal', ...)`; `test.db` is read only outside
// transaction bodies. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    classifyMatches,
    generateDoubleElim,
    generateSingleElim,
    placeQualifiers,
    splitIntoGroups,
    type BracketSpec,
} from '@shared/bracket';
import { deleteBracket, insertBracket, insertGroupBracket } from '../helpers/bracketStore';
import { applyBracketResult, rollbackBracketResult, matchGames } from '../helpers/bracketResults';
import { groupStandings, qualifiersFor } from '../helpers/tournamentStandings';
import { allowedSlotsFor } from '../helpers/tournamentLobbySides';
import { DEFAULT_LOBBY_ARGS, M, expectReject, guest, lobbyRow, newHarness, tx, type Harness } from './s4-fixtures';

const ACTOR = 0; // SYSTEM

const AUDIT = (test: Harness) => {
    const ts = test.clock.now();
    return { createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts };
};

function insertTournament(test: Harness, over: Record<string, unknown> = {}): any {
    return tx(test, 'internal', (ctx) => ctx.db.Tournament.insert({
        id: 0,
        name: 'S8a cup',
        description: '',
        organizerId: 0,
        format: { tag: 'DoubleElimination' },
        stage: { tag: 'Seeding' },
        defaultGameMode: { tag: 'MemoryOfChaos' },
        maxParticipants: 64,
        teamSize: 2,
        isAnonymousDefault: false,
        isAnonymousSpectators: false,
        rosterVisibility: { tag: 'OpenRoster' },
        disconnectPolicy: { tag: 'Standard' },
        disconnectForfeitSeconds: undefined,
        checkInEnabled: false,
        winnerAdvantage: 1,
        groupAssignmentMode: { tag: 'Auto' },
        groupAdvanceCount: 2,
        costSetId: 0,
        seasonId: 0,
        countTowardsMmr: false,
        requireResultValidation: false,
        defaultBestOf: 1,
        grandFinalBestOf: 3,
        maxAccountsPerPlayer: 1,
        groupSize: 4,
        has3rdPlaceMatch: false,
        requireOwnership: false,
        allowMirrorPicks: false,
        lineupFormat: { tag: 'Halves' },
        lobbyPresetId: 0,
        requireVerified: false,
        requireRoster: false,
        minimumMmr: undefined,
        requireApproval: false,
        waitlistEnabled: false,
        scheduledStartAt: undefined,
        registrationDeadline: undefined,
        lastSeedChangeAt: undefined,
        bracketGeneratedAt: undefined,
        finalizationStartedAt: undefined,
        finalizedAt: undefined,
        ...AUDIT(test),
        ...over,
    } as any));
}

/** `n` Active teams with seeds 1..n; returns their ids in seed order (ascending ids). */
function insertTeams(test: Harness, tournamentId: number, n: number): number[] {
    return tx(test, 'internal', (ctx) => Array.from({ length: n }, (_, i) => ctx.db.TournamentTeam.insert({
        id: 0,
        tournamentId,
        name: `Team ${i + 1}`,
        captainUserId: 0,
        status: { tag: 'Active' },
        seedNumber: i + 1,
        groupId: undefined,
        finalPlacement: undefined,
        ...AUDIT(test),
    } as any).id));
}

const rows = (test: Harness, tournamentId: number) => [...test.db.BracketMatch.tournament_id.filter(tournamentId)];
const byKey = (test: Harness, tournamentId: number) => new Map(rows(test, tournamentId).map((r) => [r.positionKey, r]));
const matchRow = (test: Harness, id: number) => test.db.BracketMatch.id.find(id)!;
const team = (test: Harness, id: number) => test.db.TournamentTeam.id.find(id)!;
const SETTLED = ['Decided', 'Walkover', 'Void'];

function setup(n: number, format: 'single' | 'double', thirdPlace = false) {
    const test = newHarness();
    const t = insertTournament(test, {
        format: { tag: format === 'single' ? 'SingleElimination' : 'DoubleElimination' },
        has3rdPlaceMatch: thirdPlace,
    });
    const teams = insertTeams(test, t.id, n);
    const spec: BracketSpec = format === 'single'
        ? generateSingleElim(n, { thirdPlace })
        : generateDoubleElim(n, { winnerAdvantage: t.winnerAdvantage });
    const ids = tx(test, 'internal', (ctx) => insertBracket(ctx, t, spec, teams, ACTOR));
    return { test, t, teams, spec, ids };
}

function checkInserted({ test, t, spec, ids }: ReturnType<typeof setup>) {
    const all = rows(test, t.id);
    expect(all).toHaveLength(spec.matches.length);
    expect(ids.size).toBe(spec.matches.length);
    const kinds = classifyMatches(spec);
    for (const m of spec.matches) {
        const row = matchRow(test, ids.get(m.key)!);
        expect(row.tournamentId).toBe(t.id);
        expect(row.positionKey).toBe(m.key);
        expect(row.bracketSide.tag).toBe(m.side);
        expect(row.roundNumber).toBe(m.round);
        expect(row.matchNumber).toBe(m.number);
        // routes resolve to rows of the same tournament, with the spec's slot
        if (m.winnerTo) {
            const next = matchRow(test, row.nextWinnerMatchId!);
            expect(next.tournamentId).toBe(t.id);
            expect(next.positionKey).toBe(m.winnerTo.key);
            expect(row.nextWinnerSlot).toBe(m.winnerTo.slot);
        } else {
            expect(row.nextWinnerMatchId).toBeUndefined();
        }
        if (m.loserTo) {
            const next = matchRow(test, row.nextLoserMatchId!);
            expect(next.tournamentId).toBe(t.id);
            expect(next.positionKey).toBe(m.loserTo.key);
            expect(row.nextLoserSlot).toBe(m.loserTo.slot);
        } else {
            expect(row.nextLoserMatchId).toBeUndefined();
        }
        // bestOf / winnerAdvantage
        if (m.side === 'GrandFinals') {
            expect(row.bestOf).toBe(t.grandFinalBestOf);
            expect(row.winnerAdvantage).toBe(m.winnerAdvantage);
            expect(row.winnerAdvantage).toBe(t.winnerAdvantage);
        } else {
            expect(row.bestOf).toBe(t.defaultBestOf);
            expect(row.winnerAdvantage).toBe(0);
        }
        // T-S8g (A70(1), A71(1)): generation writes the default colours (no blueTeamId: team1 = Blue); the head start is
        // team-based (team1Games = winnerAdvantage, asserted below), no colour column
        expect(row.blueTeamId).toBeUndefined();
        // BYE matches are settled right after insert, the real entrant already routed
        const kind = kinds.get(m.key)!;
        if (kind === 'walkover' && row.state.tag === 'Pending') {
            // one BYE known, the real entrant still comes from an unplayed match (e.g. an LB round-1 slot)
            expect([row.team1IsBye, row.team2IsBye].filter(Boolean)).toHaveLength(1);
            expect(row.team1Id ?? row.team2Id).toBeUndefined();
        } else if (kind === 'walkover') {
            expect(row.state.tag).toBe('Walkover');
            expect(row.winnerTeamId).toBeTypeOf('number');
            expect(row.loserTeamId).toBeUndefined();
            if (row.nextWinnerMatchId !== undefined) {
                const next = matchRow(test, row.nextWinnerMatchId);
                expect(row.nextWinnerSlot === 1 ? next.team1Id : next.team2Id).toBe(row.winnerTeamId);
            }
        } else if (kind === 'void') {
            expect(row.state.tag).toBe('Void');
            expect(row.winnerTeamId).toBeUndefined();
        } else {
            expect(SETTLED).not.toContain(row.state.tag);
        }
        // A69(1): the A27 head start sits on the row from generation (team1Games = winnerAdvantage; 0 for every
        // match without a head start, i.e. everything but the double-elimination grand final).
        expect(row.team1Games).toBe(row.winnerAdvantage);
        if (m.side !== 'GrandFinals') expect(row.team1Games).toBe(0);
        expect(row.team2Games).toBe(0);
    }
}

interface PlayLog {
    losses: Map<number, number>;
    eliminatingLosses: Set<number>;   // lost a match with no nextLoserMatchId
    played: number;
}

/** Plays the bracket to the end through applyBracketResult only: the lower team id wins, 2-0 / 2-1 alternating. */
function playOut(test: Harness, tournamentId: number, teams: number[]): PlayLog {
    const log: PlayLog = { losses: new Map(teams.map((id) => [id, 0])), eliminatingLosses: new Set(), played: 0 };
    for (let guard = 0; guard < 200; guard++) {
        const ready = rows(test, tournamentId).filter((r) => r.state.tag === 'Ready').sort((a, b) => a.id - b.id);
        if (ready.length === 0) break;
        const r = ready[0];
        expect(r.team1Id).toBeTypeOf('number');
        expect(r.team2Id).toBeTypeOf('number');
        const winner = Math.min(r.team1Id!, r.team2Id!);
        const loser = Math.max(r.team1Id!, r.team2Id!);
        const close = log.played % 2 === 1;
        const games = winner === r.team1Id ? { team1: 2, team2: close ? 1 : 0 } : { team1: close ? 1 : 0, team2: 2 };
        // the throw on an occupied slot must never fire: a throw here fails the test
        tx(test, 'internal', (ctx) => applyBracketResult(ctx, r.id, winner, 'Played', games, ACTOR));
        log.played++;
        log.losses.set(loser, log.losses.get(loser)! + 1);
        if (r.nextLoserMatchId === undefined) log.eliminatingLosses.add(loser);
        const after = matchRow(test, r.id);
        expect(after).toMatchObject({ winnerTeamId: winner, loserTeamId: loser, team1Games: games.team1, team2Games: games.team2 });
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Played');
    }
    return log;
}

function checkPlayedOut(s: ReturnType<typeof setup>, log: PlayLog, format: 'single' | 'double') {
    const { test, t, teams, spec } = s;
    const all = rows(test, t.id);
    for (const r of all) expect(SETTLED, r.positionKey).toContain(r.state.tag);
    // every structural walkover / void ended as such; every playable match was decided
    const kinds = classifyMatches(spec);
    const expectedState = { playable: 'Decided', walkover: 'Walkover', void: 'Void' } as const;
    for (const r of all) expect(r.state.tag, r.positionKey).toBe(expectedState[kinds.get(r.positionKey)!]);
    const map = byKey(test, t.id);
    const finalKey = format === 'double' ? 'GF' : `W-R${Math.log2(spec.bracketSize)}-M1`;
    const champion = map.get(finalKey)!.winnerTeamId!;
    expect(champion).toBe(Math.min(...teams));
    expect(log.losses.get(champion)).toBe(0);
    for (const id of teams) {
        const status = team(test, id).status.tag;
        if (log.eliminatingLosses.has(id)) expect(status, `team ${id}`).toBe('Eliminated');
        else expect(status, `team ${id}`).toBe('Active');
        if (format === 'double' && id !== champion) {
            expect(status).toBe('Eliminated');
            expect(log.losses.get(id), `team ${id} losses`).toBe(2);
        }
    }
    if (format === 'double') {
        // the WB finalist sits in GF slot 1
        const wbFinal = map.get(`W-R${Math.log2(spec.bracketSize)}-M1`)!;
        expect(map.get('GF')!.team1Id).toBe(wbFinal.winnerTeamId);
    }
    return { champion, map };
}

describe('insertBracket + applyBracketResult: brackets played to the end', () => {
    for (const n of [4, 6, 16]) {
        it(`double elimination, ${n} teams`, () => {
            const s = setup(n, 'double');
            checkInserted(s);
            const log = playOut(s.test, s.t.id, s.teams);
            checkPlayedOut(s, log, 'double');
            // no third-place match in double elimination (A29)
            expect(rows(s.test, s.t.id).some((r) => r.bracketSide.tag === 'ThirdPlace')).toBe(false);
        });
    }

    it('single elimination, 5 teams with the third-place match', () => {
        const s = setup(5, 'single', true);
        checkInserted(s);
        const log = playOut(s.test, s.t.id, s.teams);
        const { map } = checkPlayedOut(s, log, 'single');
        const [t1, t2, t3, t4, t5] = s.teams;
        const tp = map.get('TP')!;
        expect(tp.state.tag).toBe('Decided');
        expect(tp.winnerTeamId).toBe(t3);
        expect(tp.loserTeamId).toBe(t4);
        expect(team(s.test, t1).status.tag).toBe('Active');   // champion
        expect(team(s.test, t3).status.tag).toBe('Active');   // third place: lost a semi with a loser route
        expect([t2, t4, t5].map((id) => team(s.test, id).status.tag)).toEqual(['Eliminated', 'Eliminated', 'Eliminated']);
    });

    it('single elimination, 3 teams with the third-place match: the TP match is a walkover, one team eliminated', () => {
        const s = setup(3, 'single', true);
        checkInserted(s);
        const log = playOut(s.test, s.t.id, s.teams);
        const { map } = checkPlayedOut(s, log, 'single');
        expect(map.get('TP')!.state.tag).toBe('Walkover');
        expect(s.teams.filter((id) => team(s.test, id).status.tag === 'Eliminated')).toEqual([s.teams[1]]);
    });

    it('applyBracketResult is idempotent for the same winner and refuses a different one ("roll back first")', () => {
        const s = setup(4, 'double');
        const m = s.ids.get('W-R1-M1')!;
        const r = matchRow(s.test, m);
        tx(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, r.team1Id!, 'Played', { team1: 2, team2: 1 }, ACTOR));
        const before = { match: matchRow(s.test, m), all: rows(s.test, s.t.id), teams: s.teams.map((id) => team(s.test, id)) };
        tx(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, r.team1Id!, 'Staff', { team1: 0, team2: 2 }, ACTOR));
        expect(matchRow(s.test, m)).toEqual(before.match);
        expect(rows(s.test, s.t.id)).toEqual(before.all);
        expect(s.teams.map((id) => team(s.test, id))).toEqual(before.teams);
        expectReject(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, r.team2Id!, 'Played', { team1: 0, team2: 2 }, ACTOR), /roll back first/);
        expect(matchRow(s.test, m)).toEqual(before.match);
    });

    it('applyBracketResult refuses a non-participant winner, a match without two teams and bad games', () => {
        const s = setup(4, 'double');
        const m = s.ids.get('W-R1-M1')!;
        expectReject(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, 999, 'Played', { team1: 2, team2: 0 }, ACTOR), /does not play/);
        const pending = s.ids.get('W-R2-M1')!;
        expectReject(s.test, 'internal', (ctx) => applyBracketResult(ctx, pending, s.teams[0], 'Played', { team1: 2, team2: 0 }, ACTOR), /two teams/);
        const r = matchRow(s.test, m);
        expectReject(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, r.team1Id!, 'Played', { team1: 2.5, team2: 0 }, ACTOR), /0\.\.255/);
        expect(matchRow(s.test, m).state.tag).toBe('Ready');
    });

    // T-S8e (A67(4)): seriesGames (a lobby series tally) is gone; matchGames derives the tally from the match's
    // Validated records (Blue → team1, Red → team2, A35; covered with real records in s8e-bracket-series). With no
    // record of the match the tally is the head start alone (team1 = winnerAdvantage, A27).
    it('matchGames with no records is the head start alone (A27, A67(4))', () => {
        const s = setup(4, 'double');
        const m = matchRow(s.test, s.ids.get('W-R1-M1')!);
        expect(tx(s.test, 'internal', (ctx) => matchGames(ctx, m))).toEqual({ team1: m.winnerAdvantage, team2: 0 });
        expect(tx(s.test, 'internal', (ctx) => matchGames(ctx, { ...m, winnerAdvantage: 1 }))).toEqual({ team1: 1, team2: 0 });
    });
});

describe('rollbackBracketResult', () => {
    it('decided match with undecided downstream → Ready, 0-0, downstream slots cleared; apply again succeeds', () => {
        const s = setup(4, 'double');
        const m = s.ids.get('W-R1-M1')!;
        const r = matchRow(s.test, m);
        const [w, l] = [r.team1Id!, r.team2Id!];
        tx(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, w, 'Played', { team1: 2, team2: 0 }, ACTOR));
        const wbNext = s.ids.get('W-R2-M1')!;
        const lbNext = s.ids.get('L-R1-M1')!;
        expect(matchRow(s.test, wbNext).team1Id).toBe(w);
        expect(matchRow(s.test, lbNext).team1Id).toBe(l);

        tx(s.test, 'internal', (ctx) => rollbackBracketResult(ctx, m, ACTOR));
        const back = matchRow(s.test, m);
        expect(back.state.tag).toBe('Ready');
        expect(back).toMatchObject({ winnerTeamId: undefined, loserTeamId: undefined, decidedBy: undefined, team1Games: 0, team2Games: 0, team1Id: w, team2Id: l });
        expect(matchRow(s.test, wbNext)).toMatchObject({ team1Id: undefined, team1IsBye: false });
        expect(matchRow(s.test, wbNext).state.tag).toBe('Pending');
        expect(matchRow(s.test, lbNext)).toMatchObject({ team1Id: undefined, team1IsBye: false });
        expect(matchRow(s.test, lbNext).state.tag).toBe('Pending');

        // apply again (the other winner this time) after the rollback
        tx(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, l, 'Staff', { team1: 0, team2: 2 }, ACTOR));
        expect(matchRow(s.test, m)).toMatchObject({ winnerTeamId: l, loserTeamId: w });
        expect(matchRow(s.test, wbNext).team1Id).toBe(l);
        expect(matchRow(s.test, lbNext).team1Id).toBe(w);
    });

    it('un-eliminates the loser of a match without a loser route (single elimination)', () => {
        const s = setup(5, 'single', true);
        const m = s.ids.get('W-R1-M2')!;      // seed 4 v seed 5
        const r = matchRow(s.test, m);
        expect([r.team1Id, r.team2Id].sort()).toEqual([s.teams[3], s.teams[4]].sort());
        tx(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, s.teams[3], 'Played', { team1: 2, team2: 0 }, ACTOR));
        expect(team(s.test, s.teams[4]).status.tag).toBe('Eliminated');
        tx(s.test, 'internal', (ctx) => rollbackBracketResult(ctx, m, ACTOR));
        expect(team(s.test, s.teams[4]).status.tag).toBe('Active');
        expect(matchRow(s.test, s.ids.get('W-R2-M1')!).team2Id).toBeUndefined();
    });

    it('re-opens a downstream walkover and re-settles it on the next apply', () => {
        // 6 teams double: W-R1-M1 (1 v BYE) sends a BYE to L-R1-M1 slot 1; W-R1-M2 (4 v 5) sends its loser to slot 2
        const s = setup(6, 'double');
        const m = s.ids.get('W-R1-M2')!;
        const lb1 = s.ids.get('L-R1-M1')!;
        const lb2 = s.ids.get('L-R2-M1')!;
        expect(matchRow(s.test, lb1)).toMatchObject({ team1IsBye: true, team2Id: undefined });
        expect(matchRow(s.test, lb1).state.tag).toBe('Pending');
        const r = matchRow(s.test, m);
        const [w, l] = [Math.min(r.team1Id!, r.team2Id!), Math.max(r.team1Id!, r.team2Id!)];
        tx(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, w, 'Played', { team1: 2, team2: 0 }, ACTOR));
        expect(matchRow(s.test, lb1).state.tag).toBe('Walkover');
        expect(matchRow(s.test, lb1).winnerTeamId).toBe(l);
        const lb1Row = matchRow(s.test, lb1);
        const lb2Slot = lb1Row.nextWinnerSlot === 1 ? 'team1Id' : 'team2Id';
        expect(matchRow(s.test, lb2)[lb2Slot]).toBe(l);

        tx(s.test, 'internal', (ctx) => rollbackBracketResult(ctx, m, ACTOR));
        const reopened = matchRow(s.test, lb1);
        expect(reopened.state.tag).toBe('Pending');
        expect(reopened).toMatchObject({ team1IsBye: true, team2Id: undefined, winnerTeamId: undefined, loserTeamId: undefined });
        expect(matchRow(s.test, lb2)[lb2Slot]).toBeUndefined();
        expect(team(s.test, l).status.tag).toBe('Active');

        tx(s.test, 'internal', (ctx) => applyBracketResult(ctx, m, w, 'Played', { team1: 2, team2: 1 }, ACTOR));
        expect(matchRow(s.test, lb1).state.tag).toBe('Walkover');
        expect(matchRow(s.test, lb2)[lb2Slot]).toBe(l);
    });

    it('refuses when a downstream match is Decided, and refuses a match that is not Decided', () => {
        const s = setup(4, 'double');
        const k = (key: string) => s.ids.get(key)!;
        for (const key of ['W-R1-M1', 'W-R1-M2', 'W-R2-M1']) {
            const r = matchRow(s.test, k(key));
            tx(s.test, 'internal', (ctx) => applyBracketResult(ctx, k(key), Math.min(r.team1Id!, r.team2Id!), 'Played', { team1: 2, team2: 0 }, ACTOR));
        }
        const before = rows(s.test, s.t.id);
        expectReject(s.test, 'internal', (ctx) => rollbackBracketResult(ctx, k('W-R1-M1'), ACTOR), /roll that back first/);
        expect(rows(s.test, s.t.id)).toEqual(before);
        expectReject(s.test, 'internal', (ctx) => rollbackBracketResult(ctx, k('GF'), ACTOR), /only a decided match/);
        // unwinding from the top works
        tx(s.test, 'internal', (ctx) => rollbackBracketResult(ctx, k('W-R2-M1'), ACTOR));
        tx(s.test, 'internal', (ctx) => rollbackBracketResult(ctx, k('W-R1-M1'), ACTOR));
        expect(matchRow(s.test, k('W-R1-M1')).state.tag).toBe('Ready');
    });
});

describe('group stage helpers', () => {
    function groupSetup() {
        const test = newHarness();
        const t = insertTournament(test, { format: { tag: 'GroupIntoSingleElim' }, groupSize: 4, groupAdvanceCount: 2 });
        const teams = insertTeams(test, t.id, 8);
        const groups = splitIntoGroups(teams, t.groupSize);
        const ids = tx(test, 'internal', (ctx) => insertGroupBracket(ctx, t, groups, ACTOR));
        return { test, t, teams, groups, ids };
    }

    it('8 teams / groupSize 4 → 2 groups × 6 Ready matches, groupId written, A30 standings, 4 placed qualifiers', () => {
        const { test, t, teams, groups, ids } = groupSetup();
        expect(groups.map((g) => g.length)).toEqual([4, 4]);
        const all = rows(test, t.id);
        expect(all).toHaveLength(12);
        expect(ids.size).toBe(12);
        for (const g of [0, 1]) {
            const mine = all.filter((r) => r.groupId === g);
            expect(mine).toHaveLength(6);
            for (const r of mine) {
                expect(r.bracketSide.tag).toBe('Group');
                expect(r.state.tag).toBe('Ready');
                expect(r.positionKey).toMatch(new RegExp(`^G${g}-R\\d+-M\\d+$`));
                expect(groups[g]).toContain(r.team1Id);
                expect(groups[g]).toContain(r.team2Id);
                expect(r.nextWinnerMatchId).toBeUndefined();
                expect(r.nextLoserMatchId).toBeUndefined();
                expect(r.bestOf).toBe(t.defaultBestOf);
                // T-S8g (A70(1), A71(1)): group rows get the same default colours; no head start (0–0)
                expect(r.blueTeamId).toBeUndefined();
                expect([r.team1Games, r.team2Games]).toEqual([0, 0]);
            }
        }
        groups.forEach((g, gi) => g.forEach((id) => expect(team(test, id).groupId).toBe(gi)));

        // group 0 = seeds 1, 4, 5, 8 → [A, B, C, D]; a three-way cycle on 2 wins, D loses all
        const [A, B, C, D] = groups[0];
        const g0: Record<string, [number, number, number]> = {
            [[A, B].sort().join()]: [A, 2, 1],
            [[B, C].sort().join()]: [B, 2, 0],
            [[C, A].sort().join()]: [C, 2, 0],
            [[A, D].sort().join()]: [A, 2, 0],
            [[B, D].sort().join()]: [B, 2, 1],
            [[C, D].sort().join()]: [C, 2, 1],
        };
        for (const r of all) {
            let winner: number;
            let wg = 2;
            let lg = 0;
            if (r.groupId === 0) [winner, wg, lg] = g0[[r.team1Id!, r.team2Id!].sort().join()];
            else winner = Math.min(r.team1Id!, r.team2Id!);
            const games = winner === r.team1Id ? { team1: wg, team2: lg } : { team1: lg, team2: wg };
            tx(test, 'internal', (ctx) => applyBracketResult(ctx, r.id, winner, 'Played', games, ACTOR));
        }
        for (const r of rows(test, t.id)) {
            expect(r.state.tag).toBe('Decided');
            expect(r.nextLoserMatchId).toBeUndefined();
        }
        // group losses never eliminate (standings decide)
        for (const id of teams) expect(team(test, id).status.tag).toBe('Active');

        // A30: three-way tie on wins → game differential (A +1, B +2, C +1) → seed (A seed 1 before C seed 5)
        const s0 = tx(test, 'internal', (ctx) => groupStandings(ctx, t.id, 0));
        expect(s0.map((r) => r.teamId)).toEqual([B, A, C, D]);
        expect(s0.map((r) => r.wins)).toEqual([2, 2, 2, 0]);
        expect(s0.map((r) => r.gameDiff)).toEqual([2, 1, 1, -4]);
        expect(s0.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
        const s1 = tx(test, 'internal', (ctx) => groupStandings(ctx, t.id, 1));
        expect(s1.map((r) => r.teamId)).toEqual([...groups[1]].sort((a, b) => a - b));
        expect(s1.map((r) => r.wins)).toEqual([3, 2, 1, 0]);

        const q = tx(test, 'internal', (ctx) => qualifiersFor(ctx, t.id, 2));
        expect(q).toHaveLength(4);
        expect(q).toEqual(placeQualifiers([s0.map((r) => r.teamId), s1.map((r) => r.teamId)], 2));
        expect(q.slice(0, 2)).toEqual([B, s1[0].teamId]);     // group winners first, in group order
        expect(new Set(q.slice(2))).toEqual(new Set([A, s1[1].teamId]));
        // seeds 1 v 4 and 2 v 3 meet in round 1: never two teams of one group
        const groupOf = (id: number) => team(test, id).groupId;
        expect(groupOf(q[0])).not.toBe(groupOf(q[3]));
        expect(groupOf(q[1])).not.toBe(groupOf(q[2]));
    });

    it('qualifiersFor skips a Disqualified group winner (A26); groupStandings still lists it', () => {
        const { test, t, groups } = groupSetup();
        for (const r of rows(test, t.id)) {
            const winner = Math.min(r.team1Id!, r.team2Id!);
            const games = winner === r.team1Id ? { team1: 2, team2: 0 } : { team1: 0, team2: 2 };
            tx(test, 'internal', (ctx) => applyBracketResult(ctx, r.id, winner, 'Played', games, ACTOR));
        }
        const g0 = [...groups[0]].sort((a, b) => a - b);   // lower id always wins: rank = id order
        const g1 = [...groups[1]].sort((a, b) => a - b);
        const before = tx(test, 'internal', (ctx) => qualifiersFor(ctx, t.id, 2));
        expect(new Set(before)).toEqual(new Set([g0[0], g0[1], g1[0], g1[1]]));

        tx(test, 'internal', (ctx) => ctx.db.TournamentTeam.id.update({ ...ctx.db.TournamentTeam.id.find(g0[0])!, status: { tag: 'Disqualified' } as any }));
        const after = tx(test, 'internal', (ctx) => qualifiersFor(ctx, t.id, 2));
        expect(after).toHaveLength(4);
        expect(after).not.toContain(g0[0]);
        expect(new Set(after)).toEqual(new Set([g0[1], g0[2], g1[0], g1[1]]));
        expect(after).toEqual(placeQualifiers([[g0[1], g0[2], g0[3]], g1], 2));
        expect(after.slice(0, 2)).toEqual([g0[1], g1[0]]);   // the next-ranked team takes the group-winner seed

        const s0 = tx(test, 'internal', (ctx) => groupStandings(ctx, t.id, 0));
        expect(s0.map((r) => r.teamId)).toEqual(g0);           // still complete for display
        expect(s0[0]).toMatchObject({ teamId: g0[0], rank: 1, wins: 3 });
    });

    it('groupStandings includes every team of the group regardless of status, with undecided matches ignored', () => {
        const { test, t, groups } = groupSetup();
        tx(test, 'internal', (ctx) => ctx.db.TournamentTeam.id.update({ ...ctx.db.TournamentTeam.id.find(groups[0][3])!, status: { tag: 'Withdrawn' } as any }));
        const s0 = tx(test, 'internal', (ctx) => groupStandings(ctx, t.id, 0));
        expect(s0.map((r) => r.teamId)).toEqual(groups[0]);     // no results yet: seed order
        expect(s0.every((r) => r.wins === 0 && r.gameDiff === 0)).toBe(true);
    });

    it('deleteBracket removes the rows and the stand-ins, clears groupId and keeps seedNumber; other tournaments untouched', () => {
        const { test, t, teams, ids } = groupSetup();
        const t2 = insertTournament(test, { name: 'other' });
        const teams2 = insertTeams(test, t2.id, 4);
        tx(test, 'internal', (ctx) => insertBracket(ctx, t2, generateDoubleElim(4), teams2, ACTOR));
        const otherCount = rows(test, t2.id).length;

        const matchId = ids.get('G0-R1-M1')!;
        const m = matchRow(test, matchId);
        tx(test, 'internal', (ctx) => ctx.db.TournamentStandIn.insert({
            id: 0, bracketMatchId: matchId, teamId: m.team1Id!, userId: 77, approvedByUserId: 0, ...AUDIT(test),
        } as any));
        expect([...test.db.TournamentStandIn.bracket_match_id.filter(matchId)]).toHaveLength(1);

        tx(test, 'internal', (ctx) => deleteBracket(ctx, t.id, ACTOR));
        expect(rows(test, t.id)).toHaveLength(0);
        expect([...test.db.TournamentStandIn.bracket_match_id.filter(matchId)]).toHaveLength(0);
        teams.forEach((id, i) => {
            expect(team(test, id).groupId).toBeUndefined();
            expect(team(test, id).seedNumber).toBe(i + 1);
        });
        expect(rows(test, t2.id)).toHaveLength(otherCount);
    });

    it('deleteBracket on an elimination bracket, actor omitted', () => {
        const s = setup(6, 'double');
        tx(s.test, 'internal', (ctx) => deleteBracket(ctx, s.t.id));
        expect(rows(s.test, s.t.id)).toHaveLength(0);
        expect(s.teams.map((id) => team(s.test, id).seedNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    });
});

describe('allowedSlotsFor (A35, D.8.5)', () => {
    it('team1 member → Blue + Spectator, team2 stand-in → Red + Spectator, outsider and Moderator → Spectator only', () => {
        const s = setup(2, 'single');
        const { test } = s;
        const matchId = s.ids.get('W-R1-M1')!;
        const m = matchRow(test, matchId);
        const [b1, b2, r1, r2, sub, outsider, mod, host] = ['b1', 'b2', 'r1', 'r2', 'sub', 'outsider', 'mod', 'host'].map((n) => guest(test, n));
        tx(test, 'internal', (ctx) => {
            for (const [teamId, who] of [[m.team1Id!, b1], [m.team1Id!, b2], [m.team2Id!, r1], [m.team2Id!, r2]] as const) {
                ctx.db.TournamentTeamMember.insert({ teamId, userId: who.userId, tournamentId: s.t.id, ...AUDIT(test) } as any);
            }
            ctx.db.TournamentStandIn.insert({ id: 0, bracketMatchId: matchId, teamId: m.team2Id!, userId: sub.userId, approvedByUserId: 0, ...AUDIT(test) } as any);
            const u = ctx.db.User.id.find(mod.userId)!;
            ctx.db.User.id.update({ ...u, role: { tag: 'Moderator' } as any });
        });
        tx(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any));
        const lobbyId = [...test.db.Lobby.iter()].find((l) => l.hostUserId === host.userId)!.id;
        const casual = lobbyRow(test, lobbyId);
        test.db.Lobby.id.update({ ...casual, isTournamentControlled: true, bracketMatchId: matchId });
        const lobby = lobbyRow(test, lobbyId);

        const slots = (userId: number) => tx(test, 'internal', (ctx) => allowedSlotsFor(ctx, lobby, userId));
        expect(slots(b1.userId)).toEqual(['BluePlayer', 'BlueCoach', 'Spectator']);
        expect(slots(b2.userId)).toEqual(['BluePlayer', 'BlueCoach', 'Spectator']);
        expect(slots(r1.userId)).toEqual(['RedPlayer', 'RedCoach', 'Spectator']);
        expect(slots(sub.userId)).toEqual(['RedPlayer', 'RedCoach', 'Spectator']);
        expect(slots(outsider.userId)).toEqual(['Spectator']);
        expect(slots(mod.userId)).toEqual(['Spectator']);
        expect(slots(host.userId)).toEqual(['Spectator']);

        // a casual lobby allows every slot
        expect(tx(test, 'internal', (ctx) => allowedSlotsFor(ctx, casual, outsider.userId)))
            .toEqual(['BluePlayer', 'BlueCoach', 'RedPlayer', 'RedCoach', 'Spectator']);
    });
});
