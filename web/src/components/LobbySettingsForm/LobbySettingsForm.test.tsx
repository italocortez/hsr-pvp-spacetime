import {
    BUILT_IN_PRESETS,
    initialLobbySettings,
    type LobbyFormRules,
    type LobbySettings,
    validateLobbySettings,
} from '@shared/lobby-rules/lobbySettings';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LobbySettingsForm } from './LobbySettingsForm';

/*
 * T-S14.4c: the shared lobby settings form on its own: the main fields with their labels and info marks, the error
 * timing (after leaving a field, every error after a submit, focus on the first invalid one) and the read-out.
 */

const MEMBER: LobbyFormRules = { isGuest: false, costSets: [] };

function Host({
    rules = MEMBER,
    submitCount = 0,
}: {
    rules?: LobbyFormRules;
    submitCount?: number;
}) {
    const [value, setValue] = useState<LobbySettings>(() => initialLobbySettings(rules));
    const [presetKey, setPresetKey] = useState(BUILT_IN_PRESETS[0]?.key ?? '');
    return (
        <form>
            <LobbySettingsForm
                value={value}
                onChange={setValue}
                rules={rules}
                presets={BUILT_IN_PRESETS}
                presetKey={presetKey}
                onPresetChange={setPresetKey}
                errors={validateLobbySettings(value, rules)}
                submitCount={submitCount}
            />
        </form>
    );
}

const LOCKED_RULES: LobbyFormRules = {
    isGuest: false,
    costSets: [{ id: 4, name: 'Gone', gameMode: { tag: 'MemoryOfChaos' }, isLocked: true }],
};

/** A form whose value holds a locked cost set (an error only a submit shows). */
function Submitting({ submitCount }: { submitCount: number }) {
    const value = {
        ...initialLobbySettings(LOCKED_RULES),
        costSetId: 4,
        gameMode: 'MemoryOfChaos' as const,
    };
    return (
        <LobbySettingsForm
            value={value}
            onChange={() => {}}
            rules={LOCKED_RULES}
            presets={BUILT_IN_PRESETS}
            presetKey="builtin:classic"
            onPresetChange={() => {}}
            errors={validateLobbySettings(value, LOCKED_RULES)}
            submitCount={submitCount}
        />
    );
}

