// ─── Post-Draft Reducers ──────────────────────────────────────────────────────
// Four reducers for the Equipping stage and stage advancement.
// Per D-56/D-57/D-58/D-59.

import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { ensureLobbyMember, ensureStageIs, ensureHostOrAbove, slotTeam, slotIsCoach, slotIsSpectator, slotToTeamSide } from '../helpers/lobbyHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureMatchAlive } from '../helpers/disconnectHelpers';

// ─── equip_lightcone ─────────────────────────────────────────────────────────
// Records LC equip as a backend step. Deducts LC cost from team's LC budget.
// Per D-55: LCs not exclusive, duplicates allowed. Strict budget enforcement.
// Per D-56: Recorded as backend step for match replay.

export const equip_lightcone = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        characterName: t.string(),
        lightconeName: t.string(),
        superimposition: t.u8(),
    },
    (ctx, { lobbyId, characterName, lightconeName, superimposition }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const member = ensureLobbyMember(ctx, lobbyId, user.id);
        ensureStageIs(lobby, 'Equipping');
        ensureMatchAlive(ctx, lobby);

        // Coach guard (D-39): coaches blocked from all draft/post-draft actions
        if (slotIsCoach(member.lobbySlot)) {
            throw new SenderError('Coaches cannot equip lightcones.');
        }

        // Member must be on Blue or Red team (not spectator)
        if (slotIsSpectator(member.lobbySlot)) {
            throw new SenderError('Spectators cannot equip lightcones.');
        }

        // Read the current match session
        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) throw new SenderError('Match session not found.');

        // Look up LC cost from HsrLightconeCost table (15.4 D-10/D-11/Pitfall 6).
        // (lightconeName, gameMode, draftMode='Classic', costSetId) → SuperimpositionCost → s1..s5 field.
        // LC equip happens in the classic draft context regardless of char-phase draftMode.
        const CLASSIC_DRAFT_MODE = { tag: 'Classic', value: {} } as any;
        const costSetId = lobby.costSetId;
        let lcCost: number = 0;
        // Tuple-filter with enum struct is unsupported (RESEARCH.md A2); fall back to
        // cost_set_id filter + predicate find including draftMode.tag match.
        const tryFind = (csId: number) => {
            const rows = [...ctx.db.HsrLightconeCost.cost_set_id.filter(csId)];
            return rows.find((r: any) =>
                r.lightconeName === lightconeName &&
                r.gameMode.tag === lobby.gameMode.tag &&
                r.draftMode.tag === 'Classic'
            );
        };
        const costSetIdToTry = costSetId !== 0 ? costSetId : 0;
        const costRow = tryFind(costSetIdToTry)
            ?? (costSetId !== 0 ? tryFind(0) : undefined);
        // Reference CLASSIC_DRAFT_MODE for future btree-filter migration if A2 is revisited.
        void CLASSIC_DRAFT_MODE;
        if (costRow && costRow.costs) {
            const sField = `s${superimposition}` as keyof typeof costRow.costs;
            const rawCost = (costRow.costs as Record<string, number>)[sField];
            if (typeof rawCost === 'number') {
                lcCost = rawCost;
            }
        }

        // Per D-55: Strict LC budget enforcement
        const isBlue = slotTeam(member.lobbySlot) === 'Blue';
        const currentLcBudget = isBlue ? session.teamBlueLcBudget : session.teamRedLcBudget;
        if (lcCost > currentLcBudget) {
            throw new SenderError('Not enough LC budget.');
        }

        // Determine next sequence number
        const existingSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
        const nextSequence = existingSteps.length > 0
            ? Math.max(...existingSteps.map((s: any) => s.sequence)) + 1
            : 1;

        // Insert MatchSessionStep
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            gameNumber: session.currentGameNumber,
            sequence: nextSequence,
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'EquipLightcone', value: {} } as any,
            payload: {
                tag: 'EquipLightcone',
                value: { characterName, lightconeName, superimposition, costPaid: lcCost },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // Deduct LC cost from budget
        if (isBlue) {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                teamBlueLcBudget: session.teamBlueLcBudget - lcCost,
            }, user.id));
        } else {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                teamRedLcBudget: session.teamRedLcBudget - lcCost,
            }, user.id));
        }

        // Update lobby lastActivityAt
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));
    }
);

// ─── arrange_lineup ───────────────────────────────────────────────────────────
// Records lineup position order as a backend step for match replay.
// Per D-56.

