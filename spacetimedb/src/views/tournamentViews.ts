// ─── Tournament Views ─────────────────────────────────────────────────────────
// Per-user views scoped to tournaments the caller organizes, assists, or is
// enrolled in. The staff views resolve their set through `staffTournamentIds` (A105, S10g).
//
// 1. view_my_tournaments                 — Tournament rows for TO / assistant / Moderator+ (non-terminal, A105(1))
// 2. view_my_tournament_enrolled         — TournamentEnrolled rows
// 3. view_my_tournament_teams            — TournamentTeam rows
// 4. view_my_tournament_team_members     — TournamentTeamMember rows
// 5. view_my_tournament_matches          — BracketMatch rows
// 6. view_my_tournament_match_results    — MatchResultRecord rows
// 7. view_my_tournament_lobbies          — Lobby rows
// 1a-7a. view_admin_tournament*(id)      — Admin-only arg twins of 1-7 for one tournament, terminal included (A105(2))
// (8. view_my_tournament_group_standings removed in S3 with group_phase_record, A23: standings are computed client-side)
// 9. view_tournament_registrant_accounts — locked-account rows for enrolled users
//
// S9a (A37, A44(1) D9, A26a(2), A70(1)):
// 10. view_tournament_participants(id)   — anonymous arg view: enrolled rows minus Disqualified
// 11. view_tournament_teams(id)          — anonymous arg view: teams, captainUserId only when not anonymous
// 12. view_tournament_team_members(id)   — anonymous arg view: team members, userId 0 when anonymous
// 13. view_tournament_staff(id)          — anonymous arg view: organizer + assistants with their flags
// 14. view_my_tournament_enrollment      — per-user: the caller's own TournamentEnrolled rows
// 15. view_my_team_requests              — per-user: requests the caller sent or that target a team they captain
// 16. view_my_stand_ins                  — per-user: stand-in rows for the caller or the caller's teams
// 17. view_tournament_matches_for_me     — per-user: Ready / Pending bracket matches of the caller's teams (InProgress)

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { lobbyColumns } from '@module/tables/lobby/lobby';
import { Tournament } from '@module/tables/tournament/tournament';
import { ParticipantStatus, TeamStatus, BracketMatchState, BracketSide } from '@module/types/enums';
import { matchSides } from '@module/helpers/tournament/matchSides';
import { resolveUserLabel } from '@module/helpers/identity/userLabel';
import { isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { BracketMatch } from '@module/tables/tournament/bracketMatch';
import { MatchResultRecord } from '@module/tables/results/matchResult';
import { TournamentEnrolled } from '@module/tables/tournament/tournamentEnrolled';
import { TournamentTeam } from '@module/tables/tournament/tournamentTeam';
import { TournamentTeamMember } from '@module/tables/tournament/tournamentTeamMember';

// ---------------------------------------------------------------------------
// Tournament staff views (Phase 10.3; A105, S10g)
// A105(1): the seven staff views (1-7) return the tournaments that are not Completed or Cancelled where the caller
// is the organizer (Tournament.organizer_id), an assistant (TournamentAssistant.user_id; S10s, L71: a row holding at
// least one of the three permissions), or a Moderator / Admin (every non-terminal tournament, read through the Tournament.stage btree index one
// stage at a time, never a full scan): the three paths of ensureTournamentPermission.
// A105(2): the Admin-only arg views (1a-7a, `view_admin_tournament*(tournamentId)`) return the same rows for any one
// tournament, terminal ones included. The caller's Admin role is checked before any tournament row is read; a
// non-Admin caller (or an unknown tournament) gets no rows.
// ---------------------------------------------------------------------------
const STAFF_STAGES = ['Draft', 'Registration', 'CheckIn', 'Seeding', 'InProgress'];
const isLiveTournament = (tournament: any): boolean =>
    tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled';

/** The caller's user id from ctx.sender, or undefined. */
function callerUserId(ctx: any): number | undefined {
    return ctx.db.UserIdentity.identity.find(ctx.sender)?.userId;
}

/**
 * A105(1): the non-terminal tournaments the caller organizes or assists (no role path). S10s (A122(21), L71): an
 * assistant row counts only when it holds at least one of the three permissions (canManageParticipants,
 * canManageBracket, canResolveResults); an assistant with all three off reads no staff view. The seven views do not map
 * one-to-one onto the permissions (teams and matches serve more than one), so the gate is "any permission".
 */
function organizedOrAssistedLiveIds(ctx: any, userId: number): Set<number> {
    const ids = new Set<number>();
    for (const t of ctx.db.Tournament.organizer_id.filter(userId)) {
        if (isLiveTournament(t)) ids.add(t.id);
    }
    for (const a of ctx.db.TournamentAssistant.user_id.filter(userId)) {
        if (!a.canManageParticipants && !a.canManageBracket && !a.canResolveResults) continue;
        const t = ctx.db.Tournament.id.find(a.tournamentId);
        if (t && isLiveTournament(t)) ids.add(t.id);
    }
    return ids;
}

/** A105(1): the tournament set of the seven staff views (organizer, assistant, Moderator+; non-terminal only). */
function staffTournamentIds(ctx: any): Set<number> {
    const userId = callerUserId(ctx);
    if (userId === undefined) return new Set();
    const user = ctx.db.User.id.find(userId);
    if (user && isRoleAtLeast(user.role, 'Moderator')) {
        const ids = new Set<number>();
        for (const stage of STAFF_STAGES) {
            for (const t of ctx.db.Tournament.stage.filter({ tag: stage, value: {} })) ids.add(t.id);
        }
        return ids;
    }
    return organizedOrAssistedLiveIds(ctx, userId);
}

/** A105(2): `[tournamentId]` when the caller is an Admin and the tournament exists, else none (checked first). */
function adminTournamentIds(ctx: any, tournamentId: number): number[] {
    const userId = callerUserId(ctx);
    if (userId === undefined) return [];
    const user = ctx.db.User.id.find(userId);
    if (!user || !isRoleAtLeast(user.role, 'Admin')) return [];
    return ctx.db.Tournament.id.find(tournamentId) ? [tournamentId] : [];
}

// Row builders shared by the staff views and their Admin arg twins.
function tournamentRows(ctx: any, ids: Iterable<number>): any[] {
    const rows: any[] = [];
    for (const tid of ids) {
        const tournament = ctx.db.Tournament.id.find(tid);
        if (tournament) rows.push(tournament);
    }
    return rows;
}

function enrolledRows(ctx: any, ids: Iterable<number>): any[] {
    const rows: any[] = [];
    for (const tid of ids) for (const row of ctx.db.TournamentEnrolled.tournament_id.filter(tid)) rows.push(row);
    return rows;
}

function teamRows(ctx: any, ids: Iterable<number>): any[] {
    const rows: any[] = [];
    for (const tid of ids) for (const row of ctx.db.TournamentTeam.tournament_id.filter(tid)) rows.push(row);
    return rows;
}

// Navigates TournamentTeam.tournament_id -> TournamentTeamMember.team_id.
function teamMemberRows(ctx: any, ids: Iterable<number>): any[] {
    const rows: any[] = [];
    for (const tid of ids) {
        for (const team of ctx.db.TournamentTeam.tournament_id.filter(tid)) {
            for (const member of ctx.db.TournamentTeamMember.team_id.filter(team.id)) rows.push(member);
        }
    }
    return rows;
}

function matchRows(ctx: any, ids: Iterable<number>): any[] {
    const rows: any[] = [];
    for (const tid of ids) for (const row of ctx.db.BracketMatch.tournament_id.filter(tid)) rows.push(row);
    return rows;
}

// Navigates BracketMatch.tournament_id -> MatchResultRecord.bracket_match_id (no tournament id on the record, D-07).
function matchResultRows(ctx: any, ids: Iterable<number>): any[] {
    const rows: any[] = [];
    for (const tid of ids) {
        for (const bm of ctx.db.BracketMatch.tournament_id.filter(tid)) {
            for (const row of ctx.db.MatchResultRecord.bracket_match_id.filter(bm.id)) rows.push(row);
        }
    }
    return rows;
}

// S9a (A70(1), A71): each lobby row also carries its bracket match's colours (blueTeamId / redTeamId through
// matchSides, the one colour mapping; unset or stale blueTeamId = team1 Blue). Staff see real ids (A37).
function lobbyRows(ctx: any, ids: Iterable<number>): any[] {
    const rows: any[] = [];
    for (const tid of ids) {
        for (const row of ctx.db.Lobby.tournament_id.filter(tid)) {
            const match = row.bracketMatchId !== undefined ? ctx.db.BracketMatch.id.find(row.bracketMatchId) : undefined;
            const sides = match ? matchSides(match) : { blueTeamId: undefined, redTeamId: undefined };
            rows.push({ ...row, blueTeamId: sides.blueTeamId, redTeamId: sides.redTeamId });
        }
    }
    return rows;
}

const TournamentLobbyRow = t.row('TournamentLobbyRow', {
    ...lobbyColumns,
    id: t.u32().primaryKey(),
    joinCode: t.string(),
    blueTeamId: t.u32().optional(),
    redTeamId: t.u32().optional(),
});

// 1-7: the staff views (A105(1)). Phase 15 D-01/D-02: moved from securityViews.ts.
export const view_my_tournaments = spacetimedb.view(
    { name: 'view_my_tournaments', public: true },
    t.array(Tournament.rowType),
    (ctx) => tournamentRows(ctx, staffTournamentIds(ctx)),
);

export const view_my_tournament_enrolled = spacetimedb.view(
    { name: 'view_my_tournament_enrolled', public: true },
    t.array(TournamentEnrolled.rowType),
    (ctx) => enrolledRows(ctx, staffTournamentIds(ctx)),
);

export const view_my_tournament_teams = spacetimedb.view(
    { name: 'view_my_tournament_teams', public: true },
    t.array(TournamentTeam.rowType),
    (ctx) => teamRows(ctx, staffTournamentIds(ctx)),
);

export const view_my_tournament_team_members = spacetimedb.view(
    { name: 'view_my_tournament_team_members', public: true },
    t.array(TournamentTeamMember.rowType),
    (ctx) => teamMemberRows(ctx, staffTournamentIds(ctx)),
);

export const view_my_tournament_matches = spacetimedb.view(
    { name: 'view_my_tournament_matches', public: true },
    t.array(BracketMatch.rowType),
    (ctx) => matchRows(ctx, staffTournamentIds(ctx)),
);

export const view_my_tournament_match_results = spacetimedb.view(
    { name: 'view_my_tournament_match_results', public: true },
    t.array(MatchResultRecord.rowType),
    (ctx) => matchResultRows(ctx, staffTournamentIds(ctx)),
);

export const view_my_tournament_lobbies = spacetimedb.view(
    { name: 'view_my_tournament_lobbies', public: true },
    t.array(TournamentLobbyRow),
    (ctx) => lobbyRows(ctx, staffTournamentIds(ctx)),
);

// 1a-7a: the Admin-only arg views (A105(2)); subscribe as `SELECT * FROM view_admin_tournament_enrolled(42)`.
export const view_admin_tournament = spacetimedb.view(
    { name: 'view_admin_tournament', public: true },
    { tournamentId: t.u32() },
    t.array(Tournament.rowType),
    (ctx, { tournamentId }) => tournamentRows(ctx, adminTournamentIds(ctx, tournamentId)),
);

export const view_admin_tournament_enrolled = spacetimedb.view(
    { name: 'view_admin_tournament_enrolled', public: true },
    { tournamentId: t.u32() },
    t.array(TournamentEnrolled.rowType),
    (ctx, { tournamentId }) => enrolledRows(ctx, adminTournamentIds(ctx, tournamentId)),
);

export const view_admin_tournament_teams = spacetimedb.view(
    { name: 'view_admin_tournament_teams', public: true },
    { tournamentId: t.u32() },
    t.array(TournamentTeam.rowType),
    (ctx, { tournamentId }) => teamRows(ctx, adminTournamentIds(ctx, tournamentId)),
);

export const view_admin_tournament_team_members = spacetimedb.view(
    { name: 'view_admin_tournament_team_members', public: true },
    { tournamentId: t.u32() },
    t.array(TournamentTeamMember.rowType),
    (ctx, { tournamentId }) => teamMemberRows(ctx, adminTournamentIds(ctx, tournamentId)),
);

export const view_admin_tournament_matches = spacetimedb.view(
    { name: 'view_admin_tournament_matches', public: true },
    { tournamentId: t.u32() },
    t.array(BracketMatch.rowType),
    (ctx, { tournamentId }) => matchRows(ctx, adminTournamentIds(ctx, tournamentId)),
);

export const view_admin_tournament_match_results = spacetimedb.view(
    { name: 'view_admin_tournament_match_results', public: true },
    { tournamentId: t.u32() },
    t.array(MatchResultRecord.rowType),
    (ctx, { tournamentId }) => matchResultRows(ctx, adminTournamentIds(ctx, tournamentId)),
);

export const view_admin_tournament_lobbies = spacetimedb.view(
    { name: 'view_admin_tournament_lobbies', public: true },
    { tournamentId: t.u32() },
    t.array(TournamentLobbyRow),
    (ctx, { tournamentId }) => lobbyRows(ctx, adminTournamentIds(ctx, tournamentId)),
);

// ---------------------------------------------------------------------------
// 9. Tournament Registrant Accounts (per-user view) — returns locked accounts
//    for tournaments the caller is enrolled in. Respects rosterVisibility per
//    tournament. TO + assistants always see all registrant accounts.
//    (D-22, Phase 10.4)
//    S9a fix (A37): in an isAnonymousDefault tournament a non-staff reader gets the other participants' rows with
//    userId 0 / hsrAccountId 0 and the participant's `seat`; staff (TO, assistants, Moderator+) and the caller's own
//    rows keep real ids.
//    S10g (tournament audit #10): a hidden row carries a neutral `Seat-<n> account <k>` label instead of the owner's
//    displayLabel; Completed and Cancelled tournaments are skipped; a non-staff reader gets the other participants'
//    rows only while the reader is in the field (not Disqualified, not waitlisted, approved) and only for participants
//    in the field; the caller's own rows always (any enrolment), staff every registrant.
// ---------------------------------------------------------------------------
const TournamentRegistrantAccountRow = t.object('TournamentRegistrantAccountRow', {
    tournamentId: t.u32(),
    userId: t.u32(),                        // S9a fix (A37): 0 for another participant of an anonymous tournament (non-staff reader)
    seat: t.u32(),                          // S9a fix: the participant's seat (view_tournament_participants.seat), the key when userId is 0
    hsrAccountId: t.u32(),                  // 0 together with userId (an account id pairs with a user id elsewhere)
    displayLabel: t.string(),
    accountRating: t.u32().optional(),
    characterName: t.string().optional(),
    eidolonLevel: t.u8().optional(),
});

/** S10g (audit #10a): a hidden row's label never carries the owner's free-text `displayLabel`. */
const neutralAccountLabel = (seat: number, index: number): string => `Seat-${seat} account ${index}`;

/** S10g (audit #10c): an enrolment that is in the field: not Disqualified, not waitlisted, approved. */
const isFieldEnrolment = (e: any): boolean =>
    e.status.tag !== 'Disqualified' && !e.isWaitlisted && e.approvedByToAt !== undefined;

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_tournament_registrant_accounts = spacetimedb.view(
    { name: 'view_tournament_registrant_accounts', public: true },
    t.array(TournamentRegistrantAccountRow),
    (ctx) => {
        const myUserId = callerUserId(ctx);
        if (myUserId === undefined) return [];
        const results: any[] = [];
        const me = ctx.db.User.id.find(myUserId);
        const isModerator = me ? isRoleAtLeast(me.role, 'Moderator') : false;

        // Tournaments: (a) the caller is enrolled in (any enrolment: a player outside the field still sees their own
        // rows), (b) the caller organizes or assists. S10g (audit #10b): Completed and Cancelled tournaments are skipped.
        const toTournamentIds = organizedOrAssistedLiveIds(ctx, myUserId);
        const myTournamentIds = new Set<number>(toTournamentIds);
        const myEnrolment = new Map<number, any>();
        for (const enrolled of ctx.db.TournamentEnrolled.user_id.filter(myUserId)) {
            myTournamentIds.add(enrolled.tournamentId);
            myEnrolment.set(enrolled.tournamentId, enrolled);
        }

        for (const tournamentId of myTournamentIds) {
            const tournament = ctx.db.Tournament.id.find(tournamentId);
            if (!tournament || !isLiveTournament(tournament)) continue;

            const isTOOrAssistant = toTournamentIds.has(tournamentId);
            const vis = tournament.rosterVisibility.tag;
            // S9a fix (A37): staff (organizer, assistants, Moderator+) read real ids; in an anonymous tournament any
            // other reader gets another participant's rows with userId 0 and hsrAccountId 0, keyed by `seat`.
            const isStaff = isTOOrAssistant || isModerator;
            // S10g (audit #10c): a non-staff reader sees the other participants' rows only while the reader is in the
            // field, and only the rows of participants in the field. Staff see every registrant (they approve them).
            const mine = myEnrolment.get(tournamentId);
            const readerInField = isStaff || (mine !== undefined && isFieldEnrolment(mine));
            const seats = enrollmentSeats(ctx, tournamentId);

            for (const enrolled of ctx.db.TournamentEnrolled.tournament_id.filter(tournamentId)) {
                const isMe = enrolled.userId === myUserId;
                if (!isMe && !isStaff && (!readerInField || !isFieldEnrolment(enrolled))) continue;
                const hide = tournament.isAnonymousDefault && !isStaff && !isMe;
                const seat = seats.get(enrolled.userId) ?? 0;
                let accountIndex = 0;

                for (const tpa of ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, enrolled.userId])) {
                    const account = ctx.db.HsrAccount.id.find(tpa.hsrAccountId);
                    if (!account) continue;
                    accountIndex++;

                    const own = isTOOrAssistant || isMe;
                    const showRoster = own || vis === 'OpenRoster';
                    const showRating = own || vis === 'OpenRoster' || vis === 'ClosedWithRating';
                    if (!showRoster && !showRating) continue; // ClosedNoRating

                    const base = {
                        tournamentId,
                        userId: hide ? 0 : enrolled.userId,
                        seat,
                        hsrAccountId: hide ? 0 : account.id,
                        displayLabel: hide ? neutralAccountLabel(seat, accountIndex) : account.displayLabel,
                        accountRating: showRating ? account.accountRating : undefined,
                    };
                    const characters = showRoster ? [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(account.id)] : [];
                    if (characters.length === 0) {
                        results.push({ ...base, characterName: undefined, eidolonLevel: undefined });
                    } else {
                        for (const char of characters) {
                            results.push({ ...base, characterName: char.characterName, eidolonLevel: char.eidolonLevel });
                        }
                    }
                }
            }
        }

        return results;
    }
);

