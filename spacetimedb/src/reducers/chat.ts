import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { ensureLobbyMember } from '../helpers/lobbyHelpers';
import { computeAnonymousLabel } from '../helpers/anonymousLabels';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';

// ---------------------------------------------------------------------------
// send_chat_message
// Per D-10: all lobby members can send. Per D-12: 500 char limit.
// Per D-13: rolling window of 50 — oldest deleted when limit reached.
// Per D-14: metadata JSON validated against { type, replyToMessageId? } schema.
// Per D-18: anonymousLabel populated when lobby has anonymous mode.
// ---------------------------------------------------------------------------
export const send_chat_message = spacetimedb.reducer({
    lobbyId: t.u32(),
    content: t.string(),
    metadata: t.string(),
}, (ctx, { lobbyId, content, metadata }) => {
    const user = getAuthenticatedUser(ctx);

    // D-10: All lobby members can send — ensureLobbyMember throws if not a member
    ensureLobbyMember(ctx, lobbyId, user.id);

    // D-12: Content validation
    if (content.length === 0) throw new SenderError('Message cannot be empty.');
    if (content.length > 500) throw new SenderError('Message exceeds 500 character limit.');

    // D-14: Metadata validation — default empty to {"type":"text"}, validate JSON schema
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

    // D-13: Rolling window enforcement — keep at most 49 messages before inserting
    const messages = [...ctx.db.ChatMessage.lobby_id.filter(lobbyId)].sort(
        (a: any, b: any) =>
            Number(a.createdDate.microsSinceUnixEpoch - b.createdDate.microsSinceUnixEpoch)
    );
    if (messages.length >= 50) {
        ctx.db.ChatMessage.id.delete(messages[0].id);
    }

    // D-18: Anonymous enforcement — populate anonymousLabel when lobby has anonymous mode
    const lobby = ctx.db.Lobby.id.find(lobbyId);
    const anonymousLabel =
        lobby && (lobby.isAnonymousPlayers || lobby.isAnonymousSpectators)
            ? computeAnonymousLabel(ctx, lobbyId, user.id)
            : undefined;

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
    const callerMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([msg.lobbyId, user.id])][0];
    const isReferee = callerMember?.isReferee === true;

    if (!isHost && !isAdminOrMod && !isReferee) {
        throw new SenderError('Only the host, referees, moderators, or admins can delete chat messages.');
    }

    ctx.db.ChatMessage.id.delete(messageId);
});
