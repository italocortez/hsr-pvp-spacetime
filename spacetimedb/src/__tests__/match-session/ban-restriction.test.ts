// Match session: the ban restriction of a lobby.
// Decisions: A45
// Contracts: docs/match-session/contract.md
// From S6 (s6-rules.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    captainOf,
    dropDefaultCostCoverage,
    expectReject,
    lobbyRow,
    newHarness,
    priceBanNames,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from '../fixtures/harness';

const actorOf = (s: Lobby, userId: number): Actor => Object.values(s.a).find((x) => x.userId === userId)!;
const captain = (s: Lobby, team: 'Blue' | 'Red') =>
    actorOf(s, captainOf(s.test, s.lobbyId, team === 'Blue' ? 'BluePlayer' : 'RedPlayer')!.userId);

// ─── A45(2): Ban Restriction ──────────────────────────────────────────────────────────────────────────────

function seedRoles(test: Harness, roles: Record<string, 'Dps' | 'Support' | 'Sustain'>) {
    tx(test, 'internal', (ctx) => {
        for (const [name, role] of Object.entries(roles)) {
            ctx.db.HsrCharacter.insert({
                name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Destruction' }, element: { tag: 'Ice' },
                role: { tag: role }, imageUrl: '', versionReleased: 1.0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
    });
}

const ban = (s: Lobby, team: 'Blue' | 'Red', characterName: string) =>
    tx(s.test, captain(s, team), (ctx) => (priceBanNames(ctx, s.lobbyId, [characterName]), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName }))); // T-S10r (A122(7), L32): a ban names a priced character
const pick = (s: Lobby, team: 'Blue' | 'Red', characterName: string) =>
    tx(s.test, captain(s, team), (ctx) => (priceCharacters(ctx, s.lobbyId, [characterName]), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 })));

describe('A45(2): Ban Restriction', () => {
    it('Max 1 DPS rejects a second DPS ban by the same team; another role and the other team are unaffected', () => {
        const test = newHarness();
        seedRoles(test, { dps1: 'Dps', dps2: 'Dps', dps3: 'Dps', sup1: 'Support' });
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' }, banRestriction: { tag: 'MaxOneDps' } } });
        expect(lobbyRow(test, s.lobbyId).banRestriction.tag).toBe('MaxOneDps');

        ban(s, 'Blue', 'dps1');
        ban(s, 'Red', 'dps2'); // Red's first DPS ban: allowed
        pick(s, 'Blue', 'p1');
        pick(s, 'Red', 'p2');
        pick(s, 'Red', 'p3');
        pick(s, 'Blue', 'p4');
        ban(s, 'Red', 'sup1');
        expect(session(test, s.lobbyId).draftSequence[session(test, s.lobbyId).turnIndex].teamTurn.tag).toBe('Blue');
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            (priceBanNames(ctx, s.lobbyId, ['dps3']), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'dps3' })), /at most one DPS/); // T-S10r (A122(7), L32): a ban names a priced character
        ban(s, 'Blue', 'unknown-name'); // no HsrCharacter row → no role → legal
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(4);
    });

    it('the timer-expiry auto-ban (autoRandomPick) only draws characters the acting team may still ban', () => {
        const test = newHarness();
        seedRoles(test, { dpsA: 'Dps', dpsB: 'Dps', sup1: 'Support' });
        // Ban pool = the default set's Classic MoC cost rows: dpsA, dpsB, sup1.
        tx(test, 'internal', (ctx) => {
            for (const characterName of ['dpsA', 'dpsB', 'sup1']) {
                ctx.db.HsrCharacterCost.insert({
                    characterName, gameMode: { tag: 'MemoryOfChaos' }, draftMode: { tag: 'Classic' },
                    costs: { e0: 1, e1: 1, e2: 1, e3: 1, e4: 1, e5: 1, e6: 1 }, costSetId: 0,
                    createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                } as any);
            }
        });
        const s = setupLobby(test, {
            lobby: { banMode: { tag: 'Four' }, banRestriction: { tag: 'MaxOneDps' }, autoRandomPick: true },
            // autoRandomPick requires every player to field an account with characters (D-43b).
            // T-S10i fix pass (review F2): the set-0 coverage rows leave the ban pool once the lobby exists.
            beforeStart: (l) => { dropDefaultCostCoverage(test); tx(test, 'internal', (ctx) => {
                for (const name of ['b1', 'b2', 'r1', 'r2']) {
                    const acct = ctx.db.HsrAccount.insert({
                        id: 0, userId: l.a[name].userId, uid: '600000000', region: 'America', displayLabel: name,
                        isActive: true, isRosterPublic: false, isRatingPublic: false, isDuplicateUid: false, accountRating: 0,
                        createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                    });
                    ctx.db.HsrAccountCharacter.insert({
                        hsrAccountId: acct.id, characterName: 'sup1', eidolonLevel: 0,
                        createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                    } as any);
                    ctx.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[name].userId, hsrAccountId: acct.id });
                }
            }); },
        });
        ban(s, 'Blue', 'dpsA');
        ban(s, 'Red', 'x');
        pick(s, 'Blue', 'p1');
        pick(s, 'Red', 'p2');
        pick(s, 'Red', 'p3');
        pick(s, 'Blue', 'p4');
        ban(s, 'Red', 'y');
        // Blue's second ban expires: dpsB is unbanned but illegal for Blue (Max 1 DPS), so only sup1 qualifies.
        advance(test, 31_000);
        tx(test, s.a.b1, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
        const last = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban').at(-1)!;
        expect(last.actorSlot.tag).toBe('Blue');
        expect(last.payload.tag === 'Ban' && last.payload.value.characterName).toBe('sup1');
    });
});
