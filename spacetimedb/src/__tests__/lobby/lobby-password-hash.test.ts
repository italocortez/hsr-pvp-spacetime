// Lobby: a private lobby's password is stored as a salted SHA-256, compared as one, and capped in length.
// Decisions: D-02, A99
// Contracts: docs/lobby/contract.md (Private Lobby with Password)
// From S11a.
//
// T-S11a (triage L24): LobbyPassword.passwordHash held the typed text. It now holds
// hashLobbyPassword(lobbyId, password) = SHA-256 hex of "hsr-lobby-password:<lobbyId>:<password>" (helpers/lobby/
// lobbyPassword.ts, hand-written: a reducer has no crypto API). The SHA-256 is checked against the FIPS 180-4 vectors
// and against values computed with Node's crypto (UTF-8 text). The guess limit of the row is not built (a failed join
// rolls back; S11a log).
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOBBY_ARGS, M, guest, newHarness, rejection, snap, tx, type Harness } from '../fixtures/harness';
import { createLobby, join, members, settingsArgs } from '../fixtures/lobby';
import { hashLobbyPassword, LOBBY_PASSWORD_MAX_LENGTH, LOBBY_PASSWORD_MAX_UTF16_UNITS, sha256HexOfUtf8 } from '@module/helpers/lobby/lobbyPassword';

const CAP_TEXT = `The lobby password can be at most ${LOBBY_PASSWORD_MAX_LENGTH} characters.`;
const storedOf = (test: Harness, lobbyId: number) => test.db.LobbyPassword.lobbyId.find(lobbyId)?.passwordHash;

describe('L24: the hash', () => {
    it('SHA-256 matches the FIPS 180-4 vectors and reference values on multi-block and non-ASCII text', () => {
        expect(sha256HexOfUtf8('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(sha256HexOfUtf8('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(sha256HexOfUtf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
            .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
        expect(sha256HexOfUtf8('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
        expect(sha256HexOfUtf8('The quick brown fox jumps over the lazy dog')).toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
        // non-ASCII: 2-, 3- and 4-byte UTF-8 sequences (reference values from Node's crypto)
        expect(sha256HexOfUtf8('pässwört')).toBe('cb09d5a0b18f824486c1897881835055e9783f7a5887245ea009d324691bb70a');
        expect(sha256HexOfUtf8('密码🔒')).toBe('39fe364ba5d03d9063aa4e81be62283ad6ebd77e0a2428575897ab3d4ebdf12b');
    });

    it('the lobby id salts the hash: one password, two lobbies, two values', () => {
        expect(hashLobbyPassword(1, 'secret')).toBe('904e7728a1cb67a8eb5de1125d7c76b9e56e73898705ac77649b3055c67b0ea8');
        expect(hashLobbyPassword(1, 'secret')).not.toBe(hashLobbyPassword(2, 'secret'));
    });
});

describe('L24: create, join and update with a hashed password', () => {
    it('create_lobby stores the hash, never the text; join_lobby admits the right password and refuses a wrong one', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const L = createLobby(test, host, { isPublic: false, password: 'secret' });
        expect(storedOf(test, L)).toBe(hashLobbyPassword(L, 'secret'));
        expect(storedOf(test, L)).not.toContain('secret');

        const wrong = guest(test, 'wrong');
        const before = snap(members(test, L));
        expect(rejection(test, wrong, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: 'Secret' }))).toBe('Incorrect lobby password.');
        expect(rejection(test, wrong, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: hashLobbyPassword(L, 'secret') })))
            .toBe('Incorrect lobby password.'); // the stored value itself is not a password
        expect(snap(members(test, L))).toBe(before);

        join(test, guest(test, 'right'), L, 'secret');
        expect(members(test, L)).toHaveLength(2);
    });

    it('update_lobby_settings with a new password stores its hash; the old password stops working', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const L = createLobby(test, host, { isPublic: false, password: 'old' });
        tx(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(L, { isPublic: false, password: 'new' })));
        expect(storedOf(test, L)).toBe(hashLobbyPassword(L, 'new'));
        expect(rejection(test, guest(test, 'late'), (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: 'old' }))).toBe('Incorrect lobby password.');
        join(test, guest(test, 'friend'), L, 'new');
    });
});

describe(`L24: the length cap (${LOBBY_PASSWORD_MAX_LENGTH} characters)`, () => {
    it('create_lobby and update_lobby_settings refuse a longer password and write nothing; the cap itself passes', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbies = [...test.db.Lobby.iter()].length;
        const long = 'x'.repeat(LOBBY_PASSWORD_MAX_LENGTH + 1);
        expect(rejection(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, isPublic: false, password: long } as any))).toBe(CAP_TEXT);
        expect([...test.db.Lobby.iter()]).toHaveLength(lobbies);

        const atCap = '密'.repeat(LOBBY_PASSWORD_MAX_LENGTH); // counted in characters, not UTF-16 units or bytes
        const L = createLobby(test, host, { isPublic: false, password: atCap });
        const before = snap(test.db.LobbyPassword.lobbyId.find(L), test.db.Lobby.id.find(L));
        expect(rejection(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(L, { isPublic: false, password: long })))).toBe(CAP_TEXT);
        expect(snap(test.db.LobbyPassword.lobbyId.find(L), test.db.Lobby.id.find(L))).toBe(before);
        join(test, guest(test, 'friend'), L, atCap);
    });

    it('join_lobby with an over-long attempt is the wrong-password refusal', () => {
        const test = newHarness();
        const L = createLobby(test, guest(test, 'host'), { isPublic: false, password: 'pw' });
        expect(rejection(test, guest(test, 'guesser'), (ctx) =>
            M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: 'p'.repeat(1000) }))).toBe('Incorrect lobby password.');
    });
});

// T-S11a (review L3): a string over LOBBY_PASSWORD_MAX_UTF16_UNITS is refused on its raw length, before it is expanded
// into code points. The string iterator is wrapped to count expansions of any string over that length.
describe('L3: a 1 MB password is refused without expanding it', () => {
    it('join_lobby, create_lobby and update_lobby_settings refuse it with their usual text; no string over the limit is iterated', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const L = createLobby(test, host, { isPublic: false, password: 'pw' });
        const huge = 'p'.repeat(1_000_000);
        const proto = String.prototype as any;
        const original = proto[Symbol.iterator];
        let expanded = 0;
        proto[Symbol.iterator] = function (this: string) {
            if (this.length > LOBBY_PASSWORD_MAX_UTF16_UNITS) expanded++;
            return original.call(this);
        };
        try {
            expect([...'p'.repeat(LOBBY_PASSWORD_MAX_UTF16_UNITS + 1)]).toHaveLength(LOBBY_PASSWORD_MAX_UTF16_UNITS + 1);
            expect(expanded).toBe(1); // the counter works
            expanded = 0;
            const joinText = rejection(test, guest(test, 'guesser'), (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: huge }));
            const createText = rejection(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, isPublic: false, password: huge } as any));
            const updateText = rejection(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(L, { isPublic: false, password: huge })));
            expect(expanded).toBe(0);
            expect(joinText).toBe('Incorrect lobby password.');
            expect(createText).toBe(CAP_TEXT);
            expect(updateText).toBe(CAP_TEXT);
        } finally {
            proto[Symbol.iterator] = original;
        }
    });
});
