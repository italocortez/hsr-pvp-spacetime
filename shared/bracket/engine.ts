/**
 * Pure bracket generation + advancement engine (A23, S8a: moved from the review prototype
 * `notes/migration/prototypes/bracket-generation/bracket.ts`, behaviour unchanged).
 *
 * No SpacetimeDB or React imports. The module (`spacetimedb/src/helpers/bracketStore.ts`) calls
 * `generateSingleElim` / `generateDoubleElim`, persists one BracketMatch row per MatchSpec (including
 * the explicit `nextWinnerSlot` / `nextLoserSlot`), and applies the same routing rules as
 * `BracketEngine` when a result is applied (`helpers/bracketResults.ts`). The web app uses it for
 * the bracket preview.
 *
 * Design rules (see TOURNAMENT-INTENT-REVIEW.md section 5):
 *  - Every slot has exactly one explicit source: a seed, the winner of a match, or
 *    the loser of a match. Advancement writes into that exact slot, never "first
 *    empty slot".
 *  - The bracket is padded to a power of two. Seeds above teamCount are BYEs.
 *    BYEs propagate: a match with one BYE is a walkover (the real entrant advances
 *    automatically, its "loser" is a BYE); a match with two BYEs is void (its winner
 *    and loser are both BYEs). Rows for walkover/void matches still exist (Phase 4
 *    decision: BYE rows stay visible), but they are never played.
 *  - Double elimination: the WB final loser drops into the LB final; the grand
 *    final is a single match (Phase 4 CONTEXT: no reset) with the WB finalist in
 *    slot 1, so `winnerAdvantage` always belongs to slot 1.
 *  - No third-place match in double elimination (the LB final loser is 3rd, A29).
 */

/** The module's `BracketSide` enum tags; 'Group' is only produced by `groups.ts` (round robin). */
export type BracketSide = 'Winners' | 'Losers' | 'GrandFinals' | 'ThirdPlace' | 'Group';
export type Slot = 1 | 2;

export type SlotSource =
    | { kind: 'seed'; seed: number }          // 1-based; seed > teamCount means BYE
    | { kind: 'winner'; from: string }
    | { kind: 'loser'; from: string };

export interface Route {
    key: string;
    slot: Slot;
}

export interface MatchSpec {
    key: string;                 // 'W-R1-M1', 'L-R2-M1', 'GF', 'TP'
    side: BracketSide;
    round: number;               // per side, 1-based
    number: number;              // per side+round, 1-based
    sources: [SlotSource, SlotSource];
    winnerTo?: Route;
    loserTo?: Route;             // undefined = the loser is eliminated
    winnerAdvantage: number;     // games slot 1 starts with (GF only)
}

export interface BracketSpec {
    format: 'single' | 'double';
    teamCount: number;
    bracketSize: number;
    matches: MatchSpec[];        // topological order: every source refers to an earlier match
}

// ─── Seeding ────────────────────────────────────────────────────────────────

export function nextPowerOf2(n: number): number {
    let p = 1;
    while (p < n) p *= 2;
    return p;
}

/** Standard fold seeding: size 8 -> [[1,8],[4,5],[2,7],[3,6]]. */
export function foldSeeding(size: number): [number, number][] {
    let pairs: [number, number][] = [[1, 2]];
    let current = 2;
    while (current < size) {
        const next = current * 2;
        const out: [number, number][] = [];
        for (const [a, b] of pairs) {
            out.push([a, next + 1 - a]);
            out.push([b, next + 1 - b]);
        }
        pairs = out;
        current = next;
    }
    return size === 1 ? [] : pairs;
}

// ─── Keys ───────────────────────────────────────────────────────────────────

export const wbKey = (round: number, n: number): string => `W-R${round}-M${n}`;
export const lbKey = (round: number, n: number): string => `L-R${round}-M${n}`;
export const GF_KEY = 'GF';
export const TP_KEY = 'TP';
/** Group-stage key: group index (0-based, = TournamentTeam.groupId), round and match number (1-based). */
export const groupKey = (g: number, r: number, m: number): string => `G${g}-R${r}-M${m}`;

