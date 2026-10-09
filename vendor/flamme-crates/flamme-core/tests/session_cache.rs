//! The incremental session (`crates/flamme-core/src/session.rs`): a Rust walk, a
//! Rust read and a Rust cache must reproduce the TypeScript compiler's tree and
//! diagnostics on a cold run and after an edit.
//!
//! Every test builds a scratch project on disk, compiles it with `compile_project`
//! (a walk, a read and a cache of its own) and compares the tree and the diagnostics
//! byte for byte against `tests/fixtures/frozen/session_cache.json`: the verbatim
//! TypeScript runs over the same scratch project in its cold, edited, re-read and
//! deleted states, captured before `packages/core/src` was deleted. The session's
//! cache can never silently change what the compiler emits.

mod support;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use flamme_core::config::RustConfig;
use flamme_core::diagnostics::Diagnostic;
use flamme_core::request::{CompileOptions, CompileRequest, CompileResponse, SchemaInput};
use flamme_core::session::{SessionCache, SessionOutcome};
use support::{diagnostic_keys, tree_of, write_tree};

/// The project every test compiles: one fragment, one operation that spreads it and
/// one that does not, so a fragment edit has exactly one parent to rebuild.
const SCHEMA: &str = "type Query {\n  species(id: Int!): Species\n}\n\ntype Species {\n  id: Int!\n  name: String!\n  flavor: String!\n}\n";
const FRAGMENT: &str = "fragment SpeciesFields on Species {\n  id\n  name\n}\n";
const PARENT: &str = "query Parent {\n  species(id: 1) {\n    ...SpeciesFields\n  }\n}\n";
const SIBLING: &str = "query Sibling {\n  species(id: 2) {\n    id\n  }\n}\n";

/// What the TypeScript compiler produced for the scratch project in each state.
struct Expectations {
    /// The resolved config of the frozen run, with its `projectDir`/`runtimeDir`
    /// replaced per test.
    config: RustConfig,
    /// The schema SDL of the frozen run.
    schema: SchemaInput,
    /// The cold project's tree.
    cold_files: BTreeMap<String, String>,
    /// The cold project's diagnostics.
    cold_diagnostics: Vec<Diagnostic>,
    /// The tree after the fragment edit.
    edited_files: BTreeMap<String, String>,
    /// The diagnostics after the fragment edit.
    edited_diagnostics: Vec<Diagnostic>,
    /// The diagnostics after an unannounced rewrite of `src/Sibling.gql`.
    sibling_added_diagnostics: Vec<Diagnostic>,
    /// The diagnostics after `src/Sibling.gql` is deleted.
    sibling_deleted_diagnostics: Vec<Diagnostic>,
}

/// The frozen expectations, read once per test binary.
fn expectations() -> &'static Expectations {
    static EXPECTATIONS: OnceLock<Expectations> = OnceLock::new();
    EXPECTATIONS.get_or_init(|| {
        let snapshot = support::frozen("session_cache");
        let config: RustConfig = serde_json::from_value(snapshot["config"].clone())
            .expect("the frozen config deserializes");
        let schema: SchemaInput = serde_json::from_value(snapshot["schema"].clone())
            .expect("the frozen schema deserializes");
        let files = |state: &str| -> BTreeMap<String, String> {
            snapshot[state]["files"]
                .as_object()
                .expect("the state has a file map")
                .iter()
                .map(|(path, contents)| {
                    (path.clone(), contents.as_str().expect("contents").to_string())
                })
                .collect()
        };
        let diagnostics = |state: &str| -> Vec<Diagnostic> {
            serde_json::from_value(snapshot[state]["diagnostics"].clone())
                .expect("the state's diagnostics deserialize")
        };
        Expectations {
            config,
            schema,
            cold_files: files("cold"),
            cold_diagnostics: diagnostics("cold"),
            edited_files: files("edited"),
            edited_diagnostics: diagnostics("edited"),
            sibling_added_diagnostics: diagnostics("sibling_added"),
            sibling_deleted_diagnostics: diagnostics("sibling_deleted"),
        }
    })
}

