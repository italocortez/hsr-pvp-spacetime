import { describe, it, expect } from 'vitest';
import {
    generateDoubleElim,
    generateSingleElim,
    checkStructure,
    classifyMatches,
    BracketEngine,
    toRowDrafts,
    foldSeeding,
    dropSource,
    wbKey,
    lbKey,
    GF_KEY,
    TP_KEY,
    type BracketSpec,
    type Slot,
} from './engine';

// Deterministic PRNG (mulberry32) so simulations are reproducible.
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Policy = 'random' | 'higherSeedWins' | 'lowerSeedWins';

/** Plays every ready match until nothing is left. Returns the engine. */
function simulate(spec: BracketSpec, policy: Policy, seed = 1): BracketEngine {
    const teamIds = Array.from({ length: spec.teamCount }, (_, i) => 100 + i); // seed s -> id 99+s
    const engine = new BracketEngine(spec, teamIds);
    const rand = rng(seed);
    let guard = 0;
    for (;;) {
        const ready = engine.ready();
        if (ready.length === 0) break;
        const st = ready[Math.floor(rand() * ready.length)];
        const [a, b] = st.slots as [number, number];
        let slot: Slot;
        if (policy === 'random') slot = rand() < 0.5 ? 1 : 2;
        else if (policy === 'higherSeedWins') slot = a < b ? 1 : 2;
        else slot = a > b ? 1 : 2;
        engine.applyResult(st.spec.key, slot);
        if (++guard > 1000) throw new Error('simulation did not terminate');
    }
    return engine;
}

const SIZES = Array.from({ length: 14 }, (_, i) => i + 3); // 3..16
const POLICIES: Policy[] = ['random', 'higherSeedWins', 'lowerSeedWins'];

describe('foldSeeding', () => {
    it('matches the standard 8-team layout', () => {
        expect(foldSeeding(8)).toEqual([[1, 8], [4, 5], [2, 7], [3, 6]]);
    });
});

describe('double elimination: structure (3-16 teams)', () => {
    for (const n of SIZES) {
        it(`${n} teams: every non-R1 match has exactly two inbound refs, every loser slot wired, GF fed by WB+LB winners`, () => {
            const spec = generateDoubleElim(n, { winnerAdvantage: 1 });
            expect(checkStructure(spec).errors).toEqual([]);
        });
    }

    it('match counts: B-1 WB, B-2 LB, 1 GF for bracket size B', () => {
        for (const n of SIZES) {
            const spec = generateDoubleElim(n);
            const B = spec.bracketSize;
            expect(spec.matches.filter(m => m.side === 'Winners')).toHaveLength(B - 1);
            expect(spec.matches.filter(m => m.side === 'Losers')).toHaveLength(B - 2);
            expect(spec.matches.filter(m => m.side === 'GrandFinals')).toHaveLength(1);
            expect(spec.matches.filter(m => m.side === 'ThirdPlace')).toHaveLength(0);
        }
    });

    it('4 teams: the WB final loser drops into the LB final (T1 core)', () => {
        const spec = generateDoubleElim(4);
        const wbFinal = spec.matches.find(m => m.key === wbKey(2, 1))!;
        expect(wbFinal.loserTo).toEqual({ key: lbKey(2, 1), slot: 2 });
        expect(wbFinal.winnerTo).toEqual({ key: GF_KEY, slot: 1 });
    });

    it('first drop round never pairs a WB-R2 loser with an LB-R1 winner from its own subtree (B >= 8)', () => {
        for (const B of [8, 16, 32]) {
            const count = B / 4;
            for (let i = 1; i <= count; i++) expect(dropSource(1, i, count)).not.toBe(i);
        }
    });

    it('GF carries winnerAdvantage and the WB finalist always sits in slot 1', () => {
        for (const n of SIZES) {
            const spec = generateDoubleElim(n, { winnerAdvantage: 2 });
            const gf = spec.matches.find(m => m.side === 'GrandFinals')!;
            expect(gf.winnerAdvantage).toBe(2);
            for (const policy of POLICIES) {
                const engine = simulate(spec, policy, n * 7);
                const gfState = engine.matches.get(GF_KEY)!;
                const slot1 = gfState.slots[0] as number;
                // slot 1 = WB champion: reached the GF without losing
                expect(engine.losses.get(slot1)).toBeLessThanOrEqual(1);
                const wbFinal = engine.matches.get(wbKey(Math.log2(spec.bracketSize), 1))!;
                expect(wbFinal.winner).toBe(slot1);
            }
        }
    });
});

