// ─── Post-Draft Reducers ──────────────────────────────────────────────────────
// The game-package edits (A60, S7b) and stage advancement.
// Per D-56/D-57/D-58/D-59, amended by A60: light cones and lineups are editable in Equipping and Scoring, eidolons
// from Drafting (once the character is drafted) through Scoring, while the lobby's game is open. Every open-game
// edit recomputes the game and resets both captains' confirmations; an Admin may still edit the closed game while the
// record is Pending or Submitted (A60(7): no stage check, no throttle, no reset, game recomputed). A67(3): one game
// per lobby, so the edits take no game number.

import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { ensureStageIs, ensureRefereeOrAbove, slotToTeamSide } from '@module/helpers/lobby/lobbyHelpers';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureMatchAlive, ensureNotConceded } from '@module/helpers/lobby/disconnectHelpers';
import { readAbuseConfig } from '@module/helpers/lobby/abuseControls';
import { getNextSequence } from '@module/helpers/draft/stepSequence';
import { teamOwnedEidolons } from '@module/helpers/draft/ownershipValidation';
import {
    ensureCaptainOrReferee,
    ensureEditableRecord,
    ensureOpenGame,
    ensureTeamTag,
    equippedLightcones,
    findGame,
    findLineup,
    findLobbyResult,
    isAdminRole,
    isClosedGame,
    lineupCosts,
    recomputeGame,
    refreshLineupCosts,
    resetConfirmations,
    teamDraft,
    teamSideValue,
    type TeamTag,
} from '@module/helpers/results/scoringHelpers';
import { recomputeAfterAdminEdit } from '@module/helpers/results/gameClose';
import { auctionEidolonExtra, chargeExtra, teamDefaultEidolon } from './draftAuction';
import { TeamSide } from '@module/types/enums';
import { lineupError, type LineupFormatTag } from '@shared/scoring';

// ─── Edit window (A60(3)/(7), A67(3)) ─────────────────────────────────────────
// 'admin': the record's game is closed and the caller is an Admin (ensureOpenGame rejects everyone else; the record
// must be Pending or Submitted, i.e. not yet validated, A69(2)); only the liveness guard for result reducers applies (the lobby
// may be AwaitingResult). 'open': the stage must be one of `stages`, the match alive, the record Pending and the game
// not closed; otherwise ensureEditableRecord's A69(2) messages. A67(3): the lobby's one game; the session budgets are that game's.

interface EditWindow { mode: 'open' | 'admin'; session: any; record: any }

function resolveEditWindow(ctx: any, lobby: any, user: any, stages: string[]): EditWindow {
    const session = ctx.db.MatchSession.lobbyId.find(lobby.id);
    const found = findLobbyResult(ctx, lobby.id); // A54: the lobby's one record
    const record = found && (found.status.tag === 'Pending' || (isAdminRole(user) && found.status.tag === 'Submitted'))
        ? found : undefined;
    if (session && record && isClosedGame(findGame(ctx, record.id))) {
        ensureOpenGame(ctx, lobby, record, user); // throws unless the caller is an Admin
        ensureNotConceded(ctx, lobby);
        return { mode: 'admin', session, record };
    }
    ensureStageIs(lobby, ...stages);
    ensureMatchAlive(ctx, lobby);
    if (!session) throw new SenderError('Match session not found.');
    // A69(2): the status rule of findEditableResult (no record / Submitted for a non-Admin / past validation).
    const editable = ensureEditableRecord(found, user);
    const mode = ensureOpenGame(ctx, lobby, editable, user);
    return { mode, session, record: editable };
}

/** A60(2)/(7): after an edit: open → recompute the game (if its row exists) and reset both confirmations; admin → recomputeAfterAdminEdit. */
function afterEdit(ctx: any, lobby: any, window: EditWindow, actorId: number): void {
    if (window.mode === 'admin') {
        recomputeAfterAdminEdit(ctx, lobby, window.record, actorId);
        return;
    }
    if (!findGame(ctx, window.record.id)) return;
    recomputeGame(ctx, window.record, lobby, actorId);
    resetConfirmations(ctx, findGame(ctx, window.record.id), actorId);
}

