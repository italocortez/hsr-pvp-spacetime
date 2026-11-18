import { SenderError } from 'spacetimedb/server';

/*
 * S14.4p: the rules of the partner server list (tables/admin/partnerServer.ts), shared by the admin_* and server_*
 * reducers (reducers/admin/partnerServers.ts). The texts are the contract (docs/admin/architecture.md).
 */

/** At most this many rows: the landing page subscribes the whole table. */
export const PARTNER_SERVER_LIMIT = 12;
export const PARTNER_NAME_MAX = 50;
export const PARTNER_DESCRIPTION_MAX = 80;

export const PARTNER_NAME_TEXT = `Partner server name must be 1 to ${PARTNER_NAME_MAX} characters.`;
export const PARTNER_DESCRIPTION_TEXT = `Partner server description must be at most ${PARTNER_DESCRIPTION_MAX} characters.`;
export const PARTNER_INVITE_TEXT =
    'Invite must be a Discord invite code (letters, digits and hyphens, 2 to 32 characters) or a link of the form https://discord.gg/<code> or https://discord.com/invite/<code>.';
export const PARTNER_DUPLICATE_TEXT = 'A partner server with this invite is already listed.';
export const PARTNER_LIMIT_TEXT = `At most ${PARTNER_SERVER_LIMIT} partner servers can be listed.`;
export const PARTNER_NOT_FOUND_TEXT = 'Partner server not found.';

const CODE = /^[A-Za-z0-9-]{2,32}$/;
const LINK = /^https:\/\/(?:discord\.gg\/|discord\.com\/invite\/)([^/?#\s]*)$/;

/**
 * The bare invite code of `invite`: a code as is, or the code of a `https://discord.gg/<code>` or
 * `https://discord.com/invite/<code>` link (surrounding spaces trimmed). Anything else throws, so no other address
 * can ever be stored.
 */
export function normalizeInviteCode(invite: string): string {
    const trimmed = invite.trim();
    const link = LINK.exec(trimmed);
    const code = link ? link[1]! : trimmed;
    if (!CODE.test(code)) throw new SenderError(PARTNER_INVITE_TEXT);
    return code;
}

export type PartnerServerInput = { name: string; invite: string; description: string; position: number };

/** The checked row content: name and description trimmed, the invite reduced to its code. */
function checkedRow(input: PartnerServerInput) {
    const name = input.name.trim();
    if (name.length < 1 || name.length > PARTNER_NAME_MAX) throw new SenderError(PARTNER_NAME_TEXT);
    const description = input.description.trim();
    if (description.length > PARTNER_DESCRIPTION_MAX) throw new SenderError(PARTNER_DESCRIPTION_TEXT);
    const inviteCode = normalizeInviteCode(input.invite);
    return { name, inviteCode, description, position: input.position };
}

export function addPartnerServer(ctx: any, input: PartnerServerInput) {
    const row = checkedRow(input);
    if (ctx.db.PartnerServer.inviteCode.find(row.inviteCode)) throw new SenderError(PARTNER_DUPLICATE_TEXT);
    if (ctx.db.PartnerServer.count() >= BigInt(PARTNER_SERVER_LIMIT)) throw new SenderError(PARTNER_LIMIT_TEXT);
    return ctx.db.PartnerServer.insert({ id: 0, ...row });
}

export function updatePartnerServer(ctx: any, id: number, input: PartnerServerInput) {
    const existing = ctx.db.PartnerServer.id.find(id);
    if (!existing) throw new SenderError(PARTNER_NOT_FOUND_TEXT);
    const row = checkedRow(input);
    const holder = ctx.db.PartnerServer.inviteCode.find(row.inviteCode);
    if (holder && holder.id !== id) throw new SenderError(PARTNER_DUPLICATE_TEXT);
    return ctx.db.PartnerServer.id.update({ ...existing, ...row });
}

export function removePartnerServer(ctx: any, id: number) {
    if (!ctx.db.PartnerServer.id.find(id)) throw new SenderError(PARTNER_NOT_FOUND_TEXT);
    ctx.db.PartnerServer.id.delete(id);
}
