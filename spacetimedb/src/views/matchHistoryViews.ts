// ─── Match History Views ──────────────────────────────────────────────────────
// Visibility-filtered history views spanning the archived *_history tables.
//
// S9 (A37/R5): views 1-3 are removed (history is participants + Moderator+ only, through view_my_*);
// S3 only dropped the public-visibility branch so they compile.
// Visibility-filtered (participated only since S3; was public OR participated, D-93):
// 1. view_match_history              — visibility-filtered MatchSessionHistory
// 2. view_match_participant_history  — visibility-filtered MatchParticipantHistory
// 3. view_match_step_history         — visibility-filtered MatchSessionStepHistory
//
// Self-scoped (caller's own rows only — Phase 15 D-13, D-17, D-18):
// 4. view_my_mmr_history                    — Pattern A, MmrHistory.user_id filter
// 5. view_my_match_participant_history      — Pattern A, MatchParticipantHistory.by_user filter
// 6. view_my_match_session_history          — Pattern B, participant-first iteration
// 7. view_my_match_session_step_history     — Pattern B, participant-first iteration
// 8. view_my_match_result_game_history      — Pattern B, participant-first iteration

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { MatchSessionHistory } from '@module/tables/draft/matchSessionHistory';
import { MatchParticipantHistory } from '@module/tables/draft/matchParticipantHistory';
import { MatchSessionStepHistory } from '@module/tables/draft/matchSessionStepHistory';
import { MatchResultGameHistory } from '@module/tables/results/matchResultGameHistory';
import { MmrHistory } from '@module/tables/stats/mmrHistory';

// ---------------------------------------------------------------------------
// 1. view_match_history (per D-93)
//    NOT prefixed "my" because it returns both personal AND public data:
//      - (dropped in S3) the row was publicly visible, OR
//      - Caller is a participant (MatchParticipantHistory lookup)
//    The "view_my_*" views are strictly scoped to the caller's lobbies.
//    This view includes any user's publicly visible matches — hence no "my" prefix.
//    Prevents tournament scouting during active tournaments (D-72/D-73).
//
//    Implementation note: MatchSessionHistory has no visibility index.
//    We scan via 3 btree filters (one per GameMode) to avoid .iter() and
//    combine with participated matchHistoryIds from MatchParticipantHistory.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared helper: walks MatchSessionHistory via the 3 game-mode indexes once,
// returns both the visible ID set (for fan-out views) and the row array
// (for view_match_history's direct emission). Phase 15 WR-05.
// ---------------------------------------------------------------------------

function buildVisibleMatches(ctx: any): { ids: Set<number>; sessions: any[] } {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);

    const participatedIds = new Set<number>();
    if (mapping) {
        const callerUserId = mapping.userId;
        for (const row of ctx.db.MatchParticipantHistory.by_user.filter(callerUserId)) {
            participatedIds.add(row.matchHistoryId);
        }
    }

    const ids = new Set<number>();
    const sessions: any[] = [];

    const gameModes: any[] = [
        { tag: 'MemoryOfChaos', value: {} },
        { tag: 'ApocalypticShadow', value: {} },
        { tag: 'AnomalyArbitration', value: {} },
    ];

    for (const gm of gameModes) {
        for (const history of ctx.db.MatchSessionHistory.game_mode.filter(gm)) {
            if (participatedIds.has(history.id)) { // S3: the public-visibility flag was dropped (A37)
                ids.add(history.id);
                sessions.push(history);
            }
        }
    }

    return { ids, sessions };
}

// Phase 15 D-01/D-02: moved from anonymousViews.ts
export const view_match_history = spacetimedb.view(
    { name: 'view_match_history', public: true },
    t.array(MatchSessionHistory.rowType),
    (ctx) => buildVisibleMatches(ctx).sessions
);

// ---------------------------------------------------------------------------
// 2. view_match_participant_history (per D-93)
//    NOT prefixed "my" — returns participants for public matches + caller's matches.
//    Same visibility rule as view_match_history:
//      - (dropped in S3) the match was publicly visible, OR
//      - Caller is a participant in that match
//    Prevents tournament scouting — opponent identities hidden until reveal.
// ---------------------------------------------------------------------------

