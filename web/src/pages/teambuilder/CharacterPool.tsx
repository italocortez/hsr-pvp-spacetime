import { type RefObject, useEffect, useState } from 'react';
import { FilterChips } from '@/components/FilterChips/FilterChips';
import { FilterSearch } from '@/components/FilterSearch/FilterSearch';
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown/MultiSelectDropdown';
import { RemoteImage } from '@/components/RemoteImage/RemoteImage';
import { MagnifierIcon } from '@/components/SearchField/SearchField';
import { ELEMENT_LABEL, PATH_LABEL, ROLE_LABEL } from '@/lib/rosterModel';
import { CHARACTER_RARITIES, ELEMENTS, PATHS, ROLES, SEARCH_MAX } from '@/lib/rosterSearch';
import styles from './CharacterPool.module.css';
import type { TeamBuilderView } from './teambuilderSearch';
import type { DataState, PoolCharacter } from './useTeamBuilderPage';

/*
 * The character pool (S14.3a; the mockup's `.poolBody`, `.filters`, `.poolGrid`, `.charCard`): the costs page's
 * filter row (search with Clear, element, path, role, then Archetype with rarity; A190 item 7) and a grid of cards.
 * A card is a toggle button (`aria-pressed` = on the team): a press adds the character to the first empty slot (or
 * the slot the sheet was opened from), a press on a picked card removes it. Portraits load lazily through
 * `RemoteImage` (the pool is below the fold at every width). The filter lines follow the costs page's rule: at a
 * given width they do not change when a filter is picked or Clear appears.
 */

export type PoolProps = {
    view: TeamBuilderView;
    pool: readonly PoolCharacter[];
    picked: ReadonlySet<string>;
    dataState: DataState;
    filterCount: number;
    archetypeNames: readonly string[];
    archetypesReady: boolean;
    fullHint: boolean;
    searchRef?: RefObject<HTMLInputElement>;
    onToggle: <K extends 'el' | 'path' | 'role' | 'rarity' | 'arch'>(
        key: K,
        value: TeamBuilderView[K][number],
    ) => void;
    onQuery: (text: string) => void;
    onClearFilters: () => void;
    onPick: (name: string) => void;
    onRetry: () => void;
};

const SKELETONS = Array.from({ length: 12 }, (_, i) => i);

export function CharacterPool(props: PoolProps) {
    const { view, pool, picked, dataState, filterCount } = props;
    const [text, setText] = useState(view.q);
    useEffect(() => {
        setText((current) => (current.trim() === view.q.trim() ? current : view.q));
    }, [view.q]);

    const clear = () => {
        props.onClearFilters();
        props.searchRef?.current?.focus();
    };

    return (
        <div className={styles.body}>
            <search className={styles.filterRow} aria-label="Pool filters">
                <FilterSearch
                    className={styles.searchGroup}
                    label="Search characters"
                    inputRef={props.searchRef}
                    value={text}
                    maxLength={SEARCH_MAX}
                    placeholder={'Search by name or alias…'}
                    onChange={(value) => {
                        setText(value);
                        props.onQuery(value);
                    }}
                    filterCount={filterCount}
                    onClear={clear}
                />
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
                    onToggle={(v) => props.onToggle('el', v)}
                />
                <FilterChips
                    label="Filter by path"
                    wide
                    options={PATHS.map((p) => ({
                        value: p,
                        label: PATH_LABEL[p],
                        icon: `/paths/${p}.webp`,
                    }))}
                    selected={view.path}
                    onToggle={(v) => props.onToggle('path', v)}
                />
                <FilterChips
                    label="Filter by role"
                    options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                    selected={view.role}
                    onToggle={(v) => props.onToggle('role', v)}
                />
                <div className={styles.pair}>
                    <MultiSelectDropdown
                        label="Archetype"
                        listLabel="Filter by archetype"
                        emptyText={
                            props.archetypesReady ? 'No archetypes yet.' : 'Loading archetypes…'
                        }
                        options={props.archetypeNames.map((name) => ({ value: name, label: name }))}
                        selected={view.arch}
                        onToggle={(v) => props.onToggle('arch', v)}
                    />
                    <FilterChips
                        label="Filter by rarity"
                        options={CHARACTER_RARITIES.map((r) => ({
                            value: r,
                            label: `${r}★`,
                            prestige: r === '5',
                        }))}
                        selected={view.rarity}
                        onToggle={(v) => props.onToggle('rarity', v)}
                    />
                </div>
            </search>

            {props.fullHint && (
                <p className={styles.fullHint}>
                    The team is full. Remove a character to add another.
                </p>
            )}

            {/* The grid's own size container (the mockup's @container pool), kept apart from the filter row: a
                container around the row as well (nested in the search box's own) collapsed the search field to
                0px in Edge after a window resize. */}
            <div className={styles.results}>
                {dataState === 'error' ? (
                    <div className={styles.state}>
                        <p>The characters could not be loaded.</p>
                        <button
                            type="button"
                            className={styles.stateButton}
                            onClick={() => {
                                props.onRetry();
                                // Retry goes away with the message: focus moves to the search field.
                                props.searchRef?.current?.focus();
                            }}
                        >
                            Retry
                        </button>
                    </div>
                ) : dataState === 'loading' ? (
                    <ul className={styles.grid} aria-busy="true" aria-label="Loading characters">
                        {SKELETONS.map((i) => (
                            <li key={i} className={styles.skeleton} aria-hidden="true" />
                        ))}
                    </ul>
                ) : pool.length === 0 ? (
                    <div className={styles.state} role="status">
                        <MagnifierIcon className={styles.stateIcon} strokeWidth={1.6} minus />
                        <p>No characters found matching your filters.</p>
                        {filterCount > 0 && (
                            <button type="button" className={styles.stateButton} onClick={clear}>
                                Clear filters
                            </button>
                        )}
                    </div>
                ) : (
                    <ul className={styles.grid} aria-label="Characters">
                        {pool.map((c) => {
                            const on = picked.has(c.name);
                            return (
                                <li key={c.name} className={styles.gridItem}>
                                    <button
                                        type="button"
                                        className={styles.card}
                                        data-rarity={c.rarity}
                                        data-picked={on || undefined}
                                        aria-pressed={on}
                                        aria-label={`${c.displayName}, ${ROLE_LABEL[c.role]}, ${c.rarity} star`}
                                        onClick={() => props.onPick(c.name)}
                                    >
                                        <RemoteImage
                                            src={c.imageUrl}
                                            alt=""
                                            width={150}
                                            height={200}
                                            className={styles.portrait}
                                        />
                                        <img
                                            className={styles.element}
                                            src={`/elements/${c.element}.webp`}
                                            alt=""
                                            width={26}
                                            height={26}
                                        />
                                        <img
                                            className={styles.path}
                                            src={`/paths/${c.path}.webp`}
                                            alt=""
                                            width={26}
                                            height={26}
                                        />
                                        {on && (
                                            <span className={styles.pickedTag} aria-hidden="true">
                                                Picked
                                            </span>
                                        )}
                                        <span className={styles.meta}>
                                            <span className={styles.name}>{c.displayName}</span>
                                            <span className={styles.role}>
                                                {ROLE_LABEL[c.role]}
                                                <span className={styles.dot} aria-hidden="true" />
                                                {c.rarity}
                                                {'★'}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}
