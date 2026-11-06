// ─── Achievement Management Reducers ──────────────────────────────────────────
// CRUD for achievement definitions, criteria management, manual awards,
// and title display (set_displayed_achievement).
//
// Permission model:
//   - Achievement create/update, criteria add/remove: Moderator+ (D-20)
//   - Achievement delete (cascade): Admin only (D-20)
//   - manual_award: Admin/Mod unrestricted; TournamentHost → own participants (D-21)
//   - set_displayed_achievement: User sets own; Admin sets for any user (D-22)

import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import {
    ensureAdmin,
    ensureModerator,
    getAuthenticatedUser,
    isRoleAtLeast,
} from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { AchievementRarity, ComparisonOperator } from '../types/enums';

// ─── create_achievement ──────────────────────────────────────────────────────
// Creates a new achievement definition. (D-01, D-20)
// Permission: Moderator+ (Admin or Moderator)

export const create_achievement = spacetimedb.reducer(
    {
        name: t.string(),
        description: t.string(),
        rarity: AchievementRarity,
        isManualOnly: t.bool(),
        maxAwards: t.u32().optional(),
    },
    (ctx, { name, description, rarity, isManualOnly, maxAwards }: {
        name: string;
        description: string;
        rarity: any;
        isManualOnly: boolean;
        maxAwards?: number | undefined;
    }) => {
        const admin = ensureModerator(ctx);

        if (!name || name.trim() === '') {
            throw new SenderError('Achievement name must not be empty.');
        }

        const existing = ctx.db.Achievement.name.find(name);
        if (existing) {
            throw new SenderError('Achievement with this name already exists.');
        }

        ctx.db.Achievement.insert(insertWithAudit(ctx, {
            id: 0,
            name,
            description,
            rarity,
            isManualOnly,
            maxAwards,
        }, admin.id));

        console.log(`[ACHIEVEMENT] Created "${name}" by admin #${admin.id}`);
    }
);

// ─── update_achievement ──────────────────────────────────────────────────────
// Updates name/description/rarity on an achievement. (D-24)
// Permission: Moderator+ (Admin or Moderator)
// These fields are editable at any time — no criteria lock applies to metadata.

export const update_achievement = spacetimedb.reducer(
    {
        achievementId: t.u32(),
        name: t.string().optional(),
        description: t.string().optional(),
        rarity: AchievementRarity,
    },
    (ctx, { achievementId, name, description, rarity }: {
        achievementId: number;
        name?: string | undefined;
        description?: string | undefined;
        rarity: any | undefined;
    }) => {
        const admin = ensureModerator(ctx);

        const existing = ctx.db.Achievement.id.find(achievementId);
        if (!existing) {
            throw new SenderError(`Achievement #${achievementId} not found.`);
        }

        // If name is changing, verify the new name is unique
        if (name !== undefined && name !== existing.name) {
            const conflict = ctx.db.Achievement.name.find(name);
            if (conflict) {
                throw new SenderError('Achievement with this name already exists.');
            }
        }

        ctx.db.Achievement.id.update(updateWithAudit(ctx, existing, {
            name: name ?? existing.name,
            description: description ?? existing.description,
            rarity: rarity ?? existing.rarity,
        }, admin.id));

        console.log(`[ACHIEVEMENT] Updated achievement #${achievementId} by admin #${admin.id}`);
    }
);

// ─── delete_achievement ──────────────────────────────────────────────────────
// Cascade deletes an achievement: criteria rows, UserAchievement rows,
// User.displayedAchievementId clears, then the Achievement row. (D-23)

export const delete_achievement = spacetimedb.reducer(
    {
        achievementId: t.u32(),
    },
    (ctx, { achievementId }: { achievementId: number }) => {
        const admin = ensureAdmin(ctx);

        const achievement = ctx.db.Achievement.id.find(achievementId);
        if (!achievement) {
            throw new SenderError(`Achievement #${achievementId} not found.`);
        }

        // CASCADE step 1: Delete all AchievementCriteria rows
        const criteria = [...ctx.db.AchievementCriteria.by_achievement.filter(achievementId)];
        for (const c of criteria) {
            ctx.db.AchievementCriteria.id.delete(c.id);
        }

        // CASCADE step 2: Delete all UserAchievement rows
        const userAchievements = [...ctx.db.UserAchievement.by_achievement.filter(achievementId)];
        for (const ua of userAchievements) {
            ctx.db.UserAchievement.id.delete(ua.id);
        }

        // CASCADE step 3: Clear User.displayedAchievementId where it matches.
        // User table is small (<1000 rows in prod); iter() is acceptable here.
        for (const user of [...ctx.db.User.iter()]) {
            if (user.displayedAchievementId === achievementId) {
                ctx.db.User.id.update(updateWithAudit(ctx, user, {
                    displayedAchievementId: undefined,
                }, admin.id));
            }
        }

        // CASCADE step 4: Delete the Achievement row
        ctx.db.Achievement.id.delete(achievementId);

        console.log(`[ACHIEVEMENT] Deleted achievement #${achievementId} with cascade by admin #${admin.id}`);
    }
);

