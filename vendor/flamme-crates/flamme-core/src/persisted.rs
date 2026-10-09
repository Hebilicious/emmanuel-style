//! Persisted queries: the Apollo-shaped manifest of `sha256(raw)` ids.
//! Port of `packages/core/src/persisted.ts`.
//!
//! OWNER: the emit port.

use crate::contract::{ArtifactKind, IrDocument};
use crate::diagnostics::{
    Diagnostic, DiagnosticInput, Severity, SourceLocation, create_diagnostic,
};
use crate::emit::{Json, json_pretty};
use crate::naming::compare_names;

/// The persisted manifest file name.
pub const PERSISTED_MANIFEST_FILE: &str = "persisted.json";

/// The id rule the manifest records.
pub const PERSISTED_ID_RULE: &str = "sha256(raw)";

/// One persisted operation.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistedOperation {
    /// The document name.
    pub name: String,
    /// `sha256(raw)`.
    pub id: String,
    /// The document kind.
    pub kind: String,
}

/// The persisted manifest.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistedManifest {
    /// The compiler version that wrote it.
    pub compiler: String,
    /// The id rule.
    pub rule: String,
    /// The operations, sorted by name.
    pub operations: Vec<PersistedOperation>,
}

/// One operation as the file spells it: Apollo's member names, `body` included.
struct ManifestOperation {
    /// `sha256(raw)`.
    id: String,
    /// Operation name.
    name: String,
    /// `query`, `mutation` or `subscription`.
    type_name: String,
    /// The printed document, verbatim.
    body: String,
}

/// Every operation of a compiled project, sorted by name.
fn manifest_operations(documents: &[IrDocument]) -> Vec<ManifestOperation> {
    let mut operations: Vec<ManifestOperation> = documents
        .iter()
        .filter(|document| document.kind != ArtifactKind::Fragment)
        .map(|document| ManifestOperation {
            id: persisted_id_of(document),
            name: document.name.clone(),
            type_name: document.kind.as_str().to_string(),
            body: document.raw.clone(),
        })
        .collect();
    operations.sort_by(|a, b| compare_names(&a.name, &b.name));
    operations
}

/// The persisted id of a document.
pub fn persisted_id_of(document: &IrDocument) -> String {
    document.hash.clone()
}

/// The manifest for a document set.
pub fn build_persisted_manifest(documents: &[IrDocument], compiler: &str) -> PersistedManifest {
    PersistedManifest {
        compiler: compiler.to_string(),
        rule: PERSISTED_ID_RULE.to_string(),
        operations: manifest_operations(documents)
            .into_iter()
            .map(|operation| PersistedOperation {
                name: operation.name,
                id: operation.id,
                kind: operation.type_name,
            })
            .collect(),
    }
}

/// The serialized `persisted.json`.
pub fn emit_persisted_manifest(documents: &[IrDocument], compiler: &str) -> String {
    let operations = manifest_operations(documents);
    let manifest = Json::Obj(vec![
        ("format".into(), Json::Str("flamme-persisted-query-manifest".into())),
        ("version".into(), Json::Int(1)),
        ("idRule".into(), Json::Str(PERSISTED_ID_RULE.into())),
        ("compiler".into(), Json::Str(compiler.to_string())),
        (
            "operations".into(),
            Json::Arr(
                operations
                    .iter()
                    .map(|operation| {
                        Json::Obj(vec![
                            ("id".into(), Json::Str(operation.id.clone())),
                            ("name".into(), Json::Str(operation.name.clone())),
                            ("type".into(), Json::Str(operation.type_name.clone())),
                            ("body".into(), Json::Str(operation.body.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    format!("{}\n", json_pretty(&manifest))
}

/// Document name to persisted id.
pub fn persisted_id_map(documents: &[IrDocument]) -> Vec<(String, String)> {
    let mut map: Vec<(String, String)> = documents
        .iter()
        .filter(|document| document.kind != ArtifactKind::Fragment)
        .map(|document| (document.name.clone(), persisted_id_of(document)))
        .collect();
    map.sort_by(|a, b| compare_names(&a.0, &b.0));
    map
}

/// The drift between the committed manifest and the current documents.
pub fn persisted_id_drift(
    documents: &[IrDocument],
    committed: Option<&str>,
) -> Vec<(String, String)> {
    let expected = persisted_id_map(documents);
    let Some(committed) = committed else {
        return expected;
    };
    let Some(parsed) = parse_manifest(committed) else {
        return expected;
    };
    let mut drift: Vec<(String, String)> = Vec::new();
    for (name, id) in &expected {
        if parsed.iter().find(|(key, _)| key == name).map(|(_, value)| value) != Some(id) {
            drift.push((name.clone(), id.clone()));
        }
    }
    for (name, id) in &parsed {
        if !expected.iter().any(|(key, _)| key == name) {
            drift.push((name.clone(), id.clone()));
        }
    }
    drift.sort_by(|a, b| compare_names(&a.0, &b.0));
    drift
}

/// The `FLM1025` diagnostic for a missing or stale committed manifest.
pub fn persisted_manifest_diagnostic(
    documents: &[IrDocument],
    file: &str,
    committed: Option<&str>,
) -> Option<Diagnostic> {
    let location =
        SourceLocation { file: file.to_string(), line: 1, column: 1, length: 1 };
    let hint = "run `flamme generate --persisted` and commit the result";
    let Some(committed) = committed else {
        return Some(create_diagnostic(DiagnosticInput {
            code: "FLM1025".into(),
            severity: Some(Severity::Error),
            message: format!("The persisted-query manifest \"{file}\" is missing."),
            location,
            related: None,
            hint: Some(hint.into()),
        }));
    };
    // Member order and formatting are irrelevant: the ids are what CI enforces, so
    // a hand-reformatted but equivalent manifest is accepted.
    let drift = persisted_id_drift(documents, Some(committed));
    if drift.is_empty() {
        return None;
    }
    let names =
        drift.iter().map(|(name, _)| format!("\"{name}\"")).collect::<Vec<_>>().join(", ");
    Some(create_diagnostic(DiagnosticInput {
        code: "FLM1025".into(),
        severity: Some(Severity::Error),
        message: format!(
            "The persisted-query manifest \"{file}\" is stale: operation(s) {names} changed id."
        ),
        location,
        related: None,
        hint: Some(hint.into()),
    }))
}

/// The operation map of a committed manifest, or `None` when it is not readable.
fn parse_manifest(committed: &str) -> Option<Vec<(String, String)>> {
    let parsed: serde_json::Value = serde_json::from_str(committed).ok()?;
    let object = parsed.as_object()?;
    let operations = object.get("operations")?.as_array()?;
    let mut map: Vec<(String, String)> = Vec::new();
    for entry in operations {
        let name = field_of(entry, "name").and_then(|value| value.as_str());
        let id = field_of(entry, "id").and_then(|value| value.as_str());
        if let (Some(name), Some(id)) = (name, id) {
            match map.iter_mut().find(|(key, _)| key == name) {
                Some(slot) => slot.1 = id.to_string(),
                None => map.push((name.to_string(), id.to_string())),
            }
        }
    }
    Some(map)
}

/// One member of a parsed JSON entry, or `None` when it is not an object.
fn field_of<'a>(entry: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    entry.as_object()?.get(key)
}
