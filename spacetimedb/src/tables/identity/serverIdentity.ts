import { table, t } from 'spacetimedb/server';
import { ServerIdentityKind } from '@module/types/enums';

/**
 * Trusted server identities (ACCESS-SECURITY-OPS §C.4).
 *
 * - Owner: the database publisher, inserted by `init` on the first publish (and on every
 *   `--delete-data` republish). Only the owner may register or revoke delegates.
 * - Delegate: identities the owner registered with `server_register_delegate` (the bootstrap
 *   script's token for seeding and the manage-user script). Delegates map to the SYSTEM user and may call the
 *   `server_*` reducers guarded by `requireServer`, but not manage other server identities.
 * - Linker (M5a3): the Vercel auth function's identity, registered with `server_register_linker`. No UserIdentity,
 *   not mapped to SYSTEM; it may only call `linker_present_code` (helpers/identity/serverIdentities.ts).
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
