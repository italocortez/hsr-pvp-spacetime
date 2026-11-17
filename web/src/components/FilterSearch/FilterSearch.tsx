import type { Ref } from 'react';
import { SearchField } from '@/components/SearchField/SearchField';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './FilterSearch.module.css';

/*
 * A filter row's search with its red "Clear N" button in one box (S14.2c to S14.2e on the costs page, A187 to
 * A189; shared with the team builder's pool since S14.3a). The box is an inline-size container, so its width never
 * depends on what it holds: Clear appearing narrows the search and moves nothing else in the row. Clear follows the
 * search in the source (Tab order matches what is seen). It is the full "Clear N ✕" when the box keeps the search
 * 248px wide, otherwise the compact "N ✕" (and always compact at the narrow step, 560px); its name stays
 * "Clear N filter(s)". The caller sizes the box in its row through `className` and moves focus after a clear.
 */

export function FilterSearch({
    className,
    value,
    onChange,
    placeholder,
    maxLength,
    inputRef,
    filterCount,
    onClear,
    label = 'Search',
}: {
    className?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    maxLength: number;
    inputRef?: Ref<HTMLInputElement>;
    /** Active filters (search included); Clear shows while it is above 0. */
    filterCount: number;
    onClear: () => void;
    label?: string;
}) {
    return (
        <div className={className ? `${styles.group} ${className}` : styles.group}>
            <SearchField
                label={label}
                inputRef={inputRef}
                value={value}
                maxLength={maxLength}
                placeholder={placeholder}
                onChange={onChange}
            />
            {filterCount > 0 && (
                <button type="button" className={styles.clearChip} onClick={onClear}>
                    <span className={styles.clearWord}>Clear</span> {filterCount}{' '}
                    <span className={hidden.visuallyHidden}>
                        {filterCount === 1 ? 'filter' : 'filters'}
                    </span>
                    <span aria-hidden="true"> {'✕'}</span>
                </button>
            )}
        </div>
    );
}
