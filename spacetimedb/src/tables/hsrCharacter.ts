import { table, t } from 'spacetimedb/server';
import { Path, Element, CharRole } from '../types/enums';

export const hsrCharacterColumns = {
    name: t.string().primaryKey(),
    displayName: t.string(),
    aliases: t.array(t.string()),
    rarity: t.u8(),
    path: Path,
    element: Element,
    role: CharRole,
    imageUrl: t.string(),
    versionReleased: t.f64(),
    treatAsVersion: t.f64(),

    // NEW (Phase 15, D-05): Spine asset URLs — optional, most characters lack Spine.
    skelUrl: t.string().optional(),
    atlasUrl: t.string().optional(),
    atlasImgUrls: t.array(t.string()),

    // NEW (Phase 15, D-05a): Card positioning — required i32 with 0 defaults.
    posX: t.i32(),
    posY: t.i32(),
    width: t.i32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// People from the forums say we dont need "name": XXXXXXXXX on indexes anymore
export const HsrCharacter = table({
    name: 'hsr_character',
    public: true,
    indexes: [
        { accessor: 'by_path', algorithm: 'btree', columns: ['path'] },
        { accessor: 'by_element', algorithm: 'btree', columns: ['element'] },
        { accessor: 'by_role', algorithm: 'btree', columns: ['role'] },
    ]
}, hsrCharacterColumns);