/**
 * The native compiler binding (`crates/flamme-napi`).
 *
 * Two JSON-in/JSON-out entry points over one pipeline: `compile(requestJson)` takes
 * the discovered files with their text, and `compileProject(requestJson)` walks the
 * project itself. The module is loaded lazily and cached, so a package that never
 * compiles anything never touches the filesystem for it.
 *
 * There is one compiler. A missing built module is a failed run with an `FLM2002`
 * diagnostic naming the build command (`pnpm build:native`), never a different
 * compiler; nothing here throws on a missing file, so the caller reports it.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
// `URL` is imported, not taken from the global: a jsdom test environment replaces
// the global with one that resolves a relative path against `http://localhost`, and
// the binding path would come out as `undefined`.
import { fileURLToPath, URL } from 'node:url';

/** Where the built module lives, relative to this package. */
export const NATIVE_MODULE_FILE = 'native/flamme.node';

/** The shape of the built module. */
export interface NativeModule {
  /** The crate version. */
  version(): string;
  /** Compiles one project from the files the caller discovered and read. */
  compile(requestJson: string): string;
  /** Compiles one project by walking `projectDir` itself. */
  compileProject(requestJson: string): string;
}

/** Why the native module could not be loaded. */
export interface NativeLoadFailure {
  /** The path the loader tried. */
  readonly path: string;
  /** The thrown value's message. */
  readonly reason: string;
}

let loaded: NativeModule | undefined;
let failure: NativeLoadFailure | undefined;

/** The path the loader looks at, or the `FLAMME_NATIVE_PATH` override. */
export function nativeModulePath(): string {
  const override = process.env['FLAMME_NATIVE_PATH'];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return fileURLToPath(new URL(`../${NATIVE_MODULE_FILE}`, import.meta.url));
}

/** True when a loaded value has the binding's shape. */
function isNativeModule(value: unknown): value is NativeModule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate: { version?: unknown; compile?: unknown; compileProject?: unknown } = value;
  return (
    typeof candidate.version === 'function' &&
    typeof candidate.compile === 'function' &&
    typeof candidate.compileProject === 'function'
  );
}

/** Loads the native module once, returning `undefined` when it is not built. */
export function loadNativeModule(): NativeModule | undefined {
  if (loaded !== undefined || failure !== undefined) {
    return loaded;
  }
  const path = nativeModulePath();
  let value: unknown;
  try {
    const require = createRequire(import.meta.url);
    value = require(path);
  } catch (error) {
    failure = { path, reason: error instanceof Error ? error.message : String(error) };
    return undefined;
  }
  if (!isNativeModule(value)) {
    failure = { path, reason: 'the module does not export compile() and compileProject()' };
    return undefined;
  }
  loaded = value;
  return loaded;
}

/** The reason the last load failed, for the error message. */
export function nativeLoadFailure(): NativeLoadFailure | undefined {
  loadNativeModule();
  return failure;
}

/** True when the built module is present (does not load it). */
export function nativeModuleBuilt(): boolean {
  return loaded !== undefined || existsSync(nativeModulePath());
}

/**
 * The message explaining that the compiler cannot run.
 *
 * There is no fallback: the Rust compiler is the compiler, so a missing binding is a
 * failed run, not a different one.
 */
export function missingCompilerMessage(): string {
  const detail = nativeLoadFailure()?.reason ?? 'not built';
  return (
    `flamme: the Rust compiler is not available (${detail}). ` +
    'Run `pnpm build:native` (or `moon run core:native`) to build it.'
  );
}

/** Test seam: forget the cached load so a rebuilt module can be picked up. */
export function resetNativeModule(): void {
  loaded = undefined;
  failure = undefined;
}
