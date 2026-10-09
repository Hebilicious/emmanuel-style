//! The incremental session: discovery, reading, the per-file cache and the compile
//! that skips every document the cache already holds.
//!
//! The TypeScript side hands the session the resolved config, the schema source, the
//! run options and the state the previous run left behind; the session walks the
//! project (unless the caller already walked it), stats and reads the files a change
//! set or a stale stamp makes current, extracts and compiles only what the cache
//! cannot serve, emits the whole tree as data, and reports the state the next run
//! may continue from.
//!
//! Reading is all the session does to the filesystem: the writer, its rollback and
//! the tombstones stay in TypeScript. The one exception is a `stat` of an artifact
//! module a re-used document owns, so the response still carries the bytes of a
//! module a failed run removed (`packages/core/src/generate.ts` re-puts it).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::config::RustConfig;
use crate::contract::IrDocument;
use crate::diagnostics::{
    Diagnostic, DiagnosticInput, Severity, SourceLocation, create_diagnostic, has_errors,
};
use crate::emit::emit_tree_filtered;
use crate::extract::{CachedFileResidue, RawDocument, SourceFile, extract_project_cached};
use crate::graphql::ast::Definition;
use crate::ir::{build_ir, transitive_spreads};
use crate::naming::{artifact_module_path, compare_names};
use crate::offsets::to_posix;
use crate::persisted::{PERSISTED_MANIFEST_FILE, persisted_manifest_diagnostic};
use crate::request::{
    CompileOptions, CompileResponse, CompiledArtifact, ExtractedDocument, ExtractedImport, OutFile,
    SchemaInput,
};
use crate::schema::{SchemaIndexOptions, build_schema_index};
use crate::validate::{DocumentIndex, ValidateOptions, prepare_project, validate_project};

/// One file's contribution to the cache, keyed by its project-relative posix path.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFile {
    /// Posix path relative to `projectDir`.
    pub relative: String,
    /// Size in bytes as the run that cached it read it.
    pub size: u64,
    /// Modification time in nanoseconds since the epoch as that run stat'ed it.
    ///
    /// An integer on purpose: this record is serialized into the cache JSON, and
    /// `serde_json`'s float parser is not round-trip exact (it parses
    /// `1789486246200.6343` back one ULP higher), so a millisecond `f64` made an
    /// unchanged file compare as changed and re-read it.
    pub mtime_ns: u64,
    /// What extraction found in it.
    pub residue: CachedFileResidue,
}

/// One compiled document, as the cache holds it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedIr {
    /// The document text as written, which is what the re-use decision compares.
    pub raw: String,
    /// The IR; its `document` member is rebuilt from the extraction on the way in.
    pub ir: IrDocument,
}

/// Everything one run hands the next: the schema and `@list` fingerprint it compiled
/// against, the per-file extraction, and the IR of every document.
///
/// The state is JSON and opaque to the caller: TypeScript keeps the string only
/// after the tree it describes is on disk, so a run that failed to write cannot
/// make the next one believe its documents are current.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCache {
    /// `schema.hash` of the run.
    pub schema_hash: String,
    /// The project's `@list` registrations, as a fingerprint string.
    pub lists: String,
    /// Fragment name to its text as written, for the dependency check.
    pub fragments: Vec<(String, String)>,
    /// One record per discovered file.
    pub files: Vec<CachedFile>,
    /// One record per compiled document, in document order.
    pub documents: Vec<CachedIr>,
}

impl SessionCache {
    /// The cached IR of `name`, when this state holds it.
    fn document(&self, name: &str) -> Option<&CachedIr> {
        self.documents.iter().find(|document| document.ir.name == name)
    }

    /// Fragment name to its text, as the re-use decision compares them.
    fn fragment_map(&self) -> HashMap<String, String> {
        self.fragments.iter().cloned().collect()
    }
}

/// One file the session compiled from.
struct InputFile {
    /// Posix path relative to `projectDir`.
    relative: String,
    /// Absolute path on disk.
    absolute: String,
    /// Size in bytes, as this run stat'ed it.
    size: u64,
    /// Modification time in nanoseconds since the epoch, as this run stat'ed it.
    mtime_ns: u64,
    /// The caller's text, when it read the file itself.
    text: Option<String>,
}

/// One run's input, assembled by the caller (`generate.rs`).
pub struct SessionRequest<'a> {
    /// The resolved config.
    pub config: &'a RustConfig,
    /// The schema source.
    pub schema: &'a SchemaInput,
    /// The discovered files, when the caller walked the project. `None` makes the
    /// session walk `config.project_dir` by `include`/`exclude` itself.
    pub files: Option<Vec<SourceFile>>,
    /// The previous run's state, as [`SessionCache`] JSON.
    pub cache: Option<String>,
    /// The project-relative paths whose `text` in `files` is authoritative; `None`
    /// means every one of them. A file outside the set is re-used from the cache or
    /// read from disk.
    pub read_texts: Option<HashSet<String>>,
    /// The run options.
    pub options: &'a CompileOptions,
    /// The committed `persisted.json` text, for the drift check.
    pub persisted_committed: Option<&'a str>,
    /// The `persisted.json` path relative to `projectDir`, for `FLM1025`.
    pub persisted_path: Option<&'a str>,
    /// The synthetic composed route documents, appended to `sources` after the walk (or after the
    /// caller's file list), so one pass compiles them with everything else
    /// (`research/route-composition-design.md` §4.1).
    pub route_documents: Option<&'a [SourceFile]>,
}

