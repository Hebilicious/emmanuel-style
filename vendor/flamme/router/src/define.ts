/**
 * The runtime half of filesystem routing (REQ-1, REQ-3): what the generated `$flamme/routes` module
 * and `@flamme/router/auto` call.
 *
 * The generated module is a **flat** list of {@link FlammeRoute} records with a `parent` name, so it
 * stays a pure data table. `defineFlammeRoutes` nests that list for vue-router and materialises each
 * record's loaders against the app's client, which is the step that fills `meta.loaders` and turns
 * the generator's `{ artifact, params }` plan into a real {@link RouteQueryLoader}.
 */

import { defineAsyncComponent, defineComponent, h, ref, type Ref } from 'vue';

import { stableStringify } from '@flamme/runtime';
import type {
  Artifact,
  ArtifactData,
  ArtifactInput,
  Client,
  QueryOptions,
  QueryResult,
} from '@flamme/runtime';
import type { RouteLocation, RouteRecordRaw } from 'vue-router';

import { queryLoader, type RouteQueryLoader } from './loader.js';
import { resolveRouteVariables, type RouteParamSource } from './variables.js';

/** The `meta.loaders` payload a generated route carries: one factory per document. */
export interface FlammeLoaderDefinition {
  /** Builds the loader for one client. Called once per route, at router-creation time. */
  readonly load: (client: Client) => RouteQueryLoader<unknown>;
}

/** The `meta` a generated record carries: its kind and its materialised loaders. */
export interface FlammeRouteMeta {
  /** `'page'` or `'layout'`; `usePageQuery` only ever returns a page's loader. */
  readonly flamme: 'page' | 'layout';
  /** The loaders the navigation guard runs, filled in by {@link defineFlammeRoutes}. */
  readonly loaders: readonly RouteQueryLoader<unknown>[];
  /**
   * `true` when `meta.loaders` holds a composed loader: the record's own document loader was moved
   * to `pageLoaders` and the composed one is what the navigation runs. Observability only.
   */
  readonly composed?: boolean;
}

/**
 * One generated route record: a vue-router `RouteRecordRaw` plus the two generator conventions,
 * `parent` and `loaders`. Both are consumed by {@link defineFlammeRoutes} and neither reaches
 * vue-router.
 */
export interface FlammeRoute {
  /** Unique name; also the key of the generated `pages` map. */
  readonly name: string;
  /** Absolute path (`/:id`, `/teams/:teamId`), or `''` for a pathless child (a route group). */
  readonly path: string;
  /**
   * The path **relative to `parent`**, for a nested record: `''` when the record renders the
   * parent's own URL (a page on its layout's path, a route group, a catch-all that owns its
   * directory's URL), and the tail otherwise (`settings`, `:pathMatch(.*)*`,
   * `admin/:pathMatch(.*)*` for a catch-all whose directory has no record).
   *
   * vue-router always reads a child's `path` against its parent's, so this is the field
   * {@link defineFlammeRoutes} nests by; {@link path} stays the absolute URL for every consumer
   * that only wants to know where a record lives. Hand-written records may leave it out and declare
   * the child spelling in `path` itself, as they always have.
   */
  readonly segment?: string | undefined;
  /**
   * The component to render.
   *
   * A generated record always carries one. A hand-written **redirect** record carries none, because
   * vue-router resolves the redirect before anything renders; vue-router's own record type has the
   * same two shapes.
   */
  readonly component?: NonNullable<RouteRecordRaw['component']> | undefined;
  /** The name of the record this one nests under; `undefined` at the top level. */
  readonly parent?: string | undefined;
  /** The route's param names, for the generated `pages` map and for tests. */
  readonly params?: readonly string[] | undefined;
  /** The record's kind and its loader factories. */
  readonly meta: {
    /** `'page'` or `'layout'`. */
    readonly flamme: 'page' | 'layout';
  };
  /**
   * A pathless layout's redirect to its own index page, or a hand-written record's redirect to the
   * route it stands in for. Any vue-router redirect value: a path string, a location object, or a
   * function of the target location.
   */
  readonly redirect?: RouteRecordRaw['redirect'] | undefined;
  /**
   * The layout the record renders itself, for a page whose nearest ancestor layout has no record of
   * its own (a pathless `+layout.vue` with no page it owns). `defineFlammeRoutes` composes it around
   * the component with `h(layout, null, { default: () => h(component) })`.
   */
  readonly layout?: NonNullable<RouteRecordRaw['component']> | undefined;
  /** The loader factories, in declaration order. */
  readonly loaders?: readonly FlammeLoaderDefinition[] | undefined;
  /**
   * The participant document names of this record's composed document, in chain order;
   * `undefined` when the record does not compose (`research/route-composition-design.md` §4.3).
   *
   * The generated `load:` closure already closes over the chain, so this is what
   * {@link defineFlammeRoutes} reads to set `meta.composed`.
   */
  readonly composedChain?: readonly string[] | undefined;
  /**
   * The loader factories the record keeps but the navigation guard must not run. The generator never
   * emits this; a test uses it to mount a page on a cold cache and watch the page's own read fill in
   * (`research/routing-report.md`, behaviour 6). `defineFlammeRoutes` materialises it into
   * `meta.pageLoaders`, which `usePageQuery()` reads before `meta.loaders`.
   */
  readonly unattachedLoaders?: readonly FlammeLoaderDefinition[] | undefined;
}

