// T-S10q: in-memory tests for the gaps the S10k to S10s reviews named (tests only). Each `it` cites its decision row and
// the review finding it closes. The tests assert the decision rows; where a row says nothing about the case, the test pins
// today's behaviour and its title starts with "pins current behaviour (row silent)". A test written from a row that the
// code does not meet stays in the file as `it.skip` with a `// DIAGNOSTIC S10q:` line, for the owner to triage.
// Gaps: A110 (S10k review N3), A112 (S10l review answer 7), A113 (S10m review F5), A115 (S10n review F9, amended after
// S10r), A118 (S10o log), A122(14) L51 (S10r review F5), A125 / A127 (S10s re-review N5), A124 (same N5), A122(22) L86
// (same N5), A121 (S10s review "side effects to know").
// State is built through the module's reducers; HSR accounts, roles, rating rows, identity rows and the few engineered
// states named in their tests are written straight into the in-memory datastore outside any reducer, like the earlier
// suites. `test.db` is read only outside `tx` bodies. TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    disconnect,
    expectReject,
    guest,
    linkDiscord,
    lobbyRow,
    member,
    newHarness,
    now,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
} from './s4-fixtures';
import { blueNames, captain, draftClassic, finishGame, insertRoster, redNames } from './s7-fixtures';
import {
    AUDIT,
    advanceStage,
    assignAssistant,
    bracketRows,
    createTournament,
    enrolled,
    host,
    insertHsrAccount,
    membership,
    moderator,
    openTournament,
    register,
    seedAndGenerate,
    setUserRole,
    tRow,
    teamRow,
    updateBody,
    verified,
} from './s8-fixtures';
import {
    byKey,
    captainActor,
    createTournamentLobby,
    draftGame,
    drain,
    duel,
    join,
    openMatchLobby,
    recordsOfLobby,
    seedElo,
    validate,
} from './s8d-fixtures';
import { ownedAccount, playRanked, validateAndFinalize } from './s10-a2-fixtures';
import { fireDeletionJob, freshAuth } from './s10-c1-fixtures';
import { DAY_MS, HOUR_MS, addSlot, createEvent, fromNow, invite, slotsOf } from './s10-c2-fixtures';

// ─── Texts ───────────────────────────────────────────────────────────────────

const FINISH_TEXT = 'Finish your current game before signing in to an existing account.';
const guestsText = (n: number) => `These settings require verified accounts, and ${n} guest player(s) are registered.`;
const NO_AUTHORITY_TEXT = 'You do not have authority to finalize this match result.';
const AWAY_TEXT = 'You are away from this lobby. Return to it before acting.';
const NO_STEPS_TEXT = 'No steps to undo.';
const UNDO_REFEREE_TEXT = 'Only referees with undo permission can undo.';
const ORGANIZER_DELETE_TEXT = 'You organize a tournament that has not finished. Cancel it, or wait until it ends, before deleting your account.';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const byId = (x: number, y: number) => x - y;
const statRows = (test: Harness, name: string) =>
    [...test.db.PlayerCharacterStat.iter()].filter((r) => r.characterName === name);
/** Users with the played stat of `name` (matchesPlayed > 0), sorted. */
const playedBy = (test: Harness, name: string) => statRows(test, name).filter((r) => r.matchesPlayed > 0).map((r) => r.userId).sort(byId);
/** Users with the faced stat of `name` (timesFaced > 0), sorted. */
const facedBy = (test: Harness, name: string) => statRows(test, name).filter((r) => r.timesFaced > 0).map((r) => r.userId).sort(byId);
const charStat = (test: Harness, userId: number, name: string) =>
    [...test.db.PlayerCharacterStat.by_user.filter(userId)].find((r) => r.characterName === name);
const globalRows = (test: Harness, name: string) => [...test.db.GlobalCharacterStat.iter()].filter((r) => r.characterName === name);

/** A verified user with a known provider id (the account a guest signs in to) and `accounts` HSR accounts. */
function existingUser(test: Harness, sub: string, accounts = 1): { a: Actor; providerId: string; accountIds: number[] } {
    const a = guest(test, sub);
    const providerId = `pid-${sub}`;
    linkDiscord(test, a, providerId, sub);
    const accountIds = Array.from({ length: accounts }, (_, i) => insertHsrAccount(test, a.userId, `${sub}-acc-${i}`)).sort(byId);
    return { a, providerId, accountIds };
}

/** server_link_provider (as the owner) for `g` to the account owning `providerId`; returns the guest's former user id. */
function signIn(test: Harness, g: Actor, providerId: string): number {
    const guestId = g.userId;
    linkDiscord(test, g, providerId, 'ignored');
    return guestId;
}