/** B-4 throttle (fan-out): reject a move that comes faster than AbuseConfig.lineupMinIntervalMs. */
function ensureLineupThrottle(ctx: any, member: any): void {
    const minIntervalMicros = BigInt(readAbuseConfig(ctx).lineupMinIntervalMs) * 1000n;
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (member.lastLineupAt && now - member.lastLineupAt.microsSinceUnixEpoch < minIntervalMicros) {
        throw new SenderError('Lineup changes are too frequent. Please wait a moment.');
    }
}

/** Throttle stamp on the private member row: no audit bump (not a user edit, like lastCursorAt). */
function stampLineupThrottle(ctx: any, lobbyId: number, member: any): void {
    ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, member.userId]);
    ctx.db.LobbyMember.insert({ ...member, lastLineupAt: ctx.timestamp });
}

// ─── equip_lightcone ─────────────────────────────────────────────────────────
// Records LC equip as a backend step. Deducts LC cost from team's LC budget.
// Per D-55: LCs not exclusive, duplicates allowed. Strict budget enforcement.
// Per D-56: Recorded as backend step for match replay.
// A60(1): Equipping or Scoring, open game only; recomputes the game and resets both confirmations. The S7
// surcharge reservation is gone: the Auction surcharge gate sits at confirm_game / close_game (A60(4)).
// A78: caller = the captain of `teamSide` or any lobby referee (ensureCaptainOrReferee), throttled per member like
// arrange_lineup / set_eidolon (AbuseConfig.lineupMinIntervalMs); the character must be in that team's draft of the
// game. A60(7) Admin path (closed game): the given side, same draft check, no throttle, no reset.
// CH-S6 / D.8.7: the superimposition argument stands even under requireOwnership; light cones have no
// ownership data yet, so there is nothing to resolve it from. Once they do, resolve it like the pick eidolon.

/** A78: the character must be in the `side` team's draft of the game (open and Admin paths alike). */
function ensureInTeamDraft(ctx: any, lobbyId: number, side: TeamTag, characterName: string): void {
    if (!teamDraft(ctx, lobbyId, side).characters.includes(characterName)) {
        throw new SenderError(`${characterName} is not in the ${side} team's draft of this game.`);
    }
}

export const equip_lightcone = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        teamSide: TeamSide,
        characterName: t.string(),
        lightconeName: t.string(),
        superimposition: t.u8(),
    },
    (ctx, { lobbyId, teamSide, characterName, lightconeName, superimposition }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const side = ensureTeamTag(teamSide);
        let member = isAdminRole(user) ? undefined : ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'equip lightcones');
        const window = resolveEditWindow(ctx, lobby, user, ['Equipping', 'Scoring']);
        const session = window.session;

        if (window.mode === 'open') {
            member ??= ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'equip lightcones');
            ensureLineupThrottle(ctx, member);
        }
        ensureInTeamDraft(ctx, lobbyId, side, characterName);

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
        const isBlue = side === 'Blue';
        const currentLcBudget = isBlue ? session.teamBlueLcBudget : session.teamRedLcBudget;
        if (lcCost > currentLcBudget) {
            throw new SenderError('Not enough LC budget.');
        }

        // Insert MatchSessionStep (sequence: the lobby-wide counter)
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId),
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: teamSideValue(side),
            action: { tag: 'EquipLightcone', value: {} } as any,
            payload: {
                tag: 'EquipLightcone',
                value: { characterName, lightconeName, superimposition, costPaid: lcCost },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        // A21: the side's lineup row follows the new light cone: roster cost and surcharge.
        refreshLineupCosts(ctx, lobby, side, user.id);

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

        // A60(2)/(7): recompute the game, reset confirmations (open) or recomputeAfterAdminEdit (admin).
        afterEdit(ctx, lobby, window, user.id);

        if (window.mode === 'open') stampLineupThrottle(ctx, lobbyId, member);

        // Update lobby lastActivityAt
        ctx.db.Lobby.id.update(updateWithAudit(ctx, ctx.db.Lobby.id.find(lobbyId)!, {
            lastActivityAt: ctx.timestamp,
        }, user.id));
    }
);

