//! Pagination and list-operation rules (`spec/spec.md` §6.7, §6.8, §7.3).
//!
//! These surfaces have no counterpart in the frozen snapshot corpus
//! (`@paginate(name:)`'s list registration, the four argument-shape diagnostics, the offset
//! argument plan and the `_upsert` spread). Everything the shared corpus covers is pinned by the
//! frozen snapshots; this file pins the rest, with inline projects so no shared fixture has to
//! exercise it.

use flamme_core::config::RustConfig;
use flamme_core::contract::{ArtifactKind, IrDocument};
use flamme_core::diagnostics::Diagnostic;
use flamme_core::extract::{DocumentSurface, RawDocument};
use flamme_core::ir::build_ir;
use flamme_core::offsets::{Offset, SourceText};
use flamme_core::schema::{SchemaIndexOptions, build_schema_index};
use flamme_core::validate::{ValidateOptions, prepare_project, validate_project};

/// A schema with every pagination shape the rules distinguish.
const SCHEMA: &str = r#"
type Query {
	moves(first: Int, after: String, last: Int, before: String): MoveConnection!
	movesFwd(first: Int, after: String): MoveConnection!
	movesBack(last: Int, before: String): MoveConnection!
	noCursor: MoveConnection!
	plain(offset: Int, limit: Int): [Move!]!
	plainNeither: [Move!]!
}
type Mutation {
	plain(offset: Int, limit: Int): [Move!]!
}
type MoveConnection { edges: [MoveEdge!]! nodes: [Move!]! pageInfo: PageInfo! }
type MoveEdge { cursor: String node: Move! }
type Move { id: ID! name: String! }
type PageInfo { endCursor: String hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String }
"#;

/// One inline document.
fn document(name: &str, kind: ArtifactKind, text: &str) -> RawDocument {
    let ast = flamme_core::graphql::parse_document(text)
        .unwrap_or_else(|error| panic!("the test document parses: {error}\n{text}"));
    RawDocument {
        name: name.to_string(),
        kind,
        raw: text.to_string(),
        file: format!("src/{name}.gql"),
        relative_path: format!("src/{name}.gql"),
        surface: DocumentSurface::File,
        offset: 0,
        start: 0,
        end: text.len() as Offset,
        source_offsets: Vec::new(),
        ast,
        source: SourceText::new(text),
    }
}

/// Every diagnostic of one document, in the order the pipeline reports them.
fn diagnostics_of(text: &str) -> Vec<Diagnostic> {
    let config = RustConfig::default();
    let schema = build_schema_index(
        SCHEMA,
        &SchemaIndexOptions::from_config(&config),
        "<inline>",
    )
    .expect("the test schema indexes");
    let documents = vec![document("Doc", ArtifactKind::Query, text)];
    let prepared = prepare_project(&config, &schema, &documents);
    let mut diagnostics = Vec::new();
    diagnostics.extend(prepared.diagnostics.iter().cloned());
    diagnostics.extend(validate_project(&ValidateOptions {
        config: &config,
        schema: &schema,
        documents: &documents,
        imports: &[],
        imported_names: &[],
        index: &prepared.index,
    }));
    diagnostics
}

/// The codes one document's diagnostics carry.
fn codes_of(text: &str) -> Vec<String> {
    diagnostics_of(text)
        .into_iter()
        .map(|entry| entry.code)
        .collect()
}

/// The one diagnostic with `code`.
fn only(text: &str, code: &str) -> Diagnostic {
    let matches: Vec<Diagnostic> = diagnostics_of(text)
        .into_iter()
        .filter(|entry| entry.code == code)
        .collect();
    assert_eq!(matches.len(), 1, "expected exactly one {code} in {text:?}");
    matches.into_iter().next().expect("checked")
}

/// The IR of one document.
fn ir_of(text: &str) -> IrDocument {
    let config = RustConfig::default();
    let schema = build_schema_index(
        SCHEMA,
        &SchemaIndexOptions::from_config(&config),
        "<inline>",
    )
    .expect("the test schema indexes");
    let documents = vec![document("Doc", ArtifactKind::Query, text)];
    let prepared = prepare_project(&config, &schema, &documents);
    build_ir(&documents[0], &documents, &prepared.index, &schema, &config)
}

