import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { ensureLobbyMember, slotTeam, slotIsCoach, slotIsSpectator, memberHasLeft, isSeatedPlayer } from '@module/helpers/lobby/lobbyHelpers';
import { buildConcedeSummary, isForfeitEligible, isPastDisconnectThreshold, isThirdPartyReferee } from '@module/helpers/lobby/disconnectHelpers';
import { runFinalization } from '@module/helpers/results/finalizationHelpers';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { findLobbyResult, postSystemChat } from '@module/helpers/results/scoringHelpers';
import { handOffToBracket } from '@module/helpers/tournament/tournamentResults';

/**
 * A92(4): a seated player whose row is away (leftAt) cannot concede, claim a forfeit or defer until they return
 * through join_lobby; an abandoned row (abandonedAt, A68(4)) never can. A98 (S10h): called right after the membership
 * check, so it covers every caller (a referee or coach row included); the A92(4) texts are kept for these three reducers.
 */
function ensureSeatPresent(member: any): void {
    if (member.abandonedAt !== undefined) {
        throw new SenderError('You left this match for another lobby and cannot act on it.');
    }
    if (member.leftAt !== undefined) {
        throw new SenderError('You are away from this match. Return to it first.');
    }
}

// ─── Shared concede helper ──────────────────────────────────────────────────
// Used by concede_match, claim_forfeit and dq_participant's team settlement. A68(3): no reducer concedes
// automatically (leave_lobby's D-31 auto-concede is gone).

export function performConcede(
    ctx: any,
    lobby: any,
    losingTeam: string,       // 'Blue' or 'Red'
    triggerUserId: number,
    concedeTrigger: any,       // ConcedeTrigger enum value
    disconnectedMembers?: any[] // For concedeSummary if available
): void {
    // 1. Determine winner (opposite team)
    const winnerTeamSide = losingTeam === 'Blue' ? 'Red' : 'Blue';

    // 2. Build concedeSummary
    const summary = disconnectedMembers && disconnectedMembers.length > 0
        ? buildConcedeSummary(ctx, lobby, disconnectedMembers, triggerUserId, concedeTrigger.tag)
        : `${losingTeam} team conceded. Trigger: ${concedeTrigger.tag} by userId:${triggerUserId}, stage: ${lobby.stage.tag}`;

    // 4. A54 (S8d): the lobby has one MatchResultRecord (start_draft's Pending one); the concede settles it in place.
    // Every concede path runs from Drafting on (after start_draft), so the record exists.
    const existingResult = findLobbyResult(ctx, lobby.id);
    if (!existingResult) throw new SenderError('No match result for this lobby.');
    ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, existingResult, {
        status: { tag: 'Validated', value: {} } as any,
        winnerTeamSide: { tag: winnerTeamSide, value: {} } as any,
        refereeUserId: triggerUserId,
        matchEndReason: { tag: 'Concede', value: {} } as any,
        concedeTrigger: concedeTrigger,
        concedeSummary: summary,
        concedeAtStage: lobby.stage.tag,
        settledAt: ctx.timestamp, // A24(1): a concede counts as a settled result
    }, triggerUserId));
    const settledResult = ctx.db.MatchResultRecord.id.find(existingResult.id);

    // 5. A38(1), A67(6): a concede settles this game and hands it to the bracket through the single writer, which
    // recomputes the derived tally and decides the match only when a side reaches ceil(bestOf / 2) (decidedBy
    // Concede, colours by the match's mapping, A70(1), SYSTEM_USER_ID as audit actor, A37). Only a Ready match: one already settled by
    // staff or a DQ stays as it is. No finalization for tournament records (A24(4)).
    handOffToBracket(ctx, settledResult, 'Concede');

    // 6. Transition lobby to AwaitingResult (D-28)
    ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
        stage: { tag: 'AwaitingResult', value: {} } as any,
        lastActivityAt: ctx.timestamp,
    }, triggerUserId));

    // 7. System chat message (S10r, A122(3): the shared 50-message trim)
    postSystemChat(ctx, lobby.id, `Match conceded. ${winnerTeamSide} team wins. Reason: ${concedeTrigger.tag}.`, triggerUserId);

    // 8. Auto-finalize for casual non-tournament concedes
    // Tournament concedes park in AwaitingResult (A24(2)); the bracket already advanced in step 5 (A38(1)).
    // Non-tournament concedes finalize immediately — no reason to wait for admin.
    if (!lobby.isTournamentControlled) {
        const freshResult = ctx.db.MatchResultRecord.id.find(settledResult.id);
        if (freshResult) {
            runFinalization(ctx, freshResult, triggerUserId);
        }
    }

    console.log(`[CONCEDE] Lobby #${lobby.id} conceded. Winner: ${winnerTeamSide}. Trigger: ${concedeTrigger.tag} by userId:${triggerUserId}${!lobby.isTournamentControlled ? ' (auto-finalized)' : ''}`);
}