// ─── unequip_lightcone ───────────────────────────────────────────────────────
// S7b hand-off (S8d): removes the latest light cone still equipped on `characterName` for the side (the inverse of one
// equip_lightcone). Same callers (A78: the captain of `teamSide` or a referee), throttle and window as equip_lightcone. Refunds that light cone's
// costPaid to the side's light-cone budget, logs an UnequipLightcone step { characterName,
// lightconeName, refunded }, refreshes the lineup costs, then recomputes the game and resets both confirmations
// (A60(2)); teamDraft drops the unequipped light cone from lightconeCosts.

export const unequip_lightcone = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        teamSide: TeamSide,
        characterName: t.string(),
    },
    (ctx, { lobbyId, teamSide, characterName }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const side = ensureTeamTag(teamSide);
        let member = isAdminRole(user) ? undefined : ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'unequip lightcones');
        const window = resolveEditWindow(ctx, lobby, user, ['Equipping', 'Scoring']);
        const session = window.session;

        if (window.mode === 'open') {
            member ??= ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'unequip lightcones');
            ensureLineupThrottle(ctx, member);
        }
        ensureInTeamDraft(ctx, lobbyId, side, characterName);

        const equipped = equippedLightcones(ctx, lobbyId, side)
            .filter((e) => e.characterName === characterName);
        const latest = equipped[equipped.length - 1];
        if (!latest) throw new SenderError(`${characterName} has no light cone equipped.`);

        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId),
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: teamSideValue(side),
            action: { tag: 'UnequipLightcone', value: {} } as any,
            payload: {
                tag: 'UnequipLightcone',
                value: { characterName, lightconeName: latest.lightconeName, refunded: latest.costPaid },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        refreshLineupCosts(ctx, lobby, side, user.id);

        // Refund to the light-cone budget
        if (latest.costPaid !== 0) {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, side === 'Blue'
                ? { teamBlueLcBudget: session.teamBlueLcBudget + latest.costPaid }
                : { teamRedLcBudget: session.teamRedLcBudget + latest.costPaid }, user.id));
        }

        afterEdit(ctx, lobby, window, user.id);

        if (window.mode === 'open') stampLineupThrottle(ctx, lobbyId, member);
        ctx.db.Lobby.id.update(updateWithAudit(ctx, ctx.db.Lobby.id.find(lobbyId)!, {
            lastActivityAt: ctx.timestamp,
        }, user.id));
    }
);

// ─── arrange_lineup ───────────────────────────────────────────────────────────
// (A21, backlog #3): places the team's drafted characters into lineup groups (Lobby.lineupFormat: Halves = 2
// groups of 4, Thirds = 3 groups of 4), every drafted character exactly once. Caller: the captain of that team,
// or a referee for either team (tightens D-56's any non-coach team member). Upserts the one live MatchLineup row
// per team per game with the synergy surcharge and the live roster cost (hundredths). A fan-out reducer: throttled
// per member through AbuseConfig.lineupMinIntervalMs (LobbyMember.lastLineupAt, stamped without an audit bump) and
// bounded in size. No step is logged here (ArrangeLineupPayload is a position list).
// A60: Equipping or Scoring, open game only; recomputes the game and resets both confirmations (there is no lineup
// confirmation any more: confirm_lineup was removed). A60(7) Admin path on a closed game: no throttle, no reset.

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
        let member = isAdminRole(user) ? undefined : ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'arrange the lineup');
        const window = resolveEditWindow(ctx, lobby, user, ['Equipping', 'Scoring']);

        if (window.mode === 'open') {
            member ??= ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'arrange the lineup');
            ensureLineupThrottle(ctx, member);
        }

        const parsed = parseGroups(groups);
        const draft = teamDraft(ctx, lobbyId, side);
        const problem = lineupError(parsed, draft.characters, lobby.lineupFormat.tag as LineupFormatTag);
        if (problem) throw new SenderError(problem);
        const { surcharge, rosterCost } = lineupCosts(ctx, lobby, draft, parsed);

        const existing = findLineup(ctx, lobbyId, side);
        if (existing) {
            ctx.db.MatchLineup.id.update(updateWithAudit(ctx, existing, {
                groups: JSON.stringify(parsed),
                synergySurcharge: surcharge,
                rosterCost,
            }, user.id));
        } else {
            ctx.db.MatchLineup.insert(insertWithAudit(ctx, {
                id: 0,
                lobbyId,
                teamSide: teamSideValue(side),
                groups: JSON.stringify(parsed),
                synergySurcharge: surcharge,
                rosterCost,
            }, user.id));
        }

        // A60(2)/(7): recompute the game, reset confirmations (open) or recomputeAfterAdminEdit (admin).
        afterEdit(ctx, lobby, window, user.id);

        if (window.mode === 'open') stampLineupThrottle(ctx, lobbyId, member);
    }
);

