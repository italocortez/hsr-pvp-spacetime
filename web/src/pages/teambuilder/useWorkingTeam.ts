import {
    type Budgets,
    decodeTeam,
    encodeTeam,
    type Slot,
    type Slots,
    swapSlots,
    type Team,
    withSlot,
} from '@shared/teambuilder';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    clearPrevious,
    draftUnreadable,
    readDraft,
    readDraftTeam,
    readPrevious,
    writeDraft,
    writePrevious,
} from './teamStorage';

/*
 * The working team (S14.3a): the four slots and the Auction budgets. It starts from a packed team in the address
 * when the page was opened with one (a share link, decoded once on arrival), otherwise from the draft in browser
 * storage, otherwise empty; every change is written back to storage (`teamStorage.ts`). The draft mode, game mode
 * and cost set are the address's (the page passes them in for the stored text).
 *
 * A link that replaces a different, non-empty working team keeps that team as the previous team (review S3): the
 * page offers "Restore my previous team" until it is restored or the notice is dismissed, across reloads too, and
 * further links in the meantime do not replace it (review 2 S4).
 */

export type Arrival =
    /** No team in the address. */
    | { kind: 'none' }
    /** A team that decoded: loaded; its settings go to the address. */
    | { kind: 'loaded'; team: Team }
    /** A team that did not decode: ignored, with a notice. */
    | { kind: 'invalid' };

type State = { slots: Slots; budgets: Budgets; arrival: Arrival; previous: Team | null };

/** Same slots and budgets (the modes aside): the packed texts under one set of settings are equal. */
function sameTeam(a: Pick<Team, 'slots' | 'budgets'>, b: Pick<Team, 'slots' | 'budgets'>) {
    const settings = { draftMode: 'classic', gameMode: 'as', costSetId: 0 } as const;
    const ea = encodeTeam({ ...settings, slots: a.slots, budgets: a.budgets });
    const eb = encodeTeam({ ...settings, slots: b.slots, budgets: b.budgets });
    return ea.ok && eb.ok && ea.code === eb.code;
}

function initial(teamParam: string | undefined): State {
    if (teamParam !== undefined) {
        const decoded = decodeTeam(teamParam);
        if (decoded.ok) {
            const saved = readDraftTeam();
            let previous = readPrevious();
            // A kept previous team stays until it is restored or dismissed: a second link in a row must not put
            // the first link's team in its place (review 2 S4).
            if (
                !previous &&
                saved?.slots.some((s) => s !== null) &&
                !sameTeam(saved, decoded.team)
            ) {
                writePrevious(saved);
                previous = saved;
            }
            return {
                slots: decoded.team.slots,
                budgets: decoded.team.budgets,
                arrival: { kind: 'loaded', team: decoded.team },
                previous,
            };
        }
        return { ...readDraft(), arrival: { kind: 'invalid' }, previous: readPrevious() };
    }
    return { ...readDraft(), arrival: { kind: 'none' }, previous: readPrevious() };
}

export function useWorkingTeam(
    teamParam: string | undefined,
    settings: Pick<Team, 'draftMode' | 'gameMode' | 'costSetId'>,
) {
    // Read once: the address's team is used on arrival only (the page then removes it).
    const [state, setState] = useState<State>(() => initial(teamParam));
    const { slots, budgets, previous } = state;
    // A stored draft this build cannot read is not overwritten until the team changes (review 2 M7): the start's
    // slots and budgets, while they are still the ones in use.
    const untouched = useRef<Pick<State, 'slots' | 'budgets'> | null>(null);
    const checked = useRef(false);
    if (!checked.current) {
        checked.current = true;
        if (state.arrival.kind !== 'loaded' && draftUnreadable())
            untouched.current = { slots: state.slots, budgets: state.budgets };
    }

    const { draftMode, gameMode, costSetId } = settings;
    useEffect(() => {
        const start = untouched.current;
        if (start) {
            if (start.slots === slots && start.budgets === budgets) return;
            untouched.current = null;
        }
        writeDraft({ slots, budgets, draftMode, gameMode, costSetId });
    }, [slots, budgets, draftMode, gameMode, costSetId]);

    const update = useCallback((next: (slots: Slots) => Slots) => {
        setState((s) => ({ ...s, slots: next(s.slots) }));
    }, []);

    return {
        slots,
        budgets,
        arrival: state.arrival,
        /** The team a link replaced, while it can still be restored. */
        previous,
        setSlot: useCallback(
            (index: number, slot: Slot) => update((s) => withSlot(s, index, slot)),
            [update],
        ),
        swap: useCallback((a: number, b: number) => update((s) => swapSlots(s, a, b)), [update]),
        clear: useCallback(() => update(() => [null, null, null, null]), [update]),
        /** S14.3b: the Auction budgets (hundredths); written to storage with the slots. */
        setBudgets: useCallback(
            (next: (budgets: Budgets) => Budgets) =>
                setState((s) => ({ ...s, budgets: next(s.budgets) })),
            [],
        ),
        /** S14.3c: a loadout's team replaces the working team (switching loadout; the caller sets the modes). */
        load: useCallback(
            (t: Pick<Team, 'slots' | 'budgets'>) =>
                // The same team keeps its state: nothing is written (an unreadable stored draft stays, M7).
                setState((s) =>
                    sameTeam(s, t) ? s : { ...s, slots: t.slots, budgets: t.budgets },
                ),
            [],
        ),
        /** The arrival has been handled (its notice shown, the address cleaned). */
        settleArrival: useCallback(
            () => setState((s) => ({ ...s, arrival: { kind: 'none' } })),
            [],
        ),
        /** Brings the previous team back (the caller restores its modes) and forgets it. */
        restorePrevious: useCallback(() => {
            clearPrevious();
            setState((s) =>
                s.previous
                    ? { ...s, slots: s.previous.slots, budgets: s.previous.budgets, previous: null }
                    : s,
            );
        }, []),
        /** Forgets the previous team. */
        dismissPrevious: useCallback(() => {
            clearPrevious();
            setState((s) => ({ ...s, previous: null }));
        }, []),
    };
}