/** A page's query as a route loader: the loader itself, bound to one client. */
export type PageLoader = RouteQueryLoader<unknown>;

/**
 * Materialises one generated loader definition: a `queryLoader` whose variables come from the
 * route's params, coerced by the document's own variable types.
 *
 * ```ts
 * // what the generated module writes, once per document a page declares
 * createPageLoader(client, Info, [{ variable: 'id', param: 'id', coercion: 'int' }])
 * // `routing.loaders: 'background'`: the page renders its own pending state while the read is on
 * // the wire (the policy slot is unused here, so `undefined` holds its place)
 * createPageLoader(client, Info, [{ variable: 'id', param: 'id', coercion: 'int' }], undefined, true)
 * ```
 *
 * The loader carries {@link RouteQueryDefinition}, so a page renders exactly the same read through
 * `usePageQuery()` without naming the document (REQ-1).
 */
export function createPageLoader<A extends Artifact<'query'>>(
  client: Client,
  artifact: A,
  params: readonly RouteParamSource[],
  policy?: Parameters<typeof queryLoader<A>>[0]['policy'],
  background?: boolean,
): RouteQueryLoader<ArtifactData<A>> {
  return queryLoader<A>({
    client: deduped(client),
    artifact,
    variables: (route: RouteLocation) => routeVariables<A>(params, route),
    ...(policy === undefined ? {} : { policy }),
    ...(background === undefined ? {} : { background }),
  });
}

/**
 * A route's **composed** loader: one request for the record's whole chain
 * (`research/route-composition-design.md` §3.1).
 *
 * It is {@link createPageLoader} plus two things: the composed artifact it runs (one query over the
 * record's own document and every ancestor record's), and the longest-chain arbitration below.
 * Everything else - the cache subscription, the first-payload settle for `@defer`, the error
 * mapping - is inherited from `queryLoader`, so the guard, `useRouteQuery` and `usePageQuery` treat
 * it as an ordinary loader.
 *
 * ```ts
 * // what the generated module writes for a composed record
 * createComposedPageLoader(client, RouteSpecies_id_1a2b3c, [...], ['Chrome', 'Species'])
 * // a background route: the guard commits the navigation and the page renders its pending state
 * createComposedPageLoader(client, RouteSpecies_id_1a2b3c, [...], ['Chrome', 'Species'], true)
 * ```
 */
