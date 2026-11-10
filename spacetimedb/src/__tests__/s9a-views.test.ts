// T-S9a: in-memory tests for step S9a, the lobby / match-session / match-result / tournament views (DECISIONS A37,
// A40, A44(1), A48, A56, A60, A63, A67(3), A68(10), A70(1), A71). Each view is called the way the harness smoke test
// shows: per-sender views with `test.viewContext(auth)`, anonymous shared views (and arg views) with
// `test.anonymousViewContext()`. State is built through the module's reducers (s4 / s7 / s8 / s8d builders); ratings,
// HSR accounts and roles are written straight into the in-memory datastore, as the earlier suites do. Readers per view:
// a member / participant, an outsider (a user in no lobby, not enrolled), an identity with no UserIdentity mapping and a
// Moderator who is not a member. Row shapes and messages: the views code is the truth; the decision rows say what
// must hold, so an anonymity leak stays a failing test (CLAUDE.md §6). Nothing reaches maincloud.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import type {
    AdjustmentItem,
    AnonymousChatRow,
    AnonymousMatchParticipantRow,
    AnonymousMatchStepRow,
    GroupScoreItem,
    Lobby as LobbyBinding,
    LobbyBanViewRow,
    LobbyBrowserRow,
    LobbyMemberViewRow,
    LobbyPresetViewRow,
    MatchForMeRow,
    MatchLineupViewRow,
    MatchResultGameViewRow,
    MatchResultRecord as MatchResultRecordBinding,
    MatchResultViewRow,
    MatchSessionViewRow,
    MyLobbyListRow,
    StandInViewRow,
    StuckGameRow,
    TeamRequestViewRow,
    TournamentLobbyRow,
    TournamentParticipantRow,
    TournamentRegistrantAccountRow,
    TournamentStaffRow,
    TournamentTeamMemberPublicRow,
    TournamentTeamPublicRow,
} from '@bindings/types';
import type { tables as bindingTables } from '@bindings/index';
import { lobbyColumns } from '@module/tables/lobby/lobby';
import { computeLobbyMemberRating } from '@module/helpers/stats/accountRating';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    TestAuth,
    advance,
    connect,
    disconnect,
    guest,
    lobbyRow,
    member,
    newHarness,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
    type SlotTag,
    seatOf,
} from './s4-fixtures';
import {
    H,
    blueNames,
    captain,
    closeGame,
    confirmBoth,
    confirmGame,
    finishGame,
    playToScoring,
    recordScores,
    redNames,
    side,
    type ScoringLobbyOpts,
} from './s7-fixtures';
import {
    AUDIT,
    advanceStage,
    assignAssistant,
    host as tournamentHost,
    insertHsrAccount,
    makeTeam,
    matchRow,
    moderator,
    openTournament,
    register,
    verified,
    type RegisterOpts,
} from './s8-fixtures';
import { duel, openMatchLobby, playMatch, seedElo, sidesOf } from './s8d-fixtures';
import { parkedLobby } from './s10-a2-fixtures';
import { seatLabel } from './s10h-fixtures';

// ─── Reading views ───────────────────────────────────────────────────────────

type Reader = Actor | TestAuth;
const authOf = (r: Reader): TestAuth => ('auth' in r ? r.auth : r);

/** A per-sender view as `who` reads it (T-S10n: with arguments for the per-match history views). */
function view<T = any>(test: Harness, name: string, who: Reader, args: Record<string, unknown> = {}): T[] {
    return (M as any)[name](test.viewContext(authOf(who)), args) as T[];
}

/** T-S10n (A115(3)): the history id of the one archived match `who` played in. */
const onlyMatchOf = (test: Harness, who: Actor) => [...test.db.MatchParticipantHistory.by_user.filter(who.userId)][0].matchHistoryId;

/** An anonymous shared view (no sender), optionally with arguments (arg views). */
function shared<T = any>(test: Harness, name: string, args: Record<string, unknown> = {}): T[] {
    return (M as any)[name](test.anonymousViewContext(), args) as T[];
}

let ghostSeq = 9_000n;
/** A client identity that never logged in: no UserIdentity mapping. */
const ghost = () => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub: `ghost-${ghostSeq}` }), new ConnectionId(ghostSeq++));

const displayName = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.displayName;
const keysOf = (row: object) => Object.keys(row).sort();
/** Runtime egress check: the emitted object carries no key outside the documented column list. */
function expectOnlyColumns(row: object, cols: readonly string[]) {
    const extra = Object.keys(row).filter((k) => !cols.includes(k));
    expect(extra, 'undocumented columns').toEqual([]);
}
const AUDIT_KEYS = ['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate'];
/** The audit columns that carry a user id (A37); a shared row may still carry a plain creation date (the browser's createdDate). */
const AUDIT_ID_KEYS = ['createdById', 'lastModifiedById'];
const USER_ID_KEY = /userid|byid$|^hostuserid$|^createdbyid$|^lastmodifiedbyid$/i;

// ─── Documented columns (the egress list; type-checked against the generated bindings) ───────────────────────

const COLS = {
    browser: ['id', 'name', 'joinCode', 'hostLabel', 'gameMode', 'draftMode', 'matchType', 'banMode', 'banRestriction',
        'lineupFormat', 'rosterVisibility', 'disconnectPolicy', 'teamSize', 'currentPlayerCount', 'coachCount',
        'spectatorCount', 'maxSpectators', 'isPublic', 'isAnonymousPlayers', 'isAnonymousSpectators',
        'isTournamentControlled', 'stage', 'createdDate', 'tournamentName', 'costSetName'] as const,
    myLobbies: ['id', 'joinCode', 'name', 'stage', 'isAway'] as const,
    member: ['memberKey', 'lobbyId', 'joinSeq', 'userId', 'label', 'lobbySlot', 'presence', 'isHost', 'isReferee',
        'isCaptain', 'isConfirmed', 'avatarCharacterName', 'displayedAchievementId', 'mmrByMode', 'accountRating',
        'accountCount', 'disconnectActionAt'] as const, // T-S10d: + disconnectActionAt (A92(9))
    ban: ['lobbyId', 'bannedUserId', 'bannedJoinSeq', 'label', 'bannedByUserId', 'createdDate'] as const, // T-S9c: + bannedJoinSeq (A74(2))
    chat: ['id', 'lobbyId', 'senderUserId', 'senderType', 'content', 'metadata', 'anonymousLabel', 'createdDate'] as const,
    session: ['lobbyId', 'turnIndex', 'draftSequence', 'timerState', 'isAuctionPhase', 'nextNominatorTeam',
        'blueCharactersWon', 'redCharactersWon', 'currentNomination', 'currentBidAmount', 'currentBidTeam',
        'teamBlueCharBudget', 'teamRedCharBudget', 'teamBlueLcBudget', 'teamRedLcBudget', 'pausesUsedBlue',
        'pausesUsedRed'] as const,
    step: ['id', 'lobbyId', 'sequence', 'actorUserId', 'anonymousLabel', 'actorSlot', 'action', 'payload', 'timestamp'] as const,
    participant: ['matchResultId', 'userId', 'teamSide', 'isCaptain', 'anonymousLabel', 'accountRatingSnapshot'] as const,
    lineup: ['id', 'lobbyId', 'teamSide', 'groups', 'synergySurcharge', 'rosterCost', 'blueConfirmed', 'redConfirmed',
        'closedAt'] as const,
    result: ['id', 'lobbyId', 'bracketMatchId', 'isTournamentControlled', 'status', 'winnerTeamSide', 'matchType',
        'matchEndReason', 'concedeTrigger', 'concedeSummary', 'concedeAtStage', 'disputedByUserId', 'disputeReason',
        'winnerOverride', 'winnerOverrideById', 'winnerOverrideReason', 'settledAt'] as const,
    game: ['matchResultId', 'lobbyId', 'gameMode', 'teamBlueScreenshotUrl', 'teamRedScreenshotUrl', 'teamBlueCyclesUsed',
        'teamRedCyclesUsed', 'teamBlueScore', 'teamRedScore', 'teamBlueDeaths', 'teamRedDeaths', 'teamBlueAdjustedResult',
        'teamRedAdjustedResult', 'tieBreakLevel', 'winnerTeamSide', 'validationStatus', 'validatedByUserId',
        'blueConfirmed', 'redConfirmed', 'closedAt', 'closedById', 'groupScores', 'adjustments'] as const,
    groupScore: ['teamSide', 'groupIndex', 'value'] as const,
    adjustment: ['id', 'teamSide', 'value', 'reason', 'setById'] as const,
    stuck: ['lobbyId', 'joinCode', 'stage', 'blueConfirmed', 'redConfirmed', 'isTie', 'sinceAt'] as const,
    tParticipant: ['tournamentId', 'seat', 'teamId', 'userId', 'label', 'status', 'isWaitlisted'] as const,
    tTeam: ['id', 'tournamentId', 'name', 'status', 'seedNumber', 'groupId', 'finalPlacement', 'captainUserId'] as const,
    tTeamMember: ['teamId', 'tournamentId', 'userId', 'label'] as const,
    tStaff: ['tournamentId', 'userId', 'label', 'isOrganizer', 'canManageParticipants', 'canManageBracket',
        'canResolveResults'] as const,
    teamRequest: ['teamId', 'tournamentId', 'teamName', 'userId', 'label', 'isMine', 'createdDate'] as const,
    standIn: ['id', 'bracketMatchId', 'teamId', 'userId', 'label'] as const,
    registrant: ['tournamentId', 'userId', 'seat', 'hsrAccountId', 'displayLabel', 'accountRating', 'characterName',
        'eidolonLevel'] as const,
    matchForMe: ['bracketMatchId', 'tournamentId', 'myTeamId', 'opponentTeamId', 'opponentTeamName', 'blueTeamId',
        'redTeamId', 'state', 'bracketSide', 'roundNumber', 'matchNumber', 'bestOf', 'team1Id', 'team2Id', 'team1Games',
        'team2Games', 'scheduledAt'] as const,
};
type Cols<K extends keyof typeof COLS> = (typeof COLS)[K][number];

// ─── Builders ────────────────────────────────────────────────────────────────

/** Seats named `${p}b1`, `${p}b2` (Blue), `${p}r1`, `${p}r2` (Red); the host `${p}host`. */
function seatsOf(p: string): Array<[string, SlotTag]> {
    return [[`${p}b1`, 'BluePlayer'], [`${p}b2`, 'BluePlayer'], [`${p}r1`, 'RedPlayer'], [`${p}r2`, 'RedPlayer']];
}

/** A lobby whose actors carry the prefix `p` (several lobbies in one harness; D-22 binds a user to one lobby). */
function lobbyOf(test: Harness, p: string, opts: SetupOpts = {}): Lobby {
    return setupLobby(test, { seats: seatsOf(p), actors: { host: guest(test, `${p}host`) }, ...opts });
}

/** playToScoring with prefixed actors and character names (HsrCharacter names are unique per harness). */
function scoringOf(test: Harness, p: string, opts: ScoringLobbyOpts = {}): Lobby {
    return playToScoring(test, {
        seats: seatsOf(p),
        actors: { host: guest(test, `${p}host`) },
        blue: blueNames().map((n) => `${p}${n}`),
        red: redNames().map((n) => `${p}${n}`),
        ...opts,
    });
}

/** beforeStart hook: the lobby becomes Ranked (direct row edit, as s7b) and every player gets an HSR account (D-08). */
const makeRanked = (test: Harness) => (l: Lobby) => {
    test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
    let accountId = 800 + l.lobbyId * 10;
    for (const m of test.db.LobbyMember.lobby_id.filter(l.lobbyId)) {
        if (m.lobbySlot.tag === 'BluePlayer' || m.lobbySlot.tag === 'RedPlayer') {
            test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: m.userId, hsrAccountId: accountId++ });
        }
    }
};

const ANON = { isAnonymousPlayers: true };
const leave = (test: Harness, who: Actor, lobbyId: number) => tx(test, who, (ctx) => M.leave_lobby(ctx, { lobbyId }));
const chat = (test: Harness, who: Actor, lobbyId: number, content: string) =>
    tx(test, who, (ctx) => M.send_chat_message(ctx, { lobbyId, content, metadata: '' }));
