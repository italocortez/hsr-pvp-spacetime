import {
    BAN_RESTRICTION_LABEL,
    BAN_RESTRICTION_OPTIONS,
    DISCONNECT_POLICY_LABEL,
    LINEUP_FORMAT_LABEL,
    LOBBY_ADVANCED_FIELDS,
    LOBBY_CREATE_DISCONNECT_POLICIES,
    LOBBY_LINEUP_FORMATS,
    LOBBY_NUMBER_FIELD_KIND,
    LOBBY_TEAM_ALIAS_MAX_LENGTH,
    type LobbyAdvancedField,
    type LobbyFormRules,
    type LobbyNumberDrafts,
    type LobbyNumberFieldKey,
    type LobbyPresetChoice,
    type LobbySettingKey,
    type LobbySettings,
    type LobbySettingsErrors,
    lobbyNumberFieldText,
    lobbyPresetMatches,
    readLobbyNumber,
    settleLobbySettings,
} from '@shared/lobby-rules/lobbySettings';
import { unitOf } from '@shared/scoring/units';
import { type ReactNode, useId } from 'react';
import { SegmentedControl } from '@/components/SegmentedControl/SegmentedControl';
import { NO_AUTOFILL } from '@/lib/noAutofill';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './AdvancedLobbySettings.module.css';
import { type ErrorProps, LabelRow, SelectField } from './fieldParts';
import form from './LobbySettingsForm.module.css';
import {
    FORM_TEXT,
    ADVANCED_INFO as INFO,
    type InfoText,
    ADVANCED_TEXT as TEXT,
} from './lobbySettingsText';
import { useFieldErrors } from './useFieldErrors';

/*
 * Advanced Settings (S14.4d): the field groups of design/mockups/index.html's Advanced Settings sub-dialog, part of the
 * shared lobby settings form. Hosts are thin: `AdvancedSettingsDialog` (a second dialog over Create, the mockup's form)
 * or a section that expands inside the host's own form. Controlled like `LobbySettingsForm`: the value, the errors and
 * the number fields' texts come in as props, every change goes out settled. The rules live in
 * `shared/lobby-rules/lobbySettings.ts`.
 *
 * - Number fields are text fields (`inputmode` numeric or decimal; web-guidance forms.md) with a draft per field
 *   (`drafts`): what the person typed stays while it reads as the value; the value holds NaN for a text that does not
 *   read, which validation refuses (never sent). The unit sits in the box and is read with the label.
 * - Fields one draft mode does not use stay visible and say why (the mockup locks them): the Auction economy in a
 *   Classic lobby is read-only (`aria-disabled`, still focusable, its reason under the group); Mirror Picks and Random
 *   Auto-Pick (the module uses them in Classic only) keep their value in an Auction lobby with the other choice
 *   unavailable and the reason given. A locked amount that holds an error (a preset's) stays editable so it can be fixed.
 * - Ranked: Mirror Picks shows Off with On unavailable (the module forces it, D-42); No Action is offered for Casual
 *   lobbies only (A92(3)); Deferred is not offered (A91(2)).
 * - Errors: `useFieldErrors` over `LOBBY_ADVANCED_FIELDS`. The host says when this section moves focus
 *   (`focusRequest`): Create with an invalid field here and none in the main fields, or the dialog's Done.
 */

export type AdvancedLobbySettingsProps = {
    value: LobbySettings;
    onChange: (next: LobbySettings) => void;
    rules: LobbyFormRules;
    /** Every current error (`validateLobbySettings`); this section shows its own fields' ones. */
    errors: LobbySettingsErrors;
    /** Submits tried so far (Create, Done): above 0 shows every error of this section. */
    submitCount: number;
    /** Each new value above 0 moves focus to the first invalid field here (see `useFieldErrors`). */
    focusRequest: number;
    /** The number fields' texts as typed, kept by the host so they outlive this section. */
    drafts: LobbyNumberDrafts;
    onDraftsChange: (next: LobbyNumberDrafts) => void;
    /** The preset list and the one picked last: the note at the top names it, or "Custom". */
    presets: readonly LobbyPresetChoice[];
    presetKey: string;
    disabled?: boolean;
};

