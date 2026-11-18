/**
 * MNT1: turn the database's maintenance mode on or off, or show it, through the delegate token (server_set_maintenance,
 * the server twin of the Admin's switch on the admin page; A163(3)). The operator's way to open and close a maintenance
 * window around a breaking publish without the admin page.
 *
 *   npx tsx scripts/stdb/maintenance.ts --target test|prod on|off|status
 *   npm run stdb:maintenance -- --target prod on
 *
 * on/off: setting the value the database already has is a no-op that succeeds. Turning it on drops no connection:
 * new connections of non-Admins are refused, connected non-Admins are refused on their next action.
 * status: subscribes view_admin_abuse_config as the delegate (mapped to the SYSTEM user, an Admin), prints the flag and
 * closes. Extra words and unknown options are refused. Add --dry-run to print the call without connecting.
 */
import { ENV_KEYS, EnvConfigError } from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { connect, subscribeOnly } from './_connection';
import { backendEnvFor } from './_env';

const USAGE = `usage:
  maintenance.ts --target test|prod on       (turn maintenance mode on)
  maintenance.ts --target test|prod off      (turn maintenance mode off)
  maintenance.ts --target test|prod status   (show whether it is on)`;

runMain('maintenance', async () => {
    const { target, dryRun, flags, positionals } = parseCli();
    const [command] = positionals;
    if (command !== 'on' && command !== 'off' && command !== 'status') throw new EnvConfigError(USAGE);
    if (positionals.length > 1) {
        const extra = positionals.slice(1).map((x) => `"${x}"`).join(' ');
        throw new EnvConfigError(`unexpected extra argument(s): ${extra}.\n${USAGE}`);
    }
    const unknown = [...flags].filter((f) => f !== 'dry-run');
    if (unknown.length > 0) throw new EnvConfigError(`unknown option(s): ${unknown.map((f) => `--${f}`).join(' ')}.\n${USAGE}`);

    if (dryRun) {
        const backend = backendEnvFor(target);
        const call = command === 'status' ? 'subscribe view_admin_abuse_config' : `server_set_maintenance(${command === 'on'})`;
        console.log(`[dry-run] ${call} on ${backend.dbName} as the delegate (${ENV_KEYS.serverToken} from ${backend.envFile})`);
        return;
    }

    const backend = backendEnvFor(target, { requireToken: true });
    const delegate = await connect({ backend, token: backend.serverToken, label: 'maintenance' });
    if (command === 'status') {
        await subscribeOnly(delegate.conn, ['SELECT * FROM view_admin_abuse_config'], 'maintenance');
        const row = [...delegate.conn.db.viewAdminAbuseConfig.iter()][0];
        if (!row) throw new EnvConfigError(`no abuse config row visible on ${backend.dbName} (not seeded, or the token is not staff).`);
        console.log(`[maintenance] ${backend.dbName}: maintenance mode is ${row.maintenanceMode ? 'on' : 'off'}`);
    } else {
        await delegate.conn.reducers.serverSetMaintenance({ on: command === 'on' });
        console.log(`[maintenance] ${backend.dbName}: maintenance mode ${command}`);
    }
    delegate.close();
});
