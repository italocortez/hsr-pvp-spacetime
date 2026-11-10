// T-S8d: in-memory tests for tournament lobbies (A27, A33, A33a, A34, A35, D-22, D-45, D-65, ACCESS-SECURITY-OPS
// §D.8.4 / §D.8.5): create_tournament_lobby (callers, guards, the integrity set from the tournament, the free set from
// the preset / system preset, no series field on the lobby (T-S8e, A67(2)), the creator as host + referee),
// approve_stand_in / revoke_stand_in, the A35 seat rule on join_lobby (auto-seat) and set_team_slot, reclaim_referee
// by seated staff, and the locked integrity set of update_lobby_settings. Builders in s8d-fixtures.ts. Nothing
// reaches maincloud. The A67(5) D-45 rule and the game cap are tested in s8e-bracket-series.test.ts.
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_PERM_MESSAGES } from '@module/helpers/tournament/tournamentPermissions';
import { M, expectReject, guest, lobbyRow, member, newHarness, setupLobby, tx, type Actor, type Harness, seatOf } from './s4-fixtures';
import {
    advanceStage,
    assignAssistant,
    host,
    liveField,
    matchRow,
    openTournament,
    fullTeams,
    seedAndGenerate,
    tRow,
    verified,
} from './s8-fixtures';
import { byKey, createTournamentLobby, join, lobbiesOf, sidesOf } from './s8d-fixtures';

const SEAT = 'This seat is not available to you in this tournament lobby.';
const PARTICIPANTS = TOURNAMENT_PERM_MESSAGES.participants;

const slotOf = (test: Harness, lobbyId: number, who: Actor) => member(test, lobbyId, who.userId)?.lobbySlot.tag;
const setSlot = (test: Harness, by: Actor, lobbyId: number, target: Actor, slot: string) =>
    tx(test, by, (ctx) => M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, target.userId), lobbySlot: { tag: slot } as any }));
const approve = (test: Harness, by: Actor, bracketMatchId: number, teamId: number, userId: number) =>
    tx(test, by, (ctx) => M.approve_stand_in(ctx, { bracketMatchId, teamId, userId }));
const revoke = (test: Harness, by: Actor, bracketMatchId: number, userId: number) =>
    tx(test, by, (ctx) => M.revoke_stand_in(ctx, { bracketMatchId, userId }));
const standIns = (test: Harness, bracketMatchId: number) => [...test.db.TournamentStandIn.bracket_match_id.filter(bracketMatchId)];

/** update_lobby_settings arguments built from the lobby row itself (so only the overridden keys change). */
function settingsFrom(test: Harness, lobbyId: number, over: Record<string, unknown> = {}) {
    const l = lobbyRow(test, lobbyId);
    return {
        lobbyId,
        teamSize: l.teamSize, draftMode: l.draftMode, banMode: l.banMode, gameMode: l.gameMode, matchType: l.matchType,
        standardTurnSeconds: l.standardTurnSeconds, reserveBankSeconds: l.reserveBankSeconds,
        characterBudget: l.characterBudget, lightconeBudget: l.lightconeBudget, minimumBidRaise: l.minimumBidRaise,
        rosterDiffAdvantage: l.rosterDiffAdvantage, rosterThreshold: l.rosterThreshold,
        underThresholdAdvantage: l.underThresholdAdvantage, aboveThresholdPenalty: l.aboveThresholdPenalty,
        deathPenalty: l.deathPenalty, isAnonymousPlayers: l.isAnonymousPlayers, isAnonymousSpectators: l.isAnonymousSpectators,
        rosterVisibility: l.rosterVisibility, requireOwnership: l.requireOwnership, costSetId: l.costSetId,
        disconnectPolicy: l.disconnectPolicy, disconnectForfeitSeconds: l.disconnectForfeitSeconds ?? 0,
        allowMirrorPicks: l.allowMirrorPicks, autoRandomPick: l.autoRandomPick, refereeCanUndo: l.refereeCanUndo,
        refereeCanPause: l.refereeCanPause, refereeCanSetCaptain: l.refereeCanSetCaptain, refereeCanKick: l.refereeCanKick,
        allowPlayerPause: l.allowPlayerPause, refereeExclusiveConcede: l.refereeExclusiveConcede,
        teamBlueAlias: l.teamBlueAlias, teamRedAlias: l.teamRedAlias, isPublic: l.isPublic, password: '',
        ...over,
    } as any;
}

