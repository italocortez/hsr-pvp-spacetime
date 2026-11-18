/**
 * S14.4p: list, add, update or remove the partnered Discord servers on the landing page (the public `partner_server`
 * table) through the delegate token (server_add_partner_server / server_update_partner_server /
 * server_remove_partner_server).
 *
 *   npx tsx scripts/stdb/manage-partners.ts --target test|prod list
 *   npx tsx scripts/stdb/manage-partners.ts --target test|prod add <name> <invite> [--description=<text>] [--position=<n>]
 *   npx tsx scripts/stdb/manage-partners.ts --target test|prod update <id> <name> <invite> [--description=<text>] [--position=<n>]
 *   npx tsx scripts/stdb/manage-partners.ts --target test|prod remove <id>
 *   npm run stdb:manage-partners -- --target prod add "Genius Society" HbXErzYVQ5 --description="Relic manipulators and build makers"
 *
 * <invite> is a bare invite code or a https://discord.gg/<code> or https://discord.com/invite/<code> link; the module
 * stores the code (helpers/admin/partnerServers.ts holds the rules and the refusal texts). add: the description
 * defaults to empty and the position to 0. update: an omitted description or position keeps the row's current value.
 * Quote a name or description with spaces; a value that starts with "--" must be written as --description=<text>.
 * Extra words are refused. Add --dry-run to print the call without connecting.
 * list subscribes the public table, prints it ordered by position then id, and closes.
 */
import { ENV_KEYS, EnvConfigError } from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { connect, subscribeOnly } from './_connection';
import { backendEnvFor } from './_env';

/** Each command and the number of positionals it takes, the command word included. */
const POSITIONALS: Record<string, number> = {
    list: 1,
    add: 3,
    update: 4,
    remove: 2,
};
const U32_MAX = 4294967295;
const USAGE = `usage:
  manage-partners.ts --target test|prod list
  manage-partners.ts --target test|prod add <name> <invite> [--description=<text>] [--position=<n>]
  manage-partners.ts --target test|prod update <id> <name> <invite> [--description=<text>] [--position=<n>]
  manage-partners.ts --target test|prod remove <id>
<invite>: a Discord invite code, or https://discord.gg/<code> / https://discord.com/invite/<code>.
Quote values with spaces; a value that starts with "--" must be written as --description=<text>.`;

const VALUE_OPTIONS = ['description', 'position'] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

/**
 * `--description <text>` / `--description=<text>` and the same for `--position`, taken out of argv (the shared parser
 * has boolean flags only); the rest goes to parseCli unchanged. A repeated option is refused.
 */
function takeValues(argv: readonly string[]): { values: Partial<Record<ValueOption, string>>; rest: string[] } {
    const values: Partial<Record<ValueOption, string>> = {};
    const rest: string[] = [];
    const set = (name: ValueOption, value: string) => {
        if (values[name] !== undefined) throw new EnvConfigError(`--${name} given more than once.\n${USAGE}`);
        values[name] = value;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const name = VALUE_OPTIONS.find((o) => a === `--${o}` || a.startsWith(`--${o}=`));
        if (!name) {
            rest.push(a);
        } else if (a === `--${name}`) {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                throw new EnvConfigError(`--${name} needs a value (use --${name}=<value> for one that starts with "--").`);
            }
            set(name, value);
            i++;
        } else {
            set(name, a.slice(`--${name}=`.length));
        }
    }
    return { values, rest };
}

/** A u32 written in decimal digits, or a fail-fast error naming `what`. */
function parseU32(raw: string, what: string): number {
    const n = /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(n) || n > U32_MAX) throw new EnvConfigError(`${what} must be a whole number from 0 to ${U32_MAX}, got "${raw}".`);
    return n;
}

type PartnerRow = { id: number; name: string; inviteCode: string; description: string; position: number };

