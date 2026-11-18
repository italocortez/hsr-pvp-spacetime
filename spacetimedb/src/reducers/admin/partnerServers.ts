import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { ensureAdmin } from '@module/helpers/identity/ensurePermissions';
import { addPartnerServer, removePartnerServer, updatePartnerServer } from '@module/helpers/admin/partnerServers';
import { requireServer } from '@module/reducers/identity/server';

// ─── S14.4p: the partner server list (tables/admin/partnerServer.ts) ──────────────────────────────────────────────
// Admin reducers (the app's future admin page) and their server twins (`npm run stdb:manage-partners`), one rule set
// in helpers/admin/partnerServers.ts. The table has no audit columns (user ruling), so no actor is recorded.
// `invite` takes a bare code or a https://discord.gg/<code> / https://discord.com/invite/<code> link; the code is stored.

const partnerArgs = {
    name: t.string(),
    invite: t.string(),
    description: t.string(),
    position: t.u32(),
};

export const admin_add_partner_server = spacetimedb.reducer(partnerArgs, (ctx, args) => {
    ensureAdmin(ctx);
    addPartnerServer(ctx, args);
});

export const admin_update_partner_server = spacetimedb.reducer({ id: t.u32(), ...partnerArgs }, (ctx, { id, ...args }) => {
    ensureAdmin(ctx);
    updatePartnerServer(ctx, id, args);
});

export const admin_remove_partner_server = spacetimedb.reducer({ id: t.u32() }, (ctx, { id }) => {
    ensureAdmin(ctx);
    removePartnerServer(ctx, id);
});

export const server_add_partner_server = spacetimedb.reducer(partnerArgs, (ctx, args) => {
    requireServer(ctx);
    addPartnerServer(ctx, args);
});

export const server_update_partner_server = spacetimedb.reducer({ id: t.u32(), ...partnerArgs }, (ctx, { id, ...args }) => {
    requireServer(ctx);
    updatePartnerServer(ctx, id, args);
});

export const server_remove_partner_server = spacetimedb.reducer({ id: t.u32() }, (ctx, { id }) => {
    requireServer(ctx);
    removePartnerServer(ctx, id);
});
