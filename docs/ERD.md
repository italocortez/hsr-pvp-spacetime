# HSRPVP SpacetimeDB ERD

67 tables. All v0.5 tables included. Updated 2026-04-12. Paste into [mermaid.live](https://mermaid.live) to preview.

| Color | Tables |
|-------|--------|
| blue | user, user_identity (PRIVATE Phase 12), user_private (PRIVATE Phase 12), ban_record (PRIVATE Phase 12), server_identity, user_deletion_job, identity_gc_job (Phase 12.1), gc_result (PRIVATE Phase 12.1) |
| green | hsr_character, hsr_lightcone, archetype, hsr_character_archetype, season |
| orange | hsr_account (PRIVATE D-20), hsr_account_character (PRIVATE D-20), hsr_account_lightcone, cost_set, hsr_character_cost, hsr_lightcone_cost, hsr_synergy_cost, cost_set_draft_character, cost_set_draft_lightcone, cost_set_draft_synergy |
| purple | tournament, tournament_enrolled, tournament_team_member, tournament_assistant, tournament_team, tournament_team_request, tournament_stand_in, tournament_player_account, bracket_match, group_phase_record |
| cyan | lobby, lobby_member_account (NON-PUBLIC D-02), lobby_member, lobby_ban, lobby_preset, lobby_password, lobby_cursor_event, lobby_gc_job, match_session, match_session_step, chat_message, elo_config |
| red | match_result_record, match_result_game, match_result_participant |
| grey | match_session_history, match_session_step_history, match_participant_history, match_result_game_history |
| pink | mmr_rating, mmr_history, leaderboard, player_stat, player_character_stat, global_character_stat, player_relationship, account_rating_config (Phase 11) |
| yellow | achievement, user_achievement, achievement_criteria, calendar_event, calendar_event_invite, availability_slot, saved_calendar |

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
    user_private {
        u32 userId PK_FK
    }
    ban_record {
        u32 id PK
        u32 bannedByUserId FK
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
        string sourceName FK
        string targetName FK
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
        string sourceName PK
        string targetName PK
        string gameMode PK
    }

    %% purple
    tournament {
        u32 id PK
        u32 organizerId FK
        u32 costSetId FK
        u32 seasonId FK
        u8 maxAccountsPerPlayer "default 1 — Phase 10.4 D-33"
        bool requireOwnership "character ownership validation in draft — Phase 12.3"
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
        u32 tournamentId PK_FK
        u32 userId PK_FK
    }
    tournament_team {
        u32 id PK
        u32 tournamentId FK
        u32 captainUserId FK
    }
    tournament_team_request {
        u32 teamId PK_FK
        u32 userId PK_FK
    }
    tournament_stand_in {
        u32 bracketMatchId PK_FK
        u32 userId PK_FK
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
        u32 team1Id FK
        u32 team2Id FK
        u32 nextWinnerMatchId FK
        u32 nextLoserMatchId FK
        u32 winnerTeamId FK
    }
    group_phase_record {
        u32 tournamentId PK_FK
        u32 groupId PK
        u32 teamId PK_FK
    }

    %% cyan  (lobby_member_account is NON-PUBLIC since Phase 10.4 — D-02)
    lobby {
        u32 id PK
        string joinCode UK
        u32 hostUserId FK
        u32 tournamentId FK
        u32 bracketMatchId FK
        u32 costSetId FK
    }
    lobby_member_account {
        u32 lobbyId PK_FK
        u32 userId PK_FK
        u32 hsrAccountId PK_FK
    }
    lobby_member {
        u32 lobbyId PK_FK
        u32 userId PK_FK
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
        u32 senderUserId FK
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
    }
    match_result_game {
        u32 matchResultId PK_FK
        u8 gameNumber PK
        u32 validatedByUserId FK
    }
    match_result_participant {
        u32 matchResultId PK_FK
        u32 userId PK_FK
        f64 accountRatingSnapshot "frozen at match-record time — Phase 12.3"
    }

    %% grey
    match_session_history {
        u32 id PK
    }
    match_session_step_history {
        u32 matchHistoryId PK_FK
        u8 gameNumber PK
        u32 sequence PK
    }
    match_participant_history {
        u32 userId PK_FK
        u32 matchHistoryId PK_FK
    }
    match_result_game_history {
        u32 matchHistoryId PK_FK
        u8 gameNumber PK
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
    hsr_synergy_cost }o--|| hsr_character : "sourceName (many-to-one)"
    hsr_synergy_cost }o--|| hsr_character : "targetName (many-to-one)"
    cost_set_draft_character }o--|| cost_set : "costSetId (many-to-one)"
    cost_set_draft_character }o--|| hsr_character : "characterName (many-to-one)"
    cost_set_draft_lightcone }o--|| cost_set : "costSetId (many-to-one)"
    cost_set_draft_lightcone }o--|| hsr_lightcone : "lightconeName (many-to-one)"
    cost_set_draft_synergy }o--|| cost_set : "costSetId (many-to-one)"
    cost_set_draft_synergy }o--|| hsr_character : "sourceName (many-to-one)"
    cost_set_draft_synergy }o--|| hsr_character : "targetName (many-to-one)"

    %% purple: tournament (many-to-many enrollment via junction tables)
    tournament }o--|| user : "organizerId (many-to-one)"
    tournament }o--|| cost_set : "costSetId (many-to-one)"
    tournament }o--o| season : "seasonId (many-to-one, optional)"
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
    group_phase_record }o--|| tournament : "tournamentId (many-to-one)"
    group_phase_record }o--|| tournament_team : "teamId (many-to-one)"

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
    match_result_game }o--|| match_result_record : "matchResultId (many-to-one)"
    match_result_game }o--o| user : "validatedByUserId (many-to-one, optional)"
    match_result_participant }o--|| match_result_record : "matchResultId (many-to-many junction)"
    match_result_participant }o--|| user : "userId (many-to-many junction)"

    %% grey: history (archived snapshots, many-to-one from history)
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

    %% Phase 12.1: Identity GC + GC audit log
    gc_result }o--|| user : "createdById (many-to-one)"
```