const signInBody = (g: Actor, providerId: string) => (ctx: any) => M.server_link_provider(ctx, {
    callerIdentityHex: g.identity.toHexString(), provider: 'discord', providerId, providerName: 'ignored',
});

/** A second client identity mapped to `userId` (written directly, as s10-identity-gc / s10h do). */
function addSecondIdentity(test: Harness, userId: number, sub: string) {
    const extra = freshAuth(test, sub);
    test.db.UserIdentity.insert({ identity: extra.identity, userId, lastSeenAt: test.clock.now(), ...AUDIT(test) } as any);
    return extra;
}

const mappedUser = (test: Harness, a: Actor) => test.db.UserIdentity.identity.find(a.identity)!.userId;
const identitiesOf = (test: Harness, userId: number) => [...test.db.UserIdentity.user_id.filter(userId)];

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

/** The lobby row of `userId`, re-written with `over` (LobbyMember is updated by delete + insert, as the module does). */
function rewriteMember(test: Harness, lobbyId: number, userId: number, over: Record<string, unknown>) {
    const row = member(test, lobbyId, userId)!;
    test.db.LobbyMember.by_lobby_and_user.delete([lobbyId, userId]);
    test.db.LobbyMember.insert({ ...row, ...over } as any);
}

/** The first Pick step of `team` in the lobby (its character name). */
const firstPickOf = (test: Harness, lobbyId: number, team: 'Blue' | 'Red') =>
    (steps(test, lobbyId)
        .filter((st) => st.action.tag === 'Pick' && st.actorSlot.tag === team)
        .sort((a, b) => a.sequence - b.sequence)[0].payload.value as any).characterName as string;

/** A solo (teamSize 1) tournament in InProgress with `players` registered; the bracket match holding `who`. */
function soloLive(test: Harness, org: Actor, players: Actor[], who: Actor) {
    const id = openTournament(test, org, { teamSize: 1, maxParticipants: Math.max(4, players.length) });
    for (const p of players) register(test, p, id);
    advanceStage(test, org, id, 'Seeding');
    seedAndGenerate(test, org, id);
    advanceStage(test, org, id, 'InProgress');
    const teamId = membership(test, id, who.userId)!.teamId;
    const match = bracketRows(test, id).find((m) => m.team1Id === teamId || m.team2Id === teamId)!;
    return { id, teamId, match };
}

// ════════════════════════════════════════════════════════════════════════════
// Gap 1. A110 (S10k review N3 (a), (c), (e))
// ════════════════════════════════════════════════════════════════════════════

/** A casual 2v2 Classic MoC game drafted by hand (each pick by its captain), `beforeFinish`, then the host closes it for Blue. */
function classicGame(opts: SetupOpts, beforeFinish: (s: Lobby) => void = () => {}): Lobby {
    const test = newHarness();
    insertRoster(test, [...blueNames(), ...redNames()]);
    const s = setupLobby(test, opts);
    draftClassic(s, blueNames(), redNames());
    beforeFinish(s);
    finishGame(s, 'Blue');
    expect(test.db.MatchSessionHistory.count()).toBe(1n); // casual: finalized at the close
    return s;
}
/** The non-captain Blue player of a standalone 2v2 lobby (by actor name). */
const blueMateName = (s: Lobby) => (captain(s, 'Blue').userId === s.a.b1.userId ? 'b2' : 'b1');

/**
 * A 2-team tournament (Bo1 final) whose final lobby is drafted and closed for Blue, then validated when needed; the
 * lobby parks in AwaitingResult and nothing derived is written until the tournament completes (A24(4)). Returns the
 * Blue captain and mate of the lobby and the first character Blue picked.
 */
function tournamentGameParked() {
    const f = duel({ defaultBestOf: 1, grandFinalBestOf: 1 });
    const { test } = f;
    const m = byKey(test, f.id, 'W-R1-M1');
    const s = openMatchLobby(f, m.id);
    draftGame(s, 'q');
    const blueCap = captainActor(s, 'Blue');
    const blueMate = [s.a.b1, s.a.b2].find((a) => a.userId !== blueCap.userId)!;
    const reds = [s.a.r1, s.a.r2];
    const pick = firstPickOf(test, s.lobbyId, 'Blue');
    finishGame(s, 'Blue');
    expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    if (recordsOfLobby(test, s.lobbyId)[0].status.tag !== 'Validated') validate(test, f.org, s.lobbyId);
    return { f, test, s, blueCap, blueMate, reds, pick };
}

