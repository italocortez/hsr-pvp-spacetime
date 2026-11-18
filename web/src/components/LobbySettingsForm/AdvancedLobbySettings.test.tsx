import {
    applyLobbyPreset,
    BUILT_IN_PRESETS,
    initialLobbySettings,
    type LobbyFormRules,
    type LobbyNumberDrafts,
    type LobbySettings,
    validateLobbySettings,
} from '@shared/lobby-rules/lobbySettings';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AdvancedLobbySettings, type AdvancedLobbySettingsProps } from './AdvancedLobbySettings';
import { AdvancedSettingsDialog } from './AdvancedSettingsDialog';

/*
 * T-S14.4d: Advanced Settings on its own and in its dialog host: every module setting the dialog edits, the dropped
 * ones absent, number entry (units, decimals, hundredths, drafts), the rules shown (Classic / Auction, Ranked), the
 * error timing and the host's focus request.
 */

const MEMBER: LobbyFormRules = { isGuest: false, costSets: [] };
const GUEST: LobbyFormRules = { isGuest: true, costSets: [] };
const GUEST_OWNERSHIP_REASON =
    "Guests have no game account, so a guest's lobby cannot require ownership. Sign in with Discord to use it.";

type HostProps = {
    initial?: Partial<LobbySettings>;
    focusRequest?: number;
    submitCount?: number;
    onValue?: (value: LobbySettings) => void;
    /** T-S14.4d-fix: props for the lobby room's reuse (locks, read-only, no presets). */
    extra?: Partial<AdvancedLobbySettingsProps>;
};

