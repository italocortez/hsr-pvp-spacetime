import { describe, expect, it } from 'vitest';
import { differences } from './differences';

// T-S14.3c-sync (second review N5): what differs between the two copies of a held loadout.

const c = (code: string, name = 'Hyper', note = '') => ({ name, note, code });

describe('differences', () => {
    it('equal copies: nothing', () => {
        expect(
            differences(
                c('1.acheron-0._._._.as-c-0-3000-1500'),
                c('1.acheron-0._._._.as-c-0-3000-1500'),
            ),
        ).toEqual([]);
    });

    it('two copies with the same name and the same count still differ by who is in them', () => {
        expect(
            differences(
                c('1.acheron-0.pela-6._._.as-c-0-3000-1500'),
                c('1.acheron-0.clara-0._._.as-c-0-3000-1500'),
            ),
        ).toEqual([{ kind: 'members', mine: ['acheron', 'pela'], theirs: ['acheron', 'clara'] }]);
    });

    it('name and note', () => {
        expect(
            differences(
                c('1._._._._.as-c-0-3000-1500', 'A', 'x'),
                c('1._._._._.as-c-0-3000-1500', 'B', 'y'),
            ),
        ).toEqual([{ kind: 'name', mine: 'A', theirs: 'B' }, { kind: 'note' }]);
    });

    it('the same members: order, light cones, eidolons', () => {
        expect(
            differences(
                c('1.acheron-0.pela-6._._.as-c-0-3000-1500'),
                c('1.pela-6.acheron-0._._.as-c-0-3000-1500'),
            ),
        ).toEqual([{ kind: 'order' }]);
        expect(
            differences(
                c('1.acheron-0._._._.as-c-0-3000-1500'),
                c('1.acheron-2._._._.as-c-0-3000-1500'),
            ),
        ).toEqual([{ kind: 'levels' }]);
    });

    it('modes and Auction budgets', () => {
        const d = differences(
            c('1.acheron-0._._._.as-c-0-3000-1500'),
            c('1.acheron-0._._._.aa-a-0-2000-1500'),
        );
        expect(d.map((x) => x.kind)).toEqual(['modes', 'auction']);
        expect(d[0]).toEqual({
            kind: 'modes',
            mine: { gameMode: 'as', draftMode: 'classic', costSetId: 0 },
            theirs: { gameMode: 'aa', draftMode: 'auction', costSetId: 0 },
        });
    });
});
