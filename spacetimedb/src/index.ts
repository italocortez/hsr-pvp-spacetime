import spacetimedb from './schema';
import { ScheduleAt } from 'spacetimedb';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { checkProviderBan } from '@module/helpers/lobby/banHelper';
import { handleDisconnectPoolUpdate, markMemberOffline } from '@module/helpers/lobby/disconnectHelpers';
import { hasLivePresence, markPresenceOnline } from '@module/helpers/identity/presenceHelpers';
import { seedAbuseConfigDefaults } from '@module/helpers/lobby/abuseControls';
import { seedSystemLobbyPreset } from '@module/helpers/lobby/systemPreset';
import { memberHasLeft } from '@module/helpers/lobby/lobbyHelpers';
import { isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';

// Private auth tables — imported for schema registration (UserPrivate was merged into User, A77)
import '@module/tables/admin/banRecord';

// Phase 15 D-01/D-02: domain view barrel — each file holds views that match the `tables/` layout.
// Every view must be named-re-exported here so [registerExport] fires during module init
// (Phase 12.2 rule — CONVENTIONS.md:233-252). Splitting security/anonymousViews into 8 files
// puts each view in a home that matches its underlying domain.
export {
    view_lobby_browser,
    view_my_lobbies,
    view_my_lobby_chat,
    view_my_lobby_members,
    view_my_lobby,                          // S9a
    view_my_lobby_bans,                     // S9a
    view_lobby_presets,                     // S9a
} from '@module/views/lobbyViews';
export {
    view_my_identity,
    view_my_profile,
    view_public_hsr_accounts,
    view_admin_user_private,
    view_user_by_username,                  // S9b: arg view (username)
    view_user_achievements,                 // S9b: arg view (userId)
    view_admin_users,                       // S11a (A77): Moderator+, the admin Users tab
    view_my_link_request,                   // M5a: the caller's one-time link code
} from '@module/views/identityViews';
export {
    view_my_cost_sets,
    view_my_draft_character_costs,
    view_my_draft_lightcone_costs,
    view_my_draft_synergy_costs,
    view_cost_set_missing,                  // S10i: arg view (costSetId), A107(2)
    view_published_cost_sets,               // S11a (L91): CostSet is private; the published sets for everyone
} from '@module/views/costSetViews';
export {
    view_my_player_stats,
    view_my_character_stats,
    view_my_mmr_ratings,                    // S9b
} from '@module/views/statsViews';
export {
    view_my_calendar_events,                // S9b
    view_my_calendar_invites,
    view_my_availability,
    view_saved_calendar_availability,
    view_my_saved_calendars,
    view_event_attendees,                   // S10ad (A161(1)): with an argument
} from '@module/views/calendarViews';
export {
    view_admin_user_identities,             // S9b: Moderator+
    view_admin_ban_records,
    view_admin_deleted_users,
    view_admin_presence,
    view_admin_lobby_bans,
    view_admin_abuse_config,
} from '@module/views/adminViews';
export {
    view_my_relationships,
    view_my_roster_visibility,
    view_my_roster,
} from '@module/views/socialViews';
export {
    view_my_match_steps,
    view_my_match_participants,
    view_my_match_session,                  // S9a
    view_my_lineups,                        // S9a
} from '@module/views/matchViews';
export {
    view_my_match_result,                   // S9a
    view_my_match_result_games,             // S9a
    view_admin_stuck_games,                 // S9a
} from '@module/views/matchResultViews';
export {
    // S9a (A37): view_match_history, view_match_participant_history, view_match_step_history removed
    // S10n (A115): the five unbounded view_my_match_*_history views are replaced by the paged list, its count and
    // the per-match detail views
    view_my_match_history,                  // S10n (A115)
    view_my_match_history_count,            // S10n (A115)
    view_my_match_history_participants,     // S10n (A115)
    view_my_match_history_steps,            // S10n (A115)
    view_my_match_history_games,            // S10n (A115)
    view_my_match_history_lineups,          // S10n (A115)
    view_my_mmr_history,                    // Phase 15 D-13; paged since S10n (A115(4))
} from '@module/views/matchHistoryViews';
export {
    view_my_tournaments,
    view_my_tournament_enrolled,
    view_my_tournament_teams,
    view_my_tournament_team_members,
    view_my_tournament_matches,
    view_my_tournament_match_results,
    view_my_tournament_lobbies,
    view_admin_tournament,                  // S10g (A105(2)): Admin-only arg views (tournamentId)
    view_admin_tournament_enrolled,
    view_admin_tournament_teams,
    view_admin_tournament_team_members,
    view_admin_tournament_matches,
    view_admin_tournament_match_results,
    view_admin_tournament_lobbies,
    view_tournament_registrant_accounts,
    view_tournament_participants,           // S9a: arg views (tournamentId)
    view_tournament_teams,
    view_tournament_team_members,
    view_tournament_staff,
    view_my_tournament_enrollment,          // S9a: per-sender
    view_my_team_requests,
    view_my_stand_ins,
    view_my_tournament_stand_ins,
    view_tournament_matches_for_me,
} from '@module/views/tournamentViews';
export { broadcast_cursor } from '@module/reducers/lobby/cursor';
export { login_as_guest, request_link_code, confirm_link } from '@module/reducers/identity/auth';
export { delete_my_account, update_display_name, update_username, update_avatar } from '@module/reducers/identity/profile';
export { server_register_delegate, server_revoke_delegate, server_link_provider, server_link_by_code, server_set_role, server_delete_user, server_set_guest_creation, server_set_guest_lobby_creation, server_set_datetime, server_set_online, server_set_mmr, server_nuke_test_data } from '@module/reducers/identity/server';
export { admin_ban_user, admin_unban_user } from '@module/reducers/admin/banAdmin';
export { admin_delete_row, admin_bulk_upsert, admin_update_user } from '@module/reducers/admin/admin';
export { admin_update_elo_config, admin_seed_elo_config } from '@module/reducers/stats/eloAdmin';
export { admin_seed_rating_config, admin_update_rating_config, admin_recalculate_all_ratings } from '@module/reducers/stats/ratingAdmin';
export { run_user_deletion } from '@module/reducers/identity/userDeletion';
export { create_hsr_account, update_hsr_account, set_active_hsr_account, delete_hsr_account, batch_upsert_characters, batch_remove_characters, migrate_roster } from '@module/reducers/roster/roster';
export { admin_create_hsr_account, admin_update_hsr_account, admin_delete_hsr_account, admin_batch_upsert_characters, admin_batch_remove_characters, admin_upsert_archetype, admin_delete_archetype, admin_assign_character_archetypes, admin_remove_character_archetypes } from '@module/reducers/roster/rosterAdmin';
export { create_cost_set, edit_draft_character_cost, edit_draft_lightcone_cost, edit_draft_synergy_cost, publish_cost_set, lock_cost_set, unpublish_cost_set, delete_cost_set } from '@module/reducers/roster/costSetManagement';
export { create_tournament, update_tournament, advance_tournament_stage, cancel_tournament, admin_cancel_idle_tournaments, admin_restart_tournament_finalize } from '@module/reducers/tournament/tournamentManagement';
export { check_in_tournament } from '@module/reducers/tournament/tournamentCheckIn';
export { register_for_tournament, withdraw_from_tournament, approve_participant, reject_participant, waitlist_promote, add_participant, set_anonymous_alias, lock_tournament_accounts } from '@module/reducers/tournament/tournamentRegistration';
export { create_tournament_team, request_join_team, accept_team_request, reject_team_request, leave_tournament_team, disband_tournament_team, withdraw_tournament_team, add_team_member, rename_tournament_team, assign_team_group, clear_team_groups } from '@module/reducers/tournament/tournamentTeams';
export { transfer_referee, reclaim_referee, transfer_host } from '@module/reducers/lobby/refereeManagement';
export { confirm_game, close_game, dispute_match_result } from '@module/reducers/results/matchResultSubmission';
export { record_group_scores, set_score_adjustment } from '@module/reducers/results/scoreEntry';
export { dq_participant, override_match_result, assign_tournament_assistant, remove_tournament_assistant, mod_promote_to_host, mod_demote_from_host } from '@module/reducers/tournament/tournamentAdmin';
export { set_match_sides } from '@module/reducers/tournament/bracketSides';
export { generate_bracket, seed_bracket, set_seed_order } from '@module/reducers/tournament/bracketGeneration';
export { advance_group_stage, resolve_bracket_match, rollback_bracket_match } from '@module/reducers/tournament/bracketAdvancement';
export { finalize_match_result, validate_match_result } from '@module/reducers/results/matchFinalization';
export { create_season, set_active_season } from '@module/reducers/tournament/seasonAdmin';
export { create_achievement, update_achievement, delete_achievement, add_achievement_criteria, remove_achievement_criteria, manual_award_achievement, set_displayed_achievement } from '@module/reducers/stats/achievementManagement';
export { create_availability_slot, update_availability_slot, delete_availability_slot } from '@module/reducers/calendar/calendarAvailability';
export { save_calendar, unsave_calendar, toggle_calendar_visibility } from '@module/reducers/calendar/calendarSaved';
export { create_calendar_event, update_calendar_event, delete_calendar_event, invite_to_event, remove_invite } from '@module/reducers/calendar/calendarEvents';
export { respond_to_invite } from '@module/reducers/calendar/calendarInviteResponse';
export { create_lobby, join_lobby, leave_lobby, close_lobby, kick_member, ban_member, unban_member } from '@module/reducers/lobby/lobbyLifecycle';
export { send_chat_message, delete_chat_message } from '@module/reducers/lobby/chat';
export { update_lobby_settings, set_team_slot, confirm_ready, unconfirm_ready, set_captain, shuffle_teams } from '@module/reducers/lobby/lobbySettings';
export { create_lobby_preset, update_lobby_preset, delete_lobby_preset } from '@module/reducers/lobby/lobbyPresets';
export { create_tournament_lobby, approve_stand_in, revoke_stand_in } from '@module/reducers/tournament/tournamentLobby';
export { run_lobby_gc, admin_gc_lobbies, seed_lobby_gc_job } from '@module/reducers/lobby/lobbyGc';
export { run_identity_gc, admin_gc_identities, seed_identity_gc_job } from '@module/reducers/identity/identityGc';
export { run_referee_transfer_check } from '@module/reducers/lobby/refereeTransfer';
export { run_tournament_finalize } from '@module/reducers/tournament/tournamentFinalize';
export { admin_update_abuse_config, admin_set_guest_lobby_creation, admin_set_guest_creation, admin_acknowledge_alert } from '@module/reducers/admin/abuse';
export { start_draft, pick_character, ban_character, timer_expiry_classic } from '@module/reducers/draft/draftClassic';
export { undo_last_step, pause_draft, resume_draft } from '@module/reducers/draft/draftControl';
export { nominate_character, place_bid, pass_bid, timer_expiry_auction } from '@module/reducers/draft/draftAuction';
export { equip_lightcone, unequip_lightcone, arrange_lineup, set_eidolon, advance_stage } from '@module/reducers/draft/postDraft';
export { concede_match, claim_forfeit, defer_match } from '@module/reducers/results/concede';

export { admin_force_finalize, admin_void_match } from '@module/reducers/admin/adminMatchTools';
export { select_match_account, deselect_match_account } from '@module/reducers/lobby/accountSelection';

// Lifecycle hooks MUST be exported: the SDK only registers a hook when it walks the
// module's exports. A bare `spacetimedb.clientConnected(...)` call is silently dropped
// (no error, no lifecycle reducer in the schema). Export names follow the snake_case
// reducer convention.
// init runs on the first publish and on every --delete-data republish, never on a plain republish.
// Its sender is the publisher (the database owner). ACCESS-SECURITY-OPS §C.4: register the owner and
// create the SYSTEM user. This replaces the old first-come server registration reducer (removed in M2).
export const init = spacetimedb.init((ctx) => {
  // iter() required: checking table emptiness (no count/isEmpty API; the table holds 1-2 rows).
  if ([...ctx.db.ServerIdentity.iter()].length === 0) {
    ctx.db.ServerIdentity.insert({
      identity: ctx.sender,
      kind: { tag: 'Owner' },
      label: 'owner',
      registeredAt: ctx.timestamp,
    });

    // The SYSTEM user: the first user in the database. User.id is autoInc, so id: 0 asks for the
    // next value; SYSTEM_USER_ID (0) is only the audit sentinel, never the row id. Reducers find the
    // row by its unique username 'SYSTEM'.
    const systemUser = ctx.db.User.insert(insertWithAudit(ctx, {
      id: 0,
      username: 'SYSTEM',
      displayName: 'SYSTEM',
      isGuest: false,
      role: { tag: 'Admin' },
      avatarCharacterName: 'march7th',
      displayedAchievementId: undefined,
      deletedAt: undefined,
      loginMethod: undefined,
      providerId: undefined,
      providerUsername: undefined,
      linkedAt: undefined,
    }, SYSTEM_USER_ID));

    // Link the owner identity to the SYSTEM user so owner connections pass
    // getAuthenticatedUser / ensureAdmin checks. Delegates get the same link in server_register_delegate.
    ctx.db.UserIdentity.insert(insertWithAudit(ctx, {
      identity: ctx.sender,
      userId: systemUser.id,
      lastSeenAt: ctx.timestamp,
    }, SYSTEM_USER_ID));
  }

  // Abuse controls (D-B5 / A42): the AbuseConfig singleton with its defaults. Idempotent (inserted only when absent),
  // SYSTEM actor. The guest-lobby circuit breaker runs inline in create_lobby (A57), so no job is seeded.
  seedAbuseConfigDefaults(ctx);

  // A33a / CH-S4: the built-in system lobby preset ("Tournament default"), owned by SYSTEM_USER_ID, from
  // compile-time constants (helpers/lobby/systemPreset.ts). Idempotent: inserted only when absent.
  seedSystemLobbyPreset(ctx);
});

export const client_connected = spacetimedb.clientConnected((ctx) => {
  console.log(`Client connected: ${ctx.sender.toHexString()}`);

  // B-8 (ACCESS-SECURITY-OPS §B.3 / §B.5): under maintenance mode only registered server identities and, since S11a
  // (A163(3), triage L9), identities of a live Admin user may connect. Throwing in this hook rejects the socket (skill
  // how-to "Rejecting Client Connections"). The AbuseConfig singleton (id 1) is seeded by init; while the row is
  // absent this check is inert. A connected non-Admin is refused on every action by ensureNotInMaintenance.
  const abuseConfig = ctx.db.AbuseConfig.id.find(1);
  if (abuseConfig?.maintenanceMode && !ctx.db.ServerIdentity.identity.find(ctx.sender)) {
    const adminMapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    const adminUser = adminMapping ? ctx.db.User.id.find(adminMapping.userId) : undefined;
    if (!adminUser || adminUser.deletedAt || !isRoleAtLeast(adminUser.role, 'Admin')) {
      throw new Error('Maintenance mode: connections are not accepted right now.');
    }
  }

  // A fresh guest has no mapping yet: login_as_guest creates it and upserts the presence row itself.
  const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
  if (!mapping) return;
  const user = ctx.db.User.id.find(mapping.userId);
  if (!user) return;

  // A48 (D-A1): presence lives in the private per-identity UserPresence row, not on the public User row.
  markPresenceOnline(ctx, ctx.sender, user.id);

  // D-01: Bump lastSeenAt for GC staleness tracking
  // Note: `lastSeenAt: ctx.timestamp` paired with `updateWithAudit` is safe (NOT Pitfall 6) —
  // there is no custom `ts` variable; both lastSeenAt and lastModifiedDate use ctx.timestamp.
  ctx.db.UserIdentity.identity.update(updateWithAudit(ctx, mapping, {
    lastSeenAt: ctx.timestamp,
  }, user.id));

  // F1 (A22(2)): restore every membership of the user and cancel its pending A22a checks, so a reconnect inside
  // the 15 s window keeps every flag and never pauses the draft. Idempotent: a row already online is left alone.
  // The pool decrement is the D-10/D-11 rule (handleDisconnectPoolUpdate); join_lobby stays the explicit path.
  // A68(2): an away / abandoned row is left alone (offline, its pending 15 s check kept): the user may be browsing
  // the site; only an explicit return through join_lobby clears leftAt.
  for (const member of [...ctx.db.LobbyMember.user_id.filter(user.id)]) {
    if (memberHasLeft(member)) continue;
    for (const check of [...ctx.db.RefereeTransferCheck.by_lobby_and_user.filter([member.lobbyId, user.id])]) {
      ctx.db.RefereeTransferCheck.scheduledId.delete(check.scheduledId);
    }
    if (member.isOnline) continue;
    const lobby = ctx.db.Lobby.id.find(member.lobbyId);
    if (!lobby) continue;
    ctx.db.LobbyMember.by_lobby_and_user.delete([member.lobbyId, user.id]);
    ctx.db.LobbyMember.insert(updateWithAudit(ctx, member, {
      isOnline: true,
      disconnectedAt: undefined,
      disconnectPoolRemainingMs: handleDisconnectPoolUpdate(ctx, member, lobby, ctx.timestamp),
    }, user.id));
    // S10aa (A151): the reconnect no longer lifts a disconnect auto-pause (A92(7) superseded); resume_draft does.
  }

  // D-08 enforcement point 2: Check if the user's provider is banned on reconnect (A46: loginMethod + providerId)
  // A77 (S11a): the provider link is on the User row (merged from UserPrivate).
  if (user.loginMethod !== undefined && user.providerId !== undefined) {
    const isBanned = checkProviderBan(ctx, user.loginMethod, user.providerId);
    if (isBanned && !user.deletedAt) {
      ctx.db.User.id.update(updateWithAudit(ctx, user, {
        deletedAt: ctx.timestamp,
      }, user.id));
      // D-10 R1 fix: schedule deletion cascade 5s out (the admin_delete_row('User') pattern, reducers/admin/admin.ts)
      // Actor is user.id — no human admin present on reconnect; matches existing audit pattern
      const deleteAt = ctx.timestamp.microsSinceUnixEpoch + 5_000_000n;
      ctx.db.UserDeletionJob.insert(insertWithAudit(ctx, {
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(deleteAt),
        userId: user.id,
      }, user.id));
      console.log(`[BAN-RECONNECT] User #${user.id} soft-deleted -- banned provider id detected on reconnect.`);
    }
  }
});

export const client_disconnected = spacetimedb.clientDisconnected((ctx) => {
  console.log(`Client disconnected: ${ctx.sender.toHexString()}`);

  const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
  if (!mapping) return;
  const userId = mapping.userId;

  // A48: mark this identity's presence row offline; "user offline" = no live row left (user_id index).
  const presence = ctx.db.UserPresence.identity.find(ctx.sender);
  if (presence) {
    ctx.db.UserPresence.identity.update(updateWithAudit(ctx, presence, {
      isOnline: false,
      lastSeenAt: ctx.timestamp,
    }, userId));
  }
  // Another device of the same user is still connected: memberships stay online, nothing is scheduled.
  if (hasLivePresence(ctx, userId)) return;

  // A22a (D.8.2): per membership, mark offline; in an active stage also stamp disconnectedAt (Standard/Deferred
  // only, D-08; NoAction tracks nothing) and schedule the grace check 15 s out (markMemberOffline, shared with a
  // player's live-stage Leave, A68(1)). Nothing else happens here: the referee / captain / host transfers and the
  // player auto-pause are decided by run_referee_transfer_check. A68(2): away / abandoned rows are already offline
  // and keep their stamp and pending check.
  for (const member of [...ctx.db.LobbyMember.user_id.filter(userId)]) {
    if (memberHasLeft(member)) continue;
    const lobby = ctx.db.Lobby.id.find(member.lobbyId);
    if (!lobby) continue;

    markMemberOffline(ctx, lobby, member, SYSTEM_USER_ID);
    console.log(`[DISCONNECT] User #${userId} offline in lobby #${member.lobbyId} (stage: ${lobby.stage.tag})`);
  }
});

export default spacetimedb;
