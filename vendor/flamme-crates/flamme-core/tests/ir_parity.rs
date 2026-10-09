//! IR tests (`spec/spec.md` §3, §4.6): the Rust IR builder against the frozen
//! TypeScript IR, on a fixture project that covers what the PoC does not.
//!
//! The test deliberately does not go through extraction or emit, so it isolates
//! `ir.rs`: it reads `tests/fixtures/frozen/ir_parity.json` (the verbatim TypeScript
//! IR output, captured before `packages/core/src` was deleted),
//! rebuilds every `RawDocument` from the snapshot's own document list (parsing the
//! document text with the Rust parser), indexes them with
//! `validate::prepare_project`, and compares the canonical JSON of each `build_ir`
//! result against the frozen `IrDocument`.
//!
//! The comparison is order-sensitive where order is behaviour: the order of a
//! selection's `fields`/`fragments`/`abstractFields` (the generated types follow
//! source order), the order of `paginated`, `deferred`, `injectedKeys` and of the
//! input record. Everything else is compared structurally.

mod support;

use flamme_core::config::RustConfig;
use flamme_core::contract::{IrDocument, SubscriptionSelection};
use flamme_core::extract::{DocumentSurface, RawDocument};
use flamme_core::js::JsObject;
use flamme_core::offsets::{Offset, SourceText};
use flamme_core::request::SchemaInput;
use flamme_core::schema::{SchemaIndexOptions, build_schema_index};
use flamme_core::validate::prepare_project;
use serde::Serialize;
use serde_json::{Map, Value};

/// The frozen IR snapshot of one fixture project.
fn ir_snapshot(project: &str) -> Value {
    support::frozen("ir_parity")
        .get(project)
        .cloned()
        .unwrap_or_else(|| panic!("the frozen IR snapshot has no {project} entry"))
}

/// One document the frozen extraction produced, as a Rust [`RawDocument`].
fn raw_document(entry: &Value) -> RawDocument {
    let text = entry["raw"].as_str().expect("raw").to_string();
    let ast = flamme_core::graphql::parse_document(&text)
        .unwrap_or_else(|error| panic!("the snapshot's document text parses: {error}\n{text}"));
    let surface = match entry["surface"].as_str().expect("surface") {
        "file" => DocumentSurface::File,
        "tag" => DocumentSurface::Tag,
        "script" => DocumentSurface::Script,
        "module" => DocumentSurface::Module,
        other => panic!("unknown document surface \"{other}\""),
    };
    let offset = |name: &str| entry[name].as_u64().expect(name) as Offset;
    RawDocument {
        name: entry["name"].as_str().expect("name").to_string(),
        kind: serde_json::from_value(entry["kind"].clone()).expect("kind"),
        raw: text,
        file: entry["file"].as_str().expect("file").to_string(),
        relative_path: entry["relativePath"].as_str().expect("relativePath").to_string(),
        surface,
        offset: offset("offset"),
        start: offset("start"),
        end: offset("end"),
        source_offsets: entry["sourceOffsets"]
            .as_array()
            .expect("sourceOffsets")
            .iter()
            .map(|value| value.as_u64().expect("offset") as Offset)
            .collect(),
        ast,
        source: SourceText::new(entry["source"].as_str().expect("source")),
    }
}

/// The IR of one document as the plain JSON the snapshot holds.
fn ir_json(document: &IrDocument) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), Value::String(document.name.clone()));
    out.insert("kind".into(), Value::String(document.kind.as_str().to_string()));
    out.insert("raw".into(), Value::String(document.raw.clone()));
    out.insert("hash".into(), Value::String(document.hash.clone()));
    out.insert("rootType".into(), Value::String(document.root_type.clone()));
    out.insert("selection".into(), selection_json(&document.selection));
    out.insert("input".into(), to_json(&document.input));
    out.insert("refetch".into(), optional_json(&document.refetch));
    out.insert("pluginData".into(), to_json(&document.plugin_data));
    out.insert("enableLoadingState".into(), optional_json(&document.enable_loading_state));
    out.insert(
        "policy".into(),
        match document.policy {
            Some(policy) => Value::String(policy.as_str().to_string()),
            None => Value::Null,
        },
    );
    out.insert(
        "partial".into(),
        match document.partial {
            Some(partial) => Value::Bool(partial),
            None => Value::Null,
        },
    );
    out.insert("paginated".into(), to_json(&document.paginated));
    out.insert("lists".into(), to_json(&document.lists));
    out.insert("deferred".into(), optional_json(&document.deferred));
    out.insert(
        "optimisticKeys".into(),
        match document.optimistic_keys {
            Some(value) => Value::Bool(value),
            None => Value::Null,
        },
    );
    out.insert("injectedKeys".into(), pairs_json(&document.injected_keys, Value::String));
    out.insert("fragmentTypes".into(), pairs_json(&document.fragment_types, Value::String));
    out.insert(
        "fragmentSelections".into(),
        to_json(&JsObject::from_pairs(
            document
                .fragment_selections
                .iter()
                .map(|(name, selection)| (name.clone(), selection_json(selection))),
        )),
    );
    Value::Object(out)
}