const createCasual = (test: Harness, who: Actor, over: Record<string, unknown> = {}) =>
    tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...over } as any));
const hostedBy = (test: Harness, who: Actor) => [...test.db.Lobby.iter()].filter((l) => l.hostUserId === who.userId);
const recordOf = (test: Harness, lobbyId: number) => [...test.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];

/** Sets a LobbyMember flag directly (the table has no primary key: delete + insert the same row). */
function patchMember(test: Harness, lobbyId: number, userId: number, patch: Record<string, unknown>) {
    const row = member(test, lobbyId, userId);
    test.db.LobbyMember.delete(row);
    test.db.LobbyMember.insert({ ...row, ...patch } as any);
}

/** An HSR account with a fixed rating selected by `who` for the lobby. Returns the account id. */
function selectRatedAccount(test: Harness, lobbyId: number, who: Actor, uid: string, rating: number): number {
    const id = insertHsrAccount(test, who.userId, uid);
    test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(id)!, accountRating: rating });
    test.db.LobbyMemberAccount.insert({ lobbyId, userId: who.userId, hsrAccountId: id });
    return id;
}

const ratingOf = (test: Harness, lobbyId: number, userId: number) =>
    Math.round(tx(test, 'internal', (ctx) => computeLobbyMemberRating(ctx, lobbyId, userId)));

const rowFor = <T extends { userId: number; label: string }>(rows: T[], label: string) => rows.find((r) => r.label === label)!;

// ════════════════════════════════════════════════════════════════════════════
// Outsider isolation (A37; §A.4 P1): every per-sender view returns [] for an outsider, an unmapped identity and a
// Moderator who is not a member, while a member of the same world reads rows (so the [] is not vacuous).
// ════════════════════════════════════════════════════════════════════════════

describe('A37 outsider isolation: per-sender views', () => {
    /** A lobby world: a Scoring lobby with chat, a ban and an adjustment; a finalized casual match (replay rows). */
    function lobbyWorld() {
        const test = newHarness();
        seedElo(test);
        const s = scoringOf(test, '', {
            beforeStart: (l) => {
                const banned = guest(test, 'banned');
                tx(test, banned, (ctx) => M.join_lobby(ctx, { lobbyId: l.lobbyId, joinCode: '', password: '' }));
                tx(test, l.host, (ctx) => M.ban_member(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, banned.userId) }));
            },
        });
        chat(test, s.a.b1, s.lobbyId, 'hello');
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), value: H(1) }));
        const done = scoringOf(test, 'Z');
        finishGame(done, 'Blue');
        return { test, s, done, outsider: guest(test, 'outsider'), mod: moderator(test, 'mod') };
    }

    /** A tournament world: a duel with a stand-in, colours set and a Waiting lobby; a Registration cup with a request. */
    function tournamentWorld() {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const sub = verified(test, 'sub');
        tx(test, org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId }));
        openMatchLobby(f, m.id, { noStart: true });
        const cup = openTournament(test, org, { name: 'Cup 2' });
        const cap = verified(test, 'cap');
        const asker = verified(test, 'asker');
        register(test, cap, cup);
        register(test, asker, cup);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: cup, teamName: 'Forming' }));
        const teamId = [...test.db.TournamentTeam.tournament_id.filter(cup)][0].id;
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));
        return { f, test, org, m, sub, cap, asker, outsider: guest(test, 'outsider'), mod: moderator(test, 'mod') };
    }

    it('lobby / match / result views: [] for an outsider, an unmapped identity and a non-member Moderator; a member reads rows', () => {
        const { test, s, done, outsider, mod } = lobbyWorld();
        const views: Array<[string, Actor]> = [
            ['view_my_lobbies', s.a.b1],
            ['view_my_lobby', s.a.b1],
            ['view_my_lobby_chat', s.a.b1],
            ['view_my_lobby_members', s.a.b1],
            ['view_my_lobby_bans', s.host],
            ['view_my_match_session', s.a.b1],
            ['view_my_match_steps', s.a.b1],
            ['view_my_match_participants', s.a.b1],
            ['view_my_lineups', s.a.b1],
            ['view_my_match_result', s.a.b1],
            ['view_my_match_result_games', s.a.b1],
        ];
        for (const [name, memberReader] of views) {
            expect(view(test, name, memberReader).length, `${name}: member`).toBeGreaterThan(0);
            expect(view(test, name, outsider), `${name}: outsider`).toEqual([]);
            expect(view(test, name, ghost()), `${name}: unmapped identity`).toEqual([]);
            expect(view(test, name, mod), `${name}: non-member Moderator`).toEqual([]);
        }
        // T-S10n (A115(3)): the replay lineups (was view_my_match_lineup_history) are read per match.
        const lineups = { matchHistoryId: onlyMatchOf(test, done.a.Zb1) };
        const name = 'view_my_match_history_lineups';
        expect(view(test, name, done.a.Zb1, lineups).length, `${name}: member`).toBeGreaterThan(0);
        expect(view(test, name, outsider, lineups), `${name}: outsider`).toEqual([]);
        expect(view(test, name, ghost(), lineups), `${name}: unmapped identity`).toEqual([]);
        expect(view(test, name, mod, lineups), `${name}: non-member Moderator`).toEqual([]);
    });

    it('view_lobby_presets: [] for an unmapped identity; any mapped user reads the system preset only', () => {
        const { test, outsider } = lobbyWorld();
        expect(view(test, 'view_lobby_presets', ghost())).toEqual([]);
        const rows = view<LobbyPresetViewRow>(test, 'view_lobby_presets', outsider);
        expect(rows).toHaveLength(1);
        expect(rows[0].isSystemPreset).toBe(true);
    });

    it('view_admin_stuck_games: [] for a player, an outsider and an unmapped identity', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { beforeStart: makeRanked(test) });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(20)]);
        confirmGame(s, captain(s, 'Blue'), 'Blue');
        expect(view(test, 'view_admin_stuck_games', moderator(test))).toHaveLength(1);
        expect(view(test, 'view_admin_stuck_games', s.a.b1)).toEqual([]);
        expect(view(test, 'view_admin_stuck_games', guest(test, 'outsider'))).toEqual([]);
        expect(view(test, 'view_admin_stuck_games', ghost())).toEqual([]);
    });

    it('tournament per-sender views: [] for an outsider, an unmapped identity and a non-staff Moderator (personal views); a participant / staff reads rows; T-S10g (A105(1)): a Moderator reads the running tournaments through the staff view', () => {
        const { test, org, f, sub, cap, outsider, mod } = tournamentWorld();
        const personal: Array<[string, Actor]> = [
            ['view_my_tournament_enrollment', f.ts[0].captain],
            ['view_my_team_requests', cap],
            ['view_my_stand_ins', sub],
            ['view_tournament_matches_for_me', f.ts[0].captain],
        ];
        const views: Array<[string, Actor]> = [...personal, ['view_my_tournament_lobbies', org]];
        for (const [name, reader] of views) {
            expect(view(test, name, reader).length, `${name}: reader`).toBeGreaterThan(0);
            expect(view(test, name, outsider), `${name}: outsider`).toEqual([]);
            expect(view(test, name, ghost()), `${name}: unmapped identity`).toEqual([]);
        }
        for (const [name] of personal) {
            expect(view(test, name, mod), `${name}: non-staff Moderator`).toEqual([]);
        }
        // A105(1): a Moderator who is not staff of the tournament reads its (running) lobbies like the organizer
        expect(view(test, 'view_my_tournament_lobbies', mod)).toEqual(view(test, 'view_my_tournament_lobbies', org));
        // a player is not staff: no tournament lobbies through the staff view
        expect(view(test, 'view_my_tournament_lobbies', f.ts[0].captain)).toEqual([]);
    });

    it('anonymous shared views emit no audit id columns, and view_lobby_browser no user-id column at all', () => {
        const test = newHarness();
        lobbyOf(test, 'a', { noStart: true, lobby: ANON });
        lobbyOf(test, 'p', { noStart: true });
        const rows = shared<LobbyBrowserRow>(test, 'view_lobby_browser');
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(Object.keys(row).filter((k) => USER_ID_KEY.test(k) || AUDIT_ID_KEYS.includes(k))).toEqual([]);
        }
        const f = duel({ isAnonymousDefault: true });
        for (const name of ['view_tournament_participants', 'view_tournament_teams', 'view_tournament_team_members', 'view_tournament_staff']) {
            const tRows = shared(f.test, name, { tournamentId: f.id });
            expect(tRows.length, name).toBeGreaterThan(0);
            for (const row of tRows) {
                expect(Object.keys(row).filter((k) => AUDIT_ID_KEYS.includes(k) || k === 'lastModifiedDate'), name).toEqual([]);
            }
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Anonymous lobby (isAnonymousPlayers; A37, D-69..D-71, R3 / R4)
// ════════════════════════════════════════════════════════════════════════════

describe('A37 anonymous lobby: view_my_lobby_members', () => {
    // Aligned in the T-S9a follow-up (orchestrator ruling; anonymous-play contract "Separate Player/Spectator Toggles",
    // S9a fix pass "Seat kind picks the toggle"): with only isAnonymousPlayers on, the spectator host is identified.
    it('the caller reads their own real id and name; teammates are identified; opponents read userId 0 and a join-order label; the spectator host is identified (isAnonymousSpectators off)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: ANON });
        for (const n of ['b1', 'b2', 'r1', 'r2']) {
            test.db.User.id.update({ ...test.db.User.id.find(s.a[n].userId)!, avatarCharacterName: `avatar-${n}`, displayedAchievementId: 7 });
        }
        const rows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.r1);
        expect(rows).toHaveLength(5);

        const own = rows.find((r) => r.userId === s.a.r1.userId)!;
        expect(own.label).toBe(displayName(test, s.a.r1));
        expect(own.avatarCharacterName).toBe('avatar-r1');
        const mate = rows.find((r) => r.userId === s.a.r2.userId)!;
        expect(mate.label).toBe(displayName(test, s.a.r2));
        expect(mate.displayedAchievementId).toBe(7);

        // opponents: T-S10h (A97): the seat label "Blue Player #<joinSeq>", never derived from the id or the name
        const blue1 = rowFor(rows, seatLabel(test, s.lobbyId, s.a.b1.userId));
        const blue2 = rowFor(rows, seatLabel(test, s.lobbyId, s.a.b2.userId));
        for (const [row, who] of [[blue1, s.a.b1], [blue2, s.a.b2]] as const) {
            expect(row.userId).toBe(0);
            expect(row.label).not.toContain(displayName(test, who));
            expect(row.avatarCharacterName).toBeUndefined();
            expect(row.displayedAchievementId).toBeUndefined();
        }
        expect(blue1.joinSeq).toBeLessThan(blue2.joinSeq);
        // the host is the spectator referee: a spectator follows isAnonymousSpectators (off here), so it is identified
        const hostRow = rows.find((r) => r.isHost)!;
        expect(hostRow.userId).toBe(s.host.userId);
        expect(hostRow.label).toBe(displayName(test, s.host));
        expect(hostRow.isReferee).toBe(true);
        expect(rows.filter((r) => /^Spectator #/.test(r.label))).toEqual([]);
        // no id of a hidden member anywhere in the caller's rows
        const hidden = [s.a.b1.userId, s.a.b2.userId];
        expect(rows.filter((r) => hidden.includes(r.userId))).toEqual([]);
    });

    it('the spectator referee (D-71) reads every real id; a plain spectator reads every player anonymized', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: ANON, seats: [...seatsOf(''), ['spec', 'Spectator']] });
        const refRows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.host);
        expect(refRows.every((r) => r.userId !== 0)).toBe(true);
        const specRows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.spec);
        const players = specRows.filter((r) => r.lobbySlot.tag === 'BluePlayer' || r.lobbySlot.tag === 'RedPlayer');
        expect(players).toHaveLength(4);
        expect(players.every((r) => r.userId === 0)).toBe(true);
        // T-S10h (A97): seat labels from the seat number
        expect(players.map((r) => r.label).sort())
            .toEqual([s.a.b1, s.a.b2, s.a.r1, s.a.r2].map((w) => seatLabel(test, s.lobbyId, w.userId)).sort());
    });

    it('a non-anonymous lobby shows real ids and display names to everyone', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const rows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.r1);
        for (const who of [s.host, s.a.b1, s.a.b2, s.a.r1, s.a.r2]) {
            const row = rows.find((r) => r.userId === who.userId);
            expect(row, who.sub).toBeDefined();
            expect(row!.label).toBe(displayName(test, who));
        }
    });

    it('S9a-V3: Alice (host, Blue) is masked for Bob (Red) in view_my_lobby; her seat keeps isHost with userId 0 and her seat label (A97)', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            lobby: ANON,
            hostSlot: 'BluePlayer',
            seats: [['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
            noStart: true,
        });
        const [bobLobby] = view<LobbyBinding>(test, 'view_my_lobby', s.a.r1);
        expect(bobLobby.hostUserId).toBe(0);
        expect(bobLobby.createdById).toBe(0);
        expect([s.host.userId, s.a.b2.userId]).not.toContain(bobLobby.lastModifiedById);
        const [aliceLobby] = view<LobbyBinding>(test, 'view_my_lobby', s.host);
        expect(aliceLobby.hostUserId).toBe(s.host.userId);
        const hostSeat = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.r1).find((r) => r.isHost)!;
        expect(hostSeat.userId).toBe(0);
        expect(hostSeat.label).toBe(seatLabel(test, s.lobbyId, s.host.userId)); // T-S10h (A97): "Blue Player #1"
        // a teammate of the host reads her real id
        expect(view<LobbyBinding>(test, 'view_my_lobby', s.a.b2)[0].hostUserId).toBe(s.host.userId);
    });
});

