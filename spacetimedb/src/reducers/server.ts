import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { Identity, Timestamp } from 'spacetimedb';
import { auditUpdate, SYSTEM_USER_ID } from '../helpers/auditColumns';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { performUserDeletion } from '../helpers/userDeletionHelper';
import { rejectIfBanned, DISCORD_BAN_TYPE } from '../helpers/banHelper';

/**
 * Helper: verify the caller is the registered server identity.
 */
function requireServer(ctx: any) {
    const server = ctx.db.ServerIdentity.identity.find(ctx.sender);
    if (!server) {
        throw new SenderError('Forbidden: caller is not the registered server identity.');
    }
    return server;
}

/**
 * Bootstrap reducer: register the calling identity as the trusted server.
 * Only works when no server identity exists yet (first-come-first-served).
 * Also creates a SYSTEM user for audit trail purposes.
 *
 * Run via: npx tsx scripts/register-server.ts
 */
export const register_server = spacetimedb.reducer((ctx) => {
    // iter() required: checking table emptiness — no count/isEmpty API exists, and PK is identity (unknown value)
    const existing = [...ctx.db.ServerIdentity.iter()];
    if (existing.length > 0) {
        throw new SenderError('Server identity already registered. To re-register, clear the database first.');
    }

    // Register the server identity (no audit columns on this table)
    ctx.db.ServerIdentity.insert({
        identity: ctx.sender,
        registeredAt: ctx.timestamp,
    });

    // Create the SYSTEM user — the first user in the database.
    const systemUser = ctx.db.User.insert(insertWithAudit(ctx, {
        id: 0,
        username: 'SYSTEM',
        displayName: 'SYSTEM',
        isGuest: false,
        isOnline: false,
        lastLoginAt: ctx.timestamp,
        role: { tag: 'Admin' },
        hasDiscordLinked: false,
        avatarCharacterName: 'march7th',
        displayedAchievementId: undefined,
        deletedAt: undefined,
    }, SYSTEM_USER_ID));

    // Link server identity to SYSTEM user so server-token connections
    // pass getAuthenticatedUser/ensureAdmin checks (e.g. seed-data.ts)
    ctx.db.UserIdentity.insert(insertWithAudit(ctx, {
        identity: ctx.sender,
        userId: systemUser.id,
        lastSeenAt: ctx.timestamp,
    }, SYSTEM_USER_ID));
});

