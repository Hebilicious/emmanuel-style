//! Schema-index tests against the frozen TypeScript snapshots.
//!
//! `tests/fixtures/frozen/schema_parity.json` holds one verbatim TypeScript run over
//! the `schema` fixture (a valid project that exercises the
//! interface/union/enum/input-object/key-resolution paths), over `poc`,
//! `schema-declared` and `schema-keys` (the two FLM1015 reports), captured before
//! `packages/core/src` was deleted. Each test compares the Rust `SchemaIndex` and the
//! four schema-derived emitted files with what that run produced: `schema.graphql`,
//! `graphql/enums.ts`, `graphql/inputs.ts` and `runtime/index.ts`, byte for byte.
//!
//! `index_the_fixture` degrades to a printed notice while the GraphQL parser is still
//! a stub, so the parser-independent half (`mergeDirectiveDefinitions` against the
//! snapshot's own `schema.graphql`) always runs.

mod support;

use std::collections::BTreeMap;

use flamme_core::emit::{emit_enums, emit_inputs, emit_runtime_index, emit_schema_file};
use flamme_core::schema::{
    INDEX_KEY_DIRECTIVE, SchemaIndex, SchemaIndexOptions, build_schema_index,
    has_directive_definition, index_sdl_for, merge_directive_definitions, type_ref_string,
};
use support::{Frozen, diagnostic_key, diagnostic_keys, fixture, frozen};

/// The suite's frozen snapshots, read once per test binary.
fn snapshots() -> &'static serde_json::Value {
    static SNAPSHOTS: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    SNAPSHOTS.get_or_init(|| frozen("schema_parity"))
}

