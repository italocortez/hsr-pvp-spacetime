// Types for preview.mjs (read by the unit tests' typecheck).
import type { Server } from 'node:http';

export declare const PREVIEW_TARGET: 'test';

export declare function parseArgs(
    argv: readonly string[],
): { port: number; build: boolean; maintenance: boolean } | { error: string };

export declare function readBundleTarget(texts: readonly string[]): {
    targets: string[];
    testNameMapped: boolean;
};

export declare function checkBundleTarget(distDir: string): string | null;

export declare function createBundleGuard(distDir: string): () => string | null;

export declare function runPreview(
    argv: readonly string[],
    io?: {
        root?: string;
        out?: (line: string) => void;
        err?: (line: string) => void;
        port?: number;
    },
): Promise<{ code: number; server?: Server; port?: number; url?: string }>;
