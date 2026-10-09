/**
 * The artifact format (§3.2, D2).
 *
 * This is the canonical site for the artifact types: generated artifact modules import them from
 * `@flamme/runtime` directly, and `@flamme/core` imports them with `import type` only
 * (§2.2 rule 2). An artifact is plain data and is never mutated by the runtime.
 */

/** The four document kinds. Lowercase deliberately (D2); Houdini's literals are `HoudiniQuery`, … */
export type ArtifactKind = 'query' | 'fragment' | 'mutation' | 'subscription';

/** Cache policies (D5). Declared once; §5.5 and §7.8 reference this declaration. */
export type CachePolicy = 'CacheOrNetwork' | 'NetworkOnly' | 'CacheAndNetwork' | 'CacheOnly';

/** Where a cache read's data came from. */
export type DataSource = 'cache' | 'network' | 'partial' | 'optimistic';

/**
 * One compiler output. Framework-agnostic and frozen; the runtime never mutates an artifact.
 *
 * `__data`, `__input` and `__key` are phantom carriers: they are declared here and added by the
 * generated cast (`const document: Info = artifact as unknown as Info`), never present on the
 * runtime object. They exist so `typeof import('./Info').default` is usable as a hook argument
 * (§3.1, the `TypedDocumentNode` technique).
 */
export interface Artifact<
  K extends ArtifactKind = ArtifactKind,
  TData = unknown,
  TInput = unknown,
  TKey = unknown,
> {
  readonly name: string;
  readonly kind: K;
  /**
   * sha256 hex of `raw` **exactly as stored**, trailing newline included; no `trim()`, no
   * normalization. The document id used for dedupe, persisted queries and HMR (§4.6).
   */
  readonly hash: string;
  /** The operation plus every transitively referenced fragment, printed and sorted by name. */
  readonly raw: string;
  readonly rootType: string;
  readonly selection: SubscriptionSelection;
  readonly input?: InputObject;
  /** Variables that survive printing but are unused by the operation. */
  readonly stripVariables: readonly string[];
  readonly refetch?: RefetchSpec;
  /**
   * The companion query a **paginated fragment**'s page requests are sent as
   * (`<FragmentName>_Pagination_Query`, §7.3): the fragment's fields inlined into a query rooted at
   * its owner type. `Client.fetchFragmentPage` sends it, and the page it writes lands on the owner
   * record the fragment reads through. Absent on every other artifact.
   */
  readonly paginationArtifact?: Artifact<'query'>;
  readonly operations?: readonly ListOperation[];
  readonly pluginData: Readonly<Record<string, unknown>>;
  /** Queries only. */
  readonly policy?: CachePolicy;
  readonly partial?: boolean;
  /** Present when the document or any selection carries `@loading`. */
  readonly enableLoadingState?: 'local' | 'global';
  /**
   * `true` when a field of the document is marked `@optimisticKey` (§7.14): the document can create
   * a record whose server id is not known yet, and the mutation writes it under a generated id that
   * the confirmation remaps. Absent otherwise.
   */
  readonly optimisticKeys?: boolean;
  /**
   * Every `@defer`/`@stream` target in the document, sorted by label (§7.13). Absent for a document
   * that declares none, which is what keeps a non-incremental artifact byte-identical.
   */
  readonly deferred?: readonly DeferredSpec[];

  /** @internal phantom result carrier — never present at runtime. */
  readonly __data?: TData;
  /** @internal phantom variables carrier — never present at runtime. */
  readonly __input?: TInput;
  /** @internal phantom fragment-reference carrier — never present at runtime. */
  readonly __key?: TKey;
}

/** The generated handle's result type, read off the phantom carrier. */
export type ArtifactData<A> = A extends { readonly __data?: infer D } ? D : never;
/** The generated handle's variables type, read off the phantom carrier. */
export type ArtifactInput<A> = A extends { readonly __input?: infer I } ? I : never;
/** The generated handle's fragment-reference type, read off the phantom carrier. */
export type ArtifactKey<A> = A extends { readonly __key?: infer K } ? K : never;

/** A normalized selection node: fields by response key, fragment spreads by name. */
export interface SubscriptionSelection {
  readonly fields?: Readonly<Record<string, FieldSpec>>;
  readonly fragments?: Readonly<Record<string, FragmentSpec>>;
  /** Inline fragments on abstract types, keyed by the concrete type condition. */
  readonly abstractFields?: Readonly<Record<string, SubscriptionSelection>>;
}

