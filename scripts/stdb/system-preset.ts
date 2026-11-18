/**
 * S14.4s: bring the system lobby preset ("Tournament default") of a live database to the module's current constants,
 * through the delegate token (server_refresh_system_preset). `init` runs only on the first publish or a wipe, so a
 * database published before a change of the constants keeps the old row until this runs (after the publish that
 * carries the new constants). A row an Admin has edited is left as it is; the module log says what was done.
 *
 *   npx tsx scripts/stdb/system-preset.ts --target test|prod refresh
 *   npm run stdb:system-preset -- --target test refresh
 *
 * Extra words and unknown options are refused. Add --dry-run to print the call without connecting.
 */
import { ENV_KEYS, EnvConfigError } from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { connect } from './_connection';
import { backendEnvFor } from './_env';

const USAGE = `usage:
  system-preset.ts --target test|prod refresh   (bring a system preset no Admin edited to the current constants)`;

runMain('system-preset', async () => {
    const { target, dryRun, flags, positionals } = parseCli();
    const [command] = positionals;
    if (command !== 'refresh') throw new EnvConfigError(USAGE);
    if (positionals.length > 1) {
        const extra = positionals.slice(1).map((x) => `"${x}"`).join(' ');
        throw new EnvConfigError(`unexpected extra argument(s): ${extra}.\n${USAGE}`);
    }
    const unknown = [...flags].filter((f) => f !== 'dry-run');
    if (unknown.length > 0) throw new EnvConfigError(`unknown option(s): ${unknown.map((f) => `--${f}`).join(' ')}.\n${USAGE}`);

    if (dryRun) {
        const backend = backendEnvFor(target);
        console.log(`[dry-run] server_refresh_system_preset() on ${backend.dbName} as the delegate (${ENV_KEYS.serverToken} from ${backend.envFile})`);
        return;
    }

    const backend = backendEnvFor(target, { requireToken: true });
    const delegate = await connect({ backend, token: backend.serverToken, label: 'system-preset' });
    await delegate.conn.reducers.serverRefreshSystemPreset({});
    console.log(`[system-preset] ${backend.dbName}: refresh done; the module log ([PRESET]) says whether the row changed`);
    delegate.close();
});