// ─── create_tournament_lobby: callers and guards ──────────────────────────────

describe('create_tournament_lobby: callers (A34)', () => {
    it('a team1 member creates it: host + referee, seated BluePlayer (A35 team1 = Blue), not captain', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const { blue } = sidesOf(f, m.id);
        const lobbyId = createTournamentLobby(f.test, blue.mate, m.id);
        const l = lobbyRow(f.test, lobbyId);
        expect(l.hostUserId).toBe(blue.mate.userId);
        expect(l.isTournamentControlled).toBe(true);
        expect(l.tournamentId).toBe(f.id);
        expect(l.bracketMatchId).toBe(m.id);
        expect(l.stage.tag).toBe('Waiting');
        const me = member(f.test, lobbyId, blue.mate.userId);
        expect(me.lobbySlot.tag).toBe('BluePlayer');
        expect(me.isReferee).toBe(true);
        expect(me.isCaptain).toBe(false);
    });

    it('a team2 member creates it: seated RedPlayer', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const { red } = sidesOf(f, m.id);
        const lobbyId = createTournamentLobby(f.test, red.captain, m.id);
        expect(slotOf(f.test, lobbyId, red.captain)).toBe('RedPlayer');
        expect(member(f.test, lobbyId, red.captain.userId).isReferee).toBe(true);
    });

    // T-S10v (A140): a stand-in approval no longer allows creating the lobby; a member creates and the stand-in joins.
    it('A140: an approved stand-in of team2 cannot create it; a team member creates and the stand-in joins on RedPlayer', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const sub = verified(f.test, 'sub');
        approve(f.test, f.org, m.id, m.team2Id!, sub.userId);
        expectReject(f.test, sub, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m.id }), 'A stand-in cannot create the match lobby: a team member or tournament staff creates it.');
        const red = f.ts.find((t) => t.teamId === m.team2Id)!;
        const lobbyId = createTournamentLobby(f.test, red.captain, m.id);
        join(f.test, sub, lobbyId);
        expect(slotOf(f.test, lobbyId, sub)).toBe('RedPlayer');
        expect(member(f.test, lobbyId, sub.userId).isReferee).toBe(false);
    });

    it('bracket staff (organizer, bracket assistant) create it as a Spectator referee and a member (D-22 applies)', () => {
        const f = liveField(4);
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const lobbyId = createTournamentLobby(f.test, f.org, m1.id);
        const me = member(f.test, lobbyId, f.org.userId);
        expect(me.lobbySlot.tag).toBe('Spectator');
        expect(me.isReferee).toBe(true);
        expect(lobbyRow(f.test, lobbyId).hostUserId).toBe(f.org.userId);
        // D-22: the organizer already sits in a Waiting lobby.
        expectReject(f.test, f.org, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m2.id }), /already in a lobby/);

        const asst = verified(f.test, 'asst');
        assignAssistant(f.test, f.org, f.id, asst, { bracket: true });
        const second = createTournamentLobby(f.test, asst, m2.id);
        expect(slotOf(f.test, second, asst)).toBe('Spectator');
        expect(member(f.test, second, asst.userId).isReferee).toBe(true);
    });

    it('rejected: an outsider, a results-only assistant, a non-Ready match, a second live lobby; a non-InProgress tournament', () => {
        const f = liveField(4);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const AUTH = 'You are not authorized to create a lobby for this bracket match.';
        expectReject(f.test, verified(f.test, 'out'), (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m.id }), AUTH);
        const res = verified(f.test, 'res');
        assignAssistant(f.test, f.org, f.id, res, { results: true });
        expectReject(f.test, res, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m.id }), AUTH);
        // A team of the other round-1 match is not a participant of this one.
        const other = f.ts.find((t) => t.teamId !== m.team1Id && t.teamId !== m.team2Id)!;
        expectReject(f.test, other.captain, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m.id }), AUTH);
        expect(final.state.tag).not.toBe('Ready');
        expectReject(f.test, f.org, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: final.id }), /a lobby needs a Ready match/);
        expectReject(f.test, f.org, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: 99999 }), 'Bracket match not found.');

        const { blue, red } = sidesOf(f, m.id);
        createTournamentLobby(f.test, blue.captain, m.id);
        expectReject(f.test, red.captain, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m.id }),
            'A lobby for this bracket match is still in play.'); // T-S8e: D-45 as reworded by A67(5)
        expect(lobbiesOf(f.test, m.id)).toHaveLength(1);

        // Seeding (bracket generated, matches Ready): not in progress.
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        fullTeams(test, id, 2);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        const seedingMatch = [...test.db.BracketMatch.tournament_id.filter(id)][0];
        expectReject(test, org, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: seedingMatch.id }),
            'Tournament is not in progress.');
    });
});