#[test]
fn schema_index_matches_the_frozen_expectation() {
    let snapshot = Frozen::from_json(&fixture("schema"), &snapshots()["schema"]);
    assert!(snapshot.diagnostics.is_empty(), "the fixture schema is valid: {:?}", snapshot.diagnostics);
    let schema_graphql = snapshot
        .files
        .get("schema.graphql")
        .expect("the snapshot emitted schema.graphql");

    // Parser-independent: `mergeDirectiveDefinitions` is byte for byte the schema
    // file the snapshot emitted, and the fixture declares none of the compiler's
    // definitions, so `indexSdlFor` swaps in the repeatable `@key`.
    assert_eq!(&merge_directive_definitions(&snapshot.schema.sdl), schema_graphql);
    assert!(!has_directive_definition(&snapshot.schema.sdl, "key"));
    let indexed_sdl = index_sdl_for(&snapshot.schema.sdl);
    assert!(indexed_sdl.contains(INDEX_KEY_DIRECTIVE));

    let Some(index) = index_the_fixture(&snapshot, "schema") else {
        return;
    };

    assert_eq!(index.sdl, snapshot.schema.sdl);
    assert_eq!(index.index_sdl, indexed_sdl);
    assert_eq!(index.file, snapshot.schema.file);
    assert!(!index.has_key_directive);
    assert!(index.diagnostics.is_empty(), "{:?}", index.diagnostics);
    // `manifest.json` carries `schemaHash`, which is `sha256` of the merged SDL.
    assert_eq!(index.hash, frozen_schema_hash(text_of(&snapshot, "manifest.json")));

    // The emitted files the index produces, byte for byte against the snapshot's tree.
    assert_eq!(&emit_schema_file(&index), schema_graphql);
    assert_eq!(
        &emit_enums(&index),
        snapshot.files.get("graphql/enums.ts").expect("the snapshot emitted graphql/enums.ts")
    );
    assert_eq!(
        &emit_inputs(&index),
        snapshot.files.get("graphql/inputs.ts").expect("the snapshot emitted graphql/inputs.ts")
    );
    assert_eq!(
        &emit_runtime_index(&index, &snapshot.config),
        snapshot.files.get("runtime/index.ts").expect("the snapshot emitted runtime/index.ts")
    );

    // The index's own facts, read back out of the snapshot's files rather than out of
    // the emit port's rendering.
    assert_eq!(frozen_cache_keys(text_of(&snapshot, "runtime/index.ts")), string_map(&index.key_fields));
    assert_eq!(frozen_enums(text_of(&snapshot, "graphql/enums.ts")), string_map(&index.enums));
    assert_eq!(
        frozen_inputs(text_of(&snapshot, "graphql/inputs.ts")),
        input_shapes(&index)
    );

    // `possibleTypes` has no generated file; these are the fixture schema's static
    // shape, which the snapshot's own `possibleTypes` was read from by hand.
    assert_eq!(index.possible_types_of("Node"), ["Species", "Trainer", "Gym", "League"]);
    assert_eq!(index.possible_types_of("SearchResult"), ["Species", "Trainer", "Gym"]);
    assert_eq!(index.possible_types_of("Species"), ["Species"]);
    assert!(index.is_composite("SearchResult"));
    assert!(index.is_leaf("Region"));
    // `extend enum Region` merges into the base enum, `extend type Badge` into the
    // base type, and the `@key` the extension carries is invisible (the snapshot reads
    // `type.astNode.directives`, which is the base definition's list).
    assert_eq!(index.enum_values("Region"), ["Kanto", "Johto", "Hoenn", "Sinnoh"]);
    assert_eq!(
        index.named_type("Badge").map(|entry| {
            entry.fields.iter().map(|field| field.name.clone()).collect::<Vec<_>>()
        }),
        Some(vec!["id".to_string(), "name".to_string(), "extra".to_string()])
    );
    assert_eq!(index.key_fields_for_type("Badge"), ["id"]);
    assert_eq!(index.schema_key_fields.get("Badge").map(Vec::len), Some(0));
    assert_eq!(index.interfaces_of("Species"), ["Node"]);
    assert_eq!(
        index.field_type("Trainer", "home").map(type_ref_string),
        Some("Region".to_string())
    );
    assert_eq!(
        index.argument_type("Query", "search", "filter").map(type_ref_string),
        Some("SearchFilter".to_string())
    );
    assert_eq!(index.type_kind("SearchFilter"), Some(flamme_core::schema::SchemaTypeKind::InputObject));
}

#[test]
fn poc_schema_index_matches_the_frozen_expectation() {
    let snapshot = Frozen::from_json(&fixture("poc"), &snapshots()["poc"]);
    let schema_graphql = snapshot
        .files
        .get("schema.graphql")
        .expect("the snapshot emitted schema.graphql");
    assert_eq!(&merge_directive_definitions(&snapshot.schema.sdl), schema_graphql);

    let Some(index) = index_the_fixture(&snapshot, "poc") else {
        return;
    };
    assert_eq!(index.hash, frozen_schema_hash(text_of(&snapshot, "manifest.json")));
    assert_eq!(
        frozen_cache_keys(text_of(&snapshot, "runtime/index.ts")),
        string_map(&index.key_fields)
    );
    assert_eq!(frozen_enums(text_of(&snapshot, "graphql/enums.ts")), string_map(&index.enums));
    assert_eq!(frozen_inputs(text_of(&snapshot, "graphql/inputs.ts")), input_shapes(&index));
    // `SpeciesMove: { keys: ['name'] }` names a field the type does not declare, so the
    // configured key is the verified no-op: the type stays embedded.
    assert!(index.is_embedded("SpeciesMove"));
    assert_eq!(index.key_fields_for_type("Species"), ["id"]);
    assert!(!index.has_key_directive);
}

