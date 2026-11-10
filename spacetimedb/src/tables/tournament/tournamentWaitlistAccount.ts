import { table, t } from 'spacetimedb/server';

// A104 (S10g): the HSR accounts a waitlisted registrant chose (register_for_tournament hsrAccountIds, or
// lock_tournament_accounts while waitlisted). Locked (TournamentPlayerAccount) at promotion, then deleted. No row for a
// registrant = every account they own is locked at promotion (the pre-S10g behaviour). Same shape as
// TournamentPlayerAccount; private, never read by a view.
export const tournamentWaitlistAccountColumns = {
    tournamentId: t.u32(),
    userId: t.u32(),
    hsrAccountId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const TournamentWaitlistAccount = table({
    name: 'tournament_waitlist_account',
    public: false,
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] },
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
    ],
}, tournamentWaitlistAccountColumns);
