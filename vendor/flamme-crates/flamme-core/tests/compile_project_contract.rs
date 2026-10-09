//! The contracts of the two entry points, on the Rust side.
//!
//! `compile_project` walks the project itself, so a request that carries a file
//! list is rejected rather than silently walked (`CompileRequest::files` says the
//! field must be absent), and a directory the walk cannot read is reported with the
//! one stable message both backends use. The TypeScript half of the walk fixture is
//! `packages/core/test/walk-permissions.test.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use flamme_core::diagnostics::{Diagnostic, Severity, SourceLocation};
use flamme_core::extract::SourceFile;
use flamme_core::offsets::to_posix;
use flamme_core::request::{CompileOptions, CompileRequest, SchemaInput};
use flamme_core::RustConfig;

/// A schema with one field, so a project with one query compiles cleanly.
const SCHEMA: &str = "type Query {\n  ok: Boolean!\n}\n";

/// The one document of the scratch project.
const QUERY: &str = "query A {\n  ok\n}\n";

/// A scratch project (`server/schema.graphql` plus `src/A.gql`), rebuilt per test.
fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("flamme-entry-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("server")).expect("mkdir server");
    fs::create_dir_all(root.join("src")).expect("mkdir src");
    fs::write(root.join("server/schema.graphql"), SCHEMA).expect("write schema");
    fs::write(root.join("src/A.gql"), QUERY).expect("write query");
    root
}

/// Removes a scratch project (the tests run in one process, so each names its own).
fn dispose(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// The request one test runs, with the file list the test wants the request to carry.
fn request(root: &Path, files: Option<Vec<SourceFile>>) -> CompileRequest {
    CompileRequest {
        route_documents: None,
        config: RustConfig {
            project_dir: to_posix(&root.to_string_lossy()),
            runtime_dir: to_posix(&root.join("generated").to_string_lossy()),
            include: vec!["src/**/*.gql".into()],
            ..RustConfig::default()
        },
        schema: SchemaInput { sdl: SCHEMA.into(), file: "server/schema.graphql".into() },
        files,
        options: CompileOptions::default(),
        persisted_committed: None,
        persisted_path: None,
        cache: None,
        sources: None,
    }
}

/// `compile_project` rejects a request that carries a file list: the walk is what
/// this entry point is for, and ignoring the field silently would hide the mistake.
#[test]
fn a_request_that_carries_files_is_rejected() {
    let root = scratch("files-present");
    let response = flamme_core::compile_project(&request(
        &root,
        Some(vec![SourceFile {
            relative: "src/A.gql".into(),
            absolute: to_posix(&root.join("src/A.gql").to_string_lossy()),
            text: QUERY.into(),
            size: 0,
            mtime_ms: 0.0,
        }]),
    ));
    assert_eq!(response.diagnostics.len(), 1, "the rejection is the only diagnostic");
    let diagnostic = &response.diagnostics[0];
    assert_eq!(diagnostic.code, "FLM2002");
    assert_eq!(diagnostic.severity, Severity::Error);
    assert_eq!(
        diagnostic.message,
        "the compileProject entry point walks the project; \"files\" must be absent"
    );
    assert_eq!(diagnostic.location, SourceLocation::config());
    assert!(response.sources.is_empty(), "a rejected request walks nothing");
    assert!(response.files.is_empty(), "a rejected request emits nothing");
    dispose(&root);
}

/// The same request without the field still walks the project and compiles it.
#[test]
fn a_request_without_files_still_walks() {
    let root = scratch("files-absent");
    let response = flamme_core::compile_project(&request(&root, None));
    let relatives: Vec<&str> = response.sources.iter().map(|file| file.relative.as_str()).collect();
    assert_eq!(relatives, vec!["src/A.gql"], "the walk found the project's one file");
    assert_eq!(
        response.artifacts.iter().map(|artifact| artifact.name.as_str()).collect::<Vec<_>>(),
        vec!["A"]
    );
    assert!(
        response.diagnostics.iter().all(|diagnostic| diagnostic.code != "FLM2002"),
        "the walk ran: {:?}",
        response.diagnostics
    );
    dispose(&root);
}

/// A directory the walk cannot read is reported as `FLM2001` with the one message
/// both backends use: `Cannot read directory "<path>"`, with no platform text.
#[cfg(unix)]
#[test]
fn an_unreadable_directory_reports_the_stable_message() {
    use std::os::unix::fs::PermissionsExt;

    let root = scratch("unreadable");
    let locked = root.join("src/locked");
    fs::create_dir_all(&locked).expect("mkdir locked");
    fs::write(locked.join("B.gql"), "query B {\n  ok\n}\n").expect("write locked query");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod 0o000");
    // Running as root bypasses permission bits (`geteuid() == 0`): the directory
    // stays readable and there is no diagnostic to assert. `read_dir` is the
    // portable form of that check, and it also covers CAP_DAC_OVERRIDE.
    if fs::read_dir(&locked).is_ok() {
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("restore");
        dispose(&root);
        return;
    }

    let response = flamme_core::compile_project(&request(&root, None));
    let found: Vec<&Diagnostic> =
        response.diagnostics.iter().filter(|entry| entry.code == "FLM2001").collect();
    assert_eq!(found.len(), 1, "one unreadable directory, one diagnostic");
    assert_eq!(found[0].severity, Severity::Error);
    assert_eq!(found[0].location, SourceLocation::config());
    assert_eq!(
        found[0].message,
        format!("Cannot read directory \"{}\"", to_posix(&locked.to_string_lossy())),
        "the message is the TypeScript walk's message, byte for byte"
    );
    // The readable half of the project is still discovered.
    assert_eq!(
        response.sources.iter().map(|file| file.relative.as_str()).collect::<Vec<_>>(),
        vec!["src/A.gql"]
    );

    // Restore the bits before removing: `remove_dir_all` must descend into the
    // directory, which mode 0 forbids.
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("restore");
    dispose(&root);
}
