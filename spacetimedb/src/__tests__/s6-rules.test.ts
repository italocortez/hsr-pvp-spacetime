// T-S6: in-memory tests for the cost-set guards (backlog #2, D-D6), the merged account rating (backlog #10), Ban
// Restriction (A45(2)) and the three A45(3) reducers. Reuses the S4 builders; in-memory datastore on the TestClock.
// Admin / TournamentHost calls run as the owner identity (TestAuth.internal()), which init links to SYSTEM (Admin).
import { describe, expect, it } from 'vitest';
import { computeAccountRating, computeMergedAccountRating } from '@module/helpers/stats/accountRating';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    captainOf,
    expectReject,
    guest,
    linkDiscord,
    lobbyRow,
    member,
    dropDefaultCostCoverage,
    newBareHarness,
    newHarness,
    seedDefaultCostCoverage,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    seatOf,
    priceCharacters,
} from './s4-fixtures';
import { finishGame } from './s7-fixtures';
import { seedReferenceNames } from './s10-c2-fixtures';

const actorOf = (s: Lobby, userId: number): Actor => Object.values(s.a).find((x) => x.userId === userId)!;
const captain = (s: Lobby, team: 'Blue' | 'Red') =>
    actorOf(s, captainOf(s.test, s.lobbyId, team === 'Blue' ? 'BluePlayer' : 'RedPlayer')!.userId);

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

// ─── Backlog #10: merged account rating ───────────────────────────────────────────────────────────────────

const CHARS = ['c1', 'c2', 'c5', 'c6', 'c9'];

