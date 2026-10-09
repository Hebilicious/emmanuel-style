//! The emitter's tests, beyond the PoC acceptance run: enum unions, input
//! interfaces and scalar modules (`graphql/enums.ts`, `graphql/inputs.ts`),
//! `props.ts` across root types, `ambient.d.ts`, `manifest.json` with lists,
//! pagination and persisted ids, `persisted.json` and the `FLM1025` drift check.
//!
//! Every comparison is byte-exact against a frozen snapshot of the TypeScript
//! compiler's output (`tests/fixtures/frozen/emit_parity.json`, one verbatim run per
//! fixture); the compiler under test is the Rust port. Whenever two texts differ the
//! assertion prints the first differing line and both variants.

mod support;

use std::collections::HashMap;

use flamme_core::contract::{
    ArtifactKind, IrDocument, SubscriptionSelection,
};
use flamme_core::diagnostics::Diagnostic;
use flamme_core::emit;
use flamme_core::extract::{DocumentSurface, RawDocument};
use flamme_core::graphql::ast::Document;
use flamme_core::js::JsObject;
use flamme_core::offsets::SourceText;
use flamme_core::persisted::persisted_manifest_diagnostic;
use flamme_core::request::CompileOptions;
use flamme_core::schema::SchemaIndex;
use serde::Deserialize;
use support::{assert_frozen, compile_frozen, fixture, frozen, Frozen};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Asserts two texts are byte-identical, reporting the first differing line.
fn assert_same_text(what: &str, expected: &str, actual: &str) {
    if expected == actual {
        return;
    }
    let expected_lines: Vec<&str> = expected.lines().collect();
    let actual_lines: Vec<&str> = actual.lines().collect();
    let position = expected_lines
        .iter()
        .zip(actual_lines.iter())
        .position(|(left, right)| left != right)
        .unwrap_or_else(|| expected_lines.len().min(actual_lines.len()));
    let expected_len = expected.lines().count();
    let actual_len = actual.lines().count();
    panic!(
        "{what} differs\n  first difference at line {} (frozen {expected_len} lines, rust {actual_len} lines)\n  frozen: {:?}\n  rust:   {:?}",
        position + 1,
        expected_lines.get(position).copied().unwrap_or("<missing>"),
        actual_lines.get(position).copied().unwrap_or("<missing>"),
    );
}

