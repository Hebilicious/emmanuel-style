/**
 * A recursive directory watcher with debouncing, built on `node:fs.watch` and
 * nothing else. `--watch` uses it to re-run the codegen pipeline after a burst of
 * changes, never in the middle of the previous run.
 */

import { watch } from 'node:fs';

/** Default debounce window; the Vite plugin uses the same 50 ms. */
export const WATCH_DEBOUNCE_MS = 50;

/** One watcher subscription. */
export interface WatchHandle {
  /** Stops the underlying watcher. Safe to call more than once. */
  close(): void;
}

/** Creates the underlying watcher; injectable so tests can drive events by hand. */
export type WatchFactory = (
  directory: string,
  listener: (filename: string | null) => void,
) => WatchHandle;

/** Options for {@link watchDirectory}. */
export interface WatchOptions {
  /** Directory watched recursively. */
  readonly directory: string;
  /**
   * Handles one debounced batch of changed project-relative posix paths. The
   * batch is empty when the event carried no filename, which means "rebuild
   * everything".
   */
  readonly onChange: (files: readonly string[]) => void | Promise<void>;
  /** Debounce window in milliseconds. Defaults to {@link WATCH_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** Returns `true` for paths that must not trigger a rebuild. */
  readonly ignore?: (relativePath: string) => boolean;
  /** Closes the watcher when aborted. */
  readonly signal?: AbortSignal | undefined;
  /** Watcher factory. Defaults to `fs.watch(directory, { recursive: true })`. */
  readonly createWatcher?: WatchFactory;
}

/** A running watcher. */
export interface WatchSession {
  /**
   * Settles once the session is closed and the last batch has settled; rejects
   * when that batch's `onChange` rejected (a later batch that succeeded wins).
   */
  readonly closed: Promise<void>;
  /** Stops watching. Idempotent. */
  close(): void;
}

/** The default factory: `fs.watch` with recursive watching. */
function createFsWatcher(
  directory: string,
  listener: (filename: string | null) => void,
): WatchHandle {
  const watcher = watch(
    directory,
    { recursive: true, persistent: true },
    (_eventType, filename) => {
      listener(filename);
    },
  );
  return {
    close: () => {
      watcher.close();
    },
  };
}

/** A do-nothing function, used until a promise resolver is installed. */
function noop(): void {
  // Intentionally empty.
}

/** Watches `directory` recursively and reports debounced batches to `onChange`. */
export function watchDirectory(options: WatchOptions): WatchSession {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const createWatcher = options.createWatcher ?? createFsWatcher;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let work: Promise<void> = Promise.resolve();
  let resolveClosed: () => void = noop;
  let rejectClosed: (error: unknown) => void = noop;
  const closedPromise = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = undefined;
    handle.close();
    options.signal?.removeEventListener('abort', close);
    work.then(resolveClosed, rejectClosed);
  };

  const flush = (): void => {
    timer = undefined;
    const files = [...pending].toSorted();
    pending.clear();
    // The batch runs after the previous one settled; a rejected batch is
    // reported through `closed`, and must not stall the queue or surface as an
    // unhandled rejection in the meantime.
    work = work.then(
      () => options.onChange(files),
      () => options.onChange(files),
    );
    void work.catch(() => undefined);
  };

  const onEvent = (filename: string | null): void => {
    if (closed) {
      return;
    }
    if (filename !== null) {
      const relative = filename.split('\\').join('/');
      if (options.ignore?.(relative) === true) {
        return;
      }
      pending.add(relative);
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, debounceMs);
  };

  const handle = createWatcher(options.directory, onEvent);
  if (options.signal?.aborted === true) {
    close();
  } else {
    options.signal?.addEventListener('abort', close, { once: true });
  }
  return { closed: closedPromise, close };
}
