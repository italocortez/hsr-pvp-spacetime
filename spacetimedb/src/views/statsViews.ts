// ─── Stats Views ──────────────────────────────────────────────────────────────
// Per-user views over PlayerStat and PlayerCharacterStat private tables.
//
// 1. view_my_player_stats    — caller's own PlayerStat rows (D-33)
// 2. view_my_character_stats — caller's own PlayerCharacterStat rows (D-33)

import spacetimedb from '../schema';
import { t } from 'spacetimedb/server';
import { PlayerStat } from '../tables/playerStats';
import { PlayerCharacterStat } from '../tables/characterStats';

// ---------------------------------------------------------------------------
// 1. My Player Stats (per-user view) — returns caller's own PlayerStat rows.
//    PlayerStat is private (public: false), so this view is the only way
//    for clients to access their own stats. (D-33)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_player_stats = spacetimedb.view(
    { name: 'view_my_player_stats', public: true },
    t.array(PlayerStat.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        return [...ctx.db.PlayerStat.by_user.filter(mapping.userId)];
    }
);

// ---------------------------------------------------------------------------
// 2. My Character Stats (per-user view) — returns caller's own
//    PlayerCharacterStat rows. Private table accessible via this view. (D-33)
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_character_stats = spacetimedb.view(
    { name: 'view_my_character_stats', public: true },
    t.array(PlayerCharacterStat.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        return [...ctx.db.PlayerCharacterStat.by_user.filter(mapping.userId)];
    }
);
