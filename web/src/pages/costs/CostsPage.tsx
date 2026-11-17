import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { FilterChips } from '@/components/FilterChips/FilterChips';
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown/MultiSelectDropdown';
import { SearchField } from '@/components/SearchField/SearchField';
import {
    ControlSelect,
    SegmentedControl,
    tabId,
} from '@/components/SegmentedControl/SegmentedControl';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import hidden from '@/styles/visuallyHidden.module.css';
import { CostsIntro } from './CostsIntro';
import styles from './CostsPage.module.css';
import { CostTable } from './CostTable';
import {
    countNoun,
    DRAFT_LABEL,
    ELEMENT_LABEL,
    MODE_LABEL,
    MODE_SHORT,
    PATH_LABEL,
    ROLE_LABEL,
} from './costModel';
import {
    type CostsSearch,
    ELEMENTS,
    GAME_MODES,
    PATHS,
    RARITIES_BY_TAB,
    ROLES,
    SEARCH_MAX,
} from './costsSearch';
import { useAnnouncement } from './useAnnouncement';
import { useCostsPage } from './useCostsPage';

/*
 * The cost tables page (S14.2), a port of design/mockups/costs.html: the intro, the control bar
 * (table, draft mode, game mode, cost set), and the table card (count, filters, the table, the
 * footer line). Everything the viewer sets lives in the address (`costsSearch.ts`); the data and
 * the rules live in `useCostsPage` and `costModel.ts`.
 */

export const COSTS_TITLE = 'Cost Tables \u2014 IPC Battlegrounds';

export function CostsPage({ search }: { search: CostsSearch }) {
    useDocumentTitle(COSTS_TITLE);
    const page = useCostsPage(search);
    const { view, mode, actions } = page;
    const ids = useId();
    const tabsPrefix = `${ids}-tab`;
    const captionId = `${ids}-caption`;
    const isChars = view.tab === 'characters';
    const count = page.rows.length;
    const ready = page.tableState === 'ready';
    const setLabel = page.costSet?.name ?? 'Default';

    const fallbackNotice =
        page.noticeSet !== null
            ? `Cost set ${page.noticeSet} is not available. Showing the Default set.`
            : '';
    const announcement = useAnnouncement(
        ready ? `${count} ${countNoun(view.tab, count)} listed.` : '',
        ready,
        fallbackNotice,
    );

    // A clear removes the button that was pressed: focus goes to the search field, not the body.
    const searchRef = useRef<HTMLInputElement>(null);
    const clearFilters = () => {
        actions.clearFilters();
        searchRef.current?.focus();
    };

    const kind = isChars ? 'Character' : 'Light cone';
    const caption = `${kind} draft costs \u2014 ${setLabel} cost set, ${MODE_LABEL[mode]}, ${DRAFT_LABEL[view.draft]} draft. ${count} ${count === 1 ? 'row' : 'rows'}. Use the column headers to sort.`;

    return (
        <div className={styles.page}>
            <CostsIntro onToggle={page.dismissNotice} />
            <div className={styles.workspace}>
                <ControlBar page={page} tabsPrefix={tabsPrefix} />

                {fallbackNotice && <p className={styles.notice}>{fallbackNotice}</p>}

                <section
                    className={styles.card}
                    role="tabpanel"
                    aria-labelledby={tabId(tabsPrefix, view.tab)}
                >
                    <div className={styles.cardHead}>
                        <h2 className={styles.chapter}>
                            <strong>{isChars ? 'Character Costs' : 'Light Cone Costs'}</strong>
                        </h2>
                        <p className={styles.cardAside}>
                            {ready ? (
                                <>
                                    <b>{count}</b> {countNoun(view.tab, count)} listed
                                </>
                            ) : page.tableState === 'loading' ? (
                                'Loading'
                            ) : (
                                'Unavailable'
                            )}
                        </p>
                    </div>

                    <Filters page={page} searchRef={searchRef} onClear={clearFilters} />

                    <CostTable
                        tab={view.tab}
                        rows={page.rows}
                        state={page.tableState}
                        sort={view.sort}
                        dir={view.dir}
                        onSort={actions.sortBy}
                        expanded={page.expandedNames}
                        onToggleExpanded={page.toggleExpanded}
                        captionId={captionId}
                        caption={caption}
                        hasFilters={page.filterCount > 0}
                        onClearFilters={clearFilters}
                        onRetry={actions.retry}
                        idPrefix={ids}
                    />

                    <div className={styles.foot}>
                        <span>
                            {setLabel} {'\u00B7'} {DRAFT_LABEL[view.draft]} Draft {'\u00B7'}{' '}
                            {MODE_LABEL[mode]}
                        </span>
                        <span className={styles.footSynergy}>
                            {'\u25C6'} synergy pairings shown per draft mode
                        </span>
                    </div>
                </section>
            </div>
            <p role="status" className={hidden.visuallyHidden}>
                {announcement}
            </p>
        </div>
    );
}