// ─── create_tournament_lobby: settings (A33, A33a, A27) ───────────────────────

describe('create_tournament_lobby: the integrity set, the free set, the series (A33, A33a, A27)', () => {
    it('the integrity set is copied from the tournament; no series fields on the lobby (A67(2)); Casual from countTowardsMmr false', () => {
        // T-S10v (A137(4)): registration in a requireOwnership tournament now needs an active game account; the fixture
        // players own none, so the field is built without the flag and the flag is set on the row before the lobby.
        const f = liveField(2, {
            lineupFormat: 'Thirds', rosterVisibility: 'ClosedWithRating', isAnonymousDefault: true,
            disconnectPolicy: 'Deferred', disconnectForfeitSeconds: 45, allowMirrorPicks: true,
            defaultGameMode: 'ApocalypticShadow', grandFinalBestOf: 3,
        });
        f.test.db.Tournament.id.update({ ...tRow(f.test, f.id), requireOwnership: true });
        const t = tRow(f.test, f.id);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        const l = lobbyRow(f.test, lobbyId);
        expect(l.teamSize).toBe(t.teamSize);
        expect(l.gameMode.tag).toBe('ApocalypticShadow');
        expect(l.gameMode).toEqual(t.defaultGameMode);
        expect(l.matchType.tag).toBe('Casual');
        expect(l.isAnonymousPlayers).toBe(true);
        expect(l.isAnonymousPlayers).toBe(t.isAnonymousDefault);
        expect(l.isAnonymousSpectators).toBe(t.isAnonymousSpectators);
        expect(l.rosterVisibility.tag).toBe('ClosedWithRating');
        expect(l.requireOwnership).toBe(true);
        expect(l.costSetId).toBe(t.costSetId);
        expect(l.disconnectPolicy.tag).toBe('Deferred');
        expect(l.disconnectForfeitSeconds).toBe(45);
        expect(l.allowMirrorPicks).toBe(true);
        expect(l.lineupFormat.tag).toBe('Thirds');
        // T-S8e (A67(2)): the lobby no longer carries bestOf / bestOfNAdvantage; the bracket match does.
        expect('bestOf' in l).toBe(false);
        expect('bestOfNAdvantage' in l).toBe(false);
        expect(matchRow(f.test, m.id).bestOf).toBeGreaterThanOrEqual(1);
        expect(l.name).toContain(t.name);
        expect(l.name).toContain(m.positionKey);
    });

    it('Ranked when countTowardsMmr; allowMirrorPicks forced false (D-42)', () => {
        const f = liveField(2, { countTowardsMmr: true, allowMirrorPicks: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const l = lobbyRow(f.test, createTournamentLobby(f.test, f.org, m.id));
        expect(l.matchType.tag).toBe('Ranked');
        expect(l.allowMirrorPicks).toBe(false);
    });

    // T-S8e (A67(2)(4)): the head start lives on the bracket match only (pre-credited to team1 by the derived tally);
    // the grand-final lobby has no advantage field and no bestOf.
    it('the head start stays on the bracket match (A27, A67(4)); the grand-final lobby carries no series field', () => {
        const f = liveField(4, { format: 'DoubleElimination', grandFinalBestOf: 3, winnerAdvantage: 1 });
        const rows = [...f.test.db.BracketMatch.tournament_id.filter(f.id)];
        const gf = rows.find((r) => r.bracketSide.tag === 'GrandFinals')!;
        expect(gf.winnerAdvantage).toBeGreaterThan(0);
        const first = rows.find((r) => r.state.tag === 'Ready' && r.bracketSide.tag === 'Winners')!;
        expect(first.winnerAdvantage).toBe(0);
        createTournamentLobby(f.test, sidesOf(f, first.id).blue.captain, first.id);
        // Staff settle every other match (the resolve voids the waiting lobby of the first one, A24(3)) until the
        // grand final is Ready.
        let guard = 0;
        while (matchRow(f.test, gf.id).state.tag !== 'Ready' && guard++ < 10) {
            const ready = [...f.test.db.BracketMatch.tournament_id.filter(f.id)].find((r) => r.state.tag === 'Ready' && r.id !== gf.id)!;
            tx(f.test, f.org, (ctx) => M.resolve_bracket_match(ctx, { bracketMatchId: ready.id, winnerTeamId: ready.team1Id!, reason: 't' }));
        }
        const l = lobbyRow(f.test, createTournamentLobby(f.test, f.org, gf.id));
        expect('bestOfNAdvantage' in l).toBe(false);
        expect('bestOf' in l).toBe(false);
        const g = matchRow(f.test, gf.id);
        expect(g.bestOf).toBe(3);
        expect(g.winnerAdvantage).toBe(1); // the stored-tally expectation lives in s8e-bracket-series
    });

    it('the free set comes from the tournament preset, and from the system preset once that row is gone (A33a)', () => {
        const f = liveField(4);
        const sys = [...f.test.db.LobbyPreset.iter()].find((p) => p.isSystemPreset)!;
        const own = f.test.db.LobbyPreset.insert({
            ...sys, id: 0, isSystemPreset: false, name: 'own', creatorUserId: f.org.userId,
            standardTurnSeconds: 77, reserveBankSeconds: 33, characterBudget: 321, banMode: { tag: 'None' } as any,
            refereeCanKick: true, hideMmr: !sys.hideMmr,
        });
        f.test.db.Tournament.id.update({ ...tRow(f.test, f.id), lobbyPresetId: own.id });

        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const l1 = lobbyRow(f.test, createTournamentLobby(f.test, f.org, m1.id));
        expect(l1.standardTurnSeconds).toBe(77);
        expect(l1.reserveBankSeconds).toBe(33);
        expect(l1.characterBudget).toBe(321);
        expect(l1.banMode.tag).toBe('None');
        expect(l1.refereeCanKick).toBe(true);
        expect(l1.hideMmr).toBe(own.hideMmr);
        // The preset's integrity placeholders never leak: teamSize stays the tournament's.
        expect(l1.teamSize).toBe(tRow(f.test, f.id).teamSize);

        f.test.db.LobbyPreset.id.delete(own.id);
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const l2 = lobbyRow(f.test, createTournamentLobby(f.test, sidesOf(f, m2.id).blue.captain, m2.id));
        expect(l2.standardTurnSeconds).toBe(sys.standardTurnSeconds);
        expect(l2.characterBudget).toBe(sys.characterBudget);
        expect(l2.banMode.tag).toBe(sys.banMode.tag);
        expect(l2.refereeCanKick).toBe(sys.refereeCanKick);
    });
});

// ─── approve_stand_in / revoke_stand_in (A25 participants, A35, review §5.4) ──

describe('approve_stand_in / revoke_stand_in', () => {
    it('participants permission; teamId in the match; verified; not enrolled on the other team; duplicate rejected', () => {
        const f = liveField(4);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const sub = verified(f.test, 'sub');

        expectReject(f.test, blue.captain, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId }), PARTICIPANTS);
        const pAsst = verified(f.test, 'pa');
        assignAssistant(f.test, f.org, f.id, pAsst, { participants: true });
        const other = f.ts.find((t) => t.teamId !== m.team1Id && t.teamId !== m.team2Id)!;
        expectReject(f.test, f.org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: other.teamId, userId: sub.userId }),
            'The team does not play this bracket match.');
        const g = guest(f.test, 'g'); // never create actors inside a tx body
        expectReject(f.test, f.org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: g.userId }),
            'A stand-in must be a verified user.');
        expectReject(f.test, f.org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: red.mate.userId }),
            'A stand-in cannot be enrolled on the other team of the match.');

        approve(f.test, pAsst, m.id, m.team1Id!, sub.userId);
        const rows = standIns(f.test, m.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ teamId: m.team1Id, userId: sub.userId, approvedByUserId: pAsst.userId });
        expectReject(f.test, f.org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team2Id!, userId: sub.userId }),
            'Stand-in already approved for this bracket match.');
        // T-S10v (A135(3), SI8): a player of another team still in the tournament may no longer stand in.
        expectReject(f.test, f.org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team2Id!, userId: other.mate.userId }),
            'A player whose team is still in the tournament cannot be a stand-in.');
        expect(standIns(f.test, m.id)).toHaveLength(1);
    });

    it('revoke: participants permission; deletes the row; a missing approval rejected; the next seat rule follows', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const { blue } = sidesOf(f, m.id);
        const sub = verified(f.test, 'sub');
        approve(f.test, f.org, m.id, m.team1Id!, sub.userId);
        expectReject(f.test, blue.captain, (ctx) => M.revoke_stand_in(ctx, { bracketMatchId: m.id, userId: sub.userId }), PARTICIPANTS);
        revoke(f.test, f.org, m.id, sub.userId);
        expect(standIns(f.test, m.id)).toHaveLength(0);
        expectReject(f.test, f.org, (ctx) => M.revoke_stand_in(ctx, { bracketMatchId: m.id, userId: sub.userId }),
            'No stand-in approval for this user in this bracket match.');
        // Revoked: no longer a participant (cannot create the lobby, joins as Spectator).
        expectReject(f.test, sub, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m.id }),
            'You are not authorized to create a lobby for this bracket match.');
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        join(f.test, sub, lobbyId);
        expect(slotOf(f.test, lobbyId, sub)).toBe('Spectator');
    });
});

