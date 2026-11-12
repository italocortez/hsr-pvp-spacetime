// Admin: maintenance mode lets only Admins in and stops every other user's actions.
// Decisions: A163(3), A42 (AbuseConfig), triage L9
// Contracts: docs/admin/contract.md
// From S11a (rulings pass).
//
// T-S11a rulings pass (A163(3), triage L9): while AbuseConfig.maintenanceMode is on, client_connected admits server
// identities and identities of a live Admin user, and refuses everyone else as before. A non-Admin who is still
// connected is refused on every state-changing reducer with MAINTENANCE_TEXT (getAuthenticatedUser, plus profile.ts
// resolveUser and login_as_guest); broadcast_cursor drops the call silently. Server-identity reducers and scheduled
// reducers keep running. Turning the mode off restores everything. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import { MAINTENANCE_TEXT } from '@module/helpers/identity/ensurePermissions';
import { DEFAULT_LOBBY_ARGS, M, advance, connect, now, rejection, setupLobby, tx, type Actor, type Ctx, type Harness } from '../fixtures/harness';
import { admin, moderator } from '../fixtures/identity';
import { at } from '../fixtures/calendar';
import { duel } from '../fixtures/tournament-matches';

const CONNECT_REFUSED = 'Maintenance mode: connections are not accepted right now.';

const setMaintenance = (test: Harness, who: Actor, on: boolean) =>
    tx(test, who, (ctx) => M.admin_update_abuse_config(ctx, { maintenanceMode: on } as any));

/** A tournament (duel, in progress), a live lobby (Drafting) and an Admin, Moderator and normal user. */
function world() {
    const f = duel();
    const test = f.test;
    const s = setupLobby(test);
    const boss = admin(test, 'mmboss');
    const mod = moderator(test, 'mmmod');
    const user = s.a.b1; // a normal user seated in the live lobby
    return { f, test, s, boss, mod, user };
}

/** A sample of state-changing reducers per domain, as `user` would call them. */
function samples(w: ReturnType<typeof world>): Array<[string, (ctx: Ctx) => unknown]> {
    const lobbyId = w.s.lobbyId;
    return [
        ['lobby: create_lobby', (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any)],
        ['lobby: send_chat_message', (ctx) => M.send_chat_message(ctx, { lobbyId, content: 'hi', metadata: '' })],
        ['lobby: leave_lobby', (ctx) => M.leave_lobby(ctx, { lobbyId })],
        ['draft: pick_character', (ctx) => M.pick_character(ctx, { lobbyId, characterName: 'Kafka', eidolon: 0 })],
        ['draft: pause_draft', (ctx) => M.pause_draft(ctx, { lobbyId } as any)],
        ['results: concede_match', (ctx) => M.concede_match(ctx, { lobbyId, losingTeamSide: 0 })],
        ['tournament: register_for_tournament', (ctx) => M.register_for_tournament(ctx, { tournamentId: w.f.id } as any)],
        ['tournament: create_tournament_team', (ctx) => M.create_tournament_team(ctx, { tournamentId: w.f.id, name: 'Team' } as any)],
        ['calendar: create_availability_slot', (ctx) => M.create_availability_slot(ctx, { startAt: at(w.test, 1), endAt: at(w.test, 2), kind: 'Available' })],
        ['calendar: create_calendar_event', (ctx) => M.create_calendar_event(ctx, { title: 'T', description: '', startAt: at(w.test, 24), endAt: at(w.test, 25), bracketMatchId: 0, inviteeUserIds: '' } as any)],
        ['roster: create_hsr_account', (ctx) => M.create_hsr_account(ctx, { uid: '800000001', displayLabel: 'Main' })],
        ['identity: update_display_name', (ctx) => M.update_display_name(ctx, { newDisplayName: 'New name' })],
        ['identity: update_avatar', (ctx) => M.update_avatar(ctx, { characterName: 'Kafka' })],
        ['identity: delete_my_account', (ctx) => M.delete_my_account(ctx, {})],
        ['identity: login_as_guest', (ctx) => M.login_as_guest(ctx, {})],
        ['stats: set_displayed_achievement', (ctx) => M.set_displayed_achievement(ctx, { achievementId: undefined } as any)],
    ];
}

