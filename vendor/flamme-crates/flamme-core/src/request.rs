//! The JSON-in/JSON-out contract of the native entry point.
//!
//! One call compiles a project: the TypeScript side resolves the config, reads the
//! SDL and discovers and reads every source file (orchestration, kept in Node), and
//! this side builds the schema index, extracts, validates, builds the IR and emits
//! the whole generated tree as an in-memory map. Nothing here touches the
//! filesystem, so the native module is a pure function of its request.

use serde::{Deserialize, Serialize};

use crate::config::RustConfig;
use crate::contract::ArtifactKind;
use crate::diagnostics::Diagnostic;
use crate::extract::SourceFile;

/// The schema source, as the TypeScript loader read it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchemaInput {
    /// The SDL text (an introspection result is printed to SDL by the TypeScript loader).
    pub sdl: String,
    /// The SDL's project-relative posix path, or `<inline>`/`<introspection>`.
    pub file: String,
}

/// What one native compile may produce.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileOptions {
    /// `true` in check mode: the tree is still computed, the caller discards it.
    #[serde(default)]
    pub check: bool,
    /// `true` when the run carries persisted queries.
    #[serde(default)]
    pub persisted: bool,
    /// The project-relative sources this run was triggered by, when the caller had
    /// a change set. The native compiler always compiles the whole project; the
    /// field is accepted so the request mirrors `GenerateOptions`.
    #[serde(default)]
    pub files: Option<Vec<String>>,
    /// Include the full IR in the response, for a run whose plugin host reads it.
    /// The fast path leaves it off: the IR is the largest part of the response and
    /// only the TypeScript plugin contract needs it.
    #[serde(default)]
    pub include_ir: bool,
    /// `true` when the caller keeps the cache state this run returns. A run whose
    /// caller has no cache to store it in (the CLI, a one-off `check`) does not pay
    /// for building and serializing one.
    #[serde(default)]
    pub save_cache: bool,
}

/// One native compile request.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    /// The resolved config.
    pub config: RustConfig,
    /// The schema source.
    pub schema: SchemaInput,
    /// The discovered files with their text, for `flamme_core::compile`. The
    /// `compile_project` entry point walks the project instead and requires the
    /// field to be absent: a request that carries it is rejected with `FLM2002`
    /// rather than silently walked. This is the one place the contract is stated;
    /// the two entry points and the napi binding point here.
    #[serde(default)]
    pub files: Option<Vec<SourceFile>>,
    /// Run options.
    #[serde(default)]
    pub options: CompileOptions,
    /// The committed `persisted.json` text, when the caller asked for the drift check.
    #[serde(default)]
    pub persisted_committed: Option<String>,
    /// The `persisted.json` path relative to `projectDir`, for `FLM1025`.
    #[serde(default)]
    pub persisted_path: Option<String>,
    /// The state the previous run of the same project returned, as
    /// [`crate::session::SessionCache`] JSON. `null` (or absent) compiles everything.
    #[serde(default)]
    pub cache: Option<String>,
    /// The synthetic composed route documents of this run
    /// (`research/route-composition-design.md` §4.1).
    ///
    /// They have no file on disk: the session appends them to its source list after the walk (or
    /// after the caller's file list), so they are extracted, validated, IR'd, emitted and
    /// manifested exactly like discovered documents, in one pass. Absent means the caller composes
    /// nothing.
    #[serde(default)]
    pub route_documents: Option<Vec<SourceFile>>,
    /// The project-relative paths whose `text` the caller read and stands behind.
    /// `null` (or absent) means every entry of `files` was read. Any other entry is
    /// served from the cache, or read from disk when the cache cannot describe it.
    #[serde(default)]
    pub sources: Option<Vec<String>>,
}

/// One emitted file, keyed by its path relative to `runtimeDir`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutFile {
    /// Path relative to `runtimeDir`, posix.
    pub path: String,
    /// The file's exact bytes.
    pub contents: String,
}

/// One compiled artifact, as `manifest.json` and the drivers see it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledArtifact {
    /// The artifact name.
    pub name: String,
    /// The document kind.
    pub kind: ArtifactKind,
    /// `sha256(raw)`.
    pub hash: String,
    /// The printed document.
    pub raw: String,
    /// Absolute path of the source file.
    pub file: String,
    /// Posix path relative to `projectDir`.
    pub source: String,
    /// Path relative to `runtimeDir`.
    pub artifact_file: String,
    /// Paginated field paths and their modes.
    pub paginated: Vec<Vec<String>>,
    /// The `@list` names the document registers.
    pub lists: Vec<String>,
}