/// What one session produced.
pub struct SessionOutcome {
    /// The compile response.
    pub response: CompileResponse,
    /// The state the next run continues from; `None` when this run produced none
    /// (a schema that failed to index, or a project that did not compile).
    pub cache: Option<SessionCache>,
}

/// Compiles one project, re-using everything the previous run's cache still describes.
pub fn compile_session(request: SessionRequest<'_>) -> SessionOutcome {
    let config = request.config;
    let mut diagnostics: Vec<Diagnostic> = Vec::new();

    // The schema first: a project whose SDL cannot be indexed reports that and
    // nothing else, exactly like the TypeScript pipeline.
    let index_options = SchemaIndexOptions::from_config(config);
    let schema = match build_schema_index(&request.schema.sdl, &index_options, &request.schema.file) {
        Ok(schema) => schema,
        Err(error) => {
            return SessionOutcome {
                response: failure_response(schema_diagnostic(&error.message)),
                cache: None,
            };
        }
    };
    diagnostics.extend(schema.diagnostics.iter().cloned());

    // Discovery: the caller's walk when it made one, this crate's otherwise.
    let mut extraction_diagnostics: Vec<Diagnostic> = Vec::new();
    let mut files: Vec<InputFile> = match &request.files {
        Some(files) => files
            .iter()
            .map(|file| {
                let read = request
                    .read_texts
                    .as_ref()
                    .is_none_or(|read| read.contains(&file.relative));
                InputFile {
                    relative: file.relative.clone(),
                    absolute: file.absolute.clone(),
                    size: 0,
                    mtime_ns: 0,
                    text: read.then(|| file.text.clone()),
                }
            })
            .collect(),
        None => walk_project(config, &mut extraction_diagnostics),
    };
    // Every stamp is this run's: the caller's file list carries no stat (the walk
    // that produced it was about paths), and a stale stamp silently re-uses old
    // text, so the session never trusts one it did not read.
    for file in &mut files {
        let (size, mtime_ns) = stamp(&file.absolute);
        file.size = size;
        file.mtime_ns = mtime_ns;
    }
    // The integer stamps, for the cache: `SourceFile` carries milliseconds for the
    // response, and the cache record has to keep the nanoseconds this run stat'ed.
    let stamps: HashMap<&str, u64> =
        files.iter().map(|file| (file.relative.as_str(), file.mtime_ns)).collect();

    let previous: Option<SessionCache> =
        request.cache.as_deref().and_then(|json| serde_json::from_str(json).ok());
    let changed: Option<HashSet<&str>> = request
        .options
        .files
        .as_deref()
        .map(|files| files.iter().map(String::as_str).collect());

    // Decide what the cache still describes. Without a change set nothing is
    // re-usable (a full run re-reads the project); with one, every file the change
    // set does not name (directly or through a `<script src>`) is re-used while its
    // size and modification time are unchanged.
    let mut stale: HashSet<String> = HashSet::new();
    let mut reused: HashMap<String, String> = HashMap::new();
    match (&previous, &changed) {
        (Some(previous), Some(changed)) => {
            let cached: HashMap<&str, &CachedFile> =
                previous.files.iter().map(|file| (file.relative.as_str(), file)).collect();
            let dependents: HashSet<&str> = previous
                .files
                .iter()
                .filter(|file| {
                    file.residue
                        .dependencies
                        .iter()
                        .any(|dependency| changed.contains(dependency.as_str()))
                })
                .map(|file| file.relative.as_str())
                .collect();
            for file in &files {
                let record = cached.get(file.relative.as_str());
                let current = record.is_some_and(|record| {
                    record.size == file.size && record.mtime_ns == file.mtime_ns
                });
                if !changed.contains(file.relative.as_str())
                    && !dependents.contains(file.relative.as_str())
                    && current
                {
                    let record = record.expect("a current record is a record");
                    reused.insert(file.relative.clone(), record.residue.text.clone());
                } else {
                    stale.insert(file.relative.clone());
                }
            }
        }
        _ => {
            stale.extend(files.iter().map(|file| file.relative.clone()));
        }
    }

    // Read what the caller did not read, in parallel: an incremental run reads its
    // change set, a full run reads the project.
    let mut texts: HashMap<String, String> = HashMap::new();
    let mut to_read: Vec<&InputFile> = Vec::new();
    for file in &files {
        if let Some(record) = reused.get(&file.relative) {
            texts.insert(file.relative.clone(), record.clone());
            continue;
        }
        match &file.text {
            Some(text) => {
                texts.insert(file.relative.clone(), text.clone());
            }
            None => to_read.push(file),
        }
    }
    let read: Vec<(String, Result<String, String>)> = read_all(&to_read);
    for (relative, outcome) in read {
        match outcome {
            Ok(text) => {
                texts.insert(relative, text);
            }
            Err(message) => {
                extraction_diagnostics.push(read_error(&relative, &message));
                texts.insert(relative, String::new());
            }
        }
    }

    let sources: Vec<SourceFile> = files
        .iter()
        .map(|file| SourceFile {
            relative: file.relative.clone(),
            absolute: file.absolute.clone(),
            text: texts.get(&file.relative).cloned().unwrap_or_default(),
            size: file.size,
            mtime_ms: milliseconds(file.mtime_ns),
        })
        .collect();

    // The composed route documents join the source list here, after the walk and after the cache
    // decision, so they are always extracted from the text the request carries: they have no file
    // on disk, and a previous run's residue describes an older composed text.
    let mut sources = sources;
    if let Some(composed) = request.route_documents {
        for document in composed {
            stale.insert(document.relative.clone());
            sources.push(document.clone());
        }
    }
    let cached_residues: HashMap<String, CachedFileResidue> = previous
        .as_ref()
        .map(|previous| {
            previous
                .files
                .iter()
                .map(|file| (file.relative.clone(), file.residue.clone()))
                .collect()
        })
        .unwrap_or_default();
    let (mut extracted, records) =
        extract_project_cached(config, &sources, &stale, &cached_residues);
    // The composed route documents are synthetic: extraction sees them as ordinary `.gql` files
    // (that is what makes them real artifacts), and the surface is what tells the barrel, the
    // ambient declarations and the TypeScript route planner that they are not app API
    // (`research/route-composition-design.md` §1.5).
    if let Some(composed) = request.route_documents {
        let composed_paths: HashSet<&str> =
            composed.iter().map(|document| document.relative.as_str()).collect();
        for document in &mut extracted.documents {
            if composed_paths.contains(document.relative_path.as_str()) {
                document.surface = crate::extract::DocumentSurface::Composed;
            }
        }
    }
    extraction_diagnostics.extend(extracted.diagnostics.iter().cloned());
    diagnostics.extend(extraction_diagnostics.iter().cloned());

    // The depth limit, before anything recursive sees the tree. The parser bounds
    // only the *lexical* nesting (`depth::MAX_PARSE_NESTING`); the document limit is
    // lower and is measured here by an iterative walk, which follows fragment spreads
    // because the compiler's own expansion does: 701 fragments, each spreading the
    // next, measured two selection sets each and used to kill the process with
    // SIGSEGV. An over-deep document is reported and dropped, exactly as a document
    // that cannot be parsed is, so `prepare`, `validate`, the IR, emit and the
    // response serialization never descend into it (`crates/flamme-core/src/depth.rs`).
    let expansion = crate::depth::FragmentExpansion::new(
        extracted
            .documents
            .iter()
            .filter_map(|document| match document.ast.definitions.first() {
                Some(Definition::Fragment(fragment)) => {
                    Some((fragment.name.value.as_str(), &fragment.selection_set))
                }
                _ => None,
            }),
    );
    let mut too_deep: Vec<Diagnostic> = Vec::new();
    extracted.documents.retain(|document| {
        let depth = crate::depth::document_expansion_depth(&document.ast, &expansion);
        if depth <= crate::depth::MAX_SELECTION_DEPTH {
            return true;
        }
        let location = match texts.get(&document.relative_path) {
            Some(text) => crate::offsets::location_at(
                &crate::offsets::SourceText::new(text.clone()),
                &document.relative_path,
                document.start,
                1,
            ),
            None => SourceLocation::document(&document.relative_path),
        };
        // The one document a `FLM1049` reports measures two depths: what it is written
        // as, and what the compiler's expansion of its spreads reaches. A chain of
        // shallow fragments is the second, and a message about its nesting would send
        // the reader to a definition that nests nothing.
        let plain = crate::depth::document_depth(&document.ast);
        let expanded = plain < depth;
        let limit = crate::depth::MAX_SELECTION_DEPTH;
        too_deep.push(create_diagnostic(DiagnosticInput {
            code: "FLM1049".into(),
            severity: Some(Severity::Error),
            message: if expanded {
                format!(
                    "{}:{}:{} the document \"{}\" reaches {} selection sets deep once its fragment spreads are expanded; the compiler's limit is {}.",
                    location.file, location.line, location.column, document.name, depth, limit
                )
            } else {
                format!(
                    "{}:{}:{} the document \"{}\" nests {} selection sets deep; the compiler's limit is {}.",
                    location.file, location.line, location.column, document.name, depth, limit
                )
            },
            location,
            related: None,
            hint: Some(if expanded {
                format!(
                    "shorten the fragment chain so no definition reaches deeper than {limit} selection sets."
                )
            } else {
                format!(
                    "split the chain across fragments so no definition nests deeper than {limit} selection sets."
                )
            }),
        }));
        false
    });
    diagnostics.extend(too_deep);

    let prepared = prepare_project(config, &schema, &extracted.documents);
    diagnostics.extend(prepared.diagnostics.iter().cloned());
    diagnostics.extend(validate_project(&ValidateOptions {
        config,
        schema: &schema,
        documents: &extracted.documents,
        imports: &extracted.imports,
        imported_names: &extracted.imported_names,
        index: &prepared.index,
    }));

    // Fragment pagination (research §3): every fragment that owns a `@paginate` field
    // gets an internal `<Fragment>_paginated` clone plus a `<Fragment>_Pagination_Query`
    // companion. The clone is registered in the index so the companion can inline it,
    // and the companions are ordinary query documents from here on.
    let companions = if has_errors(&diagnostics) {
        crate::companion::CompanionSet {
            companions: Vec::new(),
            index: prepared.index.clone(),
            documents: Vec::new(),
        }
    } else {
        crate::companion::build_companions(
            &extracted.documents,
            &prepared.index,
            &schema,
            config,
            &mut diagnostics,
        )
    };
    let companion_index = &companions.index;
    let mut all_documents: Vec<RawDocument> = extracted.documents.clone();
    all_documents.extend(companions.documents.iter().cloned());

    // The IR: a document the cache still describes is not built again. A changed
    // schema or a changed `@list` registration reaches every document, and neither
    // is derivable from one document's own text.
    let mut documents: Vec<IrDocument> = Vec::new();
    let mut compiled: Vec<String> = Vec::new();
    let current_fragments = fragment_raws(&extracted.documents, &prepared.index);
    if !has_errors(&diagnostics) {
        let previous_fragments =
            previous.as_ref().map(SessionCache::fragment_map).unwrap_or_default();
        let lists = list_fingerprint(&prepared.index);
        let rebuild_everything = previous.as_ref().is_none_or(|previous| {
            previous.schema_hash != schema.hash || previous.lists != lists
        });
        for document in &extracted.documents {
            let cached = match (&previous, rebuild_everything) {
                (Some(previous), false) => previous.document(&document.name),
                _ => None,
            };
            if can_reuse(document, companion_index, cached, &previous_fragments, &current_fragments)
            {
                let mut ir = cached.expect("a re-usable document is a cached one").ir.clone();
                ir.document = document.clone();
                documents.push(ir);
            } else {
                compiled.push(document.name.clone());
                documents.push(build_ir(
                    document,
                    &extracted.documents,
                    companion_index,
                    &schema,
                    config,
                ));
            }
        }
        // A companion is derived from its fragment and cheap to rebuild, so it is
        // never cached: it is rebuilt every run and the fragment points at it.
        for companion in &companions.companions {
            compiled.push(companion.document.name.clone());
            let mut ir = build_ir(
                &companion.document,
                &all_documents,
                companion_index,
                &schema,
                config,
            );
            // The companion exists to write into the fragment's own connection, and a
            // cache field is addressed by `keyRaw`. The clone binds the page arguments
            // as variables, so its own key differs from the fragment's; the companion
            // takes the fragment's key so a page lands where the fragment reads.
            let fragment_key = documents
                .iter()
                .find(|entry| entry.name == companion.fragment)
                .and_then(crate::companion::paginated_field_key);
            if let Some(key) = &fragment_key {
                if let Some(path) = ir.paginated.first().cloned() {
                    crate::companion::set_paginated_field_key(&mut ir, &path, key);
                }
            }
            if let Some(fragment) =
                documents.iter_mut().find(|entry| entry.name == companion.fragment)
            {
                fragment.pagination_companion = Some(companion.document.name.clone());
            }
            ir.pagination_companion = None;
            documents.push(ir);
        }
    }

    // The tree: every aggregate member, the artifacts this run rebuilt, and the
    // artifact of a re-used document whose module is not on disk (a failed run's
    // rollback or a plugin's tombstone removed it).
    let mut tree: Vec<OutFile> = Vec::new();
    if !has_errors(&diagnostics) {
        let rebuilt: HashSet<&str> = compiled.iter().map(String::as_str).collect();
        tree = emit_tree_filtered(&documents, &schema, config, request.options.persisted, |doc| {
            rebuilt.contains(doc.name.as_str()) || !artifact_on_disk(config, &doc.name)
        })
        .into_iter()
        .map(|(path, contents)| OutFile { path, contents })
        .collect();
        if request.options.persisted && request.options.check {
            // Check mode writes nothing: the persisted plugin reports the drift
            // instead, and a project that does not compile keeps its ordinary
            // diagnostics only (the guard above is the same one).
            let file = request
                .persisted_path
                .unwrap_or(PERSISTED_MANIFEST_FILE)
                .to_string();
            if let Some(diagnostic) =
                persisted_manifest_diagnostic(&documents, &file, request.persisted_committed)
            {
                diagnostics.push(diagnostic);
            }
        }
    }

    let artifacts = documents
        .iter()
        .map(|document| CompiledArtifact {
            name: document.name.clone(),
            kind: document.kind,
            hash: document.hash.clone(),
            raw: document.raw.clone(),
            file: document.file.clone(),
            source: document.source.clone(),
            artifact_file: document.artifact_module_path(),
            paginated: document.paginated.clone(),
            lists: document.lists.clone(),
        })
        .collect();

    let documents_out = extracted
        .documents
        .iter()
        .map(|document| ExtractedDocument {
            name: document.name.clone(),
            kind: document.kind,
            raw: document.raw.clone(),
            file: document.file.clone(),
            relative_path: document.relative_path.clone(),
            surface: surface_name(document),
            offset: document.offset,
            start: document.start,
            end: document.end,
            source_offsets: document.source_offsets.clone(),
        })
        .collect();

    let imports = extracted
        .imports
        .iter()
        .map(|entry| ExtractedImport {
            file: entry.file.clone(),
            relative_path: entry.relative_path.clone(),
            specifier: entry.specifier.clone(),
            resolved: entry.resolved.clone(),
            offset: entry.offset,
        })
        .collect();

    // The next run's state. Reported only when this run reached the IR stage: a
    // project that did not compile may not claim its documents are current. A caller
    // with no cache to keep (`CompileOptions::save_cache`, which is what the CLI and
    // a one-off `check` send) gets none at all: the state carries the IR of every
    // document, and building and serializing megabytes of JSON for a value the caller
    // drops is pure cost.
    let cache = if has_errors(&diagnostics) || !request.options.save_cache {
        None
    } else {
        let raw_by_name: HashMap<&str, &str> = extracted
            .documents
            .iter()
            .map(|document| (document.name.as_str(), document.raw.as_str()))
            .collect();
        Some(SessionCache {
            schema_hash: schema.hash.clone(),
            lists: list_fingerprint(&prepared.index),
            fragments: current_fragments.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            files: sources
                .iter()
                .map(|file| CachedFile {
                    relative: file.relative.clone(),
                    size: file.size,
                    // A composed route document has no file on disk and no stamp.
                    mtime_ns: stamps.get(file.relative.as_str()).copied().unwrap_or(0),
                    residue: records.get(&file.relative).cloned().unwrap_or_default(),
                })
                .collect(),
            documents: documents
                .iter()
                .map(|ir| CachedIr {
                    raw: raw_by_name.get(ir.name.as_str()).copied().unwrap_or("").to_string(),
                    ir: ir.clone(),
                })
                .collect(),
        })
    };
    let cache_state = cache
        .as_ref()
        .and_then(|cache| serde_json::to_string(cache).ok());

    SessionOutcome {
        response: CompileResponse {
            files: tree,
            diagnostics,
            artifacts,
            extraction_diagnostics,
            documents: documents_out,
            imports,
            imported_names: extracted.imported_names.clone(),
            // The IR surface carries the generated companions too: the TypeScript
            // plugin host keeps only the extracted documents (`rehydrateDocuments`),
            // while a caller that asked for the IR gets the whole artifact set.
            ir_documents: if request.options.include_ir { Some(documents) } else { None },
            // The read-only inspectors get the schema surface from the same pass that
            // built it, instead of indexing the SDL a second time.
            ir_schema: if request.options.include_ir {
                Some(crate::request::IrSchema {
                    possible_types: schema.possible_types.clone(),
                    key_fields: schema.key_fields.clone(),
                    enums: schema.enums.clone(),
                    input_types: schema.input_types.clone(),
                    hash: schema.hash.clone(),
                    sdl: schema.sdl.clone(),
                    default_keys: index_options.default_keys.clone(),
                })
            } else {
                None
            },
            compiled,
            cache_state,
            sources,
        },
        cache,
    }
}