/// A scratch project with the three documents, removed and rebuilt per test.
fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("flamme-session-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("server")).expect("mkdir server");
    fs::create_dir_all(root.join("src")).expect("mkdir src");
    fs::write(root.join("server/schema.graphql"), SCHEMA).expect("write schema");
    fs::write(
        root.join("flamme.config.json"),
        "{\n  \"schemaPath\": \"./server/schema.graphql\",\n  \"include\": [\"src/**/*.{vue,ts,graphql,gql}\"],\n  \"exclude\": [\"server/schema.graphql\"]\n}\n",
    )
    .expect("write config");
    fs::write(root.join("src/Frag.gql"), FRAGMENT).expect("write fragment");
    fs::write(root.join("src/Parent.gql"), PARENT).expect("write parent");
    fs::write(root.join("src/Sibling.gql"), SIBLING).expect("write sibling");
    root
}

/// Removes a scratch project (the tests run in one process, so each names its own).
fn dispose(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// The request one test runs: the frozen run's resolved config and schema, pointed
/// at the scratch project and a runtime directory outside it.
fn request(
    config: &RustConfig,
    schema: &SchemaInput,
    project: &Path,
    runtime: &Path,
    cache: Option<&str>,
    files: Option<Vec<String>>,
) -> CompileRequest {
    let mut config = config.clone();
    config.project_dir = project.to_string_lossy().to_string();
    config.runtime_dir = runtime.to_string_lossy().to_string();
    CompileRequest {
        route_documents: None,
        config,
        schema: schema.clone(),
        files: None,
        options: CompileOptions {
            files,
            save_cache: true,
            ..CompileOptions::default()
        },
        persisted_committed: None,
        persisted_path: None,
        cache: cache.map(str::to_string),
        sources: None,
    }
}

/// The runtime directory of one scratch project.
fn runtime_of(root: &Path) -> PathBuf {
    root.join("generated")
}

/// The scratch project of one test and the first (cold) run over it.
struct Session {
    root: PathBuf,
    runtime: PathBuf,
    first: CompileResponse,
}

/// Runs the cold half of a test: the project on disk and one `compile_project` that
/// walks the tree itself.
fn cold(name: &str) -> Session {
    let root = scratch(name);
    let runtime = runtime_of(&root);
    let first = flamme_core::compile_project(&request(
        &expectations().config,
        &expectations().schema,
        &root,
        &runtime,
        None,
        None,
    ));
    Session { root, runtime, first }
}

#[test]
fn a_walked_run_matches_the_frozen_tree_and_diagnostics() {
    let session = cold("cold");
    assert_eq!(session.first.compiled.len(), session.first.artifacts.len());
    assert_eq!(
        session.first.compiled,
        vec!["SpeciesFields", "Parent", "Sibling"],
        "a cold run compiles every document, in extraction order"
    );
    assert_eq!(tree_of(&session.first), expectations().cold_files, "cold tree");
    assert_eq!(
        diagnostic_keys(&session.first.diagnostics),
        diagnostic_keys(&expectations().cold_diagnostics),
        "cold diagnostics"
    );
    let sources: Vec<&str> =
        session.first.sources.iter().map(|file| file.relative.as_str()).collect();
    assert_eq!(sources, vec!["src/Frag.gql", "src/Parent.gql", "src/Sibling.gql"]);
    assert!(
        session.first.sources.iter().all(|file| !file.text.is_empty()),
        "the walk reads what it returns"
    );
    dispose(&session.root);
}

#[test]
fn a_second_run_with_the_cache_rebuilds_nothing_and_emits_nothing_new() {
    let session = cold("cache");
    let cache = session.first.cache_state.clone().expect("the cold run caches");
    // The cold run's tree is on disk, which is the state an incremental run starts
    // from: only the aggregates are left to emit.
    write_tree(&session.runtime, &tree_of(&session.first));
    let second = flamme_core::compile_project(&request(
        &expectations().config,
        &expectations().schema,
        &session.root,
        &session.runtime,
        Some(&cache),
        Some(Vec::new()),
    ));
    assert!(second.compiled.is_empty(), "nothing changed, so nothing is rebuilt");
    assert_eq!(
        diagnostic_keys(&second.diagnostics),
        diagnostic_keys(&expectations().cold_diagnostics)
    );
    for file in &second.files {
        let on_disk = fs::read_to_string(session.runtime.join(&file.path)).expect("on disk");
        assert_eq!(on_disk, file.contents, "a re-emitted file keeps its bytes: {}", file.path);
    }
    assert!(
        second.files.iter().all(|file| !file.path.starts_with("artifacts/")),
        "every artifact is re-used and already on disk"
    );
    assert_eq!(second.artifacts.len(), 3, "the response still describes every document");
    dispose(&session.root);
}

#[test]
fn an_edited_fragment_rebuilds_it_and_its_parent_only() {
    let session = cold("edit");
    let cache = session.first.cache_state.clone().expect("the cold run caches");
    write_tree(&session.runtime, &tree_of(&session.first));
    let edited = "fragment SpeciesFields on Species {\n  id\n  name\n  flavor\n}\n".to_string();
    fs::write(session.root.join("src/Frag.gql"), &edited).expect("write edit");
    let second = flamme_core::compile_project(&request(
        &expectations().config,
        &expectations().schema,
        &session.root,
        &session.runtime,
        Some(&cache),
        Some(vec!["src/Frag.gql".to_string()]),
    ));
    assert_eq!(second.compiled, vec!["SpeciesFields", "Parent"], "the fragment and its parent");
    // The same edit compiled from scratch by the TypeScript compiler, frozen: the
    // incremental tree has to describe the same project, whichever documents a run
    // happened to rebuild. The artifacts the run re-used are the ones already on
    // disk; the ones it rebuilt come from the response.
    let fresh = &expectations().edited_files;
    let mut incremental: BTreeMap<String, String> = fs::read_dir(session.runtime.join("artifacts"))
        .expect("artifacts")
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let contents = fs::read_to_string(entry.path()).expect("artifact contents");
            (format!("artifacts/{name}"), contents)
        })
        .collect();
    for file in &second.files {
        incremental.insert(file.path.clone(), file.contents.clone());
    }
    for (path, expected) in fresh {
        assert_eq!(incremental.get(path), Some(expected), "incremental tree: {path}");
    }
    assert_eq!(
        diagnostic_keys(&second.diagnostics),
        diagnostic_keys(&expectations().edited_diagnostics)
    );
    dispose(&session.root);
}

