import { tables } from '@bindings/index';
import { toSql } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { MY_LOBBY_MEMBERS_QUERY } from '@/pages/lobby-room/LobbyPlaceholder';
import { REFERENCE_QUERIES } from '@/stdb/referenceSet';
import {
    CREATE_LOBBY_QUERIES,
    LOBBY_PRESETS_QUERY,
    PUBLISHED_COST_SETS_QUERY,
} from './createLobbyQueries';

/*
 * T-S14.4c: the create dialog's and the lobby placeholder's subscriptions are plain SQL text (their chunks need no
 * SDK); this pins the text to what the installed SDK's query builder writes for the generated bindings.
 */

describe('create-lobby queries', () => {
    it('the same SQL as toSql(tables.x)', () => {
        expect(PUBLISHED_COST_SETS_QUERY).toBe(toSql(tables.viewPublishedCostSets));
        expect(LOBBY_PRESETS_QUERY).toBe(toSql(tables.viewLobbyPresets));
        expect(MY_LOBBY_MEMBERS_QUERY).toBe(toSql(tables.viewMyLobbyMembers));
    });

    it('the cost set query is the reference set’s own text (one subscription shared when both are live)', () => {
        expect(REFERENCE_QUERIES).toContain(PUBLISHED_COST_SETS_QUERY);
        expect(CREATE_LOBBY_QUERIES).toEqual([PUBLISHED_COST_SETS_QUERY, LOBBY_PRESETS_QUERY]);
    });
});
