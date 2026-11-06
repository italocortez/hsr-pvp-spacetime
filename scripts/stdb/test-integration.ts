/**
 * Live integration suite wrapper (test target only; it wipes and re-bootstraps test1 in globalSetup).
 *
 *   npx tsx scripts/stdb/test-integration.ts [--target test] [--dry-run] [-- <vitest args>]
 *
 * Sets STDB_TARGET=test in the vitest child environment, so no inline env syntax is needed on Windows.
 * Refuses --target prod (and STDB_TARGET=prod).
 */
import {
    assertWipeAllowed,
    ENV_KEYS,
    EnvConfigError,
    parseTarget,
} from '../../shared/stdb-targets';
import { runMain } from './_args';
import { runLocal } from './_spawn';

runMain('test:integration', () => {
    const argv = process.argv.slice(2);
    const passthrough: string[] = [];
    let raw: string | undefined = process.env[ENV_KEYS.target] || 'test';
    let dryRun = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--target') raw = argv[++i];
        else if (a.startsWith('--target=')) raw = a.slice('--target='.length);
        else if (a === '--dry-run') dryRun = true;
        else if (a !== '--') passthrough.push(a);
    }
    const target = parseTarget(raw, '--target');
    if (target !== 'test')
        throw new EnvConfigError('the live integration suite runs against test only.');
    assertWipeAllowed(target); // globalSetup wipes the database

    const quoted = passthrough.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : JSON.stringify(a)));
    const cmd = [
        'npx',
        'vitest',
        'run',
        '--config',
        'test/vitest.integration.config.ts',
        ...quoted,
    ].join(' ');
    if (dryRun) {
        console.log(`[dry-run] ${ENV_KEYS.target}=${target} ${cmd}`);
        return;
    }
    runLocal(cmd, { [ENV_KEYS.target]: target });
});
