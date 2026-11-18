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
    lobbyNumberLeaveText,
    lobbyPresetMatches,
    readLobbyNumber,
    settleLobbySettings,
} from '@shared/lobby-rules/lobbySettings';
import { unitOf } from '@shared/scoring/units';
import { type ReactNode, type Ref, useId } from 'react';
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
 * - A guest: Require Ownership shows Off with On unavailable and the reason (S14.4u: the module refuses it).
 * - Errors: `useFieldErrors` over `LOBBY_ADVANCED_FIELDS`. The host says when this section moves focus
 *   (`focusRequest`): Create with an invalid field here and none in the main fields, or the dialog's Done.
 * - S14.4d-fix: leaving a number field replaces its text with the text of the value that is sent ("$5" is "5", "1.50"
 *   is "1.5"); a text that does not read stays beside its error. For the lobby room later: `presets` are optional,
 *   `locks` makes single fields read-only with their reason, `readOnlyReason` the whole section (info buttons work in
 *   both; `disabled` does not keep them).
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
    /**
     * The preset list and the one picked last: the note at the top names it, or "Custom". Optional (a host without a
     * preset select, as the lobby room's settings will be): without them the note is not shown.
     */
    presets?: readonly LobbyPresetChoice[];
    presetKey?: string;
    /**
     * Per field, why it cannot change here (S14.4d-fix, for the lobby room: a setting a tournament fixes). A locked field
     * is read-only and stays focusable, its reason shown under it as its description; its info button still works.
     */
    locks?: Partial<Record<LobbyAdvancedField, string>>;
    /**
     * The whole section is read-only (S14.4d-fix, for the lobby room: a member who is not the host): this reason shows
     * once at the top and describes every field; the fields stay focusable and the info buttons work (unlike `disabled`).
     */
    readOnlyReason?: string;
    /** The first field (Ban Restriction), for a host dialog's first focus. */
    firstFieldRef?: Ref<HTMLSelectElement>;
    /** A submit is in flight: the whole section is out of reach (`fieldset disabled`). */
    disabled?: boolean;
};

