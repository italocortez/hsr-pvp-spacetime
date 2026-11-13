// Barrel for the A23 bracket module shared by the SpacetimeDB module and the web app (bracket preview, live
// group standings). The CLI bundler resolves the tsconfig alias only one segment deep (`@shared/bracket`), so
// consumers import this index. Pure TypeScript: nothing here imports `spacetimedb` or `react`.
export * from './engine';
export * from './groups';
export * from './guards';
export * from './standings';