#[test]
fn an_unchanged_file_is_never_read_again() {
    let session = cold("unread");
    let cache = session.first.cache_state.clone().expect("the cold run caches");
    write_tree(&session.runtime, &tree_of(&session.first));
    // A same-size rewrite with the old modification time: the stamp still matches, so
    // the cache must serve the file without reading it. Nothing may notice the bytes.
    let target = session.root.join("src/Sibling.gql");
    let stamp = fs::metadata(&target).expect("stat").modified().expect("mtime");
    let original = fs::read_to_string(&target).expect("read");
    let poisoned = original.replace("Sibling", "PoisonX");
    assert_eq!(poisoned.len(), original.len(), "the poison keeps the size");
    fs::write(&target, &poisoned).expect("write");
    fs::File::options()
        .write(true)
        .open(&target)
        .expect("open")
        .set_modified(stamp)
        .expect("set mtime");
    // A real edit to the fragment, so the change set is honest and the run rebuilds
    // the one document the fragment reaches.
    fs::write(
        session.root.join("src/Frag.gql"),
        "fragment SpeciesFields on Species {\n  id\n  name\n  flavor\n}\n",
    )
    .expect("write edit");
    let second = flamme_core::compile_project(&request(
        &expectations().config,
        &expectations().schema,
        &session.root,
        &session.runtime,
        Some(&cache),
        Some(vec!["src/Frag.gql".to_string()]),
    ));
    // The observable is the set the run rebuilt and the text it compiled from, never
    // the stamp itself: the sibling is re-used, so it is not in `compiled` and the
    // text the run reports for it is the cached one, not the poison on disk.
    assert_eq!(second.compiled, vec!["SpeciesFields", "Parent"], "the sibling is untouched");
    let artifact_names: Vec<&str> =
        second.artifacts.iter().map(|artifact| artifact.name.as_str()).collect();
    assert_eq!(artifact_names, vec!["SpeciesFields", "Parent", "Sibling"]);
    let reused: Vec<&str> = artifact_names
        .iter()
        .copied()
        .filter(|name| !second.compiled.iter().any(|compiled| compiled == name))
        .collect();
    assert_eq!(reused, vec!["Sibling"], "the sibling was served from the cache");
    let sibling_source = second
        .sources
        .iter()
        .find(|file| file.relative == "src/Sibling.gql")
        .expect("the sibling is a source");
    assert_eq!(sibling_source.text, SIBLING, "the poisoned bytes were never read");
    let sibling = fs::read_to_string(session.runtime.join("artifacts/Sibling.ts")).expect("artifact");
    assert!(sibling.contains("Sibling"), "the artifact still carries the cached document");
    assert!(!sibling.contains("PoisonX"));
    dispose(&session.root);
}

