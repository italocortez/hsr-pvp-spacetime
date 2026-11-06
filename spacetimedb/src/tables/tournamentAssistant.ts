import { table, t } from 'spacetimedb/server';

export const tournamentAssistantColumns = {
    tournamentId: t.u32(),
    userId: t.u32(),
    canValidateResults: t.bool(),
    canOverrideResults: t.bool(),
    canDqParticipants: t.bool(),
    canManageBracket: t.bool(),
    canAssignSeeds: t.bool(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const TournamentAssistant = table({
    name: 'tournament_assistant',
    public: true,
    primaryKey: ['tournamentId', 'userId'],
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] },
    ],
}, tournamentAssistantColumns);
