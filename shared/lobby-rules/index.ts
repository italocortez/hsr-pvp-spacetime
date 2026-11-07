// Barrel for the lobby rules shared by the module and the web app. The CLI bundler (Rolldown, 2.14.1)
// resolves the tsconfig alias only one segment deep (`@shared/lobby-rules`, not
// `@shared/lobby-rules/refereeTransfer`), so consumers import this index.
export * from './refereeTransfer';
