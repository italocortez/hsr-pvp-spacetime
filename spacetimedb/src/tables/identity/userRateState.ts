import { table, t } from 'spacetimedb/server';

/**
 * Per-user rate windows (S3; ACCESS-SECURITY-OPS §B.5, B-7). One row per user, created on first use by the
 * chat and lobby-creation throttles (helpers/abuseControls.ts): a fixed window start plus a count, compared against AbuseConfig.
 * Cursor and lineup throttles live on LobbyMember (lastCursorAt / lastLineupAt) because they are per lobby.
 * S10e (lobby audit #6): `membershipWindowStart` / `membershipCount` are the fixed window of the user's membership
 * changes (join / return / seat move; a leave is not counted; consumeMembershipAllowance); the window starts at the epoch.
 */
export const userRateStateColumns = {
    userId: t.u32().primaryKey(),
    chatWindowStart: t.timestamp(),
    chatCount: t.u32(),
    lobbyWindowStart: t.timestamp(),
    lobbyCreates: t.u32(),
    membershipWindowStart: t.timestamp(),
    membershipCount: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserRateState = table({
    name: 'user_rate_state',
    public: false,
}, userRateStateColumns);