/// One extracted document, as the TypeScript side rehydrates it for route planning.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedDocument {
    /// The document name.
    pub name: String,
    /// The kind.
    pub kind: ArtifactKind,
    /// The document text as written.
    pub raw: String,
    /// Absolute path of the file.
    pub file: String,
    /// Posix path relative to `projectDir`.
    pub relative_path: String,
    /// `file`, `tag`, `script` or `module`.
    pub surface: String,
    /// Absolute offset of `raw[0]` in the file.
    pub offset: u32,
    /// Absolute offset of the document's first source byte.
    pub start: u32,
    /// Absolute offset just past the document's last source byte.
    pub end: u32,
    /// `sourceOffsets[i]` is the absolute file offset of `raw[i]`.
    pub source_offsets: Vec<u32>,
}

/// One `.gql`/`.graphql` import the extraction found.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedImport {
    /// Absolute path of the importing file.
    pub file: String,
    /// Posix path relative to `projectDir`.
    pub relative_path: String,
    /// The specifier as written.
    pub specifier: String,
    /// Absolute path the specifier resolves to.
    pub resolved: Option<String>,
    /// Absolute offset of the import declaration.
    pub offset: u32,
}

/// One native compile response. Serialized to the caller; never deserialized.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResponse {
    /// The tree this run has to land, in the order the built-ins contribute it: the
    /// aggregate members over the whole project, the artifacts of the documents this
    /// run rebuilt, and the artifact of a re-used document whose module is not on
    /// disk. The caller inserts it into the plugin emit bag, which sorts before
    /// writing.
    pub files: Vec<OutFile>,
    /// Every diagnostic, in discovery order (the caller sorts for reporting).
    pub diagnostics: Vec<Diagnostic>,
    /// Every compiled document, in extraction order, whether it was rebuilt or
    /// re-used from the cache: `manifest.json` and the drivers describe the whole
    /// project.
    pub artifacts: Vec<CompiledArtifact>,
    /// The extraction diagnostics alone, so the caller can rebuild an
    /// `ExtractResult` whose diagnostics are the extraction's own.
    pub extraction_diagnostics: Vec<Diagnostic>,
    /// The extracted documents the caller needs for route planning.
    pub documents: Vec<ExtractedDocument>,
    /// Every `.gql`/`.graphql` import found in a code file.
    pub imports: Vec<ExtractedImport>,
    /// Every name imported from `$flamme` anywhere in the project.
    pub imported_names: Vec<String>,
    /// The full IR, present only when the request asked for it. Each entry is an
    /// [`crate::contract::IrDocument`] without its `document` member, in the same
    /// order as `documents`; the caller reattaches the extracted document by name.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ir_documents: Option<Vec<crate::contract::IrDocument>>,
    /// The schema index's read-only surface, present only when the request asked for
    /// the IR. The read-only inspectors (`flamme explain`, `flamme refs`) report key
    /// fields from it, and it is what a caller gets instead of building a second,
    /// TypeScript schema index.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ir_schema: Option<IrSchema>,
    /// The names of the documents this run built, rather than re-used from the
    /// cache. Every other document's IR, artifact and diagnostics came from the
    /// cache, and the caller re-serializes only these.
    #[serde(default)]
    pub compiled: Vec<String>,
    /// The state the next run continues from (a [`crate::session::SessionCache`] as
    /// JSON), or `None` when this run produced none. The caller keeps it only after
    /// the tree is on disk.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cache_state: Option<String>,
    /// Every file the run compiled from, with its text, in walk order.
    #[serde(default)]
    pub sources: Vec<SourceFile>,
}

/// The schema index as the read-only inspectors read it.
///
/// The port builds the index inside Rust and never hands a JavaScript object back,
/// so this is the subset a caller can act on: the key fields per composite type, the
/// possible types, the enum and input-object maps, and the SDL hash. The members
/// mirror `SchemaIndex` in `packages/core/src/schema.ts`, minus the graphql-js
/// objects that only the deleted TypeScript emitter read.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IrSchema {
    /// `possibleTypes` per composite type.
    pub possible_types: crate::js::JsObject<Vec<String>>,
    /// Key fields per composite type, before the `defaultKeys` fallback.
    pub key_fields: crate::js::JsObject<Vec<String>>,
    /// Enum name to its values.
    pub enums: crate::js::JsObject<Vec<String>>,
    /// Input object name to field name to type string.
    pub input_types: crate::js::JsObject<crate::js::JsObject<String>>,
    /// `sha256` of the SDL the index was built from.
    pub hash: String,
    /// The user's SDL, verbatim.
    pub sdl: String,
    /// The `defaultKeys` in effect, the last fallback of `keyFieldsForType`.
    pub default_keys: Vec<String>,
}

/// The source file kind, derived from the path's extension.
pub fn file_kind(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("vue") => "vue",
        Some("tsx") => "tsx",
        Some("ts") | Some("mts") | Some("cts") => "ts",
        Some("gql") | Some("graphql") => "gql",
        _ => "other",
    }
}

/// Rebuilds a [`SourceFile`] list from the request, for tests.
pub fn source_files(files: &[SourceFile]) -> Vec<SourceFile> {
    files.to_vec()
}