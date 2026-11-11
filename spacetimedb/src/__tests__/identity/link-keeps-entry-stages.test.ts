// Identity: more stages and shapes of a guest signing in to an existing account with a tournament entry.
// Decisions: A112
// Contracts: docs/auth/contract.md
// From S10q (s10q-gap-coverage.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    guest,
    lobbyRow,
    member,
    newHarness,
    tx,
    type Harness,
    type Lobby,
} from '../fixtures/harness';
import { finishGame } from '../fixtures/draft-and-scoring-builders';
import {
    advanceStage,
    bracketRows,
    enrolled,
    host,
    membership,
    openTournament,
    register,
    seedAndGenerate,
    tRow,
    teamRow,
    verified,
} from '../fixtures/tournament-builders';
import {
    createTournamentLobby,
    draftGame,
    drain,
    join,
    recordsOfLobby,
    validate,
} from '../fixtures/tournament-match-builders';
import {
    addSecondIdentity,
    existingUser,
    mappedUser,
    signIn,
    soloLive,
} from '../fixtures/guest-sign-in-builders';

const identitiesOf = (test: Harness, userId: number) => [...test.db.UserIdentity.user_id.filter(userId)];

// ════════════════════════════════════════════════════════════════════════════
// Gap 2. A112 (S10l review answer 7)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 2, A112: more stages and shapes of a guest signing in to an existing account (S10l review answer 7)', () => {
    it('A112(1) (answer 7: CheckIn): a guest entry already checked in moves with its CheckedIn status; at Seeding the moved team is Ready and a team that did not check in is Withdrawn', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, checkInEnabled: true });
        const g = guest(test, 'g-ci');
        const v1 = verified(test, 'ci-v1');
        const v2 = verified(test, 'ci-v2');
        for (const p of [g, v1, v2]) register(test, p, id);
        advanceStage(test, org, id, 'CheckIn');
        tx(test, g, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        tx(test, v1, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        const before = enrolled(test, id, g.userId)!;
        expect(before.status.tag).toBe('CheckedIn');
        const teamId = membership(test, id, g.userId)!.teamId;
        const lateTeam = membership(test, id, v2.userId)!.teamId;
        const e = existingUser(test, 'e-ci');

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toMatchObject({ status: { tag: 'CheckedIn' }, createdDate: before.createdDate });
        expect(membership(test, id, e.a.userId)!.teamId).toBe(teamId);
        expect(teamRow(test, teamId)!.captainUserId).toBe(e.a.userId);

        advanceStage(test, org, id, 'Seeding');
        expect(teamRow(test, teamId)!.status.tag).toBe('Ready');
        expect(teamRow(test, lateTeam)!.status.tag).toBe('Withdrawn');
    });

    it('A112(1) (answer 7: Seeding before generation): the entry moves, the team keeps its status; generate_bracket then places the moved team', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 4 });
        const g = guest(test, 'g-seed0');
        const v = verified(test, 'seed0-v');
        register(test, g, id);
        register(test, v, id);
        advanceStage(test, org, id, 'Seeding');
        expect(tRow(test, id).bracketGeneratedAt).toBeUndefined();
        const teamId = membership(test, id, g.userId)!.teamId;
        const statusBefore = teamRow(test, teamId)!.status.tag;
        const e = existingUser(test, 'e-seed0');

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toBeTruthy();
        expect(membership(test, id, e.a.userId)!.teamId).toBe(teamId);
        expect(teamRow(test, teamId)).toMatchObject({ captainUserId: e.a.userId, status: { tag: statusBefore } });

        seedAndGenerate(test, org, id);
        const placed = new Set(bracketRows(test, id).flatMap((r) => [r.team1Id, r.team2Id]).filter((t) => t !== undefined));
        expect(placed.has(teamId)).toBe(true);
    });

    it('pins current behaviour (row silent): A112 (answer 7: second identity): a guest who keeps a second identity is not deleted by the sign-in, so nothing moves: the entry stays with the guest, the signing-in identity maps to the existing user', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g-two-ids');
        register(test, g, id);
        const extra = addSecondIdentity(test, g.userId, 'g-two-ids-2nd');
        const before = enrolled(test, id, g.userId)!;
        const e = existingUser(test, 'e-two-ids');

        const guestId = signIn(test, g, e.providerId);

        expect(mappedUser(test, g)).toBe(e.a.userId);
        expect(test.db.User.id.find(guestId)).toMatchObject({ isGuest: true });
        expect(identitiesOf(test, guestId).map((r) => r.identity.toHexString())).toEqual([extra.identity.toHexString()]);
        expect(enrolled(test, id, guestId)).toEqual(before);
        expect(enrolled(test, id, e.a.userId)).toBeFalsy();
    });

    it('A112(1), A113(3) (answer 7: games played, review F5): a guest who played a tournament game and then signs in keeps the entry on the existing user; at completion the game\'s history and stats are written for the archived guest id, none for the existing user; the bracket result stays with the team', () => {
        const test = newHarness();
        const org = host(test);
        const g = guest(test, 'g-played');
        const v = verified(test, 'played-v');
        const { id, teamId, match } = soloLive(test, org, [g, v], g);
        const lobbyId = createTournamentLobby(test, org, match.id);
        for (const p of [g, v]) {
            join(test, p, lobbyId);
            tx(test, p, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        }
        tx(test, org, (ctx) => M.start_draft(ctx, { lobbyId }));
        const s: Lobby = { test, lobbyId, host: org, a: { host: org, g, v } };
        draftGame(s, 'gp');
        const gSide = member(test, lobbyId, g.userId)!.lobbySlot.tag === 'BluePlayer' ? 'Blue' : 'Red';
        finishGame(s, gSide);
        if (recordsOfLobby(test, lobbyId)[0].status.tag !== 'Validated') validate(test, org, lobbyId);
        expect(test.db.BracketMatch.id.find(match.id)!.winnerTeamId).toBe(teamId);
        const e = existingUser(test, 'e-played');

        const guestId = signIn(test, g, e.providerId); // AwaitingResult is not a live stage (A113(4))

        expect(enrolled(test, id, e.a.userId)).toBeTruthy();
        expect(teamRow(test, teamId)!.captainUserId).toBe(e.a.userId);
        expect(test.db.DeletedUser.id.find(guestId)).toBeTruthy(); // the guest has history: archived

        advanceStage(test, org, id, 'Completed');
        drain(test, id);

        expect([...test.db.MatchParticipantHistory.by_user.filter(guestId)]).toHaveLength(1);
        expect([...test.db.MatchParticipantHistory.by_user.filter(e.a.userId)]).toEqual([]);
        expect([...test.db.PlayerStat.by_user.filter(guestId)].length).toBeGreaterThan(0);
        expect([...test.db.PlayerStat.by_user.filter(e.a.userId)]).toEqual([]);
        expect(test.db.BracketMatch.id.find(match.id)!.winnerTeamId).toBe(teamId);
        expect(teamRow(test, teamId)!.captainUserId).toBe(e.a.userId);
    });

    it('A112(4) (answer 7: a non-live lobby, review F4): a guest seated in a Waiting tournament lobby: the guest\'s seat is removed with the guest and not moved; the existing user then joins and is seated on that team\'s side', () => {
        const test = newHarness();
        const org = host(test);
        const g = guest(test, 'g-wait-seat');
        const v = verified(test, 'wait-seat-v');
        const { match } = soloLive(test, org, [g, v], g);
        const lobbyId = createTournamentLobby(test, org, match.id);
        join(test, g, lobbyId);
        join(test, v, lobbyId);
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Waiting');
        const seatTag = member(test, lobbyId, g.userId)!.lobbySlot.tag;
        expect(['BluePlayer', 'RedPlayer']).toContain(seatTag);
        const e = existingUser(test, 'e-wait-seat');

        const guestId = signIn(test, g, e.providerId);

        expect(member(test, lobbyId, guestId)).toBeFalsy();
        expect(member(test, lobbyId, e.a.userId)).toBeFalsy();
        join(test, e.a, lobbyId);
        expect(member(test, lobbyId, e.a.userId)!.lobbySlot.tag).toBe(seatTag);
    });
});
