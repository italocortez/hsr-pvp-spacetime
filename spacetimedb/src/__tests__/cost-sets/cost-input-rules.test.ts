// Cost sets: edit_draft_*_cost input rules and a synergy naming an unknown character.
// Contracts: docs/cost-sets/contract.md
// From S10f, S10c (s10f-draft-results.test.ts, s10c-high-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import { M, newBareHarness, newHarness, tx } from '../fixtures/harness';
import { host as tournamentHost } from '../fixtures/tournament-builders';
import {
    E,
    S,
    bulkUpsert,
    costSetId,
    draftChar,
    draftLc,
    draftSyn,
    eCost,
    liveSyn,
    sCost,
    synergyRow,
} from '../fixtures/achievement-auth-cost-builders';
import {
    rejection,
    seedCharacters,
    seedReferenceNames,
} from '../fixtures/calendar-roster-rating-builders';
import characterSeed from '../../../../data/seed/characters.json';
import synergySeed from '../../../../data/seed/synergies.json';

describe('Roster #9: edit_draft_*_cost input rules (cost-sets architecture S10f)', () => {
    const MOC = 'MemoryOfChaos';
    function draftSet() {
        const test = newBareHarness(); // T-S10i fix pass (review F2): set 0 holds no rows, nothing is cloned
        seedReferenceNames(test, ['kafka', 'pela'], ['patience']);
        const org = tournamentHost(test);
        tx(test, org, (ctx) => M.create_cost_set(ctx, { name: 'rules', sourceSetId: 0, gameModeTag: MOC }));
        return { test, org, id: costSetId(test, 'rules') };
    }
    const fieldMsg = (k: string) => `costsJson field "${k}" must be a number between 0 and 100000.`;
    const MODIFIER = 'costModifier must be a number between -100000 and 100000.';
    const WRONG_MODE = 'This cost set is for MemoryOfChaos; gameModeTag must be MemoryOfChaos.';
    const BAD_DRAFT_MODE = 'Invalid draftModeTag. Must be one of: Classic, Auction';
    const eJson = (over: Record<string, unknown>) => JSON.stringify({ e0: 1, e1: 1, e2: 1, e3: 1, e4: 1, e5: 1, e6: 1, ...over });
    const sJson = (over: Record<string, unknown>) => JSON.stringify({ s1: 1, s2: 1, s3: 1, s4: 1, s5: 1, ...over });

    it('character costs: Infinity, negative and above 100000 rejected; NaN is no JSON; 0 and 100000 pass (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const edit = (costsJson: string, characterName = 'kafka') => (ctx: any) =>
            M.edit_draft_character_cost(ctx, { costSetId: id, characterName, gameModeTag: MOC, draftModeTag: 'Classic', costsJson });
        const msgs = [
            rejection(test, org, edit('{"e0":1e999,"e1":1,"e2":1,"e3":1,"e4":1,"e5":1,"e6":1}')),
            rejection(test, org, edit(eJson({ e3: -1 }))),
            rejection(test, org, edit(eJson({ e6: 100_001 }))),
            rejection(test, org, edit('{"e0":NaN,"e1":1,"e2":1,"e3":1,"e4":1,"e5":1,"e6":1}')),
        ];
        expect(draftChar(test, id).filter((r) => r.characterName === 'kafka')).toHaveLength(0);
        expect(msgs).toEqual([fieldMsg('e0'), fieldMsg('e3'), fieldMsg('e6'), 'costsJson must be a valid JSON object.']);
        tx(test, org, edit(eJson({ e0: 0, e6: 100_000 })));
        expect(draftChar(test, id).find((r) => r.characterName === 'kafka')!.costs).toEqual({ ...eCost(1), e0: 0, e6: 100_000 });
    });

    it('light-cone costs: the same bounds (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const edit = (costsJson: string) => (ctx: any) =>
            M.edit_draft_lightcone_cost(ctx, { costSetId: id, lightconeName: 'patience', gameModeTag: MOC, draftModeTag: 'Classic', costsJson });
        const msgs = [
            rejection(test, org, edit('{"s1":1e999,"s2":1,"s3":1,"s4":1,"s5":1}')),
            rejection(test, org, edit(sJson({ s2: -0.5 }))),
            rejection(test, org, edit(sJson({ s5: 100_000.5 }))),
        ];
        expect(draftLc(test, id).filter((r) => r.lightconeName === 'patience')).toHaveLength(0);
        expect(msgs).toEqual([fieldMsg('s1'), fieldMsg('s2'), fieldMsg('s5')]);
    });

    it('synergy modifier: NaN, ±Infinity and |value| > 100000 rejected; -100000 and 100000 pass (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const edit = (costModifier: number, draftModeTag = 'Classic') => (ctx: any) =>
            M.edit_draft_synergy_cost(ctx, { costSetId: id, sourceName: 'kafka', targetName: 'pela', gameModeTag: MOC, draftModeTag, costModifier });
        const msgs = [NaN, Infinity, -Infinity, 100_001, -100_001].map((v) => rejection(test, org, edit(v)));
        expect(draftSyn(test, id)).toHaveLength(0);
        expect(msgs).toEqual(Array(5).fill(MODIFIER));
        tx(test, org, edit(-100_000));
        tx(test, org, edit(100_000, 'Auction'));
        expect(draftSyn(test, id).map((r) => [r.draftMode.tag, r.costModifier]).sort()).toEqual([['Auction', 100_000], ['Classic', -100_000]]);
    });

    it('unknown character / light-cone names are rejected (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const charMsg = rejection(test, org, (ctx) =>
            M.edit_draft_character_cost(ctx, { costSetId: id, characterName: 'nobody', gameModeTag: MOC, draftModeTag: 'Classic', costsJson: E(1) }));
        const lcMsg = rejection(test, org, (ctx) =>
            M.edit_draft_lightcone_cost(ctx, { costSetId: id, lightconeName: 'no-cone', gameModeTag: MOC, draftModeTag: 'Classic', costsJson: S(1) }));
        expect([draftChar(test, id).filter((r) => r.characterName === 'nobody'), draftLc(test, id).filter((r) => r.lightconeName === 'no-cone')].map((r) => r.length)).toEqual([0, 0]);
        expect([charMsg, lcMsg]).toEqual(['Character nobody not found.', 'Light cone no-cone not found.']);
    });

    it('a game-mode tag other than the set\'s, an unknown game-mode tag and an unknown draft-mode tag are rejected, for all three reducers (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const calls = (gameModeTag: string, draftModeTag: string): Array<(ctx: any) => unknown> => [
            (ctx) => M.edit_draft_character_cost(ctx, { costSetId: id, characterName: 'kafka', gameModeTag, draftModeTag, costsJson: E(1) }),
            (ctx) => M.edit_draft_lightcone_cost(ctx, { costSetId: id, lightconeName: 'patience', gameModeTag, draftModeTag, costsJson: S(1) }),
            (ctx) => M.edit_draft_synergy_cost(ctx, { costSetId: id, sourceName: 'kafka', targetName: 'pela', gameModeTag, draftModeTag, costModifier: 1 }),
        ];
        const wrong = calls('ApocalypticShadow', 'Classic').map((c) => rejection(test, org, c));
        const unknown = calls('Nope', 'Classic').map((c) => rejection(test, org, c));
        const badDraft = calls(MOC, 'Draft').map((c) => rejection(test, org, c));
        expect([draftChar(test, id), draftLc(test, id), draftSyn(test, id)].map((r) => r.length)).toEqual([0, 0, 0]); // set 0 is empty here: nothing cloned
        expect(wrong).toEqual(Array(3).fill(WRONG_MODE));
        for (const m of unknown) expect(m).toMatch(/^Invalid gameModeTag\. Must be one of: /);
        expect(badDraft).toEqual(Array(3).fill(BAD_DRAFT_MODE));
    });

    it('a valid edit is stored with only the documented fields (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        tx(test, org, (ctx) => M.edit_draft_character_cost(ctx, {
            costSetId: id, characterName: 'kafka', gameModeTag: MOC, draftModeTag: 'Auction', costsJson: eJson({ e2: 7, extra: 99, note: 'x' }),
        }));
        tx(test, org, (ctx) => M.edit_draft_lightcone_cost(ctx, {
            costSetId: id, lightconeName: 'patience', gameModeTag: MOC, draftModeTag: 'Auction', costsJson: sJson({ s3: 4, bonus: 1 }),
        }));
        const c = draftChar(test, id).find((r) => r.characterName === 'kafka')!;
        expect(c.costs).toEqual({ ...eCost(1), e2: 7 });
        expect(Object.keys(c.costs).sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
        const l = draftLc(test, id).find((r) => r.lightconeName === 'patience')!;
        expect(l.costs).toEqual({ ...sCost(1), s3: 4 });
        expect(Object.keys(l.costs).sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Roster finding 1 (brief "finding 9"): synergy names must be HsrCharacter rows
// ════════════════════════════════════════════════════════════════════════════

describe('audit roster finding 1: a synergy naming an unknown character is rejected', () => {
    it('admin_bulk_upsert(HsrSynergyCost) rejects a pair with an unknown name; no row is written (finding 9)', () => {
        const test = newHarness();
        seedCharacters(test, ['kafka']);
        const msg = rejection(test, 'internal', (ctx) => M.admin_bulk_upsert(ctx, {
            tableName: 'HsrSynergyCost', jsonData: JSON.stringify([synergyRow('kafka', 'trailblaizerharmony', 'Classic', 1)]),
        }));
        expect([...test.db.HsrSynergyCost.iter()]).toHaveLength(0);
        expect(msg).toBe('Character trailblaizerharmony not found.');
        // Both names known: accepted.
        seedCharacters(test, ['trailblazerharmony']);
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('kafka', 'trailblazerharmony', 'Classic', 1)]);
        expect([...test.db.HsrSynergyCost.iter()]).toHaveLength(1);
    });

    it('edit_draft_synergy_cost rejects an unknown name; no draft row is written (finding 9)', () => {
        const test = newHarness();
        seedCharacters(test, ['kafka']);
        tx(test, 'internal', (ctx) => M.create_cost_set(ctx, { name: 'syn', sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
        const id = costSetId(test, 'syn');
        const edit = (targetName: string) => (ctx: any) => M.edit_draft_synergy_cost(ctx, {
            costSetId: id, sourceName: 'kafka', targetName, gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic', costModifier: 1,
        });
        const msg = rejection(test, 'internal', edit('nobody'));
        expect(draftSyn(test, id)).toHaveLength(0);
        expect(liveSyn(test, id)).toHaveLength(0);
        expect(msg).toBe('Character nobody not found.');
    });

    it('every name in data/seed/synergies.json exists in data/seed/characters.json (finding 9)', () => {
        const names = new Set((characterSeed as Array<{ name: string }>).map((c) => c.name));
        const unknown = (synergySeed as Array<{ source_name: string; target_name: string }>)
            .flatMap((p) => [p.source_name, p.target_name])
            .filter((n) => !names.has(n));
        expect(unknown).toEqual([]);
    });
});
