// Tournaments: a deleted or banned organizer is replaced, or a server deletion cancels the unfinished tournaments.
// Decisions: A94, A121, A124
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10s, S10q (s10s-triage-fixes.test.ts, s10q-gap-coverage.test.ts).
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import {
    M,
    advance,
    disconnect,
    expectReject,
    guest,
    newHarness,
    now,
    tx,
    type Actor,
    type Harness,
} from '../fixtures/harness';
import {
    AUDIT,
    advanceStage,
    assignAssistant,
    createTournament,
    enrollMany,
    enrolled,
    host,
    openTournament,
    register,
    setUserRole,
    tRow,
    updateBody,
    verified,
} from '../fixtures/tournament-builders';
import {
    byKey,
    createTournamentLobby,
    duel,
    playMatch,
} from '../fixtures/tournament-match-builders';
import { DAY_MS, createEvent, rejection } from '../fixtures/calendar-roster-rating-builders';
import { fireDeletionJob, providerOf } from '../fixtures/achievement-auth-cost-builders';
import { existingUser, signIn } from '../fixtures/guest-sign-in-builders';

const assistantsOf = (test: Harness, tournamentId: number) =>
    [...test.db.TournamentAssistant.tournament_id.filter(tournamentId)].map((a) => a.userId).sort((a, b) => a - b);

/** admin_delete_row('User') by `boss` and the scheduled run_user_deletion fired by hand. */
function adminDelete(test: Harness, boss: Actor, who: Actor) {
    tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(who.userId) }));
    fireDeletionJob(test, who.userId);
}

/** admin_ban_user on the user's Discord id by `by` (an Admin, or 'internal' = the SYSTEM user) and the deletion job. */
function ban(test: Harness, by: Actor | 'internal', who: Actor) {
    const providerId = providerOf(test, who)!;
    tx(test, by, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId, reason: 'test' }));
    fireDeletionJob(test, who.userId);
}


// ════════════════════════════════════════════════════════════════════════════
// L70 / A121: a new organizer when staff delete or ban the organizer
// ════════════════════════════════════════════════════════════════════════════

