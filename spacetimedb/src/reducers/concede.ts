import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { ensureLobbyMember, slotTeam, slotIsCoach, slotIsSpectator } from '../helpers/lobbyHelpers';
import { buildConcedeSummary, isForfeitEligible, isThirdPartyReferee } from '../helpers/disconnectHelpers';
import { runFinalization } from '../helpers/finalizationHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { findLobbyResult } from '../helpers/scoringHelpers';
import { handOffToBracket } from '../helpers/tournamentResults';

// ─── Shared concede helper ──────────────────────────────────────────────────
// Used by concede_match, claim_forfeit, and leave_lobby auto-concede.

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

    // 5. A38(1): a concede is a settled result and advances the bracket through the single writer (decidedBy
    // Concede, the series score so far, A35 Blue = team1, SYSTEM_USER_ID as audit actor, A37). Only a Ready match:
    // one already settled by staff or a DQ stays as it is. No finalization for tournament records (A24(4)).
    handOffToBracket(ctx, settledResult, 'Concede');

    // 6. Transition lobby to AwaitingResult (D-28)
    ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
        stage: { tag: 'AwaitingResult', value: {} } as any,
        lastActivityAt: ctx.timestamp,
    }, triggerUserId));

    // 7. System chat message
    ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
        id: 0,
        lobbyId: lobby.id,
        senderUserId: 0,
        senderType: { tag: 'System', value: {} } as any,
        content: `Match conceded. ${winnerTeamSide} team wins. Reason: ${concedeTrigger.tag}.`,
        metadata: undefined,
        anonymousLabel: undefined,
    }, triggerUserId));

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

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // D-26, D-93: Only active stages (D-10: BetweenGames allows concede — surrenders entire series)
        const activeStages = ['Drafting', 'Equipping', 'Scoring', 'BetweenGames'];
        if (!activeStages.includes(lobby.stage.tag)) {
            throw new SenderError('Concede is only available during Drafting, Equipping, Scoring, or BetweenGames.');
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

        // Determine concedeTrigger (D-70)
        const concedeTrigger = member.isReferee
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

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // Only active stages (D-10: BetweenGames included)
        const activeStages = ['Drafting', 'Equipping', 'Scoring', 'BetweenGames'];
        if (!activeStages.includes(lobby.stage.tag)) {
            throw new SenderError('Forfeit claim is only available during Drafting, Equipping, Scoring, or BetweenGames.');
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
            .filter((m: any) => slotTeam(m.lobbySlot) === targetTeam && !slotIsCoach(m.lobbySlot) && !slotIsSpectator(m.lobbySlot) && !m.isOnline);

        performConcede(ctx, lobby, targetTeam, user.id, concedeTrigger, disconnectedMembers);
    }
);

// ─── defer_match ─────────────────────────────────────────────────────────────
// Shelve match to AwaitingResult for TO/admin resolution.
// Deferred policy only. Per D-18, D-19, D-20, D-63.

export const defer_match = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);
        const member = ensureLobbyMember(ctx, lobbyId, user.id);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // Only active stages (D-10: BetweenGames included)
        const activeStages = ['Drafting', 'Equipping', 'Scoring', 'BetweenGames'];
        if (!activeStages.includes(lobby.stage.tag)) {
            throw new SenderError('Defer is only available during Drafting, Equipping, Scoring, or BetweenGames.');
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

        // Get all disconnected members (any team) for summary
        const disconnectedMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)]
            .filter((m: any) => !m.isOnline && !slotIsCoach(m.lobbySlot) && !slotIsSpectator(m.lobbySlot) && !m.voluntarilyLeft);

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

        // System chat message
        ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId: lobby.id,
            senderUserId: 0,
            senderType: { tag: 'System', value: {} } as any,
            content: 'Match deferred to admin/TO resolution.',
            metadata: undefined,
            anonymousLabel: undefined,
        }, user.id));

        console.log(`[DEFER] Lobby #${lobby.id} deferred to AwaitingResult by userId:${user.id}`);
    }
);
