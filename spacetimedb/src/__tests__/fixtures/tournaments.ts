// Fixtures: tournaments, registration, teams, staff actions, account locks and brackets.
// From S8 (s8-fixtures.ts); staff bodies and waitlist rows (S10g), account locks (S10 A1 / A2), live solo entries
// (S10q) and the permission texts gathered by T-REORG2. Users and roles live in identity.ts, HSR accounts in roster.ts.
//
// T-S8b / T-S8c: builders for the in-memory tournament tests (permissions, stage machine, registration, teams,
// bracket reducers). Not a test file. State is built through the module's reducers; account locks are written straight
// into the in-memory datastore, outside any reducer, like the S4 / S7 tests' direct row edits. Since S8c,
// seed_bracket + generate_bracket stamp lastSeedChangeAt / bracketGeneratedAt themselves (`seedAndGenerate`);
// `stampGenerated` / `stampSeedChange` stay for the guard tests whose field cannot be generated. `test.db` is read only
// outside `tx` bodies. Nothing reaches maincloud.
import { Timestamp } from 'spacetimedb';
import { TOURNAMENT_PERM_MESSAGES } from '@module/helpers/tournament/tournamentPermissions';
import { AUDIT, M, newHarness, tx, type Actor, type Harness } from './harness';
import { host, verified } from './identity';

// ─── Texts ───────────────────────────────────────────────────────────────────

export const PARTICIPANTS = TOURNAMENT_PERM_MESSAGES.participants;
export const BRACKET = TOURNAMENT_PERM_MESSAGES.bracket;
export const RESULTS = TOURNAMENT_PERM_MESSAGES.results;
export const guestsText = (n: number) => `These settings require verified accounts, and ${n} guest player(s) are registered.`;

// ─── Tournaments ─────────────────────────────────────────────────────────────

/** Best of 1 for every round, the grand final included. */
export const BO1 = { defaultBestOf: 1, grandFinalBestOf: 1 };

/** The full A36 create_tournament argument set: SingleElimination, teamSize 2, 8 spots, no gates. */
export const TOURNAMENT_ARGS = {
    name: 'S8b cup',
    description: '',
    format: 'SingleElimination',
    teamSize: 2,
    maxParticipants: 8,
    rosterVisibility: 'ClosedNoRating', // S10m: A113(1) forces requireVerified for any other value; "no gates" keeps guests able to register
    isAnonymousDefault: false,
    disconnectPolicy: 'Standard',
    disconnectForfeitSeconds: undefined as number | undefined,
    costSetId: 0,
    defaultBestOf: 1,
    grandFinalBestOf: 3,
    winnerAdvantage: 0,
    groupSize: 4,
    groupAdvanceCount: 2,
    groupAssignmentMode: 'Auto',
    has3rdPlaceMatch: false,
    checkInEnabled: false,
    requireResultValidation: false,
    requireOwnership: false,
    allowMirrorPicks: false,
    lineupFormat: 'Halves',
    lobbyPresetId: undefined as number | undefined,
    requireVerified: false,
    requireRoster: false,
    minimumMmr: undefined as number | undefined,
    requireApproval: false,
    waitlistEnabled: false,
    scheduledStartAt: '',
    registrationDeadline: '',
    maxAccountsPerPlayer: 1,
    defaultGameMode: 'MemoryOfChaos',
    countTowardsMmr: false,
};
export type TournamentArgs = typeof TOURNAMENT_ARGS;

/** update_tournament arguments that keep a tournament's current settings, with overrides. */
export function updateArgs(test: Harness, tournamentId: number, over: Partial<TournamentArgs> = {}) {
    const t = tRow(test, tournamentId);
    const { defaultGameMode: _g, countTowardsMmr: _c, ...rest } = TOURNAMENT_ARGS;
    return {
        ...rest,
        tournamentId,
        name: t.name,
        format: t.format.tag,
        teamSize: t.teamSize,
        maxParticipants: t.maxParticipants,
        checkInEnabled: t.checkInEnabled,
        requireApproval: t.requireApproval,
        waitlistEnabled: t.waitlistEnabled,
        isAnonymousDefault: t.isAnonymousDefault,
        groupAssignmentMode: t.groupAssignmentMode.tag,
        groupSize: t.groupSize,
        ...over,
    };
}

/** create_tournament as `organizer` (a Tournament Host); returns the new tournament id. */
export function createTournament(test: Harness, organizer: Actor, over: Partial<TournamentArgs> = {}): number {
    tx(test, organizer, (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS, ...over } as any));
    return Math.max(...[...test.db.Tournament.organizer_id.filter(organizer.userId)].map((t) => t.id));
}

export const tRow = (test: Harness, tournamentId: number) => test.db.Tournament.id.find(tournamentId)!;
export const stageOf = (test: Harness, tournamentId: number) => tRow(test, tournamentId).stage.tag;