#[test]
fn a_rewrite_the_change_set_misses_is_still_re_read() {
    let session = cold("missed");
    let cache = session.first.cache_state.clone().expect("the cold run caches");
    write_tree(&session.runtime, &tree_of(&session.first));
    let target = session.root.join("src/Sibling.gql");
    fs::write(&target, SIBLING.replace("    id\n", "    id\n    name\n")).expect("write");
    // `files: []` claims nothing changed; the stamp says otherwise, and the stamp wins.
    let second = flamme_core::compile_project(&request(
        &expectations().config,
        &expectations().schema,
        &session.root,
        &session.runtime,
        Some(&cache),
        Some(Vec::new()),
    ));
    assert_eq!(second.compiled, vec!["Sibling"]);
    assert_eq!(
        diagnostic_keys(&second.diagnostics),
        diagnostic_keys(&expectations().sibling_added_diagnostics),
        "the re-read file's project still matches the frozen expectation"
    );
    dispose(&session.root);
}

#[test]
fn a_deleted_file_drops_its_document() {
    let session = cold("delete");
    let cache = session.first.cache_state.clone().expect("the cold run caches");
    write_tree(&session.runtime, &tree_of(&session.first));
    fs::remove_file(session.root.join("src/Sibling.gql")).expect("remove");
    let second = flamme_core::compile_project(&request(
        &expectations().config,
        &expectations().schema,
        &session.root,
        &session.runtime,
        Some(&cache),
        Some(vec!["src/Sibling.gql".to_string()]),
    ));
    let names: Vec<&str> = second.artifacts.iter().map(|artifact| artifact.name.as_str()).collect();
    assert_eq!(names, vec!["SpeciesFields", "Parent"], "the deleted document is gone");
    assert!(
        second.files.iter().all(|file| file.path != "artifacts/Sibling.ts"),
        "its artifact is not re-emitted"
    );
    assert_eq!(
        diagnostic_keys(&second.diagnostics),
        diagnostic_keys(&expectations().sibling_deleted_diagnostics)
    );
    let cache: SessionCache = serde_json::from_str(&second.cache_state.expect("cache")).expect("json");
    assert_eq!(cache.files.len(), 2, "the deleted file left the cache");
    dispose(&session.root);
}

