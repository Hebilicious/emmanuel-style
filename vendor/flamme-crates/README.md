# The Rust compiler

The Flamme compiler is this crate. `packages/core` is the TypeScript driver that
loads it, resolves the config, runs the plugin host and writes the tree; the
TypeScript compiler it once mirrored no longer exists.

## Layout

| Crate                | What it is                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/flamme-core` | The compiler: the incremental session (walk, stat, read, cache), schema indexing from SDL, extraction from `.vue`/`.ts`/`.tsx`/`.gql`, validation (`FLM1001`-`FLM1031`), the normalized IR and emit of the generated tree. A library: it reads files when the session asks it to, and never writes one. |
| `crates/flamme-napi` | The napi-rs binding. Two JSON-in/JSON-out entry points, `compile(requestJson)` (the caller's file list) and `compileProject(requestJson)` (the native walk), plus `version()`.                                                                                                                          |

## Build

```sh
pnpm build:native            # release build, copies the module to packages/core/native/flamme.node
moon run core:native         # the same thing through moon
node crates/flamme-napi/install-native.mjs --debug   # fast edit/test loop
```

`packages/core/native/` and `/target/` are gitignored: the module is a build
artifact, not a source file. The build is reproducible from a clean checkout
(`rust-toolchain.toml` pins the toolchain, `Cargo.lock` the crates).

### Why `oxc_parser` is pinned to 0.130

The npm `oxc-parser` the retired TypeScript compiler used is 0.149.0 (it was
0.130.0 when the port was written), but the Rust crates
(`oxc_allocator`, `oxc_ast`, `oxc_parser`, `oxc_span`) are pinned at 0.130.0: the
later releases declare a `rust-version` this toolchain cannot satisfy
(`0.140.0` and `0.145.0` require 1.95.0, `0.149.0` and `0.150.0` require 1.96.0,
`0.130.0` requires 1.93.0), and `rust-toolchain.toml` pins **1.94.1**.

What unblocks it: raise `rust-toolchain.toml` (and the CI image) to 1.96 or newer,
then move all four oxc crates to 0.149.x in one step and re-run
`cargo test -p flamme-core` and `moon run core:test`: the AST shape is not
guaranteed stable between oxc releases, and the frozen extraction snapshots are what
catch a move.

## What runs where

Rust owns the compile pipeline, including discovery, reading and the incremental
cache. TypeScript keeps orchestration:

- config-file loading (`flamme.config.ts` is TypeScript, loaded by Node) and
  `resolveConfig`, which crosses the boundary as JSON;
- schema _sourcing_ (an SDL file, an introspection JSON file, a URL), while the
  schema _index_ is built in Rust from the SDL text;
- the compiler plugin host, the emit-bag semantics, the atomic writer with its
  rollback and tombstones, and route planning;
- the walk of a **change-set run**: `options.files` is the watcher's own list, so
  the TypeScript side walks the project and reads the files it names. The native
  side never reads them twice.

Rust reads files and stats them; it never writes one. The single look it takes at
the generated tree is a `stat` of an artifact module a re-used document owns, so a
module a failed run removed is still in the response the writer lands.

## The incremental session

`crates/flamme-core/src/session.rs` is what a run compiles from:

- **Discovery.** A full run (`options.files` absent) calls `compileProject`, which
  walks `projectDir` by the resolved include/exclude globs in Rust, depth-first,
  sorted, skipping `node_modules` and dot-directories, and reports an unreadable
  directory as `FLM2001` exactly like `walkFiles`.
- **Reading.** Stale files are read on as many threads as the machine has;
  invalid UTF-8 is replaced, not fatal, the way `readFile(_, 'utf8')` does it.
- **The cache.** `SessionCache` is JSON and opaque to TypeScript. It carries the
  schema hash, the `@list` fingerprint, the fragment texts, one record per
  discovered file (its stamp, its extraction residue with the file's text, its
  `<script src>` dependencies) and the IR of every document.
- **What a run skips.** A change-set run re-uses every file the change set does not
  name (directly or through a `<script src>`) while its size and modification time
  are unchanged, and a full run reads the project but still re-uses the IR of every
  document whose text, fragments, schema hash and `@list` fingerprint are unchanged.
  The re-use rule is the retired TypeScript compiler's (`canReuse`, once in
  `packages/core/src/generate.ts`),
  ported: a re-used residue replaces work, never a decision, so an incremental tree
  is byte-identical to a cold one.
- **What it returns.** The tree the run has to land (the aggregate members over the
  whole project, the artifacts it rebuilt, and the artifact of a re-used document
  whose module is not on disk), the compiled document names, the state the next run
  continues from, the file list and the diagnostics. A one-edit run on the
  400-document corpus compiles 1 of 400 documents and hands the writer 1 file.

TypeScript keeps the writer, its rollback and tombstones, and it commits the state
only after the tree is on disk (a run that failed to write may not tell the next run
its documents are current). The native run goes through `emitProject`, `emitSet` and
`landTree`, with `emitArtifacts` precomputed so the bag never re-serializes an
artifact the cache serves.

## One compiler

There is no backend to select: the Rust crate is the compiler, and the TS pipeline
that used to mirror it is gone. A checkout without the built module fails the run
with `FLM2002` and the build command (`pnpm build:native`), it does not compile with
something else.

Plugins that observe (`config`, `configResolved`, `beforeExtract`) or contribute
files (`beforeEmit`, `afterEmit`) run unchanged; the request asks for the full IR
when a hook reads `context.documents`. `transformDocument`, `validate` and
`afterExtract` change what the compiler produces, and it produces it inside Rust, so
a project with one of those hooks fails with `FLM2005` naming the plugin and the
hook instead of compiling a document the hook never saw.

## Tests

```sh
pnpm test          # moon run :test -> the compiler
```

The suites depend on `core:native`, so `moon run :test` builds the module first and
cannot test anything else.

## Frozen expectations and benchmarks

- `cargo test -p flamme-core` covers the compiler against fixtures. The integration
  suites compare byte for byte against frozen snapshots of the retired TypeScript
  compiler's output, committed under `crates/flamme-core/tests/fixtures/` (per-fixture
  `expected.json`/`oracle.json` and `fixtures/frozen/*.json`), so a run needs no Node.
  `crates/flamme-core/tests/session_cache.rs` is the incremental session's own suite:
  a scratch project, a cold run, an edit, a kept cache, and the frozen tree and
  diagnostics for every step.
- `node packages/core/bench/native-bench.mjs` reports wall time and peak RSS for a
  full run and a one-edit run on the Pokédex and on a synthetic ~400-document
  corpus. `--edit` makes the one-edit scenario rewrite the changed source between the
  warm-up and the measured run.

### Numbers

Method: `node packages/core/bench/native-bench.mjs --runs 5` (before: 3 runs), each
run in its own child process (`process.resourceUsage().maxRSS`, Node runtime
included), median of the runs, `FLAMME_COMPILER` unset so each row uses the backend
it names. Host: Linux, 22 cores, Node 25.9.0, rustc 1.94.1, a shared machine (load
average ≈3.6), so treat single-digit differences as noise.

"One edit" passes `files: [<one changed source>]` with the previous run's cache;
the `--edit` run below rewrites that source first, so there is one document to
rebuild rather than none. Before the port, a Rust one-edit run was a full compile
with the change set passed through; after it, it compiles the one document.

Rust backend, before → after (same method):

| corpus               | scenario | before ms | after ms | before RSS MB | after RSS MB |
| -------------------- | -------- | --------- | -------- | ------------- | ------------ |
| pokedex              | full     | 39.5      | 29.7     | 100.9         | 102.3        |
| pokedex              | one edit | 19.6      | 18.1     | 101.2         | 102.9        |
| synthetic (400 docs) | full     | 346.8     | 272.8    | 126.3         | 129.0        |
| synthetic (400 docs) | one edit | 242.3     | 122.6    | 153.7         | 166.5        |

End to end, both backends after the port (default method / `--edit`):

| corpus               | scenario            | ts ms | rust ms | ts RSS MB | rust RSS MB |
| -------------------- | ------------------- | ----- | ------- | --------- | ----------- |
| pokedex              | full                | 113.8 | 29.7    | 115.8     | 102.3       |
| pokedex              | one edit            | 21.5  | 18.1    | 117.4     | 102.9       |
| pokedex              | one edit (`--edit`) | 21.9  | 18.8    | 117.7     | 102.7       |
| synthetic (400 docs) | full                | 415.0 | 272.8   | 130.0     | 129.0       |
| synthetic (400 docs) | one edit            | 147.1 | 122.6   | 168.0     | 166.5       |
| synthetic (400 docs) | one edit (`--edit`) | 153.4 | 130.8   | 169.9     | 167.0       |

Where the remaining time goes (400-document corpus, full run): Rust reads the
project in 0.5 ms and compiles it in ~138 ms; the TypeScript writer lands 410 files
in ~111 ms. A one-edit run compiles 1 of 400 documents (`compiled: ['Species0']`),
writes 1 file, and spends ~27 ms in the TypeScript walk (the watcher's change set),
~84 ms in the native call (about 50 ms of compiler, the rest JSON at the boundary)
and 3 ms writing. The retired TypeScript compiler's own one-edit run spent ~98 ms
re-validating all 400 documents, which is what kept the two numbers close: the port
removed the discovery, reading, extraction and IR work it was asked to remove, and
validation of unchanged documents is a cost the compiler still pays.
