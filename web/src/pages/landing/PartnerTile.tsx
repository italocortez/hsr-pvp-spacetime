import { useState } from 'react';
import { discordInviteUrl, useDiscordInviteIcon } from '@/lib/useDiscordInviteIcon';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './PartnerTile.module.css';
import { type Partner, partnerInitials } from './partners';

/**
 * One partner community (DESIGN.md §4.4): the round icon, the name, one line about the server and "Join"; the whole
 * tile is the invite link, in a new tab. The name and the line come from the `partner_server` row; the icon is the
 * server's current one, asked from Discord by the invite code (`useDiscordInviteIcon`, S14.4p). Until it is known, when
 * Discord does not answer, when the server has no icon, or when the image fails to load: the name's initials.
 */
export function PartnerTile({ partner }: { partner: Partner }) {
    const icon = useDiscordInviteIcon(partner.inviteCode);
    // The address that failed to load, so a new address is tried again.
    const [failed, setFailed] = useState<string | undefined>();
    const showIcon = icon !== undefined && icon !== failed;
    return (
        <a
            className={`${styles.tile} ${styles.tileLink}`}
            href={discordInviteUrl(partner.inviteCode)}
            target="_blank"
            rel="noopener noreferrer"
        >
            <span className={styles.avatar}>
                {showIcon ? (
                    // Decorative: the name is the text right below. Discord's CDN, not UploadThing, so not
                    // RemoteImage (no CORS mode, no service worker cache).
                    <img
                        src={icon}
                        alt=""
                        width={112}
                        height={112}
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        className={styles.icon}
                        onError={() => setFailed(icon)}
                    />
                ) : (
                    <span className={styles.initials} aria-hidden="true">
                        {partnerInitials(partner.name)}
                    </span>
                )}
            </span>
            <span className={styles.name}>{partner.name}</span>
            {partner.description !== '' && (
                <span className={styles.role}>{partner.description}</span>
            )}
            <span className={styles.join}>
                Join<span className={hidden.visuallyHidden}> on Discord (opens in a new tab)</span>
            </span>
        </a>
    );
}
