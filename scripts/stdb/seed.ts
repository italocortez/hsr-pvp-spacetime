/**
 * Re-run bootstrap step 5 alone: seed data/seed/*, starter achievements, config singletons and
 * GC jobs as the delegate whose token bootstrap wrote to .env.<target>.local.
 *
 *   npx tsx scripts/stdb/seed.ts --target test|prod [--dry-run]
 */
import { ENV_KEYS } from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { connect } from './_connection';
import { backendEnvFor } from './_env';
import { seedAll } from './_seed';

runMain('seed', async () => {
    const { target, dryRun } = parseCli();
    if (dryRun) {
        const backend = backendEnvFor(target);
        console.log(
            `[dry-run] seed ${backend.dbName} as the delegate (${ENV_KEYS.serverToken} from ${backend.envFile})`,
        );
        return;
    }
    const backend = backendEnvFor(target, { requireToken: true });
    const delegate = await connect({ backend, token: backend.serverToken, label: 'seed' });
    console.log(`[seed] ${target} → ${backend.dbName} as ${delegate.identityHex}`);
    await seedAll(delegate.conn);
    delegate.close();
    console.log('[seed] complete');
});
