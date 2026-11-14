/**
 * T-M5b (fix pass, item 9): the handle the confirm panel shows is `view_my_link_request`
 * .pendingProviderName, which `linker_present_code` writes through the module's
 * `cleanProviderName`. Does that clean-up remove bidi override and isolate characters, so a
 * handle cannot reorder the confirm line? Read-only check of the module helper; nothing changes.
 */
import { describe, expect, it } from 'vitest';
import { cleanProviderName } from '@module/helpers/identity/providerLink';

describe('cleanProviderName and bidi controls', () => {
    it.each([
        ['U+202A LRE', '\u202A'],
        ['U+202B RLE', '\u202B'],
        ['U+202C PDF', '\u202C'],
        ['U+202D LRO', '\u202D'],
        ['U+202E RLO', '\u202E'],
        ['U+2066 LRI', '\u2066'],
        ['U+2067 RLI', '\u2067'],
        ['U+2068 FSI', '\u2068'],
        ['U+2069 PDI', '\u2069'],
        ['U+200E LRM', '\u200E'],
        ['U+200F RLM', '\u200F'],
        ['U+061C ALM', '\u061C'],
    ])('removes %s', (_label, ch) => {
        expect(cleanProviderName(`kaf${ch}ka${ch}_handle`)).toBe('kafka_handle');
    });

    it('a right-to-left override cannot reverse the rest of the line', () => {
        const spoof = 'admin\u202Eeldnah_\u202C';
        const cleaned = cleanProviderName(spoof);
        expect(cleaned).toBe('admineldnah_');
        expect(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/.test(cleaned)).toBe(false);
    });

    it('plain right-to-left letters stay (they are a name, not a control)', () => {
        expect(cleanProviderName('שלום')).toBe('שלום');
    });
});
