import { SplashLayout } from '@/components/SplashLayout/SplashLayout';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

const IMAGE = { src: '/not-found-image.webp', width: 281, height: 262 };

/** Any path the app does not know. Same editorial pattern as standby. */
export function NotFoundPage() {
    useDocumentTitle('Not found — IPC Battlegrounds');

    return (
        <SplashLayout
            image={IMAGE}
            imageTone="placeholder"
            hudLabel="SYS://NO SIGNAL"
            hudCoord="Sector ?? · Uncharted"
            eyebrow="Error // 404"
            title={
                <>
                    Page <em>not found.</em>
                </>
            }
            lede="The IPC has no record of this route. Check the link, or head back to base."
        />
    );
}
