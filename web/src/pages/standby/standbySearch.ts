/** Search params of `/standby`: `module` names the requested section. */
export type StandbySearch = { module?: string };

/**
 * `validateSearch` for `/standby`. The default search parser turns JSON-looking values into
 * numbers, booleans or objects: scalars are kept as text, anything else is dropped. `module` is
 * always present (maybe undefined): the router merges the raw search under the validated one,
 * so a key left out would let a rejected raw value through.
 */
export function parseStandbySearch(search: Record<string, unknown>): StandbySearch {
    const { module } = search;
    const isScalar =
        typeof module === 'string' || typeof module === 'number' || typeof module === 'boolean';
    return { module: isScalar ? String(module) : undefined };
}
