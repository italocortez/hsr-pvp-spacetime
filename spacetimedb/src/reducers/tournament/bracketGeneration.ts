import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { allowsThirdPlace, generateDoubleElim, generateSingleElim, groupCount, splitIntoGroups } from '@shared/bracket';
import { fairShuffle, SHUFFLE_DOMAIN, shuffleKeyAt } from '@shared/lobby-rules';
import { ensureTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { isGroupFormat } from '@module/helpers/tournament/tournamentHelpers';
import { deleteBracket, insertBracket, insertGroupBracket } from '@module/helpers/tournament/bracketStore';

// ─── Seeding and generation (A23, A26, A26a, A29, A32, A36a, review §5.4, C-a7, T20; S8c) ─────────────────
// Built on the shared pure engine (`@shared/bracket`) and the S8a bracket store. Seeding and generation are
// separate: seeding writes `TournamentTeam.seedNumber` and stamps `Tournament.lastSeedChangeAt`; generation
// turns the seeded Ready teams into rows and stamps `Tournament.bracketGeneratedAt` (Seeding → InProgress
// requires bracketGeneratedAt ≥ lastSeedChangeAt).

const unit = (tag: string) => ({ tag, value: {} }) as any;

function ensureSeedingStage(tournament: any): void {
    if (tournament.stage.tag !== 'Seeding') throw new SenderError('Tournament is not in Seeding.');
}

function readyTeams(ctx: any, tournamentId: number): any[] {
    return [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)]
        .filter((team: any) => team.status.tag === 'Ready')
        .sort((a: any, b: any) => a.id - b.id);
}

/** Writes seed 1..n in the given order and stamps lastSeedChangeAt. */
function writeSeeds(ctx: any, tournament: any, ordered: any[], actorId: number): void {
    ordered.forEach((team, index) => {
        if (team.seedNumber !== index + 1) {
            ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { seedNumber: index + 1 }, actorId));
        }
    });
    const fresh = ctx.db.Tournament.id.find(tournament.id);
    ctx.db.Tournament.id.update(updateWithAudit(ctx, fresh, { lastSeedChangeAt: ctx.timestamp }, actorId));
}

// ─── seed_bracket ─────────────────────────────────────────────────────────────
// `bracket` (A25); Seeding; Ready teams only (A26). Modes kept from the legacy reducer:
//   'mmr'    captain's rating for the tournament's default game mode in the active season (S10s, L65), highest
//            first; ties by team id.
//   'random' fairShuffle (A120, shared/lobby-rules/timerDraw.ts) of the Ready teams in team-id order (C-a7: the legacy
//            hash was id order), keyed by the transaction time, SHUFFLE_DOMAIN.BracketSeeding and the tournament id.

export const seed_bracket = spacetimedb.reducer(
    { tournamentId: t.u32(), mode: t.string() },
    (ctx, { tournamentId, mode }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'bracket');
        ensureSeedingStage(tournament);
        if (mode !== 'mmr' && mode !== 'random') throw new SenderError('Seeding mode must be "mmr" or "random".');

        const teams = readyTeams(ctx, tournamentId);
        if (teams.length === 0) throw new SenderError('No Ready teams to seed.');

        let ordered: any[];
        if (mode === 'mmr') {
            // S10s (A122(18), L65): the captain's rating of the active season (the Season row with isActive, else 0, the
            // way the rating writer and the A36b registration check resolve it); a captain with no row there counts 0.
            const activeSeason = [...ctx.db.Season.is_active.filter(true)][0];
            const seasonId = activeSeason ? activeSeason.id : 0;
            const ratings = new Map<number, number>();
            for (const team of teams) {
                const modeRating = [...ctx.db.MmrRating.by_user_mode_season.filter([team.captainUserId, tournament.defaultGameMode, seasonId])][0];
                ratings.set(team.id, modeRating ? modeRating.rating : 0);
            }
            ordered = [...teams].sort((a: any, b: any) => (ratings.get(b.id)! - ratings.get(a.id)!) || a.id - b.id);
        } else {
            // A120: the fair shuffle, keyed by the transaction time, the seeding domain word and the tournament id.
            ordered = fairShuffle(teams, shuffleKeyAt(ctx.timestamp.microsSinceUnixEpoch, [SHUFFLE_DOMAIN.BracketSeeding, tournamentId]));
        }

        writeSeeds(ctx, tournament, ordered, user.id);
        console.log(`[BRACKET] Seeded ${teams.length} teams for tournament #${tournamentId} (mode: ${mode})`);
    }
);

// ─── set_seed_order ───────────────────────────────────────────────────────────
// `bracket`; Seeding. `teamIds` must be exactly the Ready teams, each once; position i → seed i + 1.
// Replaces swap_seeds.

export const set_seed_order = spacetimedb.reducer(
    { tournamentId: t.u32(), teamIds: t.array(t.u32()) },
    (ctx, { tournamentId, teamIds }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'bracket');
        ensureSeedingStage(tournament);

        const teams = readyTeams(ctx, tournamentId);
        const byId = new Map<number, any>(teams.map((team: any) => [team.id, team]));
        if (new Set(teamIds).size !== teamIds.length) throw new SenderError('A team appears twice in the seed order.');
        if (teamIds.length !== teams.length || teamIds.some((id: number) => !byId.has(id))) {
            throw new SenderError('The seed order must list every Ready team exactly once.');
        }

        writeSeeds(ctx, tournament, teamIds.map((id: number) => byId.get(id)), user.id);
        console.log(`[BRACKET] Seed order set for tournament #${tournamentId} (${teamIds.length} teams)`);
    }
);

