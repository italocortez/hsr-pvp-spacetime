# Chat -- Architecture

Last updated: 2026-04-09

## Overview

Chat provides ephemeral per-lobby messaging. Messages are bounded to 50 per lobby via a rolling window -- the oldest message is deleted before inserting a new one once the limit is reached. Messages are never archived or replayed. On lobby close, all ChatMessage rows for that lobby are hard-deleted in the same transaction. The real `senderUserId` is always stored; anonymous enforcement is applied at read-time via `view_my_lobby_chat`.

## Table Relationships

```
Lobby (id: u32 autoInc PK)
  +-- ChatMessage (id: u32 autoInc PK)
        lobbyId -> Lobby.id  [btree: lobby_id]
        senderUserId: u32 -> User.id (real userId; 0=System)
        senderType: ChatSenderType (Player | System)
        content: string (max 500 chars, server-enforced)
        metadata: string? (JSON: { type, replyToMessageId? })
        anonymousLabel: string? (pre-computed label e.g. "Blue-1" when anonymous)
        createdById: u32
        createdDate: Timestamp
        lastModifiedById: u32
        lastModifiedDate: Timestamp
        Indexes: lobby_id (btree, lobbyId)
```

## Reducer Flows

### send_chat_message(lobbyId, content, metadata?)
1. `getAuthenticatedUser(ctx)` -- resolve caller; find `LobbyMember` for caller in this lobby
2. Validate `content.length <= 500` (D-12)
3. If `metadata` provided: validate parses as JSON with valid `type` field (`text` | `reply` | `emoji_only`) -- reject with `SenderError` if invalid (D-14)
4. Rolling window (D-13): count messages via `lobby_id` index; if >= 50, delete oldest by `createdDate`
5. Anonymous enforcement: if `lobby.isAnonymousPlayers || lobby.isAnonymousSpectators`:
   - Compute `computeAnonymousLabel(ctx, lobbyId, userId)`
   - Write `senderUserId=0`, `anonymousLabel=computedLabel`
6. Otherwise: write `senderUserId=userId`, `anonymousLabel=undefined`
7. Insert `ChatMessage` row with `senderType=Player`

### delete_chat_message(messageId)
1. `getAuthenticatedUser(ctx)` -- resolve caller
2. Find `ChatMessage` by id -- reject if not found
3. Permission check -- any of:
   - `lobby.hostUserId === caller.id`
   - `LobbyMember.isReferee === true` for caller in this lobby
   - `isRoleAtLeast(caller.role, 'Moderator')`
4. Hard-delete the message row

### System messages (inserted by other reducers)
Inserted by: `join_lobby`, `leave_lobby`, `kick_member`, `ban_member`, `advance_stage` (Drafting->Equipping, Equipping->Scoring), `start_draft`.
- `senderType=System`, `senderUserId=0`, no `anonymousLabel`
- Subject to the same 50-message rolling window

### Lifecycle cleanup (close_lobby / auto-close)
- All `ChatMessage` rows for the lobby are hard-deleted via `lobby_id` index before the Lobby row is deleted (D-19, CHAT-03)
- No archival -- chat is not written to any history table

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Ephemeral chat -- messages not persisted after lobby close (CHAT-03) | Phase 09 CONTEXT.md | 2026-03-28 |
| 500 character limit per message, enforced server-side (D-12) | Phase 09 CONTEXT.md | 2026-03-28 |
| Rolling window of 50 -- oldest deleted on insert when limit reached (D-13) | Phase 09 CONTEXT.md | 2026-03-28 |
| Metadata JSON validates against { type, replyToMessageId? } schema (D-14) | Phase 09 CONTEXT.md | 2026-03-28 |
| Real senderUserId stored; view layer anonymizes (D-18, D-92) | Phase 09 CONTEXT.md | 2026-03-28 |
| System messages share same table with senderType=System flag (D-11) | Phase 09 CONTEXT.md | 2026-03-28 |
| delete_chat_message added for host/referee/mod moderation (D-26) | Phase 09 execution | 2026-03-28 |
| Reply to deleted message: backend stores dangling replyToMessageId; frontend handles gracefully (D-17) | Phase 09 CONTEXT.md | 2026-03-28 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 09*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
