// Barrel for the A21 scoring module shared by the SpacetimeDB module and the web live preview. The CLI
// bundler resolves the tsconfig alias only one segment deep (`@shared/scoring`), so consumers import this
// index. Pure TypeScript: nothing here imports `spacetimedb` or `react`, and all arithmetic is integer
// hundredths (floats only in toHundredths / fromHundredths at the boundary).
export * from './fixedPoint';
export * from './game';
export * from './groups';
export * from './handicaps';
export * from './rosterCost';
export * from './synergy';
export * from './units';
export * from './winner';
