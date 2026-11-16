import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ControlSelect, SegmentedControl, tabId } from './SegmentedControl';

/* T-COSTS: the shared segmented control (toggle buttons or tabs) and the select in its frame. */

function Toggle({ disabledReason }: { disabledReason?: string }) {
    const [value, setValue] = useState<'a' | 'b'>('a');
    return (
        <SegmentedControl
            label="Draft Mode"
            value={value}
            onChange={setValue}
            options={[
                { value: 'a', label: 'Classic' },
                { value: 'b', label: 'Auction', disabledReason },
            ]}
        />
    );
}

function Tabs() {
    const [value, setValue] = useState<'x' | 'y' | 'z'>('x');
    return (
        <>
            <SegmentedControl
                label="Table"
                semantics="tabs"
                idPrefix="t"
                value={value}
                onChange={setValue}
                options={[
                    { value: 'x', label: 'One' },
                    { value: 'y', label: 'Two' },
                    { value: 'z', label: 'Three' },
                ]}
            />
            <div role="tabpanel" aria-labelledby={tabId('t', value)} />
        </>
    );
}

describe('SegmentedControl as toggle buttons', () => {
    it('a named group; one button pressed; a click presses another', async () => {
        const user = userEvent.setup();
        render(<Toggle />);
        expect(screen.getByRole('group', { name: 'Draft Mode' })).toBeInTheDocument();
        const classic = screen.getByRole('button', { name: 'Classic' });
        const auction = screen.getByRole('button', { name: 'Auction' });
        expect(classic).toHaveAttribute('aria-pressed', 'true');
        expect(auction).toHaveAttribute('aria-pressed', 'false');
        await user.click(auction);
        expect(auction).toHaveAttribute('aria-pressed', 'true');
        expect(classic).toHaveAttribute('aria-pressed', 'false');
    });

    it('every button is a Tab stop; Space presses', async () => {
        const user = userEvent.setup();
        render(<Toggle />);
        await user.tab();
        await user.tab();
        expect(screen.getByRole('button', { name: 'Auction' })).toHaveFocus();
        await user.keyboard(' ');
        expect(screen.getByRole('button', { name: 'Auction' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    it('a disabled option stays focusable, ignores activation, and says why', async () => {
        const user = userEvent.setup();
        render(<Toggle disabledReason="Fixed by the cost set." />);
        const auction = screen.getByRole('button', { name: 'Auction' });
        expect(auction).toHaveAttribute('aria-disabled', 'true');
        expect(auction).toHaveAccessibleDescription('Fixed by the cost set.');
        expect(auction).not.toBeDisabled();
        await user.click(auction);
        expect(auction).toHaveAttribute('aria-pressed', 'false');
    });

    it('an abbreviated label is named in full', () => {
        const onChange = vi.fn();
        render(
            <SegmentedControl
                label="Game Mode"
                value="as"
                onChange={onChange}
                options={[{ value: 'as', label: 'AS', ariaLabel: 'Apocalyptic Shadow' }]}
            />,
        );
        expect(screen.getByRole('button', { name: 'Apocalyptic Shadow' })).toHaveTextContent('AS');
    });
});

describe('SegmentedControl as tabs', () => {
    it('tablist and tabs with aria-selected; only the selected tab is a Tab stop', () => {
        render(<Tabs />);
        expect(screen.getByRole('tablist', { name: 'Table' })).toBeInTheDocument();
        const [one, two] = screen.getAllByRole('tab');
        expect(one).toHaveAttribute('aria-selected', 'true');
        expect(one).not.toHaveAttribute('tabindex');
        expect(two).toHaveAttribute('aria-selected', 'false');
        expect(two).toHaveAttribute('tabindex', '-1');
        expect(screen.getByRole('tabpanel')).toHaveAccessibleName('One');
    });

    it('arrows (wrapping), Home and End move focus; Enter selects (selection by activation)', async () => {
        const user = userEvent.setup();
        render(<Tabs />);
        const [one, two, three] = screen.getAllByRole('tab') as HTMLElement[];
        await user.tab();
        expect(one).toHaveFocus();
        await user.keyboard('{ArrowLeft}');
        expect(three).toHaveFocus();
        await user.keyboard('{ArrowRight}');
        expect(one).toHaveFocus();
        await user.keyboard('{End}');
        expect(three).toHaveFocus();
        await user.keyboard('{Home}{ArrowRight}');
        expect(two).toHaveFocus();
        expect(one).toHaveAttribute('aria-selected', 'true');
        await user.keyboard('{Enter}');
        expect(two).toHaveAttribute('aria-selected', 'true');
        expect(two).not.toHaveAttribute('tabindex');
        expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Two');
    });

    it('focus entering the list lands on the selected tab', async () => {
        const user = userEvent.setup();
        render(<Tabs />);
        await user.click(screen.getByRole('tab', { name: 'Three' }));
        await user.tab({ shift: true });
        await user.tab();
        expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus();
    });
});

describe('ControlSelect', () => {
    it('a native select named by its label', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
            <ControlSelect label="Cost Set" value="0" onChange={onChange}>
                <option value="0">Default</option>
                <option value="3">Yuji Tournament</option>
            </ControlSelect>,
        );
        const select = screen.getByRole('combobox', { name: 'Cost Set' });
        await user.selectOptions(select, '3');
        expect(onChange).toHaveBeenCalled();
    });
});
