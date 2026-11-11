// Roster: an account selected in an active lobby cannot be edited by an Admin.
// Decisions: A142
// Contracts: docs/roster/contract.md
// From S10w (s10w-account-edit-lock.test.ts).
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    lobbyRow,
    newHarness,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
    type SetupOpts,
} from '../fixtures/harness';
import { captain, insertCharacter, selectAccount } from '../fixtures/draft-and-scoring-builders';
import { insertHsrAccount, verified } from '../fixtures/tournament-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { COST_LOCKED, classic } from '../fixtures/live-lobby-lock-helpers';

// ─── Texts ───────────────────────────────────────────────────────────────────

/** A142: the Admin roster refusal (names the lobby by its join code). */
const LOCKED = (joinCode: string) =>
    `This account is selected in active lobby ${joinCode}; its roster cannot be edited until the player's membership in that lobby ends or the lobby closes.`;
/** D-24: admin_delete_hsr_account's refusal, unchanged. */
const DELETE_LOCKED = 'Cannot delete an account that is selected in an active lobby. Leave the lobby first.';

// ─── Builders ────────────────────────────────────────────────────────────────

type Side = 'Blue' | 'Red';
const TWO_V_TWO: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];

/** b1's HSR account (inactive, so no join auto-selects it) owning A at E0 and selected for the lobby. */
function selectedAccount(s: Lobby): number {
    insertCharacter(s.test, 'A', 5);
    insertCharacter(s.test, 'B', 5);
    const id = insertHsrAccount(s.test, s.a.b1.userId, '800000001');
    s.test.db.HsrAccount.id.update({ ...s.test.db.HsrAccount.id.find(id)!, isActive: false });
    selectAccount(s.test, s.lobbyId, s.a.b1.userId, id, { A: 0 });
    return id;
}

const ownedOf = (test: Harness, id: number) =>
    Object.fromEntries([...test.db.HsrAccountCharacter.hsr_account_id.filter(id)].map((r) => [r.characterName, r.eidolonLevel]));

type AdminPath = [name: string, body: (id: number) => (ctx: any) => unknown];
const ROSTER_PATHS: AdminPath[] = [
    ['admin_batch_upsert_characters (eidolon update)', (id) => (ctx) =>
        M.admin_batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: JSON.stringify([{ characterName: 'A', eidolonLevel: 3 }]) })],
    ['admin_batch_upsert_characters (add)', (id) => (ctx) =>
        M.admin_batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: JSON.stringify([{ characterName: 'B', eidolonLevel: 1 }]) })],
    ['admin_batch_remove_characters', (id) => (ctx) =>
        M.admin_batch_remove_characters(ctx, { hsrAccountId: id, characterNamesJson: '["A"]' })],
];
const DELETE_PATH = (id: number) => (ctx: any) => M.admin_delete_hsr_account(ctx, { hsrAccountId: id });

// ════════════════════════════════════════════════════════════════════════════
// A142: the Admin roster paths
// ════════════════════════════════════════════════════════════════════════════

