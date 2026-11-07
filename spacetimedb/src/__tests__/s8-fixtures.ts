// T-S8b: builders for the S8b in-memory tournament tests (permissions, stage machine, registration, teams).
// Not a test file: imported by s8b-*.test.ts. State is built through the module's reducers; roles, HSR accounts,
// rating rows and the transitional bracket stamps (bracketGeneratedAt / lastSeedChangeAt, which the legacy
// generate_bracket does not set until S8c) are written straight into the in-memory datastore, outside any reducer,
// like the S4 / S7 tests' direct row edits. `test.db` is read only outside `tx` bodies. Nothing reaches maincloud.
import { Timestamp } from 'spacetimedb';
import { M, guest, linkDiscord, tx, type Actor, type Harness } from './s4-fixtures';

export const AUDIT = (test: Harness) => {
    const ts = test.clock.now();
    return { createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts };
};

let nextProvider = 1;

/** A verified (Discord-linked) user. */
export function verified(test: Harness, name: string): Actor {
    const a = guest(test, name);
    linkDiscord(test, a, `discord-${name}-${nextProvider++}`, name);
    return a;
}

/** Sets a user's role directly on the row. */
export function setUserRole(test: Harness, userId: number, role: 'User' | 'TournamentHost' | 'Moderator' | 'Admin') {
    test.db.User.id.update({ ...test.db.User.id.find(userId)!, role: { tag: role } as any });
}

/** A verified Tournament Host (may call create_tournament). */
export function host(test: Harness, name = 'org'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'TournamentHost');
    return a;
}

/** A verified Moderator. */
export function moderator(test: Harness, name = 'mod'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Moderator');
    return a;
}

/** The full A36 create_tournament argument set: SingleElimination, teamSize 2, 8 spots, no gates. */
export const TOURNAMENT_ARGS = {
    name: 'S8b cup',
    description: '',
    format: 'SingleElimination',
    teamSize: 2,
    maxParticipants: 8,
    rosterVisibility: 'OpenRoster',
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

/** An HSR account owned by `userId` (inserted directly). Returns its id. */
export function insertHsrAccount(test: Harness, userId: number, uid: string): number {
    return test.db.HsrAccount.insert({
        id: 0,
        userId,
        uid,
        region: 'eu',
        displayLabel: uid,
        isActive: true,
        isRosterPublic: true,
        isRatingPublic: true,
        isDuplicateUid: false,
        accountRating: 0,
        ...AUDIT(test),
    }).id;
}

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

/**
 * Transitional (until S8c): generate the bracket through the legacy generate_bracket, then stamp
 * bracketGeneratedAt on the row (the legacy reducer sets neither it nor groupId; see the S8b addendum).
 */
export function generateAndStamp(test: Harness, who: Actor, tournamentId: number) {
    tx(test, who, (ctx) => M.generate_bracket(ctx, { tournamentId }));
    stampGenerated(test, tournamentId);
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
