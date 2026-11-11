// Views: the profile, user, achievement, rating, stats, leaderboard and relationship views and their egress.
// Decisions: A37, A40, A43, A44, A45
// Contracts: docs/views/contract.md
// From S9b (s9b-views.test.ts).
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
    AdminAbuseConfigRow,
    AdminBanRecordRow,
    AdminDeletedUserRow,
    AdminLobbyBanRow,
    AdminPresenceRow,
    AdminUserIdentityRow,
    AdminUserPrivateRow,
    AdminUserRow,
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
import {
    LEADERBOARD_MAX_ENTRIES,
    rebuildLeaderboard,
} from '@module/helpers/stats/leaderboardRebuild';
import {
    M,
    SYSTEM_USER_ID,
    guest,
    newHarness,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    AUDIT,
} from '../fixtures/harness';
import { moderator, verified, seedUserRow, displayName, linked } from '../fixtures/identity';
import { createAchievement } from '../fixtures/achievements';
import { addSlotAt, createTitledEvent, saveCalendar } from '../fixtures/calendar';
import { finishGame, playToScoring, setRole } from '../fixtures/draft-and-scoring';
import {
    ANON,
    AUDIT_KEYS,
    profileGhost as ghost,
    keysOf,
    seatsOf,
    selectRatedAccount,
    shared,
    sorted,
    view,
    type Reader,
    scoringOf,
    makeRanked,
    type Cols,
} from '../fixtures/views';
import { seedElo } from '../fixtures/tournament-matches';

const MOC = { tag: 'MemoryOfChaos' } as any;
const AS = { tag: 'ApocalypticShadow' } as any;

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
        selectRatedAccount(test, r.lobbyId, r.a.vb1, 'vb1-acc', 1100, ['vb1-char']);
        const carol = verified(test, 'carol');
        const dave = verified(test, 'dave');
        createTitledEvent(test, carol, 'E1', [dave]);
        addSlotAt(test, dave, 30);
        addSlotAt(test, carol, 30);
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

    it('a verified user: loginMethod / providerId / providerUsername from the User row (A46; A77: UserPrivate merged, row shape kept, hasDiscordLinked derived); role and title from User', () => {
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
            seedUserRow(test, s.userId); // T-S10f (results audit #9): only users with a live User row are ranked
            seedRating(test, s.userId, s.rating, { global: s.rating });
            seedStat(test, s.userId, s.wins);
            seeds.push(s);
        }
        seedUserRow(test, 6001);
        seedUserRow(test, 6002);
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
        seedUserRow(test, 7000); // T-S10f (results audit #9)
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
        expectTypeOf<keyof AdminUserRow>().toEqualTypeOf<Cols<'adminUser'>>(); // T-S11a (A77(1))
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
