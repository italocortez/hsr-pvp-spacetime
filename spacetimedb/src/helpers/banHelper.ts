import { SenderError } from 'spacetimedb/server';

/**
 * A46 (S3): bans are keyed by loginMethod + providerId, the shape of the token claims
 * (`login_method`, `provider_id`). Discord is the only login method accepted at launch.
 */
export const DISCORD_LOGIN_METHOD = 'discord';

/**
 * Check if a provider id is banned for the given login method.
 *
 * WR-01: MUST filter by loginMethod, not just providerId alone (prevents
 * cross-provider false positives). Uses the single-column provider_id index,
 * then filters loginMethod in memory (the by_method_and_provider index is the
 * M5 replacement once the multi-column filter is re-verified on 2.14.1).
 */
export function checkProviderBan(ctx: any, loginMethod: string, providerId: string): boolean {
    const matches = [...ctx.db.BanRecord.provider_id.filter(providerId)];
    return matches.some((r: any) => r.loginMethod === loginMethod);
}

/**
 * Throws SenderError if the provider id is banned for the given login method.
 * Convenience wrapper for use in reducers.
 */
export function rejectIfBanned(ctx: any, loginMethod: string, providerId: string): void {
    if (checkProviderBan(ctx, loginMethod, providerId)) {
        throw new SenderError(`This ${loginMethod} account is banned and cannot be linked.`);
    }
}
