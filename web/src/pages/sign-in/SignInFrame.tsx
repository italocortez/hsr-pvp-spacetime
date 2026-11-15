import { IpcActionButton } from '@/components/IpcButton/IpcButton';
import { SplashLayout } from '@/components/SplashLayout/SplashLayout';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { SIGN_IN_FRAME, SIGN_IN_TEXT, SIGN_IN_TITLE } from './signInText';

const noop = () => {};

/**
 * The sign-in panel's first state, inert, shown while the panel's own chunk loads (S14.1): a hard
 * load of `/?login=1` (the Discord return) paints the splash with its `h1` at once, in the same
 * place as the panel, instead of a blank page. The button stays disabled until the panel arrives.
 */
export function SignInFrame() {
    useDocumentTitle(SIGN_IN_TITLE);
    return (
        <SplashLayout
            {...SIGN_IN_FRAME}
            title={
                <>
                    Sign <em>in.</em>
                </>
            }
            lede={SIGN_IN_TEXT.lede}
            action={
                <IpcActionButton onClick={noop} disabled>
                    {SIGN_IN_TEXT.button}
                </IpcActionButton>
            }
        />
    );
}
