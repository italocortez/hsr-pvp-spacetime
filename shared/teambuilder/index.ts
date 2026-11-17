// Barrel for the team builder's shared model (S14.3a): the team, its packed text and its cost. Pure TypeScript, no
// `spacetimedb` or `react` import, so the page, browser storage and (S14.3s) the module can all use it. Consumers
// import this index (the CLI bundler resolves `@shared/<folder>` one segment deep).
export * from './amount';
export * from './auctionSpend';
export * from './defaults';
export * from './team';
export * from './teamCode';
export * from './teamCost';
