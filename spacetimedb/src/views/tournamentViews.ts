// ─── Tournament Views ─────────────────────────────────────────────────────────
// Per-user views scoped to tournaments the caller organizes, assists, or is
// enrolled in. Shared helper `getMyTournamentIds` resolves the caller's set.
//
// 1. view_my_tournaments                 — Tournament rows for TO/assistant
// 2. view_my_tournament_enrolled         — TournamentEnrolled rows
// 3. view_my_tournament_teams            — TournamentTeam rows
// 4. view_my_tournament_team_members     — TournamentTeamMember rows
// 5. view_my_tournament_matches          — BracketMatch rows
// 6. view_my_tournament_match_results    — MatchResultRecord rows
// 7. view_my_tournament_lobbies          — Lobby rows
// 8. view_my_tournament_group_standings  — GroupPhaseRecord rows
// 9. view_tournament_registrant_accounts — locked-account rows for enrolled users
//
// Note (Phase 15): the phase plan referenced "7 tournament views" in the file
// header text; the source god file actually held 9 tournament-scoped views and
// all 9 are moved here verbatim (no rename, no drop). Tracked as a Rule 1
// deviation in SUMMARY.md — fix is a comment/text correction, not a code change.

import spacetimedb from '../schema';
import { t } from 'spacetimedb/server';
import { Lobby } from '../tables/lobby';
import { Tournament } from '../tables/tournament';
import { BracketMatch } from '../tables/bracketMatch';
import { GroupPhaseRecord } from '../tables/groupPhaseRecord';
import { MatchResultRecord } from '../tables/matchResult';
import { TournamentEnrolled } from '../tables/tournamentEnrolled';
import { TournamentTeam } from '../tables/tournamentTeam';
import { TournamentTeamMember } from '../tables/tournamentTeamMember';

// ---------------------------------------------------------------------------
// Tournament Organizer Views (Phase 10.3)
// Shared helper resolves the calling user's tournament set via two paths:
//   Path 1: Tournament.organizer_id btree -> tournaments where caller is organizer
//   Path 2: TournamentAssistant.user_id btree -> tournaments where caller is assistant
// Same two-path pattern as ensureTournamentAccess in tournamentHelpers.ts.
// ---------------------------------------------------------------------------
function getMyTournamentIds(ctx: any): { userId: number; tournamentIds: Set<number> } | null {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    if (!mapping) return null;
    const userId = mapping.userId;
    const tournamentIds = new Set<number>();
    // Path 1: Organizer
    for (const t of ctx.db.Tournament.organizer_id.filter(userId)) {
        tournamentIds.add(t.id);
    }
    // Path 2: Assistant
    for (const a of ctx.db.TournamentAssistant.user_id.filter(userId)) {
        tournamentIds.add(a.tournamentId);
    }
    return { userId, tournamentIds };
}

