/**
 * The narrowed plugin-context and config shapes the hooks actually use, so the
 * hooks can be unit-tested against plain objects with no casts and no full Vite
 * `PluginContext` stand-in.
 */

import type { AliasOptions, EnvironmentModuleNode } from 'vite';

/** The context members every hook may use to fail loudly. */
export interface ErrorContextLike {
  /** Prints a warning through Vite's logger. */
  warn(message: string): void;
  /** Fails the build with a clear message. */
  error(message: string): never;
}

/** The plugin-context members the transform hooks touch. */
export interface TransformContextLike extends ErrorContextLike {
  /** Registers a watched dependency of the current module. */
  addWatchFile(id: string): void;
}

/** The plugin-context members the plugin touches, for tests and the seam guard. */
export interface PluginContextLike extends TransformContextLike {
  /** Every module id in the build graph (Rollup only). */
  getModuleIds(): Iterable<string>;
}

/** The slice of `UserConfig` the `config` hook reads. */
export interface UserConfigLike {
  /** Project root, as the user configured it. */
  readonly root?: string;
  /** Resolution options, for the alias merge. */
  readonly resolve?: { readonly alias?: AliasOptions };
  /** Server options; read defensively for `watch.ignored`. */
  readonly server?: unknown;
}

/** The slice of `ResolvedConfig` the `configResolved` hook reads. */
export interface ResolvedConfigLike {
  /** Absolute project root. */
  readonly root: string;
  /** Whether Vite is building or serving. */
  readonly command: 'build' | 'serve';
  /** Production flag, recorded for the dev/build split. */
  readonly isProduction: boolean;
  /** The resolved plugin list, for the ordering check. */
  readonly plugins: readonly { readonly name: string }[];
  /** Vite's logger. */
  readonly logger: { warn(message: string): void; info(message: string): void };
}

/** A dev-server stand-in: only the members the HMR path uses. */
export interface DevServerLike {
  /** The chokidar watcher, kept for lifecycle wiring. */
  readonly watcher: { on(event: string, listener: (...args: never[]) => void): unknown };
  /**
   * Invalidates artifact modules after codegen. The node type is opaque here:
   * the plugin only hands back what the graph gave it.
   */
  readonly moduleGraph: {
    invalidateModule(module: unknown): void;
    getModulesByFile(file: string): ReadonlySet<unknown> | undefined;
  };
  /** Pushes HMR payloads to the browser. */
  readonly ws: { send(payload: unknown): void };
}

/** The hot-update event fields our handler reads; Vite's own options satisfy it. */
export interface HotUpdateLike {
  /** Watcher event type; `create` and `delete` are why `hotUpdate` is used at all. */
  readonly type: 'create' | 'update' | 'delete';
  /** Absolute path of the changed file. */
  readonly file: string;
  /** Event timestamp, for the own-write guard. */
  readonly timestamp: number;
  /** Reads the file's current content (stale-tolerant by contract). */
  read(): string | Promise<string>;
}

/** The raw-sourcemap shape both Vite and rolldown accept from a plugin. */
export interface RawSourceMapLike {
  /** Sourcemap format version. */
  readonly version: number;
  /** The file the map describes. */
  readonly file: string;
  /** VLQ mappings. */
  readonly mappings: string;
  /** Original identifier names. */
  readonly names: string[];
  /** Original sources. */
  readonly sources: string[];
  /** Original sources' contents. */
  readonly sourcesContent: (string | null)[];
}

/** One entry of the transform plugin's result. */
export type TransformOutput = { readonly code: string; readonly map: RawSourceMapLike | null } | null;

/** The `hotUpdate` return value Vite accepts. */
export type HotUpdateReturn = void | [] | EnvironmentModuleNode[];
