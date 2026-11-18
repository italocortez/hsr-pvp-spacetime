import type { CostSet, LobbyPresetViewRow } from '@bindings/types';
import {
    advancedErrorKeys,
    awayLobbyOf,
    awayPromptCode,
    heldLobbyOf,
    LOBBY_MAIN_FIELDS,
    type LobbyFormRules,
    type LobbyNumberDrafts,
    type LobbySettings,
    lobbyHoldOf,
    lobbyLabel,
    lobbyPresetChoices,
    lobbySettingsChanged,
    settleLobbySettings,
    toCreateLobbyArgs,
    validateLobbySettings,
} from '@shared/lobby-rules/lobbySettings';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@/components/Dialog/Dialog';
import { GearIcon } from '@/components/GearIcon/GearIcon';
import { AdvancedSettingsDialog } from '@/components/LobbySettingsForm/AdvancedSettingsDialog';
import { LobbySettingsForm } from '@/components/LobbySettingsForm/LobbySettingsForm';
import { ADVANCED_TEXT } from '@/components/LobbySettingsForm/lobbySettingsText';
import { useStdbConnection } from '@/stdb/connectionContext';
import { getMyLobbies, subscribeMyLobbies, useMyLobbies } from '@/stdb/myLobbies';
import { NotConnectedError, useReducerCall } from '@/stdb/useReducerCall';
import { useRouteSubscriptions } from '@/stdb/useRouteSubscriptions';
import { useRows } from '@/stdb/useRows';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './CreateLobbyDialog.module.css';
import { CREATE_LOBBY_QUERIES } from './createLobbyQueries';
import { CREATE_LOBBY_TEXT as TEXT } from './createLobbyText';

/** The form's state, kept by the host while the dialog is closed (see `CreateLobbyFlow`). */
export type CreateLobbyDraft = {
    settings: LobbySettings;
    presetKey: string;
    /** The value it opened with: closing asks before discarding once the settings differ from it. */
    initial: LobbySettings;
};

export type CreateLobbyDialogProps = {
    draft: CreateLobbyDraft;
    /** Changes the draft from its latest value (two changes in one event both land). */
    onDraft: (update: (draft: CreateLobbyDraft) => CreateLobbyDraft) => void;
    isGuest: boolean;
    /**
     * The person closed it. `discard`: they confirmed (or nothing was changed): the next open starts fresh. `keep`: it
     * closed with changes and no confirmation (Chromium's second Escape in a row cannot be refused): the next open
     * shows them again.
     */
    onClose: (outcome: 'discard' | 'keep') => void;
    /** The lobby exists and is the person's: the host goes there. */
    onCreated: (lobbyId: number) => void;
    /** "Go to your lobby": another lobby holds the person (taken in another tab); the draft stays for later. */
    onOpenLobby: (lobbyId: number) => void;
    /**
     * The outcome is not known (a lost answer, a server error, a created lobby that did not arrive) and no new lobby
     * came: the host closes the dialog, keeps the draft, and shows `text` under "Play Now".
     */
    onUnresolved: (text: string) => void;
    returnFocus: HTMLElement | null;
};

/** How long it waits for the new lobby to arrive in `view_my_lobbies` after the call resolved (or was lost). */
export const NEW_LOBBY_WAIT_MS = 10_000;

/**
 * The give-up question's confirm button ignores a press this soon after the question opened: the second click of a
 * double click on Create never lands on it.
 */
export const ABANDON_CONFIRM_GUARD_MS = 500;

const NONE: readonly string[] = [];

/** A lobby that was not among `before` and holds the person (their new one), or undefined. */
function newLobbyId(before: ReadonlySet<number>): number | undefined {
    return getMyLobbies().rows.find((r) => !before.has(r.id) && lobbyHoldOf(r) === 'held')?.id;
}

/** The new lobby's id once it is in `view_my_lobbies`, or undefined after `ms`. */
function waitForNewLobby(before: ReadonlySet<number>, ms: number): Promise<number | undefined> {
    const now = newLobbyId(before);
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((resolve) => {
        const done = (id: number | undefined) => {
            clearTimeout(timer);
            stop();
            resolve(id);
        };
        const stop = subscribeMyLobbies(() => {
            const id = newLobbyId(before);
            if (id !== undefined) done(id);
        });
        const timer = setTimeout(() => done(undefined), ms);
    });
}

