// T-S10 batch A1: in-memory port of test/backend/match-session/post-draft.test.ts (equip_lightcone guards and budget,
// light-cone cost lookup, arrange_lineup guards, advance_stage). The ArrangeLineup / ConfirmLineup steps and the
// positions JSON are obsolete (A21, A60, A63) and not ported; the two client-filter cost tests become one reducer-level
// test (orchestrator ruling Q5: D-10 / D-11). Every `it` cites docs/match-session/contract.md. In-memory datastore on
// the TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, expectReject, guest, joinAsSpectator, lobbyRow, newHarness, session, setupLobby, steps, tx, type Lobby } from './s4-fixtures';
import { blueNames, captain, draftClassic, equip, insertLightconeCost, insertRoster, redNames, side } from './s7-fixtures';
import { insertLightconeCostFor } from './s10-a1-fixtures';

const stageMsg = (stage: string) => `This action is not allowed in the current lobby stage (${stage}).`;
const HOST_OR_ABOVE = 'Only the host, moderators, or admins can perform this action.';
const BLUE_ARRANGE = 'Only the Blue captain or a referee can arrange the lineup.';
const GROUPS_JSON = 'groups must be a JSON array of arrays of character names.';

/** A Classic lobby drafted to Equipping (16 picks): b1 / b2 Blue, bc the Blue coach, r1 / r2 Red, the host a spectator referee. */
function equipping(lobby: Record<string, unknown> = {}): Lobby {
    const test = newHarness();
    insertRoster(test, [...blueNames(), ...redNames()]);
    const s = setupLobby(test, {
        lobby,
        seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
    });
    draftClassic(s, blueNames(), redNames());
    return s;
}

const equipSteps = (s: Lobby) => steps(s.test, s.lobbyId).filter((x) => x.action.tag === 'EquipLightcone');
const equipBody = (s: Lobby, characterName: string, lightconeName: string) =>
    (ctx: any) => M.equip_lightcone(ctx, { lobbyId: s.lobbyId, characterName, lightconeName, superimposition: 1 });

// ─── equip_lightcone ──────────────────────────────────────────────────────────

describe('equip_lightcone', () => {
    it('a non-member is rejected (flow step 1)', () => {
        const s = equipping();
        insertLightconeCost(s.test, 'lc-1', 1);
        const outsider = guest(s.test, 'outsider');
        expectReject(s.test, outsider, equipBody(s, 'blue-1', 'lc-1'), 'You are not a member of this lobby.');
        expect(equipSteps(s)).toHaveLength(0);
    });

    it('a spectator (the host referee, and a plain spectator) is rejected: "Spectators cannot equip lightcones."', () => {
        const s = equipping();
        insertLightconeCost(s.test, 'lc-1', 1);
        expectReject(s.test, s.host, equipBody(s, 'blue-1', 'lc-1'), 'Spectators cannot equip lightcones.');
        const watcher = joinAsSpectator(s, 'watcher');
        expectReject(s.test, watcher, equipBody(s, 'blue-1', 'lc-1'), 'Spectators cannot equip lightcones.');
        expect(equipSteps(s)).toHaveLength(0);
    });

    it('a coach is rejected: "Coaches cannot equip lightcones." (D-39)', () => {
        const s = equipping();
        insertLightconeCost(s.test, 'lc-1', 1);
        expectReject(s.test, s.a.bc, equipBody(s, 'blue-1', 'lc-1'), 'Coaches cannot equip lightcones.');
        expect(equipSteps(s)).toHaveLength(0);
    });

    it('Equipping: Lightcone Budget: an EquipLightcone step with costPaid; the team LC budget drops by the cost', () => {
        const s = equipping({ lightconeBudget: 20, characterBudget: 0 });
        insertLightconeCost(s.test, 'patience', 15);
        const blue = captain(s, 'Blue');
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(20);
        equip(s, blue, 'blue-1', 'patience');
        const st = equipSteps(s);
        expect(st).toHaveLength(1);
        expect(st[0].actorUserId).toBe(blue.userId);
        expect(st[0].actorSlot.tag).toBe('Blue');
        expect(st[0].payload).toMatchObject({
            tag: 'EquipLightcone',
            value: { characterName: 'blue-1', lightconeName: 'patience', superimposition: 1, costPaid: 15 },
        });
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(5);
        expect(session(s.test, s.lobbyId).teamRedLcBudget).toBe(20);
    });

    it('Equipping: Lightcone Budget: a second light cone costing more than the remaining budget is rejected "Not enough LC budget." (D-55)', () => {
        const s = equipping({ lightconeBudget: 20, characterBudget: 0 });
        insertLightconeCost(s.test, 'patience', 15);
        insertLightconeCost(s.test, 'ten', 10);
        const blue = captain(s, 'Blue');
        equip(s, blue, 'blue-1', 'patience');
        expectReject(s.test, blue, equipBody(s, 'blue-2', 'ten'), 'Not enough LC budget.');
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(5);
        expect(equipSteps(s)).toHaveLength(1);
    });

    it('the light-cone cost is read from the Classic row only: a light cone with only an Auction row costs 0 (flow step 5, D-10 / D-11)', () => {
        const s = equipping();
        insertLightconeCostFor(s.test, 'auction-only', 'Auction', 30);
        const blue = captain(s, 'Blue');
        const start = session(s.test, s.lobbyId).teamBlueLcBudget;
        equip(s, blue, 'blue-1', 'auction-only');
        expect(equipSteps(s)[0].payload).toMatchObject({ value: { lightconeName: 'auction-only', costPaid: 0 } });
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(start);
    });

    it('equip_lightcone in Drafting is rejected by the stage check (flow step 2; A60(1): Equipping or Scoring)', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertLightconeCost(test, 'lc-1', 1);
        const s = setupLobby(test);
        const blue = captain(s, 'Blue');
        tx(test, blue, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 0 }));
        expectReject(test, blue, equipBody(s, 'blue-1', 'lc-1'), stageMsg('Drafting'));
        expect(equipSteps(s)).toHaveLength(0);
    });
});

