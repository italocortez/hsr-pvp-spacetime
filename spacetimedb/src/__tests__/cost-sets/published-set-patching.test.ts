// Cost sets: completeness view and publish check; a published set patched in place; history untouched.
// Decisions: A107
// Contracts: docs/cost-sets/contract.md
// From S10i (s10i-draft-cost.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    guest,
    lobbyRow,
    newBareHarness,
    priceBanNames,
    session,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
} from '../fixtures/harness';
import { captain, completeDraft, finishGame } from '../fixtures/draft-and-scoring-builders';
import {
    host as tournamentHost,
    liveField,
    moderator,
    verified,
} from '../fixtures/tournament-builders';
import { byKey, captainActor, openMatchLobby } from '../fixtures/tournament-match-builders';
import { rejection, seedReferenceNames } from '../fixtures/calendar-roster-rating-builders';
import { parkedLobby } from '../fixtures/ranked-game-builders';
import {
    MOC,
    advanceBody,
    charRow,
    createSet,
    eJson,
    editChar,
    editLc,
    equipBody,
    ladder,
    liveChars,
    payloadOf,
    pickBody,
    publish,
    publishBody,
    sJson,
    sLadder,
    snap,
    type Mode,
    type Team,
} from '../fixtures/cost-set-pricing-builders';

const LOCKED = 'This cost set is locked; its costs cannot be changed.';
const UNPUBLISHED = 'This cost set is unpublished; its costs cannot be changed.';
const PATCH_BLOCKED = (n: number) =>
    `Cannot patch this cost set while ${n} ${n === 1 ? 'lobby using it is' : 'lobbies using it are'} in Drafting, Equipping or Scoring.`;
const editSyn = (test: Harness, who: Actor | 'internal', costSetId: number, sourceName: string, targetName: string, draftModeTag: Mode, costModifier: number) =>
    tx(test, who, (ctx) => M.edit_draft_synergy_cost(ctx, { costSetId, sourceName, targetName, gameModeTag: MOC, draftModeTag, costModifier }));
const liveLcs = (test: Harness, id: number) => [...test.db.HsrLightconeCost.cost_set_id.filter(id)];
const liveSyns = (test: Harness, id: number) => [...test.db.HsrSynergyCost.cost_set_id.filter(id)];
const draftChars = (test: Harness, id: number) => [...test.db.CostSetDraftCharacter.cost_set_id.filter(id)];
const draftLcs = (test: Harness, id: number) => [...test.db.CostSetDraftLightcone.cost_set_id.filter(id)];
const draftSyns = (test: Harness, id: number) => [...test.db.CostSetDraftSynergy.cost_set_id.filter(id)];
const lcRow = (rows: any[], name: string, mode: Mode = 'Classic') =>
    rows.find((r) => r.lightconeName === name && r.draftMode.tag === mode && r.gameMode.tag === MOC);
/** `name|mode|e0` (characters) or `name|mode|s1` (light cones), sorted: the price image of a row set. */
const priceImage = (rows: any[]) =>
    rows.map((r) => `${r.characterName ?? r.lightconeName}|${r.draftMode.tag}|${r.costs.e0 ?? r.costs.s1}`).sort();

// ════════════════════════════════════════════════════════════════════════════
// B.4 A107(2): completeness at publish and view_cost_set_missing
// ════════════════════════════════════════════════════════════════════════════

const missingView = (test: Harness, who: Actor, costSetId: number) =>
    ((M as any).view_cost_set_missing(test.viewContext(who.auth), { costSetId }) as any[])
        .map((r) => `${r.costSetId}|${r.draftMode.tag}|${r.kind}|${r.name}`).sort();

/** Reference data c1..c3 and l1, l2; an owner, a rival host, a Moderator and a plain user. */
function completenessWorld() {
    const test = newBareHarness(); // fix pass (review F2): the clones of set 0 carry no coverage rows
    seedReferenceNames(test, ['c1', 'c2', 'c3'], ['l1', 'l2']);
    return { test, owner: tournamentHost(test, 'owner'), rival: tournamentHost(test, 'rival'), mod: moderator(test), plain: verified(test, 'plain') };
}

