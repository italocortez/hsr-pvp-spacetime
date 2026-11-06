import spacetimedb from './schema';
import { ScheduleAt } from 'spacetimedb';
import { auditUpdate, SYSTEM_USER_ID } from './helpers/auditColumns';
import { insertWithAudit, updateWithAudit } from './helpers/auditHelpers';
import { transferCaptain, transferReferee, transferHost } from './helpers/flagTransferHelpers';
import { checkProviderBan, DISCORD_BAN_TYPE } from './helpers/banHelper';
import { slotToTeamSide } from './helpers/lobbyHelpers';

// Private auth tables — imported for schema registration
import './tables/userPrivate';
import './tables/banRecord';
// Phase 15 D-01/D-02: domain view barrel — each file holds views that match the `tables/` layout.
// Every view must be named-re-exported here so [registerExport] fires during module init
// (Phase 12.2 rule — CONVENTIONS.md:233-252). Splitting security/anonymousViews into 8 files
// puts each view in a home that matches its underlying domain.
export {
    view_lobby_browser,
    view_my_lobbies,
    view_my_lobby_chat,
    view_my_lobby_members,
} from './views/lobbyViews';
export {
    view_my_identity,
    view_my_profile,
    view_public_hsr_accounts,
    view_admin_user_private,
} from './views/identityViews';
export {
    view_my_cost_sets,
    view_my_draft_character_costs,
    view_my_draft_lightcone_costs,
    view_my_draft_synergy_costs,
} from './views/costSetViews';
export {
    view_my_player_stats,
    view_my_character_stats,
} from './views/statsViews';
export {
    view_my_relationships,
    view_my_roster_visibility,
    view_my_roster,
} from './views/socialViews';
export {
    view_my_match_steps,
    view_my_match_participants,
} from './views/matchViews';
export {
    view_match_history,
    view_match_participant_history,
    view_match_step_history,
    view_my_match_session_history,          // Phase 15 D-13
    view_my_match_session_step_history,     // Phase 15 D-13
    view_my_match_participant_history,      // Phase 15 D-13
    view_my_mmr_history,                    // Phase 15 D-13
    view_my_match_result_game_history,      // Phase 15 D-13
} from './views/matchHistoryViews';
export {
    view_my_tournaments,
    view_my_tournament_enrolled,
    view_my_tournament_teams,
    view_my_tournament_team_members,
    view_my_tournament_matches,
    view_my_tournament_match_results,
    view_my_tournament_lobbies,
    view_my_tournament_group_standings,
    view_tournament_registrant_accounts,
} from './views/tournamentViews';
export { broadcast_cursor } from './reducers/cursor';
export { login_as_guest } from './reducers/auth';
export { delete_guest_account, update_display_name, update_username, update_avatar } from './reducers/profile';
export { register_server, server_link_provider, server_set_role, server_delete_user, server_set_datetime, server_set_online, server_set_mmr, server_nuke_test_data } from './reducers/server';
export { admin_ban_user, admin_unban_user } from './reducers/banAdmin';
export { admin_delete_row, admin_bulk_upsert, admin_update_user } from './reducers/admin';
export { admin_update_elo_config, admin_seed_elo_config } from './reducers/eloAdmin';
export { admin_seed_rating_config, admin_update_rating_config, admin_recalculate_all_ratings } from './reducers/ratingAdmin';
export { run_user_deletion } from './reducers/userDeletion';
export { create_hsr_account, update_hsr_account, set_active_hsr_account, delete_hsr_account, batch_upsert_characters, batch_remove_characters, migrate_roster } from './reducers/roster';
export { admin_create_hsr_account, admin_update_hsr_account, admin_delete_hsr_account, admin_batch_upsert_characters, admin_batch_remove_characters, admin_upsert_archetype, admin_delete_archetype, admin_assign_character_archetypes, admin_remove_character_archetypes } from './reducers/rosterAdmin';
export { create_cost_set, edit_draft_character_cost, edit_draft_lightcone_cost, edit_draft_synergy_cost, publish_cost_set, lock_cost_set, unpublish_cost_set, delete_cost_set } from './reducers/costSetManagement';
export { create_tournament, update_tournament, advance_tournament_stage, cancel_tournament } from './reducers/tournamentManagement';
export { check_in_tournament } from './reducers/tournamentCheckIn';
export { register_for_tournament, withdraw_from_tournament, approve_participant, waitlist_promote } from './reducers/tournamentRegistration';
export { create_tournament_team, request_join_team, accept_team_request, reject_team_request, leave_tournament_team, disband_tournament_team } from './reducers/tournamentTeams';
export { transfer_referee, reclaim_referee } from './reducers/refereeManagement';
export { confirm_match_scores, submit_match_result, dispute_match_result } from './reducers/matchResultSubmission';
export { record_game_scores } from './reducers/scoreEntry';
export { dq_participant, override_match_result, assign_tournament_assistant, remove_tournament_assistant, mod_promote_to_host, mod_demote_from_host } from './reducers/tournamentAdmin';
export { generate_bracket, seed_bracket, swap_seeds } from './reducers/bracketGeneration';
export { advance_bracket_match, submit_and_advance_bracket, rollback_bracket_match, advance_group_to_elimination } from './reducers/bracketAdvancement';
export { finalize_match_result, process_tournament_mmr } from './reducers/matchFinalization';
export { create_season, set_active_season } from './reducers/seasonAdmin';
export { create_achievement, update_achievement, delete_achievement, add_achievement_criteria, remove_achievement_criteria, manual_award_achievement, set_displayed_achievement } from './reducers/achievementManagement';
export { create_availability_slot, update_availability_slot, delete_availability_slot } from './reducers/calendarAvailability';
export { save_calendar, unsave_calendar, toggle_calendar_visibility } from './reducers/calendarSaved';
export { create_calendar_event, update_calendar_event, delete_calendar_event, invite_to_event, remove_invite } from './reducers/calendarEvents';
export { respond_to_invite } from './reducers/calendarInviteResponse';
export { create_lobby, join_lobby, leave_lobby, close_lobby, kick_member, ban_member } from './reducers/lobbyLifecycle';
export { send_chat_message, delete_chat_message } from './reducers/chat';
export { update_lobby_settings, set_team_slot, confirm_ready, unconfirm_ready, set_captain } from './reducers/lobbySettings';
export { create_lobby_preset, update_lobby_preset, delete_lobby_preset } from './reducers/lobbyPresets';
export { create_tournament_lobby, approve_stand_in } from './reducers/tournamentLobby';
export { run_lobby_gc, admin_gc_lobbies, seed_lobby_gc_job } from './reducers/lobbyGc';
export { run_identity_gc, admin_gc_identities, seed_identity_gc_job } from './reducers/identityGc';
export { start_draft, pick_character, ban_character, timer_expiry_classic } from './reducers/draftClassic';
export { undo_last_step, pause_draft, resume_draft } from './reducers/draftControl';
export { nominate_character, place_bid, pass_bid, timer_expiry_auction } from './reducers/draftAuction';
export { equip_lightcone, arrange_lineup, confirm_lineup, advance_stage } from './reducers/postDraft';
export { concede_match, claim_forfeit, defer_match } from './reducers/concede';
export { advance_to_next_game, shelve_series, resume_series } from './reducers/seriesManagement';
export { admin_force_finalize, admin_void_match, admin_set_bracket_winner } from './reducers/adminMatchTools';
export { select_match_account, deselect_match_account } from './reducers/accountSelection';

