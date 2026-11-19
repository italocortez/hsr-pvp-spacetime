// ─── Social Views ─────────────────────────────────────────────────────────────
// Per-user views over relationships and roster visibility across lobbies.
//
// 1. view_my_relationships      — caller's PlayerRelationship rows + the other player's card (D-33; S9b: D2, A40)
// 1b. view_my_player_cards      — the caller's Best Ally and Nemesis cards, two rows at most (S14.5s, A226)
// 2. view_my_roster_visibility  — rosters visible to caller per lobby (D-10..D-16; S9b: A37 / A40)
// 3. view_my_roster             — caller's own HsrAccounts + characters (D-20)
//
// Index-only: no table scan in any view body.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { GameMode, DraftMode, MatchType } from '@module/types/enums';
import { slotIsSpectator, slotSameTeam } from '@module/helpers/lobby/lobbyHelpers';
import { resolveUserLabel } from '@module/helpers/identity/userLabel';
import {
    callerMemberships, callerUserId, hideUserId, mmrByModeOf, ratingVisible,
} from '@module/helpers/identity/viewAnonymity';

// ---------------------------------------------------------------------------
// 1. My Relationships (per-user view) — the caller's PlayerRelationship rows (private table, D-33): the profile's
//    best ally / nemesis. S9b (PAGE-MAP D2): the other player's displayName, avatar and title are denormalized into
//    the row, so the profile never subscribes `User`; A40 (CH-M1 "keep the mockup"): the other player's MMR per mode
//    (active season, `[MemoryOfChaos, ApocalypticShadow, AnomalyArbitration]`, the initial rating for an unplayed
//    mode) is denormalized too. `otherUserId` stays: relationships are aggregates of finished matches, whose
//    identities are revealed to their participants (A37). No audit columns (the writer stamps the finalizing user)
//    and no `userId` (the caller). A deleted other player keeps the archived name, no avatar, title or MMR.
//    Index-only: PlayerRelationship.by_user, User.id, DeletedUser.id, Season.is_active, EloConfigTable.id,
//    MmrRating.by_user_mode_season (once per other player).
// ---------------------------------------------------------------------------
const MyRelationshipRow = t.row('MyRelationshipRow', {
    otherUserId: t.u32(),
    otherDisplayName: t.string(),
    otherAvatarCharacterName: t.string().optional(),
    otherDisplayedAchievementId: t.u32().optional(),
    otherMmrByMode: t.array(t.u32()).optional(),
    gameMode: GameMode,
    draftMode: DraftMode,
    matchType: MatchType,
    teamSize: t.u8(),
    seasonId: t.u32(),
    matchesAsAlly: t.u32(),
    winsAsAlly: t.u32(),
    matchesAsOpponent: t.u32(),
    winsAsOpponent: t.u32(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_relationships = spacetimedb.view(
    { name: 'view_my_relationships', public: true },
    t.array(MyRelationshipRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const cards = new Map<number, any>();
        const rows: any[] = [];
        for (const r of ctx.db.PlayerRelationship.by_user.filter(me)) {
            let card = cards.get(r.otherUserId);
            if (!card) {
                const user = ctx.db.User.id.find(r.otherUserId);
                card = {
                    otherDisplayName: user ? user.displayName : resolveUserLabel(ctx, r.otherUserId).displayName,
                    otherAvatarCharacterName: user?.avatarCharacterName,
                    otherDisplayedAchievementId: user?.displayedAchievementId,
                    otherMmrByMode: user ? mmrByModeOf(ctx, r.otherUserId) : undefined,
                };
                cards.set(r.otherUserId, card);
            }
            rows.push({
                otherUserId: r.otherUserId,
                ...card,
                gameMode: r.gameMode,
                draftMode: r.draftMode,
                matchType: r.matchType,
                teamSize: r.teamSize,
                seasonId: r.seasonId,
                matchesAsAlly: r.matchesAsAlly,
                winsAsAlly: r.winsAsAlly,
                matchesAsOpponent: r.matchesAsOpponent,
                winsAsOpponent: r.winsAsOpponent,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 1b. My Player Cards (per-user view) — S14.5s (A226 items 5, 6): the profile's Best Ally and Nemesis, at most two
//     rows, each with what a player card shows. Built from the caller's PlayerRelationship rows of the active season
//     (seasonId 0 when no season is active, as finalization writes), summed per other player over every game mode,
//     draft mode, match type and team size:
//     - BestAlly: the most wins together among players with at least PLAYER_CARD_MIN_MATCHES matches together;
//     - Nemesis: the most losses against among players with at least PLAYER_CARD_MIN_MATCHES matches against.
//     A count of 0 never qualifies. Ties: the fewer shared matches first (the higher rate), then the lower user id.
//     A candidate whose User row is gone (deleted) or pending deletion (deletedAt: an admin deletion or a ban) is
//     skipped and the next one is taken. A suspended other player is shown, as on the leaderboard.
//     Card: displayName, username (the handle), avatar, displayed title, the rating of the ACTIVE game account (A226
//     item 5; A228 item 6: the only rating a card carries outside a lobby; unset when no account is active) and the
//     number of game accounts. S14.5s fix pass (A228 item 6): the mode ratings and the composite `globalRating` are
//     dropped, and so is `userId` (no client lookup is keyed by it; the row's key is `relation`).
//     `matches` / `wins` / `losses` are the caller's side of the relation (together for BestAlly, against for Nemesis).
//     The caller is resolved through callerUserId (a suspended or unmapped caller gets []).
//     Read set: UserIdentity.identity + UserSuspension (callerUserId), Season.is_active, PlayerRelationship.by_user
//     (the caller's rows only), then for each carded player only: User.id, HsrAccount.user_id. No scan.
// ---------------------------------------------------------------------------
/** S14.5s (A226 item 6): the fewest shared matches for a Best Ally or Nemesis card. */
export const PLAYER_CARD_MIN_MATCHES = 3;

const PlayerCardRow = t.row('PlayerCardRow', {
    relation: t.string().primaryKey(), // 'BestAlly' | 'Nemesis'; one row each at most, so the client gets onUpdate
    displayName: t.string(),
    username: t.string(),
    avatarCharacterName: t.string(),
    displayedAchievementId: t.u32().optional(),
    activeAccountRating: t.u32().optional(),
    accountCount: t.u32(),
    matches: t.u32(),
    wins: t.u32(),
    losses: t.u32(),
});

interface PairTotals { matchesAsAlly: number; winsAsAlly: number; matchesAsOpponent: number; winsAsOpponent: number }

/** The ordered candidates of one relation: qualifying players, best first (count desc, matches asc, user id asc). */
function rankCandidates(
    totals: Map<number, PairTotals>,
    matchesOf: (p: PairTotals) => number,
    countOf: (p: PairTotals) => number,
): number[] {
    return [...totals.entries()]
        .filter(([, p]) => matchesOf(p) >= PLAYER_CARD_MIN_MATCHES && countOf(p) > 0)
        .sort(([idA, a], [idB, b]) => (countOf(b) - countOf(a)) || (matchesOf(a) - matchesOf(b)) || (idA - idB))
        .map(([id]) => id);
}

/** The card fields of a live user (index reads only). */
function playerCard(ctx: any, user: any) {
    const accounts = [...ctx.db.HsrAccount.user_id.filter(user.id)];
    const active = accounts.find((a: any) => a.isActive);
    return {
        displayName: user.displayName,
        username: user.username,
        avatarCharacterName: user.avatarCharacterName,
        displayedAchievementId: user.displayedAchievementId,
        activeAccountRating: active ? active.accountRating : undefined,
        accountCount: accounts.length,
    };
}

export const view_my_player_cards = spacetimedb.view(
    { name: 'view_my_player_cards', public: true },
    t.array(PlayerCardRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const activeSeason = [...ctx.db.Season.is_active.filter(true)][0];
        const seasonId = activeSeason ? activeSeason.id : 0;

        const totals = new Map<number, PairTotals>();
        for (const r of ctx.db.PlayerRelationship.by_user.filter(me)) {
            if (r.seasonId !== seasonId) continue;
            const p = totals.get(r.otherUserId) ?? { matchesAsAlly: 0, winsAsAlly: 0, matchesAsOpponent: 0, winsAsOpponent: 0 };
            p.matchesAsAlly += r.matchesAsAlly;
            p.winsAsAlly += r.winsAsAlly;
            p.matchesAsOpponent += r.matchesAsOpponent;
            p.winsAsOpponent += r.winsAsOpponent;
            totals.set(r.otherUserId, p);
        }

        const relations = [
            {
                relation: 'BestAlly',
                matchesOf: (p: PairTotals) => p.matchesAsAlly,
                countOf: (p: PairTotals) => p.winsAsAlly,
                winsOf: (p: PairTotals) => p.winsAsAlly,
            },
            {
                relation: 'Nemesis',
                matchesOf: (p: PairTotals) => p.matchesAsOpponent,
                countOf: (p: PairTotals) => p.matchesAsOpponent - p.winsAsOpponent,
                winsOf: (p: PairTotals) => p.winsAsOpponent,
            },
        ];
        const rows: any[] = [];
        for (const rel of relations) {
            for (const otherId of rankCandidates(totals, rel.matchesOf, rel.countOf)) {
                const user = ctx.db.User.id.find(otherId);
                if (!user || user.deletedAt !== undefined) continue;
                const p = totals.get(otherId)!;
                const matches = rel.matchesOf(p);
                const wins = rel.winsOf(p);
                rows.push({ relation: rel.relation, ...playerCard(ctx, user), matches, wins, losses: matches - wins });
                break;
            }
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 2. My Roster Visibility (per-user view) — the selected-account characters (LobbyMemberAccount, D-15) of the
//    members of the caller's lobbies that the caller may see: the Account Selection modal and the "View roster"
//    drawer of the lobby room (PAGE-MAP lobbyroom gap (2)).
//
//    Rules (S9b: A40 replaces the D-18 "anonymous forces ClosedNoRating" override):
//    - Self, a teammate (D-70) and the spectator referee (D-14 narrowed by A75, as D-71 / A40): roster and rating.
//      A referee seated on a team is a player: opponents per rosterVisibility below.
//    - Anyone else: OpenRoster → roster and rating (D-11), ClosedWithRating → rating only (D-12), ClosedNoRating →
//      nothing (D-13); on anonymized seats too (A40: exact ratings; the roster only under OpenRoster).
//    - Spectators follow the opponent rules (D-16), except the spectator referee.
//    A37: `memberUserId` and `hsrAccountId` are 0 when the member is hidden from the caller (`hideUserId`; a
//    player referee does not see anonymized opponents' ids, D-71); `joinSeq` ties every row to the member card
//    (`view_my_lobby_members.memberKey = lobbyId << 32 | joinSeq`). A rating-only row has characterName '' and
//    eidolonLevel 0. Abandoned memberships of the caller are skipped (A68(4)).
//    Index-only: UserIdentity.identity, LobbyMember.user_id / lobby_id / by_lobby_and_user, Lobby.id,
//    LobbyMemberAccount.by_lobby_and_user, HsrAccount.id, HsrAccountCharacter.hsr_account_id.
// ---------------------------------------------------------------------------
const RosterVisibilityRow = t.object('RosterVisibilityRow', {
    lobbyId: t.u32(),
    joinSeq: t.u32(),
    memberUserId: t.u32(),
    hsrAccountId: t.u32(),
    characterName: t.string(),
    eidolonLevel: t.u8(),
    accountRating: t.u32().optional(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_roster_visibility = spacetimedb.view(
    { name: 'view_my_roster_visibility', public: true },
    t.array(RosterVisibilityRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const results: any[] = [];

        for (const myMembership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(myMembership.lobbyId);
            if (!lobby) continue;
            const openRoster = lobby.rosterVisibility.tag === 'OpenRoster';

            for (const member of ctx.db.LobbyMember.lobby_id.filter(lobby.id)) {
                const isSelf = member.userId === me.userId;
                const fullAccess = isSelf
                    || (myMembership.isReferee && slotIsSpectator(myMembership.lobbySlot)) // A75: spectator referee only
                    || slotSameTeam(myMembership.lobbySlot, member.lobbySlot);
                const canSeeRoster = fullAccess || openRoster;
                const canSeeRating = canSeeRoster || ratingVisible(lobby, myMembership, member);
                if (!canSeeRoster && !canSeeRating) continue;

                const hidden = !isSelf && hideUserId(ctx, lobby, myMembership, member.userId);

                for (const lma of ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobby.id, member.userId])) {
                    const account = ctx.db.HsrAccount.id.find(lma.hsrAccountId);
                    if (!account) continue;
                    const base = {
                        lobbyId: lobby.id,
                        joinSeq: member.joinSeq,
                        memberUserId: hidden ? 0 : member.userId,
                        hsrAccountId: hidden ? 0 : account.id,
                    };
                    if (canSeeRoster) {
                        for (const char of ctx.db.HsrAccountCharacter.hsr_account_id.filter(account.id)) {
                            results.push({
                                ...base,
                                characterName: char.characterName,
                                eidolonLevel: char.eidolonLevel,
                                accountRating: account.accountRating,
                            });
                        }
                    } else {
                        // D-12 ClosedWithRating: the selected account's rating only, no characters
                        results.push({ ...base, characterName: '', eidolonLevel: 0, accountRating: account.accountRating });
                    }
                }
            }
        }

        return results;
    }
);

// ---------------------------------------------------------------------------
// 3. My Roster (per-user view) — returns caller's own HsrAccounts + characters.
//    Replaces raw HsrAccount/HsrAccountCharacter subscriptions now that both
//    tables are private (D-20). Flat rows (one per character); accounts with
//    no characters emit a single row with characterName/eidolonLevel = undefined.
//    S9b: re-checked against PAGE-MAP profile (uid, region, displayLabel, isActive, the two public toggles, rating,
//    eidolons); unchanged.
// ---------------------------------------------------------------------------
const MyRosterAccountRow = t.object('MyRosterAccountRow', {
    accountId: t.u32(),
    uid: t.string(),
    region: t.string(),
    displayLabel: t.string(),
    isActive: t.bool(),
    isRosterPublic: t.bool(),
    isRatingPublic: t.bool(),
    isDuplicateUid: t.bool(),
    accountRating: t.u32(),
    characterName: t.string().optional(),
    eidolonLevel: t.u8().optional(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_roster = spacetimedb.view(
    { name: 'view_my_roster', public: true },
    t.array(MyRosterAccountRow),
    (ctx) => {
        const myUserId = callerUserId(ctx);
        if (myUserId === undefined) return [];

        const accounts = [...ctx.db.HsrAccount.user_id.filter(myUserId)];
        const results: any[] = [];

        for (const account of accounts) {
            const base = {
                accountId: account.id,
                uid: account.uid,
                region: account.region,
                displayLabel: account.displayLabel,
                isActive: account.isActive,
                isRosterPublic: account.isRosterPublic,
                isRatingPublic: account.isRatingPublic,
                isDuplicateUid: account.isDuplicateUid,
                accountRating: account.accountRating,
            };
            const characters = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(account.id)];
            if (characters.length === 0) {
                // Account with no characters — still return account metadata
                results.push({ ...base, characterName: undefined, eidolonLevel: undefined });
            } else {
                for (const char of characters) {
                    results.push({ ...base, characterName: char.characterName, eidolonLevel: char.eidolonLevel });
                }
            }
        }

        return results;
    }
);
