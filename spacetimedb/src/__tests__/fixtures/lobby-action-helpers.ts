// Shared helpers: lobby actions (join, leave, chat, abandon), cursor events and snapshots.
// From S10h (s10h-lobby-rulings.test.ts); not a test file.
import { DEFAULT_LOBBY_ARGS, M, tx, type Actor, type Harness } from './harness';

export type Ctx = Parameters<Parameters<Harness['withReducerTx']>[1]>[0];

/** A JSON snapshot (bigint-safe), to prove "nothing changed" across a rejected call. */
export const snap = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
export const lobbyOfHost = (test: Harness, who: Actor) => [...test.db.Lobby.iter()].find((l) => l.hostUserId === who.userId)?.id;
export const join = (test: Harness, who: Actor, lobbyId: number, password = '') =>
    tx(test, who, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password }));
export const leave = (test: Harness, who: Actor, lobbyId: number) => tx(test, who, (ctx) => M.leave_lobby(ctx, { lobbyId }));
export const chat = (test: Harness, who: Actor, lobbyId: number, content: string) =>
    tx(test, who, (ctx) => M.send_chat_message(ctx, { lobbyId, content, metadata: '' }));
export const abandon = (test: Harness, who: Actor) =>
    tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));

// ════════════════════════════════════════════════════════════════════════════
// 3. A96: cursor events carry the seat
// ════════════════════════════════════════════════════════════════════════════

/** broadcast_cursor as `who`; returns the LobbyCursorEvent rows the call inserted (event rows live only in the transaction). */
export function cursorEvents(test: Harness, who: Actor, lobbyId: number): any[] {
    return tx(test, who, (ctx) => {
        M.broadcast_cursor(ctx, { lobbyId, x: 0.5, y: 0.5 });
        return [...ctx.db.LobbyCursorEvent.iter()].map((r: any) => ({ ...r }));
    });
}
