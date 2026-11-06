# Chat

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Lobby chat provides ephemeral, per-lobby messaging for all lobby members. Messages are bounded by a rolling window (50 max per lobby) to cap reconnect egress. The system supports text, reply, and emoji-only message types via a metadata JSON schema. Anonymous mode enforcement happens server-side: real `senderUserId` is always stored, but the `view_my_lobby_chat` view anonymizes it per-viewer. System messages (join, leave, kick, ban, draft start, stage transitions) share the same table with `senderType=System`. Host, referee, and admin/moderator can delete individual messages.

## Reducers

### send_chat_message

**Purpose:** Insert a player chat message into a lobby's rolling message window.

**Permission:** Any authenticated lobby member (D-10)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby |
| content | string | Yes | Message text (1-500 chars) |
| metadata | string | Yes | JSON string; defaults to `{"type":"text"}` if empty |

**Flow:**
1. Authenticate caller via `getAuthenticatedUser(ctx)`
2. Verify caller is a member of the lobby via `ensureLobbyMember(ctx, lobbyId, user.id)`
3. Validate content: reject empty (`length === 0`) and over-limit (`length > 500`)
4. Validate/default metadata:
   - Empty string -> resolves to `{"type":"text"}`
   - Non-empty -> parse as JSON, require `type` field with value `"text"`, `"reply"`, or `"emoji_only"`; reject on parse failure or invalid type
5. Enforce rolling window: query all `ChatMessage` rows for `lobbyId`, sort by `createdDate` ascending; if count >= 50, delete the oldest row
6. Compute `anonymousLabel` if lobby has `isAnonymousPlayers` or `isAnonymousSpectators` enabled
7. Insert `ChatMessage` row with `senderType: Player`, `senderUserId: user.id`, resolved metadata, computed anonymousLabel, and audit columns
8. Update `Lobby.lastActivityAt` to current timestamp

**Expected State Changes:**
- `ChatMessage` row inserted (senderType=Player, senderUserId=caller)
- Oldest `ChatMessage` row deleted if lobby had 50 messages before insert
- `Lobby.lastActivityAt` updated

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller not authenticated | (thrown by `getAuthenticatedUser`) |
| Caller not a lobby member | (thrown by `ensureLobbyMember`) |
| Empty content | "Message cannot be empty." |
| Content > 500 characters | "Message exceeds 500 character limit." |
| Invalid metadata JSON or missing/invalid type field | "Invalid metadata JSON. Expected: { type: \"text\" \| \"reply\" \| \"emoji_only\", replyToMessageId?: number }" |

### delete_chat_message

**Purpose:** Hard-delete a single chat message from a lobby (moderation action).

**Permission:** Host, referee in that lobby, admin, or moderator (D-26)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| messageId | u32 | Yes | ChatMessage.id to delete |

**Flow:**
1. Authenticate caller via `getAuthenticatedUser(ctx)`
2. Look up `ChatMessage` by id; throw if not found
3. Look up `Lobby` by message's `lobbyId`; throw if not found
4. Permission check (any one sufficient):
   - `lobby.hostUserId === user.id` (host)
   - `LobbyMember.isReferee === true` for caller in this lobby (referee)
   - `isRoleAtLeast(user.role, 'Moderator')` (admin or moderator)
5. Delete the `ChatMessage` row

**Expected State Changes:**
- `ChatMessage` row deleted
- Other messages with `replyToMessageId` pointing to this message are NOT modified (dangling reference allowed)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller not authenticated | (thrown by `getAuthenticatedUser`) |
| Message not found | "Message not found." |
| Lobby not found | "Lobby not found." |
| Caller is not host, referee, admin, or moderator | "Only the host, referees, moderators, or admins can delete chat messages." |

## Acceptance Scenarios

### Happy Path: Send a Text Message
**Given:** Lobby exists, Player A is a member, lobby has < 50 messages
**When:** Player A calls `send_chat_message(lobbyId, "hello", "")`
**Then:** ChatMessage inserted with content="hello", metadata=`{"type":"text"}`, senderType=Player, senderUserId=PlayerA.id. Lobby.lastActivityAt updated.

