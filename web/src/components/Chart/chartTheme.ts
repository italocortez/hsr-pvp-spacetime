/*
 * Theme references in a chart configuration (S14.5c). A model writes colours and font families as `'var(--name)'`;
 * before each draw the wrapper copies the configuration with every such string replaced by the value the chart's
 * element computes for it (`resolveConfig`). Functions (callbacks, scriptable options) and non-plain objects are kept
 * as they are; nothing in the model's object is changed.
 *
 * `cssReader` resolves through a hidden probe inside the chart, so a custom property that holds another `var()`, a
 * system colour (forced colours: `CanvasText`) or `rgba()` reaches the canvas as one computed colour. The probe has
 * `forced-color-adjust: none`, so forced colours do not overwrite the authored hues; the forced palette comes from
 * the custom properties the stylesheets redefine under `@media (forced-colors: active)`.
 */

const REF = /^var\((--[\w-]+)\)$/;

export type ThemeKind = 'color' | 'font';
export type ThemeReader = (name: string, kind: ThemeKind) => string;

const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;

export function resolveConfig<T>(value: T, read: ThemeReader, key = ''): T {
    if (typeof value === 'string') {
        const m = REF.exec(value);
        return (m ? read(m[1] as string, key === 'family' ? 'font' : 'color') : value) as T;
    }
    if (Array.isArray(value)) {
        // Data arrays of numbers are copied as they are (no walk per value).
        if (value.every((v) => typeof v !== 'string' && !isPlain(v) && !Array.isArray(v)))
            return value.slice() as T;
        return value.map((v) => resolveConfig(v, read, key)) as T;
    }
    if (isPlain(value)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = resolveConfig(v, read, k);
        return out as T;
    }
    return value;
}

/** Reads `--name` as the probe computes it; falls back to the raw custom property of `root`. */
export function cssReader(root: HTMLElement, probe: HTMLElement): ThemeReader {
    return (name, kind) => {
        const ref = `var(${name})`;
        if (kind === 'font') {
            probe.style.fontFamily = ref;
            const v = getComputedStyle(probe).fontFamily;
            probe.style.fontFamily = '';
            if (v && !v.includes('var(')) return v;
        } else {
            probe.style.color = ref;
            const v = getComputedStyle(probe).color;
            probe.style.color = '';
            if (v && !v.includes('var(')) return v;
        }
        return getComputedStyle(root).getPropertyValue(name).trim();
    };
}