// ===========================================================================
// S9a: public tournament page (anonymous arg views, §A.4 P3) and per-sender tournament views (PAGE-MAP D9).
// Arg views are shared per tournamentId (no ctx.sender, no primary key); `Tournament.isAnonymousDefault` decides
// anonymity for every row of the tournament. Subscribe as `SELECT * FROM view_tournament_participants(42)`.
// ===========================================================================

/**
 * A37: a participant's public seat number, from the enrollment order (createdDate, ties in index order), never from
 * the user id. All enrolled rows count (Disqualified included), so hiding a DQ row does not renumber the others.
 */
function enrollmentSeats(ctx: any, tournamentId: number): Map<number, number> {
    const rows = [...ctx.db.TournamentEnrolled.tournament_id.filter(tournamentId)];
    rows.sort((a: any, b: any) => {
        const da = a.createdDate.microsSinceUnixEpoch;
        const db = b.createdDate.microsSinceUnixEpoch;
        return da < db ? -1 : da > db ? 1 : 0;
    });
    const seats = new Map<number, number>();
    rows.forEach((r: any, i: number) => seats.set(r.userId, i + 1));
    return seats;
}

/** A37 / A36a: the public label of an enrolled user: alias or `Seat-<n>` when anonymous, else the display name. */
function participantLabel(ctx: any, tournament: any, userId: number, seats: Map<number, number>): string {
    if (!tournament.isAnonymousDefault) return resolveUserLabel(ctx, userId).displayName;
    const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournament.id, userId])][0];
    return enrolled?.anonymousAlias ?? `Seat-${seats.get(userId) ?? 0}`;
}

