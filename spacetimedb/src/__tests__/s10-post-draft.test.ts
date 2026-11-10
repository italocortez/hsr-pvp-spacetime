// T-S10 batch A1: in-memory port of test/backend/match-session/post-draft.test.ts (equip_lightcone guards and budget,
// light-cone cost lookup, arrange_lineup guards, advance_stage). The ArrangeLineup / ConfirmLineup steps and the
// positions JSON are obsolete (A21, A60, A63) and not ported; the two client-filter cost tests become one reducer-level
// test (orchestrator ruling Q5: D-10 / D-11). Every `it` cites docs/match-session/contract.md. In-memory datastore on
// the TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, advance, expectReject, guest, joinAsSpectator, lobbyRow, newHarness, priceCharacters, session, setupLobby, steps, tx, type Lobby } from './s4-fixtures';
import { blueNames, captain, draftAuction, draftClassic, engineerFullDraft, equip, insertLightconeCost, insertRoster, redNames, side } from './s7-fixtures';
import { rejection } from './s10-c2-fixtures';
import { insertLightconeCostFor } from './s10-a1-fixtures';

const stageMsg = (stage: string) => `This action is not allowed in the current lobby stage (${stage}).`;
const REFEREE_OR_ABOVE = 'Only the referee, moderators, or admins can perform this action.'; // A80
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
const BLUE_EQUIP = 'Only the Blue captain or a referee can equip lightcones.';
/** T-S10b (A78(2)): equip_lightcone names the side; these tests edit Blue's copy. */
const equipBody = (s: Lobby, characterName: string, lightconeName: string) =>
    (ctx: any) => M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName, lightconeName, superimposition: 1 });

// ─── equip_lightcone ──────────────────────────────────────────────────────────

describe('equip_lightcone', () => {
    it('a non-member is rejected (flow step 1; A78(1): "Only the Blue captain or a referee can equip lightcones.")', () => {
        const s = equipping();
        insertLightconeCost(s.test, 'lc-1', 1);
        const outsider = guest(s.test, 'outsider');
        expectReject(s.test, outsider, equipBody(s, 'blue-1', 'lc-1'), BLUE_EQUIP);
        expect(equipSteps(s)).toHaveLength(0);
    });

    it('a plain spectator is rejected; the spectator referee (the host) may equip for Blue (A78(1))', () => {
        const s = equipping();
        insertLightconeCost(s.test, 'lc-1', 1);
        const watcher = joinAsSpectator(s, 'watcher');
        expectReject(s.test, watcher, equipBody(s, 'blue-1', 'lc-1'), BLUE_EQUIP);
        expect(equipSteps(s)).toHaveLength(0);
        tx(s.test, s.host, equipBody(s, 'blue-1', 'lc-1'));
        expect(equipSteps(s)).toHaveLength(1);
        expect(equipSteps(s)[0].actorUserId).toBe(s.host.userId);
    });

    it('a coach is rejected (D-39; A78(1): "Only the Blue captain or a referee can equip lightcones.")', () => {
        const s = equipping();
        insertLightconeCost(s.test, 'lc-1', 1);
        expectReject(s.test, s.a.bc, equipBody(s, 'blue-1', 'lc-1'), BLUE_EQUIP);
        expect(equipSteps(s)).toHaveLength(0);
    });

    it('Equipping: Lightcone Budget: an EquipLightcone step with costPaid; the team LC budget drops by the cost', () => {
        const s = equipping({ lightconeBudget: 20, characterBudget: 0 });
        insertLightconeCost(s.test, 'patience', 15);
        const blue = captain(s, 'Blue');
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(20);
        equip(s, blue, 'Blue', 'blue-1', 'patience');
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
        equip(s, blue, 'Blue', 'blue-1', 'patience');
        advance(s.test, 300); // A78(3): past the lineup throttle (AbuseConfig.lineupMinIntervalMs = 250)
        expectReject(s.test, blue, equipBody(s, 'blue-2', 'ten'), 'Not enough LC budget.');
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(5);
        expect(equipSteps(s)).toHaveLength(1);
    });

    // T-S10i re-assertion (A101, A107(1)(5)): the cost is the lobby's own draft-mode row, not the Classic row. In a
    // Classic lobby a light cone with only an Auction row has no cost and is rejected; an Auction lobby reads that row.
    it("the light-cone cost is the row of the lobby's draft mode: a light cone with only an Auction row is rejected in Classic and costs its Auction price in Auction (A101, A107(1)(5))", () => {
        const s = equipping();
        insertLightconeCostFor(s.test, 'auction-only', 'Auction', 30);
        const blue = captain(s, 'Blue');
        const start = session(s.test, s.lobbyId).teamBlueLcBudget;
        const msg = rejection(s.test, blue, equipBody(s, 'blue-1', 'auction-only'));
        expect(equipSteps(s)).toHaveLength(0);
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(start);
        expect(msg).toBe("auction-only has no cost in this lobby's cost set.");

        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertLightconeCostFor(test, 'auction-only', 'Auction', 30);
        const a = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' }, lightconeBudget: 50 } });
        draftAuction(a, blueNames(), redNames());
        const before = session(test, a.lobbyId).teamBlueLcBudget;
        tx(test, captain(a, 'Blue'), equipBody(a, 'blue-1', 'auction-only'));
        expect(equipSteps(a)[0].payload).toMatchObject({ value: { lightconeName: 'auction-only', costPaid: 30 } });
        expect(session(test, a.lobbyId).teamBlueLcBudget).toBe(before - 30);
    });

    it('equip_lightcone in Drafting is rejected by the stage check (flow step 2; A60(1): Equipping or Scoring)', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertLightconeCost(test, 'lc-1', 1);
        const s = setupLobby(test);
        const blue = captain(s, 'Blue');
        tx(test, blue, (ctx) => (priceCharacters(ctx, s.lobbyId, ['blue-1']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 0 })));
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
    it('a player who is not the referee is rejected (A80)', () => {
        const s = equipping();
        expectReject(s.test, s.a.b1, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }), REFEREE_OR_ABOVE);
        expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
    });

    it('advance_stage from Waiting is rejected "Cannot advance stage from Waiting." (error table)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        expectReject(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }), 'Cannot advance stage from Waiting.');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
    });

    // T-S10i re-assertion (A100): Drafting → Equipping only once both teams hold charactersPerTeam characters. A finished
    // draft leaves Drafting by itself, so the accepted case is the engineered full draft still in Drafting (EMPTY counts).
    it('the host advances Drafting → Equipping (D-50 rollover: charBudget into lcBudget) → Scoring; refused out of an unfinished draft (A100)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { characterBudget: 100, lightconeBudget: 50 } });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        const before = JSON.stringify(session(test, s.lobbyId), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        const msg = rejection(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(JSON.stringify(session(test, s.lobbyId), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(before);
        expect(msg).toBe('The draft is not finished: Blue holds 0 of 8 characters and Red holds 0 of 8.');

        engineerFullDraft(s);
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        const sess = session(test, s.lobbyId);
        expect([sess.teamBlueCharBudget, sess.teamRedCharBudget]).toEqual([0, 0]);
        expect([sess.teamBlueLcBudget, sess.teamRedLcBudget]).toEqual([150, 150]);
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Scoring');
    });
});
