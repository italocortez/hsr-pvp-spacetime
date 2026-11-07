// ─── Post-Draft Reducers ──────────────────────────────────────────────────────
// Four reducers for the Equipping stage and stage advancement.
// Per D-56/D-57/D-58/D-59.

import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { ensureLobbyMember, ensureStageIs, ensureHostOrAbove, slotTeam, slotIsCoach, slotIsSpectator, slotToTeamSide } from '../helpers/lobbyHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureMatchAlive } from '../helpers/disconnectHelpers';
import { readAbuseConfig } from '../helpers/abuseControls';
import { getNextSequence } from '../helpers/stepSequence';
import {
    ensureCaptainOrReferee,
    ensureTeamTag,
    findLineup,
    lineupCosts,
    recomputeGame,
    refreshLineupCosts,
    teamDraft,
    teamSideValue,
} from '../helpers/scoringHelpers';
import { TeamSide } from '../types/enums';
import { fromHundredths, lineupError, toHundredths, type LineupFormatTag } from '@shared/scoring';

// ─── equip_lightcone ─────────────────────────────────────────────────────────
// Records LC equip as a backend step. Deducts LC cost from team's LC budget.
// Per D-55: LCs not exclusive, duplicates allowed. Strict budget enforcement.
// Per D-56: Recorded as backend step for match replay.
// CH-S6 / D.8.7: the superimposition argument stands even under requireOwnership; light cones have no
// ownership data yet, so there is nothing to resolve it from. Once they do, resolve it like the pick eidolon.

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
        // A21 / backlog #3 (Auction): a confirmed lineup's synergy surcharge is reserved out of the LC budget, so
        // confirming first and then spending everything on light cones cannot defeat confirm_lineup's gate.
        const side = isBlue ? 'Blue' : 'Red';
        const lineup = findLineup(ctx, lobbyId, session.currentGameNumber, side);
        if (lobby.draftMode.tag === 'Auction' && lineup?.isConfirmed
            && lcCost + fromHundredths(lineup.synergySurcharge) > currentLcBudget) {
            throw new SenderError('Not enough LC budget: the confirmed lineup\'s synergy surcharge is reserved.');
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

        // A21: the side's lineup row (confirmed or not) follows the new light cone: roster cost and surcharge.
        refreshLineupCosts(ctx, lobby, session.currentGameNumber, side, user.id);

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
// (A21, backlog #3): places the team's drafted characters into lineup groups (Lobby.lineupFormat: Halves = 2
// groups of 4, Thirds = 3 groups of 4), every drafted character exactly once. Caller: the captain of that team,
// or a referee for either team (tightens D-56's any non-coach team member). Upserts the one live MatchLineup row
// per team per game with the synergy surcharge and the live roster cost (hundredths) and isConfirmed = false, so
// arranging a confirmed lineup clears its confirmation. A fan-out reducer: throttled per member through
// AbuseConfig.lineupMinIntervalMs (LobbyMember.lastLineupAt, stamped without an audit bump) and bounded in size.
// No step is logged here (ArrangeLineupPayload is a position list; the replay keeps only the ConfirmLineup step).

const MAX_GROUPS_JSON_LENGTH = 2000;

function parseGroups(groups: string): string[][] {
    if (groups.length > MAX_GROUPS_JSON_LENGTH) {
        throw new SenderError('groups is too long.');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(groups);
    } catch {
        throw new SenderError('groups must be a JSON array of arrays of character names.');
    }
    if (!Array.isArray(parsed) || !parsed.every((g) => Array.isArray(g) && g.every((n) => typeof n === 'string'))) {
        throw new SenderError('groups must be a JSON array of arrays of character names.');
    }
    return parsed as string[][];
}

export const arrange_lineup = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        teamSide: TeamSide,
        groups: t.string(),
    },
    (ctx, { lobbyId, teamSide, groups }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const side = ensureTeamTag(teamSide);
        const member = ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'arrange the lineup');
        ensureStageIs(lobby, 'Equipping');
        ensureMatchAlive(ctx, lobby);

        // B-4 throttle (fan-out): reject a move that comes faster than lineupMinIntervalMs.
        const minIntervalMicros = BigInt(readAbuseConfig(ctx).lineupMinIntervalMs) * 1000n;
        const now = ctx.timestamp.microsSinceUnixEpoch;
        if (member.lastLineupAt && now - member.lastLineupAt.microsSinceUnixEpoch < minIntervalMicros) {
            throw new SenderError('Lineup changes are too frequent. Please wait a moment.');
        }

        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) throw new SenderError('Match session not found.');

        const parsed = parseGroups(groups);
        const draft = teamDraft(ctx, lobbyId, session.currentGameNumber, side);
        const problem = lineupError(parsed, draft.characters, lobby.lineupFormat.tag as LineupFormatTag);
        if (problem) throw new SenderError(problem);
        const { surcharge, rosterCost } = lineupCosts(ctx, lobby, draft, parsed);

        const existing = findLineup(ctx, lobbyId, session.currentGameNumber, side);
        if (existing) {
            ctx.db.MatchLineup.id.update(updateWithAudit(ctx, existing, {
                groups: JSON.stringify(parsed),
                synergySurcharge: surcharge,
                rosterCost,
                isConfirmed: false,
            }, user.id));
        } else {
            ctx.db.MatchLineup.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                gameNumber: session.currentGameNumber,
                teamSide: teamSideValue(side),
                groups: JSON.stringify(parsed),
                synergySurcharge: surcharge,
                rosterCost,
                isConfirmed: false,
            }, user.id));
        }

        // Throttle stamp on the private member row: no audit bump (not a user edit, like lastCursorAt).
        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, member.userId]);
        ctx.db.LobbyMember.insert({ ...member, lastLineupAt: ctx.timestamp });
    }
);