/** The rows as a plain text table, ordered by position then id (as the landing page). */
function partnerTable(rows: readonly PartnerRow[]): string {
    if (rows.length === 0) return '(no partner servers)';
    const header = ['id', 'position', 'name', 'invite', 'description'];
    const body = [...rows]
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((r) => [String(r.id), String(r.position), r.name, r.inviteCode, r.description === '' ? '-' : r.description]);
    const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
    return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

runMain('manage-partners', async () => {
    const { values, rest } = takeValues(process.argv.slice(2));
    const { target, dryRun, flags, positionals } = parseCli(rest);
    const [action] = positionals;
    const expected = POSITIONALS[action];
    if (expected === undefined) throw new EnvConfigError(USAGE);
    if (positionals.length !== expected) {
        const extra = positionals.slice(expected);
        throw new EnvConfigError(
            extra.length > 0
                ? `unexpected extra argument(s) for ${action}: ${extra.map((x) => `"${x}"`).join(' ')}.\n${USAGE}`
                : `missing argument(s) for ${action}.\n${USAGE}`,
        );
    }
    const unknown = [...flags].filter((f) => f !== 'dry-run');
    if (unknown.length > 0) throw new EnvConfigError(`unknown option(s): ${unknown.map((f) => `--${f}`).join(' ')}.\n${USAGE}`);
    if ((action === 'list' || action === 'remove') && Object.keys(values).length > 0) {
        throw new EnvConfigError(`--description and --position apply to add and update only.\n${USAGE}`);
    }
    const position = values.position === undefined ? undefined : parseU32(values.position, '--position');
    const id = action === 'update' || action === 'remove' ? parseU32(positionals[1], '<id>') : undefined;
    const [name, invite] = action === 'add' ? positionals.slice(1, 3) : action === 'update' ? positionals.slice(2, 4) : [];

    if (dryRun) {
        const backend = backendEnvFor(target);
        const fields = () =>
            `name: "${name}", invite: "${invite}", description: ${values.description === undefined ? (action === 'add' ? '""' : 'unchanged') : `"${values.description}"`}, position: ${position ?? (action === 'add' ? 0 : 'unchanged')}`;
        const call =
            action === 'list'
                ? 'subscribe partner_server'
                : action === 'add'
                  ? `server_add_partner_server(${fields()})`
                  : action === 'update'
                    ? `server_update_partner_server(id: ${id}, ${fields()})`
                    : `server_remove_partner_server(id: ${id})`;
        console.log(`[dry-run] ${call} on ${backend.dbName} as the delegate (${ENV_KEYS.serverToken} from ${backend.envFile})`);
        return;
    }

    const backend = backendEnvFor(target, { requireToken: true });
    const delegate = await connect({ backend, token: backend.serverToken, label: 'manage-partners' });
    const reducers = delegate.conn.reducers;
    if (action === 'add') {
        await reducers.serverAddPartnerServer({ name, invite, description: values.description ?? '', position: position ?? 0 });
        console.log(`[manage-partners] ${backend.dbName}: "${name}" added`);
    } else if (action === 'remove') {
        await reducers.serverRemovePartnerServer({ id: id! });
        console.log(`[manage-partners] ${backend.dbName}: partner server #${id} removed`);
    } else {
        await subscribeOnly(delegate.conn, ['SELECT * FROM partner_server'], 'manage-partners');
        const rows = [...delegate.conn.db.partnerServer.iter()] as PartnerRow[];
        if (action === 'list') {
            console.log(`[manage-partners] ${backend.dbName}: ${rows.length} partner server(s)`);
            console.log(partnerTable(rows));
        } else {
            const current = rows.find((r) => r.id === id);
            if (!current) throw new EnvConfigError(`partner server #${id} not found on ${backend.dbName}.`);
            await reducers.serverUpdatePartnerServer({
                id: id!,
                name,
                invite,
                description: values.description ?? current.description,
                position: position ?? current.position,
            });
            console.log(`[manage-partners] ${backend.dbName}: partner server #${id} updated`);
        }
    }
    delegate.close();
});
