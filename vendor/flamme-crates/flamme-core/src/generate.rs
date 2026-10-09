//! The compile driver: schema → discover → read → extract → prepare → validate → IR
//! → emit.
//!
//! Two entry points, one pipeline ([`crate::session`]):
//!
//! - [`compile`] takes every discovered file with its text, for a caller that walked
//!   and read the project itself (the parity oracle's shape);
//! - [`compile_project`] takes the project root and the include/exclude globs and
//!   walks, stats and reads the tree itself, on as many threads as the machine has.
//!
//! Both accept the previous run's cache (`CompileRequest::cache`), so a run compiles
//! only what changed and returns the tree it has to land. The plugin host, the
//! atomic writer with its rollback and tombstones, and route planning stay in
//! TypeScript.

use crate::diagnostics::{DiagnosticInput, SourceLocation, create_diagnostic};
use crate::request::{CompileRequest, CompileResponse};
use crate::session::{SessionRequest, compile_session, failure_response};

/// The `FLM2002` message `compile_project` rejects a request that carries `files`
/// with: the walk is what this entry point is for, and ignoring the caller's file
/// list silently would hide the mistake (see [`CompileRequest::files`]).
const REJECTED_FILES: &str =
    "the compileProject entry point walks the project; \"files\" must be absent";

/// Compiles one project from the files the caller discovered and read.
pub fn compile(request: &CompileRequest) -> CompileResponse {
    let files = request.files.clone().unwrap_or_default();
    let outcome = compile_session(SessionRequest {
        config: &request.config,
        schema: &request.schema,
        files: Some(files),
        cache: request.cache.clone(),
        read_texts: request
            .sources
            .as_ref()
            .map(|sources| sources.iter().cloned().collect()),
        options: &request.options,
        persisted_committed: request.persisted_committed.as_deref(),
        persisted_path: request.persisted_path.as_deref(),
        route_documents: request.route_documents.as_deref(),
    });
    outcome.response
}

/// Compiles one project by walking `config.project_dir` itself.
///
/// The request must not carry a file list (the contract of [`CompileRequest::files`]):
/// one that does is rejected with `FLM2002` instead of being walked, because the walk
/// is what makes a full run skip the TypeScript discovery and reading pass. An
/// unreadable directory is reported as `FLM2001`, exactly like the TypeScript walk.
pub fn compile_project(request: &CompileRequest) -> CompileResponse {
    if request.files.is_some() {
        return failure_response(create_diagnostic(DiagnosticInput::error(
            "FLM2002",
            REJECTED_FILES,
            SourceLocation::config(),
        )));
    }
    let outcome = compile_session(SessionRequest {
        config: &request.config,
        schema: &request.schema,
        files: None,
        cache: request.cache.clone(),
        read_texts: None,
        options: &request.options,
        persisted_committed: request.persisted_committed.as_deref(),
        persisted_path: request.persisted_path.as_deref(),
        route_documents: request.route_documents.as_deref(),
    });
    outcome.response
}
