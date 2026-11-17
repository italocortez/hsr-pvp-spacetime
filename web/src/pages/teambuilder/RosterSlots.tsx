import type { HsrCharacter, HsrLightcone } from '@bindings/types';
import { BID_MAX, type SlotCost, type Slots } from '@shared/teambuilder';
import {
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent,
    useEffect,
    useId,
    useRef,
    useState,
} from 'react';
import { RemoteImage } from '@/components/RemoteImage/RemoteImage';
import hidden from '@/styles/visuallyHidden.module.css';
import { AmountField } from './AmountField';
import { amountFixed } from './costChartModel';
import { LightconePicker } from './LightconePicker';
import styles from './RosterSlots.module.css';
import { EmptyConeIcon, GripIcon, LinkIcon } from './TeamBuilderIcons';

/*
 * The Active Roster's four slots (S14.3a; the mockup's `.rosterSlots`, `.slot` and its "reference-style slot
 * display": `.lcSlot`, `.verticals`, `.slotCost`, `.lcPick`). A filled slot is one 3:4 card: the portrait, the
 * element (top left) and path (top right) icons, the cost pill (top centre; character | light cone on hover or
 * focus, the link icon while the character is in an active pair), the equipped light cone's art in the lower right
 * (clipped to the mockup's slanted shape over a dark divider, placed by the cone's own position values), the
 * Eidolon and Superimposition selects in a small pill (bottom left; Superimposition only with a cone), and the
 * light cone search bar along the bottom edge (it opens on hover or focus; the art fades and the pill rides up).
 * Remove and the move handle show on hover and on focus inside the card, and always where there is no hover. The
 * name is a visually hidden heading (the mockup shows none) and the card's tooltip. An empty slot is a button:
 * "Empty" and its hint.
 *
 * Swapping two slots (A190 item 8; web-guidance ui-behaviors/drag-and-drop.md): each filled slot has a move
 * handle. Pointer and touch: press the handle and drag onto another slot (filled or empty); the slot under the
 * pointer is outlined; releasing there swaps the two; Escape or releasing elsewhere cancels. The handle alone
 * takes the gesture (`touch-action: none` on it only), so the page still scrolls everywhere else. Click, tap,
 * Space or Enter on the handle picks the slot up (`aria-pressed`); then the arrow keys move it one slot at a time
 * (each step swaps it with its neighbour), a click or tap on another slot's handle or on an empty slot moves it
 * there (screen readers on phones send clicks, not keys), Space, Enter or a click on its own handle drops it,
 * Escape puts it back where it was picked up, and leaving the handle by keyboard drops it. Every move is
 * announced in the page's status region.
 */

export type SlotsProps = {
    slots: Slots;
    costs: readonly (SlotCost | null)[];
    /** Rows not ready yet: filled slots show a placeholder. */
    loading: boolean;
    /** The cost rows are all here: until then the pills show a placeholder, never "n/a". */
    costsReady: boolean;
    /** Characters in an active pair (the pill's link icon). */
    paired: ReadonlySet<string>;
    characterOf: (name: string) => HsrCharacter | undefined;
    lightconeOf: (name: string) => HsrLightcone | undefined;
    lightcones: readonly HsrLightcone[];
    coneCostAtS1: (name: string) => number | undefined;
    onRemove: (index: number) => void;
    onEidolon: (index: number, value: number) => void;
    onSuperimposition: (index: number, value: number) => void;
    onEquip: (index: number, name: string | null) => void;
    onSwap: (a: number, b: number) => void;
    onEmpty: (index: number) => void;
    announce: (text: string) => void;
    draftAuction: boolean;
    /** S14.3b: a slot's Auction extra bid changed (hundredths). */
    onBid: (index: number, hundredths: number) => void;
};

const EIDOLONS = [0, 1, 2, 3, 4, 5, 6] as const;
const SUPERIMPOSITIONS = [1, 2, 3, 4, 5] as const;
const DRAG_THRESHOLD = 4;
/** The light cone art's size (UploadThing files are 904 by 1260); CSS scales it by the cone's width value. */
const CONE_ART = { width: 904, height: 1260 } as const;

type Drag = { from: number; pointerId: number; x0: number; y0: number; dx: number; dy: number };

/**
 * What the person used last, a key or a pointer (review 2 S3). A card shows its hover look on keyboard focus only;
 * Edge matches `:focus-visible` on a select and the text field after a click too, so the card is marked
 * `data-pointer-focus` when focus arrives after a pointer press, and unmarked by any key pressed inside it.
 */