describe('A142: an Admin cannot edit the characters of an account selected in an active lobby', () => {
    for (const stage of ['Waiting', 'Drafting'] as const) {
        for (const [name, body] of ROSTER_PATHS) {
            it(`A142: ${name} is refused for an account selected in a ${stage} lobby; the roster is unchanged`, () => {
                const s = classic(stage === 'Waiting');
                expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe(stage);
                const id = selectedAccount(s);
                expect(rejection(s.test, 'internal', body(id))).toBe(LOCKED(lobbyRow(s.test, s.lobbyId).joinCode));
                expect(ownedOf(s.test, id)).toEqual({ A: 0 });
            });
        }
        it(`A142 (D-24 unchanged): admin_delete_hsr_account is refused for an account selected in a ${stage} lobby`, () => {
            const s = classic(stage === 'Waiting');
            const id = selectedAccount(s);
            expect(rejection(s.test, 'internal', DELETE_PATH(id))).toBe(DELETE_LOCKED);
            expect(s.test.db.HsrAccount.id.find(id)).toBeDefined();
        });
    }

    for (const [name, body] of ROSTER_PATHS) {
        it(`A142: ${name} is accepted for an account of the same player that is not selected (live draft)`, () => {
            const s = classic();
            selectedAccount(s);
            const other = insertHsrAccount(s.test, s.a.b1.userId, '800000002');
            s.test.db.HsrAccount.id.update({ ...s.test.db.HsrAccount.id.find(other)!, isActive: false });
            s.test.db.HsrAccountCharacter.insert({ hsrAccountId: other, characterName: 'A', eidolonLevel: 0, createdById: 0, createdDate: s.test.clock.now(), lastModifiedById: 0, lastModifiedDate: s.test.clock.now() } as any);
            tx(s.test, 'internal', body(other));
            expect(ownedOf(s.test, other)).not.toEqual({ A: 0 });
        });

        it(`A142: ${name} is accepted once the player left the Waiting lobby (the selection is released)`, () => {
            const s = classic(true);
            const id = selectedAccount(s);
            tx(s.test, s.a.b1, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
            tx(s.test, 'internal', body(id));
            expect(ownedOf(s.test, id)).not.toEqual({ A: 0 });
        });

        it(`A142: ${name} is accepted once the Waiting lobby is closed by its host`, () => {
            const s = classic(true);
            const id = selectedAccount(s);
            tx(s.test, s.host, (ctx) => M.close_lobby(ctx, { lobbyId: s.lobbyId }));
            expect(s.test.db.Lobby.id.find(s.lobbyId)).toBeNull();
            tx(s.test, 'internal', body(id));
            expect(ownedOf(s.test, id)).not.toEqual({ A: 0 });
        });

        it(`A142: ${name} is accepted once the drafting lobby is gone (deleted through the Admin table editor)`, () => {
            const s = classic();
            const id = selectedAccount(s);
            tx(s.test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'Lobby', primaryKeyJson: String(s.lobbyId) }));
            tx(s.test, 'internal', body(id));
            expect(ownedOf(s.test, id)).not.toEqual({ A: 0 });
        });

        it(`A142 (S10e review F3 kept): ${name} is accepted for the account of a member who abandoned the match`, () => {
            const s = classic();
            const id = selectedAccount(s);
            tx(s.test, s.a.b1, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId })); // away (A68(2))
            expect(rejection(s.test, 'internal', body(id))).toBe(LOCKED(lobbyRow(s.test, s.lobbyId).joinCode)); // away still locks
            tx(s.test, s.a.b1, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
            const row = [...s.test.db.LobbyMember.by_lobby_and_user.filter([s.lobbyId, s.a.b1.userId])][0];
            expect(row.abandonedAt).toBeDefined();
            expect([...s.test.db.LobbyMemberAccount.by_account.filter(id)]).toHaveLength(1); // the row stays for the match
            tx(s.test, 'internal', body(id));
            expect(ownedOf(s.test, id)).not.toEqual({ A: 0 });
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// A142 vs S10u review G2: the step-down route through an Admin roster edit is closed
// ════════════════════════════════════════════════════════════════════════════

describe('A142 (S10u review G2): an Admin roster edit between a bid and its sale is refused; the sale completes at the level checked at the bid', () => {
    const nominatorOf = (s: Lobby) => session(s.test, s.lobbyId).nextNominatorTeam.tag as Side;
    const nominate = (s: Lobby, name: string) => {
        advance(s.test, 300);
        tx(s.test, captain(s, nominatorOf(s)), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name }));
    };
    const pass = (s: Lobby, side: Side) => { advance(s.test, 300); tx(s.test, captain(s, side), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId })); };

    /** 2v2 ownership Auction, budgets 10 / 2, minimum raise 1; X costs 10 / 11.5 / 15...; b1 owns X at E0, b2 at E2; Blue nominates X at 10. */
    function bidOnX(verifiedBlue = false) {
        const test = newHarness();
        const s = setupLobby(test, {
            seats: TWO_V_TWO,
            actors: verifiedBlue ? { b1: verified(test, 'b1'), b2: verified(test, 'b2') } : {},
            lobby: { draftMode: { tag: 'Auction' }, requireOwnership: true, characterBudget: 10, lightconeBudget: 2, minimumBidRaise: 1 },
        });
        priceCharacters(s.test, s.lobbyId, ['X'], [10, 11.5, 15, 15, 15, 15, 15]);
        const acct: Record<string, number> = {};
        for (const [who, e] of [['b1', 0], ['b2', 2], ['r1', 0], ['r2', 0]] as const) {
            acct[who] = insertHsrAccount(s.test, s.a[who].userId, `80000010${who.charCodeAt(1)}`);
            s.test.db.HsrAccount.id.update({ ...s.test.db.HsrAccount.id.find(acct[who])!, isActive: false });
            selectAccount(s.test, s.lobbyId, s.a[who].userId, acct[who], { X: e });
        }
        if (nominatorOf(s) !== 'Blue') { nominate(s, 'EMPTY'); pass(s, 'Blue'); }
        nominate(s, 'X'); // Blue holds 10; its default is E0 (extra 0)
        return { s, acct };
    }
    const soldX = (s: Lobby) => steps(s.test, s.lobbyId)
        .filter((x) => x.action.tag === 'AuctionSold')
        .map((x) => x.payload.value as any)
        .find((p) => p.characterName === 'X');

    for (const [name, body] of [
        ['admin_batch_remove_characters (b1 loses X)', (id: number) => (ctx: any) => M.admin_batch_remove_characters(ctx, { hsrAccountId: id, characterNamesJson: '["X"]' })],
        ['admin_batch_upsert_characters (b1 at E2)', (id: number) => (ctx: any) => M.admin_batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: JSON.stringify([{ characterName: 'X', eidolonLevel: 2 }]) })],
    ] as const) {
        it(`A142: ${name} is refused mid-round; Red passes and X is sold at E0 with no extra (0 / 2)`, () => {
            const { s, acct } = bidOnX();
            expect(rejection(s.test, 'internal', body(acct.b1))).toBe(LOCKED(lobbyRow(s.test, s.lobbyId).joinCode));
            expect(ownedOf(s.test, acct.b1)).toEqual({ X: 0 });
            pass(s, 'Red');
            const sold = soldX(s);
            expect([sold.eidolon, sold.eidolonCost, sold.charCharged, sold.lcCharged]).toEqual([0, 0, 10, 0]);
            const x = session(s.test, s.lobbyId);
            expect({ char: x.teamBlueCharBudget, lc: x.teamBlueLcBudget }).toEqual({ char: 0, lc: 2 });
        });
    }

    // T-S10w fix pass (review F5): the same scenario through the Admin cost tools.
    const xCost = (ladder: number[]) => ({
        characterName: 'X', gameMode: 'MemoryOfChaos', draftMode: 'Auction',
        costs: Object.fromEntries(ladder.map((v, i) => [`e${i}`, v])), costSetId: 0,
    });
    for (const [name, body] of [
        ['admin_bulk_upsert HsrCharacterCost (X e1..e6 at 30)', (ctx: any) =>
            M.admin_bulk_upsert(ctx, { tableName: 'HsrCharacterCost', jsonData: JSON.stringify([xCost([10, 30, 30, 30, 30, 30, 30])]) })],
        ['admin_delete_row HsrCharacterCost (X)', (ctx: any) =>
            M.admin_delete_row(ctx, { tableName: 'HsrCharacterCost', primaryKeyJson: JSON.stringify({ characterName: 'X', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Auction', costSetId: 0 }) })],
    ] as const) {
        it(`A142: ${name} is refused mid-round; Red passes and X is sold at E0 with no extra (0 / 2)`, () => {
            const { s } = bidOnX();
            expect(rejection(s.test, 'internal', body)).toBe(COST_LOCKED(0, 1));
            pass(s, 'Red');
            const sold = soldX(s);
            expect([sold.eidolon, sold.eidolonCost, sold.charCharged, sold.lcCharged]).toEqual([0, 0, 10, 0]);
            const x = session(s.test, s.lobbyId);
            expect({ char: x.teamBlueCharBudget, lc: x.teamBlueLcBudget }).toEqual({ char: 0, lc: 2 });
        });
    }

    // T-S10w fix pass (review F5): the two routes A142 leaves to the S10u fallback, end to end through the reducers.
    /** Sold at E1 (extra 1.5: E2's extra 5 does not fit 0 + 2); Blue 0 / 0.5, total 12 - (10 + 1.5); Red untouched. */
    function expectStepDown(s: Lobby) {
        pass(s, 'Red');
        const sold = soldX(s);
        expect([sold.eidolon, sold.eidolonCost, sold.charCharged, sold.lcCharged]).toEqual([1, 1.5, 10, 1.5]);
        const x = session(s.test, s.lobbyId);
        expect({ char: x.teamBlueCharBudget, lc: x.teamBlueLcBudget }).toEqual({ char: 0, lc: 0.5 });
        expect(x.teamBlueCharBudget + x.teamBlueLcBudget).toBe(12 - (10 + 1.5)); // no budget created
        expect({ char: x.teamRedCharBudget, lc: x.teamRedLcBudget }).toEqual({ char: 10, lc: 2 });
    }

    it('A142 (route 1): server_delete_user of a seated Blue player mid-round removes its account rows; the sale steps down to E1', () => {
        const { s, acct } = bidOnX(true);
        const username = s.test.db.User.id.find(s.a.b1.userId)!.username;
        tx(s.test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(s.test.db.HsrAccount.id.find(acct.b1)).toBeNull();
        expect(ownedOf(s.test, acct.b1)).toEqual({});
        expectStepDown(s);
    });

    it('A142 (route 2): a Blue player who abandons the match may then edit the selected roster as its owner; the sale steps down to E1', () => {
        const { s, acct } = bidOnX(true);
        const removeX = (ctx: any) => M.batch_remove_characters(ctx, { hsrAccountId: acct.b1, characterNamesJson: '["X"]' });
        tx(s.test, s.a.b1, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId })); // away: still locked
        expect(rejection(s.test, s.a.b1, removeX)).toMatch(/Leave the lobby first\.$/);
        tx(s.test, s.a.b1, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
        tx(s.test, s.a.b1, removeX);
        expect(ownedOf(s.test, acct.b1)).toEqual({});
        expectStepDown(s);
    });
});