const FIELD_LABEL: Record<LobbyAdvancedField, string> = {
    banRestriction: TEXT.banRestriction,
    lineupFormat: TEXT.lineupFormat,
    teamBlueAlias: TEXT.teamBlueAlias,
    teamRedAlias: TEXT.teamRedAlias,
    allowMirrorPicks: TEXT.allowMirrorPicks,
    autoRandomPick: TEXT.autoRandomPick,
    characterBudget: TEXT.characterBudget,
    lightconeBudget: TEXT.lightconeBudget,
    minimumBidRaise: TEXT.minimumBidRaise,
    deathPenalty: TEXT.deathPenalty,
    rosterDiffAdvantage: TEXT.rosterDiffAdvantage,
    rosterThreshold: TEXT.rosterThreshold,
    underThresholdAdvantage: TEXT.underThresholdAdvantage,
    aboveThresholdPenalty: TEXT.aboveThresholdPenalty,
    requireOwnership: TEXT.requireOwnership,
    standardTurnSeconds: TEXT.standardTurnSeconds,
    reserveBankSeconds: TEXT.reserveBankSeconds,
    confirmWindowSeconds: TEXT.confirmWindowSeconds,
    refereeCanUndo: TEXT.refereeCanUndo,
    refereeCanPause: TEXT.refereeCanPause,
    refereeCanSetCaptain: TEXT.refereeCanSetCaptain,
    refereeCanKick: TEXT.refereeCanKick,
    allowPlayerPause: TEXT.allowPlayerPause,
    refereeExclusiveConcede: TEXT.refereeExclusiveConcede,
    isAnonymousSpectators: TEXT.isAnonymousSpectators,
    hideMmr: TEXT.hideMmr,
    maxSpectators: TEXT.maxSpectators,
    disconnectPolicy: TEXT.disconnectPolicy,
    disconnectForfeitSeconds: TEXT.disconnectForfeitSeconds,
};

type BooleanKey = {
    [K in LobbySettingKey]: LobbySettings[K] extends boolean ? K : never;
}[LobbySettingKey];