describe('Gap 1, A110: played stats on the tournament path, with a deleted, abandoned or inactive-account player (S10k review N3)', () => {
    it('A110(1)(5), A115(5) (N3a): a tournament game writes no character stat until the tournament completes; at completion the played stat follows the ownership read then (an owner added after the game is credited, the picking captain is not)', () => {
        const { f, test, blueCap, blueMate, reds, pick } = tournamentGameParked();
        expect(statRows(test, pick)).toEqual([]); // deferred: nothing derived before Completed
        ownedAccount(test, blueMate.userId, 'late-owner', [pick]); // the owner gets the character after the game

        advanceStage(test, f.org, f.id, 'Completed');
        drain(test, f.id);

        expect(playedBy(test, pick)).toEqual([blueMate.userId]);
        expect(charStat(test, blueMate.userId, pick)).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0 });
        expect(charStat(test, blueCap.userId, pick)).toBeUndefined();
        expect(facedBy(test, pick)).toEqual(reds.map((r) => r.userId).sort(byId));
        expect(globalRows(test, pick)).toHaveLength(1);
    });

    it('pins current behaviour (row silent): A110(3) (N3c, review N2): on the tournament path, the only owner of a Blue pick is deleted before the tournament completes; at completion nobody is credited (the deleted player still counts as one of the side\'s two players and owns nothing any more); faced and global rows are written', () => {
        const { f, test, blueCap, blueMate, reds, pick } = tournamentGameParked();
        ownedAccount(test, blueMate.userId, 'doomed-owner', [pick]);
        const username = test.db.User.id.find(blueMate.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(test.db.User.id.find(blueMate.userId)).toBeFalsy();
        expect([...test.db.HsrAccount.user_id.filter(blueMate.userId)]).toEqual([]);

        advanceStage(test, f.org, f.id, 'Completed');
        drain(test, f.id);

        expect(playedBy(test, pick)).toEqual([]);
        expect(charStat(test, blueCap.userId, pick)).toBeUndefined();
        expect(facedBy(test, pick)).toEqual(reds.map((r) => r.userId).sort(byId));
        expect(globalRows(test, pick)).toHaveLength(1);
    });

    it('pins current behaviour (row silent): A110(1) (N3c): a Blue player who abandoned the match (left, then took another lobby with abandonCurrentMatch) and owns the pick is still credited at finalization; the picking captain is not', () => {
        let mate = '';
        const s = classicGame({}, (l) => {
            mate = blueMateName(l);
            ownedAccount(l.test, l.a[mate].userId, `own-${mate}`, ['blue-1']);
            tx(l.test, l.a[mate], (ctx) => M.leave_lobby(ctx, { lobbyId: l.lobbyId }));
            tx(l.test, l.a[mate], (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
            expect(member(l.test, l.lobbyId, l.a[mate].userId)!.abandonedAt).toBeDefined();
        });
        const cap = mate === 'b1' ? 'b2' : 'b1';
        expect(playedBy(s.test, 'blue-1')).toEqual([s.a[mate].userId]);
        expect(charStat(s.test, s.a[mate].userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1 });
        expect(charStat(s.test, s.a[cap].userId, 'blue-1')).toBeUndefined();
    });

    it('A110(1) (N3e): ownership on an account with isActive = false counts ("any of their HSR accounts"): the owner is credited, the captain who picked is not', () => {
        let mate = '';
        let inactiveId = 0;
        const s = classicGame({}, (l) => {
            mate = blueMateName(l);
            inactiveId = ownedAccount(l.test, l.a[mate].userId, `inactive-${mate}`, ['blue-1'], false);
        });
        expect(s.test.db.HsrAccount.id.find(inactiveId)!.isActive).toBe(false);
        const cap = mate === 'b1' ? 'b2' : 'b1';
        expect(playedBy(s.test, 'blue-1')).toEqual([s.a[mate].userId]);
        expect(charStat(s.test, s.a[cap].userId, 'blue-1')).toBeUndefined();
    });
});

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

// ════════════════════════════════════════════════════════════════════════════
// Gap 3. A113 (S10m review F5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 3, A113: guest counts, the live-game guard, invites, minimumMmr 0 (S10m review F5)', () => {
    /** An open solo tournament with a verified player and a guest the organizer has disqualified. */
    function dqGuestCup() {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 8 });
        const g = guest(test, 'g-dq');
        const v = verified(test, 'dq-v');
        register(test, g, id);
        register(test, v, id);
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: g.userId, reason: 'test' }));
        expect(enrolled(test, id, g.userId)!.status.tag).toBe('Disqualified');
        return { test, org, id, g };
    }
    const GUESTS_1_FULL = `${guestsText(1)} Remove them first, or keep the settings that allow guests.`;

    it('A144, A113(2) (F5: the Disqualified exclusion): a tournament whose only guest enrolment is Disqualified accepts the change that turns requireVerified on; the disqualified entry stays, still Disqualified', () => {
        const { test, org, id, g } = dqGuestCup();
        const dqBefore = enrolled(test, id, g.userId)!;
        expect(tRow(test, id)).toMatchObject({ requireRoster: false, requireVerified: false });

        tx(test, org, updateBody(test, id, { requireRoster: true }));

        expect(tRow(test, id)).toMatchObject({ requireRoster: true, requireVerified: true });
        expect(enrolled(test, id, g.userId)).toEqual(dqBefore);
        expect(enrolled(test, id, g.userId)!.status.tag).toBe('Disqualified');
    });

    it('A144, A113(2), A118 (F5: the Disqualified exclusion, neighbour): with a Disqualified guest and one other guest, the change is refused naming 1 guest player; after reject_participant removes the other guest it is accepted', () => {
        const { test, org, id, g } = dqGuestCup();
        const o = guest(test, 'g-other');
        register(test, o, id);
        expect(enrolled(test, id, o.userId)!.status.tag).not.toBe('Disqualified');
        const before = tRow(test, id);

        expectReject(test, org, updateBody(test, id, { requireRoster: true }), GUESTS_1_FULL);
        expect(tRow(test, id)).toEqual(before);

        tx(test, org, (ctx) => M.reject_participant(ctx, { tournamentId: id, userId: o.userId }));
        expect(enrolled(test, id, o.userId)).toBeUndefined();

        tx(test, org, updateBody(test, id, { requireRoster: true }));
        expect(tRow(test, id)).toMatchObject({ requireRoster: true, requireVerified: true });
        expect(enrolled(test, id, g.userId)!.status.tag).toBe('Disqualified');
    });

    it('A113(2) (F5): a waitlisted guest and a guest awaiting approval are guest enrolments: the change is refused with the count', () => {
        const test = newHarness();
        const org = host(test);
        const waitId = openTournament(test, org, { teamSize: 1, maxParticipants: 2, waitlistEnabled: true });
        for (const n of ['w1', 'w2']) register(test, verified(test, n), waitId);
        const gw = guest(test, 'g-waitlisted');
        register(test, gw, waitId);
        expect(enrolled(test, waitId, gw.userId)!.isWaitlisted).toBe(true);
        expectReject(test, org, updateBody(test, waitId, { requireRoster: true }), guestsText(1));
        expect(tRow(test, waitId).requireRoster).toBe(false);

        const approvalId = openTournament(test, org, { teamSize: 1, requireApproval: true, name: 'Approval cup' } as any);
        const ga = guest(test, 'g-awaiting');
        register(test, ga, approvalId);
        expect(enrolled(test, approvalId, ga.userId)!.approvedByToAt).toBeUndefined();
        expectReject(test, org, updateBody(test, approvalId, { requireVerified: true }), guestsText(1));
        expect(tRow(test, approvalId).requireVerified).toBe(false);
    });

    /** The guest holds an entry and sits as BluePlayer in a started casual 2v2 lobby (Drafting). */
    function seatedGuest() {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        register(test, g, id);
        const s = setupLobby(test, { seats: [['g', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']], actors: { g } });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        return { test, id, g, guestId: g.userId, lobbyId: s.lobbyId, e: existingUser(test, 'e') };
    }

    it('A113(4), A98 (F5: an away seat): a guest who left a live game (row away, leftAt set) still holds the seat: the sign-in is refused and nothing changes', () => {
        const { test, id, g, guestId, lobbyId, e } = seatedGuest();
        tx(test, g, (ctx) => M.leave_lobby(ctx, { lobbyId }));
        expect(member(test, lobbyId, guestId)).toMatchObject({ lobbySlot: { tag: 'BluePlayer' } });
        expect(member(test, lobbyId, guestId)!.leftAt).toBeDefined();
        expect(member(test, lobbyId, guestId)!.abandonedAt).toBeUndefined();
        const entryBefore = enrolled(test, id, guestId);

        expectReject(test, 'internal', signInBody(g, e.providerId), FINISH_TEXT);

        expect(mappedUser(test, g)).toBe(guestId);
        expect(test.db.User.id.find(guestId)!.isGuest).toBe(true);
        expect(enrolled(test, id, guestId)).toEqual(entryBefore);
        expect(enrolled(test, id, e.a.userId)).toBeFalsy();
    });

    it('pins current behaviour (row silent): A113(4) (F5: a second identity): a seated guest who keeps a second identity is not deleted by the sign-in, so it is accepted; the guest keeps its seat and its entry, the signing-in identity maps to the existing user', () => {
        const { test, id, g, guestId, lobbyId, e } = seatedGuest();
        addSecondIdentity(test, guestId, 'g-second-device');
        const seatBefore = member(test, lobbyId, guestId);
        const entryBefore = enrolled(test, id, guestId);

        tx(test, 'internal', signInBody(g, e.providerId));

        expect(mappedUser(test, g)).toBe(e.a.userId);
        expect(test.db.User.id.find(guestId)!.isGuest).toBe(true);
        expect(member(test, lobbyId, guestId)).toEqual(seatBefore);
        expect(enrolled(test, id, guestId)).toEqual(entryBefore);
        expect(enrolled(test, id, e.a.userId)).toBeFalsy();
    });

    it('A113(5) (F5: an invite already responded to): the re-pointed invite keeps its status and respondedAt (the guest\'s response is written on the row: respond_to_invite refuses guests)', () => {
        const test = newHarness();
        const org = host(test);
        const g = guest(test, 'g-inv');
        const v = verified(test, 'inv-v');
        const { id, match } = soloLive(test, org, [g, v], g);
        const eventId = createEvent(test, org, { bracketMatchId: match.id });
        const pending = invite(test, eventId, g.userId)!;
        expect(pending.inviteStatus.tag).toBe('Pending');
        advance(test, 5_000);
        const respondedAt = test.clock.now();
        test.db.CalendarEventInvite.delete(pending);
        test.db.CalendarEventInvite.insert({ ...pending, inviteStatus: { tag: 'Accepted' } as any, respondedAt } as any);
        advance(test, 5_000);
        const e = existingUser(test, 'e-inv');

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, e.a.userId)).toBeTruthy();
        expect(invite(test, eventId, guestId)).toBeFalsy();
        const moved = invite(test, eventId, e.a.userId)!;
        expect(moved.inviteStatus.tag).toBe('Accepted');
        expect(moved.respondedAt).toEqual(respondedAt);
    });

    it('pins current behaviour (row silent): A113(1) (F5: minimumMmr 0): a floor of 0 is stored as no floor and does not force requireVerified, at create and at an update while a guest is enrolled', () => {
        const test = newHarness();
        const org = host(test);
        const created = createTournament(test, org, { minimumMmr: 0, requireVerified: false });
        expect(tRow(test, created)).toMatchObject({ requireVerified: false });
        expect(tRow(test, created).minimumMmr).toBeUndefined();

        const id = openTournament(test, org, { teamSize: 1, name: 'Floor cup' } as any);
        const g = guest(test, 'g-floor0');
        register(test, g, id);
        tx(test, org, updateBody(test, id, { minimumMmr: 0, requireVerified: false }));
        expect(tRow(test, id).requireVerified).toBe(false);
        expect(tRow(test, id).minimumMmr).toBeUndefined();
        expect(enrolled(test, id, g.userId)).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 4. A115 (S10n review F9, amended after S10r A122(2))
// ════════════════════════════════════════════════════════════════════════════

type Reader = Actor;
const view = <T = any>(test: Harness, name: string, who: Reader, args: Record<string, unknown>): T[] =>
    (M as any)[name](test.viewContext(who.auth), args) as T[];
const ANY = { gameMode: '', draftMode: '', matchType: '' };
const DETAIL_VIEWS = [
    'view_my_match_history_participants', 'view_my_match_history_steps',
    'view_my_match_history_games', 'view_my_match_history_lineups',
] as const;

describe('Gap 4, A115: the history views after an admin deletes a match history row; the rating history tie-break (S10n review F9)', () => {
    it('A115(1)(2)(3)(4), A122(2) (F9, amended): after admin_delete_row(MatchSessionHistory) of the older of two Ranked matches, view_my_mmr_history still lists the rating rows of both; the list and the count hold the remaining match only; its detail reads; the deleted match\'s detail is empty; nothing throws', () => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const actors = Object.fromEntries(['host', 'b1', 'b2', 'r1', 'r2'].map((n) => [n, guest(test, `hist-${n}`)]));
        const first = playRanked(test, 'Blue', { actors });
        validateAndFinalize(test, first.s, first.recId, mod, 'Blue');
        advance(test, 60_000);
        const second = playRanked(test, 'Red', { actors });
        validateAndFinalize(test, second.s, second.recId, mod, 'Red');
        const [older, newer] = [...test.db.MatchSessionHistory.iter()]
            .sort((a, b) => Number(a.playedAt.microsSinceUnixEpoch - b.playedAt.microsSinceUnixEpoch))
            .map((h) => h.id);
        const me = actors.b1;
        expect(view(test, 'view_my_match_history_count', me, ANY)).toEqual([{ total: 2 }]);

        tx(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'MatchSessionHistory', primaryKeyJson: String(older) }));
        expect(test.db.MatchSessionHistory.id.find(older)).toBeFalsy();

        const ratings = view(test, 'view_my_mmr_history', me, { page: 0, gameMode: '' });
        expect(ratings.map((r) => r.matchHistoryId)).toEqual([newer, older]);
        expect(ratings.every((r) => r.userId === me.userId)).toBe(true);

        const list = view(test, 'view_my_match_history', me, { page: 0, ...ANY });
        expect(list.map((r) => r.matchHistoryId)).toEqual([newer]);
        expect(list[0].ratingDelta).toBeDefined();
        expect(view(test, 'view_my_match_history_count', me, ANY)).toEqual([{ total: 1 }]);
        expect(view(test, 'view_my_match_history', me, { page: 1, ...ANY })).toEqual([]);
        for (const name of DETAIL_VIEWS) {
            const rows = view(test, name, me, { matchHistoryId: newer });
            expect(rows.length, name).toBeGreaterThan(0);
            expect(rows.every((r) => r.matchHistoryId === newer), name).toBe(true);
            expect(view(test, name, me, { matchHistoryId: older }), name).toEqual([]);
        }
    });

    it('pins current behaviour (row silent): A115(4) (F9: the rating history tie-break): rating rows written at the same instant are ordered by the higher id first, across the page boundary (10 + 3), with no overlap; an older row comes last', () => {
        const test = newHarness();
        const me = guest(test, 'tie-me');
        const insertRating = (matchHistoryId: number, at: ReturnType<Harness['clock']['now']>) =>
            test.db.MmrHistory.insert({
                id: 0, userId: me.userId, gameMode: { tag: 'MemoryOfChaos' }, matchHistoryId, previousRating: 1000, newRating: 1016,
                delta: 16, seasonId: undefined, createdById: 0, createdDate: at, lastModifiedById: 0, lastModifiedDate: at,
            } as any).id as number;
        const olderAt = test.clock.now();
        const olderId = insertRating(900, olderAt);
        advance(test, 60_000);
        const sameAt = test.clock.now();
        const tied = Array.from({ length: 12 }, (_, i) => insertRating(1000 + i, sameAt));
        const pages = [0, 1, 2].map((page) => view(test, 'view_my_mmr_history', me, { page, gameMode: '' }));
        expect(pages.map((p) => p.length)).toEqual([10, 3, 0]);
        const seen = pages.flat().map((r) => r.id);
        expect(new Set(seen).size).toBe(13);
        expect(seen).toEqual([...[...tied].sort((a, b) => b - a), olderId]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 5. A118 (S10o log: calendar invites on a removal)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 5, A118: the removed guest\'s calendar invites go as on a withdrawal (S10o log)', () => {
    it('A118, D-24 (S10o log): reject_participant on a guest removes the guest\'s invites to the tournament\'s match events, as the withdrawal path does; the opponent\'s invite and the guest\'s personal-event invite stay (engineered: match events exist only after generation, so the bracket stamp is cleared by hand; withdraw_from_tournament itself is closed in Seeding, so the comparison is with the D-24 rule, not a second call)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 4 });
        const g = guest(test, 'g-rm');
        const v1 = verified(test, 'rm-v1');
        const v2 = verified(test, 'rm-v2');
        const v3 = verified(test, 'rm-v3');
        for (const p of [g, v1, v2, v3]) register(test, p, id);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        const matchOf = (who: Actor) => {
            const teamId = membership(test, id, who.userId)!.teamId;
            return bracketRows(test, id).find((m) => m.team1Id === teamId || m.team2Id === teamId)!;
        };
        const opponentOf = (who: Actor) => {
            const m = matchOf(who);
            const teamId = membership(test, id, who.userId)!.teamId;
            return teamRow(test, m.team1Id === teamId ? m.team2Id! : m.team1Id!)!.captainUserId;
        };
        const gEvent = createEvent(test, org, { bracketMatchId: matchOf(g).id });
        const personal = createEvent(test, org, { title: 'Personal', invitees: [g] });
        expect(invite(test, gEvent, g.userId)).toBeTruthy();
        const gOpponent = opponentOf(g);
        expect(invite(test, gEvent, gOpponent)).toBeTruthy();
        // Engineered state: A118 applies before the bracket exists, when no match event can exist yet.
        test.db.Tournament.id.update({ ...tRow(test, id), bracketGeneratedAt: undefined });

        tx(test, org, (ctx) => M.reject_participant(ctx, { tournamentId: id, userId: g.userId }));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
        expect(invite(test, gEvent, g.userId)).toBeFalsy();
        expect(invite(test, personal, g.userId)).toBeTruthy();
        expect(invite(test, gEvent, gOpponent)).toBeTruthy();
        expect(test.db.CalendarEvent.id.find(gEvent)).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 6. A122(14), L51 (S10r review F5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 6, A122(14) L51: finalize_match_result by an away referee and by a caller with no member row (S10r review F5)', () => {
    /** A standalone Ranked game closed by the host referee and validated by a Moderator (override_match_result). */
    function validatedRanked() {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Blue');
        tx(test, mod, (ctx) => M.override_match_result(ctx, { matchResultId: recId, newStatusTag: 'Validated', winnerTeamSideTag: 'Blue', reason: 'reviewed' }));
        expect(member(test, s.lobbyId, s.host.userId)!.isReferee).toBe(true);
        return { test, s, recId, mod };
    }
    const finalizeBody = (recId: number) => (ctx: any) => M.finalize_match_result(ctx, { matchResultId: recId });

    it('A122(14), A98 (F5: an away referee): the lobby\'s referee whose row is away is refused with the away text; a Moderator then finalizes (engineered: in AwaitingResult leave_lobby removes the row, so leftAt is set on the row)', () => {
        const { test, s, recId, mod } = validatedRanked();
        rewriteMember(test, s.lobbyId, s.host.userId, { leftAt: test.clock.now() });
        expect(member(test, s.lobbyId, s.host.userId)).toMatchObject({ isReferee: true });

        expectReject(test, s.host, finalizeBody(recId), AWAY_TEXT);
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(0);
        tx(test, mod, finalizeBody(recId));
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);
    });

    it('A122(14) (F5: no member row): a verified user who is not in the lobby and the former referee who left it (row removed) are refused; staff without a row (a Moderator) finalize', () => {
        const { test, s, recId, mod } = validatedRanked();
        const outsider = verified(test, 'outsider');
        expectReject(test, outsider, finalizeBody(recId), NO_AUTHORITY_TEXT);
        tx(test, s.host, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        expect(member(test, s.lobbyId, s.host.userId)).toBeFalsy();
        expectReject(test, s.host, finalizeBody(recId), NO_AUTHORITY_TEXT);
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(0);
        expect(member(test, s.lobbyId, mod.userId)).toBeFalsy();
        tx(test, mod, finalizeBody(recId));
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 7. A125 / A127 (S10s re-review N5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 7, A125 / A127: Auction undo with no bans configured; undo by a non-referee (S10s re-review N5)', () => {
    const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });
    const nominatorOf = (s: Lobby) => session(s.test, s.lobbyId).nextNominatorTeam.tag as 'Blue' | 'Red';
    const otherSide = (side: 'Blue' | 'Red') => (side === 'Blue' ? 'Red' : 'Blue');
    function nominate(s: Lobby, name: string) {
        tx(s.test, captain(s, nominatorOf(s)), (ctx) => {
            priceCharacters(ctx, s.lobbyId, [name]);
            return M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name });
        });
    }
    const stepsOf = (s: Lobby, tag: string) => steps(s.test, s.lobbyId).filter((x) => x.action.tag === tag);
    const snapshot = (s: Lobby) => {
        const x = session(s.test, s.lobbyId);
        return {
            currentNomination: x.currentNomination, currentBidAmount: x.currentBidAmount, currentBidTeam: x.currentBidTeam.tag,
            nextNominatorTeam: x.nextNominatorTeam.tag, turnIndex: x.turnIndex, isAuctionPhase: x.isAuctionPhase,
            blue: x.teamBlueCharBudget, red: x.teamRedCharBudget, blueLc: x.teamBlueLcBudget, redLc: x.teamRedLcBudget,
            blueWon: x.blueCharactersWon, redWon: x.redCharactersWon,
        };
    };
    const auctionNoBans = () => setupLobby(newHarness(), { lobby: { draftMode: { tag: 'Auction' }, banMode: { tag: 'None' } } });

    // T-S10u re-alignment (A134): in the auction phase the unit of undo is the round; two rounds (one sold, one open
    // with a bid) are undone in two calls, each back to the state before its nomination.
    it('A127, A125, A134 (N5: no bans): with nothing done the undo is refused; a sold round and an open round are undone one round per call back to the start; a further undo is refused', () => {
        const s = auctionNoBans();
        expect(session(s.test, s.lobbyId).isAuctionPhase).toBe(true);
        const start = snapshot(s);
        expectReject(s.test, s.host, undoBody(s), NO_STEPS_TEXT);

        const nominator = nominatorOf(s);
        nominate(s, 'lot-1');
        tx(s.test, captain(s, otherSide(nominator)), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }));
        tx(s.test, captain(s, nominator), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        expect(stepsOf(s, 'AuctionSold')).toHaveLength(1);
        const sold = snapshot(s);
        nominate(s, 'lot-2');
        tx(s.test, captain(s, nominatorOf(s) === 'Blue' ? 'Red' : 'Blue'), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }));

        tx(s.test, s.host, undoBody(s)); // the open round: lot-2 and its bid
        expect(snapshot(s)).toEqual(sold);
        tx(s.test, s.host, undoBody(s)); // the sold round: the sale, its bid and lot-1
        expect(snapshot(s)).toEqual(start);
        expect(stepsOf(s, 'Nominate')).toEqual([]);
        expect(stepsOf(s, 'Undo')).toHaveLength(2);
        expectReject(s.test, s.host, undoBody(s), NO_STEPS_TEXT);
    });

    // T-S10u re-alignment (A134): the referee's undo of the sale returns to the state before the nomination.
    it('A127, D-60, A134 (N5: a non-referee): in the auction phase a captain without the referee flag is refused for an open nomination and for a sale; nothing changes; the referee then undoes', () => {
        const s = auctionNoBans();
        const nominator = nominatorOf(s);
        const start = snapshot(s);
        nominate(s, 'lot-a');
        const opened = snapshot(s);
        for (const who of [captain(s, 'Blue'), captain(s, 'Red')]) {
            expect(member(s.test, s.lobbyId, who.userId)!.isReferee).toBe(false);
            expectReject(s.test, who, undoBody(s), UNDO_REFEREE_TEXT);
        }
        expect(snapshot(s)).toEqual(opened);
        tx(s.test, captain(s, otherSide(nominator)), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        const sold = snapshot(s);
        expectReject(s.test, captain(s, nominator), undoBody(s), UNDO_REFEREE_TEXT);
        expect(snapshot(s)).toEqual(sold);
        expect(stepsOf(s, 'Undo')).toEqual([]);
        tx(s.test, s.host, undoBody(s));
        expect(snapshot(s)).toEqual(start);
    });
});

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
// Gap 9. A122(22), L86 (S10s re-review N5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 9, A122(22) L86: the clean-up spares the call\'s own old target (S10s re-review N5)', () => {
    it('A122(22) L86 (N5): update_availability_slot on the caller\'s slot expired 9 days ago succeeds and moves it; another expired slot of the caller is cleaned', () => {
        const test = newHarness();
        const u = verified(test, 'cal-slot');
        const target = addSlot(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const other = addSlot(test, u, { startMs: HOUR_MS, endMs: 3 * HOUR_MS });
        advance(test, 9 * DAY_MS);
        const startAt = fromNow(test, DAY_MS);
        const endAt = fromNow(test, DAY_MS + 2 * HOUR_MS);

        tx(test, u, (ctx) => M.update_availability_slot(ctx, {
            slotId: target, startAt, endAt, isRecurring: false, recurrenceType: '', interval: 0, dayOfWeek: 255, dayOfMonth: 0, endDate: '',
        }));

        const slots = slotsOf(test, u);
        expect(slots.map((sl) => sl.id)).toEqual([target]);
        expect(slots[0].startAt.microsSinceUnixEpoch.toString()).toBe(startAt);
        expect(other).not.toBe(target);
    });

    it('A122(22) L86 (N5): invite_to_event on the caller\'s event ended 91 days ago succeeds; another old event of the caller is cleaned', () => {
        const test = newHarness();
        const u = verified(test, 'cal-inv');
        const friend = verified(test, 'cal-friend');
        const target = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const other = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 91 * DAY_MS);

        tx(test, u, (ctx) => M.invite_to_event(ctx, { eventId: target, inviteeUserId: friend.userId }));

        expect(test.db.CalendarEvent.id.find(target)).toBeTruthy();
        expect(invite(test, target, friend.userId)).toMatchObject({ inviteStatus: { tag: 'Pending' } });
        expect(test.db.CalendarEvent.id.find(other)).toBeFalsy();
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
