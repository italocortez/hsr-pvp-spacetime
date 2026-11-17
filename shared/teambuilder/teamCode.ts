import {
    type Budgets,
    type DraftMode,
    GAME_MODES,
    type GameMode,
    isEidolon,
    isSuperimposition,
    type Slot,
    type Slots,
    TEAM_SIZE,
    type Team,
    type TeamSlot,
} from './team';

// S14.3a: the packed team text. One versioned, URL-safe string for a whole team: the share link carries it
// (`/teambuilder?team=...`), the browser keeps the working draft in it, and the account loadout (S14.3s) will store
// it in one column, so one parser validates all three.
//
// Grammar, version 1 (every character is unreserved in a URL: no percent encoding, ever):
//
//   code     = "1" "." slot "." slot "." slot "." slot "." settings
//   slot     = "_"                                                      (empty)
//            | name "-" eidolon [ "-" name "-" superimposition ] [ "-" bid ]
//                                        (the light cone is optional, then the optional Auction extra bid)
//   name     = 1 to 40 of [a-z0-9]                 (a character's or light cone's key name)
//   eidolon  = "0" to "6";  superimposition = "1" to "5"
//   bid      = the slot's Auction extra bid in integer hundredths, 1 to 9999 in canonical decimal (0.01 to 99.99);
//              a bid of 0 is written as nothing, so each team has one text. A bid cannot be read as a light cone:
//              a cone is always followed by "-" and its superimposition. (The per-slot "Extra bid" input is
//              S14.3b; the field is in version 1 now, before any text is stored anywhere.)
//   settings = mode "-" draft "-" set "-" budget "-" budget
//   mode     = "as" | "moc" | "aa";  draft = "c" (Classic) | "a" (Auction)
//   set      = "0" | 1 to 4294967295 in canonical decimal (no leading zero)
//   budget   = integer hundredths, "0" or 1 to 99999999 in canonical decimal (character, then light cone)
//
// Example: 1.firefly-0-whereaboutsshouldyouwish-1-250.ruanmei-6._._.as-a-0-3000-1500 (Firefly bids 2.50 extra)
//
// Size: the worst case is 1 + 5 dots + 4 x (40 + 2 + 1 + 40 + 2 + 5) + 34 = 400 characters, exactly the cap
// (`TEAM_CODE_MAX`; 380 without bids). The longest names in data/seed/ are 23 (characters) and 38 (light cones).
//
// Decoding is strict and total: any malformed, oversized or self-contradicting input (a character twice) returns a
// failure, never throws and never yields a half-valid team. Names are checked against the reference set only when
// a catalog is given: an unknown character or light cone then stays in the team and is listed in `unavailable`, so
// the caller can show it as unavailable instead of losing the whole team. Encoding never throws either, also on an
// object that breaks the types (a missing slot, `budgets: null`, an unknown draft mode).

export const TEAM_CODE_VERSION = '1';
export const TEAM_CODE_MAX = 400;
export const TEAM_NAME_MAX = 40;
/** The largest per-slot extra bid, in hundredths (99.99). */
export const BID_MAX = 9_999;
const BUDGET_MAX = 99_999_999;
const U32_MAX = 4_294_967_295;

const N = `[a-z0-9]{1,${TEAM_NAME_MAX}}`;
const NAME = new RegExp(`^${N}$`);
const SLOT = new RegExp(`^(${N})-([0-6])(?:-(${N})-([1-5]))?(?:-([1-9][0-9]{0,3}))?$`);
const SETTINGS = /^(as|moc|aa)-([ca])-(0|[1-9][0-9]{0,9})-(0|[1-9][0-9]{0,7})-(0|[1-9][0-9]{0,7})$/;

const DRAFT_CODE: Record<DraftMode, string> = { classic: 'c', auction: 'a' };
const own = (o: object, key: unknown) => typeof key === 'string' && Object.hasOwn(o, key);

export type TeamCodeError =
    | 'empty'
    | 'too-long'
    | 'bad-characters'
    | 'version'
    | 'shape'
    | 'slot'
    | 'duplicate'
    | 'settings';

const MESSAGES: Record<TeamCodeError, string> = {
    empty: 'The team code is empty.',
    'too-long': `The team code is longer than ${TEAM_CODE_MAX} characters.`,
    'bad-characters': 'The team code holds characters it cannot contain.',
    version: 'The team code is from an unknown version.',
    shape: 'The team code does not have four slots and its settings.',
    slot: 'A slot of the team code is not valid.',
    duplicate: 'The team code holds the same character twice.',
    settings: 'The settings of the team code are not valid.',
};

export type TeamCodeFailure = { ok: false; error: TeamCodeError; message: string };

const fail = (error: TeamCodeError): TeamCodeFailure => ({
    ok: false,
    error,
    message: MESSAGES[error],
});

/** A name a catalog did not know: the slot keeps it, the caller shows it as unavailable. */
export type Unavailable = { slot: number; kind: 'character' | 'lightcone'; name: string };

/** The names the reference set knows (a `Set` or a `Map` keyed by name fits). */
export type TeamCatalog = {
    characters: { has(name: string): boolean };
    lightcones: { has(name: string): boolean };
};

export type DecodedTeam = { ok: true; team: Team; unavailable: Unavailable[] };

const nameOk = (v: unknown): v is string => typeof v === 'string' && NAME.test(v);
const bidOk = (v: unknown) =>
    v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= BID_MAX);

