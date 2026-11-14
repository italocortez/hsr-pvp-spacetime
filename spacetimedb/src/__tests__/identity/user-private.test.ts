// Identity: the private User table (UserPrivate merged into it) and what the views deliver instead.
// Decisions: A77 (PAGE-MAP D2, D6), A44(1)
// Contracts: docs/auth/contract.md, docs/views/contract.md
//
// T-S11a (A77): `User` is private (no client subscription, no generated accessor) and holds the provider columns that
// UserPrivate held. No view gives a non-staff reader another user's provider link, role, guest flag, deletion state or
// link time; the names and avatars the views delivered before still arrive; the admin Users tab reads view_admin_users
// (Moderator+); the public leaderboard carries the player's name and avatar (A77(1), denormalized columns). In-memory
// only; nothing reaches maincloud.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { discordId } from '../fixtures/harness'; // T-M5a3: valid Discord ids from labels
import type { tables as bindingTables } from '@bindings/index';
import type { AdminUserRow } from '@bindings/types';
import { rebuildLeaderboard } from '@module/helpers/stats/leaderboardRebuild';
import { AUDIT, DEFAULT_LOBBY_ARGS as LOBBY, M, guest, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import { admin, linked, moderator, verified } from '../fixtures/identity';
import { insertCharacter } from '../fixtures/draft-and-scoring';
import { createTitledEvent, saveCalendar } from '../fixtures/calendar';
import { join } from '../fixtures/lobby';
import { keysOf, profileGhost, sorted, view, type Reader } from '../fixtures/views';

const SECRET_PROVIDER_ID = discordId('pid-SECRET-a77');
const SECRET_PROVIDER_NAME = 'SecretProviderName';
/** Keys that carry what A77 hides; only view_my_profile (the caller's own row) and the staff views may hold them. */
const PRIVATE_KEYS = ['loginMethod', 'providerId', 'providerUsername', 'linkedAt', 'hasDiscordLinked', 'role', 'isGuest', 'deletedAt'];
const OWN_ROW_VIEWS = new Set(['view_my_profile']);

const jsonOf = (rows: unknown) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** Every view the module exports (the barrel re-exports each one, SKILL "Views require export to register"). */
const VIEW_NAMES = Object.keys(M).filter((k) => k.startsWith('view_')).sort();

/** One argument set that fits every view with arguments (extra keys are ignored by the others). */
function argsFor(o: { username: string; userId: number; eventId: number; tournamentId: number }) {
    return {
        username: o.username, userId: o.userId, eventId: o.eventId, tournamentId: o.tournamentId, costSetId: 0,
        matchHistoryId: 1, page: 0, gameMode: '', draftMode: '', matchType: '',
    };
}

/**
 * The victim: a verified user with a distinctive provider link, then renamed (username and display name) so neither
 * equals the provider name. They host a Waiting lobby the readers join, organize a personal event inviting the
 * verified reader, and the verified reader saves their calendar.
 */
function world() {
    const test = newHarness();
    insertCharacter(test, 'Kafka', 5);
    const victim = linked(test, 'victim-dev', SECRET_PROVIDER_ID, SECRET_PROVIDER_NAME);
    tx(test, victim, (ctx) => M.update_username(ctx, { newUsername: 'victim_uid' }));
    tx(test, victim, (ctx) => M.update_display_name(ctx, { newDisplayName: 'Shown Name' }));
    tx(test, victim, (ctx) => M.update_avatar(ctx, { characterName: 'Kafka' }));
    const reader = verified(test, 'reader');
    const visitor = guest(test, 'visitor');
    tx(test, victim, (ctx) => M.create_lobby(ctx, { ...LOBBY } as any));
    const lobbyId = [...test.db.Lobby.iter()].find((l) => l.hostUserId === victim.userId)!.id;
    join(test, reader, lobbyId);
    join(test, visitor, lobbyId);
    const eventId = createTitledEvent(test, victim, 'Tea', [reader]);
    saveCalendar(test, reader, victim);
    tx(test, reader, (ctx) => M.toggle_calendar_visibility(ctx, { targetUserId: victim.userId, isVisible: true }));
    const args = argsFor({ username: 'victim_uid', userId: victim.userId, eventId, tournamentId: 1 });
    return { test, victim, reader, visitor, lobbyId, eventId, args };
}


/** Reads `name` as `who`: per-sender views through a view context, the anonymous ones through the shared context. */
function readAs(test: Harness, name: string, who: Reader, args: Record<string, unknown>): any[] {
    const out = readRaw(test, name, who, args); // view_my_identity returns an option, the others arrays
    return Array.isArray(out) ? out : out == null ? [] : [out];
}
function readRaw(test: Harness, name: string, who: Reader, args: Record<string, unknown>): any {
    try {
        return view(test, name, who, args);
    } catch {
        return (M as any)[name](test.anonymousViewContext(), args) as any[];
    }
}

// ════════════════════════════════════════════════════════════════════════════
// The client surface: no User accessor, the admin view exists
// ════════════════════════════════════════════════════════════════════════════

describe('A77(1): the bindings carry no User or UserPrivate accessor; view_admin_users is generated', () => {
    it('type level: no `user` / `userPrivate` client table, a `viewAdminUsers` view with the documented row', () => {
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('user');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('userPrivate');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('user_private');
        expectTypeOf<typeof bindingTables>().toHaveProperty('viewAdminUsers');
        expectTypeOf<keyof AdminUserRow>().toEqualTypeOf<
            'id' | 'username' | 'displayName' | 'isGuest' | 'role' | 'hasDiscordLinked' | 'avatarCharacterName'
            | 'displayedAchievementId' | 'deletedAt' | 'createdById' | 'createdDate' | 'lastModifiedById' | 'lastModifiedDate'>();
        expect(typeof (M as any).view_admin_users).toBe('function');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// No view gives a non-staff reader what A77 hides
// ════════════════════════════════════════════════════════════════════════════

describe('A77: an outsider, a guest and a normal user reach no private user data through any view', () => {
    it('sweep over every exported view: no row holds the victim\'s provider id or provider name, and no private column outside the reader\'s own profile row', () => {
        const w = world();
        const outsider = verified(w.test, 'outsider');
        const readers: Array<[string, Reader, number | undefined]> = [
            ['verified user (lobby member, invitee, saver)', w.reader, w.reader.userId],
            ['guest (lobby member)', w.visitor, w.visitor.userId],
            ['outsider (verified, no shared context)', outsider, outsider.userId],
            ['unmapped identity', profileGhost(), undefined],
        ];
        expect(VIEW_NAMES.length).toBeGreaterThan(60);
        for (const [label, who, ownId] of readers) {
            for (const name of VIEW_NAMES) {
                const rows = readAs(w.test, name, who, w.args);
                const text = jsonOf(rows);
                expect(text.includes(SECRET_PROVIDER_ID), `${label}: ${name} leaks the provider id`).toBe(false);
                expect(text.includes(SECRET_PROVIDER_NAME), `${label}: ${name} leaks the provider name`).toBe(false);
                for (const row of rows) {
                    if (OWN_ROW_VIEWS.has(name)) {
                        expect(row.id, `${label}: ${name} is the reader's own row`).toBe(ownId);
                        continue;
                    }
                    const leaked = PRIVATE_KEYS.filter((k) => k in row);
                    expect(leaked, `${label}: ${name} carries ${leaked.join(', ')}`).toEqual([]);
                }
            }
        }
    });

    it('the staff views give a non-staff reader nothing; a Moderator reads the victim\'s provider link only through view_admin_user_private', () => {
        const w = world();
        for (const who of [w.reader, w.visitor, profileGhost()]) {
            expect(view(w.test, 'view_admin_users', who)).toEqual([]);
            expect(view(w.test, 'view_admin_user_private', who)).toEqual([]);
        }
        const mod = moderator(w.test, 'a77mod');
        expect(view(w.test, 'view_admin_user_private', mod).find((r: any) => r.userId === w.victim.userId))
            .toEqual({ userId: w.victim.userId, loginMethod: 'discord', providerId: SECRET_PROVIDER_ID, providerUsername: SECRET_PROVIDER_NAME });
        expect(jsonOf(view(w.test, 'view_admin_users', mod)).includes(SECRET_PROVIDER_ID)).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// The names and avatars the views delivered still arrive
// ════════════════════════════════════════════════════════════════════════════

describe('A77 / PAGE-MAP D2: the views still deliver the names and avatars', () => {
    it('lobby members, lobby browser, calendar events, invites, attendees, saved calendars and the exact username search carry the victim\'s display name and avatar', () => {
        const w = world();
        const { test, reader, victim } = w;
        const member = view(test, 'view_my_lobby_members', reader).find((r: any) => r.userId === victim.userId);
        expect(member).toMatchObject({ label: 'Shown Name', avatarCharacterName: 'Kafka' });
        const browser = (M as any).view_lobby_browser(test.anonymousViewContext(), {}).find((r: any) => r.id === w.lobbyId);
        expect(browser.hostLabel).toBe('Shown Name');
        const ev = view(test, 'view_my_calendar_events', reader).find((r: any) => r.id === w.eventId);
        expect(ev).toMatchObject({ organizerId: victim.userId, organizerLabel: 'Shown Name', organizerAvatarCharacterName: 'Kafka' });
        const inv = view(test, 'view_my_calendar_invites', reader).find((r: any) => r.eventId === w.eventId);
        expect(inv).toMatchObject({ inviterLabel: 'Shown Name', inviterAvatarCharacterName: 'Kafka' });
        const att = view(test, 'view_event_attendees', victim, { eventId: w.eventId });
        expect(att).toEqual([expect.objectContaining({ inviteeUserId: reader.userId, inviteeLabel: 'reader' })]);
        expect(view(test, 'view_my_saved_calendars', reader)).toEqual([
            { targetUserId: victim.userId, targetLabel: 'Shown Name', targetAvatarCharacterName: 'Kafka', isVisible: true },
        ]);
        expect((M as any).view_user_by_username(test.anonymousViewContext(), { username: 'victim_uid' })).toEqual([{
            userId: victim.userId, username: 'victim_uid', displayName: 'Shown Name', avatarCharacterName: 'Kafka', displayedAchievementId: undefined,
        }]);
    });

    it('view_my_profile keeps its row shape for the user themself: the provider fields from the User row, hasDiscordLinked derived', () => {
        const w = world();
        const [row] = view(w.test, 'view_my_profile', w.victim);
        expect(row).toMatchObject({
            id: w.victim.userId, username: 'victim_uid', displayName: 'Shown Name', hasDiscordLinked: true, isGuest: false,
            loginMethod: 'discord', providerId: SECRET_PROVIDER_ID, providerUsername: SECRET_PROVIDER_NAME,
        });
        expect('linkedAt' in row).toBe(false);
        const [g] = view(w.test, 'view_my_profile', w.visitor);
        expect(g).toMatchObject({ hasDiscordLinked: false, isGuest: true, loginMethod: undefined, providerId: undefined });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_admin_users (A77(1)): the admin Users tab
// ════════════════════════════════════════════════════════════════════════════

describe('A77(1): view_admin_users for a Moderator and an Admin', () => {
    it('a Moderator and an Admin read every User row with the documented columns; a guest is unlinked; a soft-deleted user shows deletedAt', () => {
        const w = world();
        const mod = moderator(w.test, 'a77mod');
        const boss = admin(w.test, 'a77boss');
        const victimRow = w.test.db.User.id.find(w.victim.userId)!;
        const gone = verified(w.test, 'a77gone'); // in no lobby (a member cannot be deleted)
        tx(w.test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(gone.userId) }));
        for (const staff of [mod, boss]) {
            const rows = view<AdminUserRow>(w.test, 'view_admin_users', staff);
            expect(rows).toHaveLength(Number(w.test.db.User.count()));
            for (const r of rows) expect(keysOf(r)).toEqual(sorted('adminUser'));
            expect(rows.find((r) => r.id === w.victim.userId)).toEqual({
                id: w.victim.userId, username: 'victim_uid', displayName: 'Shown Name', isGuest: false, role: victimRow.role,
                hasDiscordLinked: true, avatarCharacterName: 'Kafka', displayedAchievementId: undefined, deletedAt: undefined,
                createdById: victimRow.createdById, createdDate: victimRow.createdDate,
                lastModifiedById: victimRow.lastModifiedById, lastModifiedDate: victimRow.lastModifiedDate,
            });
            expect(rows.find((r) => r.id === w.visitor.userId)).toMatchObject({ isGuest: true, hasDiscordLinked: false });
            expect(rows.find((r) => r.id === gone.userId)!.deletedAt).toBeDefined();
            expect(rows.find((r) => r.id === staff.userId)!.role.tag).toBe(staff === mod ? 'Moderator' : 'Admin');
        }
    });

    it('a change made through admin_update_user shows in the row (PK id: an update in place)', () => {
        const w = world();
        const boss = admin(w.test, 'a77boss');
        tx(w.test, boss, (ctx) => M.admin_update_user(ctx, { userId: w.victim.userId, displayName: 'Renamed', username: 'victim_uid', roleTag: 'TournamentHost' }));
        const row = view<AdminUserRow>(w.test, 'view_admin_users', boss).find((r) => r.id === w.victim.userId)!;
        expect(row).toMatchObject({ displayName: 'Renamed', role: { tag: 'TournamentHost' } });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// The public leaderboard carries the name and avatar (A77(1): denormalized columns)
// ════════════════════════════════════════════════════════════════════════════

describe('A77(1): Leaderboard rows carry displayName and avatarCharacterName and follow a rename or a new avatar', () => {
    const MOC = { tag: 'MemoryOfChaos' } as any;
    function seedRated(test: Harness, userId: number, rating: number) {
        test.db.MmrRating.insert({ userId, gameMode: MOC, rating, matchesPlayed: 5, globalCompositeRating: rating, seasonId: 0, ...AUDIT(test) } as any);
        test.db.PlayerStat.insert({
            userId, gameMode: MOC, draftMode: { tag: 'Classic' }, matchesPlayed: 5, wins: 3, losses: 2, matchesSpectated: 0,
            seasonId: 0, matchType: { tag: 'Ranked' }, teamSize: 2, ...AUDIT(test),
        } as any);
    }
    const cards = (test: Harness, who: Actor) =>
        [...test.db.Leaderboard.by_user.filter(who.userId)].map((r) => `${r.category}:${r.displayName}:${r.avatarCharacterName}`).sort();

    it('the rebuild writes the card; update_display_name, update_avatar and admin_update_user rewrite it; another player\'s rows are untouched', () => {
        const test = newHarness();
        insertCharacter(test, 'Kafka', 5);
        insertCharacter(test, 'Robin', 5);
        const p = verified(test, 'lbp');
        const q = verified(test, 'lbq');
        seedRated(test, p.userId, 1500);
        seedRated(test, q.userId, 1400);
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
        const avatar = test.db.User.id.find(p.userId)!.avatarCharacterName;
        expect(cards(test, p)).toEqual([`Global:lbp:${avatar}`, `MemoryOfChaos:lbp:${avatar}`]);
        const qBefore = cards(test, q);

        tx(test, p, (ctx) => M.update_display_name(ctx, { newDisplayName: 'Top Player' }));
        expect(cards(test, p)).toEqual([`Global:Top Player:${avatar}`, `MemoryOfChaos:Top Player:${avatar}`]);
        tx(test, p, (ctx) => M.update_avatar(ctx, { characterName: 'Robin' }));
        expect(cards(test, p)).toEqual(['Global:Top Player:Robin', 'MemoryOfChaos:Top Player:Robin']);
        const boss = admin(test, 'lbboss');
        tx(test, boss, (ctx) => M.admin_update_user(ctx, { userId: p.userId, displayName: 'By Admin', username: 'lbp', roleTag: 'User' }));
        expect(cards(test, p)).toEqual(['Global:By Admin:Robin', 'MemoryOfChaos:By Admin:Robin']);
        expect(cards(test, q)).toEqual(qBefore);
        // the rank, rating and audit actor are kept by the rewrite (SYSTEM, A37)
        const top = [...test.db.Leaderboard.by_user.filter(p.userId)].find((r) => r.category === 'MemoryOfChaos')!;
        expect(top).toMatchObject({ rank: 1, rating: 1500, lastModifiedById: 0 });
    });
});
