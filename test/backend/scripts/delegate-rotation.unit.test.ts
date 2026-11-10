// T-S10s (DECISIONS.md A122(23), triage L101): scripts/stdb/_delegate.ts rotateDelegate, the delegate rotation of
// bootstrap. The new delegate is registered and its token saved before the old delegate is revoked; a failure in between
// leaves the old delegate working. Fakes only: the script is not run and nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { rotateDelegate, type DelegateRotationSteps } from '../../../scripts/stdb/_delegate';

const ROTATION = { freshToken: 'tok-new', freshHex: 'new-hex', previousHex: 'old-hex', label: 'vercel-auth-test' };

/** Fake steps recording the order of calls; `fail` names the step that throws. */
function fakes(fail?: 'register' | 'save' | 'revoke') {
    const calls: string[] = [];
    const steps: DelegateRotationSteps = {
        register: async (hex, label) => {
            calls.push(`register ${hex} ${label}`);
            if (fail === 'register') throw new Error('register failed');
        },
        save: (token, hex) => {
            calls.push(`save ${token} ${hex}`);
            if (fail === 'save') throw new Error('disk full');
        },
        revoke: async (hex) => {
            calls.push(`revoke ${hex}`);
            if (fail === 'revoke') throw new Error('already revoked');
        },
        log: () => {},
    };
    return { calls, steps };
}

describe('A122(23) L101: bootstrap registers and saves the new delegate before revoking the old one', () => {
    it('A122(23) L101: the order is register, save, revoke', async () => {
        const { calls, steps } = fakes();
        await rotateDelegate(ROTATION, steps);
        expect(calls).toEqual(['register new-hex vercel-auth-test', 'save tok-new new-hex', 'revoke old-hex']);
    });

    it('A122(23) L101: a failed registration or a failed save throws before the old delegate is revoked', async () => {
        for (const fail of ['register', 'save'] as const) {
            const { calls, steps } = fakes(fail);
            await expect(rotateDelegate(ROTATION, steps)).rejects.toThrow();
            expect(calls.some((c) => c.startsWith('revoke')), fail).toBe(false);
        }
    });

    it('A122(23) L101 (neighbour): a failed revoke is reported, not thrown; no previous delegate, or the same identity, means no revoke', async () => {
        const failing = fakes('revoke');
        await expect(rotateDelegate(ROTATION, failing.steps)).resolves.toBeUndefined();
        expect(failing.calls).toHaveLength(3);
        for (const previousHex of [undefined, 'new-hex']) {
            const { calls, steps } = fakes();
            await rotateDelegate({ ...ROTATION, previousHex }, steps);
            expect(calls).toEqual(['register new-hex vercel-auth-test', 'save tok-new new-hex']);
        }
    });
});
