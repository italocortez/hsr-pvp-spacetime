// Barrel for the team builder's loadouts (S14.3c): names, list operations, account slots, the autosave state
// machine, the version-based account sync (S14.3c-sync) and the copies' differences. Pure TypeScript, no `spacetimedb`
// or `react` import. The module does not import this folder (its own checks live in
// `spacetimedb/src/helpers/roster/loadoutRules.ts`); the rules and texts here are kept equal to those.
export * from './autosave';
export * from './differences';
export * from './list';
export * from './names';
export * from './sync';
