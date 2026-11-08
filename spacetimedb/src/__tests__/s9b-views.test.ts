// T-S9b: in-memory tests for step S9b, the identity / profile, stats, roster, calendar and admin views and the
// public-aggregate writers (DECISIONS A37, A40, A42, A43, A44(1)(2), A45(1), A48). Same method as s9a-views.test.ts:
// per-sender views through `test.viewContext(auth)`, anonymous views (and arg views) through
// `test.anonymousViewContext()`. State is built through the module's reducers (s4 / s7 / s8 / s8d builders); ratings,
// stats, HSR accounts and roles are written straight into the in-memory datastore, as the earlier suites do. Readers:
// the owner of the rows, an outsider (a user with none), an identity with no UserIdentity mapping and, for per-sender
// views, a Moderator who owns nothing. Row shapes: the views code is the truth; the decision rows say what must hold,
// so an anonymity leak or a player id on a public aggregate row stays a failing test (CLAUDE.md §6). Nothing reaches
// maincloud.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import type {
    AdminAbuseConfigRow,
    AdminBanRecordRow,
    AdminDeletedUserRow,
    AdminLobbyBanRow,
    AdminPresenceRow,
    AdminUserIdentityRow,
    AdminUserPrivateRow,
    MyAvailabilityRow,
    MyCalendarEventRow,
    MyCalendarInviteRow,
    MyCharacterStatRow,
    MyIdentityRow,
    MyMmrRatingRow,
    MyPlayerStatRow,
    MyProfileRow,
    MyRelationshipRow,
    MyRosterAccountRow,
    MySavedCalendarRow,
    PublicHsrAccountRow,
    RosterVisibilityRow,
    SavedCalendarAvailabilityRow,
    UserAchievementViewRow,
    UserByUsernameRow,
} from '@bindings/types';
import type { tables as bindingTables } from '@bindings/index';
import { LEADERBOARD_MAX_ENTRIES, rebuildLeaderboard } from '@module/helpers/stats/leaderboardRebuild';
import {
    M,
    SYSTEM_USER_ID,
    TestAuth,
    connect,
    disconnect,
    guest,
    linkDiscord,
    lobbyRow,
    member,
    newHarness,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
    type SlotTag,
} from './s4-fixtures';
import { blueNames, finishGame, playToScoring, redNames, setRole, type ScoringLobbyOpts } from './s7-fixtures';
import { AUDIT, insertHsrAccount, moderator, verified } from './s8-fixtures';
import { duel, seedElo } from './s8d-fixtures';

// ─── Reading views ───────────────────────────────────────────────────────────

type Reader = Actor | TestAuth;
const authOf = (r: Reader): TestAuth => ('auth' in r ? r.auth : r);

/** A per-sender view as `who` reads it. */
function view<T = any>(test: Harness, name: string, who: Reader): T[] {
    return (M as any)[name](test.viewContext(authOf(who)), {}) as T[];
}

/** An anonymous shared view (no sender), optionally with arguments (arg views). */
function shared<T = any>(test: Harness, name: string, args: Record<string, unknown> = {}): T[] {
    return (M as any)[name](test.anonymousViewContext(), args) as T[];
}

let ghostSeq = 19_000n;
/** A client identity that never logged in: no UserIdentity mapping. */
const ghost = () => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub: `s9b-ghost-${ghostSeq}` }), new ConnectionId(ghostSeq++));

const displayName = (test: Harness, who: Actor | number) =>
    test.db.User.id.find(typeof who === 'number' ? who : who.userId)!.displayName;
const keysOf = (row: object) => Object.keys(row).sort();
const AUDIT_KEYS = ['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate'];
const noAudit = (row: object) => AUDIT_KEYS.filter((k) => k in row);

// ─── Documented columns (the egress list; type-checked against the generated bindings) ───────────────────────

const COLS = {
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
    adminLobbyBan: ['lobbyId', 'bannedUserId', 'bannedUserLabel', 'bannedByUserId', 'bannedByLabel', 'createdDate'] as const,
    adminAbuse: ['id', 'cursorMinIntervalMs', 'chatMinIntervalMs', 'chatPerMinute', 'lineupMinIntervalMs',
        'lobbyCreatesPerHour', 'maxPresetsPerUser', 'maxCostSetsPerUser', 'maintenanceMode', 'guestLobbyCreationEnabled',
        'guestLobbyBurstThreshold', 'guestLobbyBurstWindowMinutes'] as const,
    adminUserPrivate: ['userId', 'loginMethod', 'providerId', 'providerUsername'] as const,
};
type Cols<K extends keyof typeof COLS> = (typeof COLS)[K][number];
const sorted = <K extends keyof typeof COLS>(k: K) => [...COLS[k]].sort();

// ─── Builders ────────────────────────────────────────────────────────────────

const ANON = { isAnonymousPlayers: true };
const MOC = { tag: 'MemoryOfChaos' } as any;
const AS = { tag: 'ApocalypticShadow' } as any;

/** Seats named `${p}b1`, `${p}b2` (Blue), `${p}r1`, `${p}r2` (Red). */
function seatsOf(p: string): Array<[string, SlotTag]> {
    return [[`${p}b1`, 'BluePlayer'], [`${p}b2`, 'BluePlayer'], [`${p}r1`, 'RedPlayer'], [`${p}r2`, 'RedPlayer']];
}

/** playToScoring with prefixed actors and character names (HsrCharacter names are unique per harness). */
function scoringOf(test: Harness, p: string, opts: ScoringLobbyOpts = {}): Lobby {
    return playToScoring(test, {
        seats: seatsOf(p),
        actors: { host: guest(test, `${p}host`) },
        blue: blueNames().map((n) => `${p}${n}`),
        red: redNames().map((n) => `${p}${n}`),
        ...opts,
    });
}

/** beforeStart hook: the lobby becomes Ranked (direct row edit, as s7b / s9a) and every player gets an HSR account. */
const makeRanked = (test: Harness) => (l: Lobby) => {
    test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
    let accountId = 800 + l.lobbyId * 10;
    for (const m of test.db.LobbyMember.lobby_id.filter(l.lobbyId)) {
        if (m.lobbySlot.tag === 'BluePlayer' || m.lobbySlot.tag === 'RedPlayer') {
            test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: m.userId, hsrAccountId: accountId++ });
        }
    }
};

/** An MmrRating row (private table) written directly, as the S8 / S9a suites seed ratings. */
function seedRating(test: Harness, userId: number, rating: number, o: { matchesPlayed?: number; gameMode?: any; seasonId?: number; global?: number } = {}) {
    test.db.MmrRating.insert({
        userId, gameMode: o.gameMode ?? MOC, rating, matchesPlayed: o.matchesPlayed ?? 5,
        globalCompositeRating: o.global, seasonId: o.seasonId ?? 0, ...AUDIT(test),
    } as any);
}

/** A PlayerStat row written directly (the leaderboard and view_my_mmr_ratings read its wins). */
function seedStat(test: Harness, userId: number, wins: number, o: { gameMode?: any; draftMode?: string; seasonId?: number } = {}) {
    test.db.PlayerStat.insert({
        userId, gameMode: o.gameMode ?? MOC, draftMode: { tag: o.draftMode ?? 'Classic' }, matchesPlayed: wins + 2, wins,
        losses: 2, matchesSpectated: 0, seasonId: o.seasonId ?? 0, matchType: { tag: 'Ranked' }, teamSize: 2, ...AUDIT(test),
    } as any);
}

/** A guest that links a provider (verified) with an explicit provider id. */
function linked(test: Harness, sub: string, providerId: string, name: string): Actor {
    const a = guest(test, sub);
    linkDiscord(test, a, providerId, name);
    return a;
}

