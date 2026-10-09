//! The session's depth guard (`crates/flamme-core/src/depth.rs`).
//!
//! Recursion over a document is unavoidable in the parser, the IR, the emitter and
//! `serde_json`, and a stack overflow is not catchable: the guard has to refuse the
//! document before any of them descend into it. Two shapes reach the guard:
//!
//! - a document that nests past [`flamme_core::depth::MAX_SELECTION_DEPTH`] selection
//!   sets itself, reported as `FLM1049` and dropped while the rest of the project
//!   compiles;
//! - a chain of shallow fragments, each spreading the next, which nests two sets per
//!   definition and used to pass. Expanding it is what recurses: 701 documents in a
//!   chain killed the native compiler with SIGSEGV (exit 139), and a 400-document
//!   chain took 614 seconds. The limit is now measured on the expansion.

use std::fs;
use std::path::{Path, PathBuf};

use flamme_core::config::RustConfig;
use flamme_core::offsets::to_posix;
use flamme_core::request::{CompileOptions, CompileRequest, CompileResponse, SchemaInput};

/// The schema the chain fragments spread on: `me` is the operation's entry point.
const CHAIN_SCHEMA: &str =
    "type Query {\n  me: User!\n}\n\ntype User {\n  id: ID!\n  name: String!\n}\n";

/// The schema a document nests through: `User.friends` refers to itself.
const DEEP_SCHEMA: &str = "type Query {\n  me: User!\n}\n\ntype User {\n  id: ID!\n  friends: [User!]!\n}\n";

