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
    +-- senderUserId: u32  (0 when anonymous)
    +-- anonymousLabel: string?  (computed label e.g. "Blue-1")

  MatchSessionStep
    +-- actorUserId: u32  (0 when anonymous)
    +-- anonymousLabel: string?

  ChatMessage
    +-- senderUserId: u32  (0 when anonymous)
    +-- anonymousLabel: string?

History tables (real userIds preserved -- gated by views):
  MatchParticipantHistory
    +-- userId: u32  (real userId for post-match replay)
    +-- displayName: string

  MatchSessionStepHistory
    +-- actorUserId: u32  (real userId)
    +-- actorDisplayName: string
```

## Reducer Flows

### broadcast_cursor(lobbyId, x, y, pageId)
1. Resolve caller from `ctx.sender` via UserIdentity
2. Find `LobbyMember` for caller in this lobby
3. If `lobby.isAnonymousPlayers || lobby.isAnonymousSpectators`:
   - Compute `computeAnonymousLabel(ctx, lobbyId, userId)` from LobbyMember join order
   - Write `senderUserId=0`, `anonymousLabel=computedLabel`
4. Otherwise: write `senderUserId=userId`, `anonymousLabel=undefined`
5. Insert `LobbyCursorEvent` row

### send_chat_message(lobbyId, content, metadata?)
1. Resolve caller, find lobby, find LobbyMember
2. Validate content length (<=500 chars) and metadata JSON
3. If lobby anonymous settings active: compute label, write `senderUserId=0`, `anonymousLabel`
4. Rolling window: delete oldest if >50 messages per lobby
5. Insert `ChatMessage` row

### Draft step reducers (pick, ban, etc.)
1. Resolve caller, find lobby
2. If `lobby.isAnonymousPlayers`: compute label, write `actorUserId=0`, `anonymousLabel`
3. Insert `MatchSessionStep` row with sentinel or real userId

### computeAnonymousLabel(ctx, lobbyId, userId) -- helper
1. Look up the caller's `LobbyMember` row for the given lobbyId
2. Determine role from `lobbySlot`: BlueCoach/RedCoach -> Coach, BluePlayer/RedPlayer -> Player, Spectator
3. Check `isReferee` flag
4. Compute label from slot + join order among peers with same slot:
   - BluePlayer -> "Blue-{N}" (N = join order among BluePlayer members)
   - RedPlayer -> "Red-{N}"
   - BlueCoach -> "Coach-Blue"
   - RedCoach -> "Coach-Red"
   - Spectator -> "Spectator-{N}"
5. Return label string (deterministic, stable across reconnects)

## View Definitions

### Real-time views (view_my_* prefix -- scoped to caller's lobbies)

| View | Source Table | Anonymizes |
|------|-------------|------------|
| `view_my_lobby_chat` | ChatMessage | senderUserId, uses stored anonymousLabel |
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

---

*Last updated: 2026-04-09*
*Feature owner: Phase 06*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