/** An HSR account owned by `who` with characters, selected for the lobby (LobbyMemberAccount). Returns the account id. */
function selectAccount(test: Harness, lobbyId: number, who: Actor, uid: string, rating: number, chars: string[]): number {
    const id = addAccount(test, who.userId, uid, { rating, chars });
    test.db.LobbyMemberAccount.insert({ lobbyId, userId: who.userId, hsrAccountId: id });
    return id;
}

function addAccount(test: Harness, userId: number, uid: string, o: { rating?: number; chars?: string[]; isRosterPublic?: boolean; isRatingPublic?: boolean } = {}): number {
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
const at = (test: Harness, hours: number) => (test.clock.now().microsSinceUnixEpoch + BigInt(hours) * 3_600_000_000n).toString();

function createEvent(test: Harness, who: Actor, title: string, invitees: Actor[] = [], bracketMatchId = 0): number {
    tx(test, who, (ctx) => M.create_calendar_event(ctx, {
        title, description: `${title} notes`, startAt: at(test, 24), endAt: at(test, 26), bracketMatchId,
        inviteeUserIds: invitees.map((i) => i.userId).join(','),
    }));
    return [...test.db.CalendarEvent.organizer_id.filter(who.userId)].find((e) => e.title === title)!.id;
}

function addSlot(test: Harness, who: Actor, startHours: number) {
    tx(test, who, (ctx) => M.create_availability_slot(ctx, {
        startAt: at(test, startHours), endAt: at(test, startHours + 2), isRecurring: false, recurrenceType: '',
        interval: 0, dayOfWeek: 255, dayOfMonth: 0, endDate: '',
    }));
}

const saveCalendar = (test: Harness, who: Actor, target: Actor) =>
    tx(test, who, (ctx) => M.save_calendar(ctx, { targetUserId: target.userId }));
const showCalendar = (test: Harness, who: Actor, target: Actor, isVisible: boolean) =>
    tx(test, who, (ctx) => M.toggle_calendar_visibility(ctx, { targetUserId: target.userId, isVisible }));

function createAchievement(test: Harness, mod: Actor, name: string, isManualOnly: boolean): number {
    tx(test, mod, (ctx) => M.create_achievement(ctx, { name, description: name, rarity: { tag: 'Rare' } as any, isManualOnly, maxAwards: undefined }));
    return test.db.Achievement.name.find(name)!.id;
}

// ════════════════════════════════════════════════════════════════════════════
// Outsider isolation (A37; §A.4 P1): every S9b per-sender view returns [] for an outsider, an unmapped identity and
// a Moderator who owns nothing, while the owner reads rows (so the [] is not vacuous).
// ════════════════════════════════════════════════════════════════════════════

describe('A37 outsider isolation: S9b per-sender views', () => {
    function world() {
        const test = newHarness();
        seedElo(test);
        const s = scoringOf(test, '', { lobby: ANON });
        finishGame(s, 'Blue'); // stats, character stats and relationships for the four players
        seedRating(test, s.a.b1.userId, 1300);
        const rhost = verified(test, 'rhost');
        const r = setupLobby(test, { seats: seatsOf('v'), actors: { host: rhost }, noStart: true });
        selectAccount(test, r.lobbyId, r.a.vb1, 'vb1-acc', 1100, ['vb1-char']);
        const carol = verified(test, 'carol');
        const dave = verified(test, 'dave');
        createEvent(test, carol, 'E1', [dave]);
        addSlot(test, dave, 30);
        addSlot(test, carol, 30);
        saveCalendar(test, dave, carol);
        return { test, s, r, carol, dave, outsider: guest(test, 'outsider'), mod: moderator(test, 'mod') };
    }

    it('stats, MMR, relationships, roster and calendar views: [] for an outsider, an unmapped identity and a Moderator who owns nothing; the owner reads rows', () => {
        const { test, s, r, dave, outsider, mod } = world();
        const views: Array<[string, Actor]> = [
            ['view_my_player_stats', s.a.b1],
            ['view_my_character_stats', s.a.b1],
            ['view_my_mmr_ratings', s.a.b1],
            ['view_my_relationships', s.a.b1],
            ['view_my_roster_visibility', r.a.vr1],
            ['view_my_roster', r.a.vb1],
            ['view_my_calendar_events', dave],
            ['view_my_calendar_invites', dave],
            ['view_my_availability', dave],
            ['view_saved_calendar_availability', dave],
            ['view_my_saved_calendars', dave],
        ];
        for (const [name, owner] of views) {
            expect(view(test, name, owner).length, `${name}: owner`).toBeGreaterThan(0);
            expect(view(test, name, outsider), `${name}: outsider`).toEqual([]);
            expect(view(test, name, ghost()), `${name}: unmapped identity`).toEqual([]);
            expect(view(test, name, mod), `${name}: Moderator who owns nothing`).toEqual([]);
        }
    });

    it('view_my_profile / view_my_identity: an unmapped identity reads nothing; anyone else reads only their own row', () => {
        const { test, s, outsider, mod } = world();
        expect(view(test, 'view_my_profile', ghost())).toEqual([]);
        expect((M as any).view_my_identity(test.viewContext(ghost()), {})).toBeUndefined();
        for (const who of [outsider, mod, s.a.b1]) {
            const rows = view<MyProfileRow>(test, 'view_my_profile', who);
            expect(rows.map((x) => x.id), who.sub).toEqual([who.userId]);
            const id = (M as any).view_my_identity(test.viewContext(who.auth), {}) as MyIdentityRow;
            expect(id.userId, who.sub).toBe(who.userId);
        }
    });

    it('admin views: [] for a player, a guest outsider and an unmapped identity; rows for a Moderator', () => {
        const { test, s, outsider, mod } = world();
        tx(test, s.a.b1, (ctx) => M.client_connected(ctx, {})); // a presence row exists for the Moderator to read
        for (const name of ADMIN_VIEWS) {
            expect(view(test, name, mod).length, `${name}: Moderator`).toBeGreaterThan(0);
            for (const who of [s.a.b1, outsider] as Reader[]) {
                expect(view(test, name, who), `${name}: non-staff`).toEqual([]);
            }
            expect(view(test, name, ghost()), `${name}: unmapped`).toEqual([]);
        }
    });
});

const ADMIN_VIEWS = [
    'view_admin_user_identities',
    'view_admin_presence',
    'view_admin_abuse_config',
    'view_admin_user_private',
] as const;

// ════════════════════════════════════════════════════════════════════════════
// Identity / profile (S9b-V1, V2, V3)
// ════════════════════════════════════════════════════════════════════════════

describe('view_my_profile (S9b-V1, S3 hand-off, PAGE-MAP profile)', () => {
    it('a guest: one row keyed by their id, the documented columns only (no presence, email, discord or audit column); provider fields undefined', () => {
        const test = newHarness();
        const g = guest(test, 'pg');
        const rows = view<MyProfileRow>(test, 'view_my_profile', g);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(keysOf(row)).toEqual(sorted('profile'));
        for (const k of ['isOnline', 'lastLoginAt', 'email', 'discordId', 'discordUsername', 'deletedAt', ...AUDIT_KEYS]) {
            expect(k in row, k).toBe(false);
        }
        expect(row).toMatchObject({ id: g.userId, isGuest: true, hasDiscordLinked: false, loginMethod: undefined, providerId: undefined, providerUsername: undefined });
        expect(row.username).toBe(test.db.User.id.find(g.userId)!.username);
    });

    it('a verified user: loginMethod / providerId / providerUsername from UserPrivate (A46); role and title from User', () => {
        const test = newHarness();
        const pat = linked(test, 'pat-dev', 'pid-pat', 'Pat');
        test.db.User.id.update({ ...test.db.User.id.find(pat.userId)!, avatarCharacterName: 'Kafka', displayedAchievementId: 4 });
        setRole(test, pat.userId, 'Moderator');
        const [row] = view<MyProfileRow>(test, 'view_my_profile', pat);
        expect(row).toEqual({
            id: pat.userId, username: 'Pat', displayName: 'Pat', avatarCharacterName: 'Kafka', displayedAchievementId: 4,
            hasDiscordLinked: true, isGuest: false, role: test.db.User.id.find(pat.userId)!.role, loginMethod: 'discord',
            providerId: 'pid-pat', providerUsername: 'Pat',
        });
        expect(row.role.tag).toBe('Moderator');
    });

    it('view_my_identity returns only { identity, userId }', () => {
        const test = newHarness();
        const g = guest(test, 'idg');
        const row = (M as any).view_my_identity(test.viewContext(g.auth), {}) as MyIdentityRow;
        expect(keysOf(row)).toEqual(sorted('identity'));
        expect(row.userId).toBe(g.userId);
        expect(row.identity.toHexString()).toBe(g.identity.toHexString());
    });
});

describe('view_user_by_username(username) (S9b-V2, S9b-C4, A44(1) D7)', () => {
    function world() {
        const test = newHarness();
        const erin = linked(test, 'erin-dev', 'pid-erin', 'ErinX');
        test.db.User.id.update({ ...test.db.User.id.find(erin.userId)!, avatarCharacterName: 'Kafka', displayedAchievementId: 3 });
        return { test, erin };
    }

    it('the exact username returns one row with the public columns only', () => {
        const { test, erin } = world();
        const rows = shared<UserByUsernameRow>(test, 'view_user_by_username', { username: 'ErinX' });
        expect(rows).toEqual([{ userId: erin.userId, username: 'ErinX', displayName: 'ErinX', avatarCharacterName: 'Kafka', displayedAchievementId: 3 }]);
        expect(keysOf(rows[0])).toEqual(sorted('byUsername'));
    });

    it('a different case, a prefix, a padded name or an unknown name returns [] (the unique index is case-sensitive)', () => {
        const { test } = world();
        for (const username of ['erinx', 'ERINX', 'Erin', 'ErinX ', 'nobody', '']) {
            expect(shared(test, 'view_user_by_username', { username }), JSON.stringify(username)).toEqual([]);
        }
    });

    it('a soft-deleted user (banned: deletedAt set, archive pending) returns []', () => {
        const { test } = world();
        const boss = verified(test, 'boss');
        setRole(test, boss.userId, 'Admin');
        tx(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId: 'pid-erin', reason: 'abuse' }));
        expect(test.db.User.username.find('ErinX')!.deletedAt).toBeDefined();
        expect(shared(test, 'view_user_by_username', { username: 'ErinX' })).toEqual([]);
    });
});