// ---------------------------------------------------------------------------
// `@paginate(name:)`
// ---------------------------------------------------------------------------

#[test]
fn a_named_paginate_enrols_the_connection_in_the_list_system() {
    let document = ir_of(
        "query Q { moves(first: 1) @paginate(name: \"Moves_List\") { edges { node { id } } } }",
    );
    let moves = document
        .selection
        .fields
        .get("moves")
        .expect("the field is selected");
    let list = moves
        .list
        .as_ref()
        .expect("a named paginate writes a list spec");
    assert_eq!(list.name, "Moves_List");
    assert!(list.connection, "a connection stays a connection");
    assert_eq!(
        list.type_name, "Move",
        "the element type, not the connection type"
    );
    // the artifact still carries the pagination spec beside it
    assert_eq!(
        moves.pagination.as_ref().map(|spec| spec.method.as_str()),
        Some("cursor")
    );
}

#[test]
fn a_paginate_without_a_name_warns_and_names_the_fix() {
    let diagnostic = only(
        "query Q { moves(first: 1) @paginate { edges { node { id } } } }",
        "FLM1032",
    );
    assert_eq!(
        diagnostic.severity,
        flamme_core::diagnostics::Severity::Warning
    );
    assert!(
        diagnostic
            .message
            .contains("@paginate on \"moves\" has no \"name\"")
    );
    assert!(
        diagnostic.hint.as_deref().is_some_and(
            |hint| hint.contains("name: \"Moves\"") && hint.contains("...Moves_insert")
        ),
        "the hint names the fix: {:?}",
        diagnostic.hint
    );
    // and the document still compiles: a bare `@paginate` pages, it just cannot be targeted
    assert_eq!(
        codes_of("query Q { moves(first: 1) @paginate { edges { node { id } } } }"),
        ["FLM1032"]
    );
}

#[test]
fn list_and_paginate_on_one_field_is_rejected_with_houdinis_reasoning() {
    let diagnostic = only(
        "query Q { moves(first: 1) @paginate(name: \"Moves_List\") @list(name: \"Other\") { edges { node { id } } } }",
        "FLM1033",
    );
    assert_eq!(
        diagnostic.message,
        "@list is unnecessary on a field annotated with @paginate, simply use the 'name' parameter on @paginate instead"
    );
}

// ---------------------------------------------------------------------------
// The four argument shapes (`lists/validate.go:1402-1448`)
// ---------------------------------------------------------------------------

#[test]
fn a_cursor_connection_needs_first_or_last_outside_single_page() {
    let diagnostic = only(
        "query Q { moves @paginate(mode: Infinite, name: \"M\") { edges { node { id } } } }",
        "FLM1034",
    );
    assert!(
        diagnostic
            .message
            .contains("with cursor-based pagination must have either")
    );
    assert!(diagnostic.message.contains("add \"first: 10\""));
    // SinglePage exempts it, exactly as Houdini's `paginateMode != "SinglePage"` guard does
    assert_eq!(
        codes_of(
            "query Q { moves @paginate(mode: SinglePage, name: \"M\") { edges { node { id } } } }"
        ),
        Vec::<String>::new()
    );
}

#[test]
fn a_cursor_connection_cannot_apply_first_and_last_in_infinite_mode() {
    let diagnostic = only(
        "query Q { moves(first: 1, last: 1) @paginate(mode: Infinite, name: \"M\") { edges { node { id } } } }",
        "FLM1035",
    );
    assert!(
        diagnostic
            .message
            .contains("cannot have both \"first\" and \"last\"")
    );
    assert!(diagnostic.message.contains("mode: SinglePage"));
}

