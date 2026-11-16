import { Fragment, type RefObject, useEffect, useRef, useState } from 'react';
import { RarityBadge } from '@/components/RarityBadge/RarityBadge';
import { RemoteImage } from '@/components/RemoteImage/RemoteImage';
import {
    type CollapseMeasure,
    collapseItem,
    reopenOnFocus,
    useScrollCollapse,
} from '@/lib/scrollCollapse';
import { customMediaQuery } from '@/shell/PhoneMenu';
import mediaCss from '@/styles/media.css?raw';
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
 * (`th scope="row"`), named by the name alone (`aria-labelledby`), so a cell is announced with
 * the character's or the cone's name and not with the expander's label or the badge's words.
 * Rows are keyed, so a sort moves the existing `tr` elements (focus inside a row survives). The
 * scroller is a named region and becomes a Tab stop when it can scroll (responsive-table.md),
 * so the keyboard can scroll it.
 *
 * On phones (the narrow step, 560px, and below) while the table can scroll sideways, the first
 * column is sticky and gives its room back as the viewer scrolls into the costs: the shared
 * scroll-linked collapse (`lib/scrollCollapse.ts`), this page its first user. Collapsed it keeps
 * the expander slot and the portrait (Characters) or the portrait (Light Cones).
 */

/** The narrow rule (`--bp-sm`): the collapsing name column applies at this width and below. */
export const NARROW_QUERY = customMediaQuery(mediaCss, '--bp-sm');

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

/** What the scroller's hooks read; injectable in tests (jsdom has no layout). */
export type TableMeasure = CollapseMeasure & { scrollHeight: number; clientHeight: number };

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
    /** Test seam: replaces the scroller's DOM measurements. */
    measure?: (el: HTMLElement) => TableMeasure;
};

/** The table, remounted per tab: each tab is its own table (scroll start, collapsed width). */
export function CostTable(props: CostTableProps) {
    return <TableScroller key={props.tab} {...props} />;
}

function TableScroller(props: CostTableProps) {
    const { tab, state, sort, dir, onSort, captionId, caption, measure } = props;
    const columns = tab === 'characters' ? CHARACTER_COLUMNS : LIGHTCONE_COLUMNS;
    const scroller = useRef<HTMLElement>(null);
    const scrollable = useScrollable(scroller, measure);
    const collapse = useScrollCollapse(scroller, NARROW_QUERY, measure);

    return (
        // A named section is a region landmark (responsive-table.md: role="region").
        <section
            ref={scroller}
            className={styles.wrap}
            aria-labelledby={captionId}
            // A Tab stop while it can scroll; otherwise focusable from script only (after Retry).
            tabIndex={scrollable ? 0 : -1}
            data-tab={tab}
            data-scroll-collapse={collapse}
            {...reopenOnFocus}
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
                                    className={i === 0 ? `${styles.th} ${collapseItem}` : styles.th}
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

/** A first-column cell's classes: the cell, and the collapsing item while the column collapses. */
const FIRST = `${styles.td} ${collapseItem}`;

function Body(props: CostTableProps & { columnCount: number }) {
    const { state, rows, tab, columnCount } = props;
    if (state === 'loading') {
        return (
            <>
                {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
                    <tr key={i} className={styles.skeletonRow}>
                        <td className={FIRST} data-first>
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
              <LightconeTableRow
                  key={row.name}
                  row={row}
                  sort={props.sort}
                  idPrefix={props.idPrefix}
              />
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
    const id = (part: string | number) => `${idPrefix}-${row.name}-${part}`;
    const controls = open
        ? [id('syn-head'), ...row.synergies.map((_s, i) => id(`syn-${i}`))].join(' ')
        : undefined;
    return (
        <Fragment>
            <tr className={styles.tr}>
                <th
                    scope="row"
                    id={id('row')}
                    aria-labelledby={id('name')}
                    className={FIRST}
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
                        <span id={id('name')} className={styles.nameText} title={row.displayName}>
                            {row.displayName}
                        </span>
                        {count > 0 && (
                            <span className={styles.synBadge}>
                                <span aria-hidden="true">{'◆'} </span>
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
                    {/* The sub-rows' own headers. Each partner is a header of its sub-row, and
                        its value names the character, the partner and "Extra Cost" in `headers`,
                        so it reads as "Clara, Huohuo, Extra Cost: −1", not under "Rarity". */}
                    <tr className={styles.synHeadRow} id={id('syn-head')}>
                        <th className={FIRST} data-first id={id('paired')}>
                            <span className={styles.synLabel} data-indent>
                                Paired Unit
                            </span>
                        </th>
                        <th className={styles.td} id={id('extra')}>
                            <span className={styles.synLabel}>Extra Cost</span>
                        </th>
                        <td colSpan={EIDOLON_KEYS.length} />
                    </tr>
                    {row.synergies.map((partner, i) => {
                        const value = formatModifier(partner.modifier);
                        return (
                            <tr key={partner.name} className={styles.synRow} id={id(`syn-${i}`)}>
                                <th
                                    className={FIRST}
                                    data-first
                                    id={id(`partner-${i}`)}
                                    headers={`${id('row')} ${id('paired')}`}
                                >
                                    {/* The value again in the collapsed column, drawn by CSS
                                        from `data-value` with empty alternative text: for the
                                        eye only, the value cell keeps it for AT. */}
                                    <span className={styles.synTarget} data-value={value}>
                                        <Thumb
                                            src={partner.imageUrl}
                                            className={styles.synThumb}
                                            small
                                        />
                                        <span className={styles.synName}>
                                            {partner.displayName}
                                        </span>
                                    </span>
                                </th>
                                <td
                                    className={styles.td}
                                    headers={`${id('row')} ${id(`partner-${i}`)} ${id('extra')}`}
                                >
                                    <span className={styles.synCost}>{value}</span>
                                </td>
                                <td colSpan={EIDOLON_KEYS.length} />
                            </tr>
                        );
                    })}
                </>
            )}
        </Fragment>
    );
}

function LightconeTableRow({
    row,
    sort,
    idPrefix,
}: {
    row: LightconeRow;
    sort: SortKey;
    idPrefix: string;
}) {
    const nameId = `${idPrefix}-${row.name}-name`;
    return (
        <tr className={styles.tr}>
            <th
                scope="row"
                aria-labelledby={nameId}
                className={FIRST}
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
                    <span id={nameId} className={styles.nameText} title={row.displayName}>
                        {row.displayName}
                    </span>
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
function useScrollable(
    ref: RefObject<HTMLElement | null>,
    measure?: (el: HTMLElement) => TableMeasure,
): boolean {
    const [scrollable, setScrollable] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const check = () => {
            const m = measure ? measure(el) : el;
            setScrollable(m.scrollWidth > m.clientWidth + 1 || m.scrollHeight > m.clientHeight + 1);
        };
        const observer =
            typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(check);
        observer?.observe(el);
        const table = el.firstElementChild;
        if (table) observer?.observe(table);
        check();
        return () => observer?.disconnect();
    }, [ref, measure]);
    return scrollable;
}
