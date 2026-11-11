// Fixtures: the A97 seat label of a lobby member.
// From S10h (s10h-fixtures.ts).
//
// T-S10h: the A97 seat label as the decision row states it, derived on the test side from the member row (never from the
// module's helper): "<seat kind> #<joinSeq>", seat kind one of Blue Player, Red Player, Blue Coach, Red Coach, Spectator.
// Not a test file. `test.db` is read outside a transaction only.
import { member, type Harness } from './harness';

const SEAT_KIND: Record<string, string> = {
    BluePlayer: 'Blue Player',
    RedPlayer: 'Red Player',
    BlueCoach: 'Blue Coach',
    RedCoach: 'Red Coach',
    Spectator: 'Spectator',
};

/** A97: the label of a member row (slot tag + joinSeq). */
export function labelOfRow(row: { lobbySlot: { tag: string }; joinSeq: number }): string {
    return `${SEAT_KIND[row.lobbySlot.tag]} #${row.joinSeq}`;
}

/** A97: the label of `userId`'s current row in the lobby; throws when the user holds no row (capture it before a leave). */
export function seatLabel(test: Harness, lobbyId: number, userId: number): string {
    const row = member(test, lobbyId, userId);
    if (!row) throw new Error(`seatLabel: user ${userId} holds no row in lobby ${lobbyId}`);
    return labelOfRow(row);
}
