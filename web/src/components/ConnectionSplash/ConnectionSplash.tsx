import type { ReactNode } from 'react';
import { IpcActionButton } from '@/components/IpcButton/IpcButton';
import { SplashLayout } from '@/components/SplashLayout/SplashLayout';

const IMAGE = { src: '/standby.webp', width: 1920, height: 1080 };

type Props = {
    eyebrow: string;
    title: ReactNode;
    lede: ReactNode;
    onRetry: () => void;
};

/**
 * The connection screens (offline, maintenance): `SplashLayout` with the standby art, like
 * `ErrorSplash`, but with one Retry action in place of the link back to base. No CSS of its own.
 */
export function ConnectionSplash({ eyebrow, title, lede, onRetry }: Props) {
    return (
        <SplashLayout
            image={IMAGE}
            eyebrow={eyebrow}
            title={title}
            lede={lede}
            action={<IpcActionButton onClick={onRetry}>Retry</IpcActionButton>}
        />
    );
}
