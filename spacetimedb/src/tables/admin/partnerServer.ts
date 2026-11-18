import { table, t } from 'spacetimedb/server';

/**
 * S14.4p: the partnered Discord servers shown on the landing page (user ruling 2026-11-17). Public: the landing page
 * subscribes the whole table (at most PARTNER_SERVER_LIMIT rows, helpers/admin/partnerServers.ts). Edited by the
 * admin_*_partner_server reducers (reducers/admin/partnerServers.ts) and their server_* twins
 * (`npm run stdb:manage-partners`).
 *
 * `inviteCode` is the bare Discord invite code (letters, digits, hyphen, 2 to 32 characters), never a URL: the page
 * builds `https://discord.com/invite/<code>` itself and asks Discord for the server's icon with it.
 * `description` is the tile's one-line text (may be empty). `position` orders the tiles (then `id`).
 *
 * NO audit columns: a deliberate exception to the repo's audit-columns policy, by the user's explicit ruling
 * (2026-11-17: "we dont need audit columns there"). Do not add them.
 */
export const partnerServerColumns = {
    id: t.u32().primaryKey().autoInc(),
    name: t.string(),
    inviteCode: t.string().unique(),
    description: t.string(),
    position: t.u32(),
};

export const PartnerServer = table({
    name: 'partner_server',
    public: true,
}, partnerServerColumns);