// ─── Generation ─────────────────────────────────────────────────────────────

function buildWinnersBracket(bracketSize: number): MatchSpec[] {
    const rounds = Math.log2(bracketSize);
    const out: MatchSpec[] = [];
    foldSeeding(bracketSize).forEach(([s1, s2], i) => {
        out.push({
            key: wbKey(1, i + 1), side: 'Winners', round: 1, number: i + 1,
            sources: [{ kind: 'seed', seed: s1 }, { kind: 'seed', seed: s2 }],
            winnerAdvantage: 0,
        });
    });
    for (let r = 2; r <= rounds; r++) {
        const count = bracketSize / 2 ** r;
        for (let m = 1; m <= count; m++) {
            out.push({
                key: wbKey(r, m), side: 'Winners', round: r, number: m,
                sources: [
                    { kind: 'winner', from: wbKey(r - 1, 2 * m - 1) },
                    { kind: 'winner', from: wbKey(r - 1, 2 * m) },
                ],
                winnerAdvantage: 0,
            });
        }
    }
    return out;
}

/** Fill winnerTo / loserTo from the sources (single source of truth = sources). */
function wireRoutes(matches: MatchSpec[]): void {
    const byKey = new Map(matches.map(m => [m.key, m]));
    for (const m of matches) {
        m.sources.forEach((src, idx) => {
            if (src.kind === 'seed') return;
            const from = byKey.get(src.from);
            if (!from) throw new Error(`${m.key} references unknown match ${src.from}`);
            const route: Route = { key: m.key, slot: (idx + 1) as Slot };
            if (src.kind === 'winner') {
                if (from.winnerTo) throw new Error(`${src.from} winner routed twice`);
                from.winnerTo = route;
            } else {
                if (from.loserTo) throw new Error(`${src.from} loser routed twice`);
                from.loserTo = route;
            }
        });
    }
}

export function generateSingleElim(teamCount: number, opts: { thirdPlace?: boolean } = {}): BracketSpec {
    if (!Number.isInteger(teamCount) || teamCount < 2) throw new Error('Single elimination needs at least 2 teams.');
    const bracketSize = nextPowerOf2(teamCount);
    const rounds = Math.log2(bracketSize);
    const matches = buildWinnersBracket(bracketSize);
    if (opts.thirdPlace && rounds >= 2) {
        matches.push({
            key: TP_KEY, side: 'ThirdPlace', round: rounds, number: 1,
            sources: [
                { kind: 'loser', from: wbKey(rounds - 1, 1) },
                { kind: 'loser', from: wbKey(rounds - 1, 2) },
            ],
            winnerAdvantage: 0,
        });
    }
    wireRoutes(matches);
    return { format: 'single', teamCount, bracketSize, matches };
}

/**
 * Which WB match of round j+1 drops into LB drop-round match i (1-based).
 * Odd drop rounds reverse the order, even ones swap halves; both keep a team
 * from meeting, in its first LB match, someone it just beat in the WB.
 */
export function dropSource(j: number, i: number, count: number): number {
    if (count === 1) return 1;
    if (j % 2 === 1) return count + 1 - i;
    const half = count / 2;
    return i <= half ? i + half : i - half;
}

