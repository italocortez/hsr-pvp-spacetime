// T-S10 batch C1: helpers shared by s10-achievements / s10-identity / s10-identity-gc / s10-cost-data. Not a test
// file. Copies of small local helpers from s9b-views (createAchievement) and s6-rules (E, S, publishedCostSet), plus
// the new builders this batch needs. State is built through the module's reducers; `test.db` is read only outside
// `tx` bodies (reading it inside `withReducerTx` crashes the in-memory datastore). Nothing reaches maincloud.
import { ConnectionId } from 'spacetimedb';
import { M, TestAuth, tx, type Actor, type Harness } from './s4-fixtures';

// ─── Achievements ────────────────────────────────────────────────────────────

/** create_achievement as `who`; returns the new id (copy of the s9b-views helper, with optional maxAwards). */
export function createAchievement(test: Harness, who: Actor | 'internal', name: string, isManualOnly: boolean, maxAwards?: number): number {
    tx(test, who, (ctx) => M.create_achievement(ctx, { name, description: name, rarity: { tag: 'Rare' } as any, isManualOnly, maxAwards }));
    return test.db.Achievement.name.find(name)!.id;
}

/** add_achievement_criteria as `who` (PlayerStat.matchesPlayed >= threshold unless overridden). */
export function addCriteria(
    test: Harness,
    who: Actor | 'internal',
    achievementId: number,
    over: Partial<{ statTable: string; statField: string; thresholdValue: number; filterGameMode: string }> = {},
) {
    tx(test, who, (ctx) => M.add_achievement_criteria(ctx, {
        achievementId,
        statTable: over.statTable ?? 'PlayerStat',
        statField: over.statField ?? 'matchesPlayed',
        operator: { tag: 'GreaterOrEqual' } as any,
        thresholdValue: over.thresholdValue ?? 1,
        filterGameMode: over.filterGameMode,
        filterCharacterName: undefined,
        filterMatchType: undefined,
    }));
}

export const criteriaOf = (test: Harness, achievementId: number) => [...test.db.AchievementCriteria.by_achievement.filter(achievementId)];
export const awardsOf = (test: Harness, achievementId: number) => [...test.db.UserAchievement.by_achievement.filter(achievementId)];

export function award(test: Harness, who: Actor | 'internal', achievementId: number, targetUserId: number) {
    tx(test, who, (ctx) => M.manual_award_achievement(ctx, { achievementId, targetUserId }));
}

// ─── Identity ────────────────────────────────────────────────────────────────

let nextConn = 900_000n;

/** A client identity that has never called login_as_guest (no UserIdentity row). */
export function freshAuth(test: Harness, sub: string) {
    const auth = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(nextConn++));
    return { auth, identity: test.viewContext(auth).sender };
}

export const providerOf = (test: Harness, a: Actor) => test.db.UserPrivate.userId.find(a.userId)?.providerId;
export const jobsFor = (test: Harness, userId: number) => [...test.db.UserDeletionJob.iter()].filter((j) => j.userId === userId);
export const identitiesOf = (test: Harness, userId: number) => [...test.db.UserIdentity.user_id.filter(userId)];

/** Fires the user's single pending UserDeletionJob by hand, as the scheduler would (the row is consumed first). */
export function fireDeletionJob(test: Harness, userId: number) {
    const jobs = jobsFor(test, userId);
    if (jobs.length !== 1) throw new Error(`fireDeletionJob: expected one job for user ${userId}, found ${jobs.length}`);
    test.db.UserDeletionJob.scheduledId.delete(jobs[0].scheduledId);
    tx(test, 'internal', (ctx) => M.run_user_deletion(ctx, { arg: jobs[0] }));
}

// ─── Cost data ───────────────────────────────────────────────────────────────

export const E = (n: number) => JSON.stringify({ e0: n, e1: n, e2: n, e3: n, e4: n, e5: n, e6: n });
export const S = (n: number) => JSON.stringify({ s1: n, s2: n, s3: n, s4: n, s5: n });
export const eCost = (n: number) => ({ e0: n, e1: n, e2: n, e3: n, e4: n, e5: n, e6: n });
export const sCost = (n: number) => ({ s1: n, s2: n, s3: n, s4: n, s5: n });

