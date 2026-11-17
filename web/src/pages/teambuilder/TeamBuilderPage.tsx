import { teamCharacters } from '@shared/teambuilder';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PageIntro } from '@/components/PageIntro/PageIntro';
import { ControlSelect, SegmentedControl } from '@/components/SegmentedControl/SegmentedControl';
import { SiteFooter } from '@/components/SiteFooter/SiteFooter';
import { MODE_LABEL } from '@/lib/rosterModel';
import { useAnnouncement } from '@/lib/useAnnouncement';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import hidden from '@/styles/visuallyHidden.module.css';
import { AuctionPanel, overReasons } from './AuctionPanel';
import { CharacterPool, type PoolLine } from './CharacterPool';
import { CostChart } from './CostChart';
import { GameModeTiles } from './GameModeTiles';
import { LoadoutNote } from './LoadoutNote';
import { LoadoutsPanel } from './LoadoutsPanel';
import { PictureActions } from './PictureActions';
import { RosterSlots } from './RosterSlots';
import styles from './TeamBuilderPage.module.css';
import { PairStrip, TeamTotal } from './TeamTotal';
import type { TeamBuilderSearch } from './teambuilderSearch';
import type { PictureRequest } from './teamPictureLayout';
import { type TeamBuilderPageState, useTeamBuilderPage } from './useTeamBuilderPage';

/*
 * The team builder (S14.3a), a port of design/mockups/teambuilder.html: the intro, the Modes card (cost set, draft
 * mode, game mode), the Active Roster (four slots, the pairs strip, in Auction an extra bid under each card), the
 * Cost Breakdown (the total, in Auction the simulator, the cost chart; S14.3b), and the Character Pool. S14.3c: the
 * Loadouts card beside Modes (saved loadouts in the browser and on the account, the share link), the note under the
 * pairs strip, and the footer. State and rules live in `useTeamBuilderPage` and `useLoadouts`; the cost model in
 * `shared/teambuilder`, the loadout rules in `shared/loadouts`.
 */

/** The notice after a link replaced a different saved team (review S3). */
export const LOADED_FROM_LINK = 'Loaded a team from a link.';

export const TEAMBUILDER_TITLE = 'Team Builder — IPC Battlegrounds';

/** S14.3b: said when an Auction team that was over budget fits again. */
export const BACK_WITHIN = 'Back within budget.';

/** S14.3b fix pass (review S1): how long the over-budget state must hold still before it is announced. */
export const OVER_DELAY_MS = 600;

/** S14.3b fix pass (review M7): shown in Classic while the team holds Auction bids. */
export const KEPT_BIDS = 'Your Auction extra bids are kept for when you switch back.';

const FULL_HINT = 'The team is full. Remove a character to add another.';
const slotsLeft = (n: number) => `${n} ${n === 1 ? 'slot' : 'slots'} left.`;

/*
 * Picking from an empty slot (S14.3a-pick, the user's ruling of 2026-11-17, at every width): the page scrolls to
 * the Character Pool (unless its heading is already in view; a jump under reduced motion) and focus moves to the
 * pool's heading, not its search field, so a phone does not open its keyboard over the cards; Tab goes on to the
 * search. That slot is the target: the next pick fills it. The target lasts until a pick, Escape inside the pool,
 * another empty slot, or any other change to the team (remove, swap, Clear Team, Restore). After a pick the page
 * stays at the pool and the line under the filters says which slot was filled and how many are left.
 */