/** Characters (same version, same role: symmetric age weights), one archetype {c1, c5, c9}, then the config. */
function seedRatingData(test: Harness) {
    tx(test, 'internal', (ctx) => {
        for (const name of CHARS) {
            ctx.db.HsrCharacter.insert({
                name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Harmony' }, element: { tag: 'Fire' },
                role: { tag: 'Support' }, imageUrl: '', versionReleased: 2.0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
        const arch = ctx.db.Archetype.insert({
            id: 0, name: 'hypercarry', description: '',
            createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
        });
        for (const name of ['c1', 'c5', 'c9']) {
            ctx.db.HsrCharacterArchetype.insert({
                characterName: name, archetypeId: arch.id,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            });
        }
    });
    tx(test, 'internal', (ctx) => M.admin_seed_rating_config(ctx, {}));
}

/** A verified player with two accounts holding disjoint rosters of the same shape ({c1, c2} and {c5, c6}). */
function twoAccountPlayer(test: Harness): { who: Actor; acct1: number; acct2: number } {
    const who = guest(test, 'multi');
    linkDiscord(test, who, 'discord-multi', 'Multi');
    tx(test, who, (ctx) => M.create_hsr_account(ctx, { uid: '600000001', displayLabel: 'main' }));
    tx(test, who, (ctx) => M.create_hsr_account(ctx, { uid: '600000002', displayLabel: 'alt' }));
    const [acct1, acct2] = [...test.db.HsrAccount.user_id.filter(who.userId)].map((a) => a.id).sort((a, b) => a - b);
    const roster = (names: string[]) => JSON.stringify(names.map((characterName) => ({ characterName, eidolonLevel: 0 })));
    tx(test, who, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: acct1, charactersJson: roster(['c1', 'c2']) }));
    tx(test, who, (ctx) => M.batch_upsert_characters(ctx, { hsrAccountId: acct2, charactersJson: roster(['c5', 'c6']) }));
    return { who, acct1, acct2 };
}

const snapshotOf = (test: Harness, lobbyId: number, userId: number) => {
    const record = [...test.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];
    return [...test.db.MatchResultParticipant.by_result_and_user.filter([record.id, userId])][0].accountRatingSnapshot;
};

describe('Backlog #10: merged account rating', () => {
    it('two equally rated accounts with disjoint rosters merge to a different (higher) rating; one account is unchanged', () => {
        const test = newHarness();
        seedRatingData(test);
        const { acct1, acct2 } = twoAccountPlayer(test);
        const r1 = test.db.HsrAccount.id.find(acct1)!.accountRating;
        const r2 = test.db.HsrAccount.id.find(acct2)!.accountRating;
        expect(r1).toBeGreaterThan(0);
        expect(r2).toBe(r1);

        const merged = tx(test, 'internal', (ctx) => computeMergedAccountRating(ctx, [acct1, acct2]));
        expect(merged).not.toBe(r1);
        expect(merged).toBeGreaterThan(r1);

        // Single account: the wrapper and the merged path over one account equal the stored number exactly.
        const single = tx(test, 'internal', (ctx) => [computeAccountRating(ctx, acct1), computeMergedAccountRating(ctx, [acct1])]);
        expect(single).toEqual([r1, r1]);
    });

    it('start_draft snapshots the merged rating; selection is Waiting-only after A67, so the snapshot holds; a single-account snapshot is the stored rating', () => {
        const test = newHarness();
        seedRatingData(test);
        const { who, acct1, acct2 } = twoAccountPlayer(test);
        const r1 = test.db.HsrAccount.id.find(acct1)!.accountRating;
        const merged = tx(test, 'internal', (ctx) => computeMergedAccountRating(ctx, [acct1, acct2]));

        const s = setupLobby(test, {
            actors: { b1: who },
            // Two selected accounts, as the tournament path (D-05, additive) allows.
            beforeStart: (l) => tx(test, 'internal', (ctx) => {
                ctx.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: who.userId, hsrAccountId: acct1 });
                ctx.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: who.userId, hsrAccountId: acct2 });
            }),
        });
        expect(snapshotOf(test, s.lobbyId, who.userId)).toBe(merged);

        // T-S8e (A67(1)): the between-games account swap is gone (D-06: selection in Waiting only). After start_draft
        // a deselect / reselect is rejected and the snapshot stays the merged rating.
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expectReject(test, who, (ctx) => M.deselect_match_account(ctx, { lobbyId: s.lobbyId, hsrAccountId: acct2 }),
            'Account deselection is only allowed during the Waiting stage.');
        expectReject(test, who, (ctx) => M.select_match_account(ctx, { lobbyId: s.lobbyId, hsrAccountId: acct1 }),
            'Account selection is only allowed during the Waiting stage.');
        expect(snapshotOf(test, s.lobbyId, who.userId)).toBe(merged);
        expect(r1).toBeLessThan(merged);

        // A single selected account snapshots exactly its stored rating.
        const t2 = newHarness();
        seedRatingData(t2);
        const p2 = twoAccountPlayer(t2);
        const s2 = setupLobby(t2, {
            actors: { b1: p2.who },
            beforeStart: (l) => tx(t2, p2.who, (ctx) => M.select_match_account(ctx, { lobbyId: l.lobbyId, hsrAccountId: p2.acct1 })),
        });
        expect(snapshotOf(t2, s2.lobbyId, p2.who.userId)).toBe(t2.db.HsrAccount.id.find(p2.acct1)!.accountRating);
    });
});

// ─── A45(2): Ban Restriction ──────────────────────────────────────────────────────────────────────────────

function seedRoles(test: Harness, roles: Record<string, 'Dps' | 'Support' | 'Sustain'>) {
    tx(test, 'internal', (ctx) => {
        for (const [name, role] of Object.entries(roles)) {
            ctx.db.HsrCharacter.insert({
                name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Destruction' }, element: { tag: 'Ice' },
                role: { tag: role }, imageUrl: '', versionReleased: 1.0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
    });
}

const ban = (s: Lobby, team: 'Blue' | 'Red', characterName: string) =>
    tx(s.test, captain(s, team), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName }));
const pick = (s: Lobby, team: 'Blue' | 'Red', characterName: string) =>
    tx(s.test, captain(s, team), (ctx) => (priceCharacters(ctx, s.lobbyId, [characterName]), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 })));