/** A user's team in a tournament (TournamentTeamMember by [tournamentId, userId]), or undefined. */
function teamOf(ctx: any, tournamentId: number, userId: number): number | undefined {
    return [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([tournamentId, userId])][0]?.teamId;
}

// ---------------------------------------------------------------------------
// 10. view_tournament_participants(tournamentId) — A26a(2): Disqualified rows are hidden from the public list.
// ---------------------------------------------------------------------------
const TournamentParticipantRow = t.row('TournamentParticipantRow', {
    tournamentId: t.u32(),
    seat: t.u32(),
    teamId: t.u32().optional(),
    userId: t.u32(),                        // 0 when the tournament is anonymous (A37)
    label: t.string(),
    status: ParticipantStatus,
    isWaitlisted: t.bool(),
});

export const view_tournament_participants = spacetimedb.anonymousView(
    { name: 'view_tournament_participants', public: true },
    { tournamentId: t.u32() },
    t.array(TournamentParticipantRow),
    (ctx, { tournamentId }) => {
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) return [];
        const anonymous = tournament.isAnonymousDefault;
        const seats = enrollmentSeats(ctx, tournamentId);
        const rows: any[] = [];
        for (const e of ctx.db.TournamentEnrolled.tournament_id.filter(tournamentId)) {
            if (e.status.tag === 'Disqualified') continue;
            rows.push({
                tournamentId,
                seat: seats.get(e.userId) ?? 0,
                teamId: teamOf(ctx, tournamentId, e.userId),
                userId: anonymous ? 0 : e.userId,
                label: participantLabel(ctx, tournament, e.userId, seats),
                status: e.status,
                isWaitlisted: e.isWaitlisted,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 11. view_tournament_teams(tournamentId) — captainUserId only when the tournament is not anonymous.
// ---------------------------------------------------------------------------
const TournamentTeamPublicRow = t.row('TournamentTeamPublicRow', {
    id: t.u32(),
    tournamentId: t.u32(),
    name: t.string(),
    status: TeamStatus,
    seedNumber: t.u32().optional(),
    groupId: t.u32().optional(),
    finalPlacement: t.u8().optional(),
    captainUserId: t.u32().optional(),
});

export const view_tournament_teams = spacetimedb.anonymousView(
    { name: 'view_tournament_teams', public: true },
    { tournamentId: t.u32() },
    t.array(TournamentTeamPublicRow),
    (ctx, { tournamentId }) => {
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) return [];
        const rows: any[] = [];
        for (const team of ctx.db.TournamentTeam.tournament_id.filter(tournamentId)) {
            rows.push({
                id: team.id,
                tournamentId,
                name: team.name,
                status: team.status,
                seedNumber: team.seedNumber,
                groupId: team.groupId,
                finalPlacement: team.finalPlacement,
                captainUserId: tournament.isAnonymousDefault ? undefined : team.captainUserId,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 12. view_tournament_team_members(tournamentId) — userId 0 and the alias / seat label when anonymous.
// ---------------------------------------------------------------------------
const TournamentTeamMemberPublicRow = t.row('TournamentTeamMemberPublicRow', {
    teamId: t.u32(),
    tournamentId: t.u32(),
    userId: t.u32(),
    label: t.string(),
});

export const view_tournament_team_members = spacetimedb.anonymousView(
    { name: 'view_tournament_team_members', public: true },
    { tournamentId: t.u32() },
    t.array(TournamentTeamMemberPublicRow),
    (ctx, { tournamentId }) => {
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) return [];
        const anonymous = tournament.isAnonymousDefault;
        const seats = enrollmentSeats(ctx, tournamentId);
        const rows: any[] = [];
        for (const team of ctx.db.TournamentTeam.tournament_id.filter(tournamentId)) {
            for (const member of ctx.db.TournamentTeamMember.team_id.filter(team.id)) {
                rows.push({
                    teamId: team.id,
                    tournamentId,
                    userId: anonymous ? 0 : member.userId,
                    label: participantLabel(ctx, tournament, member.userId, seats),
                });
            }
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 13. view_tournament_staff(tournamentId) — the organizer and the assistants with their permission flags (A25);
//     staff are never anonymous (A37).
// ---------------------------------------------------------------------------
const TournamentStaffRow = t.row('TournamentStaffRow', {
    tournamentId: t.u32(),
    userId: t.u32(),
    label: t.string(),
    isOrganizer: t.bool(),
    canManageParticipants: t.bool(),
    canManageBracket: t.bool(),
    canResolveResults: t.bool(),
});

export const view_tournament_staff = spacetimedb.anonymousView(
    { name: 'view_tournament_staff', public: true },
    { tournamentId: t.u32() },
    t.array(TournamentStaffRow),
    (ctx, { tournamentId }) => {
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) return [];
        const rows: any[] = [{
            tournamentId,
            userId: tournament.organizerId,
            label: resolveUserLabel(ctx, tournament.organizerId).displayName,
            isOrganizer: true,
            canManageParticipants: true,
            canManageBracket: true,
            canResolveResults: true,
        }];
        for (const a of ctx.db.TournamentAssistant.tournament_id.filter(tournamentId)) {
            rows.push({
                tournamentId,
                userId: a.userId,
                label: resolveUserLabel(ctx, a.userId).displayName,
                isOrganizer: false,
                canManageParticipants: a.canManageParticipants,
                canManageBracket: a.canManageBracket,
                canResolveResults: a.canResolveResults,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 14. view_my_tournament_enrollment — the caller's own TournamentEnrolled rows (real id: it is the caller).
// ---------------------------------------------------------------------------
export const view_my_tournament_enrollment = spacetimedb.view(
    { name: 'view_my_tournament_enrollment', public: true },
    t.array(TournamentEnrolled.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        return [...ctx.db.TournamentEnrolled.user_id.filter(mapping.userId)];
    }
);

// ---------------------------------------------------------------------------
// 15. view_my_team_requests — TournamentTeamRequest rows the caller sent, plus the rows targeting a team the caller
//     captains (accept_team_request / reject_team_request take the requester's id, so the captain gets it). A73: a
//     request targeting the caller's team is identified, in every tournament: the label is the requester's display
//     name (resolveUserLabel), whatever isAnonymousDefault says (team formation precedes any match; an A37
//     clarification). The caller's own rows (isMine) keep the tournament-anonymity label (alias or seat).
// ---------------------------------------------------------------------------
const TeamRequestViewRow = t.row('TeamRequestViewRow', {
    teamId: t.u32(),
    tournamentId: t.u32(),
    teamName: t.string(),
    userId: t.u32(),
    label: t.string(),
    isMine: t.bool(),                       // the caller sent it
    createdDate: t.timestamp(),
});

export const view_my_team_requests = spacetimedb.view(
    { name: 'view_my_team_requests', public: true },
    t.array(TeamRequestViewRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const me = mapping.userId;
        const rows: any[] = [];
        const push = (req: any, team: any) => {
            const tournament = ctx.db.Tournament.id.find(team.tournamentId);
            if (!tournament) return;
            rows.push({
                teamId: team.id,
                tournamentId: team.tournamentId,
                teamName: team.name,
                userId: req.userId,
                label: req.userId === me
                    ? participantLabel(ctx, tournament, req.userId, enrollmentSeats(ctx, team.tournamentId))
                    : resolveUserLabel(ctx, req.userId).displayName, // A73: the captain sees who asks
                isMine: req.userId === me,
                createdDate: req.createdDate,
            });
        };
        for (const req of ctx.db.TournamentTeamRequest.user_id.filter(me)) {
            const team = ctx.db.TournamentTeam.id.find(req.teamId);
            if (team) push(req, team);
        }
        for (const team of ctx.db.TournamentTeam.captain_user_id.filter(me)) {
            for (const req of ctx.db.TournamentTeamRequest.team_id.filter(team.id)) {
                if (req.userId !== me) push(req, team);
            }
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 16. view_my_stand_ins (PAGE-MAP D9) — TournamentStandIn rows naming the caller (index user_id, added in S9a) and
//     the stand-ins of the caller's own teams (team_id). Opponents' stand-ins are not listed. No approver id.
// ---------------------------------------------------------------------------
const StandInViewRow = t.row('StandInViewRow', {
    id: t.u32().primaryKey(),
    bracketMatchId: t.u32(),
    teamId: t.u32(),
    userId: t.u32(),
    label: t.string(),
});

export const view_my_stand_ins = spacetimedb.view(
    { name: 'view_my_stand_ins', public: true },
    t.array(StandInViewRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const me = mapping.userId;
        const byId = new Map<number, any>();
        for (const s of ctx.db.TournamentStandIn.user_id.filter(me)) byId.set(s.id, s);
        for (const enrolled of ctx.db.TournamentEnrolled.user_id.filter(me)) {
            const teamId = teamOf(ctx, enrolled.tournamentId, me);
            if (teamId === undefined) continue;
            for (const s of ctx.db.TournamentStandIn.team_id.filter(teamId)) byId.set(s.id, s);
        }
        return [...byId.values()].map((s: any) => ({
            id: s.id,
            bracketMatchId: s.bracketMatchId,
            teamId: s.teamId,
            userId: s.userId,
            // the caller or a stand-in of the caller's own team (A37: teammates see real identities)
            label: resolveUserLabel(ctx, s.userId).displayName,
        }));
    }
);

// ---------------------------------------------------------------------------
// 17. view_tournament_matches_for_me (PAGE-MAP D9; A70(1), A71) — the Ready / Pending BracketMatch rows of the
//     InProgress tournaments (S10g, audit #11) the caller is enrolled in where one slot is the caller's team: the opponent's name, the colours
//     (matchSides: unset / stale blueTeamId = team1 Blue), the tally (head start on team1, A71) and scheduledAt.
//     Team ids only (BracketMatch is public).
// ---------------------------------------------------------------------------
const MatchForMeRow = t.row('MatchForMeRow', {
    bracketMatchId: t.u32().primaryKey(),
    tournamentId: t.u32(),
    myTeamId: t.u32(),
    opponentTeamId: t.u32().optional(),
    opponentTeamName: t.string().optional(),
    blueTeamId: t.u32().optional(),
    redTeamId: t.u32().optional(),
    state: BracketMatchState,
    bracketSide: BracketSide,
    roundNumber: t.u32(),
    matchNumber: t.u32(),
    bestOf: t.u8(),
    team1Id: t.u32().optional(),
    team2Id: t.u32().optional(),
    team1Games: t.u8(),
    team2Games: t.u8(),
    scheduledAt: t.timestamp().optional(),
});

export const view_tournament_matches_for_me = spacetimedb.view(
    { name: 'view_tournament_matches_for_me', public: true },
    t.array(MatchForMeRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const me = mapping.userId;
        const rows: any[] = [];
        for (const enrolled of ctx.db.TournamentEnrolled.user_id.filter(me)) {
            // S10g (audit #11): running tournaments only (a cancelled or completed bracket keeps its rows for good).
            if (ctx.db.Tournament.id.find(enrolled.tournamentId)?.stage.tag !== 'InProgress') continue;
            const myTeamId = teamOf(ctx, enrolled.tournamentId, me);
            if (myTeamId === undefined) continue;
            for (const match of ctx.db.BracketMatch.tournament_id.filter(enrolled.tournamentId)) {
                const state = match.state.tag;
                if (state !== 'Ready' && state !== 'Pending') continue;
                if (match.team1Id !== myTeamId && match.team2Id !== myTeamId) continue;
                const opponentTeamId = match.team1Id === myTeamId ? match.team2Id : match.team1Id;
                const opponent = opponentTeamId !== undefined ? ctx.db.TournamentTeam.id.find(opponentTeamId) : undefined;
                const sides = matchSides(match);
                rows.push({
                    bracketMatchId: match.id,
                    tournamentId: match.tournamentId,
                    myTeamId,
                    opponentTeamId,
                    opponentTeamName: opponent?.name,
                    blueTeamId: sides.blueTeamId,
                    redTeamId: sides.redTeamId,
                    state: match.state,
                    bracketSide: match.bracketSide,
                    roundNumber: match.roundNumber,
                    matchNumber: match.matchNumber,
                    bestOf: match.bestOf,
                    team1Id: match.team1Id,
                    team2Id: match.team2Id,
                    team1Games: match.team1Games,
                    team2Games: match.team2Games,
                    scheduledAt: match.scheduledAt,
                });
            }
        }
        return rows;
    }
);
