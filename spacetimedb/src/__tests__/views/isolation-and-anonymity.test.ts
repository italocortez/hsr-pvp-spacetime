// Views: outsider isolation of the per-sender views and the anonymous lobby (members, chat, steps, spectators,
//   member-event lines, step labels).
// Decisions: A37, D-07, D-70, D-71
// Contracts: docs/views/contract.md
// From S9a (s9a-views.test.ts).
import { describe, expect, it } from 'vitest';
import type {
    AnonymousChatRow,
    AnonymousMatchParticipantRow,
    AnonymousMatchStepRow,
    Lobby as LobbyBinding,
    LobbyBrowserRow,
    LobbyMemberViewRow,
    LobbyPresetViewRow,
    MatchResultGameViewRow,
} from '@bindings/types';
import {
    M,
    guest,
    member,
    newHarness,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from '../fixtures/harness';
import { moderator, verified, displayName } from '../fixtures/identity';
import { H, captain, closeGame, confirmGame, finishGame, recordScores, side } from '../fixtures/draft-and-scoring';
import { seatLabel, leave, chat } from '../fixtures/lobby';
import {
    ANON,
    COLS,
    USER_ID_KEY,
    ghost,
    keysOf,
    lobbyOf,
    makeRanked,
    onlyMatchOf,
    rowFor,
    scoringOf,
    seatsOf,
    shared,
    view,
    type Reader,
} from '../fixtures/views';
import { openTournament, register } from '../fixtures/tournaments';
import { duel, openMatchLobby, seedElo } from '../fixtures/tournament-matches';

/** The audit columns that carry a user id (A37); a shared row may still carry a plain creation date (the browser's createdDate). */
const AUDIT_ID_KEYS = ['createdById', 'lastModifiedById'];

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
