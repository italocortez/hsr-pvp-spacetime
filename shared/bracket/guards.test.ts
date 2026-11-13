// T-S8a: unit tests for the pure stage-machine guards (review §5.1, A26, A29): one accepting and at least one
// rejecting case per predicate.
import { describe, expect, it } from 'vitest';
import {
    allowsThirdPlace,
    canCloseRegistration,
    canComplete,
    canOpenRegistration,
    canStartInProgress,
    type EligibilityMember,
    type GuardBracketRow,
    type GuardResult,
    isEligibleTeam,
} from './index';

const tag = <T extends string>(t: T) => ({ tag: t });
const at = (n: number) => ({ microsSinceUnixEpoch: BigInt(n) });

const member = (over: Partial<EligibilityMember> = {}): EligibilityMember => ({
    status: tag('Registered'),
    isWaitlisted: false,
    approvedByToAt: at(1),
    ...over,
});
const settings = { teamSize: 2, requireApproval: true };

const row = (over: Partial<GuardBracketRow> = {}): GuardBracketRow => ({
    bracketSide: tag('Winners'),
    roundNumber: 1,
    team1Id: 1,
    team2Id: 2,
    state: tag('Decided'),
    ...over,
});

const rejected = (r: GuardResult): string => {
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.reason;
};

describe('isEligibleTeam', () => {
    it('accepts a Forming or Ready team of teamSize Registered / CheckedIn members', () => {
        expect(
            isEligibleTeam(
                { status: tag('Forming') },
                [member(), member({ status: tag('CheckedIn') })],
                settings,
            ),
        ).toEqual({ ok: true });
        expect(isEligibleTeam({ status: tag('Ready') }, [member(), member()], settings).ok).toBe(
            true,
        );
    });
    it('without requireApproval an unapproved member is fine', () => {
        const r = isEligibleTeam(
            { status: tag('Ready') },
            [member({ approvedByToAt: undefined }), member()],
            { teamSize: 2, requireApproval: false },
        );
        expect(r.ok).toBe(true);
    });
    it('rejects the wrong member count', () => {
        expect(rejected(isEligibleTeam({ status: tag('Ready') }, [member()], settings))).toMatch(
            /1 of 2/,
        );
        expect(
            rejected(
                isEligibleTeam({ status: tag('Ready') }, [member(), member(), member()], settings),
            ),
        ).toMatch(/3 of 2/);
    });
    it('rejects a member who is not enrolled', () => {
        expect(
            rejected(isEligibleTeam({ status: tag('Ready') }, [member(), undefined], settings)),
        ).toMatch(/not enrolled/);
    });
    it('rejects a waitlisted member', () => {
        expect(
            rejected(
                isEligibleTeam(
                    { status: tag('Ready') },
                    [member(), member({ isWaitlisted: true })],
                    settings,
                ),
            ),
        ).toMatch(/waitlisted/);
    });
    it('rejects an unapproved member under requireApproval', () => {
        expect(
            rejected(
                isEligibleTeam(
                    { status: tag('Ready') },
                    [member(), member({ approvedByToAt: undefined })],
                    settings,
                ),
            ),
        ).toMatch(/approval/);
    });
    it('rejects a member whose enrolment status is not Registered / CheckedIn', () => {
        expect(
            rejected(
                isEligibleTeam(
                    { status: tag('Ready') },
                    [member(), member({ status: tag('Withdrawn') })],
                    settings,
                ),
            ),
        ).toMatch(/Withdrawn/);
    });
    it('rejects a Withdrawn (or any non Forming / Ready) team', () => {
        expect(
            rejected(isEligibleTeam({ status: tag('Withdrawn') }, [member(), member()], settings)),
        ).toMatch(/Withdrawn/);
        expect(
            rejected(isEligibleTeam({ status: tag('Active') }, [member(), member()], settings)),
        ).toMatch(/Active/);
    });
});

describe('allowsThirdPlace (A29)', () => {
    it('single elimination formats only', () => {
        expect(allowsThirdPlace(tag('SingleElimination'))).toBe(true);
        expect(allowsThirdPlace(tag('GroupIntoSingleElim'))).toBe(true);
        expect(allowsThirdPlace(tag('DoubleElimination'))).toBe(false);
        expect(allowsThirdPlace(tag('GroupOnly'))).toBe(false);
    });
});

