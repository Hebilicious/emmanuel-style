//! Fragment-level `@paginate` (research §3): the companion query, the internal clone
//! and the fragment artifact's embedded refetch spec.
//!
//! The frozen snapshot corpus has no paginated fragment, so no shared fixture
//! exercises one. The pipeline runs end to end here (a `CompileRequest` with inline
//! files), which is what makes it possible to assert the generated tree, not only one
//! stage.

use flamme_core::config::RustConfig;
use flamme_core::contract::{ArtifactKind, IrDocument};
use flamme_core::diagnostics::Diagnostic;
use flamme_core::extract::SourceFile;
use flamme_core::request::{CompileOptions, CompileRequest, CompileResponse, SchemaInput};

/// A schema with a `Node`-implementing owner, a connection and a plain list.
const SCHEMA: &str = r#"
type Query {
	users: [User!]!
	viewer: User
	plant: Plant!
	node(id: ID!): Node
}
interface Node { id: ID! }
type User implements Node {
	id: ID!
	name: String!
	friends(first: Int, after: String, last: Int, before: String, status: String): UserConnection!
}
type UserConnection { edges: [UserEdge!]! pageInfo: PageInfo! }
type UserEdge { cursor: String node: User! }
type PageInfo { endCursor: String hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String }
type Plant { id: ID! height: Int! leaves(first: Int, after: String): LeafConnection! }
type LeafConnection { edges: [LeafEdge!]! pageInfo: PageInfo! }
type LeafEdge { cursor: String node: Leaf! }
type Leaf { id: ID! }
"#;

/// Compiles one inline project.
fn compile(files: &[(&str, &str)]) -> CompileResponse {
    flamme_core::compile(&CompileRequest {
        route_documents: None,
        config: RustConfig {
            project_dir: "/inline".into(),
            runtime_dir: "/inline/.flamme".into(),
            include: vec!["src/**/*.gql".into()],
            ..RustConfig::default()
        },
        schema: SchemaInput {
            sdl: SCHEMA.to_string(),
            file: "schema.graphql".into(),
        },
        files: Some(
            files
                .iter()
                .map(|(relative, text)| SourceFile {
                    relative: (*relative).to_string(),
                    absolute: format!("/inline/{relative}"),
                    text: (*text).to_string(),
                    size: text.len() as u64,
                    mtime_ms: 0.0,
                })
                .collect(),
        ),
        options: CompileOptions {
            include_ir: true,
            ..CompileOptions::default()
        },
        persisted_committed: None,
        persisted_path: None,
        cache: None,
        sources: None,
    })
}

/// One emitted file, by its runtime-relative path.
fn file(response: &CompileResponse, path: &str) -> String {
    response
        .files
        .iter()
        .find(|entry| entry.path == path)
        .unwrap_or_else(|| panic!("no generated file \"{path}\""))
        .contents
        .clone()
}

/// One artifact, by document name.
fn artifact(response: &CompileResponse, name: &str) -> IrDocument {
    response
        .ir_documents
        .as_ref()
        .expect("include_ir")
        .iter()
        .find(|entry| entry.name == name)
        .unwrap_or_else(|| panic!("no artifact named \"{name}\""))
        .clone()
}

/// The codes a run reports.
fn codes(response: &CompileResponse) -> Vec<String> {
    response
        .diagnostics
        .iter()
        .map(|entry: &Diagnostic| entry.code.clone())
        .collect()
}

/// The paginated fragment: the companion's source document.
const PAGED: &str = "fragment UserFriends on User {
	friends(first: 10, status: \"active\") @paginate(name: \"User_Friends\") {
		edges {
			node {
				id
				name
			}
		}
	}
}";

/// The operation that spreads the paginated fragment.
const VIEWER: &str = "query Viewer { viewer { ...UserFriends } }";

/// The fixture project: the fragment and the operation that spreads it.
fn project() -> Vec<(&'static str, &'static str)> {
    vec![("src/Paged.gql", PAGED), ("src/Viewer.gql", VIEWER)]
}

