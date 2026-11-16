import { Fragment, type RefObject, useEffect, useRef, useState } from 'react';
import { RarityBadge } from '@/components/RarityBadge/RarityBadge';
import { RemoteImage } from '@/components/RemoteImage/RemoteImage';
import hidden from '@/styles/visuallyHidden.module.css';
import { ChevronRightIcon, ChevronUpIcon, NoResultsIcon } from './CostIcons';
import styles from './CostTable.module.css';
import {
    type CharacterRow,
    EIDOLON_KEYS,
    formatCost,
    formatModifier,
    type LightconeRow,
    PATH_LABEL,
    SUPERIMPOSITION_KEYS,
} from './costModel';
import type { SortDir, SortKey, Tab } from './costsSearch';
import type { TableState } from './useCostsPage';

/*
 * The cost table (the mockup's `.tableWrap` + `table.cost`), page-level: a semantic table in its
 * own scroller (`max-height: 74vh`, sticky header inside it, the mockup's edge shadows for
 * sideways overflow). Sortable headers follow web-guidance ui-behaviors/sortable-table.md: a
 * button inside each `th scope="col"`, `aria-sort` on the sorted column only, a decorative
 * direction icon, the caption as the table's name. Each row's name cell is its row header
 * (`th scope="row"`). Rows are keyed, so a sort moves the existing `tr` elements (focus inside
 * a row survives). The scroller is a named region and becomes a Tab stop when it can scroll
 * (responsive-table.md), so the keyboard can scroll it.
 */

type Column = { key: SortKey; label: string };

export const CHARACTER_COLUMNS: readonly Column[] = [
    { key: 'name', label: 'Character' },
    { key: 'rarity', label: 'Rarity' },
    ...EIDOLON_KEYS.map((k) => ({ key: k, label: k.toUpperCase() })),
];
export const LIGHTCONE_COLUMNS: readonly Column[] = [
    { key: 'name', label: 'Light Cone' },
    { key: 'rarity', label: 'Rarity' },
    ...SUPERIMPOSITION_KEYS.map((k) => ({ key: k, label: k.toUpperCase() })),
];

/** Skeleton rows while loading: fixed height (the data row's), so nothing shifts. */
const SKELETON_ROWS = 10;

export type CostTableProps = {
    tab: Tab;
    rows: readonly CharacterRow[] | readonly LightconeRow[];
    state: TableState;
    sort: SortKey;
    dir: SortDir;
    onSort: (column: SortKey) => void;
    expanded: ReadonlySet<string>;
    onToggleExpanded: (name: string) => void;
    captionId: string;
    caption: string;
    hasFilters: boolean;
    onClearFilters: () => void;
    onRetry: () => void;
    idPrefix: string;
};

