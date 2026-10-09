//! The compiler's structural view of the artifact contract
//! (`packages/runtime/src/artifact.ts`, reached by the oracle through
//! `packages/core/src/contract.ts`). Field names and shapes are the runtime's, so
//! the port keeps them verbatim; `serde` renames every field to camelCase.

use serde::{Deserialize, Serialize};

use crate::js::{JsObject, de_object};

/// The four document kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    /// `query`
    Query,
    /// `fragment`
    Fragment,
    /// `mutation`
    Mutation,
    /// `subscription`
    Subscription,
}

impl Default for GraphQLValue {
    fn default() -> Self {
        GraphQLValue::NullValue
    }
}

impl ArtifactKind {
    /// The lowercase spelling the artifact stores.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactKind::Query => "query",
            ArtifactKind::Fragment => "fragment",
            ArtifactKind::Mutation => "mutation",
            ArtifactKind::Subscription => "subscription",
        }
    }
}

/// Cache policies (D5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CachePolicy {
    /// Cache or network.
    CacheOrNetwork,
    /// Network only.
    NetworkOnly,
    /// Cache and network.
    CacheAndNetwork,
    /// Cache only.
    CacheOnly,
}

impl CachePolicy {
    /// The spelling the artifact stores.
    pub fn as_str(self) -> &'static str {
        match self {
            CachePolicy::CacheOrNetwork => "CacheOrNetwork",
            CachePolicy::NetworkOnly => "NetworkOnly",
            CachePolicy::CacheAndNetwork => "CacheAndNetwork",
            CachePolicy::CacheOnly => "CacheOnly",
        }
    }
}

/// A serialized GraphQL value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum GraphQLValue {
    /// `$name`
    Variable {
        /// The variable name.
        name: String,
    },
    /// An integer literal.
    IntValue {
        /// The literal text.
        value: String,
    },
    /// A float literal.
    FloatValue {
        /// The literal text.
        value: String,
    },
    /// A string literal.
    StringValue {
        /// The value.
        value: String,
    },
    /// An enum literal.
    EnumValue {
        /// The value.
        value: String,
    },
    /// A boolean literal.
    BooleanValue {
        /// The value.
        value: bool,
    },
    /// `null`
    NullValue,
    /// A list literal.
    ListValue {
        /// The values.
        values: Vec<GraphQLValue>,
    },
    /// An object literal.
    ObjectValue {
        /// The fields.
        fields: JsObject<GraphQLValue>,
    },
}

/// A normalized selection node: fields by response key, fragment spreads by name.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionSelection {
    /// Fields by response key.
    #[serde(default, skip_serializing_if = "JsObject::is_empty", deserialize_with = "de_object")]
    pub fields: JsObject<FieldSpec>,
    /// Fragment spreads by fragment name.
    #[serde(default, skip_serializing_if = "JsObject::is_empty", deserialize_with = "de_object")]
    pub fragments: JsObject<FragmentSpec>,
    /// Inline fragments on abstract types, keyed by the concrete type condition.
    #[serde(
        rename = "abstractFields",
        default,
        skip_serializing_if = "JsObject::is_empty",
        deserialize_with = "de_object"
    )]
    pub abstract_fields: JsObject<SubscriptionSelection>,
}

/// One normalized field.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FieldSpec {
    /// The GraphQL type name with modifiers stripped.
    #[serde(rename = "type")]
    pub type_name: String,
    /// The full GraphQL type string.
    pub modifiers: String,
    /// Field name plus arguments, before variable interpolation.
    #[serde(rename = "keyRaw")]
    pub key_raw: String,
    /// The nested selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<SubscriptionSelection>,
    /// Inline fragments on an abstract field's value.
    #[serde(
        rename = "abstractFields",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub abstract_fields: Option<JsObject<SubscriptionSelection>>,
    /// `true` when the schema type is nullable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
    /// `@required` on the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    /// Included in masked reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    /// The field's value type is an interface or union.
    #[serde(rename = "abstract", default, skip_serializing_if = "Option::is_none")]
    pub abstract_: Option<bool>,
    /// An abstract field with at least one direct child made non-null by `@required`.
    #[serde(rename = "abstractHasRequired", default, skip_serializing_if = "Option::is_none")]
    pub abstract_has_required: Option<bool>,
    /// Directives kept in the artifact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directives: Option<Vec<DirectiveSpec>>,
    /// Loading metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loading: Option<LoadingSpec>,
    /// `@list` specification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<ListSpec>,
    /// Arguments currently applied to a `@list` field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<JsObject<GraphQLValue>>,
    /// `@paginate` specification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pagination: Option<PaginationSpec>,
    /// Merge directions for a connection field under Infinite pagination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updates: Option<Vec<String>>,
    /// `@list` insert operations produced by a mutation payload at this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operations: Option<Vec<ListOperation>>,
    /// `@optimisticKey` on this field.
    #[serde(rename = "optimisticKey", default, skip_serializing_if = "Option::is_none")]
    pub optimistic_key: Option<bool>,
    /// `@stream` on this list field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defer: Option<DeferredSpec>,
}

