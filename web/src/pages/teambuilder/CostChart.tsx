import type { Slots, TeamCost } from '@shared/teambuilder';
import { useMemo } from 'react';
import { StackedBarChart } from '@/components/StackedBarChart/StackedBarChart';
import { MODE_SHORT } from '@/lib/rosterModel';
import type { ModeParam } from '@/lib/rosterSearch';
import styles from './CostChart.module.css';
import { costChartBars, costSeries } from './costChartModel';

/*
 * The Cost Breakdown chart (S14.3b; the mockup's `.costChartWrap`, `.costLegend`, `buildCostChart`): the shared CSS
 * column chart with the team's columns (`costChartModel.ts`) and the mockup's colour ramp for the game mode
 * (`CostChart.module.css`). The y title is the mockup's "Cost — <mode>".
 */

export function CostChart({
    slots,
    cost,
    auction,
    mode,
    ready,
    nameOf,
}: {
    slots: Slots;
    cost: TeamCost;
    auction: boolean;
    mode: ModeParam;
    /** False while the cost rows load: no columns (never a misleading "n/a"). */
    ready: boolean;
    nameOf: (key: string) => string;
}) {
    const bars = useMemo(
        () => (ready ? costChartBars({ slots, cost, auction, nameOf }) : []),
        [ready, slots, cost, auction, nameOf],
    );
    const filled = slots.some((s) => s !== null);
    return (
        <div className={styles.wrap} data-mode={mode} data-draft={auction ? 'auction' : 'classic'}>
            <StackedBarChart
                label={`Cost per character, ${MODE_SHORT[mode]}, ${auction ? 'Auction' : 'Classic'} draft`}
                axisTitle={`Cost — ${MODE_SHORT[mode]}`}
                series={costSeries(auction)}
                bars={bars}
                empty={filled && !ready ? 'Loading costs' : 'No characters selected'}
            />
        </div>
    );
}
