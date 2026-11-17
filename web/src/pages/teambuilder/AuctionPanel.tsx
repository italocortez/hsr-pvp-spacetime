import { type AuctionSpend, BUDGET_MAX, type Budgets } from '@shared/teambuilder';
import { type CSSProperties, type ReactNode, useId } from 'react';
import { InfoPopover } from '@/components/InfoPopover/InfoPopover';
import hidden from '@/styles/visuallyHidden.module.css';
import { AmountField } from './AmountField';
import styles from './AuctionPanel.module.css';
import { amountFixed } from './costChartModel';

/*
 * The Auction simulator (S14.3b; the mockup's `.auctionPanel`): the two budgets, editable, starting at 30 and 15
 * (A190 item 5), and two meters that drain as the team spends them, by the module's rules (`auctionSpend`,
 * shared/teambuilder/auctionSpend.ts):
 *
 * - Characters: the winning bids (base + extra bid) and the eidolon extras the character budget can still pay.
 * - Light Cones: the base budget plus the leftover character budget (rolled over when the draft ends, the tick marks
 *   the base), less the cones and any eidolon extra that spilled; the pairings slice (iris) must fit what is left.
 *
 * Over the limit: the meter turns red, its foot says "Over by X", and a line under the meters says what is over in
 * words (the page announces it). Each meter has an info button: since S14.3i the shared InfoPopover (the circled "!",
 * quiet tone, the mockup's panel with its heading and foot line), a toggletip: hover, keyboard focus, a click or tap
 * opens it; Escape, a press elsewhere or Tab moving on closes it (`@/components/InfoPopover`).
 */

export type OverReason = { kind: 'character' | 'lightcone' | 'pairings'; text: string };

/**
 * What is over, in words: the page shows it under the meters and announces it. Each line ends on the same figure as
 * its meter's "Over by" (review S6): the character line on the winning amounts above the budget; the light cone line
 * on everything above the light cone budget, naming its parts (the cones, any eidolon extras, the pairings).
 */
export function overReasons(s: AuctionSpend): OverReason[] {
    const out: OverReason[] = [];
    if (s.over.character)
        out.push({
            kind: 'character',
            text: `The winning bids are ${amountFixed(s.winning - s.budgets.character)} over the character budget. A lobby refuses a bid above the character budget left.`,
        });
    if (s.over.lightcone) {
        const cones = amountFixed(s.lightconeSpent - s.lightconeAvailable);
        const what = `The light cones${s.eidolonsFromLightcone > 0 ? ' and eidolon extras' : ''}`;
        out.push({
            kind: 'lightcone',
            text:
                s.pairings > 0
                    ? `${what} are ${cones} over the light cone budget; with the pairings (${amountFixed(s.pairings)}) it is ${amountFixed(-s.left)} over.`
                    : `${what} are ${cones} over the light cone budget.`,
        });
    }
    if (s.over.pairings)
        out.push({
            kind: 'pairings',
            text: `The pairings (${amountFixed(s.pairings)}) are ${amountFixed(-s.left)} over the ${amountFixed(s.lightconeAvailable - s.lightconeSpent)} left after the light cones. A lobby asks for another lineup.`,
        });
    return out;
}

const pct = (part: number, whole: number) =>
    whole > 0 ? `${Math.max(0, Math.min(100, (part / whole) * 100))}%` : '0%';

