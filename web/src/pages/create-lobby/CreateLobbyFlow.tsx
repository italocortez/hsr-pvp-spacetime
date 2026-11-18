import {
    BUILT_IN_CLASSIC_KEY,
    heldLobbyOf,
    initialLobbySettings,
} from '@shared/lobby-rules/lobbySettings';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authStore, useAuth } from '@/auth/authStore';
import { type EnsureSignedInResult, useEnsureSignedIn } from '@/auth/useEnsureSignedIn';
import { SIGN_IN_TEXT } from '@/pages/sign-in/signInText';
import { getMyLobbies, type MyLobbiesState, subscribeMyLobbies } from '@/stdb/myLobbies';
import { CreateLobbyDialog, type CreateLobbyDraft } from './CreateLobbyDialog';
import { CREATE_LOBBY_TEXT as TEXT } from './createLobbyText';

export type CreateLobbyFlowProps = {
    /** Bumped by every press of "Play Now" (0: none yet). */
    request: number;
    /** "Play Now": focus goes back there when the dialog closes. */
    trigger: HTMLElement | null;
    /** True while the press is being handled (the guest on demand, the lobby check). */
    onBusy: (busy: boolean) => void;
    /** One line for "Play Now"'s status: progress or a failure; '' clears it. */
    onStatus: (text: string) => void;
};

/** How long "Play Now" waits for `view_my_lobbies` to have its first result before opening the dialog anyway. */
export const LOBBIES_WAIT_MS = 3000;

function waitForLobbies(ms: number): Promise<MyLobbiesState> {
    const now = getMyLobbies();
    if (now.ready) return Promise.resolve(now);
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            stop();
            resolve(getMyLobbies());
        };
        const stop = subscribeMyLobbies(() => {
            if (getMyLobbies().ready) done();
        });
        const timer = setTimeout(done, ms);
    });
}

/** "Play Now"'s line for a sign-in that did not happen (the sign-in dialog's sentences). */
function signInFailure(result: Exclude<EnsureSignedInResult, { kind: 'ready' }>): string {
    if (result.kind === 'refused') return result.text || SIGN_IN_TEXT.failedLede;
    if (result.reason === 'timeout') return SIGN_IN_TEXT.tooLong;
    if (result.reason === 'unknown') return SIGN_IN_TEXT.unknown;
    return TEXT.notConnected;
}

/**
 * The landing page's "Play Now" (S14.4c, A221 R2 and R3): a visitor becomes a guest first (`useEnsureSignedIn`); a
 * person who already holds a lobby (the one-lobby rule, D-22: a membership that is not away and not in
 * AwaitingResult; the module would refuse "You are already in a lobby. Leave it before creating or joining
 * another.") goes to that lobby; anyone else gets the create dialog. On success the person lands on
 * `/lobby/$lobbyId`. The form's state lives here, not in the dialog, so a close that could not be refused (Chromium
 * lets a page refuse one Escape per user activation) keeps the changes for the next "Play Now"; a confirmed discard
 * or a created lobby starts the next one fresh. Loaded as its own chunk (`createLobbyLoader.ts`).
 */
export function CreateLobbyFlow({ request, trigger, onBusy, onStatus }: CreateLobbyFlowProps) {
    const navigate = useNavigate();
    const auth = useAuth();
    const ensureSignedIn = useEnsureSignedIn();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<CreateLobbyDraft | null>(null);
    const isGuest = auth.user?.isGuest ?? true;
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const latest = useRef({ onBusy, onStatus, open });
    latest.current = { onBusy, onStatus, open };

    const start = useCallback(async () => {
        const { onBusy: busy, onStatus: status } = latest.current;
        if (latest.current.open) return;
        busy(true);
        // Only a known visitor gets a guest account; before the profile has answered, the person may be a member.
        const known = authStore.getSnapshot();
        status(known.user ? '' : known.ready ? TEXT.preparingGuest : TEXT.connecting);
        const result = await ensureSignedIn();
        if (!alive.current) return;
        if (result.kind !== 'ready') {
            busy(false);
            status(signInFailure(result));
            return;
        }
        const lobbies = await waitForLobbies(LOBBIES_WAIT_MS);
        if (!alive.current) return;
        busy(false);
        status('');
        const held = heldLobbyOf(lobbies.rows);
        if (held) {
            void navigate({ to: '/lobby/$lobbyId', params: { lobbyId: String(held.id) } });
            return;
        }
        setDraft((d) => {
            if (d) return d;
            const settings = initialLobbySettings({ isGuest: result.isGuest, costSets: [] });
            return { settings, initial: settings, presetKey: BUILT_IN_CLASSIC_KEY };
        });
        setOpen(true);
    }, [ensureSignedIn, navigate]);

    const updateDraft = useCallback(
        (update: (d: CreateLobbyDraft) => CreateLobbyDraft) => setDraft((d) => (d ? update(d) : d)),
        [],
    );

    const handled = useRef(0);
    useEffect(() => {
        if (request === 0 || request === handled.current) return;
        handled.current = request;
        void start();
    }, [request, start]);

    if (!open || !draft) return null;
    return (
        <CreateLobbyDialog
            draft={draft}
            onDraft={updateDraft}
            isGuest={isGuest}
            returnFocus={trigger}
            onClose={(outcome) => {
                setOpen(false);
                if (outcome === 'discard') setDraft(null);
            }}
            onCreated={(lobbyId) => {
                setDraft(null);
                setOpen(false);
                void navigate({ to: '/lobby/$lobbyId', params: { lobbyId: String(lobbyId) } });
            }}
            onOpenLobby={(lobbyId) => {
                setOpen(false);
                void navigate({ to: '/lobby/$lobbyId', params: { lobbyId: String(lobbyId) } });
            }}
            onUnresolved={(text) => {
                setOpen(false);
                latest.current.onStatus(text);
            }}
        />
    );
}
