// Match session: no light cone on an EMPTY pick or sale.
// Decisions: A191 item 4
// Contracts: docs/match-session/contract.md (Phase History, Phase S14.3s execution)
// From S14.3s.
//
// T-S14.3s: equip_lightcone refuses characterName EMPTY (a Classic EMPTY pick or an Auction EMPTY sale) with
// "A light cone cannot be equipped on an empty pick."; nothing is written and no budget moves. A real pick still takes
// a light cone. unequip_lightcone stays open on EMPTY, so a cone equipped before the rule can be removed and refunded.
// In-memory datastore on the TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { EMPTY_LIGHTCONE_TEXT } from '@module/reducers/draft/postDraft';
import { M, newHarness, rejection, session, setupLobby, steps, type Lobby } from '../fixtures/harness';
import {
    blueNames,
    captain,
    draftAuction,
    draftClassic,
    equip,
    insertLightconeCost,
    insertRoster,
    redNames,
    side,
    unequip,
} from '../fixtures/draft-and-scoring';

const BLUE = ['EMPTY', ...blueNames(7)];
const equipSteps = (s: Lobby) => steps(s.test, s.lobbyId).filter((x) => x.action.tag === 'EquipLightcone');
const equipBody = (s: Lobby, characterName: string, lightconeName: string) =>
    (ctx: any) => M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName, lightconeName, superimposition: 1 });

/** A Classic lobby in Equipping where Blue picked EMPTY first, then blue-1..blue-7. */
function classicWithEmpty(): Lobby {
    const test = newHarness();
    insertRoster(test, [...blueNames(7), ...redNames()]);
    const s = setupLobby(test, { lobby: { lightconeBudget: 20, characterBudget: 0 } });
    draftClassic(s, BLUE, redNames());
    return s;
}

describe('equip_lightcone on EMPTY (A191 item 4)', () => {
    it('scenario "No light cone on an empty pick": a Classic EMPTY pick is refused with the EMPTY text; no step, budget unchanged', () => {
        const s = classicWithEmpty();
        insertLightconeCost(s.test, 'patience', 5);
        const blue = captain(s, 'Blue');
        const before = session(s.test, s.lobbyId).teamBlueLcBudget;
        const msg = rejection(s.test, blue, equipBody(s, 'EMPTY', 'patience'));
        expect(equipSteps(s)).toHaveLength(0);
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(before);
        expect(msg).toBe(EMPTY_LIGHTCONE_TEXT);
        expect(EMPTY_LIGHTCONE_TEXT).toBe('A light cone cannot be equipped on an empty pick.');
    });

    it('scenario "No light cone on an empty pick": the spectator referee (the host) is refused the same way', () => {
        const s = classicWithEmpty();
        insertLightconeCost(s.test, 'patience', 5);
        expect(rejection(s.test, s.host, equipBody(s, 'EMPTY', 'patience'))).toBe(EMPTY_LIGHTCONE_TEXT);
        expect(equipSteps(s)).toHaveLength(0);
    });

    it('scenario "No light cone on an empty pick": a real pick of the same team still takes a light cone', () => {
        const s = classicWithEmpty();
        insertLightconeCost(s.test, 'patience', 5);
        equip(s, captain(s, 'Blue'), 'Blue', 'blue-1', 'patience');
        expect(equipSteps(s)).toHaveLength(1);
        expect(equipSteps(s)[0].payload).toMatchObject({ value: { characterName: 'blue-1', lightconeName: 'patience', costPaid: 5 } });
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(15);
    });

    it('scenario "No light cone on an empty pick": an Auction EMPTY sale is refused too', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(7), ...redNames()]);
        insertLightconeCost(test, 'patience', 5);
        const a = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' }, lightconeBudget: 50 } });
        draftAuction(a, BLUE, redNames());
        const sold = steps(test, a.lobbyId).filter((x) => x.payload.tag === 'AuctionSold' && (x.payload.value as any).characterName === 'EMPTY');
        expect(sold).toHaveLength(1);
        expect(rejection(test, captain(a, 'Blue'), equipBody(a, 'EMPTY', 'patience'))).toBe(EMPTY_LIGHTCONE_TEXT);
        expect(equipSteps(a)).toHaveLength(0);
    });

    it('a light cone equipped on EMPTY before the rule can still be unequipped and refunded (unequip_lightcone unchanged)', () => {
        const s = classicWithEmpty();
        const blue = captain(s, 'Blue');
        // An EquipLightcone step on EMPTY as an older module wrote it (written directly; the reducer now refuses it).
        const all = steps(s.test, s.lobbyId);
        const sequence = all.reduce((m, r) => Math.max(m, r.sequence), 0) + 1;
        const ts = s.test.clock.now();
        s.test.db.MatchSessionStep.insert({
            id: 0, lobbyId: s.lobbyId, sequence, actorUserId: blue.userId, anonymousLabel: undefined,
            actorSlot: { tag: 'Blue' }, action: { tag: 'EquipLightcone' },
            payload: { tag: 'EquipLightcone', value: { characterName: 'EMPTY', lightconeName: 'patience', superimposition: 1, costPaid: 4 } },
            timestamp: ts, createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts,
        } as any);
        const sess = session(s.test, s.lobbyId);
        s.test.db.MatchSession.lobbyId.update({ ...sess, teamBlueLcBudget: sess.teamBlueLcBudget - 4 });
        const before = session(s.test, s.lobbyId).teamBlueLcBudget;

        unequip(s, blue, 'Blue', 'EMPTY');
        const un = steps(s.test, s.lobbyId).filter((x) => x.action.tag === 'UnequipLightcone');
        expect(un).toHaveLength(1);
        expect(un[0].payload).toMatchObject({ value: { characterName: 'EMPTY', lightconeName: 'patience', refunded: 4 } });
        expect(session(s.test, s.lobbyId).teamBlueLcBudget).toBe(before + 4);
    });
});