// ─── concede_match ───────────────────────────────────────────────────────────
// Surrender own side. Any policy, Drafting/Equipping/Scoring.
// Per D-26, D-27, D-62.

export const concede_match = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        losingTeamSide: t.u8(), // 0 = derive from caller's lobbySlot (players always pass 0). 1 = Blue, 2 = Red (referee-only — matches winnerTeamId convention)
    },
    (ctx, { lobbyId, losingTeamSide }) => {
        const user = getAuthenticatedUser(ctx);
        const member = ensureLobbyMember(ctx, lobbyId, user.id);
        ensureSeatPresent(member); // A92(4), A98: every caller, the referee path included

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // D-26: Only active stages (A67(1)(6): the concede settles this game; no series-level concede)
        const activeStages = ['Drafting', 'Equipping', 'Scoring'];
        if (!activeStages.includes(lobby.stage.tag)) {
            throw new SenderError('Concede is only available during Drafting, Equipping, or Scoring.');
        }

        // D-81: 3rd party referee exclusive concede (checked BEFORE spectator/coach guards
        // because the 3rd party referee IS on Spectator slot — they must bypass that guard)
        let isCallerExclusiveReferee = false;
        if (lobby.refereeExclusiveConcede) {
            const thirdPartyRef = isThirdPartyReferee(ctx, lobbyId);
            if (thirdPartyRef) {
                if (thirdPartyRef.userId !== user.id) {
                    throw new SenderError('Only the referee can concede when referee exclusive concede is active.');
                }
                isCallerExclusiveReferee = true;
            }
        }

        // Not spectator, not coach (D-26) — skipped for 3rd party referee (D-81)
        if (!isCallerExclusiveReferee) {
            if (slotIsSpectator(member.lobbySlot)) {
                throw new SenderError('Spectators cannot concede.');
            }
            if (slotIsCoach(member.lobbySlot)) {
                throw new SenderError('Coaches cannot concede.');
            }
        }

        // Determine losing team: referee specifies via losingTeamSide, players derive from slot
        // Determine losing team: referee specifies via losingTeamSide, players derive from slot
        let losingTeam: 'Blue' | 'Red' | null;
        if (isCallerExclusiveReferee) {
            if (losingTeamSide === 1) losingTeam = 'Blue';
            else if (losingTeamSide === 2) losingTeam = 'Red';
            else throw new SenderError('Referee must specify losingTeamSide: 1=Blue, 2=Red.');
        } else {
            // Players must pass 0 — reject attempts to concede the opposing team
            if (losingTeamSide !== 0) {
                throw new SenderError('Players must pass losingTeamSide=0 (derived from your team slot).');
            }
            losingTeam = slotTeam(member.lobbySlot) as 'Blue' | 'Red' | null;
        }
        if (!losingTeam) {
            throw new SenderError('Cannot determine team for concede.');
        }

        // Determine concedeTrigger (D-70). S10r (A122(15), L52): a referee seated on a team who concedes that team
        // surrenders (VoluntaryLeave). A seated caller always concedes their own team (losingTeamSide = 0), so
        // RefereeDecision is left to the exclusive (Spectator) referee, who names the losing team.
        const ownsLosingTeam = slotTeam(member.lobbySlot) === losingTeam;
        const concedeTrigger = member.isReferee && !ownsLosingTeam
            ? { tag: 'RefereeDecision', value: {} }
            : { tag: 'VoluntaryLeave', value: {} };

        performConcede(ctx, lobby, losingTeam, user.id, concedeTrigger);
    }
);

