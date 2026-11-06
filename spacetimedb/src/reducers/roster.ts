import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureVerifiedUser } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { validateUid, deriveRegion, recalcDuplicateUid } from '../helpers/rosterHelpers';
import { applyBatchUpsert, applyBatchRemove } from '../helpers/rosterMutations';

/**
 * D-G-02 (Phase 12.3): Builds a user-facing SenderError for the lobby-guard
 * rejections. Cites the first conflicting lobby's joinCode (fallback: lobby id)
 * so the user can find the match they need to leave.
 */
function buildLobbyGuardError(ctx: any, lmaRows: Array<{ lobbyId: number }>, verbPhrase: string): SenderError {
    const firstLobbyId = lmaRows[0].lobbyId;
    const lobby = ctx.db.Lobby.id.find(firstLobbyId);
    const lobbyLabel = lobby?.joinCode ? `lobby ${lobby.joinCode}` : `lobby #${firstLobbyId}`;
    return new SenderError(
        `Cannot ${verbPhrase} while you have an account selected in ${lobbyLabel}. Leave the lobby first.`
    );
}

// ─── create_hsr_account ───────────────────────────────────────────────────────
// Creates a new HSR account entry for the authenticated user.
// Validates UID format, derives region, enforces 5-account cap,
// auto-defaults label, and auto-activates if it is the user's first account.

export const create_hsr_account = spacetimedb.reducer(
    { uid: t.string(), displayLabel: t.string() },
    (ctx, { uid, displayLabel }) => {
        const user = ensureVerifiedUser(ctx);

        validateUid(uid);
        const region = deriveRegion(uid);

        const existing = [...ctx.db.HsrAccount.user_id.filter(user.id)];
        if (existing.length >= 5) {
            throw new SenderError('Maximum 5 HSR accounts per user');
        }

        const label = displayLabel.trim() || 'Account ' + (existing.length + 1);
        const isFirst = existing.length === 0;

        ctx.db.HsrAccount.insert(insertWithAudit(ctx, {
            id: 0,
            userId: user.id,
            uid,
            region,
            displayLabel: label,
            isActive: isFirst,
            isRosterPublic: false,
            isRatingPublic: false,
            isDuplicateUid: false,
            accountRating: 0,
        }, user.id));

        recalcDuplicateUid(ctx, uid, user.id);
    }
);

// ─── update_hsr_account ───────────────────────────────────────────────────────
// Updates display label and visibility toggles.
// UID and region are immutable — this reducer does NOT accept them.

export const update_hsr_account = spacetimedb.reducer(
    { hsrAccountId: t.u32(), displayLabel: t.string(), isRosterPublic: t.bool(), isRatingPublic: t.bool() },
    (ctx, { hsrAccountId, displayLabel, isRosterPublic, isRatingPublic }) => {
        const user = ensureVerifiedUser(ctx);

        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found');
        if (account.userId !== user.id) throw new SenderError('Not your account');

        const trimmed = displayLabel.trim();
        if (!trimmed) throw new SenderError('Display label cannot be empty');

        ctx.db.HsrAccount.id.update(updateWithAudit(ctx, account, {
            displayLabel: trimmed,
            isRosterPublic,
            isRatingPublic,
        }, user.id));
    }
);

// ─── set_active_hsr_account ───────────────────────────────────────────────────
// Sets the specified account as the active one, deactivating all others.