export function AuctionPanel({
    spend,
    budgets,
    onBudget,
    announce,
}: {
    spend: AuctionSpend;
    budgets: Budgets;
    onBudget: (kind: keyof Budgets, hundredths: number) => void;
    /** The page's polite status region (the budget fields' messages). */
    announce?: (text: string) => void;
}) {
    const id = useId();
    const reasons = overReasons(spend);
    const charOver = spend.over.character;
    const lcOver = spend.over.lightcone || spend.over.pairings;
    const lcUsed = spend.lightconeSpent + spend.pairings;

    return (
        <section className={styles.panel} aria-labelledby={`${id}-title`}>
            <h3 id={`${id}-title`} className={hidden.visuallyHidden}>
                Auction budgets
            </h3>
            <div className={styles.budgets}>
                <div className={styles.budget}>
                    <label className={styles.budgetLabel} htmlFor={`${id}-char`}>
                        Character Budget
                    </label>
                    <AmountField
                        id={`${id}-char`}
                        className={styles.input}
                        value={budgets.character}
                        max={BUDGET_MAX}
                        onChange={(v) => onBudget('character', v)}
                        announce={announce}
                    />
                </div>
                <div className={styles.budget}>
                    <label className={styles.budgetLabel} htmlFor={`${id}-lc`}>
                        Light Cone Budget
                    </label>
                    <AmountField
                        id={`${id}-lc`}
                        className={styles.input}
                        value={budgets.lightcone}
                        max={BUDGET_MAX}
                        onChange={(v) => onBudget('lightcone', v)}
                        announce={announce}
                    />
                </div>
            </div>

            <div className={styles.meters}>
                <Meter
                    name="Characters"
                    info={
                        <Info
                            title="Character Budget"
                            label="How the character budget works"
                            foot="What is left when the draft ends rolls into the Light Cone budget."
                        >
                            <p>
                                Each character you win is paid from this budget at its{' '}
                                <strong>winning bid</strong>: the opening bid, which is its E0 cost,
                                plus the <strong>extra bid</strong> your team bids on top (typed
                                under its card).
                            </p>
                            <p>
                                In a lobby an extra bid must be 0 or at least the lobby&apos;s
                                minimum raise. The builder does not know that raise and accepts any
                                amount.
                            </p>
                            <p>
                                An eidolon above the lobby&apos;s default is bought after the sale:
                                its <strong>eidolon extra</strong> (its cost minus the E0 cost) is
                                paid from this budget first, then from the light cone budget.
                            </p>
                            <p>
                                The builder assumes the best order of sales, so a real draft can
                                refuse a last bid that fits here.
                            </p>
                        </Info>
                    }
                    left={spend.characterLeft}
                    over={charOver}
                    fill={pct(Math.max(0, spend.characterLeft), spend.budgets.character)}
                    items={[
                        { label: 'Winning bids', value: spend.winning },
                        ...(spend.eidolonsFromCharacter > 0
                            ? [{ label: 'Eidolons', value: spend.eidolonsFromCharacter }]
                            : []),
                    ]}
                    foot={
                        charOver
                            ? `Over by ${amountFixed(spend.winning - spend.budgets.character)}`
                            : `${amountFixed(spend.characterSpent)} of ${amountFixed(spend.budgets.character)}`
                    }
                />
                <Meter
                    name="Light Cones"
                    info={
                        <Info title="Light Cone Budget" label="How the light cone budget works">
                            <p>
                                Each equipped light cone is paid from this budget at its cost for
                                the chosen superimposition. Eidolon extras the character budget
                                could not pay come from here too.
                            </p>
                            <p>
                                When the draft ends, the <strong>leftover character budget</strong>{' '}
                                rolls in: the tick marks the base budget, the rest came from
                                characters.
                            </p>
                            <p>
                                <strong>Pairings</strong> cost nothing in Auction unless the cost
                                set prices them; then their surcharge must fit what is left (the
                                iris slice) and counts in the total cost.
                            </p>
                        </Info>
                    }
                    left={spend.left}
                    over={lcOver}
                    fill={pct(Math.max(0, spend.left), spend.lightconeAvailable)}
                    pair={
                        spend.pairings > 0
                            ? pct(
                                  Math.min(
                                      spend.pairings,
                                      Math.max(0, spend.lightconeAvailable - spend.lightconeSpent),
                                  ),
                                  spend.lightconeAvailable,
                              )
                            : undefined
                    }
                    tick={
                        spend.rollover > 0 && spend.lightconeAvailable > 0
                            ? pct(spend.budgets.lightcone, spend.lightconeAvailable)
                            : undefined
                    }
                    items={[
                        { label: 'Cones', value: spend.cones, dot: 'cone' },
                        // Shown only when the cost set prices the team's pairs in Auction (the Default set prices
                        // every Auction pair at 0, A108; A185 item 3: a zero is hidden).
                        ...(spend.pairings > 0
                            ? [{ label: 'Pairings', value: spend.pairings, dot: 'pair' as const }]
                            : []),
                        ...(spend.eidolonsFromLightcone > 0
                            ? [{ label: 'Eidolons', value: spend.eidolonsFromLightcone }]
                            : []),
                    ]}
                    carry={spend.rollover > 0 ? spend.rollover : undefined}
                    foot={
                        lcOver
                            ? `Over by ${amountFixed(-spend.left)}`
                            : `${amountFixed(lcUsed)} of ${amountFixed(spend.lightconeAvailable)}`
                    }
                />
            </div>

            {reasons.length > 0 && (
                <div className={styles.over} data-active="">
                    <span className={styles.overMark} aria-hidden="true">
                        !
                    </span>
                    <p>
                        <strong>Over budget.</strong> {reasons.map((r) => r.text).join(' ')}
                    </p>
                </div>
            )}
        </section>
    );
}

type Item = { label: string; value: number; dot?: 'cone' | 'pair' };

function Meter({
    name,
    info,
    left,
    over,
    fill,
    pair,
    tick,
    items,
    carry,
    foot,
}: {
    name: string;
    info: ReactNode;
    left: number;
    over: boolean;
    fill: string;
    pair?: string;
    tick?: string;
    items: Item[];
    carry?: number;
    foot: string;
}) {
    return (
        <div className={styles.meter} data-over={over ? '' : undefined}>
            <div className={styles.meterHead}>
                <div className={styles.meterName}>
                    {name}
                    {info}
                </div>
                <span className={styles.meterValue}>
                    <b>{amountFixed(left)}</b> left
                </span>
            </div>
            <div className={styles.bar} aria-hidden="true">
                <span className={styles.fill} style={{ inlineSize: fill } as CSSProperties} />
                {pair && <span className={styles.pair} style={{ inlineSize: pair }} />}
                {tick && <span className={styles.tick} style={{ insetInlineStart: tick }} />}
            </div>
            <div className={styles.foot}>
                {items.map((it) => (
                    <span key={it.label} className={styles.footItem}>
                        {it.dot && (
                            <i className={styles.dot} data-dot={it.dot} aria-hidden="true" />
                        )}
                        {it.label} <b>{amountFixed(it.value)}</b>
                    </span>
                ))}
                {carry !== undefined && (
                    <span className={styles.carry}>
                        <span aria-hidden="true">{'⇢ '}</span>+<b>{amountFixed(carry)}</b> from
                        Chars
                    </span>
                )}
                <span className={styles.footTotal}>{foot}</span>
            </div>
        </div>
    );
}

/** A meter's info button and its explainer: the shared info popover (S14.3i), in the mockup's panel form. */
function Info({
    title,
    label,
    foot,
    children,
}: {
    title: string;
    label: string;
    foot?: string;
    children: ReactNode;
}) {
    return (
        <InfoPopover label={label} heading={title} foot={foot} className={styles.info}>
            {children}
        </InfoPopover>
    );
}
