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
import { ensureStageIs, ensureRefereeOrAbove } from '@module/helpers/lobby/lobbyHelpers';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureMatchAlive, ensureNotConceded } from '@module/helpers/lobby/disconnectHelpers';
import { ensureLineupThrottle, stampLineupThrottle } from '@module/helpers/lobby/abuseControls';
import { ensureEditStepRoom, getNextSequence } from '@module/helpers/draft/stepSequence';
import { characterCostAt, lightconeCostAt } from '@module/helpers/draft/costSetGuards';
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
    postSystemChat,
    recomputeGame,
    refreshLineupCosts,
    resetConfirmations,
    teamDraft,
    teamSideValue,
    type TeamTag,
} from '@module/helpers/results/scoringHelpers';
import { recomputeAfterAdminEdit } from '@module/helpers/results/gameClose';
import { auctionEidolonExtra, chargeExtra, charBudgetIsZero, holderFitText, raiseAtZeroText, teamDefaultEidolon } from './draftAuction';
import { finishDraft } from '@module/helpers/draft/draftComplete';
import { TeamSide } from '@module/types/enums';
import { charactersPerTeam, lineupError, type LineupFormatTag } from '@shared/scoring';

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

// B-4 throttle: ensureLineupThrottle / stampLineupThrottle live in helpers/lobby/abuseControls.ts since S10f (the
// result reducers use the per-user result-entry window instead). Draft audit #8: the open-game step writers also call ensureEditStepRoom (stepSequence.ts), counted
// per edited team side (review F1).

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
            ensureEditStepRoom(ctx, lobbyId, side, 'edit');
        }
        ensureInTeamDraft(ctx, lobbyId, side, characterName);
        if (superimposition < 1 || superimposition > 5) throw new SenderError('superimposition must be between 1 and 5.');

        // A101 / A107(1)(5): the light cone's row in the lobby's own cost set, game mode and draft mode (no Classic-only
        // read, no fallback to the default set); a light cone without a row is rejected ("<name> has no cost in this
        // lobby's cost set.").
        const lcCost = lightconeCostAt(ctx, lobby, lightconeName, superimposition);

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
            ensureEditStepRoom(ctx, lobbyId, side, 'edit');
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
// bounded in size. No step is logged here (S11a, L39: the unused ArrangeLineup step kind is removed).
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
// Cost: Classic → costPaid = the lobby's cost row at the new level (A107: no row → rejected), no budget. Auction → the
// difference of the eidolon extras: a positive delta is charged character budget first, then the light-cone budget
// (rejected when it exceeds both). S10u, A133, in Drafting (the confirm window included): rejected when no character
// budget is available (the character budget minus a held bid counts as 0, charBudgetIsZero); a team holding the bid may
// not spill at all (the raise must fit its free character budget); a team not holding it spills only with the charge
// that empties its character budget. So a team dips into the light-cone budget at most once per stretch of the draft
// without an undo that gives character budget back. After the dip a lowering is one-way until Equipping: its refund
// lands in the light-cone budget and a new raise is refused at character budget 0. A negative delta is refunded to the light-cone budget in every stage
// (orchestrator rule, S7b: a refund never restores bidding power, otherwise a team could overdraw its character
// budget more than once, which A61 rules out; the two budgets merge at the D-50 rollover anyway); costPaid = the
// extra at the new level. Logs a SetEidolon step (actorSlot = the team), refreshes the lineup row, then recomputes the
// game and resets both confirmations. A60(7) Admin path on a closed game: no throttle, no reset, game recomputed.

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
            ensureEditStepRoom(ctx, lobbyId, side, 'edit');
            // A22(3): no edit while the draft is paused. Drafting only (S10t review F3: the move to Equipping clears the
            // pause, so the stage test is a guard, not a carried pause); resume_draft looks at the last Pause step.
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
        let charCharged = 0;
        let lcCharged = 0;
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
                const reservedText = 'Not enough budget for that eidolon: your current bid is reserved.';
                if (holdsBid && delta > charBudget + lcBudget - (reservedBid + reservedExtra)) {
                    throw new SenderError(reservedText);
                }
                if (delta > charBudget + lcBudget) throw new SenderError('Not enough budget for that eidolon.');
                const spendableChar = Math.max(0, charBudget - reservedBid);
                // S10u (A133): during the Auction draft (Drafting, the confirm window included) a raise needs character
                // budget available for it: the character budget minus the held bid (the bid is reserved, A61(4)). At 0
                // (within charBudgetIsZero's tolerance, review F3) it is refused. In Equipping and later (holdsBid false,
                // budgets merged by the D-50 roll-over) the pool rule is unchanged.
                // S10u review 2 G3: refused only when the raise would need the light-cone budget (it does not fit what
                // is left), so a raise that fits a budget inside the tolerance is still accepted.
                if (lobby.stage.tag === 'Drafting' && charBudgetIsZero(lobby, spendableChar) && delta > spendableChar) throw new SenderError(raiseAtZeroText);
                // S10u fix pass (A133, review F1): a holder may not spill: its raise must fit the free character budget,
                // so the one dip (a spill that empties the character budget) is never made with budget still reserved.
                if (holdsBid && delta > spendableChar) throw new SenderError(holderFitText);
                // Not holding: the free part first, the rest from the light-cone budget; a spill empties the character budget.
                const fromChar = Math.min(spendableChar, delta);
                // S10u (A133(1)): a held bid of 0 that owes a default extra needs a character budget above 0 at the sale,
                // so the edit may not empty it (with a bid above 0 the character budget stays at least the bid).
                // S10u review 2 G3: consistent with the sale's spill test (resolveSale): refused only when the extra would
                // then need the light-cone budget.
                if (holdsBid && reservedExtra > 0 && charBudgetIsZero(lobby, charBudget - fromChar) && reservedExtra > charBudget - fromChar) throw new SenderError(reservedText);
                // chargeExtra over the spendable part only: it takes fromChar from it, the rest from the LC budget.
                const charged = chargeExtra({ ...session, teamBlueCharBudget: fromChar, teamRedCharBudget: fromChar }, side, delta);
                next = { charBudget: charBudget - fromChar + charged.charBudget, lcBudget: charged.lcBudget };
                // S10u (review 3 F2): the reservation must hold on the stored f32 values, not only before rounding, or the
                // sale's chargeExtra would meet a shortfall of half a unit in the last place.
                if (holdsBid && Math.fround(next.charBudget) + Math.fround(next.lcBudget) < reservedBid + reservedExtra) {
                    throw new SenderError(reservedText);
                }
            } else if (delta < 0) {
                next = { charBudget, lcBudget: lcBudget - delta }; // refund to the light-cone budget (see header)
            }
            if (delta !== 0) {
                charCharged = charBudget - Math.fround(next.charBudget);
                lcCharged = lcBudget - Math.fround(next.lcBudget);
                ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, side === 'Blue'
                    ? { teamBlueCharBudget: next.charBudget, teamBlueLcBudget: next.lcBudget }
                    : { teamRedCharBudget: next.charBudget, teamRedLcBudget: next.lcBudget }, user.id));
            }
        } else {
            costPaid = characterCostAt(ctx, lobby, characterName, eidolon); // A107: the lobby's row; none → rejected
        }

        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId),
            actorUserId: user.id,
            actorSlot: teamSideValue(side),
            action: { tag: 'SetEidolon', value: {} } as any,
            payload: {
                tag: 'SetEidolon',
                // S10t (A132): what this edit charged each budget (stored before minus stored after; 0 in Classic),
                // given back by undo_last_step when it removes the character's pick or sale.
                value: { characterName, eidolon, previousEidolon: current.eidolon, costPaid, charCharged, lcCharged },
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
            // S10t (A129): the normal end of every draft. The last pick or sale leaves the lobby in Drafting with the
            // draft complete; this call (the referee, A80, or a Moderator+) moves it to Equipping with the D-50 roll-over
            // the last step used to make (the S10i review F7 note, "reachable only through engineered state", no longer
            // holds). Until then undo_last_step can take the last step back (A127). A130: the confirm window's expiry
            // makes the same move when nobody advances.
            // Transition: Drafting → Equipping
            // Per D-50: Carry over leftover character budget to LC budget
            const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
            if (!session) throw new SenderError('Match session not found.');

            // A100: no advance out of an unfinished draft. A team holds the characters of its draft (teamDraft: its
            // Pick steps in Classic, the AuctionSold steps it won in Auction; EMPTY counts); both must hold
            // charactersPerTeam. Since S10t (A129) there is no automatic transition: this is the only way out of Drafting.
            const target = charactersPerTeam(lobby.lineupFormat.tag as LineupFormatTag);
            const blueHeld = teamDraft(ctx, lobbyId, 'Blue').characters.length;
            const redHeld = teamDraft(ctx, lobbyId, 'Red').characters.length;
            if (blueHeld < target || redHeld < target) {
                throw new SenderError(
                    `The draft is not finished: Blue holds ${blueHeld} of ${target} characters and Red holds ${redHeld} of ${target}.`,
                );
            }

            // S10t (A130): the shared move (finishDraft, helpers/draft/draftComplete.ts): the D-50 roll-over, stage
            // Equipping, lastActivityAt and the system chat line (D-11; the A122(3) 50-message trim), the same write as the
            // confirm-window expiry. Allowed at any time in the window (an early advance).
            finishDraft(ctx, lobby, session, user.id);

        } else if (currentStage === 'Equipping') {
            // Transition: Equipping → Scoring
            // A60(5) / A80: a referee signal with no gate (lineups, light cones and eidolons stay editable in Scoring).

            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                stage: { tag: 'Scoring', value: {} } as any,
                lastActivityAt: ctx.timestamp,
            }, user.id));

            // System chat message for stage change (D-11); S10r (A122(3)): the shared 50-message trim.
            postSystemChat(ctx, lobbyId, 'Lineups set. Stage: Scoring', user.id);

        } else if (currentStage === 'Scoring') {
            throw new SenderError('Games close through confirm_game or close_game; the stage moves on the close.');
        } else {
            throw new SenderError(`Cannot advance stage from ${currentStage}.`);
        }
    }
);