export const set_active_hsr_account = spacetimedb.reducer(
    { hsrAccountId: t.u32() },
    (ctx, { hsrAccountId }) => {
        const user = ensureVerifiedUser(ctx);

        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found');
        if (account.userId !== user.id) throw new SenderError('Not your account');

        // No-op if already active
        if (account.isActive) return;

        // D-G-01 (Phase 12.3, WIDE per research A1): reject when the target account
        // OR any of the caller's currently-active accounts is bound to a live lobby.
        // Covers two UX cases: (a) "I'm trying to activate an account that's already
        // bound to a live lobby" and (b) "I'm trying to swap OUT of an account that's
        // bound to a live lobby". Snapshot from Plan 01 already makes the system
        // correct — this guard exists for clarity (D-G-03).
        const targetBinding = [...ctx.db.LobbyMemberAccount.by_account.filter(hsrAccountId)];
        if (targetBinding.length > 0) {
            throw buildLobbyGuardError(ctx, targetBinding, 'change your active account');
        }
        const allBindings = ctx.db.HsrAccount.user_id.filter(user.id);
        for (const acc of allBindings) {
            if (!acc.isActive) continue;
            const activeBinding = [...ctx.db.LobbyMemberAccount.by_account.filter(acc.id)];
            if (activeBinding.length > 0) {
                throw buildLobbyGuardError(ctx, activeBinding, 'change your active account');
            }
        }

        const allAccounts = [...ctx.db.HsrAccount.user_id.filter(user.id)];
        for (const acc of allAccounts) {
            if (acc.isActive && acc.id !== hsrAccountId) {
                ctx.db.HsrAccount.id.update(updateWithAudit(ctx, acc, { isActive: false }, user.id));
            }
        }

        ctx.db.HsrAccount.id.update(updateWithAudit(ctx, account, { isActive: true }, user.id));
    }
);

// ─── delete_hsr_account ───────────────────────────────────────────────────────
// Deletes an HSR account with cascade to characters.
// If the deleted account was active, auto-activates the oldest remaining.

export const delete_hsr_account = spacetimedb.reducer(
    { hsrAccountId: t.u32() },
    (ctx, { hsrAccountId }) => {
        const user = ensureVerifiedUser(ctx);

        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found');
        if (account.userId !== user.id) throw new SenderError('Not your account');

        // D-24: Block deletion if account is currently selected in an active lobby
        const activeLma = [...ctx.db.LobbyMemberAccount.by_account.filter(hsrAccountId)];
        if (activeLma.length > 0) {
            throw new SenderError('Cannot delete an account that is selected in an active lobby. Leave the lobby first.');
        }

        // D-24: Block if account is locked in an active tournament
        const tpaEntries = [...ctx.db.TournamentPlayerAccount.by_user.filter(user.id)]
            .filter((e: any) => e.hsrAccountId === hsrAccountId);
        for (const tpa of tpaEntries) {
            const tournament = ctx.db.Tournament.id.find(tpa.tournamentId);
            if (tournament && tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled') {
                throw new SenderError('Cannot delete an account locked in an active tournament. Wait for the tournament to complete or be cancelled.');
            }
        }

        const uid = account.uid;

        // Cascade: delete all characters for this account
        const characters = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(hsrAccountId)];
        for (const char of characters) {
            ctx.db.HsrAccountCharacter.delete(char);
        }

        ctx.db.HsrAccount.id.delete(hsrAccountId);

        // Auto-activate oldest remaining if this was the active account
        if (account.isActive) {
            const remaining = [...ctx.db.HsrAccount.user_id.filter(user.id)];
            if (remaining.length > 0) {
                remaining.sort((a: any, b: any) =>
                    Number(a.createdDate.microsSinceUnixEpoch - b.createdDate.microsSinceUnixEpoch)
                );
                ctx.db.HsrAccount.id.update(updateWithAudit(ctx, remaining[0], {
                    isActive: true,
                }, user.id));
            }
        }

        recalcDuplicateUid(ctx, uid, user.id);
    }
);

// ─── batch_upsert_characters ──────────────────────────────────────────────────
// Atomically upserts multiple characters on an account.
// Phase 1 validates ALL items before Phase 2 writes ANY — all-or-nothing.

export const batch_upsert_characters = spacetimedb.reducer(
    { hsrAccountId: t.u32(), charactersJson: t.string() },
    (ctx, { hsrAccountId, charactersJson }) => {
        const user = ensureVerifiedUser(ctx);

        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found');
        if (account.userId !== user.id) throw new SenderError('Not your account');

        // D-G-01 (Phase 12.3, NARROW per research A2): reject when the specific
        // target account is bound to a live lobby. Existing `by_account` index is
        // sufficient — no new `by_user` index (C11).
        const hsrAccountBinding = [...ctx.db.LobbyMemberAccount.by_account.filter(hsrAccountId)];
        if (hsrAccountBinding.length > 0) {
            throw buildLobbyGuardError(ctx, hsrAccountBinding, 'edit characters on this account');
        }

        const items: Array<{ characterName: string; eidolonLevel: number }> = JSON.parse(charactersJson);

        // D-D-02 (Phase 12.3): delegate to shared helper — validates items against
        // HsrCharacter + eidolon range, upserts via composite-PK delete+insert, then
        // recomputes accountRating. Single source of truth for "mutate chars + recompute".
        applyBatchUpsert(ctx, hsrAccountId, items, user.id);
    }
);

