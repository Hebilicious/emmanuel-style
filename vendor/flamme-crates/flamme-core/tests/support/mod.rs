//! Shared helpers for the integration suites: the fixture tree, the frozen compiler
//! snapshots under `tests/fixtures/frozen/` and the comparisons that run the Rust
//! compiler against them.
//!
//! A *frozen snapshot* is one verbatim run of the TypeScript compiler over a fixture
//! project, captured before `packages/core/src` was deleted. The Rust compiler is the
//! only compiler now, so a snapshot is the contract: each suite compiles the fixture
//! afresh and compares the generated tree and the diagnostics against the frozen
//! bytes, exactly as the parity suites compared them against the TypeScript compiler
//! before it was deleted.
//!
//! `#![allow(dead_code)]` because every integration test binary includes this module
//! and uses a subset of it.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use flamme_core::config::RustConfig;
use flamme_core::diagnostics::Diagnostic;
use flamme_core::extract::SourceFile;
use flamme_core::request::{CompileOptions, CompileRequest, CompileResponse, SchemaInput};

/// The repository root.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

/// A fixture project directory under `crates/flamme-core/tests/fixtures`.
pub fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

/// The frozen snapshots of one suite, from `tests/fixtures/frozen/<suite>.json`.
///
/// Each suite assembles its own file out of the TypeScript runs it needs; the keys name
/// the fixture and the mode, so a test reads the snapshot it compares against.
pub fn frozen(suite: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/frozen").join(format!("{suite}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is missing: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

/// One frozen compiler run: the resolved config, the schema, the inputs it compiled,
/// the tree it emitted and the diagnostics it reported.
pub struct Frozen {
    /// The resolved config, as the compiler under test resolved it.
    pub config: RustConfig,
    /// The schema the frozen run compiled against.
    pub schema: SchemaInput,
    /// Every input file of the run, with its text.
    pub inputs: Vec<SourceFile>,
    /// The generated tree, keyed by path relative to `runtimeDir`.
    pub files: BTreeMap<String, String>,
    /// Every diagnostic of the run.
    pub diagnostics: Vec<Diagnostic>,
}

impl Frozen {
    /// Builds the [`Frozen`] view of one snapshot document.
    ///
    /// The inputs' `absolute` paths are re-anchored at `project`, so a snapshot taken
    /// in one checkout still resolves its files in another; their text is the frozen
    /// text, which is what the run under test has to compile.
    pub fn from_json(project: &Path, value: &serde_json::Value) -> Frozen {
        let mut config_value = value["config"].clone();
        config_value["projectDir"] = serde_json::Value::String(
            project.to_string_lossy().replace('\\', "/"),
        );
        let config: RustConfig =
            serde_json::from_value(config_value).expect("resolved config deserializes");
        // An extraction-only snapshot carries no schema; nothing in it is compiled.
        let schema: SchemaInput = if value["schema"].is_object() {
            serde_json::from_value(value["schema"].clone()).expect("schema deserializes")
        } else {
            SchemaInput { sdl: String::new(), file: String::new() }
        };
        let mut inputs_value = value["inputs"].clone();
        for input in inputs_value.as_array_mut().expect("inputs is an array") {
            let relative = input["relative"].as_str().expect("relative").to_string();
            input["absolute"] = serde_json::Value::String(
                project.join(&relative).to_string_lossy().replace('\\', "/"),
            );
        }
        let inputs: Vec<SourceFile> =
            serde_json::from_value(inputs_value).expect("inputs deserialize");
        let mut files = BTreeMap::new();
        for file in value["files"].as_array().cloned().unwrap_or_default() {
            files.insert(
                file["path"].as_str().expect("path").to_string(),
                file["contents"].as_str().expect("contents").to_string(),
            );
        }
        let diagnostics: Vec<Diagnostic> =
            serde_json::from_value(value["diagnostics"].clone()).expect("diagnostics deserialize");
        Frozen { config, schema, inputs, files, diagnostics }
    }
}

/// Compiles a fixture with the Rust compiler, from the frozen run's own inputs.
pub fn compile_with(inputs: &[SourceFile], config: &RustConfig, schema: &SchemaInput, options: CompileOptions) -> CompileResponse {
    flamme_core::compile(&CompileRequest {
        route_documents: None,
        config: config.clone(),
        schema: schema.clone(),
        files: Some(inputs.to_vec()),
        options,
        persisted_committed: None,
        persisted_path: None,
        cache: None,
        sources: None,
    })
}

/// The generated tree of a response, keyed by path relative to `runtimeDir`.
pub fn tree_of(response: &CompileResponse) -> BTreeMap<String, String> {
    response.files.iter().map(|file| (file.path.clone(), file.contents.clone())).collect()
}

/// The comparable tuple of one diagnostic: code, severity, file, line, column, message.
pub fn diagnostic_key(diagnostic: &Diagnostic) -> (String, String, String, u32, u32, String) {
    (
        diagnostic.code.clone(),
        flamme_core::diagnostics::severity_name(diagnostic.severity).to_string(),
        diagnostic.location.file.clone(),
        diagnostic.location.line,
        diagnostic.location.column,
        diagnostic.message.clone(),
    )
}

/// Every diagnostic of a slice, as comparable tuples.
pub fn diagnostic_keys(diagnostics: &[Diagnostic]) -> Vec<(String, String, String, u32, u32, String)> {
    diagnostics.iter().map(diagnostic_key).collect()
}

/// Compiles `project` from one frozen run's inputs, in the run's mode.
///
/// `extra_args` carries the mode (`--check`, `--persisted`) exactly as the frozen
/// snapshot was taken with it.
pub fn compile_frozen(project: &Path, extra_args: &[&str], expected: &serde_json::Value) -> (Frozen, CompileResponse) {
    let frozen = Frozen::from_json(project, expected);
    let options = CompileOptions {
        check: extra_args.contains(&"--check"),
        persisted: extra_args.contains(&"--persisted"),
        files: None,
        include_ir: false,
        save_cache: false,
    };
    let response = compile_with(&frozen.inputs, &frozen.config, &frozen.schema, options);
    (frozen, response)
}

/// Asserts that a fresh Rust compile of `project` reproduces one frozen run.
///
/// Returns `(tree, diagnostics)` for tests that want to assert more.
pub fn assert_frozen(project: &Path, extra_args: &[&str], expected: &serde_json::Value) -> (BTreeMap<String, String>, Vec<Diagnostic>) {
    let (frozen, response) = compile_frozen(project, extra_args, expected);
    assert_matches(project, &frozen, &response);
    (tree_of(&response), response.diagnostics)
}

/// Asserts one already-compiled response reproduces the frozen tree and diagnostics.
pub fn assert_matches(project: &Path, frozen: &Frozen, response: &CompileResponse) {
    let tree = tree_of(response);

    let expected_paths: Vec<&String> = frozen.files.keys().collect();
    let rust_paths: Vec<&String> = tree.keys().collect();
    assert_eq!(
        expected_paths, rust_paths,
        "generated tree paths differ for {}",
        project.display()
    );
    for (path, expected) in &frozen.files {
        let actual = tree.get(path).expect("path present");
        if actual != expected {
            let expected_lines: Vec<&str> = expected.lines().collect();
            let actual_lines: Vec<&str> = actual.lines().collect();
            let first = expected_lines
                .iter()
                .zip(actual_lines.iter())
                .position(|(a, b)| a != b)
                .unwrap_or_else(|| expected_lines.len().min(actual_lines.len()));
            panic!(
                "{} differs for {}\n  first difference at line {}\n  frozen: {:?}\n  rust:   {:?}",
                path,
                project.display(),
                first + 1,
                expected_lines.get(first).unwrap_or(&"<missing>"),
                actual_lines.get(first).unwrap_or(&"<missing>"),
            );
        }
    }

    let expected_diagnostics = diagnostic_keys(&frozen.diagnostics);
    let actual_diagnostics = diagnostic_keys(&response.diagnostics);
    assert_eq!(
        expected_diagnostics,
        actual_diagnostics,
        "diagnostics differ for {}",
        project.display()
    );
}

/// Writes a file into a scratch directory (for tests that need a project on disk).
pub fn write_tree(root: &Path, files: &BTreeMap<String, String>) {
    for (path, contents) in files {
        let absolute = root.join(path);
        std::fs::create_dir_all(absolute.parent().expect("parent")).expect("mkdir");
        std::fs::write(&absolute, contents).expect("write");
    }
}
