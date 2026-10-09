//! The routing-document exemption and the configured document extensions.
//!
//! A colocated page document is never imported by path, so one per page directory is
//! legal and `FLM1010` must not fire for it. The exemption has to name every spelling
//! the configured extensions imply: with the default `documentExtensions` of `.gql`
//! and `.graphql`, a project may hold `src/pages/a/+page.graphql` and
//! `src/pages/b/+page.graphql`, and a list naming only `+page.gql` reports
//! `Ambiguous document filename "+page.graphql"` for a legal project. The TypeScript
//! half is `packages/core/test/routing-documents.test.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use flamme_core::offsets::to_posix;
use flamme_core::request::{CompileOptions, CompileRequest, SchemaInput};
use flamme_core::RustConfig;

/// A schema with one keyed type, so the page queries compile cleanly.
const SCHEMA: &str = "type Query {\n  species(id: Int!): Species\n}\n\ntype Species {\n  id: ID!\n  name: String!\n}\n";

/// The two page documents, both spelled `+page.graphql`, in two directories.
const PAGE_A: &str = "query A {\n  species(id: 1) {\n    id\n  }\n}\n";
const PAGE_B: &str = "query B {\n  species(id: 2) {\n    id\n  }\n}\n";

/// A scratch project with a page document per directory, rebuilt per test.
fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("flamme-routing-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("server")).expect("mkdir server");
    fs::create_dir_all(root.join("src/pages/a")).expect("mkdir a");
    fs::create_dir_all(root.join("src/pages/b")).expect("mkdir b");
    fs::write(root.join("server/schema.graphql"), SCHEMA).expect("write schema");
    fs::write(root.join("src/pages/a/+page.graphql"), PAGE_A).expect("write page a");
    fs::write(root.join("src/pages/b/+page.graphql"), PAGE_B).expect("write page b");
    root
}

/// Removes a scratch project (the tests run in one process, so each names its own).
fn dispose(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// The request one test runs: the scratch project walked by `compile_project`.
fn request(root: &Path) -> CompileRequest {
    CompileRequest {
        route_documents: None,
        config: RustConfig {
            project_dir: to_posix(&root.to_string_lossy()),
            runtime_dir: to_posix(&root.join("generated").to_string_lossy()),
            include: vec!["src/**/*.graphql".into()],
            ..RustConfig::default()
        },
        schema: SchemaInput { sdl: SCHEMA.into(), file: "server/schema.graphql".into() },
        files: None,
        options: CompileOptions::default(),
        persisted_committed: None,
        persisted_path: None,
        cache: None,
        sources: None,
    }
}

/// The `FLM1010` code of one response, as a list.
fn codes(response: &flamme_core::CompileResponse) -> Vec<&str> {
    response.diagnostics.iter().map(|diagnostic| diagnostic.code.as_str()).collect()
}

/// Two `+page.graphql` documents in two directories are the routing convention's own
/// files, not an ambiguous pair.
#[test]
fn two_page_documents_with_the_graphql_extension_are_not_ambiguous() {
    let root = scratch("page-graphql");
    let response = flamme_core::compile_project(&request(&root));
    assert!(
        !codes(&response).contains(&"FLM1010"),
        "a legal project reports no FLM1010: {:?}",
        codes(&response)
    );
    assert!(response.diagnostics.is_empty(), "and nothing else: {:?}", codes(&response));
    let mut names: Vec<&str> =
        response.artifacts.iter().map(|artifact| artifact.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["A", "B"], "both page documents compile");
    dispose(&root);
}

/// The exemption covers the convention's own file names, not a basename collision
/// between documents a project wrote by hand: `FLM1010` still fires for those.
#[test]
fn two_hand_written_documents_of_one_basename_are_still_ambiguous() {
    let root = scratch("hand-written");
    fs::create_dir_all(root.join("src/a")).expect("mkdir a");
    fs::create_dir_all(root.join("src/b")).expect("mkdir b");
    // Different document names, so the only rule in play is the basename collision.
    fs::write(root.join("src/a/Info.graphql"), "query HandA {\n  species(id: 3) {\n    id\n  }\n}\n")
        .expect("write a");
    fs::write(root.join("src/b/Info.graphql"), "query HandB {\n  species(id: 4) {\n    id\n  }\n}\n")
        .expect("write b");    let response = flamme_core::compile_project(&request(&root));
    assert_eq!(codes(&response), vec!["FLM1010"], "the ambiguity is reported");
    dispose(&root);
}
