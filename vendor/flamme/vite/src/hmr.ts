/**
 * The `hotUpdate` pipeline (`spec/spec.md` §4.8): ownership filtering, the
 * 50 ms debounce with a pipeline lock, delete handling, module invalidation and
 * the two websocket payloads. Kept free of Vite internals so it can be driven
 * against a fake context.
 */

import { relative } from 'node:path';

import {
  DEFAULT_DOCUMENT_EXTENSIONS,
  hasDocumentExtension,
  matchesAny,
  toPosix,
} from '@flamme/core';

import { ARTIFACT_UPDATE_EVENT } from './names.js';

/** The three watcher event types `hotUpdate` reports. */
export type HmrEventType = 'create' | 'update' | 'delete';

/** One changed file. */
export interface HmrEvent {
  /** Absolute path of the changed file. */
  readonly file: string;
  /** What happened to it. */
  readonly type: HmrEventType;
}

/** An artifact whose content changed during one regeneration. */
export interface ChangedArtifact {
  /** Absolute path of the artifact module. */
  readonly path: string;
  /** Document name. */
  readonly name: string;
  /** Content hash, pushed to the client with the custom event. */
  readonly hash: string;
}

/** Ownership verdicts: `generated` is suppressed, `owned` is ours, `other` is ignored. */
export type Ownership = 'generated' | 'owned' | 'other';

/** Everything the HMR runner needs from the plugin. */
export interface HmrRunnerOptions {
  /** Absolute project root. */
  readonly projectDir: string;
  /** Absolute generated directory. */
  readonly runtimeDir: string;
  /** The config's `include` globs, for the document ownership rule. */
  readonly include: readonly string[];
  /** The document extensions in effect (`routing.documentExtensions`); the default pair without. */
  readonly documentExtensions?: readonly string[];
  /** Debounce window; 50 ms per §4.8 step 3. */
  readonly debounceMs?: number;
  /** Re-runs codegen and reports the artifacts whose content changed. */
  readonly regenerate: (files: readonly string[]) => Promise<readonly ChangedArtifact[]>;
  /** Reads a file for the `$flamme` ownership test. */
  readonly readFile: (file: string) => Promise<string | undefined>;
  /** True when the document store still has rows for the path. */
  readonly isKnownDocumentFile: (file: string) => boolean;
  /** True when the plugin wrote this file itself recently (§4.8 step 7). */
  readonly isOwnWrite: (file: string) => boolean;
  /** Drops the documents of deleted files before regeneration. */
  readonly onDelete: (files: readonly string[]) => void | Promise<void>;
  /** Invalidates the changed artifact modules. */
  readonly invalidate: (artifacts: readonly ChangedArtifact[]) => void;
  /** Sends an HMR payload to the client. */
  readonly send: (payload: unknown) => void;
  /** Timer hooks, injectable for tests. */
  readonly setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Timer hooks, injectable for tests. */
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
}

/** The runner the plugin delegates `hotUpdate` to. */
export interface HmrRunner {
  /** Classifies one file against the ownership rules. */
  ownership(file: string): Promise<Ownership>;
  /** Queues one watcher event behind the debounce. */
  enqueue(event: HmrEvent): void;
  /** Runs the pending batch now; resolves after the pipeline lock is free. */
  flush(): Promise<void>;
  /** Number of files waiting for the next batch. */
  readonly pending: number;
}

/** Creates the HMR runner (§4.8 steps 2-7). */
export function createHmrRunner(options: HmrRunnerOptions): HmrRunner {
  const debounceMs = options.debounceMs ?? 50;
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  const queue = new Map<string, HmrEvent['type']>();
  let handle: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const ownership = async (file: string): Promise<Ownership> => {
    const relativeFile = toPosix(relative(options.projectDir, file));
    const relativeRuntime = toPosix(relative(options.projectDir, options.runtimeDir));
    if (relativeFile === relativeRuntime || relativeFile.startsWith(`${relativeRuntime}/`)) {
      return 'generated';
    }
    const extensions = options.documentExtensions ?? DEFAULT_DOCUMENT_EXTENSIONS;
    if (hasDocumentExtension(file, extensions) && matchesAny(options.include, relativeFile)) {
      return 'owned';
    }
    if (options.isKnownDocumentFile(file)) {
      return 'owned';
    }
    const content = await options.readFile(file);
    return content !== undefined && content.includes('$flamme') ? 'owned' : 'other';
  };

  const runBatch = async (): Promise<void> => {
    const events = [...queue];
    queue.clear();
    if (events.length === 0) {
      return;
    }
    const deleted = events.filter(([, type]) => type === 'delete').map(([file]) => file);
    if (deleted.length > 0) {
      await options.onDelete(deleted);
    }
    const files = events.map(([file]) => file);
    const changed = await options.regenerate(files);
    if (changed.length === 0) {
      return;
    }
    options.invalidate(changed);
    const timestamp = options.now?.() ?? Date.now();
    options.send({
      type: 'update',
      updates: changed.map((artifact) => ({
        type: 'js-update',
        path: artifact.path,
        acceptedPath: artifact.path,
        timestamp,
      })),
    });
    options.send({
      type: 'custom',
      event: ARTIFACT_UPDATE_EVENT,
      data: {
        artifacts: changed.map((artifact) => ({
          name: artifact.name,
          hash: artifact.hash,
          path: artifact.path,
        })),
      },
    });
  };

  const schedule = (): void => {
    if (handle !== undefined) {
      clearTimer(handle);
    }
    handle = setTimer(() => {
      handle = undefined;
      chain = chain.then(runBatch);
    }, debounceMs);
  };

  return {
    ownership,
    enqueue(event) {
      if (options.isOwnWrite(event.file)) {
        return;
      }
      queue.set(event.file, event.type === 'delete' ? 'delete' : event.type);
      schedule();
    },
    async flush() {
      if (handle !== undefined) {
        clearTimer(handle);
        handle = undefined;
      }
      chain = chain.then(runBatch);
      await chain;
    },
    get pending() {
      return queue.size;
    },
  };
}