describe('double elimination: simulated play completes for 3-16 teams', () => {
    for (const n of SIZES) {
        for (const policy of POLICIES) {
            it(`${n} teams, ${policy}`, () => {
                const spec = generateDoubleElim(n, { winnerAdvantage: 1 });
                for (let run = 0; run < (policy === 'random' ? 25 : 1); run++) {
                    const engine = simulate(spec, policy, run + 1);
                    expect(engine.isComplete()).toBe(true);
                    const champ = engine.champion();
                    expect(champ).toBeDefined();
                    // 2n-2 played matches (single GF, no reset): each produces exactly one loss
                    expect(engine.played).toBe(2 * n - 2);
                    // everyone but the champion is eliminated exactly once
                    expect(engine.eliminated.size).toBe(n - 1);
                    expect(engine.eliminated.has(champ!)).toBe(false);
                    for (const [team, losses] of engine.losses) {
                        if (team === champ) expect(losses).toBeLessThanOrEqual(1);
                        else expect(losses === 1 || losses === 2).toBe(true);
                    }
                    // nobody with 0 losses except possibly the champion; LB eliminations have 2 losses
                    const gf = engine.matches.get(GF_KEY)!;
                    for (const team of engine.eliminated) {
                        if (team !== gf.loser) expect(engine.losses.get(team)).toBe(2);
                    }
                }
            });
        }
    }
});

describe('single elimination', () => {
    for (const n of SIZES) {
        for (const thirdPlace of [false, true]) {
            it(`${n} teams, thirdPlace=${thirdPlace}: structure + simulated play`, () => {
                const spec = generateSingleElim(n, { thirdPlace });
                expect(checkStructure(spec).errors).toEqual([]);
                for (const policy of POLICIES) {
                    const engine = simulate(spec, policy, n);
                    expect(engine.isComplete()).toBe(true);
                    const tpPlayed = thirdPlace && classifyMatches(spec).get(TP_KEY) === 'playable' ? 1 : 0;
                    expect(engine.played).toBe(n - 1 + tpPlayed);
                    expect(engine.champion()).toBeDefined();
                }
            });
        }
    }

    it('5 teams: 7 rows, 3 BYE walkovers pre-resolved (matches the contract scenario)', () => {
        const spec = generateSingleElim(5);
        expect(spec.matches).toHaveLength(7);
        const kinds = classifyMatches(spec);
        expect([...kinds.values()].filter(k => k === 'walkover')).toHaveLength(3);
        const engine = new BracketEngine(spec, [11, 12, 13, 14, 15]);
        // 4v5 is playable; seeds 2 and 3 both had BYEs, so their R2 match is ready at once
        expect(engine.ready().map(s => s.spec.key)).toEqual([wbKey(1, 2), wbKey(2, 2)]);
    });

    it('3 teams with a third-place match: TP becomes a walkover (one semifinal is a BYE)', () => {
        const spec = generateSingleElim(3, { thirdPlace: true });
        expect(classifyMatches(spec).get(TP_KEY)).toBe('walkover');
    });
});

describe('BYE handling in the losers bracket', () => {
    it('5 teams: LB R1 has one walkover and one void match; nothing gets stuck', () => {
        const spec = generateDoubleElim(5);
        const kinds = classifyMatches(spec);
        expect(kinds.get(lbKey(1, 1))).toBe('walkover'); // loser(1 v BYE)=BYE vs loser(4 v 5)
        expect(kinds.get(lbKey(1, 2))).toBe('void');     // BYE vs BYE
        expect(kinds.get(lbKey(2, 1))).toBe('playable');
        expect(kinds.get(lbKey(2, 2))).toBe('walkover');
    });

    it('row drafts expose explicit slots so advancement never uses first-empty-slot', () => {
        const rows = toRowDrafts(generateDoubleElim(6));
        for (const r of rows) {
            if (r.nextWinnerKey) expect([1, 2]).toContain(r.nextWinnerSlot);
            if (r.nextLoserKey) expect([1, 2]).toContain(r.nextLoserSlot);
        }
        expect(rows.find(r => r.positionKey === GF_KEY)!.nextWinnerSlot).toBe(0);
    });
});

describe('engine safety', () => {
    it('re-applying the same result is a no-op; a different result is refused', () => {
        const spec = generateDoubleElim(4);
        const engine = new BracketEngine(spec, [1, 2, 3, 4]);
        engine.applyResult(wbKey(1, 1), 1);
        engine.applyResult(wbKey(1, 1), 1);
        expect(engine.played).toBe(1);
        expect(() => engine.applyResult(wbKey(1, 1), 2)).toThrow(/already decided/);
    });

    it('refuses to play a match whose slots are not both filled', () => {
        const engine = new BracketEngine(generateDoubleElim(4), [1, 2, 3, 4]);
        expect(() => engine.applyResult(GF_KEY, 1)).toThrow(/not playable/);
    });

    it('rejects fewer than 2 teams', () => {
        expect(() => generateDoubleElim(1)).toThrow();
        expect(() => generateSingleElim(1)).toThrow();
    });

    it('2-team double elimination routes the WB final loser straight to the GF', () => {
        const spec = generateDoubleElim(2, { winnerAdvantage: 1 });
        expect(checkStructure(spec).errors).toEqual([]);
        const engine = simulate(spec, 'lowerSeedWins');
        expect(engine.played).toBe(2);
        expect(engine.isComplete()).toBe(true);
    });
});
