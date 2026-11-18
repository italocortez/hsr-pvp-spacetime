// Identity: where the module may read the caller's identity (`ctx.sender`) itself, pinned as an allow-list.
// Decisions: A195, A213, A214 (a suspended account reads nothing of its own and writes nothing)
// Contracts: docs/suspension/contract.md
// From suspension-s1 (fix pass, review S2).
//
// T-suspension-s1 (S2): the no-read and no-write rules hold because every view resolves its caller through
// callerUserId / callerMapping / staffCaller (helpers/identity/viewAnonymity.ts) and every user reducer through
// getAuthenticatedUser (helpers/identity/ensurePermissions.ts), both of which treat a suspended account as refused.
// The behaviour tests sample views and reducers; this test reads the module source and fails when a file under
// views/, helpers/ or reducers/ reads `.sender` anywhere that is not on the list below, so a new view or reducer that
// resolves its caller itself is caught. Comment lines are ignored; `senderAuth` (the scheduler guard) is not a read
// of the caller. The sources are read through Vite's import.meta.glob (raw text, keys with forward slashes on every
// platform; the module's tsconfig carries no Node types). Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';

declare global {
    interface ImportMeta {
        glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
    }
}

/** Source text by path relative to src (`views/identityViews.ts`); the glob keys start with `../../`. */
const SOURCES: Record<string, string> = Object.fromEntries(
    Object.entries({
        ...import.meta.glob('../../views/**/*.ts', { query: '?raw', import: 'default', eager: true }),
        ...import.meta.glob('../../helpers/**/*.ts', { query: '?raw', import: 'default', eager: true }),
        ...import.meta.glob('../../reducers/**/*.ts', { query: '?raw', import: 'default', eager: true }),
    }).map(([key, text]) => [key.replace(/\\/g, '/').replace(/^(\.\.\/)+/, ''), text]),
);

/** The `.sender` reads of one file, as trimmed code lines (one entry per read), comment lines left out. */
function senderReads(file: string): string[] {
    const reads: string[] = [];
    for (const raw of SOURCES[file].split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        const code = line.replace(/\s\/\/.*$/, ''); // a trailing comment
        for (const _ of code.matchAll(/\.sender\b/g)) reads.push(code);
    }
    return reads;
}

/**
 * The allow-list: file -> how many `.sender` reads it may hold, and why each is safe. A read that resolves a user goes
 * through a suspension check in the same function; the others never resolve a user.
 */
const ALLOWED: Record<string, { reads: number; why: string }> = {
    // views
    'views/identityViews.ts': {
        reads: 2,
        why: 'view_my_link_request reads its LinkRequest row, then callerUserId (nothing for a suspended caller); '
            + 'view_my_suspension must answer the suspended caller (user id only).',
    },
    // helpers/identity: the shared guards and two non-user reads
    'helpers/identity/viewAnonymity.ts': { reads: 1, why: 'callerMapping: the one caller resolution of every view.' },
    'helpers/identity/ensurePermissions.ts': { reads: 1, why: 'getAuthenticatedUser: the one caller resolution of user reducers.' },
    'helpers/identity/anonymousHelpers.ts': {
        reads: 1,
        why: 'shouldAnonymize: reached only from views that already returned nothing for a suspended caller (callerMemberships).',
    },
    'helpers/identity/linkCode.ts': { reads: 1, why: 'the identity bytes mixed into a link code; no user is resolved.' },
    'helpers/identity/serverIdentities.ts': { reads: 1, why: 'requireLinker: the Linker identity, never a user.' },
    // reducers that resolve the caller themselves, each with its own suspension check, or a server gate
    'reducers/identity/auth.ts': {
        reads: 11,
        why: 'login_as_guest, request_link_code, confirm_link: each checks the suspension before maintenance.',
    },
    'reducers/identity/profile.ts': { reads: 4, why: 'resolveUser (suspension first) and delete_my_account behind it.' },
    'reducers/lobby/cursor.ts': { reads: 1, why: 'broadcast_cursor: a suspended member is dropped silently.' },
    'reducers/identity/server.ts': { reads: 1, why: 'requireServer: a server identity, never a user.' },
    'reducers/identity/identityGc.ts': { reads: 1, why: 'a server gate (trustedServerRow), never a user.' },
    'reducers/lobby/lobbyGc.ts': { reads: 1, why: 'a server gate (trustedServerRow), never a user.' },
    'reducers/admin/admin.ts': { reads: 2, why: 'the identity in a refusal log line, after ensureAdmin.' },
};

const HOW_TO_FIX =
    'Resolve the caller through the shared helpers instead: callerUserId / callerMapping / staffCaller '
    + '(helpers/identity/viewAnonymity.ts) in a view, getAuthenticatedUser or an ensure* helper '
    + '(helpers/identity/ensurePermissions.ts) in a reducer, so a suspended account reads and writes nothing. '
    + 'If the read is deliberate and safe (it checks the suspension itself, or resolves no user), add the file to '
    + 'ALLOWED in spacetimedb/src/__tests__/identity/suspension-structure.test.ts with the reason.';

const SCANNED = Object.keys(SOURCES).sort();

describe('the caller is resolved only through the shared guards (suspension-s1, review S2)', () => {
    it('the scan finds the module files', () => {
        expect(SCANNED.length).toBeGreaterThan(50);
        expect(SCANNED).toContain('views/identityViews.ts');
        expect(SCANNED).toContain('helpers/identity/ensurePermissions.ts');
        expect(SCANNED).toContain('reducers/identity/auth.ts');
    });

    it('no file under views/, helpers/ or reducers/ reads .sender outside the allow-list', () => {
        const problems: string[] = [];
        for (const file of SCANNED) {
            const reads = senderReads(file);
            const allowed = ALLOWED[file]?.reads ?? 0;
            if (reads.length > allowed) {
                problems.push(
                    `${file}: ${reads.length} read(s) of .sender, ${allowed} allowed:\n    ${reads.join('\n    ')}`,
                );
            }
        }
        expect(problems, problems.length ? `${problems.join('\n')}\n${HOW_TO_FIX}` : '').toEqual([]);
    });

    it('every allow-list entry still matches (a removed read shrinks the list)', () => {
        const stale: string[] = [];
        for (const [file, { reads }] of Object.entries(ALLOWED)) {
            const found = SCANNED.includes(file) ? senderReads(file).length : -1;
            if (found !== reads) stale.push(`${file}: allowed ${reads}, found ${found === -1 ? 'no file' : found}`);
        }
        expect(stale, `update ALLOWED in this test to the current counts:\n${stale.join('\n')}`).toEqual([]);
    });
});