/// A scratch project directory with `src/` and `schema.graphql`, removed and rebuilt
/// per test.
fn scratch(name: &str, schema: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("flamme-depth-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("src")).expect("mkdir src");
    fs::write(root.join("schema.graphql"), schema).expect("write schema");
    root
}

/// Removes a scratch project (the tests run in one process, so each names its own).
fn dispose(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// One `compile_project` over the scratch project, walking and reading it itself.
fn compile(root: &Path, schema: &str) -> CompileResponse {
    let config = RustConfig {
        project_dir: to_posix(&root.to_string_lossy()),
        runtime_dir: to_posix(&root.join("generated").to_string_lossy()),
        include: vec!["src/**/*.gql".into()],
        ..RustConfig::default()
    };
    flamme_core::compile_project(&CompileRequest {
        config,
        schema: SchemaInput {
            sdl: schema.to_string(),
            file: to_posix(&root.join("schema.graphql").to_string_lossy()),
        },
        files: None,
        options: CompileOptions::default(),
        persisted_committed: None,
        persisted_path: None,
        cache: None,
        route_documents: None,
        sources: None,
    })
}

/// The codes of `response`, in diagnostic order.
fn codes(response: &CompileResponse) -> Vec<&str> {
    response.diagnostics.iter().map(|diagnostic| diagnostic.code.as_str()).collect()
}

/// `query Deep { me { friends { … id } } }` with exactly `depth` selection sets.
fn deep_document(depth: usize) -> String {
    let mut body = "id".to_string();
    for _ in 2..depth {
        body = format!("friends {{ {body} }}");
    }
    format!("query Deep {{ me {{ {body} }} }}\n")
}

/// One chain project: the operation that reaches the chain and `count` fragments,
/// each spreading the next.
fn write_chain(root: &Path, count: usize) {
    fs::write(root.join("src/Chain.gql"), "query Chain {\n  me {\n    ...F1\n  }\n}\n")
        .expect("write operation");
    for level in 1..=count {
        let body =
            if level == count { "  id\n".to_string() } else { format!("  id\n  ...F{}\n", level + 1) };
        fs::write(
            root.join(format!("src/F{level}.gql")),
            format!("fragment F{level} on User {{\n{body}}}\n"),
        )
        .expect("write fragment");
    }
}

/// The guard block in the session: an over-deep document is reported with its own
/// measured depth and dropped, and the documents around it still compile.
///
/// The document nests 200 sets, not the 700 of the finding: this test runs the debug
/// parser, whose own recursion overflows between 600 and 1000 (`MAX_PARSE_NESTING`),
/// and the release module the TypeScript suite drives is what pins the 700 case.
#[test]
fn a_document_past_the_limit_is_reported_and_dropped() {
    let root = scratch("plain", DEEP_SCHEMA);
    fs::write(root.join("src/Deep.gql"), deep_document(200)).expect("write deep");
    fs::write(root.join("src/Sibling.gql"), "query Sibling {\n  me {\n    id\n  }\n}\n")
        .expect("write sibling");
    let response = compile(&root, DEEP_SCHEMA);
    assert_eq!(codes(&response), vec!["FLM1049"], "the deep document is the only error");
    let message = &response.diagnostics[0].message;
    assert!(
        message.contains("the document \"Deep\" nests 200 selection sets deep")
            && message.contains("the compiler's limit is 128."),
        "{message}"
    );
    assert_eq!(
        response.diagnostics[0].hint.as_deref(),
        Some("split the chain across fragments so no definition nests deeper than 128 selection sets.")
    );
    // The document is dropped, not compiled: it is gone from the extraction the
    // response reports while its sibling stays. The error stops the run before the IR,
    // exactly as an unparsable document does, so nothing is emitted at all.
    let documents: Vec<&str> =
        response.documents.iter().map(|document| document.name.as_str()).collect();
    assert_eq!(documents, vec!["Sibling"], "only the deep document left the run");
    assert!(response.artifacts.is_empty(), "the run failed before the IR");
    assert!(response.files.is_empty(), "nothing is emitted");
    // The sources are still reported: the walk read the file the guard refused.
    let sources: Vec<&str> = response.sources.iter().map(|file| file.relative.as_str()).collect();
    assert_eq!(sources, vec!["src/Deep.gql", "src/Sibling.gql"]);
    dispose(&root);
}

/// The finding: 701 documents in one spread chain used to kill the process. The
/// guard has to report them and stop before anything expands the chain.
#[test]
fn a_spread_chain_past_the_limit_is_reported_not_crashed() {
    let root = scratch("chain", CHAIN_SCHEMA);
    write_chain(&root, 701);
    let response = compile(&root, CHAIN_SCHEMA);
    let codes = codes(&response);
    assert!(
        codes.contains(&"FLM1049"),
        "the chain is reported as over the depth limit, got {:?}",
        &codes[..codes.len().min(8)]
    );
    // The first fragment carries the whole chain below it, so its own expansion is
    // the 701 documents, and the operation that reaches it is deeper still. The
    // message names the expansion, not the two selection sets the file is written as.
    let deepest = response
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "FLM1049")
        .map(|diagnostic| diagnostic.message.clone())
        .find(|message| message.contains("the document \"F1\""))
        .expect("the first fragment of the chain is over the limit");
    assert!(
        deepest.contains("reaches 701 selection sets deep once its fragment spreads are expanded"),
        "{deepest}"
    );
    // The run stopped at the guard: nothing was expanded, so no artifact exists and
    // no tree was emitted.
    assert!(response.artifacts.is_empty(), "no artifact survives the guard");
    assert!(response.files.is_empty(), "nothing is emitted");
    dispose(&root);
}

/// A chain below the limit is an ordinary project: the guard measures the expansion
/// without rejecting it, and every document still compiles.
#[test]
fn a_spread_chain_below_the_limit_still_compiles() {
    let root = scratch("below", CHAIN_SCHEMA);
    write_chain(&root, 30);
    let response = compile(&root, CHAIN_SCHEMA);
    assert!(
        !codes(&response).contains(&"FLM1049"),
        "a 30-fragment chain is under the limit: {:?}",
        codes(&response)
    );
    assert!(response.diagnostics.is_empty(), "{:?}", codes(&response));
    // The operation plus every fragment.
    assert_eq!(response.artifacts.len(), 31);
    dispose(&root);
}
