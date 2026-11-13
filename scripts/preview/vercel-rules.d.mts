// Types for vercel-rules.mjs (read by the unit tests' typecheck).

export declare const DEFAULT_CACHE_CONTROL: string;

export declare function sourceToRegExp(source: string): RegExp;

export declare function assertSupportedSource(source: string, where: string): void;

export type Resolved =
    | { kind: 'file'; file: string }
    | { kind: 'rewrite'; file: string; source: string }
    | { kind: 'notFound' };

export interface CompiledRules {
    resolve(pathname: string, fileExists: (path: string) => boolean): Resolved;
    headersFor(pathname: string, options?: { staticFile?: boolean }): Record<string, string>;
}

export declare function compileRules(config: unknown): CompiledRules;
