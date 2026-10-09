//! The list-operation directives: `@when`/`@when_not` filters, `@allLists`,
//! `@includeListID` and `@listID` (research §4, §5, §6 and §8 of
//! `research/houdini-lists-and-pagination.md`).
//!
//! These surfaces have no counterpart in the frozen snapshot corpus, so no shared
//! fixture exercises them. Everything here has inline documents and an inline schema,
//! and each rule is asserted on the artifact the compiler actually produces.

use flamme_core::config::RustConfig;
use flamme_core::contract::{ArtifactKind, GraphQLValue, IrDocument, ListWhen};
use flamme_core::diagnostics::{Diagnostic, Severity};
use flamme_core::extract::{DocumentSurface, RawDocument};
use flamme_core::ir::build_ir;
use flamme_core::offsets::{Offset, SourceText};
use flamme_core::schema::{build_schema_index, SchemaIndexOptions};
use flamme_core::validate::{prepare_project, validate_project, ValidateOptions};

/// A schema with a plain list, a connection and a `Node` type to hang a fragment on.
const SCHEMA: &str = r#"
type Query {
	items(status: String, limit: Int): [Item!]!
	paged(status: String, first: Int, after: String): ItemConnection!
	users: [User!]!
	node(id: ID!): Node
}
interface Node { id: ID! }
type User implements Node { id: ID! name: String! friends(first: Int, after: String, status: String, last: Int, before: String): UserConnection! }
type UserConnection { edges: [UserEdge!]! pageInfo: PageInfo! }
type UserEdge { cursor: String node: User! }
type Item { id: ID! name: String! }
type ItemConnection { edges: [ItemEdge!]! pageInfo: PageInfo! }
type ItemEdge { cursor: String node: Item! }
type PageInfo { endCursor: String hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String }
type Mutation { addItem(input: String): ItemPayload! }
type ItemPayload { item: Item! }
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

/// Compiles a set of inline documents with the default config.
fn compile(documents: Vec<RawDocument>) -> (Vec<IrDocument>, Vec<Diagnostic>) {
    // `RustConfig::default()` carries the resolved defaults (`single`), so `@allLists` is
    // observable without an override
    let config = RustConfig::default();
    let schema = build_schema_index(
        SCHEMA,
        &SchemaIndexOptions::from_config(&config),
        "<inline>",
    )
    .expect("the test schema indexes");
    let prepared = prepare_project(&config, &schema, &documents);
    let mut diagnostics: Vec<Diagnostic> = prepared.diagnostics.clone();
    diagnostics.extend(validate_project(&ValidateOptions {
        config: &config,
        schema: &schema,
        documents: &documents,
        imports: &[],
        imported_names: &[],
        index: &prepared.index,
    }));
    let artifacts = documents
        .iter()
        .map(|entry| build_ir(entry, &documents, &prepared.index, &schema, &config))
        .collect();
    (artifacts, diagnostics)
}

/// The diagnostics of one set of documents, by code.
fn codes(documents: Vec<RawDocument>) -> Vec<String> {
    compile(documents)
        .1
        .into_iter()
        .map(|entry| entry.code)
        .collect()
}

/// The one diagnostic with `code`.
fn only(documents: Vec<RawDocument>, code: &str) -> Diagnostic {
    let matches: Vec<Diagnostic> = compile(documents)
        .1
        .into_iter()
        .filter(|entry| entry.code == code)
        .collect();
    assert_eq!(
        matches.len(),
        1,
        "expected exactly one {code}, got {matches:?}"
    );
    matches.into_iter().next().expect("checked")
}

/// A registered `@list` document for the inline schema.
fn inbox() -> RawDocument {
    let _ = SCHEMA;
    document(
        "Inbox",
        ArtifactKind::Query,
        "query Inbox { items(status: \"active\") @list(name: \"All_Items\") { id } }",
    )
}

