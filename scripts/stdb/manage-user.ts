/**
 * Change a user's role or delete a user through the delegate token (server_set_role / server_delete_user).
 *
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod set-role <username> <role>
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod delete <username>
 *   npm run stdb:manage-user -- --target prod set-role <username> Admin
 *
 * Roles: Admin, Moderator, TournamentHost, User. Add --dry-run to print the call without connecting.
 * The user must have logged in once (the reducers look the user up by username).
 */
import { ENV_KEYS, EnvConfigError } from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { connect } from './_connection';
import { backendEnvFor } from './_env';

const VALID_ROLES = ['Admin', 'Moderator', 'TournamentHost', 'User'];
const USAGE = `usage:
  manage-user.ts --target test|prod set-role <username> <role>   (roles: ${VALID_ROLES.join(', ')})
  manage-user.ts --target test|prod delete <username>`;

runMain('manage-user', async () => {
    const { target, dryRun, positionals } = parseCli();
    const [action, username, role] = positionals;
    if (!username || (action !== 'set-role' && action !== 'delete'))
        throw new EnvConfigError(USAGE);
    if (action === 'set-role' && (!role || !VALID_ROLES.includes(role))) {
        throw new EnvConfigError(
            `invalid role "${role ?? ''}"; expected one of ${VALID_ROLES.join(', ')}.`,
        );
    }

    if (dryRun) {
        const backend = backendEnvFor(target);
        const call =
            action === 'set-role'
                ? `server_set_role(${username}, ${role})`
                : `server_delete_user(${username})`;
        console.log(
            `[dry-run] ${call} on ${backend.dbName} as the delegate (${ENV_KEYS.serverToken} from ${backend.envFile})`,
        );
        return;
    }

    const backend = backendEnvFor(target, { requireToken: true });
    const delegate = await connect({ backend, token: backend.serverToken, label: 'manage-user' });
    if (action === 'set-role') {
        await delegate.conn.reducers.serverSetRole({ username, roleTag: role });
        console.log(`[manage-user] ${backend.dbName}: "${username}" role set to ${role}`);
    } else {
        await delegate.conn.reducers.serverDeleteUser({ username });
        console.log(`[manage-user] ${backend.dbName}: "${username}" deleted`);
    }
    delegate.close();
});
