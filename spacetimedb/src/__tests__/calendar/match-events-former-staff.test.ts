// Calendar: a match event follows the bracket permission; when its organizer loses it, the tournament organizer takes it.
// Decisions: A163(2), A162(1), A157(7)
// Contracts: docs/calendar/contract.md, docs/tournament/contract.md (assistants)
// From S11a (rulings pass).
//
// T-S11a rulings pass (A163(2), review L2): remove_tournament_assistant, assign_tournament_assistant turning the bracket
// flag off, and a demotion below Moderator (admin_update_user, server_set_role) hand every match event of the affected
// tournament(s) that the user organizes, and whose tournament they no longer hold the bracket permission of, to the
// tournament organizer (handOverMatchEventsOfFormerStaff). The new organizer's own invite to such an event is deleted
// (an organizer is never their own invitee); no cap refuses a hand-over; Completed and Cancelled tournaments are handled
// the same way. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import { AUDIT, M, advance, tx, type Actor, type Harness } from '../fixtures/harness';
import { admin, fireDeletionJob, setUserRole, verified } from '../fixtures/identity';
import { createTitledEvent, event, eventsOf, invite, invitesOf } from '../fixtures/calendar';
import { duel } from '../fixtures/tournament-matches';
import { assignAssistant } from '../fixtures/tournaments';

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);
const inviteeIds = (test: Harness, eventId: number) => invitesOf(test, eventId).map((i) => i.inviteeUserId).sort((a, b) => a - b);

/** A duel's final; `creator` (a bracket assistant) schedules its match event; the four team members are invited. */
function world() {
    const f = duel();
    const { test, org } = f;
    const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
    const creator = verified(test, 'mefcreator');
    assignAssistant(test, org, f.id, creator, { bracket: true });
    const id = createTitledEvent(test, creator, 'Final', [], m.id);
    expect(event(test, id)!.organizerId).toBe(creator.userId);
    return { f, test, org, m, creator, id, invitees: inviteeIds(test, id) };
}

function expectHandedTo(test: Harness, id: number, from: Actor, to: Actor, invitees: number[]) {
    const e = event(test, id)!;
    expect(e.organizerId).toBe(to.userId);
    expect(ids(eventsOf(test, from))).not.toContain(id);
    expect(ids(eventsOf(test, to))).toContain(id);
    expect(inviteeIds(test, id)).toEqual(invitees);
}

describe('A163(2): each trigger hands the match event to the tournament organizer', () => {
    it('remove_tournament_assistant: the event goes to the organizer; invites and bracket time are kept; audit actor is the organizer', () => {
        const w = world();
        const scheduledAt = w.test.db.BracketMatch.id.find(w.m.id)!.scheduledAt;
        tx(w.test, w.org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: w.f.id, userId: w.creator.userId }));
        expectHandedTo(w.test, w.id, w.creator, w.org, w.invitees);
        expect(event(w.test, w.id)!.lastModifiedById).toBe(w.org.userId);
        expect(w.test.db.BracketMatch.id.find(w.m.id)!.scheduledAt).toEqual(scheduledAt);
    });

    it('assign_tournament_assistant with the bracket flag turned off: handed over; another flag change that keeps the bracket flag hands nothing', () => {
        const w = world();
        assignAssistant(w.test, w.org, w.f.id, w.creator, { bracket: true, participants: true });
        expect(event(w.test, w.id)!.organizerId).toBe(w.creator.userId);
        assignAssistant(w.test, w.org, w.f.id, w.creator, { participants: true, results: true });
        expectHandedTo(w.test, w.id, w.creator, w.org, w.invitees);
    });

    it('a personal event of the former assistant stays theirs', () => {
        const w = world();
        const personal = createTitledEvent(w.test, w.creator, 'Personal');
        tx(w.test, w.org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: w.f.id, userId: w.creator.userId }));
        expect(event(w.test, personal)!.organizerId).toBe(w.creator.userId);
    });

    it('admin_update_user demotes a Moderator to User: the match events of tournaments where they hold no bracket permission go to each organizer', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const mod = verified(test, 'mefmod');
        setUserRole(test, mod.userId, 'Moderator');
        const id = createTitledEvent(test, mod, 'Final', [], m.id);
        const invitees = inviteeIds(test, id);
        const boss = admin(test, 'mefboss');
        const username = test.db.User.id.find(mod.userId)!.username;
        const displayName = test.db.User.id.find(mod.userId)!.displayName;
        tx(test, boss, (ctx) => M.admin_update_user(ctx, { userId: mod.userId, displayName, username, roleTag: 'User' }));
        expectHandedTo(test, id, mod, org, invitees);
        expect(event(test, id)!.lastModifiedById).toBe(boss.userId);
    });

    it('a demoted Moderator who is a bracket assistant of the tournament keeps the event; an Admin demoted to Moderator keeps it', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const boss = admin(test, 'mefboss');
        const asAssistant = verified(test, 'mefmodassist');
        setUserRole(test, asAssistant.userId, 'Moderator');
        assignAssistant(test, org, f.id, asAssistant, { bracket: true });
        const kept = createTitledEvent(test, asAssistant, 'Kept', [], m.id);
        const u1 = test.db.User.id.find(asAssistant.userId)!;
        tx(test, boss, (ctx) => M.admin_update_user(ctx, { userId: u1.id, displayName: u1.displayName, username: u1.username, roleTag: 'User' }));
        expect(event(test, kept)!.organizerId).toBe(asAssistant.userId);

        tx(test, asAssistant, (ctx) => M.delete_calendar_event(ctx, { eventId: kept }));
        const exAdmin = admin(test, 'mefexadmin');
        const id = createTitledEvent(test, exAdmin, 'Final', [], m.id);
        const u2 = test.db.User.id.find(exAdmin.userId)!;
        tx(test, boss, (ctx) => M.admin_update_user(ctx, { userId: u2.id, displayName: u2.displayName, username: u2.username, roleTag: 'Moderator' }));
        expect(event(test, id)!.organizerId).toBe(exAdmin.userId);
    });

    it('server_set_role demotes a Moderator to TournamentHost: the match event goes to the organizer', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const mod = verified(test, 'mefsrvmod');
        setUserRole(test, mod.userId, 'Moderator');
        const id = createTitledEvent(test, mod, 'Final', [], m.id);
        const invitees = inviteeIds(test, id);
        const username = test.db.User.id.find(mod.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_set_role(ctx, { username, roleTag: 'TournamentHost' }));
        expectHandedTo(test, id, mod, org, invitees);
    });
});

