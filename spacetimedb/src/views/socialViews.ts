// ─── Social Views ─────────────────────────────────────────────────────────────
// Per-user views over relationships and roster visibility across lobbies.
//
// 1. view_my_relationships      — caller's PlayerRelationship rows (D-33)
// 2. view_my_roster_visibility  — rosters visible to caller per lobby (D-10..D-16, ANON-04)
// 3. view_my_roster             — caller's own HsrAccounts + characters (D-20)

import spacetimedb from '../schema';
import { t } from 'spacetimedb/server';
import { PlayerRelationship } from '../tables/playerRelationship';
import { slotTeam } from '../helpers/lobbyHelpers';

// ---------------------------------------------------------------------------
// 1. My Relationships (per-user view) — returns caller's own
//    PlayerRelationship rows. Private table accessible via this view. (D-33)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_relationships = spacetimedb.view(
    { name: 'view_my_relationships', public: true },
    t.array(PlayerRelationship.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        return [...ctx.db.PlayerRelationship.by_user.filter(mapping.userId)];
    }
);

// ---------------------------------------------------------------------------
// 2. My Roster Visibility (per-user view) — returns HsrAccountCharacter rows
//    the calling user is allowed to see, based on their lobby memberships and
//    each lobby's rosterVisibility setting (D-10 through D-16, ANON-04).
//
//    Visibility rules:
//    - Referee: sees all rosters regardless of setting (D-14)
//    - Self + own team: always see full roster and rating
//    - OpenRoster: all rosters visible (D-11)
//    - ClosedWithRating: opponent roster hidden, rating visible (D-12)
//    - ClosedNoRating: opponent roster AND rating hidden (D-13)
//    - Spectators follow same rules as opponents (D-16)
// ---------------------------------------------------------------------------
const RosterVisibilityRow = t.object('RosterVisibilityRow', {
    lobbyId: t.u32(),
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
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const myUserId = mapping.userId;

        // Get all lobbies the user is a member of
        const myMemberships = [...ctx.db.LobbyMember.user_id.filter(myUserId)];
        const results: any[] = [];

        for (const myMembership of myMemberships) {
            const lobby = ctx.db.Lobby.id.find(myMembership.lobbyId);
            if (!lobby) continue;

            const allMembers = [...ctx.db.LobbyMember.lobby_id.filter(lobby.id)];
            const myTeam = slotTeam(myMembership.lobbySlot);
            const isReferee = myMembership.isReferee;

            for (const member of allMembers) {
                const isOwnTeam = slotTeam(member.lobbySlot) === myTeam;
                const isSelf = member.userId === myUserId;

                // Determine if we can see this member's roster
                let canSeeRoster = false;
                let canSeeRating = false;

                if (isReferee) {
                    // D-14: Referee sees all rosters regardless of setting
                    canSeeRoster = true;
                    canSeeRating = true;
                } else if (isSelf || isOwnTeam) {
                    // Own + allies' rosters always visible
                    canSeeRoster = true;
                    canSeeRating = true;
                } else {
                    // Opponent visibility depends on rosterVisibility setting
                    const vis = lobby.rosterVisibility.tag;
                    if (vis === 'OpenRoster') {
                        // D-11: All rosters visible
                        canSeeRoster = true;
                        canSeeRating = true;
                    } else if (vis === 'ClosedWithRating') {
                        // D-12: Opponent roster hidden, rating visible
                        canSeeRoster = false;
                        canSeeRating = true;
                    } else {
                        // ClosedNoRating (D-13): Opponent roster AND rating hidden
                        canSeeRoster = false;
                        canSeeRating = false;
                    }

                    // D-18: Anonymous mode override — force ClosedNoRating for opponents
                    if (lobby.isAnonymousPlayers) {
                        canSeeRoster = false;
                        canSeeRating = false;
                    }
                }

                if (!canSeeRoster && !canSeeRating) continue;

                // D-15: Filter by LobbyMemberAccount — only characters from selected account(s) shown
                const selectedAccountRows = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobby.id, member.userId])];

                for (const lma of selectedAccountRows) {
                    const account = ctx.db.HsrAccount.id.find(lma.hsrAccountId);
                    if (!account) continue;

                    if (canSeeRoster) {
                        // D-16 OpenRoster: selected account(s) rating + characters
                        const characters = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(account.id)];
                        for (const char of characters) {
                            results.push({
                                lobbyId: lobby.id,
                                memberUserId: member.userId,
                                hsrAccountId: account.id,
                                characterName: char.characterName,
                                eidolonLevel: char.eidolonLevel,
                                accountRating: canSeeRating ? account.accountRating : undefined,
                            });
                        }
                    } else if (canSeeRating) {
                        // D-16 ClosedWithRating: selected account(s) rating only, no characters
                        results.push({
                            lobbyId: lobby.id,
                            memberUserId: member.userId,
                            hsrAccountId: account.id,
                            characterName: '',  // Sentinel: no roster data, rating only
                            eidolonLevel: 0,
                            accountRating: account.accountRating,
                        });
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
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const myUserId = mapping.userId;

        const accounts = [...ctx.db.HsrAccount.user_id.filter(myUserId)];
        const results: any[] = [];

        for (const account of accounts) {
            const characters = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(account.id)];
            if (characters.length === 0) {
                // Account with no characters — still return account metadata
                results.push({
                    accountId: account.id,
                    uid: account.uid,
                    region: account.region,
                    displayLabel: account.displayLabel,
                    isActive: account.isActive,
                    isRosterPublic: account.isRosterPublic,
                    isRatingPublic: account.isRatingPublic,
                    isDuplicateUid: account.isDuplicateUid,
                    accountRating: account.accountRating,
                    characterName: undefined,
                    eidolonLevel: undefined,
                });
            } else {
                for (const char of characters) {
                    results.push({
                        accountId: account.id,
                        uid: account.uid,
                        region: account.region,
                        displayLabel: account.displayLabel,
                        isActive: account.isActive,
                        isRosterPublic: account.isRosterPublic,
                        isRatingPublic: account.isRatingPublic,
                        isDuplicateUid: account.isDuplicateUid,
                        accountRating: account.accountRating,
                        characterName: char.characterName,
                        eidolonLevel: char.eidolonLevel,
                    });
                }
            }
        }

        return results;
    }
);
