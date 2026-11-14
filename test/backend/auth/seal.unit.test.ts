/**
 * T-M5b: the sealed OAuth state (api/_lib/seal.ts): AES-256-GCM, key by HKDF from AUTH_SECRET.
 */
import { describe, expect, it } from 'vitest';
import { seal, unseal } from '../../../api/_lib/seal';
import { AUTH_SECRET, LINK_CODE } from './auth-fixtures';

const NOW = 1_800_000_000_000;
const TEN_MIN = 600_000;
const payload = { state: 'S'.repeat(43), linkCode: LINK_CODE, createdAt: NOW };

describe('seal / unseal', () => {
    it('round trip returns the same payload', () => {
        const sealed = seal(payload, AUTH_SECRET);
        expect(unseal(sealed, AUTH_SECRET, NOW + 1000, TEN_MIN)).toEqual({ ok: true, payload });
    });

    it('the sealed value does not contain the link code or the state, in any common encoding', () => {
        const sealed = seal(payload, AUTH_SECRET);
        expect(sealed.startsWith('v1.')).toBe(true);
        const decoded = Buffer.from(sealed.slice(3), 'base64url').toString('latin1');
        for (const text of [sealed, decoded]) {
            expect(text).not.toContain(LINK_CODE);
            expect(text).not.toContain(payload.state);
        }
    });

    it('a fresh IV each time: two seals of one payload differ', () => {
        expect(seal(payload, AUTH_SECRET)).not.toBe(seal(payload, AUTH_SECRET));
    });

    it('a tampered byte is refused as invalid', () => {
        const sealed = seal(payload, AUTH_SECRET);
        const bytes = Buffer.from(sealed.slice(3), 'base64url');
        bytes[20] = (bytes[20] ?? 0) ^ 1;
        const tampered = `v1.${bytes.toString('base64url')}`;
        expect(unseal(tampered, AUTH_SECRET, NOW, TEN_MIN)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('another key is refused as invalid', () => {
        const sealed = seal(payload, AUTH_SECRET);
        expect(unseal(sealed, `${AUTH_SECRET}-other`, NOW, TEN_MIN)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('older than the max age is expired; exactly at the limit is accepted', () => {
        const sealed = seal(payload, AUTH_SECRET);
        expect(unseal(sealed, AUTH_SECRET, NOW + TEN_MIN, TEN_MIN).ok).toBe(true);
        expect(unseal(sealed, AUTH_SECRET, NOW + TEN_MIN + 1, TEN_MIN)).toEqual({ ok: false, reason: 'expired' });
    });

    it('a state created more than a minute in the future is expired (clock skew)', () => {
        const sealed = seal({ ...payload, createdAt: NOW + 61_000 }, AUTH_SECRET);
        expect(unseal(sealed, AUTH_SECRET, NOW, TEN_MIN)).toEqual({ ok: false, reason: 'expired' });
    });

    it.each([
        ['no prefix', 'abc'],
        ['not base64url', 'v1.@@@'],
        ['too short', 'v1.AAAA'],
        ['empty', ''],
    ])('a malformed value (%s) is refused before decryption', (_label, value) => {
        expect(unseal(value, AUTH_SECRET, NOW, TEN_MIN)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('a sealed payload with a bad link code is refused as invalid', () => {
        const sealed = seal({ ...payload, linkCode: 'short' }, AUTH_SECRET);
        expect(unseal(sealed, AUTH_SECRET, NOW, TEN_MIN)).toEqual({ ok: false, reason: 'invalid' });
    });
});
