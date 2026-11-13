import type {
    Archetype,
    CostSet,
    HsrCharacter,
    HsrCharacterArchetype,
    HsrLightcone,
    MyLobbyListRow,
    MyProfileRow,
} from '@bindings/types';
import type { ConnectionEventsLike } from '@/stdb/connection';
import type {
    StdbConnectionLike,
    SubscriptionBuilderLike,
    SubscriptionHandleLike,
    TableLike,
} from '@/stdb/types';

/*
 * Test double for exactly the connection surface the app uses (`web/src/stdb/types.ts`): a
 * subscription builder whose handles tests apply or fail, table caches whose rows tests insert,
 * update and delete (cache first, then callbacks, as the SDK does), and a builder whose connect
 * and disconnect events tests fire. No socket, no network.
 */

type RowCb<Row> = (ctx: unknown, row: Row) => void;
type UpdateCb<Row> = (ctx: unknown, oldRow: Row, newRow: Row) => void;
const CTX = { event: { tag: 'Transaction' } };

export class MockTable<Row> implements TableLike<Row> {
    rows: Row[] = [];
    readonly inserts = new Set<RowCb<Row>>();
    readonly deletes = new Set<RowCb<Row>>();
    readonly updates = new Set<UpdateCb<Row>>();

    iter(): Iterable<Row> {
        return [...this.rows];
    }
    onInsert(cb: RowCb<Row>) {
        this.inserts.add(cb);
    }
    removeOnInsert(cb: RowCb<Row>) {
        this.inserts.delete(cb);
    }
    onDelete(cb: RowCb<Row>) {
        this.deletes.add(cb);
    }
    removeOnDelete(cb: RowCb<Row>) {
        this.deletes.delete(cb);
    }
    onUpdate(cb: UpdateCb<Row>) {
        this.updates.add(cb);
    }
    removeOnUpdate(cb: UpdateCb<Row>) {
        this.updates.delete(cb);
    }

    /** Number of callbacks still registered (all three kinds). */
    get listenerCount(): number {
        return this.inserts.size + this.deletes.size + this.updates.size;
    }

    /** Puts rows in the cache without events (rows that arrive with a subscription's first result, before `apply`). */
    seed(...rows: Row[]) {
        this.rows.push(...rows);
    }
    insert(...rows: Row[]) {
        this.rows.push(...rows);
        for (const row of rows) for (const cb of [...this.inserts]) cb(CTX, row);
    }
    delete(row: Row) {
        this.rows = this.rows.filter((r) => r !== row);
        for (const cb of [...this.deletes]) cb(CTX, row);
    }
    update(oldRow: Row, newRow: Row) {
        this.rows = this.rows.map((r) => (r === oldRow ? newRow : r));
        for (const cb of [...this.updates]) cb(CTX, oldRow, newRow);
    }
}

export class MockSubscription implements SubscriptionHandleLike {
    unsubscribed = false;
    ended = false;
    constructor(
        readonly query: string,
        private readonly applied?: () => void,
        private readonly errored?: (ctx: unknown, error?: Error) => void,
        /** Like a live socket: the end arrives later (`end()`), not at `unsubscribe()`. */
        private readonly delayEnd = false,
    ) {}
    unsubscribe() {
        // Same rule as the SDK handle: a second call throws.
        if (this.unsubscribed) throw new Error('Unsubscribe has already been called');
        this.unsubscribed = true;
        if (!this.delayEnd) this.ended = true;
    }
    /** The server's late confirmation of an unsubscribe. */
    end() {
        this.ended = true;
    }
    isEnded() {
        return this.ended;
    }
    /** Fires a result (rows are whatever the tables hold); again for a replay after a reconnect. */
    apply() {
        this.applied?.();
    }
    /**
     * Fires the error. `thenDrop` models the SDK's order for a failed replay
     * (`#applyReplayBatch`): the error callback first, then the deletes of the rows this
     * subscription had brought into the cache.
     */
    fail(message: string, thenDrop?: () => void) {
        this.ended = true;
        this.errored?.(CTX, new Error(message));
        thenDrop?.();
    }
}