// ---------------------------------------------------------------------------
// The companion document
// ---------------------------------------------------------------------------

#[test]
fn a_paginated_fragment_generates_its_companion_query() {
    let response = compile(&project());
    assert!(
        codes(&response).is_empty(),
        "no diagnostics expected: {:?}",
        response.diagnostics
    );

    let companion = artifact(&response, "UserFriends_Pagination_Query");
    assert_eq!(companion.kind, ArtifactKind::Query);
    let refetch = companion
        .refetch
        .as_ref()
        .expect("the companion is paginated");
    // §3: the companion's `refetch.path` drops the wrapper element the fragment's own
    // data does not have (`artifacts/selection.go:366-375`).
    assert_eq!(refetch.path, vec!["friends".to_string()]);
    assert!(
        !refetch.embedded,
        "the companion is a query, not an embedded fragment"
    );
    assert_eq!(refetch.target_type, "User");
    assert_eq!(refetch.method, "cursor");
    assert_eq!(refetch.page_size, 10);

    // the companion re-resolves the owner record by key and spreads the internal clone
    assert!(
        companion.raw.contains("node(id: $id)"),
        "the wrapper is the Node resolve field: {}",
        companion.raw
    );
    assert!(
        companion.raw.contains("...UserFriends_paginated"),
        "the companion spreads the internal clone: {}",
        companion.raw
    );
    assert!(
        !companion.raw.contains("@paginate"),
        "the compiler directive is stripped from the wire document: {}",
        companion.raw
    );
    assert!(
        companion
            .raw
            .contains("fragment UserFriends_paginated on User"),
        "the clone is folded into the companion's raw: {}",
        companion.raw
    );
    // the page variables are the canonical ones, and the field's own argument is kept
    assert!(companion.raw.contains("first: $first"), "{}", companion.raw);
    assert!(companion.raw.contains("after: $after"), "{}", companion.raw);
    assert!(
        companion.raw.contains("status: \"active\""),
        "{}",
        companion.raw
    );
    // the page size survives as the variable default
    assert!(
        companion.raw.contains("$first: Int = 10"),
        "{}",
        companion.raw
    );
}

#[test]
fn the_companion_is_not_an_extracted_document() {
    let response = compile(&project());
    assert!(
        !response
            .documents
            .iter()
            .any(|entry| entry.name == "UserFriends_Pagination_Query"),
        "the companion must stay out of the route/extraction surface"
    );
    assert!(
        response
            .artifacts
            .iter()
            .any(|entry| entry.name == "UserFriends_Pagination_Query"),
        "the companion is still an artifact the writer lands"
    );
    assert!(
        response
            .compiled
            .contains(&"UserFriends_Pagination_Query".to_string()),
        "it is rebuilt every run"
    );
}

#[test]
fn the_internal_clone_gets_no_artifact_of_its_own() {
    let response = compile(&project());
    assert!(
        !response
            .artifacts
            .iter()
            .any(|entry| entry.name == "UserFriends_paginated"),
        "the clone is internal: no artifact module, only text in the companion's raw"
    );
    assert!(
        !response
            .files
            .iter()
            .any(|entry| entry.path == "artifacts/UserFriends_paginated.ts"),
        "no module is written for the clone"
    );
}

#[test]
fn the_fragment_artifact_keeps_the_embedded_refetch_spec() {
    let response = compile(&project());
    let fragment = artifact(&response, "UserFriends");
    let refetch = fragment
        .refetch
        .as_ref()
        .expect("a paginated fragment carries refetch");
    assert!(
        refetch.embedded,
        "the fragment's own pagination is embedded"
    );
    assert_eq!(
        refetch.target_type, "User",
        "the type condition the page is rooted at"
    );
    assert_eq!(refetch.path, vec!["friends".to_string()]);
    assert_eq!(refetch.mode, "Infinite");
}