// ─── confirm_lineup ───────────────────────────────────────────────────────────
// Same callers as arrange_lineup. Recomputes the surcharge and roster cost from the stored groups, fixes the
// rosterCost on the row (equip_lightcone keeps it current afterwards), sets isConfirmed and logs the ConfirmLineup step with the
// groups for replay (actorSlot = the lineup's team, so a spectator referee's confirmation replays on the right
// side). Auction: rejected while the surcharge exceeds the team's remaining light-cone budget (the surcharge comes
// out of that budget; an over-budget arrangement is allowed while arranging). The budget itself is not debited.

export const confirm_lineup = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        teamSide: TeamSide,
    },
    (ctx, { lobbyId, teamSide }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const side = ensureTeamTag(teamSide);
        ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'confirm the lineup');
        ensureStageIs(lobby, 'Equipping');
        ensureMatchAlive(ctx, lobby);

        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) throw new SenderError('Match session not found.');

        const lineup = findLineup(ctx, lobbyId, session.currentGameNumber, side);
        if (!lineup) throw new SenderError('Arrange the lineup before confirming it.');

        const draft = teamDraft(ctx, lobbyId, session.currentGameNumber, side);
        const parsed: string[][] = JSON.parse(lineup.groups);
        const problem = lineupError(parsed, draft.characters, lobby.lineupFormat.tag as LineupFormatTag);
        if (problem) throw new SenderError(problem);
        const { surcharge, rosterCost } = lineupCosts(ctx, lobby, draft, parsed);

        if (lobby.draftMode.tag === 'Auction') {
            const remainingLc = toHundredths(side === 'Blue' ? session.teamBlueLcBudget : session.teamRedLcBudget);
            if (surcharge > remainingLc) {
                throw new SenderError('The synergy surcharge exceeds the remaining light-cone budget; rearrange the lineup.');
            }
        }

        ctx.db.MatchLineup.id.update(updateWithAudit(ctx, lineup, {
            synergySurcharge: surcharge,
            rosterCost,
            isConfirmed: true,
        }, user.id));

        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            gameNumber: session.currentGameNumber,
            sequence: getNextSequence(ctx, lobbyId),
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: teamSideValue(side),
            action: { tag: 'ConfirmLineup', value: {} } as any,
            payload: {
                tag: 'ConfirmLineup',
                value: { confirmed: true, groups: lineup.groups },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

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
                // Find the MatchResultRecord for this lobby (created by start_draft; game rows by record_group_scores)
                const matchResult = [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];

                let newGamesWonBlue = session.gamesWonBlue;
                let newGamesWonRed = session.gamesWonRed;

                if (matchResult) {
                    // (A21): the current game's winner is server-computed; refresh it from its inputs first.
                    recomputeGame(ctx, matchResult, lobby, session.currentGameNumber, user.id);
                    // Count wins per side from MatchResultGame rows
                    const games = [...ctx.db.MatchResultGame.match_result_id.filter(matchResult.id)];
                    let blueWins = 0;
                    let redWins = 0;
                    for (const game of games) {
                        if (game.winnerTeamSide.tag === 'Blue') blueWins++;
                        else if (game.winnerTeamSide.tag === 'Red') redWins++;
                    }
                    // A27: the lobby's head start (seeded by start_draft) stays on top of the played games.
                    newGamesWonBlue = blueWins + (lobby.bestOfNAdvantage?.tag === 'Blue' ? 1 : 0);
                    newGamesWonRed = redWins + (lobby.bestOfNAdvantage?.tag === 'Red' ? 1 : 0);

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