/// The response of a run that stopped before discovery (`generate.rs` uses it for
/// the request `compile_project` rejects).
pub(crate) fn failure_response(diagnostic: Diagnostic) -> CompileResponse {
    CompileResponse {
        files: Vec::new(),
        diagnostics: vec![diagnostic],
        artifacts: Vec::new(),
        extraction_diagnostics: Vec::new(),
        documents: Vec::new(),
        imports: Vec::new(),
        imported_names: Vec::new(),
        ir_documents: None,
        ir_schema: None,
        compiled: Vec::new(),
        cache_state: None,
        sources: Vec::new(),
    }
}

/// The `FLM2002` diagnostic a schema that cannot be indexed reports.
fn schema_diagnostic(message: &str) -> Diagnostic {
    create_diagnostic(DiagnosticInput {
        code: "FLM2002".into(),
        severity: Some(Severity::Error),
        message: message.to_string(),
        location: SourceLocation::config(),
        related: None,
        hint: None,
    })
}

/// The `FLM1011` diagnostic a file this run could not read reports.
fn read_error(relative: &str, message: &str) -> Diagnostic {
    create_diagnostic(DiagnosticInput::error(
        "FLM1011",
        format!("{relative}: cannot read the file: {message}"),
        SourceLocation {
            file: relative.to_string(),
            line: 1,
            column: 1,
            length: 1,
        },
    ))
}

