import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog, type DialogProps } from './Dialog';
import { dialogInTurn } from './dialogQueue';

/*
 * T-S14.4b: the shared modal dialog. jsdom has no `showModal` or `close`: the dialog opens by its `open` attribute
 * and closes by removing it and sending `close` (the component's fallback), so these tests check the component's own
 * rules (names, focus, values, the page's close, the dismiss switch, stacking), not the browser's top layer.
 */

type Props = Partial<DialogProps> & { children?: ReactNode };

function renderDialog(props: Props = {}) {
    const onClose = props.onClose ?? vi.fn();
    const view = (p: Props) => (
        <Dialog
            open={p.open ?? true}
            onClose={onClose}
            title={p.title ?? 'Delete Hyper?'}
            {...p}
            actions={
                p.actions ?? (
                    <>
                        <button type="submit" value="cancel">
                            Cancel
                        </button>
                        <button type="submit" value="delete">
                            Delete
                        </button>
                    </>
                )
            }
        />
    );
    const r = render(view(props));
    return { onClose, rerender: (p: Props) => r.rerender(view({ ...props, ...p })) };
}

const dialog = () => document.querySelector('dialog') as HTMLDialogElement;

/** A dialog whose second button is the chosen initial focus. */
function Chosen() {
    const ref = useRef<HTMLButtonElement>(null);
    return (
        <Dialog
            open
            onClose={() => {}}
            title="T"
            initialFocus={ref}
            actions={
                <>
                    <button type="submit" value="a">
                        A
                    </button>
                    <button ref={ref} type="submit" value="b">
                        B
                    </button>
                </>
            }
        />
    );
}

/** A dialog with a button that opens a second dialog over it (the create form and its Advanced Settings). */
function Stacked({
    outerClose,
    innerClose,
}: {
    outerClose: (value: string) => void;
    innerClose: (value: string) => void;
}) {
    const [inner, setInner] = useState(false);
    const opener = useRef<HTMLButtonElement>(null);
    return (
        <Dialog
            open
            onClose={outerClose}
            title="Create Lobby"
            actions={<button type="submit">Create</button>}
        >
            <button ref={opener} type="button" onClick={() => setInner(true)}>
                Advanced Settings
            </button>
            <Dialog
                open={inner}
                onClose={(value) => {
                    setInner(false);
                    innerClose(value);
                }}
                title="Advanced Settings"
                returnFocus={opener}
                actions={
                    <button type="submit" value="done">
                        Done
                    </button>
                }
            />
        </Dialog>
    );
}

describe('Dialog: names, place and attributes', () => {
    it('is named by its heading, described by its description, and rendered into the body', () => {
        renderDialog({ description: 'It is removed from this browser.', 'data-test-dialog': '' });
        const d = screen.getByRole('dialog', { name: 'Delete Hyper?' });
        expect(d).toHaveAccessibleDescription('It is removed from this browser.');
        expect(d.parentElement).toBe(document.body);
        expect(d).toHaveAttribute('open');
        expect(d).toHaveAttribute('data-test-dialog');
        expect(within(d).getByRole('heading', { level: 2 })).toHaveTextContent('Delete Hyper?');
        expect(d).not.toHaveAttribute('role');
        expect(d).not.toHaveAttribute('aria-modal');
    });

    it('describedBy names an element of the body instead', () => {
        renderDialog({ describedBy: 'hint', children: <p id="hint">Nothing is saved.</p> });
        expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Nothing is saved.');
    });

    it('closedby: closerequest by default, any with closeOnBackdrop, none while not dismissible', () => {
        const { rerender } = renderDialog();
        expect(dialog()).toHaveAttribute('closedby', 'closerequest');
        rerender({ closeOnBackdrop: true });
        expect(dialog()).toHaveAttribute('closedby', 'any');
        rerender({ closeOnBackdrop: true, dismissible: false });
        expect(dialog()).toHaveAttribute('closedby', 'none');
    });

    it('closed: the dialog element stays, its content does not', () => {
        renderDialog({ open: false });
        expect(dialog()).not.toHaveAttribute('open');
        expect(dialog().childElementCount).toBe(0);
    });
});