/// `SinglePage` exempts the cursor argument shapes, `first` + `last` included.
///
/// The exemption is what Houdini's `paginateMode != "SinglePage"` guard does; without it a
/// `SinglePage` connection that asks for both ends would be rejected even though the runtime
/// never pages it in either direction (`review-f5a`).
#[test]
fn single_page_exempts_a_connection_that_applies_both_first_and_last() {
    assert_eq!(
        codes_of(
            "query Q { moves(first: 1, last: 1) @paginate(mode: SinglePage, name: \"M\") { edges { node { id } } } }"
        ),
        Vec::<String>::new()
    );
    let document = ir_of(
        "query Q { moves(first: 1, last: 1) @paginate(mode: SinglePage, name: \"M\") { edges { node { id } } } }",
    );
    let moves = document.selection.fields.get("moves").expect("moves");
    assert_eq!(
        moves.pagination.as_ref().map(|spec| spec.mode.as_str()),
        Some("SinglePage"),
        "the exemption is the mode's, and the mode is recorded"
    );
}

#[test]
fn an_offset_list_needs_a_limit() {
    let diagnostic = only(
        "query Q { plain(offset: 0) @paginate(mode: Infinite, name: \"P\") { id } }",
        "FLM1036",
    );
    assert!(
        diagnostic
            .message
            .contains("offset-based pagination must have a \"limit\"")
    );
    assert!(diagnostic.message.contains("add \"limit: 10\""));
}

#[test]
fn a_field_with_neither_strategy_is_rejected() {
    let diagnostic = only(
        "query Q { noCursor @paginate(mode: Infinite, name: \"N\") { edges { node { id } } } }",
        "FLM1037",
    );
    assert!(
        diagnostic
            .message
            .contains("does not support a valid pagination mode")
    );
    assert!(diagnostic.message.contains("Query.noCursor"));
}

#[test]
fn a_non_pagination_field_keeps_its_connection_diagnostic_only() {
    // `plainNeither` is a list without offset/limit, so it is a valid *list* for `@list` and an
    // invalid pagination target for `@paginate` (FLM1037). A field that is neither a connection nor
    // a list is FLM1007, not a strategy diagnostic.
    assert_eq!(
        codes_of("query Q { plainNeither @paginate(mode: Infinite, name: \"P\") { id } }"),
        ["FLM1037"]
    );
}

// ---------------------------------------------------------------------------
// The IR's method, direction and offset data
// ---------------------------------------------------------------------------

#[test]
fn the_method_comes_from_the_value_type_and_the_direction_from_the_schema() {
    let both = ir_of(
        "query Q { moves(first: 1, last: 2) @paginate(mode: SinglePage, name: \"M\") { edges { node { id } } } }",
    );
    let refetch = both
        .refetch
        .expect("a paginated document carries a refetch spec");
    assert_eq!(refetch.method, "cursor");
    assert_eq!(refetch.direction, "both");
    assert_eq!(refetch.page_size, 1, "the first literal wins over last");
    let spec = both
        .selection
        .fields
        .get("moves")
        .and_then(|field| field.pagination.as_ref());
    assert_eq!(spec.map(|spec| spec.supports_forward), Some(true));
    assert_eq!(spec.map(|spec| spec.supports_backward), Some(true));

    let forward = ir_of(
        "query Q { movesFwd(first: 2) @paginate(mode: Infinite, name: \"F\") { edges { node { id } } } }",
    );
    let refetch = forward.refetch.expect("refetch");
    assert_eq!(refetch.direction, "forward");
    assert_eq!(refetch.page_size, 2);

    let backward = ir_of(
        "query Q { movesBack(last: 3) @paginate(mode: Infinite, name: \"B\") { edges { node { id } } } }",
    );
    let refetch = backward.refetch.expect("refetch");
    assert_eq!(refetch.direction, "backward");
    assert_eq!(refetch.page_size, 3, "`last` is a page size too");
}