/** The three Auction amounts, one group. */
const AUCTION_FIELDS = ['characterBudget', 'lightconeBudget', 'minimumBidRaise'] as const;

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
    locks,
    readOnlyReason,
    firstFieldRef,
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
    const picked = presets?.find((p) => p.key === presetKey);
    const presetLabel =
        picked && lobbyPresetMatches(value, picked, rules) ? picked.label : FORM_TEXT.presetCustom;

    const readOnlyId = fieldId('read-only');
    /** Why a field cannot change here: the whole section's reason (shown once at the top), else the field's own. */
    const lockOf = (key: LobbyAdvancedField): FieldLock | undefined => {
        if (readOnlyReason !== undefined) return { reasonId: readOnlyId };
        const reason = locks?.[key];
        return reason === undefined ? undefined : { reasonId: fieldId(`${key}-locked`), reason };
    };

    const number = (
        key: LobbyNumberFieldKey & LobbyAdvancedField,
        unitShown: string | null,
        unitSpoken: string,
        groupLock?: { reasonId: string },
    ) => {
        const text = lobbyNumberFieldText(key, drafts[key], value[key]);
        const locked =
            lockOf(key) ??
            // A field the group locks that holds an error stays editable, so a preset's bad value can be fixed.
            (groupLock && errors[key] === undefined ? groupLock : undefined);
        return (
            <NumberField
                id={fieldId(key)}
                label={FIELD_LABEL[key]}
                info={INFO[key]}
                unit={unitShown}
                unitSpoken={unitSpoken}
                text={text}
                decimal={LOBBY_NUMBER_FIELD_KIND[key] !== 'whole'}
                locked={locked}
                onText={(next) => {
                    onDraftsChange({ ...drafts, [key]: next });
                    set(key, readLobbyNumber(key, next));
                }}
                onLeave={() => {
                    touch(key);
                    // S14.4d-fix (review D S4): leaving shows the text of the value that is sent ("1.50" is "1.5").
                    if (locked) return;
                    const shown = lobbyNumberLeaveText(key, text);
                    if (shown !== text) onDraftsChange({ ...drafts, [key]: shown });
                }}
                extra={errorProps(key)}
                error={errorLine(key)}
            />
        );
    };

    const toggle = (
        key: BooleanKey & LobbyAdvancedField,
        options: { shown?: boolean; fixed?: string } = {},
    ) => {
        const lock = lockOf(key);
        return (
            <ToggleField
                label={FIELD_LABEL[key]}
                info={INFO[key as keyof typeof INFO] as InfoText}
                value={options.shown ?? value[key]}
                // A lock wins; the whole section's reason is shown once at the top, not under each field.
                fixed={lock ? (lock.reason ?? readOnlyReason) : options.fixed}
                showReason={lock ? lock.reason !== undefined : true}
                onChange={(on) => set(key, on)}
            />
        );
    };

    // Classic-only settings: Ranked fixes mirror picks Off; an Auction lobby does not use either, and sends both Off
    // (review D M4), so both show Off there.
    const mirrorReason = isRanked ? TEXT.rankedMirror : isAuction ? TEXT.classicLocked : undefined;
    const autoPickReason = isAuction ? TEXT.classicLocked : undefined;
    const auctionReasonId = fieldId('auction-locked');
    // Review D M12: the group is dimmed only while none of its amounts holds an error (that one stays editable).
    const auctionDimmed = !isAuction && AUCTION_FIELDS.every((k) => errors[k] === undefined);

    return (
        <fieldset
            ref={containerRef}
            className={styles.advanced}
            disabled={disabled}
            data-advanced-settings=""
            data-read-only={readOnlyReason !== undefined ? '' : undefined}
        >
            {presets && <p className={styles.note}>{TEXT.presetNote(presetLabel)}</p>}
            {readOnlyReason !== undefined && (
                <p id={readOnlyId} className={form.hint} data-read-only-reason="">
                    {readOnlyReason}
                </p>
            )}

            <Group title={TEXT.match}>
                <div className={styles.grid}>
                    <SelectField
                        selectRef={firstFieldRef}
                        id={fieldId('banRestriction')}
                        label={TEXT.banRestriction}
                        info={INFO.banRestriction}
                        value={value.banRestriction}
                        onChange={(v) =>
                            set('banRestriction', v as LobbySettings['banRestriction'])
                        }
                        options={BAN_RESTRICTION_OPTIONS.map((r) => [r, BAN_RESTRICTION_LABEL[r]])}
                        locked={lockOf('banRestriction')}
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
                        locked={lockOf('lineupFormat')}
                        extra={errorProps('lineupFormat')}
                        error={errorLine('lineupFormat')}
                    />
                </div>
                <div className={styles.grid}>
                    {(['teamBlueAlias', 'teamRedAlias'] as const).map((key) => {
                        const lock = lockOf(key);
                        const ownError = errorProps(key);
                        const describedBy =
                            [lock?.reasonId, ownError['aria-describedby']]
                                .filter(Boolean)
                                .join(' ') || undefined;
                        return (
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
                                    readOnly={lock !== undefined}
                                    aria-disabled={lock ? true : undefined}
                                    onChange={(e) => set(key, e.target.value)}
                                    onBlur={() => touch(key)}
                                    {...ownError}
                                    aria-describedby={describedBy}
                                />
                                {lock?.reason && (
                                    <p id={lock.reasonId} className={form.hint}>
                                        {lock.reason}
                                    </p>
                                )}
                                {errorLine(key)}
                            </div>
                        );
                    })}
                </div>
                <p className={styles.subNote}>{TEXT.classicOnly}</p>
                <div className={styles.grid}>
                    {toggle('allowMirrorPicks', {
                        shown: isRanked || isAuction ? false : value.allowMirrorPicks,
                        fixed: mirrorReason,
                    })}
                    {toggle('autoRandomPick', {
                        shown: isAuction ? false : value.autoRandomPick,
                        fixed: autoPickReason,
                    })}
                </div>
            </Group>

            <Group
                title={TEXT.auction}
                note={TEXT.auctionOnly}
                locked={auctionDimmed}
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
                <div className={styles.grid}>
                    {/* S14.4u: a guest's lobby cannot require ownership (the module refuses it). */}
                    {toggle('requireOwnership', {
                        shown: rules.isGuest ? false : value.requireOwnership,
                        fixed: rules.isGuest ? TEXT.guestOwnership : undefined,
                    })}
                </div>
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
                        locked={lockOf('disconnectPolicy')}
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

/** Why a field cannot change: the element that says so, and its words when they are shown under the field. */
type FieldLock = { reasonId: string; reason?: string };

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
    /**
     * Set: read-only (still focusable), the element `reasonId` as its description; with `reason` that line is shown
     * under the field, without it the reason is an element elsewhere (the group's, or the read-only section's).
     */
    locked?: FieldLock;
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
            {locked?.reason && (
                <p id={locked.reasonId} className={form.hint}>
                    {locked.reason}
                </p>
            )}
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
    showReason = true,
    onChange,
}: {
    label: string;
    info: InfoText;
    value: boolean;
    fixed?: string;
    /** False: `fixed` is shown elsewhere (the read-only section's one line); the option still carries it. */
    showReason?: boolean;
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
            {fixed && showReason && (
                <p className={form.hint} aria-hidden="true">
                    {fixed}
                </p>
            )}
        </div>
    );
}
