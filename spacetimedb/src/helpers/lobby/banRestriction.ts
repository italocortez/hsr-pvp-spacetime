// ─── A45(2): Ban Restriction, per team ──────────────────────────────────────────────────────────────────────
// Lobby.banRestriction limits which characters ONE team may ban in the current game, by HsrCharacter.role:
//   NoRestriction — anything; MaxOneDps — at most one Dps ban; MaxTwoDps — at most two Dps bans;
//   MaxOnePerRole — at most one ban per role (Dps, Sustain, Support).
// Counted over the team's Ban steps of the lobby's one game (A67(3)).
// The SKIP / EMPTY sentinels and names without an HsrCharacter row carry no role and never count or violate.
// Enforced by ban_character and respected by the timer-expiry auto-ban (timer_expiry_classic, both draft modes).

import { lobbySteps } from '@module/helpers/draft/stepSequence';

const SENTINELS = new Set(['SKIP', 'EMPTY']);

function roleOf(ctx: any, characterName: string): string | undefined {
    if (SENTINELS.has(characterName)) return undefined;
    return ctx.db.HsrCharacter.name.find(characterName)?.role.tag;
}

/** Roles of the characters `teamTag` ('Blue' | 'Red') has banned so far in the lobby's current game. */
function teamBanRoles(ctx: any, lobbyId: number, teamTag: string): string[] {
    const roles: string[] = [];
    for (const s of lobbySteps(ctx, lobbyId)) { // A67(3): the lobby's one game
        if (s.action.tag !== 'Ban' || s.payload.tag !== 'Ban' || s.actorSlot.tag !== teamTag) continue;
        const role = roleOf(ctx, s.payload.value.characterName);
        if (role) roles.push(role);
    }
    return roles;
}

/** Why `teamTag` may not ban `characterName` under the lobby's restriction, or null when the ban is legal. */
export function banRestrictionError(ctx: any, lobby: any, teamTag: string, characterName: string): string | null {
    const restriction: string = lobby.banRestriction?.tag ?? 'NoRestriction';
    if (restriction === 'NoRestriction') return null;
    const role = roleOf(ctx, characterName);
    if (!role) return null;
    const banned = teamBanRoles(ctx, lobby.id, teamTag);
    const dpsBans = banned.filter((r) => r === 'Dps').length;
    if (restriction === 'MaxOneDps' && role === 'Dps' && dpsBans >= 1) {
        return 'Ban restriction: your team may ban at most one DPS character.';
    }
    if (restriction === 'MaxTwoDps' && role === 'Dps' && dpsBans >= 2) {
        return 'Ban restriction: your team may ban at most two DPS characters.';
    }
    if (restriction === 'MaxOnePerRole' && banned.includes(role)) {
        return `Ban restriction: your team may ban at most one ${role} character.`;
    }
    return null;
}

export function isBanLegal(ctx: any, lobby: any, teamTag: string, characterName: string): boolean {
    return banRestrictionError(ctx, lobby, teamTag, characterName) === null;
}
