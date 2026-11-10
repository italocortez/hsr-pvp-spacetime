// ─── Match History Views ──────────────────────────────────────────────────────
// Self-scoped views over the archived *_history tables (A37: history is private; a user reads only the matches they
// played in, where the identities of that match are revealed to its participants: no anonymous labels here).
//
// S9a: the public history views (view_match_history, view_match_participant_history, view_match_step_history)
// are removed (A37 / R5); Moderator+ access is S9b's admin view.
// S10n (A115): the five unbounded views (view_my_match_participant_history, view_my_match_session_history,
// view_my_match_session_step_history, view_my_match_result_game_history, view_my_match_lineup_history) are replaced
// by a paged list, its count and four per-match detail views; the rating history is paged too.
//
// 1. view_my_match_history(page, gameMode, draftMode, matchType) — the caller's matches, 10 per page, newest first
// 2. view_my_match_history_count(gameMode, draftMode, matchType)  — one row: the number of matches for the filters
// 3. view_my_match_history_participants(matchHistoryId)           — MatchParticipantHistory rows of one match
// 4. view_my_match_history_steps(matchHistoryId)                  — MatchSessionStepHistory rows of one match
// 5. view_my_match_history_games(matchHistoryId)                  — MatchResultGameHistory rows of one match
// 6. view_my_match_history_lineups(matchHistoryId)                — MatchLineupHistory rows of one match
// 7. view_my_mmr_history(page, gameMode)                          — the caller's MmrHistory rows, 10 per page, newest first
//
// Filters are strings because a view argument is passed as a SQL literal (`SELECT * FROM view_my_match_history(0, '',
// 'Classic', '')`): '' means "any", otherwise the enum tag (GameMode / DraftMode / MatchType). An unknown tag matches
// nothing. Pages start at 0; a page past the end returns no rows. Order: played-at (MatchSessionHistory.playedAt;
// MmrHistory.createdDate) newest first, the id only as the tie-break between equal times (CLAUDE.md §3.4).
//
// Match type and winner are stored on MatchSessionHistory at finalization (S10n fix pass, review F1 / F2): the list
// reads them; nothing is derived from tournaments, rating rows or the archived game.
//
// Cost per evaluation of 1 / 2: one MatchParticipantHistory.by_user scan (the caller's own matches, n rows), n
// MatchSessionHistory PK lookups, a sort of n; the list (1) also one MmrHistory.user_id scan (the caller's own rating
// rows). No other
// user's rows are read to build the list. The sort stays: no index on a history table can order one user's matches
// by time without a playedAt column on the participant row.
// Detail views (3-6): one by_match_history probe of MatchParticipantHistory (the match's few participants) for the
// membership check, then one by_match_history probe of the table read.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { MatchSessionHistory } from '@module/tables/draft/matchSessionHistory';
import { MatchParticipantHistory } from '@module/tables/draft/matchParticipantHistory';
import { MatchSessionStepHistory } from '@module/tables/draft/matchSessionStepHistory';
import { MatchLineupHistory } from '@module/tables/draft/matchLineupHistory';
import { MatchResultGameHistory } from '@module/tables/results/matchResultGameHistory';
import { MmrHistory } from '@module/tables/stats/mmrHistory';
import { DraftMode, GameMode, MatchEndReason, MatchType, TeamSide } from '@module/types/enums';
import { LobbyConfigSnapshot } from '@module/types/structs';

export const MATCH_HISTORY_PAGE_SIZE = 10;

/** The caller's user id from ctx.sender, or undefined. */
function callerUserId(ctx: any): number | undefined {
    return ctx.db.UserIdentity.identity.find(ctx.sender)?.userId;
}

/** Newest first by time; the id only breaks a tie between equal times (never the order itself, CLAUDE.md §3.4). */
function newestFirst(timeOf: (r: any) => bigint, idOf: (r: any) => number) {
    return (a: any, b: any): number => {
        const ta = timeOf(a);
        const tb = timeOf(b);
        if (ta !== tb) return ta > tb ? -1 : 1;
        return idOf(b) - idOf(a);
    };
}

function pageOf<T>(rows: T[], page: number): T[] {
    const start = page * MATCH_HISTORY_PAGE_SIZE;
    return rows.slice(start, start + MATCH_HISTORY_PAGE_SIZE);
}

interface MyMatch { participant: any; session: any }

/**
 * The caller's matches for the filters, newest first. Reads the caller's own participant rows and their sessions only.
 */
