// Shared helpers: view readers, column lists, accounts, calendar entries and links of the profile, roster, calendar
//   and admin view tests.
// From S9b (s9b-views.test.ts); not a test file.
import { ConnectionId } from 'spacetimedb';
import {
    M,
    TestAuth,
    guest,
    linkDiscord,
    tx,
    type Actor,
    type Harness,
    type SlotTag,
} from './harness';
import { AUDIT, insertHsrAccount } from './tournament-builders';

// ─── Reading views ───────────────────────────────────────────────────────────

export type Reader = Actor | TestAuth;
export const authOf = (r: Reader): TestAuth => ('auth' in r ? r.auth : r);

/** A per-sender view as `who` reads it. */
export function view<T = any>(test: Harness, name: string, who: Reader): T[] {
    return (M as any)[name](test.viewContext(authOf(who)), {}) as T[];
}

/** An anonymous shared view (no sender), optionally with arguments (arg views). */
export function shared<T = any>(test: Harness, name: string, args: Record<string, unknown> = {}): T[] {
    return (M as any)[name](test.anonymousViewContext(), args) as T[];
}

export let ghostSeq = 19_000n;
/** A client identity that never logged in: no UserIdentity mapping. */
export const ghost = () => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub: `s9b-ghost-${ghostSeq}` }), new ConnectionId(ghostSeq++));

export const displayName = (test: Harness, who: Actor | number) =>
    test.db.User.id.find(typeof who === 'number' ? who : who.userId)!.displayName;
export const keysOf = (row: object) => Object.keys(row).sort();
export const AUDIT_KEYS = ['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate'];

// ─── Documented columns (the egress list; type-checked against the generated bindings) ───────────────────────

export const COLS = {
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
    calEvent: ['id', 'organizerId', 'organizerLabel', 'title', 'description', 'startAt', 'endAt', 'bracketMatchId'] as const,
    calInvite: ['inviteKey', 'eventId', 'inviteeUserId', 'inviteeLabel', 'inviteStatus', 'respondedAt', 'inviterLabel'] as const,
    availability: ['id', 'startAt', 'endAt', 'isRecurring', 'recurrenceRule', 'expiresAt'] as const,
    savedAvailability: ['id', 'userId', 'userLabel', 'startAt', 'endAt', 'isRecurring', 'recurrenceRule', 'expiresAt'] as const,
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
};
export const sorted = <K extends keyof typeof COLS>(k: K) => [...COLS[k]].sort();

// ─── Builders ────────────────────────────────────────────────────────────────

export const ANON = { isAnonymousPlayers: true };

/** Seats named `${p}b1`, `${p}b2` (Blue), `${p}r1`, `${p}r2` (Red). */
export function seatsOf(p: string): Array<[string, SlotTag]> {
    return [[`${p}b1`, 'BluePlayer'], [`${p}b2`, 'BluePlayer'], [`${p}r1`, 'RedPlayer'], [`${p}r2`, 'RedPlayer']];
}

/** A guest that links a provider (verified) with an explicit provider id. */
export function linked(test: Harness, sub: string, providerId: string, name: string): Actor {
    const a = guest(test, sub);
    linkDiscord(test, a, providerId, name);
    return a;
}

/** An HSR account owned by `who` with characters, selected for the lobby (LobbyMemberAccount). Returns the account id. */
export function selectAccount(test: Harness, lobbyId: number, who: Actor, uid: string, rating: number, chars: string[]): number {
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

// Calendar builders (reducers; times are micros strings, as the client sends them)
export const at = (test: Harness, hours: number) => (test.clock.now().microsSinceUnixEpoch + BigInt(hours) * 3_600_000_000n).toString();

export function createEvent(test: Harness, who: Actor, title: string, invitees: Actor[] = [], bracketMatchId = 0): number {
    tx(test, who, (ctx) => M.create_calendar_event(ctx, {
        title, description: `${title} notes`, startAt: at(test, 24), endAt: at(test, 26), bracketMatchId,
        inviteeUserIds: invitees.map((i) => i.userId).join(','),
    }));
    return [...test.db.CalendarEvent.organizer_id.filter(who.userId)].find((e) => e.title === title)!.id;
}

export function addSlot(test: Harness, who: Actor, startHours: number) {
    tx(test, who, (ctx) => M.create_availability_slot(ctx, {
        startAt: at(test, startHours), endAt: at(test, startHours + 2), isRecurring: false, recurrenceType: '',
        interval: 0, dayOfWeek: 255, dayOfMonth: 0, endDate: '',
    }));
}

export const saveCalendar = (test: Harness, who: Actor, target: Actor) =>
    tx(test, who, (ctx) => M.save_calendar(ctx, { targetUserId: target.userId }));
