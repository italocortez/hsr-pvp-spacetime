# HSRPVP SpacetimeDB ERD

76 tables. Updated 2026-11-06 (S3 backend reset: 27 tables public → private per A37 / ACCESS-SECURITY-OPS Appendix A, 10 new, `group_phase_record` dropped per A23). Visibility: **21 public** (reference data, aggregates, `user`, `tournament`, `bracket_match`, `admin_alert`, the `lobby_cursor_event` event table); every other table is PRIVATE and read through views (S9). Paste into [mermaid.live](https://mermaid.live) to preview.

Phase S8e execution (DECISIONS.md A67): one game per lobby. `lobby` / `lobby_preset` lose `bestOf`, `bestOfNAdvantage`, `refereeControlsShelving` (the `AdvantageSide` enum is gone); `match_session` loses `currentGameNumber`, `gamesWonBlue`, `gamesWonRed`, `seriesBestOf`; `gameNumber` leaves `match_session_step`, `match_session_step_history` (PK `[matchHistoryId, sequence]`), `match_lineup` (index `by_lobby`), `match_lineup_history`, `match_result_group_score` / `match_result_adjustment` (index `by_result`), `match_result_game` (PK `matchResultId`, one row per record) and `match_result_game_history` (PK `matchHistoryId`); `LobbyStage` = Waiting | Drafting | Equipping | Scoring | AwaitingResult. `bracket_match.team1Games` / `team2Games` are the derived series tally (A67(4)).

Phase S7b execution (DECISIONS.md A60): `match_result_game` gains `blueConfirmed`, `redConfirmed` (per-game captain confirmations), `closedAt` (optional, the closed marker) and `closedById` (optional, FK user); `match_result_record` loses `blueConfirmed` / `redConfirmed`; `match_lineup` loses `isConfirmed`.

| Color | Tables (PUBLIC unless marked) |
|-------|--------|
| blue | user, user_presence (PRIVATE, new S3 A48), user_identity (PRIVATE), user_private (PRIVATE), ban_record (PRIVATE), link_request (PRIVATE, new S3 A46), deleted_user (PRIVATE), server_identity (PRIVATE), user_deletion_job, identity_gc_job, gc_result (PRIVATE) |
| green | hsr_character, hsr_lightcone, archetype, hsr_character_archetype, season |
| orange | hsr_account (PRIVATE), hsr_account_character (PRIVATE), cost_set, hsr_character_cost, hsr_lightcone_cost, hsr_synergy_cost (characterA/characterB, A21), cost_set_draft_character (PRIVATE), cost_set_draft_lightcone (PRIVATE), cost_set_draft_synergy (PRIVATE) |
| purple | tournament, bracket_match, tournament_enrolled (PRIVATE), tournament_team_member (PRIVATE), tournament_assistant (PRIVATE), tournament_team (PRIVATE), tournament_team_request (PRIVATE), tournament_stand_in (PRIVATE), tournament_player_account (PRIVATE), tournament_finalize_job (scheduled, new S3 A24) |
| cyan | lobby (PRIVATE), lobby_member_account (PRIVATE), lobby_member (PRIVATE), lobby_ban (PRIVATE), lobby_preset (PRIVATE), lobby_password (PRIVATE), lobby_cursor_event (public event, no audit columns A19), lobby_gc_job, referee_transfer_check (scheduled, new S3 A22a), match_session (PRIVATE), match_session_step (PRIVATE), match_lineup (PRIVATE, new S3 A21), chat_message (PRIVATE), elo_config |
| red | match_result_record (PRIVATE), match_result_game (PRIVATE), match_result_participant (PRIVATE), match_result_group_score (PRIVATE, new S3 A21), match_result_adjustment (PRIVATE, new S3 A21) |
| grey | match_session_history (PRIVATE), match_session_step_history (PRIVATE), match_participant_history (PRIVATE), match_result_game_history (PRIVATE) |
| pink | mmr_rating (PRIVATE A40), mmr_history (PRIVATE), leaderboard (top 20 per category, A45), player_stat (PRIVATE), player_character_stat (PRIVATE), global_character_stat, player_relationship (PRIVATE), account_rating_config |
| yellow | achievement, user_achievement, achievement_criteria, calendar_event (PRIVATE), calendar_event_invite (PRIVATE), availability_slot (PRIVATE), saved_calendar (PRIVATE) |
| brown | abuse_config (PRIVATE, new S3 §B.5), user_rate_state (PRIVATE, new S3 §B.5), admin_alert (public, counts only, new S3 A42) |

```mermaid
erDiagram
    %% blue
    user {
        u32 id PK
        string username UK
        string avatarCharacterName FK
        u32 displayedAchievementId FK
    }
    user_identity {
        Identity identity PK
        u32 userId FK
    }
    user_presence {
        Identity identity PK
        u32 userId FK
        bool isOnline "A48: one row per identity, no per-user count"
    }
    user_private {
        u32 userId PK_FK
        string loginMethod "A46: 'discord'"
        string providerId
    }
    ban_record {
        u32 id PK
        string loginMethod "A46: keyed by loginMethod + providerId"
        string providerId
        u32 bannedByUserId FK
    }
    link_request {
        string code PK
        Identity identity UK
        u32 userId FK
    }
    deleted_user {
        u32 id PK "archived displayName of a hard-deleted user (Phase 15.2 D-05)"
    }
    server_identity {
        Identity identity PK
    }
    user_deletion_job {
        u64 scheduledId PK
        u32 userId FK
    }
    identity_gc_job {
        u64 scheduledId PK
    }
    gc_result {
        u32 id PK
        string gcType
        u32 createdById FK
    }

    %% green
    hsr_character {
        string name PK
    }
    hsr_lightcone {
        string name PK
    }
    archetype {
        u32 id PK
        string name UK
    }
    hsr_character_archetype {
        string characterName PK_FK
        u32 archetypeId PK_FK
    }
    season {
        u32 id PK
    }

    %% orange  (hsr_account and hsr_account_character are PRIVATE since Phase 10.4 — D-20)
    hsr_account {
        u32 id PK
        u32 userId FK
    }
    hsr_account_character {
        u32 hsrAccountId PK_FK
        string characterName PK_FK
    }
    hsr_account_lightcone {
        u32 hsrAccountId PK_FK
        string lightconeName PK_FK
    }
    cost_set {
        u32 id PK
        u32 creatorId FK
    }
    hsr_character_cost {
        string characterName PK_FK
        string gameMode PK
        u32 costSetId PK_FK
    }
    hsr_lightcone_cost {
        string lightconeName PK_FK
        string gameMode PK
        u32 costSetId PK_FK
    }
    hsr_synergy_cost {
        u32 id PK
        string characterA FK "A21: unordered pair, canonical order"
        string characterB FK
        u32 costSetId FK
    }
    cost_set_draft_character {
        u32 costSetId PK_FK
        string characterName PK_FK
        string gameMode PK
    }
    cost_set_draft_lightcone {
        u32 costSetId PK_FK
        string lightconeName PK_FK
        string gameMode PK
    }
    cost_set_draft_synergy {
        u32 costSetId PK_FK
        string characterA PK
        string characterB PK
        string gameMode PK
    }

    %% purple
    tournament {
        u32 id PK
        u32 organizerId FK
        u32 costSetId FK
        u32 seasonId FK "A36: 0 for now"
        u32 lobbyPresetId FK "A33a: free-set starting values"
        u8 maxAccountsPerPlayer "default 1 — Phase 10.4 D-33"
        bool requireOwnership "character ownership validation in draft — Phase 12.3"
        bool requireResultValidation "A36"
        string lineupFormat "A21/A33 integrity set"
    }
    tournament_enrolled {
        u32 tournamentId PK_FK
        u32 userId PK_FK
    }
    %% tournament_enrolled.hsrAccountId removed in Phase 10.4 (D-23) — TournamentPlayerAccount is sole source of truth
    tournament_team_member {
        u32 teamId PK_FK
        u32 userId PK_FK
        u32 tournamentId FK
    }
    tournament_assistant {
        u32 id PK
        u32 tournamentId FK
        u32 userId FK
        bool canManageParticipants "A25: three flags"
    }
    tournament_team {
        u32 id PK
        u32 tournamentId FK
        u32 captainUserId FK
        string status "A26: Forming|Ready|Active|Eliminated|Withdrawn|Disqualified"
        u32 groupId "A23: replaces group_phase_record"
    }
    tournament_team_request {
        u32 teamId PK_FK
        u32 userId PK_FK
    }
    tournament_stand_in {
        u32 id PK
        u32 bracketMatchId FK
        u32 teamId FK "A35"
        u32 userId FK
        u32 approvedByUserId FK
    }
    tournament_player_account {
        u32 tournamentId PK_FK
        u32 userId PK_FK
        u32 hsrAccountId PK_FK
    }
    bracket_match {
        u32 id PK
        u32 tournamentId FK
        string positionKey "A23: engine address"
        u32 team1Id FK
        u32 team2Id FK
        u32 nextWinnerMatchId FK
        u32 nextLoserMatchId FK
        u32 winnerTeamId FK
        u32 loserTeamId FK
        string state "Pending|Ready|Walkover|Void|Decided"
        u8 team1Games "A67(4), A69(1): derived tally (head start, stored from generation + Validated games)"
        u8 team2Games "A67(4): derived tally (Validated games)"
    }
    tournament_finalize_job {
        u64 scheduledId PK
        u32 tournamentId FK
        u32 cursor "D.8.1 chunked finalization"
    }

    %% cyan  (lobby_member_account is NON-PUBLIC since Phase 10.4 — D-02)
    lobby {
        u32 id PK
        string joinCode UK
        string name "D-A8"
        u32 hostUserId FK
        u32 tournamentId FK
        u32 bracketMatchId FK
        u32 costSetId FK
        string lineupFormat "A21 Halves|Thirds"
        string banRestriction "A45"
        bool hideMmr "A40"
    }
    lobby_member_account {
        u32 lobbyId PK_FK
        u32 userId PK_FK
        u32 hsrAccountId PK_FK
    }
    lobby_member {
        u32 lobbyId PK_FK
        u32 userId PK_FK
        u32 joinSeq "R4: anonymous labels derive from it"
    }
    referee_transfer_check {
        u64 scheduledId PK
        u32 lobbyId FK
        u32 userId FK
    }
    match_lineup {
        u32 id PK
        u32 lobbyId FK
        string groups "A21: JSON string[][] of 4-character groups"
    }
    lobby_ban {
        u32 lobbyId PK_FK
        u32 bannedUserId PK_FK
        u32 bannedByUserId FK
    }
    lobby_preset {
        u32 id PK
        u32 creatorUserId FK
        u32 costSetId FK
    }
    lobby_password {
        u32 lobbyId PK_FK
    }
    lobby_cursor_event {
        u32 lobbyId FK
        u32 senderUserId FK "0 when anonymized; no audit columns (A19)"
    }
    lobby_gc_job {
        u64 scheduledId PK
    }
    match_session {
        u32 lobbyId PK_FK
    }
    match_session_step {
        u32 id PK
        u32 lobbyId FK
        u32 actorUserId FK
    }
    chat_message {
        u32 id PK
        u32 lobbyId FK
        u32 senderUserId FK
    }
    elo_config {
        u32 id PK
    }

    %% red
    match_result_record {
        u32 id PK
        u32 bracketMatchId FK
        u32 lobbyId FK
        u32 refereeUserId FK
        u32 disputedByUserId FK
        u32 winnerOverrideById FK "A21/A39 tie-break override"
    }
    match_result_game {
        u32 matchResultId PK_FK "A67: one row per record"
        u8 teamBlueDeaths "A21"
        u32 validatedByUserId FK
        bool blueConfirmed "A60 (S7b): per-game captain confirmation"
        bool redConfirmed "A60 (S7b)"
        timestamp closedAt "A60 (S7b): closed marker, optional"
        u32 closedById FK "A60 (S7b): closer, optional"
    }
    match_result_group_score {
        u32 id PK
        u32 matchResultId FK
        u8 groupIndex "A21: per half/third"
        u32 value "hundredths"
    }
    match_result_adjustment {
        u32 id PK
        u32 matchResultId FK
        i32 value "A21: signed hundredths, required reason"
        u32 setById FK
    }
    match_result_participant {
        u32 matchResultId PK_FK
        u32 userId PK_FK
        f64 accountRatingSnapshot "frozen at match-record time — Phase 12.3"
    }

    %% grey
    match_session_history {
        u32 id PK
        u32 tournamentId FK "A24/A37: replaces isPubliclyVisible"
        u32 bracketMatchId FK
    }
    match_session_step_history {
        u32 matchHistoryId PK_FK
        u32 sequence PK
    }
    match_participant_history {
        u32 userId PK_FK
        u32 matchHistoryId PK_FK
    }
    match_result_game_history {
        u32 matchHistoryId PK_FK "A67: one game per match"
    }

    %% pink
    account_rating_config {
        u32 id PK
    }
    mmr_rating {
        u32 userId PK_FK
        string gameMode PK
        u32 seasonId PK_FK
    }
    mmr_history {
        u32 id PK
        u32 userId FK
        u32 matchHistoryId FK
        u32 seasonId FK
    }
    leaderboard {
        string category PK
        u16 rank PK
        u32 seasonId PK_FK
        u32 userId FK
    }
    player_stat {
        u32 userId PK_FK
        string gameMode PK
        string draftMode PK
        u32 seasonId PK_FK
        string matchType PK
        u8 teamSize PK
    }
    player_character_stat {
        u32 userId PK_FK
        string characterName PK_FK
        string gameMode PK
        string draftMode PK
        u32 seasonId PK_FK
        string matchType PK
        u8 teamSize PK
    }
    global_character_stat {
        string characterName PK_FK
        string gameMode PK
        string draftMode PK
        u32 seasonId PK_FK
        string matchType PK
        u8 teamSize PK
    }
    player_relationship {
        u32 userId PK_FK
        u32 otherUserId PK_FK
        string gameMode PK
        string draftMode PK
        u32 seasonId PK_FK
        string matchType PK
        u8 teamSize PK
    }

    %% yellow
    achievement {
        u32 id PK
        string name UK
    }
    user_achievement {
        u32 id PK
        u32 userId FK
        u32 achievementId FK
        u32 awardedById FK
    }
    achievement_criteria {
        u32 id PK
        u32 achievementId FK
    }
    calendar_event {
        u32 id PK
        u32 organizerId FK
        u32 bracketMatchId FK
    }
    calendar_event_invite {
        u32 eventId PK_FK
        u32 inviteeUserId PK_FK
    }
    availability_slot {
        u32 id PK
        u32 userId FK
    }
    saved_calendar {
        u32 userId PK_FK
        u32 targetUserId PK_FK
    }

    %% brown (S3 abuse controls, §B.5 / A42)
    abuse_config {
        u32 id PK "singleton 1"
    }
    user_rate_state {
        u32 userId PK_FK
    }
    admin_alert {
        u32 id PK
        string kind "counts only, no user ids, no audit columns"
    }

    %% ── relationships ──────────────────────────────────────
    %% Notation: ||--|| one-to-one, }o--|| many-to-one, }o--o| many-to-zero-or-one (optional)

    %% blue: auth (1 user has many identities, 1:1 private data)
    user_identity }o--|| user : "userId (many-to-one)"
    user_deletion_job }o--|| user : "userId (many-to-one)"
    user }o--|| hsr_character : "avatarCharacterName (many-to-one)"
    user }o--o| achievement : "displayedAchievementId (many-to-one, optional)"

    %% green: character/archetype (many-to-many via junction)
    hsr_character_archetype }o--|| hsr_character : "characterName (many-to-one)"
    hsr_character_archetype }o--|| archetype : "archetypeId (many-to-one)"

    %% orange: roster/costs (one user has many accounts, many-to-many char ownership)
    hsr_account }o--|| user : "userId (many-to-one)"
    hsr_account_character }o--|| hsr_account : "hsrAccountId (many-to-one)"
    hsr_account_character }o--|| hsr_character : "characterName (many-to-one)"
    hsr_account_lightcone }o--|| hsr_account : "hsrAccountId (many-to-one)"
    hsr_account_lightcone }o--|| hsr_lightcone : "lightconeName (many-to-one)"
    cost_set }o--|| user : "creatorId (many-to-one)"
    hsr_character_cost }o--|| hsr_character : "characterName (many-to-one)"
    hsr_character_cost }o--|| cost_set : "costSetId (many-to-one)"
    hsr_lightcone_cost }o--|| hsr_lightcone : "lightconeName (many-to-one)"
    hsr_lightcone_cost }o--|| cost_set : "costSetId (many-to-one)"
    hsr_synergy_cost }o--|| cost_set : "costSetId (many-to-one)"
    hsr_synergy_cost }o--|| hsr_character : "characterA (many-to-one)"
    hsr_synergy_cost }o--|| hsr_character : "characterB (many-to-one)"
    cost_set_draft_character }o--|| cost_set : "costSetId (many-to-one)"
    cost_set_draft_character }o--|| hsr_character : "characterName (many-to-one)"
    cost_set_draft_lightcone }o--|| cost_set : "costSetId (many-to-one)"
    cost_set_draft_lightcone }o--|| hsr_lightcone : "lightconeName (many-to-one)"
    cost_set_draft_synergy }o--|| cost_set : "costSetId (many-to-one)"
    cost_set_draft_synergy }o--|| hsr_character : "characterA (many-to-one)"
    cost_set_draft_synergy }o--|| hsr_character : "characterB (many-to-one)"

    %% purple: tournament (many-to-many enrollment via junction tables)
    tournament }o--|| user : "organizerId (many-to-one)"
    tournament }o--|| cost_set : "costSetId (many-to-one)"
    tournament }o--|| season : "seasonId (many-to-one; 0 until seasons are designed, A36)"
    tournament }o--|| lobby_preset : "lobbyPresetId (many-to-one, A33a)"
    tournament_enrolled }o--|| tournament : "tournamentId (many-to-many junction)"
    tournament_enrolled }o--|| user : "userId (many-to-many junction)"
    %% tournament_enrolled.hsrAccountId removed in Phase 10.4 (D-23)
    tournament_team_member }o--|| tournament_team : "teamId (many-to-one)"
    tournament_team_member }o--|| user : "userId (many-to-one)"
    tournament_team_member }o--|| tournament : "tournamentId (many-to-one)"
    tournament_assistant }o--|| tournament : "tournamentId (many-to-many junction)"
    tournament_assistant }o--|| user : "userId (many-to-many junction)"
    tournament_team }o--|| tournament : "tournamentId (many-to-one)"
    tournament_team }o--|| user : "captainUserId (many-to-one)"
    tournament_team_request }o--|| tournament_team : "teamId (many-to-many junction)"
    tournament_team_request }o--|| user : "userId (many-to-many junction)"
    tournament_stand_in }o--|| bracket_match : "bracketMatchId (many-to-one)"
    tournament_stand_in }o--|| tournament_team : "teamId (many-to-one, A35)"
    tournament_stand_in }o--|| user : "userId (many-to-one)"
    tournament_stand_in }o--|| user : "approvedByUserId (many-to-one)"
    tournament_player_account }o--|| tournament : "tournamentId (many-to-many junction)"
    tournament_player_account }o--|| user : "userId (many-to-many junction)"
    tournament_player_account }o--|| hsr_account : "hsrAccountId (many-to-many junction)"
    bracket_match }o--|| tournament : "tournamentId (many-to-one)"
    bracket_match }o--o| tournament_team : "team1Id (many-to-one, optional)"
    bracket_match }o--o| tournament_team : "team2Id (many-to-one, optional)"
    bracket_match }o--o| bracket_match : "nextWinnerMatchId (self-ref, optional)"
    bracket_match }o--o| bracket_match : "nextLoserMatchId (self-ref, optional)"
    bracket_match }o--o| tournament_team : "winnerTeamId (many-to-one, optional)"
    bracket_match }o--o| tournament_team : "loserTeamId (many-to-one, optional)"
    tournament_finalize_job }o--|| tournament : "tournamentId (many-to-one, D.8.1)"

    %% cyan: lobby/match (one lobby has many members, one-to-one match session)
    lobby }o--|| user : "hostUserId (many-to-one)"
    lobby }o--o| tournament : "tournamentId (many-to-one, optional)"
    lobby }o--o| bracket_match : "bracketMatchId (many-to-one, optional)"
    lobby }o--o| cost_set : "costSetId (many-to-one, optional)"
    lobby_member_account }o--|| lobby : "lobbyId (many-to-one)"
    lobby_member_account }o--|| user : "userId (many-to-one)"
    lobby_member_account }o--|| hsr_account : "hsrAccountId (many-to-one)"
    lobby_member }o--|| lobby : "lobbyId (many-to-many junction)"
    lobby_member }o--|| user : "userId (many-to-many junction)"
    referee_transfer_check }o--|| lobby : "lobbyId (many-to-one, A22a)"
    referee_transfer_check }o--|| user : "userId (many-to-one)"
    match_lineup }o--|| lobby : "lobbyId (many-to-one, A21)"
    lobby_ban }o--|| lobby : "lobbyId (many-to-one)"
    lobby_ban }o--|| user : "bannedUserId (many-to-one)"
    lobby_ban }o--|| user : "bannedByUserId (many-to-one)"
    lobby_preset }o--|| user : "creatorUserId (many-to-one)"
    lobby_preset }o--o| cost_set : "costSetId (many-to-one, optional)"
    lobby_password ||--|| lobby : "lobbyId (one-to-one)"
    lobby_cursor_event }o--|| lobby : "lobbyId (many-to-one)"
    lobby_cursor_event }o--|| user : "senderUserId (many-to-one)"
    match_session ||--|| lobby : "lobbyId (one-to-one)"
    match_session_step }o--|| lobby : "lobbyId (many-to-one)"
    match_session_step }o--|| user : "actorUserId (many-to-one)"
    chat_message }o--|| lobby : "lobbyId (many-to-one)"
    chat_message }o--|| user : "senderUserId (many-to-one)"

    %% red: match results (one result has many games + participants)
    match_result_record }o--o| bracket_match : "bracketMatchId (many-to-one, optional)"
    match_result_record }o--|| lobby : "lobbyId (many-to-one)"
    match_result_record }o--o| user : "refereeUserId (many-to-one, optional)"
    match_result_record }o--o| user : "disputedByUserId (many-to-one, optional)"
    match_result_record }o--o| user : "winnerOverrideById (many-to-one, optional, A39)"
    match_result_group_score }o--|| match_result_record : "matchResultId (many-to-one)"
    match_result_adjustment }o--|| match_result_record : "matchResultId (many-to-one)"
    match_result_adjustment }o--|| user : "setById (many-to-one)"
    match_result_game }o--|| match_result_record : "matchResultId (many-to-one)"
    match_result_game }o--o| user : "validatedByUserId (many-to-one, optional)"
    match_result_game }o--o| user : "closedById (many-to-one, optional; A60 S7b)"
    match_result_participant }o--|| match_result_record : "matchResultId (many-to-many junction)"
    match_result_participant }o--|| user : "userId (many-to-many junction)"

    %% grey: history (archived snapshots, many-to-one from history)
    match_session_history }o--o| tournament : "tournamentId (many-to-one, optional, A24)"
    match_session_history }o--o| bracket_match : "bracketMatchId (many-to-one, optional)"
    match_session_step_history }o--|| match_session_history : "matchHistoryId (many-to-one)"
    match_session_step_history }o--|| user : "actorUserId (many-to-one)"
    match_participant_history }o--|| match_session_history : "matchHistoryId (many-to-many junction)"
    match_participant_history }o--|| user : "userId (many-to-many junction)"
    match_result_game_history }o--|| match_session_history : "matchHistoryId (many-to-one)"

    %% pink: MMR/stats (one user has many ratings per mode/season)
    mmr_rating }o--|| user : "userId (many-to-one)"
    mmr_rating }o--|| season : "seasonId (many-to-one)"
    mmr_history }o--|| user : "userId (many-to-one)"
    mmr_history }o--|| match_session_history : "matchHistoryId (many-to-one)"
    mmr_history }o--o| season : "seasonId (many-to-one, optional)"
    leaderboard }o--|| user : "userId (many-to-one)"
    leaderboard }o--|| season : "seasonId (many-to-one)"
    player_stat }o--|| user : "userId (many-to-one)"
    player_stat }o--|| season : "seasonId (many-to-one)"
    player_character_stat }o--|| user : "userId (many-to-one)"
    player_character_stat }o--|| hsr_character : "characterName (many-to-one)"
    player_character_stat }o--|| season : "seasonId (many-to-one)"
    global_character_stat }o--|| hsr_character : "characterName (many-to-one)"
    global_character_stat }o--|| season : "seasonId (many-to-one)"
    player_relationship }o--|| user : "userId (many-to-one)"
    player_relationship }o--|| user : "otherUserId (many-to-one)"
    player_relationship }o--|| season : "seasonId (many-to-one)"

    %% yellow: achievements/calendar (one user has many achievements, events)
    user_achievement }o--|| achievement : "achievementId (many-to-one)"
    user_achievement }o--|| user : "userId (many-to-one)"
    user_achievement }o--|| user : "awardedById (many-to-one)"
    achievement_criteria }o--|| achievement : "achievementId (many-to-one)"
    calendar_event }o--|| user : "organizerId (many-to-one)"
    calendar_event }o--o| bracket_match : "bracketMatchId (many-to-one, optional)"
    calendar_event_invite }o--|| calendar_event : "eventId (many-to-many junction)"
    calendar_event_invite }o--|| user : "inviteeUserId (many-to-many junction)"
    availability_slot }o--|| user : "userId (many-to-one)"
    saved_calendar }o--|| user : "userId (many-to-many junction)"
    saved_calendar }o--|| user : "targetUserId (many-to-many junction)"

    %% Phase 12: Auth Security Hardening
    user_private ||--|| user : "userId (one-to-one)"
    ban_record }o--|| user : "bannedByUserId (many-to-one)"

    %% S3 backend reset (A46 link codes, A48 presence, §B.5 rate state)
    user_presence }o--|| user : "userId (many-to-one: one row per identity)"
    link_request }o--|| user : "userId (many-to-one)"
    user_rate_state ||--|| user : "userId (one-to-one)"
    deleted_user ||--o| user : "id (the former User.id; archive row, no live FK)"

    %% Phase 12.1: Identity GC + GC audit log
    gc_result }o--|| user : "createdById (many-to-one)"
```