/// A document with only the fields one emitter reads, for the direct comparisons.
fn stub_document(name: &str, kind: ArtifactKind, hash: &str, raw: &str) -> IrDocument {
    let file = format!("src/{name}.gql");
    IrDocument {
        name: name.to_string(),
        kind,
        raw: raw.to_string(),
        hash: hash.to_string(),
        file: file.clone(),
        source: file.clone(),
        root_type: "Query".to_string(),
        selection: SubscriptionSelection::default(),
        input: Default::default(),
        refetch: None,
        plugin_data: JsObject::new(),
        enable_loading_state: None,
        policy: None,
        partial: None,
        paginated: Vec::new(),
        lists: Vec::new(),
        deferred: None,
        pagination_companion: None,
        optimistic_keys: None,
        injected_keys: Vec::new(),
        fragment_types: Vec::new(),
        fragment_selections: Vec::new(),
        document: RawDocument {
            name: name.to_string(),
            kind,
            raw: raw.to_string(),
            file: file.clone(),
            relative_path: file,
            surface: DocumentSurface::File,
            offset: 0,
            start: 0,
            end: 0,
            source_offsets: Vec::new(),
            ast: Document { definitions: Vec::new() },
            source: SourceText::new(""),
        },
        strip_variables: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Frozen snapshots: the whole tree and the diagnostics, byte for byte
// ---------------------------------------------------------------------------

/// The suite's frozen snapshots, read once per test binary.
fn snapshots() -> &'static serde_json::Value {
    static SNAPSHOTS: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    SNAPSHOTS.get_or_init(|| frozen("emit_parity"))
}

#[test]
fn enums_inputs_and_scalar_modules_match_the_frozen_expectation() {
    let (tree, diagnostics) = assert_frozen(&fixture("emit_enums"), &[], &snapshots()["emit_enums"]);
    assert_eq!(diagnostics.len(), 0);
    let enums = &tree["graphql/enums.ts"];
    assert!(enums.contains("export type Rarity$options ="), "the enum union is emitted");
    assert!(enums.contains("  | \"Legendary\""), "every enum value is a union member");
    let inputs = &tree["graphql/inputs.ts"];
    assert!(inputs.contains("export interface SpeciesFilter {"));
    assert!(
        inputs.contains("readonly nested?: SpeciesFilter | null;"),
        "a nested input object types as itself"
    );
    assert!(
        inputs.contains("readonly rarities?: ReadonlyArray<Rarity$options> | null;"),
        "an input field types as the generated enum union"
    );
    let artifact = &tree["artifacts/Enums.ts"];
    assert!(artifact.contains("import type { Rarity$options } from '../graphql/enums'"));
    assert!(artifact.contains("import type { Date } from './scalars'"));
    assert!(artifact.contains("import type JsonValue from './scalars'"));
    assert!(artifact.contains("import type { SpeciesFilter } from '../graphql/inputs'"));
    assert!(
        artifact.contains("\"huge\": 1e+21,") && artifact.contains("\"small\": 1e-7,"),
        "a float default renders the way JavaScript's String(number) renders it"
    );
    assert!(artifact.contains("\"ratio\": 1.5,"), "a plain float default keeps its digits");
    assert!(
        artifact.find("\"name\": \"bulbasaur\"").expect("the object default")
            < artifact.find("\"limit\": 3").expect("the object default's second key"),
        "an object default keeps the source key order, not a sorted one"
    );
}

#[test]
fn props_across_root_types_match_the_frozen_expectation() {
    let (tree, _diagnostics) = assert_frozen(&fixture("props_multi"), &[], &snapshots()["props_multi"]);
    let props = &tree["props.ts"];
    for name in ["MoveA", "QueryFrag", "SpeciesA", "SpeciesB"] {
        assert!(props.contains(&format!("export const {name}Prop = {{")), "{name} descriptor");
        assert!(props.contains(&format!("export function is{name}Key")), "{name} validator");
    }
    assert!(props.contains("  speciesMove: {"), "SpeciesMove lowers to speciesMove");
    assert!(props.contains("  query: {"), "Query lowers to query");
    assert!(props.contains("import type { SpeciesA$key } from './artifacts/SpeciesA'"));
}

#[test]
fn a_name_collision_between_an_operation_and_a_fragment_matches_the_frozen_expectation() {
    let (tree, diagnostics) = assert_frozen(&fixture("name_collision"), &[], &snapshots()["name_collision"]);
    assert!(tree.is_empty(), "an error diagnostic emits no tree");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "FLM1020");
    assert!(diagnostics[0].message.contains("collide onto one artifact name"));
    assert!(diagnostics[0].related.is_some(), "the fragment's location is related");
}

#[test]
fn an_unusable_document_name_matches_the_frozen_expectation() {
    let (tree, diagnostics) = assert_frozen(&fixture("unusable_name"), &[], &snapshots()["unusable_name"]);
    assert!(tree.is_empty(), "a rejected name emits no tree");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "FLM1019");
    assert!(diagnostics[0].message.contains("cannot be used as a TypeScript identifier"));
}