export class MockConnection implements StdbConnectionLike {
    /** Every subscription ever created, in order (unsubscribed ones included). */
    readonly subscriptions: MockSubscription[] = [];
    /** Calls to `disconnect()`. */
    disconnects = 0;
    /** New handles end only when the test calls `end()` on them (a live unsubscribe round trip). */
    delayEnd = false;

    disconnect() {
        this.disconnects += 1;
    }
    readonly db = {
        viewMyProfile: new MockTable<MyProfileRow>(),
        viewMyLobbies: new MockTable<MyLobbyListRow>(),
        hsrCharacter: new MockTable<HsrCharacter>(),
        hsrLightcone: new MockTable<HsrLightcone>(),
        archetype: new MockTable<Archetype>(),
        hsrCharacterArchetype: new MockTable<HsrCharacterArchetype>(),
        viewPublishedCostSets: new MockTable<CostSet>(),
    };

    subscriptionBuilder(): SubscriptionBuilderLike {
        let applied: (() => void) | undefined;
        let errored: ((ctx: unknown, error?: Error) => void) | undefined;
        const builder: SubscriptionBuilderLike = {
            onApplied: (cb) => {
                applied = cb;
                return builder;
            },
            onError: (cb) => {
                errored = cb;
                return builder;
            },
            subscribe: (query) => {
                const sub = new MockSubscription(query, applied, errored, this.delayEnd);
                this.subscriptions.push(sub);
                return sub;
            },
        };
        return builder;
    }

    /** Subscriptions neither unsubscribed nor ended by an error. */
    live(): MockSubscription[] {
        return this.subscriptions.filter((s) => !s.unsubscribed && !s.ended);
    }
    liveQueries(): string[] {
        return this.live().map((s) => s.query);
    }
    /** Fires the first result of every live subscription to `query`. */
    apply(query: string) {
        for (const sub of this.live()) if (sub.query === query) sub.apply();
    }
    applyAll() {
        for (const sub of this.live()) sub.apply();
    }
}

type Cb = (...args: never[]) => void;

/** A connection builder whose lifecycle events tests fire by hand. */
export class MockBuilder implements ConnectionEventsLike {
    private readonly handlers: Record<string, Cb[]> = {};
    private on(event: string, cb: Cb) {
        const list = this.handlers[event] ?? [];
        list.push(cb);
        this.handlers[event] = list;
        return this;
    }
    onConnect(cb: (conn: unknown, identity: unknown, token: string) => void) {
        return this.on('connect', cb);
    }
    onAutomaticReconnect(cb: (conn: unknown, identity: unknown, token: string) => void) {
        return this.on('automaticReconnect', cb);
    }
    onConnectError(cb: (ctx: unknown, error: Error, next?: number, delay?: number) => void) {
        return this.on('connectError', cb);
    }
    onDisconnect(cb: (ctx: unknown, error?: Error, next?: number, delay?: number) => void) {
        return this.on('disconnect', cb);
    }
    private emit(event: string, ...args: unknown[]) {
        for (const cb of this.handlers[event] ?? []) (cb as (...a: unknown[]) => void)(...args);
    }

    /** The connection the events come from; `isDisconnectRequested` as on the SDK connection. */
    readonly conn = {
        isDisconnectRequested: false,
        disconnects: 0,
        disconnect() {
            this.isDisconnectRequested = true;
            this.disconnects += 1;
        },
    };

    connect(token: string) {
        this.emit('connect', this.conn, {}, token);
    }
    automaticReconnect(token: string) {
        this.emit('automaticReconnect', this.conn, {}, token);
    }
    connectError(error: Error, nextAttempt?: number) {
        this.emit('connectError', this.conn, error, nextAttempt, nextAttempt && 1000);
    }
    disconnect(error?: Error, nextAttempt?: number) {
        this.emit('disconnect', this.conn, error, nextAttempt, nextAttempt && 1000);
    }
}

/** A `view_my_profile` row. */
export function profileRow(overrides: Partial<MyProfileRow> = {}): MyProfileRow {
    return {
        id: 7,
        username: 'kafka',
        displayName: 'Kafka',
        avatarCharacterName: 'kafka',
        displayedAchievementId: undefined,
        hasDiscordLinked: false,
        isGuest: false,
        role: { tag: 'User' },
        loginMethod: undefined,
        providerId: undefined,
        providerUsername: undefined,
        ...overrides,
    };
}