describe('A163(3): connecting while maintenance mode is on', () => {
    it('an Admin connects; a Moderator and a normal user are refused at connect', () => {
        const w = world();
        setMaintenance(w.test, w.boss, true);
        connect(w.test, w.boss);
        expect(rejection(w.test, w.mod, (ctx) => M.client_connected(ctx, {}))).toBe(CONNECT_REFUSED);
        expect(rejection(w.test, w.user, (ctx) => M.client_connected(ctx, {}))).toBe(CONNECT_REFUSED);
    });

    it('an Admin pending deletion is refused at connect', () => {
        const w = world();
        const other = admin(w.test, 'mmgone'); // created before the mode is on (login_as_guest is refused after)
        setMaintenance(w.test, w.boss, true);
        w.test.db.User.id.update({ ...w.test.db.User.id.find(other.userId)!, deletedAt: w.test.clock.now() });
        expect(rejection(w.test, other, (ctx) => M.client_connected(ctx, {}))).toBe(CONNECT_REFUSED);
    });
});

describe('A163(3): acting while maintenance mode is on', () => {
    it('a connected normal user is refused on a sample of reducers from each domain with one text; nothing changes', () => {
        const w = world();
        setMaintenance(w.test, w.boss, true);
        for (const [name, call] of samples(w)) {
            expect(rejection(w.test, w.user, call), name).toBe(MAINTENANCE_TEXT);
        }
        // the user still exists, still sits in the lobby
        expect(w.test.db.User.id.find(w.user.userId)).not.toBeNull();
        expect([...w.test.db.LobbyMember.by_lobby_and_user.filter([w.s.lobbyId, w.user.userId])]).toHaveLength(1);
    });

    it('a connected Moderator is refused too, on a Moderator tool as well', () => {
        const w = world();
        setMaintenance(w.test, w.boss, true);
        expect(rejection(w.test, w.mod, (ctx) => M.admin_gc_lobbies(ctx, {}))).toBe(MAINTENANCE_TEXT);
        expect(rejection(w.test, w.mod, (ctx) => M.update_display_name(ctx, { newDisplayName: 'Mod name' }))).toBe(MAINTENANCE_TEXT);
    });

    it('broadcast_cursor of a non-Admin is dropped silently (no event, no stamp)', () => {
        const w = world();
        setMaintenance(w.test, w.boss, true);
        const n = tx(w.test, w.user, (ctx) => {
            M.broadcast_cursor(ctx, { lobbyId: w.s.lobbyId, x: 0.5, y: 0.5 });
            return [...ctx.db.LobbyCursorEvent.iter()].length;
        });
        expect(n).toBe(0);
    });

    it('an Admin acts: creates a lobby, renames themself, turns the mode off', () => {
        const w = world();
        setMaintenance(w.test, w.boss, true);
        tx(w.test, w.boss, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any));
        expect([...w.test.db.Lobby.host_user_id.filter(w.boss.userId)]).toHaveLength(1);
        tx(w.test, w.boss, (ctx) => M.update_display_name(ctx, { newDisplayName: 'Boss' }));
        expect(w.test.db.User.id.find(w.boss.userId)!.displayName).toBe('Boss');
        setMaintenance(w.test, w.boss, false);
        expect(w.test.db.AbuseConfig.id.find(1)!.maintenanceMode).toBe(false);
    });

    it('server-identity reducers and scheduled reducers keep running', () => {
        const w = world();
        setMaintenance(w.test, w.boss, true);
        const username = w.test.db.User.id.find(w.mod.userId)!.username;
        tx(w.test, 'internal', (ctx) => M.server_set_role(ctx, { username, roleTag: 'TournamentHost' }));
        expect(w.test.db.User.id.find(w.mod.userId)!.role.tag).toBe('TournamentHost');
        const jobs = [...w.test.db.LobbyGcJob.iter()];
        for (const j of jobs) w.test.db.LobbyGcJob.scheduledId.delete(j.scheduledId);
        const arg = jobs[0] ?? { scheduledId: 1n, scheduledAt: ScheduleAt.time(now(w.test)) };
        tx(w.test, 'internal', (ctx) => M.run_lobby_gc(ctx, { arg } as any));
    });
});

describe('A163(3): turning maintenance mode off restores everything', () => {
    it('the Moderator and the user connect again and act', () => {
        const w = world();
        setMaintenance(w.test, w.boss, true);
        expect(rejection(w.test, w.user, (ctx) => M.update_display_name(ctx, { newDisplayName: 'Later' }))).toBe(MAINTENANCE_TEXT);
        setMaintenance(w.test, w.boss, false);
        connect(w.test, w.mod);
        connect(w.test, w.user);
        advance(w.test, 1000);
        tx(w.test, w.user, (ctx) => M.send_chat_message(ctx, { lobbyId: w.s.lobbyId, content: 'back', metadata: '' }));
        tx(w.test, w.user, (ctx) => M.update_display_name(ctx, { newDisplayName: 'Later' }));
        expect(w.test.db.User.id.find(w.user.userId)!.displayName).toBe('Later');
        tx(w.test, w.mod, (ctx) => M.update_display_name(ctx, { newDisplayName: 'Mod name' }));
    });
});