// ─── claim_forfeit ───────────────────────────────────────────────────────────
// Claim forfeit when all opposing team players are offline > grace period.
// Standard policy only. Per D-15, D-16, D-61.

export const claim_forfeit = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        forfeitingTeamSide: t.u8(), // F7: 0 = the team opposing the caller's slot; 1 = Blue, 2 = Red (required for the exclusive referee)
    },
    (ctx, { lobbyId, forfeitingTeamSide }) => {
        const user = getAuthenticatedUser(ctx);
        const member = ensureLobbyMember(ctx, lobbyId, user.id);
        ensureSeatPresent(member); // A92(4), A98: every caller, the referee path included

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // Only active stages (A67(1))
        const activeStages = ['Drafting', 'Equipping', 'Scoring'];
        if (!activeStages.includes(lobby.stage.tag)) {
            throw new SenderError('Forfeit claim is only available during Drafting, Equipping, or Scoring.');
        }

        // D-81: 3rd party referee exclusive concede (before spectator/coach guards)
        let isCallerExclusiveReferee = false;
        if (lobby.refereeExclusiveConcede) {
            const thirdPartyRef = isThirdPartyReferee(ctx, lobbyId);
            if (thirdPartyRef) {
                if (thirdPartyRef.userId !== user.id) {
                    throw new SenderError('Only the referee can claim forfeit when referee exclusive concede is active.');
                }
                isCallerExclusiveReferee = true;
            }
        }

        // Not spectator, not coach — skipped for 3rd party referee (D-81)
        if (!isCallerExclusiveReferee) {
            if (slotIsSpectator(member.lobbySlot)) {
                throw new SenderError('Spectators cannot claim forfeit.');
            }
            if (slotIsCoach(member.lobbySlot)) {
                throw new SenderError('Coaches cannot claim forfeit.');
            }
        }

        // D-15: Standard policy only
        if (lobby.disconnectPolicy.tag !== 'Standard') {
            throw new SenderError('Forfeit claim is only available under Standard disconnect policy.');
        }

        // F7: the forfeiting team. The exclusive referee holds the Spectator slot and has no team to derive
        // from, so they must name it (1 = Blue, 2 = Red); 0 derives the team opposing the caller's own slot.
        // isForfeitEligible below stays the gate whichever way the team was named.
        let targetTeam: 'Blue' | 'Red';
        if (forfeitingTeamSide === 1) {
            targetTeam = 'Blue';
        } else if (forfeitingTeamSide === 2) {
            targetTeam = 'Red';
        } else if (forfeitingTeamSide === 0) {
            if (isCallerExclusiveReferee) {
                throw new SenderError('Referee must specify forfeitingTeamSide: 1=Blue, 2=Red.');
            }
            const callerTeam = slotTeam(member.lobbySlot);
            if (!callerTeam) {
                throw new SenderError('Cannot determine team for forfeit claim.');
            }
            targetTeam = callerTeam === 'Blue' ? 'Red' : 'Blue';
        } else {
            throw new SenderError('forfeitingTeamSide must be 0 (derive), 1 (Blue) or 2 (Red).');
        }

        // D-16: Check forfeit eligibility — all opposing team players offline > grace
        if (!isForfeitEligible(ctx, lobby, targetTeam, ctx.timestamp)) {
            throw new SenderError('Opposing team is not eligible for forfeit. At least one player is still connected or grace period has not expired.');
        }

        // Determine concedeTrigger
        const concedeTrigger = member.isReferee
            ? { tag: 'RefereeDecision', value: {} }
            : { tag: 'Disconnect', value: {} };

        // Get disconnected members for summary
        const disconnectedMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)]
            .filter((m: any) => slotTeam(m.lobbySlot) === targetTeam && !slotIsCoach(m.lobbySlot) && !slotIsSpectator(m.lobbySlot) && (!m.isOnline || memberHasLeft(m)));

        performConcede(ctx, lobby, targetTeam, user.id, concedeTrigger, disconnectedMembers);
    }
);

