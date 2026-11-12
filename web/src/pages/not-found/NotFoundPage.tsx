import { SplashLayout } from '@/components/SplashLayout/SplashLayout';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

const IMAGE = { src: '/standby.webp', width: 1920, height: 1080 };

/**
 * Something the app cannot find. Same screen as standby; only the wording changes with `what`
 * is missing (default: the page itself, for an unknown route).
 */
export function NotFoundPage({ what = 'Page' }: { what?: string }) {
    useDocumentTitle(`${what} not found — IPC Battlegrounds`);
    const lede =
        what === 'Page'
            ? 'The IPC has no record of this route. Check the link, or head back to base.'
            : `The IPC has no record of this ${what.toLowerCase()}. Check the link, or head back to base.`;

    return (
        <SplashLayout
            image={IMAGE}
            hudLabel="SYS://NO SIGNAL"
            hudCoord="Sector ?? · Uncharted"
            eyebrow="Error // 404"
            title={
                <>
                    {what} <em>not found.</em>
                </>
            }
            lede={lede}
        />
    );
}
