/**
 * The CLI's input/output seam. Commands never touch `process` directly: they
 * write through a {@link CliIo}, which tests replace with recording sinks.
 */

/** Everything a command needs from the outside world: a cwd and two line sinks. */
export interface CliIo {
  /** Directory the commands operate in. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Receives one line of normal output. Defaults to `process.stdout`. */
  readonly stdout?: (line: string) => void;
  /** Receives one line of error output. Defaults to `process.stderr`. */
  readonly stderr?: (line: string) => void;
}

/** {@link CliIo} with every field resolved; commands receive this, not `CliIo`. */
export interface ResolvedIo {
  /** Directory the commands operate in. */
  readonly cwd: string;
  /** Receives one line of normal output. */
  readonly stdout: (line: string) => void;
  /** Receives one line of error output. */
  readonly stderr: (line: string) => void;
}

/** Fills the gaps in a {@link CliIo} with `process.cwd()`, stdout and stderr. */
export function resolveIo(io: CliIo): ResolvedIo {
  return {
    cwd: io.cwd ?? process.cwd(),
    stdout:
      io.stdout ??
      ((line: string): void => {
        process.stdout.write(`${line}\n`);
      }),
    stderr:
      io.stderr ??
      ((line: string): void => {
        process.stderr.write(`${line}\n`);
      }),
  };
}