### Happy Path: Send a Reply
**Given:** Lobby exists, Player A is a member, message #42 exists
**When:** Player A calls `send_chat_message(lobbyId, "I agree", '{"type":"reply","replyToMessageId":42}')`
**Then:** ChatMessage inserted with metadata=`{"type":"reply","replyToMessageId":42}`.

### Happy Path: Send an Emoji-Only Message
**Given:** Lobby exists, Player A is a member
**When:** Player A calls `send_chat_message(lobbyId, ":thumbsup:", '{"type":"emoji_only"}')`
**Then:** ChatMessage inserted with metadata=`{"type":"emoji_only"}`.

### Rolling Window Enforcement
**Given:** Lobby has exactly 50 ChatMessage rows, oldest is message #1 (earliest createdDate)
**When:** Player A calls `send_chat_message(lobbyId, "message 51", "")`
**Then:** Message #1 deleted. New message inserted. Lobby still has exactly 50 messages.

### Anonymous Mode: Label Computed on Insert
**Given:** Lobby has `isAnonymousPlayers=true`, Player A is a member
**When:** Player A calls `send_chat_message(lobbyId, "hi", "")`
**Then:** ChatMessage inserted with `anonymousLabel` populated (e.g., "Blue-1"). `senderUserId` is still Player A's real ID on the row.

### Anonymous Mode: View Anonymizes
**Given:** Lobby has `isAnonymousPlayers=true`, Player A sent a message, Player B is on the opposing team
**When:** Player B subscribes to `view_my_lobby_chat`
**Then:** Player A's message appears with `senderUserId=0` and `anonymousLabel="Blue-1"` (or equivalent). System messages appear with real `senderType=System` and are never anonymized.

### System Message on Join
**Given:** Lobby exists in Waiting stage
**When:** Player A calls `join_lobby(lobbyId)`
**Then:** ChatMessage inserted with senderType=System, senderUserId=0, content="{displayName} joined the lobby."

### System Message on Leave
**Given:** Player A is a lobby member
**When:** Player A calls `leave_lobby(lobbyId)`
**Then:** ChatMessage inserted with senderType=System, senderUserId=0, content="{displayName} left the lobby."

### System Message on Kick
**Given:** Host and Player B are in the lobby
**When:** Host calls `kick_member(lobbyId, playerB.userId)`
**Then:** ChatMessage inserted with senderType=System, senderUserId=0, content="{displayName} was kicked from the lobby."

### System Message on Ban
**Given:** Host and Player B are in the lobby
**When:** Host calls `ban_member(lobbyId, playerB.userId)`
**Then:** ChatMessage inserted with senderType=System, senderUserId=0, content="{displayName} was banned from the lobby."

### System Message on Draft Start
**Given:** Lobby in Drafting stage, draft ready
**When:** `start_draft` triggers (classic draft)
**Then:** ChatMessage inserted with senderType=System, content="Draft has started!"

### System Message on Stage Transition (Equipping)
**Given:** Draft completes
**When:** `advance_stage` transitions Drafting -> Equipping
**Then:** ChatMessage inserted with senderType=System, content="Draft complete. Stage: Equipping"

### System Message on Stage Transition (Scoring)
**Given:** Equipping completes
**When:** `advance_stage` transitions Equipping -> Scoring
**Then:** ChatMessage inserted with senderType=System, content="Lineups set. Stage: Scoring"

### Delete Message by Host
**Given:** Player A sent message #10 in a lobby, User B is the host
**When:** Host calls `delete_chat_message(10)`
**Then:** ChatMessage #10 deleted. No other messages modified.

### Delete Message by Referee
**Given:** Player A sent message #10, User C is a referee (LobbyMember.isReferee=true)
**When:** Referee calls `delete_chat_message(10)`
**Then:** ChatMessage #10 deleted.

### Delete Message by Admin/Moderator
**Given:** Player A sent message #10, User D has Admin or Moderator role
**When:** Admin calls `delete_chat_message(10)`
**Then:** ChatMessage #10 deleted.