export interface FieldSpec {
  /** The GraphQL type name of the field's value, with modifiers stripped (`SpeciesMoveConnection`). */
  readonly type: string;
  /**
   * The full GraphQL type string, `!` for non-null and one `]` per closed list level:
   * `Species`, `[Species!]!`, `SpeciesMoveConnection!`. List-ness and list depth are read from
   * here (§7.2 `depth` = number of `]`; §9.2 array types; §6.4 connection storage).
   */
  readonly modifiers: string;
  /** Field name plus arguments, before variable interpolation; `::paginated` for Infinite pagination. */
  readonly keyRaw: string;
  readonly selection?: SubscriptionSelection;
  readonly abstractFields?: Readonly<Record<string, SubscriptionSelection>>;
  /** `true` when the schema type is nullable (the outermost modifier is not `!`). */
  readonly nullable?: boolean;
  /**
   * `@required` on the field: non-null in the generated types, so a null or missing value at read
   * time nulls the enclosing object instead of producing a `null` where the type promises a value.
   */
  readonly required?: boolean;
  /** Included in masked reads. `false`/absent for injected internal fields (`__typename`). */
  readonly visible?: boolean;
  /** The field's value type is an interface or union. */
  readonly abstract?: boolean;
  /**
   * An abstract field with at least one direct child made non-null by `@required`: the one child
   * that is null lives in a single branch, so the read poisons the value with
   * `REQUIRED_MISSING_TYPENAME` instead of nulling every branch's data.
   */
  readonly abstractHasRequired?: boolean;
  readonly directives?: readonly DirectiveSpec[];
  /** Loading metadata. Absent when the field takes no part in a loading state. */
  readonly loading?: LoadingSpec;
  /** `@list` specification. */
  readonly list?: ListSpec;
  /** Arguments currently applied to a `@list` field, serialized for the list manager. */
  readonly filters?: Readonly<Record<string, GraphQLValue>>;
  /** `@paginate` specification (at most one per document, see §7.3). */
  readonly pagination?: PaginationSpec;
  /** Merge direction for a connection field under Infinite pagination. */
  readonly updates?: readonly ('append' | 'prepend')[];
  /** `@list` insert operations produced by a mutation payload at this field. */
  readonly operations?: readonly ListOperation[];
  /**
   * `@optimisticKey` on this field (§7.14): the field will hold a created record's server id, so an
   * optimistic write that leaves it unresolved gets a generated id. Only ever `true` on a key field.
   */
  readonly optimisticKey?: boolean;
  /**
   * `@stream` on this list field (§7.13): the initial payload carries `initialCount` items and the
   * rest arrive as `items` patches. Only `kind: 'list'` is recorded here; a deferred inline
   * fragment is recorded on the fields it contributes and in the artifact's `deferred` list.
   */
  readonly defer?: DeferredSpec;
}

export interface FragmentSpec {
  /** Evaluated fragment arguments in GraphQL value form; `{}` when the fragment takes none. */
  readonly arguments: Readonly<Record<string, GraphQLValue>>;
  /** The spread sits under a loading state: the reference is a placeholder while loading. */
  readonly loading?: boolean;
  /**
   * `@when` / `@when_not`: the conditions under which the spread's fields are part of the
   * selection. Absent means unconditional; several entries are a disjunction (the fields are in
   * the selection when any one condition holds). The writer uses this to keep the conditionally
   * spread fragment's fields out of the cache; the read drops the fields through the `when`
   * directives on the fields themselves.
   */
  readonly when?: readonly WhenCondition[];
  /**
   * `@defer` on this spread (§7.13): the fragment's fields are not part of the initial payload; they
   * arrive in a patch whose `path` is the object the spread sits on. The ` $fragments` entry for the
   * spread is written by the initial read anyway, which is what lets a child read the fragment with
   * `partial: true` before its fields arrive.
   */
  readonly defer?: DeferredSpec;
}

/**
 * One `@defer`/`@stream` target (`spec/spec.md` §7.13). The directive stays in `raw` (the server
 * must see it); this is the artifact's own copy, so the runtime can attribute a patch and answer
 * "is this part of the response still pending?" without re-parsing the document.
 */