/// The operations one payload field carries.
fn operations(artifact: &IrDocument, field: &str) -> Vec<flamme_core::contract::ListOperation> {
    artifact
        .selection
        .fields
        .get(field)
        .and_then(|spec| spec.operations.clone())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// `@when` / `@when_not`: list filters
// ---------------------------------------------------------------------------

/// Houdini's `@when`/`@when_not` take arbitrary key/value pairs, and the compiler
/// records them on the **operation** as `must`/`must_not`
/// (`documents/artifacts/selection.go:1572-1606`). A `$variable` stays a variable so
/// the runtime resolves it against the mutation's own variables.
#[test]
fn when_filters_are_recorded_on_the_operation() {
    let mutation = document(
        "AddItem",
        ArtifactKind::Mutation,
        "mutation AddItem($status: String) { addItem(input: \"x\") { ...All_Items_insert @when(status: $status) @when_not(kind: \"archived\") } }",
    );
    let (artifacts, diagnostics) = compile(vec![inbox(), mutation]);
    assert!(
        diagnostics.is_empty(),
        "no diagnostics expected: {diagnostics:?}"
    );
    let add = artifacts
        .iter()
        .find(|entry| entry.name == "AddItem")
        .expect("built");
    let recorded = operations(add, "addItem");
    assert_eq!(recorded.len(), 1, "the spread records one operation");
    let when = recorded[0].when.clone().expect("the filters are recorded");
    assert_eq!(
        when.must.get("status"),
        Some(&GraphQLValue::Variable {
            name: "status".to_string()
        }),
        "a variable filter stays a variable"
    );
    assert_eq!(
        when.must_not.get("kind"),
        Some(&GraphQLValue::StringValue {
            value: "archived".to_string()
        })
    );
    assert!(
        when.must.get("kind").is_none(),
        "the polarities stay separate"
    );
}

/// A `@when` with no arguments filters nothing and is a diagnostic, not a silent
/// unconditional operation.
#[test]
fn when_without_a_filter_is_rejected() {
    let mutation = document(
        "AddItem",
        ArtifactKind::Mutation,
        "mutation AddItem { addItem(input: \"x\") { ...All_Items_insert @when } }",
    );
    let diagnostic = only(vec![inbox(), mutation], "FLM1038");
    assert_eq!(diagnostic.severity, Severity::Error);
    assert!(
        diagnostic
            .message
            .contains("@when() requires at least one filter"),
        "unexpected message: {}",
        diagnostic.message
    );
}

/// The old Flamme shape, `@when(argument: "isLoggedIn")`, is a boolean-variable gate.
/// It is diagnosed and points at the standard directives.
#[test]
fn the_old_argument_shape_points_at_include_and_skip() {
    let query = document(
        "Q",
        ArtifactKind::Query,
        "query Q($isLoggedIn: Boolean!) { items @include(if: $isLoggedIn) { id } users { ...UserFields @when(argument: \"isLoggedIn\") } }\nfragment UserFields on User { id }",
    );
    let diagnostic = only(vec![query], "FLM1039");
    assert_eq!(diagnostic.severity, Severity::Error);
    assert!(
        diagnostic.message.contains("@include(if: $isLoggedIn)")
            && diagnostic.message.contains("@skip(if: $isLoggedIn)"),
        "the message names the replacements: {}",
        diagnostic.message
    );
    assert!(
        diagnostic
            .hint
            .as_deref()
            .is_some_and(|hint| hint.contains("@include(if: $isLoggedIn)")),
        "the hint names the replacement spelling: {:?}",
        diagnostic.hint
    );
}

/// Outside a list-operation spread there is no list to filter: the directive is an
/// error that names the standard boolean gate instead.
#[test]
fn when_outside_a_list_operation_spread_is_rejected() {
    let query = document(
        "Q",
        ArtifactKind::Query,
        "query Q { users { ...UserFields @when(status: \"active\") } }\nfragment UserFields on User { id }",
    );
    let diagnostic = only(vec![query], "FLM1040");
    assert!(
        diagnostic
            .message
            .contains("only supported on a list operation spread"),
        "unexpected message: {}",
        diagnostic.message
    );
    assert!(diagnostic
        .hint
        .as_deref()
        .is_some_and(|hint| hint.contains("@include(if: $x)")));
}

/// `@when`/`@when_not` on a field or an inline fragment have no meaning either.
#[test]
fn when_on_a_field_is_rejected() {
    let query = document(
        "Q",
        ArtifactKind::Query,
        "query Q { users @when(status: \"active\") { id } }",
    );
    let diagnostic = only(vec![query], "FLM1040");
    assert!(diagnostic
        .message
        .contains("only supported on a list operation spread"));
}

// ---------------------------------------------------------------------------
// `@allLists`
// ---------------------------------------------------------------------------

/// `@allLists` sets the operation's `target` to `all`
/// (`artifacts/selection.go:1677-1686`), overriding the configured default.
#[test]
fn all_lists_marks_the_operation_target_all() {
    let mutation = document(
        "AddItem",
        ArtifactKind::Mutation,
        "mutation AddItem { addItem(input: \"x\") { ...All_Items_insert @allLists } }",
    );
    let (artifacts, diagnostics) = compile(vec![inbox(), mutation]);
    assert!(
        diagnostics.is_empty(),
        "no FLM1008 for @allLists: {diagnostics:?}"
    );
    let add = artifacts
        .iter()
        .find(|entry| entry.name == "AddItem")
        .expect("built");
    let recorded = operations(add, "addItem");
    assert_eq!(recorded[0].target.as_deref(), Some("all"));
    // without the directive the operation keeps the configured target
    let plain = document(
        "Plain",
        ArtifactKind::Mutation,
        "mutation Plain { addItem(input: \"x\") { ...All_Items_insert } }",
    );
    let (artifacts, _) = compile(vec![inbox(), plain]);
    let add = artifacts
        .iter()
        .find(|entry| entry.name == "Plain")
        .expect("built");
    assert_eq!(
        operations(add, "addItem")[0].target.as_deref(),
        Some("single")
    );
}

/// Houdini: `@parentID cannot appear alongside @allLists` (`lists/validate.go:115-163`).
/// Flamme's analogue of `@parentID` is `@listTarget(name:)`.
#[test]
fn all_lists_with_list_target_is_rejected() {
    let mutation = document(
        "AddItem",
        ArtifactKind::Mutation,
        "mutation AddItem { addItem(input: \"x\") { ...All_Items_insert @allLists @listTarget(name: \"All_Items\") } }",
    );
    let diagnostic = only(vec![inbox(), mutation], "FLM1042");
    assert!(
        diagnostic.message.contains("@listTarget") && diagnostic.message.contains("@allLists"),
        "unexpected message: {}",
        diagnostic.message
    );
}

/// `@allLists` is meaningless anywhere but a list-operation spread.
#[test]
fn all_lists_outside_a_list_spread_is_rejected() {
    let query = document(
        "Q",
        ArtifactKind::Query,
        "query Q { users { ...UserFields @allLists } }\nfragment UserFields on User { id }",
    );
    let diagnostic = only(vec![query], "FLM1041");
    assert!(
        diagnostic
            .message
            .contains("only supported on a list operation spread"),
        "unexpected message: {}",
        diagnostic.message
    );
}

// ---------------------------------------------------------------------------
// `@includeListID` and `@listID`
// ---------------------------------------------------------------------------

/// `@includeListID` requires `@list` or `@paginate` on the same field
/// (`lists/validate.go:64-113`), and marks the list spec when it is legal.
#[test]
fn include_list_id_requires_a_list_or_paginate_field() {
    let query = document(
        "Q",
        ArtifactKind::Query,
        "query Q { items @includeListID { id } }",
    );
    let diagnostic = only(vec![query], "FLM1043");
    assert_eq!(
        diagnostic.message,
        "@includeListID can only be used on fields that also have @list or @paginate in document \"Q\"."
    );

    let marked = document(
        "Inbox",
        ArtifactKind::Query,
        "query Inbox { items(status: \"active\") @list(name: \"All_Items\") @includeListID { id } }",
    );
    let (artifacts, diagnostics) = compile(vec![marked]);
    assert!(
        diagnostics.is_empty(),
        "a legal @includeListID reports nothing: {diagnostics:?}"
    );
    let list = artifacts[0]
        .selection
        .fields
        .get("items")
        .and_then(|spec| spec.list.clone())
        .expect("the list spec");
    assert_eq!(list.include_list_id, Some(true));
}

/// `@listID(value:)` carries the opaque list id into the operation, literal or
/// variable (`artifacts/selection.go:1611-1613`).
#[test]
fn list_id_names_the_list_instance() {
    let mutation = document(
        "AddItem",
        ArtifactKind::Mutation,
        "mutation AddItem($listId: ID!) { addItem(input: \"x\") { ...All_Items_insert @listID(value: $listId) } }",
    );
    let (artifacts, diagnostics) = compile(vec![inbox(), mutation]);
    assert!(
        diagnostics.is_empty(),
        "no FLM1008 for @listID: {diagnostics:?}"
    );
    let add = artifacts
        .iter()
        .find(|entry| entry.name == "AddItem")
        .expect("built");
    assert_eq!(
        operations(add, "addItem")[0].list_id,
        Some(GraphQLValue::Variable {
            name: "listId".to_string()
        })
    );
}

/// `@listID` without a value cannot resolve anything.
#[test]
fn list_id_without_a_value_is_rejected() {
    let mutation = document(
        "AddItem",
        ArtifactKind::Mutation,
        "mutation AddItem { addItem(input: \"x\") { ...All_Items_insert @listID } }",
    );
    let diagnostic = only(vec![inbox(), mutation], "FLM1044");
    assert!(
        diagnostic.message.contains("@listID requires a value"),
        "unexpected message: {}",
        diagnostic.message
    );
}

/// `@listID` is meaningless anywhere but a list-operation spread.
#[test]
fn list_id_outside_a_list_spread_is_rejected() {
    let query = document(
        "Q",
        ArtifactKind::Query,
        "query Q { users { ...UserFields @listID(value: \"User:1::All\") } }\nfragment UserFields on User { id }",
    );
    let diagnostic = only(vec![query], "FLM1045");
    assert!(diagnostic
        .message
        .contains("only supported on a list operation spread"));
}

// ---------------------------------------------------------------------------
// `@paginate` inside a `@list` (`lists/validate.go:1369-1379`)
// ---------------------------------------------------------------------------

/// Houdini: "Paginated fields cannot be inside of lists. Please move this field into
/// a fragment" — the page request needs one owner record, and a list element is not
/// addressable that way.
#[test]
fn a_paginated_field_inside_a_list_is_rejected() {
    let query = document(
        "Q",
        ArtifactKind::Query,
        "query Q { users { friends(first: 1) @paginate(name: \"Nested\") { edges { node { id } } } } }",
    );
    let diagnostic = only(vec![query], "FLM1046");
    assert!(
        diagnostic
            .message
            .contains("Paginated fields cannot be inside of lists"),
        "unexpected message: {}",
        diagnostic.message
    );
}

/// The same rule reaches a paginated field through a fragment the list spreads.
#[test]
fn a_paginated_fragment_spread_inside_a_list_is_rejected() {
    let fragment = document(
        "PagedFrag",
        ArtifactKind::Fragment,
        "fragment PagedFrag on User { friends(first: 1) @paginate(name: \"F\") { edges { node { id } } } }",
    );
    let query = document(
        "Q",
        ArtifactKind::Query,
        "query Q { users { ...PagedFrag } }",
    );
    let diagnostic = only(vec![fragment, query], "FLM1046");
    assert!(
        diagnostic.message.contains("PagedFrag")
            && diagnostic.message.contains("inside a list field"),
        "unexpected message: {}",
        diagnostic.message
    );
}

/// A paginated fragment spread outside a list is legal, and so is a paginated field
/// on a plain object field.
#[test]
fn a_paginated_fragment_outside_a_list_is_legal() {
    let fragment = document(
        "PagedFrag",
        ArtifactKind::Fragment,
        "fragment PagedFrag on User { friends(first: 1) @paginate(name: \"F\") { edges { node { id } } } }",
    );
    let query = document(
        "Q",
        ArtifactKind::Query,
        "query Q { users @list(name: \"U\") { id } viewer { ...PagedFrag } }",
    );
    let codes = codes(vec![fragment, query]);
    assert!(
        !codes.contains(&"FLM1046".to_string()),
        "a paginated fragment outside the list is legal: {codes:?}"
    );
}

/// A `ListWhen` with both maps empty records nothing: the operation is unconditional.
#[test]
fn an_empty_filter_is_not_recorded() {
    let _ = ListWhen::default();
    let mutation = document(
        "AddItem",
        ArtifactKind::Mutation,
        "mutation AddItem { addItem(input: \"x\") { ...All_Items_insert } }",
    );
    let (artifacts, _) = compile(vec![inbox(), mutation]);
    let add = artifacts
        .iter()
        .find(|entry| entry.name == "AddItem")
        .expect("built");
    assert!(operations(add, "addItem")[0].when.is_none());
}
