import { table, t } from 'spacetimedb/server';

export const archetypeColumns = {
    id: t.u32().primaryKey().autoInc(),
    name: t.string().unique(),
    description: t.string(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const Archetype = table({
    name: 'archetype',
    public: true,
}, archetypeColumns);
