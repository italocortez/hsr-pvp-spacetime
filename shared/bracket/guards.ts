// Stage-machine guards (review §5.1, A26, A29). Pure predicates over plain row shapes, no ctx, no
// `spacetimedb` / `react`: the reducers (S8b–S8d) read the rows and throw `reason` when `ok` is false.
// Enum columns are taken in the generated `{ tag }` shape, timestamps as `{ microsSinceUnixEpoch }`.

export type GuardResult = { ok: true } | { ok: false; reason: string };

type Tag<T extends string> = { tag: T };
type Micros = { microsSinceUnixEpoch: bigint };

const OK: GuardResult = { ok: true };
const no = (reason: string): GuardResult => ({ ok: false, reason });

/** The `TournamentEnrolled` row of a team member; `undefined` = the member is not enrolled. */
export interface EligibilityMember {
    status: Tag<string>;
    isWaitlisted: boolean;
    approvedByToAt?: unknown;
}

export interface EligibilitySettings {
    teamSize: number;
    requireApproval: boolean;
}

/**
 * Review §5.1 footnote 1: status Forming or Ready, member count = teamSize, every member enrolled, not
 * waitlisted, approved when `requireApproval`, and Registered or CheckedIn. `members` holds one entry per
 * `TournamentTeamMember` row (its enrolled row, or `undefined`), so `members.length` is the member count.
 */
export function isEligibleTeam(
    team: { status: Tag<string> },
    members: readonly (EligibilityMember | undefined)[],
    settings: EligibilitySettings,
): GuardResult {
    if (team.status.tag !== 'Forming' && team.status.tag !== 'Ready')
        return no(`Team is ${team.status.tag}.`);
    if (members.length !== settings.teamSize)
        return no(`Team has ${members.length} of ${settings.teamSize} members.`);
    for (const m of members) {
        if (!m) return no('A member is not enrolled.');
        if (m.isWaitlisted) return no('A member is waitlisted.');
        if (settings.requireApproval && m.approvedByToAt === undefined)
            return no('A member awaits approval.');
        if (m.status.tag !== 'Registered' && m.status.tag !== 'CheckedIn')
            return no(`A member is ${m.status.tag}.`);
    }
    return OK;
}

/** A29: a third-place match exists only in the single-elimination formats. */
export const allowsThirdPlace = (format: Tag<string>): boolean =>
    format.tag === 'SingleElimination' || format.tag === 'GroupIntoSingleElim';

/**
 * Draft → Registration, pure part: stage Draft and A29. The rules / selectable cost set checks need ctx and stay
 * in the reducer.
 */
export function canOpenRegistration(tournament: {
    stage: Tag<string>;
    format: Tag<string>;
    has3rdPlaceMatch: boolean;
}): GuardResult {
    if (tournament.stage.tag !== 'Draft')
        return no(`Tournament is in ${tournament.stage.tag}, not Draft.`);
    if (tournament.has3rdPlaceMatch && !allowsThirdPlace(tournament.format)) {
        return no('A third-place match exists only in single elimination.');
    }
    return OK;
}

/**
 * Registration closes into Seeding (review §5.1): from Registration when check-in is off, or from CheckIn;
 * at least two eligible teams. (Registration → CheckIn has no team-count guard.)
 */
export function canCloseRegistration(
    tournament: { stage: Tag<string>; checkInEnabled: boolean },
    eligibleTeamCount: number,
): GuardResult {
    const stage = tournament.stage.tag;
    if (stage === 'Registration' && tournament.checkInEnabled)
        return no('Check-in is enabled: move to CheckIn first.');
    if (stage !== 'Registration' && stage !== 'CheckIn') return no(`Tournament is in ${stage}.`);
    if (eligibleTeamCount < 2)
        return no(`At least 2 eligible teams are needed (${eligibleTeamCount}).`);
    return OK;
}

export interface GuardBracketRow {
    bracketSide: Tag<string>;
    roundNumber: number;
    team1Id?: number;
    team2Id?: number;
    state: Tag<string>;
}

/**
 * Seeding → InProgress (review §5.1): the bracket was generated after the last seed change, and every Winners
 * round-1 / group round-1 match holds at least one real team.
 */
export function canStartInProgress(
    tournament: { stage: Tag<string>; bracketGeneratedAt?: Micros; lastSeedChangeAt?: Micros },
    bracketRows: readonly GuardBracketRow[],
): GuardResult {
    if (tournament.stage.tag !== 'Seeding')
        return no(`Tournament is in ${tournament.stage.tag}, not Seeding.`);
    const generated = tournament.bracketGeneratedAt;
    if (!generated || bracketRows.length === 0) return no('Generate the bracket first.');
    if (
        tournament.lastSeedChangeAt &&
        generated.microsSinceUnixEpoch < tournament.lastSeedChangeAt.microsSinceUnixEpoch
    ) {
        return no('Seeding changed after the bracket was generated; regenerate it.');
    }
    const firstRound = bracketRows.filter(
        (r) =>
            r.roundNumber === 1 &&
            (r.bracketSide.tag === 'Winners' || r.bracketSide.tag === 'Group'),
    );
    if (firstRound.some((r) => r.team1Id === undefined && r.team2Id === undefined)) {
        return no('A first-round match has no team.');
    }
    return OK;
}

/** InProgress → Completed (review §5.1): every match Decided / Walkover / Void and no tournament lobby left.
 * Gap: for the GroupInto* formats this passes once every group row is settled even before the elimination rows
 * exist; S8d must check `format` / the presence of elimination rows before calling it. */
export function canComplete(
    bracketRows: readonly GuardBracketRow[],
    liveTournamentLobbyCount: number,
): GuardResult {
    if (bracketRows.length === 0) return no('The tournament has no bracket.');
    const open = bracketRows.filter(
        (r) => r.state.tag !== 'Decided' && r.state.tag !== 'Walkover' && r.state.tag !== 'Void',
    );
    if (open.length > 0) return no(`${open.length} bracket match(es) are not settled.`);
    if (liveTournamentLobbyCount > 0)
        return no(`${liveTournamentLobbyCount} tournament lobby(ies) still open.`);
    return OK;
}
