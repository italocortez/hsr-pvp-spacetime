// T-S10 batch A2: builders shared by s10-draft / s10-results / s10-stats (the in-memory port of the live draft,
// result-lifecycle and MMR / stats suites). Not a test file. Reuses the S4 / S7 / S8 / S8d builders; HSR accounts,
// account characters, tournament account locks and the ranked flag are written straight into the in-memory datastore
// (outside any reducer), like the earlier suites. `test.db` is read only outside `tx` bodies. Nothing reaches maincloud.
// seedRatingData is copied from s6-rules.test.ts (a local helper there, not exported).
import { expect } from 'vitest';
import { M, lobbyRow, session, setupLobby, tx, type Actor, type Harness, type Lobby, type SetupOpts } from './s4-fixtures';
import { H, arrange, blueNames, captain, closeGame, halves, redNames, side } from './s7-fixtures';
import { AUDIT, insertHsrAccount } from './s8-fixtures';

// ─── Rating data (copied from s6-rules.test.ts) ───────────────────────────────

export const RATING_CHARS = ['c1', 'c2', 'c5', 'c6', 'c9'];

/** Characters (same version, same role: symmetric age weights) and one archetype {c1, c5, c9}; no config row. */
export function seedRatingChars(test: Harness) {
    tx(test, 'internal', (ctx) => {
        for (const name of RATING_CHARS) {
            ctx.db.HsrCharacter.insert({
                name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Harmony' }, element: { tag: 'Fire' },
                role: { tag: 'Support' }, imageUrl: '', versionReleased: 2.0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
        const arch = ctx.db.Archetype.insert({
            id: 0, name: 'hypercarry', description: '',
            createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
        });
        for (const name of ['c1', 'c5', 'c9']) {
            ctx.db.HsrCharacterArchetype.insert({
                characterName: name, archetypeId: arch.id,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            });
        }
    });
}

/** seedRatingChars, then the config row through the internal owner (SYSTEM Admin). */
export function seedRatingData(test: Harness) {
    seedRatingChars(test);
    tx(test, 'internal', (ctx) => M.admin_seed_rating_config(ctx, {}));
}

// ─── HSR accounts, ownership, tournament locks ────────────────────────────────

/**
 * An HSR account of `userId` owning `chars` (names at E0, or name → eidolon), inserted directly. `active: false`
 * marks it inactive (join_lobby auto-selects the user's active account, D-04). Returns its id.
 */
export function ownedAccount(test: Harness, userId: number, uid: string, chars: string[] | Record<string, number>, active = true): number {
    const id = insertHsrAccount(test, userId, uid);
    if (!active) test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(id)!, isActive: false });
    const owned = Array.isArray(chars) ? Object.fromEntries(chars.map((c) => [c, 0])) : chars;
    for (const [characterName, eidolonLevel] of Object.entries(owned)) {
        test.db.HsrAccountCharacter.insert({ hsrAccountId: id, characterName, eidolonLevel, ...AUDIT(test) });
    }
    return id;
}

/** A TournamentPlayerAccount lock (what registration writes), inserted directly. */
export function lockAccount(test: Harness, tournamentId: number, userId: number, hsrAccountId: number) {
    test.db.TournamentPlayerAccount.insert({ tournamentId, userId, hsrAccountId, ...AUDIT(test) });
}

export const lmaOf = (test: Harness, lobbyId: number, userId: number) =>
    [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])].map((r) => r.hsrAccountId).sort((a, b) => a - b);

/** update_lobby_settings arguments built from the lobby row itself (so only the overridden keys change). */
export function settingsFrom(test: Harness, lobbyId: number, over: Record<string, unknown> = {}) {
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

// ─── Draft drivers ─────────────────────────────────────────────────────────────

/**
 * Plays a Classic draft (any ban mode) to Equipping: each Pick turn's captain picks the next name of its team's list,
 * each Ban turn's captain bans the next name of `bans`.
 */
export function draftWithBans(s: Lobby, blue: string[], red: string[], bans: string[] = []) {
    const queue = { Blue: [...blue], Red: [...red] };
    const banQueue = [...bans];
    let guard = 0;
    while (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting' && guard++ < 64) {
        const sess = session(s.test, s.lobbyId);
        const step = sess.draftSequence[sess.turnIndex];
        const team = step.teamTurn.tag as 'Blue' | 'Red';
        const who = captain(s, team);
        if (step.actionRequired.tag === 'Pick') {
            const characterName = queue[team].shift()!;
            tx(s.test, who, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 }));
        } else {
            const characterName = banQueue.shift()!;
            tx(s.test, who, (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName }));
        }
    }
    expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
}

// ─── Ranked standalone matches ────────────────────────────────────────────────

/** Names of the lobby's player seats (BluePlayer / RedPlayer), by actor name. */
function playerNames(l: Lobby): string[] {
    const players = [...l.test.db.LobbyMember.lobby_id.filter(l.lobbyId)]
        .filter((m) => m.lobbySlot.tag === 'BluePlayer' || m.lobbySlot.tag === 'RedPlayer')
        .map((m) => m.userId);
    return Object.entries(l.a).filter(([, a]) => players.includes(a.userId)).map(([n]) => n);
}