describe('A37 anonymous lobby: chat, steps, participants, result games', () => {
    it('view_my_lobby_chat: an opponent reads senderUserId 0 and the stored label; a teammate and the spectator referee read the real id', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: ANON });
        chat(test, s.a.b1, s.lobbyId, 'gl hf');
        const find = (who: Actor) => view<AnonymousChatRow>(test, 'view_my_lobby_chat', who).find((c) => c.content === 'gl hf')!;
        expect(find(s.a.r1).senderUserId).toBe(0);
        expect(find(s.a.r1).anonymousLabel).toBe(seatLabel(test, s.lobbyId, s.a.b1.userId)); // T-S10h (A97)
        expect(find(s.a.b2).senderUserId).toBe(s.a.b1.userId);
        expect(find(s.a.b2).anonymousLabel).toBeUndefined();
        expect(find(s.host).senderUserId).toBe(s.a.b1.userId);
    });

    it('S9a-A2: a Blue coach who wrote in chat and left stays hidden from Red (senderUserId 0, label stored at write time)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: ANON, seats: [...seatsOf(''), ['c1', 'BlueCoach']] });
        const coachLabel = seatLabel(test, s.lobbyId, s.a.c1.userId); // T-S10h (A97): "Blue Coach #<joinSeq>"
        chat(test, s.a.c1, s.lobbyId, 'coach says hi');
        leave(test, s.a.c1, s.lobbyId); // A68(5): a coach's leave deletes the row
        expect(member(test, s.lobbyId, s.a.c1.userId)).toBeUndefined();
        const row = view<AnonymousChatRow>(test, 'view_my_lobby_chat', s.a.r1).find((c) => c.content === 'coach says hi')!;
        expect(row.senderUserId).toBe(0);
        expect(row.anonymousLabel).toBe(coachLabel);
    });

    // Module finding (A37 leak): join_lobby / leave_lobby write System messages "<displayName> joined the lobby." /
    // "left the match." / "is back." (reducers/lobby/lobbyLifecycle.ts), and view_my_lobby_chat passes System content
    // through unmasked, so an opponent reads every anonymized player's display name in the chat.
    it('A37: in an anonymous lobby no chat message an opponent reads names an anonymized player (System join / leave / return messages included)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: ANON });
        leave(test, s.a.b2, s.lobbyId); // Drafting: away ("left the match.")
        tx(test, s.a.b2, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' })); // "is back."
        const contents = view<AnonymousChatRow>(test, 'view_my_lobby_chat', s.a.r1).map((c) => c.content);
        for (const who of [s.a.b1, s.a.b2]) {
            const name = displayName(test, who);
            expect(contents.filter((c) => c.includes(name)), `chat naming ${who.sub}`).toEqual([]);
        }
    });

    it('view_my_match_steps: Red reads every Blue / host actor as 0, Red actors with real ids; the spectator referee reads every id', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { lobby: ANON });
        const rows = view<AnonymousMatchStepRow>(test, 'view_my_match_steps', s.a.r1);
        expect(rows.length).toBeGreaterThan(0);
        const hidden = [s.a.b1.userId, s.a.b2.userId, s.host.userId];
        expect(rows.filter((r) => hidden.includes(r.actorUserId))).toEqual([]);
        const masked = rows.filter((r) => r.actorUserId === 0);
        const real = rows.filter((r) => r.actorUserId !== 0);
        expect(masked.length).toBeGreaterThan(0);
        expect(real.length).toBeGreaterThan(0);
        expect(real.every((r) => [s.a.r1.userId, s.a.r2.userId].includes(r.actorUserId))).toBe(true);
        expect(masked.every((r) => r.actorSlot.tag === 'Blue')).toBe(true);
        for (const r of rows) keysOf(r).forEach((k) => expect(COLS.step as readonly string[]).toContain(k));
        expect(view<AnonymousMatchStepRow>(test, 'view_my_match_steps', s.host).every((r) => r.actorUserId !== 0)).toBe(true);
    });

    // Module finding (not a leak; contract gap): the view emits the label stored on the step at write time, and the
    // draft writers (pick_character, ...) store none, so an anonymized actor reads `actorUserId 0` with no label,
    // where S9a-A1 / view comment 2 promise "actorUserId 0 + the stored label" (e.g. "Blue Player #2", A97).
    it('S9a-A1: an anonymized step actor carries a seat label (Blue Player #n, A97), never the display name', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { lobby: ANON });
        const masked = view<AnonymousMatchStepRow>(test, 'view_my_match_steps', s.a.r1).filter((r) => r.actorUserId === 0);
        expect(masked.length).toBeGreaterThan(0);
        for (const r of masked) {
            expect(r.anonymousLabel).toMatch(/^Blue (Player|Coach) #\d+$/); // T-S10h (A97)
        }
    });

    it('view_my_match_participants: Red reads Blue participants as 0 with their seat labels (A97); Red participants with real ids', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { lobby: ANON });
        const rows = view<AnonymousMatchParticipantRow>(test, 'view_my_match_participants', s.a.r1);
        expect(rows).toHaveLength(4);
        const blue = rows.filter((r) => r.teamSide.tag === 'Blue');
        const red = rows.filter((r) => r.teamSide.tag === 'Red');
        expect(blue.every((r) => r.userId === 0)).toBe(true);
        expect(blue.map((r) => r.anonymousLabel).sort())
            .toEqual([s.a.b1, s.a.b2].map((w) => seatLabel(test, s.lobbyId, w.userId)).sort()); // T-S10h (A97)
        expect(red.map((r) => r.userId).sort()).toEqual([s.a.r1.userId, s.a.r2.userId].sort());
        expect(red.every((r) => r.anonymousLabel === undefined)).toBe(true);
        // a Blue player reads its own team with real ids
        const fromBlue = view<AnonymousMatchParticipantRow>(test, 'view_my_match_participants', s.a.b1);
        expect(fromBlue.filter((r) => r.teamSide.tag === 'Blue').map((r) => r.userId).sort())
            .toEqual([s.a.b1.userId, s.a.b2.userId].sort());
    });

    it('view_my_match_result_games: an adjustment set and a game closed by the Blue host-referee read setById / closedById 0 for Red, real for Blue', () => {
        const test = newHarness();
        const s = scoringOf(test, '', {
            lobby: ANON,
            hostSlot: 'BluePlayer',
            seats: [['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
            beforeStart: makeRanked(test),
        });
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), value: H(2), reason: 'late' }));
        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]);
        closeGame(s, s.host);
        const [red] = view<MatchResultGameViewRow>(test, 'view_my_match_result_games', s.a.r1);
        expect(red.adjustments).toHaveLength(1);
        expect(red.adjustments[0].setById).toBe(0);
        expect(red.closedById).toBe(0);
        const [blue] = view<MatchResultGameViewRow>(test, 'view_my_match_result_games', s.a.b2);
        expect(blue.adjustments[0].setById).toBe(s.host.userId);
        expect(blue.closedById).toBe(s.host.userId);
        // view_my_lobby_members: the host's seat stays masked for Red after the close
        expect(view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.r1).find((r) => r.isHost)!.userId).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Ratings (A40)
// ════════════════════════════════════════════════════════════════════════════