describe('LobbySettingsForm', () => {
    it('the main fields of the mockup, Cost Set for Rule Set, and one info mark per field that has one', () => {
        render(<Host />);
        expect(screen.getByRole('textbox', { name: 'Lobby Name' })).toHaveValue('');
        // S14.4c-fix S2: a masked text field, not `type="password"`, with autofill and the password managers off.
        const password = screen.getByLabelText('Lobby Password');
        expect(password).toHaveAttribute('type', 'text');
        expect(password).toHaveAttribute('data-masked');
        for (const [name, v] of [
            ['autocomplete', 'off'],
            ['data-1p-ignore', ''],
            ['data-lpignore', 'true'],
            ['data-bwignore', ''],
            ['data-form-type', 'other'],
        ] as const) {
            expect(password).toHaveAttribute(name, v);
        }
        expect(password.id).not.toMatch(/password/i);
        // The lobby name: not a person's name for autofill, not a username for a manager.
        const name = screen.getByRole('textbox', { name: 'Lobby Name' });
        expect(name).toHaveAttribute('autocomplete', 'off');
        expect(name).toHaveAttribute('data-1p-ignore', '');
        expect(name).toHaveAttribute('data-lpignore', 'true');
        expect(name).toHaveAttribute('data-bwignore', '');
        expect(name.id).not.toMatch(/name/i);
        for (const [name, value] of [
            ['Draft Mode', 'Classic'],
            ['Game Mode', 'ApocalypticShadow'],
            ['Cost Set', '0'],
            ['Ban Mode', 'Six'],
            ['Roster', 'OpenRoster'],
            ['Team Size', '3'],
            ['Settings Preset', 'builtin:classic'],
        ] as const) {
            expect(screen.getByRole('combobox', { name })).toHaveValue(value);
        }
        expect(screen.queryByRole('combobox', { name: 'Rule Set' })).toBeNull();
        const type = screen.getByRole('group', { name: 'Type' });
        expect(within(type).getByRole('button', { name: 'Casual' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(screen.getByRole('group', { name: 'Anonymous Players' })).toBeInTheDocument();
        expect(
            screen
                .getAllByRole('button', { name: /^About / })
                .map((b) => b.getAttribute('aria-label')),
        ).toEqual([
            // T-S14.4u: the preset's info mark (user request, 2026-11-18).
            'About Settings Preset',
            'About Draft Mode',
            'About Game Mode',
            'About Cost Set',
            'About Ban Mode',
            'About Type',
            'About Anonymous Players',
            'About Roster',
            'About Team Size',
        ]);
    });

    it('the password reveal toggles the text and its own name', async () => {
        const user = userEvent.setup();
        render(<Host />);
        const password = screen.getByLabelText('Lobby Password');
        expect(screen.queryByRole('button', { name: 'Show password' })).toBeNull();
        await user.type(password, 'abc');
        expect(password).toHaveAttribute('data-masked');
        await user.click(screen.getByRole('button', { name: 'Show password' }));
        // S14.4c-fix S2: the eye switches the mask; the type stays text.
        expect(password).not.toHaveAttribute('data-masked');
        expect(password).toHaveAttribute('type', 'text');
        expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    it('an error that appears on typing is read out once, half a second later', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
            const { container } = render(<Host />);
            const region = container.querySelector('[aria-live="polite"]');
            await user.type(screen.getByLabelText('Lobby Password'), '#');
            expect(region).toBeEmptyDOMElement();
            act(() => vi.advanceTimersByTime(500));
            expect(region).toHaveTextContent(
                'Lobby Password: Use letters and numbers only (A–⁠Z, a–⁠z, 0–⁠9).',
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('the read-out is cleared when its error goes, so the same error is read again', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
            const { container } = render(<Host />);
            const region = container.querySelector('[aria-live="polite"]');
            const password = screen.getByLabelText('Lobby Password');
            await user.type(password, '#');
            act(() => vi.advanceTimersByTime(500));
            expect(region).toHaveTextContent(/^Lobby Password: Use letters/);
            await user.type(password, '{Backspace}');
            expect(region).toBeEmptyDOMElement();
            await user.type(password, '#');
            act(() => vi.advanceTimersByTime(500));
            expect(region).toHaveTextContent(/^Lobby Password: Use letters/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a guest: the Ranked reason is visible words; the locked roster is focusable, says why, and ignores a change', () => {
        render(<Host rules={{ isGuest: true, costSets: [] }} />);
        expect(
            screen.getByText(
                'Guests can only create Casual lobbies. Sign in with Discord to play Ranked.',
                { selector: 'p' },
            ),
        ).toBeVisible();
        const roster = screen.getByRole('combobox', { name: 'Roster' });
        expect(roster).toHaveAttribute('aria-disabled', 'true');
        expect(roster).toBeEnabled();
        roster.focus();
        expect(roster).toHaveFocus();
        expect(roster).toHaveAccessibleDescription('Guests always play Closed No Rating.');
        fireEvent.change(roster, { target: { value: 'OpenRoster' } });
        expect(roster).toHaveValue('ClosedNoRating');
    });

    it('the preset sits above the fields it sets; a pick is announced; an edit shows "Custom"; a re-pick re-applies', async () => {
        const user = userEvent.setup();
        const { container } = render(<Host />);
        const preset = screen.getByRole('combobox', { name: 'Settings Preset' });
        const draftMode = screen.getByRole('combobox', { name: 'Draft Mode' });
        const password = screen.getByLabelText('Lobby Password');
        expect(
            password.compareDocumentPosition(preset) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            preset.compareDocumentPosition(draftMode) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        const status = container.querySelector('[data-preset-status]');

        await user.type(screen.getByRole('textbox', { name: 'Lobby Name' }), 'Mine');
        await user.type(password, 'abc');
        await user.selectOptions(preset, 'builtin:auction');
        expect(preset).toHaveValue('builtin:auction');
        expect(draftMode).toHaveValue('Auction');
        expect(status).toHaveTextContent('Default Auction applied.');
        // The name and the password are never the preset's.
        expect(screen.getByRole('textbox', { name: 'Lobby Name' })).toHaveValue('Mine');
        expect(password).toHaveValue('abc');

        await user.selectOptions(screen.getByRole('combobox', { name: 'Team Size' }), '1');
        expect(preset).toHaveValue('custom');
        expect(within(preset).getByRole('option', { name: 'Custom' })).toBeDisabled();
        expect(status).toBeEmptyDOMElement();

        await user.selectOptions(preset, 'builtin:auction');
        expect(preset).toHaveValue('builtin:auction');
        expect(screen.getByRole('combobox', { name: 'Team Size' })).toHaveValue('3');
        expect(within(preset).queryByRole('option', { name: 'Custom' })).toBeNull();
    });

    // T-S14.4u: the user's request of 2026-11-18.
    it('the preset has an info mark that opens its panel: what a preset fills in, what it keeps, and Custom', () => {
        render(<Host />);
        const mark = screen.getByRole('button', { name: 'About Settings Preset' });
        expect(mark).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(mark);
        expect(mark).toHaveAttribute('aria-expanded', 'true');
        const panel = mark.nextElementSibling as HTMLElement;
        expect(panel).not.toHaveAttribute('hidden');
        expect(panel.querySelector('p')?.textContent).toBe('Settings Preset');
        expect(panel.textContent).toContain(
            'Your lobby name, password and team names are never changed.',
        );
        expect(panel.textContent).toContain(
            'Change any setting it filled in and this shows Custom.',
        );
    });

    it('after a submit every error shows and the first invalid field takes focus', () => {
        const { rerender } = render(<Submitting submitCount={0} />);
        const costSet = screen.getByRole('combobox', { name: 'Cost Set' });
        expect(costSet).toHaveAttribute('aria-invalid', 'false');
        rerender(<Submitting submitCount={1} />);
        expect(costSet).toHaveAttribute('aria-invalid', 'true');
        expect(costSet).toHaveAccessibleDescription(
            'This cost set is not available. Pick another one.',
        );
        expect(costSet).toHaveFocus();
        expect(screen.getByRole('option', { name: 'Cost set 4' })).toBeInTheDocument();
    });
});
