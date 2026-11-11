// ─── Match Views (live) ───────────────────────────────────────────────────────
// Per-user views over the live match of the caller's lobbies (S9a: A37, A40, A56, A60, A63). Subscribed by the room
// only once the lobby is past Waiting (PAGE-MAP D3). Fan-out from the caller's memberships (abandoned excluded,
// A68(4)); user ids anonymized per the seat rules (hideUserId: shouldAnonymize, plus leavers in anonymous lobbies).
//
// 1. view_my_match_session      — the MatchSession row (timers, turn, budgets), no audit columns
// 2. view_my_match_steps        — anonymized MatchSessionStep rows (D-92, A67(3): no gameNumber)
// 3. view_my_match_participants — anonymized MatchResultParticipant rows, rating snapshot per A40
// 4. view_my_lineups            — live MatchLineup rows with the game's confirmation flags and closed marker (A60)
//
// Index-only: no table scan in any view body.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { TeamSide, ActionType } from '@module/types/enums';
import { StepPayload } from '@module/types/structs';
import { matchSessionColumns } from '@module/tables/draft/matchSession';
import { anonymousLabelOr, callerMemberships, hideUserId, ratingVisible } from '@module/helpers/identity/viewAnonymity';
import { findLobbyResult } from '@module/helpers/results/scoringHelpers';

// ---------------------------------------------------------------------------
// 1. view_my_match_session (§A.4 P1; PAGE-MAP match flow): the MatchSession row of each of the caller's lobbies.
//    MatchSession holds no user id besides its audit columns, which are dropped (A37).
// ---------------------------------------------------------------------------
const {
    createdById: _sessionCreatedById,
    createdDate: _sessionCreatedDate,
    lastModifiedById: _sessionLastModifiedById,
    lastModifiedDate: _sessionLastModifiedDate,
    ...sessionViewColumns
} = matchSessionColumns;

const MatchSessionViewRow = t.row('MatchSessionViewRow', sessionViewColumns);