/// The surface spelling the response reports.
fn surface_name(document: &RawDocument) -> String {
    match document.surface {
        crate::extract::DocumentSurface::File => "file".into(),
        crate::extract::DocumentSurface::Tag => "tag".into(),
        crate::extract::DocumentSurface::Script => "script".into(),
        crate::extract::DocumentSurface::Module => "module".into(),
        crate::extract::DocumentSurface::Composed => "composed".into(),
    }
}

/// `size` and `mtimeNs` of `absolute`, or a stamp that never matches a record.
///
/// A file that cannot be stat'ed gets `(u64::MAX, u64::MAX)`: no real file has that
/// size or modification time, so the record it is compared against cannot match and
/// the file is read.
fn stamp(absolute: &str) -> (u64, u64) {
    match std::fs::metadata(absolute) {
        Ok(metadata) => (metadata.len(), mtime_ns(&metadata)),
        Err(_) => (u64::MAX, u64::MAX),
    }
}

/// `stat.mtime`: nanoseconds since the epoch, as an integer.
///
/// Nanoseconds are the finest granularity `SystemTime` carries, so two stats of an
/// unchanged file compare equal. The cache stores this integer, never a float: the
/// value crosses `serde_json`, whose float parser is not round-trip exact, and one
/// ULP of difference made the reuse check re-read an unchanged file.
fn mtime_ns(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u128::from(u64::MAX - 1)) as u64)
        .unwrap_or(u64::MAX)
}

