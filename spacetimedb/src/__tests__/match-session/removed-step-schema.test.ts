// Match session: the unused step schema is gone (the ArrangeLineup step kind and payload, MatchSessionStep.anonymousLabel).
// Decisions: A60 (no lineup step), A37 (labels computed at read time)
// Contracts: docs/match-session/contract.md
// From S11a.
//
// T-S11a (triage L39): no reducer wrote an ArrangeLineup step and every step writer left anonymousLabel empty; the view
// computes the actor's seat label at read time. The enum variants (ActionType, StepPayload), the payload struct and the
// column are removed; the anonymized actor still reads a label through view_my_match_steps.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ActionType, AnonymousMatchStepRow, MatchSessionStep, StepPayload } from '@bindings/types';
import { M, captainOf, newHarness, setupLobby, steps, tx } from '../fixtures/harness';
import { view } from '../fixtures/views';
import * as Enums from '@module/types/enums';
import * as Structs from '@module/types/structs';

describe('L39: the ArrangeLineup step kind and the stored step label are removed', () => {
    it('module types: no ArrangeLineup variant in ActionType or StepPayload, no ArrangeLineupPayload struct', () => {
        expect(Object.keys(Enums.ActionType.variants)).not.toContain('ArrangeLineup');
        expect(Object.keys(Structs.StepPayload.variants)).not.toContain('ArrangeLineup');
        expect('ArrangeLineupPayload' in Structs).toBe(false);
    });

    it('bindings: the step row has no anonymousLabel; the tags have no ArrangeLineup', () => {
        expectTypeOf<MatchSessionStep>().not.toHaveProperty('anonymousLabel');
        expectTypeOf<Extract<ActionType['tag'], 'ArrangeLineup'>>().toBeNever();
        expectTypeOf<Extract<StepPayload['tag'], 'ArrangeLineup'>>().toBeNever();
        expectTypeOf<AnonymousMatchStepRow>().toHaveProperty('anonymousLabel'); // the view's computed label stays
    });

    it('a written step row has no anonymousLabel key; an anonymized actor still reads a seat label in the view', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { isAnonymousPlayers: true } });
        // A pause step (any step works): the Blue captain pauses; Red reads the actor as a seat label.
        const blueCaptain = Object.values(s.a).find((a) => a.userId === captainOf(test, s.lobbyId, 'BluePlayer')!.userId)!;
        tx(test, blueCaptain, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        const [pause] = steps(test, s.lobbyId);
        expect(pause.action.tag).toBe('Pause');
        expect('anonymousLabel' in pause).toBe(false);
        const [row] = view<AnonymousMatchStepRow>(test, 'view_my_match_steps', s.a.r1).filter((r) => r.id === pause.id);
        expect(row.actorUserId).toBe(0);
        expect(row.anonymousLabel).toBeTruthy();
    });
});
