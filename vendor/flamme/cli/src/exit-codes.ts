/**
 * The process exit codes the CLI returns (`spec/spec.md` §10.5) and the message
 * the executable prints for each one.
 */

/**
 * Exit codes: `0` success · `1` compile errors · `2` config/usage error ·
 * `3` schema load failure · `4` internal error.
 */
export const EXIT_CODES = {
  /** Everything compiled; warnings are allowed. */
  success: 0,
  /** At least one `FLM1xxx` error diagnostic. */
  compileError: 1,
  /** A missing or invalid config file, or an unusable command line. */
  configError: 2,
  /** The GraphQL schema could not be loaded (`FLM2002`). */
  schemaError: 3,
  /** A bug in the CLI: the only code for which a stack trace is printed. */
  internalError: 4,
} as const;

/** One of the values in {@link EXIT_CODES}. */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** One-line message per exit code, printed by the executable's shim. */
const EXIT_MESSAGES: Readonly<Record<ExitCode, string>> = {
  0: 'flamme: ok',
  1: 'flamme: compile error',
  2: 'flamme: config or usage error',
  3: 'flamme: schema load failure',
  4: 'flamme: internal error',
};

/** The message that names an exit code, for the `bin.ts` shim. */
export function exitMessage(code: ExitCode): string {
  return EXIT_MESSAGES[code];
}