export function createComposedPageLoader<A extends Artifact<'query'>>(
  client: Client,
  artifact: A,
  params: readonly RouteParamSource[],
  chain: readonly string[],
  background?: boolean,
): RouteQueryLoader<ArtifactData<A>> {
  const shared = deduped(client);
  /** The route the arbitration last claimed on, so the request can mark the same navigation. */
  let claimed: RouteLocation | undefined;
  // Every request this loader issues is marked on the navigation's claim while it is open. A read of
  // one of the record's own documents (what `usePageQuery()` renders) consults that mark: while the
  // composed request is still streaming its `@defer` patches the cache read is partial, and fetching
  // the participant document at that moment is a second request for data already on its way.
  const tracked: Client = new Proxy(shared, {
    get(target, property, receiver): unknown {
      if (property !== 'query') {
        return Reflect.get(target, property, receiver);
      }
      return (
        requestArtifact: Artifact<'query'>,
        options: QueryOptions = {},
      ): Promise<QueryResult> => {
        const meta = claimed?.meta;
        markComposed(meta, chain, 1);
        return target.query(requestArtifact, options).finally(() => {
          markComposed(meta, chain, -1);
        });
      };
    },
  });
  return queryLoader<A>({
    client: tracked,
    artifact,
    variables: (route: RouteLocation) => routeVariables<A>(params, route),
    ...(background === undefined ? {} : { background }),
    claim: (route: RouteLocation) => {
      claimed = route;
      return claimLongest(route, chain);
    },
  });
}

/**
 * The key the longest-chain arbitration writes on the navigation's merged `meta`.
 *
 * A symbol, so it can never collide with a record's own meta; `route.meta` is a fresh merged object
 * per navigation, which is exactly why the loader plugin itself keeps its loader set there.
 */
const COMPOSED_CLAIM: unique symbol = Symbol.for('flamme.composedClaim');

/** What one navigation's arbitration holds: the winning chain and the requests it has open. */
interface ComposedClaim {
  readonly chain: readonly string[];
  /** `ref`, so a reader that suppresses its own request re-evaluates when the request settles. */
  readonly pending: Ref<number>;
}

/** The claim on one `meta`, or `undefined` when no composed loader registered on it. */
function claimOf(meta: unknown): ComposedClaim | undefined {
  if (typeof meta !== 'object' || meta === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(meta, COMPOSED_CLAIM);
  return isComposedClaim(value) ? value : undefined;
}

/** `true` for the object this module writes under {@link COMPOSED_CLAIM}. */
function isComposedClaim(value: unknown): value is ComposedClaim {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(Reflect.get(value, 'chain')) &&
    typeof Reflect.get(value, 'pending') === 'object'
  );
}

/**
 * `true` while the navigation's composed request is still open.
 *
 * `usePageQuery()` reads it to keep a record's own document read from issuing its own request while
 * the composed one is streaming: the composed write is a superset of that read, so there is nothing
 * for a second request to fetch, and once the composed request settles the mark drops and the read
 * fetches only if the cache really cannot answer it.
 */
export function composedRequestInFlight(route: RouteLocation): boolean {
  return (claimOf(route.meta)?.pending.value ?? 0) > 0;
}

/** Adds `delta` to the open-request count of one navigation's claim. */
function markComposed(meta: unknown, chain: readonly string[], delta: number): void {
  const claim = claimOf(meta);
  if (claim === undefined || claim.chain !== chain) {
    return;
  }
  claim.pending.value = Math.max(0, claim.pending.value + delta);
}

/**
 * Registers this loader's chain on the navigation and reports whether it owns the request.
 *
 * vue-router unions the loader sets of **every** matched record into one navigation set and starts
 * them all, so a two-level navigation would otherwise run the layout's composed loader and the
 * page's: two composed requests whose chains are nested. The register is a synchronous write, and
 * the single microtask yield is what lets every sibling register in the same tick before anyone
 * decides: `Promise.all(loaders.map(...))` invokes every loader body synchronously in matched
 * order, so after the yield the deepest chain is the one the meta holds.
 *
 * The owner is the longest chain because a record's chain is its ancestors' plus its own documents,
 * so the deepest matched record's composition is a superset of every other matched record's: one
 * request carries every matched record's fields. A tie (two records that resolve to the same
 * participant documents) is won by the later registration, which is the deeper record, and the
 * loser sends nothing and returns its own cache view.
 */
function claimLongest(route: RouteLocation, chain: readonly string[]): Promise<boolean> {
  const meta: unknown = route.meta;
  if (typeof meta === 'object' && meta !== null) {
    const existing = claimOf(meta);
    if (existing === undefined || chain.length >= existing.chain.length) {
      Reflect.set(meta, COMPOSED_CLAIM, { chain, pending: ref(0) } satisfies ComposedClaim);
    }
  }
  return Promise.resolve().then(() => claimOf(meta)?.chain === chain);
}

