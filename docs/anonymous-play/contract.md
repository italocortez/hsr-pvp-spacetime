# Anonymous Play

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Anonymous play allows lobbies and tournaments to hide real player identities during live matches. When enabled, real-time tables (cursor events, chat messages, match steps) replace the sender's real userId with a sentinel value (0) and attach a deterministic label like "Blue-1" or "Red-2". Labels are computed from the LobbyMember's slot and join order — same data always produces the same label, stable across reconnects. History tables always record real identities for post-match replay. Two independent toggles exist: `isAnonymousPlayers` (hides player team members) and `isAnonymousSpectators` (hides spectators separately).

## Anonymous Label Computation

Anonymous labels are computed by `computeAnonymousLabel` in `helpers/anonymousLabels.ts`. This function is called at write-time when inserting into real-time tables (LobbyCursorEvent, ChatMessage, MatchSessionStep).

### Label Format

| LobbySlot category | Label format | Example |
|-------------------|-------------|---------|
| Blue team player | `Blue-{joinOrder}` | Blue-1, Blue-2 |
| Red team player | `Red-{joinOrder}` | Red-1, Red-2 |
| Blue coach | `Coach-Blue` | Coach-Blue |
| Red coach | `Coach-Red` | Coach-Red |
| Spectator | `Spectator-{joinOrder}` | Spectator-1, Spectator-2 |

### Computation Algorithm

1. Look up `LobbyMember` by `[lobbyId, userId]` composite index
2. If member is a coach (`slotIsCoach(member.lobbySlot)`): return `Coach-{team}` (no index)
3. If member is a spectator (`lobbySlot.tag === 'Spectator'`): collect all spectator peers
4. Otherwise: collect peers on same team that are not coaches
5. Sort peers by `createdDate` ascending (join order — earlier join = lower number)
6. Find target user's index in sorted peer list (0-based → 1-based)
7. Return `{prefix}-{index+1}`

### Anonymous Enforcement Points

Anonymous mode applies at write-time in these reducers:
- `send_chat_message` — `isAnonymousPlayers` or `isAnonymousSpectators` checked
- `broadcast_cursor` — `isAnonymousPlayers` or `isAnonymousSpectators` checked
- MatchSessionStep inserts — `isAnonymousPlayers` checked

At read-time, the view `view_my_lobby_chat` re-applies `shouldAnonymize()` per viewer, hiding real senderUserId from opposing team members.

### What Is Never Anonymized

- `MatchParticipantHistory` — always stores real userIds (post-match replay)
- `MatchSessionStepHistory` — always stores real actorUserId + actorDisplayName
- Match result tables — real userIds for server-internal finalization
- Tournament bracket tables — public with real data; display-layer only anonymizes to "Seed-N"

## Acceptance Scenarios

### Anonymous Cursor Broadcast
**Given:** Lobby with isAnonymousPlayers=true, caller is a player in Blue team
**When:** `broadcast_cursor(lobbyId, x, y)`
**Then:** LobbyCursorEvent written with senderUserId=0 and anonymousLabel="Blue-1" (or appropriate label from team slot + join order). Real identity resolved from ctx.sender for auth only, never stored on the row.

### Non-Anonymous Cursor Broadcast
**Given:** Lobby with isAnonymousPlayers=false
**When:** `broadcast_cursor(lobbyId, x, y)`
**Then:** LobbyCursorEvent written with real senderUserId. anonymousLabel is undefined/empty.

### Separate Player/Spectator Toggles
**Given:** Lobby with isAnonymousPlayers=true, isAnonymousSpectators=false
**When:** A player broadcasts cursor
**Then:** Player's cursor has userId=0 + label
**When:** A spectator sends chat
**Then:** Spectator's chat has real userId, no anonymous label

### Tournament Anonymous Inheritance
**Given:** Tournament with isAnonymousDefault=true, lobby created with isTournamentControlled=true
**When:** Lobby inherits settings from tournament
**Then:** Lobby.isAnonymousPlayers=true (inherited from tournament.isAnonymousDefault). Anonymous enforcement applies to all real-time writes in that lobby.

### Label Stability Across Reconnects
**Given:** Player in anonymous lobby with lobbySlot=BluePlayer, join order=2 (label="Blue-2")
**When:** Player disconnects and reconnects
**Then:** Same LobbyMember data produces same label "Blue-2". No randomness or stored label state.

