// Views: the history views after an admin deletes a match history row; the rating history tie-break.
// Decisions: A115
// Contracts: docs/views/contract.md
// From S10q (s10q-gap-coverage.test.ts).
import { describe, expect, it } from 'vitest';
import { M, advance, guest, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import { moderator } from '../fixtures/tournament-builders';
import { seedElo } from '../fixtures/tournament-match-builders';
import { playRanked, validateAndFinalize } from '../fixtures/ranked-game-builders';

// ════════════════════════════════════════════════════════════════════════════
// Gap 4. A115 (S10n review F9, amended after S10r A122(2))
// ════════════════════════════════════════════════════════════════════════════

type Reader = Actor;
const view = <T = any>(test: Harness, name: string, who: Reader, args: Record<string, unknown>): T[] =>
    (M as any)[name](test.viewContext(who.auth), args) as T[];
const ANY = { gameMode: '', draftMode: '', matchType: '' };
const DETAIL_VIEWS = [
    'view_my_match_history_participants', 'view_my_match_history_steps',
    'view_my_match_history_games', 'view_my_match_history_lineups',
] as const;

describe('Gap 4, A115: the history views after an admin deletes a match history row; the rating history tie-break (S10n review F9)', () => {
    it('A115(1)(2)(3)(4), A122(2) (F9, amended): after admin_delete_row(MatchSessionHistory) of the older of two Ranked matches, view_my_mmr_history still lists the rating rows of both; the list and the count hold the remaining match only; its detail reads; the deleted match\'s detail is empty; nothing throws', () => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const actors = Object.fromEntries(['host', 'b1', 'b2', 'r1', 'r2'].map((n) => [n, guest(test, `hist-${n}`)]));
        const first = playRanked(test, 'Blue', { actors });
        validateAndFinalize(test, first.s, first.recId, mod, 'Blue');
        advance(test, 60_000);
        const second = playRanked(test, 'Red', { actors });
        validateAndFinalize(test, second.s, second.recId, mod, 'Red');
        const [older, newer] = [...test.db.MatchSessionHistory.iter()]
            .sort((a, b) => Number(a.playedAt.microsSinceUnixEpoch - b.playedAt.microsSinceUnixEpoch))
            .map((h) => h.id);
        const me = actors.b1;
        expect(view(test, 'view_my_match_history_count', me, ANY)).toEqual([{ total: 2 }]);

        tx(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'MatchSessionHistory', primaryKeyJson: String(older) }));
        expect(test.db.MatchSessionHistory.id.find(older)).toBeFalsy();

        const ratings = view(test, 'view_my_mmr_history', me, { page: 0, gameMode: '' });
        expect(ratings.map((r) => r.matchHistoryId)).toEqual([newer, older]);
        expect(ratings.every((r) => r.userId === me.userId)).toBe(true);

        const list = view(test, 'view_my_match_history', me, { page: 0, ...ANY });
        expect(list.map((r) => r.matchHistoryId)).toEqual([newer]);
        expect(list[0].ratingDelta).toBeDefined();
        expect(view(test, 'view_my_match_history_count', me, ANY)).toEqual([{ total: 1 }]);
        expect(view(test, 'view_my_match_history', me, { page: 1, ...ANY })).toEqual([]);
        for (const name of DETAIL_VIEWS) {
            const rows = view(test, name, me, { matchHistoryId: newer });
            expect(rows.length, name).toBeGreaterThan(0);
            expect(rows.every((r) => r.matchHistoryId === newer), name).toBe(true);
            expect(view(test, name, me, { matchHistoryId: older }), name).toEqual([]);
        }
    });

    it('pins current behaviour (row silent): A115(4) (F9: the rating history tie-break): rating rows written at the same instant are ordered by the higher id first, across the page boundary (10 + 3), with no overlap; an older row comes last', () => {
        const test = newHarness();
        const me = guest(test, 'tie-me');
        const insertRating = (matchHistoryId: number, at: ReturnType<Harness['clock']['now']>) =>
            test.db.MmrHistory.insert({
                id: 0, userId: me.userId, gameMode: { tag: 'MemoryOfChaos' }, matchHistoryId, previousRating: 1000, newRating: 1016,
                delta: 16, seasonId: undefined, createdById: 0, createdDate: at, lastModifiedById: 0, lastModifiedDate: at,
            } as any).id as number;
        const olderAt = test.clock.now();
        const olderId = insertRating(900, olderAt);
        advance(test, 60_000);
        const sameAt = test.clock.now();
        const tied = Array.from({ length: 12 }, (_, i) => insertRating(1000 + i, sameAt));
        const pages = [0, 1, 2].map((page) => view(test, 'view_my_mmr_history', me, { page, gameMode: '' }));
        expect(pages.map((p) => p.length)).toEqual([10, 3, 0]);
        const seen = pages.flat().map((r) => r.id);
        expect(new Set(seen).size).toBe(13);
        expect(seen).toEqual([...[...tied].sort((a, b) => b - a), olderId]);
    });
});
