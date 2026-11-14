/** The largest `u32`, the type of `Lobby.id`. */
export const U32_MAX = 4_294_967_295;

/**
 * The `$lobbyId` route param as a number when it is decimal digits only (at most 10, no sign,
 * no spaces, no exponent, no leading zero, not `0`) within the `u32` range; otherwise undefined
 * (the not-found page). One address per lobby: `/lobby/007` is not `/lobby/7`.
 */
export function parseLobbyId(raw: unknown): number | undefined {
    if (typeof raw !== 'string' || !/^[1-9][0-9]{0,9}$/.test(raw)) return undefined;
    const id = Number(raw);
    return id <= U32_MAX ? id : undefined;
}
