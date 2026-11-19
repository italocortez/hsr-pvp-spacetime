/**
 * Change a user's role, delete, suspend or lift a suspension through the delegate token (server_set_role /
 * server_delete_user / server_suspend_user / server_lift_suspension), show one account, list the suspended accounts
 * (view_admin_suspensions), or lowercase every username once (server_lowercase_usernames, A228 item 3).
 *
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod set-role <user> <role>
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod delete <user>
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod suspend <user> [--reason "<text>"]
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod unsuspend <user>
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod show <user>
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod suspended
 *   npx tsx scripts/stdb/manage-user.ts --target test|prod lowercase-usernames
 *   npm run stdb:manage-user -- --target prod set-role <user> Admin
 *
 * <user> (A228 item 4): a username, `id:<n>` (the user id) or `discord:<id>` (the Discord id). Before acting, the
 * script subscribes view_admin_users and view_admin_user_private as the delegate (the SYSTEM user, an Admin), finds
 * the one matching account, prints it (id, username, display name, role, Discord id, guest and pending-deletion
 * flags), then calls the reducer with `id:<n>`, so the reducer acts on the printed account even if the name changed
 * hands between the script's read and its call. That protects an `id:` or `discord:` reference only: a username is
 * resolved to whoever holds it now. Safe procedure: `show <user>` first, then the action with `id:<n>`.
 * No match, or more than one, stops before any call. `show` prints and acts on nothing.
 * Roles: Admin, Moderator, TournamentHost, User. Add --dry-run to print the call without connecting.
 * The user must have logged in once.
 * suspend (suspension-s1, A214): any verified account except SYSTEM, an Admin included; the reason is optional
 * (500 characters at most), kept for the admins' record and never shown to the person. A reason that starts with
 * `--` must be written as `--reason=<text>`. Extra words are refused, so quote a reason with spaces.
 * suspended: subscribes view_admin_suspensions as the delegate (mapped to the SYSTEM user, an Admin), prints the rows
 * as a table once they are applied, and closes.
 */
import { ENV_KEYS, EnvConfigError } from '../../shared/stdb-targets';
import { matchUserReference, userIdReference, userReferenceError } from '../../shared/identity';
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
    show: 2,
    suspended: 1,
    'lowercase-usernames': 1,
};
/** The commands whose second positional is a <user> reference. */
const USER_COMMANDS = new Set(['set-role', 'delete', 'suspend', 'unsuspend', 'show']);
/** The module's limit on the reason, in UTF-16 units (SUSPENSION_REASON_MAX_LENGTH in suspensionActions.ts). */
const REASON_MAX_LENGTH = 500;
const USAGE = `usage:
  manage-user.ts --target test|prod set-role <user> <role>   (roles: ${VALID_ROLES.join(', ')})
  manage-user.ts --target test|prod delete <user>
  manage-user.ts --target test|prod suspend <user> [--reason "<text>"]
  manage-user.ts --target test|prod unsuspend <user>
  manage-user.ts --target test|prod show <user>
  manage-user.ts --target test|prod suspended
  manage-user.ts --target test|prod lowercase-usernames
<user> is a username, id:<n> (the user id) or discord:<id> (the Discord id).
A username means whoever holds it now: run show <user> first, then act with id:<n> from what it printed.
A reason with spaces must be quoted (at most ${REASON_MAX_LENGTH} characters); a reason that starts with "--" must be
written as --reason=<text>.`;

/** One account as the script prints it: view_admin_users joined with view_admin_user_private (by user id). */
interface AccountLine {
    id: number;
    username: string;
    displayName: string;
    role: string;
    discordId?: string;
    isGuest: boolean;
    pendingDeletion: boolean;
}

/**
 * A228 item 4: the one account `ref` names, read through the two admin views as the delegate; throws (before any
 * reducer call) when none or more than one matches.
 */
