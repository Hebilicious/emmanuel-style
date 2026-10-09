/**
 * `FLM2004` — the SFC-analyzer / Vize-seam failure (`spec/spec.md` §10.3, §12.1).
 * Thrown by the Vite plugin when a document surface cannot be served, so a
 * `<gql>` block can never vanish silently.
 */
export class VizeSeamError extends Error {
  /** The taxonomy code, a literal so tests assert codes and not messages. */
  readonly code = 'FLM2004' as const;

  /** One line naming the concrete fix. */
  readonly hint: string | undefined;

  constructor(message: string, options: { readonly hint?: string; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VizeSeamError';
    this.hint = options.hint;
  }

  /** The one-line error form the CLI and the Vite overlay print. */
  format(): string {
    return this.hint === undefined
      ? `${this.code}  ${this.message}`
      : `${this.code}  ${this.message}\n${this.hint}`;
  }
}