/** A published cost set (owner SYSTEM) with one character row and one light-cone row for MoC × the draft mode (copy of s6-rules). */
export function publishedCostSet(test: Harness, name: string, draftModeTag: 'Classic' | 'Auction' | null): number {
    tx(test, 'internal', (ctx) => M.create_cost_set(ctx, { name, sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
    const id = costSetId(test, name);
    if (draftModeTag) {
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

export const costSetId = (test: Harness, name: string) => [...test.db.CostSet.iter()].find((c) => c.name === name)!.id;
export const costSetRow = (test: Harness, id: number) => test.db.CostSet.id.find(id);

/** admin_bulk_upsert as `who` (default the owner, which init links to the SYSTEM Admin). */
export function bulkUpsert(test: Harness, tableName: string, rows: unknown[], who: Actor | 'internal' = 'internal') {
    tx(test, who, (ctx) => M.admin_bulk_upsert(ctx, { tableName, jsonData: JSON.stringify(rows) }));
}

type DM = 'Classic' | 'Auction';
type GM = 'MemoryOfChaos' | 'ApocalypticShadow' | 'AnomalyArbitration';

export const charCostRow = (characterName: string, draftMode: DM, n: number, costSetId = 0, gameMode: GM = 'MemoryOfChaos') =>
    ({ characterName, gameMode, draftMode, costs: eCost(n), costSetId });
export const lcCostRow = (lightconeName: string, draftMode: DM, n: number, costSetId = 0, gameMode: GM = 'MemoryOfChaos') =>
    ({ lightconeName, gameMode, draftMode, costs: sCost(n), costSetId });
export const synergyRow = (characterA: string, characterB: string, draftMode: DM, costModifier: number, costSetId = 0, gameMode: GM = 'MemoryOfChaos') =>
    ({ characterA, characterB, gameMode, draftMode, costModifier, costSetId });

/** A full HsrCharacter bulk-upsert row (A17 column set). */
export const characterRow = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    displayName: name,
    aliases: [] as string[],
    rarity: 5,
    path: 'Destruction',
    element: 'Physical',
    role: 'Dps',
    imageUrl: '',
    versionReleased: 1,
    treatAsVersion: 1,
    posX: 0,
    posY: 0,
    width: 0,
    ...over,
});

/** A full HsrLightcone bulk-upsert row. */
export const lightconeRow = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    displayName: name,
    aliases: [] as string[],
    path: 'Destruction',
    rarity: 5,
    imageUrl: '',
    posX: 0,
    posY: 0,
    width: 0,
    ...over,
});

export const liveChar = (test: Harness, costSetId: number) => [...test.db.HsrCharacterCost.cost_set_id.filter(costSetId)];
export const liveLc = (test: Harness, costSetId: number) => [...test.db.HsrLightconeCost.cost_set_id.filter(costSetId)];
export const liveSyn = (test: Harness, costSetId: number) => [...test.db.HsrSynergyCost.cost_set_id.filter(costSetId)];
export const draftChar = (test: Harness, costSetId: number) => [...test.db.CostSetDraftCharacter.cost_set_id.filter(costSetId)];
export const draftLc = (test: Harness, costSetId: number) => [...test.db.CostSetDraftLightcone.cost_set_id.filter(costSetId)];
export const draftSyn = (test: Harness, costSetId: number) => [...test.db.CostSetDraftSynergy.cost_set_id.filter(costSetId)];

/** `${name}|${gameMode}|${draftMode}` keys of cost rows, sorted (for set-shaped assertions). */
export const keysOf = (rows: Array<{ gameMode: { tag: string }; draftMode: { tag: string } } & Record<string, any>>, nameField: string) =>
    rows.map((r) => `${r[nameField]}|${r.gameMode.tag}|${r.draftMode.tag}`).sort();
