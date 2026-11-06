import { table, t } from 'spacetimedb/server';

/**
 * Stores the trusted server identity (Next.js API server).
 * Only one row should ever exist. The server identity is the only caller
 * allowed to invoke server_link_provider (which links OAuth provider accounts to users).
 *
 * Bootstrap: call register_server when the table is empty.
 */
export const serverIdentityColumns = {
    identity: t.identity().primaryKey(),
    registeredAt: t.timestamp(),
};

export const ServerIdentity = table({
    name: 'server_identity',
    public: false, // No client needs to read this
}, serverIdentityColumns);