/** What a failed call means for the dialog. */
type CallOutcome =
    /** The module refused: its sentence in the error slot. */
    | { kind: 'refused'; text: string }
    /** The module's A68(4) prompt: ask the give-up question for the lobby with this join code. */
    | { kind: 'away'; code: string }
    /** Not sent: the error slot. */
    | { kind: 'notSent' }
    /** The answer is unknown or the server failed: wait for the row as on success, else this line under Play Now. */
    | { kind: 'unknown'; text: string };

function callOutcome(error: unknown): CallOutcome {
    if (error instanceof NotConnectedError) return { kind: 'notSent' };
    if (error instanceof Error && error.name === 'DisconnectedError') return { kind: 'notSent' };
    if (error instanceof Error && error.name === 'SenderError') {
        const text = error.message.trim();
        const code = awayPromptCode(text);
        if (code !== undefined) return { kind: 'away', code };
        return { kind: 'refused', text: text.slice(0, 300) || TEXT.refused };
    }
    if (error instanceof Error && error.name === 'InternalError')
        return { kind: 'unknown', text: TEXT.internal };
    return { kind: 'unknown', text: TEXT.unknown };
}

/**
 * The create-lobby dialog (S14.4c; design/mockups/index.html Create Lobby): the shared lobby settings form in the
 * shared modal dialog. While open it subscribes the published cost sets and the presets (dropped on close). Create
 * calls `create_lobby` with the form's value (`toCreateLobbyArgs`); the dialog cannot be dismissed while the call is
 * in flight; a refusal keeps it open with the module's sentence in the error slot. Success, and an answer that was
 * lost, wait for the new row of `view_my_lobbies` and hand its id to the host; with no row the host closes the dialog
 * (draft kept) and says so under "Play Now". Closing with changes asks first (the Dialog's `canClose`; advanced edits
 * count too).
 *
 * Advanced Settings (S14.4d, the mockup's form, look question L3 option A): "Advanced Settings" opens the shared
 * `AdvancedSettingsDialog` over this one; Create stays here. The button carries a count while a setting there needs a
 * fix. Create with an invalid field focuses the first invalid main field, or, when every main field is valid, opens
 * Advanced Settings and focuses its first invalid field. The number fields' texts are kept here (`drafts`).
 *
 * The A68(4) rule (S1): a person away from a live match (their `view_my_lobbies` row, or the module's prompt) is asked
 * in a second dialog over this one, naming that lobby, "Keep my match" focused; only its confirm button sends
 * `abandonCurrentMatch`. Create never changes its label or meaning.
 */