/// The nanoseconds of a stamp as milliseconds, for the response's `SourceFile`.
fn milliseconds(nanoseconds: u64) -> f64 {
    nanoseconds as f64 / 1_000_000.0
}

/// True when the artifact module of `name` is on disk under `runtimeDir`.
///
/// The writer stays in TypeScript; this is the one look at the generated tree, and
/// it is what keeps a module a failed run removed in the response.
fn artifact_on_disk(config: &RustConfig, name: &str) -> bool {
    let path = Path::new(&config.runtime_dir).join(artifact_module_path(name));
    std::fs::metadata(path).map(|metadata| metadata.is_file()).unwrap_or(false)
}

/// The message a file whose reader thread panicked reports.
const READER_PANIC: &str = "the reader thread panicked";

/// Reads every file `to_read` names, on as many threads as the machine has.
fn read_all(files: &[&InputFile]) -> Vec<(String, Result<String, String>)> {
    read_all_with(files, read_text)
}

/// [`read_all`] with the reader injected, so a test can make one read panic.
///
/// A panic inside one read is caught and turned into that file's `Err`: a reader
/// that dies can never leave a file with empty text and no diagnostic. A worker
/// that dies outside the guard is caught by the join below, and every file that
/// came back without a result is reported as an error too.
fn read_all_with<R>(files: &[&InputFile], read: R) -> Vec<(String, Result<String, String>)>
where
    R: Fn(&str) -> Result<String, String> + Sync,
{
    if files.is_empty() {
        return Vec::new();
    }
    let workers = std::thread::available_parallelism().map(|count| count.get()).unwrap_or(4).min(files.len());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut results: Vec<(String, Result<String, String>)> = Vec::with_capacity(files.len());
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            handles.push(scope.spawn(|| {
                let mut mine: Vec<(String, Result<String, String>)> = Vec::new();
                loop {
                    let index = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let Some(file) = files.get(index) else { break };
                    let outcome =
                        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            read(&file.absolute)
                        })) {
                            Ok(outcome) => outcome,
                            Err(payload) => Err(panic_message(payload.as_ref())),
                        };
                    mine.push((file.relative.clone(), outcome));
                }
                mine
            }));
        }
        for handle in handles {
            match handle.join() {
                Ok(mine) => results.extend(mine),
                // A worker that panicked outside its guarded read leaves its files
                // without a result; the fill-in below reports them instead of
                // letting them reach the caller as empty text.
                Err(_) => {}
            }
        }
    });
    // Every requested file has a result, one per occurrence: a file a dead worker
    // never reached is an error, never a silent empty text.
    fill_unread(files, &mut results);
    // The results arrive in completion order; the caller keys them by path, so the
    // order only has to be deterministic for the read-error diagnostics. Sort by the
    // walk's order instead of a thread's.
    let order: HashMap<&str, usize> = files
        .iter()
        .enumerate()
        .map(|(index, file)| (file.relative.as_str(), index))
        .collect();
    results.sort_by_key(|(relative, _)| order.get(relative.as_str()).copied().unwrap_or(usize::MAX));
    results
}