export function advanceStage(test: Harness, who: Actor, tournamentId: number, nextStage: string) {
    tx(test, who, (ctx) => M.advance_tournament_stage(ctx, { tournamentId, nextStage }));
}

/** Creates the tournament and opens registration. */
export function openTournament(test: Harness, organizer: Actor, over: Partial<TournamentArgs> = {}): number {
    const id = createTournament(test, organizer, over);
    advanceStage(test, organizer, id, 'Registration');
    return id;
}

export interface RegisterOpts {
    hsrAccountIds?: number[];
    anonymousAlias?: string;
    allowRandomTeamAssignment?: boolean;
}

export function register(test: Harness, who: Actor, tournamentId: number, opts: RegisterOpts = {}) {
    tx(test, who, (ctx) => M.register_for_tournament(ctx, { tournamentId, ...opts }));
}

/** `n` verified players registered for the tournament (names `${prefix}1..n`). */
export function enrollMany(test: Harness, tournamentId: number, n: number, prefix = 'p', opts: RegisterOpts = {}): Actor[] {
    return Array.from({ length: n }, (_, i) => {
        const a = verified(test, `${prefix}${i + 1}`);
        register(test, a, tournamentId, opts);
        return a;
    });
}

/** The captain creates a team; each member requests to join and the captain accepts. Returns the team id. */
export function makeTeam(test: Harness, tournamentId: number, captain: Actor, members: Actor[], name: string): number {
    tx(test, captain, (ctx) => M.create_tournament_team(ctx, { tournamentId, teamName: name }));
    const teamId = [...test.db.TournamentTeam.tournament_id.filter(tournamentId)].find((t) => t.name === name)!.id;
    for (const m of members) {
        tx(test, m, (ctx) => M.request_join_team(ctx, { teamId }));
        tx(test, captain, (ctx) => M.accept_team_request(ctx, { teamId, userId: m.userId }));
    }
    return teamId;
}

/** Enrolls 2·`teams` players and pairs them into full teams of two (teamSize 2). Returns [captain, mate, teamId][]. */
export function fullTeams(test: Harness, tournamentId: number, teams: number, prefix = 't'): Array<{ captain: Actor; mate: Actor; teamId: number }> {
    return Array.from({ length: teams }, (_, i) => {
        const [captain, mate] = enrollMany(test, tournamentId, 2, `${prefix}${i + 1}-`);
        return { captain, mate, teamId: makeTeam(test, tournamentId, captain, [mate], `${prefix} team ${i + 1}`) };
    });
}

export const enrolled = (test: Harness, tournamentId: number, userId: number) =>
    [...test.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, userId])][0];
export const enrolledAll = (test: Harness, tournamentId: number) => [...test.db.TournamentEnrolled.tournament_id.filter(tournamentId)];
export const teams = (test: Harness, tournamentId: number) => [...test.db.TournamentTeam.tournament_id.filter(tournamentId)];
export const teamRow = (test: Harness, teamId: number) => test.db.TournamentTeam.id.find(teamId);
export const membersOf = (test: Harness, teamId: number) =>
    [...test.db.TournamentTeamMember.team_id.filter(teamId)].map((m) => m.userId).sort((a, b) => a - b);
export const membership = (test: Harness, tournamentId: number, userId: number) =>
    [...test.db.TournamentTeamMember.by_tournament_and_user.filter([tournamentId, userId])][0];
export const locks = (test: Harness, tournamentId: number, userId: number) =>
    [...test.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, userId])].map((r) => r.hsrAccountId).sort((a, b) => a - b);
export const requestsOf = (test: Harness, userId: number) => [...test.db.TournamentTeamRequest.user_id.filter(userId)];

/** A TournamentPlayerAccount lock (what registration writes), inserted directly. */
export function lockAccount(test: Harness, tournamentId: number, userId: number, hsrAccountId: number) {
    test.db.TournamentPlayerAccount.insert({ tournamentId, userId, hsrAccountId, ...AUDIT(test) });
}

/** The user's waitlist account ids in the tournament, ascending. */
export const waitlistRows = (test: Harness, tournamentId: number, userId: number) =>
    [...test.db.TournamentWaitlistAccount.by_tournament_and_user.filter([tournamentId, userId])].map((r) => r.hsrAccountId).sort((a, b) => a - b);

// ─── Staff action bodies ─────────────────────────────────────────────────────

export const dq = (tournamentId: number, userId: number, dqWholeTeam = false) =>
    (ctx: any) => M.dq_participant(ctx, { tournamentId, userId, reason: 'test', dqWholeTeam });