describe('A40 ratings on member rows', () => {
    /** A Waiting lobby where b1 has one rated account, b2 two, r1 one; r2 none; an MMR row for b1 (MoC, pre-season). */
    function rated(lobby: Record<string, unknown>) {
        const test = newHarness();
        seedElo(test); // EloConfig.initialRating = 1000 for a mode never played (interpretation 12)
        // a verified host: D-23 forces ClosedNoRating on a guest host's lobby
        const s = setupLobby(test, { lobby, noStart: true, actors: { host: verified(test, 'host') } });
        expect(lobbyRow(test, s.lobbyId).rosterVisibility.tag).toBe(((lobby.rosterVisibility as any)?.tag) ?? 'OpenRoster');
        selectRatedAccount(test, s.lobbyId, s.a.b1, 'b1-acc', 1234);
        selectRatedAccount(test, s.lobbyId, s.a.b2, 'b2-acc1', 900);
        selectRatedAccount(test, s.lobbyId, s.a.b2, 'b2-acc2', 1100);
        selectRatedAccount(test, s.lobbyId, s.a.r1, 'r1-acc', 777);
        test.db.MmrRating.insert({
            userId: s.a.b1.userId, gameMode: { tag: 'MemoryOfChaos' }, rating: 1500, matchesPlayed: 3,
            globalCompositeRating: undefined, seasonId: 0, ...AUDIT(test),
        } as any);
        const rows = (who: Actor) => view<LobbyMemberViewRow>(test, 'view_my_lobby_members', who);
        return { test, s, rows };
    }

    it('mmrByMode on an identified seat when hideMmr is off: the active-season rating per mode, initialRating for a mode never played', () => {
        const { s, rows } = rated({});
        const b1 = rows(s.a.r1).find((r) => r.userId === s.a.b1.userId)!;
        expect(b1.mmrByMode).toEqual([1500, 1000, 1000]);
    });

    it('hideMmr = true: no seat carries mmrByMode (the caller\'s own included); the account rating stays', () => {
        const { test, s, rows } = rated({ hideMmr: true });
        const all = rows(s.a.b1);
        expect(all.every((r) => r.mmrByMode === undefined)).toBe(true);
        expect(all.find((r) => r.userId === s.a.b1.userId)!.accountRating).toBe(ratingOf(test, s.lobbyId, s.a.b1.userId));
    });

    it('OpenRoster: accountRating / accountCount on every seat (anonymized included) equal computeLobbyMemberRating and the selected-account count', () => {
        const { test, s, rows } = rated({ ...ANON, rosterVisibility: { tag: 'OpenRoster' } });
        const red = rows(s.a.r1);
        for (const [who, count] of [[s.a.b1, 1], [s.a.b2, 2]] as const) {
            const row = rowFor(red, seatLabel(test, s.lobbyId, who.userId)); // T-S10h (A97)
            expect(row.userId).toBe(0);
            expect(row.mmrByMode).toBeUndefined(); // anonymized: no MMR (A40)
            expect(row.accountRating).toBe(ratingOf(test, s.lobbyId, who.userId));
            expect(row.accountCount).toBe(count);
        }
        expect(rowFor(red, seatLabel(test, s.lobbyId, s.a.b1.userId)).accountRating).toBe(1234);
        const r2 = red.find((r) => r.userId === s.a.r2.userId)!;
        expect(r2.accountCount).toBe(0);
    });

    it('S9a-A3 / S9a-V5: ClosedWithRating shows the exact rating and count on an anonymized seat, without MMR, avatar or title', () => {
        const { test, s, rows } = rated({ ...ANON, rosterVisibility: { tag: 'ClosedWithRating' } });
        const blue1 = rowFor(rows(s.a.r1), seatLabel(test, s.lobbyId, s.a.b1.userId)); // T-S10h (A97)
        expect(blue1.userId).toBe(0);
        expect(blue1.accountRating).toBe(1234);
        expect(blue1.accountRating).toBe(ratingOf(test, s.lobbyId, s.a.b1.userId));
        expect(blue1.accountCount).toBe(1);
        expect(blue1.mmrByMode).toBeUndefined();
        expect(blue1.avatarCharacterName).toBeUndefined();
        expect(blue1.displayedAchievementId).toBeUndefined();
        // an identified teammate carries everything
        const mate = rows(s.a.r1).find((r) => r.userId === s.a.r2.userId)!;
        expect(mate.mmrByMode).toEqual([1000, 1000, 1000]);
        expect(mate.accountRating).toBeDefined();
    });

    it('ClosedNoRating: opponents carry no rating; the caller\'s own and a teammate\'s do; the spectator referee reads every rating (interpretation 7)', () => {
        const { test, s, rows } = rated({ rosterVisibility: { tag: 'ClosedNoRating' } });
        const red = rows(s.a.r1);
        for (const who of [s.a.b1, s.a.b2]) {
            const row = red.find((r) => r.userId === who.userId)!;
            expect(row.accountRating, who.sub).toBeUndefined();
            expect(row.accountCount, who.sub).toBeUndefined();
        }
        expect(red.find((r) => r.userId === s.a.r1.userId)!.accountRating).toBe(777);
        expect(red.find((r) => r.userId === s.a.r2.userId)!.accountRating).toBe(ratingOf(test, s.lobbyId, s.a.r2.userId));
        const ref = rows(s.host);
        expect(ref.find((r) => r.userId === s.a.b1.userId)!.accountRating).toBe(1234);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Presence (A68(10), A48)
// ════════════════════════════════════════════════════════════════════════════

describe('A68(10) / A48: view_my_lobby_members presence state', () => {
    it('S9a-V4: Online (connected), Online (membership offline, live presence row), Offline, Away after a live Leave, Gone after abandonCurrentMatch', () => {
        const test = newHarness();
        const s = setupLobby(test); // Drafting
        connect(test, s.a.b1);
        patchMember(test, s.lobbyId, s.a.b2.userId, { isOnline: false }); // the guest login left a live UserPresence row
        expect([...test.db.UserPresence.user_id.filter(s.a.b2.userId)].some((p) => p.isOnline)).toBe(true);
        disconnect(test, s.a.r1);
        leave(test, s.a.r2, s.lobbyId);
        expect([...test.db.UserPresence.user_id.filter(s.a.r2.userId)].some((p) => p.isOnline)).toBe(true);

        const presenceOf = (who: Actor) =>
            view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.b1).find((r) => r.userId === who.userId)!.presence.tag;
        expect(presenceOf(s.a.b1)).toBe('Online');
        expect(presenceOf(s.a.b2)).toBe('Online');
        expect(presenceOf(s.a.r1)).toBe('Offline');
        expect(presenceOf(s.a.r2)).toBe('Away');

        createCasual(test, s.a.r2, { abandonCurrentMatch: true });
        expect(presenceOf(s.a.r2)).toBe('Gone');
    });

    it('the member row has no isOnline / displayName / lastCursorAt / lastLineupAt / audit keys; memberKey = lobbyId << 32 | joinSeq', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const rows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.b1);
        for (const row of rows) {
            expect(keysOf(row)).toEqual([...COLS.member].sort());
            for (const k of ['isOnline', 'displayName', 'lastCursorAt', 'lastLineupAt', ...AUDIT_KEYS]) expect(k in row, k).toBe(false);
            expect(row.memberKey).toBe((BigInt(row.lobbyId) << 32n) | BigInt(row.joinSeq));
        }
        expect(new Set(rows.map((r) => r.memberKey)).size).toBe(rows.length);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_my_lobby / view_my_lobbies (PAGE-MAP D10; §A.4 P1; A68(4)(10))
// ════════════════════════════════════════════════════════════════════════════

describe('view_my_lobby / view_my_lobbies', () => {
    it('a member reads the full Lobby row (no password column) and the layer-0 row', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { isPublic: false, password: 'secret' }, seats: [], noStart: true });
        const [full] = view<LobbyBinding>(test, 'view_my_lobby', s.host);
        expectOnlyColumns(full, Object.keys(lobbyColumns));
        expect(Object.keys(full).filter((k) => /password/i.test(k))).toEqual([]);
        expect(full.id).toBe(s.lobbyId);
        expect(full.hostUserId).toBe(s.host.userId);
        const [small] = view<MyLobbyListRow>(test, 'view_my_lobbies', s.host);
        expect(keysOf(small)).toEqual([...COLS.myLobbies].sort());
        expect(small).toMatchObject({ id: s.lobbyId, joinCode: lobbyRow(test, s.lobbyId).joinCode, isAway: false });
        expect(small.stage.tag).toBe('Waiting');
    });

    it('S9a-V2: an away membership is listed (isAway = true) in both views; an abandoned one is dropped from both', () => {
        const test = newHarness();
        const s = setupLobby(test);
        leave(test, s.a.r1, s.lobbyId);
        expect(view<MyLobbyListRow>(test, 'view_my_lobbies', s.a.r1)).toEqual([expect.objectContaining({ id: s.lobbyId, isAway: true })]);
        expect(view<LobbyBinding>(test, 'view_my_lobby', s.a.r1).map((l) => l.id)).toEqual([s.lobbyId]);
        createCasual(test, s.a.r1, { abandonCurrentMatch: true });
        const fresh = hostedBy(test, s.a.r1)[0].id;
        expect(view<MyLobbyListRow>(test, 'view_my_lobbies', s.a.r1).map((l) => l.id)).toEqual([fresh]);
        expect(view<LobbyBinding>(test, 'view_my_lobby', s.a.r1).map((l) => l.id)).toEqual([fresh]);
    });

    it('a Waiting-stage spectator reads the lobby in both views', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: [['b1', 'BluePlayer'], ['spec', 'Spectator']], noStart: true });
        expect(view<LobbyBinding>(test, 'view_my_lobby', s.a.spec).map((l) => l.id)).toEqual([s.lobbyId]);
        expect(view<MyLobbyListRow>(test, 'view_my_lobbies', s.a.spec).map((l) => l.id)).toEqual([s.lobbyId]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_lobby_browser (S9a-V1; F17, D-A4, D-A8, A68(8); interpretation 2)
// ════════════════════════════════════════════════════════════════════════════

describe('view_lobby_browser (anonymous shared)', () => {
    function browserWorld() {
        const test = newHarness();
        const named = lobbyOf(test, 'n', { lobby: { name: 'Scrim', maxSpectators: 5 }, noStart: true,
            seats: [['nb1', 'BluePlayer'], ['nc', 'BlueCoach'], ['ns1', 'Spectator'], ['ns2', 'Spectator']] });
        const priv = lobbyOf(test, 'v', { lobby: { isPublic: false, password: 'secret' }, seats: [], noStart: true });
        // a spectator host is hidden only under isAnonymousSpectators (S9a fix pass; aligned in the T-S9a follow-up)
        const anon = lobbyOf(test, 'a', { lobby: { ...ANON, isAnonymousSpectators: true, name: 'Masked' }, seats: [], noStart: true });
        const empty = lobbyOf(test, 'e', { seats: [], noStart: true });
        const drafting = lobbyOf(test, 'd');
        // T-S10d (A91(2)): parked through a submitted Ranked game instead of a standalone Deferred defer.
        const parked = parkedLobby(test, { seats: seatsOf('k'), actors: { host: guest(test, 'khost') } });
        expect(lobbyRow(test, parked.lobbyId).stage.tag).toBe('AwaitingResult');
        const rows = shared<LobbyBrowserRow>(test, 'view_lobby_browser');
        const byId = (s: Lobby) => rows.find((r) => r.id === s.lobbyId);
        return { test, rows, byId, named, priv, anon, empty, drafting, parked };
    }

    it('a public Waiting lobby: its name, joinCode, the host\'s display name, coach / spectator counts and maxSpectators', () => {
        const { test, byId, named } = browserWorld();
        const row = byId(named)!;
        expect(row.name).toBe('Scrim');
        expect(row.joinCode).toBe(lobbyRow(test, named.lobbyId).joinCode);
        expect(row.hostLabel).toBe(displayName(test, named.host));
        expect(row.coachCount).toBe(1);
        expect(row.spectatorCount).toBe(3); // the host (exclusive spectator referee) + two spectators
        expect(row.maxSpectators).toBe(5);
        expect(row.currentPlayerCount).toBe(lobbyRow(test, named.lobbyId).currentPlayerCount);
        expect(row.stage.tag).toBe('Waiting');
    });

    it('interpretation 2: a private lobby is listed without a joinCode; its empty name reads "Private lobby" (never the code)', () => {
        const { test, byId, priv } = browserWorld();
        const row = byId(priv)!;
        expect(row.joinCode).toBeUndefined();
        expect(row.name).toBe('Private lobby');
        expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
            .not.toContain(lobbyRow(test, priv.lobbyId).joinCode);
        expect(row.isPublic).toBe(false);
    });

    it('D-A4: an anonymous lobby (players and spectators, spectator host) reads hostLabel "Anonymous host"; no row carries a user id or the host\'s name', () => {
        const { test, rows, byId, anon } = browserWorld();
        expect(byId(anon)!.hostLabel).toBe('Anonymous host');
        expect(JSON.stringify(byId(anon), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
            .not.toContain(displayName(test, anon.host));
        for (const row of rows) expect(Object.keys(row).filter((k) => USER_ID_KEY.test(k))).toEqual([]);
    });

    it('D-A8: a public lobby with an empty name reads "Lobby <joinCode>"', () => {
        const { test, byId, empty } = browserWorld();
        expect(byId(empty)!.name).toBe(`Lobby ${lobbyRow(test, empty.lobbyId).joinCode}`);
    });

    it('S8e-V2 / A68(8): a Drafting lobby is listed (spectators may join it); an AwaitingResult lobby is not', () => {
        const { byId, drafting, parked } = browserWorld();
        expect(byId(drafting)?.stage.tag).toBe('Drafting');
        expect(byId(parked)).toBeUndefined();
    });

    it('egress: the row carries exactly the documented columns, no series fields (A67(2))', () => {
        const { rows } = browserWorld();
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(keysOf(row)).toEqual([...COLS.browser].sort());
            for (const k of ['bestOf', 'bestOfNAdvantage', 'refereeControlsShelving']) expect(k in row).toBe(false);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_lobby_presets (S9a-V6; A33a; LobbyPreset private)
// ════════════════════════════════════════════════════════════════════════════

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

describe('view_lobby_presets', () => {
    it('the system preset plus the caller\'s own presets, without audit columns; another user\'s preset and a non-system SYSTEM preset are absent', () => {
        const test = newHarness();
        const alice = tournamentHost(test, 'alice');
        const bob = tournamentHost(test, 'bob');
        tx(test, alice, (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'alice-1' } as any));
        tx(test, alice, (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'alice-2' } as any));
        tx(test, bob, (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'bob-1' } as any));
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'system-owned, not the system preset' } as any));
        const rows = view<LobbyPresetViewRow>(test, 'view_lobby_presets', alice);
        expect(rows.filter((r) => r.isSystemPreset)).toHaveLength(1);
        expect(rows.filter((r) => !r.isSystemPreset).map((r) => r.name).sort()).toEqual(['alice-1', 'alice-2']);
        for (const row of rows) for (const k of AUDIT_KEYS) expect(k in row, k).toBe(false);
        expect(view<LobbyPresetViewRow>(test, 'view_lobby_presets', bob).map((r) => r.name)).not.toContain('alice-1');
    });

    it('LobbyPreset is private: the generated client bindings expose view_lobby_presets and no lobby_preset table (type-level)', () => {
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('lobbyPreset');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('lobby_preset');
        expectTypeOf<typeof bindingTables>().toHaveProperty('viewLobbyPresets');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_my_lobby_bans (S9a-V6; PAGE-MAP D4)
// ════════════════════════════════════════════════════════════════════════════

describe('view_my_lobby_bans', () => {
    function banned(lobby: Record<string, unknown> = {}, opts: SetupOpts = {}) {
        const test = newHarness();
        const s = setupLobby(test, { lobby, noStart: true, ...opts });
        const target = guest(test, 'target');
        tx(test, target, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, target.userId) }));
        return { test, s, target };
    }

    it('the host (the referee) reads the lobby\'s bans with the banned user\'s name; a plain member reads nothing', () => {
        const { test, s, target } = banned();
        const rows = view<LobbyBanViewRow>(test, 'view_my_lobby_bans', s.host);
        expect(rows).toHaveLength(1);
        expect(keysOf(rows[0])).toEqual([...COLS.ban].sort());
        expect(rows[0]).toMatchObject({ lobbyId: s.lobbyId, bannedUserId: target.userId, bannedByUserId: s.host.userId });
        expect(rows[0].label).toBe(displayName(test, target));
        expect(view(test, 'view_my_lobby_bans', s.a.b1)).toEqual([]);
    });

    it('a referee who is not the host reads the bans', () => {
        const { test, s } = banned();
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        expect(view(test, 'view_my_lobby_bans', s.a.r1)).toHaveLength(1);
    });

    it('anonymous lobby: a player referee does not read bannedByUserId of the host who banned', () => {
        const { test, s } = banned(ANON, { hostSlot: 'BluePlayer', seats: [['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        const [row] = view<LobbyBanViewRow>(test, 'view_my_lobby_bans', s.a.r1);
        expect(row.bannedByUserId).toBeUndefined();
    });

    // Module finding (A37 leak, contradicts interpretation 5): the banned user is no longer a member, so in an anonymous
    // lobby their id is withheld from anyone but a spectator referee everywhere else; view_my_lobby_bans emits the real
    // bannedUserId and resolveUserLabel's display name to a player referee. (unban_member takes the user id: a design
    // question for the user.)
    it('A37: anonymous lobby: a player referee reads neither the real id nor the display name of a banned (former) member', () => {
        const { test, s, target } = banned(ANON, { hostSlot: 'BluePlayer', seats: [['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        const [row] = view<LobbyBanViewRow>(test, 'view_my_lobby_bans', s.a.r1);
        expect(row.bannedUserId).toBe(0);
        expect(row.label).not.toBe(displayName(test, target));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Live match views (S9a-V7; PAGE-MAP D3; A56, A60, A63, A67(3); interpretation 1)
// ════════════════════════════════════════════════════════════════════════════

describe('live match views: view_my_match_session / view_my_lineups / view_my_match_result / view_my_match_result_games', () => {
    it('a member reads the rows of their own live lobby only (two lobbies in Scoring)', () => {
        const test = newHarness();
        const a = scoringOf(test, '');
        const b = scoringOf(test, 'Y');
        for (const s of [a, b]) { // the game row exists once a score is recorded
            recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(10)]);
            recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(20)]);
        }
        for (const name of ['view_my_match_session', 'view_my_lineups', 'view_my_match_result', 'view_my_match_result_games']) {
            const rows = view<{ lobbyId: number }>(test, name, a.a.b1);
            expect(rows.length, name).toBeGreaterThan(0);
            expect(rows.every((r) => r.lobbyId === a.lobbyId), name).toBe(true);
            expect(view<{ lobbyId: number }>(test, name, b.a.Yr1).every((r) => r.lobbyId === b.lobbyId), name).toBe(true);
        }
    });

    it('view_my_match_session: the session row without audit columns; nothing in Waiting', () => {
        const test = newHarness();
        const w = lobbyOf(test, 'w', { noStart: true });
        expect(view(test, 'view_my_match_session', w.a.wb1)).toEqual([]);
        const s = scoringOf(test, '');
        const [row] = view<MatchSessionViewRow>(test, 'view_my_match_session', s.a.r2);
        expect(row.lobbyId).toBe(s.lobbyId);
        expectOnlyColumns(row, COLS.session);
        for (const k of AUDIT_KEYS) expect(k in row, k).toBe(false);
    });

    it('interpretation 1: every member (players of both teams, the spectator) reads both teams\' lineups; Blue\'s confirmation shows on both rows', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { beforeStart: makeRanked(test) });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(20)]);
        confirmGame(s, captain(s, 'Blue'), 'Blue');
        for (const who of [s.a.b1, s.a.r1, s.host]) {
            const rows = view<MatchLineupViewRow>(test, 'view_my_lineups', who);
            expect(rows.map((r) => r.teamSide.tag).sort(), who.sub).toEqual(['Blue', 'Red']);
            for (const r of rows) {
                expect(keysOf(r)).toEqual([...COLS.lineup].sort());
                expect(r).toMatchObject({ blueConfirmed: true, redConfirmed: false, closedAt: undefined });
            }
        }
        const [game] = view<MatchResultGameViewRow>(test, 'view_my_match_result_games', s.a.r1);
        expect(game).toMatchObject({ blueConfirmed: true, redConfirmed: false, closedAt: undefined });
    });

    it('after the close (both ready, a captain submits): closedAt and both flags appear in view_my_lineups and view_my_match_result_games', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { beforeStart: makeRanked(test) });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(20)]);
        confirmBoth(s);
        closeGame(s, captain(s, 'Blue'));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        for (const r of view<MatchLineupViewRow>(test, 'view_my_lineups', s.a.r1)) {
            expect(r.blueConfirmed && r.redConfirmed).toBe(true);
            expect(r.closedAt).toBeDefined();
        }
        const [game] = view<MatchResultGameViewRow>(test, 'view_my_match_result_games', s.a.r1);
        expect(game.blueConfirmed && game.redConfirmed).toBe(true);
        expect(game.closedAt).toBeDefined();
        expect(game.winnerTeamSide.tag).toBe('Blue');
        const [result] = view<MatchResultViewRow>(test, 'view_my_match_result', s.a.r1);
        expect(result.status.tag).toBe('Submitted');
    });

    it('view_my_match_result_games nests the group scores and the adjustments of the lobby\'s one game', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { beforeStart: makeRanked(test) });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(11)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(21)]);
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), value: H(-1), reason: 'penalty' }));
        const rows = view<MatchResultGameViewRow>(test, 'view_my_match_result_games', s.a.b1);
        expect(rows).toHaveLength(1);
        const [game] = rows;
        expect(keysOf(game)).toEqual([...COLS.game].sort());
        expect(game.matchResultId).toBe(recordOf(test, s.lobbyId).id);
        expect(game.groupScores).toHaveLength(4);
        for (const g of game.groupScores) expect(keysOf(g)).toEqual([...COLS.groupScore].sort());
        const blueValues = game.groupScores.filter((g) => g.teamSide.tag === 'Blue').sort((x, y) => x.groupIndex - y.groupIndex).map((g) => g.value);
        expect(blueValues).toEqual([H(10), H(11)]);
        expect(game.adjustments).toHaveLength(1);
        expect(keysOf(game.adjustments[0])).toEqual([...COLS.adjustment].sort());
        expect(game.adjustments[0]).toMatchObject({ value: H(-1), reason: 'penalty', setById: s.host.userId });
        expect(game.adjustments[0].teamSide.tag).toBe('Red');
    });

    it('view_my_match_result: the documented columns, no referee id or refereeFullControl, no audit columns', () => {
        const test = newHarness();
        const s = scoringOf(test, '');
        const [row] = view<MatchResultViewRow>(test, 'view_my_match_result', s.a.b1);
        expect(keysOf(row)).toEqual([...COLS.result].sort());
        expect(row.status.tag).toBe('Pending');
        for (const k of ['refereeUserId', 'refereeFullControl', ...AUDIT_KEYS]) expect(k in row, k).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Replay set (S9a-V9; A37, A56(1))
// ════════════════════════════════════════════════════════════════════════════

describe('replay set: view_my_match_history_lineups (was view_my_match_lineup_history) and the removed public history views', () => {
    it('the archived lineups of a finalized casual match go to its participants only (T-S10n: per match, A115(3))', () => {
        const test = newHarness();
        const s = scoringOf(test, '');
        finishGame(s, 'Blue'); // Casual: the close validates and finalizes inline (A60(6))
        const history = [...test.db.MatchLineupHistory.iter()];
        expect(history).toHaveLength(2);
        const args = { matchHistoryId: onlyMatchOf(test, s.a.b1) };
        for (const who of [s.a.b1, s.a.r2]) {
            const rows = view<{ matchHistoryId: number; teamSide: { tag: string } }>(test, 'view_my_match_history_lineups', who, args);
            expect(rows.map((r) => r.teamSide.tag).sort(), who.sub).toEqual(['Blue', 'Red']);
        }
        expect(view(test, 'view_my_match_history_lineups', s.host, args)).toEqual([]); // the spectator host did not play
        expect(view(test, 'view_my_match_history_lineups', guest(test, 'outsider'), args)).toEqual([]);
    });

    it('view_match_history, view_match_participant_history and view_match_step_history are gone (module and bindings)', () => {
        expectTypeOf<typeof M>().not.toHaveProperty('view_match_history');
        expectTypeOf<typeof M>().not.toHaveProperty('view_match_participant_history');
        expectTypeOf<typeof M>().not.toHaveProperty('view_match_step_history');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('viewMatchHistory');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('viewMatchParticipantHistory');
        expectTypeOf<typeof bindingTables>().not.toHaveProperty('viewMatchStepHistory');
        for (const name of ['view_match_history', 'view_match_participant_history', 'view_match_step_history']) {
            expect(name in M, name).toBe(false);
        }
        expect('view_my_match_history_lineups' in M).toBe(true); // T-S10n (A115): the per-match replay lineups
    });
});

// ════════════════════════════════════════════════════════════════════════════
// view_admin_stuck_games (S9a-V8; A60(9), A63; interpretation 3)
// ════════════════════════════════════════════════════════════════════════════

describe('view_admin_stuck_games', () => {
    it('a Moderator reads a ranked Scoring lobby with one ready flag and a ranked open level-4 tie with both flags; a casual lobby and a closed game are absent', () => {
        const test = newHarness();
        const oneSided = scoringOf(test, 'A', { beforeStart: makeRanked(test) });
        recordScores(oneSided, captain(oneSided, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(oneSided, captain(oneSided, 'Red'), 'Red', [H(20), H(20)]);
        confirmGame(oneSided, captain(oneSided, 'Red'), 'Red');

        const tie = scoringOf(test, 'T', { beforeStart: makeRanked(test) });
        recordScores(tie, captain(tie, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(tie, captain(tie, 'Red'), 'Red', [H(5), H(5)]);
        confirmBoth(tie);

        const casual = scoringOf(test, 'C');
        recordScores(casual, captain(casual, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(casual, captain(casual, 'Red'), 'Red', [H(20), H(20)]);
        confirmGame(casual, captain(casual, 'Blue'), 'Blue');

        const both = scoringOf(test, 'B', { beforeStart: makeRanked(test) });
        recordScores(both, captain(both, 'Blue'), 'Blue', [H(10), H(10)]);
        recordScores(both, captain(both, 'Red'), 'Red', [H(20), H(20)]);
        confirmBoth(both); // both ready, no tie: waiting for the submit click, not stuck

        const closed = scoringOf(test, 'X', { beforeStart: makeRanked(test) });
        finishGame(closed, 'Red');

        const rows = view<StuckGameRow>(test, 'view_admin_stuck_games', moderator(test));
        expect(rows.map((r) => r.lobbyId).sort((x, y) => x - y)).toEqual([oneSided.lobbyId, tie.lobbyId].sort((x, y) => x - y));
        const one = rows.find((r) => r.lobbyId === oneSided.lobbyId)!;
        expect(keysOf(one)).toEqual([...COLS.stuck].sort());
        expect(one).toMatchObject({ joinCode: lobbyRow(test, oneSided.lobbyId).joinCode, blueConfirmed: false, redConfirmed: true, isTie: false });
        expect(one.stage.tag).toBe('Scoring');
        const gameRow = [...test.db.MatchResultGame.match_result_id.filter(recordOf(test, oneSided.lobbyId).id)][0];
        expect(one.sinceAt.microsSinceUnixEpoch).toBe(gameRow.lastModifiedDate.microsSinceUnixEpoch);
        expect(rows.find((r) => r.lobbyId === tie.lobbyId)).toMatchObject({ blueConfirmed: true, redConfirmed: true, isTie: true });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Tournament arg views (S9a-V10; A37, A26a(2), §A.4 P3; interpretation 9)
// ════════════════════════════════════════════════════════════════════════════

describe('tournament arg views', () => {
    /**
     * A Registration-stage tournament: p1 (alias "Masked" when anonymous) and p2 form team Alpha; p3 is disqualified;
     * p4 enrolls last. One second between enrollments, so the seat order is the enrollment order. An assistant with
     * the results flag.
     */
    function cup(isAnonymousDefault: boolean) {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault });
        const p = [1, 2, 3, 4].map((i) => verified(test, `p${i}`));
        p.forEach((who, i) => {
            advance(test, 1_000);
            const opts: RegisterOpts = isAnonymousDefault && i === 0 ? { anonymousAlias: 'Masked' } : {};
            register(test, who, id, opts);
        });
        const teamId = makeTeam(test, id, p[0], [p[1]], 'Alpha');
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: p[2].userId, reason: 'no-show' }));
        const asst = verified(test, 'asst');
        assignAssistant(test, org, id, asst, { results: true });
        return { test, org, id, p, teamId, asst };
    }

    it('non-anonymous: participants (DQ hidden), team captain, team members and staff carry real ids and display names', () => {
        const { test, org, id, p, teamId, asst } = cup(false);
        const parts = shared<TournamentParticipantRow>(test, 'view_tournament_participants', { tournamentId: id });
        expect(parts.map((r) => r.userId).sort()).toEqual([p[0].userId, p[1].userId, p[3].userId].sort());
        for (const r of parts) {
            expect(keysOf(r)).toEqual([...COLS.tParticipant].sort());
            expect(r.label).toBe(test.db.User.id.find(r.userId)!.displayName);
        }
        expect(parts.find((r) => r.userId === p[0].userId)!.teamId).toBe(teamId);
        const [team] = shared<TournamentTeamPublicRow>(test, 'view_tournament_teams', { tournamentId: id });
        expect(keysOf(team)).toEqual([...COLS.tTeam].sort());
        expect(team).toMatchObject({ id: teamId, name: 'Alpha', captainUserId: p[0].userId });
        const members = shared<TournamentTeamMemberPublicRow>(test, 'view_tournament_team_members', { tournamentId: id });
        expect(members.map((r) => r.userId).sort()).toEqual([p[0].userId, p[1].userId].sort());
        for (const r of members) expect(keysOf(r)).toEqual([...COLS.tTeamMember].sort());
        const staff = shared<TournamentStaffRow>(test, 'view_tournament_staff', { tournamentId: id });
        expect(staff.map((r) => r.userId).sort()).toEqual([org.userId, asst.userId].sort());
        for (const r of staff) expect(keysOf(r)).toEqual([...COLS.tStaff].sort());
    });

    it('A26a(2) / A37 / interpretation 9: anonymous: DQ row hidden, userId 0, alias or Seat-<n> by enrollment order (the DQ row keeps its seat)', () => {
        const { test, id, p } = cup(true);
        const parts = shared<TournamentParticipantRow>(test, 'view_tournament_participants', { tournamentId: id });
        expect(parts).toHaveLength(3);
        expect(parts.every((r) => r.userId === 0)).toBe(true);
        expect(parts.map((r) => r.label).sort()).toEqual(['Masked', 'Seat-2', 'Seat-4']);
        expect(parts.map((r) => r.seat).sort()).toEqual([1, 2, 4]);
        for (const r of parts) {
            for (const who of p) expect(r.label).not.toContain(displayName(test, who));
        }
    });

    it('anonymous: teams carry no captainUserId; team members carry userId 0 and the alias / seat label', () => {
        const { test, id } = cup(true);
        const [team] = shared<TournamentTeamPublicRow>(test, 'view_tournament_teams', { tournamentId: id });
        expect(team.captainUserId).toBeUndefined();
        const members = shared<TournamentTeamMemberPublicRow>(test, 'view_tournament_team_members', { tournamentId: id });
        expect(members.every((r) => r.userId === 0)).toBe(true);
        expect(members.map((r) => r.label).sort()).toEqual(['Masked', 'Seat-2']);
    });

    it('anonymous: staff are identified always (organizer + assistant with their flags)', () => {
        const { test, org, id, asst } = cup(true);
        const staff = shared<TournamentStaffRow>(test, 'view_tournament_staff', { tournamentId: id });
        expect(staff.find((r) => r.isOrganizer)).toMatchObject({ userId: org.userId, label: displayName(test, org) });
        expect(staff.find((r) => !r.isOrganizer)).toMatchObject({
            userId: asst.userId, canResolveResults: true, canManageBracket: false, canManageParticipants: false,
        });
    });

    it('a wrong tournamentId reads [] from all four arg views', () => {
        const { test, id } = cup(false);
        for (const name of ['view_tournament_participants', 'view_tournament_teams', 'view_tournament_team_members', 'view_tournament_staff']) {
            expect(shared(test, name, { tournamentId: id + 999 }), name).toEqual([]);
        }
    });

    // Module finding (A37 leak, a kept view re-checked in S9a): view_tournament_registrant_accounts emits every other
    // enrolled player's real userId to an enrolled player, whatever Tournament.isAnonymousDefault says.
    it('A37: anonymous tournament: an enrolled player reads no other participant\'s real id in view_tournament_registrant_accounts', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault: true, rosterVisibility: 'OpenRoster' });
        const a = verified(test, 'pa');
        const b = verified(test, 'pb');
        insertHsrAccount(test, a.userId, 'uid-a');
        insertHsrAccount(test, b.userId, 'uid-b');
        register(test, a, id);
        register(test, b, id);
        const rows = view<{ userId: number }>(test, 'view_tournament_registrant_accounts', a);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter((r) => r.userId === b.userId)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Per-sender tournament views (S9a-V11; PAGE-MAP D9; A70(1), A71; interpretations 10, 11)
// ════════════════════════════════════════════════════════════════════════════

describe('per-sender tournament views', () => {
    it('view_my_tournament_enrollment: the caller\'s own rows only, across tournaments', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const t1 = openTournament(test, org, { name: 'One' });
        const t2 = openTournament(test, org, { name: 'Two' });
        const me = verified(test, 'me');
        const other = verified(test, 'other');
        register(test, me, t1);
        register(test, me, t2);
        register(test, other, t1);
        const rows = view<{ userId: number; tournamentId: number }>(test, 'view_my_tournament_enrollment', me);
        expect(rows.map((r) => r.tournamentId).sort()).toEqual([t1, t2].sort());
        expect(rows.every((r) => r.userId === me.userId)).toBe(true);
        expect(view(test, 'view_my_tournament_enrollment', org)).toEqual([]);
    });

    it('view_my_team_requests: the requester reads their own request (isMine); the captain reads requests to their team with the requester\'s id (interpretation 10); a third player reads nothing', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org);
        const [cap, asker, third] = ['cap', 'asker', 'third'].map((n) => verified(test, n));
        for (const who of [cap, asker, third]) register(test, who, id);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'Forming' }));
        const teamId = [...test.db.TournamentTeam.tournament_id.filter(id)][0].id;
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));

        const capRows = view<TeamRequestViewRow>(test, 'view_my_team_requests', cap);
        expect(capRows).toHaveLength(1);
        expect(keysOf(capRows[0])).toEqual([...COLS.teamRequest].sort());
        expect(capRows[0]).toMatchObject({ teamId, teamName: 'Forming', userId: asker.userId, isMine: false, label: displayName(test, asker) });
        const askerRows = view<TeamRequestViewRow>(test, 'view_my_team_requests', asker);
        expect(askerRows).toEqual([expect.objectContaining({ teamId, userId: asker.userId, isMine: true })]);
        expect(view(test, 'view_my_team_requests', third)).toEqual([]);
    });

    // T-S9c: S9a's seat label is superseded by A73(1): the captain reads the requester's real display name in every tournament.
    it('view_my_team_requests in an anonymous tournament: the captain reads the display name of the requester (A73(1), was the seat label)', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault: true });
        const [cap, asker] = ['cap', 'asker'].map((n) => verified(test, n));
        register(test, cap, id);
        advance(test, 1_000);
        register(test, asker, id);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'Forming' }));
        const teamId = [...test.db.TournamentTeam.tournament_id.filter(id)][0].id;
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));
        const [row] = view<TeamRequestViewRow>(test, 'view_my_team_requests', cap);
        expect(row.label).toBe(displayName(test, asker));
        expect(row.userId).toBe(asker.userId);
    });

    it('view_my_stand_ins: the stand-in and their team read the row; the opponents do not (interpretation 11)', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const { blue, red } = sidesOf(f, m.id);
        const sub = verified(test, 'sub');
        tx(test, org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId }));
        const [own] = view<StandInViewRow>(test, 'view_my_stand_ins', sub);
        expect(keysOf(own)).toEqual([...COLS.standIn].sort());
        expect(own).toMatchObject({ bracketMatchId: m.id, teamId: m.team1Id, userId: sub.userId, label: displayName(test, sub) });
        expect('approvedByUserId' in own).toBe(false);
        expect(view<StandInViewRow>(test, 'view_my_stand_ins', blue.captain).map((r) => r.userId)).toEqual([sub.userId]);
        expect(view<StandInViewRow>(test, 'view_my_stand_ins', blue.mate).map((r) => r.userId)).toEqual([sub.userId]);
        expect(view(test, 'view_my_stand_ins', red.captain)).toEqual([]);
    });

    it('view_tournament_matches_for_me: the Ready match of my team with the opponent\'s name and colours; after set_match_sides the colours follow; the tally stays team-based (A71)', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const { blue, red } = sidesOf(f, m.id);
        const [mine] = view<MatchForMeRow>(test, 'view_tournament_matches_for_me', blue.captain);
        expect(keysOf(mine)).toEqual([...COLS.matchForMe].sort());
        expect(mine).toMatchObject({
            bracketMatchId: m.id, tournamentId: f.id, myTeamId: blue.teamId, opponentTeamId: red.teamId,
            opponentTeamName: test.db.TournamentTeam.id.find(red.teamId)!.name, blueTeamId: m.team1Id, redTeamId: m.team2Id,
        });
        expect(mine.state.tag).toBe('Ready');
        const [theirs] = view<MatchForMeRow>(test, 'view_tournament_matches_for_me', red.mate);
        expect(theirs).toMatchObject({ myTeamId: red.teamId, opponentTeamId: blue.teamId });

        tx(test, org, (ctx) => M.set_match_sides(ctx, { bracketMatchId: m.id, blueTeamId: m.team2Id! }));
        const [after] = view<MatchForMeRow>(test, 'view_tournament_matches_for_me', blue.captain);
        expect(after).toMatchObject({ blueTeamId: m.team2Id, redTeamId: m.team1Id });
        expect(after.team1Games).toBe(matchRow(test, m.id).team1Games);
        expect(after.team2Games).toBe(matchRow(test, m.id).team2Games);
    });

    it('view_tournament_matches_for_me: a decided match is not listed', () => {
        const f = duel();
        const m = [...f.test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const { blue } = sidesOf(f, m.id);
        playMatch(f, m.id, 'Blue');
        expect(matchRow(f.test, m.id).state.tag).not.toBe('Ready');
        expect(view(f.test, 'view_tournament_matches_for_me', blue.captain)).toEqual([]);
    });

    it('view_my_tournament_lobbies: staff read each lobby with its match\'s blue / red team ids (A70(1)), following set_match_sides', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        tx(test, org, (ctx) => M.set_match_sides(ctx, { bracketMatchId: m.id, blueTeamId: m.team2Id! }));
        const s = openMatchLobby(f, m.id, { noStart: true });
        const rows = view<TournamentLobbyRow>(test, 'view_my_tournament_lobbies', org);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: s.lobbyId, blueTeamId: m.team2Id, redTeamId: m.team1Id });
    });

    it('view_my_tournament_match_results: rows of a played match carry no refereeFullControl (runtime and type-level)', () => {
        const f = duel();
        const m = [...f.test.db.BracketMatch.tournament_id.filter(f.id)][0];
        playMatch(f, m.id, 'Red');
        const rows = view<MatchResultRecordBinding>(f.test, 'view_my_tournament_match_results', f.org);
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect('refereeFullControl' in r).toBe(false);
        expectTypeOf<MatchResultRecordBinding>().not.toHaveProperty('refereeFullControl');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Egress smoke: the generated row types equal the documented column lists (type-level, checked by npm run typecheck)
// ════════════════════════════════════════════════════════════════════════════

describe('egress smoke (type-level)', () => {
    it('each new or reshaped S9a row type has exactly the documented columns', () => {
        expectTypeOf<keyof LobbyBrowserRow>().toEqualTypeOf<Cols<'browser'>>();
        expectTypeOf<keyof MyLobbyListRow>().toEqualTypeOf<Cols<'myLobbies'>>();
        expectTypeOf<keyof LobbyMemberViewRow>().toEqualTypeOf<Cols<'member'>>();
        expectTypeOf<keyof LobbyBanViewRow>().toEqualTypeOf<Cols<'ban'>>();
        expectTypeOf<keyof AnonymousChatRow>().toEqualTypeOf<Cols<'chat'>>();
        expectTypeOf<keyof MatchSessionViewRow>().toEqualTypeOf<Cols<'session'>>();
        expectTypeOf<keyof AnonymousMatchStepRow>().toEqualTypeOf<Cols<'step'>>();
        expectTypeOf<keyof AnonymousMatchParticipantRow>().toEqualTypeOf<Cols<'participant'>>();
        expectTypeOf<keyof MatchLineupViewRow>().toEqualTypeOf<Cols<'lineup'>>();
        expectTypeOf<keyof MatchResultViewRow>().toEqualTypeOf<Cols<'result'>>();
        expectTypeOf<keyof MatchResultGameViewRow>().toEqualTypeOf<Cols<'game'>>();
        expectTypeOf<keyof GroupScoreItem>().toEqualTypeOf<Cols<'groupScore'>>();
        expectTypeOf<keyof AdjustmentItem>().toEqualTypeOf<Cols<'adjustment'>>();
        expectTypeOf<keyof StuckGameRow>().toEqualTypeOf<Cols<'stuck'>>();
        expectTypeOf<keyof TournamentParticipantRow>().toEqualTypeOf<Cols<'tParticipant'>>();
        expectTypeOf<keyof TournamentTeamPublicRow>().toEqualTypeOf<Cols<'tTeam'>>();
        expectTypeOf<keyof TournamentTeamMemberPublicRow>().toEqualTypeOf<Cols<'tTeamMember'>>();
        expectTypeOf<keyof TournamentStaffRow>().toEqualTypeOf<Cols<'tStaff'>>();
        expectTypeOf<keyof TeamRequestViewRow>().toEqualTypeOf<Cols<'teamRequest'>>();
        expectTypeOf<keyof StandInViewRow>().toEqualTypeOf<Cols<'standIn'>>();
        expectTypeOf<keyof MatchForMeRow>().toEqualTypeOf<Cols<'matchForMe'>>();
        // T-S9a follow-up: the fix pass added `seat` to the registrant row; the browser, view_my_lobby and the staff
        // row kept their columns (review #6, #7, #12 skipped), so their key sets above stand
        expectTypeOf<keyof TournamentRegistrantAccountRow>().toEqualTypeOf<Cols<'registrant'>>();
        // view_my_lobby emits the Lobby row type; no secret column exists on it (the hash is in LobbyPassword)
        expectTypeOf<LobbyBinding>().not.toHaveProperty('passwordHash');
        expectTypeOf<LobbyBinding>().not.toHaveProperty('password');
        // view_my_tournament_lobbies: the Lobby columns plus the colours
        expectTypeOf<TournamentLobbyRow>().toHaveProperty('blueTeamId');
        expectTypeOf<TournamentLobbyRow>().toHaveProperty('redTeamId');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// T-S9a follow-up: the S9a fix pass (A37, D-07, D-70, D-71; anonymous-play contract "S9a fix pass", S9a-A4 / S9a-A5)
// ════════════════════════════════════════════════════════════════════════════

const SPEC_ANON = { isAnonymousSpectators: true };

/** The member-event System message about `subjectUserId` (ChatMessage is private: read in memory for its row id only). */
function memberEventRow(test: Harness, lobbyId: number, event: string, subjectUserId: number) {
    const row = [...test.db.ChatMessage.lobby_id.filter(lobbyId)].find((m) => {
        if (m.senderType.tag !== 'System' || !m.metadata) return false;
        try {
            const p = JSON.parse(m.metadata);
            return p.event === event && p.subjectUserId === subjectUserId;
        } catch {
            return false;
        }
    });
    expect(row, `${event} line about ${subjectUserId}`).toBeDefined();
    return row!;
}
const chatRowById = (test: Harness, who: Reader, id: number) =>
    view<AnonymousChatRow>(test, 'view_my_lobby_chat', who).find((c) => c.id === id)!;

describe('D-07 / A37: isAnonymousSpectators is its own toggle (review #1)', () => {
    /** A Waiting lobby: the spectator host (referee), b1 b2 r1 r2 seated, then two spectators s1, s2. */
    function specWorld(lobby: Record<string, unknown>) {
        const test = newHarness();
        const s = setupLobby(test, { lobby, noStart: true, seats: [...seatsOf(''), ['s1', 'Spectator'], ['s2', 'Spectator']] });
        return { test, s };
    }
    const spectatorIds = (s: Lobby) => [s.host.userId, s.a.s1.userId, s.a.s2.userId];

    it('S9a-A4: spectators anonymous, players not: a player reads every spectator (the host included) as userId 0 with a Spectator #n label (A97); every player is identified', () => {
        const { test, s } = specWorld(SPEC_ANON);
        const rows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.b1);
        expect(rows).toHaveLength(7);
        const specs = rows.filter((r) => r.lobbySlot.tag === 'Spectator');
        expect(specs).toHaveLength(3);
        expect(specs.every((r) => r.userId === 0)).toBe(true);
        // T-S10h (A97): "Spectator #<joinSeq>"
        expect(specs.map((r) => r.label).sort())
            .toEqual(spectatorIds(s).map((id) => seatLabel(test, s.lobbyId, id)).sort());
        for (const r of specs) {
            expect(r.avatarCharacterName).toBeUndefined();
            expect(r.displayedAchievementId).toBeUndefined();
            expect(r.mmrByMode).toBeUndefined();
        }
        expect(specs.find((r) => r.isHost)!.label).toBe(seatLabel(test, s.lobbyId, s.host.userId)); // "Spectator #1"
        for (const who of [s.a.b1, s.a.b2, s.a.r1, s.a.r2]) {
            expect(rows.find((r) => r.userId === who.userId)?.label, who.sub).toBe(displayName(test, who));
        }
        expect(rows.filter((r) => spectatorIds(s).includes(r.userId))).toEqual([]);
    });

    it('S9a-A4: spectators anonymous, players not: view_my_lobby_chat hides a spectator sender and names no spectator in a System line; players stay identified', () => {
        const { test, s } = specWorld(SPEC_ANON);
        chat(test, s.a.s1, s.lobbyId, 'spec says hi');
        chat(test, s.a.r1, s.lobbyId, 'red says hi');
        const rows = view<AnonymousChatRow>(test, 'view_my_lobby_chat', s.a.b1);
        const spec = rows.find((c) => c.content === 'spec says hi')!;
        expect(spec.senderUserId).toBe(0);
        expect(spec.anonymousLabel).toBe(seatLabel(test, s.lobbyId, s.a.s1.userId)); // T-S10h (A97)
        const red = rows.find((c) => c.content === 'red says hi')!;
        expect(red.senderUserId).toBe(s.a.r1.userId);
        expect(red.anonymousLabel).toBeUndefined();

        const joined = chatRowById(test, s.a.b1, memberEventRow(test, s.lobbyId, 'joined', s.a.s1.userId).id);
        expect(joined.content).toBe(`${seatLabel(test, s.lobbyId, s.a.s1.userId)} joined the lobby.`);
        expect(JSON.parse(joined.metadata!)).toEqual({ event: 'joined', subjectUserId: 0 });
        const redJoined = chatRowById(test, s.a.b1, memberEventRow(test, s.lobbyId, 'joined', s.a.r1.userId).id);
        expect(redJoined.content).toBe(`${displayName(test, s.a.r1)} joined the lobby.`);

        for (const who of [s.host, s.a.s1, s.a.s2]) {
            expect(rows.filter((c) => c.content.includes(displayName(test, who))), who.sub).toEqual([]);
        }
        expect(rows.filter((c) => spectatorIds(s).includes(c.senderUserId))).toEqual([]);
    });

    it('the reverse (players anonymous, spectators not): a Red player reads the Blue players as 0 and every spectator with the real id and name, in members and chat', () => {
        const { test, s } = specWorld(ANON);
        const rows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.r1);
        expect(rows.filter((r) => r.lobbySlot.tag === 'BluePlayer').map((r) => [r.userId, r.label]).sort())
            .toEqual([s.a.b1, s.a.b2].map((w) => [0, seatLabel(test, s.lobbyId, w.userId)]).sort()); // T-S10h (A97)
        for (const who of [s.host, s.a.s1, s.a.s2]) {
            expect(rows.find((r) => r.userId === who.userId)?.label, who.sub).toBe(displayName(test, who));
        }
        chat(test, s.a.s1, s.lobbyId, 'spec says hi');
        const spec = view<AnonymousChatRow>(test, 'view_my_lobby_chat', s.a.r1).find((c) => c.content === 'spec says hi')!;
        expect(spec.senderUserId).toBe(s.a.s1.userId);
        expect(spec.anonymousLabel).toBeUndefined();
        const joined = chatRowById(test, s.a.r1, memberEventRow(test, s.lobbyId, 'joined', s.a.s1.userId).id);
        expect(joined.content).toBe(`${displayName(test, s.a.s1)} joined the lobby.`);
    });

    it('D-71: under isAnonymousSpectators the spectator referee reads every real id (members, chat sender, System lines); a plain spectator reads the other spectators hidden and the players identified', () => {
        const { test, s } = specWorld(SPEC_ANON);
        chat(test, s.a.s2, s.lobbyId, 'from s2');
        expect(view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.host).every((r) => r.userId !== 0)).toBe(true);
        const refChat = view<AnonymousChatRow>(test, 'view_my_lobby_chat', s.host);
        expect(refChat.find((c) => c.content === 'from s2')!.senderUserId).toBe(s.a.s2.userId);
        expect(chatRowById(test, s.host, memberEventRow(test, s.lobbyId, 'joined', s.a.s1.userId).id).content)
            .toBe(`${displayName(test, s.a.s1)} joined the lobby.`);

        const s1Rows = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.s1);
        expect(s1Rows.find((r) => r.userId === s.a.s1.userId)!.label).toBe(displayName(test, s.a.s1));
        expect(s1Rows.filter((r) => r.lobbySlot.tag === 'Spectator' && r.userId !== s.a.s1.userId).every((r) => r.userId === 0)).toBe(true);
        expect(s1Rows.filter((r) => r.lobbySlot.tag === 'BluePlayer' || r.lobbySlot.tag === 'RedPlayer').every((r) => r.userId !== 0)).toBe(true);
    });

    it('view_lobby_browser: the host label follows the host\'s own seat kind (spectator host + isAnonymousSpectators: "Anonymous host"; players-only: the spectator host\'s name; a player host follows isAnonymousPlayers)', () => {
        const test = newHarness();
        const specHost = lobbyOf(test, 'x', { lobby: SPEC_ANON, seats: [], noStart: true });
        const playersOnly = lobbyOf(test, 'y', { lobby: ANON, seats: [], noStart: true });
        const playerHostSpecAnon = lobbyOf(test, 'z', { lobby: SPEC_ANON, hostSlot: 'BluePlayer', seats: [], noStart: true });
        const playerHostAnon = lobbyOf(test, 'w', { lobby: ANON, hostSlot: 'BluePlayer', seats: [], noStart: true });
        const rows = shared<LobbyBrowserRow>(test, 'view_lobby_browser');
        const label = (l: Lobby) => rows.find((r) => r.id === l.lobbyId)!.hostLabel;
        expect(label(specHost)).toBe('Anonymous host');
        expect(label(playersOnly)).toBe(displayName(test, playersOnly.host));
        expect(label(playerHostSpecAnon)).toBe(displayName(test, playerHostSpecAnon.host));
        expect(label(playerHostAnon)).toBe('Anonymous host');
    });
});

describe('S9a fix: member-event System lines rendered per reader (A37, D-70, D-71; S9a-A5)', () => {
    it('"joined" about Blue player P: P, a teammate and the spectator referee read P\'s name and real subject id; an opponent reads "<seat label> joined the lobby." (A97) with subjectUserId 0', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: ANON, noStart: true });
        const raw = memberEventRow(test, s.lobbyId, 'joined', s.a.b1.userId);
        const named = `${displayName(test, s.a.b1)} joined the lobby.`;
        for (const who of [s.a.b1, s.a.b2, s.host]) {
            const row = chatRowById(test, who, raw.id);
            expect(row.content, who.sub).toBe(named);
            expect(JSON.parse(row.metadata!), who.sub).toEqual({ event: 'joined', subjectUserId: s.a.b1.userId });
            expect(row.senderType.tag).toBe('System');
            expect(row.senderUserId).toBe(0);
        }
        const opp = chatRowById(test, s.a.r1, raw.id);
        expect(keysOf(opp)).toEqual([...COLS.chat].sort());
        // T-S10h (A97; S10h review F6): the label stored when the line was written. P joined as a spectator and then took
        // the Blue seat, so the line keeps "Spectator #<seat>"; the seat number still ties it to P's current label.
        const seat = seatOf(test, s.lobbyId, s.a.b1.userId);
        expect(seatLabel(test, s.lobbyId, s.a.b1.userId)).toBe(`Blue Player #${seat}`);
        expect(opp.content).toBe(`Spectator #${seat} joined the lobby.`);
        expect(opp.content).not.toContain(displayName(test, s.a.b1));
        expect(JSON.parse(opp.metadata!)).toEqual({ event: 'joined', subjectUserId: 0 });
    });

    it('away / back: Red reads "<seat label> left the match." and "<seat label> is back." (A97); Blue-2\'s teammate reads the name', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: ANON }); // Drafting: a leave is an away
        leave(test, s.a.b2, s.lobbyId);
        tx(test, s.a.b2, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        const away = memberEventRow(test, s.lobbyId, 'away', s.a.b2.userId);
        const back = memberEventRow(test, s.lobbyId, 'back', s.a.b2.userId);
        const b2Label = seatLabel(test, s.lobbyId, s.a.b2.userId); // T-S10h (A97): the seat survives the away / back
        expect(chatRowById(test, s.a.r1, away.id).content).toBe(`${b2Label} left the match.`);
        expect(chatRowById(test, s.a.r1, back.id).content).toBe(`${b2Label} is back.`);
        expect(chatRowById(test, s.a.b1, away.id).content).toBe(`${displayName(test, s.a.b2)} left the match.`);
        expect(chatRowById(test, s.a.b1, back.id).content).toBe(`${displayName(test, s.a.b2)} is back.`);
    });

    it('kick: a kicked Blue player (no longer a member) reads "<seat label> was kicked from the lobby." (A97) for Red, with subjectUserId 0; the spectator referee reads the name', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: ANON, noStart: true });
        const b2Label = seatLabel(test, s.lobbyId, s.a.b2.userId); // T-S10h (A97): captured before the row goes
        tx(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b2.userId) }));
        const raw = memberEventRow(test, s.lobbyId, 'kicked', s.a.b2.userId);
        const opp = chatRowById(test, s.a.r1, raw.id);
        expect(opp.content).toBe(`${b2Label} was kicked from the lobby.`);
        expect(JSON.parse(opp.metadata!).subjectUserId).toBe(0);
        expect(chatRowById(test, s.host, raw.id).content).toBe(`${displayName(test, s.a.b2)} was kicked from the lobby.`);
    });

    it('ban: a banned former member is never named to a player; the line carries a seat label and subjectUserId 0', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: ANON, noStart: true });
        const target = guest(test, 'target');
        tx(test, target, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        const targetLabel = seatLabel(test, s.lobbyId, target.userId); // T-S10h (A97): "Spectator #<joinSeq>"
        tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, target.userId) }));
        const raw = memberEventRow(test, s.lobbyId, 'banned', target.userId);
        const opp = chatRowById(test, s.a.r1, raw.id);
        expect(opp.content).toMatch(/^Spectator #\d+ was banned from the lobby\.$/); // T-S10h (A97)
        expect(opp.content).toBe(`${targetLabel} was banned from the lobby.`);
        expect(opp.content).not.toContain(displayName(test, target));
        expect(JSON.parse(opp.metadata!).subjectUserId).toBe(0);
    });
});