/// One fragment spread in a selection.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FragmentSpec {
    /// Evaluated fragment arguments; `{}` when the fragment takes none.
    #[serde(default)]
    pub arguments: JsObject<GraphQLValue>,
    /// The spread sits under a loading state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loading: Option<bool>,
    /// `@when` / `@when_not` conditions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Vec<WhenCondition>>,
    /// `@defer` on this spread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defer: Option<DeferredSpec>,
}

/// One `@defer`/`@stream` target.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DeferredSpec {
    /// The label a patch carries.
    pub label: String,
    /// Response-key path from the artifact root.
    pub path: Vec<String>,
    /// `fragment` or `list`.
    pub kind: String,
    /// The `if:` argument.
    #[serde(rename = "if", default, skip_serializing_if = "Option::is_none")]
    pub if_value: Option<GraphQLValue>,
    /// The deferred fragment, for a named spread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment: Option<String>,
    /// `@stream(initialCount: n)`.
    #[serde(rename = "initialCount", default, skip_serializing_if = "Option::is_none")]
    pub initial_count: Option<i64>,
}

/// One `@when(argument: "x")` / `@when_not(argument: "x")` condition.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WhenCondition {
    /// The variable the directive's `argument:` names.
    pub variable: String,
    /// `true` for `@when`, `false` for `@when_not`.
    pub polarity: bool,
}

/// A directive kept in the artifact.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DirectiveSpec {
    /// The directive name.
    pub name: String,
    /// Its arguments as values.
    pub arguments: JsObject<GraphQLValue>,
}

/// `@loading`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoadingSpec {
    /// `value` or `continue`.
    pub kind: String,
    /// Present for list fields under `@loading(count: n)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<LoadingListSpec>,
}

/// The `count`/`depth` pair of a list `@loading`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoadingListSpec {
    /// List levels.
    pub depth: i64,
    /// Placeholder count.
    pub count: i64,
}

/// `@list(name:)`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListSpec {
    /// The list name.
    pub name: String,
    /// `true` when the list field is a connection.
    pub connection: bool,
    /// The element type name.
    #[serde(rename = "type")]
    pub type_name: String,
    /// `@includeListID` on the list-declaring field: the read stamps the opaque list id on the
    /// value it returns (`packages/runtime/src/cache/read.ts`).
    #[serde(rename = "includeListID", default, skip_serializing_if = "Option::is_none")]
    pub include_list_id: Option<bool>,
}

/// A cache mutation carried by a mutation payload for a `@list`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListOperation {
    /// The action.
    pub action: String,
    /// The list name.
    pub list: String,
    /// Insert position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    /// Target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Field path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<Vec<String>>,
    /// `@when` / `@when_not`: the list filters the operation applies under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<ListWhen>,
    /// `@listID(value:)`: the opaque id of the list instance to target.
    #[serde(rename = "listID", default, skip_serializing_if = "Option::is_none")]
    pub list_id: Option<GraphQLValue>,
}

/// The `@when` / `@when_not` filters of one list operation.
///
/// Houdini records both polarities on the operation (`must`/`must_not`) and compares
/// each entry, resolved against the mutation's variables, with the list's own stored
/// filters using deep equality (`cache/lists.ts:524-553`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ListWhen {
    /// `@when(...)`: the list must match every entry.
    #[serde(default, skip_serializing_if = "JsObject::is_empty", deserialize_with = "de_object")]
    pub must: JsObject<GraphQLValue>,
    /// `@when_not(...)`: the list must match none of them.
    #[serde(
        rename = "mustNot",
        default,
        skip_serializing_if = "JsObject::is_empty",
        deserialize_with = "de_object"
    )]
    pub must_not: JsObject<GraphQLValue>,
}

impl ListWhen {
    /// `true` when neither polarity carries an entry.
    pub fn is_empty(&self) -> bool {
        self.must.is_empty() && self.must_not.is_empty()
    }
}

/// `@paginate`, attached to the paginated field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PaginationSpec {
    /// Field path from the artifact root.
    pub path: Vec<String>,
    /// `cursor` or `offset`.
    pub method: String,
    /// `SinglePage` or `Infinite`.
    pub mode: String,
    /// Page size.
    #[serde(rename = "pageSize")]
    pub page_size: i64,
    /// `true` when the paginated field is inside the document's own selection.
    pub embedded: bool,
    /// The type the page query is rooted at.
    #[serde(rename = "targetType")]
    pub target_type: String,
    /// The paginated field's value type is a connection.
    pub paginated: bool,
    /// `forward`, `backward` or `both`.
    pub direction: String,
    /// Whether the connection supports forward pagination.
    #[serde(rename = "supportsForward")]
    pub supports_forward: bool,
    /// Whether the connection supports backward pagination.
    #[serde(rename = "supportsBackward")]
    pub supports_backward: bool,
    /// The cursor scalar type.
    #[serde(rename = "cursorType", default, skip_serializing_if = "Option::is_none")]
    pub cursor_type: Option<String>,
}