export function generateDoubleElim(teamCount: number, opts: { winnerAdvantage?: number } = {}): BracketSpec {
    if (!Number.isInteger(teamCount) || teamCount < 2) throw new Error('Double elimination needs at least 2 teams.');
    const winnerAdvantage = opts.winnerAdvantage ?? 0;
    const bracketSize = nextPowerOf2(teamCount);
    const k = Math.log2(bracketSize);               // WB rounds
    const lbRounds = 2 * (k - 1);
    const matches = buildWinnersBracket(bracketSize);

    for (let r = 1; r <= lbRounds; r++) {
        if (r === 1) {
            // WB round-1 losers pair up
            const count = bracketSize / 4;
            for (let i = 1; i <= count; i++) {
                matches.push({
                    key: lbKey(1, i), side: 'Losers', round: 1, number: i,
                    sources: [
                        { kind: 'loser', from: wbKey(1, 2 * i - 1) },
                        { kind: 'loser', from: wbKey(1, 2 * i) },
                    ],
                    winnerAdvantage: 0,
                });
            }
        } else if (r % 2 === 0) {
            // Drop round: LB survivors vs losers of WB round j+1
            const j = r / 2;
            const count = bracketSize / 2 ** (j + 1);
            for (let i = 1; i <= count; i++) {
                matches.push({
                    key: lbKey(r, i), side: 'Losers', round: r, number: i,
                    sources: [
                        { kind: 'winner', from: lbKey(r - 1, i) },
                        { kind: 'loser', from: wbKey(j + 1, dropSource(j, i, count)) },
                    ],
                    winnerAdvantage: 0,
                });
            }
        } else {
            // Internal round: LB survivors play each other
            const j = (r - 1) / 2;
            const count = bracketSize / 2 ** (j + 2);
            for (let i = 1; i <= count; i++) {
                matches.push({
                    key: lbKey(r, i), side: 'Losers', round: r, number: i,
                    sources: [
                        { kind: 'winner', from: lbKey(r - 1, 2 * i - 1) },
                        { kind: 'winner', from: lbKey(r - 1, 2 * i) },
                    ],
                    winnerAdvantage: 0,
                });
            }
        }
    }

    matches.push({
        key: GF_KEY, side: 'GrandFinals', round: 1, number: 1,
        sources: [
            { kind: 'winner', from: wbKey(k, 1) },
            // 2 teams: no LB; the WB final loser goes straight to the grand final
            lbRounds === 0 ? { kind: 'loser', from: wbKey(1, 1) } : { kind: 'winner', from: lbKey(lbRounds, 1) },
        ],
        winnerAdvantage,
    });

    wireRoutes(matches);
    return { format: 'double', teamCount, bracketSize, matches };
}

// ─── Static BYE analysis ────────────────────────────────────────────────────

export type MatchKind = 'playable' | 'walkover' | 'void';

/** Classifies every match once the team count is known (no results needed). */
export function classifyMatches(spec: BracketSpec): Map<string, MatchKind> {
    const kind = new Map<string, MatchKind>();
    const isBye = (src: SlotSource): boolean => {
        if (src.kind === 'seed') return src.seed > spec.teamCount;
        const k = kind.get(src.from);
        if (k === undefined) throw new Error(`source ${src.from} not classified yet (order)`);
        if (src.kind === 'winner') return k === 'void';
        return k === 'void' || k === 'walkover';          // loser of a walkover is a BYE
    };
    for (const m of spec.matches) {
        const byes = m.sources.filter(isBye).length;
        kind.set(m.key, byes === 0 ? 'playable' : byes === 1 ? 'walkover' : 'void');
    }
    return kind;
}

// ─── Runtime engine (what the reducer helper would do against rows) ─────────

export type Entrant = number | 'BYE';             // team id, or a structural BYE

export interface MatchState {
    spec: MatchSpec;
    slots: [Entrant | undefined, Entrant | undefined];
    winner?: Entrant;
    loser?: Entrant;
}

export class BracketEngine {
    readonly matches = new Map<string, MatchState>();
    readonly losses = new Map<number, number>();
    readonly eliminated = new Set<number>();
    played = 0;

    constructor(readonly spec: BracketSpec, teamIdsBySeed: number[]) {
        if (teamIdsBySeed.length !== spec.teamCount) throw new Error('teamIdsBySeed length != teamCount');
        for (const m of spec.matches) {
            const st: MatchState = { spec: m, slots: [undefined, undefined] };
            m.sources.forEach((src, idx) => {
                if (src.kind === 'seed') st.slots[idx] = src.seed <= spec.teamCount ? teamIdsBySeed[src.seed - 1] : 'BYE';
            });
            this.matches.set(m.key, st);
        }
        for (const id of teamIdsBySeed) this.losses.set(id, 0);
        this.settle();
    }