// ─── generate_bracket ─────────────────────────────────────────────────────────
// `bracket`; Seeding. Withdraws the still-Forming teams (A26a), requires ≥ 2 Ready teams with unique seeds,
// deletes any previous bracket with its stand-ins and calendar rows (T20), then:
//   SingleElimination / DoubleElimination: the engine over the Ready teams by seed (A27, A29).
//   GroupOnly / GroupInto*: round-robin groups, manual (TournamentTeam.groupId, A36a) or snake split (A32);
//   the elimination part of GroupInto* is created by advance_group_stage from the standings (review T7).
// Stamps bracketGeneratedAt.

/**
 * Manual groups (A36a, A32): every Ready team grouped, groupCount groups, each ≥ groupSize, sizes within one.
 * As in the auto split (shared/bracket/groups.ts), fewer Ready teams than groupSize make one group holding every team.
 */
function manualGroups(ready: any[], groupSize: number): number[][] {
    const count = groupCount(ready.length, groupSize);
    const groups: number[][] = Array.from({ length: count }, () => []);
    for (const team of ready) {
        if (team.groupId === undefined) throw new SenderError(`Team "${team.name}" has no group.`);
        if (team.groupId >= count) throw new SenderError(`Team "${team.name}" is in group ${team.groupId}; only ${count} groups exist.`);
        groups[team.groupId].push(team.id);
    }
    const sizes = groups.map((g) => g.length);
    if (count > 1 && sizes.some((s) => s < groupSize)) throw new SenderError(`Every group needs at least ${groupSize} teams.`);
    if (Math.max(...sizes) - Math.min(...sizes) > 1) throw new SenderError('Group sizes may differ by one team at most.');
    return groups;
}

export const generate_bracket = spacetimedb.reducer(
    { tournamentId: t.u32() },
    (ctx, { tournamentId }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'bracket');
        ensureSeedingStage(tournament);
        const formatTag = tournament.format.tag as string;

        // 1. A26a: teams still Forming at generation are Withdrawn; their members stay enrolled.
        for (const team of [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)]) {
            if (team.status.tag === 'Forming') {
                ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { status: unit('Withdrawn') }, user.id));
            }
        }

        // 2. ≥ 2 Ready teams, every one seeded once (the pure engine throws plain Errors below 2: check first).
        const ready = readyTeams(ctx, tournamentId);
        if (ready.length < 2) throw new SenderError('At least 2 Ready teams are needed.');
        if (ready.some((team: any) => team.seedNumber === undefined)) throw new SenderError('Seed every Ready team first.');
        if (new Set(ready.map((team: any) => team.seedNumber)).size !== ready.length) {
            throw new SenderError('Seed numbers must be unique.');
        }
        ready.sort((a: any, b: any) => a.seedNumber - b.seedNumber);
        const teamIdsBySeed = ready.map((team: any) => team.id as number);

        // Format checks before anything is deleted or written.
        if (tournament.has3rdPlaceMatch && !allowsThirdPlace(tournament.format)) {
            throw new SenderError('A third-place match exists only in single elimination.');
        }
        let groups: number[][] | undefined;
        if (isGroupFormat(formatTag)) {
            if (tournament.groupSize < 2) throw new SenderError('groupSize must be at least 2.');
            // Manual groups are read before deleteBracket, which clears TournamentTeam.groupId.
            groups = tournament.groupAssignmentMode.tag === 'Manual'
                ? manualGroups(ready, tournament.groupSize)
                : splitIntoGroups(teamIdsBySeed, tournament.groupSize);
            if (formatTag !== 'GroupOnly') {
                if (tournament.groupAdvanceCount < 1 || tournament.groupAdvanceCount > 2) {
                    throw new SenderError('groupAdvanceCount must be 1 or 2.');
                }
                if (groups.length * tournament.groupAdvanceCount < 2) {
                    throw new SenderError('At least 2 teams must qualify from the groups.');
                }
            }
        } else if (formatTag !== 'SingleElimination' && formatTag !== 'DoubleElimination') {
            throw new SenderError(`Unknown tournament format: ${formatTag}.`);
        }

        // 3. T20: regeneration removes the old rows with their stand-ins and calendar rows.
        deleteBracket(ctx, tournamentId, user.id);

        // 4. Rows.
        let summary: string;
        if (groups) {
            for (const g of groups) {
                const seedOf = new Map<number, number>(ready.map((team: any) => [team.id, team.seedNumber]));
                g.sort((a, b) => seedOf.get(a)! - seedOf.get(b)!);
            }
            const ids = insertGroupBracket(ctx, tournament, groups, user.id);
            summary = `${groups.length} group(s), ${ids.size} group matches`;
        } else {
            const spec = formatTag === 'SingleElimination'
                ? generateSingleElim(teamIdsBySeed.length, { thirdPlace: tournament.has3rdPlaceMatch })
                : generateDoubleElim(teamIdsBySeed.length, { winnerAdvantage: tournament.winnerAdvantage });
            const ids = insertBracket(ctx, tournament, spec, teamIdsBySeed, user.id);
            summary = `${ids.size} matches`;
        }

        // 5. Seeding → InProgress requires bracketGeneratedAt ≥ lastSeedChangeAt (review §5.1).
        const fresh = ctx.db.Tournament.id.find(tournamentId)!;
        ctx.db.Tournament.id.update(updateWithAudit(ctx, fresh, { bracketGeneratedAt: ctx.timestamp }, user.id));

        console.log(`[BRACKET] Generated bracket for tournament #${tournamentId} (${formatTag}): ${summary}`);
    }
);
