// T-S7b: A59 Classic draft orders for Thirds (12 picks per team), asserted step by step on MatchSession.draftSequence
// as start_draft builds it; the Halves orders of docs/match-session/draft-order.md stay unchanged. In-memory datastore.
import { describe, expect, it } from 'vitest';
import { newHarness, session, setupLobby } from './s4-fixtures';

type BanMode = 'None' | 'Four' | 'Six';

/** DECISIONS.md A59, expanded: one token per step, B / R = Blue / Red pick, [B] / [R] = ban. */
const THIRDS: Record<BanMode, string> = {
    None: 'B R R B R B B R R B B R R B B R B R B R B B R R',
    Four: '[B] [R] B R R B [R] [B] R B B R R B B R R B B R R B B R R B B R',
    Six: '[B] [R] B R R B [R] [B] R B B R [B] [R] B B R R B B R R B B R R B R B R',
};

/** docs/match-session/draft-order.md "classic" (0bans / 4ban / 6ban), the user's 8-pick spec. */
const HALVES: Record<BanMode, string> = {
    None: 'B R R B R B B R R B B R R B B R',
    Four: '[B] [R] B R R B [R] [B] R B B R R B B R R B B R',
    Six: '[B] [R] B R R B [R] [B] R B B R [B] [R] B B R R B R B R',
};

/** The built sequence in the same notation. */
function tokens(lobbyFormat: 'Halves' | 'Thirds', banMode: BanMode): string[] {
    const test = newHarness();
    const s = setupLobby(test, { lobby: { lineupFormat: { tag: lobbyFormat }, banMode: { tag: banMode } } });
    return session(test, s.lobbyId).draftSequence.map((st) => {
        const team = st.teamTurn.tag === 'Blue' ? 'B' : 'R';
        return st.actionRequired.tag === 'Ban' ? `[${team}]` : team;
    });
}

const longestRun = (seq: string[]) => {
    let best = 0;
    let run = 0;
    let prev = '';
    for (const t of seq) {
        const colour = t.replace(/[[\]]/g, '');
        run = colour === prev ? run + 1 : 1;
        prev = colour;
        best = Math.max(best, run);
    }
    return best;
};

describe('A59: Classic Thirds orders', () => {
    for (const banMode of ['None', 'Four', 'Six'] as const) {
        it(`${banMode}: the A59 order step by step, 12 picks each, Blue first, Red last, no run longer than two`, () => {
            const seq = tokens('Thirds', banMode);
            const expected = THIRDS[banMode].split(' ');
            expect(seq).toHaveLength(expected.length);
            seq.forEach((t, i) => expect(`${i + 1}:${t}`).toBe(`${i + 1}:${expected[i]}`));
            expect(seq.filter((t) => t === 'B')).toHaveLength(12);
            expect(seq.filter((t) => t === 'R')).toHaveLength(12);
            const picks = seq.filter((t) => !t.startsWith('['));
            expect(picks[0]).toBe('B');
            expect(picks[picks.length - 1]).toBe('R');
            expect(longestRun(seq)).toBeLessThanOrEqual(2);
            // Every ban position (and the first eight picks) as in the Halves order of the same ban mode.
            const halves = HALVES[banMode].split(' ');
            const bansAt = (q: string[]) => q.map((t, i) => (t.startsWith('[') ? `${i}${t}` : '')).filter(Boolean);
            expect(bansAt(seq)).toEqual(bansAt(halves));
            expect(seq.filter((t) => !t.startsWith('[')).slice(0, 8)).toEqual(halves.filter((t) => !t.startsWith('[')).slice(0, 8));
        });
    }
    it('lengths: None 24, Four 28, Six 30 steps', () => {
        expect(tokens('Thirds', 'None')).toHaveLength(24);
        expect(tokens('Thirds', 'Four')).toHaveLength(28);
        expect(tokens('Thirds', 'Six')).toHaveLength(30);
    });
});

describe('A59: Halves orders unchanged (docs/match-session/draft-order.md)', () => {
    for (const banMode of ['None', 'Four', 'Six'] as const) {
        it(`${banMode}: matches the 8-pick spec step by step`, () => {
            expect(tokens('Halves', banMode)).toEqual(HALVES[banMode].split(' '));
        });
    }
});
