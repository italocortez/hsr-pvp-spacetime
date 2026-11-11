// Shared helpers: view readers, column lists, ghosts and the lobby and scoring builders of the lobby and match view
//   tests.
// From S9a (s9a-views.test.ts); not a test file.
import { expect } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import {
    M,
    TestAuth,
    guest,
    lobbyRow,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
    type SlotTag,
} from './harness';
import {
    blueNames,
    playToScoring,
    redNames,
    type ScoringLobbyOpts,
} from './draft-and-scoring-builders';

// ─── Reading views ───────────────────────────────────────────────────────────

export type Reader = Actor | TestAuth;
export const authOf = (r: Reader): TestAuth => ('auth' in r ? r.auth : r);

/** A per-sender view as `who` reads it (T-S10n: with arguments for the per-match history views). */
export function view<T = any>(test: Harness, name: string, who: Reader, args: Record<string, unknown> = {}): T[] {
    return (M as any)[name](test.viewContext(authOf(who)), args) as T[];
}

/** T-S10n (A115(3)): the history id of the one archived match `who` played in. */
export const onlyMatchOf = (test: Harness, who: Actor) => [...test.db.MatchParticipantHistory.by_user.filter(who.userId)][0].matchHistoryId;

/** An anonymous shared view (no sender), optionally with arguments (arg views). */
export function shared<T = any>(test: Harness, name: string, args: Record<string, unknown> = {}): T[] {
    return (M as any)[name](test.anonymousViewContext(), args) as T[];
}

export let ghostSeq = 9_000n;
/** A client identity that never logged in: no UserIdentity mapping. */
export const ghost = () => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub: `ghost-${ghostSeq}` }), new ConnectionId(ghostSeq++));

export const displayName = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.displayName;
export const keysOf = (row: object) => Object.keys(row).sort();
/** Runtime egress check: the emitted object carries no key outside the documented column list. */
export function expectOnlyColumns(row: object, cols: readonly string[]) {
    const extra = Object.keys(row).filter((k) => !cols.includes(k));
    expect(extra, 'undocumented columns').toEqual([]);
}
export const AUDIT_KEYS = ['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate'];
export const USER_ID_KEY = /userid|byid$|^hostuserid$|^createdbyid$|^lastmodifiedbyid$/i;

// ─── Documented columns (the egress list; type-checked against the generated bindings) ───────────────────────