describe('A45(2): Ban Restriction', () => {
    it('Max 1 DPS rejects a second DPS ban by the same team; another role and the other team are unaffected', () => {
        const test = newHarness();
        seedRoles(test, { dps1: 'Dps', dps2: 'Dps', dps3: 'Dps', sup1: 'Support' });
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' }, banRestriction: { tag: 'MaxOneDps' } } });
        expect(lobbyRow(test, s.lobbyId).banRestriction.tag).toBe('MaxOneDps');

        ban(s, 'Blue', 'dps1');
        ban(s, 'Red', 'dps2'); // Red's first DPS ban: allowed
        pick(s, 'Blue', 'p1');
        pick(s, 'Red', 'p2');
        pick(s, 'Red', 'p3');
        pick(s, 'Blue', 'p4');
        ban(s, 'Red', 'sup1');
        expect(session(test, s.lobbyId).draftSequence[session(test, s.lobbyId).turnIndex].teamTurn.tag).toBe('Blue');
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'dps3' }), /at most one DPS/);
        ban(s, 'Blue', 'unknown-name'); // no HsrCharacter row → no role → legal
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(4);
    });

    it('the timer-expiry auto-ban (autoRandomPick) only draws characters the acting team may still ban', () => {
        const test = newHarness();
        seedRoles(test, { dpsA: 'Dps', dpsB: 'Dps', sup1: 'Support' });
        // Ban pool = the default set's Classic MoC cost rows: dpsA, dpsB, sup1.
        tx(test, 'internal', (ctx) => {
            for (const characterName of ['dpsA', 'dpsB', 'sup1']) {
                ctx.db.HsrCharacterCost.insert({
                    characterName, gameMode: { tag: 'MemoryOfChaos' }, draftMode: { tag: 'Classic' },
                    costs: { e0: 1, e1: 1, e2: 1, e3: 1, e4: 1, e5: 1, e6: 1 }, costSetId: 0,
                    createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                } as any);
            }
        });
        const s = setupLobby(test, {
            lobby: { banMode: { tag: 'Four' }, banRestriction: { tag: 'MaxOneDps' }, autoRandomPick: true },
            // autoRandomPick requires every player to field an account with characters (D-43b).
            // T-S10i fix pass (review F2): the set-0 coverage rows leave the ban pool once the lobby exists.
            beforeStart: (l) => { dropDefaultCostCoverage(test); tx(test, 'internal', (ctx) => {
                for (const name of ['b1', 'b2', 'r1', 'r2']) {
                    const acct = ctx.db.HsrAccount.insert({
                        id: 0, userId: l.a[name].userId, uid: '600000000', region: 'America', displayLabel: name,
                        isActive: true, isRosterPublic: false, isRatingPublic: false, isDuplicateUid: false, accountRating: 0,
                        createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                    });
                    ctx.db.HsrAccountCharacter.insert({
                        hsrAccountId: acct.id, characterName: 'sup1', eidolonLevel: 0,
                        createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                    } as any);
                    ctx.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[name].userId, hsrAccountId: acct.id });
                }
            }); },
        });
        ban(s, 'Blue', 'dpsA');
        ban(s, 'Red', 'x');
        pick(s, 'Blue', 'p1');
        pick(s, 'Red', 'p2');
        pick(s, 'Red', 'p3');
        pick(s, 'Blue', 'p4');
        ban(s, 'Red', 'y');
        // Blue's second ban expires: dpsB is unbanned but illegal for Blue (Max 1 DPS), so only sup1 qualifies.
        advance(test, 31_000);
        tx(test, s.a.b1, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
        const last = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban').at(-1)!;
        expect(last.actorSlot.tag).toBe('Blue');
        expect(last.payload.tag === 'Ban' && last.payload.value.characterName).toBe('sup1');
    });
});

// ─── A45(3): shuffle_teams, unban_member, delete_my_account ──────────────────────────────────────────────

const slotOf = (s: Lobby, name: string) => member(s.test, s.lobbyId, s.a[name].userId).lobbySlot.tag;