export const arrange_lineup = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        positions: t.string(),
    },
    (ctx, { lobbyId, positions }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const member = ensureLobbyMember(ctx, lobbyId, user.id);
        ensureStageIs(lobby, 'Equipping');
        ensureMatchAlive(ctx, lobby);

        // Coach guard (D-39)
        if (slotIsCoach(member.lobbySlot)) {
            throw new SenderError('Coaches cannot arrange lineups.');
        }

        // Member must be on Blue or Red team
        if (slotIsSpectator(member.lobbySlot)) {
            throw new SenderError('Spectators cannot arrange lineups.');
        }

        // Load session for gameNumber stamping (WR-04 Phase 15.4: archival integrity).
        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) throw new SenderError('Match session not found.');

        // Validate positions is valid JSON array of strings
        let parsedPositions: string[];
        try {
            parsedPositions = JSON.parse(positions);
            if (!Array.isArray(parsedPositions) || !parsedPositions.every((p: any) => typeof p === 'string')) {
                throw new Error('Not an array of strings');
            }
        } catch {
            throw new SenderError('positions must be a valid JSON array of strings.');
        }

        // Determine next sequence number
        const existingSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
        const nextSequence = existingSteps.length > 0
            ? Math.max(...existingSteps.map((s: any) => s.sequence)) + 1
            : 1;

        // Insert MatchSessionStep
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            gameNumber: session.currentGameNumber,
            sequence: nextSequence,
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'ArrangeLineup', value: {} } as any,
            payload: {
                tag: 'ArrangeLineup',
                value: { positions },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // Update lobby lastActivityAt
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));
    }
);

// ─── confirm_lineup ───────────────────────────────────────────────────────────
// Records lineup confirmation as a backend step.
// Per D-56.

export const confirm_lineup = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const member = ensureLobbyMember(ctx, lobbyId, user.id);
        ensureStageIs(lobby, 'Equipping');
        ensureMatchAlive(ctx, lobby);

        // Coach guard (D-39)
        if (slotIsCoach(member.lobbySlot)) {
            throw new SenderError('Coaches cannot confirm lineups.');
        }

        // Member must be on Blue or Red team
        if (slotIsSpectator(member.lobbySlot)) {
            throw new SenderError('Spectators cannot confirm lineups.');
        }

        // Load session for gameNumber stamping (WR-04 Phase 15.4: archival integrity).
        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) throw new SenderError('Match session not found.');

        // Determine next sequence number
        const existingSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
        const nextSequence = existingSteps.length > 0
            ? Math.max(...existingSteps.map((s: any) => s.sequence)) + 1
            : 1;

        // Insert MatchSessionStep
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            gameNumber: session.currentGameNumber,
            sequence: nextSequence,
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'ConfirmLineup', value: {} } as any,
            payload: {
                tag: 'ConfirmLineup',
                value: { confirmed: true },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // Update lobby lastActivityAt
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));
    }
);

// ─── advance_stage ────────────────────────────────────────────────────────────
// Host manually transitions between lobby sub-phases. Per D-58/D-59.
// Transitions: Drafting → Equipping → Scoring
// Scoring → Finished is handled by finalize_match_result (not this reducer).

