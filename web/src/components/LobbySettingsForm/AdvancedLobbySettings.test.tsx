import {
    BUILT_IN_PRESETS,
    initialLobbySettings,
    type LobbyFormRules,
    type LobbyNumberDrafts,
    type LobbySettings,
    validateLobbySettings,
} from '@shared/lobby-rules/lobbySettings';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AdvancedLobbySettings } from './AdvancedLobbySettings';
import { AdvancedSettingsDialog } from './AdvancedSettingsDialog';

/*
 * T-S14.4d: Advanced Settings on its own and in its dialog host: every module setting the dialog edits, the dropped
 * ones absent, number entry (units, decimals, hundredths, drafts), the rules shown (Classic / Auction, Ranked), the
 * error timing and the host's focus request.
 */

const MEMBER: LobbyFormRules = { isGuest: false, costSets: [] };

type HostProps = {
    initial?: Partial<LobbySettings>;
    focusRequest?: number;
    submitCount?: number;
    onValue?: (value: LobbySettings) => void;
};

function Host({ initial = {}, focusRequest = 0, submitCount = 0, onValue }: HostProps) {
    const [value, setValue] = useState<LobbySettings>(() => ({
        ...initialLobbySettings(MEMBER),
        ...initial,
    }));
    const [drafts, setDrafts] = useState<LobbyNumberDrafts>({});
    return (
        <form>
            <AdvancedLobbySettings
                value={value}
                onChange={(next) => {
                    setValue(next);
                    onValue?.(next);
                }}
                rules={MEMBER}
                errors={validateLobbySettings(value, MEMBER)}
                submitCount={submitCount}
                focusRequest={focusRequest}
                drafts={drafts}
                onDraftsChange={setDrafts}
                presets={BUILT_IN_PRESETS}
                presetKey="builtin:classic"
            />
        </form>
    );
}

const textbox = (name: string | RegExp) => screen.getByRole('textbox', { name });

