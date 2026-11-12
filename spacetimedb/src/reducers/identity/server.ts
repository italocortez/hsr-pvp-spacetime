import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { Identity, Timestamp } from 'spacetimedb';
import { auditUpdate, SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { performUserDeletion } from '@module/helpers/identity/userDeletionHelper';
import { isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { handOverMatchEventsOfFormerStaff } from '@module/helpers/calendar/calendarCascade';
import { moveTournamentTiesToUser } from '@module/helpers/tournament/entryTransfer';
import { rejectIfBanned, DISCORD_LOGIN_METHOD } from '@module/helpers/lobby/banHelper';
import { seedSystemLobbyPreset } from '@module/helpers/lobby/systemPreset';
import { uniqueUsername, USERNAME_MAX_LENGTH } from '@module/helpers/identity/usernames';
import { setGuestCreationEnabled, setGuestLobbyCreationEnabled } from '@module/helpers/lobby/abuseControls';
import { LIVE_STAGES, slotIsCoach, slotIsSpectator } from '@module/helpers/lobby/lobbyHelpers';

/** A113(4) (S10m): the refusal of a sign-in to an existing account while the guest plays a live game. */
const FINISH_GAME_BEFORE_SIGN_IN_TEXT = 'Finish your current game before signing in to an existing account.';

/**
 * A113(4): the user holds a player seat (BluePlayer / RedPlayer; coach and spectator seats do not count) that is not
 * abandoned (A68(4): an away seat still counts, its holder may return) in a lobby whose stage is Drafting, Equipping or
 * Scoring (LIVE_STAGES). Waiting and AwaitingResult lobbies do not count.
 */
function isSeatedInLiveGame(ctx: any, userId: number): boolean {
    for (const m of ctx.db.LobbyMember.user_id.filter(userId)) {
        if (slotIsSpectator(m.lobbySlot) || slotIsCoach(m.lobbySlot) || m.abandonedAt !== undefined) continue;
        const lobby = ctx.db.Lobby.id.find(m.lobbyId);
        if (lobby && LIVE_STAGES.includes(lobby.stage.tag)) return true;
    }
    return false;
}

/**
 * Guard: the caller is a registered server identity (Owner or Delegate, §C.4).
 * Used by every server_* reducer.
 */
function requireServer(ctx: any) {
    const server = ctx.db.ServerIdentity.identity.find(ctx.sender);
    if (!server) {
        throw new SenderError('Forbidden: caller is not a registered server identity.');
    }
    return server;
}

/**
 * Guard: the caller is the Owner server identity (the publisher, registered by `init`).
 * Only the owner may register or revoke delegates.
 */
function requireOwner(ctx: any) {
    const server = requireServer(ctx);
    if (server.kind.tag !== 'Owner') {
        throw new SenderError('Forbidden: only the owner server identity may do this.');
    }
    return server;
}

/**
 * Guard for the test-only reducers (D-C1). Default-deny: anything but 'test' rejects, including a
 * database published without STDB_TARGET (the value is then absent and reads as undefined).
 * Must be the FIRST line of server_set_datetime, server_set_online, server_set_mmr, server_nuke_test_data.
 */
// ctx.env.STDB_TARGET is typed `string` on SDK 2.14.1 + TS 7.1 beta (the t.enum literal union is not surfaced).
function requireTestDatabase(ctx: { readonly env: { readonly STDB_TARGET: string } }) {
    if (ctx.env.STDB_TARGET !== 'test') throw new SenderError('Not a test database.');
}

function parseIdentityHex(identityHex: string, argName = 'identityHex'): Identity {
    if (!identityHex || identityHex.length === 0) {
        throw new SenderError(`${argName} is required`);
    }
    try {
        return Identity.fromString(identityHex);
    } catch {
        throw new SenderError(`${argName} is not a valid identity`);
    }
}

// USERNAME_MAX_LENGTH and uniqueUsername (S10e, identity audit #3) live in helpers/identity/usernames.ts (S10h: shared
// with login_as_guest).

/**
 * Owner-only: register a delegate server identity (e.g. the bootstrap script's fresh token,
 * the Vercel auth function). The delegate is linked to the SYSTEM user through UserIdentity so
 * its connections pass the getAuthenticatedUser / ensureAdmin checks (admin_bulk_upsert, seeding).
 *
 * Run via: scripts/stdb/bootstrap.ts --target <test|prod>
 */
export const server_register_delegate = spacetimedb.reducer({
    identityHex: t.string(),
    label: t.string(),
}, (ctx, { identityHex, label }) => {
    requireOwner(ctx);
    const identity = parseIdentityHex(identityHex);
    if (!label || label.length === 0) {
        throw new SenderError('label is required');
    }
    if (ctx.db.ServerIdentity.identity.find(identity)) {
        throw new SenderError('Already registered.');
    }
    if (ctx.db.UserIdentity.identity.find(identity)) {
        throw new SenderError('Identity is already linked to a user; mint a fresh identity for the delegate.');
    }

    // SYSTEM_USER_ID is the audit sentinel (0), not the SYSTEM row's id: User.id is autoInc,
    // so the SYSTEM row created by `init` is found by its unique username.
    const systemUser = ctx.db.User.username.find('SYSTEM');
    if (!systemUser) {
        throw new SenderError('SYSTEM user missing; the database was not initialized by init.');
    }

    ctx.db.ServerIdentity.insert({
        identity,
        kind: { tag: 'Delegate' },
        label,
        registeredAt: ctx.timestamp,
    });
    ctx.db.UserIdentity.insert(insertWithAudit(ctx, {
        identity,
        userId: systemUser.id,
        lastSeenAt: ctx.timestamp,
    }, SYSTEM_USER_ID));
});

/**
 * Owner-only: revoke a delegate server identity (a leaked token is revoked here and a new one
 * minted by bootstrap, without a wipe). Deletes the ServerIdentity row and the delegate's
 * UserIdentity row. The Owner row cannot be revoked.
 */
export const server_revoke_delegate = spacetimedb.reducer({
    identityHex: t.string(),
}, (ctx, { identityHex }) => {
    requireOwner(ctx);
    const identity = parseIdentityHex(identityHex);
    const row = ctx.db.ServerIdentity.identity.find(identity);
    if (!row) {
        throw new SenderError('Not a registered server identity.');
    }
    if (row.kind.tag !== 'Delegate') {
        throw new SenderError('Only delegates can be revoked.');
    }
    ctx.db.ServerIdentity.identity.delete(identity);
    ctx.db.UserIdentity.identity.delete(identity);
    // S10e (identity audit #5): the identity's UserPresence row goes with its mapping; client_disconnected returns
    // before touching presence once the mapping is gone, so a live row would stay online for the SYSTEM user.
    if (ctx.db.UserPresence.identity.find(identity)) ctx.db.UserPresence.identity.delete(identity);
});

/**
 * Server-only reducer: link an OAuth provider to a user identity.
 * Replaces server_link_discord with a unified, extensible approach.
 * Currently supports: discord (only provider in scope).
 *
 * Called by a registered server identity (Owner or Delegate): the auth function (Vercel, M5)
 * uses the delegate token from bootstrap after verifying the OAuth session.
 *
 * The callerIdentityHex is the verified SpacetimeDB identity hex of the
 * end-user (verified via ephemeral connection in the API route).
 */
export const server_link_provider = spacetimedb.reducer({
    callerIdentityHex: t.string(),
    provider: t.string(),       // 'discord' -- extensible for future providers
    providerId: t.string(),
    providerName: t.string(),
}, (ctx, { callerIdentityHex, provider, providerId, providerName }) => {
    // 1. Verify caller is the trusted server
    requireServer(ctx);
    const systemUserId = SYSTEM_USER_ID;

    // 2. Validate inputs. S10e (identity audit #3): the provider name is trimmed and capped like a username
    // (USERNAME_MAX_LENGTH, update_username / update_display_name).
    if (!providerId || providerId.length === 0) {
        throw new SenderError('providerId is required');
    }
    const name = (providerName ?? '').trim().slice(0, USERNAME_MAX_LENGTH);
    if (name.length === 0) {
        throw new SenderError('providerName is required');
    }
    if (!callerIdentityHex || callerIdentityHex.length === 0) {
        throw new SenderError('callerIdentityHex is required');
    }

    // 3. Validate provider (A46: the token's login_method; Discord-only policy at launch)
    const validProviders = [DISCORD_LOGIN_METHOD];
    if (!validProviders.includes(provider)) {
        throw new SenderError(`Invalid provider "${provider}". Must be one of: ${validProviders.join(', ')}`);
    }
    const loginMethod = provider;

    // 4. Ban check (D-08 enforcement point 1: link-time)
    rejectIfBanned(ctx, loginMethod, providerId);

    // 5. Resolve the end-user's identity -> UserIdentity -> User
    const callerIdentity = parseIdentityHex(callerIdentityHex, 'callerIdentityHex');
    const userMapping: any = ctx.db.UserIdentity.identity.find(callerIdentity);

    let currentUser: any = null;
    if (userMapping) {
        currentUser = ctx.db.User.id.find(userMapping.userId);
    }

    // 6. Check if a user already holds this provider identity (A77: the provider columns are on User)
    // M5: switch to by_method_and_provider.filter([loginMethod, providerId]) with the link-code flow.
    const existingByProvider = [...ctx.db.User.provider_id.filter(providerId)]
        .filter((u: any) => u.loginMethod === loginMethod);
    const providerOwner = existingByProvider.length > 0 ? existingByProvider[0] : null;

    if (currentUser) {
        if (providerOwner && providerOwner.id !== currentUser.id) {
            // Case 1b: Identity currently points to a different user (guest),
            // but the provider account belongs to an existing verified user.
            // Re-point identity to the provider owner, clean up orphaned guest.
            const oldGuestId = currentUser.id;
            const wasGuest = currentUser.isGuest;

            // A113(4) (S10m): the guest is deleted below when this identity is its only link (the mapping is re-pointed
            // first). On that path, refuse before any change while the guest holds a player seat (not coach, not
            // spectator, not abandoned) in a lobby that is Drafting, Equipping or Scoring: its game would lose a player.
            if (wasGuest && [...ctx.db.UserIdentity.user_id.filter(oldGuestId)].length <= 1 && isSeatedInLiveGame(ctx, oldGuestId)) {
                throw new SenderError(FINISH_GAME_BEFORE_SIGN_IN_TEXT);
            }

            ctx.db.UserIdentity.identity.update(updateWithAudit(ctx, userMapping, {
                userId: providerOwner.id,
                lastSeenAt: ctx.timestamp,
            }, systemUserId));

            // A48 (S3 review M3): client_connected does not re-run after a mid-connection re-point, so the
            // identity's UserPresence row follows the mapping here (userId + lastLoginAt), before the guest's
            // own presence rows go with performUserDeletion below. M5 owns the rest of the link flow.
            const presence = ctx.db.UserPresence.identity.find(callerIdentity);
            if (presence) {
                ctx.db.UserPresence.identity.update(updateWithAudit(ctx, presence, {
                    userId: providerOwner.id,
                    lastLoginAt: ctx.timestamp,
                }, systemUserId));
            }

            if (wasGuest) {
                const remainingLinks = [...ctx.db.UserIdentity.user_id.filter(oldGuestId)];
                if (remainingLinks.length === 0) {
                    // A112 (S10l): the guest's entries in unfinished tournaments move to the existing user first; the
                    // ones it cannot hold are settled by the deletion (A94(2)).
                    moveTournamentTiesToUser(ctx, oldGuestId, providerOwner.id, systemUserId);
                    performUserDeletion(ctx, oldGuestId, systemUserId);
                }
            }
            return;
        }

        // Case 1a / 1c: Upgrade guest or refresh provider info
        // S10e (identity audit #3): a guest upgrade takes the provider name, or a derived free one on a collision.
        // A77 (S11a): the provider columns are written on the User row (formerly the UserPrivate upsert). linkedAt is
        // the time the current provider account was linked: set on the first link and when the provider id or login
        // method changes; a refresh of the same link (Case 1c) keeps it and updates the provider name only.
        const sameLink = currentUser.loginMethod === loginMethod && currentUser.providerId === providerId;
        ctx.db.User.id.update(updateWithAudit(ctx, currentUser, {
            username: currentUser.isGuest ? uniqueUsername(ctx, name, currentUser.id) : currentUser.username,
            displayName: currentUser.isGuest ? name : currentUser.displayName,
            isGuest: false,
            loginMethod,
            providerId,
            providerUsername: name,
            linkedAt: sameLink && currentUser.linkedAt !== undefined ? currentUser.linkedAt : ctx.timestamp,
        }, systemUserId));
        ctx.db.UserIdentity.identity.update(updateWithAudit(ctx, userMapping, {
            lastSeenAt: ctx.timestamp,
        }, systemUserId));
        return;
    }

    // No UserIdentity mapping exists for this identity yet (Case 2, cross-device login with a known provider, and
    // Case 3, a fresh identity, alike): the client must call login_as_guest first.
    throw new SenderError('Identity not registered. Call login_as_guest first.');
});

/**
 * Server-only reducer: set a user's role.
 * Called via: npm run stdb:manage-user -- --target <test|prod> set-role <username> <role>
 */
export const server_set_role = spacetimedb.reducer({
    username: t.string(),
    roleTag: t.string(),
}, (ctx, { username, roleTag }) => {
    requireServer(ctx);
    const systemUserId = SYSTEM_USER_ID;

    if (!username || username.length === 0) {
        throw new SenderError('username is required');
    }

    const validRoles = ['Admin', 'Moderator', 'TournamentHost', 'User'];
    if (!validRoles.includes(roleTag)) {
        throw new SenderError(`Invalid role "${roleTag}". Must be one of: ${validRoles.join(', ')}`);
    }

    // Use unique index instead of .iter()
    const targetUser = ctx.db.User.username.find(username);
    if (!targetUser) {
        throw new SenderError(`User "${username}" not found`);
    }
    // S10e (identity audit #9): the server identities' admin rights come from the SYSTEM user's role.
    if (targetUser.username === 'SYSTEM') {
        throw new SenderError('The SYSTEM user cannot be changed.');
    }

    ctx.db.User.id.update(updateWithAudit(ctx, targetUser, {
        role: { tag: roleTag, value: {} } as any,
    }, systemUserId));
    // A163(2) (S11a): demoted below Moderator → match events of tournaments where they hold no bracket permission go to
    // each tournament's organizer.
    if (isRoleAtLeast(targetUser.role, 'Moderator') && !isRoleAtLeast({ tag: roleTag }, 'Moderator')) {
        handOverMatchEventsOfFormerStaff(ctx, targetUser.id, systemUserId);
    }
});

/**
 * Server-only reducer: delete a user by username.
 * Called via: npm run stdb:manage-user -- --target <test|prod> delete <username>
 * Guest users with no history references are hard-deleted; others are soft-deleted.
 */
export const server_delete_user = spacetimedb.reducer({
    username: t.string(),
}, (ctx, { username }) => {
    requireServer(ctx);

    if (!username || username.length === 0) {
        throw new SenderError('username is required');
    }

    // Use unique index instead of .iter()
    const targetUser = ctx.db.User.username.find(username);
    if (!targetUser) {
        throw new SenderError(`User "${username}" not found`);
    }
    // S10e (identity audit #9): deleting SYSTEM would remove every server identity's mapping.
    if (targetUser.username === 'SYSTEM') {
        throw new SenderError('The SYSTEM user cannot be deleted.');
    }

    // S10s fix pass (A124): a server deletion cancels the user's unfinished tournaments (explicit signal).
    performUserDeletion(ctx, targetUser.id, SYSTEM_USER_ID, { serverDeletion: true });
});

/**
 * A109(3): server-only switch of the guest creation breaker (login_as_guest for a new identity), the server-side twin of
 * admin_set_guest_creation, for when no Admin can sign in (while the switch is off a new browser cannot start a session).
 * Re-enabling drops the breaker's window counter. Audit actor: SYSTEM.
 */
export const server_set_guest_creation = spacetimedb.reducer({
    enabled: t.bool(),
}, (ctx, { enabled }) => {
    requireServer(ctx);
    setGuestCreationEnabled(ctx, enabled, SYSTEM_USER_ID);
    console.log(`[ABUSE] Guest creation ${enabled ? 'enabled' : 'disabled'} by a server identity`);
});

/**
 * A109(3): server-only switch of guest lobby creation (A42(1)), the server-side twin of admin_set_guest_lobby_creation.
 * Re-enabling drops the breaker's window counter. Audit actor: SYSTEM.
 */
export const server_set_guest_lobby_creation = spacetimedb.reducer({
    enabled: t.bool(),
}, (ctx, { enabled }) => {
    requireServer(ctx);
    setGuestLobbyCreationEnabled(ctx, enabled, SYSTEM_USER_ID);
    console.log(`[ABUSE] Guest lobby creation ${enabled ? 'enabled' : 'disabled'} by a server identity`);
});

/**
 * Server-only reducer: set MMR rating for a user.
 * Upserts MmrRating row for the given userId + gameMode.
 * Useful for test seeding and future admin tools.
 *
 * Called via server-token connection (test harness). Test databases only.
 */
/**
 * Server-only reducer: set a datetime field on a supported table.
 * General-purpose timestamp manipulation for testing time-dependent behavior
 * (e.g. aging identities past GC TTL, backdating lobby creation).
 *
 * Supported table/field combos:
 *   user_identity / lastSeenAt    — GC TTL testing
 *   user_identity / createdDate   — creation age testing
 *   lobby / createdDate           — lobby GC age testing
 *
 * Called via server-token connection (test harness scripts).
 *
 * Audit-column handling:
 *   - `lastSeenAt` updates use `updateWithAudit(...)` — lastSeenAt is a domain
 *     column (not an audit column), so the helper correctly bumps
 *     `lastModified*` while preserving `createdById`/`createdDate`.
 *   - `createdDate` updates HAND-ROLL the audit fields (spread row, override
 *     createdDate + lastModified*). `auditUpdate` cannot be used here because
 *     it intentionally preserves `existing.createdDate` (audit invariant) —
 *     which is the exact field this reducer needs to overwrite. Using
 *     `auditUpdate` would silently drop the override and the test setup would
 *     be a no-op. Drift risk: if the audit-column set ever grows, the spread
 *     will preserve the new field via `...row`, but a future field with
 *     special semantics (e.g. requiring SYSTEM_USER_ID as actor) would need
 *     a manual update here. WR-07 reviewed 2026-05-06; auditUpdate fix-path
 *     rejected — kept as documented hand-roll. If this pattern accrues a
 *     third site, extract a `forceAuditOverride(ctx, row, patch, userId)`
 *     helper.
 */
export const server_set_datetime = spacetimedb.reducer({
    tableName: t.string(),
    primaryKey: t.string(),
    field: t.string(),
    timestampMicros: t.string(),  // BigInt micros as string
}, (ctx, { tableName, primaryKey, field, timestampMicros }) => {
    requireTestDatabase(ctx);
    requireServer(ctx);

    const ts = new Timestamp(BigInt(timestampMicros));

    if (tableName === 'user_identity') {
        const identity = Identity.fromString(primaryKey);
        const row = ctx.db.UserIdentity.identity.find(identity);
        if (!row) throw new SenderError(`UserIdentity not found for identity ${primaryKey.slice(0, 16)}...`);

        if (field === 'lastSeenAt') {
            ctx.db.UserIdentity.identity.update(
                updateWithAudit(ctx, row, { lastSeenAt: ts }, SYSTEM_USER_ID)
            );
        } else if (field === 'createdDate') {
            // Hand-roll: auditUpdate preserves existing.createdDate (audit invariant).
            // See reducer docstring "Audit-column handling".
            ctx.db.UserIdentity.identity.update({
                ...row,
                createdDate: ts,
                lastModifiedById: SYSTEM_USER_ID,
                lastModifiedDate: ctx.timestamp,
            });
        } else {
            throw new SenderError(`Unsupported field "${field}" for user_identity. Supported: lastSeenAt, createdDate`);
        }
    } else if (tableName === 'lobby') {
        const lobbyId = parseInt(primaryKey, 10);
        if (isNaN(lobbyId)) throw new SenderError(`Invalid lobby ID: ${primaryKey}`);
        const row = ctx.db.Lobby.id.find(lobbyId);
        if (!row) throw new SenderError(`Lobby #${lobbyId} not found`);

        if (field === 'createdDate') {
            // Hand-roll: auditUpdate preserves existing.createdDate (audit invariant).
            // See reducer docstring "Audit-column handling".
            ctx.db.Lobby.id.update({
                ...row,
                createdDate: ts,
                lastModifiedById: SYSTEM_USER_ID,
                lastModifiedDate: ctx.timestamp,
            });
        } else {
            throw new SenderError(`Unsupported field "${field}" for lobby. Supported: createdDate`);
        }
    } else {
        throw new SenderError(`Unsupported table "${tableName}". Supported: user_identity, lobby`);
    }
});

/**
 * Server-only reducer: force a user's isOnline flag.
 * Test utility — maincloud disconnect detection can be delayed 30-60s,
 * making it unreliable in test windows. This lets tests explicitly
 * set a user offline before running GC or other online-sensitive logic.
 */
export const server_set_online = spacetimedb.reducer({
    userId: t.u32(),
    isOnline: t.bool(),
}, (ctx, { userId, isOnline }) => {
    requireTestDatabase(ctx);
    requireServer(ctx);

    const user = ctx.db.User.id.find(userId);
    if (!user) throw new SenderError(`User #${userId} not found`);

    // A48: presence is per identity in UserPresence; force every identity row of the user. Kept as the
    // test-side way to correct a stale row (see the staleness rule on the UserPresence table).
    for (const mapping of [...ctx.db.UserIdentity.user_id.filter(userId)]) {
        const presence = ctx.db.UserPresence.identity.find(mapping.identity);
        if (presence) {
            ctx.db.UserPresence.identity.update(updateWithAudit(ctx, presence, { isOnline, lastSeenAt: ctx.timestamp }, SYSTEM_USER_ID));
        } else {
            ctx.db.UserPresence.insert(insertWithAudit(ctx, {
                identity: mapping.identity,
                userId,
                isOnline,
                lastLoginAt: ctx.timestamp,
                lastSeenAt: ctx.timestamp,
            }, SYSTEM_USER_ID));
        }
    }
});

export const server_set_mmr = spacetimedb.reducer({
    userId: t.u32(),
    gameMode: t.string(),
    rating: t.u32(),
}, (ctx, { userId, gameMode, rating }) => {
    requireTestDatabase(ctx);
    requireServer(ctx);
    const systemUserId = SYSTEM_USER_ID;

    const user = ctx.db.User.id.find(userId);
    if (!user) {
        throw new SenderError(`User #${userId} not found`);
    }

    const validModes = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'];
    if (!validModes.includes(gameMode)) {
        throw new SenderError(`Invalid gameMode "${gameMode}". Must be one of: ${validModes.join(', ')}`);
    }

    // S11a (triage L5): the row of the active season (0 when none is active), the one the views and finalization read
    // (by_user_mode_season); a rating set while a season is active lands in that season.
    const seasonId = [...ctx.db.Season.is_active.filter(true)][0]?.id ?? 0;
    const existing = [...ctx.db.MmrRating.by_user_mode_season.filter([userId, { tag: gameMode } as any, seasonId])][0];

    if (existing) {
        // Delete + re-insert (composite PK) — P4 delete+insert-carry:
        // keep auditUpdate primitive because caller builds the full row here.
        ctx.db.MmrRating.delete(existing);
        ctx.db.MmrRating.insert({
            ...existing,
            rating,
            ...auditUpdate(ctx, existing, systemUserId),
        } as any);
    } else {
        ctx.db.MmrRating.insert(insertWithAudit(ctx, {
            userId,
            gameMode: { tag: gameMode, value: {} } as any,
            rating,
            matchesPlayed: 0,
            globalCompositeRating: undefined,
            seasonId,
        }, systemUserId) as any);
    }
});

/**
 * Server-only reducer: wipe all test state from non-seed tables.
 *
 * Fast alternative to `npm run stdb:publish:test:clear` + `stdb:bootstrap:test`
 * (expected ~100ms vs ~11s) for tests that need a clean slate mid-suite or
 * for suite-level afterAll cleanup.
 *
 * Preserves:
 *   - ServerIdentity
 *   - SYSTEM user (found by username 'SYSTEM'; its row id is autoInc, not 0) and its UserIdentity mappings
 *   - Seed data: HsrCharacter, HsrLightcone, HsrCharacterCost, HsrLightconeCost,
 *     HsrSynergyCost, Archetype, HsrCharacterArchetype
 *   - Starter achievements: Achievement + AchievementCriteria
 *   - Config: EloConfigTable, AccountRatingConfig
 *   - Scheduled jobs: IdentityGcJob, LobbyGcJob (seeded by scripts/stdb/bootstrap.ts)
 *
 * Deletes everything else: users (except SYSTEM), rosters, lobbies, tournaments,
 * match sessions + history, chat, stats, cost sets, calendar events, leaderboards,
 * pending user deletion jobs, bans, gc audit logs.
 *
 * Safety:
 *   - Gated by requireTestDatabase() (STDB_TARGET must be 'test') and requireServer()
 *     (a registered Owner/Delegate identity, e.g. STDB_SERVER_TOKEN from .env.test.local)
 *   - Requires confirmation="NUKE_TEST_DATA" to prevent accidental invocation
 *   - DO NOT CALL IN PRODUCTION
 */
export const server_nuke_test_data = spacetimedb.reducer({
    confirmation: t.string(),
}, (ctx, { confirmation }) => {
    requireTestDatabase(ctx);
    requireServer(ctx);

    if (confirmation !== 'NUKE_TEST_DATA') {
        throw new SenderError(
            'server_nuke_test_data requires confirmation="NUKE_TEST_DATA". ' +
            'This reducer wipes all test state and must never be called in production.'
        );
    }

    let totalDeleted = 0;

    // Whole-table wipes use ctx.db.X.clear() (v2.2.0+, PR #4729).
    // The SYSTEM-preserving blocks below (UserPresence, UserIdentity, User) keep
    // iter+filter+delete because they must skip the SYSTEM row by username='SYSTEM'.

    // Delete order: children before parents is not strictly required
    // (SpacetimeDB does not enforce FKs) but follows the natural dependency
    // graph for readability.

    // ── Match session ephemeral
    ctx.db.MatchSessionStep.clear();
    ctx.db.MatchSession.clear();

    // ── Match result ephemeral
    ctx.db.MatchResultGame.clear();
    ctx.db.MatchResultParticipant.clear();
    ctx.db.MatchResultRecord.clear();

    // ── Match history (permanent under normal ops; wiped on nuke)
    ctx.db.MatchSessionStepHistory.clear();
    ctx.db.MatchSessionHistory.clear();
    ctx.db.MatchParticipantHistory.clear();
    ctx.db.MatchResultGameHistory.clear();
    ctx.db.PlayerRelationship.clear();

    // ── Lobby ephemeral (children first)
    ctx.db.LobbyCursorEvent.clear();
    ctx.db.LobbyCursorStamp.clear(); // S11a (L19): cursor throttle stamps
    ctx.db.RefereeTransferCheck.clear(); // A22a pending grace checks
    ctx.db.LobbyMemberAccount.clear();
    ctx.db.LobbyMember.clear();
    ctx.db.LobbyBan.clear();
    ctx.db.LobbyPassword.clear();
    ctx.db.LobbyPreset.clear();
    seedSystemLobbyPreset(ctx); // A33a: the built-in preset must exist for create_tournament (re-seeded, new id)
    ctx.db.Lobby.clear();

    // ── Bracket (group_phase_record dropped in S3, A23)
    ctx.db.BracketMatch.clear();
    // ── Scoring (A21/A56): live group scores, adjustments and lineups, and the archived lineups
    ctx.db.MatchResultGroupScore.clear();
    ctx.db.MatchResultAdjustment.clear();
    ctx.db.MatchLineup.clear();
    ctx.db.MatchLineupHistory.clear();
    // ── Tournament finalize job (A24(7), S8d): pending ticks of a tournament wiped below. LinkRequest is cleared once
    // its writer lands with the auth function.
    ctx.db.TournamentFinalizeJob.clear();

    // ── Abuse controls (A42, B-7, A57): rate windows, the inline breaker's counters and alerts. AbuseConfig is
    // seeded by init and survives the nuke.
    ctx.db.UserRateState.clear();
    ctx.db.AbuseCounter.clear();
    ctx.db.AdminAlert.clear();

    // ── Tournaments (children first)
    ctx.db.TournamentStandIn.clear();
    ctx.db.TournamentAssistant.clear();
    ctx.db.TournamentTeamRequest.clear();
    ctx.db.TournamentTeamMember.clear();
    ctx.db.TournamentTeam.clear();
    ctx.db.TournamentEnrolled.clear();
    ctx.db.TournamentPlayerAccount.clear();
    ctx.db.Tournament.clear();

    // ── Chat
    ctx.db.ChatMessage.clear();

    // ── Stats, MMR, leaderboard
    ctx.db.MmrHistory.clear();
    ctx.db.MmrRating.clear();
    ctx.db.Leaderboard.clear();
    ctx.db.PlayerCharacterStat.clear();
    ctx.db.PlayerStat.clear();
    ctx.db.GlobalCharacterStat.clear();

    // ── Calendar
    ctx.db.CalendarEventInvite.clear();
    ctx.db.CalendarEvent.clear();
    ctx.db.SavedCalendar.clear();
    ctx.db.AvailabilitySlot.clear();

    // ── Seasons
    ctx.db.Season.clear();

    // ── Cost sets (user-defined; seed data lives in HsrCharacterCost etc.)
    ctx.db.CostSetDraftSynergy.clear();
    ctx.db.CostSetDraftLightcone.clear();
    ctx.db.CostSetDraftCharacter.clear();
    ctx.db.CostSet.clear();

    // ── Rosters
    ctx.db.HsrAccountCharacter.clear();
    ctx.db.HsrAccount.clear();

    // ── User achievements (keep Achievement/AchievementCriteria seed data)
    ctx.db.UserAchievement.clear();

    // ── GC audit
    ctx.db.GcResult.clear();

    // ── Pending user deletion jobs (would fail referencing deleted users anyway)
    ctx.db.UserDeletionJob.clear();

    // ── Bans
    ctx.db.BanRecord.clear();

    // ── Users: preserve the SYSTEM user and its auth chain.
    // SYSTEM_USER_ID is a SENTINEL (0) used for audit columns during bootstrap,
    // NOT the actual User.id of the SYSTEM row — User.id is autoInc, so the real
    // SYSTEM row gets whatever the first autoInc value was (typically 1). We
    // identify it by its unique username 'SYSTEM'.
    const systemUser = ctx.db.User.username.find('SYSTEM');
    const systemUserRowId = systemUser?.id;

    // A77 (S11a): the provider link columns are on User (UserPrivate merged); they go with the User rows below.
    ctx.db.DeletedUser.clear();

    // A48: presence rows of every non-SYSTEM user; the server identities' rows survive with their chain.
    const presences = [...ctx.db.UserPresence.iter()]
        .filter((p: any) => systemUserRowId === undefined || p.userId !== systemUserRowId);
    for (const p of presences) { ctx.db.UserPresence.delete(p); }
    if (presences.length > 0) console.log(`[NUKE] UserPresence: ${presences.length}`);
    totalDeleted += presences.length;

    const userIdents = [...ctx.db.UserIdentity.iter()]
        .filter((ui: any) => systemUserRowId === undefined || ui.userId !== systemUserRowId);
    for (const ui of userIdents) { ctx.db.UserIdentity.delete(ui); }
    if (userIdents.length > 0) console.log(`[NUKE] UserIdentity: ${userIdents.length}`);
    totalDeleted += userIdents.length;

    const users = [...ctx.db.User.iter()]
        .filter((u: any) => systemUserRowId === undefined || u.id !== systemUserRowId);
    for (const u of users) { ctx.db.User.delete(u); }
    if (users.length > 0) console.log(`[NUKE] User: ${users.length}`);
    totalDeleted += users.length;

    console.log(`[NUKE] server_nuke_test_data complete: ${totalDeleted} rows deleted from filtered blocks; the other tables listed above fully cleared via Table.clear()`);
});