/**
 * The variables of one navigation, re-typed as the artifact's own input.
 *
 * The resolver works in `Variables` (the runtime's `Readonly<Record<string, unknown>>`) because the
 * param names and the document's variables are only known at generation time; the phantom
 * `ArtifactInput<A>` is what `queryLoader` wants back, and the generator guarantees the keys are the
 * document's own.
 */
function routeVariables<A extends Artifact<'query'>>(
  params: readonly RouteParamSource[],
  route: RouteLocation,
): ArtifactInput<A> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a generated param list names the document's own variables, which the phantom type carries
  return resolveRouteVariables(params, route.params) as ArtifactInput<A>;
}

/** One deduped view per real client, shared by every loader generated for that client. */
const dedupedClients = new WeakMap<Client, Client>();

/**
 * A client whose `query` shares an in-flight call with an identical one.
 *
 * `Client.query` is a one-shot: it opens a lifecycle, waits for the result and disposes it, so two
 * overlapping calls for the same `(document, variables)` are two wire requests. vue-router's
 * navigation guard can ask the same loader twice for one navigation (`setupLoaderGuard` unions each
 * matched record's loader set into the target's set, and `record.meta[LOADER_SET_KEY]` keeps what a
 * previous navigation put there, `dist/navigation-guard-*.js`), so the second call would be a second
 * request for data the first is already fetching. This wrapper keys by the artifact hash and the
 * resolved variables, so the duplicate joins the first call.
 *
 * The table is per client and an entry is dropped as soon as its call settles: a later navigation
 * with the same variables is the cache's decision, which is what keeps back and forward free while
 * `CacheAndNetwork` can still refetch.
 */
function deduped(client: Client): Client {
  const existing = dedupedClients.get(client);
  if (existing !== undefined) {
    return existing;
  }
  const pending = new Map<string, Promise<QueryResult>>();
  const view = new Proxy(client, {
    get(target, property, receiver): unknown {
      if (property !== 'query') {
        return Reflect.get(target, property, receiver);
      }
      return (artifact: Artifact<'query'>, options: QueryOptions = {}): Promise<QueryResult> => {
        const key = `${artifact.hash}::${stableStringify(options.variables ?? {})}`;
        const shared = pending.get(key);
        if (shared !== undefined) {
          return shared;
        }
        const call = target.query(artifact, options).finally(() => {
          pending.delete(key);
        });
        pending.set(key, call);
        return call;
      };
    },
  });
  dedupedClients.set(client, view);
  return view;
}

/**
 * One own-document loader, paused while its record's composed request is still open.
 *
 * The pause is the loader's own `enabled` predicate, so it applies to every path that runs the
 * loader (a component reading it through `usePageQuery()`, a `useRouteQuery(loader)` handle), and it
 * clears as soon as the composed request settles: the read then fetches only if the cache still
 * cannot answer it.
 */
function pauseWhileComposed(
  client: Client,
  loader: RouteQueryLoader<unknown>,
): RouteQueryLoader<unknown> {
  return queryLoader({
    client: deduped(client),
    artifact: loader.artifact,
    variables: (route: RouteLocation) => loader.variables(route),
    enabled: (route: RouteLocation) => !composedRequestInFlight(route),
    // The pause changes *whether* this read sends, never how the navigation treats it: a background
    // document loader stays background, so the page's handle still reports `fetching` while the
    // composed request that carries its fields is open.
    ...(loader.background ? { background: true } : {}),
  });
}

/** One route record and the records nested under it, as {@link defineFlammeRoutes} builds them. */
interface Nested {
  readonly record: RouteRecordRaw;
  readonly children: Nested[];
}

/**
 * Nests a flat generated route table for vue-router and binds every loader to `client`.
 *
 * A `parent` that names no record is a generator bug, not a user error, so it throws: silently
 * dropping the record would ship a route the app cannot reach. A `parent` chain that closes on
 * itself is reported for the same reason: no record in the cycle is a root, so nesting it would
 * install none of them (`FLM4019`).
 *
 * ```ts
 * const routes = defineFlammeRoutes(generated, client) // -> RouteRecordRaw[]
 * ```
 */