#[test]
fn the_fragment_module_carries_the_companion() {
    let response = compile(&project());
    let module = file(&response, "artifacts/UserFriends.ts");
    assert!(
        module.contains("import paginationArtifact from './UserFriends_Pagination_Query.js'"),
        "the fragment module imports its companion: {module}"
    );
    assert!(
        module.contains("paginationArtifact"),
        "the artifact literal carries the companion: {module}"
    );
    let companion_module = file(&response, "artifacts/UserFriends_Pagination_Query.ts");
    assert!(companion_module.contains("export default document"));
}

/// The companion's wrapper is an **abstract** field, and its emitted literal has to carry the
/// concrete branch map.
///
/// The companion is `node(id: $id) { ... on User { ... } }`, so the writer keys the page payload by
/// the payload's `__typename` (`concreteType`, `write.ts`). Without `abstractFields` in the literal
/// the write used the wrapper's own type and the page landed on `Node:1` while the fragment read
/// `User:1`, so the page never appeared (`review-f7`).
#[test]
fn the_companion_module_carries_the_abstract_branch_map() {
    let response = compile(&project());
    let module = file(&response, "artifacts/UserFriends_Pagination_Query.ts");
    assert!(
        module.contains("\"abstract\": true"),
        "the wrapper is marked abstract: {module}"
    );
    assert!(
        module.contains("\"abstractFields\": {"),
        "the wrapper carries its concrete branches: {module}"
    );
    assert!(
        module.contains("\"User\": {"),
        "the `User` branch is the one the companion resolves: {module}"
    );
    // the branch is the concrete selection, not an empty placeholder: it holds the clone's spread
    let branch = module
        .split("\"abstractFields\": {")
        .nth(1)
        .expect("the branch map is present");
    assert!(
        branch.contains("\"fields\""),
        "the branch carries a selection: {branch}"
    );
}

#[test]
fn the_fragment_ir_points_at_its_companion() {
    let response = compile(&project());
    let fragment = artifact(&response, "UserFriends");
    assert_eq!(
        fragment.pagination_companion.as_deref(),
        Some("UserFriends_Pagination_Query")
    );
    // the companion itself is nobody's companion
    let companion = artifact(&response, "UserFriends_Pagination_Query");
    assert_eq!(companion.pagination_companion, None);
}

/// The injected page info is visible in a fragment: `usePaginatedFragment` reads it
/// out of the fragment's **masked** data, where a `visible: false` field is dropped.
#[test]
fn a_paginated_fragment_exposes_its_page_info() {
    let response = compile(&project());
    let fragment = artifact(&response, "UserFriends");
    let friends = fragment
        .selection
        .fields
        .get("friends")
        .expect("the paginated field");
    let page_info = friends
        .selection
        .as_ref()
        .and_then(|selection| selection.fields.get("pageInfo"))
        .expect("pageInfo is injected when the fragment does not select it");
    assert_eq!(
        page_info.visible,
        Some(true),
        "a fragment's page info is readable"
    );
    let children = page_info.selection.as_ref().expect("page info fields");
    assert_eq!(
        children
            .fields
            .get("endCursor")
            .and_then(|spec| spec.visible),
        Some(true)
    );
    assert_eq!(
        children
            .fields
            .get("hasNextPage")
            .and_then(|spec| spec.visible),
        Some(true)
    );
    // a document keeps the injection out of the user's masked view
    let query = compile(&[(
        "src/Q.gql",
        "query Q { viewer { friends(first: 10) @paginate(name: \"User_Friends\") { edges { node { id } } } } }",
    )]);
    let document = artifact(&query, "Q");
    let page_info = document
        .selection
        .fields
        .get("viewer")
        .and_then(|spec| spec.selection.as_ref())
        .and_then(|selection| selection.fields.get("friends"))
        .and_then(|spec| spec.selection.as_ref())
        .and_then(|selection| selection.fields.get("pageInfo"))
        .expect("injected");
    assert_eq!(page_info.visible, Some(false));
}

