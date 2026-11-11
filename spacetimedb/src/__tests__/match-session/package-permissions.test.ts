// Match session: who may edit the game package and which side an edit names.
// Decisions: A78
// Contracts: docs/match-session/contract.md
// From S10b (s10b-package-permissions.test.ts).
//
// T-S10b: in-memory tests for A78, the game-package caller rule. set_eidolon, equip_lightcone, unequip_lightcone and
// arrange_lineup share one rule on the open game (the captain of the named team or any lobby referee), the light-cone
// reducers take an explicit teamSide (mirror picks reach Red's copy, Admin path included) and use the lineup throttle.
// Builders in s4 / s7 fixtures; the clock is the TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    guest,
    joinAsSpectator,
    lobbyRow,
    member,
    newHarness,
    seatOf,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
    rejection,
    type Team,
    type Ctx,
    other,
} from '../fixtures/harness';
import {
    blueNames,
    captain,
    draftClassic,
    equip,
    finishGame,
    halves,
    insertLightconeCost,
    insertRoster,
    lineup,
    record,
    redNames,
    setRole,
    side,
} from '../fixtures/draft-and-scoring';

const THROTTLED = 'Lineup changes are too frequent. Please wait a moment.';
const lc = (t: Team) => `${t.toLowerCase()}-1`; // the light-cone target of each team
const eid = (t: Team) => `${t.toLowerCase()}-2`; // the eidolon target of each team
const namesOf = (t: Team) => (t === 'Blue' ? blueNames() : redNames());

/** AbuseConfig.lineupMinIntervalMs as the module reads it (the singleton seeded by init). */
const lineupInterval = (test: Harness) => test.db.AbuseConfig.id.find(1)!.lineupMinIntervalMs;
/** Moves the clock past the lineup throttle. */
const pastThrottle = (test: Harness) => advance(test, lineupInterval(test) + 1);

/** A Classic 2v2 drafted to Equipping: b1 / b2 Blue, bc the Blue coach, r1 / r2 Red, the host a spectator referee, `spec` a plain spectator. */
function equipping(opts: SetupOpts = {}): Lobby {
    const test = newHarness();
    insertRoster(test, [...blueNames(), ...redNames()]);
    insertLightconeCost(test, 'lc-1', 1);
    const s = setupLobby(test, {
        seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        ...opts,
    });
    joinAsSpectator(s, 'spec');
    draftClassic(s, blueNames(), redNames());
    pastThrottle(test);
    return s;
}

// ─── One state snapshot for every package edit of a team ───────────────────────────────────────────────────────────

const teamSteps = (s: Lobby, action: string, team: Team) =>
    steps(s.test, s.lobbyId)
        .filter((st) => st.action.tag === action && st.actorSlot.tag === team)
        .sort((a, b) => a.sequence - b.sequence);

/** Everything a package edit of `team` can change: its step log, its lineup row and its light-cone budget. */
function snapshot(s: Lobby, team: Team) {
    const l = lineup(s.test, s.lobbyId, team);
    const sess = session(s.test, s.lobbyId);
    return JSON.stringify({
        eidolon: teamSteps(s, 'SetEidolon', team).length,
        equip: teamSteps(s, 'EquipLightcone', team).length,
        unequip: teamSteps(s, 'UnequipLightcone', team).length,
        groups: l?.groups ?? null,
        lineupBy: l?.lastModifiedById ?? null,
        lcBudget: team === 'Blue' ? sess.teamBlueLcBudget : sess.teamRedLcBudget,
    });
}

interface Op {
    name: string;
    /** The tail of the A78 rejection text: `Only the <Side> captain or a referee can <what>.` */
    what: string;
    /** The call for `team`; `n` varies the arguments so consecutive successful calls are real changes. */
    body: (s: Lobby, team: Team, n: number) => (ctx: Ctx) => unknown;
    /** The user id of the last successful edit of `team`. */
    lastActor: (s: Lobby, team: Team) => number | undefined;
    /** Runs before a call expected to succeed (unequip needs an equipped light cone). */
    prep?: (s: Lobby, team: Team) => void;
}

const lastStepActor = (action: string) => (s: Lobby, team: Team) => teamSteps(s, action, team).at(-1)?.actorUserId;

