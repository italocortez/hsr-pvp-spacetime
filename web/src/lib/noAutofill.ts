/*
 * The attributes that keep browsers and password managers out of a free-text field that is not a credential or an
 * address (S14.4c-fix): a lobby name, a loadout name or note, a search, an amount. Spread on the `input` or `textarea`:
 *
 *   <input type="text" {...NO_AUTOFILL} />
 *
 * - `autocomplete="off"`: the browser offers no saved entries and fills nothing.
 * - `data-1p-ignore` (1Password), `data-lpignore="true"` (LastPass), `data-bwignore` (Bitwarden),
 *   `data-form-type="other"` (Dashlane): each manager's documented opt-out; none of them shows its icon or offers
 *   to save or fill there.
 *
 * Browsers decide what a field is also from its id, name, label and placeholder: a field that names itself "name" or
 * "password" in its id is easy to take for a contact or a login field, so such ids are avoided as well.
 */
export const NO_AUTOFILL = {
    autoComplete: 'off',
    'data-1p-ignore': '',
    'data-lpignore': 'true',
    'data-bwignore': '',
    'data-form-type': 'other',
} as const;
