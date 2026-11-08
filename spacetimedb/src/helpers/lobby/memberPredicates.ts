// Pure LobbyMember / LobbySlot predicates with no module imports, shared by lobbyHelpers (which re-exports them) and
// flagTransferHelpers, so the two helpers do not import each other (S8f: the module's one import cycle removed).

/** A68(2)(4): the row is away (`leftAt`) or abandoned (`abandonedAt`): offline whatever the presence rows say. */
export function memberHasLeft(member: any): boolean {
    return member.leftAt !== undefined || member.abandonedAt !== undefined;
}

/** Get team from LobbySlot: BluePlayer→'Blue', RedCoach→'Red', Spectator→null */
export function slotTeam(slot: any): string | null {
    const tag: string = slot.tag;
    if (tag.startsWith('Blue')) return 'Blue';
    if (tag.startsWith('Red')) return 'Red';
    return null;
}