describe('A45(3): shuffle_teams', () => {
    it('TeamSwap moves every Blue seat to Red and back, with one confirmation reset', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.shuffle_teams(ctx, { lobbyId: s.lobbyId, mode: { tag: 'TeamSwap' } }));
        expect(['b1', 'b2'].map((n) => slotOf(s, n))).toEqual(['RedPlayer', 'RedPlayer']);
        expect(['r1', 'r2'].map((n) => slotOf(s, n))).toEqual(['BluePlayer', 'BluePlayer']);
        for (const n of ['b1', 'b2', 'r1', 'r2']) expect(member(test, s.lobbyId, s.a[n].userId).isConfirmed).toBe(false);
    });

    it('RandomSwap keeps two players per team; a player who is not the host is rejected; Drafting is rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.shuffle_teams(ctx, { lobbyId: s.lobbyId, mode: { tag: 'RandomSwap' } }));
        const slots = ['b1', 'b2', 'r1', 'r2'].map((n) => slotOf(s, n));
        expect(slots.filter((x) => x === 'BluePlayer')).toHaveLength(2);
        expect(slots.filter((x) => x === 'RedPlayer')).toHaveLength(2);
        expect(slotOf(s, 'host')).toBe('Spectator');

        expectReject(test, s.a.b1, (ctx) => M.shuffle_teams(ctx, { lobbyId: s.lobbyId, mode: { tag: 'TeamSwap' } }), /Only the host/);

        const d = setupLobby(newHarness());
        expectReject(d.test, d.host, (ctx) => M.shuffle_teams(ctx, { lobbyId: d.lobbyId, mode: { tag: 'TeamSwap' } }), /not allowed in the current lobby stage/);
    });
});

describe('A45(3): unban_member', () => {
    it('the host lifts a ban and the user can rejoin; a plain player cannot; an unbanned user is rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        // T-S9c (A74(2)): the ban records the seat; unban_member takes that seat number.
        const seat = seatOf(test, s.lobbyId, s.a.r2.userId);
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seat }));
        expect([...test.db.LobbyBan.lobby_id.filter(s.lobbyId)]).toHaveLength(1);

        expectReject(test, s.a.b1, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: seat }), /lift a lobby ban/);
        tx(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: seat }));
        expect([...test.db.LobbyBan.lobby_id.filter(s.lobbyId)]).toHaveLength(0);
        tx(test, s.a.r2, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expect(member(test, s.lobbyId, s.a.r2.userId)).toBeDefined();

        // T-S9c (A74(2)/(3)): the lifted seat has no ban left (the old "not banned" text is now the seat rejection).
        expectReject(test, s.host, (ctx) => M.unban_member(ctx, { lobbyId: s.lobbyId, bannedJoinSeq: seat }), `No ban is recorded for seat ${seat} of this lobby.`);
    });
});

describe('A45(3): delete_my_account', () => {
    it('a verified user outside any lobby is deleted through performUserDeletion', () => {
        const test = newHarness();
        const v = guest(test, 'v');
        linkDiscord(test, v, 'discord-v', 'Verified');
        tx(test, v, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(v.userId)).toBeNull();
        expect(test.db.UserIdentity.identity.find(v.identity)).toBeNull();
        expect(test.db.DeletedUser.id.find(v.userId)).not.toBeNull();
    });

    it('a guest keeps the old delete_guest_account behaviour (identity and user row removed)', () => {
        const test = newHarness();
        const g = guest(test, 'g');
        tx(test, g, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(g.userId)).toBeNull();
        expect(test.db.UserIdentity.identity.find(g.identity)).toBeNull();
    });

    it('a verified user seated in a lobby is rejected', () => {
        const test = newHarness();
        const v = guest(test, 'v');
        linkDiscord(test, v, 'discord-v', 'Verified');
        setupLobby(test, { noStart: true, actors: { b1: v } });
        expectReject(test, v, (ctx) => M.delete_my_account(ctx, {}), /Leave your lobby/);
        expect(test.db.User.id.find(v.userId)).not.toBeNull();
    });
});
