import { table, t } from 'spacetimedb/server';
import { Path } from '../types/enums';

export const hsrLightconeColumns = {
    name: t.string().primaryKey(),
    displayName: t.string(),
    aliases: t.array(t.string()),
    path: Path,
    rarity: t.u8(),
    imageUrl: t.string(),

    // CSS positioning corrections for the UI
    posX: t.i32(),
    posY: t.i32(),
    width: t.i32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const HsrLightcone = table({
    name: 'hsr_lightcone',
    public: true,
    indexes: [
        { accessor: 'by_path', algorithm: 'btree', columns: ['path'] },
    ]
}, hsrLightconeColumns);