// ---------------------------------------------------------------------------
// 1. My Tournaments (per-user view) — Tournament rows where the caller is the
//    organizer or an assistant. Resolves both paths via getMyTournamentIds.
//    (TO-VIEW-01)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_tournaments = spacetimedb.view(
    { name: 'view_my_tournaments', public: true },
    t.array(Tournament.rowType),
    (ctx) => {
        const resolved = getMyTournamentIds(ctx);
        if (!resolved || resolved.tournamentIds.size === 0) return [];
        const results: any[] = [];
        for (const tid of resolved.tournamentIds) {
            const tournament = ctx.db.Tournament.id.find(tid);
            if (tournament) results.push(tournament);
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 2. My Tournament Enrolled (per-user view) — TournamentEnrolled rows for all
//    tournaments where the caller is the organizer or an assistant.
//    Direct tournament_id btree filter. (TO-VIEW-02)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_tournament_enrolled = spacetimedb.view(
    { name: 'view_my_tournament_enrolled', public: true },
    t.array(TournamentEnrolled.rowType),
    (ctx) => {
        const resolved = getMyTournamentIds(ctx);
        if (!resolved || resolved.tournamentIds.size === 0) return [];
        const results: any[] = [];
        for (const tid of resolved.tournamentIds) {
            for (const row of ctx.db.TournamentEnrolled.tournament_id.filter(tid)) {
                results.push(row);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 3. My Tournament Teams (per-user view) — TournamentTeam rows for all
//    tournaments where the caller is the organizer or an assistant.
//    Direct tournament_id btree filter. (TO-VIEW-02)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_tournament_teams = spacetimedb.view(
    { name: 'view_my_tournament_teams', public: true },
    t.array(TournamentTeam.rowType),
    (ctx) => {
        const resolved = getMyTournamentIds(ctx);
        if (!resolved || resolved.tournamentIds.size === 0) return [];
        const results: any[] = [];
        for (const tid of resolved.tournamentIds) {
            for (const row of ctx.db.TournamentTeam.tournament_id.filter(tid)) {
                results.push(row);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 4. My Tournament Team Members (per-user view) — TournamentTeamMember rows for
//    all tournaments where the caller is the organizer or an assistant.
//    Navigates via TournamentTeam.tournament_id -> TournamentTeamMember.team_id
//    (no single-column tournament_id index on TournamentTeamMember). (TO-VIEW-02)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_tournament_team_members = spacetimedb.view(
    { name: 'view_my_tournament_team_members', public: true },
    t.array(TournamentTeamMember.rowType),
    (ctx) => {
        const resolved = getMyTournamentIds(ctx);
        if (!resolved || resolved.tournamentIds.size === 0) return [];
        const results: any[] = [];
        for (const tid of resolved.tournamentIds) {
            for (const team of ctx.db.TournamentTeam.tournament_id.filter(tid)) {
                for (const member of ctx.db.TournamentTeamMember.team_id.filter(team.id)) {
                    results.push(member);
                }
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 5. My Tournament Matches (per-user view) — BracketMatch rows for all
//    tournaments where the caller is the organizer or an assistant.
//    Direct tournament_id btree filter. (TO-VIEW-03)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_tournament_matches = spacetimedb.view(
    { name: 'view_my_tournament_matches', public: true },
    t.array(BracketMatch.rowType),
    (ctx) => {
        const resolved = getMyTournamentIds(ctx);
        if (!resolved || resolved.tournamentIds.size === 0) return [];
        const results: any[] = [];
        for (const tid of resolved.tournamentIds) {
            for (const row of ctx.db.BracketMatch.tournament_id.filter(tid)) {
                results.push(row);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 6. My Tournament Match Results (per-user view) — MatchResultRecord rows for
//    all tournaments where the caller is the organizer or an assistant.
//    Navigates via BracketMatch.tournament_id -> MatchResultRecord.bracket_match_id
//    (MatchResultRecord has no tournament_id column — D-07). (TO-VIEW-03)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_tournament_match_results = spacetimedb.view(
    { name: 'view_my_tournament_match_results', public: true },
    t.array(MatchResultRecord.rowType),
    (ctx) => {
        const resolved = getMyTournamentIds(ctx);
        if (!resolved || resolved.tournamentIds.size === 0) return [];
        const results: any[] = [];
        for (const tid of resolved.tournamentIds) {
            for (const bm of ctx.db.BracketMatch.tournament_id.filter(tid)) {
                for (const row of ctx.db.MatchResultRecord.bracket_match_id.filter(bm.id)) {
                    results.push(row);
                }
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 7. My Tournament Lobbies (per-user view) — Lobby rows for all tournaments
//    where the caller is the organizer or an assistant.
//    Uses direct Lobby.tournament_id btree index. (TO-VIEW-03)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_tournament_lobbies = spacetimedb.view(
    { name: 'view_my_tournament_lobbies', public: true },
    t.array(Lobby.rowType),
    (ctx) => {
        const resolved = getMyTournamentIds(ctx);
        if (!resolved || resolved.tournamentIds.size === 0) return [];
        const results: any[] = [];
        for (const tid of resolved.tournamentIds) {
            for (const row of ctx.db.Lobby.tournament_id.filter(tid)) {
                results.push(row);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 8. My Tournament Group Standings (per-user view) — GroupPhaseRecord rows for
//    all tournaments where the caller is the organizer or an assistant.
//    Direct tournament_id btree filter. (TO-VIEW-02)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_tournament_group_standings = spacetimedb.view(
    { name: 'view_my_tournament_group_standings', public: true },
    t.array(GroupPhaseRecord.rowType),
    (ctx) => {
        const resolved = getMyTournamentIds(ctx);
        if (!resolved || resolved.tournamentIds.size === 0) return [];
        const results: any[] = [];
        for (const tid of resolved.tournamentIds) {
            for (const row of ctx.db.GroupPhaseRecord.tournament_id.filter(tid)) {
                results.push(row);
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 9. Tournament Registrant Accounts (per-user view) — returns locked accounts
//    for tournaments the caller is enrolled in. Respects rosterVisibility per
//    tournament. TO + assistants always see all registrant accounts.
//    (D-22, Phase 10.4)
// ---------------------------------------------------------------------------
const TournamentRegistrantAccountRow = t.object('TournamentRegistrantAccountRow', {
    tournamentId: t.u32(),
    userId: t.u32(),
    hsrAccountId: t.u32(),
    displayLabel: t.string(),
    accountRating: t.u32().optional(),
    characterName: t.string().optional(),
    eidolonLevel: t.u8().optional(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_tournament_registrant_accounts = spacetimedb.view(
    { name: 'view_tournament_registrant_accounts', public: true },
    t.array(TournamentRegistrantAccountRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const myUserId = mapping.userId;
        const results: any[] = [];

        // Collect tournaments: (a) caller is enrolled in, (b) caller is TO/assistant
        const myTournamentIds = new Set<number>();
        const toTournamentIds = new Set<number>();

        // Path 1: Enrolled tournaments
        for (const enrolled of ctx.db.TournamentEnrolled.user_id.filter(myUserId)) {
            myTournamentIds.add(enrolled.tournamentId);
        }

        // Path 2: TO/assistant tournaments (always see all)
        const resolved = getMyTournamentIds(ctx);
        if (resolved) {
            for (const tid of resolved.tournamentIds) {
                toTournamentIds.add(tid);
                myTournamentIds.add(tid);
            }
        }

        for (const tournamentId of myTournamentIds) {
            const tournament = ctx.db.Tournament.id.find(tournamentId);
            if (!tournament) continue;

            const isTOOrAssistant = toTournamentIds.has(tournamentId);
            const vis = tournament.rosterVisibility.tag;

            // For each enrolled user in this tournament, get their TPA entries
            const enrolledUsers = [...ctx.db.TournamentEnrolled.tournament_id.filter(tournamentId)];

            for (const enrolled of enrolledUsers) {
                const isMe = enrolled.userId === myUserId;
                const tpaForUser = [...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, enrolled.userId])];

                for (const tpa of tpaForUser) {
                    const account = ctx.db.HsrAccount.id.find(tpa.hsrAccountId);
                    if (!account) continue;

                    let showRoster = false;
                    let showRating = false;

                    if (isTOOrAssistant || isMe) {
                        showRoster = true;
                        showRating = true;
                    } else if (vis === 'OpenRoster') {
                        showRoster = true;
                        showRating = true;
                    } else if (vis === 'ClosedWithRating') {
                        showRoster = false;
                        showRating = true;
                    } else {
                        // ClosedNoRating
                        showRoster = false;
                        showRating = false;
                    }

                    if (!showRoster && !showRating) continue;

                    if (showRoster) {
                        const characters = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(account.id)];
                        if (characters.length === 0) {
                            results.push({
                                tournamentId,
                                userId: enrolled.userId,
                                hsrAccountId: account.id,
                                displayLabel: account.displayLabel,
                                accountRating: showRating ? account.accountRating : undefined,
                                characterName: undefined,
                                eidolonLevel: undefined,
                            });
                        } else {
                            for (const char of characters) {
                                results.push({
                                    tournamentId,
                                    userId: enrolled.userId,
                                    hsrAccountId: account.id,
                                    displayLabel: account.displayLabel,
                                    accountRating: showRating ? account.accountRating : undefined,
                                    characterName: char.characterName,
                                    eidolonLevel: char.eidolonLevel,
                                });
                            }
                        }
                    } else if (showRating) {
                        results.push({
                            tournamentId,
                            userId: enrolled.userId,
                            hsrAccountId: account.id,
                            displayLabel: account.displayLabel,
                            accountRating: account.accountRating,
                            characterName: undefined,
                            eidolonLevel: undefined,
                        });
                    }
                }
            }
        }

        return results;
    }
);