/// One selection as the snapshot prints it: empty containers are omitted.
fn selection_json(selection: &SubscriptionSelection) -> Value {
    let mut out = Map::new();
    if !selection.fields.is_empty() {
        out.insert("fields".into(), to_json(&selection.fields));
    }
    if !selection.fragments.is_empty() {
        out.insert("fragments".into(), to_json(&selection.fragments));
    }
    if !selection.abstract_fields.is_empty() {
        out.insert(
            "abstractFields".into(),
            to_json(&JsObject::from_pairs(
                selection
                    .abstract_fields
                    .iter()
                    .map(|(name, branch)| (name.to_string(), selection_json(branch))),
            )),
        );
    }
    Value::Object(out)
}

/// An association list as a JavaScript object: index-like keys first.
fn pairs_json<T>(
    pairs: &[(String, T)],
    convert: impl Fn(T) -> Value + Copy,
) -> Value
where
    T: Serialize + Clone,
{
    to_json(&JsObject::from_pairs(
        pairs.iter().map(|(name, value)| (name.clone(), convert(value.clone()))),
    ))
}

/// Serializes a value, which cannot fail for the IR's shapes.
fn to_json<T: Serialize>(value: &T) -> Value {
    runtime_names(serde_json::to_value(value).expect("the IR serializes"))
}