// Phase 15 D-01/D-02: moved from anonymousViews.ts
export const view_match_participant_history = spacetimedb.view(
    { name: 'view_match_participant_history', public: true },
    t.array(MatchParticipantHistory.rowType),
    (ctx) => {
        const { ids } = buildVisibleMatches(ctx);
        const results: any[] = [];
        for (const matchId of ids) {
            for (const row of ctx.db.MatchParticipantHistory.by_match_history.filter(matchId)) {
                results.push(row);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 3. view_match_step_history (per D-93)
//    NOT prefixed "my" — returns step history for public matches + caller's matches.
//    Same visibility rule as view_match_history.
//    Contains the full draft replay (picks, bans, bids, pauses, undos).
// ---------------------------------------------------------------------------

// Phase 15 D-01/D-02: moved from anonymousViews.ts
export const view_match_step_history = spacetimedb.view(
    { name: 'view_match_step_history', public: true },
    t.array(MatchSessionStepHistory.rowType),
    (ctx) => {
        const { ids } = buildVisibleMatches(ctx);
        const results: any[] = [];
        for (const matchId of ids) {
            for (const row of ctx.db.MatchSessionStepHistory.by_match_history.filter(matchId)) {
                results.push(row);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 4. view_my_mmr_history (Phase 15 D-13, D-17)
//    Pattern A: caller's own MMR history rows via direct user_id index filter.
// ---------------------------------------------------------------------------
export const view_my_mmr_history = spacetimedb.view(
    { name: 'view_my_mmr_history', public: true },
    t.array(MmrHistory.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        return [...ctx.db.MmrHistory.user_id.filter(mapping.userId)];
    }
);

// ---------------------------------------------------------------------------
// 5. view_my_match_participant_history (Phase 15 D-13, D-17)
//    Pattern A: caller's own participant-history rows via direct by_user index.
//    Distinct from `view_match_participant_history` above (visibility-filtered,
//    no `my_` prefix). Both coexist — this one is the strict self-scope.
// ---------------------------------------------------------------------------
export const view_my_match_participant_history = spacetimedb.view(
    { name: 'view_my_match_participant_history', public: true },
    t.array(MatchParticipantHistory.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        return [...ctx.db.MatchParticipantHistory.by_user.filter(mapping.userId)];
    }
);

// ---------------------------------------------------------------------------
// 6. view_my_match_session_history (Phase 15 D-13, D-18)
//    Pattern B: MatchSessionHistory has no userId column.
//    Seed participant set via by_user, then look up each session by PK.
// ---------------------------------------------------------------------------
export const view_my_match_session_history = spacetimedb.view(
    { name: 'view_my_match_session_history', public: true },
    t.array(MatchSessionHistory.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const myMatchIds = new Set<number>();
        for (const p of ctx.db.MatchParticipantHistory.by_user.filter(mapping.userId)) {
            myMatchIds.add(p.matchHistoryId);
        }
        const results: any[] = [];
        for (const matchId of myMatchIds) {
            const row = ctx.db.MatchSessionHistory.id.find(matchId);
            if (row) results.push(row);
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 7. view_my_match_session_step_history (Phase 15 D-13, D-18)
//    Pattern B: seed via participant set, fan out via by_match_history index.
// ---------------------------------------------------------------------------
export const view_my_match_session_step_history = spacetimedb.view(
    { name: 'view_my_match_session_step_history', public: true },
    t.array(MatchSessionStepHistory.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const myMatchIds = new Set<number>();
        for (const p of ctx.db.MatchParticipantHistory.by_user.filter(mapping.userId)) {
            myMatchIds.add(p.matchHistoryId);
        }
        const results: any[] = [];
        for (const matchId of myMatchIds) {
            for (const step of ctx.db.MatchSessionStepHistory.by_match_history.filter(matchId)) {
                results.push(step);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 8. view_my_match_result_game_history (Phase 15 D-13, D-18)
//    Pattern B: seed via participant set, fan out via by_match_history index.
// ---------------------------------------------------------------------------
export const view_my_match_result_game_history = spacetimedb.view(
    { name: 'view_my_match_result_game_history', public: true },
    t.array(MatchResultGameHistory.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const myMatchIds = new Set<number>();
        for (const p of ctx.db.MatchParticipantHistory.by_user.filter(mapping.userId)) {
            myMatchIds.add(p.matchHistoryId);
        }
        const results: any[] = [];
        for (const matchId of myMatchIds) {
            for (const row of ctx.db.MatchResultGameHistory.by_match_history.filter(matchId)) {
                results.push(row);
            }
        }
        return results;
    }
);
