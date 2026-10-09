/**
 * Broken-pipe tolerance for the executable (A5): `flamme generate | head -1`
 * closes stdout while the CLI is still listing files. Node turns the failed
 * write into an `error` event on the stream, and with no listener that is an
 * uncaught exception (exit 1 with a stack) on an otherwise successful
 * generation. A consumer that goes away is a normal way for a pipeline to end,
 * so `EPIPE` is swallowed; every other stream error is rethrown unchanged.
 */

/** The `error` code a write to a pipe whose reader went away reports. */
const BROKEN_PIPE = 'EPIPE';

/** The slice of a writable stream {@link ignoreBrokenPipes} needs. */
export interface PipeStream {
  /** Registers an `error` listener. */
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/** True when `error` is the `EPIPE` a closed output pipe produces. */
export function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === BROKEN_PIPE
  );
}

/**
 * Makes `streams` (the process's stdout and stderr by default) tolerate a
 * consumer that exits early. Non-`EPIPE` errors keep their normal behaviour and
 * still crash the process, because they are real failures.
 */
export function ignoreBrokenPipes(
  streams: readonly PipeStream[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    stream.on('error', (error: unknown) => {
      if (!isBrokenPipe(error)) {
        throw error;
      }
    });
  }
}