#[test]
fn a_schema_that_declares_the_compiler_directives_matches_the_frozen_expectation() {
    let snapshot = Frozen::from_json(&fixture("schema-declared"), &snapshots()["schema-declared"]);
    assert!(snapshot.diagnostics.is_empty(), "the fixture schema is valid: {:?}", snapshot.diagnostics);
    let schema_graphql = text_of(&snapshot, "schema.graphql");

    // `emitSchemaFile` returns the user's SDL verbatim once it declares `@key`; the
    // indexing merge still adds the definitions that are missing.
    let mut base = snapshot.schema.sdl.clone();
    if !base.ends_with('\n') {
        base.push('\n');
    }
    assert_eq!(base, *schema_graphql);
    let merged = merge_directive_definitions(&snapshot.schema.sdl);
    assert_ne!(merged, *schema_graphql);
    assert!(has_directive_definition(&snapshot.schema.sdl, "key"));
    assert!(has_directive_definition(&snapshot.schema.sdl, "cache"));
    assert_eq!(index_sdl_for(&snapshot.schema.sdl), merged);

    let Some(index) = index_the_fixture(&snapshot, "schema-declared") else {
        return;
    };
    assert!(index.has_key_directive);
    assert_eq!(index.index_sdl, merged);
    // The user's non-repeatable `@key` stays, so no FLM1015 is possible.
    assert!(!index.index_sdl.contains(INDEX_KEY_DIRECTIVE));
    assert_eq!(index.hash, frozen_schema_hash(text_of(&snapshot, "manifest.json")));
    assert_eq!(frozen_cache_keys(text_of(&snapshot, "runtime/index.ts")), string_map(&index.key_fields));
    assert_eq!(frozen_enums(text_of(&snapshot, "graphql/enums.ts")), string_map(&index.enums));
    // The merge keeps the user's enum declarations and adds only `DedupeMatchMode`.
    assert_eq!(
        index.enum_values("CachePolicy"),
        ["CacheOrNetwork", "NetworkOnly", "CacheAndNetwork", "CacheOnly", "SessionOnly"]
    );
    assert_eq!(index.enum_values("PaginateMode"), ["SinglePage", "Infinite", "Windowed"]);
    assert_eq!(index.enum_values("DedupeMatchMode"), ["variables", "all"]);
    assert_eq!(index.key_fields_for_type("Wallet"), ["id"]);
}

#[test]
fn schema_key_diagnostics_match_the_frozen_expectation() {
    let snapshot = Frozen::from_json(&fixture("schema-keys"), &snapshots()["schema-keys"]);
    assert!(
        snapshot.files.is_empty(),
        "the snapshot refuses to emit a project whose schema reports FLM1015"
    );
    let expected: Vec<_> = snapshot
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "FLM1015")
        .map(diagnostic_key)
        .collect();
    assert_eq!(expected.len(), 2, "the fixture reports both FLM1015 rules: {:#?}", snapshot.diagnostics);

    let Some(index) = index_the_fixture(&snapshot, "schema-keys") else {
        return;
    };
    assert_eq!(diagnostic_keys(&index.diagnostics), expected);
    // The key lists themselves still resolve the way the snapshot resolves them: the
    // duplicate directive is dropped, the composite name stays in `schemaKeyFields`
    // but not in the key fields, and the default key takes over.
    assert_eq!(index.schema_key_fields.get("Species").map(Vec::len), Some(0));
    assert_eq!(
        index.schema_key_fields.get("Trainer").map(Vec::as_slice),
        Some(&["home".to_string()][..])
    );
    assert_eq!(index.key_fields_for_type("Species"), ["id"]);
    assert_eq!(index.key_fields_for_type("Trainer"), ["id"]);
}

/// Indexes a fixture, or returns `None` while the GraphQL parser is still a stub.
fn index_the_fixture(snapshot: &Frozen, name: &str) -> Option<SchemaIndex> {
    let options = SchemaIndexOptions::from_config(&snapshot.config);
    match build_schema_index(&snapshot.schema.sdl, &options, &snapshot.schema.file) {
        Ok(index) => Some(index),
        Err(error) if error.message.contains("parser not ported") => {
            eprintln!(
                "schema_parity: the GraphQL parser is not ported yet; \
                 skipping the {name} index comparison"
            );
            None
        }
        Err(error) => panic!("the {name} fixture schema must index: {}", error.message),
    }
}

