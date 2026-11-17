import { teamCharacters } from '@shared/teambuilder';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PageIntro } from '@/components/PageIntro/PageIntro';
import { ControlSelect, SegmentedControl } from '@/components/SegmentedControl/SegmentedControl';
import { MODE_LABEL } from '@/lib/rosterModel';
import { useAnnouncement } from '@/lib/useAnnouncement';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { customMediaQuery } from '@/shell/PhoneMenu';
import mediaCss from '@/styles/media.css?raw';
import hidden from '@/styles/visuallyHidden.module.css';
import { CharacterPool } from './CharacterPool';
import { GameModeTiles } from './GameModeTiles';
import { PoolSheet } from './PoolSheet';
import { RosterSlots } from './RosterSlots';
import styles from './TeamBuilderPage.module.css';
import { PairStrip, TeamTotal } from './TeamTotal';
import type { TeamBuilderSearch } from './teambuilderSearch';
import { type TeamBuilderPageState, useTeamBuilderPage } from './useTeamBuilderPage';

/*
 * The team builder (S14.3a), a port of design/mockups/teambuilder.html: the intro, the Modes card (cost set, draft
 * mode, game mode), the Active Roster (four slots, the pairs strip), the total, and the Character Pool. Loadouts,
 * the cost chart, the Auction simulator, the share link and the footer come in S14.3b and S14.3c: the grid keeps
 * their places (the Loadouts card beside Modes, the chart under the total). State and rules live in
 * `useTeamBuilderPage`; the cost model in `shared/teambuilder`.
 */

/** The notice after a link replaced a different saved team (review S3). */
export const LOADED_FROM_LINK = 'Loaded a team from a link.';

export const TEAMBUILDER_TITLE = 'Team Builder — IPC Battlegrounds';

/** Where an empty slot opens the pool sheet instead of pointing at the pool below (the middle step). */
export const SHEET_QUERY = customMediaQuery(mediaCss, '--bp-md');