#[test]
fn lists_pagination_and_persisted_queries_match_the_frozen_expectation() {
    let (tree, diagnostics) = assert_frozen(
        &fixture("persisted_lists"),
        &["--persisted"],
        &snapshots()["persisted_lists_persisted"],
    );
    assert_eq!(diagnostics.len(), 0);
    let manifest = &tree["manifest.json"];
    assert!(manifest.contains("\"lists\": {"), "the @list registration is in the manifest");
    assert!(manifest.contains("\"Found\": {"), "the list is keyed by its name");
    assert!(manifest.contains("\"fragments\": {}"), "a project without fragments");
    assert!(manifest.contains("\"paginated\": {"), "the paginated document is recorded");
    assert!(manifest.contains("\"persisted\": {"), "--persisted registers the id map");
    let persisted = &tree["persisted.json"];
    assert!(persisted.starts_with("{\n  \"format\": \"flamme-persisted-query-manifest\","));
    assert!(persisted.contains("\"idRule\": \"sha256(raw)\""));
    assert!(persisted.contains("\"type\": \"mutation\""));
    let favorites = &tree["artifacts/Favorites.ts"];
    assert!(favorites.contains("\"list\": {"), "the artifact carries the list metadata");
    let add_favorite = &tree["artifacts/AddFavorite.ts"];
    assert!(add_favorite.contains("\"operations\": ["), "the payload carries list operations");
    assert!(add_favorite.contains("\"action\": \"toggle\""));
}

#[test]
fn deferred_branches_and_optimistic_keys_match_the_frozen_expectation() {
    let (tree, diagnostics) = assert_frozen(&fixture("emit_branches"), &[], &snapshots()["emit_branches"]);
    assert_eq!(diagnostics.len(), 1, "@required on a non-null field warns");
    let deferred = &tree["artifacts/Deferred.ts"];
    assert!(deferred.contains("export function isPreviewReady(result: QueryResult<Deferred$result>)"));
    assert!(deferred.contains("export function hasPreview("), "the stream/defer key predicate");
    assert!(deferred.contains("value: Incremental<NonNullable<Deferred$unmasked[\"species\"]>>"));
    assert!(deferred.contains("value[\"flavorText\"] !== undefined;"));
    assert!(
        deferred.contains("export function isPreview2Ready("),
        "two labels that pascal-case alike get numbered helpers"
    );
    assert!(
        deferred.contains(
            "NonNullable<Extract<NonNullable<NonNullable<Deferred$unmasked[\"species\"]>[\"creature\"]>, { readonly flavorText?: unknown }>[\"flavorText\"]>"
        ),
        "a defer target inside a union renders through Extract"
    );
    assert!(
        deferred.contains("\"flavorText\" in value && value[\"flavorText\"] !== undefined;"),
        "and its key test needs the `in` guard"
    );
    assert!(deferred.contains("readonly __typename: \"%other\";"), "the union fallback branch");
    assert!(deferred.contains("\"policy\": \"NetworkOnly\""));
    assert!(deferred.contains("\"partial\": true"));
    assert!(deferred.contains("\"deferred\": ["), "the recorded defer/stream targets");
    let rename = &tree["artifacts/Rename.ts"];
    assert!(rename.contains("export type Rename$optimistic = {"));
    assert!(rename.contains("\"optimisticKeys\": true"));
    let watch = &tree["artifacts/Watch.ts"];
    assert!(watch.contains("export type Watch = Artifact<'subscription', Watch$result, Watch$input, never>"));
}

#[test]
fn emit_tree_contributes_files_in_plugin_order() {
    let project = fixture("poc");
    let (frozen_run, response) = compile_frozen(
        &project,
        &["--persisted"],
        &snapshots()["poc_persisted"],
    );
    support::assert_matches(&project, &frozen_run, &response);
    let paths: Vec<String> = response.files.iter().map(|file| file.path.clone()).collect();
    let first_aggregate = paths
        .iter()
        .position(|path| !path.starts_with("artifacts/"))
        .expect("the tree has aggregate members");
    assert!(
        paths[..first_aggregate].iter().all(|path| path.ends_with(".ts")),
        "the artifacts come first"
    );
    assert_eq!(
        &paths[first_aggregate..],
        [
            "index.ts",
            "ambient.d.ts",
            "props.ts",
            "schema.graphql",
            "graphql/enums.ts",
            "graphql/inputs.ts",
            "tsconfig.json",
            "runtime/index.ts",
            "manifest.json",
            "persisted.json",
        ]
    );
}