export const view_my_match_session = spacetimedb.view(
    { name: 'view_my_match_session', public: true },
    t.array(MatchSessionViewRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const rows: any[] = [];
        for (const membership of me.memberships) {
            const session = ctx.db.MatchSession.lobbyId.find(membership.lobbyId);
            if (!session) continue;
            const { createdById, createdDate, lastModifiedById, lastModifiedDate, ...rest } = session;
            rows.push(rest);
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 2. view_my_match_steps (D-92, A37, A67(3)): actorUserId 0 + a seat label when the actor is anonymized for the
//    caller (S9a fix: computed at read time, anonymousLabelOr; "<side> player" for a leaver; S11a (L39): the step
//    table no longer has a stored label);
//    no gameNumber (one game per lobby); no audit columns.
// ---------------------------------------------------------------------------
const AnonymousMatchStepRow = t.row('AnonymousMatchStepRow', {
    id: t.u32().primaryKey(),
    lobbyId: t.u32(),
    sequence: t.u32(), // A67(3): one game per lobby
    actorUserId: t.u32(),
    anonymousLabel: t.string().optional(),
    actorSlot: TeamSide,
    action: ActionType,
    payload: StepPayload,
    timestamp: t.timestamp(),
});

export const view_my_match_steps = spacetimedb.view(
    { name: 'view_my_match_steps', public: true },
    t.array(AnonymousMatchStepRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const results: any[] = [];
        for (const membership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
            if (!lobby) continue;
            for (const step of ctx.db.MatchSessionStep.lobby_id.filter(lobby.id)) {
                const anonymize = hideUserId(ctx, lobby, membership, step.actorUserId);
                results.push({
                    id: step.id,
                    lobbyId: step.lobbyId,
                    sequence: step.sequence,
                    actorUserId: anonymize ? 0 : step.actorUserId,
                    // S9a fix (S9a-A1): computed at read time; the step writers store no label
                    anonymousLabel: anonymize
                        ? anonymousLabelOr(ctx, lobby.id, step.actorUserId, `${step.actorSlot.tag} player`)
                        : undefined,
                    actorSlot: step.actorSlot,
                    action: step.action,
                    payload: step.payload,
                    timestamp: step.timestamp,
                });
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 3. view_my_match_participants (D-92, A37, A40): the start-of-draft participant copy of each lobby's record.
//    userId 0 + label when anonymized; accountRatingSnapshot per ratingVisible (exact, anonymized seats too, A40).
// ---------------------------------------------------------------------------
const AnonymousMatchParticipantRow = t.row('AnonymousMatchParticipantRow', {
    matchResultId: t.u32(),
    userId: t.u32(),
    teamSide: TeamSide,
    isCaptain: t.bool(),
    anonymousLabel: t.string().optional(),
    accountRatingSnapshot: t.f64().optional(),
});

export const view_my_match_participants = spacetimedb.view(
    { name: 'view_my_match_participants', public: true },
    t.array(AnonymousMatchParticipantRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const results: any[] = [];
        for (const membership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
            if (!lobby) continue;
            const record = findLobbyResult(ctx, lobby.id);
            if (!record) continue;
            for (const participant of ctx.db.MatchResultParticipant.match_result_id.filter(record.id)) {
                const anonymize = hideUserId(ctx, lobby, membership, participant.userId);
                // A seat stand-in for the rating rule: the participant's team as a player slot (a leaver has no row).
                const target = {
                    userId: participant.userId,
                    lobbySlot: { tag: participant.teamSide.tag === 'Blue' ? 'BluePlayer' : 'RedPlayer' },
                };
                results.push({
                    matchResultId: participant.matchResultId,
                    userId: anonymize ? 0 : participant.userId,
                    teamSide: participant.teamSide,
                    isCaptain: participant.isCaptain,
                    // S9a fix (review #10): a participant without a member row reads the slot-based label, never "Unknown"
                    anonymousLabel: anonymize
                        ? anonymousLabelOr(ctx, lobby.id, participant.userId, `${participant.teamSide.tag} player`)
                        : undefined,
                    accountRatingSnapshot: ratingVisible(lobby, membership, target) ? participant.accountRatingSnapshot : undefined,
                });
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 4. view_my_lineups (A56 live table, A60(2)(3), A63; PAGE-MAP lineup arrangement): the live MatchLineup rows of the
//    caller's lobbies, both teams, with the game's ready flags and closed marker from the lobby's MatchResultGame.
//    Visibility: everyone in the lobby sees both lineups live (MatchLineup table rule "visible live to everyone in
//    the lobby through view_my_lineups"; A60 Why: "everyone in the lobby sees every edit"); the characters are
//    public through the draft steps anyway. A lineup holds no user id; the audit columns are dropped.
// ---------------------------------------------------------------------------
const MatchLineupViewRow = t.row('MatchLineupViewRow', {
    id: t.u32().primaryKey(),
    lobbyId: t.u32(),
    teamSide: TeamSide,
    groups: t.string(),
    synergySurcharge: t.u32(),
    rosterCost: t.u32(),
    blueConfirmed: t.bool(),
    redConfirmed: t.bool(),
    closedAt: t.timestamp().optional(),
});

export const view_my_lineups = spacetimedb.view(
    { name: 'view_my_lineups', public: true },
    t.array(MatchLineupViewRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const results: any[] = [];
        for (const membership of me.memberships) {
            const record = findLobbyResult(ctx, membership.lobbyId);
            const game = record ? [...ctx.db.MatchResultGame.match_result_id.filter(record.id)][0] : undefined;
            for (const lineup of ctx.db.MatchLineup.by_lobby.filter(membership.lobbyId)) {
                results.push({
                    id: lineup.id,
                    lobbyId: lineup.lobbyId,
                    teamSide: lineup.teamSide,
                    groups: lineup.groups,
                    synergySurcharge: lineup.synergySurcharge,
                    rosterCost: lineup.rosterCost,
                    blueConfirmed: game ? game.blueConfirmed : false,
                    redConfirmed: game ? game.redConfirmed : false,
                    closedAt: game ? game.closedAt : undefined,
                });
            }
        }
        return results;
    }
);
