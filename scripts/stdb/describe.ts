/**
 * Print the published schema of one target as JSON (the §C.5 schema-delta gate diffs test vs prod).
 *
 *   npx tsx scripts/stdb/describe.ts --target test|prod [--dry-run]
 */
import { readArgs } from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { runSpacetime } from './_spawn';

runMain('describe', () => {
    const { target, dryRun } = parseCli();
    // readArgs adds --json for describe; the CLI prints the JSON to stdout.
    runSpacetime({ args: readArgs(target, 'describe'), target, dryRun });
});
