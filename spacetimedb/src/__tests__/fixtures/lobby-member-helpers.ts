// Shared helpers: lobby member, chat and account rows; leave, abandon and slot moves.
// From S10e (s10e-lobby-identity.test.ts); not a test file.
import { M, tx, type Actor, type Harness, type SlotTag } from './harness';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const members = (test: Harness, lobbyId: number) => [...test.db.LobbyMember.lobby_id.filter(lobbyId)];
export const chatRows = (test: Harness, lobbyId: number) => [...test.db.ChatMessage.lobby_id.filter(lobbyId)];
export const lmaRows = (test: Harness, lobbyId: number, userId: number) =>
    [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])];
export const leave = (test: Harness, who: Actor, lobbyId: number) => tx(test, who, (ctx) => M.leave_lobby(ctx, { lobbyId }));
export const selfSlot = (lobbyId: number, tag: SlotTag) => (ctx: any) => M.set_team_slot(ctx, { lobbyId, lobbySlot: { tag } as any });
export const moveSlot = (lobbyId: number, seat: number, tag: SlotTag) => (ctx: any) =>
    M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seat, lobbySlot: { tag } as any });