export function AdvancedLobbySettings({
    value,
    onChange,
    rules,
    errors,
    submitCount,
    focusRequest,
    drafts,
    onDraftsChange,
    presets,
    presetKey,
    disabled = false,
}: AdvancedLobbySettingsProps) {
    const id = useId();
    const fieldId = (key: string) => `${id}-${key}`;
    const { shows, touch, errorId, errorProps, announcement, containerRef } = useFieldErrors({
        fields: LOBBY_ADVANCED_FIELDS,
        labels: FIELD_LABEL,
        errors,
        submitCount,
        idPrefix: id,
        focusRequest,
    });

    const set = <K extends LobbySettingKey>(key: K, v: LobbySettings[K]) =>
        onChange(settleLobbySettings({ ...value, [key]: v }, rules));

    const errorLine = (key: LobbyAdvancedField) =>
        shows(key) ? (
            <p id={errorId(key)} className={form.error}>
                {errors[key]}
            </p>
        ) : null;

    const isAuction = value.draftMode === 'Auction';
    const isRanked = value.matchType === 'Ranked';
    const unit = TEXT.unitWord[unitOf(value.gameMode)];
    const picked = presets.find((p) => p.key === presetKey);
    const presetLabel =
        picked && lobbyPresetMatches(value, picked, rules) ? picked.label : FORM_TEXT.presetCustom;

    const number = (
        key: LobbyNumberFieldKey & LobbyAdvancedField,
        unitShown: string | null,
        unitSpoken: string,
        locked?: { reasonId: string },
    ) => (
        <NumberField
            id={fieldId(key)}
            label={FIELD_LABEL[key]}
            info={INFO[key]}
            unit={unitShown}
            unitSpoken={unitSpoken}
            text={lobbyNumberFieldText(key, drafts[key], value[key])}
            decimal={LOBBY_NUMBER_FIELD_KIND[key] !== 'whole'}
            // A locked field that holds an error stays editable, so a preset's bad value can be fixed.
            locked={locked && errors[key] === undefined ? locked : undefined}
            onText={(text) => {
                onDraftsChange({ ...drafts, [key]: text });
                set(key, readLobbyNumber(key, text));
            }}
            onLeave={() => touch(key)}
            extra={errorProps(key)}
            error={errorLine(key)}
        />
    );

    const toggle = (
        key: BooleanKey & LobbyAdvancedField,
        options: { shown?: boolean; fixed?: string } = {},
    ) => (
        <ToggleField
            label={FIELD_LABEL[key]}
            info={INFO[key as keyof typeof INFO] as InfoText}
            value={options.shown ?? value[key]}
            fixed={options.fixed}
            onChange={(on) => set(key, on)}
        />
    );

    // Classic-only settings: Ranked fixes mirror picks Off; an Auction lobby does not use either.
    const mirrorReason = isRanked ? TEXT.rankedMirror : isAuction ? TEXT.classicLocked : undefined;
    const autoPickReason = isAuction ? TEXT.classicLocked : undefined;
    const auctionReasonId = fieldId('auction-locked');

    return (
        <fieldset
            ref={containerRef}
            className={styles.advanced}
            disabled={disabled}
            data-advanced-settings=""
        >
            <p className={styles.note}>{TEXT.presetNote(presetLabel)}</p>

            <Group title={TEXT.match}>
                <div className={styles.grid}>
                    <SelectField
                        id={fieldId('banRestriction')}
                        label={TEXT.banRestriction}
                        info={INFO.banRestriction}
                        value={value.banRestriction}
                        onChange={(v) =>
                            set('banRestriction', v as LobbySettings['banRestriction'])
                        }
                        options={BAN_RESTRICTION_OPTIONS.map((r) => [r, BAN_RESTRICTION_LABEL[r]])}
                        extra={errorProps('banRestriction')}
                        error={errorLine('banRestriction')}
                    />
                    <SelectField
                        id={fieldId('lineupFormat')}
                        label={TEXT.lineupFormat}
                        info={INFO.lineupFormat}
                        value={value.lineupFormat}
                        onChange={(v) => set('lineupFormat', v as LobbySettings['lineupFormat'])}
                        options={LOBBY_LINEUP_FORMATS.map((f) => [f, LINEUP_FORMAT_LABEL[f]])}
                        extra={errorProps('lineupFormat')}
                        error={errorLine('lineupFormat')}
                    />
                </div>
                <div className={styles.grid}>
                    {(['teamBlueAlias', 'teamRedAlias'] as const).map((key) => (
                        <div key={key} className={form.field}>
                            <LabelRow
                                label={FIELD_LABEL[key]}
                                info={INFO.teamAliases}
                                htmlFor={fieldId(key)}
                            />
                            <input
                                // Not "-name": nothing for an autofill heuristic to take for a person's name.
                                id={fieldId(key)}
                                className={form.input}
                                type="text"
                                value={value[key]}
                                maxLength={LOBBY_TEAM_ALIAS_MAX_LENGTH}
                                placeholder={key === 'teamBlueAlias' ? 'Blue' : 'Red'}
                                {...NO_AUTOFILL}
                                onChange={(e) => set(key, e.target.value)}
                                onBlur={() => touch(key)}
                                {...errorProps(key)}
                            />
                            {errorLine(key)}
                        </div>
                    ))}
                </div>
                <p className={styles.subNote}>{TEXT.classicOnly}</p>
                <div className={styles.grid}>
                    {toggle('allowMirrorPicks', {
                        shown: isRanked ? false : value.allowMirrorPicks,
                        fixed: mirrorReason,
                    })}
                    {toggle('autoRandomPick', { fixed: autoPickReason })}
                </div>
            </Group>

            <Group
                title={TEXT.auction}
                note={TEXT.auctionOnly}
                locked={!isAuction}
                reason={isAuction ? undefined : { id: auctionReasonId, text: TEXT.auctionLocked }}
            >
                <div className={styles.grid}>
                    {number(
                        'characterBudget',
                        null,
                        '',
                        isAuction ? undefined : { reasonId: auctionReasonId },
                    )}
                    {number(
                        'lightconeBudget',
                        null,
                        '',
                        isAuction ? undefined : { reasonId: auctionReasonId },
                    )}
                    {number(
                        'minimumBidRaise',
                        null,
                        '',
                        isAuction ? undefined : { reasonId: auctionReasonId },
                    )}
                </div>
            </Group>

            <Group title={TEXT.handicap} note={TEXT.handicapNote}>
                <div className={styles.grid}>
                    {number('deathPenalty', unit, ` (${unit})`)}
                    {number('rosterDiffAdvantage', TEXT.perCostUnit, TEXT.perCostSpoken(unit))}
                    {number('rosterThreshold', TEXT.costUnit, TEXT.costSpoken)}
                    {number('underThresholdAdvantage', unit, ` (${unit})`)}
                    {number('aboveThresholdPenalty', unit, ` (${unit})`)}
                </div>
            </Group>

            <Group title={TEXT.ownership}>
                <div className={styles.grid}>{toggle('requireOwnership')}</div>
            </Group>

            <Group title={TEXT.timers}>
                <div className={styles.grid}>
                    {number('standardTurnSeconds', TEXT.secondsUnit, TEXT.secondsSpoken)}
                    {number('reserveBankSeconds', TEXT.secondsUnit, TEXT.secondsSpoken)}
                    {number('confirmWindowSeconds', TEXT.secondsUnit, TEXT.secondsSpoken)}
                </div>
            </Group>

            <Group title={TEXT.referee}>
                <div className={styles.grid}>
                    {toggle('refereeCanUndo')}
                    {toggle('refereeCanPause')}
                    {toggle('refereeCanSetCaptain')}
                    {toggle('refereeCanKick')}
                    {toggle('allowPlayerPause')}
                    {toggle('refereeExclusiveConcede')}
                </div>
            </Group>

            <Group title={TEXT.privacy}>
                <div className={styles.grid}>
                    {toggle('isAnonymousSpectators')}
                    {toggle('hideMmr')}
                    {number('maxSpectators', TEXT.maxUnit, TEXT.maxSpoken)}
                </div>
            </Group>

            <Group title={TEXT.disconnect}>
                <div className={styles.grid}>
                    <SelectField
                        id={fieldId('disconnectPolicy')}
                        label={TEXT.disconnectPolicy}
                        info={INFO.disconnectPolicy}
                        value={value.disconnectPolicy}
                        onChange={(v) => {
                            set('disconnectPolicy', v as LobbySettings['disconnectPolicy']);
                            touch('disconnectPolicy');
                        }}
                        options={[
                            ...LOBBY_CREATE_DISCONNECT_POLICIES.map((p) =>
                                p === 'NoAction' && isRanked
                                    ? ([p, TEXT.noActionRanked, true] as const)
                                    : ([p, DISCONNECT_POLICY_LABEL[p]] as const),
                            ),
                            // A value no option offers (a preset's Deferred is mapped away; kept for safety) stays shown.
                            ...((LOBBY_CREATE_DISCONNECT_POLICIES as readonly string[]).includes(
                                value.disconnectPolicy,
                            )
                                ? []
                                : [
                                      [
                                          value.disconnectPolicy,
                                          DISCONNECT_POLICY_LABEL[value.disconnectPolicy],
                                          true,
                                      ] as const,
                                  ]),
                        ]}
                        extra={errorProps('disconnectPolicy')}
                        error={errorLine('disconnectPolicy')}
                    />
                    {number('disconnectForfeitSeconds', TEXT.secondsUnit, TEXT.secondsSpoken)}
                </div>
            </Group>

            <p className={hidden.visuallyHidden} aria-live="polite">
                {announcement}
            </p>
        </fieldset>
    );
}

