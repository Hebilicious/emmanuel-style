/**
 * The pipeline lock `--watch` uses. Rebuilds are queued rather than run in
 * parallel, so two batches can never interleave their writes.
 */

/** Serializes asynchronous work: every task starts after the previous one settled. */
export interface PipelineLock {
  /** Runs `task` once every task enqueued before it has settled. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** Creates a {@link PipelineLock}; a rejected task does not block the queue. */
export function createPipelineLock(): PipelineLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task, task);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