/**
 * beforeStart hook: the lobby becomes Ranked (guests cannot create one, D-23) and every player holds exactly one
 * selected account (D-08): their first HSR account (created on first use), with `ratings[name]` as its stored
 * accountRating when given. join_lobby's auto-selection is replaced so the selection is exactly that one account.
 */
export const rankedHook = (test: Harness, ratings: Record<string, number> = {}) => (l: Lobby) => {
    test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
    for (const name of playerNames(l)) {
        const userId = l.a[name].userId;
        for (const row of [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([l.lobbyId, userId])]) {
            test.db.LobbyMemberAccount.delete(row);
        }
        const existing = [...test.db.HsrAccount.user_id.filter(userId)].sort((a, b) => a.id - b.id)[0];
        const id = existing ? existing.id : insertHsrAccount(test, userId, `acct-${name}-${userId}`);
        if (ratings[name] !== undefined) {
            test.db.HsrAccount.id.update({ ...test.db.HsrAccount.id.find(id)!, accountRating: ratings[name] });
        }
        test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId, hsrAccountId: id });
    }
};

export const SHOT = (team: string) => `https://example.test/${team}.png`;

export interface RankedOpts {
    /** Actors reused by name (the same users play several matches). */
    actors?: Record<string, Actor>;
    lobby?: Record<string, unknown>;
    ratings?: Record<string, number>;
    bans?: string[];
    /** Runs right after start_draft (Drafting). */
    afterStart?: (s: Lobby) => void;
    /** Screenshots on both score entries (default true: the Ranked validation gate, D-07). */
    screenshots?: boolean;
}

/**
 * A standalone Ranked Classic MoC Bo1 (teamSize 2: b1, b2 Blue; r1, r2 Red; host = Spectator referee): drafted
 * (blueNames / redNames, `bans` on ban turns), lineups arranged by the captains, Equipping → Scoring, both sides'
 * group scores recorded by the host referee (with screenshots), and the host's close submits it (Submitted,
 * AwaitingResult; A60(6)). `winner` gets 10 cycles per group, the other 20.
 */
export function playRanked(test: Harness, winner: 'Blue' | 'Red', opts: RankedOpts = {}): { s: Lobby; recId: number } {
    const s = setupLobby(test, { actors: opts.actors, lobby: opts.lobby, beforeStart: rankedHook(test, opts.ratings) });
    opts.afterStart?.(s);
    playRankedGame(s, winner, opts.bans ?? [], opts.screenshots ?? true);
    const recId = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0].id;
    return { s, recId };
}

/** playRanked after start_draft: drafted, arranged, Equipping → Scoring, scored by the host referee, closed. */
function playRankedGame(s: Lobby, winner: 'Blue' | 'Red', bans: string[], shots: boolean) {
    const { test } = s;
    draftWithBans(s, blueNames(), redNames(), bans);
    arrange(s, captain(s, 'Blue'), 'Blue', halves(blueNames()));
    arrange(s, captain(s, 'Red'), 'Red', halves(redNames()));
    tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
    for (const team of ['Blue', 'Red'] as const) {
        const values = [H(team === winner ? 10 : 20), H(team === winner ? 10 : 20)];
        tx(test, s.host, (ctx) => M.record_group_scores(ctx, {
            lobbyId: s.lobbyId, teamSide: side(team), values, deaths: 0, screenshotUrl: shots ? SHOT(team) : undefined,
        }));
    }
    closeGame(s, s.host);
}

/**
 * T-S10d (A91(2)): a standalone lobby parked in AwaitingResult now that the Deferred policy is reserved for
 * tournaments. setupLobby with `opts` (DEFAULT_LOBBY_ARGS' Standard policy; seats, actors and beforeStart kept), made
 * Ranked by rankedHook after opts.beforeStart, then played as playRanked plays it: the host referee's close submits
 * the game, so the record is Submitted (no standalone path parks a Pending record any more) and the lobby parks.
 */
export function parkedLobby(test: Harness, opts: SetupOpts = {}, winner: 'Blue' | 'Red' = 'Blue'): Lobby {
    const s = setupLobby(test, {
        ...opts,
        beforeStart: (l) => {
            opts.beforeStart?.(l);
            rankedHook(test)(l);
        },
    });
    playRankedGame(s, winner, [], true);
    expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    return s;
}

/** override_match_result → Validated(winner) by `mod`, then finalize_match_result by the match referee (the host). */
export function validateAndFinalize(test: Harness, s: Lobby, recId: number, mod: Actor, winner: 'Blue' | 'Red') {
    tx(test, mod, (ctx) => M.override_match_result(ctx, { matchResultId: recId, newStatusTag: 'Validated', winnerTeamSideTag: winner, reason: 'reviewed' }));
    tx(test, s.host, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }));
}