// ─── Seat enforcement (A35, D.8.5) ────────────────────────────────────────────

describe('seat rule: join_lobby auto-seat and set_team_slot (A35, A26, D.8.5)', () => {
    it('join_lobby in Waiting: team1 → BluePlayer, team2 → RedPlayer, a stand-in on its side, a full side and outsiders → Spectator', () => {
        const f = liveField(4);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const sub = verified(f.test, 'sub');
        approve(f.test, f.org, m.id, m.team2Id!, sub.userId);
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);

        join(f.test, red.captain, lobbyId);
        expect(slotOf(f.test, lobbyId, red.captain)).toBe('RedPlayer');
        join(f.test, sub, lobbyId);
        expect(slotOf(f.test, lobbyId, sub)).toBe('RedPlayer'); // the stand-in of team2
        join(f.test, red.mate, lobbyId);
        expect(slotOf(f.test, lobbyId, red.mate)).toBe('Spectator'); // Red is full (teamSize 2)
        join(f.test, blue.captain, lobbyId);
        join(f.test, blue.mate, lobbyId);
        expect(slotOf(f.test, lobbyId, blue.captain)).toBe('BluePlayer');
        expect(slotOf(f.test, lobbyId, blue.mate)).toBe('BluePlayer');
        const out = verified(f.test, 'out');
        join(f.test, out, lobbyId);
        expect(slotOf(f.test, lobbyId, out)).toBe('Spectator');
        const other = f.ts.find((t) => t.teamId !== m.team1Id && t.teamId !== m.team2Id)!;
        join(f.test, other.captain, lobbyId);
        expect(slotOf(f.test, lobbyId, other.captain)).toBe('Spectator');
    });

    it('set_team_slot outside allowedSlotsFor is rejected; inside it is accepted (players, coaches by the host)', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        const out = verified(f.test, 'out');
        for (const who of [blue.captain, red.captain, out]) join(f.test, who, lobbyId);

        expectReject(f.test, out, (ctx) => M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, out.userId), lobbySlot: { tag: 'BluePlayer' } as any }), SEAT);
        expectReject(f.test, red.captain, (ctx) => M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, red.captain.userId), lobbySlot: { tag: 'BluePlayer' } as any }), SEAT);
        expectReject(f.test, f.org, (ctx) => M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, out.userId), lobbySlot: { tag: 'RedCoach' } as any }), SEAT);
        expectReject(f.test, f.org, (ctx) => M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, blue.captain.userId), lobbySlot: { tag: 'RedCoach' } as any }), SEAT);
        // Staff may not sit as a player either (Spectator only).
        expectReject(f.test, f.org, (ctx) => M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, f.org.userId), lobbySlot: { tag: 'RedPlayer' } as any }), SEAT);

        setSlot(f.test, red.captain, lobbyId, red.captain, 'Spectator');
        expect(slotOf(f.test, lobbyId, red.captain)).toBe('Spectator');
        setSlot(f.test, red.captain, lobbyId, red.captain, 'RedPlayer');
        expect(slotOf(f.test, lobbyId, red.captain)).toBe('RedPlayer');
        setSlot(f.test, f.org, lobbyId, blue.captain, 'BlueCoach'); // coaches follow the team rule (D.8.5)
        expect(slotOf(f.test, lobbyId, blue.captain)).toBe('BlueCoach');
    });

    it('a casual lobby is unaffected: any guest takes any player seat', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: [['x', 'RedPlayer'], ['y', 'BluePlayer']], noStart: true });
        expect(slotOf(test, s.lobbyId, s.a.x)).toBe('RedPlayer');
        expect(slotOf(test, s.lobbyId, s.a.y)).toBe('BluePlayer');
        const late = guest(test, 'late');
        join(test, late, s.lobbyId);
        expect(slotOf(test, s.lobbyId, late)).toBe('Spectator'); // D-27: casual joins stay Spectator
        setSlot(test, late, s.lobbyId, late, 'BluePlayer');
        expect(slotOf(test, s.lobbyId, late)).toBe('BluePlayer');
    });
});

