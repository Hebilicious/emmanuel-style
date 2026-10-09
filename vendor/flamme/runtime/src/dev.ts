/**
 * Developer-facing diagnostics (§12.1, §12.2).
 *
 * The runtime is framework-agnostic and has no `node` types, so the environment is read through a
 * structural carrier. Warnings are DEV-only: they name the concrete misuse and never throw, because
 * every one of them has a defined degrade path (an unknown list still writes its payload, and so on).
 */

/** `true` when the process reports a production build. */
export function isProduction(): boolean {
  const carrier: RuntimeEnvCarrier = globalThis;
  return carrier.process?.env?.['NODE_ENV'] === 'production';
}

/** Logs one developer-facing warning outside production; a no-op in a production build. */
export function devWarn(message: string, hint?: string): void {
  if (isProduction()) {
    return;
  }
  const carrier: ConsoleCarrier = globalThis;
  if (carrier.console === undefined) {
    return;
  }
  carrier.console.warn(hint === undefined ? message : `${message} ${hint}`);
}

/** A structural view of the global object (see `cache/keys.ts` for the same pattern). */
interface RuntimeEnvCarrier {
  readonly Object: unknown;
  readonly console?: { warn(message: string): void };
  readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> };
}

interface ConsoleCarrier {
  readonly console?: { warn(message: string): void };
}
