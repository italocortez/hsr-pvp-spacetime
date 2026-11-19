// Barrel for the identity rules shared by the module and the web app (S14.5s, A226). The CLI bundler resolves the
// tsconfig alias only one segment deep (`@shared/identity`), so consumers import this index.

export * from './username';
export * from './userReference';
