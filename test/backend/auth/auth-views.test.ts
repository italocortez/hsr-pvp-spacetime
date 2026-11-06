import { describe, it, expect } from 'vitest';

/**
 * Auth Views (Security Views) integration tests.
 *
 * SpacetimeDB views are virtual projections — they are NOT queryable via
 * `spacetime sql` CLI ("no such table"). Views are only accessible via
 * WebSocket subscriptions, but views don't generate typed client bindings
 * (conn.db.ViewName is undefined). This means automated testing of view
 * projections is currently not possible via the integration test harness.
 *
 * Coverage is provided by:
 *   - UAT test 10 (manual verification of view_my_profile in browser)
 *   - Frontend integration (useAuth subscribes to view_my_profile, view_my_identity)
 *   - The views themselves are thin SQL projections of already-tested tables
 *
 * These placeholder tests document the expected behavior and serve as
 * anchors for future automation when the SDK supports view bindings.
 */
describe('Auth Views (Security Views)', () => {

  describe('VIEW-02: view_my_profile', () => {
    // view_my_profile uses ctx.sender to resolve UserIdentity → User,
    // then left-joins UserPrivate to return merged MyProfileRow.
    // The spacetime sql CLI has no sender context, so this view
    // always returns empty when queried via SQL.
    //
    // Functional coverage: UAT test 10, useAuth.ts frontend integration.
    it.todo('merges User + UserPrivate for caller identity (verified in UAT test 10)');
  });

  describe('VIEW-03: view_my_identity', () => {
    // view_my_identity returns the single UserIdentity row for ctx.sender.
    // SEC-02 in auth-security.test.ts verifies the mapping exists via SQL
    // against the raw user_identity table (which IS a physical table).
    it.todo('returns only caller own identity mapping (verified in SEC-02)');
  });

  describe('VIEW-04: view_admin_user_private', () => {
    // view_admin_user_private checks isRoleAtLeast(user.role, 'Moderator')
    // before returning UserPrivate rows. Requires WebSocket subscription
    // with a Moderator+ identity, which is not supported by the test
    // harness (views don't generate typed bindings).
    it.todo('gated by Moderator+ role (not testable via SQL — no sender context)');
  });
});
