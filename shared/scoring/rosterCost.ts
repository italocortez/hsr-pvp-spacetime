// A21 roster cost per team, hundredths. The caller picks the inputs by draft mode:
// - Classic: each character's cost-table value at its eidolon (Pick.costPaid) and each light cone's value at
//   its superimposition (EquipLightcone.costPaid);
// - Auction: the budget actually spent, i.e. each winning bid (AuctionSold.winningAmount) and each light cone.
// Both then add the synergy surcharge. The formula is the same sum; only the sources differ.

export interface RosterCostInput {
    characterCosts: number[];
    lightconeCosts: number[];
    surcharge: number;
}

export function rosterCost(input: RosterCostInput): number {
    let total = input.surcharge;
    for (const c of input.characterCosts) total += c;
    for (const c of input.lightconeCosts) total += c;
    return total;
}