describe('Dialog: focus', () => {
    it('the first control takes focus, not the close button', () => {
        renderDialog({ closeLabel: 'Close' });
        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });

    it('initialFocus wins', () => {
        render(<Chosen />);
        expect(screen.getByRole('button', { name: 'B' })).toHaveFocus();
    });

    it('only the close button: it takes focus', () => {
        renderDialog({ closeLabel: 'Close', actions: <span>no controls</span> });
        expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });

    it('a new focusKey while open places the focus again', () => {
        const { rerender } = renderDialog({ focusKey: 1 });
        act(() => screen.getByRole('button', { name: 'Delete' }).focus());
        rerender({ focusKey: 2 });
        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });

    it('returnFocus takes focus after a close the person made', async () => {
        const user = userEvent.setup();
        const opener = document.createElement('button');
        document.body.append(opener);
        renderDialog({ returnFocus: opener });
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(opener).toHaveFocus();
        opener.remove();
    });
});

describe('Dialog: closing', () => {
    it('a submit button closes it with its value; the page then sets open to false', async () => {
        const user = userEvent.setup();
        const { onClose, rerender } = renderDialog();
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onClose).toHaveBeenCalledExactlyOnceWith('delete');
        expect(dialog()).not.toHaveAttribute('open');
        rerender({ open: false });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('the close button closes it with an empty value', async () => {
        const user = userEvent.setup();
        const { onClose } = renderDialog({ closeLabel: 'Close sign-in' });
        await user.click(screen.getByRole('button', { name: 'Close sign-in' }));
        expect(onClose).toHaveBeenCalledExactlyOnceWith('');
    });

    it('a close by the page (open turns false) calls nothing', () => {
        const { onClose, rerender } = renderDialog();
        rerender({ open: false });
        expect(dialog()).not.toHaveAttribute('open');
        expect(onClose).not.toHaveBeenCalled();
        rerender({ open: true });
        expect(dialog()).toHaveAttribute('open');
    });

    it('Escape (the cancel event) is let through, and blocked while not dismissible', () => {
        const { rerender } = renderDialog({ closeLabel: 'Close' });
        expect(fireEvent(dialog(), new Event('cancel', { cancelable: true }))).toBe(true);
        rerender({ dismissible: false });
        expect(fireEvent(dialog(), new Event('cancel', { cancelable: true }))).toBe(false);
        expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    });

    it('onSubmit: the page handles its form, the dialog stays open', async () => {
        const user = userEvent.setup();
        const onSubmit = vi.fn();
        const { onClose } = renderDialog({
            onSubmit,
            children: <input aria-label="Name" />,
            actions: <button type="submit">Create</button>,
        });
        await user.click(screen.getByRole('button', { name: 'Create' }));
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit.mock.calls[0]?.[0].defaultPrevented).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
        expect(dialog()).toHaveAttribute('open');
    });
});

describe('Dialog: a second dialog over the first', () => {
    it('both open; the second closes alone, the first keeps its state, focus goes back into the first', async () => {
        const user = userEvent.setup();
        const outerClose = vi.fn();
        const innerClose = vi.fn();
        render(<Stacked outerClose={outerClose} innerClose={innerClose} />);
        await user.click(screen.getByRole('button', { name: 'Advanced Settings' }));
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(2);
        const inner = screen.getByRole('dialog', { name: 'Advanced Settings' });
        // Not a form inside a form: each dialog is its own element in the body.
        expect(inner.parentElement).toBe(document.body);
        expect(within(inner).getByRole('button', { name: 'Done' })).toHaveFocus();
        // Escape on the second: only its cancel.
        expect(fireEvent(inner, new Event('cancel', { cancelable: true }))).toBe(true);
        await user.click(within(inner).getByRole('button', { name: 'Done' }));
        expect(innerClose).toHaveBeenCalledExactlyOnceWith('done');
        expect(outerClose).not.toHaveBeenCalled();
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
        expect(screen.getByRole('button', { name: 'Advanced Settings' })).toHaveFocus();
    });
});

describe('dialogInTurn: one dialog at a time', () => {
    const order = ['delete', 'held', 'notice'] as const;
    it('the first wanted in the order', () => {
        expect(dialogInTurn(order, { delete: false, held: true, notice: true })).toBe('held');
        expect(dialogInTurn(order, { notice: true })).toBe('notice');
        expect(dialogInTurn(order, { delete: true, notice: true })).toBe('delete');
        expect(dialogInTurn(order, {})).toBeNull();
    });
});
