import { describe, expect, it } from 'vitest';
import { parseLobbyId, U32_MAX } from './lobbyId';

/* T-M5b: the `$lobbyId` rule (decimal digits within u32, no leading zero, not 0). */

describe('parseLobbyId', () => {
    it.each([
        ['1', 1],
        ['123', 123],
        ['1000000000', 1_000_000_000],
        ['4294967295', U32_MAX],
    ])('keeps %s', (raw, id) => {
        expect(parseLobbyId(raw)).toBe(id);
    });

    it.each([
        '',
        '0',
        '00',
        '007',
        '01',
        '04294967295',
        '4294967296',
        '99999999999',
        '-1',
        '+1',
        '1.5',
        '1e3',
        ' 1',
        '1 ',
        'abc',
        '0x10',
        '١٢',
        '00000000001',
    ])('drops %j', (raw) => {
        expect(parseLobbyId(raw)).toBeUndefined();
    });

    it('drops a non-string', () => {
        expect(parseLobbyId(5)).toBeUndefined();
        expect(parseLobbyId(undefined)).toBeUndefined();
    });
});