/** A mockup section: its title (`.advSection`), an optional note beside it, and its fields. */
function Group({
    title,
    note,
    locked = false,
    reason,
    children,
}: {
    title: string;
    note?: string;
    /** The mockup's `.advGroup.is-locked`: dimmed, the reason under the title. */
    locked?: boolean;
    reason?: { id: string; text: string };
    children: ReactNode;
}) {
    return (
        <div className={styles.group} data-locked={locked ? '' : undefined}>
            <h3 className={styles.section}>
                {title}
                {note && <span className={styles.sectionNote}>{note}</span>}
            </h3>
            {reason && (
                <p id={reason.id} className={form.hint}>
                    {reason.text}
                </p>
            )}
            {children}
        </div>
    );
}

function NumberField({
    id,
    label,
    info,
    unit,
    unitSpoken,
    text,
    decimal,
    locked,
    onText,
    onLeave,
    extra,
    error,
}: {
    id: string;
    label: string;
    info: InfoText;
    /** Shown in the box after the value; null for none. */
    unit: string | null;
    /** Read with the label (" (seconds)"). */
    unitSpoken: string;
    text: string;
    decimal: boolean;
    /** Set: read-only, its reason (an element of the group) as its description. */
    locked?: { reasonId: string };
    onText: (text: string) => void;
    onLeave: () => void;
    extra: ErrorProps;
    error: ReactNode;
}) {
    const describedBy =
        [locked?.reasonId, extra['aria-describedby']].filter(Boolean).join(' ') || undefined;
    return (
        <div className={form.field}>
            <LabelRow label={label} info={info} htmlFor={id} hiddenSuffix={unitSpoken} />
            <div className={styles.numberBox} data-unit={unit ? '' : undefined}>
                <input
                    id={id}
                    className={form.input}
                    type="text"
                    inputMode={decimal ? 'decimal' : 'numeric'}
                    enterKeyHint="done"
                    spellCheck={false}
                    {...NO_AUTOFILL}
                    // Long enough for any valid value with room to show a mistake; the module's bound is the check.
                    maxLength={16}
                    value={text}
                    readOnly={locked !== undefined}
                    aria-disabled={locked ? true : undefined}
                    onChange={(e) => onText(e.target.value)}
                    onBlur={onLeave}
                    {...extra}
                    aria-describedby={describedBy}
                />
                {unit && (
                    <span className={styles.unit} aria-hidden="true">
                        {unit}
                    </span>
                )}
            </div>
            {error}
        </div>
    );
}

/** An Off / On setting as the site's pill; `fixed` makes the other choice unavailable, with the reason shown. */
function ToggleField({
    label,
    info,
    value,
    fixed,
    onChange,
}: {
    label: string;
    info: InfoText;
    value: boolean;
    fixed?: string;
    onChange: (on: boolean) => void;
}) {
    return (
        <div className={`${form.field} ${form.pill}`}>
            <LabelRow label={label} info={info} />
            <SegmentedControl
                label={label}
                showLabel={false}
                value={value ? 'on' : 'off'}
                onChange={(v) => onChange(v === 'on')}
                options={[
                    {
                        value: 'off',
                        label: FORM_TEXT.off,
                        disabledReason: fixed && value ? fixed : undefined,
                    },
                    {
                        value: 'on',
                        label: FORM_TEXT.on,
                        disabledReason: fixed && !value ? fixed : undefined,
                    },
                ]}
            />
            {/* Visible words for touch and sighted keyboard users (the option's own reason is its description). */}
            {fixed && (
                <p className={form.hint} aria-hidden="true">
                    {fixed}
                </p>
            )}
        </div>
    );
}
