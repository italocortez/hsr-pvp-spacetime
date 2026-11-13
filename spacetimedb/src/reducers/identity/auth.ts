import spacetimedb from '@module/schema';
import { SenderError, t } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import {
    CONFIRM_REFUSED_TEXT,
    CONFIRM_TOKEN_INVALID_TEXT,
    NO_PENDING_LINK_TEXT,
    checkClientNonce,
    confirmHashOf,
    ensureStillTheRequestingGuest,
    generateLinkCode,
    isAwaitingConfirm,
    isBase64Url32,
    LINK_CODE_TTL_MICROS,
    LINK_SWEEP_SCAN_LIMIT,
    sameText,
    sweepStaleLinkRequests,
} from '@module/helpers/identity/linkCode';
import { applyProviderLink, planProviderLink } from '@module/helpers/identity/providerLink';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { markPresenceOnline } from '@module/helpers/identity/presenceHelpers';
import { recordGuestCreation } from '@module/helpers/lobby/abuseControls';
import { guestUsernameBase, uniqueUsername } from '@module/helpers/identity/usernames';
import { ensureNotInMaintenance } from '@module/helpers/identity/ensurePermissions';

/**
 * Login as a guest user.
 * - If identity already linked → bump UserIdentity.lastSeenAt (presence was written by client_connected).
 * - Otherwise → create a new User + UserIdentity mapping and the UserPresence row (A48): the fresh guest's
 *   connect ran before the mapping existed, so client_connected could not write it.
 * - A95(2): a new guest user is counted by the guest creation breaker (recordGuestCreation): rejected while
 *   AbuseConfig.guestCreationEnabled is off; the creation that crosses the threshold trips it. A returning guest (the
 *   first branch) is never counted or blocked.
 * - Identity audit #10: a mapping whose User row is gone (orphan) is repointed to the new user instead of inserting a
 *   second row with the same identity (which aborted the call on the primary key).
 * - S10h: the username is "Guest_" + the last 8 hex characters of the identity, made unique (uniqueUsername) so the
 *   insert never aborts on the unique User.username index.
 */
export const login_as_guest = spacetimedb.reducer((ctx) => {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    // A163(3) (S11a): while maintenance mode is on only an Admin acts; no guest is created or refreshed.
    ensureNotInMaintenance(ctx, mapping ? ctx.db.User.id.find(mapping.userId) : undefined);
    if (mapping) {
        const user = ctx.db.User.id.find(mapping.userId);
        if (user) {
            // Already registered — bump lastSeenAt; isOnline / lastLoginAt live on UserPresence (client_connected)
            ctx.db.UserIdentity.identity.update(
                updateWithAudit(ctx, mapping, { lastSeenAt: ctx.timestamp }, user.id),
            );
            return;
        }
    }

    // A95(2): guest creation breaker (throws while the switch is off)
    recordGuestCreation(ctx);

    // A guest username from the identity hex: "Guest_" + its last 8 characters (the first ones are a fixed tag and a
    // short checksum, guestUsernameBase); on a collision with any existing username the first free "_2", "_3", ...
    // variant (uniqueUsername), so a guest login never aborts on the unique User.username index.
    const guestUsername = uniqueUsername(ctx, guestUsernameBase(ctx.sender.toHexString()), -1);

    // Create the User row (id is autoInc, pass 0)
    const newUser = ctx.db.User.insert(insertWithAudit(ctx, {
        id: 0,
        username: guestUsername,
        displayName: guestUsername,
        isGuest: true,
        role: { tag: 'User' },
        avatarCharacterName: 'march7th',
        displayedAchievementId: undefined,
        deletedAt: undefined,
        loginMethod: undefined,      // A77: no provider linked yet
        providerId: undefined,
        providerUsername: undefined,
        linkedAt: undefined,
    }, SYSTEM_USER_ID));

    // Link this identity to the new user (identity audit #10: an orphan mapping is repointed, not duplicated)
    if (mapping) {
        ctx.db.UserIdentity.identity.update(
            updateWithAudit(ctx, mapping, { userId: newUser.id, lastSeenAt: ctx.timestamp }, newUser.id),
        );
    } else {
        ctx.db.UserIdentity.insert(insertWithAudit(ctx, {
            identity: ctx.sender,
            userId: newUser.id,
            lastSeenAt: ctx.timestamp,
        }, newUser.id));
    }

    // A48: this identity's presence row; its connect preceded the mapping
    markPresenceOnline(ctx, ctx.sender, newUser.id);
});

/** M5a: the refusal of request_link_code for an identity with no live user. */
export const NO_ACCOUNT_FOR_LINK_TEXT = 'No account for this identity. Call login_as_guest first.';
/** M5a: the refusal of request_link_code for a user that already has a provider linked (or is not a guest). */
export const ALREADY_LINKED_TEXT = 'This account is already linked.';
/** The text getAuthenticatedUser uses for a soft-deleted (deleted or banned, pending the cascade) account. */
const DELETED_ACCOUNT_TEXT = 'Unauthorized: This account has been deleted.';

