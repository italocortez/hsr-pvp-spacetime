import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { ensurePresentIfMember, ensurePresentMember } from '@module/helpers/lobby/lobbyHelpers';
import { computeAnonymousLabel } from '@module/helpers/identity/anonymousLabels';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { consumeChatAllowance } from '@module/helpers/lobby/abuseControls';
import { lobbyChatOldestFirst, trimChatForInsert } from '@module/helpers/lobby/chatWindow';

/** S10e (lobby audit #5): the cap on a message's metadata JSON (content: 500, D-12). */
const CHAT_METADATA_MAX_LENGTH = 200;

// ---------------------------------------------------------------------------
// send_chat_message
// Per D-10: all lobby members can send. Per D-12: 500 char limit.
// Per D-13: rolling window of 50 — oldest deleted when limit reached.
// Per D-14: metadata JSON validated against { type, replyToMessageId? } schema.
// Per D-18 / A97 (S10h): anonymousLabel = the sender's seat label (seat kind + joinSeq), stored on every message.
// ---------------------------------------------------------------------------
export const send_chat_message = spacetimedb.reducer({
    lobbyId: t.u32(),
    content: t.string(),
    metadata: t.string(),
}, (ctx, { lobbyId, content, metadata }) => {
    const user = getAuthenticatedUser(ctx);

    // D-10: All lobby members can send — ensurePresentMember throws if not a member; A98: or if away / abandoned
    ensurePresentMember(ctx, lobbyId, user.id);

    // D-12: Content validation
    if (content.length === 0) throw new SenderError('Message cannot be empty.');
    if (content.length > 500) throw new SenderError('Message exceeds 500 character limit.');

    // D-14: Metadata validation — default empty to {"type":"text"}, validate JSON schema
    // S10e (lobby audit #5): metadata is capped like the content; the documented shape
    // ({"type":"reply","replyToMessageId":4294967295}) is well under the cap.
    if (metadata.length > CHAT_METADATA_MAX_LENGTH) {
        throw new SenderError(`Message metadata exceeds ${CHAT_METADATA_MAX_LENGTH} character limit.`);
    }
    let resolvedMetadata = metadata;
    if (!metadata || metadata.length === 0) {
        resolvedMetadata = '{"type":"text"}';
    } else {
        try {
            const parsed = JSON.parse(metadata);
            if (!parsed.type || !['text', 'reply', 'emoji_only'].includes(parsed.type)) {
                throw new Error();
            }
        } catch {
            throw new SenderError(
                'Invalid metadata JSON. Expected: { type: "text" | "reply" | "emoji_only", replyToMessageId?: number }'
            );
        }
    }

    // D-13: Rolling window enforcement — keep at most 49 messages before inserting (oldest first by createdDate)
    const messages = lobbyChatOldestFirst(ctx, lobbyId);

    // B-4 (D-B5): minimum interval since the sender's newest message in this lobby + the fixed one-minute
    // window in UserRateState, both read from AbuseConfig. Rejection rolls the whole call back.
    let lastOwnMicros: bigint | undefined;
    for (const m of messages) {
        if (m.senderUserId === user.id) lastOwnMicros = m.createdDate.microsSinceUnixEpoch;
    }
    consumeChatAllowance(ctx, user.id, lastOwnMicros);

    trimChatForInsert(ctx, lobbyId, messages);

    // D-18 / A97: the sender's seat label ("Blue Player #3"), stored on every message, not only when the lobby is
    // anonymous at send time (lobby audit #25): a lobby made anonymous later in Waiting still has a label for a sender
    // who has left. ChatMessage is private; view_my_lobby_chat emits the label only for an anonymized sender.
    const lobby = ctx.db.Lobby.id.find(lobbyId);
    const anonymousLabel = computeAnonymousLabel(ctx, lobbyId, user.id);

    // Insert the message
    ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
        id: 0,
        lobbyId,
        senderUserId: user.id,
        senderType: { tag: 'Player', value: {} } as any,
        content,
        metadata: resolvedMetadata,
        anonymousLabel,
    }, user.id));

    // Update lobby lastActivityAt
    if (lobby) {
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));
    }
});

// ---------------------------------------------------------------------------
// delete_chat_message
// Per D-26: host, referee, admin, moderator can delete individual messages.
// ---------------------------------------------------------------------------
export const delete_chat_message = spacetimedb.reducer({
    messageId: t.u32(),
}, (ctx, { messageId }) => {
    const user = getAuthenticatedUser(ctx);

    const msg = ctx.db.ChatMessage.id.find(messageId);
    if (!msg) throw new SenderError('Message not found.');

    const lobby = ctx.db.Lobby.id.find(msg.lobbyId);
    if (!lobby) throw new SenderError('Lobby not found.');

    // Permission check: host, referee, admin, or moderator
    const isHost = lobby.hostUserId === user.id;
    const isAdminOrMod = isRoleAtLeast(user.role, 'Moderator');

    // Check if caller is a referee in this lobby
    // A98: the host and referee powers come from the membership: a caller who holds a row must be present.
    const callerMember = isAdminOrMod
        ? [...ctx.db.LobbyMember.by_lobby_and_user.filter([msg.lobbyId, user.id])][0]
        : ensurePresentIfMember(ctx, msg.lobbyId, user.id);
    const isReferee = callerMember?.isReferee === true;

    if (!isHost && !isAdminOrMod && !isReferee) {
        throw new SenderError('Only the host, referees, moderators, or admins can delete chat messages.');
    }

    ctx.db.ChatMessage.id.delete(messageId);
});