describe('AdvancedLobbySettings', () => {
    it('every advanced setting of create_lobby has a field, the mockup groups in order; the dropped ones are absent', () => {
        render(<Host />);
        const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
        expect(headings).toEqual([
            'Match',
            'Auction EconomyAuction draft only',
            'Handicap / Scoringoptional · 0 = no effect',
            'Ownership',
            'Timers',
            'Referee Powers & Pausing',
            'Privacy & Access',
            'Disconnect Handling',
        ]);
        for (const name of ['Ban Restriction', 'Lineup Format', 'Disconnect Policy'])
            expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
        for (const name of [
            'Blue Team Name',
            'Red Team Name',
            'Character Budget',
            'Light Cone Budget',
            'Minimum Bid Raise',
            'Death Penalty (points)',
            /^Roster Diff Advantage \(points per point/,
            'Roster Threshold (roster cost)',
            'Under-Threshold Advantage (points)',
            'Above-Threshold Penalty (points)',
            'Standard Turn (seconds)',
            'Reserve Bank (seconds)',
            'Confirm Window (seconds)',
            'Spectators (at most)',
            'Auto-Forfeit (seconds)',
        ])
            expect(textbox(name)).toBeInTheDocument();
        for (const name of [
            'Mirror Picks',
            'Random Auto-Pick',
            'Require Ownership',
            'Referee Can Undo',
            'Referee Can Pause',
            'Referee Can Set Captain',
            'Referee Can Kick',
            'Players Can Pause',
            'Referee-Only Concede',
            'Anonymous Spectators',
            'Hide MMR',
        ])
            expect(screen.getByRole('group', { name })).toBeInTheDocument();
        // A67 and A91: no series settings, no Deferred.
        expect(screen.queryByText(/Best Of|Bo3|Shelving/)).toBeNull();
        const policy = screen.getByRole('combobox', { name: 'Disconnect Policy' });
        expect(
            within(policy)
                .getAllByRole('option')
                .map((o) => o.textContent),
        ).toEqual(['Standard', 'No Action']);
        // Six ban restrictions (A221 R4).
        expect(
            within(screen.getByRole('combobox', { name: 'Ban Restriction' })).getAllByRole(
                'option',
            ),
        ).toHaveLength(6);
        expect(screen.getByText(/Settings Preset: Default Classic\./)).toBeInTheDocument();
    });

    it('the defaults: the module defaults (A221 R5) and the mockup values', () => {
        render(<Host />);
        expect(textbox('Standard Turn (seconds)')).toHaveValue('60');
        expect(textbox('Reserve Bank (seconds)')).toHaveValue('120');
        expect(textbox('Confirm Window (seconds)')).toHaveValue('60');
        expect(textbox('Spectators (at most)')).toHaveValue('12');
        expect(textbox('Auto-Forfeit (seconds)')).toHaveValue('0');
        expect(textbox('Character Budget')).toHaveValue('30');
        expect(textbox('Light Cone Budget')).toHaveValue('15');
        expect(textbox('Minimum Bid Raise')).toHaveValue('5');
        expect(screen.getByRole('combobox', { name: 'Lineup Format' })).toHaveValue('Halves');
        const pressed = (group: string) =>
            within(screen.getByRole('group', { name: group })).getByRole('button', {
                pressed: true,
            }).textContent;
        expect(pressed('Referee-Only Concede')).toBe('On');
        expect(pressed('Referee Can Kick')).toBe('Off');
        expect(pressed('Mirror Picks')).toBe('Off');
        expect(pressed('Hide MMR')).toBe('Off');
    });

    it('handicap points are typed with a dot or a comma and kept in hundredths, exactly', async () => {
        const user = userEvent.setup();
        const onValue = vi.fn();
        render(<Host onValue={onValue} />);
        const death = textbox('Death Penalty (points)');
        await user.clear(death);
        await user.type(death, '1,15');
        expect(death).toHaveValue('1,15');
        expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ deathPenalty: 115 }));
        const raise = textbox('Minimum Bid Raise');
        // Locked in Classic: read-only.
        expect(raise).toHaveAttribute('readonly');
    });

    it('a text that does not read keeps its text, holds NaN, and shows its error once the field is left', async () => {
        const user = userEvent.setup();
        const onValue = vi.fn();
        render(<Host onValue={onValue} />);
        const turn = textbox('Standard Turn (seconds)');
        await user.clear(turn);
        await user.type(turn, 'abc');
        expect(turn).toHaveValue('abc');
        expect(onValue.mock.lastCall?.[0].standardTurnSeconds).toBeNaN();
        expect(turn).toHaveAttribute('aria-invalid', 'false');
        await user.tab();
        expect(turn).toHaveAttribute('aria-invalid', 'true');
        expect(turn).toHaveAccessibleDescription('The standard turn is 10 to 600 seconds.');
    });

    it('the unit follows the game mode: cycles for Memory of Chaos', () => {
        render(<Host initial={{ gameMode: 'MemoryOfChaos' }} />);
        expect(textbox('Death Penalty (cycles)')).toBeInTheDocument();
    });

    it('Classic: the Auction economy is read-only with its reason; Auction: editable, and the Classic-only toggles say why', () => {
        const { unmount } = render(<Host />);
        const budget = textbox('Character Budget');
        expect(budget).toHaveAttribute('readonly');
        expect(budget).toHaveAttribute('aria-disabled', 'true');
        expect(budget).toHaveAccessibleDescription(
            'Auction draft only: a Classic lobby does not use these.',
        );
        unmount();
        render(<Host initial={{ draftMode: 'Auction' }} />);
        expect(textbox('Character Budget')).not.toHaveAttribute('readonly');
        const mirror = screen.getByRole('group', { name: 'Mirror Picks' });
        expect(within(mirror).getByRole('button', { name: 'On' })).toHaveAttribute(
            'aria-disabled',
            'true',
        );
        expect(within(mirror).getByRole('button', { name: 'On' })).toHaveAccessibleDescription(
            'Classic draft only: an Auction lobby does not use it.',
        );
    });

    it('a locked Auction amount that holds an error stays editable, so it can be fixed', () => {
        render(<Host initial={{ characterBudget: 100_001 }} />);
        expect(textbox('Character Budget')).not.toHaveAttribute('readonly');
        expect(textbox('Light Cone Budget')).toHaveAttribute('readonly');
    });

    it('Ranked: mirror picks show Off with On unavailable (D-42), No Action is not offered (A92(3))', () => {
        render(<Host initial={{ matchType: 'Ranked', allowMirrorPicks: true }} />);
        const mirror = screen.getByRole('group', { name: 'Mirror Picks' });
        expect(within(mirror).getByRole('button', { pressed: true })).toHaveTextContent('Off');
        expect(within(mirror).getByRole('button', { name: 'On' })).toHaveAccessibleDescription(
            'Ranked lobbies never allow mirror picks.',
        );
        const noAction = within(
            screen.getByRole('combobox', { name: 'Disconnect Policy' }),
        ).getByRole('option', { name: 'No Action (Casual only)' });
        expect(noAction).toBeDisabled();
    });

    it('an Auction raise of 0 is an error in an Auction lobby only (A224)', () => {
        render(<Host initial={{ draftMode: 'Auction', minimumBidRaise: 0 }} submitCount={1} />);
        expect(textbox('Minimum Bid Raise')).toHaveAccessibleDescription(
            'An Auction lobby needs a minimum bid raise above 0.',
        );
    });

    it('the host focus request moves focus to the first invalid field here; a submit alone does not', async () => {
        const initial = { reserveBankSeconds: 5000, maxSpectators: 20 };
        const { rerender } = render(<Host initial={initial} focusRequest={0} submitCount={1} />);
        expect(document.activeElement).toBe(document.body);
        rerender(<Host initial={initial} focusRequest={0} submitCount={2} />);
        await act(async () => {});
        expect(document.activeElement).toBe(document.body);
        rerender(<Host initial={initial} focusRequest={1} submitCount={2} />);
        await waitFor(() => expect(textbox('Reserve Bank (seconds)')).toHaveFocus());
    });
});