// ─── set_eidolon ──────────────────────────────────────────────────────────────
// A60(1), A61(6): changes the eidolon of a character in the team's draft of the current game (Classic: picked by
// that side; Auction: sold to that side; EMPTY rejected). Stages Drafting, Equipping, Scoring, open game only.
// Caller (A78): the captain of that team or any lobby referee (seated or not, naming the team through teamSide), the
// arrange_lineup rule (ensureCaptainOrReferee); throttled like arrange_lineup (AbuseConfig.lineupMinIntervalMs).
// Level: 0..6; under requireOwnership only a level the team owns on its selected accounts (teamOwnedEidolons).
// Cost: Classic → costPaid = the Classic cost row at the new level (0 without a row), no budget. Auction → the
// difference of the eidolon extras: a positive delta is charged character budget first, then the light-cone budget
// (rejected when it exceeds both); a negative delta is refunded to the light-cone budget in every stage
// (orchestrator rule, S7b: a refund never restores bidding power, otherwise a team could overdraw its character
// budget more than once, which A61 rules out; the two budgets merge at the D-50 rollover anyway); costPaid = the
// extra at the new level. Logs a SetEidolon step (actorSlot = the team), refreshes the lineup row, then recomputes the
// game and resets both confirmations. A60(7) Admin path on a closed game: no throttle, no reset, game recomputed.

function classicCostAt(ctx: any, lobby: any, characterName: string, eidolon: number): number {
    const costRow = [...ctx.db.HsrCharacterCost.cost_set_id.filter(lobby.costSetId)].find(
        (r: any) =>
            r.characterName === characterName &&
            r.gameMode.tag === lobby.gameMode.tag &&
            r.draftMode.tag === 'Classic'
    );
    return costRow ? (costRow.costs[`e${eidolon}`] ?? 0) : 0;
}

