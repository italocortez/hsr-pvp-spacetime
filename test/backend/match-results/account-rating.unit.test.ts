/**
 * Unit tests for spacetimedb/src/helpers/accountRating.ts
 *
 * Tests the matrix-based account rating formula (Phase 11):
 * vertical (eidolon depth + age decay) × 0.4 + horizontal (archetype coverage) × 0.6
 * normalized by maxPossible, scaled to 0–1000.
 *
 * Uses a mock ctx to simulate database access.
 */

import { describe, it, expect } from 'vitest';
import { computeAccountRating, computeMaxPossible } from '../../../spacetimedb/src/helpers/accountRating';

type ConfigType = {
    id: number;
    verticalWeight: number;
    horizontalWeight: number;
    compression: number;
    roleExponentDps: number;
    roleExponentSupport: number;
    roleExponentSustain: number;
    archetypeThreshold: number;
    scale: number;
    maxPossible: number;
};

const DEFAULT_CONFIG: ConfigType = {
    id: 1,
    verticalWeight: 0.4,
    horizontalWeight: 0.6,
    compression: 0.2,
    roleExponentDps: 2.0,
    roleExponentSupport: 1.3,
    roleExponentSustain: 1.0,
    archetypeThreshold: 3.0,
    scale: 1000.0,
    maxPossible: 0.0,
};

type AllChar = { name: string; versionReleased: number; treatAsVersion: number; role: { tag: string } };
type OwnedChar = { characterName: string; eidolonLevel: number };
type Archetype = { id: number; name: string };
type Junction = { characterName: string; archetypeId: number };