/// Appends [`READER_PANIC`] for every requested file `results` has no outcome for,
/// one per occurrence.
fn fill_unread(files: &[&InputFile], results: &mut Vec<(String, Result<String, String>)>) {
    if results.len() == files.len() {
        return;
    }
    let mut unreported: HashMap<String, usize> = HashMap::new();
    for (relative, _) in results.iter() {
        *unreported.entry(relative.clone()).or_default() += 1;
    }
    for file in files {
        match unreported.get_mut(&file.relative) {
            Some(count) if *count > 0 => *count -= 1,
            _ => results.push((file.relative.clone(), Err(READER_PANIC.to_string()))),
        }
    }
}

/// The message a panic payload carries, for the file whose read panicked.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| READER_PANIC.to_string())
}

/// The text of `absolute`: `readFile(_, 'utf8')`, which replaces invalid sequences
/// rather than failing.
fn read_text(absolute: &str) -> Result<String, String> {
    match std::fs::read(absolute) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) => Err(error.to_string()),
    }
}

/// Walks `config.project_dir` depth-first, returning the files `include` matches and
/// `exclude` does not, sorted by their project-relative posix path. Port of
/// `walkFiles` in `packages/core/src/glob.ts`: directories named `node_modules` and
/// dot-directories are not entered, and an unreadable directory is reported rather
/// than thrown. The result is reported to the caller as `sources`.
fn walk_project(config: &RustConfig, diagnostics: &mut Vec<Diagnostic>) -> Vec<InputFile> {
    let root = Path::new(&config.project_dir);
    let mut found: Vec<InputFile> = Vec::new();
    visit(root, root, config, &mut found, diagnostics);
    found.sort_by(|a, b| compare_names(&a.relative, &b.relative));
    found
}

