import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureAdmin } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';

// ─── create_season ──────────────────────────────────────────────────────────
// Creates a new Season row. Defaults to inactive.
// Permission: Admin only.

export const create_season = spacetimedb.reducer(
    {
        name: t.string(),
        startDate: t.timestamp(),
        endDate: t.timestamp().optional(),
    },
    (ctx, { name, startDate, endDate }) => {
        const admin = ensureAdmin(ctx);

        ctx.db.Season.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            name,
            startDate,
            endDate,
            isActive: false,
        }, admin.id));

        console.log(`[SEASON] Season "${name}" created by admin #${admin.id}`);
    }
);

// ─── set_active_season ──────────────────────────────────────────────────────
// Deactivates all currently active seasons, then activates the target season.
// Permission: Admin only.

export const set_active_season = spacetimedb.reducer(
    {
        seasonId: t.u32(),
    },
    (ctx, { seasonId }) => {
        const admin = ensureAdmin(ctx);

        // Find the target season
        const season = ctx.db.Season.id.find(seasonId);
        if (!season) {
            throw new SenderError(`Season #${seasonId} not found.`);
        }

        // Deactivate all currently active seasons
        const activeSeasons = [...ctx.db.Season.is_active.filter(true)];
        for (const row of activeSeasons) {
            ctx.db.Season.id.update(updateWithAudit(ctx, row, {
                isActive: false,
            }, admin.id));
        }

        // Activate the target season
        // Re-read in case it was in the active list and just got deactivated
        const freshSeason = ctx.db.Season.id.find(seasonId)!;
        ctx.db.Season.id.update(updateWithAudit(ctx, freshSeason, {
            isActive: true,
        }, admin.id));

        console.log(`[SEASON] Season #${seasonId} set as active by admin #${admin.id}`);
    }
);
