import type { ReactNode } from 'react';
import { SplashLayout } from '@/components/SplashLayout/SplashLayout';

const IMAGE = { src: '/standby.webp', width: 1920, height: 1080 };

type Props = {
    /** HTTP-style code shown in the eyebrow (`Error // <code>`). */
    code: string;
    title: ReactNode;
    lede: ReactNode;
};

/**
 * The error screens (404, 403): `SplashLayout` with the standby art (user ruling, M3) and an
 * `Error // <code>` eyebrow; only the wording changes. No CSS of its own.
 */
export function ErrorSplash({ code, title, lede }: Props) {
    return <SplashLayout image={IMAGE} eyebrow={`Error // ${code}`} title={title} lede={lede} />;
}