function myMatches(ctx: any, userId: number, gameMode: string, draftMode: string, matchType: string): MyMatch[] {
    const matches: MyMatch[] = [];
    for (const participant of ctx.db.MatchParticipantHistory.by_user.filter(userId)) {
        const session = ctx.db.MatchSessionHistory.id.find(participant.matchHistoryId);
        if (!session) continue;
        if (gameMode !== '' && session.gameMode.tag !== gameMode) continue;
        if (draftMode !== '' && session.draftMode.tag !== draftMode) continue;
        if (matchType !== '' && session.matchType.tag !== matchType) continue;
        matches.push({ participant, session });
    }
    matches.sort(newestFirst((m) => m.session.playedAt.microsSinceUnixEpoch, (m) => m.session.id));
    return matches;
}

/** True when the caller has a participant row in the match (the detail views' gate). */
function callerPlayedIn(ctx: any, matchHistoryId: number): boolean {
    const userId = callerUserId(ctx);
    if (userId === undefined) return false;
    for (const p of ctx.db.MatchParticipantHistory.by_match_history.filter(matchHistoryId)) {
        if (p.userId === userId) return true;
    }
    return false;
}

const FILTER_ARGS = { gameMode: t.string(), draftMode: t.string(), matchType: t.string() };

// ---------------------------------------------------------------------------
// 1. view_my_match_history(page, gameMode, draftMode, matchType) — A115(1)
//    One row per match of the page: the MatchSessionHistory fields (audit columns left out; the stored match type and
//    winner included), and the caller's own participant fields (side, flags, won, rating change when the match rated
//    them).
// ---------------------------------------------------------------------------
const MatchHistoryListRow = t.row('MatchHistoryListRow', {
    matchHistoryId: t.u32(),
    lobbyCode: t.string(),
    playedAt: t.timestamp(),
    draftMode: DraftMode,
    gameMode: GameMode,
    matchType: MatchType,                   // stored at finalization (MatchSessionHistory.matchType)
    teamBlueAlias: t.string(),
    teamRedAlias: t.string(),
    snapshotConfig: LobbyConfigSnapshot,
    outcome: MatchEndReason,
    teamBlueSpent: t.f32().optional(),
    teamRedSpent: t.f32().optional(),
    handicapApplied: t.i32().optional(),
    tournamentId: t.u32().optional(),
    bracketMatchId: t.u32().optional(),
    voidedAt: t.timestamp().optional(),
    winnerOverride: TeamSide.optional(),
    winnerOverrideById: t.u32().optional(),
    winnerOverrideReason: t.string().optional(),
    winnerTeamSide: TeamSide.optional(),    // stored at finalization: the record's final winner; none = no winner
    // The caller's own participant row
    teamSide: TeamSide,
    displayName: t.string(),
    isReferee: t.bool(),
    isCoach: t.bool(),
    isCaptain: t.bool(),
    won: t.bool().optional(),               // caller's side = the stored winner; none when the match has no winner
    // The caller's own MmrHistory row for this match, when it rated them
    previousRating: t.u32().optional(),
    newRating: t.u32().optional(),
    ratingDelta: t.i32().optional(),
});

export const view_my_match_history = spacetimedb.view(
    { name: 'view_my_match_history', public: true },
    { page: t.u32(), ...FILTER_ARGS },
    t.array(MatchHistoryListRow),
    (ctx, { page, gameMode, draftMode, matchType }) => {
        const userId = callerUserId(ctx);
        if (userId === undefined) return [];
        // The caller's own rating rows by match id (the list rows' rating change)
        const ownRated = new Map<number, any>();
        for (const m of ctx.db.MmrHistory.user_id.filter(userId)) ownRated.set(m.matchHistoryId, m);
        return pageOf(myMatches(ctx, userId, gameMode, draftMode, matchType), page).map(({ participant: p, session: s }) => {
            const winnerTeamSide = s.winnerTeamSide;
            const rating = ownRated.get(s.id);
            return {
                matchHistoryId: s.id,
                lobbyCode: s.lobbyCode,
                playedAt: s.playedAt,
                draftMode: s.draftMode,
                gameMode: s.gameMode,
                matchType: s.matchType,
                teamBlueAlias: s.teamBlueAlias,
                teamRedAlias: s.teamRedAlias,
                snapshotConfig: s.snapshotConfig,
                outcome: s.outcome,
                teamBlueSpent: s.teamBlueSpent,
                teamRedSpent: s.teamRedSpent,
                handicapApplied: s.handicapApplied,
                tournamentId: s.tournamentId,
                bracketMatchId: s.bracketMatchId,
                voidedAt: s.voidedAt,
                winnerOverride: s.winnerOverride,
                winnerOverrideById: s.winnerOverrideById,
                winnerOverrideReason: s.winnerOverrideReason,
                winnerTeamSide,
                teamSide: p.teamSide,
                displayName: p.displayName,
                isReferee: p.isReferee,
                isCoach: p.isCoach,
                isCaptain: p.isCaptain,
                // Participant rows sit on Blue or Red (finalization writes players only); the guard keeps a
                // non-team side from reading as a loss.
                won: winnerTeamSide !== undefined && (p.teamSide.tag === 'Blue' || p.teamSide.tag === 'Red')
                    ? winnerTeamSide.tag === p.teamSide.tag
                    : undefined,
                previousRating: rating?.previousRating,
                newRating: rating?.newRating,
                ratingDelta: rating?.delta,
            };
        });
    }
);

