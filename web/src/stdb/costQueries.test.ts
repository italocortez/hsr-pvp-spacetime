import { tables } from '@bindings/index';
import { toSql } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { costQueries, costQueryList, DEFAULT_COST_SET_ID, isCostSetId } from './costQueries';
import { DEFAULT_COST_QUERIES, REFERENCE_QUERIES } from './referenceSet';

/*
 * T-COSTS: the reference set and the cost-set queries are plain SQL text (so a page chunk does
 * not pull the SDK in); this pins that text to what the installed SDK's query builder writes for
 * the generated bindings.
 */

describe('cost set queries', () => {
    it.each([0, 1, 42, 4294967295])(
        'set %i: the same SQL as toSql(tables.x.where(r => r.costSetId.eq(id)))',
        (id) => {
            const q = costQueries(id);
            expect(q.characters).toBe(
                toSql(tables.hsrCharacterCost.where((r) => r.costSetId.eq(id))),
            );
            expect(q.lightcones).toBe(
                toSql(tables.hsrLightconeCost.where((r) => r.costSetId.eq(id))),
            );
            expect(q.synergies).toBe(toSql(tables.hsrSynergyCost.where((r) => r.costSetId.eq(id))));
        },
    );

    it('the generated SQL text of the default set', () => {
        expect(costQueryList(DEFAULT_COST_SET_ID)).toEqual([
            'SELECT * FROM "hsr_character_cost" WHERE "hsr_character_cost"."cost_set_id" = 0',
            'SELECT * FROM "hsr_lightcone_cost" WHERE "hsr_lightcone_cost"."cost_set_id" = 0',
            'SELECT * FROM "hsr_synergy_cost" WHERE "hsr_synergy_cost"."cost_set_id" = 0',
        ]);
        expect(DEFAULT_COST_QUERIES).toEqual(costQueryList(0));
    });

    it('a custom set and the default set never share a query (no "0 OR N")', () => {
        const zero = new Set(costQueryList(0));
        for (const q of costQueryList(7)) {
            expect(zero.has(q)).toBe(false);
            expect(q).not.toMatch(/\bOR\b/);
            expect(q).toMatch(/= 7$/);
        }
    });

    it.each([-1, 1.5, 4294967296, Number.NaN, Number.POSITIVE_INFINITY])(
        'refuses %s (not a u32 cost set id)',
        (id) => {
            expect(isCostSetId(id)).toBe(false);
            expect(() => costQueries(id)).toThrow();
        },
    );

    it('the base reference queries are the SDK text for the five sources', () => {
        expect(REFERENCE_QUERIES).toEqual([
            toSql(tables.hsrCharacter),
            toSql(tables.hsrLightcone),
            toSql(tables.archetype),
            toSql(tables.hsrCharacterArchetype),
            toSql(tables.viewPublishedCostSets),
        ]);
    });
});
