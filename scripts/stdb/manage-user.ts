/**
 * Change a user's role, delete, suspend or lift a suspension through the delegate token (server_set_role /
 * server_delete_user / server_suspend_user / server_lift_suspension), or list the suspended accounts
 * (view_admin_suspensions).
 *
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod set-role <username> <role>
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod delete <username>
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod suspend <username> [--reason "<text>"]
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod unsuspend <username>
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod suspended
 *   npm run stdb:manage-user -- --target prod set-role <username> Admin
 *
 * Roles: Admin, Moderator, TournamentHost, User. Add --dry-run to print the call without connecting.
 * The user must have logged in once (the reducers look the user up by username).
 * suspend (suspension-s1, A214): any verified account except SYSTEM, an Admin included; the reason is optional
 * (500 characters at most), kept for the admins' record and never shown to the person. A reason that starts with
 * `--` must be written as `--reason=<text>`. Extra words are refused, so quote a reason with spaces.
 * suspended: subscribes view_admin_suspensions as the delegate (mapped to the SYSTEM user, an Admin), prints the rows
 * as a table once they are applied, and closes.
 */
import { ENV_KEYS, EnvConfigError } from '../../shared/stdb-targets';
import { parseCli, runMain } from './_args';
import { connect, subscribeOnly } from './_connection';
import { backendEnvFor } from './_env';

const VALID_ROLES = ['Admin', 'Moderator', 'TournamentHost', 'User'];
/** Each command and the number of positionals it takes, the command word included. */
const POSITIONALS: Record<string, number> = {
    'set-role': 3,
    delete: 2,
    suspend: 2,
    unsuspend: 2,
    suspended: 1,
};
/** The module's limit on the reason, in UTF-16 units (SUSPENSION_REASON_MAX_LENGTH in suspensionActions.ts). */
const REASON_MAX_LENGTH = 500;
const USAGE = `usage:
  manage-user.ts --target test|prod set-role <username> <role>   (roles: ${VALID_ROLES.join(', ')})
  manage-user.ts --target test|prod delete <username>
  manage-user.ts --target test|prod suspend <username> [--reason "<text>"]
  manage-user.ts --target test|prod unsuspend <username>
  manage-user.ts --target test|prod suspended
A reason with spaces must be quoted (at most ${REASON_MAX_LENGTH} characters); a reason that starts with "--" must be
written as --reason=<text>.`;

/**
 * `--reason <text>` / `--reason=<text>` taken out of argv (the shared parser has boolean flags only); the rest goes to
 * parseCli unchanged. A second `--reason` is refused.
 */
function takeReason(argv: readonly string[]): { reason: string | undefined; rest: string[] } {
    const rest: string[] = [];
    let reason: string | undefined;
    const set = (value: string) => {
        if (reason !== undefined) throw new EnvConfigError(`--reason given more than once.\n${USAGE}`);
        reason = value;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--reason') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                throw new EnvConfigError(`--reason needs a value (use --reason=<text> for a text that starts with "--").`);
            }
            set(value);
            i++;
        } else if (a.startsWith('--reason=')) {
            set(a.slice('--reason='.length));
        } else {
            rest.push(a);
        }
    }
    return { reason, rest };
}

/** The suspended accounts as a plain text table; the SYSTEM user (a server call) is labelled "server". */
function suspensionTable(rows: readonly any[]): string {
    if (rows.length === 0) return '(no suspended accounts)';
    const header = ['user id', 'username', 'display name', 'suspended by', 'set at (UTC)', 'reason'];
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    const body = [...rows]
        .sort((a, b) => (a.suspendedAt.microsSinceUnixEpoch < b.suspendedAt.microsSinceUnixEpoch ? -1 : 1))
        .map((r) => [
            String(r.userId),
            flat(r.username),
            flat(r.displayName),
            r.suspendedById === 0 ? 'server' : `${r.suspendedByUsername ?? '(gone)'} (#${r.suspendedById})`,
            new Date(Number(r.suspendedAt.microsSinceUnixEpoch / 1000n)).toISOString(),
            r.reason === '' ? '-' : flat(r.reason),
        ]);
    const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
    return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

runMain('manage-user', async () => {
    const { reason, rest } = takeReason(process.argv.slice(2));
    const { target, dryRun, positionals } = parseCli(rest);
    const [action, username, role] = positionals;
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
    if (action === 'set-role' && !VALID_ROLES.includes(role)) {
        throw new EnvConfigError(
            `invalid role "${role ?? ''}"; expected one of ${VALID_ROLES.join(', ')}.`,
        );
    }
    if (reason !== undefined && action !== 'suspend') {
        throw new EnvConfigError('--reason applies to suspend only.');
    }
    if (reason !== undefined && reason.length > REASON_MAX_LENGTH) {
        throw new EnvConfigError(
            `the reason is ${reason.length} characters; at most ${REASON_MAX_LENGTH} are accepted.`,
        );
    }

    if (dryRun) {
        const backend = backendEnvFor(target);
        const call =
            action === 'set-role'
                ? `server_set_role(${username}, ${role})`
                : action === 'delete'
                  ? `server_delete_user(${username})`
                  : action === 'suspend'
                    ? `server_suspend_user(${username}, reason: ${reason === undefined ? 'none' : `${reason.length} characters`})`
                    : action === 'unsuspend'
                      ? `server_lift_suspension(${username})`
                      : 'subscribe view_admin_suspensions';
        console.log(
            `[dry-run] ${call} on ${backend.dbName} as the delegate (${ENV_KEYS.serverToken} from ${backend.envFile})`,
        );
        return;
    }

    const backend = backendEnvFor(target, { requireToken: true });
    const delegate = await connect({ backend, token: backend.serverToken, label: 'manage-user' });
    if (action === 'set-role') {
        await delegate.conn.reducers.serverSetRole({ username, roleTag: role });
        console.log(`[manage-user] ${backend.dbName}: "${username}" role set to ${role}`);
    } else if (action === 'delete') {
        await delegate.conn.reducers.serverDeleteUser({ username });
        console.log(`[manage-user] ${backend.dbName}: "${username}" deleted`);
    } else if (action === 'suspend') {
        await delegate.conn.reducers.serverSuspendUser({ username, reason: reason ?? '' });
        console.log(`[manage-user] ${backend.dbName}: "${username}" suspended`);
    } else if (action === 'unsuspend') {
        await delegate.conn.reducers.serverLiftSuspension({ username });
        console.log(`[manage-user] ${backend.dbName}: "${username}" suspension lifted`);
    } else {
        await subscribeOnly(delegate.conn, ['SELECT * FROM view_admin_suspensions'], 'manage-user');
        const rows = [...delegate.conn.db.viewAdminSuspensions.iter()];
        console.log(`[manage-user] ${backend.dbName}: ${rows.length} suspended account(s)`);
        console.log(suspensionTable(rows));
    }
    delegate.close();
});