#[test]
fn an_offset_list_paginates_forward_with_limit_offset_variables() {
    let document = ir_of(
        "query Q($limit: Int = 5) { plain(limit: $limit, offset: 0) @paginate(mode: Infinite, name: \"P\") { id name } }",
    );
    let refetch = document
        .refetch
        .clone()
        .expect("an offset document carries a refetch spec");
    assert_eq!(refetch.method, "offset");
    assert_eq!(refetch.direction, "forward");
    assert_eq!(
        refetch.page_size, 5,
        "the page size is the variable's own default"
    );
    assert_eq!(
        refetch.page_size,
        document
            .selection
            .fields
            .get("plain")
            .expect("plain")
            .pagination
            .as_ref()
            .unwrap()
            .page_size
    );

    let plain = document
        .selection
        .fields
        .get("plain")
        .expect("the field is selected");
    assert_eq!(
        plain.updates.as_deref(),
        Some(["append".to_string()].as_slice()),
        "an offset page merges into the field itself"
    );
    assert!(
        plain
            .selection
            .as_ref()
            .is_some_and(|child| child.fields.get("pageInfo").is_none()),
        "a list has no pageInfo to inject"
    );
    // `keyRaw` keeps the user's own spelling (the offset literal included), which is what makes
    // every Infinite page land under one key; `raw` is where the page variables appear.
    assert_eq!(plain.key_raw, "plain(limit: $limit, offset: 0)::paginated");

    // the literal `offset: 0` becomes a page variable with that default; `limit` was already one
    assert!(
        document
            .raw
            .contains("plain(limit: $limit, offset: $offset)"),
        "{}",
        document.raw
    );
    assert!(
        !document.raw.contains("pageInfo"),
        "a list has no pageInfo to inject into the document: {}",
        document.raw
    );
    assert!(
        document.raw.contains("$offset: Int"),
        "the offset variable is declared: {}",
        document.raw
    );
    assert!(
        document.raw.contains("$limit: Int = 5"),
        "the user's own declaration is untouched: {}",
        document.raw
    );
    // the literal arrives as the injected variable's default in `input.defaults`
    assert_eq!(
        document.input.defaults.get("offset"),
        Some(&serde_json::json!(0))
    );
}

/// A `SinglePage` offset list replaces its window, so it carries no `updates`.
///
/// Houdini writes the merge directions for the `Infinite` forms only; emitting `['append']` for a
/// `SinglePage` page made the runtime append a window the reference replaces (`review-f5b`).
#[test]
fn an_offset_list_in_single_page_mode_carries_no_merge_direction() {
    let document = ir_of(
        "query Q($limit: Int = 5) { plain(limit: $limit, offset: 0) @paginate(mode: SinglePage, name: \"P\") { id name } }",
    );
    let plain = document.selection.fields.get("plain").expect("the field is selected");
    let pagination = plain.pagination.as_ref().expect("a paginated field carries the spec");
    assert_eq!(pagination.mode, "SinglePage");
    assert_eq!(pagination.method, "offset");
    assert_eq!(
        plain.updates, None,
        "a SinglePage page is the window itself: nothing merges into it"
    );
    let refetch = document.refetch.expect("an offset document still pages");
    assert_eq!(refetch.method, "offset");
    assert_eq!(refetch.mode, "SinglePage");
    assert_eq!(refetch.page_size, 5);
}

#[test]
fn an_infinite_connection_records_its_page_size_and_merge_directions() {
    let document = ir_of(
        "query Q($first: Int = 10) { moves(first: $first) @paginate(mode: Infinite, name: \"M\") { edges { node { id } } } }",
    );
    let refetch = document.refetch.expect("refetch");
    assert_eq!(refetch.method, "cursor");
    assert_eq!(
        refetch.page_size, 10,
        "the variable's default supplies the page size"
    );
    let edges = document
        .selection
        .fields
        .get("moves")
        .expect("moves")
        .selection
        .as_ref()
        .and_then(|selection| selection.fields.get("edges"))
        .expect("edges");
    assert_eq!(
        edges.updates.as_deref(),
        Some(["append".to_string()].as_slice())
    );
    let page_info = document
        .selection
        .fields
        .get("moves")
        .expect("moves")
        .selection
        .as_ref()
        .and_then(|selection| selection.fields.get("pageInfo"))
        .expect("pageInfo is injected when the document does not select it");
    assert_eq!(
        page_info.visible,
        Some(false),
        "the injected pageInfo stays hidden from masking"
    );
    let fields = page_info
        .selection
        .as_ref()
        .expect("pageInfo has a selection");
    for name in ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"] {
        assert!(fields.fields.get(name).is_some(), "pageInfo carries {name}");
    }
}