describe('A121, L70: a tournament whose organizer is deleted or banned by staff gets a new organizer', () => {
    it('A121 L70: an admin deletion hands the tournament to the longest-serving assistant holding all three permissions; that row is removed', () => {
        const test = newHarness();
        const org = host(test);
        const boss = admin(test);
        const id = openTournament(test, org);
        const partial = verified(test, 'partial');
        const first = verified(test, 'first');
        const second = verified(test, 'second');
        assignAssistant(test, org, id, partial, { participants: true, bracket: true }); // oldest, but not all three
        advance(test, 1_000);
        assignAssistant(test, org, id, first, { participants: true, bracket: true, results: true });
        advance(test, 1_000);
        assignAssistant(test, org, id, second, { participants: true, bracket: true, results: true });
        const done = openTournament(test, org, { name: 'Done cup' });
        tx(test, org, (ctx) => M.cancel_tournament(ctx, { tournamentId: done }));

        adminDelete(test, boss, org);
        expect(tRow(test, id).organizerId).toBe(first.userId);
        expect(assistantsOf(test, id)).toEqual([partial.userId, second.userId].sort((a, b) => a - b));
        expect(tRow(test, done).organizerId).toBe(org.userId); // a Cancelled tournament keeps its row as it was
    });

    it('A121 L70: a ban with no full assistant makes the acting Admin the organizer; the linked calendar event moves to them', () => {
        const f = duel();
        const { test, org } = f;
        const boss = admin(test);
        const partial = verified(test, 'partial');
        assignAssistant(test, org, f.id, partial, { results: true });
        const m = byKey(test, f.id, 'W-R1-M1');
        const eventId = createEvent(test, org, { bracketMatchId: m.id });

        ban(test, boss, org);
        expect(tRow(test, f.id).organizerId).toBe(boss.userId);
        expect(test.db.CalendarEvent.id.find(eventId)?.organizerId).toBe(boss.userId);
        expect(assistantsOf(test, f.id)).toEqual([partial.userId]);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
        // the new organizer holds the owner permission: in InProgress the stage refuses the settings change, not the permission
        expect(rejection(test, boss, updateBody(test, f.id, {}))).toBe('Tournament settings can only change before Seeding.');
    });

    // S10s fix pass (F13): the heir filters and an heir who also plays.
    it('A121 L70 (F13): a guest assistant, an assistant pending deletion and a partial one are skipped; equal dates go to the lower user id; an heir enrolled as a player keeps the enrolment', () => {
        const test = newHarness();
        const org = host(test);
        const boss = admin(test);
        const id = openTournament(test, org);
        const ghost = guest(test, 'ghost');            // a guest assistant row (A113(6) refuses it today; a legacy row)
        const pending = verified(test, 'pending');     // full permissions, pending deletion
        const partial = verified(test, 'partial');
        const low = verified(test, 'low');             // created before `high`: the lower user id
        const high = verified(test, 'high');
        expect(low.userId).toBeLessThan(high.userId);
        const fullRow = (userId: number) => ({
            id: 0, tournamentId: id, userId, canManageParticipants: true, canManageBracket: true, canResolveResults: true, ...AUDIT(test),
        });
        test.db.TournamentAssistant.insert(fullRow(ghost.userId));
        advance(test, 1_000);
        assignAssistant(test, org, id, pending, { participants: true, bracket: true, results: true });
        test.db.User.id.update({ ...test.db.User.id.find(pending.userId)!, deletedAt: test.clock.now() });
        advance(test, 1_000);
        assignAssistant(test, org, id, partial, { participants: true, results: true });
        advance(test, 1_000);
        assignAssistant(test, org, id, high, { participants: true, bracket: true, results: true }); // same instant
        assignAssistant(test, org, id, low, { participants: true, bracket: true, results: true });
        register(test, low, id); // the heir also plays

        adminDelete(test, boss, org);
        expect(tRow(test, id).organizerId).toBe(low.userId);
        expect(assistantsOf(test, id)).not.toContain(low.userId);
        expect(enrolled(test, id, low.userId)).toBeDefined();
        expect(assistantsOf(test, id)).toEqual([ghost.userId, pending.userId, partial.userId, high.userId].sort((a, b) => a - b));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A124: a server deletion of an organizer cancels the tournament
// ════════════════════════════════════════════════════════════════════════════

describe('A124: a server deletion or ban of an organizer cancels the unfinished tournaments', () => {
    it('A124: server_delete_user cancels a tournament in Registration through the cancel path; no assistant takes over; a Completed one is untouched', () => {
        const f = duel();
        const { test, org } = f;
        playMatch(f, byKey(test, f.id, 'W-R1-M1').id, 'Blue');
        advanceStage(test, org, f.id, 'Completed');
        const reg = openTournament(test, org, { name: 'Open cup' });
        const helper = verified(test, 'helper');
        assignAssistant(test, org, reg, helper, { participants: true, bracket: true, results: true });
        const [p] = enrollMany(test, reg, 1, 'reg');

        const username = test.db.User.id.find(org.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(tRow(test, reg).stage.tag).toBe('Cancelled');
        expect(tRow(test, reg).organizerId).toBe(org.userId); // no hand-over on this path
        expect(assistantsOf(test, reg)).toEqual([helper.userId]); // the cancel keeps the staff rows (display)
        expect(enrolled(test, reg, p.userId)).toBeDefined();      // and the enrolments (audit trail)
        expect([...test.db.TournamentFinalizeJob.tournament_id.filter(reg)]).toHaveLength(1); // the A24(5) job started
        expect(tRow(test, f.id).stage.tag).toBe('Completed');
    });

    it('A124: a ban sent as the SYSTEM user (Owner or Delegate) cancels a live tournament: its open lobby is voided and its match event deleted', () => {
        const f = duel();
        const { test, org } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const eventId = createEvent(test, org, { bracketMatchId: m.id });
        const lobbyId = createTournamentLobby(test, org, m.id);
        expect(test.db.Lobby.id.find(lobbyId)).toBeTruthy();

        ban(test, 'internal', org);
        expect(tRow(test, f.id).stage.tag).toBe('Cancelled');
        expect(test.db.Lobby.id.find(lobbyId)).toBeFalsy();
        expect(test.db.CalendarEvent.id.find(eventId)).toBeFalsy();
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
    });

    it('A124 (neighbour): an Admin\'s ban still hands the tournament over (A121), it is not cancelled', () => {
        const test = newHarness();
        const org = host(test);
        const boss = admin(test);
        const id = openTournament(test, org);
        ban(test, boss, org);
        expect(tRow(test, id).stage.tag).toBe('Registration');
        expect(tRow(test, id).organizerId).toBe(boss.userId);
    });
});

const ORGANIZER_DELETE_TEXT = 'You organize a tournament that has not finished. Cancel it, or wait until it ends, before deleting your account.';

/** A verified Admin (role written on the row). */
function admin(test: Harness, name = 'boss'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

/** admin_delete_row('User') by `by` ('internal' = the SYSTEM user) and the scheduled run_user_deletion fired by hand. */
function adminDeleteUser(test: Harness, by: Actor | 'internal', who: Actor) {
    tx(test, by, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(who.userId) }));
    fireDeletionJob(test, who.userId);
}

// ════════════════════════════════════════════════════════════════════════════
// Gap 8. A124 (S10s re-review N5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 8, A124: server deletions cancel; identity GC and server_link_provider do not (S10s re-review N5)', () => {
    it('A124 (N5: a Draft tournament): server_delete_user of its organizer cancels a tournament still in Draft; no assistant takes over', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org);
        const helper = verified(test, 'helper');
        assignAssistant(test, org, id, helper, { participants: true, bracket: true, results: true });
        expect(tRow(test, id).stage.tag).toBe('Draft');
        const username = test.db.User.id.find(org.userId)!.username;

        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));

        expect(tRow(test, id).stage.tag).toBe('Cancelled');
        expect(tRow(test, id).organizerId).toBe(org.userId);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
    });

    it('A124 (N5: admin_delete_row as SYSTEM): admin_delete_row(\'User\') sent by the Owner identity (the SYSTEM user) cancels the organizer\'s tournament in Registration; the full assistant does not take over', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const helper = verified(test, 'helper');
        assignAssistant(test, org, id, helper, { participants: true, bracket: true, results: true });

        adminDeleteUser(test, 'internal', org);

        expect(tRow(test, id).stage.tag).toBe('Cancelled');
        expect(tRow(test, id).organizerId).toBe(org.userId);
        expect([...test.db.TournamentAssistant.tournament_id.filter(id)].map((a) => a.userId)).toEqual([helper.userId]);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
    });

    /** A tournament in Registration whose organizerId is a guest (engineered: a guest cannot be a Tournament Host). */
    function guestOrganized(test: Harness, sub: string) {
        const org = host(test, `${sub}-creator`);
        const id = openTournament(test, org, { name: `${sub} cup` } as any);
        const g = guest(test, sub);
        test.db.Tournament.id.update({ ...tRow(test, id), organizerId: g.userId });
        return { id, g };
    }

    it('pins current behaviour (row silent): A124 (N5: identity GC): the scheduled identity clean-up deletes an idle guest organizer; the tournament is not cancelled and keeps its organizer id', () => {
        const test = newHarness();
        const { id, g } = guestOrganized(test, 'gc-org');
        disconnect(test, g); // the guest closed the tab (presence offline), as s10h's idle guests
        advance(test, 31 * DAY_MS);
        tx(test, 'internal', (ctx) => M.run_identity_gc(ctx, { arg: { scheduledId: 1n, scheduledAt: ScheduleAt.time(now(test)) } as any }));

        expect(test.db.User.id.find(g.userId)).toBeFalsy();
        expect(tRow(test, id).stage.tag).toBe('Registration');
        expect(tRow(test, id).organizerId).toBe(g.userId);
    });

    it('pins current behaviour (row silent): A124 (N5: server_link_provider): a guest organizer signing in to an existing account is deleted; the tournament is not cancelled and keeps the guest\'s organizer id', () => {
        const test = newHarness();
        const { id, g } = guestOrganized(test, 'link-org');
        const e = existingUser(test, 'e-link-org');

        const guestId = signIn(test, g, e.providerId);

        expect(test.db.User.id.find(guestId)).toBeFalsy();
        expect(tRow(test, id).stage.tag).toBe('Registration');
        expect(tRow(test, id).organizerId).toBe(guestId);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 10. A121 with A94(1)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 10, A121: the new organizer is bound by A94(1) (S10s review, "side effects to know")', () => {
    it('A121, A94(1): the assistant who took over cannot delete their own account while the tournament is unfinished; once they cancel it, the deletion goes through', () => {
        const test = newHarness();
        const org = host(test);
        const boss = admin(test);
        const id = openTournament(test, org);
        const heir = verified(test, 'heir');
        assignAssistant(test, org, id, heir, { participants: true, bracket: true, results: true });
        adminDeleteUser(test, boss, org);
        expect(tRow(test, id).organizerId).toBe(heir.userId);

        expectReject(test, heir, (ctx) => M.delete_my_account(ctx, {}), ORGANIZER_DELETE_TEXT);
        expect(test.db.User.id.find(heir.userId)).toBeTruthy();

        tx(test, heir, (ctx) => M.cancel_tournament(ctx, { tournamentId: id }));
        tx(test, heir, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(heir.userId)).toBeFalsy();
    });
});