#[test]
fn a_non_utf8_file_is_read_the_way_node_reads_it() {
    let session = cold("utf8");
    let cache = session.first.cache_state.clone().expect("the cold run caches");
    // An invalid byte becomes U+FFFD, exactly as `readFile(_, 'utf8')` replaces it,
    // instead of failing the read. It sits in a comment, so the document still parses
    // and the text that reaches the compiler is the one Node would produce.
    fs::write(
        session.root.join("src/Sibling.gql"),
        b"query Sibling { species(id: 2) { id } }\n# \xff\n",
    )
    .expect("write");
    let second = flamme_core::compile_project(&request(
        &expectations().config,
        &expectations().schema,
        &session.root,
        &session.runtime,
        Some(&cache),
        Some(vec!["src/Sibling.gql".to_string()]),
    ));
    assert!(second.compiled.contains(&"Sibling".to_string()));
    let text = &second.sources.iter().find(|file| file.relative == "src/Sibling.gql").expect("source").text;
    assert!(text.contains('\u{fffd}'), "the invalid byte is replaced, not fatal");
    dispose(&session.root);
}

/// `set_modified` is what makes the stamp tests possible; this is the guard that the
/// system supports it.
#[test]
fn the_filesystem_reports_a_settable_modification_time() {
    let root = scratch("stamp");
    let file = root.join("src/Sibling.gql");
    let stamp: SystemTime = fs::metadata(&file).expect("stat").modified().expect("mtime");
    fs::File::options().write(true).open(&file).expect("open").set_modified(stamp).expect("set");
    assert_eq!(fs::metadata(&file).expect("stat").modified().expect("mtime"), stamp);
    dispose(&root);
}

/// One `compile_session` over the standard scratch project with `save_cache` as
/// written, for the two tests below.
fn session_with(name: &str, save_cache: bool) -> (PathBuf, SessionOutcome) {
    let root = scratch(name);
    let runtime = runtime_of(&root);
    let mut request = request(
        &expectations().config,
        &expectations().schema,
        &root,
        &runtime,
        None,
        None,
    );
    request.options.save_cache = save_cache;
    let outcome = flamme_core::compile_session(flamme_core::SessionRequest {
        config: &request.config,
        schema: &request.schema,
        files: None,
        cache: None,
        read_texts: None,
        options: &request.options,
        persisted_committed: None,
        persisted_path: None,
        route_documents: None,
    });
    (root, outcome)
}

/// `save_cache: false` is honoured: the CLI and a one-off `check` have no cache to
/// keep, so the state is neither built nor serialized into the response. The state
/// carries the IR of every document, which is most of the response's bytes.
#[test]
fn save_cache_false_builds_and_serializes_no_state() {
    let (root, outcome) = session_with("save-cache-off", false);
    assert!(outcome.cache.is_none(), "no state is built");
    assert!(outcome.response.cache_state.is_none(), "and none is serialized");
    let json = serde_json::to_string(&outcome.response).expect("serialize the response");
    assert!(!json.contains("cacheState"), "the response carries no cache key at all");
    // Only the state is skipped: the compile itself is unchanged.
    assert_eq!(
        tree_of(&outcome.response),
        expectations().cold_files,
        "the tree is still the frozen one"
    );
    assert_eq!(
        diagnostic_keys(&outcome.response.diagnostics),
        diagnostic_keys(&expectations().cold_diagnostics)
    );
    dispose(&root);
}

/// `save_cache: true` still reports the state the next run continues from.
#[test]
fn save_cache_true_still_reports_the_state() {
    let (root, outcome) = session_with("save-cache-on", true);
    assert!(outcome.cache.is_some(), "the state is built");
    let state = outcome.response.cache_state.as_deref().expect("the state is serialized");
    let parsed: SessionCache = serde_json::from_str(state).expect("the state parses back");
    assert_eq!(parsed.documents.len(), 3, "every document's IR is in it");
    dispose(&root);
}