// ---------------------------------------------------------------------------
// The persisted-query check (`FLM1025`)
// ---------------------------------------------------------------------------

#[test]
fn persisted_check_mode_reports_a_missing_manifest() {
    let project = fixture("persisted_lists");
    let snapshot = &snapshots()["persisted_lists_check_persisted"];
    let frozen_run = Frozen::from_json(&project, snapshot);
    assert!(frozen_run.files.is_empty(), "check mode writes no tree");
    assert_eq!(frozen_run.diagnostics.len(), 1, "the committed manifest is missing");
    // The frozen run's manifest path is inside the throwaway runtime directory it was
    // frozen with, so the drift check is handed the same path the snapshot reports.
    let path = frozen_run.diagnostics[0].location.file.clone();
    let response = flamme_core::compile(&flamme_core::request::CompileRequest {
        route_documents: None,
        config: frozen_run.config.clone(),
        schema: frozen_run.schema.clone(),
        files: Some(frozen_run.inputs.clone()),
        options: CompileOptions {
            check: true,
            persisted: true,
            files: None,
            include_ir: false,
            save_cache: false,
        },
        persisted_committed: None,
        persisted_path: Some(path.clone()),
        cache: None,
        sources: None,
    });
    assert_eq!(response.diagnostics.len(), 1);
    let diagnostic = &response.diagnostics[0];
    assert_eq!(diagnostic.code, "FLM1025");
    assert_eq!(diagnostic.message, frozen_run.diagnostics[0].message);
    assert_eq!(diagnostic.hint, frozen_run.diagnostics[0].hint);
    assert_eq!(diagnostic.location, frozen_run.diagnostics[0].location);
    assert!(diagnostic.message.contains(&path), "the message names the manifest");
}

#[derive(Deserialize)]
struct PersistedCase {
    name: String,
    path: String,
    committed: Option<String>,
    diagnostic: Option<Diagnostic>,
}

#[derive(Deserialize)]
struct CaseDocument {
    name: String,
    kind: ArtifactKind,
    hash: String,
    raw: String,
}

#[derive(Deserialize)]
struct PersistedDump {
    cases: Vec<PersistedCase>,
    documents: Vec<CaseDocument>,
}

/// The persisted-manifest drift cases (`missing`, `current`, `stale-id`,
/// `extra-id`, `dropped-id` and `unreadable`) and the PoC documents they run
/// against, frozen from the TypeScript implementation at a fixed path.
#[test]
fn persisted_id_drift_matches_the_frozen_implementation() {
    let dump: PersistedDump = serde_json::from_value(snapshots()["persisted_cases"].clone())
        .expect("the frozen persisted cases deserialize");
    let documents: Vec<IrDocument> = dump
        .documents
        .into_iter()
        .map(|document| {
            stub_document(&document.name, document.kind, &document.hash, &document.raw)
        })
        .collect();
    assert!(documents.len() >= 3, "the PoC has three operations");
    assert_eq!(dump.cases.len(), 6);
    for case in &dump.cases {
        let actual =
            persisted_manifest_diagnostic(&documents, &case.path, case.committed.as_deref());
        assert_eq!(
            actual.as_ref(),
            case.diagnostic.as_ref(),
            "the FLM1025 diagnostic for the {} manifest differs",
            case.name
        );
    }
    let by_name = |name: &str| dump.cases.iter().find(|case| case.name == name).expect("case");
    assert!(by_name("current").diagnostic.is_none(), "a current manifest reports nothing");
    for name in ["missing", "stale-id", "extra-id", "dropped-id", "unreadable"] {
        assert!(by_name(name).diagnostic.is_some(), "{name} reports a diagnostic");
    }
    assert!(by_name("stale-id").diagnostic.as_ref().expect("stale").message.contains("is stale"));
}