type Page = ReturnType<typeof useCostsPage>;

function ControlBar({ page, tabsPrefix }: { page: Page; tabsPrefix: string }) {
    const { view, mode, actions, costSet } = page;
    const lockedReason = costSet
        ? `The cost set ${costSet.name} is for ${MODE_LABEL[mode]} only. Pick Default to change the game mode.`
        : undefined;
    return (
        <div className={styles.controlBar}>
            <SegmentedControl
                label="Table"
                semantics="tabs"
                tone="prestige"
                idPrefix={tabsPrefix}
                value={view.tab}
                onChange={actions.setTab}
                options={[
                    { value: 'characters', label: 'Characters' },
                    { value: 'lightcones', label: 'Light Cones' },
                ]}
            />
            <SegmentedControl
                label="Draft Mode"
                value={view.draft}
                onChange={actions.setDraft}
                options={[
                    { value: 'classic', label: 'Classic' },
                    { value: 'auction', label: 'Auction' },
                ]}
            />
            <SegmentedControl
                label="Game Mode"
                value={mode}
                onChange={actions.setMode}
                options={GAME_MODES.map((m) => ({
                    value: m,
                    label: MODE_SHORT[m],
                    ariaLabel: MODE_LABEL[m],
                    disabledReason: m === mode ? undefined : lockedReason,
                }))}
            />
            <ControlSelect
                label="Cost Set"
                value={String(costSet?.id ?? 0)}
                onChange={(e) => actions.setCostSet(Number(e.currentTarget.value))}
            >
                <option value="0">Default</option>
                {page.setsForMode.map((s) => (
                    <option key={s.id} value={String(s.id)}>
                        {s.isLocked ? `${s.name} (locked)` : s.name}
                    </option>
                ))}
            </ControlSelect>
        </div>
    );
}

function Filters({
    page,
    searchRef,
    onClear,
}: {
    page: Page;
    searchRef: RefObject<HTMLInputElement>;
    onClear: () => void;
}) {
    const { view, actions } = page;
    const isChars = view.tab === 'characters';
    // The field keeps what is typed (a leading space, say); the address keeps the search.
    const [text, setText] = useState(view.q);
    useEffect(() => {
        setText((current) => (current.trim() === view.q.trim() ? current : view.q));
    }, [view.q]);

    // Rendered in the archetype pair on Characters, on its own on Light Cones.
    const rarity = (
        <FilterChips
            label="Filter by rarity"
            options={RARITIES_BY_TAB[view.tab].map((r) => ({
                value: r,
                label: `${r}\u2605`,
                prestige: r === '5',
            }))}
            selected={view.rarity}
            onToggle={(v) => actions.toggle('rarity', v)}
        />
    );

    return (
        <search className={styles.filterRow} aria-label="Filters">
            <SearchField
                label="Search"
                inputRef={searchRef}
                value={text}
                maxLength={SEARCH_MAX}
                placeholder={isChars ? 'Search by name or alias\u2026' : 'Search light cones\u2026'}
                onChange={(value) => {
                    setText(value);
                    actions.setQuery(value);
                }}
            />
            {isChars && (
                <FilterChips
                    label="Filter by element"
                    wide
                    layout="fit"
                    options={ELEMENTS.map((e) => ({
                        value: e,
                        label: ELEMENT_LABEL[e],
                        icon: `/elements/${e}.webp`,
                    }))}
                    selected={view.el}
                    onToggle={(v) => actions.toggle('el', v)}
                />
            )}
            <FilterChips
                label="Filter by path"
                wide
                options={PATHS.map((p) => ({
                    value: p,
                    label: PATH_LABEL[p],
                    icon: `/paths/${p}.webp`,
                }))}
                selected={view.path}
                onToggle={(v) => actions.toggle('path', v)}
            />
            {isChars && (
                <FilterChips
                    label="Filter by role"
                    options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                    selected={view.role}
                    onToggle={(v) => actions.toggle('role', v)}
                />
            )}
            {isChars ? (
                // Archetype and rarity share one line on phones, whatever is picked.
                <div className={styles.pair}>
                    <MultiSelectDropdown
                        label="Archetype"
                        listLabel="Filter by archetype"
                        emptyText={page.setsReady ? 'No archetypes yet.' : 'Loading archetypes…'}
                        options={page.archetypeNames.map((name) => ({ value: name, label: name }))}
                        selected={view.arch}
                        onToggle={(v) => actions.toggle('arch', v)}
                    />
                    {rarity}
                </div>
            ) : (
                rarity
            )}
            {page.filterCount > 0 && (
                <button type="button" className={styles.clearChip} onClick={onClear}>
                    <span className={styles.clearWord}>Clear</span> {page.filterCount}{' '}
                    <span className={hidden.visuallyHidden}>
                        {page.filterCount === 1 ? 'filter' : 'filters'}
                    </span>
                    <span aria-hidden="true"> {'\u2715'}</span>
                </button>
            )}
        </search>
    );
}
