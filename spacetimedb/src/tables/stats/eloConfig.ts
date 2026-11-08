import { table, t } from 'spacetimedb/server';

export const eloConfigColumns = {
    id: t.u32().primaryKey(),
    kFactorNew: t.u8(),
    kFactorMid: t.u8(),
    kFactorVet: t.u8(),
    newThreshold: t.u32(),
    midThreshold: t.u32(),
    initialRating: t.u32(),
    sizeBonus: t.u32(),
    spreadDivisor: t.u8(),
    maxAccountBonus: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const EloConfigTable = table({
    name: 'elo_config',
    public: true,
}, eloConfigColumns);