    /** Matches ready to be played: both slots hold real teams, no result yet. */
    ready(): MatchState[] {
        return [...this.matches.values()].filter(s =>
            s.winner === undefined && typeof s.slots[0] === 'number' && typeof s.slots[1] === 'number');
    }

    isComplete(): boolean {
        return [...this.matches.values()].every(s => s.winner !== undefined);
    }

    champion(): number | undefined {
        const last = this.spec.format === 'double'
            ? this.matches.get(GF_KEY)
            : this.matches.get(wbKey(Math.log2(this.spec.bracketSize), 1));
        return typeof last?.winner === 'number' ? last.winner : undefined;
    }

    /**
     * Records a played result. Re-applying the same result is a no-op (idempotent);
     * a different result for a decided match must go through rollback.
     */
    applyResult(key: string, winnerSlot: Slot): void {
        const st = this.matches.get(key);
        if (!st) throw new Error(`unknown match ${key}`);
        const [a, b] = st.slots;
        if (typeof a !== 'number' || typeof b !== 'number') throw new Error(`${key} is not playable`);
        const winner = winnerSlot === 1 ? a : b;
        if (st.winner !== undefined) {
            if (st.winner === winner) return;
            throw new Error(`${key} already decided; roll back first`);
        }
        const loser = winnerSlot === 1 ? b : a;
        this.played++;
        this.losses.set(loser, (this.losses.get(loser) ?? 0) + 1);
        this.decide(st, winner, loser);
        this.settle();
    }

    private decide(st: MatchState, winner: Entrant, loser: Entrant): void {
        st.winner = winner;
        st.loser = loser;
        if (st.spec.winnerTo) this.place(st.spec.winnerTo, winner);
        if (st.spec.loserTo) this.place(st.spec.loserTo, loser);
        else if (typeof loser === 'number') this.eliminated.add(loser);
    }

    private place(route: Route, entrant: Entrant): void {
        const target = this.matches.get(route.key);
        if (!target) throw new Error(`route to unknown match ${route.key}`);
        const idx = route.slot - 1;
        const existing = target.slots[idx];
        if (existing !== undefined && existing !== entrant) {
            throw new Error(`${route.key} slot ${route.slot} already holds ${existing}`);
        }
        target.slots[idx] = entrant;
    }

    /** Resolves walkovers (one BYE) and void matches (two BYEs) until stable. */
    private settle(): void {
        let changed = true;
        while (changed) {
            changed = false;
            for (const st of this.matches.values()) {
                if (st.winner !== undefined) continue;
                const [a, b] = st.slots;
                if (a === undefined || b === undefined) continue;
                if (a === 'BYE' && b === 'BYE') { this.decide(st, 'BYE', 'BYE'); changed = true; }
                else if (a === 'BYE') { this.decide(st, b, 'BYE'); changed = true; }
                else if (b === 'BYE') { this.decide(st, a, 'BYE'); changed = true; }
            }
        }
    }
}

// ─── Structural invariants (shared by tests and by a reducer-side assert) ───

export interface InvariantReport {
    errors: string[];
}

/**
 * Structural checks independent of results:
 *  1. every non-R1 match has exactly two inbound references, one per slot;
 *     WB R1 matches have two seed sources;
 *  2. every winner is routed except the final(s); in double elim every WB loser is
 *     routed into the LB (or the GF for 2 teams) and every LB loser is eliminated;
 *  3. the grand final receives the WB final winner (slot 1) and the LB final winner (slot 2).
 */
