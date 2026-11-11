// Shared helpers: a live Classic lobby and the cost-lock text.
// From S10w (s10w-account-edit-lock.test.ts); not a test file.
import { newHarness, setupLobby, type Lobby, type SetupOpts } from './harness';

/** A142: the Admin cost-row refusal (the A107(4) test). */
export const COST_LOCKED = (costSetId: number, live: number) =>
    `Cannot change a cost row of cost set ${costSetId} while ${live} ${live === 1 ? 'lobby using it is' : 'lobbies using it are'} in Drafting, Equipping or Scoring.`;
export const ONE_V_ONE: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];

/** A 1v1 Classic lobby on set 0; `noStart` keeps it in Waiting. */
export function classic(noStart = false): Lobby {
    return setupLobby(newHarness(), { seats: ONE_V_ONE, noStart });
}
