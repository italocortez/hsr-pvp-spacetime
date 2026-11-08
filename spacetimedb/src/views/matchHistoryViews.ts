// ─── Match History Views ──────────────────────────────────────────────────────
// Self-scoped replay views over the archived *_history tables (A37: history is private; a user reads only the
// matches they played in, where the identities of that match are revealed to its participants).
//
// S9a: the public history views (view_match_history, view_match_participant_history, view_match_step_history)
// are removed (A37 / R5); Moderator+ access is S9b's admin view.
//
// 1. view_my_mmr_history                    — Pattern A, MmrHistory.user_id filter
// 2. view_my_match_participant_history      — Pattern A, MatchParticipantHistory.by_user filter
// 3. view_my_match_session_history          — Pattern B, participant-first iteration
// 4. view_my_match_session_step_history     — Pattern B, participant-first iteration
// 5. view_my_match_result_game_history      — Pattern B, participant-first iteration
// 6. view_my_match_lineup_history           — Pattern B, participant-first iteration (A56(1), S9a)

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { MatchSessionHistory } from '@module/tables/draft/matchSessionHistory';
import { MatchParticipantHistory } from '@module/tables/draft/matchParticipantHistory';
import { MatchSessionStepHistory } from '@module/tables/draft/matchSessionStepHistory';
import { MatchLineupHistory } from '@module/tables/draft/matchLineupHistory';
import { MatchResultGameHistory } from '@module/tables/results/matchResultGameHistory';
import { MmrHistory } from '@module/tables/stats/mmrHistory';

// ---------------------------------------------------------------------------
// 1. view_my_mmr_history (Phase 15 D-13, D-17)
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
// 2. view_my_match_participant_history (Phase 15 D-13, D-17)
//    Pattern A: caller's own participant-history rows via direct by_user index.
//    (S9a: the visibility-filtered view_match_participant_history is removed, A37.)
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
// 3. view_my_match_session_history (Phase 15 D-13, D-18)
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
// 4. view_my_match_session_step_history (Phase 15 D-13, D-18)
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
// 5. view_my_match_result_game_history (Phase 15 D-13, D-18)
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

// ---------------------------------------------------------------------------
// 6. view_my_match_lineup_history (A56(1), S9a; replay viewer): MatchLineupHistory rows (one per team) of the
//    matches the caller played in. Pattern B: seed via MatchParticipantHistory.by_user, fan out via by_match_history.
// ---------------------------------------------------------------------------
export const view_my_match_lineup_history = spacetimedb.view(
    { name: 'view_my_match_lineup_history', public: true },
    t.array(MatchLineupHistory.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const myMatchIds = new Set<number>();
        for (const p of ctx.db.MatchParticipantHistory.by_user.filter(mapping.userId)) {
            myMatchIds.add(p.matchHistoryId);
        }
        const results: any[] = [];
        for (const matchId of myMatchIds) {
            for (const row of ctx.db.MatchLineupHistory.by_match_history.filter(matchId)) {
                results.push(row);
            }
        }
        return results;
    }
);