export function checkStructure(spec: BracketSpec): InvariantReport {
    const errors: string[] = [];
    const inbound = new Map<string, { slot: number; ref: string }[]>();
    for (const m of spec.matches) inbound.set(m.key, []);
    for (const m of spec.matches) {
        if (m.winnerTo) inbound.get(m.winnerTo.key)?.push({ slot: m.winnerTo.slot, ref: `W:${m.key}` });
        if (m.loserTo) inbound.get(m.loserTo.key)?.push({ slot: m.loserTo.slot, ref: `L:${m.key}` });
    }
    const wbRounds = Math.log2(spec.bracketSize);
    for (const m of spec.matches) {
        const refs = inbound.get(m.key)!;
        const isR1 = m.side === 'Winners' && m.round === 1;
        if (isR1) {
            if (refs.length !== 0) errors.push(`${m.key}: R1 match has inbound refs`);
            if (!m.sources.every(s => s.kind === 'seed')) errors.push(`${m.key}: R1 sources must be seeds`);
        } else {
            const slots = refs.map(r => r.slot).sort().join(',');
            if (refs.length !== 2 || slots !== '1,2') errors.push(`${m.key}: inbound ${JSON.stringify(refs)}`);
        }
        const isFinal = spec.format === 'double' ? m.side === 'GrandFinals'
            : (m.side === 'ThirdPlace' || (m.side === 'Winners' && m.round === wbRounds));
        if (!isFinal && !m.winnerTo) errors.push(`${m.key}: winner not routed`);
        if (spec.format === 'double') {
            if (m.side === 'Winners' && !m.loserTo) errors.push(`${m.key}: WB loser not routed`);
            if (m.side === 'Losers' && m.loserTo) errors.push(`${m.key}: LB loser must be eliminated`);
            if (m.side === 'ThirdPlace') errors.push('double elimination must not have a third-place match');
        }
    }
    if (spec.format === 'double') {
        const gf = spec.matches.find(m => m.side === 'GrandFinals');
        if (!gf) errors.push('missing grand final');
        else {
            const lbRounds = 2 * (wbRounds - 1);
            const [s1, s2] = gf.sources;
            if (!(s1.kind === 'winner' && s1.from === wbKey(wbRounds, 1))) errors.push('GF slot 1 is not the WB final winner');
            const s2ok = lbRounds === 0
                ? s2.kind === 'loser' && s2.from === wbKey(1, 1)
                : s2.kind === 'winner' && s2.from === lbKey(lbRounds, 1);
            if (!s2ok) errors.push('GF slot 2 is not the LB final winner');
        }
    }
    return { errors };
}

// ─── Row adapter (shape the reducer would insert) ───────────────────────────

export interface BracketRowDraft {
    positionKey: string;
    bracketSide: BracketSide;
    roundNumber: number;
    matchNumber: number;
    team1Seed?: number;            // resolved to TournamentTeam.id by the reducer
    team2Seed?: number;
    nextWinnerKey?: string;
    nextWinnerSlot: number;        // 0 = none
    nextLoserKey?: string;
    nextLoserSlot: number;         // 0 = eliminated
    kind: MatchKind;
    winnerAdvantage: number;
}

export function toRowDrafts(spec: BracketSpec): BracketRowDraft[] {
    const kinds = classifyMatches(spec);
    return spec.matches.map(m => ({
        positionKey: m.key,
        bracketSide: m.side,
        roundNumber: m.round,
        matchNumber: m.number,
        team1Seed: m.sources[0].kind === 'seed' && m.sources[0].seed <= spec.teamCount ? m.sources[0].seed : undefined,
        team2Seed: m.sources[1].kind === 'seed' && m.sources[1].seed <= spec.teamCount ? m.sources[1].seed : undefined,
        nextWinnerKey: m.winnerTo?.key,
        nextWinnerSlot: m.winnerTo?.slot ?? 0,
        nextLoserKey: m.loserTo?.key,
        nextLoserSlot: m.loserTo?.slot ?? 0,
        kind: kinds.get(m.key)!,
        winnerAdvantage: m.winnerAdvantage,
    }));
}