function Host({ initial = {}, focusRequest = 0, submitCount = 0, onValue, extra }: HostProps) {
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
                {...extra}
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

    // T-S14.4u: a guest's lobby cannot require ownership (the module refuses it).
    it('a guest: Require Ownership shows Off, On is unavailable with the visible reason, and a click changes nothing', async () => {
        const user = userEvent.setup();
        const values: LobbySettings[] = [];
        render(
            <Host
                initial={initialLobbySettings(GUEST)}
                onValue={(v) => values.push(v)}
                extra={{ rules: GUEST }}
            />,
        );
        const ownership = screen.getByRole('group', { name: 'Require Ownership' });
        expect(within(ownership).getByRole('button', { pressed: true })).toHaveTextContent('Off');
        const on = within(ownership).getByRole('button', { name: 'On' });
        expect(on).toHaveAccessibleDescription(GUEST_OWNERSHIP_REASON);
        expect(screen.getByText(GUEST_OWNERSHIP_REASON, { selector: 'p' })).toBeVisible();
        await user.click(on);
        expect(values.every((v) => v.requireOwnership === false)).toBe(true);
        expect(within(ownership).getByRole('button', { pressed: true })).toHaveTextContent('Off');
    });

    it('a guest: a preset with Require Ownership on is applied Off and the note still names the preset', () => {
        const [classic] = BUILT_IN_PRESETS;
        if (!classic) throw new Error('built-ins');
        const owned = {
            key: 'preset:5',
            label: 'Owned only',
            values: { ...classic.values, requireOwnership: true },
        };
        const applied = applyLobbyPreset(initialLobbySettings(GUEST), owned, GUEST);
        expect(applied.requireOwnership).toBe(false);
        render(
            <Host
                initial={applied}
                extra={{ rules: GUEST, presets: [owned], presetKey: owned.key }}
            />,
        );
        expect(screen.getByText(/Settings Preset: Owned only\.$/)).toBeInTheDocument();
        // A member keeps it on, and the note names the preset too.
        expect(applyLobbyPreset(initialLobbySettings(MEMBER), owned, MEMBER).requireOwnership).toBe(
            true,
        );
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

    // T-S14.4d-fix (review D S4): a field never shows something other than what is sent.
    it('leaving a number field shows the text of the value it sends; a text that does not read stays', async () => {
        const user = userEvent.setup();
        const onValue = vi.fn();
        render(<Host initial={{ draftMode: 'Auction' }} onValue={onValue} />);
        const budget = textbox('Character Budget');
        for (const [typed, shown, sent] of [
            ['$5', '5', 5],
            [' 2,5 ', '2.5', 2.5],
            ['1.50', '1.5', 1.5],
        ] as const) {
            await user.clear(budget);
            await user.type(budget, typed);
            expect(budget).toHaveValue(typed);
            await user.tab();
            expect(budget).toHaveValue(shown);
            expect(onValue.mock.lastCall?.[0].characterBudget).toBe(sent);
        }
        // A third decimal is refused, not rounded (review D M6): the text stays beside its error.
        await user.clear(budget);
        await user.type(budget, '1.005');
        await user.tab();
        expect(budget).toHaveValue('1.005');
        expect(budget).toHaveAccessibleDescription(
            'The character budget is 0 to 100000, in steps of 0.01, with no thousands separator.',
        );
        const turn = textbox('Standard Turn (seconds)');
        await user.clear(turn);
        await user.type(turn, '45.');
        await user.tab();
        expect(turn).toHaveValue('45');
        const forfeit = textbox('Auto-Forfeit (seconds)');
        await user.clear(forfeit);
        await user.type(forfeit, '-0');
        await user.tab();
        expect(forfeit).toHaveValue('0');
        expect(Object.is(onValue.mock.lastCall?.[0].disconnectForfeitSeconds, 0)).toBe(true);
        const death = textbox('Death Penalty (points)');
        await user.clear(death);
        await user.type(death, '-0,50');
        await user.tab();
        expect(death).toHaveValue('-0.5');
    });

    // T-S14.4d-fix (review D M4): the module reads both in the Classic draft only.
    it('Auction: Mirror Picks and Random Auto-Pick turned on in Classic show Off', () => {
        render(
            <Host
                initial={{ draftMode: 'Auction', allowMirrorPicks: true, autoRandomPick: true }}
            />,
        );
        for (const name of ['Mirror Picks', 'Random Auto-Pick']) {
            const group = screen.getByRole('group', { name });
            expect(within(group).getByRole('button', { pressed: true })).toHaveTextContent('Off');
            expect(within(group).getByRole('button', { name: 'On' })).toHaveAttribute(
                'aria-disabled',
                'true',
            );
        }
    });

    // T-S14.4d-fix (review D M12): an error line inside the locked Auction group is never dimmed.
    it('the locked Auction group is dimmed only while none of its amounts holds an error', () => {
        const group = () =>
            screen.getByRole('heading', { name: /Auction Economy/ }).parentElement as HTMLElement;
        const { unmount } = render(<Host />);
        expect(group()).toHaveAttribute('data-locked');
        unmount();
        render(<Host initial={{ characterBudget: 100_001 }} submitCount={1} />);
        expect(group()).not.toHaveAttribute('data-locked');
        expect(textbox('Character Budget')).toHaveAccessibleDescription(
            /The character budget is 0 to 100000/,
        );
    });

    // T-S14.4d-fix: the pieces the lobby room will need.
    it('without presets there is no preset note', () => {
        render(<Host extra={{ presets: undefined, presetKey: undefined }} />);
        expect(screen.queryByText(/Settings Preset:/)).toBeNull();
        expect(screen.getByRole('combobox', { name: 'Ban Restriction' })).toBeInTheDocument();
    });

    it('a locked field is read-only and focusable with its reason; its info button still opens', async () => {
        const user = userEvent.setup();
        const onValue = vi.fn();
        const reason = 'The tournament sets this.';
        render(
            <Host
                onValue={onValue}
                extra={{
                    locks: {
                        lineupFormat: reason,
                        reserveBankSeconds: reason,
                        teamBlueAlias: reason,
                        hideMmr: reason,
                    },
                }}
            />,
        );
        const lineup = screen.getByRole('combobox', { name: 'Lineup Format' });
        expect(lineup).toHaveAttribute('aria-disabled', 'true');
        expect(lineup).toHaveAccessibleDescription(reason);
        fireEvent.change(lineup, { target: { value: 'Thirds' } });
        expect(lineup).toHaveValue('Halves');
        const reserve = textbox('Reserve Bank (seconds)');
        expect(reserve).toHaveAttribute('readonly');
        expect(reserve).toHaveAccessibleDescription(reason);
        reserve.focus();
        expect(reserve).toHaveFocus();
        const blue = textbox('Blue Team Name');
        expect(blue).toHaveAttribute('readonly');
        expect(blue).toHaveAccessibleDescription(reason);
        const hide = screen.getByRole('group', { name: 'Hide MMR' });
        expect(within(hide).getByRole('button', { name: 'On' })).toHaveAccessibleDescription(
            reason,
        );
        // Unlocked fields are untouched.
        expect(textbox('Standard Turn (seconds)')).not.toHaveAttribute('readonly');
        const info = screen.getByRole('button', { name: 'About Lineup Format' });
        await user.click(info);
        expect(info).toHaveAttribute('aria-expanded', 'true');
        expect(onValue).not.toHaveBeenCalled();
    });

    it('read-only for a non-host: every field read-only, one reason at the top, the info buttons work', async () => {
        const user = userEvent.setup();
        const reason = 'Only the host can change these settings.';
        render(<Host initial={{ draftMode: 'Auction' }} extra={{ readOnlyReason: reason }} />);
        // One visible line; the toggles' unavailable options carry it as their (visually hidden) description.
        const lines = document.querySelectorAll('[data-read-only-reason]');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toHaveTextContent(reason);
        expect(screen.getAllByText(reason).filter((el) => el.tagName === 'P')).toHaveLength(1);
        for (const name of ['Ban Restriction', 'Lineup Format', 'Disconnect Policy']) {
            const select = screen.getByRole('combobox', { name });
            expect(select).toHaveAttribute('aria-disabled', 'true');
            expect(select).toHaveAccessibleDescription(reason);
        }
        for (const name of ['Blue Team Name', 'Character Budget', 'Standard Turn (seconds)']) {
            expect(textbox(name)).toHaveAttribute('readonly');
            expect(textbox(name)).toHaveAccessibleDescription(reason);
        }
        const kick = screen.getByRole('group', { name: 'Referee Can Kick' });
        expect(within(kick).getByRole('button', { name: 'On' })).toHaveAttribute(
            'aria-disabled',
            'true',
        );
        const info = screen.getByRole('button', { name: 'About Character Budget' });
        expect(info).not.toBeDisabled();
        await user.click(info);
        expect(info).toHaveAttribute('aria-expanded', 'true');
    });
});

function DialogHost({
    initial = {},
    startOpen = true,
}: {
    initial?: Partial<LobbySettings>;
    /** T-S14.4d-fix: false opens it from the "Open" button, as a person does. */
    startOpen?: boolean;
}) {
    const [open, setOpen] = useState(startOpen);
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
    // T-S14.4d-fix (review D S1, the review's probe P1 as a test): the Ban Restriction info panel opened by itself.
    it.each([
        ['a pointer click', 'pointer'],
        ['the keyboard (Enter on the button)', 'keyboard'],
    ] as const)('opened by %s: focus on the first field, no info panel opens', (_how, how) => {
        vi.useFakeTimers();
        try {
            render(<DialogHost startOpen={false} />);
            const openButton = screen.getByRole('button', { name: 'Open' });
            if (how === 'pointer') {
                fireEvent.pointerDown(openButton);
                fireEvent.click(openButton);
            } else {
                openButton.focus();
                fireEvent.keyDown(openButton, { key: 'Enter' });
                fireEvent.click(openButton);
            }
            const dialog = screen.getByRole('dialog', { name: 'Advanced Settings' });
            expect(within(dialog).getByRole('combobox', { name: 'Ban Restriction' })).toHaveFocus();
            act(() => {
                vi.advanceTimersByTime(1000);
            });
            for (const info of within(dialog).getAllByRole('button', { name: /^About / }))
                expect(info).toHaveAttribute('aria-expanded', 'false');
            expect(within(dialog).queryByRole('tooltip')).toBeNull();
            expect(within(dialog).queryByText(/Caps how many characters/)).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

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
