import { SenderError } from 'spacetimedb/server';

/**
 * Next MatchSessionStep.sequence for a lobby: max existing sequence + 1, 0 for the first step.
 * F9: every step writer uses this (picks, bans, auction steps, manual and auto Pause, the Undo
 * record), so sequences never collide and MatchSessionStepHistory's logical key
 * [matchHistoryId, sequence] stays unique (A67(3): one game per lobby). Classic turn progress is
 * `MatchSession.turnIndex`, which is not a sequence number.
 */
export function getNextSequence(ctx: any, lobbyId: number): number {
    const steps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
    if (steps.length === 0) return 0;
    return Math.max(...steps.map((s: any) => s.sequence)) + 1;
}

/**
 * Draft audit #8 (S10f, per side since review F1): the cap on game-package edit and confirmation steps, counted per team
 * side so one team can only exhaust its own allowance. Two counters per side, each MAX_EDIT_STEPS_PER_LOBBY:
 * - 'edit': SetEidolon, EquipLightcone, UnequipLightcone steps whose actorSlot (the edited team) is `side`, whoever the
 *   caller was (captain or referee);
 * - 'confirm': ConfirmGame steps whose payload confirmedSide is `side`.
 * A Thirds game drafts 24 characters, so one equip and one eidolon change each, a few swaps and the confirmations stay
 * far below 300; the cap only stops a client that toggles an edit in a loop (each step reaches every member's view and
 * is archived to MatchSessionStepHistory). Checked on the open-game path of set_eidolon, equip_lightcone,
 * unequip_lightcone (kind 'edit', the step's team side) and by confirm_game (kind 'confirm', the confirming side); the
 * A60(7) Admin closed-game edit, close_game and concede are not capped, so a capped game can still be closed by its
 * referee or staff.
 */
export const MAX_EDIT_STEPS_PER_LOBBY = 300;
const EDIT_STEP_TAGS = new Set(['SetEidolon', 'EquipLightcone', 'UnequipLightcone']);

export function ensureEditStepRoom(ctx: any, lobbyId: number, side: 'Blue' | 'Red', kind: 'edit' | 'confirm'): void {
    let count = 0;
    for (const s of ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)) {
        if (kind === 'edit') {
            if (EDIT_STEP_TAGS.has(s.action.tag) && s.actorSlot?.tag === side) count++;
        } else if (s.action.tag === 'ConfirmGame' && s.payload?.value?.confirmedSide?.tag === side) {
            count++;
        }
    }
    if (count >= MAX_EDIT_STEPS_PER_LOBBY) {
        throw new SenderError(
            `The ${side} side of this game has reached the limit of ${MAX_EDIT_STEPS_PER_LOBBY} ${kind === 'edit' ? 'edit' : 'confirmation'} steps; the referee or staff can still close it.`,
        );
    }
}

/**
 * S10r (A122(10), L35): the same cap (MAX_EDIT_STEPS_PER_LOBBY) on the Undo rows of the lobby's game. Undo is a referee
 * power acting for the whole lobby, so the count is per lobby, not per side: every Undo step of the lobby counts.
 * undo_last_step calls it before deleting the step, so a referee looping pick and undo stops at the cap.
 */
export const undoCapText = `This game has reached the limit of ${MAX_EDIT_STEPS_PER_LOBBY} undo steps.`;

export function ensureUndoStepRoom(ctx: any, lobbyId: number): void {
    let count = 0;
    for (const s of ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)) {
        if (s.action.tag === 'Undo') count++;
    }
    if (count >= MAX_EDIT_STEPS_PER_LOBBY) throw new SenderError(undoCapText);
}

/**
 * Draft audit #8 (S10f, per pausing party since review F3): a manual pause_draft is rejected while the latest manual
 * Pause step of the caller's own pausing party is younger than PAUSE_MIN_INTERVAL_MS. The parties are 'Blue' and 'Red'
 * (a team's players, and a seated referee without the pause power, who pauses as a player) and 'Referee' (a referee
 * pausing with the referee power: `isReferee && lobby.refereeCanPause`, seated or not). A Pause step's party is the
 * actor's: 'Referee' when the actor's current LobbyMember row holds that power or the step's actorSlot is Spectator,
 * otherwise the step's actorSlot (Blue / Red). Every pause / resume cycle logs one Pause step (resume_draft logs none
 * and needs a pause first), so this bounds each party's cycles at one per 10 s (the referee's unlimited pauses as well
 * as each team's 3) while one party's pause never delays another's. The disconnect auto-pause neither counts nor is
 * throttled.
 */
export const PAUSE_MIN_INTERVAL_MS = 10_000;

export type PauseParty = 'Blue' | 'Red' | 'Referee';

function pauseStepParty(ctx: any, lobby: any, step: any): PauseParty {
    const slotTag: string | undefined = step.actorSlot?.tag;
    if (slotTag !== 'Blue' && slotTag !== 'Red') return 'Referee';
    if (lobby.refereeCanPause) {
        const actor = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobby.id, step.actorUserId])][0];
        if (actor?.isReferee) return 'Referee';
    }
    return slotTag;
}

export function ensurePauseInterval(ctx: any, lobby: any, party: PauseParty): void {
    let latest: bigint | undefined;
    for (const s of ctx.db.MatchSessionStep.lobby_id.filter(lobby.id)) {
        if (s.payload?.tag !== 'Pause' || s.payload.value?.isAutoPause) continue;
        const at: bigint = s.timestamp.microsSinceUnixEpoch;
        if (latest !== undefined && at <= latest) continue;
        if (pauseStepParty(ctx, lobby, s) !== party) continue;
        latest = at;
    }
    if (latest !== undefined && ctx.timestamp.microsSinceUnixEpoch - latest < BigInt(PAUSE_MIN_INTERVAL_MS) * 1000n) {
        throw new SenderError('The draft was paused moments ago. Please wait a few seconds before pausing again.');
    }
}

/**
 * A67(3): the live steps of the lobby's one game (A65's per-game filter is gone). Every reader of the draft state,
 * undo, ban restriction, edits and auto-resume goes through this.
 */
export function lobbySteps(ctx: any, lobbyId: number): any[] {
    return [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
}
