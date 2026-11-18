import type { PartnerServer } from '@bindings/types';
import { useMemo } from 'react';
import { DISCORD_INVITE_CODE } from '@/lib/useDiscordInviteIcon';
import { useStdbConnection } from '@/stdb/connectionContext';
import { useRouteSubscriptions } from '@/stdb/useRouteSubscriptions';
import { useRows } from '@/stdb/useRows';

/*
 * S14.4p: the landing page's partner servers, a route subscription of `/` (CLAUDE.md §4): the whole public
 * `partner_server` table (at most 12 small rows), one subscription, dropped when the page unmounts; no reference set.
 * The query is plain SQL text, so the route's chunk reaches no SDK module (`stdb/entryChunk.test.ts`); it is exactly
 * what `toSql(tables.partnerServer)` writes (pinned in `LandingPage.test.tsx`).
 */

export const PARTNER_SERVERS_QUERY = 'SELECT * FROM "partner_server"';
const QUERIES = [PARTNER_SERVERS_QUERY];

export type PartnerServers = {
    /** The subscription's first result has arrived. */
    ready: boolean;
    /** Ordered by `position`, then `id`; a row whose code lacks the invite shape is left out. */
    partners: readonly PartnerServer[];
};

const NONE: readonly string[] = [];

export function usePartnerServers(): PartnerServers {
    // As Layer 0 does for the suspension view: no table handle on the connection (the test doubles
    // of the earlier steps), nothing to read, so nothing is subscribed. The generated connection
    // always has it.
    const hasTable = useStdbConnection()?.db.partnerServer !== undefined;
    const { ready } = useRouteSubscriptions(hasTable ? QUERIES : NONE);
    const rows = useRows((conn) => conn.db.partnerServer, ready);
    const partners = useMemo(
        () =>
            rows
                .filter((r) => DISCORD_INVITE_CODE.test(r.inviteCode))
                .sort((a, b) => a.position - b.position || a.id - b.id),
        [rows],
    );
    return { ready, partners };
}
