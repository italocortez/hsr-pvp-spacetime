/**
 * Regenerate the client bindings from the local module source (no database, no target).
 *
 *   npx tsx scripts/stdb/generate.ts [--dry-run]
 *
 * Review `git diff --stat web/src/module_bindings` afterwards: the bindings diff is the
 * zero-energy schema gate (D-M2). The CLI asks before deleting stale files (e.g. a removed reducer).
 */
import { parseFlags, runMain } from './_args';
import { runSpacetime } from './_spawn';

runMain('generate', () => {
    const { dryRun } = parseFlags();
    runSpacetime({
        args: [
            'generate',
            '--lang',
            'typescript',
            '--out-dir',
            'web/src/module_bindings',
            '--module-path',
            'spacetimedb',
        ],
        dryRun,
    });
});