/// One directory of the walk.
fn visit(
    root: &Path,
    directory: &Path,
    config: &RustConfig,
    found: &mut Vec<InputFile>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        // One stable sentence, no platform text (finding 3, option (b)); the
        // matching comment in `packages/core/src/glob.ts` is the other half. Node
        // reports libuv's `EACCES: permission denied, scandir '<path>'` and Rust
        // reports `Permission denied (os error 13)`, and the two can never be
        // byte-identical on every platform: libuv's errno strings and the path
        // spelling differ (Windows reports the path with backslashes, and Rust's
        // std does not expose the errno constants that would name EPERM apart from
        // EACCES). Both backends therefore report the path alone; the diagnostic
        // code and the severity carry what failed.
        Err(_) => {
            diagnostics.push(create_diagnostic(DiagnosticInput::error(
                "FLM2001",
                format!("Cannot read directory \"{}\"", to_posix(&directory.to_string_lossy())),
                SourceLocation::config(),
            )));
            return;
        }
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut directories: Vec<std::path::PathBuf> = Vec::new();
    for name in names {
        let absolute = directory.join(&name);
        // `stat`, not `lstat`: a symlink to a file is a file, exactly as the
        // TypeScript walk sees it.
        let Ok(metadata) = std::fs::metadata(&absolute) else { continue };
        if metadata.is_file() {
            let relative = to_posix(&absolute.strip_prefix(root).unwrap_or(&absolute).to_string_lossy());
            if crate::glob::matches_any(&config.include, &relative)
                && !crate::glob::matches_any(&config.exclude, &relative)
            {
                found.push(InputFile {
                    relative,
                    absolute: to_posix(&absolute.to_string_lossy()),
                    size: metadata.len(),
                    mtime_ns: mtime_ns(&metadata),
                    text: None,
                });
            }
        } else if metadata.is_dir() && name != "node_modules" && !name.starts_with('.') {
            directories.push(absolute);
        }
    }
    for child in directories {
        visit(root, &child, config, found, diagnostics);
    }
}

/// Fragment name to its text as written, from the project index.
fn fragment_raws(
    documents: &[RawDocument],
    index: &DocumentIndex,
) -> HashMap<String, String> {
    index
        .fragments
        .iter()
        .filter_map(|(name, entry)| {
            documents
                .get(entry.document)
                .map(|document| (name.clone(), document.raw.clone()))
        })
        .collect()
}

/// A fingerprint of the project's `@list` registrations: they are the one piece of
/// the index that crosses documents, so a change invalidates every document.
fn list_fingerprint(index: &DocumentIndex) -> String {
    let mut entries: Vec<String> = index
        .lists
        .iter()
        .map(|(name, list)| format!("{name}:{}:{}", list.type_name, list.connection))
        .collect();
    entries.sort();
    entries.join("|")
}

