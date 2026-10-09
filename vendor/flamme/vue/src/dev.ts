/**
 * The dev-only warnings the Vue layer owes (§8.4 FLM4002, §8.6 FLM3004, §8.10 detached use).
 *
 * Each site warns once per key: a component tree can call the same composable hundreds of times, and
 * a warning per call is noise, not information. Production builds skip the call entirely.
 */

/** The keys already warned about, so one misconfiguration logs one line. */
const warned = new Set<string>();

/** `true` unless the bundler replaced the environment with a production one. */
function isDev(): boolean {
  const meta = import.meta as ImportMeta & { readonly env?: { readonly DEV?: boolean } };
  return meta.env?.DEV ?? true;
}

/** Logs `message` once per `key`, in dev only. */
export function warnOnce(key: string, message: string): void {
  if (!isDev() || warned.has(key)) {
    return;
  }
  warned.add(key);
  console.warn(message);
}

/** Forgets every warning; tests call it so one case cannot silence the next. */
export function resetWarnings(): void {
  warned.clear();
}
