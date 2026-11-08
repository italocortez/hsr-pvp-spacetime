import { table, t } from 'spacetimedb/server';

// A25 (S3): three flags replace the old five. Only the organizer and Moderator+ may cancel, edit settings
// or manage assistants; ensureTournamentPermission(ctx, tournamentId, 'owner' | 'participants' | 'bracket' | 'results') (S8).
export const tournamentAssistantColumns = {
    id: t.u32().primaryKey().autoInc(),
    tournamentId: t.u32(),
    userId: t.u32(),
    canManageParticipants: t.bool(),      // approvals, waitlist promotion, check-in, DQ, stand-ins, adding participants
    canManageBracket: t.bool(),           // seeding, generation, group -> elimination, creating tournament lobbies
    canResolveResults: t.bool(),          // validating ranked results, staff corrections, rollback
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (D-A3): private; S9a: view_tournament_staff(id) emits each assistant's display name and the three flags to
// anyone (the S9a brief and the T-S9a column list; D-A3's "flags are staff-only" is open with the user, review #6).
export const TournamentAssistant = table({
    name: 'tournament_assistant',
    public: false,
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] },
    ],
}, tournamentAssistantColumns);
