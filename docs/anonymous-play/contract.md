# Anonymous Play

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Anonymous play allows lobbies and tournaments to hide real player identities during live matches. When enabled, real-time tables (cursor events, chat messages, match steps) replace the sender's real userId with a sentinel value (0) and attach a deterministic label like "Blue-1" or "Red-2". Labels are computed from the LobbyMember's slot and join order — same data always produces the same label, stable across reconnects. History tables always record real identities for post-match replay. Two independent toggles exist: `isAnonymousPlayers` (hides player team members) and `isAnonymousSpectators` (hides spectators separately).

## Anonymous Label Computation

Anonymous labels are computed by `computeAnonymousLabel` in `helpers/anonymousLabels.ts`. This function is called at write-time when inserting into real-time tables (LobbyCursorEvent, ChatMessage, MatchSessionStep).
_Amended in Phase S9a execution: peers are ordered by `LobbyMember.joinSeq` (step 5 below), the per-lobby join counter (R4)._

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
_Superseded in Phase S9a execution (DECISIONS.md A37): the history is private; a participant reads their own matches through the `view_my_*_history` views (real identities revealed to the match's participants); `isPubliclyVisible` and the public history views are gone._
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

## A37 / A40 as implemented in the views (Phase S9a execution)

**Rule (A37).** No row a client can read carries a user id for an anonymous context, audit columns included. In a
lobby view, a user id is 0 for the caller when that user is anonymized by the seat rules (`shouldAnonymize`: the caller
is never hidden from themself, teammates see each other, a spectator referee sees everyone, spectators see every
player anonymized, opponents follow `isAnonymousPlayers`), and also when the id no longer belongs to a member of an
anonymous lobby (a leaver, a staff actor) unless the caller is a spectator referee. This covers `Lobby.hostUserId` and
the audit columns of `view_my_lobby`, chat senders, step actors, result participants, `disputedByUserId`,
`winnerOverrideById`, the game's `validatedByUserId` / `closedById` and each adjustment's `setById`. Live views drop
the audit columns of session, lineup, result, group-score and adjustment rows. The lobby browser and the tournament
arg views are shared anonymous views and emit no user id in an anonymous context (`view_lobby_browser` never does).

**Labels.** A lobby label comes from the seat and the join order (`computeAnonymousLabel`, peers ordered by
`LobbyMember.joinSeq`), never from the id: `Blue-1`, `Red-2`, `Coach-Blue`, `Spectator-1`. A tournament label is the
participant's alias, else `Seat-<n>` with `n` the enrollment order.

**Ratings (A40).** An account rating is exact wherever the lobby's roster visibility allows it (`OpenRoster`,
`ClosedWithRating`), on anonymized seats too; under `ClosedNoRating` a seat shows the rating only to its owner, its
teammates and a spectator referee. MMR (`mmrByMode`) is shown only on identified seats and only while the lobby's
`hideMmr` is off.

**Accepted residual risk (A40).** Matching an exact rating, or the award timing of a public achievement, against a
public listing can defeat anonymity; the project accepts this and does not try to prevent it.

### S9a-A1 Opponent anonymized in every live view
**Given** an anonymous-players lobby in Scoring, Alice on Blue, Bob on Red
**When** Bob reads the member, chat, step, participant, result and game views
**Then** every Alice id is 0 and her seat is labelled "Blue-1"; Bob's own rows and his teammates' carry real ids.

### S9a-A2 Leaver stays hidden
**Given** the same lobby, where a Blue coach who once wrote in chat has left
**When** Bob reads `view_my_lobby_chat`
**Then** the coach's messages carry `senderUserId = 0` and the label stored at write time.

### S9a-A3 Rating shown on an anonymized seat
**Given** the lobby uses `ClosedWithRating`
**When** Bob reads `view_my_lobby_members`
**Then** Alice's seat shows her exact account rating and account count, no MMR, avatar or title (A40).


## S9a fix pass (Phase S9a execution)

**Seat kind picks the toggle (A37; D-07).** `shouldAnonymize` reads the flag of the *target's* seat kind: a spectator
target is hidden when `isAnonymousSpectators` is on, a player or coach target when `isAnonymousPlayers` is on, for a
spectator caller and an opposing player alike (the exemptions stay: the caller themself, teammates, a spectator
referee). This supersedes the S9a-section sentence "spectators see every player anonymized, opponents follow
`isAnonymousPlayers`" for the spectator-target case. `view_lobby_browser` shows "Anonymous host" when the host's own
seat kind is anonymous.

**Member-event chat lines.** Join / leave / away / return / kick / ban System messages store
`metadata = { "event", "subjectUserId" }` and the subject's seat label (anonymous lobby) at write time;
`view_my_lobby_chat` renders the event template with the label the reader may see (display name when the subject is
visible, else the live seat label, else the stored label, else "A player") and emits the metadata with
`subjectUserId = 0` for a hidden subject.

**Other S9a fix-pass rules.** A banned user hidden from the host / referee reads `bannedUserId = 0` and the label
"Banned player" in `view_my_lobby_bans`. A step actor or result participant hidden from the caller always carries a
seat label computed at read time (a departed actor: stored label or "<Side> player"; never "Unknown"). In an anonymous
tournament, `view_tournament_registrant_accounts` gives a non-staff reader the other participants' rows with
`userId = 0`, `hsrAccountId = 0` and their `seat`. A tournament `Seat-<n>` is the enrollment rank, so it renumbers
when an earlier enrollment is withdrawn (the row is deleted, A26a(1)); the alias is the stable label.

### S9a-A4 Spectators follow their own toggle
**Given** a lobby with `isAnonymousSpectators = true`, `isAnonymousPlayers = false`, Carol a spectator, Bob on Red
**When** Bob reads `view_my_lobby_members` and `view_my_lobby_chat`
**Then** Carol's seat and messages carry `userId = 0` and "Spectator-1"; every player is identified.

### S9a-A5 System lines never name a hidden member
**Given** an anonymous-players lobby where Alice (Blue) leaves the live match and returns
**When** Bob (Red) reads `view_my_lobby_chat`
**Then** the lines read "Blue-1 left the match." and "Blue-1 is back."; Alice's teammates read her display name.

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
| A37 / A40 rules as implemented in the S9a views (user ids 0 for anonymized and departed members, audit columns dropped, joinSeq label order, tournament alias / seat labels, ratings per roster visibility, MMR per hideMmr), the accepted residual risk; scenarios S9a-A1..A3 | Phase S9a execution (DECISIONS.md A37, A40) | 2026-11-08 |
| S9a fix pass: the target's seat kind picks the toggle (spectators follow isAnonymousSpectators); member-event chat lines rendered per reader; banned user, registrant accounts and step labels masked or labelled; scenarios S9a-A4, S9a-A5 | Phase S9a execution (DECISIONS.md A37) | 2026-11-08 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 6*