### History Identity Revelation
**Given:** Anonymous lobby, match completed and finalized
**When:** MatchParticipantHistory rows written during finalization
**Then:** Real userIds stored in MatchParticipantHistory (with displayName). Access gated by `view_match_participant_history` and `view_match_step_history` — only visible when `MatchSessionHistory.isPubliclyVisible=true` or caller participated. Tournament matches stay hidden until `revealTournamentHistory` runs on tournament completion.

### Bracket Anonymization (Client-Side)
**Given:** Tournament with isAnonymousDefault=true, bracket generated
**When:** Client renders tournament bracket
**Then:** Client shows "Seed-N" labels instead of player/team names. Bracket tables remain public with real data -- anonymization is a display-layer courtesy.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Anonymous mode on non-anonymous lobby | Normal behavior -- real userId, no label | |
| Coach in anonymous lobby | Label = "Coach-Blue" or "Coach-Red" based on lobbySlot (BlueCoach/RedCoach) | No index number for coaches |
| Spectator in anonymous lobby (isAnonymousSpectators=true) | Label = "Spectator-1", "Spectator-2" etc. | |
| Spectator in anonymous lobby (isAnonymousSpectators=false) | Real userId, no label (independent toggle) | |
| Anonymous mode locked after lobby creation | Cannot change isAnonymousPlayers/isAnonymousSpectators after lobby created | |
| Host controls anonymous setting, not referee | Referee operates within existing lobby config, cannot toggle anonymity | |
| Referee in anonymous lobby | Referee sees real-time data with sentinel userId like everyone else; identity revealed in history | |
| Label collision (two players same slot) | Join order differentiates -- Blue-1, Blue-2, Blue-3 | |
| Tournament lobby with isTournamentControlled=false | Anonymous settings are lobby-local, not inherited from tournament | |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| Lobby.isAnonymousPlayers | LobbyCursorEvent, MatchSessionStep, ChatMessage | Checked on write | Reads |
| Lobby.isAnonymousSpectators | LobbyCursorEvent, ChatMessage | Checked on write | Reads |
| Lobby.isTournamentControlled | Tournament.isAnonymousDefault | Inherits | Reads |
| LobbyMember.lobbySlot + join order | anonymousLabel computation | Reads | Reads |
| MatchParticipantHistory | Real userId + displayName | Writes (finalization) | Writes |
| MatchSessionStepHistory | Real actorUserId + actorDisplayName | Writes (finalization) | Writes |
| BracketMatch (public) | Client-side "Seed-N" display | Client reads | Reads |
| view_my_lobby_chat | shouldAnonymize() per viewer | Read-layer re-enforcement | Reads |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Sentinel userId=0 + anonymousLabel on real-time tables (D-01) | Phase 6 CONTEXT.md | 2026-03-21 |
| History tables keep real userIds for replay (D-02) | Phase 6 CONTEXT.md | 2026-03-21 |
| Match result tables keep real userIds, server-internal (D-03) | Phase 6 CONTEXT.md | 2026-03-21 |
| Team-based labels: Blue-1, Red-2, Coach-Blue, Spectator-1 (D-04) | Phase 6 CONTEXT.md | 2026-03-21 |
| Labels deterministic from LobbyMember data, stable across reconnects (D-05) | Phase 6 CONTEXT.md | 2026-03-21 |
| Tournament anonymous inheritance via isTournamentControlled (D-06) | Phase 6 CONTEXT.md | 2026-03-21 |
| isAnonymousPlayers and isAnonymousSpectators are independent toggles (D-07) | Phase 6 CONTEXT.md | 2026-03-21 |
| Anonymous mode locked after creation, host-controlled (D-08) | Phase 6 CONTEXT.md | 2026-03-21 |
| Bracket anonymization is client-side courtesy, not security boundary (D-09) | Phase 6 CONTEXT.md | 2026-03-21 |
| LobbySlot refactor: teamSlot+participationRole → single lobbySlot enum | Phase 9 execution | 2026-03-29 |
| Read-layer views (view_my_* for lobbies, view_match_* for history) enforce anonymity server-side | Phase 9 execution | 2026-03-29 |
| History views gated by isPubliclyVisible + participation check (D-93) | Phase 9 execution | 2026-03-29 |
| Frontend subscribes to views always — no conditional anonymous/non-anonymous branching | Phase 9 execution | 2026-03-29 |
| Fixed spectator anonymous labels (null-0 → Spectator-N) after LobbySlot refactor | Phase 9 execution | 2026-03-29 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 6*