/// The projection the runtime's page handlers consume.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RefetchSpec {
    /// Field path.
    pub path: Vec<String>,
    /// `cursor` or `offset`.
    pub method: String,
    /// `SinglePage` or `Infinite`.
    pub mode: String,
    /// Page size.
    #[serde(rename = "pageSize")]
    pub page_size: i64,
    /// Embedded in the document's own selection.
    pub embedded: bool,
    /// The type the page query is rooted at.
    #[serde(rename = "targetType")]
    pub target_type: String,
    /// The paginated field's value type is a connection.
    pub paginated: bool,
    /// `forward`, `backward` or `both`.
    pub direction: String,
}

/// Variables spec.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct InputObject {
    /// Variable name to its GraphQL type string.
    pub fields: JsObject<String>,
    /// Input object types reachable from the variables.
    pub types: JsObject<JsObject<String>>,
    /// Default values, already marshalled to plain JSON.
    pub defaults: JsObject<serde_json::Value>,
    /// `@__runtimeScalar` variable mappings (reserved; emitted empty in v1).
    #[serde(rename = "runtimeScalars")]
    pub runtime_scalars: JsObject<String>,
}

/// One compiled document: everything the emitter and `manifest.json` need.
///
/// Serialized for the TypeScript plugin host: every field crosses the boundary
/// except `document`, whose parsed AST the caller rebuilds from `raw`. The field
/// names are the runtime's, so the JSON is the same shape the TypeScript IR has.
/// Deserialized by the incremental cache (`session.rs`), which stores the IR of
/// every document so an unchanged document is never built twice.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrDocument {
    /// The document name.
    pub name: String,
    /// The kind.
    pub kind: ArtifactKind,
    /// The operation plus every transitively referenced fragment, printed.
    pub raw: String,
    /// `sha256(raw)`.
    pub hash: String,
    /// Absolute path of the source file.
    pub file: String,
    /// Posix path relative to `projectDir`.
    pub source: String,
    /// The root type name.
    pub root_type: String,
    /// The artifact selection.
    pub selection: SubscriptionSelection,
    /// The variables spec.
    pub input: InputObject,
    /// The pagination refetch spec.
    pub refetch: Option<RefetchSpec>,
    /// Plugin data, keyed by plugin.
    pub plugin_data: JsObject<serde_json::Value>,
    /// Loading state scope.
    pub enable_loading_state: Option<String>,
    /// Cache policy.
    pub policy: Option<CachePolicy>,
    /// `partial` baked into the artifact.
    pub partial: Option<bool>,
    /// Paginated field paths and their modes.
    pub paginated: Vec<Vec<String>>,
    /// The `@list` names the document registers or writes.
    pub lists: Vec<String>,
    /// Every `@defer`/`@stream` target, in source order.
    pub deferred: Option<Vec<DeferredSpec>>,
    /// The companion query a paginated fragment's pages are sent as
    /// (`<FragmentName>_Pagination_Query`), when one was generated.
    #[serde(rename = "paginationCompanion", default, skip_serializing_if = "Option::is_none")]
    pub pagination_companion: Option<String>,
    /// `true` when a field of the document is marked `@optimisticKey`.
    pub optimistic_keys: Option<bool>,
    /// Selection path plus key field, to the type whose key field was injected.
    pub injected_keys: Vec<(String, String)>,
    /// Fragment name to its type condition.
    pub fragment_types: Vec<(String, String)>,
    /// Fragment name to its artifact selection.
    pub fragment_selections: Vec<(String, SubscriptionSelection)>,
    /// The document's AST and source; rebuilt by the caller from `raw`.
    #[serde(skip, default = "placeholder_document")]
    pub document: crate::extract::RawDocument,
    /// The strip variables the artifact carries.
    pub strip_variables: Vec<String>,
}

/// The `document` a deserialized [`IrDocument`] starts with: an empty placeholder
/// the caller replaces with the extracted document (`session.rs`) or ignores
/// (the TypeScript plugin host reattaches its own).
fn placeholder_document() -> crate::extract::RawDocument {
    crate::extract::RawDocument {
        name: String::new(),
        kind: ArtifactKind::Query,
        raw: String::new(),
        file: String::new(),
        relative_path: String::new(),
        surface: crate::extract::DocumentSurface::File,
        offset: 0,
        start: 0,
        end: 0,
        source_offsets: Vec::new(),
        ast: crate::graphql::ast::Document { definitions: Vec::new() },
        source: crate::offsets::SourceText::new(""),
    }
}

impl IrDocument {
    /// The `.ts` module path of the artifact, relative to `runtimeDir`.
    pub fn artifact_module_path(&self) -> String {
        crate::naming::artifact_module_path(&self.name)
    }
}