function slotText(slot: unknown): string | null {
    if (slot === null) return '_';
    if (typeof slot !== 'object' || slot === undefined) return null;
    const s = slot as Partial<TeamSlot>;
    if (!nameOk(s.character) || typeof s.eidolon !== 'number' || !isEidolon(s.eidolon)) return null;
    if (!bidOk(s.bid)) return null;
    // Checked also without a cone, where it is not written (review 2 M12): a value outside the type is refused.
    if (typeof s.superimposition !== 'number' || !isSuperimposition(s.superimposition)) return null;
    const bid = s.bid ? `-${s.bid}` : '';
    if (s.lightcone === null) return `${s.character}-${s.eidolon}${bid}`;
    if (!nameOk(s.lightcone)) return null;
    return `${s.character}-${s.eidolon}-${s.lightcone}-${s.superimposition}${bid}`;
}

const budgetOk = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= BUDGET_MAX;

/**
 * The packed text of a team, or a failure when the team cannot be written (a name outside [a-z0-9]{1,40}, a level
 * out of range, a bid out of range, a character twice, an unknown mode, a cost set id or budget out of range).
 * Never throws, also on input that breaks the types.
 */
export function encodeTeam(team: Team): { ok: true; code: string } | TeamCodeFailure {
    try {
        if (!team || !Array.isArray(team.slots) || team.slots.length !== TEAM_SIZE)
            return fail('shape');
        const parts: string[] = [TEAM_CODE_VERSION];
        const seen = new Set<string>();
        for (const slot of team.slots as readonly unknown[]) {
            const text = slotText(slot);
            if (text === null) return fail('slot');
            if (slot) {
                const name = (slot as TeamSlot).character;
                if (seen.has(name)) return fail('duplicate');
                seen.add(name);
            }
            parts.push(text);
        }
        const budgets = team.budgets as Budgets | null | undefined;
        if (
            !(GAME_MODES as readonly unknown[]).includes(team.gameMode) ||
            !own(DRAFT_CODE, team.draftMode) ||
            typeof team.costSetId !== 'number' ||
            !Number.isInteger(team.costSetId) ||
            team.costSetId < 0 ||
            team.costSetId > U32_MAX ||
            !budgets ||
            !budgetOk(budgets.character) ||
            !budgetOk(budgets.lightcone)
        ) {
            return fail('settings');
        }
        parts.push(
            [
                team.gameMode,
                DRAFT_CODE[team.draftMode],
                String(team.costSetId),
                String(budgets.character),
                String(budgets.lightcone),
            ].join('-'),
        );
        const code = parts.join('.');
        return code.length > TEAM_CODE_MAX ? fail('too-long') : { ok: true, code };
    } catch {
        // Defensive only (a getter that throws, say): an encoder must never throw.
        return fail('shape');
    }
}

function parseSlot(text: string): Slot | undefined {
    if (text === '_') return null;
    const m = SLOT.exec(text);
    if (!m) return undefined;
    const [, character, e, lightcone, s, bid] = m;
    const slot: TeamSlot = {
        character: character as string,
        eidolon: Number(e) as TeamSlot['eidolon'],
        lightcone: lightcone ?? null,
        superimposition: (s === undefined ? 1 : Number(s)) as TeamSlot['superimposition'],
    };
    if (bid !== undefined) slot.bid = Number(bid);
    return slot;
}

/**
 * Reads a packed team. `input` may be anything (an address value can be an array or missing): only a string can
 * succeed. With a `catalog`, names it does not know are listed in `unavailable` (the team keeps them).
 */
export function decodeTeam(input: unknown, catalog?: TeamCatalog): DecodedTeam | TeamCodeFailure {
    try {
        if (typeof input !== 'string' || input === '') return fail('empty');
        if (input.length > TEAM_CODE_MAX) return fail('too-long');
        if (!/^[a-z0-9._-]+$/.test(input)) return fail('bad-characters');
        const parts = input.split('.');
        if (parts[0] !== TEAM_CODE_VERSION) return fail('version');
        if (parts.length !== TEAM_SIZE + 2) return fail('shape');

        const slots: Slot[] = [];
        const seen = new Set<string>();
        for (const text of parts.slice(1, 1 + TEAM_SIZE)) {
            const slot = parseSlot(text);
            if (slot === undefined) return fail('slot');
            if (slot) {
                if (seen.has(slot.character)) return fail('duplicate');
                seen.add(slot.character);
            }
            slots.push(slot);
        }

        const m = SETTINGS.exec(parts[TEAM_SIZE + 1] as string);
        if (!m) return fail('settings');
        const costSetId = Number(m[3]);
        if (costSetId > U32_MAX) return fail('settings');
        const budgets: Budgets = { character: Number(m[4]), lightcone: Number(m[5]) };
        const team: Team = {
            slots: slots as unknown as Slots,
            gameMode: m[1] as GameMode,
            draftMode: m[2] === 'a' ? 'auction' : 'classic',
            costSetId,
            budgets,
        };

        const unavailable: Unavailable[] = [];
        if (catalog) {
            slots.forEach((slot, index) => {
                if (!slot) return;
                if (!catalog.characters.has(slot.character))
                    unavailable.push({ slot: index, kind: 'character', name: slot.character });
                if (slot.lightcone !== null && !catalog.lightcones.has(slot.lightcone))
                    unavailable.push({ slot: index, kind: 'lightcone', name: slot.lightcone });
            });
        }
        return { ok: true, team, unavailable };
    } catch {
        // Defensive only: nothing above throws on a string, but a decoder must never throw.
        return fail('shape');
    }
}
