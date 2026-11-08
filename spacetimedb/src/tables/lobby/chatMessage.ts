import { table, t } from 'spacetimedb/server';
import { ChatSenderType } from '@module/types/enums';

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

// S3 (A37): private; members read view_my_lobby_chat (anonymized, S9).
export const ChatMessage = table({
    name: 'chat_message',
    public: false,
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
    ],
}, chatMessageColumns);
