// Types for serve.mjs (read by the unit tests' typecheck).
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export declare const HOST: string;
export declare const DEFAULT_PORT: number;
export declare const CONTENT_TYPES: Readonly<Record<string, string>>;
export declare const API_NOTE: string;
export declare const MAINTENANCE_BODY: string;

export declare function loadVercelConfig(root: string): unknown;

export declare function safeFile(distDir: string, sitePath: string): string | null;

export interface PreviewServerOptions {
    distDir: string;
    config: unknown;
    maintenance?: boolean;
    log?: (line: string) => void;
    /** Returns a refusal text when the bundle no longer targets test (503 for the app page). */
    guard?: () => string | null;
    /** Injectable file read (tests). */
    readFile?: (path: string) => Buffer;
    /** M5b: the local login routes (scripts/local-auth/localAuth.ts); true when it answered. */
    auth?: {
        handle(
            req: IncomingMessage,
            res: ServerResponse,
            extraHeaders?: Record<string, string>,
        ): boolean;
    };
}

export declare function createPreviewServer(options: PreviewServerOptions): Server;

export declare function startPreviewServer(
    options: PreviewServerOptions & { port?: number },
): Promise<{ server: Server; port: number; url: string }>;
