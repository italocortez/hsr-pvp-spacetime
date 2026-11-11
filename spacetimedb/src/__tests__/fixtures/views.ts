// Fixtures: view readers, documented column lists (the egress lists), ghosts, and the lobby, scoring and account
//   builders of the view tests.
// From S9a (s9a-views.test.ts: lobby, match and tournament views), S9b (s9b-views.test.ts: profile, roster, calendar
// and admin views), S9c (seat-view readers), S10s (viewAs); gathered by T-REORG2.
//
// Not a test file. Views are read through the module's view functions with a TestAuth context; `test.db` is read only
// outside `tx` bodies. Nothing reaches maincloud.
import { expect } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import {
    AUDIT,
    M,
    TestAuth,
    guest,
    lobbyRow,
    setupLobby,
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
} from './draft-and-scoring';
import { insertHsrAccount } from './roster';

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

/**
 * A ghost maker: each call of the returned function is a client identity that never logged in (no UserIdentity
 * mapping), JWT sub `<prefix><seq>` and connection id `seq`, the sequence counting up from `firstSeq`.
 */
export function makeGhost(prefix: string, firstSeq: bigint): () => TestAuth {
    let seq = firstSeq;
    return () => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub: `${prefix}${seq}` }), new ConnectionId(seq++));
}
/** The lobby and match view tests' ghosts (sub `ghost-<n>` from 9000). */
export const ghost = makeGhost('ghost-', 9_000n);
/** The profile, roster, calendar and admin view tests' ghosts (sub `s9b-ghost-<n>` from 19000). */
export const profileGhost = makeGhost('s9b-ghost-', 19_000n);

export const keysOf = (row: object) => Object.keys(row).sort();
/** Runtime egress check: the emitted object carries no key outside the documented column list. */
export function expectOnlyColumns(row: object, cols: readonly string[]) {
    const extra = Object.keys(row).filter((k) => !cols.includes(k));
    expect(extra, 'undocumented columns').toEqual([]);
}
export const AUDIT_KEYS = ['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate'];
/** A tournament view as `who` reads it, with arguments. */
export const viewAs = <T = any>(test: Harness, name: string, who: Actor, args: Record<string, unknown> = {}): T[] =>
    (M as any)[name](test.viewContext(who.auth), args) as T[];
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
    // S9b: profile, roster, calendar and admin views
    identity: ['identity', 'userId'] as const,
    profile: ['id', 'username', 'displayName', 'avatarCharacterName', 'displayedAchievementId', 'hasDiscordLinked',
        'isGuest', 'role', 'loginMethod', 'providerId', 'providerUsername'] as const,
    byUsername: ['userId', 'username', 'displayName', 'avatarCharacterName', 'displayedAchievementId'] as const,
    userAchievement: ['achievementId', 'awardedAt'] as const,
    playerStat: ['gameMode', 'draftMode', 'matchType', 'teamSize', 'seasonId', 'matchesPlayed', 'wins', 'losses',
        'matchesSpectated'] as const,
    charStat: ['characterName', 'gameMode', 'draftMode', 'matchType', 'teamSize', 'seasonId', 'matchesPlayed', 'wins',
        'losses', 'timesBannedInMatch', 'timesFaced', 'winsAgainst', 'lossesAgainst'] as const,
    mmr: ['gameMode', 'seasonId', 'rating', 'matchesPlayed', 'wins', 'lastUpdatedAt'] as const,
    relationship: ['otherUserId', 'otherDisplayName', 'otherAvatarCharacterName', 'otherDisplayedAchievementId',
        'otherMmrByMode', 'gameMode', 'draftMode', 'matchType', 'teamSize', 'seasonId', 'matchesAsAlly', 'winsAsAlly',
        'matchesAsOpponent', 'winsAsOpponent'] as const,
    rosterVisibility: ['lobbyId', 'joinSeq', 'memberUserId', 'hsrAccountId', 'characterName', 'eidolonLevel',
        'accountRating'] as const,
    myRoster: ['accountId', 'uid', 'region', 'displayLabel', 'isActive', 'isRosterPublic', 'isRatingPublic',
        'isDuplicateUid', 'accountRating', 'characterName', 'eidolonLevel'] as const,
    publicAccount: ['accountId', 'userId', 'uid', 'region', 'displayLabel', 'accountRating', 'characterName',
        'eidolonLevel'] as const,
    // T-S10ac (A157(1), (3), (6), (12)): avatars next to labels, isBusyBlock, slot kind; recurrence columns removed
    calEvent: ['id', 'organizerId', 'organizerLabel', 'organizerAvatarCharacterName', 'title', 'description', 'startAt',
        'endAt', 'bracketMatchId', 'isBusyBlock'] as const,
    calInvite: ['inviteKey', 'eventId', 'inviteeUserId', 'inviteeLabel', 'inviteeAvatarCharacterName', 'inviteStatus',
        'respondedAt', 'inviterLabel', 'inviterAvatarCharacterName'] as const,
    availability: ['id', 'startAt', 'endAt', 'kind'] as const,
    savedAvailability: ['id', 'userId', 'userLabel', 'startAt', 'endAt', 'kind'] as const,
    savedCalendar: ['targetUserId', 'targetLabel', 'targetAvatarCharacterName', 'isVisible'] as const,
    adminIdentity: ['identity', 'userId', 'lastSeenAt'] as const,
    adminBan: ['id', 'loginMethod', 'providerId', 'reason', 'bannedByUserId', 'bannedByLabel', 'createdDate'] as const,
    adminDeleted: ['id', 'displayName', 'isGuest', 'deletedAt'] as const,
    adminPresence: ['identity', 'userId', 'isOnline', 'lastLoginAt', 'lastSeenAt'] as const,
    adminLobbyBan: ['lobbyId', 'bannedUserId', 'bannedJoinSeq', 'bannedUserLabel', 'bannedByUserId', 'bannedByLabel', 'createdDate'] as const, // T-S9c: + bannedJoinSeq (A74(2))
    adminAbuse: ['id', 'cursorMinIntervalMs', 'chatMinIntervalMs', 'chatPerMinute', 'lineupMinIntervalMs',
        'lobbyCreatesPerHour', 'maxPresetsPerUser', 'maxCostSetsPerUser', 'maintenanceMode', 'guestLobbyCreationEnabled',
        'guestLobbyBurstThreshold', 'guestLobbyBurstWindowMinutes',
        'guestCreationEnabled', 'guestCreationBurstThreshold', 'guestCreationBurstWindowMinutes'] as const, // T-S10h: + A95(2)
    adminUserPrivate: ['userId', 'loginMethod', 'providerId', 'providerUsername'] as const,
    // T-S11a (A77(1)): the admin Users tab
    adminUser: ['id', 'username', 'displayName', 'isGuest', 'role', 'hasDiscordLinked', 'avatarCharacterName',
        'displayedAchievementId', 'deletedAt', 'createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate'] as const,
};
export type Cols<K extends keyof typeof COLS> = (typeof COLS)[K][number];
export const sorted = <K extends keyof typeof COLS>(k: K) => [...COLS[k]].sort();

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

