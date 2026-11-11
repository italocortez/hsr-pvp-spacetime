// Cost sets: which cost sets a lobby may select, and their coverage.
// Contracts: docs/cost-sets/contract.md
// From S6 (s6-rules.test.ts).
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    expectReject,
    guest,
    lobbyRow,
    newBareHarness,
    seedDefaultCostCoverage,
    setupLobby,
    tx,
    type Harness,
} from '../fixtures/harness';
import { seedReferenceNames } from '../fixtures/calendar-roster-rating-builders';

const E = (n: number) => JSON.stringify({ e0: n, e1: n, e2: n, e3: n, e4: n, e5: n, e6: n });
const S = (n: number) => JSON.stringify({ s1: n, s2: n, s3: n, s4: n, s5: n });

/** A published cost set (owner SYSTEM) with one character row and one light-cone row for MoC × the draft mode. */
function publishedCostSet(test: Harness, name: string, draftModeTag: 'Classic' | 'Auction' | null): number {
    tx(test, 'internal', (ctx) => M.create_cost_set(ctx, { name, sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
    const id = [...test.db.CostSet.iter()].find((c) => c.name === name)!.id;
    if (draftModeTag) {
        // T-S10f (roster audit #9): edit_draft_*_cost requires the HsrCharacter / HsrLightcone rows
        seedReferenceNames(test, ['acheron'], ['along-the-passing-shore']);
        tx(test, 'internal', (ctx) => M.edit_draft_character_cost(ctx, {
            costSetId: id, characterName: 'acheron', gameModeTag: 'MemoryOfChaos', draftModeTag, costsJson: E(2),
        }));
        tx(test, 'internal', (ctx) => M.edit_draft_lightcone_cost(ctx, {
            costSetId: id, lightconeName: 'along-the-passing-shore', gameModeTag: 'MemoryOfChaos', draftModeTag, costsJson: S(1),
        }));
    }
    tx(test, 'internal', (ctx) => M.publish_cost_set(ctx, { costSetId: id }));
    return id;
}

const NO_COSTS = /This cost set has no costs for MemoryOfChaos × (Classic|Auction)\. Pick another set or ask its owner to extend it\./;

describe('Backlog #2: cost-set selectability and coverage', () => {
    it('an uncovered set is rejected, id 0 passes, a covered set passes, a locked set is rejected', () => {
        // T-S10i fix pass (review F2): the sets are cloned from a set 0 without rows; set 0 is then covered for its lobby.
        const test = newBareHarness();
        const empty = publishedCostSet(test, 'empty', null);
        const classic = publishedCostSet(test, 'classic', 'Classic');
        seedDefaultCostCoverage(test);

        const g = guest(test, 'g');
        expectReject(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: empty } as any), NO_COSTS);
        expectReject(test, g, (ctx) =>
            M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: classic, draftMode: { tag: 'Auction' } } as any), NO_COSTS);
        expectReject(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: 404 } as any), /Cost set 404 not found/);

        tx(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: 0 } as any));
        const lobbyId = [...test.db.Lobby.host_user_id.filter(g.userId)][0].id;
        tx(test, g, (ctx) => M.close_lobby(ctx, { lobbyId }));

        tx(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: classic } as any));
        const l2 = [...test.db.Lobby.host_user_id.filter(g.userId)][0];
        expect(l2.costSetId).toBe(classic);
        tx(test, g, (ctx) => M.close_lobby(ctx, { lobbyId: l2.id }));

        tx(test, 'internal', (ctx) => M.lock_cost_set(ctx, { costSetId: classic }));
        expectReject(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: classic } as any), /is locked/);
    });

    it('presets, settings changes and tournaments run the same guards', () => {
        // T-S10i fix pass (review F2): as above, the clones are taken before set 0 gets its coverage rows.
        const test = newBareHarness();
        const empty = publishedCostSet(test, 'empty', null);
        const classic = publishedCostSet(test, 'classic', 'Classic');
        seedDefaultCostCoverage(test);
        const s = setupLobby(test, { noStart: true });
        const base = (() => {
            const rest = DEFAULT_LOBBY_ARGS; // A114 / A116 (S10n): no joinCode / presetId to strip
            return { lobbyId: s.lobbyId, ...rest, refereeExclusiveConcede: true };
        })();
        expectReject(test, s.host, (ctx) => M.update_lobby_settings(ctx, { ...base, costSetId: empty } as any), NO_COSTS);
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, { ...base, costSetId: classic } as any));
        expect(lobbyRow(test, s.lobbyId).costSetId).toBe(classic);
        expectReject(test, s.host, (ctx) =>
            M.update_lobby_settings(ctx, { ...base, costSetId: classic, draftMode: { tag: 'Auction' } } as any), NO_COSTS);

        expectReject(test, 'internal', (ctx) => M.create_tournament(ctx, {
            name: 'Cup', description: '', format: 'SingleElimination', teamSize: 1, defaultGameMode: 'MemoryOfChaos',
            maxParticipants: 8, rosterVisibility: 'OpenRoster', isAnonymousDefault: false, disconnectPolicy: 'Standard',
            costSetId: empty, defaultBestOf: 1, groupSize: 4, has3rdPlaceMatch: false, countTowardsMmr: false,
            winnerAdvantage: 0, requireOwnership: false, requireVerified: false, requireRoster: false, minimumMmr: 0,
            requireApproval: false, waitlistEnabled: false, scheduledStartAt: '', registrationDeadline: '', maxAccountsPerPlayer: 1,
            grandFinalBestOf: 3, groupAdvanceCount: 2, groupAssignmentMode: 'Auto', checkInEnabled: false,
            requireResultValidation: false, allowMirrorPicks: false, lineupFormat: 'Halves', // T-S8b: the A36 argument set
        }), NO_COSTS);
    });

    it('deleting a set a live lobby uses is rejected; once the lobby is gone it can be deleted', () => {
        const test = newBareHarness(); // T-S10i fix pass (review F2): the clone of set 0 carries no coverage rows
        const classic = publishedCostSet(test, 'classic', 'Classic');
        const s = setupLobby(test, { noStart: true, lobby: { costSetId: classic } });
        tx(test, 'internal', (ctx) => M.lock_cost_set(ctx, { costSetId: classic }));
        tx(test, 'internal', (ctx) => M.unpublish_cost_set(ctx, { costSetId: classic }));
        expectReject(test, 'internal', (ctx) => M.delete_cost_set(ctx, { costSetId: classic }), /used by an active lobby or tournament/);

        tx(test, s.host, (ctx) => M.close_lobby(ctx, { lobbyId: s.lobbyId }));
        tx(test, 'internal', (ctx) => M.delete_cost_set(ctx, { costSetId: classic }));
        expect(test.db.CostSet.id.find(classic)).toBeNull();
    });
});