// Lifecycle hooks MUST be exported: the SDK only registers a hook when it walks the
// module's exports. A bare `spacetimedb.clientConnected(...)` call is silently dropped
// (no error, no lifecycle reducer in the schema). Export names follow the snake_case
// reducer convention.
export const client_connected = spacetimedb.clientConnected((ctx) => {
  console.log(`Client connected: ${ctx.sender.toHexString()}`);

  // Set isOnline = true for the connected user
  const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
  if (mapping) {
    const user = ctx.db.User.id.find(mapping.userId);
    if (user) {
      ctx.db.User.id.update(updateWithAudit(ctx, user, { isOnline: true }, user.id));

      // D-01: Bump lastSeenAt for GC staleness tracking
      // Note: `lastSeenAt: ctx.timestamp` paired with `updateWithAudit` is safe (NOT Pitfall 6) —
      // there is no custom `ts` variable; both lastSeenAt and lastModifiedDate use ctx.timestamp.
      ctx.db.UserIdentity.identity.update(updateWithAudit(ctx, mapping, {
        lastSeenAt: ctx.timestamp,
      }, user.id));

      // D-08 enforcement point 2: Check if the user's provider is banned on reconnect
      const userPrivate = ctx.db.UserPrivate.userId.find(mapping.userId);
      if (userPrivate && userPrivate.discordId) {
        const isBanned = checkProviderBan(ctx, DISCORD_BAN_TYPE, userPrivate.discordId);
        if (isBanned && !user.deletedAt) {
          ctx.db.User.id.update(updateWithAudit(ctx, user, {
            isOnline: false,
            deletedAt: ctx.timestamp,
          }, user.id));
          // D-10 R1 fix: schedule deletion cascade 5s out (matches admin.ts:181-188 pattern)
          // Actor is user.id — no human admin present on reconnect; matches existing audit pattern
          const deleteAt = ctx.timestamp.microsSinceUnixEpoch + 5_000_000n;
          ctx.db.UserDeletionJob.insert(insertWithAudit(ctx, {
            scheduledId: 0n,
            scheduledAt: ScheduleAt.time(deleteAt),
            userId: user.id,
          }, user.id));
          console.log(`[BAN-RECONNECT] User #${user.id} soft-deleted -- banned Discord ID detected on reconnect.`);
        }
      }
    }
  }
});