let lastInput: 'key' | 'pointer' = 'key';
function useInputModality() {
    useEffect(() => {
        const key = () => {
            lastInput = 'key';
        };
        const pointer = () => {
            lastInput = 'pointer';
        };
        document.addEventListener('keydown', key, true);
        document.addEventListener('pointerdown', pointer, true);
        return () => {
            document.removeEventListener('keydown', key, true);
            document.removeEventListener('pointerdown', pointer, true);
        };
    }, []);
}

/**
 * The slot under a point, never the dragged one: the lifted card follows the pointer, so its own box is always
 * under it (review S14.3a B1).
 */
export function slotUnder(
    boxes: readonly (DOMRect | undefined)[],
    x: number,
    y: number,
    skip: number,
): number | null {
    for (let i = 0; i < boxes.length; i += 1) {
        if (i === skip) continue;
        const r = boxes[i];
        if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return null;
}

export function RosterSlots(props: SlotsProps) {
    const { slots, onSwap, announce } = props;
    const cellRefs = useRef<(HTMLLIElement | null)[]>([]);
    const [drag, setDrag] = useState<Drag | null>(null);
    const [over, setOver] = useState<number | null>(null);
    const [grabbed, setGrabbed] = useState<{ name: string; origin: number } | null>(null);
    const moving = useRef(false);
    // The click that ends a pointer drag is not a pick-up.
    const dragged = useRef(false);
    // A press on another slot while one is picked up: the handle's blur must not drop it first.
    const pressingTarget = useRef(false);
    useInputModality();

    const nameAt = (i: number) => {
        const s = slots[i];
        return s ? (props.characterOf(s.character)?.displayName ?? s.character) : 'Empty slot';
    };
    // Keyboard moves: keep focus on the moved slot's handle (React re-renders the slots in their new order).
    useEffect(() => {
        if (!grabbed) return;
        const i = slots.findIndex((s) => s?.character === grabbed.name);
        const handle = cellRefs.current[i]?.querySelector<HTMLElement>('[data-move-handle]');
        if (handle && document.activeElement !== handle) handle.focus({ preventScroll: true });
        cellRefs.current[i]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        moving.current = false;
    }, [slots, grabbed]);

    const boxes = () => cellRefs.current.map((el) => el?.getBoundingClientRect());

    const onPointerDown = (event: PointerEvent<HTMLButtonElement>, index: number) => {
        dragged.current = false;
        if (grabbed && slots[index]?.character !== grabbed.name) pressingTarget.current = true;
        if (event.button !== 0 || drag) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDrag({
            from: index,
            pointerId: event.pointerId,
            x0: event.clientX,
            y0: event.clientY,
            dx: 0,
            dy: 0,
        });
    };
    const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.x0;
        const dy = event.clientY - drag.y0;
        setDrag({ ...drag, dx, dy });
        setOver(slotUnder(boxes(), event.clientX, event.clientY, drag.from));
    };
    const endDrag = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const moved = Math.hypot(drag.dx, drag.dy) >= DRAG_THRESHOLD;
        if (moved) {
            dragged.current = true;
            setTimeout(() => {
                dragged.current = false;
            }, 0);
        }
        const target =
            commit && moved ? slotUnder(boxes(), event.clientX, event.clientY, drag.from) : null;
        if (target !== null) {
            const a = nameAt(drag.from);
            const b = slots[target] ? nameAt(target) : null;
            onSwap(drag.from, target);
            setGrabbed(null);
            announce(
                b
                    ? `${a} swapped with ${b}: ${a} in slot ${target + 1}, ${b} in slot ${drag.from + 1}.`
                    : `${a} moved to slot ${target + 1}.`,
            );
        }
        setDrag(null);
        setOver(null);
        // A tap's click (and, on touch, the focus change) comes after pointerup: keep the press marked until then.
        if (moved) pressingTarget.current = false;
    };

    /** The picked-up slot goes to `target` (a click or tap on another slot), then is dropped. */
    const moveGrabbedTo = (target: number) => {
        if (!grabbed) return;
        pressingTarget.current = false;
        const from = slots.findIndex((s) => s?.character === grabbed.name);
        if (from < 0 || from === target) return;
        const a = nameAt(from);
        const b = slots[target] ? nameAt(target) : null;
        const name = grabbed.name;
        setGrabbed(null);
        onSwap(from, target);
        announce(
            b
                ? `${a} swapped with ${b}: ${a} in slot ${target + 1}, ${b} in slot ${from + 1}.`
                : `${a} moved to slot ${target + 1}.`,
        );
        requestAnimationFrame(() => {
            document
                .querySelector<HTMLElement>(`[data-move-handle="${CSS.escape(name)}"]`)
                ?.focus({ preventScroll: true });
        });
    };

    const onHandleClick = (index: number) => {
        if (dragged.current) {
            dragged.current = false;
            return;
        }
        pressingTarget.current = false;
        const slot = slots[index];
        if (!slot) return;
        const name = nameAt(index);
        if (grabbed && grabbed.name !== slot.character) {
            moveGrabbedTo(index);
            return;
        }
        if (grabbed) {
            setGrabbed(null);
            announce(`${name} dropped in slot ${index + 1}.`);
        } else {
            setGrabbed({ name: slot.character, origin: index });
            announce(
                `${name} picked up from slot ${index + 1}. Arrow keys move it, Space drops it, Escape cancels. Or tap another slot.`,
            );
        }
    };

    const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        const slot = slots[index];
        if (!slot) return;
        const name = nameAt(index);
        if (drag && event.key === 'Escape') {
            // The release and its click still come: that click ends the cancelled drag, it is no pick-up
            // (review 2 M1). The next press clears the mark in case no click follows.
            dragged.current = true;
            setDrag(null);
            setOver(null);
            announce('Move cancelled.');
            return;
        }
        if (!grabbed) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            moving.current = true;
            // Back the way it came: adjacent swaps restore every other slot too.
            for (let i = index; i !== grabbed.origin; i += grabbed.origin > i ? 1 : -1)
                onSwap(i, grabbed.origin > i ? i + 1 : i - 1);
            setGrabbed(null);
            announce(`Move cancelled. ${name} is back in slot ${grabbed.origin + 1}.`);
            return;
        }
        const step =
            event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -1
                  : 0;
        if (step === 0) return;
        event.preventDefault();
        const target = index + step;
        if (target < 0 || target >= slots.length) return;
        moving.current = true;
        onSwap(index, target);
        announce(`${name} moved to slot ${target + 1}.`);
    };

    const onHandleBlur = (index: number) => {
        if (!grabbed || moving.current || pressingTarget.current) return;
        setGrabbed(null);
        announce(`${nameAt(index)} dropped in slot ${index + 1}.`);
    };

    return (
        <ol className={styles.slots} data-dragging={drag ? '' : undefined}>
            {slots.map((slot, index) => {
                const key = slot ? `c-${slot.character}` : `e-${index}`;
                const lifted = drag?.from === index && Math.hypot(drag.dx, drag.dy) >= 1;
                return (
                    <li
                        key={key}
                        ref={(el) => {
                            cellRefs.current[index] = el;
                        }}
                        className={styles.cell}
                        data-slot={index}
                        data-drop-target={over === index ? '' : undefined}
                        data-lifted={lifted ? '' : undefined}
                        data-grabbed={grabbed && slot?.character === grabbed.name ? '' : undefined}
                        style={
                            lifted
                                ? ({
                                      '--drag-x': `${drag?.dx ?? 0}px`,
                                      '--drag-y': `${drag?.dy ?? 0}px`,
                                  } as CSSProperties)
                                : undefined
                        }
                    >
                        {slot ? (
                            <FilledSlot
                                {...props}
                                index={index}
                                grabbed={grabbed?.name === slot.character}
                                handlers={{
                                    onPointerDown: (e) => onPointerDown(e, index),
                                    onPointerMove,
                                    onPointerUp: (e) => endDrag(e, true),
                                    onPointerCancel: (e) => endDrag(e, false),
                                    onLostPointerCapture: (e) => endDrag(e, false),
                                    onClick: () => onHandleClick(index),
                                    onKeyDown: (e) => onHandleKey(e, index),
                                    onBlur: () => onHandleBlur(index),
                                }}
                            />
                        ) : (
                            <button
                                type="button"
                                className={styles.empty}
                                data-slot-focus=""
                                aria-label={
                                    grabbed
                                        ? `Slot ${index + 1}, empty: move ${nameAt(slots.findIndex((s) => s?.character === grabbed.name))} here`
                                        : `Slot ${index + 1}, empty: pick a character`
                                }
                                onPointerDown={() => {
                                    if (grabbed) pressingTarget.current = true;
                                }}
                                onClick={() =>
                                    grabbed ? moveGrabbedTo(index) : props.onEmpty(index)
                                }
                            >
                                <span className={styles.emptyMark}>Empty</span>
                                <span className={styles.emptyHint} data-wide-hint="">
                                    Click a character below
                                </span>
                                <span className={styles.emptyHint} data-narrow-hint="">
                                    Pick a character below
                                </span>
                            </button>
                        )}
                        {slot && props.draftAuction && (
                            <SlotBid
                                index={index}
                                name={nameAt(index)}
                                value={slot.bid ?? 0}
                                onBid={props.onBid}
                                announce={announce}
                            />
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

/**
 * S14.3b: the Auction "Extra bid" under a filled card (the mockup's `.slotBid`): what the team bids on top of the
 * base, step 0.5 by the arrow keys, at least 0, at most 99.99 (the packed team text's limit); a blank snaps back to 0.
 */
function SlotBid({
    index,
    name,
    value,
    onBid,
    announce,
}: {
    index: number;
    name: string;
    value: number;
    onBid: (index: number, hundredths: number) => void;
    announce: (text: string) => void;
}) {
    const id = useId();
    return (
        <div className={styles.bid}>
            <label className={styles.bidLabel} htmlFor={id}>
                Extra bid
            </label>
            <span className={styles.bidPlus} aria-hidden="true">
                +
            </span>
            {/* The name says whose bid it is: the visible label is the same on all four cards. */}
            <AmountField
                id={id}
                aria-label={`Extra bid for ${name}`}
                className={styles.bidInput}
                messageClassName={styles.bidMessage}
                value={value}
                max={BID_MAX}
                onChange={(v) => onBid(index, v)}
                announce={announce}
            />
        </div>
    );
}

type HandleProps = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => void;
    onLostPointerCapture: (e: PointerEvent<HTMLButtonElement>) => void;
    onClick: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
    onBlur: () => void;
};

/** The cone's art placement (`--lcw`, `--lcx`, `--lcy`, percentages, from `hsr_lightcone`); unset values keep the
 * mockup's defaults. */
function conePosition(cone: HsrLightcone): CSSProperties {
    if (cone.width <= 0) return {};
    return {
        '--lcw': String(cone.width),
        '--lcx': String(cone.posX),
        '--lcy': String(cone.posY),
    } as CSSProperties;
}

function FilledSlot({
    index,
    slots,
    costs,
    loading,
    costsReady,
    paired,
    characterOf,
    lightconeOf,
    lightcones,
    coneCostAtS1,
    onRemove,
    onEidolon,
    onSuperimposition,
    onEquip,
    announce,
    draftAuction,
    grabbed,
    handlers,
}: SlotsProps & { index: number; grabbed: boolean; handlers: HandleProps }) {
    const slot = slots[index];
    if (!slot) return null;
    const c = characterOf(slot.character);
    const cone = slot.lightcone ? lightconeOf(slot.lightcone) : undefined;
    const name = c?.displayName ?? slot.character;
    const cost = costs[index];
    const unavailable = !loading && !c;
    const element = c?.element.tag.toLowerCase();
    const path = c?.path.tag.toLowerCase();
    const charCost = cost?.character;
    const coneCost = cost?.lightcone;
    // S14.3e: exact amounts (`amountFixed`: one decimal, two when the hundredths need them), so the parts add up to
    // the pill and the pills to the total, as on the chart and the picture.
    const costText = (v: number | null | undefined) =>
        v === null || v === undefined ? 'n/a' : amountFixed(v);
    const total = cost ? amountFixed(cost.total) : '';
    const missing = costsReady && (charCost === null || coneCost === null);
    const inPair = paired.has(slot.character);

    return (
        <article
            className={styles.slot}
            data-rarity={c?.rarity}
            data-unavailable={unavailable ? '' : undefined}
            data-cone={cone ? '' : undefined}
            aria-label={`Slot ${index + 1}: ${name}`}
            title={cone ? `${name} · ${cone.displayName}` : name}
            onFocus={(e) =>
                e.currentTarget.toggleAttribute('data-pointer-focus', lastInput === 'pointer')
            }
            onPointerDown={(e) => e.currentTarget.setAttribute('data-pointer-focus', '')}
            onKeyDown={(e) => e.currentTarget.removeAttribute('data-pointer-focus')}
        >
            {c && !loading ? (
                <RemoteImage
                    src={c.imageUrl}
                    alt=""
                    width={240}
                    height={320}
                    aboveFold
                    className={styles.portrait}
                />
            ) : (
                <span className={styles.portraitPlaceholder} aria-hidden="true" />
            )}
            {element && (
                <img
                    className={styles.element}
                    src={`/elements/${element}.webp`}
                    alt={c?.element.tag}
                    title={c?.element.tag}
                    width={32}
                    height={32}
                />
            )}
            {path && (
                <img
                    className={styles.path}
                    src={`/paths/${path}.webp`}
                    alt={c?.path.tag}
                    title={c?.path.tag}
                    width={32}
                    height={32}
                />
            )}

            {/* The cone's place: the divider shape, then the art (or the empty mark) clipped to the slanted shape. */}
            <div className={`${styles.lcSlot} ${styles.lcDivider}`} aria-hidden="true" />
            <div
                className={styles.lcSlot}
                style={cone ? conePosition(cone) : undefined}
                aria-hidden="true"
            >
                {cone ? (
                    <RemoteImage
                        src={cone.imageUrl}
                        alt=""
                        width={CONE_ART.width}
                        height={CONE_ART.height}
                        className={styles.lcArt}
                    />
                ) : (
                    <EmptyConeIcon className={styles.lcEmpty} />
                )}
            </div>

            {cost && (
                <p className={styles.cost} data-missing={missing ? '' : undefined}>
                    {costsReady ? (
                        <>
                            <span className={styles.costTotal} aria-hidden="true">
                                {total}
                            </span>
                            <span className={styles.costParts} aria-hidden="true">
                                <b className={styles.costChar}>{costText(charCost)}</b>
                                <i className={styles.costDivider} />
                                <b className={styles.costCone}>
                                    {slot.lightcone ? costText(coneCost) : amountFixed(0)}
                                </b>
                            </span>
                            <span className={hidden.visuallyHidden}>
                                {`Cost ${total}: character ${costText(charCost)}${
                                    draftAuction && cost.extra > 0
                                        ? ` (eidolon extra ${amountFixed(cost.extra)})`
                                        : ''
                                }, light cone ${slot.lightcone ? costText(coneCost) : 'none'}`}
                            </span>
                        </>
                    ) : (
                        <>
                            <span aria-hidden="true">{'–.–'}</span>
                            <span className={hidden.visuallyHidden}>Cost loading</span>
                        </>
                    )}
                    {inPair && (
                        <>
                            <LinkIcon className={styles.syn} />
                            <span className={hidden.visuallyHidden}>, in an active pair</span>
                        </>
                    )}
                </p>
            )}

            <h3 className={hidden.visuallyHidden}>{name}</h3>
            {(unavailable || !c) && (
                <p className={styles.status}>
                    <span className={styles.statusName}>{name}</span>
                    <span className={styles.statusText}>
                        {unavailable ? 'Not available' : 'Loading'}
                    </span>
                </p>
            )}

            <div className={styles.verticals}>
                <label className={styles.select}>
                    <span className={hidden.visuallyHidden}>Eidolon for {name}</span>
                    <select
                        value={slot.eidolon}
                        data-slot-focus=""
                        disabled={unavailable}
                        onChange={(e) => onEidolon(index, Number(e.currentTarget.value))}
                    >
                        {EIDOLONS.map((e) => (
                            <option key={e} value={e}>
                                E{e}
                            </option>
                        ))}
                    </select>
                </label>
                {slot.lightcone && (
                    <label className={styles.select} data-imposition="">
                        <span className={hidden.visuallyHidden}>Superimposition for {name}</span>
                        <select
                            value={slot.superimposition}
                            onChange={(e) =>
                                onSuperimposition(index, Number(e.currentTarget.value))
                            }
                        >
                            {SUPERIMPOSITIONS.map((s) => (
                                <option key={s} value={s}>
                                    S{s}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
            </div>

            <LightconePicker
                character={c}
                characterName={name}
                equipped={cone}
                equippedKey={slot.lightcone}
                superimposition={slot.superimposition}
                lightcones={lightcones}
                costOf={coneCostAtS1}
                onEquip={(n) => onEquip(index, n)}
                announce={announce}
                pickClassName={styles.lcPick ?? ''}
                searchClassName={styles.lcSearch ?? ''}
                tapClassName={styles.lcTap ?? ''}
            />

            {/* Tab order: the slot's own controls first, then move and remove (top right, shown on hover/focus). */}
            <button
                type="button"
                className={styles.handle}
                data-move-handle={slot.character}
                aria-label={`Move ${name}, slot ${index + 1}`}
                aria-pressed={grabbed}
                title="Drag to swap slots, or click to pick up"
                {...handlers}
            >
                <GripIcon className={styles.grip} />
            </button>
            <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${name}`}
                title={`Remove ${name}`}
                onClick={() => onRemove(index)}
            >
                <span aria-hidden="true">{'×'}</span>
            </button>
        </article>
    );
}