// ---------------------------------------------------------------------------
// Emitters the fixture tree does not reach
// ---------------------------------------------------------------------------

/// `withGeneratedBanner` on every shape it accepts, against the frozen output of the
/// TypeScript implementation for the same ten inputs.
#[test]
fn with_generated_banner_matches_the_frozen_implementation() {
    let expected: Vec<String> = serde_json::from_value(snapshots()["banner"].clone())
        .expect("the frozen banner cases deserialize");
    let banner = emit::GENERATED_BANNER;
    let inputs = [
        format!("{banner}\nexport const a = 1\n"),
        "// GENERATED by something, do not edit.\nexport const a = 1\n".to_string(),
        "// GENERATED by something, do not edit.\n//\nexport const a = 1\n".to_string(),
        "// GENERATED by something, do not edit.\n// a note\nexport const a = 1\n".to_string(),
        "// GENERATED by something else.\nexport const a = 1\n".to_string(),
        "export const a = 1\n".to_string(),
        String::new(),
        "// GENERATED by something, do not edit.".to_string(),
        "// GENERATED by something, do not edit.\r\nexport const a = 1\r\n".to_string(),
        banner.to_string(),
    ];
    assert_eq!(expected.len(), inputs.len());
    for (index, input) in inputs.iter().enumerate() {
        assert_same_text(
            &format!("withGeneratedBanner({index})"),
            &expected[index],
            &emit::with_generated_banner(input),
        );
    }
    assert!(expected[1].starts_with(banner), "a generation header is rewritten");
    assert!(expected[2].starts_with(&format!("{banner}\nexport const")), "the bare `//` goes too");
    assert_eq!(expected[9], banner, "an already-bannered module is returned unchanged");
}

/// A [`SchemaIndex`] carrying only what `emit_schema_file` reads.
fn schema_with_sdl(sdl: &str, has_key_directive: bool) -> SchemaIndex {
    SchemaIndex {
        types: Vec::new(),
        type_positions: HashMap::new(),
        possible_types: JsObject::new(),
        key_fields: JsObject::new(),
        schema_key_fields: JsObject::new(),
        enums: JsObject::new(),
        input_types: JsObject::new(),
        hash: String::new(),
        sdl: sdl.to_string(),
        index_sdl: sdl.to_string(),
        file: "schema.graphql".to_string(),
        has_key_directive,
        document: Default::default(),
        diagnostics: Vec::new(),
    }
}

