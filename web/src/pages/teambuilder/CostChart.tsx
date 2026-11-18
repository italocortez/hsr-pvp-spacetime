import type { Slots, TeamCost } from '@shared/teambuilder';
import { useMemo } from 'react';
import { Chart } from '@/components/Chart/Chart';
import { MODE_SHORT } from '@/lib/rosterModel';
import type { ModeParam } from '@/lib/rosterSearch';
import styles from './CostChart.module.css';
import { costChartBars, costChartModel } from './costChartModel';

/*
 * The Cost Breakdown chart (S14.3b; the mockup's `.costChartWrap`, `.costLegend`, `buildCostChart`): the shared
 * Chart.js wrapper (S14.5c, A203) with the team's columns (`costChartModel.ts`) and the mockup's colour ramp for the
 * game mode (`CostChart.module.css`). The y title is the mockup's "Cost — <mode>".
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
    const filled = slots.some((s) => s !== null);
    const model = useMemo(
        () =>
            costChartModel({
                bars: ready ? costChartBars({ slots, cost, auction, nameOf }) : [],
                auction,
                mode: MODE_SHORT[mode],
                empty: filled && !ready ? 'Loading costs' : 'No characters selected',
            }),
        [ready, slots, cost, auction, nameOf, mode, filled],
    );
    return (
        <div className={styles.wrap} data-mode={mode}>
            <Chart model={model} />
        </div>
    );
}