export function defineFlammeRoutes(
  routes: readonly FlammeRoute[],
  client?: Client,
): RouteRecordRaw[] {
  const byName = new Map<string, FlammeRoute>();
  for (const route of routes) {
    byName.set(route.name, route);
  }
  for (const route of routes) {
    if (route.parent !== undefined && !byName.has(route.parent)) {
      throw new Error(
        `The generated route "${route.name}" nests under "${route.parent}", which does not exist ` +
          '(FLM4012). Re-run `flamme generate`; the generated tree is stale or hand-edited.',
      );
    }
  }
  rejectParentCycles(routes, byName);

  const childrenOf = new Map<string | undefined, FlammeRoute[]>();
  for (const route of routes) {
    const list = childrenOf.get(route.parent) ?? [];
    list.push(route);
    childrenOf.set(route.parent, list);
  }

  const build = (route: FlammeRoute, isNested: boolean): Nested => {
    const childRecords = (childrenOf.get(route.name) ?? []).map((child) => build(child, true));
    // Each definition is materialised exactly once, so a record's loaders are the navigation
    // guard's list and the instances a component reads, which is what keeps one request per
    // document.
    const materialise = (
      definitions: readonly FlammeLoaderDefinition[] | undefined,
    ): RouteQueryLoader<unknown>[] =>
      client === undefined ? [] : (definitions ?? []).map((definition) => definition.load(client));
    const loaders = materialise(route.loaders);
    // A page may carry its own layout (a pathless `+layout.vue` that owns no page): the layout is
    // composed around the page here, so the record keeps one component and the layout still wraps
    // the page's `<router-view>` position.
    //
    // The composition is a real component object, not a bare arrow function: vue-router treats any
    // function without `displayName`/`props` as a **lazy** component and calls it for a promise, so
    // a functional wrapper would be mistaken for one more dynamic import. Each side is resolved to
    // a component once, here, so a re-render does not create a new async component (which would
    // remount the subtree).
    const component =
      route.component === undefined || route.layout === undefined
        ? route.component
        : composeLayout(route.component, route.layout);
    // A composed record's own document loaders are what `usePageQuery()` renders, and they must not
    // issue their own request while the composed request is still open: the composed write carries
    // their fields, and during a `@defer` stream their cache read is partial, which would make
    // `CacheOrNetwork` fetch a second time (`research/route-composition-design.md` §3.3). The loader
    // is rebuilt with that pause, and nothing else about it changes: same artifact, same variables,
    // same policy, same `refetch()`/`loadNextPage()` surface.
    const unattached = materialise(route.unattachedLoaders).map((loader) =>
      client === undefined || route.composedChain === undefined
        ? loader
        : pauseWhileComposed(client, loader),
    );
    const meta = {
      flamme: route.meta.flamme,
      loaders,
      ...(client === undefined || route.unattachedLoaders === undefined
        ? {}
        : { pageLoaders: unattached }),
      ...(route.composedChain === undefined ? {} : { composed: true }),
    };
    const children = childRecords.map((child) => child.record);
    const record = routeRecord(route, component, meta, children, isNested);
    return { record, children: childRecords };
  };

  return (childrenOf.get(undefined) ?? []).map((route) => build(route, false).record);
}

/**
 * Rejects a `parent` chain that closes on itself (`FLM4019`).
 *
 * Every record in a cycle nests under another record in it, so the cycle has no root and the
 * nesting pass installs none of its members: without this check the router comes up missing those
 * routes and says nothing. Each walk follows `parent` links until it reaches a root or repeats a
 * name; the repeated segment is the cycle the message names.
 *
 * The walk runs after the missing-`parent` pass, so a link always resolves to a record or ends the
 * chain, and the only way a walk does not end at a root is a cycle.
 */