// ─── arrange_lineup guards ────────────────────────────────────────────────────

describe('arrange_lineup guards (Lineup Groups, A21)', () => {
    it('groups that are not a JSON array of arrays of names are rejected', () => {
        const s = equipping();
        const blue = captain(s, 'Blue');
        for (const groups of ['not-json', '{"a":1}', '["blue-1","blue-2"]', '[[1,2,3,4]]']) {
            expectReject(s.test, blue, (ctx) => M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), groups }), GROUPS_JSON);
        }
        expect([...s.test.db.MatchLineup.by_lobby.filter(s.lobbyId)]).toHaveLength(0);
    });

    it('a plain spectator and the Blue coach cannot arrange Blue\'s lineup', () => {
        const s = equipping();
        const watcher = joinAsSpectator(s, 'watcher');
        const groups = JSON.stringify([blueNames().slice(0, 4), blueNames().slice(4)]);
        for (const who of [watcher, s.a.bc]) {
            expectReject(s.test, who, (ctx) => M.arrange_lineup(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), groups }), BLUE_ARRANGE);
        }
        expect([...s.test.db.MatchLineup.by_lobby.filter(s.lobbyId)]).toHaveLength(0);
    });
});

// ─── advance_stage ────────────────────────────────────────────────────────────

describe('advance_stage', () => {
    it('a player who is not the host is rejected (Permission: ensureHostOrAbove)', () => {
        const s = equipping();
        expectReject(s.test, s.a.b1, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }), HOST_OR_ABOVE);
        expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
    });

    it('advance_stage from Waiting is rejected "Cannot advance stage from Waiting." (error table)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        expectReject(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }), 'Cannot advance stage from Waiting.');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
    });

    it('the host advances Drafting → Equipping (D-50 rollover: charBudget into lcBudget) → Scoring', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { characterBudget: 100, lightconeBudget: 50 } });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        const sess = session(test, s.lobbyId);
        expect([sess.teamBlueCharBudget, sess.teamRedCharBudget]).toEqual([0, 0]);
        expect([sess.teamBlueLcBudget, sess.teamRedLcBudget]).toEqual([150, 150]);
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Scoring');
    });
});
