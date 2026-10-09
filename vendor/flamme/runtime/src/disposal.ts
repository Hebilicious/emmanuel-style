/**
 * The disposal stack (§5.7).
 *
 * Three owners: the client (app/request scope), each `DocumentStore`, and the cache. Registration
 * is LIFO so dependents unwind before their dependencies, `dispose()` is idempotent and runs every
 * entry exactly once, and the first error is retained and rethrown after the whole stack has run.
 */
export class DisposalStack {
  readonly #entries: (() => void)[] = [];
  #disposed = false;
  #error: unknown;

  /**
   * Registers one disposable. A push after `dispose()` runs the disposable immediately instead of
   * dropping it, so a late registration can never leak.
   */
  push(dispose: () => void): void {
    if (this.#disposed) {
      dispose();
      return;
    }
    this.#entries.push(dispose);
  }

  /** Runs every entry in LIFO order, each at most once, then rethrows the first error it saw. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    while (this.#entries.length > 0) {
      const entry = this.#entries.pop();
      if (entry === undefined) {
        continue;
      }
      try {
        entry();
      } catch (error) {
        this.#error ??= error;
      }
    }
    if (this.#error !== undefined) {
      const error = this.#error;
      this.#error = undefined;
      throw error;
    }
  }

  /** How many entries are still registered. */
  get size(): number {
    return this.#entries.length;
  }
}
