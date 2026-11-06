import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureAdmin } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';

// ─── admin_seed_elo_config ──────────────────────────────────────────────────
// Creates the initial EloConfig row with default values (sentinel PK id=1).
// Permission: Admin only.

export const admin_seed_elo_config = spacetimedb.reducer(
    {},
    (ctx) => {
        const user = ensureAdmin(ctx);

        // Check if row already exists
        const existing = ctx.db.EloConfigTable.id.find(1);
        if (existing) {
            throw new SenderError('ELO config already seeded. Use admin_update_elo_config to modify.');
        }

        ctx.db.EloConfigTable.insert(insertWithAudit(ctx, {
            id: 1,
            kFactorNew: 40,
            kFactorMid: 20,
            kFactorVet: 10,
            newThreshold: 20,
            midThreshold: 100,
            initialRating: 1000,
            sizeBonus: 150,
            spreadDivisor: 2,
            maxAccountBonus: 200,
        }, user.id));

        console.log(`[ELO] EloConfig seeded with defaults by admin #${user.id}`);
    }
);

// ─── admin_update_elo_config ────────────────────────────────────────────────
// Updates EloConfig fields. All config fields are optional — only provided
// fields are changed.
// Permission: Admin only.

export const admin_update_elo_config = spacetimedb.reducer(
    {
        kFactorNew: t.u8().optional(),
        kFactorMid: t.u8().optional(),
        kFactorVet: t.u8().optional(),
        newThreshold: t.u32().optional(),
        midThreshold: t.u32().optional(),
        initialRating: t.u32().optional(),
        sizeBonus: t.u32().optional(),
        spreadDivisor: t.u8().optional(),
        maxAccountBonus: t.u32().optional(),
    },
    (ctx, args) => {
        const user = ensureAdmin(ctx);

        const existing = ctx.db.EloConfigTable.id.find(1);
        if (!existing) {
            throw new SenderError('ELO config not initialized. Call admin_seed_elo_config first.');
        }

        // Build update object from provided (non-undefined) fields
        const changes: Record<string, any> = {};
        const changedFields: string[] = [];

        if (args.kFactorNew !== undefined) { changes.kFactorNew = args.kFactorNew; changedFields.push('kFactorNew'); }
        if (args.kFactorMid !== undefined) { changes.kFactorMid = args.kFactorMid; changedFields.push('kFactorMid'); }
        if (args.kFactorVet !== undefined) { changes.kFactorVet = args.kFactorVet; changedFields.push('kFactorVet'); }
        if (args.newThreshold !== undefined) { changes.newThreshold = args.newThreshold; changedFields.push('newThreshold'); }
        if (args.midThreshold !== undefined) { changes.midThreshold = args.midThreshold; changedFields.push('midThreshold'); }
        if (args.initialRating !== undefined) { changes.initialRating = args.initialRating; changedFields.push('initialRating'); }
        if (args.sizeBonus !== undefined) { changes.sizeBonus = args.sizeBonus; changedFields.push('sizeBonus'); }
        if (args.spreadDivisor !== undefined) { changes.spreadDivisor = args.spreadDivisor; changedFields.push('spreadDivisor'); }
        if (args.maxAccountBonus !== undefined) { changes.maxAccountBonus = args.maxAccountBonus; changedFields.push('maxAccountBonus'); }

        if (changedFields.length === 0) {
            throw new SenderError('No fields provided to update.');
        }

        ctx.db.EloConfigTable.id.update(updateWithAudit(ctx, existing, changes, user.id));

        console.log(`[ELO] EloConfig updated by admin #${user.id}: ${changedFields.join(', ')}`);
    }
);
