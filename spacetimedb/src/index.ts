import spacetimedb from './schema';
import { ScheduleAt } from 'spacetimedb';
import { SYSTEM_USER_ID } from './helpers/auditColumns';
import { insertWithAudit, updateWithAudit } from './helpers/auditHelpers';
import { checkProviderBan } from './helpers/banHelper';
import { handleDisconnectPoolUpdate } from './helpers/disconnectHelpers';
import { hasLivePresence, markPresenceOnline } from './helpers/presenceHelpers';
import { seedAbuseConfigDefaults } from './helpers/abuseControls';
import { seedSystemLobbyPreset } from './helpers/systemPreset';
import { ACTIVE_STAGES, type LobbyStage } from '@shared/lobby-rules';

// A22a: the grace period between a user's last disconnect and the referee / captain / host transfer check.
const REFEREE_TRANSFER_GRACE_MICROS = 15_000_000n;
// D-08: the forfeit clock (disconnectedAt -> pool decrement, isForfeitEligible) runs only in the three live-match
// stages. BetweenGames and Shelved still schedule the grace check (ACTIVE_STAGES) but never start that clock: a
// shelved series expects its players offline for days (review finding 1, 2026-11-06).
const DISCONNECT_CLOCK_STAGES: readonly LobbyStage[] = ['Drafting', 'Equipping', 'Scoring'];

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
    view_tournament_registrant_accounts,
} from './views/tournamentViews';
export { broadcast_cursor } from './reducers/cursor';
export { login_as_guest } from './reducers/auth';
export { delete_my_account, update_display_name, update_username, update_avatar } from './reducers/profile';
export { server_register_delegate, server_revoke_delegate, server_link_provider, server_set_role, server_delete_user, server_set_datetime, server_set_online, server_set_mmr, server_nuke_test_data } from './reducers/server';
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
export { record_group_scores, set_score_adjustment } from './reducers/scoreEntry';
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
export { create_lobby, join_lobby, leave_lobby, close_lobby, kick_member, ban_member, unban_member } from './reducers/lobbyLifecycle';
export { send_chat_message, delete_chat_message } from './reducers/chat';
export { update_lobby_settings, set_team_slot, confirm_ready, unconfirm_ready, set_captain, shuffle_teams } from './reducers/lobbySettings';
export { create_lobby_preset, update_lobby_preset, delete_lobby_preset } from './reducers/lobbyPresets';
export { create_tournament_lobby, approve_stand_in } from './reducers/tournamentLobby';
export { run_lobby_gc, admin_gc_lobbies, seed_lobby_gc_job } from './reducers/lobbyGc';
export { run_identity_gc, admin_gc_identities, seed_identity_gc_job } from './reducers/identityGc';
export { run_referee_transfer_check } from './reducers/refereeTransfer';
export { run_tournament_finalize } from './reducers/tournamentFinalize';
export { admin_update_abuse_config, admin_set_guest_lobby_creation, admin_acknowledge_alert } from './reducers/abuse';
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
      hasDiscordLinked: false,
      avatarCharacterName: 'march7th',
      displayedAchievementId: undefined,
      deletedAt: undefined,
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
  // compile-time constants (helpers/systemPreset.ts). Idempotent: inserted only when absent.
  seedSystemLobbyPreset(ctx);
});

export const client_connected = spacetimedb.clientConnected((ctx) => {
  console.log(`Client connected: ${ctx.sender.toHexString()}`);

  // B-8 (ACCESS-SECURITY-OPS §B.3 / §B.5): under maintenance mode only registered server identities may connect.
  // Throwing in this hook rejects the socket (skill how-to "Rejecting Client Connections"). The AbuseConfig
  // singleton (id 1) is seeded by init; while the row is absent this check is inert.
  const abuseConfig = ctx.db.AbuseConfig.id.find(1);
  if (abuseConfig?.maintenanceMode && !ctx.db.ServerIdentity.identity.find(ctx.sender)) {
    throw new Error('Maintenance mode: connections are not accepted right now.');
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
  for (const member of [...ctx.db.LobbyMember.user_id.filter(user.id)]) {
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
  }

  // D-08 enforcement point 2: Check if the user's provider is banned on reconnect (A46: loginMethod + providerId)
  const userPrivate = ctx.db.UserPrivate.userId.find(mapping.userId);
  if (userPrivate) {
    const isBanned = checkProviderBan(ctx, userPrivate.loginMethod, userPrivate.providerId);
    if (isBanned && !user.deletedAt) {
      ctx.db.User.id.update(updateWithAudit(ctx, user, {
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
  // only, D-08; NoAction tracks nothing) and schedule the grace check 15 s out. Nothing else happens here: the
  // referee / captain / host transfers and the player auto-pause are decided by run_referee_transfer_check.
  for (const member of [...ctx.db.LobbyMember.user_id.filter(userId)]) {
    const lobby = ctx.db.Lobby.id.find(member.lobbyId);
    if (!lobby) continue;

    const stageTag = lobby.stage.tag as LobbyStage;
    const isActiveStage = ACTIVE_STAGES.includes(stageTag);
    const tracksDisconnect = DISCONNECT_CLOCK_STAGES.includes(stageTag) && lobby.disconnectPolicy.tag !== 'NoAction';

    ctx.db.LobbyMember.by_lobby_and_user.delete([member.lobbyId, userId]);
    ctx.db.LobbyMember.insert(updateWithAudit(ctx, member, {
      isOnline: false,
      disconnectedAt: tracksDisconnect ? ctx.timestamp : member.disconnectedAt,
    }, SYSTEM_USER_ID));

    if (!isActiveStage) continue;

    // One pending check per (lobby, user): drop a stale one before scheduling.
    for (const check of [...ctx.db.RefereeTransferCheck.by_lobby_and_user.filter([member.lobbyId, userId])]) {
      ctx.db.RefereeTransferCheck.scheduledId.delete(check.scheduledId);
    }
    ctx.db.RefereeTransferCheck.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + REFEREE_TRANSFER_GRACE_MICROS),
      lobbyId: member.lobbyId,
      userId,
    });

    console.log(`[DISCONNECT] User #${userId} offline in lobby #${member.lobbyId} (stage: ${stageTag}); transfer check scheduled in 15 s`);
  }
});

export default spacetimedb;