/**
 * beforeStart hook: the lobby becomes Ranked (direct row edit, as s7b) and every player gets an HSR account (D-08),
 * account ids `firstAccountId + lobbyId * 10` upwards (default 800).
 */
export const makeRanked = (test: Harness, firstAccountId = 800) => (l: Lobby) => {
    test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
    let accountId = firstAccountId + l.lobbyId * 10;
    for (const m of test.db.LobbyMember.lobby_id.filter(l.lobbyId)) {
        if (m.lobbySlot.tag === 'BluePlayer' || m.lobbySlot.tag === 'RedPlayer') {
            test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: m.userId, hsrAccountId: accountId++ });
        }
    }
};

export const ANON = { isAnonymousPlayers: true };

export const rowFor = <T extends { userId: number; label: string }>(rows: T[], label: string) => rows.find((r) => r.label === label)!;

/** The empty filters of the match-history views (every game mode, draft mode and match type). */
export const ANY = { gameMode: '', draftMode: '', matchType: '' };

// ─── Accounts (S9b) ──────────────────────────────────────────────────────────

/** An HSR account owned by `who` with a rating and characters, selected for the lobby (LobbyMemberAccount). Returns its id. */
export function selectRatedAccount(test: Harness, lobbyId: number, who: Actor, uid: string, rating: number, chars: string[] = []): number {
    const id = addAccount(test, who.userId, uid, { rating, chars });
    test.db.LobbyMemberAccount.insert({ lobbyId, userId: who.userId, hsrAccountId: id });
    return id;
}

export function addAccount(test: Harness, userId: number, uid: string, o: { rating?: number; chars?: string[]; isRosterPublic?: boolean; isRatingPublic?: boolean } = {}): number {
    const id = insertHsrAccount(test, userId, uid);
    test.db.HsrAccount.id.update({
        ...test.db.HsrAccount.id.find(id)!,
        accountRating: o.rating ?? 0,
        isRosterPublic: o.isRosterPublic ?? true,
        isRatingPublic: o.isRatingPublic ?? true,
    });
    for (const [i, characterName] of (o.chars ?? []).entries()) {
        test.db.HsrAccountCharacter.insert({ hsrAccountId: id, characterName, eidolonLevel: i, ...AUDIT(test) });
    }
    return id;
}