async function resolveAccount(conn: any, ref: string): Promise<AccountLine> {
    await subscribeOnly(conn, ['SELECT * FROM view_admin_users'], 'manage-user');
    await subscribeOnly(conn, ['SELECT * FROM view_admin_user_private'], 'manage-user');
    const discordOf = new Map<number, string>();
    for (const p of conn.db.viewAdminUserPrivate.iter()) {
        if (p.loginMethod === 'discord') discordOf.set(p.userId, p.providerId);
    }
    const accounts: AccountLine[] = [...conn.db.viewAdminUsers.iter()].map((u: any) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role.tag,
        discordId: discordOf.get(u.id),
        isGuest: u.isGuest,
        pendingDeletion: u.deletedAt !== undefined,
    }));
    const matches = matchUserReference(accounts, ref);
    if (matches.length === 0) throw new EnvConfigError(`no account matches "${ref}"; nothing was changed.`);
    if (matches.length > 1) {
        throw new EnvConfigError(
            `${matches.length} accounts match "${ref}" (${matches.map((m) => `id:${m.id}`).join(', ')}); name one with id:<n>. Nothing was changed.`,
        );
    }
    return matches[0];
}

/** The account as one block of text. */
function accountText(a: AccountLine): string {
    return [
        `  user id:       ${a.id}`,
        `  username:      ${a.username}`,
        `  display name:  ${a.displayName}`,
        `  role:          ${a.role}`,
        `  Discord id:    ${a.discordId ?? '(none)'}`,
        `  guest:         ${a.isGuest ? 'yes' : 'no'}`,
        `  pending deletion: ${a.pendingDeletion ? 'yes' : 'no'}`,
    ].join('\n');
}

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
    if (USER_COMMANDS.has(action)) {
        const refError = userReferenceError(username);
        if (refError !== null) throw new EnvConfigError(refError);
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
                      : action === 'show'
                        ? `subscribe view_admin_users + view_admin_user_private, print ${username}`
                        : action === 'lowercase-usernames'
                          ? 'server_lowercase_usernames()'
                          : 'subscribe view_admin_suspensions';
        const resolveFirst = USER_COMMANDS.has(action) && action !== 'show'
            ? ' (after resolving and printing the account; the call then names it as id:<n>)'
            : '';
        console.log(
            `[dry-run] ${call}${resolveFirst} on ${backend.dbName} as the delegate (${ENV_KEYS.serverToken} from ${backend.envFile})`,
        );
        return;
    }

    const backend = backendEnvFor(target, { requireToken: true });
    const delegate = await connect({ backend, token: backend.serverToken, label: 'manage-user' });
    // A228 item 4: resolve and print the account first; the reducer then gets its id, never the typed name.
    let ref = '';
    let label = '';
    if (USER_COMMANDS.has(action)) {
        const account = await resolveAccount(delegate.conn, username);
        console.log(`[manage-user] ${backend.dbName}: "${username}" is this account:\n${accountText(account)}`);
        ref = userIdReference(account.id);
        label = `${account.username} (${ref})`;
    }
    if (action === 'show') {
        // printed above; nothing else
    } else if (action === 'set-role') {
        await delegate.conn.reducers.serverSetRole({ username: ref, roleTag: role });
        console.log(`[manage-user] ${backend.dbName}: ${label} role set to ${role}`);
    } else if (action === 'delete') {
        await delegate.conn.reducers.serverDeleteUser({ username: ref });
        console.log(`[manage-user] ${backend.dbName}: ${label} deleted`);
    } else if (action === 'suspend') {
        await delegate.conn.reducers.serverSuspendUser({ username: ref, reason: reason ?? '' });
        console.log(`[manage-user] ${backend.dbName}: ${label} suspended`);
    } else if (action === 'unsuspend') {
        await delegate.conn.reducers.serverLiftSuspension({ username: ref });
        console.log(`[manage-user] ${backend.dbName}: ${label} suspension lifted`);
    } else if (action === 'lowercase-usernames') {
        await delegate.conn.reducers.serverLowercaseUsernames({});
        console.log(`[manage-user] ${backend.dbName}: usernames lowercased (the counts are in the module log)`);
    } else {
        await subscribeOnly(delegate.conn, ['SELECT * FROM view_admin_suspensions'], 'manage-user');
        const rows = [...delegate.conn.db.viewAdminSuspensions.iter()];
        console.log(`[manage-user] ${backend.dbName}: ${rows.length} suspended account(s)`);
        console.log(suspensionTable(rows));
    }
    delegate.close();
});
