import { table, t } from 'spacetimedb/server';
import { RecurrenceRule } from '../types/structs';

export const availabilitySlotColumns = {
    id: t.u32().primaryKey().autoInc(),
    userId: t.u32(),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    isRecurring: t.bool(),
    recurrenceRule: RecurrenceRule,
    expiresAt: t.timestamp(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const AvailabilitySlot = table({
    name: 'availability_slot',
    public: true,
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'start_at', algorithm: 'btree', columns: ['startAt'] },
    ],
}, availabilitySlotColumns);
