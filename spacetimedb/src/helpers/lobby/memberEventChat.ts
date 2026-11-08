import { insertWithAudit } from '@module/helpers/admin/auditHelpers';
import { computeAnonymousLabel } from '@module/helpers/identity/anonymousLabels';

// ─── Member-event System chat (D-11; S9a fix, A37) ──────────────────────────────────────────────────────────
// System lines about a member ("… joined the lobby.") name a person, and who may read that name depends on the
// reader (shouldAnonymize). The writer stores the subject in `metadata` as `{ "event": <MemberEvent>,
// "subjectUserId": n }`; view_my_lobby_chat renders the per-event template below with the label the reader may see
// (renderSystemChat in helpers/identity/viewAnonymity.ts). ChatMessage is private (S3), so the stored `content`
// keeps the plain rendered text for the module side; no client reads it directly.

export type MemberEvent = 'joined' | 'left' | 'away' | 'back' | 'kicked' | 'banned';

export const MEMBER_PLACEHOLDER = '{member}';

export const MEMBER_EVENT_TEMPLATES: Record<MemberEvent, string> = {
    joined: '{member} joined the lobby.',
    left: '{member} left the lobby.',
    away: '{member} left the match.',
    back: '{member} is back.',
    kicked: '{member} was kicked from the lobby.',
    banned: '{member} was banned from the lobby.',
};

export function renderMemberEvent(event: MemberEvent, label: string): string {
    return MEMBER_EVENT_TEMPLATES[event].replace(MEMBER_PLACEHOLDER, label);
}

/** The member-event payload of a System message's metadata, or undefined (other System lines, chat metadata). */
export function parseMemberEvent(metadata: string | undefined): { event: MemberEvent; subjectUserId: number } | undefined {
    if (!metadata) return undefined;
    try {
        const parsed = JSON.parse(metadata);
        if (parsed && typeof parsed.subjectUserId === 'number' && parsed.event in MEMBER_EVENT_TEMPLATES) {
            return { event: parsed.event, subjectUserId: parsed.subjectUserId };
        }
    } catch {
        // not a member event
    }
    return undefined;
}

/**
 * The subject's seat label in an anonymous lobby, read while they still hold their LobbyMember row; undefined in a
 * lobby without anonymity or for a non-member (a ban of someone who is not in the lobby).
 */
export function memberEventLabel(ctx: any, lobby: any, subjectUserId: number): string | undefined {
    if (!lobby.isAnonymousPlayers && !lobby.isAnonymousSpectators) return undefined;
    const isMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobby.id, subjectUserId])].length > 0;
    return isMember ? computeAnonymousLabel(ctx, lobby.id, subjectUserId) : undefined;
}

/**
 * Inserts a member-event System message. The subject's seat label is stored in `anonymousLabel` (pass it when the
 * row is already gone: read memberEventLabel before the removal), so a reader for whom the subject is hidden after
 * they left still gets a label (the S9a-A2 rule for chat senders).
 */
export function postMemberEventChat(
    ctx: any, lobby: any, event: MemberEvent, subjectUserId: number, subjectName: string, actorId?: number,
    anonymousLabel: string | undefined = memberEventLabel(ctx, lobby, subjectUserId),
): void {
    ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
        id: 0,
        lobbyId: lobby.id,
        senderUserId: 0,
        senderType: { tag: 'System', value: {} } as any,
        content: renderMemberEvent(event, subjectName),
        metadata: JSON.stringify({ event, subjectUserId }),
        anonymousLabel,
    }, actorId));
}