export function CreateLobbyDialog({
    draft,
    onDraft,
    isGuest,
    onClose,
    onCreated,
    onOpenLobby,
    onUnresolved,
    returnFocus,
}: CreateLobbyDialogProps) {
    const conn = useStdbConnection();
    // As the partner servers: a connection without the handles (the earlier steps' test doubles) subscribes nothing.
    const hasViews = conn?.db.viewLobbyPresets !== undefined;
    const { ready } = useRouteSubscriptions(hasViews ? CREATE_LOBBY_QUERIES : NONE);
    const costSetRows = useRows<CostSet>(
        (c) => (hasViews ? c.db.viewPublishedCostSets : undefined),
        ready,
    );
    const presetRows = useRows<LobbyPresetViewRow>((c) => c.db.viewLobbyPresets, ready);
    const myLobbies = useMyLobbies();
    const createLobby = useReducerCall((r, args: ReturnType<typeof toCreateLobbyArgs>) => {
        if (!r.createLobby) throw new NotConnectedError();
        return r.createLobby(args);
    });

    const rules: LobbyFormRules = useMemo(
        () => ({ isGuest, costSets: costSetRows }),
        [isGuest, costSetRows],
    );
    const presets = useMemo(() => lobbyPresetChoices(presetRows), [presetRows]);
    const { settings, presetKey, initial } = draft;
    const errors = validateLobbySettings(settings, rules);
    // Until the cost sets arrive a kept custom set is unknown, not unavailable: the module checks it on Create.
    if (!ready) delete errors.costSetId;
    const changed = lobbySettingsChanged(settings, initial);

    const [submitCount, setSubmitCount] = useState(0);
    const [sending, setSending] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    /** The give-up question is open for this lobby (its label). */
    const [abandonAsk, setAbandonAsk] = useState<string | null>(null);
    const askedAt = useRef(0);
    /** Advanced Settings is open (the second dialog). */
    const [advancedOpen, setAdvancedOpen] = useState(false);
    /** Bumped by a Create that found an invalid advanced setting and none in the main fields: focus goes there. */
    const [advancedFocus, setAdvancedFocus] = useState(0);
    /** The number fields' texts as typed (kept here, so they outlive the Advanced dialog). */
    const [drafts, setDrafts] = useState<LobbyNumberDrafts>({});
    const advancedRef = useRef<HTMLButtonElement>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    // The cost sets arrive after the first render: a draft holding a custom set takes its game mode then.
    useEffect(() => {
        onDraft((d) => {
            const settled = settleLobbySettings(d.settings, rules);
            return settled === d.settings ? d : { ...d, settings: settled };
        });
    }, [rules, onDraft]);

    // Another lobby holds the person (another tab, another device): Create would be refused; offer the way there. Not
    // while a call is in flight: the person's own new lobby arrives then.
    const held = sending ? undefined : heldLobbyOf(myLobbies);

    const setSettings = (next: LobbySettings) => {
        onDraft((d) => ({ ...d, settings: next }));
        if (formError !== null && !sending) setFormError(null);
    };

    const ask = (label: string) => {
        askedAt.current = performance.now();
        setAbandonAsk(label);
    };

    const send = async (abandonCurrentMatch: boolean) => {
        setFormError(null);
        setSending(true);
        const before = new Set(getMyLobbies().rows.map((r) => r.id));
        let unresolved: string = TEXT.notShown;
        try {
            await createLobby(toCreateLobbyArgs(settings, { abandonCurrentMatch }));
        } catch (error) {
            if (!alive.current) return;
            const outcome = callOutcome(error);
            if (outcome.kind !== 'unknown') {
                setSending(false);
                if (outcome.kind === 'away') {
                    const row = getMyLobbies().rows.find((r) => r.joinCode === outcome.code);
                    ask(row ? lobbyLabel(row) : outcome.code);
                } else {
                    setFormError(outcome.kind === 'notSent' ? TEXT.notConnected : outcome.text);
                }
                return;
            }
            // The lobby may exist (a lost answer): Layer 0 re-subscribes after a reconnect and its row arrives.
            unresolved = outcome.text;
        }
        const lobbyId = await waitForNewLobby(before, NEW_LOBBY_WAIT_MS);
        if (!alive.current) return;
        setSending(false);
        if (lobbyId === undefined) {
            onUnresolved(unresolved);
            return;
        }
        onCreated(lobbyId);
    };

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (sending || abandonAsk !== null) return;
        setSubmitCount((n) => n + 1);
        if (Object.keys(errors).length > 0) {
            setFormError(null);
            // The main fields come first: their own hook focuses the first invalid one. Otherwise Advanced Settings
            // opens and its first invalid field takes focus.
            const onMain = LOBBY_MAIN_FIELDS.some((k) => errors[k] !== undefined);
            if (!onMain) {
                setAdvancedFocus((n) => n + 1);
                setAdvancedOpen(true);
            }
            return;
        }
        const rows = getMyLobbies().rows;
        // The offer to go there is already in the error slot.
        if (heldLobbyOf(rows)) return;
        const away = awayLobbyOf(rows);
        if (away) {
            setFormError(null);
            ask(lobbyLabel(away));
            return;
        }
        void send(false);
    };

    const advancedErrors = advancedErrorKeys(errors).length;
    const errorSlot = held ? (
        <span className={styles.held}>
            {TEXT.heldElsewhere(lobbyLabel(held))}{' '}
            <button type="button" className={styles.link} onClick={() => onOpenLobby(held.id)}>
                {TEXT.goToLobby}
            </button>
        </span>
    ) : (
        formError
    );
    return (
        <>
            <Dialog
                open
                onClose={() => onClose(changed ? 'keep' : 'discard')}
                title={TEXT.title}
                closeLabel={TEXT.close}
                // Phones: the full-screen sheet (user ruling B); the questions stacked over it stay small cards.
                size="sheet"
                className={styles.dialog}
                returnFocus={returnFocus}
                dismissible={!sending}
                canClose={() => {
                    if (!changed) return true;
                    setConfirmOpen(true);
                    return false;
                }}
                onSubmit={submit}
                error={errorSlot}
                data-create-lobby-dialog=""
                actions={
                    <>
                        <button
                            ref={advancedRef}
                            type="button"
                            className={`${styles.button} ${styles.secondary} ${styles.advanced}`}
                            aria-haspopup="dialog"
                            data-has-errors={advancedErrors > 0 ? '' : undefined}
                            onClick={() => {
                                setAdvancedFocus(0);
                                setAdvancedOpen(true);
                            }}
                        >
                            <GearIcon className={styles.gear} />
                            {TEXT.advanced}
                            {advancedErrors > 0 && (
                                <>
                                    <span className={styles.errorMark} aria-hidden="true">
                                        {advancedErrors}
                                    </span>
                                    <span className={hidden.visuallyHidden}>
                                        {ADVANCED_TEXT.errorMark(advancedErrors)}
                                    </span>
                                </>
                            )}
                        </button>
                        <button
                            type="submit"
                            className={`${styles.button} ${styles.primary}`}
                            aria-disabled={sending}
                            onClick={(e) => {
                                if (sending) e.preventDefault();
                            }}
                        >
                            {sending ? TEXT.creating : TEXT.create}
                        </button>
                    </>
                }
            >
                <LobbySettingsForm
                    value={settings}
                    onChange={setSettings}
                    rules={rules}
                    presets={presets}
                    presetKey={presetKey}
                    onPresetChange={(key) => onDraft((d) => ({ ...d, presetKey: key }))}
                    errors={errors}
                    submitCount={submitCount}
                    disabled={sending}
                />
            </Dialog>
            <AdvancedSettingsDialog
                open={advancedOpen}
                onClose={() => setAdvancedOpen(false)}
                focusRequest={advancedFocus}
                doneClassName={`${styles.button} ${styles.primary}`}
                returnFocus={advancedRef}
                value={settings}
                onChange={setSettings}
                rules={rules}
                errors={errors}
                submitCount={submitCount}
                drafts={drafts}
                onDraftsChange={setDrafts}
                presets={presets}
                presetKey={presetKey}
                disabled={sending}
            />
            <Dialog
                open={abandonAsk !== null}
                onClose={(value) => {
                    setAbandonAsk(null);
                    if (value === 'abandon') void send(true);
                }}
                title={TEXT.abandonTitle}
                description={abandonAsk !== null ? TEXT.abandonText(abandonAsk) : undefined}
                className={styles.confirm}
                data-create-lobby-abandon=""
                actions={
                    <>
                        {/* First: the safe answer takes focus, so a held Enter keeps the match. */}
                        <button
                            type="submit"
                            value="keep"
                            className={`${styles.button} ${styles.secondary}`}
                        >
                            {TEXT.keepMatch}
                        </button>
                        <button
                            type="submit"
                            value="abandon"
                            className={`${styles.button} ${styles.danger}`}
                            onClick={(e) => {
                                if (performance.now() - askedAt.current < ABANDON_CONFIRM_GUARD_MS)
                                    e.preventDefault();
                            }}
                        >
                            {TEXT.abandonConfirm}
                        </button>
                    </>
                }
            />
            <Dialog
                open={confirmOpen}
                onClose={(value) => {
                    setConfirmOpen(false);
                    if (value === 'discard') onClose('discard');
                }}
                title={TEXT.discardTitle}
                description={TEXT.discardText}
                className={styles.confirm}
                data-create-lobby-discard=""
                actions={
                    <>
                        <button
                            type="submit"
                            value="keep"
                            className={`${styles.button} ${styles.secondary}`}
                        >
                            {TEXT.keepEditing}
                        </button>
                        <button
                            type="submit"
                            value="discard"
                            className={`${styles.button} ${styles.danger}`}
                        >
                            {TEXT.discard}
                        </button>
                    </>
                }
            />
        </>
    );
}
