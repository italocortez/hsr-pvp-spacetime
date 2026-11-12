// Lobby: a private lobby's password is stored as a salted SHA-256, compared as one, and limited to 20 letters and digits.
// Decisions: D-02, A99, A163(4)
// Contracts: docs/lobby/contract.md (Private Lobby with Password)
// From S11a.
//
// T-S11a (triage L24): LobbyPassword.passwordHash held the typed text. It now holds
// hashLobbyPassword(lobbyId, password) = SHA-256 hex of "hsr-lobby-password:<lobbyId>:<password>" (helpers/lobby/
// lobbyPassword.ts, hand-written: a reducer has no crypto API). The SHA-256 is checked against the FIPS 180-4 vectors
// and against values computed with Node's crypto (UTF-8 text). A163(4): there is no guess limit.
//
// T-S11a rulings pass (A163(4)): a password holds only A to Z, a to z and 0 to 9, at most 20 characters; this replaces
// the 64-character cap and the 256-unit pre-check. create_lobby and update_lobby_settings refuse a password that breaks
// the rule with one text per cause; join_lobby refuses such an attempt as an incorrect password without hashing it.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOBBY_ARGS, M, guest, newHarness, rejection, snap, tx, type Harness } from '../fixtures/harness';
import { createLobby, join, members, settingsArgs } from '../fixtures/lobby';
import {
    hashLobbyPassword,
    LOBBY_PASSWORD_CHARSET_TEXT,
    LOBBY_PASSWORD_MAX_LENGTH,
    LOBBY_PASSWORD_TOO_LONG_TEXT,
    sha256HexOfUtf8,
} from '@module/helpers/lobby/lobbyPassword';

const CAP_TEXT = LOBBY_PASSWORD_TOO_LONG_TEXT;
const storedOf = (test: Harness, lobbyId: number) => test.db.LobbyPassword.lobbyId.find(lobbyId)?.passwordHash;

/**
 * Runs `body` while counting iterations of strings: `long` counts any string over `limit` units, `hashed` counts the
 * salted input of hashLobbyPassword (its UTF-8 encoder iterates the string; the rule check does not iterate).
 */
function countIterations(limit: number, body: (counts: { long: number; hashed: number }) => void): void {
    const proto = String.prototype as any;
    const original = proto[Symbol.iterator];
    const counts = { long: 0, hashed: 0 };
    proto[Symbol.iterator] = function (this: string) {
        if (this.length > limit) counts.long++;
        if (this.startsWith('hsr-lobby-password:')) counts.hashed++;
        return original.call(this);
    };
    try {
        body(counts);
    } finally {
        proto[Symbol.iterator] = original;
    }
}

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

describe(`A163(4): the length cap (${LOBBY_PASSWORD_MAX_LENGTH} characters)`, () => {
    it('the cap is 20', () => {
        expect(LOBBY_PASSWORD_MAX_LENGTH).toBe(20);
    });

    it('create_lobby and update_lobby_settings refuse a longer password and write nothing; the cap itself passes', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbies = [...test.db.Lobby.iter()].length;
        const long = 'x'.repeat(LOBBY_PASSWORD_MAX_LENGTH + 1);
        expect(rejection(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, isPublic: false, password: long } as any))).toBe(CAP_TEXT);
        expect([...test.db.Lobby.iter()]).toHaveLength(lobbies);

        const atCap = 'Az09'.repeat(LOBBY_PASSWORD_MAX_LENGTH / 4); // 20 letters and digits of every class
        const L = createLobby(test, host, { isPublic: false, password: atCap });
        const before = snap(test.db.LobbyPassword.lobbyId.find(L), test.db.Lobby.id.find(L));
        expect(rejection(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(L, { isPublic: false, password: long })))).toBe(CAP_TEXT);
        expect(snap(test.db.LobbyPassword.lobbyId.find(L), test.db.Lobby.id.find(L))).toBe(before);
        join(test, guest(test, 'friend'), L, atCap);
    });

    it('join_lobby with an over-long attempt is the wrong-password refusal, without hashing it', () => {
        const test = newHarness();
        const L = createLobby(test, guest(test, 'host'), { isPublic: false, password: 'pw' });
        const guesser = guest(test, 'guesser');
        countIterations(LOBBY_PASSWORD_MAX_LENGTH, (counts) => {
            expect(rejection(test, guesser, (ctx) =>
                M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: 'p'.repeat(LOBBY_PASSWORD_MAX_LENGTH + 1) }))).toBe('Incorrect lobby password.');
            expect(counts.hashed).toBe(0);
        });
    });
});

