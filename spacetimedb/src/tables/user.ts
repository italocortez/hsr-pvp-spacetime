import { table, t } from 'spacetimedb/server';
import { Role } from '../types/enums';

export const userColumns = {
    id: t.u32().primaryKey().autoInc(),
    username: t.string().unique(),
    displayName: t.string(),
    isGuest: t.bool(),
    isOnline: t.bool(),
    lastLoginAt: t.timestamp(),
    role: Role,
    hasDiscordLinked: t.bool(),           // D-02: replaces sensitive auth ID; only bool exposed on public table
    avatarCharacterName: t.string(), // FK reference to HsrCharacter name
    displayedAchievementId: t.u32().optional(), // FK to Achievement.id — shown on profile
    deletedAt: t.timestamp().optional(), // Set by admin soft-delete; scheduled job hard-deletes after 5s
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const User = table({
    name: 'user',
    public: true,
}, userColumns);