const OPS: Op[] = [
    {
        name: 'set_eidolon',
        what: 'set an eidolon for that team',
        body: (s, team, n) => (ctx) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side(team), characterName: eid(team), eidolon: (n % 6) + 1 }),
        lastActor: lastStepActor('SetEidolon'),
    },
    {
        name: 'equip_lightcone',
        what: 'equip lightcones',
        body: (s, team) => (ctx) =>
            M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side(team), characterName: lc(team), lightconeName: 'lc-1', superimposition: 1 }),
        lastActor: lastStepActor('EquipLightcone'),
    },
    {
        name: 'unequip_lightcone',
        what: 'unequip lightcones',
        body: (s, team) => (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side(team), characterName: lc(team) }),
        lastActor: lastStepActor('UnequipLightcone'),
        prep: (s, team) => {
            equip(s, captain(s, team), team, lc(team), 'lc-1');
            pastThrottle(s.test);
        },
    },
    {
        name: 'arrange_lineup',
        what: 'arrange the lineup',
        body: (s, team, n) => (ctx) => {
            const [a, b] = halves(namesOf(team));
            return M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: side(team), groups: JSON.stringify(n % 2 ? [b, a] : [a, b]) });
        },
        lastActor: (s, team) => lineup(s.test, s.lobbyId, team)?.lastModifiedById,
    },
];

let calls = 0;

/** `who` edits `team`: accepted, the team's state changed and the last edit is `who`'s. */
function accepted(s: Lobby, op: Op, who: Actor, team: Team) {
    op.prep?.(s, team);
    const before = snapshot(s, team);
    const untouched = snapshot(s, other(team));
    tx(s.test, who, op.body(s, team, ++calls));
    expect(snapshot(s, team)).not.toBe(before);
    expect(snapshot(s, other(team))).toBe(untouched);
    expect(op.lastActor(s, team)).toBe(who.userId);
    pastThrottle(s.test);
}

/** `who` edits `team`: rejected with the A78 text, neither team's state moved (asserted before the text). */
function rejected(s: Lobby, op: Op, who: Actor, team: Team) {
    const before = [snapshot(s, 'Blue'), snapshot(s, 'Red')];
    const msg = rejection(s.test, who, op.body(s, team, ++calls));
    expect([snapshot(s, 'Blue'), snapshot(s, 'Red')]).toEqual(before);
    expect(msg).toBe(`Only the ${team} captain or a referee can ${op.what}.`);
}

// ─── A78(1): one caller rule for the package ──────────────────────────────────────────────────────────────────────

