# Anonymous Play -- Architecture

Last updated: 2026-04-09

## Overview

Anonymous play is enforced at the server write layer, not at the client display layer. When a lobby has `isAnonymousPlayers=true` or `isAnonymousSpectators=true`, reducers that write to real-time tables replace the real userId with a sentinel value (0) and attach a deterministic label computed from LobbyMember data. The frontend subscribes to views that further enforce anonymization per-viewer -- no conditional branching needed on the client.

There are no anonymous-play-specific tables. This feature is implemented entirely through the write-layer pattern in existing table reducers, the label computation helper, and server-side views.

## Table Relationships

```
Lobby (id: u32 autoInc PK)
  +-- isAnonymousPlayers: bool  (anonymizes players + coaches)
  +-- isAnonymousSpectators: bool  (anonymizes spectators)
  +-- isTournamentControlled: bool  (inherits from Tournament when true)

Tournament (id: u32 autoInc PK)
  +-- isAnonymousDefault: bool  -> propagates to Lobby.isAnonymousPlayers when isTournamentControlled
  +-- isAnonymousSpectators: bool  -> propagates to Lobby.isAnonymousSpectators when isTournamentControlled

Real-time tables with write-layer anonymization:
  LobbyCursorEvent
    +-- senderJoinSeq: u32  (A96, S10h: the sender's seat, never the user id, in every lobby)

  MatchSessionStep
    +-- actorUserId: u32  (0 when anonymous)
    +-- anonymousLabel: string?

  ChatMessage
    +-- senderUserId: u32  (the real sender; view_my_lobby_chat masks it)
    +-- anonymousLabel: string?  (A97 seat label at send time, every Player message)

History tables (real userIds preserved -- gated by views):
  MatchParticipantHistory
    +-- userId: u32  (real userId for post-match replay)
    +-- displayName: string

  MatchSessionStepHistory
    +-- actorUserId: u32  (real userId)
    +-- actorDisplayName: string
```

## Reducer Flows

### broadcast_cursor(lobbyId, x, y)
1. Resolve caller from `ctx.sender` via UserIdentity
2. Find `LobbyMember` for caller in this lobby (silent return when absent, away or abandoned, A98)
3. A96 (S10h): insert `LobbyCursorEvent` with `senderJoinSeq = member.joinSeq` in every lobby; no user id and no label (the client resolves the seat through `view_my_lobby_members`). The table is still public. Row-level security (`clientVisibilityFilter`) exists in the installed 2.14.1 SDK and upstream says it applies to event tables, but upstream labels it experimental and unstable and this repo's skill forbids it; views cannot read event tables; so no stable mechanism exists and the stream stays public, carrying only the lobby id, the seat number and the position (A96; the route is the user's call; details in `docs/lobby/architecture.md` "Phase S10h execution").

### send_chat_message(lobbyId, content, metadata?)
1. Resolve caller, find lobby, find LobbyMember
2. Validate content length (<=500 chars) and metadata JSON
3. Store the real `senderUserId` and the A97 seat label (`anonymousLabel`, every message); `view_my_lobby_chat` masks per reader
4. Rolling window: delete oldest if >50 messages per lobby
5. Insert `ChatMessage` row

### Draft step reducers (pick, ban, etc.)
1. Resolve caller, find lobby
2. If `lobby.isAnonymousPlayers`: compute label, write `actorUserId=0`, `anonymousLabel`
3. Insert `MatchSessionStep` row with sentinel or real userId

### computeAnonymousLabel(ctx, lobbyId, userId) -- helper (A97, S10h)
1. Look up the user's `LobbyMember` row for the given lobbyId (`by_lobby_and_user`); none -> "Unknown"
2. `anonymousSeatLabel(member)`: seat kind from `lobbySlot` + the seat number `joinSeq`:
   - BluePlayer -> "Blue Player #{joinSeq}", RedPlayer -> "Red Player #{joinSeq}"
   - BlueCoach -> "Blue Coach #{joinSeq}", RedCoach -> "Red Coach #{joinSeq}"
   - Spectator -> "Spectator #{joinSeq}"
