/** Search params of `/standby`: `module` names the requested section. */
export type StandbySearch = { module?: string };

/**
 * `validateSearch` for `/standby`. Search values arrive as plain text (`web/src/lib/searchParams.ts`);
 * an empty value or anything else (a repeated key, an array) is dropped, which also clears it from
 * the URL. `module` is always present (maybe undefined): the router merges the raw search under
 * the validated one, so a key left out would let a rejected raw value through.
 */
export function parseStandbySearch(search: Record<string, unknown>): StandbySearch {
    const { module } = search;
    return { module: typeof module === 'string' && module !== '' ? module : undefined };
}