/// Renames `abstract_` to the runtime artifact's `abstract`.
///
/// `contract.rs` keeps the Rust-safe field name `abstract_` and (as of this test)
/// carries no `#[serde(rename = "abstract")]`, so the serialized member would not
/// match the runtime's. The rename is a no-op once the contract renames it.
fn runtime_names(value: Value) -> Value {
    match value {
        Value::Object(entries) => Value::Object(
            entries
                .into_iter()
                .map(|(key, entry)| {
                    let key = if key == "abstract_" { "abstract".to_string() } else { key };
                    (key, runtime_names(entry))
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(runtime_names).collect()),
        other => other,
    }
}

/// An optional member, absent in the snapshot as `null` here.
fn optional_json<T: Serialize>(value: &Option<T>) -> Value {
    match value {
        Some(value) => to_json(value),
        None => Value::Null,
    }
}

/// The key order a JSON object is canonicalized with.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// An object whose keys are sorted: the snapshot's property order inside a
    /// spec/type object carries no meaning.
    Spec,
    /// A selection: `fields`, `fragments` and `abstractFields` keep their order.
    Selection,
    /// The branches of `abstractFields`: every value is a selection.
    AbstractFields,
    /// A record whose order is behaviour (directive and fragment arguments).
    Arguments,
    /// A record whose order is behaviour, all the way down (`input`).
    Ordered,
}

/// Canonical JSON text, order-sensitive exactly where order is behaviour.
fn canonical(value: &Value, mode: Mode) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => serde_json::to_string(text).expect("a string serializes"),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(|item| canonical(item, Mode::Spec)).collect::<Vec<_>>().join(",")
        ),
        Value::Object(entries) => {
            let mut pairs: Vec<(&String, &Value)> = entries.iter().collect();
            if mode == Mode::Spec {
                pairs.sort_by(|a, b| a.0.cmp(b.0));
            }
            let mut parts: Vec<String> = Vec::new();
            for (key, entry) in pairs {
                // The Rust contract cannot tell an omitted `fields` from an empty
                // one, and no consumer can either.
                if matches!(key.as_str(), "fields" | "fragments" | "abstractFields")
                    && entry.as_object().is_some_and(|object| object.is_empty())
                {
                    continue;
                }
                let child = match mode {
                    Mode::Selection => match key.as_str() {
                        "fields" | "fragments" => Mode::Spec,
                        "abstractFields" => Mode::AbstractFields,
                        _ => Mode::Spec,
                    },
                    Mode::AbstractFields => Mode::Selection,
                    Mode::Arguments | Mode::Ordered => mode,
                    Mode::Spec => match key.as_str() {
                        "selection" => Mode::Selection,
                        "abstractFields" => Mode::AbstractFields,
                        "arguments" | "filters" => Mode::Arguments,
                        "input" => Mode::Ordered,
                        _ => Mode::Spec,
                    },
                };
                parts.push(format!(
                    "{}:{}",
                    serde_json::to_string(key).expect("a key serializes"),
                    canonical(entry, child)
                ));
            }
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// Compiles the fixture's documents with the Rust IR builder.
fn rust_documents(snapshot: &Value) -> (Vec<String>, Vec<IrDocument>) {
    let config: RustConfig = serde_json::from_value(snapshot["config"].clone())
        .expect("the resolved config deserializes");
    let schema_input: SchemaInput = serde_json::from_value(snapshot["schema"].clone())
        .expect("the schema input deserializes");
    let schema = build_schema_index(
        &schema_input.sdl,
        &SchemaIndexOptions::from_config(&config),
        &schema_input.file,
    )
    .expect("the snapshot's SDL indexes");
    let documents: Vec<RawDocument> = snapshot["documents"]
        .as_array()
        .expect("documents is an array")
        .iter()
        .map(raw_document)
        .collect();
    let prepared = prepare_project(&config, &schema, &documents);
    let names = documents.iter().map(|document| document.name.clone()).collect();
    let built = documents
        .iter()
        .map(|document| {
            flamme_core::ir::build_ir(document, &documents, &prepared.index, &schema, &config)
        })
        .collect();
    (names, built)
}

/// Compares the Rust IR of one fixture project against the frozen snapshot,
/// document by document and member by member.
fn assert_ir_parity(name: &str) {
    let snapshot = ir_snapshot(name);

    let errors: Vec<String> = snapshot["diagnostics"]
        .as_array()
        .expect("diagnostics")
        .iter()
        .filter(|entry| entry["severity"] == "error")
        .map(|entry| entry["code"].as_str().unwrap_or("?").to_string())
        .collect();
    assert!(errors.is_empty(), "{name} must validate cleanly, got errors: {errors:?}");

    let (names, built) = rust_documents(&snapshot);
    let expected = snapshot["ir"].as_array().expect("ir is an array");
    assert_eq!(names.len(), expected.len(), "{name}: document count");

    for (index, (name, document)) in names.iter().zip(built.iter()).enumerate() {
        let frozen_document = &expected[index];
        assert_eq!(
            frozen_document["name"].as_str().expect("name"),
            name,
            "{name}: document {index} order"
        );
        let frozen_text = canonical(frozen_document, Mode::Spec);
        let rust_text = canonical(&ir_json(document), Mode::Spec);
        if frozen_text != rust_text {
            let at = first_difference(&frozen_text, &rust_text);
            panic!(
                "{name}: IR differs at canonical byte {at}\n  frozen: {}\n  rust:   {}",
                snippet(&frozen_text, at),
                snippet(&rust_text, at),
            );
        }
    }
}

/// The byte offset of the first difference between two strings.
fn first_difference(left: &str, right: &str) -> usize {
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| left.len().min(right.len()))
}

/// A window around a byte offset, on character boundaries.
fn snippet(text: &str, at: usize) -> &str {
    let mut start = at.saturating_sub(160).min(text.len());
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + 320).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    &text[start..end]
}

#[test]
fn ir_features_match_the_frozen_expectation() {
    assert_ir_parity("ir_features");
}

/// The generated tree of the same fixture, which is where the IR's `raw` bytes,
/// selection order and `deferred`/`lists` metadata end up: the full Rust pipeline
/// against the frozen snapshot, byte for byte. The fixture carries the two
/// `@required`-on-a-non-null-field warnings and nothing else.
#[test]
fn ir_features_tree_matches_the_frozen_expectation() {
    let snapshots = support::frozen("ir_parity");
    let (tree, diagnostics) = support::assert_frozen(
        &support::fixture("ir_features"),
        &[],
        &snapshots["ir_features_tree"],
    );
    assert!(tree.contains_key("artifacts/PagedNull.ts"), "the tree has artifacts");
    assert_eq!(diagnostics.len(), 2, "the fixture's two @required warnings");
}

/// A schema whose `schema { … }` block renames the root types: `rootType` (and the
/// `@defer` labels derived from a root path) have to follow the block, not the
/// conventional `Query`/`Mutation` names.
#[test]
fn ir_roots_match_the_frozen_expectation() {
    assert_ir_parity("ir_roots");
}
