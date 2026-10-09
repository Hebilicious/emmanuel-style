/**
 * The document index the transform consults: document name → artifact module.
 * Built from a `CodegenResult`, from the generated `manifest.json` (the
 * `skipCodegen` path) or by hand in tests.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { CodegenResult } from '@flamme/core';

/** The fields of one artifact the transform needs. */
export interface ArtifactRecord {
  /** Document name, which is also the artifact's default export binding. */
  readonly name: string;
  /** Path relative to the runtime dir, `artifacts/<Name>.ts`. */
  readonly artifactFile: string;
  /** Absolute path of the source file the document came from, when known. */
  readonly file?: string;
  /** Project-relative posix path of the source file, when known. */
  readonly source?: string;
}

/** A read-only lookup over {@link ArtifactRecord}s. */
export interface ArtifactIndex {
  /** Number of indexed documents. */
  readonly size: number;
  /** Every record, in the order they were indexed. */
  readonly records: readonly ArtifactRecord[];
  /** Finds the artifact a document name compiles to. */
  byName(name: string): ArtifactRecord | undefined;
  /** Finds the artifact a `.gql`/`.graphql` source file compiles to. */
  byFile(absolute: string): ArtifactRecord | undefined;
}

/** Builds an index from records. Later records with the same key are ignored. */
export function createArtifactIndex(records: readonly ArtifactRecord[]): ArtifactIndex {
  const names = new Map<string, ArtifactRecord>();
  const files = new Map<string, ArtifactRecord>();
  for (const entry of records) {
    if (!names.has(entry.name)) {
      names.set(entry.name, entry);
    }
    if (entry.file !== undefined && !files.has(entry.file)) {
      files.set(entry.file, entry);
    }
  }
  return {
    size: names.size,
    records,
    byName: (name) => names.get(name),
    byFile: (absolute) => files.get(absolute),
  };
}

/** Builds an index from one codegen run (§10.2 `buildStart`). */
export function indexFromCodegen(result: CodegenResult): ArtifactIndex {
  return createArtifactIndex(
    result.artifacts.map((artifact) => ({
      name: artifact.name,
      artifactFile: artifact.artifactFile,
      file: artifact.file,
      source: artifact.source,
    })),
  );
}

/** The shape of the generated `manifest.json` the index reads. */
interface ManifestDocument {
  readonly name?: unknown;
  readonly file?: unknown;
  readonly sources?: unknown;
}

/** Copies the three manifest fields out of one unknown entry. */
function toManifestDocument(entry: unknown): ManifestDocument {
  if (typeof entry !== 'object' || entry === null) {
    return {};
  }
  return {
    name: Reflect.get(entry, 'name'),
    file: Reflect.get(entry, 'file'),
    sources: Reflect.get(entry, 'sources'),
  };
}

/**
 * Builds an index from `<runtimeDir>/manifest.json`, the `skipCodegen` path:
 * the artifacts are on disk from a CLI run, so the transform only needs names.
 */
export async function indexFromManifest(
  projectDir: string,
  runtimeDir: string,
): Promise<ArtifactIndex> {
  const text = await readFile(join(runtimeDir, 'manifest.json'), 'utf8');
  const parsed: unknown = JSON.parse(text);
  const rawDocuments: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'documents') : undefined;
  const documents = Array.isArray(rawDocuments) ? rawDocuments.map(toManifestDocument) : [];
  const records: ArtifactRecord[] = [];
  for (const document of documents) {
    const name = document.name;
    if (typeof name !== 'string') {
      continue;
    }
    const file = typeof document.file === 'string' ? document.file : `artifacts/${name}.ts`;
    const sources = Array.isArray(document.sources) ? document.sources : [];
    const source = sources.find((entry): entry is string => typeof entry === 'string');
    records.push({
      name,
      artifactFile: file,
      ...(source === undefined
        ? {}
        : { source, file: isAbsolute(source) ? source : resolve(projectDir, source) }),
    });
  }
  return createArtifactIndex(records);
}

/** The module specifier the transform imports an artifact from (§2.4). */
export function artifactSpecifier(record: ArtifactRecord): string {
  return `$flamme/${record.artifactFile.replace(/\.ts$/, '')}`;
}

/** The document name inside a GraphQL text, or `undefined` when anonymous. */
export function documentNameOf(text: string): string | undefined {
  const withoutComments = text.replaceAll(/#[^\n]*/g, '');
  const operation = /^\s*(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(
    withoutComments,
  );
  if (operation?.[1] !== undefined) {
    return operation[1];
  }
  const fragment = /^\s*fragment\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(withoutComments);
  return fragment?.[1];
}