export function CostTable(props: CostTableProps) {
    const { tab, state, sort, dir, onSort, captionId, caption } = props;
    const columns = tab === 'characters' ? CHARACTER_COLUMNS : LIGHTCONE_COLUMNS;
    const scroller = useRef<HTMLElement>(null);
    const scrollable = useScrollable(scroller);

    return (
        // A named section is a region landmark (responsive-table.md: role="region").
        <section
            ref={scroller}
            className={styles.wrap}
            aria-labelledby={captionId}
            // A Tab stop while it can scroll; otherwise focusable from script only (after Retry).
            tabIndex={scrollable ? 0 : -1}
        >
            <table
                className={styles.table}
                data-tab={tab}
                aria-busy={state === 'loading' || undefined}
            >
                <caption id={captionId} className={hidden.visuallyHidden}>
                    {caption}
                </caption>
                <thead>
                    <tr>
                        {columns.map((col, i) => {
                            const active = sort === col.key;
                            return (
                                <th
                                    key={col.key}
                                    scope="col"
                                    className={styles.th}
                                    data-first={i === 0 || undefined}
                                    data-active={active || undefined}
                                    aria-sort={
                                        active
                                            ? dir === 'asc'
                                                ? 'ascending'
                                                : 'descending'
                                            : undefined
                                    }
                                >
                                    <button
                                        type="button"
                                        className={styles.thBtn}
                                        title={`Sort by ${col.label}`}
                                        onClick={() => onSort(col.key)}
                                    >
                                        <span className={styles.thLabel}>{col.label}</span>
                                        <ChevronUpIcon className={styles.sortIcon} />
                                    </button>
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    <Body
                        {...props}
                        columnCount={columns.length}
                        // Retry removes its own button: focus goes to the table's region.
                        onRetry={() => {
                            props.onRetry();
                            scroller.current?.focus();
                        }}
                    />
                </tbody>
            </table>
        </section>
    );
}

function Body(props: CostTableProps & { columnCount: number }) {
    const { state, rows, tab, columnCount } = props;
    if (state === 'loading') {
        return (
            <>
                {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
                    <tr key={i} className={styles.skeletonRow}>
                        <td className={styles.td} data-first>
                            <span className={styles.nameCell}>
                                <span className={styles.expandSpacer} />
                                <span className={styles.skeletonThumb} />
                                <span className={styles.skeletonText} />
                            </span>
                        </td>
                        {Array.from({ length: columnCount - 1 }, (_, j) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder cells
                            <td key={j} className={styles.td}>
                                <span className={styles.skeletonCost} />
                            </td>
                        ))}
                    </tr>
                ))}
            </>
        );
    }
    if (state === 'error') {
        return (
            <tr>
                <td className={styles.emptyCell} colSpan={columnCount}>
                    <div className={styles.emptyState}>
                        <p>The cost table could not be loaded.</p>
                        <button type="button" className={styles.emptyClear} onClick={props.onRetry}>
                            Retry
                        </button>
                    </div>
                </td>
            </tr>
        );
    }
    if (rows.length === 0) {
        const noun = tab === 'characters' ? 'characters' : 'light cones';
        return (
            <tr>
                <td className={styles.emptyCell} colSpan={columnCount}>
                    <div className={styles.emptyState}>
                        <NoResultsIcon className={styles.emptyIcon} />
                        <p>
                            {props.hasFilters
                                ? `No ${noun} match these filters.`
                                : `No ${noun} in this cost table yet.`}
                        </p>
                        {props.hasFilters && (
                            <button
                                type="button"
                                className={styles.emptyClear}
                                onClick={props.onClearFilters}
                            >
                                Clear filters
                            </button>
                        )}
                    </div>
                </td>
            </tr>
        );
    }
    return tab === 'characters'
        ? (rows as readonly CharacterRow[]).map((row) => (
              <CharacterRows key={row.name} row={row} {...props} />
          ))
        : (rows as readonly LightconeRow[]).map((row) => (
              <LightconeTableRow key={row.name} row={row} sort={props.sort} />
          ));
}

function CostCells({
    costs,
    keys,
    sort,
}: {
    costs: Record<string, number> | undefined;
    keys: readonly string[];
    sort: SortKey;
}) {
    return (
        <>
            {keys.map((k) => {
                const v = costs?.[k];
                return (
                    <td key={k} className={styles.td} data-active={sort === k || undefined}>
                        {v === undefined ? <span className={styles.na}>n/a</span> : formatCost(v)}
                    </td>
                );
            })}
        </>
    );
}

function CharacterRows({
    row,
    sort,
    expanded,
    onToggleExpanded,
    idPrefix,
}: { row: CharacterRow } & CostTableProps) {
    const count = row.synergies.length;
    const open = count > 0 && expanded.has(row.name);
    const subId = (i: number | 'head' | 'paired' | 'extra') => `${idPrefix}-syn-${row.name}-${i}`;
    const controls = open
        ? [subId('head'), ...row.synergies.map((_s, i) => subId(i))].join(' ')
        : undefined;
    return (
        <Fragment>
            <tr className={styles.tr}>
                <th
                    scope="row"
                    className={styles.td}
                    data-first
                    data-active={sort === 'name' || undefined}
                >
                    <span className={styles.nameCell}>
                        {count > 0 ? (
                            <button
                                type="button"
                                className={styles.expandBtn}
                                aria-expanded={open}
                                aria-controls={controls}
                                aria-label={`Synergies for ${row.displayName}`}
                                onClick={() => onToggleExpanded(row.name)}
                            >
                                <ChevronRightIcon className={styles.expandIcon} />
                            </button>
                        ) : (
                            <span className={styles.expandSpacer} />
                        )}
                        <Thumb src={row.imageUrl} className={styles.portrait} />
                        <span className={styles.nameText}>{row.displayName}</span>
                        {count > 0 && (
                            <span className={styles.synBadge}>
                                <span aria-hidden="true">{'\u25C6'} </span>
                                {count}
                                <span className={hidden.visuallyHidden}>
                                    {count === 1 ? ' synergy' : ' synergies'}
                                </span>
                            </span>
                        )}
                    </span>
                </th>
                <td className={styles.td} data-active={sort === 'rarity' || undefined}>
                    <RarityBadge rarity={row.rarity} />
                </td>
                <CostCells costs={row.costs} keys={EIDOLON_KEYS} sort={sort} />
            </tr>
            {open && (
                <>
                    {/* The sub-rows' own headers: each sub-row cell names them in `headers`, so
                        the value reads as "Extra Cost", not as the column's "Rarity". */}
                    <tr className={styles.synHeadRow} id={subId('head')}>
                        <th className={styles.td} data-first id={subId('paired')}>
                            <span className={styles.synLabel} data-indent>
                                Paired Unit
                            </span>
                        </th>
                        <th className={styles.td} id={subId('extra')}>
                            <span className={styles.synLabel}>Extra Cost</span>
                        </th>
                        <td colSpan={EIDOLON_KEYS.length} />
                    </tr>
                    {row.synergies.map((partner, i) => (
                        <tr key={partner.name} className={styles.synRow} id={subId(i)}>
                            <td className={styles.td} data-first headers={subId('paired')}>
                                <span className={styles.synTarget}>
                                    <Thumb
                                        src={partner.imageUrl}
                                        className={styles.synThumb}
                                        small
                                    />
                                    {partner.displayName}
                                </span>
                            </td>
                            <td className={styles.td} headers={subId('extra')}>
                                <span className={styles.synCost}>
                                    {formatModifier(partner.modifier)}
                                </span>
                            </td>
                            <td colSpan={EIDOLON_KEYS.length} />
                        </tr>
                    ))}
                </>
            )}
        </Fragment>
    );
}

function LightconeTableRow({ row, sort }: { row: LightconeRow; sort: SortKey }) {
    return (
        <tr className={styles.tr}>
            <th
                scope="row"
                className={styles.td}
                data-first
                data-active={sort === 'name' || undefined}
            >
                <span className={styles.nameCell}>
                    {row.imageUrl ? (
                        <Thumb
                            src={row.imageUrl}
                            className={`${styles.portrait} ${styles.lcThumb}`}
                        />
                    ) : (
                        <img
                            className={styles.lcMark}
                            src={`/paths/${row.path}.webp`}
                            alt={PATH_LABEL[row.path]}
                            title={PATH_LABEL[row.path]}
                            width={26}
                            height={26}
                            loading="lazy"
                        />
                    )}
                    <span className={styles.nameText}>{row.displayName}</span>
                </span>
            </th>
            <td className={styles.td} data-active={sort === 'rarity' || undefined}>
                <RarityBadge rarity={row.rarity} />
            </td>
            <CostCells costs={row.costs} keys={SUPERIMPOSITION_KEYS} sort={sort} />
        </tr>
    );
}

/** A portrait or art thumbnail from UploadThing; an empty box when the row has no image. */
function Thumb({ src, className, small }: { src: string; className?: string; small?: boolean }) {
    const size = small ? 22 : 34;
    if (!src) return <span className={className} aria-hidden="true" />;
    return <RemoteImage src={src} alt="" width={size} height={size} className={className} />;
}

/** True while the element's content overflows it in either direction. */
function useScrollable(ref: RefObject<HTMLElement | null>): boolean {
    const [scrollable, setScrollable] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const check = () =>
            setScrollable(
                el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
            );
        const observer = new ResizeObserver(check);
        observer.observe(el);
        const table = el.firstElementChild;
        if (table) observer.observe(table);
        check();
        return () => observer.disconnect();
    }, [ref]);
    return scrollable;
}
