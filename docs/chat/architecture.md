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
        anonymousLabel: string? (A97: the sender's seat label at send time, e.g. "Blue Player #3"; every Player message since S10h)
        createdById: u32
        createdDate: Timestamp
        lastModifiedById: u32
        lastModifiedDate: Timestamp
        Indexes: lobby_id (btree, lobbyId)
```

## Reducer Flows

### send_chat_message(lobbyId, content, metadata?)
1. `getAuthenticatedUser(ctx)` -- resolve caller; `ensurePresentMember` (the caller's `LobbyMember` row in this lobby, not away or abandoned; A98)
2. Validate `content.length <= 500` (D-12)
3. If `metadata` provided: validate parses as JSON with valid `type` field (`text` | `reply` | `emoji_only`) -- reject with `SenderError` if invalid (D-14). S10e (lobby audit #5): `metadata` is at most 200 characters, checked first ("Message metadata exceeds 200 character limit.")
4. Rolling window (D-13): `trimChatForInsert` (`helpers/lobby/chatWindow.ts`) deletes the oldest rows by `createdDate` until one insert leaves the lobby at 50 (S10e: the shared helper; same rule as before for a lobby at the window)
5. Write the real `senderUserId` and `anonymousLabel = computeAnonymousLabel(ctx, lobbyId, userId)` (A97 seat label, stored on every message since S10h, whatever the lobby's anonymity at send time; lobby audit #25). `view_my_lobby_chat` emits the label only for a sender anonymized for the reader.
6. Insert `ChatMessage` row with `senderType=Player`

Rate limit (Phase S5 execution; DECISIONS.md A43, D-B5; ACCESS-SECURITY-OPS B-4), before the rolling-window delete, values read from `AbuseConfig` at call time (`consumeChatAllowance`, `helpers/lobby/abuseControls.ts`):
- Minimum interval: reject when the caller's newest `senderType=Player` message in this lobby is younger than `chatMinIntervalMs` (default 700 ms). A user is in one lobby at a time, so the lobby's messages (already loaded for the window) are the source; no extra column.
- Per minute: a fixed one-minute window in `UserRateState` (`chatWindowStart`, `chatCount`; row created on first use); reject once `chatPerMinute` (default 30) messages fell in the window. No role is exempt.

### delete_chat_message(messageId)
1. `getAuthenticatedUser(ctx)` -- resolve caller
2. Find `ChatMessage` by id -- reject if not found
3. Permission check -- any of:
   - `lobby.hostUserId === caller.id`
   - `LobbyMember.isReferee === true` for caller in this lobby
   - `isRoleAtLeast(caller.role, 'Moderator')`
   - A98: a caller who is not Moderator+ and holds a row in the lobby must be present (`ensurePresentIfMember`)
4. Hard-delete the message row

### System messages (inserted by other reducers)
Inserted by: `join_lobby`, `leave_lobby`, `kick_member`, `ban_member`, `advance_stage` (Drafting->Equipping, Equipping->Scoring), `start_draft`.
- `senderType=System`, `senderUserId=0`, no `anonymousLabel`
- Subject to the same 50-message rolling window. S10e (lobby audit #6 / #14): `postMemberEventChat` and `start_draft`'s "Draft has started!" call `trimChatForInsert` before their insert (before S10e they inserted without trimming, so join / leave loops grew the table without bound). Still open: the `advance_stage` lines (`postDraft.ts`, trimmed by auto-increment id) and `postSystemChat` (`helpers/results/scoringHelpers.ts`, by id; concede / defer lines) do not use the helper yet.
- S9a fix (A37): member events (`join_lobby` joined / back, `leave_lobby` left / away, `kick_member` kicked, `ban_member` banned) go through `postMemberEventChat` (`helpers/lobby/memberEventChat.ts`): `content` keeps the plain text with the display name (the table is private), `metadata = {"event","subjectUserId"}`, and `anonymousLabel` holds the subject's seat label (in every lobby since the S10h fix pass, review F7; before, only in an anonymous lobby), read before any row removal. `view_my_lobby_chat` renders these lines per reader through `renderSystemChat` (`helpers/identity/viewAnonymity.ts`): template `{member} joined the lobby.` / `left the lobby.` / `left the match.` / `is back.` / `was kicked from the lobby.` / `was banned from the lobby.`, `{member}` = display name when the subject is visible to the reader, else the stored label, else (nothing stored) the live seat label, else "A player" (`storedOrLiveLabel`, S10h review F6); metadata goes out with `subjectUserId = 0` for a hidden subject. Other System lines pass through unchanged.

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
| Chat rate limit: `chatMinIntervalMs` since the sender's last message + `chatPerMinute` fixed window in `UserRateState`, both from `AbuseConfig` | Phase S5 execution (DECISIONS.md A43, D-B5) | 2026-11-06 |
| Member-event System lines carry `metadata {event, subjectUserId}` + the seat label and are rendered per reader in `view_my_lobby_chat` (no hidden member named) | Phase S9a execution (DECISIONS.md A37) | 2026-11-08 |
| Metadata capped at 200 characters; one window helper (`trimChatForInsert`, by `createdDate`) used by player messages, member-event lines and the draft start line | Phase S10e execution (lobby audit #5, #6) | 2026-11-09 |
| A97 seat labels ("Blue Player #3"): stored on every Player message; `view_my_lobby_chat` shows the live seat label while the sender holds a row, else the stored one, else "A player" (labels stored before S10h are position-based and are shown only for a sender who left; S11 clear-publish empties the table). A98: away / abandoned senders rejected | Phase S10h execution (DECISIONS.md A97, A98) | 2026-11-09 |
| Fix pass: `view_my_lobby_chat` and the member-event lines prefer the stored label, the live one only when none was stored (`storedOrLiveLabel`; a rejoin no longer relabels old lines, review F6); member-event lines store the subject's label in every lobby (review F7) | Phase S10h execution (S10h review F6, F7; DECISIONS.md A97) | 2026-11-10 |

---

*Last updated: 2026-11-09*
*Feature owner: Phase 09*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