// ─── batch_remove_characters ──────────────────────────────────────────────────
// Atomically removes multiple characters from an account.
// Validates ALL names exist before deleting ANY — all-or-nothing.

export const batch_remove_characters = spacetimedb.reducer(
    { hsrAccountId: t.u32(), characterNamesJson: t.string() },
    (ctx, { hsrAccountId, characterNamesJson }) => {
        const user = ensureVerifiedUser(ctx);

        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found');
        if (account.userId !== user.id) throw new SenderError('Not your account');

        // D-G-01 (Phase 12.3, NARROW per research A2): reject when the target account
        // is bound to a live lobby.
        const hsrAccountBinding = [...ctx.db.LobbyMemberAccount.by_account.filter(hsrAccountId)];
        if (hsrAccountBinding.length > 0) {
            throw buildLobbyGuardError(ctx, hsrAccountBinding, 'remove characters from this account');
        }

        const names: string[] = JSON.parse(characterNamesJson);

        // D-D-02 (Phase 12.3): delegate to shared helper.
        applyBatchRemove(ctx, hsrAccountId, names, user.id);
    }
);

// ─── migrate_roster ───────────────────────────────────────────────────────────
// Migrates characters from one account to another.
// copy mode: upserts source characters into target (preserves source).
// move mode: same as copy, then deletes all source characters.

export const migrate_roster = spacetimedb.reducer(
    { sourceAccountId: t.u32(), targetAccountId: t.u32(), mode: t.string() },
    (ctx, { sourceAccountId, targetAccountId, mode }) => {
        const user = ensureVerifiedUser(ctx);

        if (mode !== 'copy' && mode !== 'move') {
            throw new SenderError('Mode must be "copy" or "move"');
        }

        const sourceAccount = ctx.db.HsrAccount.id.find(sourceAccountId);
        if (!sourceAccount) throw new SenderError('Source HSR account not found');
        if (sourceAccount.userId !== user.id) throw new SenderError('Not your account');

        const targetAccount = ctx.db.HsrAccount.id.find(targetAccountId);
        if (!targetAccount) throw new SenderError('Target HSR account not found');
        if (targetAccount.userId !== user.id) throw new SenderError('Not your account');

        if (sourceAccountId === targetAccountId) {
            throw new SenderError('Source and target cannot be the same account');
        }

        // D-G-01 (Phase 12.3): reject when EITHER side of the migration is bound
        // to a live lobby. Both accounts are mutated, so both must be checked.
        const sourceBinding = [...ctx.db.LobbyMemberAccount.by_account.filter(sourceAccountId)];
        if (sourceBinding.length > 0) {
            throw buildLobbyGuardError(ctx, sourceBinding, 'migrate characters from this account');
        }
        const targetBinding = [...ctx.db.LobbyMemberAccount.by_account.filter(targetAccountId)];
        if (targetBinding.length > 0) {
            throw buildLobbyGuardError(ctx, targetBinding, 'migrate characters to this account');
        }

        const sourceChars = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(sourceAccountId)];
        if (sourceChars.length === 0) {
            // Nothing to migrate — no rating change needed either.
            return;
        }

        // D-D-03 (Phase 12.3): upsert source characters into target via the shared
        // helper. This also recomputes the target's accountRating — fixing the pre-existing
        // latent bug where migrate_roster never called updateAccountRating (D-D-04).
        const itemsForTarget = sourceChars.map(c => ({
            characterName: c.characterName,
            eidolonLevel: c.eidolonLevel,
        }));
        applyBatchUpsert(ctx, targetAccountId, itemsForTarget, user.id);

        // Move mode: also remove from source, which recomputes source's rating.
        if (mode === 'move') {
            const namesToRemove = sourceChars.map(c => c.characterName);
            applyBatchRemove(ctx, sourceAccountId, namesToRemove, user.id);
        }
    }
);