/**
 * M5a (A44(3), A46): a connected guest asks for a one-time link code for the Discord sign-in. The caller is ctx.sender;
 * the one argument, clientNonce, is 32 bytes from the browser's crypto.getRandomValues in base64url (43 characters),
 * checked by checkClientNonce, mixed into the code and never stored or logged. The code is read back through view_my_link_request and handed to the auth function, which names it in
 * server_link_by_code; the browser's SpacetimeDB token never leaves the browser.
 * - Refused: maintenance mode for a non-Admin (A163(3), as login_as_guest and the profile reducers); an identity with
 *   no live user; a soft-deleted user (deleted, or banned pending the cascade); a user that is not a guest or already
 *   has a provider linked.
 * - One live request per identity (LinkRequest.identity unique): the caller's previous row is deleted first, so its
 *   code stops working.
 * - One live request per identity also means a pending (presented) row is dropped: starting again abandons it, and its
 *   confirm token stops working (M5a2).
 * - Clean-up: up to LINK_SWEEP_SCAN_LIMIT rows of the table are examined and the expired ones deleted.
 * - The code: generateLinkCode (32 base64url characters from a SHA-256 digest that includes the client nonce); expiresAt = now + 5 minutes.
 * No per-user rate window: like the other identity reducers, the one-row-per-identity rule is the limit.
 */
export const request_link_code = spacetimedb.reducer({
    clientNonce: t.string(),
}, (ctx, { clientNonce }) => {
    checkClientNonce(clientNonce);
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    const user = mapping ? ctx.db.User.id.find(mapping.userId) : undefined;
    ensureNotInMaintenance(ctx, user);
    if (!mapping || !user) throw new SenderError(NO_ACCOUNT_FOR_LINK_TEXT);
    if (user.deletedAt !== undefined) throw new SenderError(DELETED_ACCOUNT_TEXT);
    if (!user.isGuest || user.loginMethod !== undefined) throw new SenderError(ALREADY_LINKED_TEXT);

    const previous = ctx.db.LinkRequest.identity.find(ctx.sender);
    if (previous) ctx.db.LinkRequest.code.delete(previous.code);
    sweepStaleLinkRequests(ctx, LINK_SWEEP_SCAN_LIMIT);

    ctx.db.LinkRequest.insert(insertWithAudit(ctx, {
        code: generateLinkCode(ctx, previous?.code, clientNonce),
        identity: ctx.sender,
        userId: user.id,
        expiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + LINK_CODE_TTL_MICROS),
        usedAt: undefined,
        pendingProvider: undefined,
        pendingProviderId: undefined,
        pendingProviderName: undefined,
        confirmHash: undefined,
    }, user.id));
});

/**
 * M5a2 (the second lock): the requesting browser confirms the Discord account the auth function presented. The caller
 * is ctx.sender and must be the identity that asked for the code: its own row is found by the unique identity index,
 * so a token is useless on any other connection. confirmToken is the one-time token the function gave to the browser
 * that finished Discord (32 bytes, canonical base64url, 43 characters); its hash is confirmHashOf (SHA-256 over the 32
 * decoded bytes, base64url).
 * - Refused, in order: a malformed token (CONFIRM_TOKEN_INVALID_TEXT); maintenance mode for a non-Admin; no live user;
 *   a soft-deleted (deleted or banned) user; no presented row for this identity or its 2-minute window has passed
 *   (NO_PENDING_LINK_TEXT); a token whose hash does not match (CONFIRM_REFUSED_TEXT, no attempt counter: 256 bits);
 *   the account changed since the request (ACCOUNT_CHANGED_TEXT); the merge's own refusal (planProviderLink, run again
 *   because state may have changed: a ban, the A113(4) live-game rule). Every refusal rolls back; the row is unchanged.
 * - Otherwise, in one transaction: the row is deleted and applyProviderLink links this identity (Case 1a upgrade, or
 *   Case 1b re-point when the Discord user already exists).
 */
export const confirm_link = spacetimedb.reducer({
    confirmToken: t.string(),
}, (ctx, { confirmToken }) => {
    if (!isBase64Url32(confirmToken)) throw new SenderError(CONFIRM_TOKEN_INVALID_TEXT);
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    const user = mapping ? ctx.db.User.id.find(mapping.userId) : undefined;
    ensureNotInMaintenance(ctx, user);
    if (!mapping || !user) throw new SenderError(NO_ACCOUNT_FOR_LINK_TEXT);
    if (user.deletedAt !== undefined) throw new SenderError(DELETED_ACCOUNT_TEXT);

    const row = ctx.db.LinkRequest.identity.find(ctx.sender);
    if (!row || !isAwaitingConfirm(row) || row.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) {
        throw new SenderError(NO_PENDING_LINK_TEXT);
    }
    if (!sameText(confirmHashOf(confirmToken), row.confirmHash ?? '')) throw new SenderError(CONFIRM_REFUSED_TEXT);

    ensureStillTheRequestingGuest(ctx, row);
    const plan = planProviderLink(ctx, {
        provider: row.pendingProvider ?? '',
        providerId: row.pendingProviderId ?? '',
        providerName: row.pendingProviderName ?? '',
    }, () => ctx.sender);

    ctx.db.LinkRequest.code.delete(row.code);
    applyProviderLink(ctx, plan);
});