describe('A78(1): the captain of the team or a referee edits the package', () => {
    for (const op of OPS) {
        it(`${op.name}: the Blue captain succeeds; a non-captain teammate, the Red captain, the coach and a plain spectator are rejected (A78(1))`, () => {
            const s = equipping();
            const blueCap = captain(s, 'Blue');
            const blueMate = [s.a.b1, s.a.b2].find((a) => a.userId !== blueCap.userId)!;
            rejected(s, op, blueMate, 'Blue');
            rejected(s, op, captain(s, 'Red'), 'Blue');
            rejected(s, op, s.a.bc, 'Blue');
            rejected(s, op, s.a.spec, 'Blue');
            accepted(s, op, blueCap, 'Blue');
            // The mirror image: the Red captain edits Red, the Blue captain cannot.
            rejected(s, op, blueCap, 'Red');
            accepted(s, op, captain(s, 'Red'), 'Red');
        });

        it(`${op.name}: the spectator referee (the host) succeeds on either side (A78(1))`, () => {
            const s = equipping();
            const host = member(s.test, s.lobbyId, s.host.userId);
            expect([host.lobbySlot.tag, host.isReferee]).toEqual(['Spectator', true]);
            accepted(s, op, s.host, 'Blue');
            accepted(s, op, s.host, 'Red');
        });

        it(`${op.name}: a referee seated on Blue (not its captain) may edit Red (A78(1))`, () => {
            const test = newHarness();
            insertRoster(test, [...blueNames(), ...redNames()]);
            insertLightconeCost(test, 'lc-1', 1);
            const s = setupLobby(test, { hostSlot: 'BluePlayer', seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
            tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
            expect(captain(s, 'Blue').userId).toBe(s.a.b1.userId);
            draftClassic(s, blueNames(), redNames());
            pastThrottle(test);
            accepted(s, op, s.host, 'Red');
        });
    }
});

// ─── A78(2): explicit teamSide, mirror picks ──────────────────────────────────────────────────────────────────────

describe('A78(2): equip_lightcone / unequip_lightcone edit the named side', () => {
    const MIRROR = 'mirror';
    const blue = [MIRROR, ...blueNames().slice(1)];
    const red = [MIRROR, ...redNames().slice(1)];

    function mirrored(test: Harness, beforeStart?: (l: Lobby) => void): Lobby {
        insertRoster(test, [MIRROR, ...blueNames().slice(1), ...redNames().slice(1)]);
        insertLightconeCost(test, 'lc-5', 5);
        const s = setupLobby(test, { lobby: { allowMirrorPicks: true, lightconeBudget: 50 }, beforeStart });
        draftClassic(s, blue, red);
        pastThrottle(test);
        return s;
    }

    it('mirror picks (casual): the Red captain equips Red\'s copy: Red\'s budget is debited, the step logs actorSlot Red, Blue is untouched (A78(2))', () => {
        const test = newHarness();
        const s = mirrored(test);
        const sess0 = session(test, s.lobbyId);
        const blueBefore = snapshot(s, 'Blue');
        equip(s, captain(s, 'Red'), 'Red', MIRROR, 'lc-5');
        const sess = session(test, s.lobbyId);
        expect(sess.teamRedLcBudget).toBe(sess0.teamRedLcBudget - 5);
        expect(sess.teamBlueLcBudget).toBe(sess0.teamBlueLcBudget);
        const st = teamSteps(s, 'EquipLightcone', 'Red');
        expect(st).toHaveLength(1);
        expect(st[0].payload).toMatchObject({ value: { characterName: MIRROR, lightconeName: 'lc-5', costPaid: 5 } });
        expect(snapshot(s, 'Blue')).toBe(blueBefore);

        // unequip names the side too: Red's copy is refunded, Blue (which has nothing equipped) stays as it was.
        pastThrottle(test);
        tx(test, captain(s, 'Red'), (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), characterName: MIRROR }));
        expect(session(test, s.lobbyId).teamRedLcBudget).toBe(sess0.teamRedLcBudget);
        expect(teamSteps(s, 'UnequipLightcone', 'Red')).toHaveLength(1);
        expect(snapshot(s, 'Blue')).toBe(blueBefore);
    });

    it('mirror picks, closed game (Ranked, Submitted): an Admin equips and unequips Red\'s copy, not Blue\'s (A78(2), A60(7))', () => {
        const test = newHarness();
        const s = mirrored(test, (l) => {
            test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
            let accountId = 800;
            for (const name of ['b1', 'b2', 'r1', 'r2']) {
                test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[name].userId, hsrAccountId: accountId++ });
            }
        });
        finishGame(s, 'Blue');
        expect(record(test, s.lobbyId).status.tag).toBe('Submitted');
        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        const sess0 = session(test, s.lobbyId);
        const blueBefore = snapshot(s, 'Blue');
        const redCost0 = lineup(test, s.lobbyId, 'Red').rosterCost;

        tx(test, admin, (ctx) =>
            M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), characterName: MIRROR, lightconeName: 'lc-5', superimposition: 1 }));
        expect(session(test, s.lobbyId).teamRedLcBudget).toBe(sess0.teamRedLcBudget - 5);
        expect(lineup(test, s.lobbyId, 'Red').rosterCost).toBe(redCost0 + 500);
        expect(teamSteps(s, 'EquipLightcone', 'Red').at(-1)!.actorUserId).toBe(admin.userId);
        expect(snapshot(s, 'Blue')).toBe(blueBefore);

        tx(test, admin, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), characterName: MIRROR }));
        expect(session(test, s.lobbyId).teamRedLcBudget).toBe(sess0.teamRedLcBudget);
        expect(lineup(test, s.lobbyId, 'Red').rosterCost).toBe(redCost0);
        expect(snapshot(s, 'Blue')).toBe(blueBefore);
    });
});

// ─── A78(3): the lineup throttle on the light-cone reducers ───────────────────────────────────────────────────────