// ─── add_achievement_criteria ────────────────────────────────────────────────
// Adds a criteria row to an achievement. Locked once any player has earned it. (D-25)
// Permission: Moderator+ (Admin or Moderator)

export const add_achievement_criteria = spacetimedb.reducer(
    {
        achievementId: t.u32(),
        statTable: t.string(),
        statField: t.string(),
        operator: ComparisonOperator,
        thresholdValue: t.u32(),
        filterGameMode: t.string().optional(),
        filterCharacterName: t.string().optional(),
        filterMatchType: t.string().optional(),
    },
    (ctx, { achievementId, statTable, statField, operator, thresholdValue, filterGameMode, filterCharacterName, filterMatchType }: {
        achievementId: number;
        statTable: string;
        statField: string;
        operator: any;
        thresholdValue: number;
        filterGameMode?: string | undefined;
        filterCharacterName?: string | undefined;
        filterMatchType?: string | undefined;
    }) => {
        const admin = ensureModerator(ctx);

        const achievement = ctx.db.Achievement.id.find(achievementId);
        if (!achievement) {
            throw new SenderError(`Achievement #${achievementId} not found.`);
        }

        // Criteria lock: cannot modify once any player has earned this achievement (D-25)
        const existingAwards = [...ctx.db.UserAchievement.by_achievement.filter(achievementId)];
        if (existingAwards.length > 0) {
            throw new SenderError('Cannot modify criteria: players have already earned this achievement.');
        }

        // Validate statTable is a supported resolver target
        const validStatTables = ['PlayerStat', 'PlayerCharacterStat', 'MmrRating'];
        if (!validStatTables.includes(statTable)) {
            throw new SenderError(`Invalid statTable "${statTable}". Must be one of: ${validStatTables.join(', ')}.`);
        }

        ctx.db.AchievementCriteria.insert(insertWithAudit(ctx, {
            id: 0,
            achievementId,
            statTable,
            statField,
            operator,
            thresholdValue,
            filterGameMode,
            filterCharacterName,
            filterMatchType,
        }, admin.id));

        console.log(`[ACHIEVEMENT] Added criteria to achievement #${achievementId}: ${statTable}.${statField} by admin #${admin.id}`);
    }
);

// ─── remove_achievement_criteria ────────────────────────────────────────────
// Removes a criteria row. Locked once any player has earned the achievement. (D-25)
// Permission: Moderator+ (Admin or Moderator)

export const remove_achievement_criteria = spacetimedb.reducer(
    {
        criteriaId: t.u32(),
    },
    (ctx, { criteriaId }: { criteriaId: number }) => {
        const admin = ensureModerator(ctx);

        const criteria = ctx.db.AchievementCriteria.id.find(criteriaId);
        if (!criteria) {
            throw new SenderError(`AchievementCriteria #${criteriaId} not found.`);
        }

        // Criteria lock: cannot modify once any player has earned this achievement (D-25)
        const existingAwards = [...ctx.db.UserAchievement.by_achievement.filter(criteria.achievementId)];
        if (existingAwards.length > 0) {
            throw new SenderError('Cannot modify criteria: players have already earned this achievement.');
        }

        ctx.db.AchievementCriteria.id.delete(criteriaId);

        console.log(`[ACHIEVEMENT] Removed criteria #${criteriaId} from achievement #${criteria.achievementId} by admin #${admin.id}`);
    }
);

// ─── manual_award_achievement ────────────────────────────────────────────────
// Manually awards an achievement to a user. (D-21)
// Permission: Admin/Moderator unrestricted; TournamentHost restricted to own tournament participants.