3. The seat number never changes and is never reused (A74(3)), so a label names one membership for the lobby's lifetime: a departure never shifts another member's label (the old position-among-peers label did). It changes only when the member changes seat kind in Waiting. No peer row is read; no user id appears.

## View Definitions

### Real-time views (view_my_* prefix -- scoped to caller's lobbies)

| View | Source Table | Anonymizes |
|------|-------------|------------|
| `view_my_lobby_chat` | ChatMessage | senderUserId; label = the label stored with the message, else (nothing stored) the live seat label while the sender holds a row, else "A player" (A97; S10h review F6: one label per membership, a rejoin does not relabel old lines). Member-event lines follow the same rule and store the subject's label in every lobby (review F7) |
| `view_my_lobby_members` | LobbyMember | userId, resolves displayName or label |
| `view_my_match_steps` | MatchSessionStep | actorUserId |
| `view_my_match_participants` | MatchResultParticipant | userId |

`shouldAnonymize()` decides per-row whether to mask identity based on lobby anonymous settings and caller's team membership. Non-anonymous lobbies: views return real data. Anonymous lobbies: views mask opponent data. Same subscription either way.

### History views (post-match -- gated by isPubliclyVisible)

| View | Source Table | Gate |
|------|-------------|------|
| `view_match_history` | MatchSessionHistory | isPubliclyVisible OR participated |
| `view_match_participant_history` | MatchParticipantHistory | same |
| `view_match_step_history` | MatchSessionStepHistory | same |

All three share `buildVisibleMatchIds()` for consistent visibility logic. Tournament match history stays hidden until `revealTournamentHistory` sets `isPubliclyVisible=true` at tournament completion.

### Frontend subscription queries
```
SELECT * FROM view_my_lobby_chat
SELECT * FROM view_my_lobby_members
SELECT * FROM view_my_match_steps
SELECT * FROM view_my_match_participants
SELECT * FROM view_match_history
SELECT * FROM view_match_participant_history
SELECT * FROM view_match_step_history
```

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Write-layer sentinel pattern -- server replaces userId with 0 on real-time tables (D-01) | Phase 06 CONTEXT.md | 2026-03-07 |
| History tables keep real userIds for post-match replay (D-02) | Phase 06 CONTEXT.md | 2026-03-07 |
| Match result tables are server-internal ephemeral records, never displayed during match (D-03) | Phase 06 CONTEXT.md | 2026-03-07 |
| Team-based deterministic labels from LobbyMember data (D-04, D-05) | Phase 06 CONTEXT.md | 2026-03-07 |
| Tournament anonymous inheritance via isTournamentControlled (D-06) | Phase 06 CONTEXT.md | 2026-03-07 |
| Independent toggles for players vs spectators (D-07) | Phase 06 CONTEXT.md | 2026-03-07 |
| Anonymous mode locked after lobby creation, host-controlled (D-08) | Phase 06 CONTEXT.md | 2026-03-07 |
| Bracket anonymization is client-side courtesy only -- not a security boundary (D-09) | Phase 06 CONTEXT.md | 2026-03-07 |
| Real-time views (D-92) and history views (D-93) added; frontend subscribes to views, not raw tables | Phase 06 execution | 2026-03-07 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| A96: cursor events carry `senderJoinSeq`, never a user id; A97: labels from seat kind + seat number ("Blue Player #3"), chat stores the label on every message and the chat view prefers the live seat label | Phase S10h execution (DECISIONS.md A96, A97) | 2026-11-09 |
| Fix pass: the chat view and member-event lines prefer the stored label (live only when none was stored; review F6); member-event lines store the label in every lobby (F7); the A96 restriction statement corrected: RLS exists but is experimental and forbidden here, no stable mechanism (F2) | Phase S10h execution (S10h review F2, F6, F7; DECISIONS.md A96, A97) | 2026-11-10 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 06*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