// ---------------------------------------------------------------------------
// `_upsert` is a list-operation spread
// ---------------------------------------------------------------------------

#[test]
fn upsert_is_recognised_as_a_list_operation_spread() {
    let config = RustConfig::default();
    let schema = build_schema_index(
        SCHEMA,
        &SchemaIndexOptions::from_config(&config),
        "<inline>",
    )
    .expect("the test schema indexes");
    let documents = vec![
        document(
            "Favorites",
            ArtifactKind::Query,
            "query Favorites { plain(limit: 2) @list(name: \"Fav\") { id } }",
        ),
        document(
            "AddMove",
            ArtifactKind::Mutation,
            "mutation AddMove { plain(limit: 1) { ...Fav_upsert } }",
        ),
        document(
            "RemoveMove",
            ArtifactKind::Mutation,
            "mutation RemoveMove { plain(limit: 1) { ...Fav_remove } }",
        ),
    ];
    let prepared = prepare_project(&config, &schema, &documents);
    let diagnostics = validate_project(&ValidateOptions {
        config: &config,
        schema: &schema,
        documents: &documents,
        imports: &[],
        imported_names: &[],
        index: &prepared.index,
    });
    // No FLM1001: the pseudo-fragment resolves instead of being an unknown fragment.
    let unknown: Vec<&Diagnostic> = diagnostics
        .iter()
        .filter(|entry| entry.code == "FLM1001")
        .collect();
    assert!(
        unknown.is_empty(),
        "unexpected unknown fragments: {unknown:?}"
    );
    let action = flamme_core::validate::list_fragment_action("Fav_upsert");
    assert_eq!(action, Some(("Fav".to_string(), "upsert".to_string())));
    // the operation reaches the artifact as `upsert`, which the runtime's `ListManager` applies
    let mutation = build_ir(&documents[1], &documents, &prepared.index, &schema, &config);
    let operations = mutation
        .selection
        .fields
        .get("plain")
        .and_then(|field| field.operations.clone())
        .unwrap_or_default();
    assert_eq!(operations.len(), 1, "the spread records one operation");
    assert_eq!(operations[0].action, "upsert");
    assert_eq!(operations[0].list, "Fav");
    // `_update` records no artifact operation and `_delete` is a directive, so neither is adopted.
    assert_eq!(
        flamme_core::validate::list_fragment_action("Fav_update"),
        None
    );
    assert_eq!(
        flamme_core::validate::list_fragment_action("Move_delete"),
        None
    );
}

// ---------------------------------------------------------------------------
// The resolved `@paginate` mode in the artifact's recorded directives
// ---------------------------------------------------------------------------

/// A bare `@paginate` records the **resolved** mode, not the directive's spelling.
///
/// `FieldSpec.pagination.mode` follows the config default (`Infinite`), so the
/// `directives` entry a reader compares it against has to name the same mode; the old
/// hardcoded `SinglePage` made the two disagree on the same artifact
/// (`packages/core/src/ir.ts:1380-1405`).
#[test]
fn a_bare_paginate_records_the_resolved_mode() {
    let document = ir_of("query Q { moves(first: 1) @paginate(name: \"M\") { edges { node { id } } } }");
    let moves = document.selection.fields.get("moves").expect("selected");
    let resolved = moves
        .pagination
        .as_ref()
        .expect("a paginated field carries the spec");
    assert_eq!(resolved.mode, "Infinite", "the config default resolves the mode");
    let mode = moves
        .directives
        .as_ref()
        .expect("the artifact keeps the paginate directive")
        .iter()
        .find(|directive| directive.name == "paginate")
        .and_then(|directive| directive.arguments.get("mode"))
        .expect("the recorded directive carries a mode");
    assert_eq!(
        mode,
        &flamme_core::contract::GraphQLValue::EnumValue {
            value: "Infinite".to_string()
        },
        "the recorded mode is the resolved one, not the directive's default spelling"
    );
}