export const advance_stage = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        ensureHostOrAbove(ctx, lobby, user);
        ensureMatchAlive(ctx, lobby);

        const currentStage = lobby.stage.tag;

        if (currentStage === 'Drafting') {
            // Transition: Drafting → Equipping
            // Per D-50: Carry over leftover character budget to LC budget
            const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
            if (!session) throw new SenderError('Match session not found.');

            const newBlueLcBudget = session.teamBlueLcBudget + session.teamBlueCharBudget;
            const newRedLcBudget = session.teamRedLcBudget + session.teamRedCharBudget;

            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                teamBlueLcBudget: newBlueLcBudget,
                teamRedLcBudget: newRedLcBudget,
                teamBlueCharBudget: 0,
                teamRedCharBudget: 0,
            }, user.id));

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                stage: { tag: 'Equipping', value: {} } as any,
                lastActivityAt: ctx.timestamp,
            }, user.id));

            // System chat message for stage change (D-11)
            const existingMessages = [...ctx.db.ChatMessage.lobby_id.filter(lobbyId)];
            const nextMsgId = existingMessages.length > 0
                ? Math.max(...existingMessages.map((m: any) => m.id)) + 1
                : 1;

            // Rolling window: delete oldest if > 50
            if (existingMessages.length >= 50) {
                const sorted = [...existingMessages].sort((a: any, b: any) => a.id - b.id);
                ctx.db.ChatMessage.delete(sorted[0]);
            }

            ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
                id: 0, // autoInc
                lobbyId,
                senderUserId: 0,
                senderType: { tag: 'System', value: {} } as any,
                content: 'Draft complete. Stage: Equipping',
                metadata: undefined,
                anonymousLabel: undefined,
            }, user.id));

        } else if (currentStage === 'Equipping') {
            // Transition: Equipping → Scoring
            // Host can force transition (D-58). Check if both teams have confirmed lineup (optional validation).

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                stage: { tag: 'Scoring', value: {} } as any,
                lastActivityAt: ctx.timestamp,
            }, user.id));

            // System chat message for stage change (D-11)
            const existingMessages = [...ctx.db.ChatMessage.lobby_id.filter(lobbyId)];
            if (existingMessages.length >= 50) {
                const sorted = [...existingMessages].sort((a: any, b: any) => a.id - b.id);
                ctx.db.ChatMessage.delete(sorted[0]);
            }

            ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
                id: 0, // autoInc
                lobbyId,
                senderUserId: 0,
                senderType: { tag: 'System', value: {} } as any,
                content: 'Lineups set. Stage: Scoring',
                metadata: undefined,
                anonymousLabel: undefined,
            }, user.id));

        } else if (currentStage === 'Scoring') {
            // D-14: Series-aware Scoring transition.
            // For best-of-N (seriesBestOf > 1): count games won per side from MatchResultGame,
            // update gamesWonBlue/gamesWonRed on MatchSession, then decide next stage.
            // For bestOf=1: go directly to AwaitingResult (unchanged behavior).

            const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
            if (!session) throw new SenderError('Match session not found.');

            if (session.seriesBestOf > 1) {
                // Find the MatchResultRecord for this lobby (created by submit_match_result or record_game_scores flow)
                const matchResult = [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];

                let newGamesWonBlue = session.gamesWonBlue;
                let newGamesWonRed = session.gamesWonRed;

                if (matchResult) {
                    // Count wins per side from MatchResultGame rows
                    const games = [...ctx.db.MatchResultGame.match_result_id.filter(matchResult.id)];
                    let blueWins = 0;
                    let redWins = 0;
                    for (const game of games) {
                        if (game.winnerTeamSide.tag === 'Blue') blueWins++;
                        else if (game.winnerTeamSide.tag === 'Red') redWins++;
                    }
                    newGamesWonBlue = blueWins;
                    newGamesWonRed = redWins;

                    // Persist updated win counts to MatchSession
                    ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
                        gamesWonBlue: newGamesWonBlue,
                        gamesWonRed: newGamesWonRed,
                    }, user.id));
                }

                const winsNeeded = Math.ceil(session.seriesBestOf / 2);
                if (newGamesWonBlue >= winsNeeded || newGamesWonRed >= winsNeeded) {
                    // Series won — go to AwaitingResult for finalization
                    ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                        stage: { tag: 'AwaitingResult', value: {} } as any,
                        lastActivityAt: ctx.timestamp,
                    }, user.id));

                    // System chat message
                    const msgs2 = [...ctx.db.ChatMessage.lobby_id.filter(lobbyId)];
                    if (msgs2.length >= 50) {
                        const sorted2 = [...msgs2].sort((a: any, b: any) => a.id - b.id);
                        ctx.db.ChatMessage.id.delete(sorted2[0].id);
                    }
                    ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
                        id: 0,
                        lobbyId,
                        senderUserId: 0,
                        senderType: { tag: 'System', value: {} } as any,
                        content: `Series complete (${newGamesWonBlue}-${newGamesWonRed}). Stage: AwaitingResult`,
                        metadata: undefined,
                        anonymousLabel: undefined,
                    }, user.id));
                } else {
                    // Series not won — go to BetweenGames
                    ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                        stage: { tag: 'BetweenGames', value: {} } as any,
                        lastActivityAt: ctx.timestamp,
                    }, user.id));

                    // System chat message
                    const msgs3 = [...ctx.db.ChatMessage.lobby_id.filter(lobbyId)];
                    if (msgs3.length >= 50) {
                        const sorted3 = [...msgs3].sort((a: any, b: any) => a.id - b.id);
                        ctx.db.ChatMessage.id.delete(sorted3[0].id);
                    }
                    ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
                        id: 0,
                        lobbyId,
                        senderUserId: 0,
                        senderType: { tag: 'System', value: {} } as any,
                        content: `Game ${session.currentGameNumber} complete (${newGamesWonBlue}-${newGamesWonRed}). Stage: BetweenGames`,
                        metadata: undefined,
                        anonymousLabel: undefined,
                    }, user.id));
                }
            } else {
                // bestOf=1 — direct to AwaitingResult (original behavior)
                ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                    stage: { tag: 'AwaitingResult', value: {} } as any,
                    lastActivityAt: ctx.timestamp,
                }, user.id));

                // System chat message
                const msgs4 = [...ctx.db.ChatMessage.lobby_id.filter(lobbyId)];
                if (msgs4.length >= 50) {
                    const sorted4 = [...msgs4].sort((a: any, b: any) => a.id - b.id);
                    ctx.db.ChatMessage.id.delete(sorted4[0].id);
                }
                ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
                    id: 0,
                    lobbyId,
                    senderUserId: 0,
                    senderType: { tag: 'System', value: {} } as any,
                    content: 'Match complete. Stage: AwaitingResult',
                    metadata: undefined,
                    anonymousLabel: undefined,
                }, user.id));
            }

        } else {
            throw new SenderError(`Cannot advance stage from ${currentStage}.`);
        }
    }
);
