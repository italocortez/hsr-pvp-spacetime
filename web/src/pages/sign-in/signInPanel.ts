import type { ComponentProps, ComponentType } from 'react';
import type { SignInPage } from './SignInPage';

/*
 * The sign-in panel's chunk (S14.1). The panel uses the generated bindings (the SDK chunk), so `/`
 * loads it only for `login=1`, from its route loader; once loaded the component is kept here and
 * renders synchronously (no Suspense round trip after the router has resolved).
 */

export type SignInPageType = ComponentType<ComponentProps<typeof SignInPage>>;

let loaded: SignInPageType | undefined;
let loading: Promise<SignInPageType> | undefined;

/** Loads the panel's chunk once; a failed load can be retried by the next call. */
export function loadSignInPage(): Promise<SignInPageType> {
    if (loaded) return Promise.resolve(loaded);
    loading ??= import('./SignInPage').then(
        (m) => {
            loaded = m.SignInPage;
            return loaded;
        },
        (error: unknown) => {
            loading = undefined;
            throw error;
        },
    );
    return loading;
}

/** The panel once its chunk has loaded, else undefined. */
export function loadedSignInPage(): SignInPageType | undefined {
    return loaded;
}