export interface DeferredSpec {
  /** The label a patch carries: `label:` when the document declared one, else a derived name. */
  readonly label: string;
  /**
   * Response-key path from the artifact root: the enclosing object for a `@defer` fragment, the
   * list field itself for a `@stream` field. `[]` is the document root.
   */
  readonly path: readonly string[];
  /** `fragment` for `@defer` (a spread or an inline fragment), `list` for `@stream`. */
  readonly kind: 'fragment' | 'list';
  /**
   * The `if:` argument as a serialized GraphQL value; absent means `true`. The server evaluates it,
   * and the runtime evaluates it too so a defer that the document switched off is never awaited.
   */
  readonly if?: GraphQLValue;
  /** `kind: 'fragment'` and the defer is on a named spread: the fragment the patch completes. */
  readonly fragment?: string;
  /** `kind: 'list'`: `@stream(initialCount: n)`, the literal or the default (0). */
  readonly initialCount?: number;
}

/** The delivery state of one `@defer`/`@stream` target on a result (§7.13). */
export type DeferredStatus = 'pending' | 'ready';

/** Per-label delivery state: `pending` until the patch that completes the target is merged. */
export type DeferredState = Readonly<Record<string, DeferredStatus>>;

/** One `@when(argument: "x")` / `@when_not(argument: "x")` condition on a spread. */
export interface WhenCondition {
  /** The variable the directive's `argument:` names. */
  readonly variable: string;
  /** `true` for `@when`, `false` for `@when_not`. */
  readonly polarity: boolean;
}

export interface DirectiveSpec {
  readonly name: string;
  readonly arguments: Readonly<Record<string, GraphQLValue>>;
}

/**
 * A serialized GraphQL value. Deliberately flatter than Houdini's value nodes: a `Variable` carries
 * its name as a string rather than a nested `{kind:'Name', value}` node (§14).
 */
export type GraphQLValue =
  | { readonly kind: 'Variable'; readonly name: string }
  | { readonly kind: 'IntValue' | 'FloatValue'; readonly value: string }
  | { readonly kind: 'StringValue' | 'EnumValue'; readonly value: string }
  | { readonly kind: 'BooleanValue'; readonly value: boolean }
  | { readonly kind: 'NullValue' }
  | { readonly kind: 'ListValue'; readonly values: readonly GraphQLValue[] }
  | { readonly kind: 'ObjectValue'; readonly fields: Readonly<Record<string, GraphQLValue>> };

/**
 * The incremental view of a deferred selection (§7.13), the shape graphql-codegen's `Incremental<T>`
 * has: the complete type, or a view in which every key but the fragment marker is optional.
 *
 * A generated `has<Label>(value: Incremental<T>): value is T & {…}` predicate accepts the view a read
 * produces while the patch is outstanding and narrows it to the loaded one. Flamme keeps
 * ` $fragments` required in the partial variant on purpose: the marker is written by the read that
 * wrote the parent record, so it exists before the deferred fields do — that is what lets
 * `useFragment` return `partial: true` instead of "no reference".
 */
export type Incremental<T> =
  | T
  | {
      [P in keyof T]?: P extends ' $fragments' | '__typename' ? T[P] : never;
    };

/**
 * The frame discriminant every generated composite carries: `undefined` on the loaded branch,
 * `true` on a loading frame. Type-level only; the runtime marks frames with its own non-enumerable
 * symbol (§8.7, `LOADING_FRAME`).
 */
export interface FrameKey {
  readonly ' $loadingFrame'?: undefined;
}

/** `@loading`. `value` replaces the field with a Pending sentinel; `continue` descends into it. */
export interface LoadingSpec {
  readonly kind: 'value' | 'continue';
  /** Present for list fields under `@loading(count: n)`: `count` placeholders at `depth` list levels. */
  readonly list?: { readonly depth: number; readonly count: number };
}

/** `@list(name:)`. */
export interface ListSpec {
  readonly name: string;
  /** `true` when the list field is a connection (edges/pageInfo) rather than a plain list. */
  readonly connection: boolean;
  /** The element type name. */
  readonly type: string;
  /**
   * `@includeListID` on the list-declaring field: the read stamps the opaque list id
   * `"<parentRecordId>::<listName>"` on the field's value as `__id`, so a mutation's
   * `@listID(value:)` can name exactly that list instance (§6.7).
   */
  readonly includeListID?: boolean;
}

