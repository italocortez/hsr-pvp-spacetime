/**
 * One dialog at a time on a page, in a given order (S14.4b; the team builder's rule since S14.3j): of the dialogs
 * that want to show, the first in `order` is the one shown; the others wait (closed by the page, nothing chosen)
 * and open by themselves once the ones before them stop wanting to show.
 *
 *     const turn = dialogInTurn(['delete', 'held', 'notice'], {
 *         delete: pending !== null,
 *         held: held !== null && !dismissed,
 *         notice: notice !== null,
 *     });
 *     <Dialog open={turn === 'held'} … />
 *
 * A dialog opened over another one on purpose (a settings dialog over a form) is not a queue: open both.
 */
export function dialogInTurn<K extends string>(
    order: readonly K[],
    wanted: Partial<Record<K, boolean>>,
): K | null {
    return order.find((key) => wanted[key] === true) ?? null;
}