/// The companion shares the fragment's cache key, which is what makes a page write
/// land on the connection the fragment reads (`friends(...)::paginated`).
///
/// The companion wraps the fragment in `node(id: $id) { ... on User { … } }`, so its field lives
/// in the `User` **branch** as well as in the flattened base selection, and the writer merges the
/// branch over the base (`selectionForWrite`). Rewriting only the base left the branch with the
/// clone's own argument spelling, and a page request wrote a second cache key on the same record
/// that the fragment's masked read never saw (`review-f8`).
#[test]
fn the_companion_writes_the_fragments_cache_key() {
    let response = compile(&project());
    let fragment = artifact(&response, "UserFriends");
    let companion = artifact(&response, "UserFriends_Pagination_Query");
    let fragment_key = fragment
        .selection
        .fields
        .get("friends")
        .expect("fragment field")
        .key_raw
        .clone();
    assert_eq!(
        fragment_key,
        "friends(first: 10, status: \"active\")::paginated"
    );

    let node = companion
        .selection
        .fields
        .get("node")
        .expect("the companion wraps the owner");
    let base_key = node
        .selection
        .as_ref()
        .and_then(|selection| selection.fields.get("friends"))
        .expect("the companion selects the same field")
        .key_raw
        .clone();
    assert_eq!(base_key, fragment_key, "the flattened base keeps the fragment's key");

    let branch = node
        .abstract_fields
        .as_ref()
        .and_then(|branches| branches.get("User"))
        .expect("the wrapper's concrete branch");
    let branch_key = branch
        .fields
        .get("friends")
        .expect("the branch carries the fragment's connection")
        .key_raw
        .clone();
    assert_eq!(
        branch_key, fragment_key,
        "the branch is what `selectionForWrite` merges over the base, so it carries the fragment's key"
    );
    // the branch is the selection the writer actually uses for a `User` payload
    assert_eq!(merged_friends_key(&companion), fragment_key);
}

// ---------------------------------------------------------------------------
// Rules and limits
// ---------------------------------------------------------------------------

#[test]
fn a_fragment_on_a_non_node_type_cannot_paginate() {
    // a plain fragment on a type that is not re-resolvable is still fine
    let response = compile(&[
        (
            "src/PlantBits.gql",
            "fragment PlantBits on Plant { height }",
        ),
        (
            "src/PlantQuery.gql",
            "query PlantQuery { plant { ...PlantBits } }",
        ),
    ]);
    assert!(
        codes(&response).is_empty(),
        "unexpected: {:?}",
        response.diagnostics
    );

    // a paginated fragment whose type condition does not implement Node cannot be
    // re-resolved from its keys, so no companion is generated (Houdini's rule,
    // `lists/validate.go:244-261`).
    let response = compile(&[
        (
            "src/PlantLeaves.gql",
            "fragment PlantLeaves on Plant { leaves(first: 1) @paginate(name: \"Plant_Leaves\") { edges { node { id } } } }",
        ),
        ("src/LeafQuery.gql", "query LeafQuery { plant { ...PlantLeaves } }"),
    ]);
    assert_eq!(codes(&response), vec!["FLM1047".to_string()]);
    assert!(
        !response
            .artifacts
            .iter()
            .any(|entry| entry.name == "PlantLeaves_Pagination_Query"),
        "no companion for an unresolvable owner"
    );
}


/// The key the writer resolves for a `User` payload: `selectionForWrite` merges the concrete branch
/// over the base selection, so the branch's spelling is the one a page write uses.
fn merged_friends_key(document: &IrDocument) -> String {
    let node = document.selection.fields.get("node").expect("node");
    let base = node.selection.as_ref().expect("base selection");
    let branch = node
        .abstract_fields
        .as_ref()
        .and_then(|branches| branches.get("User"))
        .expect("the User branch");
    let mut fields = base.fields.clone();
    for (name, spec) in branch.fields.iter() {
        fields.insert(name.to_string(), spec.clone());
    }
    fields
        .get("friends")
        .expect("the merged selection carries the connection")
        .key_raw
        .clone()
}