/// True when `cached` still describes `document`: same text, and every fragment the
/// document inlines (before or after this run) has the same bytes.
fn can_reuse(
    document: &RawDocument,
    index: &DocumentIndex,
    cached: Option<&CachedIr>,
    previous_fragments: &HashMap<String, String>,
    current_fragments: &HashMap<String, String>,
) -> bool {
    let Some(cached) = cached else { return false };
    if cached.raw != document.raw {
        return false;
    }
    let mut used: Vec<String> =
        cached.ir.fragment_selections.iter().map(|(name, _)| name.clone()).collect();
    if let Some(definition) = document.ast.definitions.first() {
        used.extend(transitive_spreads(definition, index));
    }
    for name in &used {
        let previous = previous_fragments.get(name).cloned().unwrap_or_default();
        let current = current_fragments.get(name).cloned().unwrap_or_default();
        if previous != current {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The walk skips dot-directories and `node_modules`, and sorts its result.
    #[test]
    fn the_walk_matches_the_typescript_rules() {
        let root = std::env::temp_dir().join(format!("flamme-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src/nested")).expect("mkdir");
        std::fs::create_dir_all(root.join("node_modules/pkg")).expect("mkdir");
        std::fs::create_dir_all(root.join(".hidden")).expect("mkdir");
        std::fs::write(root.join("src/b.gql"), "query B { a }").expect("write");
        std::fs::write(root.join("src/a.gql"), "query A { a }").expect("write");
        std::fs::write(root.join("src/nested/c.gql"), "query C { a }").expect("write");
        std::fs::write(root.join("node_modules/pkg/d.gql"), "query D { a }").expect("write");
        std::fs::write(root.join(".hidden/e.gql"), "query E { a }").expect("write");
        std::fs::write(root.join("src/skip.gql"), "query F { a }").expect("write");

        let config = RustConfig {
            project_dir: to_posix(&root.to_string_lossy()),
            include: vec!["src/**/*.gql".into()],
            exclude: vec!["src/skip.gql".into()],
            ..RustConfig::default()
        };
        let mut diagnostics = Vec::new();
        let found = walk_project(&config, &mut diagnostics);
        let relatives: Vec<&str> = found.iter().map(|file| file.relative.as_str()).collect();
        assert_eq!(relatives, vec!["src/a.gql", "src/b.gql", "src/nested/c.gql"]);
        assert!(diagnostics.is_empty(), "a readable tree reports nothing");
        assert!(found.iter().all(|file| file.size > 0 && file.mtime_ns > 0));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `list_fingerprint` is the TypeScript fingerprint, sorted and joined.
    #[test]
    fn the_list_fingerprint_is_stable() {
        let index = DocumentIndex::default();
        assert_eq!(list_fingerprint(&index), "");
    }

    /// The cache's stamp is an integer, so the cache JSON round-trips it exactly. The
    /// millisecond spelling was an `f64`, and `serde_json`'s float parser is not
    /// round-trip exact: a modification time of 1789486246200.6343 ms parsed back one
    /// ULP higher, which made an unchanged file compare as changed and be re-read
    /// (`tests/session_cache.rs::an_unchanged_file_is_never_read_again`).
    #[test]
    fn the_cache_stamp_survives_the_json_round_trip() {
        let cache = SessionCache {
            files: vec![CachedFile {
                relative: "src/a.gql".into(),
                size: 3,
                mtime_ns: 1_789_486_246_200_634_300,
                residue: CachedFileResidue::default(),
            }],
            ..SessionCache::default()
        };
        let json = serde_json::to_string(&cache).expect("serialize the cache");
        let back: SessionCache = serde_json::from_str(&json).expect("parse the cache");
        assert_eq!(back.files[0].mtime_ns, cache.files[0].mtime_ns);
    }

    /// One input file with no caller text, as the walk builds them.
    fn input(relative: &str, absolute: &str) -> InputFile {
        InputFile {
            relative: relative.to_string(),
            absolute: absolute.to_string(),
            size: 0,
            mtime_ns: 0,
            text: None,
        }
    }

    /// A reader that panics is an `Err` for its own file, never silent empty text:
    /// every other file still gets its text and the walk order is kept.
    #[test]
    fn a_panicking_reader_is_an_error_not_empty_text() {
        let files = [input("src/a.gql", "/a"), input("src/b.gql", "/panic"), input("src/c.gql", "/c")];
        let refs: Vec<&InputFile> = files.iter().collect();
        let results = read_all_with(&refs, |absolute| {
            if absolute == "/panic" {
                panic!("the reader exploded");
            }
            Ok(format!("text of {absolute}"))
        });
        assert_eq!(
            results.iter().map(|(relative, _)| relative.as_str()).collect::<Vec<_>>(),
            vec!["src/a.gql", "src/b.gql", "src/c.gql"],
            "every requested file has a result, in walk order"
        );
        assert_eq!(results[0].1, Ok("text of /a".to_string()));
        assert_eq!(results[1].1, Err("the reader exploded".to_string()));
        assert_eq!(results[2].1, Ok("text of /c".to_string()));
    }

    /// A file with no result at all (a worker that died outside its guarded read) is
    /// an error, not an absent record the caller would read as empty text.
    #[test]
    fn a_file_without_a_result_is_an_error() {
        let files = [input("src/a.gql", "/a"), input("src/b.gql", "/b")];
        let refs: Vec<&InputFile> = files.iter().collect();
        let mut results = vec![("src/a.gql".to_string(), Ok("text of /a".to_string()))];
        fill_unread(&refs, &mut results);
        assert_eq!(results.len(), refs.len(), "every requested file has a result");
        assert_eq!(results[1].1, Err(READER_PANIC.to_string()));
    }
}