describe('view_tournament_registrant_accounts scope (S9a fix; A37, D-22)', () => {
    /** An OpenRoster tournament: a (seat 1) and b (seat 2) enrolled with one HSR account each; an assistant; an outsider. */
    function regWorld(isAnonymousDefault: boolean) {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault, rosterVisibility: 'OpenRoster' });
        const a = verified(test, 'pa');
        const b = verified(test, 'pb');
        const accA = insertHsrAccount(test, a.userId, 'uid-a');
        const accB = insertHsrAccount(test, b.userId, 'uid-b');
        register(test, a, id);
        advance(test, 1_000);
        register(test, b, id);
        const asst = verified(test, 'asst');
        assignAssistant(test, org, id, asst, { results: true });
        const rows = (who: Reader) => view<TournamentRegistrantAccountRow>(test, 'view_tournament_registrant_accounts', who);
        return { test, org, id, a, b, accA, accB, asst, rows, outsider: guest(test, 'outsider') };
    }

    it('staff (organizer, assistant) read every participant\'s rows with real ids, account ids and seats, in an anonymous tournament too', () => {
        const { org, asst, a, b, accA, accB, rows } = regWorld(true);
        for (const who of [org, asst]) {
            const r = rows(who);
            expect(r.find((x) => x.userId === a.userId), who.sub).toMatchObject({ hsrAccountId: accA, seat: 1 });
            expect(r.find((x) => x.userId === b.userId), who.sub).toMatchObject({ hsrAccountId: accB, seat: 2 });
            expect(r.filter((x) => x.userId === 0), who.sub).toEqual([]);
            for (const x of r) expect(keysOf(x)).toEqual([...COLS.registrant].sort());
        }
    });

    it('anonymous tournament: a participant reads their own rows with real ids and the others with userId 0, hsrAccountId 0 and the seat; no other player\'s id or account id', () => {
        const { a, b, accA, accB, rows } = regWorld(true);
        const r = rows(a);
        expect(r.some((x) => x.userId === a.userId)).toBe(true);
        expect(r.filter((x) => x.userId === a.userId).every((x) => x.hsrAccountId === accA && x.seat === 1)).toBe(true);
        const others = r.filter((x) => x.userId !== a.userId);
        expect(others.length).toBeGreaterThan(0);
        expect(others.every((x) => x.userId === 0 && x.hsrAccountId === 0 && x.seat === 2)).toBe(true);
        expect(r.filter((x) => x.userId === b.userId || x.hsrAccountId === accB)).toEqual([]);
    });

    it('an outsider and an unmapped identity read nothing', () => {
        const { rows, outsider } = regWorld(true);
        expect(rows(outsider)).toEqual([]);
        expect(rows(ghost())).toEqual([]);
    });

    it('non-anonymous OpenRoster tournament: a participant reads the other participant\'s rows with the real id (D-22)', () => {
        const { a, b, accB, rows } = regWorld(false);
        expect(rows(a).find((x) => x.userId === b.userId)).toMatchObject({ hsrAccountId: accB, seat: 2 });
    });
});

