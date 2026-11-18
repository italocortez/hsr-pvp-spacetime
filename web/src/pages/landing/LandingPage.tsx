import { SiteFooter } from '@/components/SiteFooter/SiteFooter';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { LandingContact } from './LandingContact';
import { LandingFeatures } from './LandingFeatures';
import { LandingHero } from './LandingHero';

export const LANDING_TITLE = 'HSR PVP — IPC Battlegrounds';

/**
 * The landing page at `/` (S14.4a, design/mockups/index.html): hero, the features bento, the
 * contact block and the site footer. One route subscription beyond the shell's Layer 0: the
 * partner servers (S14.4p, `usePartnerServers`), as plain SQL text, so the route's chunk stays
 * SDK-free (`stdb/entryChunk.test.ts`).
 */
export function LandingPage() {
    useDocumentTitle(LANDING_TITLE);
    return (
        <>
            <LandingHero />
            <LandingFeatures />
            <LandingContact />
            <SiteFooter />
        </>
    );
}
