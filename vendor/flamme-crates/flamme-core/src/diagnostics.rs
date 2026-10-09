//! Diagnostic types and the stable ordering helpers (`spec/spec.md` §4.9).
//! Port of `packages/core/src/diagnostics.ts`.

use serde::{Deserialize, Serialize};

use crate::naming::compare_names;

/// Severity of a compiler diagnostic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Fails the build.
    Error,
    /// Reported, does not fail the build.
    Warning,
    /// Informational.
    Info,
}

/// A 1-based source position; `file` is a posix path relative to `projectDir`.
/// `column` and `length` count UTF-16 code units, exactly like the JavaScript
/// compiler.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLocation {
    /// Posix path relative to `projectDir`, or an absolute path when outside it.
    pub file: String,
    /// 1-based line number.
    pub line: u32,
    /// 1-based column number.
    pub column: u32,
    /// Length of the offending text, in UTF-16 code units.
    pub length: u32,
}

impl Default for SourceLocation {
    fn default() -> Self {
        Self::config()
    }
}

impl SourceLocation {
    /// The location the run-level failures are reported at (`flamme.config.ts:1:1`).
    pub fn config() -> Self {
        Self { file: "flamme.config.ts".into(), line: 1, column: 1, length: 1 }
    }

    /// A document-level location: the top of the document's source file.
    pub fn document(source: &str) -> Self {
        Self { file: source.to_string(), line: 1, column: 1, length: 1 }
    }
}

/// A secondary location attached to a diagnostic (`FLM1004`, `FLM1002`, …).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelatedInformation {
    /// Human-readable explanation of the related location.
    pub message: String,
    /// Where the related information lives.
    pub location: SourceLocation,
}

/// One compiler diagnostic. `code` is always `FLM` plus a number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    /// Stable diagnostic code, e.g. `FLM1001`.
    pub code: String,
    /// Whether the diagnostic fails the build.
    pub severity: Severity,
    /// The full, user-facing message.
    pub message: String,
    /// The primary source position.
    pub location: SourceLocation,
    /// Secondary positions (the other declaration, the other list, …).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub related: Option<Vec<RelatedInformation>>,
    /// Optional actionable hint appended to the message.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hint: Option<String>,
}

/// The input of [`create_diagnostic`]; optional fields stay absent rather than null.
#[derive(Clone, Debug, Default)]
pub struct DiagnosticInput {
    /// Stable diagnostic code.
    pub code: String,
    /// Severity.
    pub severity: Option<Severity>,
    /// Message.
    pub message: String,
    /// Primary location.
    pub location: SourceLocation,
    /// Secondary locations.
    pub related: Option<Vec<RelatedInformation>>,
    /// Hint.
    pub hint: Option<String>,
}

impl DiagnosticInput {
    /// A diagnostic input with an error severity, the common case.
    pub fn error(code: &str, message: impl Into<String>, location: SourceLocation) -> Self {
        Self {
            code: code.to_string(),
            severity: Some(Severity::Error),
            message: message.into(),
            location,
            related: None,
            hint: None,
        }
    }

    /// A diagnostic input with a warning severity.
    pub fn warning(code: &str, message: impl Into<String>, location: SourceLocation) -> Self {
        Self { severity: Some(Severity::Warning), ..Self::error(code, message, location) }
    }

    /// Attaches secondary locations.
    pub fn with_related(mut self, related: Vec<RelatedInformation>) -> Self {
        self.related = Some(related);
        self
    }

    /// Attaches a hint.
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Builds the diagnostic.
    pub fn build(self) -> Diagnostic {
        create_diagnostic(self)
    }
}

/// Builds a diagnostic, keeping optional fields absent rather than `undefined`.
pub fn create_diagnostic(input: DiagnosticInput) -> Diagnostic {
    Diagnostic {
        code: input.code,
        severity: input.severity.unwrap_or(Severity::Error),
        message: input.message,
        location: input.location,
        related: input.related,
        hint: input.hint,
    }
}

/// True when at least one diagnostic has `severity: 'error'`.
pub fn has_errors(diagnostics: &[Diagnostic]) -> bool {
    diagnostics.iter().any(|diagnostic| diagnostic.severity == Severity::Error)
}

/// Stable-sorts diagnostics by `(file, line, column, code)` so CI output is diffable.
pub fn sort_diagnostics(diagnostics: &mut [Diagnostic]) {
    diagnostics.sort_by(|a, b| {
        compare_names(&a.location.file, &b.location.file)
            .then(a.location.line.cmp(&b.location.line))
            .then(a.location.column.cmp(&b.location.column))
            .then_with(|| compare_names(&a.code, &b.code))
    });
}

/// One-line rendering used by `CompileError` and by the CLI.
pub fn format_diagnostic(diagnostic: &Diagnostic) -> String {
    let SourceLocation { file, line, column, .. } = &diagnostic.location;
    let hint = match &diagnostic.hint {
        Some(hint) => format!("\n  hint: {hint}"),
        None => String::new(),
    };
    let related = diagnostic
        .related
        .as_ref()
        .map(|entries| {
            entries.iter().map(|entry| format!("\n  {}", entry.message)).collect::<String>()
        })
        .unwrap_or_default();
    format!(
        "{file}:{line}:{column} {} {}: {}{related}{hint}",
        severity_name(diagnostic.severity),
        diagnostic.code,
        diagnostic.message
    )
}

/// The lowercase severity spelling the CLI prints.
pub fn severity_name(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
    }
}

/// Joins diagnostics into one multi-line string.
pub fn format_diagnostics(diagnostics: &[Diagnostic]) -> String {
    diagnostics.iter().map(format_diagnostic).collect::<Vec<_>>().join("\n")
}

/// The failure a schema cannot be loaded, parsed or indexed: `FLM2002`.
#[derive(Clone, Debug)]
pub struct SchemaError {
    /// Human-readable message, reported verbatim as the diagnostic message.
    pub message: String,
}

impl SchemaError {
    /// Builds the error.
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SchemaError {}