// ─── reclaim_referee (D.8.4) ──────────────────────────────────────────────────

describe('reclaim_referee in a tournament lobby (D.8.4)', () => {
    it('a seated member with the results permission reclaims; a plain spectator member cannot; the host still can', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const lobbyId = createTournamentLobby(f.test, blue.captain, m.id); // host + referee, BluePlayer
        const res = verified(f.test, 'res');
        assignAssistant(f.test, f.org, f.id, res, { results: true });
        const out = verified(f.test, 'out');
        for (const who of [red.captain, res, out]) join(f.test, who, lobbyId);

        expectReject(f.test, out, (ctx) => M.reclaim_referee(ctx, { lobbyId }), 'Only the lobby host can reclaim the referee flag.');
        expectReject(f.test, red.captain, (ctx) => M.reclaim_referee(ctx, { lobbyId }), 'Only the lobby host can reclaim the referee flag.');
        // Staff outside the lobby (not a member) cannot either.
        expectReject(f.test, f.org, (ctx) => M.reclaim_referee(ctx, { lobbyId }), 'Only the lobby host can reclaim the referee flag.');

        tx(f.test, res, (ctx) => M.reclaim_referee(ctx, { lobbyId }));
        expect(member(f.test, lobbyId, res.userId).isReferee).toBe(true);
        expect(member(f.test, lobbyId, blue.captain.userId).isReferee).toBe(false);

        tx(f.test, blue.captain, (ctx) => M.reclaim_referee(ctx, { lobbyId }));
        expect(member(f.test, lobbyId, blue.captain.userId).isReferee).toBe(true);
        expect(member(f.test, lobbyId, res.userId).isReferee).toBe(false);
    });

    it('a casual lobby keeps host-only', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        expectReject(test, s.a.b1, (ctx) => M.reclaim_referee(ctx, { lobbyId: s.lobbyId }), 'Only the lobby host can reclaim the referee flag.');
    });
});