describe('A107(2): view_cost_set_missing and publish_cost_set completeness', () => {
    it('the owner and a Moderator see, per priced draft mode, the characters and light cones without a draft row; a rival host, a plain user and an unknown id get nothing (A107(2))', () => {
        const { test, owner, rival, mod, plain } = completenessWorld();
        const id = createSet(test, owner, 'gappy');
        editChar(test, owner, id, 'c1', 'Classic', ladder(1));
        editLc(test, owner, id, 'l1', 'Classic', sLadder(1));
        editChar(test, owner, id, 'c1', 'Auction', ladder(1));
        const expected = [
            'Auction|Character|c2', 'Auction|Character|c3', 'Auction|Lightcone|l1', 'Auction|Lightcone|l2',
            'Classic|Character|c2', 'Classic|Character|c3', 'Classic|Lightcone|l2',
        ].map((x) => `${id}|${x}`);
        expect(missingView(test, owner, id)).toEqual(expected);
        expect(missingView(test, mod, id)).toEqual(expected);
        expect(missingView(test, rival, id)).toEqual([]);
        expect(missingView(test, plain, id)).toEqual([]);
        expect(missingView(test, owner, 4040)).toEqual([]);
    });

    it('a draft mode the set does not price is not listed (A107(2))', () => {
        const { test, owner } = completenessWorld();
        const id = createSet(test, owner, 'classic only');
        editChar(test, owner, id, 'c1', 'Classic', ladder(1));
        expect(missingView(test, owner, id)).toEqual(
            ['Classic|Character|c2', 'Classic|Character|c3', 'Classic|Lightcone|l1', 'Classic|Lightcone|l2'].map((x) => `${id}|${x}`));
    });

    it('publish without confirmation is refused with the per-kind and per-mode counts and publishes nothing; with it the gaps are written at 0 in the draft and the live copy, priced modes only (A107(2))', () => {
        const { test, owner } = completenessWorld();
        const id = createSet(test, owner, 'gappy');
        editChar(test, owner, id, 'c1', 'Classic', ladder(1));
        editLc(test, owner, id, 'l1', 'Classic', sLadder(1));
        editChar(test, owner, id, 'c1', 'Auction', ladder(2));
        const before = snap(test.db.CostSet.id.find(id), draftChars(test, id), draftLcs(test, id), liveChars(test, id), liveLcs(test, id));
        const msg = rejection(test, owner, publishBody(id));
        expect(snap(test.db.CostSet.id.find(id), draftChars(test, id), draftLcs(test, id), liveChars(test, id), liveLcs(test, id))).toBe(before);
        expect(msg).toBe('This cost set has no cost for 4 characters and 3 light cones (Auction: 2 characters, 2 light cones; Classic: 2 characters, 1 light cones). Confirm to publish them at cost 0.');

        publish(test, owner, id, true);
        expect(test.db.CostSet.id.find(id)).toMatchObject({ isDraft: false, isPublished: true });
        expect(priceImage(draftChars(test, id))).toEqual(['c1|Auction|2', 'c1|Classic|1', 'c2|Auction|0', 'c2|Classic|0', 'c3|Auction|0', 'c3|Classic|0']);
        expect(priceImage(draftLcs(test, id))).toEqual(['l1|Auction|0', 'l1|Classic|1', 'l2|Auction|0', 'l2|Classic|0']);
        expect(priceImage(liveChars(test, id))).toEqual(priceImage(draftChars(test, id)));
        expect(priceImage(liveLcs(test, id))).toEqual(priceImage(draftLcs(test, id)));
        for (const r of ([...liveChars(test, id), ...liveLcs(test, id)] as any[]).filter((x) => (x.characterName ?? x.lightconeName) !== 'c1' && !((x.lightconeName === 'l1') && x.draftMode.tag === 'Classic'))) {
            expect(Object.values(r.costs).every((v) => v === 0)).toBe(true); // every eidolon / superimposition at 0
        }
        expect(missingView(test, owner, id)).toEqual([]);

        // Priced modes only: a Classic-only set gets no Auction row from the fill.
        const classicOnly = createSet(test, owner, 'classic only');
        editChar(test, owner, classicOnly, 'c1', 'Classic', ladder(1));
        publish(test, owner, classicOnly, true);
        expect([...liveChars(test, classicOnly), ...liveLcs(test, classicOnly)].map((r) => r.draftMode.tag)).not.toContain('Auction');
        expect(liveChars(test, classicOnly)).toHaveLength(3);
        expect(liveLcs(test, classicOnly)).toHaveLength(2);
    });

    it('a complete draft publishes without confirmation (A107(2))', () => {
        const { test, owner } = completenessWorld();
        const id = createSet(test, owner, 'complete');
        for (const c of ['c1', 'c2', 'c3']) editChar(test, owner, id, c, 'Classic', ladder(1));
        for (const l of ['l1', 'l2']) editLc(test, owner, id, l, 'Classic', sLadder(1));
        publish(test, owner, id);
        expect(test.db.CostSet.id.find(id)).toMatchObject({ isPublished: true });
        expect(liveChars(test, id)).toHaveLength(3);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B.5 A107(3)(4): patch in place
// ════════════════════════════════════════════════════════════════════════════

/** A published set (complete in Classic): k 10.., k2 30.., lc 5.., synergy k + k2 = 1. */
function patchWorld() {
    const test = newBareHarness(); // fix pass (review F2): the clone of set 0 carries no coverage rows
    const owner = tournamentHost(test, 'owner');
    seedReferenceNames(test, ['k', 'k2'], ['lc']);
    const id = createSet(test, owner, 'patchable');
    editChar(test, owner, id, 'k', 'Classic', ladder(10));
    editChar(test, owner, id, 'k2', 'Classic', ladder(30));
    editLc(test, owner, id, 'lc', 'Classic', sLadder(5));
    editSyn(test, owner, id, 'k', 'k2', 'Classic', 1);
    publish(test, owner, id);
    return { test, owner, id };
}

/** Distinct actor names per lobby in one harness (identities come from the JWT sub). */
const seatsFor = (tag: string): SetupOpts => ({ seats: [[`${tag}-b`, 'BluePlayer'], [`${tag}-r`, 'RedPlayer']] });
function lobbyOn(test: Harness, costSetId: number, tag: string, over: SetupOpts = {}): Lobby {
    return setupLobby(test, { ...seatsFor(tag), actors: { host: guest(test, `${tag}-host`) }, lobby: { costSetId }, ...over });
}

describe('A107(3)(4): a published set is patched in place', () => {
    it('an edit reaches the live rows only at the next publish; the live rows then equal the draft under the same id; unchanged rows are not rewritten; synergies included (A107(3))', () => {
        const { test, owner, id } = patchWorld();
        const k2Before = snap(charRow(liveChars(test, id), 'k2'));
        const lcBefore = snap(lcRow(liveLcs(test, id), 'lc'));
        const kBefore = charRow(liveChars(test, id), 'k')!;
        const synBefore = liveSyns(test, id)[0];
        advance(test, 5_000);

        editChar(test, owner, id, 'k', 'Classic', ladder(20));
        editSyn(test, owner, id, 'k2', 'k', 'Classic', 2.5);
        expect(charRow(liveChars(test, id), 'k')!.costs.e0).toBe(10); // live untouched until publish
        expect(liveSyns(test, id)[0].costModifier).toBe(1);

        publish(test, owner, id);
        expect(test.db.CostSet.id.find(id)).toMatchObject({ id, isPublished: true, isDraft: false });
        const kAfter = charRow(liveChars(test, id), 'k')!;
        expect(kAfter.costs.e0).toBe(20);
        expect(kAfter.createdDate).toEqual(kBefore.createdDate); // auditUpdate keeps the creation stamp
        expect(kAfter.lastModifiedDate.microsSinceUnixEpoch).toBeGreaterThan(kBefore.lastModifiedDate.microsSinceUnixEpoch);
        expect(snap(charRow(liveChars(test, id), 'k2'))).toBe(k2Before); // unchanged: not rewritten
        expect(snap(lcRow(liveLcs(test, id), 'lc'))).toBe(lcBefore);
        const synAfter = liveSyns(test, id)[0];
        expect(liveSyns(test, id)).toHaveLength(1);
        expect(synAfter).toMatchObject({ id: synBefore.id, costModifier: 2.5 });
        expect(priceImage(liveChars(test, id))).toEqual(priceImage(draftChars(test, id)));
        expect(priceImage(liveLcs(test, id))).toEqual(priceImage(draftLcs(test, id)));
    });

    // No reducer removes a single draft row (edit_draft_* upserts, delete_cost_set removes the whole set). The engineered
    // case below documents what publish does with a live row that has no draft row.
    it('engineered: a live row with no draft row is deleted by the next publish (A107(3); no reducer removes one draft row)', () => {
        const { test, owner, id } = patchWorld();
        test.db.CostSetDraftCharacter.delete(charRow(draftChars(test, id), 'k2')!);
        test.db.CostSetDraftSynergy.delete(draftSyns(test, id)[0]);
        publish(test, owner, id, true); // k2 is a gap again: confirmed at 0
        expect(charRow(liveChars(test, id), 'k2')!.costs.e0).toBe(0);
        expect(liveSyns(test, id)).toHaveLength(0);
    });

    it('lobbies in Waiting and AwaitingResult do not block a patch; Drafting, Equipping and Scoring do, with the count; once those games end the patch passes (A107(4))', () => {
        const { test, owner, id } = patchWorld();
        // The lobby drivers add reference rows for the names they draft, so every publish here confirms the gaps (A107(2)).
        const waiting = lobbyOn(test, id, 'w', { noStart: true });
        const parked = parkedLobby(test, { lobby: { costSetId: id } });
        expect([lobbyRow(test, waiting.lobbyId).stage.tag, lobbyRow(test, parked.lobbyId).stage.tag]).toEqual(['Waiting', 'AwaitingResult']);
        editChar(test, owner, id, 'k', 'Classic', ladder(11));
        publish(test, owner, id, true);
        expect(charRow(liveChars(test, id), 'k')!.costs.e0).toBe(11);

        const one = lobbyOn(test, id, 'one'); // Drafting
        editChar(test, owner, id, 'k', 'Classic', ladder(12)); // the draft stays editable while games run
        let before = snap(liveChars(test, id), test.db.CostSet.id.find(id));
        let msg = rejection(test, owner, publishBody(id, true));
        expect(snap(liveChars(test, id), test.db.CostSet.id.find(id))).toBe(before);
        expect(msg).toBe(PATCH_BLOCKED(1));

        const two = lobbyOn(test, id, 'two');
        completeDraft(two); // Equipping
        before = snap(liveChars(test, id));
        msg = rejection(test, owner, publishBody(id, true));
        expect(msg).toBe(PATCH_BLOCKED(2));
        tx(test, two.host, advanceBody(two)); // Scoring still blocks
        msg = rejection(test, owner, publishBody(id, true));
        expect(snap(liveChars(test, id))).toBe(before);
        expect(msg).toBe(PATCH_BLOCKED(2));

        completeDraft(one);
        finishGame(one); // casual: finalized at the close, the lobby is gone
        msg = rejection(test, owner, publishBody(id, true));
        expect(msg).toBe(PATCH_BLOCKED(1));
        finishGame(two);
        publish(test, owner, id, true);
        expect(charRow(liveChars(test, id), 'k')!.costs.e0).toBe(12);
    });

    it('a preset and a tournament pointing at the set are not changed by a patch and their next lobby reads the new prices (A107(3))', () => {
        // Preset.
        const { test, owner, id } = patchWorld();
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'on the set', costSetId: id } as any));
        const preset = [...test.db.LobbyPreset.iter()].find((p) => p.name === 'on the set')!;
        const presetBefore = snap(preset);
        editChar(test, owner, id, 'k', 'Classic', ladder(20));
        publish(test, owner, id);
        expect(snap(test.db.LobbyPreset.id.find(preset.id))).toBe(presetBefore);
        const s = lobbyOn(test, id, 'p', { lobby: { costSetId: preset.costSetId } });
        tx(test, captain(s, 'Blue'), pickBody(s, 'k'));
        expect(payloadOf(test, s.lobbyId, 'Pick')).toMatchObject({ characterName: 'k', costPaid: 20 });

        // Tournament: the organizer's set is pointed at by the tournament row (engineered selection: the set is created
        // after the field, and the selection path is not the subject here).
        const f = liveField(2);
        seedReferenceNames(f.test, ['k'], ['lc']);
        const tid = createSet(f.test, f.org, 'cup set');
        editChar(f.test, f.org, tid, 'k', 'Classic', ladder(10));
        editLc(f.test, f.org, tid, 'lc', 'Classic', sLadder(5));
        publish(f.test, f.org, tid, true);
        f.test.db.Tournament.id.update({ ...f.test.db.Tournament.id.find(f.id)!, costSetId: tid });
        const tBefore = snap(f.test.db.Tournament.id.find(f.id));
        editChar(f.test, f.org, tid, 'k', 'Classic', ladder(40));
        publish(f.test, f.org, tid, true);
        expect(snap(f.test.db.Tournament.id.find(f.id))).toBe(tBefore);
        const ts = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        expect(lobbyRow(f.test, ts.lobbyId).costSetId).toBe(tid);
        for (let i = 0; session(f.test, ts.lobbyId).draftSequence[session(f.test, ts.lobbyId).turnIndex].actionRequired.tag === 'Ban'; i++) {
            const team = session(f.test, ts.lobbyId).draftSequence[session(f.test, ts.lobbyId).turnIndex].teamTurn.tag as Team;
            tx(f.test, captainActor(ts, team), (ctx) => (priceBanNames(ctx, ts.lobbyId, [`tb-${i}`]), M.ban_character(ctx, { lobbyId: ts.lobbyId, characterName: `tb-${i}` }))); // T-S10r (A122(7), L32): a ban names a priced character
        }
        tx(f.test, captainActor(ts, 'Blue'), pickBody(ts, 'k'));
        expect(payloadOf(f.test, ts.lobbyId, 'Pick')).toMatchObject({ characterName: 'k', costPaid: 40 });
    });

    it('a clone copies the live rows, not pending draft edits; a set published before S10i (no draft rows) rebuilds its draft on the first edit (A107(3))', () => {
        const { test, owner, id } = patchWorld();
        editChar(test, owner, id, 'k', 'Classic', ladder(20)); // pending, not published
        const copy = createSet(test, owner, 'copy', id);
        expect(charRow(draftChars(test, copy), 'k')!.costs.e0).toBe(10);

        // Engineered pre-S10i state: publish used to delete the draft rows.
        const old = createSet(test, owner, 'old');
        editChar(test, owner, old, 'k', 'Classic', ladder(10));
        editChar(test, owner, old, 'k2', 'Classic', ladder(30));
        editLc(test, owner, old, 'lc', 'Classic', sLadder(5));
        editSyn(test, owner, old, 'k', 'k2', 'Classic', 1);
        publish(test, owner, old);
        for (const r of draftChars(test, old)) test.db.CostSetDraftCharacter.delete(r);
        for (const r of draftLcs(test, old)) test.db.CostSetDraftLightcone.delete(r);
        for (const r of draftSyns(test, old)) test.db.CostSetDraftSynergy.delete(r);
        editChar(test, owner, old, 'k2', 'Classic', ladder(31));
        expect(priceImage(draftChars(test, old))).toEqual(['k2|Classic|31', 'k|Classic|10']);
        expect(priceImage(draftLcs(test, old))).toEqual(['lc|Classic|5']);
        expect(draftSyns(test, old).map((r) => [r.characterA, r.characterB, r.costModifier])).toEqual([['k', 'k2', 1]]);
    });

    it('a locked or an unpublished set rejects edits and publish with their texts; delete clears the draft and the live rows (A107(3))', () => {
        const { test, owner, id } = patchWorld();
        tx(test, owner, (ctx) => M.lock_cost_set(ctx, { costSetId: id }));
        expect(rejection(test, owner, (ctx) => M.edit_draft_character_cost(ctx, { costSetId: id, characterName: 'k', gameModeTag: MOC, draftModeTag: 'Classic', costsJson: eJson(ladder(1)) }))).toBe(LOCKED);
        expect(rejection(test, owner, publishBody(id, true))).toBe(LOCKED);
        tx(test, owner, (ctx) => M.unpublish_cost_set(ctx, { costSetId: id }));
        expect(rejection(test, owner, (ctx) => M.edit_draft_lightcone_cost(ctx, { costSetId: id, lightconeName: 'lc', gameModeTag: MOC, draftModeTag: 'Classic', costsJson: sJson(sLadder(1)) }))).toBe(UNPUBLISHED);
        expect(rejection(test, owner, publishBody(id, true))).toBe(UNPUBLISHED);
        tx(test, owner, (ctx) => M.delete_cost_set(ctx, { costSetId: id }));
        expect([draftChars, draftLcs, draftSyns, liveChars, liveLcs, liveSyns].map((f) => f(test, id).length)).toEqual([0, 0, 0, 0, 0, 0]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B.6 A107(6): history keeps its stored costs
// ════════════════════════════════════════════════════════════════════════════

// T-S10n (A115): the history views are the paged list, its count, the per-match detail views and the paged ratings.
const HISTORY_VIEWS = (matchHistoryId: number): Array<[string, Record<string, unknown>]> => [
    ['view_my_match_history', { page: 0, gameMode: '', draftMode: '', matchType: '' }],
    ['view_my_match_history_count', { gameMode: '', draftMode: '', matchType: '' }],
    ['view_my_match_history_steps', { matchHistoryId }], ['view_my_match_history_lineups', { matchHistoryId }],
    ['view_my_match_history_games', { matchHistoryId }], ['view_my_match_history_participants', { matchHistoryId }],
    ['view_my_mmr_history', { page: 0, gameMode: '' }],
];

describe('A107(6): a patch never touches history', () => {
    it('after a game on the set is finalized, patching its prices leaves the history rows and the history views byte-for-byte unchanged (A107(6))', () => {
        const { test, owner, id } = patchWorld();
        const s = lobbyOn(test, id, 'h');
        tx(test, captain(s, 'Blue'), pickBody(s, 'k'));
        completeDraft(s);
        tx(test, captain(s, 'Blue'), equipBody(s, 'Blue', 'k', 'lc'));
        finishGame(s, 'Blue');
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy(); // casual: finalized at the close
        const reader = s.a['h-b'];
        const matchHistoryId = [...test.db.MatchParticipantHistory.by_user.filter(reader.userId)][0].matchHistoryId;
        const history = () => snap(
            [...test.db.MatchSessionHistory.iter()], [...test.db.MatchSessionStepHistory.iter()], [...test.db.MatchLineupHistory.iter()],
            [...test.db.MatchResultGameHistory.iter()], [...test.db.MatchParticipantHistory.iter()],
            HISTORY_VIEWS(matchHistoryId).map(([v, args]) => (M as any)[v](test.viewContext(reader.auth), args)),
        );
        // The archived step payload is the step's StepPayload as a JSON string.
        const stepPayloads = [...test.db.MatchSessionStepHistory.iter()].map((r: any) => JSON.parse(r.payload));
        expect(stepPayloads.find((p) => p.tag === 'Pick' && p.value.characterName === 'k').value.costPaid).toBe(10);
        expect(stepPayloads.find((p) => p.tag === 'EquipLightcone').value.costPaid).toBe(5);
        const before = history();

        editChar(test, owner, id, 'k', 'Classic', ladder(99));
        editLc(test, owner, id, 'lc', 'Classic', sLadder(99));
        editSyn(test, owner, id, 'k', 'k2', 'Classic', 50);
        publish(test, owner, id, true);
        expect(charRow(liveChars(test, id), 'k')!.costs.e0).toBe(99);
        expect(history()).toBe(before);
    });
});

/** create_lobby_preset arguments (as s8f-membership). */
const PRESET_ARGS = {
    teamSize: 2, draftMode: { tag: 'Classic' }, banMode: { tag: 'None' }, gameMode: { tag: 'MemoryOfChaos' },
    matchType: { tag: 'Casual' }, standardTurnSeconds: 30, reserveBankSeconds: 60, characterBudget: 100,
    lightconeBudget: 50, minimumBidRaise: 1, rosterDiffAdvantage: 0, rosterThreshold: 0, underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0, deathPenalty: 0, isPublic: true, isAnonymousPlayers: false, isAnonymousSpectators: false,
    rosterVisibility: { tag: 'OpenRoster' }, requireOwnership: false, costSetId: 0, disconnectPolicy: { tag: 'Standard' },
    disconnectForfeitSeconds: 60, allowMirrorPicks: false, autoRandomPick: false, refereeCanUndo: true,
    refereeCanPause: true, refereeCanSetCaptain: true, refereeCanKick: true, allowPlayerPause: true,
    refereeExclusiveConcede: true,
};
