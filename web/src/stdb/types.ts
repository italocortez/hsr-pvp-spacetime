import type {
    Archetype,
    CostSet,
    HsrCharacter,
    HsrCharacterArchetype,
    HsrLightcone,
    MyLobbyListRow,
    MyProfileRow,
} from '@bindings/types';

/*
 * The slice of the SDK connection this app uses, as plain structural types. The generated
 * `DbConnection` satisfies them; `web/src/test/mockConnection.ts` implements them for tests, so
 * no test needs a socket. Keep this list to what the code below actually calls.
 */

/** A subscription handle: kept by whoever subscribed, unsubscribed on leave. */
export interface SubscriptionHandleLike {
    unsubscribe(): void;
    isEnded(): boolean;
}

/** `conn.subscriptionBuilder()`: SQL strings only (`toSql(tables.x)` for the query builder). */
export interface SubscriptionBuilderLike {
    onApplied(cb: () => void): SubscriptionBuilderLike;
    onError(cb: (ctx: unknown, error?: Error) => void): SubscriptionBuilderLike;
    subscribe(query: string): SubscriptionHandleLike;
}

type RowCallback<Row> = (ctx: unknown, row: Row) => void;
type UpdateCallback<Row> = (ctx: unknown, oldRow: Row, newRow: Row) => void;

/** A client-cache table handle (`conn.db.x`) with a primary key (so `onUpdate` exists). */
export interface TableLike<Row> {
    iter(): Iterable<Row>;
    onInsert(cb: RowCallback<Row>): void;
    removeOnInsert(cb: RowCallback<Row>): void;
    onDelete(cb: RowCallback<Row>): void;
    removeOnDelete(cb: RowCallback<Row>): void;
    onUpdate(cb: UpdateCallback<Row>): void;
    removeOnUpdate(cb: UpdateCallback<Row>): void;
}

/** A client-cache table handle without a primary key (insert and delete only). */
export type KeylessTableLike<Row> = Omit<TableLike<Row>, 'onUpdate' | 'removeOnUpdate'>;

export interface StdbConnectionLike {
    subscriptionBuilder(): SubscriptionBuilderLike;
    /** Closes the connection for good (the provider's manager then waits for a Retry). */
    disconnect(): void;
    db: {
        viewMyProfile: TableLike<MyProfileRow>;
        viewMyLobbies: TableLike<MyLobbyListRow>;
        hsrCharacter: TableLike<HsrCharacter>;
        hsrLightcone: TableLike<HsrLightcone>;
        archetype: TableLike<Archetype>;
        hsrCharacterArchetype: KeylessTableLike<HsrCharacterArchetype>;
        viewPublishedCostSets: TableLike<CostSet>;
    };
}
