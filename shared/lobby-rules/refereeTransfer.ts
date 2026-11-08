// The pure decision core of the A22 / A22a referee-transfer scheduled check and the player
// auto-pause decision (S4). No SpacetimeDB runtime: `run_referee_transfer_check` wraps these.
// Same rule as `shared/stdb-targets.ts`: nothing here imports `spacetimedb` or `react`.

export type Slot = 'BluePlayer' | 'BlueCoach' | 'RedPlayer' | 'RedCoach' | 'Spectator';

export interface MemberLite {
    userId: number;
    slot: Slot;
    isOnline: boolean;
    /** A68(2)(4): the row carries `leftAt` (away) or `abandonedAt` (gone): offline whatever the presence rows say; never a candidate. */
    hasLeft: boolean;
    isReferee: boolean;
    /** Join order within the lobby (LobbyMember.joinSeq); lower = earlier. */
    joinOrder: number;
}

export type LobbyStage =
    | 'Waiting' | 'Drafting' | 'Equipping' | 'Scoring' | 'AwaitingResult';

/** Stages where a referee is needed and a disconnect matters (D-08 scope; A67(1): the three live-game stages). */
export const ACTIVE_STAGES: readonly LobbyStage[] = ['Drafting', 'Equipping', 'Scoring']; // A67(1)

export const isPlayer = (s: Slot): boolean => s === 'BluePlayer' || s === 'RedPlayer';
export const isCoach = (s: Slot): boolean => s === 'BlueCoach' || s === 'RedCoach';

const byJoin = (a: MemberLite, b: MemberLite) => a.joinOrder - b.joinOrder;

/**
 * A22(5) candidate order: host → Blue players (join order) → Red players (join order) → spectators (join order)
 * → coaches (Blue then Red, join order). The leaver and `hasLeft` rows (A68(2)(4)) are never candidates; `predicate`
 * narrows the set further (the captain's teammates). Online and offline candidates both appear, in order.
 */
function orderedCandidates(
    members: readonly MemberLite[],
    hostUserId: number,
    leaverUserId: number,
    predicate: (m: MemberLite) => boolean,
): MemberLite[] {
    const eligible = members.filter(m => m.userId !== leaverUserId && !m.hasLeft && predicate(m));
    const host = eligible.find(m => m.userId === hostUserId);
    const ordered: MemberLite[] = host ? [host] : [];
    const tiers: Array<(m: MemberLite) => boolean> = [
        m => m.slot === 'BluePlayer',
        m => m.slot === 'RedPlayer',
        m => m.slot === 'Spectator',
        m => m.slot === 'BlueCoach',
        m => m.slot === 'RedCoach',
    ];
    for (const tier of tiers) {
        ordered.push(...eligible.filter(m => m !== host && tier(m)).sort(byJoin));
    }
    return ordered;
}

/**
 * A22 / A22a: the first *online* candidate in the A22(5) order (the 15 s check, where an away player loses the flags,
 * A68(7)). Skips the leaver, offline members and `hasLeft` rows. Returns null when nobody is eligible (the flag stays).
 */
export function pickRefereeSuccessor(members: readonly MemberLite[], hostUserId: number, leaverUserId: number): number | null {
    return pickSuccessor(members, hostUserId, leaverUserId, () => true, true);
}

/**
 * A68(7): the successor of a flag (host, captain, referee) in the A22(5) order, online candidates first, then any
 * remaining member, so a lobby with members always has a host and a referee. `onlineOnly` keeps the 15 s check's
 * rule (A22a: the first online candidate, or nobody). Returns null when no candidate is left.
 */
export function pickSuccessor(
    members: readonly MemberLite[],
    hostUserId: number,
    leaverUserId: number,
    predicate: (m: MemberLite) => boolean = () => true,
    onlineOnly = false,
): number | null {
    const ordered = orderedCandidates(members, hostUserId, leaverUserId, predicate);
    const pick = ordered.find(m => m.isOnline) ?? (onlineOnly ? undefined : ordered[0]);
    return pick?.userId ?? null;
}

export interface TransferCheckInput {
    /** The member whose disconnect scheduled this check. */
    subjectUserId: number;
    /** Live state when the scheduled reducer fires (15 s later). */
    subject: MemberLite | undefined;
    members: readonly MemberLite[];
    hostUserId: number;
    stage: LobbyStage;
}

export type TransferCheckDecision =
    | { action: 'none'; reason: 'reconnected' | 'left-lobby' | 'not-referee' | 'inactive-stage' | 'no-candidate' }
    | { action: 'transfer'; toUserId: number };

/** The referee flag moves only if the subject is still offline when the check fires (A22a). */
export function decideRefereeTransfer(input: TransferCheckInput): TransferCheckDecision {
    const { subject } = input;
    if (!subject) return { action: 'none', reason: 'left-lobby' };
    if (subject.isOnline) return { action: 'none', reason: 'reconnected' };
    if (!subject.isReferee) return { action: 'none', reason: 'not-referee' };
    if (!ACTIVE_STAGES.includes(input.stage)) return { action: 'none', reason: 'inactive-stage' };
    const to = pickRefereeSuccessor(input.members, input.hostUserId, subject.userId);
    return to === null ? { action: 'none', reason: 'no-candidate' } : { action: 'transfer', toUserId: to };
}

export interface AutoPauseInput {
    subject: MemberLite | undefined;
    stage: LobbyStage;
    isPaused: boolean;
    disconnectPolicy: 'Standard' | 'Deferred' | 'NoAction';
}

/**
 * F5 + A22a: the draft auto-pauses only for a *player* on a team who is still offline when the
 * check fires, only in Drafting, only under Standard/Deferred, and only if not already paused.
 * Spectators and coaches never pause anything. A68(1): a player's Leave is a disconnect, so an away (`hasLeft`)
 * player pauses the draft like any other offline player (the caller passes `isOnline = false` for such a row).
 */
export function decideAutoPause(input: AutoPauseInput): boolean {
    const { subject } = input;
    if (!subject || subject.isOnline) return false;
    if (!isPlayer(subject.slot)) return false;
    if (input.stage !== 'Drafting') return false;
    if (input.disconnectPolicy === 'NoAction') return false;
    return !input.isPaused;
}
