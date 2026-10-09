/**
 * The server entry point: a `ManagedRuntime` per request.
 *
 * `ManagedRuntime` builds the layer once and keeps it for every run against it, which is what a
 * server wants between requests and what SSR must not do across requests: the client holds the
 * normalized cache, so one runtime per request (disposed in a `finally`) is the shape that keeps
 * request N's records out of request N+1's `serialize()`.
 */
import * as ManagedRuntime from 'effect/ManagedRuntime';

import type { Client } from '@flamme/runtime';

import type { ClientLayerOptions, FlammeConfig } from './layer.js';
import { clientLayer, flammeLayer } from './layer.js';
import type { Flamme } from './service.js';

/** A runtime over a client built from a config; dispose it when the request is done. */
export function makeRuntime(config: FlammeConfig): ManagedRuntime.ManagedRuntime<Flamme, never> {
  return ManagedRuntime.make(flammeLayer(config));
}

/** A runtime over a client you already built (the Vue app's client, a per-request client). */
export function makeClientRuntime(
  client: Client,
  options: ClientLayerOptions = {},
): ManagedRuntime.ManagedRuntime<Flamme, never> {
  return ManagedRuntime.make(clientLayer(client, options));
}