// ─── update_lobby_settings (D-65, A33, A38(4)) ────────────────────────────────

describe('update_lobby_settings in a tournament lobby (D-65, A33)', () => {
    it('lineupFormat changes rejected; other integrity fields keep the tournament values; the free set is editable (T-S8e: no bestOf / advantage argument)', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        const before = lobbyRow(f.test, lobbyId);
        const call = (over: Record<string, unknown>) => {
            const args = settingsFrom(f.test, lobbyId, over);
            return (ctx: any) => M.update_lobby_settings(ctx, args);
        };
        expectReject(f.test, f.org, call({ lineupFormat: { tag: 'Thirds' } }), /lineupFormat is set by the tournament/);

        tx(f.test, f.org, call({
            gameMode: { tag: 'AnomalyArbitration' }, matchType: { tag: 'Ranked' }, rosterVisibility: { tag: 'ClosedNoRating' },
            costSetId: 7, allowMirrorPicks: !before.allowMirrorPicks, disconnectForfeitSeconds: 99,
            standardTurnSeconds: 91, characterBudget: 222, banMode: { tag: 'None' }, refereeCanKick: !before.refereeCanKick,
            lineupFormat: before.lineupFormat,
        }));
        const after = lobbyRow(f.test, lobbyId);
        expect(after.gameMode.tag).toBe(before.gameMode.tag);
        expect(after.matchType.tag).toBe(before.matchType.tag);
        expect(after.rosterVisibility.tag).toBe(before.rosterVisibility.tag);
        expect(after.costSetId).toBe(before.costSetId);
        expect(after.allowMirrorPicks).toBe(before.allowMirrorPicks);
        expect(after.disconnectForfeitSeconds).toBe(before.disconnectForfeitSeconds);
        expect(after.standardTurnSeconds).toBe(91);
        expect(after.characterBudget).toBe(222);
        expect(after.banMode.tag).toBe('None');
        expect(after.refereeCanKick).toBe(!before.refereeCanKick);
    });
});


