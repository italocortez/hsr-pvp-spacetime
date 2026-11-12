/**
 * Publish the module to one target.
 *
 *   npx tsx scripts/stdb/publish.ts --target test [--clear] [--dry-run]
 *   npx tsx scripts/stdb/publish.ts --target prod [--dry-run]
 *
 * - Arguments come only from publishArgs() in shared/stdb-targets.ts: explicit database name,
 *   --server maincloud --no-config, and STDB_TARGET=<target> in the child environment (the module's
 *   declared env value, read by requireTestDatabase).
 * - test always adds `--yes=remote` (skips the "publish to a non-local server?" prompt, so it runs without
 *   a terminal, e.g. from test/global-setup.ts); migration prompts still ask.
 * - --clear wipes all data (`--delete-data=always --yes=delete-data`) and is refused for prod.
 * - prod = `--yes=migrate` only (no `--yes=remote`: the non-local prompt still asks); forbidden flags are
 *   re-checked before spawning; refuses a dirty tree.
 * - Runs `npm run typecheck` first and aborts on errors: `spacetime build` cannot find tsc in this
 *   workspace layout, so it bundles without type-checking (M1 finding).
 * - --dry-run prints the command and the child environment keys, runs nothing, contacts nothing.
 */
import { spawnSync } from 'node:child_process';
import {
    assertNoForbiddenProdFlags,
    assertWipeAllowed,
    publishArgs,
} from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { REPO_ROOT } from './_env';
import { runLocal, runSpacetime } from './_spawn';

runMain('publish', () => {
    const { target, dryRun, flags } = parseCli();
    const clear = flags.has('clear');
    if (clear) assertWipeAllowed(target);

    const cmd = publishArgs(target, {
        modulePath: 'spacetimedb',
        clearDatabase: clear,
        yesMigrate: target === 'prod',
    });
    if (target === 'prod') assertNoForbiddenProdFlags(cmd.args);

    if (dryRun) {
        console.log(
            `[dry-run] pre-flight: npm run typecheck${target === 'prod' ? '; git status --porcelain must be empty' : ''}`,
        );
        runSpacetime({ args: cmd.args, target, env: cmd.env, dryRun: true });
        return;
    }

    if (target === 'prod') {
        const status = spawnSync('git', ['status', '--porcelain'], {
            cwd: REPO_ROOT,
            encoding: 'utf-8',
        });
        if (status.status !== 0) throw new Error('git status failed; refusing a prod publish.');
        if (status.stdout.trim() !== '') {
            throw new Error(
                'working tree is dirty; prod publishes only from a clean, committed tree (§C.5).',
            );
        }
    }

    console.log('[publish] npm run typecheck');
    runLocal('npm run typecheck');

    console.log(`[publish] ${target}${clear ? ' (WIPE: --delete-data=always)' : ''}`);
    runSpacetime({ args: cmd.args, target, env: cmd.env, dryRun: false });
    console.log('[publish] done');
});