/// `emitSchemaFile` on schemas that declare some, none or all of the compiler's
/// directives, including one written across two lines and one only mentioned in a
/// comment, against the frozen output of the TypeScript implementation.
#[test]
fn schema_file_directive_merging_matches_the_frozen_implementation() {
    let expected: Vec<String> = serde_json::from_value(snapshots()["schema_file"].clone())
        .expect("the frozen schema cases deserialize");
    let plain = "type Query {\n  id: ID!\n}";
    let cases: [(String, bool); 8] = [
        (plain.to_string(), false),
        (
            "directive @key(fields: [String!]!) on OBJECT | INTERFACE\n\ntype Query {\n  id: ID!\n}\n"
                .to_string(),
            true,
        ),
        (
            "enum PaginateMode {\n  SinglePage\n  Infinite\n}\n\ntype Query {\n  id: ID!\n}\n"
                .to_string(),
            false,
        ),
        (
            "directive   @key(fields: [String!]!) on OBJECT | INTERFACE\n\ntype Query {\n  id: ID!\n}\n"
                .to_string(),
            false,
        ),
        (
            "type Query {\n  id: ID!\n}\n\ndirective\n  @key(fields: [String!]!) on OBJECT | INTERFACE\n"
                .to_string(),
            false,
        ),
        (
            "# directive @key(fields: [String!]!) on OBJECT | INTERFACE\ntype Query {\n  id: ID!\n}\n"
                .to_string(),
            false,
        ),
        (
            "directive @keyrings(x: Int) on OBJECT\n\ntype Query {\n  id: ID!\n}\n".to_string(),
            false,
        ),
        ("type Query { id: ID! }".to_string(), false),
    ];
    assert_eq!(expected.len(), cases.len());
    for (index, (sdl, has_key_directive)) in cases.iter().enumerate() {
        assert_same_text(
            &format!("emitSchemaFile({index})"),
            &expected[index],
            &emit::emit_schema_file(&schema_with_sdl(sdl, *has_key_directive)),
        );
    }
    assert!(
        expected[0].contains("enum DedupeMatchMode { variables all }"),
        "the missing definitions are appended in the compiler's own order"
    );
    assert!(
        expected[0].contains("directive @mask_disable on FRAGMENT_SPREAD"),
        "including the later directive definitions"
    );
    assert_eq!(
        expected[1],
        "directive @key(fields: [String!]!) on OBJECT | INTERFACE\n\ntype Query {\n  id: ID!\n}\n",
        "a schema that already declares @key is passed through verbatim"
    );
    assert!(
        !expected[2].contains("enum PaginateMode { SinglePage Infinite }"),
        "a declared enum is not added twice"
    );
    assert!(
        expected[2].contains("directive @key(fields: [String!]!)"),
        "the definitions it does not declare are still added"
    );
    assert!(
        expected[3].contains("directive   @key("),
        "the schema's own spelling survives"
    );
    assert!(
        !expected[3].contains("\ndirective @key(fields: [String!]!) on OBJECT | INTERFACE\n"),
        "extra whitespace still counts as a declaration"
    );
    assert!(
        !expected[4].contains("\ndirective @key(fields: [String!]!) on OBJECT | INTERFACE\n"),
        "so does one written across a line break"
    );
    assert!(
        expected[5].contains("\ndirective @key(fields: [String!]!) on OBJECT | INTERFACE\n"),
        "a mention in a comment is not a declaration"
    );
    assert!(
        expected[6].contains("\ndirective @key(fields: [String!]!) on OBJECT | INTERFACE\n"),
        "a differently named directive is not @key"
    );
    assert!(
        expected[7].ends_with("}\n"),
        "a schema without a trailing newline gains one"
    );
}

#[derive(Deserialize)]
struct EmitterDump {
    ambient: String,
    index: String,
}

/// `emitAmbient` and `emitIndex` on documents that share a name, which no project
/// can compile: the barrel keys its map by the raw text and dedupes it.
#[test]
fn ambient_and_index_match_the_frozen_expectation_for_same_named_documents() {
    let dump: EmitterDump = serde_json::from_value(snapshots()["ambient"].clone())
        .expect("the frozen ambient dump deserializes");
    let documents = vec![
        stub_document("Info", ArtifactKind::Query, "", "query Info {\n    __typename\n}\n"),
        stub_document("Info", ArtifactKind::Fragment, "", "fragment Info on Species {\n    id\n}\n"),
        stub_document("Info", ArtifactKind::Query, "", "query Info {\n    __typename\n}\n"),
        stub_document("Alpha", ArtifactKind::Fragment, "", "fragment Alpha on Species {\n    id\n}\n"),
        stub_document("Beta", ArtifactKind::Query, "", "query Beta {\n    __typename\n}\n"),
        stub_document("info", ArtifactKind::Query, "", "query info {\n    __typename\n}\n"),
    ];
    assert_same_text(
        "emitAmbient",
        &dump.ambient,
        &emit::emit_ambient(&documents, &[".gql".into(), ".graphql".into()]),
    );
    assert_same_text("emitIndex", &dump.index, &emit::emit_index(&documents));
    assert_eq!(
        dump.ambient.matches("declare module").count(),
        6,
        "one module per query name per document extension"
    );
    assert_eq!(dump.index.matches("DocumentMap {").count(), 1);
}