// ─── shuffle_teams (A35, S8d review) ──────────────────────────────────────────

describe('shuffle_teams in a tournament lobby (A35, S8d review)', () => {
    it('rejected in a tournament lobby (seats unchanged); a casual lobby still shuffles', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        for (const who of [blue.captain, red.captain]) join(f.test, who, lobbyId);
        for (const mode of ['TeamSwap', 'RandomSwap']) {
            expectReject(f.test, f.org, (ctx) => M.shuffle_teams(ctx, { lobbyId, mode: { tag: mode } as any }),
                "Seats in a tournament lobby follow the bracket's sides (A35 / A70); shuffling is not available."); // T-S8g: A70 message
        }
        expect(slotOf(f.test, lobbyId, blue.captain)).toBe('BluePlayer');
        expect(slotOf(f.test, lobbyId, red.captain)).toBe('RedPlayer');

        const test = newHarness();
        const s = setupLobby(test, { seats: [['x', 'BluePlayer'], ['y', 'RedPlayer']], noStart: true });
        tx(test, s.host, (ctx) => M.shuffle_teams(ctx, { lobbyId: s.lobbyId, mode: { tag: 'TeamSwap' } as any }));
        expect(slotOf(test, s.lobbyId, s.a.x)).toBe('RedPlayer');
        expect(slotOf(test, s.lobbyId, s.a.y)).toBe('BluePlayer');
    });
});