export const lockBody = (tournamentId: number, hsrAccountIds: number[]) =>
    (ctx: any) => M.lock_tournament_accounts(ctx, { tournamentId, hsrAccountIds });

/** A tournament assistant row through the reducer (owner permission). */
export function assignAssistant(
    test: Harness,
    by: Actor,
    tournamentId: number,
    who: Actor,
    flags: { participants?: boolean; bracket?: boolean; results?: boolean },
) {
    tx(test, by, (ctx) => M.assign_tournament_assistant(ctx, {
        tournamentId,
        userId: who.userId,
        canManageParticipants: flags.participants ?? false,
        canManageBracket: flags.bracket ?? false,
        canResolveResults: flags.results ?? false,
    }));
}

/** seed_bracket on the Ready teams (default 'mmr': equal ratings → team-id order). */
export function seedBracket(test: Harness, who: Actor, tournamentId: number, mode: 'mmr' | 'random' = 'mmr') {
    tx(test, who, (ctx) => M.seed_bracket(ctx, { tournamentId, mode }));
}

/** generate_bracket (S8c: stamps bracketGeneratedAt and writes groupId itself). */
export function generateBracket(test: Harness, who: Actor, tournamentId: number) {
    tx(test, who, (ctx) => M.generate_bracket(ctx, { tournamentId }));
}

/** S8c (replaces the S8b `generateAndStamp`): seed the Ready teams, then generate the bracket through the reducers. */
export function seedAndGenerate(test: Harness, who: Actor, tournamentId: number, mode: 'mmr' | 'random' = 'mmr') {
    seedBracket(test, who, tournamentId, mode);
    generateBracket(test, who, tournamentId);
}

export function stampGenerated(test: Harness, tournamentId: number) {
    test.db.Tournament.id.update({ ...tRow(test, tournamentId), bracketGeneratedAt: test.clock.now() });
}

export function stampSeedChange(test: Harness, tournamentId: number, at: Timestamp = test.clock.now()) {
    test.db.Tournament.id.update({ ...tRow(test, tournamentId), lastSeedChangeAt: at });
}

/**
 * An update_tournament reducer body with the arguments computed now (updateArgs reads `test.db`, which must not
 * happen inside a transaction body). Use as `tx(test, who, updateBody(test, id, {...}))` or with expectReject.
 */
export function updateBody(test: Harness, tournamentId: number, over: Partial<TournamentArgs> = {}) {
    const args = updateArgs(test, tournamentId, over);
    return (ctx: any) => M.update_tournament(ctx, args as any);
}

// ─── T-S8c: bracket builders ──────────────────────────────────────────────────

export const bracketRows = (test: Harness, tournamentId: number) => [...test.db.BracketMatch.tournament_id.filter(tournamentId)];
export const bracketByKey = (test: Harness, tournamentId: number) =>
    new Map(bracketRows(test, tournamentId).map((r) => [r.positionKey, r]));
export const matchRow = (test: Harness, matchId: number) => test.db.BracketMatch.id.find(matchId)!;

/** A tournament in Seeding with `n` full Ready teams of two (team ids ascending in creation order). */
export function seedingField(n: number, over: Partial<TournamentArgs> = {}) {
    const test = newHarness();
    const org = host(test);
    const id = openTournament(test, org, { maxParticipants: Math.max(8, 2 * n), ...over });
    const ts = fullTeams(test, id, n);
    advanceStage(test, org, id, 'Seeding');
    return { test, org, id, ts };
}

/** seedingField + seed ('mmr': team-id order) + generate + Seeding → InProgress (Ready teams → Active). */
export function liveField(n: number, over: Partial<TournamentArgs> = {}) {
    const s = seedingField(n, over);
    seedAndGenerate(s.test, s.org, s.id);
    advanceStage(s.test, s.org, s.id, 'InProgress');
    return s;
}

/** resolve_bracket_match as `who`. */
export function resolveMatch(test: Harness, who: Actor, bracketMatchId: number, winnerTeamId: number, reason = 'staff') {
    tx(test, who, (ctx) => M.resolve_bracket_match(ctx, { bracketMatchId, winnerTeamId, reason }));
}

/** A solo (teamSize 1) tournament in InProgress with `players` registered; the bracket match holding `who`. */
export function soloLive(test: Harness, org: Actor, players: Actor[], who: Actor) {
    const id = openTournament(test, org, { teamSize: 1, maxParticipants: Math.max(4, players.length) });
    for (const p of players) register(test, p, id);
    advanceStage(test, org, id, 'Seeding');
    seedAndGenerate(test, org, id);
    advanceStage(test, org, id, 'InProgress');
    const teamId = membership(test, id, who.userId)!.teamId;
    const match = bracketRows(test, id).find((m) => m.team1Id === teamId || m.team2Id === teamId)!;
    return { id, teamId, match };
}
