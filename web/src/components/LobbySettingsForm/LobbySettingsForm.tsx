import {
    applyLobbyPreset,
    BAN_MODE_LABEL,
    costSetGameMode,
    costSetLockedText,
    DEFAULT_COST_SET,
    DRAFT_MODE_LABEL,
    GAME_MODE_LABEL,
    LOBBY_BAN_MODES,
    LOBBY_DRAFT_MODES,
    LOBBY_GAME_MODES,
    LOBBY_MAIN_FIELDS,
    LOBBY_NAME_MAX_LENGTH,
    LOBBY_PASSWORD_MAX,
    LOBBY_ROSTER_VISIBILITIES,
    LOBBY_TEAM_SIZES,
    type LobbyFormRules,
    type LobbyPresetChoice,
    type LobbySettingKey,
    type LobbySettings,
    type LobbySettingsErrors,
    type LobbyTeamSize,
    lobbyPresetMatches,
    ROSTER_VISIBILITY_LABEL,
    selectableCostSets,
    settleLobbySettings,
    TEAM_SIZE_LABEL,
} from '@shared/lobby-rules/lobbySettings';
import { useId, useState } from 'react';
import { SegmentedControl } from '@/components/SegmentedControl/SegmentedControl';
import { NO_AUTOFILL } from '@/lib/noAutofill';
import hidden from '@/styles/visuallyHidden.module.css';
import { LabelRow, SelectField } from './fieldParts';
import styles from './LobbySettingsForm.module.css';
import { INFO, FORM_TEXT as TEXT } from './lobbySettingsText';
import { useFieldErrors } from './useFieldErrors';

/*
 * The lobby settings form (S14.4c), a shared feature: the landing page's create dialog hosts it now, the lobbies page
 * and the lobby room's settings later. It renders the main fields of design/mockups/index.html's Create Lobby dialog
 * (the Advanced Settings fields are AdvancedLobbySettings, S14.4d) and owns no state the host needs: the value, the preset choice and
 * the errors come in as props; every change goes out settled (`settleLobbySettings`: a guest stays Casual with Closed
 * No Rating, a custom cost set fixes the game mode). The rules live in `shared/lobby-rules/lobbySettings.ts`.
 *
 * Errors: the timing, focus and read-out of `useFieldErrors` over the main fields (the password's error shows at once
 * while typing: a character it refuses).
 *
 * The lobby password is not a site password: a text field masked by CSS (`-webkit-text-security`) instead of
 * `type="password"`, with autofill off and the password managers' opt-out attributes, so no browser or manager
 * offers to save, fill or suggest one. The eye switches the mask.
 *
 * A locked select (a guest's roster, the game mode a custom cost set fixes) stays focusable (`aria-disabled`, its
 * reason a visible line and its description) and ignores every change.
 */

export type LobbySettingsFormProps = {
    value: LobbySettings;
    onChange: (next: LobbySettings) => void;
    rules: LobbyFormRules;
    /** The preset list (`lobbyPresetChoices`) and the one picked last. */
    presets: readonly LobbyPresetChoice[];
    presetKey: string;
    onPresetChange: (key: string) => void;
    /** Every current error (`validateLobbySettings`); shown by the timing above. */
    errors: LobbySettingsErrors;
    /** Submits tried so far: above 0 shows every error; a new value moves focus to the first invalid field. */
    submitCount: number;
    /** A submit is in flight: the fields do not change. */
    disabled?: boolean;
};

type MainField = (typeof LOBBY_MAIN_FIELDS)[number];

/** The preset select's value while the form holds no preset as it is (never a key of a real preset). */
const CUSTOM_PRESET = 'custom';

const FIELD_LABEL: Record<MainField, string> = {
    name: TEXT.name,
    password: TEXT.password,
    draftMode: TEXT.draftMode,
    gameMode: TEXT.gameMode,
    costSetId: TEXT.costSet,
    banMode: TEXT.banMode,
    matchType: TEXT.type,
    isAnonymousPlayers: TEXT.anonymousPlayers,
    rosterVisibility: TEXT.roster,
    teamSize: TEXT.teamSize,
};