describe('A163(4): only A to Z, a to z and 0 to 9', () => {
    const BAD = ['pass word', 'pw!', 'pässwort', '密码', 'pw🔒', 'pw-1', 'pw_1', 'tab\tpw'];

    it('create_lobby and update_lobby_settings refuse any other character with the charset text and write nothing', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbies = [...test.db.Lobby.iter()].length;
        for (const bad of BAD) {
            expect(rejection(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, isPublic: false, password: bad } as any)))
                .toBe(LOBBY_PASSWORD_CHARSET_TEXT);
        }
        expect([...test.db.Lobby.iter()]).toHaveLength(lobbies);

        const L = createLobby(test, host, { isPublic: false, password: 'Good123' });
        const before = snap(test.db.LobbyPassword.lobbyId.find(L), test.db.Lobby.id.find(L));
        for (const bad of BAD) {
            expect(rejection(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(L, { isPublic: false, password: bad }))))
                .toBe(LOBBY_PASSWORD_CHARSET_TEXT);
        }
        expect(snap(test.db.LobbyPassword.lobbyId.find(L), test.db.Lobby.id.find(L))).toBe(before);
        join(test, guest(test, 'friend'), L, 'Good123');
    });

    it('the empty string is not a password: a public lobby without one, and an update that keeps the stored one, pass', () => {
        const test = newHarness();
        const P = createLobby(test, guest(test, 'host'), { isPublic: true, password: '' });
        expect(storedOf(test, P)).toBeUndefined();

        const host = guest(test, 'host2');
        const L = createLobby(test, host, { isPublic: false, password: 'keep1' });
        tx(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(L, { isPublic: false, password: '' })));
        expect(storedOf(test, L)).toBe(hashLobbyPassword(L, 'keep1'));
    });

    it('join_lobby with an attempt holding another character is the wrong-password refusal, without hashing it', () => {
        const test = newHarness();
        const L = createLobby(test, guest(test, 'host'), { isPublic: false, password: 'pw' });
        const guesser = guest(test, 'guesser');
        const before = snap(members(test, L));
        countIterations(LOBBY_PASSWORD_MAX_LENGTH, (counts) => {
            for (const bad of BAD) {
                expect(rejection(test, guesser, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: bad })))
                    .toBe('Incorrect lobby password.');
            }
            expect(counts.hashed).toBe(0);
            // the counter works: a valid wrong attempt is hashed
            expect(rejection(test, guesser, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: 'pw2' }))).toBe('Incorrect lobby password.');
            expect(counts.hashed).toBeGreaterThan(0);
        });
        expect(snap(members(test, L))).toBe(before);
    });
});

// T-S11a (review L3): a huge string is refused on its raw length, before any per-character work. The string iterator is
// wrapped to count expansions of any string over the cap and hashes of the salted input.
describe('L3: a 1 MB password is refused without expanding it', () => {
    it('join_lobby, create_lobby and update_lobby_settings refuse it with their usual text; no string over the limit is iterated', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const L = createLobby(test, host, { isPublic: false, password: 'pw' });
        const huge = 'p'.repeat(1_000_000);
        const guesser = guest(test, 'guesser');
        countIterations(LOBBY_PASSWORD_MAX_LENGTH, (counts) => {
            expect([...'p'.repeat(LOBBY_PASSWORD_MAX_LENGTH + 1)]).toHaveLength(LOBBY_PASSWORD_MAX_LENGTH + 1);
            expect(counts.long).toBe(1); // the counter works
            counts.long = 0;
            const joinText = rejection(test, guesser, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: huge }));
            const createText = rejection(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, isPublic: false, password: huge } as any));
            const updateText = rejection(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(L, { isPublic: false, password: huge })));
            expect(counts.long).toBe(0);
            expect(counts.hashed).toBe(0);
            expect(joinText).toBe('Incorrect lobby password.');
            expect(createText).toBe(CAP_TEXT);
            expect(updateText).toBe(CAP_TEXT);
        });
    });
});
