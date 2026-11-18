import type { LobbyMemberViewRow, MyLobbyListRow } from '@bindings/types';
import { LOBBY_LIVE_STAGES } from '@shared/lobby-rules/lobbySettings';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/authStore';
import { IpcActionButton } from '@/components/IpcButton/IpcButton';
import { SplashLayout } from '@/components/SplashLayout/SplashLayout';
import { useCopyText } from '@/lib/useCopyText';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useStdbConnection } from '@/stdb/connectionContext';
import { useMyLobbiesState } from '@/stdb/myLobbies';
import { NotConnectedError, useReducerCall } from '@/stdb/useReducerCall';
import { useRouteSubscriptions } from '@/stdb/useRouteSubscriptions';
import { useRows } from '@/stdb/useRows';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './LobbyPlaceholder.module.css';
import { LOBBY_PLACEHOLDER_TEXT as TEXT } from './lobbyPlaceholderText';

/** The members of the viewer's lobbies (`view_my_lobby_members`): the host's name. Plain SQL (no SDK in the chunk). */
export const MY_LOBBY_MEMBERS_QUERY = 'SELECT * FROM "view_my_lobby_members"';
const QUERIES = [MY_LOBBY_MEMBERS_QUERY];
const NONE: readonly string[] = [];

const IMAGE = { src: '/standby.webp', width: 1920, height: 1080 };

/**
 * The lobby placeholder at `/lobby/$lobbyId` (S14.4c, A221 R3) until the lobby room exists (S14.7): the lobby's name,
 * its join code with a copy button, who is host, and "Leave lobby" (one `leave_lobby` call, then back to `/`). The
 * lobby comes from `view_my_lobbies` (Layer 0); the host's name from `view_my_lobby_members`, a route subscription
 * dropped on leaving the page. A lobby that is not the viewer's, or no longer exists, says so with a link home.
 */
export function LobbyPlaceholder({ lobbyId }: { lobbyId: number }) {
    const navigate = useNavigate();
    const auth = useAuth();
    const { rows, ready } = useMyLobbiesState();
    const conn = useStdbConnection();
    const hasMembers = conn?.db.viewMyLobbyMembers !== undefined;
    const { ready: membersReady } = useRouteSubscriptions(hasMembers ? QUERIES : NONE);
    const members = useRows<LobbyMemberViewRow>((c) => c.db.viewMyLobbyMembers, membersReady);
    const leaveLobby = useReducerCall((r, args: { lobbyId: number }) => {
        if (!r.leaveLobby) throw new NotConnectedError();
        return r.leaveLobby(args);
    });
    const [leaving, setLeaving] = useState<'idle' | 'sending' | 'left'>('idle');
    const [error, setError] = useState('');
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    // After a Leave the row goes before the page does: keep showing the lobby until the address changes.
    const found = rows.find((r) => r.id === lobbyId);
    const shownRef = useRef<MyLobbyListRow | undefined>(undefined);
    if (found) shownRef.current = found;
    const lobby = found ?? (leaving === 'left' ? shownRef.current : undefined);

    const name = lobby ? lobby.name.trim() || TEXT.unnamed(lobby.joinCode) : undefined;
    useDocumentTitle(name ? TEXT.title(name) : TEXT.titleGeneric);

    const leave = async () => {
        if (leaving !== 'idle') return;
        setError('');
        setLeaving('sending');
        try {
            await leaveLobby({ lobbyId });
        } catch (e) {
            if (!alive.current) return;
            setLeaving('idle');
            setError(
                e instanceof NotConnectedError
                    ? TEXT.notConnected
                    : e instanceof Error && e.name === 'SenderError'
                      ? e.message.trim() || TEXT.failed
                      : TEXT.failed,
            );
            return;
        }
        if (!alive.current) return;
        setLeaving('left');
        void navigate({ to: '/' });
    };

    if (!lobby) {
        const loading = !ready;
        return (
            <SplashLayout
                image={IMAGE}
                eyebrow={TEXT.eyebrow}
                title={
                    loading ? (
                        <>
                            Opening the <em>lobby.</em>
                        </>
                    ) : (
                        <>
                            Lobby <em>unavailable.</em>
                        </>
                    )
                }
                lede={loading ? TEXT.loading : TEXT.missing}
            />
        );
    }

    const host = members.find((m) => m.lobbyId === lobbyId && m.isHost);
    const hostIsMe = host !== undefined && auth.user !== undefined && host.userId === auth.user.id;
    const stage = stageWording(lobby.stage.tag);
    return (
        <SplashLayout
            image={IMAGE}
            eyebrow={stage.eyebrow}
            title={<span className={styles.name}>{name}</span>}
            lede={stage.lede}
            action={
                <div className={styles.actions}>
                    {/* `busy`, not `disabled`: the focused button keeps focus while leaving and after a refusal. */}
                    <IpcActionButton onClick={() => void leave()} busy={leaving !== 'idle'}>
                        {leaving === 'idle' ? TEXT.leave : TEXT.leaving}
                    </IpcActionButton>
                    <p className={styles.error} role="status">
                        {error}
                    </p>
                </div>
            }
        >
            <div className={styles.facts}>
                <JoinCode code={lobby.joinCode} />
                <p className={styles.host}>
                    <span className={styles.factLabel}>{TEXT.host}</span>{' '}
                    <span className={styles.factValue}>
                        {host ? (hostIsMe ? TEXT.you(host.label) : host.label) : TEXT.hostUnknown}
                    </span>
                </p>
            </div>
        </SplashLayout>
    );
}

/** The eyebrow and the lede for the lobby's stage: "Waiting room" and "leave to create another" only while waiting. */
function stageWording(stage: string): { eyebrow: string; lede: string } {
    if (stage === 'Waiting') return { eyebrow: TEXT.eyebrowWaiting, lede: TEXT.lede };
    if ((LOBBY_LIVE_STAGES as readonly string[]).includes(stage))
        return { eyebrow: TEXT.eyebrowLive, lede: TEXT.ledeLive };
    if (stage === 'AwaitingResult') return { eyebrow: TEXT.eyebrowResult, lede: TEXT.ledeResult };
    return { eyebrow: TEXT.eyebrow, lede: TEXT.lede };
}

/** The join code and its copy button (`useCopyText`, web-guidance copy-button.md). */
function JoinCode({ code }: { code: string }) {
    const { state, message, copy } = useCopyText(code, {
        copied: TEXT.copied(code),
        failed: TEXT.copyFailed(code),
    });
    return (
        <div className={styles.code}>
            <span className={styles.factLabel}>{TEXT.joinCode}</span>
            <span className={styles.codeValue}>{code}</span>
            <button
                type="button"
                className={styles.copy}
                data-state={state}
                onClick={() => void copy()}
            >
                {state === 'copied'
                    ? TEXT.copiedShort
                    : state === 'failed'
                      ? TEXT.copyFailedShort
                      : TEXT.copy}
                {/* "Copy the join code" while idle; "Copied!" alone after (the status line says the rest). */}
                {state === 'idle' && (
                    <>
                        {' '}
                        <span className={hidden.visuallyHidden}>{TEXT.copyWhat}</span>
                    </>
                )}
            </button>
            <p className={hidden.visuallyHidden} role="status">
                {message}
            </p>
        </div>
    );
}