describe('canOpenRegistration', () => {
    it('accepts Draft (with a third-place match in single elimination)', () => {
        expect(
            canOpenRegistration({
                stage: tag('Draft'),
                format: tag('SingleElimination'),
                has3rdPlaceMatch: true,
            }).ok,
        ).toBe(true);
        expect(
            canOpenRegistration({
                stage: tag('Draft'),
                format: tag('DoubleElimination'),
                has3rdPlaceMatch: false,
            }).ok,
        ).toBe(true);
    });
    it('rejects a stage other than Draft', () => {
        expect(
            rejected(
                canOpenRegistration({
                    stage: tag('Registration'),
                    format: tag('SingleElimination'),
                    has3rdPlaceMatch: false,
                }),
            ),
        ).toMatch(/not Draft/);
    });
    it('rejects a third-place match in double elimination (A29)', () => {
        expect(
            rejected(
                canOpenRegistration({
                    stage: tag('Draft'),
                    format: tag('DoubleElimination'),
                    has3rdPlaceMatch: true,
                }),
            ),
        ).toMatch(/third-place/);
    });
});

describe('canCloseRegistration', () => {
    it('accepts Registration without check-in, or CheckIn, with ≥ 2 eligible teams', () => {
        expect(
            canCloseRegistration({ stage: tag('Registration'), checkInEnabled: false }, 2).ok,
        ).toBe(true);
        expect(canCloseRegistration({ stage: tag('CheckIn'), checkInEnabled: true }, 5).ok).toBe(
            true,
        );
    });
    it('rejects Registration when check-in is on', () => {
        expect(
            rejected(canCloseRegistration({ stage: tag('Registration'), checkInEnabled: true }, 4)),
        ).toMatch(/CheckIn/);
    });
    it('rejects another stage', () => {
        expect(
            rejected(canCloseRegistration({ stage: tag('Seeding'), checkInEnabled: false }, 4)),
        ).toMatch(/Seeding/);
    });
    it('rejects fewer than 2 eligible teams', () => {
        expect(
            rejected(
                canCloseRegistration({ stage: tag('Registration'), checkInEnabled: false }, 1),
            ),
        ).toMatch(/At least 2/);
    });
});

describe('canStartInProgress', () => {
    const seeding = (generated?: number, seedChange?: number) => ({
        stage: tag('Seeding'),
        bracketGeneratedAt: generated === undefined ? undefined : at(generated),
        lastSeedChangeAt: seedChange === undefined ? undefined : at(seedChange),
    });
    const rows = [
        row({ state: tag('Ready') }),
        row({ team2Id: undefined, state: tag('Walkover') }),
        row({ roundNumber: 2, team1Id: undefined, team2Id: undefined, state: tag('Pending') }),
    ];

    it('accepts a bracket generated at or after the last seed change, every round-1 match with a team', () => {
        expect(canStartInProgress(seeding(10, 5), rows).ok).toBe(true);
        expect(canStartInProgress(seeding(10, 10), rows).ok).toBe(true);
        expect(canStartInProgress(seeding(10), rows).ok).toBe(true);
    });
    it('rejects bracketGeneratedAt older than lastSeedChangeAt', () => {
        expect(rejected(canStartInProgress(seeding(5, 10), rows))).toMatch(/regenerate/);
    });
    it('rejects a missing bracket', () => {
        expect(rejected(canStartInProgress(seeding(undefined, 1), rows))).toMatch(/Generate/);
        expect(rejected(canStartInProgress(seeding(10, 5), []))).toMatch(/Generate/);
    });
    it('rejects a Winners or Group round-1 match without any real team', () => {
        expect(
            rejected(
                canStartInProgress(seeding(10, 5), [
                    ...rows,
                    row({ team1Id: undefined, team2Id: undefined, state: tag('Void') }),
                ]),
            ),
        ).toMatch(/no team/);
        expect(
            rejected(
                canStartInProgress(seeding(10, 5), [
                    row({ bracketSide: tag('Group'), team1Id: undefined, team2Id: undefined }),
                ]),
            ),
        ).toMatch(/no team/);
    });
    it('rejects a stage other than Seeding', () => {
        expect(
            rejected(canStartInProgress({ ...seeding(10, 5), stage: tag('InProgress') }, rows)),
        ).toMatch(/not Seeding/);
    });
});

describe('canComplete', () => {
    it('accepts every match Decided / Walkover / Void and no live lobby', () => {
        expect(
            canComplete([row(), row({ state: tag('Walkover') }), row({ state: tag('Void') })], 0),
        ).toEqual({ ok: true });
    });
    it('rejects an undecided match', () => {
        expect(rejected(canComplete([row(), row({ state: tag('Ready') })], 0))).toMatch(
            /1 bracket match/,
        );
        expect(rejected(canComplete([row({ state: tag('Pending') })], 0))).toMatch(/not settled/);
    });
    it('rejects a live tournament lobby', () => {
        expect(rejected(canComplete([row()], 1))).toMatch(/lobby/);
    });
    it('rejects an empty bracket', () => {
        expect(rejected(canComplete([], 0))).toMatch(/no bracket/);
    });
});