function mockCtx(opts: {
    config?: Partial<ConfigType> | null;
    allChars: AllChar[];
    ownedChars: OwnedChar[];
    archetypes: Archetype[];
    junctions: Junction[];
}): any {
    const config =
        opts.config === null
            ? null
            : { ...DEFAULT_CONFIG, ...opts.config };

    return {
        db: {
            AccountRatingConfig: {
                id: {
                    find: (id: number) => (id === 1 ? config : null),
                },
            },
            HsrCharacter: {
                iter: () => opts.allChars[Symbol.iterator](),
            },
            HsrAccountCharacter: {
                hsr_account_id: {
                    filter: (_id: number) => opts.ownedChars[Symbol.iterator](),
                },
            },
            Archetype: {
                iter: () => opts.archetypes[Symbol.iterator](),
            },
            HsrCharacterArchetype: {
                archetype_id: {
                    filter: (archetypeId: number) =>
                        opts.junctions
                            .filter((j) => j.archetypeId === archetypeId)
                            [Symbol.iterator](),
                },
            },
        },
    };
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('computeAccountRating — edge cases', () => {
    it('returns 0 for empty roster (no owned chars)', () => {
        const ctx = mockCtx({
            config: { maxPossible: 0.789 },
            allChars: [{ name: 'Himeko', versionReleased: 1.0, treatAsVersion: 0, role: { tag: 'Dps' } }],
            ownedChars: [],
            archetypes: [],
            junctions: [],
        });
        expect(computeAccountRating(ctx, 1)).toBe(0);
    });

    it('returns 0 when no AccountRatingConfig row exists', () => {
        const ctx = mockCtx({
            config: null,
            allChars: [{ name: 'Himeko', versionReleased: 1.0, treatAsVersion: 0, role: { tag: 'Dps' } }],
            ownedChars: [{ characterName: 'Himeko', eidolonLevel: 0 }],
            archetypes: [],
            junctions: [],
        });
        expect(computeAccountRating(ctx, 1)).toBe(0);
    });

    it('returns 0 when no HsrCharacter rows exist', () => {
        const ctx = mockCtx({
            config: { maxPossible: 0.5 },
            allChars: [],
            ownedChars: [{ characterName: 'Himeko', eidolonLevel: 0 }],
            archetypes: [],
            junctions: [],
        });
        expect(computeAccountRating(ctx, 1)).toBe(0);
    });

    it('returns 0 when maxPossible is 0 and char pool is empty (no division by zero)', () => {
        const ctx = mockCtx({
            config: { maxPossible: 0 },
            allChars: [],
            ownedChars: [],
            archetypes: [],
            junctions: [],
        });
        expect(computeAccountRating(ctx, 1)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Single character scenarios
// ---------------------------------------------------------------------------

describe('computeAccountRating — single character', () => {
    it('single char at E0, single archetype with 1 member — computes expected rating', () => {
        // char at v4.0 (max), Dps, E0
        // ageWeight = sqrt(4.0/4.0)^2 = 1.0
        // vertical = (1/7) * 1.0 / 1 = 0.14286
        // archetype size=1, threshold=min(3,1)=1
        // ownershipSum=1.0, score=min(1.0/1,1)=1.0
        // horizontal = 1.0 / 1 = 1.0
        // combined = 0.14286*0.4 + 1.0*0.6 = 0.65714
        // maxPossible = pre-set to 0.65714 → rating = round(0.65714/0.65714 * 1000) = 1000
        const maxP = (1.0 / 7) * 0.4 + 1.0 * 0.6; // ~0.6571
        const ctx = mockCtx({
            config: { maxPossible: maxP },
            allChars: [{ name: 'A', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } }],
            ownedChars: [{ characterName: 'A', eidolonLevel: 0 }],
            archetypes: [{ id: 1, name: 'arch1' }],
            junctions: [{ characterName: 'A', archetypeId: 1 }],
        });
        expect(computeAccountRating(ctx, 1)).toBe(1000);
    });
});

// ---------------------------------------------------------------------------
// 3 E0 recent DPS chars with 3 archetypes (9 chars total)
// ---------------------------------------------------------------------------

describe('computeAccountRating — 3-DPS scenario', () => {
    it('3 E0 recent DPS chars in 9-char pool with 3 archetypes each of size 3 → 257', () => {
        // 9 chars all v4.0 Dps, 3 archetypes each with 3 chars
        // owned: A (arch1), D (arch2), G (arch3) — all E0
        // ageWeight all = sqrt(4/4)^2 = 1.0
        // vertical = (1/7)*1.0 mean across 3 owned = 1/7 ≈ 0.1429
        // horizontal:
        //   arch1: A,B,C → owned A → ownershipSum=1.0, threshold=3 → score=1/3
        //   arch2: D,E,F → owned D → ownershipSum=1.0, threshold=3 → score=1/3
        //   arch3: G,H,I → owned G → ownershipSum=1.0, threshold=3 → score=1/3
        //   horizontal = (1/3+1/3+1/3)/3 = 1/3 ≈ 0.3333
        // combined = 0.1429*0.4 + 0.3333*0.6 = 0.05714 + 0.2 = 0.25714
        // maxPossible: all 9 at E6
        //   vertical_max = 9 * 1.0 / 9 = 1.0
        //   horizontal_max: each arch fully covered → (1+1+1)/3 = 1.0
        //   maxP = 1.0*0.4 + 1.0*0.6 = 1.0
        // rating = round(0.25714 / 1.0 * 1000) = 257
        const allChars: AllChar[] = [
            { name: 'A', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'B', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'C', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'D', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'E', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'F', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'G', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'H', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'I', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
        ];
        const archetypes: Archetype[] = [
            { id: 1, name: 'arch1' },
            { id: 2, name: 'arch2' },
            { id: 3, name: 'arch3' },
        ];
        const junctions: Junction[] = [
            { characterName: 'A', archetypeId: 1 },
            { characterName: 'B', archetypeId: 1 },
            { characterName: 'C', archetypeId: 1 },
            { characterName: 'D', archetypeId: 2 },
            { characterName: 'E', archetypeId: 2 },
            { characterName: 'F', archetypeId: 2 },
            { characterName: 'G', archetypeId: 3 },
            { characterName: 'H', archetypeId: 3 },
            { characterName: 'I', archetypeId: 3 },
        ];
        const ownedChars: OwnedChar[] = [
            { characterName: 'A', eidolonLevel: 0 },
            { characterName: 'D', eidolonLevel: 0 },
            { characterName: 'G', eidolonLevel: 0 },
        ];
        const ctx = mockCtx({
            config: { maxPossible: 1.0 },
            allChars,
            ownedChars,
            archetypes,
            junctions,
        });
        expect(computeAccountRating(ctx, 1)).toBe(257);
    });
});

// ---------------------------------------------------------------------------
// treatAsVersion override
// ---------------------------------------------------------------------------

describe('computeAccountRating — treatAsVersion', () => {
    it('treatAsVersion overrides versionReleased: char at v1.0 with treatAsVersion=4.0 scores higher than without override', () => {
        // Base chars: A (old, v1.0), B (new, v4.0) — both Sustain
        // maxVersion = max(1.0, 4.0) = 4.0

        // WITH treatAsVersion=4.0 on A:
        //   A: uses treatAsVersion=4.0 → effective=4.0, aw=sqrt(4/4)^1=1.0
        //   B: versionReleased=4.0 → aw=1.0
        //   owned A; maxP: mean([1.0,1.0])*0.4 = 0.4
        //   vertical = (1/7)*1.0/1 = 0.1429; combined = 0.1429*0.4 = 0.0571
        //   rating = round(0.0571/0.4*1000) = round(142.86) = 143
        const ctxWithOverride = mockCtx({
            config: { maxPossible: 0.4 },
            allChars: [
                { name: 'A', versionReleased: 1.0, treatAsVersion: 4.0, role: { tag: 'Sustain' } },
                { name: 'B', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Sustain' } },
            ],
            ownedChars: [{ characterName: 'A', eidolonLevel: 0 }],
            archetypes: [],
            junctions: [],
        });

        // WITHOUT treatAsVersion (0.0 = use versionReleased=1.0):
        //   A: uses versionReleased=1.0 → effective=1.0, aw=sqrt(1/4)^1=0.5
        //   B: versionReleased=4.0 → aw=1.0
        //   owned A; maxP: mean([0.5,1.0])*0.4 = 0.75*0.4 = 0.3
        //   vertical = (1/7)*0.5/1 = 0.07143; combined = 0.07143*0.4 = 0.02857
        //   rating = round(0.02857/0.3*1000) = round(95.24) = 95
        const ctxWithoutOverride = mockCtx({
            config: { maxPossible: 0.3 },
            allChars: [
                { name: 'A', versionReleased: 1.0, treatAsVersion: 0, role: { tag: 'Sustain' } },
                { name: 'B', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Sustain' } },
            ],
            ownedChars: [{ characterName: 'A', eidolonLevel: 0 }],
            archetypes: [],
            junctions: [],
        });

        const ratingWithOverride = computeAccountRating(ctxWithOverride, 1);
        const ratingWithoutOverride = computeAccountRating(ctxWithoutOverride, 1);

        expect(ratingWithOverride).toBe(143);
        expect(ratingWithoutOverride).toBe(95);
        expect(ratingWithOverride).toBeGreaterThan(ratingWithoutOverride);
    });
});

// ---------------------------------------------------------------------------
// Role-dependent age decay
// ---------------------------------------------------------------------------

describe('computeAccountRating — role-dependent decay', () => {
    it('DPS decays faster than Support which decays faster than Sustain for old chars', () => {
        // Old char at v1.0, new char at v4.0. maxVersion=4.0, compression=0.2
        // effective(v1.0) = 1.0 + 0.0*0.2 = 1.0; baseWeight = sqrt(1/4) = 0.5
        //   Dps: 0.5^2 = 0.25
        //   Support: 0.5^1.3 ≈ 0.406
        //   Sustain: 0.5^1.0 = 0.5
        // Owning the OLD char normalised against its own pool:
        //   The ratio determines relative scoring within each role's normalization
        // We compare the absolute ratings — lower exponent = less decay = higher rating for old char
        const makeCtx = (roleTag: string, roleExponent: number) => {
            const allChars: AllChar[] = [
                { name: 'OldChar', versionReleased: 1.0, treatAsVersion: 0, role: { tag: roleTag } },
                { name: 'NewChar', versionReleased: 4.0, treatAsVersion: 0, role: { tag: roleTag } },
            ];
            const ownedChars: OwnedChar[] = [{ characterName: 'OldChar', eidolonLevel: 0 }];
            const awOld = Math.pow(Math.sqrt(1.0 / 4.0), roleExponent);
            const awNew = Math.pow(Math.sqrt(4.0 / 4.0), roleExponent); // always 1.0
            const maxP = ((awOld + awNew) / 2) * 0.4; // no archetypes
            return mockCtx({
                config: { maxPossible: maxP },
                allChars,
                ownedChars,
                archetypes: [],
                junctions: [],
            });
        };

        const dpsRating = computeAccountRating(makeCtx('Dps', 2.0), 1);
        const supportRating = computeAccountRating(makeCtx('Support', 1.3), 1);
        const sustainRating = computeAccountRating(makeCtx('Sustain', 1.0), 1);

        // Old char at v1.0:
        // Dps aw=0.25 vs mean([0.25,1.0])=0.625 → ratio 0.25/0.625=0.4 → normalized to 0.4
        // Support aw≈0.406 vs mean≈0.703 → ratio≈0.578
        // Sustain aw=0.5 vs mean=0.75 → ratio=0.667
        // Sustain old char scores higher than Support which scores higher than Dps
        expect(dpsRating).toBeLessThan(supportRating);
        expect(supportRating).toBeLessThan(sustainRating);
    });
});

// ---------------------------------------------------------------------------
// Within-version compression
// ---------------------------------------------------------------------------

describe('computeAccountRating — within-version compression', () => {
    it('compression=0.2 produces smaller gap between v2.1 and v2.5 than compression=1.0', () => {
        // With compression c: effective = floor(v) + frac(v)*c
        // v2.1: effective = 2 + 0.1*c
        // v2.5: effective = 2 + 0.5*c
        // maxVersion = 2.5 in both cases
        const makeCtxForCompression = (compression: number, charName: string) => {
            const allChars: AllChar[] = [
                { name: 'v21Char', versionReleased: 2.1, treatAsVersion: 0, role: { tag: 'Sustain' } },
                { name: 'v25Char', versionReleased: 2.5, treatAsVersion: 0, role: { tag: 'Sustain' } },
            ];
            const ownedChars: OwnedChar[] = [{ characterName: charName, eidolonLevel: 0 }];
            const eff21 = 2 + 0.1 * compression;
            const eff25 = 2 + 0.5 * compression;
            const maxV = eff25; // maxVersion from versionReleased, but formula uses versionReleased for maxVersion
            // Actually maxVersion = max(versionReleased) across allChars = max(2.1, 2.5) = 2.5
            const aw21 = Math.pow(Math.sqrt(eff21 / 2.5), 1.0);
            const aw25 = Math.pow(Math.sqrt(eff25 / 2.5), 1.0);
            const maxP = ((aw21 + aw25) / 2) * 0.4;
            return mockCtx({
                config: { compression, maxPossible: maxP },
                allChars,
                ownedChars,
                archetypes: [],
                junctions: [],
            });
        };

        const r21_c02 = computeAccountRating(makeCtxForCompression(0.2, 'v21Char'), 1);
        const r25_c02 = computeAccountRating(makeCtxForCompression(0.2, 'v25Char'), 1);
        const r21_c10 = computeAccountRating(makeCtxForCompression(1.0, 'v21Char'), 1);
        const r25_c10 = computeAccountRating(makeCtxForCompression(1.0, 'v25Char'), 1);

        const diff_c02 = r25_c02 - r21_c02;
        const diff_c10 = r25_c10 - r21_c10;

        // compression=0.2 compresses within-version differences, so gap should be smaller
        expect(diff_c02).toBeLessThan(diff_c10);
    });
});

// ---------------------------------------------------------------------------
// Dynamic archetype threshold
// ---------------------------------------------------------------------------

describe('computeAccountRating — dynamic archetype threshold', () => {
    it('2-member archetype uses threshold=2 (not 3), so owning both = full coverage', () => {
        // Arch with only 2 members; threshold = min(3, 2) = 2
        // Owning both → ownershipSum = 2*aw = 2*1.0 = 2.0; score = min(2/2, 1) = 1.0
        const allChars: AllChar[] = [
            { name: 'A', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Sustain' } },
            { name: 'B', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Sustain' } },
        ];
        const ownedChars: OwnedChar[] = [
            { characterName: 'A', eidolonLevel: 0 },
            { characterName: 'B', eidolonLevel: 0 },
        ];
        const archetypes: Archetype[] = [{ id: 1, name: 'small' }];
        const junctions: Junction[] = [
            { characterName: 'A', archetypeId: 1 },
            { characterName: 'B', archetypeId: 1 },
        ];
        // vertical = (1/7 + 1/7) / 2 = 1/7 ≈ 0.1429
        // horizontal = 1.0 (full coverage of 2-member arch)
        // combined = 0.1429*0.4 + 1.0*0.6 = 0.6571
        // maxPossible = same (owning all 2 at E6 → vertical=1.0, horizontal=1.0 → 1.0*0.4+1.0*0.6=1.0)
        // But maxPossible is pre-set; if we set it to 0.6571 then rating = 1000
        const maxP = (1.0 / 7) * 0.4 + 1.0 * 0.6;
        const ctx = mockCtx({
            config: { maxPossible: maxP },
            allChars,
            ownedChars,
            archetypes,
            junctions,
        });
        // rating = round((0.1429*0.4 + 1.0*0.6) / maxP * 1000) = 1000
        expect(computeAccountRating(ctx, 1)).toBe(1000);
    });
});

// ---------------------------------------------------------------------------
// Characters without archetypes
// ---------------------------------------------------------------------------

describe('computeAccountRating — chars without archetypes', () => {
    it('char without archetypes contributes to vertical but not horizontal', () => {
        // char A: no archetype; char B: in arch1 (size=1)
        // Player owns both
        const allChars: AllChar[] = [
            { name: 'A', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Sustain' } },
            { name: 'B', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Sustain' } },
        ];
        const ownedBoth: OwnedChar[] = [
            { characterName: 'A', eidolonLevel: 0 },
            { characterName: 'B', eidolonLevel: 0 },
        ];
        const ownedBOnly: OwnedChar[] = [
            { characterName: 'B', eidolonLevel: 0 },
        ];
        const archetypes: Archetype[] = [{ id: 1, name: 'arch1' }];
        const junctions: Junction[] = [{ characterName: 'B', archetypeId: 1 }];

        // Both owned:
        //   vertical = (1/7 + 1/7) / 2 = 1/7 (mean is same as 1 char)
        //   horizontal = 1.0 (B covers arch1 fully, threshold=1)
        //   combined = 1/7*0.4 + 1.0*0.6 = 0.6571
        // B only:
        //   vertical = (1/7) / 1 = 1/7 (same mean)
        //   horizontal = 1.0
        //   combined = same
        // Both produce the same rating since vertical is a mean (A doesn't boost it)
        const ctxBoth = mockCtx({
            config: { maxPossible: 1.0 },
            allChars,
            ownedChars: ownedBoth,
            archetypes,
            junctions,
        });
        const ctxBOnly = mockCtx({
            config: { maxPossible: 1.0 },
            allChars,
            ownedChars: ownedBOnly,
            archetypes,
            junctions,
        });

        // combined for both = 1/7*0.4 + 1.0*0.6 = 0.6571; rating = round(0.6571*1000)=657
        expect(computeAccountRating(ctxBoth, 1)).toBe(657);
        expect(computeAccountRating(ctxBOnly, 1)).toBe(657);

        // Verify A at E6 (vertical contribution) DOES increase rating
        const ownedAE6B: OwnedChar[] = [
            { characterName: 'A', eidolonLevel: 6 },
            { characterName: 'B', eidolonLevel: 0 },
        ];
        const ctxAE6B = mockCtx({
            config: { maxPossible: 1.0 },
            allChars,
            ownedChars: ownedAE6B,
            archetypes,
            junctions,
        });
        // vertical = (1.0 + 1/7) / 2 = 4/7 ≈ 0.5714; combined = 0.5714*0.4 + 1.0*0.6 = 0.829
        // rating = round(0.829*1000) = 829
        expect(computeAccountRating(ctxAE6B, 1)).toBeGreaterThan(657);
    });
});

// ---------------------------------------------------------------------------
// maxPossible normalization
// ---------------------------------------------------------------------------

describe('computeAccountRating — maxPossible normalization', () => {
    it('all chars at E6 yields rating = scale (1000)', () => {
        const allChars: AllChar[] = [
            { name: 'A', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'B', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Support' } },
            { name: 'C', versionReleased: 2.0, treatAsVersion: 0, role: { tag: 'Sustain' } },
        ];
        const ownedAllE6: OwnedChar[] = [
            { characterName: 'A', eidolonLevel: 6 },
            { characterName: 'B', eidolonLevel: 6 },
            { characterName: 'C', eidolonLevel: 6 },
        ];
        const archetypes: Archetype[] = [
            { id: 1, name: 'fua' },
            { id: 2, name: 'dot' },
        ];
        const junctions: Junction[] = [
            { characterName: 'A', archetypeId: 1 },
            { characterName: 'B', archetypeId: 2 },
        ];

        // Compute maxPossible to match the formula's output when owning all at E6
        // maxVersion = 4.0
        // compression=0.2, roleExponents: Dps=2.0, Support=1.3, Sustain=1.0
        // A (Dps, v4.0): effective=4.0, aw=sqrt(4/4)^2=1.0
        // B (Support, v4.0): effective=4.0, aw=sqrt(4/4)^1.3=1.0
        // C (Sustain, v2.0): effective=2.0+0*0.2=2.0, aw=sqrt(2/4)^1=sqrt(0.5)≈0.7071
        const awA = Math.pow(Math.sqrt(4.0 / 4.0), 2.0); // 1.0
        const awB = Math.pow(Math.sqrt(4.0 / 4.0), 1.3); // 1.0
        const awC = Math.pow(Math.sqrt(2.0 / 4.0), 1.0); // ~0.7071

        // verticalMax (all at E6 → E6 factor = 7/7 = 1.0)
        const verticalMax = (awA + awB + awC) / 3;
        // arch1 (A only, size=1): threshold=1; ownershipSum=awA=1.0; score=1.0
        // arch2 (B only, size=1): threshold=1; ownershipSum=awB=1.0; score=1.0
        const horizontalMax = 1.0;
        const maxP = verticalMax * 0.4 + horizontalMax * 0.6;

        const ctx = mockCtx({
            config: { maxPossible: maxP },
            allChars,
            ownedChars: ownedAllE6,
            archetypes,
            junctions,
        });
        expect(computeAccountRating(ctx, 1)).toBe(1000);
    });
});

// ---------------------------------------------------------------------------
// computeMaxPossible
// ---------------------------------------------------------------------------

describe('computeMaxPossible', () => {
    it('returns expected value for given config and char pool (no archetypes)', () => {
        // All chars at v4.0 Dps, no archetypes
        // ageWeight each = sqrt(4/4)^2 = 1.0
        // verticalMax = (1.0+1.0)/2 = 1.0
        // horizontalMax = 0 (no archetypes)
        // maxPossible = 1.0*0.4 + 0*0.6 = 0.4
        const allChars: AllChar[] = [
            { name: 'A', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'B', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
        ];
        const config = { ...DEFAULT_CONFIG };
        const ageWeightMap = new Map<string, number>([['A', 1.0], ['B', 1.0]]);

        const mockCtxForMax = {
            db: {
                Archetype: { iter: () => [][Symbol.iterator]() },
                HsrCharacterArchetype: {
                    archetype_id: {
                        filter: (_id: number) => [][Symbol.iterator](),
                    },
                },
            },
        };

        const result = computeMaxPossible(mockCtxForMax, config, ageWeightMap, allChars);
        expect(result).toBeCloseTo(0.4, 5);
    });

    it('returns 0 when char pool is empty', () => {
        const config = { ...DEFAULT_CONFIG };
        const ageWeightMap = new Map<string, number>();
        const mockCtxForMax = {
            db: {
                Archetype: { iter: () => [][Symbol.iterator]() },
                HsrCharacterArchetype: {
                    archetype_id: {
                        filter: (_id: number) => [][Symbol.iterator](),
                    },
                },
            },
        };
        const result = computeMaxPossible(mockCtxForMax, config, ageWeightMap, []);
        expect(result).toBe(0);
    });

    it('accounts for archetypes in maxPossible calculation', () => {
        // 3 chars all at v4.0 Dps, 1 archetype of size 3
        // verticalMax = 1.0; arch fully covered → horizontalMax=1.0
        // maxPossible = 1.0*0.4 + 1.0*0.6 = 1.0
        const allChars: AllChar[] = [
            { name: 'A', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'B', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
            { name: 'C', versionReleased: 4.0, treatAsVersion: 0, role: { tag: 'Dps' } },
        ];
        const config = { ...DEFAULT_CONFIG };
        const ageWeightMap = new Map<string, number>([['A', 1.0], ['B', 1.0], ['C', 1.0]]);
        const archetypes = [{ id: 1, name: 'arch1' }];
        const junctions = [
            { characterName: 'A', archetypeId: 1 },
            { characterName: 'B', archetypeId: 1 },
            { characterName: 'C', archetypeId: 1 },
        ];
        const mockCtxForMax = {
            db: {
                Archetype: { iter: () => archetypes[Symbol.iterator]() },
                HsrCharacterArchetype: {
                    archetype_id: {
                        filter: (id: number) => junctions.filter(j => j.archetypeId === id)[Symbol.iterator](),
                    },
                },
            },
        };
        const result = computeMaxPossible(mockCtxForMax, config, ageWeightMap, allChars);
        expect(result).toBeCloseTo(1.0, 5);
    });
});
