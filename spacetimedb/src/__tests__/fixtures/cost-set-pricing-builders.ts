// Shared helpers: priced cost sets, cost rows and draft step bodies of the cost-set pricing tests.
// From S10i (s10i-draft-cost.test.ts); not a test file.
import {
    M,
    advance,
    dropDefaultCostCoverage,
    lobbyRow,
    session,
    steps,
    tx,
    type Actor,
    type CostKey,
    type Harness,
    type Lobby,
} from './harness';
import { captain, selectAccount } from './draft-and-scoring-builders';

// ─── Shared builders ─────────────────────────────────────────────────────────

export const MOC = 'MemoryOfChaos';
export type Mode = 'Classic' | 'Auction';
export type Team = 'Blue' | 'Red';

/** A JSON snapshot of rows (bigint-safe), to prove "nothing changed" / "byte-for-byte unchanged". */
export const snap = (...rows: unknown[]) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** e0..e6 = base, base + step, ... */
export const ladder = (base: number, step = 1) => Array.from({ length: 7 }, (_, i) => base + i * step);
/** s1..s5 = base, base + 1, ... */
export const sLadder = (base: number) => Array.from({ length: 5 }, (_, i) => base + i);
export const eJson = (l: number[]) => JSON.stringify({ e0: l[0], e1: l[1], e2: l[2], e3: l[3], e4: l[4], e5: l[5], e6: l[6] });
export const sJson = (l: number[]) => JSON.stringify({ s1: l[0], s2: l[1], s3: l[2], s4: l[3], s5: l[4] });
export const key0 = (draftMode: Mode): CostKey => ({ costSetId: 0, gameMode: MOC, draftMode });
export const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds

// Cost-set reducers (Memory of Chaos sets).
export function createSet(test: Harness, who: Actor | 'internal', name: string, sourceSetId = 0): number {
    tx(test, who, (ctx) => M.create_cost_set(ctx, { name, sourceSetId, gameModeTag: MOC }));
    return [...test.db.CostSet.iter()].find((r) => r.name === name)!.id;
}
export const editChar = (test: Harness, who: Actor | 'internal', costSetId: number, characterName: string, draftModeTag: Mode, l: number[]) =>
    tx(test, who, (ctx) => M.edit_draft_character_cost(ctx, { costSetId, characterName, gameModeTag: MOC, draftModeTag, costsJson: eJson(l) }));
export const editLc = (test: Harness, who: Actor | 'internal', costSetId: number, lightconeName: string, draftModeTag: Mode, l: number[]) =>
    tx(test, who, (ctx) => M.edit_draft_lightcone_cost(ctx, { costSetId, lightconeName, gameModeTag: MOC, draftModeTag, costsJson: sJson(l) }));
export const publishBody = (costSetId: number, confirmFillMissing?: boolean) => (ctx: any) =>
    M.publish_cost_set(ctx, { costSetId, confirmFillMissing });
export const publish = (test: Harness, who: Actor | 'internal', costSetId: number, confirmFillMissing?: boolean) =>
    tx(test, who, publishBody(costSetId, confirmFillMissing));

export const liveChars = (test: Harness, id: number) => [...test.db.HsrCharacterCost.cost_set_id.filter(id)];
export const charRow = (rows: any[], name: string, mode: Mode = 'Classic') =>
    rows.find((r) => r.characterName === name && r.draftMode.tag === mode && r.gameMode.tag === MOC);

// Draft calls with no pricing: a missing row stays missing.
export const pickBody = (s: Lobby, characterName: string, eidolon = 0) => (ctx: any) =>
    M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon });
export const nominateBody = (s: Lobby, characterName: string) => (ctx: any) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName });
export const passBody = (s: Lobby) => (ctx: any) => M.pass_bid(ctx, { lobbyId: s.lobbyId });
export const expireBody = (s: Lobby) => (ctx: any) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId });
export const advanceBody = (s: Lobby) => (ctx: any) => M.advance_stage(ctx, { lobbyId: s.lobbyId });
export const equipBody = (s: Lobby, team: Team, characterName: string, lightconeName: string, superimposition = 1) => (ctx: any) =>
    M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: { tag: team }, characterName, lightconeName, superimposition });

export const lastStepOf = (test: Harness, lobbyId: number, action: string) =>
    steps(test, lobbyId).filter((st) => st.action.tag === action).sort((a, b) => b.sequence - a.sequence)[0];
export const payloadOf = (test: Harness, lobbyId: number, action: string) => lastStepOf(test, lobbyId, action).payload.value as any;
export const lobbyState = (s: Lobby) =>
    snap(lobbyRow(s.test, s.lobbyId), session(s.test, s.lobbyId), steps(s.test, s.lobbyId).sort((a, b) => a.sequence - b.sequence));
export const expireTurn = (s: Lobby) => {
    advance(s.test, TURN_MS);
    tx(s.test, s.host, expireBody(s));
};

/**
 * beforeStart for autoRandomPick lobbies: start_draft requires every player to hold a selected account with characters.
 * Each player seat gets one account owning `owned[name]` (default: one unpriced filler, which no pool ever draws).
 */
export const withAccounts = (test: Harness, owned: Record<string, Record<string, number>> = {}) => (l: Lobby) => {
    dropDefaultCostCoverage(test); // fix pass (review F2): the set-0 coverage rows leave the timer pools once the lobby exists
    let id = 900;
    for (const [name, who] of Object.entries(l.a)) {
        const m = [...test.db.LobbyMember.by_lobby_and_user.filter([l.lobbyId, who.userId])][0];
        if (!m || (m.lobbySlot.tag !== 'BluePlayer' && m.lobbySlot.tag !== 'RedPlayer')) continue;
        selectAccount(test, l.lobbyId, who.userId, id++, owned[name] ?? { [`own-${name}`]: 0 });
    }
};

/** The non-captain Blue player of a 2v2 lobby. */
export const blueMate = (s: Lobby) => [s.a.b1, s.a.b2].find((a) => a.userId !== captain(s, 'Blue').userId)!;
