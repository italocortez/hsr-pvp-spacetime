import type {
    Archetype,
    CostSet,
    HsrCharacter,
    HsrCharacterArchetype,
    HsrCharacterCost,
    HsrLightcone,
    HsrLightconeCost,
    HsrSynergyCost,
    MyLinkRequestRow,
    MyLoadoutRow,
    MyLobbyListRow,
    MyProfileRow,
    MySuspensionRow,
    PartnerServer,
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

/**
 * The reducers the app calls (`conn.reducers`, generated). M5b: the sign-in flow. Each returns a
 * promise that rejects with the module's refusal text.
 */
export interface ReducersLike {
    /** The generated connection takes an empty object here (the SDK hook would take none). */
    loginAsGuest(params: Record<string, never>): Promise<void>;
    requestLinkCode(args: { clientNonce: string }): Promise<void>;
    confirmLink(args: { confirmToken: string }): Promise<void>;
}

/**
 * S14.3c: the team builder's loadout reducers (docs/loadout/contract.md). Kept apart from
 * `ReducersLike` and optional on the connection, so the test doubles of the earlier steps
 * (`test/mockSignIn.ts` maps every `ReducersLike` key) still fit. S14.3c-rev (A198): both
 * state the version they are based on (`baseRev`, 0 creates).
 */
export interface LoadoutReducersLike {
    saveLoadout(args: {
        slot: number;
        baseRev: number;
        name: string;
        note: string;
        code: string;
    }): Promise<void>;
    deleteLoadout(args: { slot: number; baseRev: number }): Promise<void>;
}

/** Every reducer the app may find on the connection. */
export type AppReducersLike = ReducersLike & Partial<LoadoutReducersLike>;

export interface StdbConnectionLike {
    subscriptionBuilder(): SubscriptionBuilderLike;
    /**
     * Optional so the test double of the earlier steps (`test/mockConnection.ts`) still fits; the
     * generated connection always has it. `useReducerCall` treats a missing one as not connected.
     */
    reducers?: AppReducersLike;
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
        /** M5b: keyless (no primary key): a replaced row arrives as an insert plus a delete. Optional as `reducers`. */
        viewMyLinkRequest?: KeylessTableLike<MyLinkRequestRow>;
        /*
         * S14.2: the three cost tables. Their composite primary keys are not engine keys (no
         * constraint in the bindings), so they are typed keyless; `hsr_synergy_cost` has an `id`
         * key, and readers also listen to `onUpdate` where the handle has it. Optional as
         * `reducers`, so the test doubles of the earlier steps still fit.
         */
        hsrCharacterCost?: KeylessTableLike<HsrCharacterCost>;
        hsrLightconeCost?: KeylessTableLike<HsrLightconeCost>;
        hsrSynergyCost?: KeylessTableLike<HsrSynergyCost>;
        /** S14.3c: the member's own loadouts; keyed by `slot` (so `onUpdate`). Optional as `reducers`. */
        viewMyLoadouts?: TableLike<MyLoadoutRow>;
        /**
         * SUS2: one row while the viewer's account is suspended (Layer 0); keyed by `userId`.
         * Optional as `reducers`, so the test doubles of the earlier steps still fit; the
         * generated connection always has it.
         */
        viewMySuspension?: TableLike<MySuspensionRow>;
        /**
         * S14.4p: the partnered Discord servers (public table, keyed by `id`), a route subscription of `/`.
         * Optional as `reducers`, so the test doubles of the earlier steps still fit.
         */
        partnerServer?: TableLike<PartnerServer>;
    };
}