### Reply to Deleted Message (Dangling Reference)
**Given:** Message #10 exists, Player A sends reply with `replyToMessageId: 10`
**When:** Host deletes message #10
**Then:** Player A's reply still exists with metadata `replyToMessageId: 10`. No cascade, no error. Frontend renders "Reply to deleted message."

### Metadata Defaults When Empty
**Given:** Lobby exists, Player A is a member
**When:** Player A calls `send_chat_message(lobbyId, "hi", "")`
**Then:** Message stored with metadata=`{"type":"text"}`.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Empty content string | Rejected: "Message cannot be empty." | Zero-length guard |
| Content exactly 500 chars | Accepted | Boundary: `> 500` is the check |
| Content 501 chars | Rejected: "Message exceeds 500 character limit." | Off-by-one boundary |
| Non-member sends message | Rejected by `ensureLobbyMember` | Membership required |
| Regular player tries to delete | Rejected: "Only the host, referees, moderators, or admins can delete chat messages." | No self-delete for players |
| Delete non-existent message | Rejected: "Message not found." | Guard on lookup |
| Reply to deleted message | Allowed; dangling `replyToMessageId` OK | No FK enforcement on metadata JSON |
| Reply to message in different lobby | Backend does not validate `replyToMessageId` exists or belongs to same lobby | Client responsibility |
| Metadata with unknown type (e.g., `{"type":"image"}`) | Rejected: invalid metadata JSON error | Only text/reply/emoji_only allowed |
| Metadata with valid JSON but no type field | Rejected: invalid metadata JSON error | `type` is required |
| Metadata that is not valid JSON | Rejected: invalid metadata JSON error | Parse failure caught |
| System messages count toward rolling window | Yes, oldest (system or player) deleted at 50 | Uniform rolling window |
| Lobby close cascade | All ChatMessage rows for lobby hard-deleted | Ephemeral; no history table |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `ChatMessage.lobbyId` | `Lobby.id` | FK reference | Reads |
| `ChatMessage.senderUserId` | `User.id` | FK reference | Reads |
| `send_chat_message` | `Lobby.lastActivityAt` | Updates timestamp on send | Writes |
| `view_my_lobby_chat` | `LobbyMember`, `Lobby` | Membership + anonymous settings | Reads |
| `view_my_lobby_chat` | `shouldAnonymize()` | Per-viewer anonymization | Reads |
| `join_lobby`, `leave_lobby`, `kick_member`, `ban_member` | `ChatMessage` | System message insert | Writes |
| `start_draft` (classic) | `ChatMessage` | System message insert | Writes |
| `advance_stage` (postDraft) | `ChatMessage` | System message insert (Equipping, Scoring) | Writes |
| `close_lobby` / auto-close | `ChatMessage` | Cascade hard-delete all lobby messages | Deletes |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| All lobby members can send chat (D-10) | Phase 9 execution | 2026-03-29 |
| System messages on join/leave/kick/ban/draft/stage (D-11) | Phase 9 execution | 2026-03-29 |
| 500 character limit (D-12) | Phase 9 execution | 2026-03-29 |
| Rolling window of 50 messages per lobby (D-13) | Phase 9 execution | 2026-03-29 |
| Metadata JSON schema with type validation (D-14) | Phase 9 execution | 2026-03-29 |
| Emoji stored as unicode or `:shortcode:` in content (D-15) | Phase 9 execution | 2026-03-29 |
| Dangling replyToMessageId allowed on delete (D-17) | Phase 9 execution | 2026-03-29 |
| Anonymous label computed on insert, view anonymizes per-viewer (D-18, D-92) | Phase 9 execution | 2026-03-29 |
| Host/referee/admin/moderator can delete messages (D-26) | Phase 9 execution | 2026-03-29 |
| Chat messages ephemeral, cascade-deleted on lobby close (CHAT-03) | Phase 9 execution | 2026-03-29 |
| Client reads via view_my_lobby_chat, not raw ChatMessage table (D-92) | Phase 9 execution | 2026-03-29 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 9*