export function TeamBuilderPage({ search }: { search: TeamBuilderSearch }) {
    useDocumentTitle(TEAMBUILDER_TITLE);
    const page = useTeamBuilderPage(search);
    const { view, actions, cost } = page;
    const ids = useId();
    const searchRef = useRef<HTMLInputElement>(null);
    const poolRef = useRef<HTMLElement>(null);
    const [sheetSlot, setSheetSlot] = useState<number | null>(null);
    const ready = page.dataState === 'ready';
    const setLabel = page.costSet?.name ?? 'Default';

    // One polite status region: the pool's count once it holds still, the notices, and each team change.
    const setNotice =
        page.noticeSet !== null
            ? `Cost set ${page.noticeSet} is not available. Showing the Default set.`
            : '';
    const notice = page.linkNotice ?? setNotice;
    const count = page.pool.length;
    const counted = useAnnouncement(
        ready ? `${count} ${count === 1 ? 'character' : 'characters'} listed.` : '',
        ready,
        notice,
    );
    const [said, setSaid] = useState('');
    useEffect(() => setSaid(counted), [counted]);
    const announce = useCallback((text: string) => {
        // A repeat of the same words still changes the region's text.
        setSaid((prev) => (prev === text ? `${text} ` : text));
    }, []);

    // A link replaced a different saved team (review S3): the notice with Restore is announced when it appears.
    useEffect(() => {
        if (page.replacedTeam) announce(LOADED_FROM_LINK);
    }, [page.replacedTeam, announce]);

    const paired = useMemo(
        () => new Set(cost.pairs.flatMap((p) => [p.characterA, p.characterB])),
        [cost.pairs],
    );

    const picked = useMemo(() => new Set(teamCharacters(page.slots)), [page.slots]);
    const nameOf = useCallback(
        (key: string) => page.characterOf(key)?.displayName ?? key,
        [page.characterOf],
    );

    const pick = (name: string, target?: number) => {
        const what = actions.pick(name, target);
        const n = nameOf(name);
        if (what === 'added') announce(`${n} added to the team.`);
        else if (what === 'removed') announce(`${n} removed from the team.`);
        else if (what === 'full') announce('The team is full. Remove a character to add another.');
        return what;
    };

    const onEmpty = (index: number) => {
        if (globalThis.matchMedia?.(SHEET_QUERY).matches) {
            setSheetSlot(index);
            return;
        }
        // No animated scroll under reduced motion (review 2 M6).
        const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        poolRef.current?.scrollIntoView?.({ block: 'start', behavior: still ? 'auto' : 'smooth' });
        searchRef.current?.focus({ preventScroll: true });
    };

    const focusSlot = (index: number) => {
        const el = document.querySelector<HTMLElement>(
            `[data-slots="${ids}"] [data-slot="${index}"] [data-slot-focus]`,
        );
        el?.focus();
    };

    const coneCostAtS1 = (name: string) => page.source.lightcone(name)?.[0];
    const lockedReason = page.costSet
        ? `The cost set ${page.costSet.name} is for ${MODE_LABEL[page.mode]} only. Pick Default to change the game mode.`
        : undefined;

    const poolProps = {
        view,
        pool: page.pool,
        picked,
        dataState: page.dataState,
        filterCount: page.filterCount,
        archetypeNames: page.archetypeNames,
        archetypesReady: page.refReady,
        fullHint: page.fullHint,
        onToggle: actions.toggle,
        onQuery: actions.setQuery,
        onClearFilters: actions.clearFilters,
        onRetry: actions.retry,
    };

    return (
        <div className={styles.page}>
            <PageIntro
                title={
                    <>
                        <em>Iterate</em> any team.
                    </>
                }
                collapsedTitle="Team Builder"
                onToggle={page.dismissNotices}
            >
                Build any team and see what it costs. Your team stays in this browser while you work
                on it. Don&apos;t forget to flip the <strong>cost set</strong>,{' '}
                <strong>draft mode</strong> and <strong>game mode</strong> as you need it.
            </PageIntro>

            <div className={styles.workspace}>
                <section
                    className={`${styles.section} ${styles.modes}`}
                    aria-labelledby={`${ids}-modes`}
                >
                    <div className={styles.sectionHead}>
                        <h2 id={`${ids}-modes`} className={styles.chapter}>
                            <strong>Modes</strong>
                        </h2>
                    </div>
                    <div className={styles.modesBody}>
                        <ControlSelect
                            label="Cost Set"
                            value={String(page.costSet?.id ?? 0)}
                            onChange={(e) => actions.setCostSet(Number(e.currentTarget.value))}
                        >
                            <option value="0">Default</option>
                            {page.setsForMode.map((s) => (
                                <option key={s.id} value={String(s.id)}>
                                    {s.isLocked ? `${s.name} (locked)` : s.name}
                                </option>
                            ))}
                        </ControlSelect>
                        <SegmentedControl
                            label="Draft Mode"
                            value={view.draft}
                            onChange={actions.setDraft}
                            options={[
                                { value: 'classic', label: 'Classic' },
                                { value: 'auction', label: 'Auction' },
                            ]}
                        />
                        <GameModeTiles
                            value={page.mode}
                            onChange={actions.setMode}
                            lockedReason={lockedReason}
                        />
                        {notice && <p className={styles.notice}>{notice}</p>}
                        {page.replacedTeam && (
                            <p className={`${styles.notice} ${styles.linkNotice}`}>
                                <span>{LOADED_FROM_LINK}</span>
                                <button
                                    type="button"
                                    className={styles.noticeButton}
                                    data-primary=""
                                    onClick={() => {
                                        actions.restorePrevious();
                                        announce('Your previous team is back.');
                                        requestAnimationFrame(() => focusSlot(0));
                                    }}
                                >
                                    Restore my previous team
                                </button>
                                <button
                                    type="button"
                                    className={styles.noticeButton}
                                    onClick={() => {
                                        actions.dismissPrevious();
                                        announce('Notice dismissed. The team from the link stays.');
                                        requestAnimationFrame(() => focusSlot(0));
                                    }}
                                >
                                    Dismiss
                                </button>
                            </p>
                        )}
                    </div>
                </section>

                <section
                    className={`${styles.section} ${styles.roster}`}
                    aria-labelledby={`${ids}-roster`}
                >
                    <div className={styles.sectionHead}>
                        <h2 id={`${ids}-roster`} className={styles.chapter}>
                            <strong>Active Roster</strong>
                        </h2>
                        <div className={styles.headActions}>
                            <p className={styles.aside}>
                                <b>{page.filled}</b> / 4 Slots
                            </p>
                            <button
                                type="button"
                                className={styles.clearTeam}
                                onClick={() => {
                                    actions.clearTeam();
                                    announce('Team cleared.');
                                }}
                            >
                                <span aria-hidden="true">{'⊘'}</span> Clear Team
                            </button>
                        </div>
                    </div>
                    <div className={styles.rosterBody} data-slots={ids}>
                        <RosterSlots
                            slots={page.slots}
                            costs={cost.slots}
                            loading={!page.refReady}
                            costsReady={page.costsReady}
                            paired={paired}
                            characterOf={page.characterOf}
                            lightconeOf={page.lightconeOf}
                            lightcones={page.lightcones}
                            coneCostAtS1={coneCostAtS1}
                            onRemove={(i) => {
                                const s = page.slots[i];
                                actions.remove(i);
                                if (s) announce(`${nameOf(s.character)} removed from the team.`);
                                // The remove button went with the slot: focus the empty slot.
                                requestAnimationFrame(() => focusSlot(i));
                            }}
                            onEidolon={actions.setEidolon}
                            onSuperimposition={actions.setSuperimposition}
                            onEquip={actions.equip}
                            onSwap={actions.swap}
                            onEmpty={onEmpty}
                            announce={announce}
                            draftAuction={view.draft === 'auction'}
                        />
                        <PairStrip pairs={cost.pairs} nameOf={nameOf} />
                    </div>
                </section>

                <aside
                    className={`${styles.section} ${styles.cost}`}
                    aria-labelledby={`${ids}-cost`}
                >
                    <div className={styles.sectionHead}>
                        <h2 id={`${ids}-cost`} className={styles.chapter}>
                            <strong>Cost Breakdown</strong>
                        </h2>
                    </div>
                    <div className={styles.costBody}>
                        <TeamTotal
                            total={cost.total}
                            ready={page.costsReady}
                            missing={cost.missing}
                            setLabel={setLabel}
                            nameOf={(kind, key) =>
                                kind === 'character'
                                    ? nameOf(key)
                                    : (page.lightconeOf(key)?.displayName ?? key)
                            }
                        />
                        <p className={styles.costFoot}>
                            {setLabel} {'·'} {view.draft === 'auction' ? 'Auction' : 'Classic'}{' '}
                            Draft {'·'} {MODE_LABEL[page.mode]}
                        </p>
                    </div>
                </aside>

                <section
                    ref={poolRef}
                    className={`${styles.section} ${styles.pool}`}
                    aria-labelledby={`${ids}-pool`}
                >
                    <div className={styles.sectionHead}>
                        <h2 id={`${ids}-pool`} className={styles.chapter}>
                            <strong>Character Pool</strong>
                        </h2>
                        <p className={styles.aside}>
                            {ready ? (
                                <>
                                    <b>{count}</b> {count === 1 ? 'unit' : 'units'} listed
                                </>
                            ) : page.dataState === 'loading' ? (
                                'Loading'
                            ) : (
                                'Unavailable'
                            )}
                        </p>
                    </div>
                    <CharacterPool {...poolProps} searchRef={searchRef} onPick={(n) => pick(n)} />
                </section>
            </div>

            <PoolSheet
                {...poolProps}
                slot={sheetSlot}
                onPick={(n) => {
                    const target = sheetSlot ?? undefined;
                    const what = pick(n, target);
                    if (what === 'added') setSheetSlot(null);
                }}
                onClose={() => setSheetSlot(null)}
                onClosed={(i) => requestAnimationFrame(() => focusSlot(i))}
            />

            <p role="status" className={hidden.visuallyHidden}>
                {said}
            </p>
        </div>
    );
}

export type { TeamBuilderPageState };
