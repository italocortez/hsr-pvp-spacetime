import { SplashLayout } from '@/components/SplashLayout/SplashLayout';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import styles from './StandbyPage.module.css';
import { useRequestedModule } from './useRequestedModule';

const IMAGE = { src: '/standby.webp', width: 1920, height: 1080 };

/** Placeholder for not-yet-built sections; `?module=<name>` names the requested one. */
export function StandbyPage() {
    const moduleName = useRequestedModule(window.location.search);
    useDocumentTitle(
        moduleName ? `${moduleName} — Standby — IPC Battlegrounds` : 'Standby — IPC Battlegrounds',
    );

    return (
        <SplashLayout
            image={IMAGE}
            hudLabel="SYS://STANDBY"
            hudCoord="Sector 04 · Provisioning"
            eyebrow="Status // Standby"
            title={
                <>
                    Module <em>offline.</em>
                </>
            }
            lede={
                <>
                    The IPC is provisioning resources for this section. <strong>Nathyron</strong> is
                    still in the workshop — check back soon for the live build.
                </>
            }
        >
            {moduleName && (
                <p className={styles.modulePill}>
                    <span>
                        Requested module<span className={styles.separator}>: </span>
                    </span>
                    <span className={styles.moduleName}>{moduleName}</span>
                </p>
            )}
        </SplashLayout>
    );
}