export const manual_award_achievement = spacetimedb.reducer(
    {
        achievementId: t.u32(),
        targetUserId: t.u32(),
    },
    (ctx, { achievementId, targetUserId }: { achievementId: number; targetUserId: number }) => {
        const caller = getAuthenticatedUser(ctx);

        if (isRoleAtLeast(caller.role, 'Moderator')) {
            // Admin/Moderator — unrestricted
        } else if (isRoleAtLeast(caller.role, 'TournamentHost')) {
            // TournamentHost — restricted to own tournament participants (TournamentEnrolled)
            // Uses Tournament.organizer_id btree index (NOT hostUserId — the field is organizerId)
            const callerTournaments = [...ctx.db.Tournament.organizer_id.filter(caller.id)];
            const isParticipant = callerTournaments.some(
                (tournament: any) => [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournament.id, targetUserId])].length > 0
            );
            if (!isParticipant) {
                throw new SenderError('Forbidden: Target user is not a participant in your tournaments.');
            }
        } else {
            throw new SenderError('Forbidden: Requires Moderator, Admin, or Tournament Host privileges.');
        }

        const achievement = ctx.db.Achievement.id.find(achievementId);
        if (!achievement) {
            throw new SenderError(`Achievement #${achievementId} not found.`);
        }

        // Per-user duplicate check
        const alreadyEarned = [...ctx.db.UserAchievement.by_user_achievement.filter([targetUserId, achievementId])];
        if (alreadyEarned.length > 0) {
            throw new SenderError('User has already earned this achievement.');
        }

        // Global cap check (D-04)
        if (achievement.maxAwards !== undefined) {
            const totalAwarded = [...ctx.db.UserAchievement.by_achievement.filter(achievementId)].length;
            if (totalAwarded >= achievement.maxAwards) {
                throw new SenderError(`Achievement "${achievement.name}" has reached its global award limit (${achievement.maxAwards}).`);
            }
        }

        // Verify target user exists
        const targetUser = ctx.db.User.id.find(targetUserId);
        if (!targetUser) {
            throw new SenderError(`User #${targetUserId} not found.`);
        }

        ctx.db.UserAchievement.insert(insertWithAudit(ctx, {
            id: 0,
            userId: targetUserId,
            achievementId,
            awardedById: caller.id,
        }, caller.id));

        console.log(`[ACHIEVEMENT] Manually awarded "${achievement.name}" to user #${targetUserId} by user #${caller.id}`);
    }
);

// ─── set_displayed_achievement ───────────────────────────────────────────────
// Sets or clears a user's displayed achievement title. (D-22)
// User: can set own title (must have earned it).
// Admin: can set title for any user.
// Pass achievementId=undefined (or 0) to clear the title.

export const set_displayed_achievement = spacetimedb.reducer(
    {
        targetUserId: t.u32().optional(),
        achievementId: t.u32().optional(),
    },
    (ctx, { targetUserId, achievementId }: {
        targetUserId?: number | undefined;
        achievementId?: number | undefined;
    }) => {
        const caller = getAuthenticatedUser(ctx);

        // Determine effectiveUserId: if targetUserId not provided or 0, use caller
        const effectiveUserId = (targetUserId !== undefined && targetUserId !== 0) ? targetUserId : caller.id;

        if (effectiveUserId !== caller.id) {
            // Setting another user's title requires Admin
            if (!isRoleAtLeast(caller.role, 'Admin')) {
                throw new SenderError('Forbidden: Only admins can set titles for other users.');
            }
        } else {
            // Setting own title — must not be a guest
            if (caller.isGuest) {
                throw new SenderError('Guests cannot set displayed achievements.');
            }
        }

        const targetUser = ctx.db.User.id.find(effectiveUserId);
        if (!targetUser) {
            throw new SenderError(`User #${effectiveUserId} not found.`);
        }

        if (achievementId !== undefined && achievementId !== 0) {
            // Validate achievement exists
            const achievement = ctx.db.Achievement.id.find(achievementId);
            if (!achievement) {
                throw new SenderError(`Achievement #${achievementId} not found.`);
            }

            // Verify user has earned this achievement
            const earned = [...ctx.db.UserAchievement.by_user_achievement.filter([effectiveUserId, achievementId])];
            if (earned.length === 0) {
                throw new SenderError('User has not earned this achievement.');
            }

            ctx.db.User.id.update(updateWithAudit(ctx, targetUser, {
                displayedAchievementId: achievementId,
            }, caller.id));

            console.log(`[ACHIEVEMENT] User #${effectiveUserId} set displayed achievement #${achievementId} by user #${caller.id}`);
        } else {
            // Clearing title
            ctx.db.User.id.update(updateWithAudit(ctx, targetUser, {
                displayedAchievementId: undefined,
            }, caller.id));

            console.log(`[ACHIEVEMENT] User #${effectiveUserId} cleared displayed achievement by user #${caller.id}`);
        }
    }
);