describe('A78(3): equip_lightcone / unequip_lightcone use the lineup throttle', () => {
    it('a second equip by the same member inside lineupMinIntervalMs is rejected; it passes once the interval has passed (A78(3))', () => {
        const s = equipping();
        const { test } = s;
        const blueCap = captain(s, 'Blue');
        equip(s, blueCap, 'Blue', 'blue-1', 'lc-1');
        const before = snapshot(s, 'Blue');
        const msg = rejection(test, blueCap, (ctx) =>
            M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-2', lightconeName: 'lc-1', superimposition: 1 }));
        expect(snapshot(s, 'Blue')).toBe(before);
        expect(msg).toBe(THROTTLED);

        advance(test, lineupInterval(test) - 1); // still inside the interval
        expect(rejection(test, blueCap, (ctx) =>
            M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-1' }))).toBe(THROTTLED);
        expect(snapshot(s, 'Blue')).toBe(before);

        advance(test, 2);
        equip(s, blueCap, 'Blue', 'blue-2', 'lc-1');
        expect(teamSteps(s, 'EquipLightcone', 'Blue')).toHaveLength(2);
    });

    it('the throttle is shared with set_eidolon and arrange_lineup: an equip right after an arrange by the same member is rejected (A78(3))', () => {
        const s = equipping();
        const { test } = s;
        const blueCap = captain(s, 'Blue');
        tx(test, blueCap, (ctx) => M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), groups: JSON.stringify(halves(blueNames())) }));
        const before = snapshot(s, 'Blue');
        expect(rejection(test, blueCap, (ctx) =>
            M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-1', lightconeName: 'lc-1', superimposition: 1 }))).toBe(THROTTLED);
        expect(snapshot(s, 'Blue')).toBe(before);
        // Another member (the referee) is not throttled by the captain's stamp.
        tx(test, s.host, (ctx) =>
            M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-1', lightconeName: 'lc-1', superimposition: 1 }));
        expect(teamSteps(s, 'EquipLightcone', 'Blue')).toHaveLength(1);
    });

    it('the Admin path on a closed game is not throttled: back-to-back equips and an unequip all pass (A78(3), A60(7))', () => {
        const test = newHarness();
        insertLightconeCost(test, 'lc-1', 1);
        insertRoster(test, [...blueNames(), ...redNames()]);
        const s = setupLobby(test, {
            beforeStart: (l) => {
                test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
                let accountId = 800;
                for (const name of ['b1', 'b2', 'r1', 'r2']) {
                    test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[name].userId, hsrAccountId: accountId++ });
                }
            },
        });
        draftClassic(s, blueNames(), redNames());
        finishGame(s, 'Blue');
        expect(record(test, s.lobbyId).status.tag).toBe('Submitted');
        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        const budget0 = session(test, s.lobbyId).teamBlueLcBudget;
        for (const c of ['blue-1', 'blue-2']) {
            tx(test, admin, (ctx) =>
                M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: c, lightconeName: 'lc-1', superimposition: 1 }));
        }
        tx(test, admin, (ctx) => M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-1' }));
        expect(teamSteps(s, 'EquipLightcone', 'Blue')).toHaveLength(2);
        expect(teamSteps(s, 'UnequipLightcone', 'Blue')).toHaveLength(1);
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(budget0 - 1);
    });
});

// ─── teamSide Spectator ───────────────────────────────────────────────────────────────────────────────────────────

describe('A78(2): teamSide must name a team', () => {
    it('equip_lightcone / unequip_lightcone with teamSide Spectator are rejected "teamSide must be Blue or Red." (A78(2))', () => {
        const s = equipping();
        const { test } = s;
        const spectatorSide = { tag: 'Spectator' } as any;
        const before = [snapshot(s, 'Blue'), snapshot(s, 'Red')];
        for (const who of [captain(s, 'Blue'), s.host]) {
            const eq = rejection(test, who, (ctx) =>
                M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: spectatorSide, characterName: 'blue-1', lightconeName: 'lc-1', superimposition: 1 }));
            const un = rejection(test, who, (ctx) =>
                M.unequip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: spectatorSide, characterName: 'blue-1' }));
            expect([snapshot(s, 'Blue'), snapshot(s, 'Red')]).toEqual(before);
            expect(eq).toBe('teamSide must be Blue or Red.');
            expect(un).toBe('teamSide must be Blue or Red.');
        }
    });
});