// ---------------------------------------------------------------------------
// 2. view_my_match_history_count(gameMode, draftMode, matchType) — A115(2)
//    Exactly one row for a mapped caller (total 0 when nothing matches); no row for an unmapped identity.
// ---------------------------------------------------------------------------
const MatchHistoryCountRow = t.row('MatchHistoryCountRow', {
    total: t.u32(),
});

export const view_my_match_history_count = spacetimedb.view(
    { name: 'view_my_match_history_count', public: true },
    FILTER_ARGS,
    t.array(MatchHistoryCountRow),
    (ctx, { gameMode, draftMode, matchType }) => {
        const userId = callerUserId(ctx);
        if (userId === undefined) return [];
        return [{ total: myMatches(ctx, userId, gameMode, draftMode, matchType).length }];
    }
);

// ---------------------------------------------------------------------------
// 3-6. Per-match detail views — A115(3). Rows only when the caller has a participant row in that match; today's row
//      shapes (the table rows), no anonymous labels (A37: a match's identities are revealed to its participants).
// ---------------------------------------------------------------------------
export const view_my_match_history_participants = spacetimedb.view(
    { name: 'view_my_match_history_participants', public: true },
    { matchHistoryId: t.u32() },
    t.array(MatchParticipantHistory.rowType),
    (ctx, { matchHistoryId }) => {
        if (!callerPlayedIn(ctx, matchHistoryId)) return [];
        return [...ctx.db.MatchParticipantHistory.by_match_history.filter(matchHistoryId)];
    }
);

export const view_my_match_history_steps = spacetimedb.view(
    { name: 'view_my_match_history_steps', public: true },
    { matchHistoryId: t.u32() },
    t.array(MatchSessionStepHistory.rowType),
    (ctx, { matchHistoryId }) => {
        if (!callerPlayedIn(ctx, matchHistoryId)) return [];
        return [...ctx.db.MatchSessionStepHistory.by_match_history.filter(matchHistoryId)]
            .sort((a: any, b: any) => a.sequence - b.sequence);
    }
);

export const view_my_match_history_games = spacetimedb.view(
    { name: 'view_my_match_history_games', public: true },
    { matchHistoryId: t.u32() },
    t.array(MatchResultGameHistory.rowType),
    (ctx, { matchHistoryId }) => {
        if (!callerPlayedIn(ctx, matchHistoryId)) return [];
        return [...ctx.db.MatchResultGameHistory.by_match_history.filter(matchHistoryId)];
    }
);

export const view_my_match_history_lineups = spacetimedb.view(
    { name: 'view_my_match_history_lineups', public: true },
    { matchHistoryId: t.u32() },
    t.array(MatchLineupHistory.rowType),
    (ctx, { matchHistoryId }) => {
        if (!callerPlayedIn(ctx, matchHistoryId)) return [];
        return [...ctx.db.MatchLineupHistory.by_match_history.filter(matchHistoryId)];
    }
);

// ---------------------------------------------------------------------------
// 7. view_my_mmr_history(page, gameMode) (Phase 15 D-13; paged since S10n, A115(4))
//    The caller's own MmrHistory rows via the user_id index, filtered by game mode ('' = any), newest first by the
//    time the row was written (createdDate; a tournament's ratings are written at its completion), id as tie-break.
// ---------------------------------------------------------------------------
export const view_my_mmr_history = spacetimedb.view(
    { name: 'view_my_mmr_history', public: true },
    { page: t.u32(), gameMode: t.string() },
    t.array(MmrHistory.rowType),
    (ctx, { page, gameMode }) => {
        const userId = callerUserId(ctx);
        if (userId === undefined) return [];
        const rows = [...ctx.db.MmrHistory.user_id.filter(userId)]
            .filter((r: any) => gameMode === '' || r.gameMode.tag === gameMode);
        rows.sort(newestFirst((r) => r.createdDate.microsSinceUnixEpoch, (r) => r.id));
        return pageOf(rows, page);
    }
);
