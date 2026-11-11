// Shared helpers: an Admin, the audit columns and the current turn.
// From S10r (s10r-triage-fixes.test.ts); not a test file.
import { Timestamp } from 'spacetimedb';
import { session, type Actor, type Harness, type Lobby } from './harness';
import { setUserRole, verified } from './tournament-builders';

export const AUDIT0 = (ts: Timestamp) => ({ createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts });
export const turnOf = (s: Lobby) => {
    const sess = session(s.test, s.lobbyId);
    return sess.draftSequence[sess.turnIndex];
};

/** A verified Admin (role written on the row). */
export function admin(test: Harness, name = 'adm'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}
