import { table, t } from 'spacetimedb/server';

/**
 * Audit log for all GC runs across all GC types.
 * Private (public: false) — dashboard-only visibility (D-10).
 * One row per GC invocation. Table is small (one row per scheduled run).
 */
export const gcResultColumns = {
    id: t.u32().primaryKey().autoInc(),
    gcType: t.string(),           // 'identity' | 'lobby' | future types
    ranAt: t.timestamp(),
    itemsScanned: t.u32(),
    itemsDeleted: t.u32(),
    details: t.string(),          // JSON-encoded breakdown per GC type
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const GcResult = table({
    name: 'gc_result',
    public: false,  // Dashboard-only visibility (D-10)
}, gcResultColumns);