export function TeamBuilderPage({ search }: { search: TeamBuilderSearch }) {
    useDocumentTitle(TEAMBUILDER_TITLE);
    const page = useTeamBuilderPage(search);
    const { view, actions, cost, loadouts } = page;
    const ids = useId();
    const searchRef = useRef<HTMLInputElement>(null);
    const poolRef = useRef<HTMLElement>(null);
    const poolHeadingRef = useRef<HTMLHeadingElement>(null);
    /** The slot an empty-slot press chose (0-based), filled by the next pick. */
    const [target, setTarget] = useState<number | null>(null);
    /** What the last pick did, for the pool's line; cleared by any other change to the team. */
    const [lastPick, setLastPick] = useState<PoolLine | null>(null);
    /** Any team change other than a pick: the target and the last pick's line no longer hold. */
    const forget = () => {
        setTarget(null);
        setLastPick(null);
    };
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

    // S14.3b: going over an Auction budget is announced once, and coming back within it once (review S1): only a
    // change between over and within counts, never a change of the amounts while over; and the change is said once
    // the text has held still for OVER_DELAY_MS, so typing "45.75" says one line with the final amounts. The state a
    // visit opens with is shown, not announced (the ref stays null until the cost rows are here).
    const auction = view.draft === 'auction';
    const overText =
        auction && page.costsReady && page.spend
            ? overReasons(page.spend)
                  .map((r) => r.text)
                  .join(' ')
            : '';
    const isOver = overText !== '';
    const saidOver = useRef<boolean | null>(null);
    useEffect(() => {
        if (!page.costsReady) return;
        if (saidOver.current === null) {
            saidOver.current = isOver;
            return;
        }
        if (isOver === saidOver.current) return;
        const timer = setTimeout(() => {
            saidOver.current = isOver;
            if (isOver) announce(`Over budget. ${overText}`);
            else if (auction) announce(BACK_WITHIN);
        }, OVER_DELAY_MS);
        return () => clearTimeout(timer);
    }, [isOver, overText, auction, announce, page.costsReady]);
    const keptBids = !auction && page.slots.some((s) => (s?.bid ?? 0) > 0);

    const paired = useMemo(
        () => new Set(cost.pairs.flatMap((p) => [p.characterA, p.characterB])),
        [cost.pairs],
    );

    const picked = useMemo(() => new Set(teamCharacters(page.slots)), [page.slots]);
    const nameOf = useCallback(
        (key: string) => page.characterOf(key)?.displayName ?? key,
        [page.characterOf],
    );

    const pick = (name: string) => {
        const { what, index } = actions.pick(name, target ?? undefined);
        const n = nameOf(name);
        setTarget(null);
        if (what === 'added') {
            const left = page.slots.filter((s) => s === null).length - 1;
            const line: PoolLine =
                left === 0
                    ? { text: FULL_HINT, tone: 'full' }
                    : { text: `Slot ${index + 1} filled. ${slotsLeft(left)}`, tone: 'done' };
            setLastPick(line);
            announce(`${n} added to the team. ${line.text}`);
        } else if (what === 'removed') {
            const left = page.slots.filter((s) => s === null).length + 1;
            const line = `Slot ${index + 1} emptied. ${slotsLeft(left)}`;
            setLastPick({ text: line, tone: 'done' });
            announce(`${n} removed from the team. ${line}`);
        } else if (what === 'full') {
            setLastPick(null);
            announce(FULL_HINT);
        }
    };

    const onEmpty = (index: number) => {
        setTarget(index);
        setLastPick(null);
        const pool = poolRef.current;
        const heading = poolHeadingRef.current;
        if (!pool || !heading) return;
        // Scroll only when the pool is not already in view: its heading below the fixed bar (which the pool's scroll
        // margin clears) and in the upper half of the screen, so cards show under it. No animated scroll under
        // reduced motion (review 2 M6).
        const top = heading.getBoundingClientRect().top;
        const clear = Number.parseFloat(getComputedStyle(pool).scrollMarginBlockStart) || 0;
        const inView = top > clear && top < window.innerHeight / 2;
        if (!inView) {
            const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            pool.scrollIntoView?.({ block: 'start', behavior: still ? 'auto' : 'smooth' });
        }
        heading.focus({ preventScroll: true });
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

    // S14.3d: what the team picture shows, read at the moment of a press.
    const pictureRequest = (hideNames: boolean): PictureRequest => ({
        title: loadouts.name,
        slots: page.slots,
        cost,
        spend: page.spend,
        draft: view.draft,
        setLabel,
        modeLabel: MODE_LABEL[page.mode],
        hideNames,
        character: (key) => {
            const c = page.characterOf(key);
            return c
                ? {
                      displayName: c.displayName,
                      rarity: c.rarity,
                      element: c.element.tag.toLowerCase(),
                      path: c.path.tag.toLowerCase(),
                      imageUrl: c.imageUrl,
                  }
                : undefined;
        },
        lightcone: (key) => page.lightconeOf(key),
    });

    const line: PoolLine = page.fullHint
        ? { text: FULL_HINT, tone: 'full' }
        : target !== null
          ? { text: `Picking for slot ${target + 1}.`, tone: 'target' }
          : (lastPick ?? { text: '', tone: 'none' });

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
                Build any team and see what it costs. Keep up to <strong>5 loadouts</strong> in this
                browser; sign in with Discord to keep up to <strong>10</strong> on your account, on
                every device. Share a team with <strong>Copy link</strong>. Don&apos;t forget to
                flip the <strong>cost set</strong>, <strong>draft mode</strong> and{' '}
                <strong>game mode</strong> as you need it.
            </PageIntro>

            <div className={styles.workspace}>
                <LoadoutsPanel
                    loadouts={loadouts}
                    code={page.code}
                    announce={announce}
                    onLoaded={forget}
                    characterName={nameOf}
                    picture={
                        <PictureActions request={pictureRequest} disabled={!page.costsReady} />
                    }
                />

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
                        {keptBids && <p className={styles.modeNote}>{KEPT_BIDS}</p>}
                        {notice && <p className={styles.notice}>{notice}</p>}
                        {page.replacedTeam && (
                            <p className={`${styles.notice} ${styles.linkNotice}`}>
                                <span>{LOADED_FROM_LINK}</span>
                                <button
                                    type="button"
                                    className={styles.noticeButton}
                                    data-primary=""
                                    onClick={() => {
                                        // S14.3c: a link opened over a saved loadout goes back to that loadout.
                                        const back = loadouts.beforeLink;
                                        if (back) {
                                            actions.dismissPrevious();
                                            loadouts.switchTo(back);
                                        } else actions.restorePrevious();
                                        forget();
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
                                        loadouts.forgetBeforeLink();
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
                                    forget();
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
                                forget();
                                if (s) announce(`${nameOf(s.character)} removed from the team.`);
                                // The remove button went with the slot: focus the empty slot.
                                requestAnimationFrame(() => focusSlot(i));
                            }}
                            onEidolon={actions.setEidolon}
                            onSuperimposition={actions.setSuperimposition}
                            onEquip={actions.equip}
                            onSwap={(a, b) => {
                                actions.swap(a, b);
                                forget();
                            }}
                            onEmpty={onEmpty}
                            announce={announce}
                            draftAuction={auction}
                            onBid={actions.setBid}
                        />
                        <PairStrip pairs={cost.pairs} nameOf={nameOf} />
                        <LoadoutNote value={loadouts.note} onChange={loadouts.setNote} />
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
                        {auction && page.spend && (
                            <AuctionPanel
                                spend={page.spend}
                                budgets={page.budgets}
                                onBudget={actions.setBudget}
                                announce={announce}
                            />
                        )}
                        <CostChart
                            slots={page.slots}
                            cost={cost}
                            auction={auction}
                            mode={page.mode}
                            ready={page.costsReady}
                            nameOf={nameOf}
                        />
                        <p className={styles.costFoot}>
                            {setLabel} {'·'} {auction ? 'Auction' : 'Classic'} Draft {'·'}{' '}
                            {MODE_LABEL[page.mode]}
                        </p>
                    </div>
                </aside>

                <section
                    ref={poolRef}
                    className={`${styles.section} ${styles.pool}`}
                    aria-labelledby={`${ids}-pool`}
                    onKeyDown={(e) => {
                        // Escape inside the pool lets go of the target slot.
                        if (e.key === 'Escape' && target !== null) setTarget(null);
                    }}
                >
                    <div className={styles.sectionHead}>
                        <h2
                            id={`${ids}-pool`}
                            ref={poolHeadingRef}
                            className={styles.chapter}
                            tabIndex={-1}
                        >
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
                    <CharacterPool
                        view={view}
                        pool={page.pool}
                        picked={picked}
                        dataState={page.dataState}
                        filterCount={page.filterCount}
                        archetypeNames={page.archetypeNames}
                        archetypesReady={page.refReady}
                        line={line}
                        searchRef={searchRef}
                        onToggle={actions.toggle}
                        onQuery={actions.setQuery}
                        onClearFilters={actions.clearFilters}
                        onPick={pick}
                        onRetry={actions.retry}
                    />
                </section>
            </div>

            <SiteFooter />

            <p role="status" className={hidden.visuallyHidden}>
                {said}
            </p>
        </div>
    );
}

export type { TeamBuilderPageState };