/**
 * `@when` / `@when_not` on a list-operation spread (§6.7): the list filters the operation applies
 * under. Every entry is resolved against the **mutation's** variables and compared, by deep
 * equality, with the filter values the declaring field's own arguments resolved to at write time
 * (Houdini's `cache/lists.ts:524-553`). A filter the list never stored is `undefined`.
 */
export interface ListWhen {
  /** `@when(...)`: the list's stored filter must equal each entry. */
  readonly must?: Readonly<Record<string, GraphQLValue>>;
  /** `@when_not(...)`: the list's stored filter must equal none of them. */
  readonly mustNot?: Readonly<Record<string, GraphQLValue>>;
}

/** A cache mutation carried by a mutation payload for a `@list`. */
export interface ListOperation {
  readonly action: 'insert' | 'remove' | 'delete' | 'toggle' | 'modify' | 'upsert';
  readonly list: string;
  readonly position?: 'first' | 'last';
  /** `@allLists` sets `'all'`: the operation applies to every instance of the list name. */
  readonly target?: 'all' | 'single';
  readonly path?: readonly string[];
  /** `@when` / `@when_not`: the list filters the operation applies under. */
  readonly when?: ListWhen;
  /** `@listID(value:)`: an opaque list id `"<parentRecordId>::<listName>"`, literal or a variable. */
  readonly listID?: GraphQLValue;
}

/** `@paginate`. Attached to the paginated field; the artifact-level `refetch` is derived from it. */
export interface PaginationSpec {
  /** Field path from the artifact root to the connection field. */
  readonly path: readonly string[];
  readonly method: 'cursor' | 'offset';
  readonly mode: 'SinglePage' | 'Infinite';
  readonly pageSize: number;
  /** `true` when the paginated field is inside the document's own selection (a fragment). */
  readonly embedded: boolean;
  /** The type the page query is rooted at (`Query` for an operation, the owner type for a fragment). */
  readonly targetType: string;
  /** The paginated field's value type is a connection. */
  readonly paginated: boolean;
  readonly direction: 'forward' | 'backward' | 'both';
  readonly supportsForward: boolean;
  readonly supportsBackward: boolean;
  readonly cursorType?: string;
}

/** The projection the runtime's page handlers consume; generated from `PaginationSpec`. */
export interface RefetchSpec {
  readonly path: readonly string[];
  readonly method: 'cursor' | 'offset';
  readonly mode: 'SinglePage' | 'Infinite';
  readonly pageSize: number;
  readonly embedded: boolean;
  readonly targetType: string;
  readonly paginated: boolean;
  readonly direction: 'forward' | 'backward' | 'both';
}

/** Variables spec. `fields` maps a variable name to its GraphQL type string. */
export interface InputObject {
  readonly fields: Readonly<Record<string, string>>;
  /** Input object types reachable from the variables: type name → field name → type string. */
  readonly types: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Default values, already marshalled to plain JSON. */
  readonly defaults: Readonly<Record<string, unknown>>;
  /** `@__runtimeScalar` variable mappings (reserved; emitted empty in v1). */
  readonly runtimeScalars: Readonly<Record<string, string>>;
}

/** A normalized record id: `Type:id` (key fields joined by `__`) or `_ROOT_`. */
export type RecordId = string;
/** A document's variables, already marshalled from `$input`. */
export type Variables = Readonly<Record<string, unknown>>;
/** A fragment subscription key: `${RecordId}::${Artifact['hash']}` or `List:<name>::<hash>`. */
export type FragmentKey = string;

/**
 * The payload stored under one ` $fragments` entry. This object plus its key is the entire coupling
 * between a parent's data and a child's fragment read (D2).
 */
export interface FragmentReference {
  readonly parent: RecordId;
  readonly variables: Variables;
}

/**
 * The generated per-fragment alias for the payload above. A fragment's `$key` alias spells out one
 * member per spread so `defineProps<...>()` sees a plain object shape (D3, §8.9) and the emitted
 * literal is `FragmentReference` rather than a hand-written structural type.
 */
export type FragmentRef = FragmentReference;

/** The runtime shape of the marker key itself; `fragmentKey = ' $fragments'` (leading space). */
export type FragmentMarker = Readonly<Record<string, FragmentReference>>;