function rejectParentCycles(
  routes: readonly FlammeRoute[],
  byName: ReadonlyMap<string, FlammeRoute>,
): void {
  for (const route of routes) {
    const chain: string[] = [];
    const at = new Map<string, number>();
    let current: string | undefined = route.name;
    while (current !== undefined) {
      const seen = at.get(current);
      if (seen !== undefined) {
        const cycle = [...chain.slice(seen), current];
        throw new Error(
          `The route parent chain ${cycle.map((name) => `"${name}"`).join(' -> ')} is a cycle ` +
            '(FLM4019). A record in the cycle nests under another record in it, so the cycle has ' +
            'no root record and vue-router would install none of them: every route in the cycle ' +
            'would be unreachable. Drop or change one of their `parent` fields.',
        );
      }
      at.set(current, chain.length);
      chain.push(current);
      current = byName.get(current)?.parent;
    }
  }
}

/**
 * One vue-router record from one {@link FlammeRoute}.
 *
 * vue-router's record union is checked per variant, and a record that carries both a `component` and
 * a `redirect` only fits its "single view with children" variant, so the shapes are built in their
 * own branch rather than by spreading possibly-undefined fields into one literal. A record with no
 * component and no redirect is a grouping record: vue-router renders its children through the
 * nearest `<router-view>` without a view of its own.
 */
function routeRecord(
  route: FlammeRoute,
  component: FlammeRoute['component'],
  meta: NonNullable<RouteRecordRaw['meta']>,
  children: readonly RouteRecordRaw[],
  isNested: boolean,
): RouteRecordRaw {
  // vue-router reads a child's `path` against its parent's, so a generated record nests by its
  // `segment` (the path its planner computed relative to its parent); `path` stays the absolute URL.
  // A hand-written record that declares no `segment` keeps its `path` as the child spelling. The
  // test is `undefined` and not falsiness: `''` is the pathless child, and falling back to the
  // absolute `path` there would install a second record on the parent's own URL.
  //
  // `segment` is only a *nested* spelling. A record the table hands to vue-router as a root (its
  // parent is absent, which is what a caller that filters the table produces) keeps its absolute
  // `path`: a root path has to start with `/`, and a segment like `:id?` makes vue-router reject the
  // whole table.
  const base = {
    name: route.name,
    path: isNested && route.segment !== undefined ? route.segment : route.path,
    meta,
  };
  const nested = children.length === 0 ? {} : { children: [...children] };
  if (component === undefined) {
    return route.redirect === undefined
      ? { ...base, children: [...children] }
      : { ...base, redirect: route.redirect, ...nested };
  }
  return route.redirect === undefined
    ? { ...base, component, ...nested }
    : { ...base, component, redirect: route.redirect, children: [...children] };
}

/**
 * A route component as something `h()` can render.
 *
 * The generated table hands every record a **lazy** component (`() => import('...')`), which
 * vue-router resolves itself but `h()` does not: it would call the loader as a functional component
 * and render the promise. `defineAsyncComponent` is what turns the loader back into a component, and
 * it is applied only to a raw loader — a function of no arguments that is not already an async
 * component (`__asyncLoader`). An eagerly imported SFC is an object and passes through untouched.
 */
function renderable(
  component: NonNullable<RouteRecordRaw['component']>,
): NonNullable<RouteRecordRaw['component']> {
  if (typeof component !== 'function' || '__asyncLoader' in component || component.length > 0) {
    return component;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a zero-argument function that is not an async component is the generated `() => import(...)` loader
  const loader = component as unknown as () => Promise<{
    readonly default: NonNullable<RouteRecordRaw['component']>;
  }>;
  // `defineAsyncComponent` unwraps the module the loader resolves, which is the component the
  // record declared, so its return already satisfies the record's field type.
  return defineAsyncComponent(loader);
}

/**
 * The one component a page renders when it carries its own layout: the layout with the page in its
 * default slot, both resolved from whatever the generated table imported.
 */
function composeLayout(
  page: NonNullable<RouteRecordRaw['component']>,
  layout: NonNullable<RouteRecordRaw['component']>,
): NonNullable<RouteRecordRaw['component']> {
  const resolvedLayout = renderable(layout);
  const resolvedPage = renderable(page);
  return defineComponent({
    name: 'FlammeComposedLayout',
    setup() {
      return () => h(resolvedLayout, null, { default: () => h(resolvedPage) });
    },
  });
}