export function LobbySettingsForm({
    value,
    onChange,
    rules,
    presets,
    presetKey,
    onPresetChange,
    errors,
    submitCount,
    disabled = false,
}: LobbySettingsFormProps) {
    const id = useId();
    const fieldId = (key: string) => `${id}-${key}`;
    const [revealPassword, setRevealPassword] = useState(false);
    /** "Default Auction applied.", read out after a pick; gone once the form no longer holds that preset. */
    const [presetNote, setPresetNote] = useState('');
    const { shows, touch, errorId, errorProps, announcement, containerRef } = useFieldErrors({
        fields: LOBBY_MAIN_FIELDS,
        labels: FIELD_LABEL,
        errors,
        submitCount,
        idPrefix: id,
    });

    const set = <K extends LobbySettingKey>(key: K, v: LobbySettings[K]) =>
        onChange(settleLobbySettings({ ...value, [key]: v }, rules));

    const errorLine = (key: MainField) =>
        shows(key) ? (
            <p id={errorId(key)} className={styles.error}>
                {errors[key]}
            </p>
        ) : null;

    const costSets = selectableCostSets(rules.costSets);
    const fixedMode = costSetGameMode(value.costSetId, rules.costSets);
    const fixedSet = rules.costSets.find((s) => s.id === value.costSetId);
    const knownSet =
        value.costSetId === DEFAULT_COST_SET || costSets.some((s) => s.id === value.costSetId);
    const isPrivate = value.password !== '';
    const picked = presets.find((p) => p.key === presetKey);
    const presetShown =
        picked && lobbyPresetMatches(value, picked, rules) ? picked.key : CUSTOM_PRESET;

    return (
        <fieldset ref={containerRef} className={styles.form} disabled={disabled}>
            <div className={styles.field}>
                <div className={styles.labelRow}>
                    <label htmlFor={fieldId('lobby-title')}>{TEXT.name}</label>
                    {isPrivate && (
                        <span className={styles.privateBadge}>
                            <LockGlyph />
                            {TEXT.privateBadge}
                        </span>
                    )}
                </div>
                <input
                    // Not "-name": nothing for an autofill heuristic to take for a person's name.
                    id={fieldId('lobby-title')}
                    className={styles.input}
                    type="text"
                    value={value.name}
                    maxLength={LOBBY_NAME_MAX_LENGTH}
                    placeholder={TEXT.namePlaceholder}
                    {...NO_AUTOFILL}
                    onChange={(e) => set('name', e.target.value)}
                    onBlur={() => touch('name')}
                    {...errorProps('name')}
                />
                {errorLine('name')}
            </div>

            <div className={styles.field}>
                <div className={styles.labelRow}>
                    <label htmlFor={fieldId('lobby-key')}>{TEXT.password}</label>
                </div>
                <div className={styles.passwordWrap}>
                    <input
                        // No "password" in the id or the type: nothing for a password manager's heuristics to take.
                        id={fieldId('lobby-key')}
                        className={styles.input}
                        type="text"
                        data-masked={revealPassword ? undefined : ''}
                        value={value.password}
                        maxLength={LOBBY_PASSWORD_MAX}
                        placeholder={TEXT.passwordPlaceholder}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        {...NO_AUTOFILL}
                        onChange={(e) => {
                            const next = e.target.value;
                            set('password', next);
                            // A refused character shows at once (the mockup's live check).
                            touch('password');
                        }}
                        onBlur={() => touch('password')}
                        {...errorProps('password')}
                    />
                    {value.password !== '' && (
                        <button
                            type="button"
                            className={styles.eye}
                            aria-label={revealPassword ? TEXT.hidePassword : TEXT.showPassword}
                            aria-pressed={revealPassword}
                            onClick={() => setRevealPassword((r) => !r)}
                        >
                            <EyeGlyph crossed={revealPassword} />
                        </button>
                    )}
                </div>
                {errorLine('password')}
            </div>

            {/*
             * Above the fields it sets (every one below; never the name or the password), so the order reads as its
             * effect. "Custom" once one of them was edited: the label is never stale; picking a preset again re-applies it.
             */}
            <div className={styles.field}>
                <LabelRow label={TEXT.preset} info={INFO.preset} htmlFor={fieldId('preset')} />
                <select
                    id={fieldId('preset')}
                    className={styles.select}
                    value={presetShown}
                    onChange={(e) => {
                        const preset = presets.find((p) => p.key === e.target.value);
                        if (!preset) return;
                        onPresetChange(preset.key);
                        onChange(applyLobbyPreset(value, preset, rules));
                        setPresetNote(TEXT.presetApplied(preset.label));
                    }}
                >
                    {presetShown === CUSTOM_PRESET && (
                        <option value={CUSTOM_PRESET} disabled>
                            {TEXT.presetCustom}
                        </option>
                    )}
                    {presets.map((p) => (
                        <option key={p.key} value={p.key}>
                            {p.label}
                        </option>
                    ))}
                </select>
            </div>

            <div className={styles.row}>
                <SelectField
                    id={fieldId('draftMode')}
                    label={TEXT.draftMode}
                    info={INFO.draftMode}
                    value={value.draftMode}
                    onChange={(v) => set('draftMode', v as LobbySettings['draftMode'])}
                    options={LOBBY_DRAFT_MODES.map((m) => [m, DRAFT_MODE_LABEL[m]])}
                    extra={errorProps('draftMode')}
                    error={errorLine('draftMode')}
                />
                <SelectField
                    id={fieldId('gameMode')}
                    label={TEXT.gameMode}
                    info={INFO.gameMode}
                    value={value.gameMode}
                    onChange={(v) => set('gameMode', v as LobbySettings['gameMode'])}
                    options={LOBBY_GAME_MODES.map((m) => [m, GAME_MODE_LABEL[m]])}
                    locked={
                        fixedMode !== undefined && fixedSet
                            ? {
                                  reasonId: fieldId('gameMode-locked'),
                                  reason: costSetLockedText(fixedSet.name, fixedMode),
                              }
                            : undefined
                    }
                    extra={errorProps('gameMode')}
                    error={errorLine('gameMode')}
                />
            </div>

            <div className={styles.row}>
                <SelectField
                    id={fieldId('costSetId')}
                    label={TEXT.costSet}
                    info={INFO.costSet}
                    value={String(value.costSetId)}
                    onChange={(v) => {
                        set('costSetId', Number(v));
                        touch('costSetId');
                    }}
                    options={[
                        [String(DEFAULT_COST_SET), TEXT.defaultCostSet],
                        ...costSets.map((s) => [String(s.id), s.name] as [string, string]),
                        ...(knownSet
                            ? []
                            : [
                                  [
                                      String(value.costSetId),
                                      TEXT.unknownCostSet(value.costSetId),
                                  ] as [string, string],
                              ]),
                    ]}
                    extra={errorProps('costSetId')}
                    error={errorLine('costSetId')}
                />
                <SelectField
                    id={fieldId('banMode')}
                    label={TEXT.banMode}
                    info={INFO.banMode}
                    value={value.banMode}
                    onChange={(v) => set('banMode', v as LobbySettings['banMode'])}
                    options={LOBBY_BAN_MODES.map((m) => [m, BAN_MODE_LABEL[m]])}
                    extra={errorProps('banMode')}
                    error={errorLine('banMode')}
                />
            </div>

            <div className={styles.row}>
                <div className={`${styles.field} ${styles.pill}`}>
                    <LabelRow label={TEXT.type} info={INFO.type} />
                    <SegmentedControl
                        label={TEXT.type}
                        showLabel={false}
                        value={value.matchType}
                        onChange={(v) => {
                            set('matchType', v);
                            touch('matchType');
                        }}
                        options={[
                            { value: 'Casual', label: 'Casual' },
                            {
                                value: 'Ranked',
                                label: 'Ranked',
                                disabledReason: rules.isGuest ? TEXT.guestRanked : undefined,
                            },
                        ]}
                    />
                    {/* Visible words for touch and sighted keyboard users (the option's own reason is its description). */}
                    {rules.isGuest && (
                        <p className={styles.hint} aria-hidden="true">
                            {TEXT.guestRanked}
                        </p>
                    )}
                    {errorLine('matchType')}
                </div>
                <div className={`${styles.field} ${styles.pill}`}>
                    <LabelRow label={TEXT.anonymousPlayers} info={INFO.anonymousPlayers} />
                    <SegmentedControl
                        label={TEXT.anonymousPlayers}
                        showLabel={false}
                        value={value.isAnonymousPlayers ? 'on' : 'off'}
                        onChange={(v) => set('isAnonymousPlayers', v === 'on')}
                        options={[
                            { value: 'off', label: TEXT.off },
                            { value: 'on', label: TEXT.on },
                        ]}
                    />
                </div>
            </div>

            <div className={styles.row}>
                <SelectField
                    id={fieldId('rosterVisibility')}
                    label={TEXT.roster}
                    info={INFO.roster}
                    value={value.rosterVisibility}
                    onChange={(v) =>
                        set('rosterVisibility', v as LobbySettings['rosterVisibility'])
                    }
                    options={LOBBY_ROSTER_VISIBILITIES.map((m) => [m, ROSTER_VISIBILITY_LABEL[m]])}
                    locked={
                        rules.isGuest
                            ? { reasonId: fieldId('roster-locked'), reason: TEXT.guestRoster }
                            : undefined
                    }
                    extra={errorProps('rosterVisibility')}
                    error={errorLine('rosterVisibility')}
                />
                <SelectField
                    id={fieldId('teamSize')}
                    label={TEXT.teamSize}
                    info={INFO.teamSize}
                    value={String(value.teamSize)}
                    onChange={(v) => set('teamSize', Number(v) as LobbyTeamSize)}
                    options={LOBBY_TEAM_SIZES.map((n) => [String(n), TEAM_SIZE_LABEL[n]])}
                    extra={errorProps('teamSize')}
                    error={errorLine('teamSize')}
                />
            </div>

            <p className={hidden.visuallyHidden} aria-live="polite">
                {announcement}
            </p>
            <p className={hidden.visuallyHidden} aria-live="polite" data-preset-status="">
                {presetShown === CUSTOM_PRESET ? '' : presetNote}
            </p>
        </fieldset>
    );
}

/** The "Private" badge's padlock (the mockup's `.privLock`); the one inline copy. Decorative. */
function LockGlyph() {
    return (
        <svg
            className={styles.lock}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
    );
}

/** The password reveal's eye (the mockup's `.pwEye`), crossed while the text shows; the one inline copy. */
function EyeGlyph({ crossed }: { crossed: boolean }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {crossed ? (
                <>
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                </>
            ) : (
                <>
                    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                    <circle cx="12" cy="12" r="3" />
                </>
            )}
        </svg>
    );
}
