/// <reference types="vite/client" />

/** Build id from `vite.config.ts` `define`: the first 8 characters of the Vercel commit SHA, or `'dev'`. */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
    /** `test` | `prod`; parsed by `resolveBrowserEnv` in `@shared/stdb-targets`. */
    readonly VITE_STDB_TARGET: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