function DialogHost({ initial = {} }: { initial?: Partial<LobbySettings> }) {
    const [open, setOpen] = useState(true);
    const [value, setValue] = useState<LobbySettings>(() => ({
        ...initialLobbySettings(MEMBER),
        ...initial,
    }));
    const [drafts, setDrafts] = useState<LobbyNumberDrafts>({});
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                Open
            </button>
            <AdvancedSettingsDialog
                open={open}
                onClose={() => setOpen(false)}
                focusRequest={0}
                value={value}
                onChange={setValue}
                rules={MEMBER}
                errors={validateLobbySettings(value, MEMBER)}
                submitCount={0}
                drafts={drafts}
                onDraftsChange={setDrafts}
                presets={BUILT_IN_PRESETS}
                presetKey="builtin:classic"
            />
        </>
    );
}

describe('AdvancedSettingsDialog', () => {
    it('Done closes it when nothing needs a fix', async () => {
        const user = userEvent.setup();
        render(<DialogHost />);
        const dialog = screen.getByRole('dialog', { name: 'Advanced Settings' });
        await user.click(within(dialog).getByRole('button', { name: 'Done' }));
        expect(screen.queryByRole('dialog', { name: 'Advanced Settings' })).toBeNull();
    });

    it('Done with an invalid field stays open, shows the error and focuses the field', async () => {
        const user = userEvent.setup();
        render(<DialogHost />);
        const dialog = screen.getByRole('dialog', { name: 'Advanced Settings' });
        const turn = within(dialog).getByRole('textbox', { name: 'Standard Turn (seconds)' });
        await user.clear(turn);
        await user.type(turn, '5');
        await user.click(within(dialog).getByRole('button', { name: 'Done' }));
        expect(screen.getByRole('dialog', { name: 'Advanced Settings' })).toBeInTheDocument();
        await waitFor(() => expect(turn).toHaveFocus());
        expect(turn).toHaveAttribute('aria-invalid', 'true');
    });

    it('reopened while a setting needs a fix, it shows the error at once; the typed text is kept', async () => {
        const user = userEvent.setup();
        render(<DialogHost />);
        let dialog = screen.getByRole('dialog', { name: 'Advanced Settings' });
        const reserve = within(dialog).getByRole('textbox', { name: 'Reserve Bank (seconds)' });
        await user.clear(reserve);
        await user.type(reserve, '2000');
        await user.click(within(dialog).getByRole('button', { name: 'Close Advanced Settings' }));
        expect(screen.queryByRole('dialog', { name: 'Advanced Settings' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Open' }));
        dialog = screen.getByRole('dialog', { name: 'Advanced Settings' });
        const again = within(dialog).getByRole('textbox', { name: 'Reserve Bank (seconds)' });
        expect(again).toHaveValue('2000');
        expect(again).toHaveAttribute('aria-invalid', 'true');
        expect(again).toHaveAccessibleDescription('The reserve bank is 0 to 1800 seconds.');
    });
});