// ─── defer_match ─────────────────────────────────────────────────────────────
// Defer the match to AwaitingResult for TO / admin resolution (Deferred, A22a).
// Deferred policy only. Per D-18, D-19, D-20, D-63; A91(1): needs a seated player disconnected past the grace or the
// live pool (the exclusive spectator referee is exempt); A92(4) / A98: an away or abandoned caller is rejected.

export const defer_match = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);
        const member = ensureLobbyMember(ctx, lobbyId, user.id);
        ensureSeatPresent(member); // A92(4), A98: every caller, the referee path included

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // Only active stages (A67(1))
        const activeStages = ['Drafting', 'Equipping', 'Scoring'];
        if (!activeStages.includes(lobby.stage.tag)) {
            throw new SenderError('Defer is only available during Drafting, Equipping, or Scoring.');
        }

        // D-81: 3rd party referee exclusive concede (before spectator/coach guards)
        let isCallerExclusiveReferee = false;
        if (lobby.refereeExclusiveConcede) {
            const thirdPartyRef = isThirdPartyReferee(ctx, lobbyId);
            if (thirdPartyRef) {
                if (thirdPartyRef.userId !== user.id) {
                    throw new SenderError('Only the referee can defer when referee exclusive concede is active.');
                }
                isCallerExclusiveReferee = true;
            }
        }

        // Not spectator, not coach — skipped for 3rd party referee (D-81)
        if (!isCallerExclusiveReferee) {
            if (slotIsSpectator(member.lobbySlot)) {
                throw new SenderError('Spectators cannot defer a match.');
            }
            if (slotIsCoach(member.lobbySlot)) {
                throw new SenderError('Coaches cannot defer a match.');
            }
        }

        // D-18: Deferred policy only
        if (lobby.disconnectPolicy.tag !== 'Deferred') {
            throw new SenderError('Defer is only available under Deferred disconnect policy.');
        }

        // A91(1): at least one seated player (not a coach) of either team is offline, away or abandoned and past the
        // forfeit grace or the live pool (A92(6)). The exclusive spectator referee (D-81) defers without it.
        if (!isCallerExclusiveReferee) {
            const anyPastThreshold = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)].some(
                (m: any) => isSeatedPlayer(m) && isPastDisconnectThreshold(lobby, m, ctx.timestamp),
            );
            if (!anyPastThreshold) {
                throw new SenderError('Defer needs a seated player who has been disconnected past the forfeit grace or whose disconnect pool is spent.');
            }
        }

        // Get all disconnected members (any team) for summary. A68(3): away / abandoned rows are offline players too.
        const disconnectedMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)]
            .filter((m: any) => (!m.isOnline || memberHasLeft(m)) && !slotIsCoach(m.lobbySlot) && !slotIsSpectator(m.lobbySlot));

        // Build concedeSummary (D-21)
        const summary = buildConcedeSummary(ctx, lobby, disconnectedMembers, user.id, 'DeferMatch');

        // A54 (S8d): the lobby's one record (start_draft's Pending record) stays Pending with NO winner (deferred,
        // D-22); the defer records its summary and stage on it. Defer runs from Drafting on, so the record exists.
        const pendingResult = findLobbyResult(ctx, lobby.id);
        if (!pendingResult) throw new SenderError('No match result for this lobby.');
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, pendingResult, {
            concedeSummary: summary,
            concedeAtStage: lobby.stage.tag,
        }, user.id));

        // Transition lobby to AwaitingResult (D-22)
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            stage: { tag: 'AwaitingResult', value: {} } as any,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        // System chat message (S10r, A122(3): the shared 50-message trim)
        postSystemChat(ctx, lobby.id, 'Match deferred to admin/TO resolution.', user.id);

        console.log(`[DEFER] Lobby #${lobby.id} deferred to AwaitingResult by userId:${user.id}`);
    }
);