/// One generated file's text.
fn text_of<'a>(snapshot: &'a Frozen, path: &str) -> &'a str {
    snapshot.files.get(path).unwrap_or_else(|| panic!("the snapshot emitted {path}"))
}

/// A `JsObject` record as a sorted map, for comparison with a parsed file.
fn string_map(object: &flamme_core::js::JsObject<Vec<String>>) -> BTreeMap<String, Vec<String>> {
    object.iter().map(|(key, value)| (key.to_string(), value.clone())).collect()
}

/// The input objects as `name → field → is the field nullable`.
fn input_shapes(index: &SchemaIndex) -> BTreeMap<String, BTreeMap<String, bool>> {
    index
        .input_types
        .iter()
        .map(|(name, fields)| {
            let fields = fields
                .iter()
                .map(|(field, type_name)| (field.to_string(), !type_name.ends_with('!')))
                .collect();
            (name.to_string(), fields)
        })
        .collect()
}

/// The `schemaHash` the snapshot's `manifest.json` records for the schema.
fn frozen_schema_hash(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| line.trim_start().starts_with("\"schemaHash\""))
        .expect("the manifest records schemaHash");
    let (_, value) = line.trim().split_once(": ").expect("a JSON entry");
    serde_json::from_str(value.trim_end_matches(',')).expect("a JSON string")
}

/// `export const cacheKeys: … = { "Name": ["field"], … }` from `runtime/index.ts`.
fn frozen_cache_keys(text: &str) -> BTreeMap<String, Vec<String>> {
    let mut keys = BTreeMap::new();
    let mut inside = false;
    for line in text.lines() {
        if !inside {
            inside = line.starts_with("export const cacheKeys");
            continue;
        }
        if line == "}" {
            break;
        }
        let (name, values) = line.trim().split_once(": ").expect("a cache key entry");
        let name: String = serde_json::from_str(name).expect("a JSON object key");
        let fields: Vec<String> =
            serde_json::from_str(values.trim_end_matches(',')).expect("a JSON string array");
        keys.insert(name, fields);
    }
    keys
}

/// `export type Name$options = | "Value" …` blocks from `graphql/enums.ts`.
fn frozen_enums(text: &str) -> BTreeMap<String, Vec<String>> {
    let mut enums: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("export type ")
            && let Some(name) = rest.strip_suffix("$options =")
        {
            enums.insert(name.to_string(), Vec::new());
            current = Some(name.to_string());
            continue;
        }
        if let Some(rest) = line.strip_prefix("  | ") {
            let name = current.clone().expect("an enum value follows its enum type");
            let value: String = serde_json::from_str(rest).expect("a JSON string literal");
            enums.get_mut(&name).expect("the enum was declared").push(value);
        }
    }
    enums
}

/// `export interface Name { readonly field?: type; … }` blocks from `graphql/inputs.ts`.
fn frozen_inputs(text: &str) -> BTreeMap<String, BTreeMap<String, bool>> {
    let mut inputs: BTreeMap<String, BTreeMap<String, bool>> = BTreeMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("export interface ")
            && let Some(name) = rest.strip_suffix(" {")
        {
            inputs.insert(name.to_string(), BTreeMap::new());
            current = Some(name.to_string());
            continue;
        }
        if line == "}" {
            current = None;
            continue;
        }
        if let Some(rest) = line.strip_prefix("  readonly ") {
            let name = current.clone().expect("a field follows its interface");
            let (field, _) = rest.split_once(':').expect("a typed field");
            let optional = field.ends_with('?');
            inputs
                .get_mut(&name)
                .expect("the input was declared")
                .insert(field.trim_end_matches('?').to_string(), optional);
        }
    }
    inputs
}
