import { ENV_KEYS } from '../../shared/stdb-targets';
import { LINK_IDENTITY_KEY } from './_env';

/**
 * S10s (A122(23), L101): the delegate rotation of bootstrap, in the order that keeps sign-in working. Since M5a3 the
 * same rotation also replaces the Linker identity of the auth function (noun 'linker', its own register / revoke
 * reducers and env keys), but only when bootstrapLinker (below) decides to mint one.
 *
 *   1. register the new delegate (as the owner);
 *   2. save its token and identity to `.env.<target>.local`;
 *   3. only then revoke the previous delegate (best effort).
 *
 * A failure in step 1 or 2 throws before anything is revoked, so the previous delegate (and the token the auth
 * function holds) keeps working; a re-run mints another identity and tries again. A failed revoke in step 3 is
 * reported and the rotation still counts as done (the new delegate is registered and saved; the old one can be revoked
 * by the next run or by hand). Pure orchestration: the reducer calls and the file write are injected, so the ordering
 * is unit-tested with fakes (test/backend/scripts/delegate-rotation.unit.test.ts) without contacting a database.
 */
export interface DelegateRotationSteps {
    /** server_register_delegate(freshHex, label) as the owner. */
    register: (identityHex: string, label: string) => Promise<void>;
    /** Writes STDB_SERVER_TOKEN and STDB_SERVER_IDENTITY for this target. */
    save: (token: string, identityHex: string) => void;
    /** server_revoke_delegate(previousHex) as the owner. */
    revoke: (identityHex: string) => Promise<void>;
    log: (line: string) => void;
}

export interface DelegateRotation {
    /** M5a3: what the log lines call the identity ('delegate' when unset; 'linker' for the auth function's identity). */
    noun?: string;
    freshToken: string;
    freshHex: string;
    /** STDB_SERVER_IDENTITY read from the target's file before the rotation, if any. */
    previousHex: string | undefined;
    label: string;
}

export async function rotateDelegate(r: DelegateRotation, steps: DelegateRotationSteps): Promise<void> {
    const noun = r.noun ?? 'delegate';
    await steps.register(r.freshHex, r.label);
    steps.log(`[bootstrap] registered ${noun} "${r.label}"`);

    steps.save(r.freshToken, r.freshHex);
    steps.log(`[bootstrap] saved the new ${noun} token and identity`);

    if (r.previousHex && r.previousHex !== r.freshHex) {
        try {
            await steps.revoke(r.previousHex);
            steps.log(`[bootstrap] revoked previous ${noun} ${r.previousHex}`);
        } catch (err) {
            steps.log(`[bootstrap] previous ${noun} not revoked (${err instanceof Error ? err.message : err})`);
        }
    }
}

// ─── M5a3: the auth function's Linker identity (keep by default) ─────────────────────────────────────────────────────
// The deployed auth function holds STDB_LINK_TOKEN as a Vercel secret. A bootstrap that minted a new linker and revoked
// the old one on every run would break that function until the secret is updated and the function redeployed, so by
// default bootstrap keeps the linker the env file names:
//   keep    the file holds STDB_LINK_IDENTITY and STDB_LINK_TOKEN: server_register_linker(that identity) as the owner.
//           After a wipe this restores it (same identity, the same token keeps working); when it is still registered the
//           module answers "Already registered." and the linker is kept as it is.
//   mint    the file holds no linker (or only half of one): mint a fresh identity, register, save, then revoke the
//           identity the file named, if any (rotateDelegate).
//   rotate  --rotate-linker: the same as mint while a linker exists. The old linker is revoked at the end of the run,
//           so the deployed function cannot present codes until its Vercel secret holds the new STDB_LINK_TOKEN and it is
//           redeployed (the release step in docs/auth/architecture.md).

export type LinkerAction = 'keep' | 'mint' | 'rotate';

/** The refusal of server_register_linker for an identity that already has a ServerIdentity row. */
export const LINKER_ALREADY_REGISTERED_TEXT = 'Already registered.';

