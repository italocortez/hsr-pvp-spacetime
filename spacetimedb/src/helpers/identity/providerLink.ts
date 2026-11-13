import { SenderError } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { performUserDeletion } from '@module/helpers/identity/userDeletionHelper';
import { uniqueUsername, USERNAME_MAX_LENGTH } from '@module/helpers/identity/usernames';
import { moveTournamentTiesToUser } from '@module/helpers/tournament/entryTransfer';
import { rejectIfBanned, DISCORD_LOGIN_METHOD } from '@module/helpers/lobby/banHelper';
import { LIVE_STAGES, slotIsCoach, slotIsSpectator } from '@module/helpers/lobby/lobbyHelpers';

// The guest -> verified merge of a provider link, shared by server_link_provider (identity hex argument) and
// server_link_by_code (M5a: the identity comes from a LinkRequest row). Moved out of reducers/identity/server.ts
// unchanged. It runs in two steps so a caller can catch a refusal without leaving a half-written merge behind:
//   planProviderLink   every check; throws a SenderError and writes nothing;
//   applyProviderLink  every write; throws no SenderError of its own.

/** A113(4) (S10m): the refusal of a sign-in to an existing account while the guest plays a live game. */
export const FINISH_GAME_BEFORE_SIGN_IN_TEXT = 'Finish your current game before signing in to an existing account.';

/** The terminal refusal of an identity with no UserIdentity mapping (Cases 2 and 3). */
export const IDENTITY_NOT_REGISTERED_TEXT = 'Identity not registered. Call login_as_guest first.';

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

/** C0 controls, DEL and C1 controls. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** The first `max` UTF-16 units of `s`, one fewer when the cut would leave a lone high surrogate. */
export function capOnCodePoint(s: string, max: number): string {
    if (s.length <= max) return s;
    const code = s.charCodeAt(max - 1);
    return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

export interface ProviderLinkInput {
    provider: string;       // 'discord' -- extensible for future providers
    providerId: string;
    providerName: string;
}

/** What applyProviderLink writes; built only by planProviderLink. */
export type ProviderLinkPlan =
    | { kind: 'repoint'; callerIdentity: Identity; userMapping: any; currentUser: any; providerOwner: any }
    | { kind: 'upgrade'; userMapping: any; currentUser: any; loginMethod: string; providerId: string; name: string };

/**
 * Every check of the merge, in the order server_link_provider has always run them. Writes nothing.
 * `resolveIdentity` is called after the ban check (where server_link_provider parsed its identity hex argument).
 */
export function planProviderLink(ctx: any, input: ProviderLinkInput, resolveIdentity: () => Identity): ProviderLinkPlan {
    const { provider, providerId, providerName } = input;

    // Validate inputs. S10e (identity audit #3): the provider name is trimmed and capped like a username
    // (USERNAME_MAX_LENGTH, update_username / update_display_name). M5a review: C0 / C1 control characters (and DEL) are
    // stripped first, and the cap never splits a surrogate pair.
    if (!providerId || providerId.length === 0) {
        throw new SenderError('providerId is required');
    }
    const name = capOnCodePoint((providerName ?? '').replace(CONTROL_CHARS, '').trim(), USERNAME_MAX_LENGTH);
    if (name.length === 0) {
        throw new SenderError('providerName is required');
    }

    // Validate provider (A46: the token's login_method; Discord-only policy at launch)
    const validProviders = [DISCORD_LOGIN_METHOD];
    if (!validProviders.includes(provider)) {
        throw new SenderError(`Invalid provider "${provider}". Must be one of: ${validProviders.join(', ')}`);
    }
    const loginMethod = provider;

    // Ban check (D-08 enforcement point 1: link-time)
    rejectIfBanned(ctx, loginMethod, providerId);

    // Resolve the end-user's identity -> UserIdentity -> User
    const callerIdentity = resolveIdentity();
    const userMapping: any = ctx.db.UserIdentity.identity.find(callerIdentity);

    let currentUser: any = null;
    if (userMapping) {
        currentUser = ctx.db.User.id.find(userMapping.userId);
    }

    // Check if a user already holds this provider identity (A77: the provider columns are on User)
    // Still open (not done in M5a): switch to the composite by_method_and_provider index, filter([loginMethod, providerId]),
    // once the multi-column filter is re-verified on this SDK (banHelper notes the same for BanRecord).
    const existingByProvider = [...ctx.db.User.provider_id.filter(providerId)]
        .filter((u: any) => u.loginMethod === loginMethod);
    const providerOwner = existingByProvider.length > 0 ? existingByProvider[0] : null;

    if (currentUser) {
        if (providerOwner && providerOwner.id !== currentUser.id) {
            // A113(4) (S10m): the guest is deleted by the re-point when this identity is its only link. On that path,
            // refuse before any change while the guest holds a player seat (not coach, not spectator, not abandoned) in
            // a lobby that is Drafting, Equipping or Scoring: its game would lose a player.
            if (currentUser.isGuest && [...ctx.db.UserIdentity.user_id.filter(currentUser.id)].length <= 1 && isSeatedInLiveGame(ctx, currentUser.id)) {
                throw new SenderError(FINISH_GAME_BEFORE_SIGN_IN_TEXT);
            }
            return { kind: 'repoint', callerIdentity, userMapping, currentUser, providerOwner };
        }
        return { kind: 'upgrade', userMapping, currentUser, loginMethod, providerId, name };
    }

    // No UserIdentity mapping exists for this identity yet (Case 2, cross-device login with a known provider, and
    // Case 3, a fresh identity, alike): the client must call login_as_guest first.
    throw new SenderError(IDENTITY_NOT_REGISTERED_TEXT);
}

/** Every write of the merge for a plan from planProviderLink. Audit actor: SYSTEM. */
export function applyProviderLink(ctx: any, plan: ProviderLinkPlan): void {
    const systemUserId = SYSTEM_USER_ID;

    if (plan.kind === 'repoint') {
        // Case 1b: Identity currently points to a different user (guest),
        // but the provider account belongs to an existing verified user.
        // Re-point identity to the provider owner, clean up orphaned guest.
        const { callerIdentity, userMapping, currentUser, providerOwner } = plan;
        const oldGuestId = currentUser.id;
        const wasGuest = currentUser.isGuest;

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
    const { userMapping, currentUser, loginMethod, providerId, name } = plan;
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
}
