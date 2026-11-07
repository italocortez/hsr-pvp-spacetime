// A21 precision rule (settled S7): every score, handicap and cost is compared as an integer number of
// hundredths of the game mode's unit. Floats appear only at the boundary: the cost tables stay t.f32()
// (A21) and are converted once with toHundredths; nothing else in this module does float arithmetic.

/** f32 / f64 value → integer hundredths, rounded to the nearest hundredth (half away from zero). */
export function toHundredths(value: number): number {
    const scaled = Math.round(Math.abs(value) * 100);
    return value < 0 ? -scaled : scaled;
}

/** Integer hundredths → display value (the only float the module produces, for the UI). */
export function fromHundredths(hundredths: number): number {
    return hundredths / 100;
}

/** a × b / 100 for two hundredths values, truncated toward zero; BigInt so the product cannot lose precision. */
export function mulHundredths(a: number, b: number): number {
    return Number((BigInt(a) * BigInt(b)) / 100n);
}
