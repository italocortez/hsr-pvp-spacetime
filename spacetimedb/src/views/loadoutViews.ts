// ─── Loadout views (S14.3s; A190 items 1, 3, 15) ─────────────────────────────
// view_my_loadouts: the caller's own team builder loadouts (private table UserLoadout). Modelled on view_my_roster.
// Sends slot, name, note and the packed team text only: no id, no userId, no audit columns. A guest (who cannot save)
// or an identity with no user gets no rows. Index-only: UserIdentity.identity, User.id, UserLoadout.user_id.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { callerUserId } from '@module/helpers/identity/viewAnonymity';

const MyLoadoutRow = t.row('MyLoadoutRow', {
    slot: t.u8().primaryKey(), // unique per caller, so the client gets onUpdate on a save
    name: t.string(),
    note: t.string(),
    code: t.string(),
});

export const view_my_loadouts = spacetimedb.view(
    { name: 'view_my_loadouts', public: true },
    t.array(MyLoadoutRow),
    (ctx) => {
        const userId = callerUserId(ctx);
        if (userId === undefined) return [];
        const user = ctx.db.User.id.find(userId);
        if (!user || user.isGuest) return [];
        return [...ctx.db.UserLoadout.user_id.filter(userId)].map(({ slot, name, note, code }) => ({ slot, name, note, code }));
    }
);
