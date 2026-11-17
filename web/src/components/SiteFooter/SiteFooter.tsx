import styles from './SiteFooter.module.css';

/*
 * The page footer of the mockups that have one (index and teambuilder, `.footerStrip`; S14.3c ports it for the team
 * builder, the landing page can reuse it). "Built with" and the three marks (A170 item 4: React in place of the
 * mockup's Next.js), then the build line. The marks are the files in `web/public/footer/`, drawn as CSS masks in
 * the text colour (the files are black), so there is no inline SVG to repeat.
 */

const STACK = [
    { name: 'React', icon: 'react' },
    { name: 'SpacetimeDB', icon: 'spacetimedb' },
    { name: 'TypeScript', icon: 'typescript' },
] as const;

export function SiteFooter() {
    return (
        <footer className={styles.strip}>
            <div className={styles.stack}>
                <span className={styles.stackLabel}>Built with</span>
                <ul className={styles.list}>
                    {STACK.map((t) => (
                        <li key={t.name} className={styles.tech}>
                            <span className={styles.mark} data-icon={t.icon} aria-hidden="true" />
                            <span>{t.name}</span>
                        </li>
                    ))}
                </ul>
            </div>
            <div className={styles.divider} aria-hidden="true" />
            <p className={styles.line}>
                HSR PVP · <strong>IPC Authorized Build</strong> · v0.9 · 2026
            </p>
        </footer>
    );
}
