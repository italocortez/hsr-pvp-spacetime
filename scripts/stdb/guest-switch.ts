/**
 * Turn guest account creation or guest lobby creation on or off through the delegate token
 * (server_set_guest_creation / server_set_guest_lobby_creation, A42, A109(3)). The operator's way back the day a
 * breaker trips, without raw CLI calls (S11a, triage L12).
 *
 *   npx tsx scripts/stdb/guest-switch.ts --target test|prod accounts on|off
 *   npx tsx scripts/stdb/guest-switch.ts --target test|prod lobbies on|off
 *   npm run stdb:guest-switch -- --target prod lobbies on
 *
 * "accounts" = guest account creation (login_as_guest); "lobbies" = guest lobby creation (A42(1); re-enabling drops the
 * breaker's window counter). Add --dry-run to print the call without connecting.
 */
import { ENV_KEYS, EnvConfigError } from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { connect } from './_connection';
import { backendEnvFor } from './_env';

const USAGE = `usage:
  guest-switch.ts --target test|prod accounts on|off   (guest account creation)
  guest-switch.ts --target test|prod lobbies on|off    (guest lobby creation)`;

runMain('guest-switch', async () => {
    const { target, dryRun, positionals } = parseCli();
    const [what, state] = positionals;
    if ((what !== 'accounts' && what !== 'lobbies') || (state !== 'on' && state !== 'off')) {
        throw new EnvConfigError(USAGE);
    }
    const enabled = state === 'on';
    const reducerName = what === 'accounts' ? 'server_set_guest_creation' : 'server_set_guest_lobby_creation';

    if (dryRun) {
        const backend = backendEnvFor(target);
        console.log(
            `[dry-run] ${reducerName}(${enabled}) on ${backend.dbName} as the delegate (${ENV_KEYS.serverToken} from ${backend.envFile})`,
        );
        return;
    }

    const backend = backendEnvFor(target, { requireToken: true });
    const delegate = await connect({ backend, token: backend.serverToken, label: 'guest-switch' });
    if (what === 'accounts') {
        await delegate.conn.reducers.serverSetGuestCreation({ enabled });
    } else {
        await delegate.conn.reducers.serverSetGuestLobbyCreation({ enabled });
    }
    console.log(`[guest-switch] ${backend.dbName}: guest ${what === 'accounts' ? 'account' : 'lobby'} creation ${state}`);
    delegate.close();
});
