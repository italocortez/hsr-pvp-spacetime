import { table, t } from 'spacetimedb/server';

export const hsrCharacterArchetypeColumns = {
    characterName: t.string(),
    archetypeId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const HsrCharacterArchetype = table({
    name: 'hsr_character_archetype',
    public: true,
    primaryKey: ['characterName', 'archetypeId'],
    indexes: [
        { accessor: 'character_name', algorithm: 'btree', columns: ['characterName'] },
        { accessor: 'archetype_id', algorithm: 'btree', columns: ['archetypeId'] },
        { accessor: 'by_character_and_archetype', algorithm: 'btree', columns: ['characterName', 'archetypeId'] },
    ],
}, hsrCharacterArchetypeColumns);