describe('A163(2): edges', () => {
    it('the tournament organizer already holds an invite to the event: that invite row is deleted, the others stay', () => {
        const w = world();
        tx(w.test, w.creator, (ctx) => M.invite_to_event(ctx, { eventId: w.id, inviteeUserId: w.org.userId }));
        expect(invite(w.test, w.id, w.org.userId)).toBeDefined();
        tx(w.test, w.org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: w.f.id, userId: w.creator.userId }));
        expect(invite(w.test, w.id, w.org.userId)).toBeUndefined();
        expectHandedTo(w.test, w.id, w.creator, w.org, w.invitees);
    });

    it('the hand-over is not refused by the new owner\'s caps: an organizer at 40 active events still receives it', () => {
        const w = world();
        // 40 not-yet-ended personal events of the organizer, written directly (the create path is rate limited)
        const start = w.test.clock.now().microsSinceUnixEpoch + 3_600_000_000n;
        for (let i = 0; i < 40; i++) {
            w.test.db.CalendarEvent.insert({
                id: 0, organizerId: w.org.userId, title: `Own ${i}`, description: undefined, bracketMatchId: undefined,
                startAt: new Timestamp(start), endAt: new Timestamp(start + 3_600_000_000n), ...AUDIT(w.test),
            } as any);
        }
        advance(w.test, 60_000);
        expect(rejectionText(w.test, w.org)).toBe('Maximum 40 active calendar events per user.');
        tx(w.test, w.org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: w.f.id, userId: w.creator.userId }));
        expect(event(w.test, w.id)!.organizerId).toBe(w.org.userId);
        expect(eventsOf(w.test, w.org)).toHaveLength(41);
    });

    it('the hand-over of a staff deletion (S10s) drops the heir\'s own invite to the handed event too', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const heir = verified(test, 'mefheir');
        assignAssistant(test, org, f.id, heir, { bracket: true, participants: true, results: true });
        const id = createTitledEvent(test, org, 'Final', [heir], m.id);
        expect(invite(test, id, heir.userId)).toBeDefined();
        const boss = admin(test, 'mefdelboss');
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(org.userId) }));
        fireDeletionJob(test, org.userId);
        expect(event(test, id)!.organizerId).toBe(heir.userId);
        expect(invite(test, id, heir.userId)).toBeUndefined();
    });

    for (const stage of ['Completed', 'Cancelled'] as const) {
        it(`a ${stage} tournament's match event is handed over too`, () => {
            const w = world();
            w.test.db.Tournament.id.update({ ...w.test.db.Tournament.id.find(w.f.id)!, stage: { tag: stage } as any });
            tx(w.test, w.org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: w.f.id, userId: w.creator.userId }));
            expectHandedTo(w.test, w.id, w.creator, w.org, w.invitees);
        });
    }
});

function rejectionText(test: Harness, who: Actor): string {
    try {
        createTitledEvent(test, who, 'Over cap');
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
    return '';
}
