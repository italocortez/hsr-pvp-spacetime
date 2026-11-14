/**
 * Post-publish bootstrap (ACCESS-SECURITY-OPS §C.4), replacing scripts/post-publish.ts.
 *
 *   npx tsx scripts/stdb/bootstrap.ts --target test|prod [--dry-run] [--rotate-linker]
 *
 * Precondition: the module was published by the CLI login that runs this script, so `init`
 * registered that identity as the Owner and created the SYSTEM user.
 *
 *   1. Owner token from `spacetime login show --token` (captured from stdout; never written or logged).
 *   2. A token-less connection mints a fresh identity + token (the new delegate).
 *   3. As owner: server_register_delegate(freshHex, 'vercel-auth-<target>').
 *   4. Writes STDB_SERVER_TOKEN and STDB_SERVER_IDENTITY into .env.<target>.local (other lines kept), then (S10s, L101)
 *      best-effort server_revoke_delegate of the identity the file recorded before (STDB_SERVER_IDENTITY). A failure
 *      before the revoke leaves the previous delegate working (scripts/stdb/_delegate.ts).
 *   4b. M5a3: the auth function's Linker identity ('vercel-link-<target>'; it may only present sign-in codes, no
 *      UserIdentity, no SYSTEM mapping). Kept by default: when the file holds STDB_LINK_IDENTITY and STDB_LINK_TOKEN,
 *      server_register_linker(that identity) again (restores it after a wipe; "Already registered." means kept), so a
 *      deployed function keeps working. Only when the file has none, or with --rotate-linker: mint, register, write
 *      STDB_LINK_TOKEN and STDB_LINK_IDENTITY, then best-effort server_revoke_linker of the previous identity; the
 *      Vercel secret must then be updated and the function redeployed (_delegate.ts bootstrapLinker).
 *   5. As the delegate: seeds data/seed/*, starter achievements, config singletons, GC jobs (_seed.ts).
 *   6. Subscribes only to `achievement` and `archetype`.
 *   7. Any unexpected disconnect exits 1 (R6).
 *
 * Re-running is safe: each run mints and registers a new delegate (the previous one is revoked), keeps the linker,
 * game data is upserted, achievements are skipped by name, singletons report "exists".
 */
import { ENV_KEYS, EnvConfigError } from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { connect } from './_connection';
import { bootstrapLinker, describeLinkerAction, planLinkerAction, rotateDelegate } from './_delegate';
import {
    backendEnvFor,
    envFilePath,
    readEnvFile,
    SERVER_IDENTITY_KEY,
    upsertEnvFile,
} from './_env';
import { seedAll } from './_seed';
import { runSpacetime } from './_spawn';

const JWT_RE = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function ownerTokenFromCli(): string {
    const out = runSpacetime({
        args: ['login', 'show', '--token'],
        dryRun: false,
        captureStdout: true,
    });
    const matches = out.match(JWT_RE);
    if (!matches || matches.length === 0) {
        throw new EnvConfigError(
            'no auth token in `spacetime login show --token` output; run `spacetime login` first.',
        );
    }
    return matches[matches.length - 1];
}

runMain('bootstrap', async () => {
    const { target, dryRun, flags } = parseCli();
    const backend = backendEnvFor(target);
    const label = `vercel-auth-${target}`;
    const linkLabel = `vercel-link-${target}`;
    const rotateLinker = flags.has('rotate-linker');

    if (dryRun) {
        console.log(`[dry-run] bootstrap ${target} → ${backend.dbName} on ${backend.host}`);
        console.log(
            '[dry-run] owner token: spacetime login show --token (stdout captured, never printed)',
        );
        console.log(
            `[dry-run] mint a fresh identity; register it as delegate "${label}"`,
        );
        console.log(
            `[dry-run] write ${ENV_KEYS.serverToken}, ${SERVER_IDENTITY_KEY} → ${backend.envFile}; then revoke the previous ${SERVER_IDENTITY_KEY} if present`,
        );
        console.log(
            describeLinkerAction(planLinkerAction(readEnvFile(envFilePath(target)), rotateLinker), linkLabel, backend.envFile),
        );
        console.log(
            '[dry-run] seed as delegate: data/seed/*, achievements, EloConfig, AccountRatingConfig, IdentityGcJob, LobbyGcJob',
        );
        return;
    }

    console.log(`[bootstrap] ${target} → ${backend.dbName}`);

    // 1. Owner connection (the publisher).
    const ownerToken = ownerTokenFromCli();
    const owner = await connect({ backend, token: ownerToken, label: 'bootstrap:owner' });
    console.log(`[bootstrap] owner connected: ${owner.identityHex}`);

    // 2. Fresh identity for the delegate.
    const fresh = await connect({ backend, label: 'bootstrap:mint' });
    const freshToken = fresh.token;
    const freshHex = fresh.identityHex;
    fresh.close();
    console.log(`[bootstrap] minted delegate identity: ${freshHex}`);

    // 3-4. S10s (L101): register the new delegate, save its credentials for this target only, then revoke the
    // previous one (best effort). A failure before the revoke leaves the previous delegate working (_delegate.ts).
    const previousHex = readEnvFile(envFilePath(target))[SERVER_IDENTITY_KEY];
    await rotateDelegate(
        { freshToken, freshHex, previousHex, label },
        {
            register: async (identityHex, delegateLabel) => {
                await owner.conn.reducers.serverRegisterDelegate({ identityHex, label: delegateLabel });
            },
            save: (token, identityHex) => {
                upsertEnvFile(target, { [ENV_KEYS.serverToken]: token, [SERVER_IDENTITY_KEY]: identityHex });
                console.log(`[bootstrap] wrote ${ENV_KEYS.serverToken} and ${SERVER_IDENTITY_KEY} to ${backend.envFile}`);
            },
            revoke: async (identityHex) => {
                await owner.conn.reducers.serverRevokeDelegate({ identityHex });
            },
            log: (line) => console.log(line),
        },
    );
    // 4b. M5a3: the auth function's Linker identity: kept by default (registered again, which restores it after a wipe),
    // minted when the file has none or with --rotate-linker (_delegate.ts bootstrapLinker).
    await bootstrapLinker({
        env: readEnvFile(envFilePath(target)),
        rotate: rotateLinker,
        label: linkLabel,
        reducers: owner.conn.reducers,
        mint: async () => {
            const freshLinker = await connect({ backend, label: 'bootstrap:mint-linker' });
            const minted = { token: freshLinker.token, identityHex: freshLinker.identityHex };
            freshLinker.close();
            return minted;
        },
        writeEnv: (values) => upsertEnvFile(target, values),
        log: (line) => console.log(line),
    });
    owner.close();

    // 5–6. Seed as the delegate.
    const delegate = await connect({ backend, token: freshToken, label: 'bootstrap:delegate' });
    await seedAll(delegate.conn);
    delegate.close();

    console.log(`[bootstrap] complete for ${backend.dbName}`);
});
