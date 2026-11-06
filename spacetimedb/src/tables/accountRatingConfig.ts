import { table, t } from 'spacetimedb/server';

export const accountRatingConfigColumns = {
    id: t.u32().primaryKey(),       // Sentinel PK, always 1
    verticalWeight: t.f64(),        // Default 0.4
    horizontalWeight: t.f64(),      // Default 0.6
    compression: t.f64(),           // Default 0.2
    roleExponentDps: t.f64(),       // Default 2.0
    roleExponentSupport: t.f64(),   // Default 1.3
    roleExponentSustain: t.f64(),   // Default 1.0
    archetypeThreshold: t.f64(),    // Default 3.0
    scale: t.f64(),                 // Default 1000.0
    maxPossible: t.f64(),           // Auto-computed, default 0.0
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const AccountRatingConfig = table({
    name: 'account_rating_config',
    public: true,
}, accountRatingConfigColumns);
