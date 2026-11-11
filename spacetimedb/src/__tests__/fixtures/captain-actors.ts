// Shared helpers: the captain actors of a lobby and the not-eligible text.
// From S4 (s4-lobby-fixes.test.ts); not a test file.
import { captainOf, type Lobby } from './harness';

export const actorOf = (s: Lobby, userId: number) => Object.values(s.a).find((x) => x.userId === userId)!;
export const blueCaptain = (s: Lobby) => actorOf(s, captainOf(s.test, s.lobbyId, 'BluePlayer')!.userId);
export const redCaptain = (s: Lobby) => actorOf(s, captainOf(s.test, s.lobbyId, 'RedPlayer')!.userId);