/** keep when the file holds both the linker identity and its token, unless --rotate-linker; else mint or rotate. */
export function planLinkerAction(env: Readonly<Record<string, string | undefined>>, rotate: boolean): LinkerAction {
    const hasLinker = Boolean(env[LINK_IDENTITY_KEY]) && Boolean(env[ENV_KEYS.linkToken]);
    if (!hasLinker) return 'mint';
    return rotate ? 'rotate' : 'keep';
}

/** The dry-run line for each action (key names only, never a value). */
export function describeLinkerAction(action: LinkerAction, label: string, envFile: string): string {
    switch (action) {
        case 'keep':
            return `[dry-run] keep the linker named by ${LINK_IDENTITY_KEY} in ${envFile}: register it again as "${label}" (restored after a wipe; "Already registered" means kept); ${ENV_KEYS.linkToken} unchanged`;
        case 'mint':
            return `[dry-run] no linker in ${envFile}: mint a fresh identity, register it as linker "${label}", write ${ENV_KEYS.linkToken}, ${LINK_IDENTITY_KEY}; then revoke the previous ${LINK_IDENTITY_KEY} if present`;
        case 'rotate':
            return `[dry-run] --rotate-linker: mint a fresh identity, register it as linker "${label}", write ${ENV_KEYS.linkToken}, ${LINK_IDENTITY_KEY}; then revoke the previous linker (the deployed function stops signing in until its secret is updated and it is redeployed)`;
    }
}

/** The two owner reducers the linker step calls (the generated `owner.conn.reducers` fits). */
export interface LinkerReducers {
    serverRegisterLinker: (args: { identityHex: string; label: string }) => Promise<unknown>;
    serverRevokeLinker: (args: { identityHex: string }) => Promise<unknown>;
}

export interface LinkerBootstrap {
    /** The target's env file as read before this step. */
    env: Readonly<Record<string, string | undefined>>;
    rotate: boolean;
    label: string;
    reducers: LinkerReducers;
    /** A token-less connection's fresh identity and token. */
    mint: () => Promise<{ token: string; identityHex: string }>;
    /** Upserts the given keys into the target's env file. */
    writeEnv: (values: Record<string, string>) => void;
    log: (line: string) => void;
}

/** Runs the linker step of bootstrap (see the header above); returns the action taken. Never logs the token. */
export async function bootstrapLinker(b: LinkerBootstrap): Promise<LinkerAction> {
    const action = planLinkerAction(b.env, b.rotate);
    if (action === 'keep') {
        const identityHex = b.env[LINK_IDENTITY_KEY] as string;
        try {
            await b.reducers.serverRegisterLinker({ identityHex, label: b.label });
            b.log(`[bootstrap] linker ${identityHex} registered again (restored after a wipe); ${ENV_KEYS.linkToken} unchanged`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!message.includes(LINKER_ALREADY_REGISTERED_TEXT)) throw err;
            b.log(`[bootstrap] kept the registered linker ${identityHex}; ${ENV_KEYS.linkToken} unchanged`);
        }
        return action;
    }
    const fresh = await b.mint();
    b.log(`[bootstrap] minted linker identity: ${fresh.identityHex}`);
    await rotateDelegate(
        { noun: 'linker', freshToken: fresh.token, freshHex: fresh.identityHex, previousHex: b.env[LINK_IDENTITY_KEY], label: b.label },
        {
            register: async (identityHex, label) => {
                await b.reducers.serverRegisterLinker({ identityHex, label });
            },
            save: (token, identityHex) => {
                b.writeEnv({ [ENV_KEYS.linkToken]: token, [LINK_IDENTITY_KEY]: identityHex });
                b.log(`[bootstrap] wrote ${ENV_KEYS.linkToken} and ${LINK_IDENTITY_KEY}`);
            },
            revoke: async (identityHex) => {
                await b.reducers.serverRevokeLinker({ identityHex });
            },
            log: b.log,
        },
    );
    if (action === 'rotate') {
        b.log(`[bootstrap] linker rotated: set the new ${ENV_KEYS.linkToken} as the Vercel function secret and redeploy`);
    }
    return action;
}