export const set_eidolon = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        teamSide: TeamSide,
        characterName: t.string(),
        eidolon: t.u8(),
    },
    (ctx, { lobbyId, teamSide, characterName, eidolon }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const side = ensureTeamTag(teamSide);
        let member = isAdminRole(user) ? undefined : ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'set an eidolon for that team');
        const window = resolveEditWindow(ctx, lobby, user, ['Drafting', 'Equipping', 'Scoring']);
        const session = window.session;

        if (window.mode === 'open') {
            member ??= ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'set an eidolon for that team');
            ensureLineupThrottle(ctx, member);
            // A22(3): no edit while the draft is paused. Drafting only (Equipping may carry isPaused across
            // advance_stage); client_connected's auto-resume looks at the last step for an auto-pause, so a SetEidolon
            // step logged during a pause would block it.
            if (lobby.stage.tag === 'Drafting' && session.timerState.isPaused) throw new SenderError('Draft is paused.');
        }

        if (eidolon > 6) throw new SenderError('eidolon must be between 0 and 6.');
        if (characterName === 'EMPTY') throw new SenderError('EMPTY has no eidolon.');

        const current = teamDraft(ctx, lobbyId, side).eidolons.find((e) => e.name === characterName);
        if (!current) throw new SenderError(`${characterName} is not in the ${side} team's draft of this game.`);
        if (current.eidolon === eidolon) throw new SenderError(`${characterName} is already at E${eidolon}.`);

        if (lobby.requireOwnership && !teamOwnedEidolons(ctx, lobbyId, side, characterName).includes(eidolon)) {
            throw new SenderError('Your team does not own that eidolon level on its selected accounts.');
        }

        let costPaid: number;
        if (lobby.draftMode.tag === 'Auction') {
            costPaid = auctionEidolonExtra(ctx, lobby, characterName, eidolon);
            const delta = costPaid - auctionEidolonExtra(ctx, lobby, characterName, current.eidolon);
            const charBudget = side === 'Blue' ? session.teamBlueCharBudget : session.teamRedCharBudget;
            const lcBudget = side === 'Blue' ? session.teamBlueLcBudget : session.teamRedLcBudget;
            let next = { charBudget, lcBudget };
            // A61(4)/(5): while the team holds the current bid in Drafting, its commitment (the bid plus the extra it
            // would owe at the sale at its default, lowest owned eidolon, A64) is reserved: the edit may not spend it, and the character budget never drops
            // below the committed bid (the sale takes the bid from it).
            const holdsBid = lobby.stage.tag === 'Drafting' && !!session.currentNomination && session.currentBidTeam?.tag === side;
            const reservedBid = holdsBid ? (session.currentBidAmount ?? 0) : 0;
            const reservedExtra = holdsBid
                ? auctionEidolonExtra(ctx, lobby, session.currentNomination, teamDefaultEidolon(ctx, lobby, side, session.currentNomination))
                : 0;
            if (delta > 0) {
                if (holdsBid && delta > charBudget + lcBudget - (reservedBid + reservedExtra)) {
                    throw new SenderError('Not enough budget for that eidolon: your current bid is reserved.');
                }
                if (delta > charBudget + lcBudget) throw new SenderError('Not enough budget for that eidolon.');
                const spendableChar = Math.max(0, charBudget - reservedBid);
                const fromChar = Math.min(spendableChar, delta);
                // chargeExtra over the spendable part only: it takes fromChar from it, the rest from the LC budget.
                const charged = chargeExtra({ ...session, teamBlueCharBudget: fromChar, teamRedCharBudget: fromChar }, side, delta);
                next = { charBudget: charBudget - fromChar + charged.charBudget, lcBudget: charged.lcBudget };
            } else if (delta < 0) {
                next = { charBudget, lcBudget: lcBudget - delta }; // refund to the light-cone budget (see header)
            }
            if (delta !== 0) {
                ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, side === 'Blue'
                    ? { teamBlueCharBudget: next.charBudget, teamBlueLcBudget: next.lcBudget }
                    : { teamRedCharBudget: next.charBudget, teamRedLcBudget: next.lcBudget }, user.id));
            }
        } else {
            costPaid = classicCostAt(ctx, lobby, characterName, eidolon);
        }

        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId),
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: teamSideValue(side),
            action: { tag: 'SetEidolon', value: {} } as any,
            payload: {
                tag: 'SetEidolon',
                value: { characterName, eidolon, previousEidolon: current.eidolon, costPaid },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));

        refreshLineupCosts(ctx, lobby, side, user.id);
        afterEdit(ctx, lobby, window, user.id);

        if (window.mode === 'open') stampLineupThrottle(ctx, lobbyId, member);
        ctx.db.Lobby.id.update(updateWithAudit(ctx, ctx.db.Lobby.id.find(lobbyId)!, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[MATCH] set_eidolon: ${side} ${characterName} E${current.eidolon} → E${eidolon} (cost ${costPaid}) in lobby #${lobbyId} by user #${user.id}${window.mode === 'admin' ? ' (admin, closed game)' : ''}`);
    }
);

// ─── advance_stage ────────────────────────────────────────────────────────────
// The referee (A80; or a Moderator+) manually transitions between lobby sub-phases. Per D-58/D-59, amended by
// A60(5)/(8) and A80. Transitions: Drafting → Equipping (D-50 rollover) → Scoring (a referee signal with no gate).
// A60: there is no Scoring branch any more: a game closes through close_game, and the close submits the game and
// moves the lobby to AwaitingResult (A67(3)).

export const advance_stage = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        ensureRefereeOrAbove(ctx, lobby, user);
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
            // A60(5) / A80: a referee signal with no gate (lineups, light cones and eidolons stay editable in Scoring).

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
            throw new SenderError('Games close through confirm_game or close_game; the stage moves on the close.');
        } else {
            throw new SenderError(`Cannot advance stage from ${currentStage}.`);
        }
    }
);