describe('view_user_achievements(userId) (S9b-V3, A43, A40)', () => {
    it('lists { achievementId, awardedAt } for the user, no awarder and no audit column; a user with none and an unknown id read []', () => {
        const test = newHarness();
        const mod = moderator(test, 'amod');
        const winner = verified(test, 'winner');
        const other = verified(test, 'other');
        const ach = createAchievement(test, mod, 'Hand picked', true);
        tx(test, mod, (ctx) => M.manual_award_achievement(ctx, { achievementId: ach, targetUserId: winner.userId }));
        const award = [...test.db.UserAchievement.by_user.filter(winner.userId)][0];
        const rows = shared<UserAchievementViewRow>(test, 'view_user_achievements', { userId: winner.userId });
        expect(rows).toEqual([{ achievementId: ach, awardedAt: award.createdDate }]);
        expect(keysOf(rows[0])).toEqual(sorted('userAchievement'));
        expect(shared(test, 'view_user_achievements', { userId: other.userId })).toEqual([]);
        expect(shared(test, 'view_user_achievements', { userId: 999_999 })).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Stats and MMR (S9b-V4; A40, A44(1) D1)
// ════════════════════════════════════════════════════════════════════════════

describe('view_my_mmr_ratings (S9b-V4)', () => {
    it('one row per mode and season for the caller, wins summed from the season + mode PlayerStat rows; another user\'s ratings never appear', () => {
        const test = newHarness();
        const a = guest(test, 'mmr-a');
        const b = guest(test, 'mmr-b');
        seedRating(test, a.userId, 1300, { matchesPlayed: 4 });
        seedRating(test, a.userId, 1100, { matchesPlayed: 2, gameMode: AS });
        seedRating(test, b.userId, 1700, { matchesPlayed: 9 });
        seedStat(test, a.userId, 2, { draftMode: 'Classic' });
        seedStat(test, a.userId, 1, { draftMode: 'Auction' });
        seedStat(test, a.userId, 1, { gameMode: AS });
        seedStat(test, a.userId, 7, { seasonId: 3 }); // another season: not summed
        const rows = view<MyMmrRatingRow>(test, 'view_my_mmr_ratings', a);
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('mmr'));
        expect(rows.find((r) => r.gameMode.tag === 'MemoryOfChaos')).toMatchObject({ seasonId: 0, rating: 1300, matchesPlayed: 4, wins: 3 });
        expect(rows.find((r) => r.gameMode.tag === 'ApocalypticShadow')).toMatchObject({ seasonId: 0, rating: 1100, matchesPlayed: 2, wins: 1 });
        const stored = [...test.db.MmrRating.user_id.filter(a.userId)].find((r) => r.gameMode.tag === 'MemoryOfChaos')!;
        expect(rows.find((r) => r.gameMode.tag === 'MemoryOfChaos')!.lastUpdatedAt).toEqual(stored.lastModifiedDate);
        expect(rows.some((r) => r.rating === 1700)).toBe(false);
        expect(view<MyMmrRatingRow>(test, 'view_my_mmr_ratings', b).map((r) => r.rating)).toEqual([1700]);
    });

    it('MmrRating stays private: no client table in the bindings (only the view); Leaderboard is the public table', () => {
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('mmrRating');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('mmr_rating');
        expectTypeOf<typeof bindingTables>().toHaveProperty('viewMyMmrRatings');
        expectTypeOf<typeof bindingTables>().toHaveProperty('leaderboard');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('playerStat');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('playerRelationship');
    });
});

describe('view_my_player_stats / view_my_character_stats (S9b-V4)', () => {
    it('after an anonymous match: the caller\'s own rows only, without userId and without audit columns', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { lobby: ANON });
        finishGame(s, 'Blue');
        const stats = view<MyPlayerStatRow>(test, 'view_my_player_stats', s.a.r1);
        expect(stats).toHaveLength([...test.db.PlayerStat.by_user.filter(s.a.r1.userId)].length);
        expect(stats).toHaveLength(1);
        expect(stats[0]).toMatchObject({ matchesPlayed: 1, wins: 0, losses: 1 });
        expect(keysOf(stats[0])).toEqual(sorted('playerStat'));
        const chars = view<MyCharacterStatRow>(test, 'view_my_character_stats', s.a.r1);
        expect(chars.length).toBeGreaterThan(0);
        expect(chars).toHaveLength([...test.db.PlayerCharacterStat.by_user.filter(s.a.r1.userId)].length);
        for (const r of chars) expect(keysOf(r)).toEqual(sorted('charStat'));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Public aggregates: top-20 leaderboard and the SYSTEM actor (A44(2), A45(1), A37; S9b-A1)
// ════════════════════════════════════════════════════════════════════════════

describe('Leaderboard top 20 and the SYSTEM audit actor on public aggregates (A44(2), A45(1), A37, S9b-A1)', () => {
    type Seed = { userId: number; rating: number; wins: number };
    /**
     * 24 rated users (matchesPlayed 5, pre-season, Memory of Chaos, globalCompositeRating = rating) in six groups of four
     * equal ratings; inside a group two users have 3 wins and two have 1, so every tie-break level is exercised.
     * Inserted in a scrambled user-id order. Plus two users above everyone with matchesPlayed 1 (below D-46's minimum).
     */
    function seed24(test: Harness): Seed[] {
        const seeds: Seed[] = [];
        const order = [17, 3, 22, 9, 0, 14, 6, 20, 11, 1, 19, 8, 23, 4, 15, 12, 2, 21, 7, 16, 10, 5, 18, 13];
        for (const i of order) {
            const s = { userId: 5000 + ((i * 7) % 24), rating: 1600 - 25 * Math.floor(i / 4), wins: i % 4 < 2 ? 3 : 1 };
            seedRating(test, s.userId, s.rating, { global: s.rating });
            seedStat(test, s.userId, s.wins);
            seeds.push(s);
        }
        seedRating(test, 6001, 1999, { matchesPlayed: 1, global: 1999 });
        seedRating(test, 6002, 1998, { matchesPlayed: 1, global: 1998 });
        return seeds;
    }
    const expectedTop = (seeds: Seed[]) =>
        [...seeds].sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.userId - b.userId).slice(0, 20);
    const category = (test: Harness, c: string) =>
        [...test.db.Leaderboard.iter()].filter((r) => r.category === c).sort((a, b) => a.rank - b.rank);

    it('a ranked anonymous match conceded by a player: exactly 20 rows per category, ordered by rating desc, wins desc, user id asc; every Leaderboard and GlobalCharacterStat row stamped SYSTEM', () => {
        const test = newHarness();
        seedElo(test);
        const seeds = seed24(test);
        const s = scoringOf(test, '', { lobby: { ...ANON, refereeExclusiveConcede: false }, beforeStart: makeRanked(test) });
        const finalizer = s.a.r1; // a player of an anonymous lobby
        tx(test, finalizer, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 }));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy(); // finalized inline (standalone concede)

        expect(LEADERBOARD_MAX_ENTRIES).toBe(20);
        const top = expectedTop(seeds);
        for (const c of ['MemoryOfChaos', 'Global']) {
            const rows = category(test, c);
            expect(rows, c).toHaveLength(20);
            expect(rows.map((r) => r.rank), c).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
            expect(rows.map((r) => r.userId), c).toEqual(top.map((t) => t.userId));
            expect(rows.map((r) => r.rating), c).toEqual(top.map((t) => t.rating));
            expect(rows.map((r) => r.wins), c).toEqual(top.map((t) => t.wins));
        }
        const board = [...test.db.Leaderboard.iter()];
        expect(board.some((r) => r.userId === 6001 || r.userId === 6002)).toBe(false); // D-46 minimum matches
        for (const r of board) {
            expect([r.createdById, r.lastModifiedById], `Leaderboard ${r.category} #${r.rank}`).toEqual([SYSTEM_USER_ID, SYSTEM_USER_ID]);
        }
        // non-vacuous: the private per-player rows of the same finalization do carry the conceding player as actor
        expect([...test.db.PlayerStat.by_user.filter(finalizer.userId)].some((r) => r.lastModifiedById === finalizer.userId)).toBe(true);
        const global = [...test.db.GlobalCharacterStat.iter()];
        expect(global.length).toBeGreaterThan(0);
        for (const r of global) {
            expect([r.createdById, r.lastModifiedById], `GlobalCharacterStat ${r.characterName}`).toEqual([SYSTEM_USER_ID, SYSTEM_USER_ID]);
        }
    });

    it('direct helper call (rebuildLeaderboard is exported): a second rebuild replaces the season\'s rows (still 20, no duplicate), other seasons untouched', () => {
        const test = newHarness();
        const seeds = seed24(test);
        seedRating(test, 7000, 1500, { seasonId: 9, global: 1500 });
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 9));
        expect(category(test, 'MemoryOfChaos').map((r) => r.userId)).toEqual([7000]);
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
        const moc = category(test, 'MemoryOfChaos');
        expect(moc.filter((r) => r.seasonId === 0)).toHaveLength(20);
        expect(moc.filter((r) => r.seasonId === 9).map((r) => r.userId)).toEqual([7000]);
        expect(moc.filter((r) => r.seasonId === 0).map((r) => r.userId)).toEqual(expectedTop(seeds).map((t) => t.userId));
        expect(category(test, 'ApocalypticShadow')).toEqual([]);
    });

    it('auto-awards after a match closed by a seated player-referee carry SYSTEM as awardedById and audit actor; a manual award keeps the Moderator\'s id', () => {
        const test = newHarness();
        const mod = moderator(test, 'awardmod');
        const auto = createAchievement(test, mod, 'First match', false);
        tx(test, mod, (ctx) => M.add_achievement_criteria(ctx, {
            achievementId: auto, statTable: 'PlayerStat', statField: 'matchesPlayed', operator: { tag: 'GreaterOrEqual' } as any,
            thresholdValue: 1, filterGameMode: undefined, filterCharacterName: undefined, filterMatchType: undefined,
        }));
        const s = playToScoring(test, {
            lobby: ANON, hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        finishGame(s, 'Blue'); // the host (a Blue player and the lobby referee) closes the game: the finalizing user
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        const awards = [...test.db.UserAchievement.by_achievement.filter(auto)];
        expect(awards.map((a) => a.userId).sort((x, y) => x - y)).toEqual([s.host, s.a.b1, s.a.r1, s.a.r2].map((a) => a.userId).sort((x, y) => x - y));
        for (const a of awards) {
            expect([a.awardedById, a.createdById, a.lastModifiedById], `award of #${a.userId}`).toEqual([SYSTEM_USER_ID, SYSTEM_USER_ID, SYSTEM_USER_ID]);
        }
        for (const r of test.db.GlobalCharacterStat.iter()) {
            expect([r.createdById, r.lastModifiedById], `GlobalCharacterStat ${r.characterName}`).toEqual([SYSTEM_USER_ID, SYSTEM_USER_ID]);
        }

        const manual = createAchievement(test, mod, 'Hand picked', true);
        tx(test, mod, (ctx) => M.manual_award_achievement(ctx, { achievementId: manual, targetUserId: s.a.r1.userId }));
        const [m] = [...test.db.UserAchievement.by_achievement.filter(manual)];
        expect([m.awardedById, m.createdById, m.lastModifiedById]).toEqual([mod.userId, mod.userId, mod.userId]);
        // the public view lists both titles of r1 without the awarder
        const rows = shared<UserAchievementViewRow>(test, 'view_user_achievements', { userId: s.a.r1.userId });
        expect(rows.map((r) => r.achievementId).sort()).toEqual([auto, manual].sort());
        for (const r of rows) expect('awardedById' in r).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Relationships (S9b-V5; PAGE-MAP D2, A40 CH-M1)
// ════════════════════════════════════════════════════════════════════════════

describe('view_my_relationships (S9b-V5)', () => {
    function world() {
        const test = newHarness();
        seedElo(test); // initialRating 1000 for a mode never played
        const s = scoringOf(test, '', {
            lobby: ANON,
            beforeStart: (l) => {
                for (const n of ['b1', 'b2', 'r2']) {
                    test.db.User.id.update({ ...test.db.User.id.find(l.a[n].userId)!, avatarCharacterName: `avatar-${n}`, displayedAchievementId: 5 });
                }
            },
        });
        finishGame(s, 'Blue');
        seedRating(test, s.a.b2.userId, 1450);
        return { test, s };
    }

    it('the caller\'s rows carry the other player\'s id, name, avatar, title and MMR per mode (no User subscription needed); no userId, no audit columns', () => {
        const { test, s } = world();
        const rows = view<MyRelationshipRow>(test, 'view_my_relationships', s.a.r1);
        expect(rows.map((r) => r.otherUserId).sort((x, y) => x - y)).toEqual([s.a.b1, s.a.b2, s.a.r2].map((a) => a.userId).sort((x, y) => x - y));
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('relationship'));
        const b1 = rows.find((r) => r.otherUserId === s.a.b1.userId)!;
        expect(b1).toMatchObject({
            otherDisplayName: displayName(test, s.a.b1), otherAvatarCharacterName: 'avatar-b1', otherDisplayedAchievementId: 5,
            otherMmrByMode: [1000, 1000, 1000], matchesAsOpponent: 1, winsAsOpponent: 0, matchesAsAlly: 0,
        });
        expect(rows.find((r) => r.otherUserId === s.a.b2.userId)!.otherMmrByMode).toEqual([1450, 1000, 1000]);
        expect(rows.find((r) => r.otherUserId === s.a.r2.userId)).toMatchObject({ matchesAsAlly: 1, winsAsAlly: 0, matchesAsOpponent: 0 });
        // the other side reads its own rows only
        expect(view<MyRelationshipRow>(test, 'view_my_relationships', s.a.b1).some((r) => r.otherUserId === s.a.b1.userId)).toBe(false);
    });

    it('after the other player deletes their account: the archived name, no avatar, title or MMR', () => {
        const { test, s } = world();
        const name = displayName(test, s.a.b1);
        tx(test, s.a.b1, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(s.a.b1.userId)).toBeFalsy();
        const row = view<MyRelationshipRow>(test, 'view_my_relationships', s.a.r1).find((r) => r.otherUserId === s.a.b1.userId)!;
        expect(row).toBeDefined();
        expect(row).toMatchObject({ otherDisplayName: name, otherAvatarCharacterName: undefined, otherDisplayedAchievementId: undefined, otherMmrByMode: undefined });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Roster visibility (S9b-V6, S9b-A3; A37, A40, D-14, D-71)
// ════════════════════════════════════════════════════════════════════════════

describe('view_my_roster_visibility (S9b-V6, S9b-A3)', () => {
    /** An anonymous-players Waiting lobby (verified host = the spectator referee; D-23 would force ClosedNoRating on a guest host). */
    function world(rosterVisibility: 'OpenRoster' | 'ClosedWithRating' | 'ClosedNoRating', opts: SetupOpts = {}) {
        const test = newHarness();
        const s = setupLobby(test, {
            lobby: { ...ANON, rosterVisibility: { tag: rosterVisibility } },
            noStart: true,
            actors: { host: verified(test, 'rvhost') },
            ...opts,
        });
        expect(lobbyRow(test, s.lobbyId).rosterVisibility.tag).toBe(rosterVisibility);
        const acc: Record<string, number> = {};
        for (const n of ['b1', 'b2', 'r1', 'r2']) acc[n] = selectAccount(test, s.lobbyId, s.a[n], `${n}-acc`, 1000 + n.charCodeAt(1), [`${n}-c1`, `${n}-c2`]);
        const rows = (who: Reader) => view<RosterVisibilityRow>(test, 'view_my_roster_visibility', who);
        const joinSeq = (who: Actor) => member(test, s.lobbyId, who.userId).joinSeq;
        return { test, s, acc, rows, joinSeq };
    }

    it('OpenRoster: an anonymized opponent\'s characters, eidolons and rating arrive with memberUserId 0, hsrAccountId 0 and the joinSeq; own and teammate rows carry real ids', () => {
        const { test, s, acc, rows, joinSeq } = world('OpenRoster');
        const r = rows(s.a.r1);
        for (const row of r) expect(keysOf(row)).toEqual(sorted('rosterVisibility'));
        for (const opp of ['b1', 'b2']) {
            const oppRows = r.filter((x) => x.joinSeq === joinSeq(s.a[opp]));
            expect(oppRows.map((x) => x.characterName).sort(), opp).toEqual([`${opp}-c1`, `${opp}-c2`]);
            for (const x of oppRows) {
                expect(x).toMatchObject({ lobbyId: s.lobbyId, memberUserId: 0, hsrAccountId: 0, accountRating: test.db.HsrAccount.id.find(acc[opp])!.accountRating });
            }
        }
        expect(r.filter((x) => x.memberUserId === s.a.r1.userId && x.hsrAccountId === acc.r1)).toHaveLength(2);
        expect(r.filter((x) => x.memberUserId === s.a.r2.userId && x.hsrAccountId === acc.r2)).toHaveLength(2);
        expect(r.filter((x) => [s.a.b1.userId, s.a.b2.userId].includes(x.memberUserId))).toEqual([]);
        expect(r.filter((x) => [acc.b1, acc.b2].includes(x.hsrAccountId))).toEqual([]);
    });

    it('ClosedWithRating: one rating-only row per selected account of an anonymized opponent (characterName \'\', eidolonLevel 0, ids 0)', () => {
        const { s, rows, joinSeq } = world('ClosedWithRating');
        const r = rows(s.a.r1);
        const b1 = r.filter((x) => x.joinSeq === joinSeq(s.a.b1));
        expect(b1).toEqual([{ lobbyId: s.lobbyId, joinSeq: joinSeq(s.a.b1), memberUserId: 0, hsrAccountId: 0, characterName: '', eidolonLevel: 0, accountRating: 1000 + 'b1'.charCodeAt(1) }]);
        expect(r.filter((x) => x.memberUserId === s.a.r2.userId)).toHaveLength(2); // teammate: full roster (D-70)
    });

    it('ClosedNoRating: nothing of the opponents; the teammate\'s roster stays', () => {
        const { s, rows, joinSeq } = world('ClosedNoRating');
        const r = rows(s.a.r1);
        expect(r.filter((x) => x.joinSeq === joinSeq(s.a.b1) || x.joinSeq === joinSeq(s.a.b2))).toEqual([]);
        expect(r.filter((x) => x.memberUserId === s.a.r2.userId)).toHaveLength(2);
    });

    it('the spectator referee (D-14, D-71) sees every roster with real ids, even under ClosedNoRating', () => {
        const { s, acc, rows } = world('ClosedNoRating');
        const r = rows(s.host);
        for (const n of ['b1', 'b2', 'r1', 'r2']) {
            expect(r.filter((x) => x.memberUserId === s.a[n].userId && x.hsrAccountId === acc[n]), n).toHaveLength(2);
        }
        expect(r.some((x) => x.memberUserId === 0)).toBe(false);
    });

    it('a seated player-referee sees every roster (D-14) but anonymized opponents\' ids stay 0 (D-71)', () => {
        const test = newHarness();
        const host = verified(test, 'seatref');
        const s = setupLobby(test, {
            lobby: { ...ANON, rosterVisibility: { tag: 'ClosedNoRating' } }, noStart: true, hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']], actors: { host },
        });
        const accR1 = selectAccount(test, s.lobbyId, s.a.r1, 'r1-acc', 1200, ['r1-c1']);
        const r = view<RosterVisibilityRow>(test, 'view_my_roster_visibility', host);
        const r1 = r.filter((x) => x.joinSeq === member(test, s.lobbyId, s.a.r1.userId).joinSeq);
        expect(r1).toHaveLength(1);
        expect(r1[0]).toMatchObject({ characterName: 'r1-c1', memberUserId: 0, hsrAccountId: 0 });
        expect(r.some((x) => x.memberUserId === s.a.r1.userId || x.hsrAccountId === accR1)).toBe(false);
    });
});

describe('view_my_roster (unchanged in S9b)', () => {
    it('the caller\'s accounts and characters only, the documented columns', () => {
        const test = newHarness();
        const a = guest(test, 'ra');
        const b = guest(test, 'rb');
        addAccount(test, a.userId, 'ra-acc', { chars: ['x', 'y'] });
        addAccount(test, b.userId, 'rb-acc', { chars: ['z'] });
        const rows = view<MyRosterAccountRow>(test, 'view_my_roster', a);
        expect(rows.map((r) => r.characterName).sort()).toEqual(['x', 'y']);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('myRoster'));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Public rosters (S9b-V7; S3 hand-off, A40 residual risk)
// ════════════════════════════════════════════════════════════════════════════

describe('view_public_hsr_accounts (S9b-V7)', () => {
    it('with accounts of mixed visibility: only public rosters, one row per character, the owner identified, the rating only when isRatingPublic; a private roster is absent', () => {
        const test = newHarness();
        const ann = guest(test, 'ann');
        const bob = guest(test, 'bob');
        const cid = guest(test, 'cid');
        const pub = addAccount(test, ann.userId, 'ann-pub', { rating: 1500, chars: ['Kafka', 'Seele'] });
        const bare = addAccount(test, bob.userId, 'bob-bare', { rating: 900, isRatingPublic: false });
        const priv = addAccount(test, cid.userId, 'cid-priv', { rating: 1700, chars: ['Acheron'], isRosterPublic: false });
        addAccount(test, ann.userId, 'ann-priv', { rating: 1100, chars: ['Bronya'], isRosterPublic: false, isRatingPublic: true });
        const rows = shared<PublicHsrAccountRow>(test, 'view_public_hsr_accounts');
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('publicAccount'));
        expect(rows.filter((r) => r.accountId === pub).map((r) => [r.userId, r.characterName, r.eidolonLevel, r.accountRating]).sort())
            .toEqual([[ann.userId, 'Kafka', 0, 1500], [ann.userId, 'Seele', 1, 1500]]);
        expect(rows.filter((r) => r.accountId === bare)).toEqual([{
            accountId: bare, userId: bob.userId, uid: 'bob-bare', region: 'eu', displayLabel: 'bob-bare', accountRating: undefined,
            characterName: undefined, eidolonLevel: undefined,
        }]);
        expect(rows.map((r) => r.accountId).sort((x, y) => x - y)).toEqual([pub, pub, bare].sort((x, y) => x - y));
        expect(rows.some((r) => r.userId === cid.userId)).toBe(false);

        // the owner opts in: the row appears (the index follows the update)
        test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(priv)!, isRosterPublic: true });
        expect(shared<PublicHsrAccountRow>(test, 'view_public_hsr_accounts').filter((r) => r.accountId === priv).map((r) => r.characterName)).toEqual(['Acheron']);
    });

    it('the HsrAccount.is_roster_public index exists (the view reads it; that no scan runs is the review / grep gate)', () => {
        const test = newHarness();
        expectTypeOf(test.db.HsrAccount).toHaveProperty('is_roster_public');
        expect(typeof (test.db.HsrAccount as any).is_roster_public.filter).toBe('function');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Calendar (S9b-C1..C4, S9b-V8; A37 calendar contexts, A45(4))
// ════════════════════════════════════════════════════════════════════════════

describe('calendar views (S9b-C1..C3, S9b-V8)', () => {
    /**
     * Carol organizes E1 inviting Dave and Gina; Dave organizes E2; the organizer created E3 for the bracket match of
     * Dave's team; Erin organizes E4, Frank E5; Dave saved Erin's calendar (shown) and Frank's (hidden). Slots: Dave 1,
     * Erin 2, Frank 1.
     */
    function world() {
        const f = duel();
        const { test, org } = f;
        const dave = f.ts[0].captain;
        const opponent = f.ts[1].captain;
        const [carol, erin, frank, gina, outsider] = ['carol', 'erin', 'frank', 'gina', 'calout'].map((n) => verified(test, n));
        test.db.User.id.update({ ...test.db.User.id.find(erin.userId)!, avatarCharacterName: 'Kafka' });
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const e1 = createEvent(test, carol, 'E1', [dave, gina]);
        const e2 = createEvent(test, dave, 'E2');
        const e3 = createEvent(test, org, 'E3', [], m.id);
        const e4 = createEvent(test, erin, 'E4');
        const e5 = createEvent(test, frank, 'E5');
        saveCalendar(test, dave, erin);
        saveCalendar(test, dave, frank);
        showCalendar(test, dave, frank, false);
        addSlot(test, dave, 30);
        addSlot(test, erin, 30);
        addSlot(test, erin, 40);
        addSlot(test, frank, 30);
        const events = (who: Reader) => view<MyCalendarEventRow>(test, 'view_my_calendar_events', who);
        const invites = (who: Reader) => view<MyCalendarInviteRow>(test, 'view_my_calendar_invites', who);
        return { f, test, org, m, dave, opponent, carol, erin, frank, gina, outsider, e1, e2, e3, e4, e5, events, invites };
    }
    const key = (eventId: number, userId: number) => (BigInt(eventId) << 32n) | BigInt(userId);

    it('S9b-C1: Dave reads E1..E4 once each with the organizer\'s name, not E5; the documented columns; an outsider reads none', () => {
        const w = world();
        const rows = w.events(w.dave);
        expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([w.e1, w.e2, w.e3, w.e4].sort((a, b) => a - b));
        const organizerOf: Record<number, Actor> = { [w.e1]: w.carol, [w.e2]: w.dave, [w.e3]: w.org, [w.e4]: w.erin };
        for (const r of rows) {
            expect(keysOf(r)).toEqual(sorted('calEvent'));
            expect(r.organizerId).toBe(organizerOf[r.id].userId);
            expect(r.organizerLabel).toBe(displayName(w.test, organizerOf[r.id]));
        }
        expect(rows.find((r) => r.id === w.e3)!.bracketMatchId).toBe(w.m.id);
        expect(rows.find((r) => r.id === w.e1)!.description).toBe('E1 notes');
        expect(w.events(w.outsider)).toEqual([]);
    });

    it('S9b-C1: the tournament-linked event is visible to both teams\' members, and stays visible to Dave once his invite row is removed', () => {
        const w = world();
        expect(w.events(w.opponent).map((r) => r.id)).toContain(w.e3);
        expect(w.events(w.f.ts[0].mate).map((r) => r.id)).toContain(w.e3);
        tx(w.test, w.org, (ctx) => M.remove_invite(ctx, { eventId: w.e3, inviteeUserId: w.dave.userId }));
        expect([...w.test.db.CalendarEventInvite.by_event_and_invitee.filter([w.e3, w.dave.userId])]).toEqual([]);
        expect(w.events(w.dave).filter((r) => r.id === w.e3)).toHaveLength(1);
    });

    it('S9b-C3: showing Frank\'s calendar again sends his events and slots', () => {
        const w = world();
        showCalendar(w.test, w.dave, w.frank, true);
        expect(w.events(w.dave).map((r) => r.id)).toContain(w.e5);
        expect(view<SavedCalendarAvailabilityRow>(w.test, 'view_saved_calendar_availability', w.dave).some((r) => r.userId === w.frank.userId)).toBe(true);
    });

    it('S9b-C2: Dave reads his own invites with the inviter\'s name, never another invitee\'s; Carol reads every invite of E1; a response updates the row in place', () => {
        const w = world();
        const mine = w.invites(w.dave);
        for (const r of mine) expect(keysOf(r)).toEqual(sorted('calInvite'));
        expect(mine.every((r) => r.inviteeUserId === w.dave.userId)).toBe(true); // no other invitee id (Gina, the opponent team)
        const e1 = mine.find((r) => r.eventId === w.e1)!;
        expect(e1).toMatchObject({
            inviteKey: key(w.e1, w.dave.userId), inviteeLabel: displayName(w.test, w.dave), inviteStatus: { tag: 'Pending' },
            respondedAt: undefined, inviterLabel: displayName(w.test, w.carol),
        });
        expect(mine.find((r) => r.eventId === w.e3)!.inviterLabel).toBe(displayName(w.test, w.org));

        const carols = w.invites(w.carol).filter((r) => r.eventId === w.e1);
        expect(carols.map((r) => [r.inviteeUserId, r.inviteeLabel]).sort()).toEqual(
            [[w.dave.userId, displayName(w.test, w.dave)], [w.gina.userId, displayName(w.test, w.gina)]].sort());

        tx(w.test, w.dave, (ctx) => M.respond_to_invite(ctx, { eventId: w.e1, status: 'Accepted' }));
        const after = w.invites(w.dave).find((r) => r.eventId === w.e1)!;
        expect(after.inviteKey).toBe(key(w.e1, w.dave.userId));
        expect(after.inviteStatus.tag).toBe('Accepted');
        expect(after.respondedAt).toBeDefined();
        expect(w.invites(w.carol).find((r) => r.inviteKey === key(w.e1, w.dave.userId))!.inviteStatus.tag).toBe('Accepted');
        expect(w.invites(w.gina).map((r) => r.inviteeUserId)).toEqual([w.gina.userId]);
        expect(w.invites(w.outsider)).toEqual([]);
    });

    it('S9b-C3: own slots; Erin\'s slots with her id and name, none of Frank\'s (hidden); both bookmarks with label, avatar and isVisible', () => {
        const w = world();
        const own = view<MyAvailabilityRow>(w.test, 'view_my_availability', w.dave);
        expect(own).toHaveLength(1);
        expect(keysOf(own[0])).toEqual(sorted('availability'));
        expect(own[0].id).toBe([...w.test.db.AvailabilitySlot.user_id.filter(w.dave.userId)][0].id);

        const saved = view<SavedCalendarAvailabilityRow>(w.test, 'view_saved_calendar_availability', w.dave);
        expect(saved).toHaveLength(2);
        for (const r of saved) {
            expect(keysOf(r)).toEqual(sorted('savedAvailability'));
            expect(r).toMatchObject({ userId: w.erin.userId, userLabel: displayName(w.test, w.erin) });
        }

        const marks = view<MySavedCalendarRow>(w.test, 'view_my_saved_calendars', w.dave);
        for (const r of marks) expect(keysOf(r)).toEqual(sorted('savedCalendar'));
        expect(marks.sort((a, b) => a.targetUserId - b.targetUserId)).toEqual([
            { targetUserId: w.erin.userId, targetLabel: displayName(w.test, w.erin), targetAvatarCharacterName: 'Kafka', isVisible: true },
            { targetUserId: w.frank.userId, targetLabel: displayName(w.test, w.frank), targetAvatarCharacterName: test_avatar(w.test, w.frank), isVisible: false },
        ].sort((a, b) => a.targetUserId - b.targetUserId));
        // Erin did not save Dave: nothing flows the other way
        expect(view(w.test, 'view_saved_calendar_availability', w.erin)).toEqual([]);
    });

    it('no calendar row carries an audit column, and the only user ids are the ones the contract names (organizer, own invitee id / organizer\'s invitees, saved target)', () => {
        const w = world();
        const names = ['view_my_calendar_events', 'view_my_calendar_invites', 'view_my_availability', 'view_saved_calendar_availability', 'view_my_saved_calendars'];
        for (const name of names) {
            for (const r of view(w.test, name, w.dave)) expect(noAudit(r), name).toEqual([]);
        }
        const allowed = new Set([w.dave, w.carol, w.org, w.erin, w.frank].map((a) => a.userId));
        for (const r of w.events(w.dave)) expect(allowed.has(r.organizerId)).toBe(true);
        expect(w.invites(w.dave).map((r) => r.inviteeUserId).every((id) => id === w.dave.userId)).toBe(true);
    });
});

const test_avatar = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.avatarCharacterName;

// ════════════════════════════════════════════════════════════════════════════
// Admin views (S9b-AD1..AD3, S9b-V9; §A.4 P4, PAGE-MAP D6, A42, A48)
// ════════════════════════════════════════════════════════════════════════════

describe('admin views (S9b-AD1..AD3, S9b-V9)', () => {
    function world() {
        const test = newHarness();
        const mod = moderator(test, 'amod');
        const admin = verified(test, 'aadmin');
        setRole(test, admin.userId, 'Admin');
        const player = verified(test, 'aplayer');
        // a provider ban (soft-deletes the banned user)
        const bannee = linked(test, 'bannee-dev', 'pid-bannee', 'Bannee');
        tx(test, admin, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId: 'pid-bannee', reason: 'cheating' }));
        // a verified user who deletes their account → DeletedUser archive
        const leaver = verified(test, 'aleaver');
        tx(test, leaver, (ctx) => M.delete_my_account(ctx, {}));
        // one user on two devices (A48): connect both, close one
        const d1 = linked(test, 'dev-1', 'pid-dev', 'Dev');
        const d2 = linked(test, 'dev-2', 'pid-dev', 'Dev');
        expect(d2.userId).toBe(d1.userId);
        connect(test, d1);
        connect(test, d2);
        disconnect(test, d2);
        // a lobby ban in an anonymous lobby
        const l = setupLobby(test, { lobby: ANON, seats: seatsOf('L'), actors: { host: guest(test, 'Lhost') }, noStart: true });
        const lb = guest(test, 'Lbanned');
        tx(test, lb, (ctx) => M.join_lobby(ctx, { lobbyId: l.lobbyId, joinCode: '', password: '' }));
        tx(test, l.host, (ctx) => M.ban_member(ctx, { lobbyId: l.lobbyId, targetUserId: lb.userId }));
        return { test, mod, admin, player, bannee, leaver, d1, d2, l, lb, outsider: guest(test, 'aout') };
    }
    const ALL = ['view_admin_user_identities', 'view_admin_ban_records', 'view_admin_deleted_users', 'view_admin_presence',
        'view_admin_lobby_bans', 'view_admin_abuse_config', 'view_admin_user_private'];

    it('S9b-AD1: a Moderator and an Admin read rows from every admin view; a User, a guest and an unmapped identity read []', () => {
        const w = world();
        for (const name of ALL) {
            expect(view(w.test, name, w.mod).length, `${name}: Moderator`).toBeGreaterThan(0);
            expect(view(w.test, name, w.admin), `${name}: Admin`).toEqual(view(w.test, name, w.mod));
            expect(view(w.test, name, w.player), `${name}: User`).toEqual([]);
            expect(view(w.test, name, w.outsider), `${name}: guest`).toEqual([]);
            expect(view(w.test, name, ghost()), `${name}: unmapped`).toEqual([]);
        }
    });

    it('view_admin_user_identities: every identity mapping (both devices of one user), no kind column', () => {
        const w = world();
        const rows = view<AdminUserIdentityRow>(w.test, 'view_admin_user_identities', w.mod);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('adminIdentity'));
        const devs = rows.filter((r) => r.userId === w.d1.userId).map((r) => r.identity.toHexString()).sort();
        expect(devs).toEqual([w.d1.identity.toHexString(), w.d2.identity.toHexString()].sort());
        expect(rows).toHaveLength(Number(w.test.db.UserIdentity.count()));
    });

    it('view_admin_ban_records: the provider ban with the banning admin\'s id and label', () => {
        const w = world();
        const rows = view<AdminBanRecordRow>(w.test, 'view_admin_ban_records', w.mod);
        expect(rows).toHaveLength(1);
        expect(keysOf(rows[0])).toEqual(sorted('adminBan'));
        expect(rows[0]).toMatchObject({ loginMethod: 'discord', providerId: 'pid-bannee', reason: 'cheating', bannedByUserId: w.admin.userId, bannedByLabel: displayName(w.test, w.admin) });
    });

    it('view_admin_deleted_users: the archived user', () => {
        const w = world();
        const rows = view<AdminDeletedUserRow>(w.test, 'view_admin_deleted_users', w.mod);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('adminDeleted'));
        expect(rows.find((r) => r.id === w.leaver.userId)).toMatchObject({ displayName: 'aleaver', isGuest: false });
    });

    it('S9b-AD2: view_admin_presence has one row per device; closing one device leaves the user online on the other (A48)', () => {
        const w = world();
        const rows = view<AdminPresenceRow>(w.test, 'view_admin_presence', w.mod);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('adminPresence'));
        const dev = rows.filter((r) => r.userId === w.d1.userId);
        expect(dev).toHaveLength(2);
        expect(dev.find((r) => r.identity.toHexString() === w.d1.identity.toHexString())!.isOnline).toBe(true);
        expect(dev.find((r) => r.identity.toHexString() === w.d2.identity.toHexString())!.isOnline).toBe(false);
        expect(dev.some((r) => r.isOnline)).toBe(true); // the panel counts the user online
        disconnect(w.test, w.d1);
        expect(view<AdminPresenceRow>(w.test, 'view_admin_presence', w.mod).filter((r) => r.userId === w.d1.userId).some((r) => r.isOnline)).toBe(false);
    });

    it('view_admin_lobby_bans: staff read the real ids and names in an anonymous lobby', () => {
        const w = world();
        const rows = view<AdminLobbyBanRow>(w.test, 'view_admin_lobby_bans', w.mod);
        expect(rows).toHaveLength(1);
        expect(keysOf(rows[0])).toEqual(sorted('adminLobbyBan'));
        expect(rows[0]).toMatchObject({
            lobbyId: w.l.lobbyId, bannedUserId: w.lb.userId, bannedUserLabel: displayName(w.test, w.lb),
            bannedByUserId: w.l.host.userId, bannedByLabel: displayName(w.test, w.l.host),
        });
    });

    it('S9b-AD3: an Admin turns the guest kill switch off; the row updates in place without audit columns; a Moderator sees it but cannot change it', () => {
        const w = world();
        const [before] = view<AdminAbuseConfigRow>(w.test, 'view_admin_abuse_config', w.mod);
        expect(keysOf(before)).toEqual(sorted('adminAbuse'));
        expect(before).toMatchObject({ id: 1, guestLobbyCreationEnabled: true });
        expect(() => tx(w.test, w.mod, (ctx) => M.admin_set_guest_lobby_creation(ctx, { enabled: false }))).toThrow();
        expect(view<AdminAbuseConfigRow>(w.test, 'view_admin_abuse_config', w.mod)[0].guestLobbyCreationEnabled).toBe(true);
        tx(w.test, w.admin, (ctx) => M.admin_set_guest_lobby_creation(ctx, { enabled: false }));
        const after = view<AdminAbuseConfigRow>(w.test, 'view_admin_abuse_config', w.mod);
        expect(after).toHaveLength(1);
        expect(after[0]).toEqual({ ...before, guestLobbyCreationEnabled: false });
    });

    it('view_admin_user_private (unchanged behaviour): every provider link, the documented columns, Moderator+ only', () => {
        const w = world();
        const rows = view<AdminUserPrivateRow>(w.test, 'view_admin_user_private', w.mod);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('adminUserPrivate'));
        expect(rows.find((r) => r.providerId === 'pid-dev')).toMatchObject({ userId: w.d1.userId, loginMethod: 'discord', providerUsername: 'Dev' });
        expect(rows.find((r) => r.providerId === 'pid-bannee')).toMatchObject({ userId: w.bannee.userId });
        expect(rows).toHaveLength(Number(w.test.db.UserPrivate.count()));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Egress: the type-level column lists of every new / changed S9b row type
// ════════════════════════════════════════════════════════════════════════════

describe('egress: S9b row types equal the documented column lists (bindings)', () => {
    it('keyof Row === documented columns', () => {
        expectTypeOf<keyof MyIdentityRow>().toEqualTypeOf<Cols<'identity'>>();
        expectTypeOf<keyof MyProfileRow>().toEqualTypeOf<Cols<'profile'>>();
        expectTypeOf<keyof UserByUsernameRow>().toEqualTypeOf<Cols<'byUsername'>>();
        expectTypeOf<keyof UserAchievementViewRow>().toEqualTypeOf<Cols<'userAchievement'>>();
        expectTypeOf<keyof MyPlayerStatRow>().toEqualTypeOf<Cols<'playerStat'>>();
        expectTypeOf<keyof MyCharacterStatRow>().toEqualTypeOf<Cols<'charStat'>>();
        expectTypeOf<keyof MyMmrRatingRow>().toEqualTypeOf<Cols<'mmr'>>();
        expectTypeOf<keyof MyRelationshipRow>().toEqualTypeOf<Cols<'relationship'>>();
        expectTypeOf<keyof RosterVisibilityRow>().toEqualTypeOf<Cols<'rosterVisibility'>>();
        expectTypeOf<keyof MyRosterAccountRow>().toEqualTypeOf<Cols<'myRoster'>>();
        expectTypeOf<keyof PublicHsrAccountRow>().toEqualTypeOf<Cols<'publicAccount'>>();
        expectTypeOf<keyof MyCalendarEventRow>().toEqualTypeOf<Cols<'calEvent'>>();
        expectTypeOf<keyof MyCalendarInviteRow>().toEqualTypeOf<Cols<'calInvite'>>();
        expectTypeOf<keyof MyAvailabilityRow>().toEqualTypeOf<Cols<'availability'>>();
        expectTypeOf<keyof SavedCalendarAvailabilityRow>().toEqualTypeOf<Cols<'savedAvailability'>>();
        expectTypeOf<keyof MySavedCalendarRow>().toEqualTypeOf<Cols<'savedCalendar'>>();
        expectTypeOf<keyof AdminUserIdentityRow>().toEqualTypeOf<Cols<'adminIdentity'>>();
        expectTypeOf<keyof AdminBanRecordRow>().toEqualTypeOf<Cols<'adminBan'>>();
        expectTypeOf<keyof AdminDeletedUserRow>().toEqualTypeOf<Cols<'adminDeleted'>>();
        expectTypeOf<keyof AdminPresenceRow>().toEqualTypeOf<Cols<'adminPresence'>>();
        expectTypeOf<keyof AdminLobbyBanRow>().toEqualTypeOf<Cols<'adminLobbyBan'>>();
        expectTypeOf<keyof AdminAbuseConfigRow>().toEqualTypeOf<Cols<'adminAbuse'>>();
        expectTypeOf<keyof AdminUserPrivateRow>().toEqualTypeOf<Cols<'adminUserPrivate'>>();
    });

    it('the S9b views are registered on the module and in the bindings; the trimmed admin views are not', () => {
        for (const name of ['view_user_by_username', 'view_user_achievements', 'view_my_mmr_ratings', 'view_my_calendar_events',
            'view_my_calendar_invites', 'view_my_availability', 'view_saved_calendar_availability', 'view_my_saved_calendars',
            'view_admin_user_identities', 'view_admin_ban_records', 'view_admin_deleted_users', 'view_admin_presence',
            'view_admin_lobby_bans', 'view_admin_abuse_config']) {
            expect(typeof (M as any)[name], name).toBe('function');
        }
        expectTypeOf<typeof M>().not.toHaveProperty('view_admin_lobbies');
        expectTypeOf<typeof M>().not.toHaveProperty('view_admin_match_results');
        expectTypeOf<typeof M>().not.toHaveProperty('view_admin_match_history');
        expectTypeOf<typeof bindingTables>().toHaveProperty('viewUserByUsername');
        expectTypeOf<typeof bindingTables>().toHaveProperty('viewAdminAbuseConfig');
    });
});

// ─── Not drivable in memory ──────────────────────────────────────────────────

describe('S9b: outside the in-memory harness', () => {
    it.todo('A37 / T-S11: a real client subscribed as an outsider to the S9b views receives no row (subscription-level; live residue on test1)');
    it.todo('arg views over the wire: `SELECT * FROM view_user_by_username(\'<name>\')` / `view_user_achievements(<id>)` subscription syntax and per-argument sharing (live residue, S11)');
    it.todo('index-only bodies (no `.iter()` in views, view_public_hsr_accounts through is_roster_public): a source property, left to the orchestrator grep gate and the review');
    it.todo('PAGE-MAP D2: no page except the admin Users tab subscribes `User` (client behaviour, CI grep, M6 / S14)');
    it.todo('S10: live suites auth-views / auth-subscriptions / auth-security (profile shape), mmr-stats (top 20), achievement-management (awardedById) rewritten against the S9b rows');
});
