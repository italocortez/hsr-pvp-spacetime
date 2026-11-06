import { table, t } from 'spacetimedb/server';
import { ChatSenderType } from '../types/enums';

export const chatMessageColumns = {
    id: t.u32().primaryKey().autoInc(),
    lobbyId: t.u32(),
    senderUserId: t.u32(),
    senderType: ChatSenderType,
    content: t.string(),
    metadata: t.string().optional(),
    anonymousLabel: t.string().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const ChatMessage = table({
    name: 'chat_message',
    public: true,
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
    ],
}, chatMessageColumns);