export const client_disconnected = spacetimedb.clientDisconnected((ctx) => {
  console.log(`Client disconnected: ${ctx.sender.toHexString()}`);

  // Set isOnline = false for the disconnected user
  const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
  if (!mapping) return;
  const userId = mapping.userId;

  const user = ctx.db.User.id.find(userId);
  if (user) {
    ctx.db.User.id.update(updateWithAudit(ctx, user, { isOnline: false }, userId));
  }

  // Handle lobby member disconnect tracking (D-01, D-08, D-72, D-73)
  const memberships = [...ctx.db.LobbyMember.user_id.filter(userId)];
  for (const member of memberships) {
    const lobby = ctx.db.Lobby.id.find(member.lobbyId);
    if (!lobby) continue;

    // Only process active stages (Drafting/Equipping/Scoring)
    const stageTag = lobby.stage.tag;
    if (stageTag !== 'Drafting' && stageTag !== 'Equipping' && stageTag !== 'Scoring') {
      // For Waiting/AwaitingResult/Finished: just set isOnline=false
      ctx.db.LobbyMember.by_lobby_and_user.delete([member.lobbyId, userId]);
      ctx.db.LobbyMember.insert({
        ...member,
        isOnline: false,
        ...auditUpdate(ctx, member, SYSTEM_USER_ID),
      } as any);
      continue;
    }

    // NoAction policy: tracking only, no pool/pause (D-23, D-25)
    if (lobby.disconnectPolicy.tag === 'NoAction') {
      ctx.db.LobbyMember.by_lobby_and_user.delete([member.lobbyId, userId]);
      ctx.db.LobbyMember.insert({
        ...member,
        isOnline: false,
        ...auditUpdate(ctx, member, SYSTEM_USER_ID),
      } as any);
      continue;
    }

    // Standard/Deferred: set disconnectedAt, isOnline=false (D-08)
    ctx.db.LobbyMember.by_lobby_and_user.delete([member.lobbyId, userId]);
    ctx.db.LobbyMember.insert({
      ...member,
      isOnline: false,
      disconnectedAt: ctx.timestamp,
      ...auditUpdate(ctx, member, SYSTEM_USER_ID),
    } as any);

    // Transfer captain/referee/host flags (D-34, D-35, D-36) — permanent
    transferCaptain(ctx, member.lobbyId, userId);
    transferReferee(ctx, member.lobbyId, userId);
    transferHost(ctx, member.lobbyId, lobby, userId);

    // Auto-pause if match session is not already paused (D-08)
    if (stageTag === 'Drafting') {
      const session = ctx.db.MatchSession.lobbyId.find(member.lobbyId);
      if (session && !session.timerState.isPaused) {
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
          id: 0,
          lobbyId: member.lobbyId,
          gameNumber: session.currentGameNumber,
          sequence: session.turnIndex,
          actorUserId: SYSTEM_USER_ID,
          anonymousLabel: undefined,
          actorSlot: slotToTeamSide(member.lobbySlot),
          action: { tag: 'Pause', value: {} } as any,
          payload: { tag: 'Pause', value: { isAutoPause: true, accumulatedPauseMs: session.timerState.accumulatedPauseMs ?? 0 } } as any,
          timestamp: ctx.timestamp,
        }, SYSTEM_USER_ID));
        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
          timerState: {
            ...session.timerState,
            isPaused: true,
          },
        }, SYSTEM_USER_ID));
      }
    }

    console.log(`[DISCONNECT] User #${userId} disconnected from lobby #${member.lobbyId} (stage: ${stageTag})`);
  }
});

export default spacetimedb;
