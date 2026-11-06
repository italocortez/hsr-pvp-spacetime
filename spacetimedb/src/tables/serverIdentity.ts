import { table, t } from 'spacetimedb/server';
import { ServerIdentityKind } from '../types/enums';

/**
 * Trusted server identities (ACCESS-SECURITY-OPS §C.4).
 *
 * - Owner: the database publisher, inserted by `init` on the first publish (and on every
 *   `--delete-data` republish). Only the owner may register or revoke delegates.
 * - Delegate: identities the owner registered with `server_register_delegate` (the bootstrap
 *   script's token, the Vercel auth function). Delegates may call the `server_*` reducers
 *   guarded by `requireServer` (e.g. `server_link_provider`), but not manage other delegates.
 *
 * Nothing in the module accepts an unregistered caller: there is no first-come registration.
 */
export const serverIdentityColumns = {
    identity: t.identity().primaryKey(),
    kind: ServerIdentityKind,
    label: t.string(),
    registeredAt: t.timestamp(),
};

export const ServerIdentity = table({
    name: 'server_identity',
    public: false, // No client needs to read this
}, serverIdentityColumns);
