//! The napi-rs binding for the Flamme Rust compiler.
//!
//! Two JSON-in/JSON-out entry points over one pipeline:
//!
//! - `compile(requestJson) -> responseJson` takes the discovered files with their
//!   text, for a caller that walked and read the project itself;
//! - `compileProject(requestJson) -> responseJson` takes the resolved config (its
//!   `projectDir`, `runtimeDir` and include/exclude globs) and walks, stats and reads
//!   the project itself.
//!
//! Both carry the resolved config, the SDL, the run options and the previous run's
//! cache, and both return the tree the run has to land plus the diagnostics, the
//! artifact metadata and the cache state the next run continues from. Keeping the
//! boundary at JSON rather than at napi objects means the native module has no
//! JavaScript-facing types to keep in sync, and the TypeScript side owns
//! serialization.

use napi_derive::napi;

/// The crate version, reported by `flamme --version` diagnostics and by tests.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Compiles one project from the files the caller discovered and read.
///
/// `request_json` is a `flamme_core::request::CompileRequest`; the return value is
/// the `CompileResponse` of the same crate. A malformed request throws a
/// JavaScript `Error` carrying the serde message, which the TypeScript caller
/// reports as an `FLM2002`-shaped failure rather than crashing the process.
///
/// The body runs inside `catch_unwind`: a panic in the compiler must surface as a
/// JavaScript exception the caller can fall back from, never as an abort that takes
/// the build (or the dev server) down with it.
#[napi]
pub fn compile(request_json: String) -> napi::Result<String> {
    guarded(&request_json, flamme_core::compile)
}

/// Compiles one project by walking its `projectDir` itself.
///
/// The request is the same shape; its `files` must be absent, because the walk is
/// what this entry point is for (`flamme_core::request::CompileRequest::files` states
/// the contract, and a request that carries the field is rejected with `FLM2002`
/// rather than silently walked). Reading is all it does to the filesystem: nothing
/// under `runtimeDir` is written.
#[napi]
pub fn compile_project(request_json: String) -> napi::Result<String> {
    guarded(&request_json, flamme_core::compile_project)
}

/// One entry point's body, wrapped in the panic guard and the JSON codec.
fn guarded(
    request_json: &str,
    run: fn(&flamme_core::request::CompileRequest) -> flamme_core::request::CompileResponse,
) -> napi::Result<String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| compile_inner(request_json, run)))
    {
        Ok(result) => result,
        Err(payload) => {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|message| (*message).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            Err(napi::Error::new(
                napi::Status::GenericFailure,
                format!("flamme: the native compiler panicked: {detail}"),
            ))
        }
    }
}

/// The compiling half of an entry point, separated so the panic guard wraps all of it.
fn compile_inner(
    request_json: &str,
    run: fn(&flamme_core::request::CompileRequest) -> flamme_core::request::CompileResponse,
) -> napi::Result<String> {
    let request: flamme_core::request::CompileRequest =
        serde_json::from_str(request_json).map_err(|error| {
            napi::Error::new(
                napi::Status::InvalidArg,
                format!("flamme: invalid compile request: {error}"),
            )
        })?;
    let response = run(&request);
    serde_json::to_string(&response).map_err(|error| {
        napi::Error::new(
            napi::Status::GenericFailure,
            format!("flamme: cannot serialize the compile response: {error}"),
        )
    })
}