export const COLS = {
    browser: ['id', 'name', 'joinCode', 'hostLabel', 'gameMode', 'draftMode', 'matchType', 'banMode', 'banRestriction',
        'lineupFormat', 'rosterVisibility', 'disconnectPolicy', 'teamSize', 'currentPlayerCount', 'coachCount',
        'spectatorCount', 'maxSpectators', 'isPublic', 'isAnonymousPlayers', 'isAnonymousSpectators',
        'isTournamentControlled', 'stage', 'createdDate', 'tournamentName', 'costSetName'] as const,
    myLobbies: ['id', 'joinCode', 'name', 'stage', 'isAway'] as const,
    member: ['memberKey', 'lobbyId', 'joinSeq', 'userId', 'label', 'lobbySlot', 'presence', 'isHost', 'isReferee',
        'isCaptain', 'isConfirmed', 'avatarCharacterName', 'displayedAchievementId', 'mmrByMode', 'accountRating',
        'accountCount', 'disconnectActionAt'] as const, // T-S10d: + disconnectActionAt (A92(9))
    ban: ['lobbyId', 'bannedUserId', 'bannedJoinSeq', 'label', 'bannedByUserId', 'createdDate'] as const, // T-S9c: + bannedJoinSeq (A74(2))
    chat: ['id', 'lobbyId', 'senderUserId', 'senderType', 'content', 'metadata', 'anonymousLabel', 'createdDate'] as const,
    session: ['lobbyId', 'turnIndex', 'draftSequence', 'timerState', 'isAuctionPhase', 'nextNominatorTeam',
        'blueCharactersWon', 'redCharactersWon', 'currentNomination', 'currentBidAmount', 'currentBidTeam',
        'teamBlueCharBudget', 'teamRedCharBudget', 'teamBlueLcBudget', 'teamRedLcBudget', 'pausesUsedBlue',
        'pausesUsedRed'] as const,
    step: ['id', 'lobbyId', 'sequence', 'actorUserId', 'anonymousLabel', 'actorSlot', 'action', 'payload', 'timestamp'] as const,
    participant: ['matchResultId', 'userId', 'teamSide', 'isCaptain', 'anonymousLabel', 'accountRatingSnapshot'] as const,
    lineup: ['id', 'lobbyId', 'teamSide', 'groups', 'synergySurcharge', 'rosterCost', 'blueConfirmed', 'redConfirmed',
        'closedAt'] as const,
    result: ['id', 'lobbyId', 'bracketMatchId', 'isTournamentControlled', 'status', 'winnerTeamSide', 'matchType',
        'matchEndReason', 'concedeTrigger', 'concedeSummary', 'concedeAtStage', 'disputedByUserId', 'disputeReason',
        'winnerOverride', 'winnerOverrideById', 'winnerOverrideReason', 'settledAt'] as const,
    game: ['matchResultId', 'lobbyId', 'gameMode', 'teamBlueScreenshotUrl', 'teamRedScreenshotUrl', 'teamBlueCyclesUsed',
        'teamRedCyclesUsed', 'teamBlueScore', 'teamRedScore', 'teamBlueDeaths', 'teamRedDeaths', 'teamBlueAdjustedResult',
        'teamRedAdjustedResult', 'tieBreakLevel', 'winnerTeamSide', 'validationStatus', 'validatedByUserId',
        'blueConfirmed', 'redConfirmed', 'closedAt', 'closedById', 'groupScores', 'adjustments'] as const,
    groupScore: ['teamSide', 'groupIndex', 'value'] as const,
    adjustment: ['id', 'teamSide', 'value', 'reason', 'setById'] as const,
    stuck: ['lobbyId', 'joinCode', 'stage', 'blueConfirmed', 'redConfirmed', 'isTie', 'sinceAt'] as const,
    tParticipant: ['tournamentId', 'seat', 'teamId', 'userId', 'label', 'status', 'isWaitlisted'] as const,
    tTeam: ['id', 'tournamentId', 'name', 'status', 'seedNumber', 'groupId', 'finalPlacement', 'captainUserId'] as const,
    tTeamMember: ['teamId', 'tournamentId', 'userId', 'label'] as const,
    tStaff: ['tournamentId', 'userId', 'label', 'isOrganizer', 'canManageParticipants', 'canManageBracket',
        'canResolveResults'] as const,
    teamRequest: ['teamId', 'tournamentId', 'teamName', 'userId', 'label', 'isMine', 'createdDate'] as const,
    standIn: ['id', 'bracketMatchId', 'teamId', 'userId', 'label'] as const,
    registrant: ['tournamentId', 'userId', 'seat', 'hsrAccountId', 'displayLabel', 'accountRating', 'characterName',
        'eidolonLevel'] as const,
    matchForMe: ['bracketMatchId', 'tournamentId', 'myTeamId', 'opponentTeamId', 'opponentTeamName', 'blueTeamId',
        'redTeamId', 'state', 'bracketSide', 'roundNumber', 'matchNumber', 'bestOf', 'team1Id', 'team2Id', 'team1Games',
        'team2Games', 'scheduledAt'] as const,
};

// ─── Builders ────────────────────────────────────────────────────────────────

/** Seats named `${p}b1`, `${p}b2` (Blue), `${p}r1`, `${p}r2` (Red); the host `${p}host`. */
export function seatsOf(p: string): Array<[string, SlotTag]> {
    return [[`${p}b1`, 'BluePlayer'], [`${p}b2`, 'BluePlayer'], [`${p}r1`, 'RedPlayer'], [`${p}r2`, 'RedPlayer']];
}

/** A lobby whose actors carry the prefix `p` (several lobbies in one harness; D-22 binds a user to one lobby). */
export function lobbyOf(test: Harness, p: string, opts: SetupOpts = {}): Lobby {
    return setupLobby(test, { seats: seatsOf(p), actors: { host: guest(test, `${p}host`) }, ...opts });
}

/** playToScoring with prefixed actors and character names (HsrCharacter names are unique per harness). */
export function scoringOf(test: Harness, p: string, opts: ScoringLobbyOpts = {}): Lobby {
    return playToScoring(test, {
        seats: seatsOf(p),
        actors: { host: guest(test, `${p}host`) },
        blue: blueNames().map((n) => `${p}${n}`),
        red: redNames().map((n) => `${p}${n}`),
        ...opts,
    });
}

/** beforeStart hook: the lobby becomes Ranked (direct row edit, as s7b) and every player gets an HSR account (D-08). */
export const makeRanked = (test: Harness) => (l: Lobby) => {
    test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
    let accountId = 800 + l.lobbyId * 10;
    for (const m of test.db.LobbyMember.lobby_id.filter(l.lobbyId)) {
        if (m.lobbySlot.tag === 'BluePlayer' || m.lobbySlot.tag === 'RedPlayer') {
            test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: m.userId, hsrAccountId: accountId++ });
        }
    }
};

export const ANON = { isAnonymousPlayers: true };
export const leave = (test: Harness, who: Actor, lobbyId: number) => tx(test, who, (ctx) => M.leave_lobby(ctx, { lobbyId }));

export const rowFor = <T extends { userId: number; label: string }>(rows: T[], label: string) => rows.find((r) => r.label === label)!;