/// An explicit mode still wins over the config default.
#[test]
fn an_explicit_paginate_mode_is_recorded_verbatim() {
    let document = ir_of(
        "query Q { moves(first: 1) @paginate(mode: SinglePage, name: \"M\") { edges { node { id } } } }",
    );
    let moves = document.selection.fields.get("moves").expect("selected");
    assert_eq!(
        moves.pagination.as_ref().map(|spec| spec.mode.as_str()),
        Some("SinglePage")
    );
    let recorded = moves
        .directives
        .as_ref()
        .and_then(|directives| directives.iter().find(|entry| entry.name == "paginate"))
        .and_then(|directive| directive.arguments.get("mode"))
        .expect("a recorded mode");
    assert_eq!(
        recorded,
        &flamme_core::contract::GraphQLValue::EnumValue {
            value: "SinglePage".to_string()
        }
    );
}
/// A `@paginate` connection that selects only `nodes` still gets the `edges` tree it needs.
///
/// The runtime's `ListManager` writes a synthesized edge into the connection's `edges`, and a page
/// snapshot reads them; a connection the compiler never gave `edges` silently swallowed every
/// insert and read as an empty connection (`review-f3`). The injection is the reference's repair
/// (`lists/validate.go:953-1020`), so the document still asks for the user's `nodes` and the
/// injected `edges` is internal.
#[test]
fn a_nodes_only_connection_gets_the_edges_tree_injected() {
    let document = ir_of(
        "query Q { moves(first: 1) @paginate(name: \"M\") { nodes { id name } } }",
    );
    let moves = document.selection.fields.get("moves").expect("the field is selected");
    let connection = moves
        .selection
        .as_ref()
        .expect("a connection has a selection");
    let edges = connection
        .fields
        .get("edges")
        .expect("`edges` is injected for a connection that selects only `nodes`");
    assert_eq!(edges.visible, Some(false), "the injection is internal");
    assert_eq!(edges.key_raw, "edges");
    assert_eq!(edges.type_name, "MoveEdge");
    assert_eq!(edges.modifiers, "[MoveEdge!]!");
    let edge_fields = edges.selection.as_ref().expect("edges has a selection");
    assert!(
        edge_fields.fields.get("__typename").is_some(),
        "the edge carries __typename"
    );
    let node = edge_fields
        .fields
        .get("node")
        .expect("`node` is injected when the edge type declares it");
    assert_eq!(node.type_name, "Move");
    assert_eq!(node.modifiers, "Move!");
    assert!(
        node.selection
            .as_ref()
            .is_some_and(|selection| selection.fields.get("__typename").is_some()),
        "the node carries __typename"
    );
    // the user's own selection is untouched
    assert!(connection.fields.get("nodes").is_some());

    // the wire document asks for the same repair, or the server returns no edges to write into
    let raw = &document.raw;
    assert!(
        raw.contains("edges {"),
        "the injected edges are in `raw`: {raw}"
    );
    assert!(raw.contains("nodes {"), "the user's selection stays: {raw}");
    assert!(!raw.contains("@paginate"), "the directive is stripped: {raw}");
}

/// A connection that already selects `edges` is not repaired twice.
#[test]
fn a_connection_that_selects_edges_is_left_alone() {
    let document = ir_of(
        "query Q { moves(first: 1) @paginate(name: \"M\") { edges { node { id } } pageInfo { hasNextPage } } }",
    );
    let raw = &document.raw;
    assert_eq!(
        raw.matches("edges {").count(),
        1,
        "exactly one edges selection: {raw}"
    );
    assert_eq!(
        raw.matches("pageInfo {").count(),
        1,
        "exactly one pageInfo selection: {raw}"
    );
}