/**
 * Server-only reducer: link an OAuth provider to a user identity.
 * Replaces server_link_discord with a unified, extensible approach.
 * Currently supports: discord (only provider in scope).
 *
 * Called by the Next.js API route after verifying the OAuth session.
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

    // 2. Validate inputs
    if (!providerId || providerId.length === 0) {
        throw new SenderError('providerId is required');
    }
    if (!providerName || providerName.length === 0) {
        throw new SenderError('providerName is required');
    }
    if (!callerIdentityHex || callerIdentityHex.length === 0) {
        throw new SenderError('callerIdentityHex is required');
    }

    // 3. Validate provider and map to BanType
    const validProviders = ['discord'];
    if (!validProviders.includes(provider)) {
        throw new SenderError(`Invalid provider "${provider}". Must be one of: ${validProviders.join(', ')}`);
    }
    const banType = DISCORD_BAN_TYPE;  // Only discord for now

    // 4. Ban check (D-08 enforcement point 1: link-time)
    rejectIfBanned(ctx, banType, providerId);

    // 5. Resolve the end-user's identity -> UserIdentity -> User
    let callerIdentity: any;
    try {
        callerIdentity = Identity.fromString(callerIdentityHex);
    } catch {
        throw new SenderError('callerIdentityHex is not a valid identity');
    }
    const userMapping: any = ctx.db.UserIdentity.identity.find(callerIdentity);

    let currentUser: any = null;
    if (userMapping) {
        currentUser = ctx.db.User.id.find(userMapping.userId);
    }

    // 6. Check if a UserPrivate row with this providerId already exists
    const existingByProvider = [...ctx.db.UserPrivate.user_private_discord_id.filter(providerId)];
    const providerOwnerPrivate = existingByProvider.length > 0 ? existingByProvider[0] : null;
    const providerOwner = providerOwnerPrivate ? ctx.db.User.id.find(providerOwnerPrivate.userId) : null;

    if (currentUser) {
        if (providerOwner && providerOwner.id !== currentUser.id) {
            // Case 1b: Identity currently points to a different user (guest),
            // but the provider account belongs to an existing verified user.
            // Re-point identity to the provider owner, clean up orphaned guest.
            const oldGuestId = currentUser.id;
            const wasGuest = currentUser.isGuest;

            ctx.db.UserIdentity.identity.update(updateWithAudit(ctx, userMapping, {
                userId: providerOwner.id,
                lastSeenAt: ctx.timestamp,
            }, systemUserId));

            ctx.db.User.id.update(updateWithAudit(ctx, providerOwner, {
                lastLoginAt: ctx.timestamp,
            }, systemUserId));

            if (wasGuest) {
                const remainingLinks = [...ctx.db.UserIdentity.user_id.filter(oldGuestId)];
                if (remainingLinks.length === 0) {
                    performUserDeletion(ctx, oldGuestId, systemUserId);
                }
            }
            return;
        }

        // Case 1a / 1c: Upgrade guest or refresh provider info
        // Update User table
        ctx.db.User.id.update(updateWithAudit(ctx, currentUser, {
            username: currentUser.isGuest ? providerName : currentUser.username,
            displayName: currentUser.isGuest ? providerName : currentUser.displayName,
            isGuest: false,
            hasDiscordLinked: true,
            lastLoginAt: ctx.timestamp,
        }, systemUserId));
        ctx.db.UserIdentity.identity.update(updateWithAudit(ctx, userMapping, {
            lastSeenAt: ctx.timestamp,
        }, systemUserId));

        // Upsert UserPrivate row
        const existingPrivate = ctx.db.UserPrivate.userId.find(currentUser.id);
        if (existingPrivate) {
            ctx.db.UserPrivate.userId.update(updateWithAudit(ctx, existingPrivate, {
                discordId: providerId,
                discordUsername: providerName,
            }, systemUserId));
        } else {
            ctx.db.UserPrivate.insert(insertWithAudit(ctx, {
                userId: currentUser.id,
                discordId: providerId,
                discordUsername: providerName,
                email: undefined,
            }, systemUserId));
        }
        return;
    }

    // No UserIdentity mapping exists for this identity yet
    if (providerOwner) {
        // Case 2: Cross-device login -- client must call login_as_guest first.
        throw new SenderError('Identity not registered. Call login_as_guest first.');
    }

    // Case 3: Same problem -- can't create UserIdentity without the Identity object.
    throw new SenderError('Identity not registered. Call login_as_guest first.');
});

/**
 * Server-only reducer: set a user's role.
 * Called via: npx tsx scripts/manage-user.ts set-role <username> <role>
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

    ctx.db.User.id.update(updateWithAudit(ctx, targetUser, {
        role: { tag: roleTag, value: {} } as any,
    }, systemUserId));
});

/**
 * Server-only reducer: delete a user by username.
 * Called via: npx tsx scripts/manage-user.ts delete <username>
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

    performUserDeletion(ctx, targetUser.id, SYSTEM_USER_ID);
});

/**
 * Server-only reducer: set MMR rating for a user.
 * Upserts MmrRating row for the given userId + gameMode.
 * Useful for test seeding and future admin tools.
 *
 * Called via server-token connection (e.g. test harness or manage-user.ts).
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
    requireServer(ctx);

    const user = ctx.db.User.id.find(userId);
    if (!user) throw new SenderError(`User #${userId} not found`);

    ctx.db.User.id.update(updateWithAudit(ctx, user, {
        isOnline,
    }, SYSTEM_USER_ID));
});

export const server_set_mmr = spacetimedb.reducer({
    userId: t.u32(),
    gameMode: t.string(),
    rating: t.u32(),
}, (ctx, { userId, gameMode, rating }) => {
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

    // Filter by userId, then find matching gameMode in memory
    const existing = [...ctx.db.MmrRating.user_id.filter(userId)]
        .find((r: any) => r.gameMode.tag === gameMode);

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
            seasonId: undefined,
        }, systemUserId) as any);
    }
});

/**
 * Server-only reducer: wipe all test state from non-seed tables.
 *
 * Fast alternative to `spacetime publish --clear-database` + post-publish.ts
 * (expected ~100ms vs ~11s) for tests that need a clean slate mid-suite or
 * for suite-level afterAll cleanup.
 *
 * Preserves:
 *   - ServerIdentity
 *   - SYSTEM user (id=0) and its UserIdentity mapping
 *   - Seed data: HsrCharacter, HsrLightcone, HsrCharacterCost, HsrLightconeCost,
 *     HsrSynergyCost, Archetype, HsrCharacterArchetype
 *   - Starter achievements: Achievement + AchievementCriteria
 *   - Config: EloConfigTable, AccountRatingConfig
 *   - Scheduled jobs: IdentityGcJob, LobbyGcJob (seeded by post-publish.ts)
 *
 * Deletes everything else: users (except SYSTEM), rosters, lobbies, tournaments,
 * match sessions + history, chat, stats, cost sets, calendar events, leaderboards,
 * pending user deletion jobs, bans, gc audit logs.
 *
 * Safety:
 *   - Gated by requireServer() — only callable with SPACETIMEDB_SERVER_TOKEN
 *   - Requires confirmation="NUKE_TEST_DATA" to prevent accidental invocation
 *   - DO NOT CALL IN PRODUCTION
 */
export const server_nuke_test_data = spacetimedb.reducer({
    confirmation: t.string(),
}, (ctx, { confirmation }) => {
    requireServer(ctx);

    if (confirmation !== 'NUKE_TEST_DATA') {
        throw new SenderError(
            'server_nuke_test_data requires confirmation="NUKE_TEST_DATA". ' +
            'This reducer wipes all test state and must never be called in production.'
        );
    }

    let totalDeleted = 0;

    // Whole-table wipes use ctx.db.X.clear() (v2.2.0+, PR #4729).
    // The 3 SYSTEM-preserving blocks below (UserPrivate, UserIdentity, User) keep
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
    ctx.db.LobbyMemberAccount.clear();
    ctx.db.LobbyMember.clear();
    ctx.db.LobbyBan.clear();
    ctx.db.LobbyPassword.clear();
    ctx.db.LobbyPreset.clear();
    ctx.db.Lobby.clear();

    // ── Bracket + group phase
    ctx.db.BracketMatch.clear();
    ctx.db.GroupPhaseRecord.clear();

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

    const userPrivates = [...ctx.db.UserPrivate.iter()]
        .filter((up: any) => systemUserRowId === undefined || up.userId !== systemUserRowId);
    for (const up of userPrivates) { ctx.db.UserPrivate.delete(up); }
    if (userPrivates.length > 0) console.log(`[NUKE] UserPrivate: ${userPrivates.length}`);
    totalDeleted += userPrivates.length;

    ctx.db.DeletedUser.clear();

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

    console.log(`[NUKE] server_nuke_test_data complete: ${totalDeleted} rows deleted from filtered blocks; 42 tables fully cleared via Table.clear()`);
});
