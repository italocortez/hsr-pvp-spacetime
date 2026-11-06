/**
 * Integration tests for chat message reducers.
 *
 * Covers:
 * - send_chat_message: content validation, metadata validation/defaults, rolling window 50 max
 * - delete_chat_message: host/referee/admin permission, regular player blocked, not found
 * - System messages: join/leave/kick/ban insert system ChatMessage rows
 * - Anonymous mode: anonymousLabel populated when lobby has anonymous players
 * - Dangling replyToMessageId: allowed when original message is deleted
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/chat/contract.md — Chat scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { promoteUser } from '../../shared/helpers/promoteUser';
import { defaultLobbyArgs, cleanupLobby } from '../../shared/helpers/lobbies';
import { myLobbies } from '../../shared/helpers/queries';

// ─── Helpers ────────────────────────────────────────────────────────────────

function lobbyMessages(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.ChatMessage.iter()].filter(m => m.lobbyId === lobbyId);
}

function playerMessages(h: TestHarness, lobbyId: number) {
    return lobbyMessages(h, lobbyId).filter(m => m.senderType.tag === 'Player');
}

function systemMessages(h: TestHarness, lobbyId: number) {
    return lobbyMessages(h, lobbyId).filter(m => m.senderType.tag === 'System');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Chat Messages', () => {
    let host: TestHarness;
    let memberA: TestHarness;
    let memberB: TestHarness;
    let outsider: TestHarness;
    const openedLobbyIds: number[] = [];

    beforeAll(async () => {
        host = await createVerifiedTestHarness();
        memberA = await createVerifiedTestHarness();
        memberB = await createVerifiedTestHarness();
        outsider = await createVerifiedTestHarness();

        await host.sync();
        await memberA.sync();
        await memberB.sync();
        await outsider.sync();
    }, 120000);

    afterAll(async () => {
        // D-03: strict cleanup per resource opened (safety net — tests already
        // close most lobbies inline; cleanupLobby swallows already-closed errors)
        for (const lobbyId of openedLobbyIds) {
            await cleanupLobby(host, [memberA, memberB], lobbyId).catch(() => {});
        }
        await host?.disconnect();
        await memberA?.disconnect();
        await memberB?.disconnect();
        await outsider?.disconnect();
    });

    // ─── send_chat_message ──────────────────────────────────────────────

    describe('send_chat_message', () => {
        it('sends a text message with default metadata', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            await memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'hello', metadata: '' });
            await memberA.sync();
            await host.sync();

            const msgs = playerMessages(host, lobby.id);
            expect(msgs.length).toBeGreaterThanOrEqual(1);
            const msg = msgs[msgs.length - 1];
            expect(msg.content).toBe('hello');
            expect(msg.senderUserId).toBe(memberA.userId);
            expect(msg.senderType.tag).toBe('Player');
            // Metadata defaults to {"type":"text"} when empty
            expect(msg.metadata).toBe('{"type":"text"}');

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('sends a reply message with replyToMessageId', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            // Send first message
            await memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'original', metadata: '' });
            await memberA.sync();
            await host.sync();
            const firstMsg = playerMessages(host, lobby.id)[0];

            // Send reply
            await memberA.call.sendChatMessage({
                lobbyId: lobby.id,
                content: 'I agree',
                metadata: JSON.stringify({ type: 'reply', replyToMessageId: firstMsg.id }),
            });
            await memberA.sync();
            await host.sync();

            const msgs = playerMessages(host, lobby.id);
            const reply = msgs.find(m => m.content === 'I agree');
            expect(reply).toBeDefined();
            const parsed = JSON.parse(reply!.metadata!);
            expect(parsed.type).toBe('reply');
            expect(parsed.replyToMessageId).toBe(firstMsg.id);

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('sends an emoji-only message', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            await memberA.call.sendChatMessage({
                lobbyId: lobby.id,
                content: ':thumbsup:',
                metadata: '{"type":"emoji_only"}',
            });
            await memberA.sync();
            await host.sync();

            const msgs = playerMessages(host, lobby.id);
            const emoji = msgs.find(m => m.content === ':thumbsup:');
            expect(emoji).toBeDefined();
            const parsed = JSON.parse(emoji!.metadata!);
            expect(parsed.type).toBe('emoji_only');

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('rejects empty content', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();

            const err = await expectReducerError(
                memberA.call.sendChatMessage({ lobbyId: lobby.id, content: '', metadata: '' })
            );
            expect(err).toContain('Message cannot be empty.');

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('rejects content over 500 characters', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();

            const err = await expectReducerError(
                memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'A'.repeat(501), metadata: '' })
            );
            expect(err).toContain('Message exceeds 500 character limit.');

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('accepts exactly 500 characters', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            await memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'A'.repeat(500), metadata: '' });
            await memberA.sync();
            await host.sync();

            const msgs = playerMessages(host, lobby.id);
            const longMsg = msgs.find(m => m.content.length === 500);
            expect(longMsg).toBeDefined();

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('rejects invalid metadata JSON', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();

            const err = await expectReducerError(
                memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'test', metadata: 'not json' })
            );
            expect(err).toContain('Invalid metadata JSON');

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('rejects metadata with unknown type', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();

            const err = await expectReducerError(
                memberA.call.sendChatMessage({
                    lobbyId: lobby.id,
                    content: 'test',
                    metadata: '{"type":"image"}',
                })
            );
            expect(err).toContain('Invalid metadata JSON');

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('rejects metadata with valid JSON but no type field', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();

            const err = await expectReducerError(
                memberA.call.sendChatMessage({
                    lobbyId: lobby.id,
                    content: 'test',
                    metadata: '{"foo":"bar"}',
                })
            );
            expect(err).toContain('Invalid metadata JSON');

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('non-member rejected', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            // outsider is not in the lobby
            const err = await expectReducerError(
                outsider.call.sendChatMessage({ lobbyId: lobby.id, content: 'hello', metadata: '' })
            );
            expect(err).toContain('not a member');

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });
    });

    // ─── delete_chat_message ────────────────────────────────────────────

    describe('delete_chat_message', () => {
        it('host deletes a message', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            await memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'delete me', metadata: '' });
            await memberA.sync();
            await host.sync();

            const msg = playerMessages(host, lobby.id).find(m => m.content === 'delete me');
            expect(msg).toBeDefined();

            await host.call.deleteChatMessage({ messageId: msg!.id });
            await host.sync();

            const afterDelete = lobbyMessages(host, lobby.id).find(m => m.id === msg!.id);
            expect(afterDelete).toBeUndefined();

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('admin deletes a message', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            // Promote outsider to Admin
            const outsiderUser = [...outsider.conn.db.User.iter()].find(u => u.id === outsider.userId);
            expect(outsiderUser).toBeDefined();
            await promoteUser(outsiderUser!.username, 'Admin');
            await outsider.sync(1500);

            await memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'admin-delete', metadata: '' });
            await memberA.sync();
            await host.sync();
            await outsider.sync();

            const msg = playerMessages(outsider, lobby.id).find(m => m.content === 'admin-delete');
            expect(msg).toBeDefined();

            // Admin (outsider) deletes without being a lobby member
            await outsider.call.deleteChatMessage({ messageId: msg!.id });
            await outsider.sync();
            await host.sync();

            const afterDelete = lobbyMessages(host, lobby.id).find(m => m.id === msg!.id);
            expect(afterDelete).toBeUndefined();

            // Cleanup — demote admin, close lobby
            await promoteUser(outsiderUser!.username, 'User');
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        }, 45000);

        it('regular player blocked from deleting', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            await memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'no delete', metadata: '' });
            await memberA.sync();
            await host.sync();

            const msg = playerMessages(host, lobby.id).find(m => m.content === 'no delete');
            expect(msg).toBeDefined();

            // memberA is not host/referee/admin — cannot delete
            const err = await expectReducerError(
                memberA.call.deleteChatMessage({ messageId: msg!.id })
            );
            expect(err).toContain('Only the host, referees, moderators, or admins can delete chat messages.');

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('message not found', async () => {
            const err = await expectReducerError(
                host.call.deleteChatMessage({ messageId: 999999 })
            );
            expect(err).toContain('Message not found.');
        });

        it('dangling replyToMessageId allowed after original deleted', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            // Send original message
            await memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'original', metadata: '' });
            await memberA.sync();
            await host.sync();

            const original = playerMessages(host, lobby.id).find(m => m.content === 'original');
            expect(original).toBeDefined();

            // Send reply to original
            await memberA.call.sendChatMessage({
                lobbyId: lobby.id,
                content: 'reply here',
                metadata: JSON.stringify({ type: 'reply', replyToMessageId: original!.id }),
            });
            await memberA.sync();
            await host.sync();

            // Delete original — reply should survive with dangling reference
            await host.call.deleteChatMessage({ messageId: original!.id });
            await host.sync();
            await memberA.sync();

            const reply = playerMessages(host, lobby.id).find(m => m.content === 'reply here');
            expect(reply).toBeDefined();
            const parsed = JSON.parse(reply!.metadata!);
            expect(parsed.replyToMessageId).toBe(original!.id);

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });
    });

    // ─── System messages ────────────────────────────────────────────────

    describe('system messages', () => {
        it('join inserts system message', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            const sysBefore = systemMessages(host, lobby.id).length;

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            const sysAfter = systemMessages(host, lobby.id);
            expect(sysAfter.length).toBeGreaterThan(sysBefore);

            const joinMsg = sysAfter.find(m => m.content.includes('joined the lobby'));
            expect(joinMsg).toBeDefined();
            expect(joinMsg!.senderType.tag).toBe('System');
            expect(joinMsg!.senderUserId).toBe(0);

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('leave inserts system message', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.sync();

            const sysMsgs = systemMessages(host, lobby.id);
            const leaveMsg = sysMsgs.find(m => m.content.includes('left the lobby'));
            expect(leaveMsg).toBeDefined();
            expect(leaveMsg!.senderType.tag).toBe('System');
            expect(leaveMsg!.senderUserId).toBe(0);

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('kick inserts system message', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            await host.call.kickMember({ lobbyId: lobby.id, targetUserId: memberA.userId });
            await host.sync();
            await memberA.sync();

            const sysMsgs = systemMessages(host, lobby.id);
            const kickMsg = sysMsgs.find(m => m.content.includes('was kicked from the lobby'));
            expect(kickMsg).toBeDefined();
            expect(kickMsg!.senderType.tag).toBe('System');
            expect(kickMsg!.senderUserId).toBe(0);

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('ban inserts system message', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberB.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberB.sync();
            await host.sync();

            await host.call.banMember({ lobbyId: lobby.id, targetUserId: memberB.userId });
            await host.sync();
            await memberB.sync();

            const sysMsgs = systemMessages(host, lobby.id);
            const banMsg = sysMsgs.find(m => m.content.includes('was banned from the lobby'));
            expect(banMsg).toBeDefined();
            expect(banMsg!.senderType.tag).toBe('System');
            expect(banMsg!.senderUserId).toBe(0);

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });
    });

    // ─── Anonymous mode ─────────────────────────────────────────────────

    describe('anonymous mode', () => {
        it('populates anonymousLabel when lobby has isAnonymousPlayers=true', async () => {
            await host.call.createLobby(defaultLobbyArgs({ isAnonymousPlayers: true }));
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            // Move memberA to a team slot so the label is meaningful
            await memberA.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: memberA.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await memberA.sync();
            await host.sync();

            await memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'anon msg', metadata: '' });
            await memberA.sync();
            await host.sync();

            const msgs = playerMessages(host, lobby.id);
            const anonMsg = msgs.find(m => m.content === 'anon msg');
            expect(anonMsg).toBeDefined();
            // anonymousLabel should be populated (e.g., "Blue-1")
            expect(anonMsg!.anonymousLabel).toBeDefined();
            expect(typeof anonMsg!.anonymousLabel).toBe('string');
            expect(anonMsg!.anonymousLabel!.length).toBeGreaterThan(0);
            // senderUserId is still the real user ID on the raw row
            expect(anonMsg!.senderUserId).toBe(memberA.userId);

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('no anonymousLabel when lobby is not anonymous', async () => {
            await host.call.createLobby(defaultLobbyArgs({ isAnonymousPlayers: false, isAnonymousSpectators: false }));
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            await memberA.call.sendChatMessage({ lobbyId: lobby.id, content: 'visible msg', metadata: '' });
            await memberA.sync();
            await host.sync();

            const msgs = playerMessages(host, lobby.id);
            const msg = msgs.find(m => m.content === 'visible msg');
            expect(msg).toBeDefined();
            // No anonymous label for non-anonymous lobby
            expect(msg!.anonymousLabel).toBeUndefined();

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });
    });

    // ─── Rolling window ─────────────────────────────────────────────────

    describe('rolling window', () => {
        it('enforces 50-message cap — oldest deleted on 51st', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobby = myLobbies(host)[myLobbies(host).length - 1];
            openedLobbyIds.push(lobby.id);

            await memberA.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await memberA.sync();
            await host.sync();

            // Note: lobby already has system messages from join.
            // We need to track the total count including system messages.
            const existingCount = lobbyMessages(host, lobby.id).length;

            // Send enough player messages to reach exactly 50 total
            const toSend = 50 - existingCount;
            for (let i = 0; i < toSend; i++) {
                await memberA.call.sendChatMessage({
                    lobbyId: lobby.id,
                    content: `msg-${i}`,
                    metadata: '',
                });
                // Brief sync to avoid overwhelming the connection
                if (i % 10 === 9) await memberA.sync(300);
            }
            await memberA.sync(1500);
            await host.sync(1500);

            const countAt50 = lobbyMessages(host, lobby.id).length;
            expect(countAt50).toBe(50);

            // Capture the oldest message ID
            const allMsgs = lobbyMessages(host, lobby.id).sort(
                (a: any, b: any) => Number(a.createdDate.microsSinceUnixEpoch - b.createdDate.microsSinceUnixEpoch)
            );
            const oldestId = allMsgs[0].id;

            // Send message 51 — should delete the oldest
            await memberA.call.sendChatMessage({
                lobbyId: lobby.id,
                content: 'message-51',
                metadata: '',
            });
            await memberA.sync(1500);
            await host.sync(1500);

            const countAfter = lobbyMessages(host, lobby.id).length;
            expect(countAfter).toBe(50);

            // Oldest message should be gone
            const oldestStillExists = lobbyMessages(host, lobby.id).find(m => m.id === oldestId);
            expect(oldestStillExists).toBeUndefined();

            // New message should exist
            const newMsg = lobbyMessages(host, lobby.id).find(m => m.content === 'message-51');
            expect(newMsg).toBeDefined();

            // Cleanup
            await memberA.call.leaveLobby({ lobbyId: lobby.id });
            await memberA.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        }, 120000);
    });
});