describe('step labels (S9a-A1, review #2) and the step history reveal (A37)', () => {
    it('Blue reads every masked Red actor with a Red seat label; a plain spectator reads masked actors of both sides with Blue / Red seat labels (A97)', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { lobby: ANON });
        const blueRows = view<AnonymousMatchStepRow>(test, 'view_my_match_steps', s.a.b1).filter((r) => r.actorUserId === 0);
        expect(blueRows.length).toBeGreaterThan(0);
        for (const r of blueRows) {
            expect(r.actorSlot.tag).toBe('Red');
            expect(r.anonymousLabel).toMatch(/^Red (Player|Coach) #\d+$/); // T-S10h (A97)
        }
        const spec = guest(test, 'spec');
        tx(test, spec, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' })); // A68(8)
        const specRows = view<AnonymousMatchStepRow>(test, 'view_my_match_steps', spec);
        const players = [s.a.b1, s.a.b2, s.a.r1, s.a.r2].map((p) => p.userId);
        expect(specRows.filter((r) => players.includes(r.actorUserId))).toEqual([]);
        const masked = specRows.filter((r) => r.actorUserId === 0);
        expect(new Set(masked.map((r) => r.actorSlot.tag))).toEqual(new Set(['Blue', 'Red']));
        for (const r of masked) expect(r.anonymousLabel).toMatch(new RegExp(`^${r.actorSlot.tag} (Player|Coach) #\\d+$`)); // T-S10h (A97)
    });

    // The fix pass kept the step history unlabelled: A37 reveals the match's real identities to its participants after
    // the match, so the history row carries actorUserId + actorDisplayName and no label column.
    // T-S10n (A115(3)): the step history is read per match (view_my_match_history_steps, was view_my_match_session_step_history).
    it('view_my_match_history_steps after an anonymous match: a participant reads the real actor ids and names of both teams; an outsider reads nothing', () => {
        const test = newHarness();
        const s = scoringOf(test, '', { lobby: ANON });
        finishGame(s, 'Blue');
        const args = { matchHistoryId: onlyMatchOf(test, s.a.r1) };
        const rows = view<{ actorUserId: number; actorDisplayName: string }>(test, 'view_my_match_history_steps', s.a.r1, args);
        expect(rows.length).toBeGreaterThan(0);
        const players = [s.a.b1, s.a.b2, s.a.r1, s.a.r2];
        const ids = new Set(rows.map((r) => r.actorUserId));
        expect(ids.has(0)).toBe(false);
        expect([s.a.b1.userId, s.a.b2.userId].some((id) => ids.has(id))).toBe(true);
        for (const r of rows) {
            const who = players.find((p) => p.userId === r.actorUserId);
            if (who) expect(r.actorDisplayName).toBe(displayName(test, who));
            expect('anonymousLabel' in r).toBe(false);
        }
        expect(view(test, 'view_my_match_history_steps', guest(test, 'outsider'), args)).toEqual([]);
    });
});

// ─── Not drivable in memory ──────────────────────────────────────────────────

describe('S9a: outside the in-memory harness', () => {
    it.todo('A37 / T-S11: a real client subscribed as an outsider receives no identifying row (subscription-level; live residue on test1)');
    it.todo('arg views over the wire: `SELECT * FROM view_tournament_participants(<id>)` subscription syntax and per-argument sharing (live residue, S11)');
    it.todo('PAGE-MAP D3: the room subscribes the match views only past Waiting (client behaviour, S14)');
    it.todo('egress: the member row is not rewritten by cursor / lineup throttle stamps (row-diff over the wire; live residue)');
    it.todo('review #9: a tournament Seat-<n> stays stable when an earlier enrollment is withdrawn (not applied in the fix pass: the anonymous-play contract documents the renumbering; the alias is the stable label)');
});
