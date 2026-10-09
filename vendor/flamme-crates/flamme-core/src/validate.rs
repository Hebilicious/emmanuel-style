//! Validation (`spec/spec.md` §4.5): the complete FLM1xxx table, the project-wide
//! fragment graph, list registration and the `graphql.validate` pass.
//! Port of `packages/core/src/validate.ts`.
//!
//! OWNER: the validation port.

use std::collections::{HashMap, HashSet};

use crate::config::RustConfig;
use crate::contract::{ArtifactKind, GraphQLValue, ListSpec};
use crate::diagnostics::{
    Diagnostic, DiagnosticInput, RelatedInformation, SourceLocation,
};
use crate::extract::{DocumentSurface, GqlImport, RawDocument};
use crate::graphql::ast::{
    Argument, Definition, Directive, Field, FragmentDefinition as FragmentNode, FragmentSpread,
    InlineFragment, NamedType, ObjectField, OperationDefinition, OperationType, Selection,
    SelectionSet, TypeNode, Value, VariableDefinition,
};
use crate::js::JsObject;
use crate::naming::{is_usable_document_name, json_string};
use crate::offsets::{column_at, line_at, location_at, Offset, SourceText};
use crate::paginate::{cursor_argument_plan, cursor_type_compatible, offset_argument_plan};
use crate::schema::{type_ref_string, SchemaIndex, SchemaTypeKind};

/// Directives the compiler implements and strips from `raw` (§7.1–§7.13).
pub const SUPPORTED_DIRECTIVES: &[&str] = &[
    "loading",
    "paginate",
    "list",
    "mask_enable",
    "mask_disable",
    "cache",
    "dedupe",
    "prepend",
    "append",
    "listTarget",
    "optimisticKey",
    "required",
    "when",
    "when_not",
    "allLists",
    "includeListID",
    "listID",
];

/// Directives passed through to the server.
pub const PASS_THROUGH_DIRECTIVES: &[&str] = &["include", "skip", "defer", "stream"];

/// Directives reserved by the compiler's own contract.
pub const RESERVED_DIRECTIVES: &[&str] = &[
    "plural",
    "refetch",
    "refetchable",
    "arguments",
    "with",
    "parentID",
    "endpoint",
    "session",
    "componentField",
    "__runtimeScalar",
];

/// FLM1008's message for `@optimisticKey` outside a field (§7.14).
const OPTIMISTIC_KEY_LOCATION_MESSAGE: &str =
    "Directive \"@optimisticKey\" is only supported on a field; it marks the field that will hold a created record's server id.";

/// FLM1046: Houdini's own wording (`lists/validate.go:1369-1379`).
const PAGINATED_IN_LIST_MESSAGE: &str =
    "Paginated fields cannot be inside of lists. Please move this field into a fragment";

/// True when a fragment's own selections carry a `@paginate`, through nested spreads.
fn fragment_paginates(ctx: &DocCtx<'_>, name: &str, seen: &mut Vec<String>) -> bool {
    if seen.iter().any(|entry| entry == name) {
        return false;
    }
    seen.push(name.to_string());
    let Some(fragment) = ctx.index.fragment_node(ctx.documents, name) else {
        return false;
    };
    fn selection_paginates(
        ctx: &DocCtx<'_>,
        selection_set: &SelectionSet,
        seen: &mut Vec<String>,
    ) -> bool {
        for selection in &selection_set.selections {
            match selection {
                Selection::Field(field) => {
                    if find_directive(&field.directives, "paginate").is_some() {
                        return true;
                    }
                    if let Some(nested) = &field.selection_set {
                        if selection_paginates(ctx, nested, seen) {
                            return true;
                        }
                    }
                }
                Selection::InlineFragment(inline) => {
                    if selection_paginates(ctx, &inline.selection_set, seen) {
                        return true;
                    }
                }
                Selection::FragmentSpread(spread) => {
                    if fragment_paginates(ctx, &spread.name.value, seen) {
                        return true;
                    }
                }
            }
        }
        false
    }
    selection_paginates(ctx, &fragment.selection_set, seen)
}

/// FLM1008's message for `@allLists` anywhere but a list operation spread (§4).
const ALL_LISTS_LOCATION_MESSAGE: &str =
    "Directive \"@allLists\" is only supported on a list operation spread (\"...<List>_insert\", \"...<List>_remove\", \"...<List>_toggle\", \"...<List>_upsert\"); it applies the operation to every cached instance of the list.";

/// FLM1045's message for `@listID` anywhere but a list operation spread (§5).
const LIST_ID_LOCATION_MESSAGE: &str =
    "Directive \"@listID\" is only supported on a list operation spread (\"...<List>_insert\", \"...<List>_remove\", \"...<List>_toggle\", \"...<List>_upsert\"); it names the opaque id of one list instance.";

/// FLM1039: the old `@when(argument: "x")` boolean-variable gate, which duplicates
/// the standard `@include`/`@skip` and is no longer how `@when` behaves (§4).
fn old_when_diagnostic(directive: &Directive, ctx: &DocCtx<'_>) -> Diagnostic {
    let variable = directive_string_argument(Some(directive), "argument").unwrap_or_default();
    DiagnosticInput::error(
        "FLM1039",
        format!(
            "@{}(argument: \"{variable}\") was Flamme's boolean-variable gate; the standard spelling is @include(if: ${variable}) or @skip(if: ${variable}), and @{} now takes filter key/value pairs matched against the @list field's own arguments.",
            directive.name.value, directive.name.value
        ),
        ctx.at(directive.loc),
    )
    .with_hint(format!(
        "replace it with @include(if: ${variable}) or @skip(if: ${variable}), or write a filter pair the list field declares (for example @when(status: \"active\"))"
    ))
    .build()
}

/// FLM1008's message for `@listTarget` anywhere but a list operation spread (§7.10).
const LIST_TARGET_LOCATION_MESSAGE: &str =
    "Directive \"@listTarget\" is only supported on a list operation spread (\"...<List>_insert\", \"...<List>_remove\", \"...<List>_toggle\"); it names the list the operation targets.";

/// One fragment definition, indexed project-globally (§4.4b).
#[derive(Clone, Debug)]
pub struct FragmentDefinition {
    /// The fragment name.
    pub name: String,
    /// The type condition.
    pub type_condition: String,
    /// Index of the document in the project's document list.
    pub document: usize,
    /// Index of the definition inside that document's AST.
    pub definition: usize,
}

/// One registered `@list(name:)`.
#[derive(Clone, Debug)]
pub struct ListRegistration {
    /// The list name.
    pub name: String,
    /// The element type name.
    pub type_name: String,
    /// `true` when the list field is a connection.
    pub connection: bool,
    /// Index of the declaring document.
    pub document: usize,
    /// The directive's spec.
    pub spec: ListSpec,
    /// Absolute offset of the `@list` directive.
    pub offset: Offset,
}

/// The project-wide document index every later stage works from.
#[derive(Clone, Debug, Default)]
pub struct DocumentIndex {
    /// Indices of the operation documents, in extraction order.
    pub operations: Vec<usize>,
    /// Fragment name to its definition.
    pub fragments: HashMap<String, FragmentDefinition>,
    /// Registered lists, in registration order.
    pub lists: JsObject<ListRegistration>,
    /// Fragment name to the fragment names it spreads directly.
    pub spread_graph: HashMap<String, Vec<String>>,
}

impl DocumentIndex {
    /// The AST node of one fragment definition.
    pub fn fragment_node<'a>(
        &self,
        documents: &'a [RawDocument],
        name: &str,
    ) -> Option<&'a crate::graphql::ast::FragmentDefinition> {
        let entry = self.fragments.get(name)?;
        let document = documents.get(entry.document)?;
        match document.ast.definitions.get(entry.definition)? {
            crate::graphql::ast::Definition::Fragment(node) => Some(node),
            crate::graphql::ast::Definition::Operation(_) => None,
            // The index only holds fragments, so this is a type system definition the
            // extraction would have rejected before the index was built.
            crate::graphql::ast::Definition::TypeSystem(_) => None,
        }
    }

    /// The raw text of the document that declares one fragment.
    pub fn fragment_raw<'a>(&self, documents: &'a [RawDocument], name: &str) -> Option<&'a str> {
        let entry = self.fragments.get(name)?;
        documents.get(entry.document).map(|document| document.raw.as_str())
    }
}

/// What `prepare_project` produced: the index and the project's diagnostics.
#[derive(Clone, Debug, Default)]
pub struct PreparedProject {
    /// The project-wide index.
    pub index: DocumentIndex,
    /// The diagnostics indexing reported.
    pub diagnostics: Vec<Diagnostic>,
}

/// The absolute file offset of a raw-document offset, through the document's source map.
pub fn file_offset_of(document: &RawDocument, index: Offset) -> Offset {
    let limit = document.source_offsets.len().saturating_sub(1) as Offset;
    let clamped = index.min(limit);
    document.source_offsets.get(clamped as usize).copied().unwrap_or(document.offset)
}

/// A location inside a document, resolved through the document's source map.
fn document_location(document: &RawDocument, node: Option<crate::graphql::ast::Loc>) -> SourceLocation {
    let start = node.map(|loc| loc.start).unwrap_or(0);
    location_at(&document.source, &document.relative_path, file_offset_of(document, start), 1)
}

/// The absolute offset of a `line:column` pair inside a document's own raw text.
fn local_offset(document: &RawDocument, line: u32, column: u32) -> Offset {
    let text = SourceText::new(document.raw.as_str());
    let index = text.build_line_index();
    let start = index.get(line as usize - 1).copied().unwrap_or(0);
    file_offset_of(document, start.saturating_add(column.saturating_sub(1)))
}

/// The 1-based line and column of an offset in a document's raw text.
fn line_column_of(document: &RawDocument, offset: Offset) -> (u32, u32) {
    let text = SourceText::new(document.raw.as_str());
    let index = text.build_line_index();
    let safe = offset.min(text.utf16_len());
    (line_at(&index, safe), column_at(&index, safe))
}

/// Builds the project-wide fragment/list index over the extracted documents.
pub fn prepare_project(
    config: &RustConfig,
    schema: &SchemaIndex,
    documents: &[RawDocument],
) -> PreparedProject {
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    // Every spelling the configured extensions imply, not one name per role: a project
    // whose `documentExtensions` covers `.gql` and `.graphql` has a legal `+page.gql`
    // in one directory and a legal `+page.graphql` in another, and FLM1010 must not
    // fire for either.
    let exempt_documents: Vec<String> = config
        .routing
        .document_file_names("page")
        .into_iter()
        .chain(config.routing.document_file_names("layout"))
        .collect();
    let mut index = index_project(documents, schema, &mut diagnostics, &exempt_documents);
    register_lists(documents, schema, &mut index, &mut diagnostics);
    PreparedProject { index, diagnostics }
}

/// The input of [`validate_project`].
pub struct ValidateOptions<'a> {
    /// The resolved config.
    pub config: &'a RustConfig,
    /// The schema index.
    pub schema: &'a SchemaIndex,
    /// Every extracted document.
    pub documents: &'a [RawDocument],
    /// Every `.gql` import found in a code file.
    pub imports: &'a [GqlImport],
    /// Every name imported from `$flamme`.
    pub imported_names: &'a [String],
    /// The project-wide index.
    pub index: &'a DocumentIndex,
}

/// Runs every validation rule over the project and returns the diagnostics.
pub fn validate_project(options: &ValidateOptions<'_>) -> Vec<Diagnostic> {
    let schema = options.schema;
    let documents = options.documents;
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    // The index is borrowed, but `registerLists` may add to the registry, so the
    // caller's index is re-registered into a local clone exactly like the oracle
    // (which mutates the map it was handed).
    let mut index = options.index.clone();
    register_lists(documents, schema, &mut index, &mut diagnostics);

    let view = SchemaView::build(schema);
    // `validate()` asserts the schema is valid before it runs any rule; the oracle
    // reports the thrown message once per document (FLM2002), so the check is
    // computed once and handed to every document.
    let schema_errors = schema_validation_errors(&view);
    let mut cycles: HashSet<String> = HashSet::new();
    for document in documents {
        validate_document(
            document,
            documents,
            &index,
            &view,
            &schema_errors,
            options.config,
            &mut diagnostics,
            &mut cycles,
        );
    }
    validate_reachability(&index, documents, &mut diagnostics);
    diagnostics
}

/// Converts a GraphQL `Value` node into the flat `GraphQLValue` the artifact stores.
pub fn value_node_to_graphql_value(node: &Value) -> GraphQLValue {
    match node {
        Value::Variable(variable) => GraphQLValue::Variable { name: variable.name.value.clone() },
        Value::IntValue { value, .. } => GraphQLValue::IntValue { value: value.clone() },
        Value::FloatValue { value, .. } => GraphQLValue::FloatValue { value: value.clone() },
        Value::StringValue { value, .. } => GraphQLValue::StringValue { value: value.clone() },
        Value::EnumValue { value, .. } => GraphQLValue::EnumValue { value: value.clone() },
        Value::BooleanValue { value, .. } => GraphQLValue::BooleanValue { value: *value },
        Value::NullValue { .. } => GraphQLValue::NullValue,
        Value::ListValue { values, .. } => GraphQLValue::ListValue {
            values: values.iter().map(value_node_to_graphql_value).collect(),
        },
        Value::ObjectValue { fields, .. } => {
            let mut object = JsObject::new();
            for field in fields {
                object.insert(field.name.value.clone(), value_node_to_graphql_value(&field.value));
            }
            GraphQLValue::ObjectValue { fields: object }
        }
    }
}

/// The evaluated arguments of a directive, keyed by name.
pub fn directive_arguments(directive: &Directive) -> JsObject<GraphQLValue> {
    let mut arguments = JsObject::new();
    for argument in &directive.arguments {
        arguments.insert(argument.name.value.clone(), value_node_to_graphql_value(&argument.value));
    }
    arguments
}

/// The directive with this name, or `None`.
pub fn find_directive<'a>(directives: &'a [Directive], name: &str) -> Option<&'a Directive> {
    directives.iter().find(|directive| directive.name.value == name)
}

/// The string argument of a directive, or `None` when absent or not a string.
pub fn directive_string_argument(directive: Option<&Directive>, name: &str) -> Option<String> {
    let argument = directive?.argument(name)?;
    match &argument.value {
        Value::StringValue { value, .. } => Some(value.clone()),
        _ => None,
    }
}

/// The integer argument of a directive, or `None` when absent or not an int.
pub fn directive_int_argument(directive: Option<&Directive>, name: &str) -> Option<i64> {
    let argument = directive?.argument(name)?;
    match &argument.value {
        Value::IntValue { value, .. } => value
            .trim()
            .parse::<i64>()
            .ok()
            .or_else(|| value.trim().parse::<f64>().ok().map(|value| value as i64)),
        _ => None,
    }
}

/// True when the directive carries the named argument.
pub fn directive_has_argument(directive: Option<&Directive>, name: &str) -> bool {
    directive.is_some_and(|directive| directive.argument(name).is_some())
}

/// The argument node with this name, or `None`.
pub fn find_argument<'a>(directive: &'a Directive, name: &str) -> Option<&'a Argument> {
    directive.argument(name)
}

/// The boolean argument of a directive, or `None` when absent or not a boolean.
fn directive_boolean_argument(directive: Option<&Directive>, name: &str) -> Option<bool> {
    let argument = directive?.argument(name)?;
    match &argument.value {
        Value::BooleanValue { value, .. } => Some(*value),
        _ => None,
    }
}

/// The element type of a list field, and whether it is a connection.
///
/// Accepts a type reference string (`[Species!]!`, `SpeciesConnection`) or a bare
/// type name, which the IR and the validation pass both pass in.
pub fn list_element_type(schema: &SchemaIndex, type_name: &str) -> Option<(String, bool)> {
    let node = parse_type_ref(type_name);
    let mut current = &node;
    while let TypeNode::NonNull(inner) = current {
        current = &inner.type_node;
    }
    if let TypeNode::List(list) = current {
        let mut element = list.type_node.as_ref();
        while let TypeNode::NonNull(inner) = element {
            element = &inner.type_node;
        }
        return Some((element.named_type().name.value.clone(), false));
    }
    let named = current.named_type().name.value.clone();
    let edges = schema.field_type(&named, "edges");
    let Some(edges) = edges else {
        return Some((named, false));
    };
    let mut edge = edges;
    while let TypeNode::NonNull(inner) = edge {
        edge = &inner.type_node;
    }
    if let TypeNode::List(list) = edge {
        let mut element = list.type_node.as_ref();
        while let TypeNode::NonNull(inner) = element {
            element = &inner.type_node;
        }
        edge = element;
    }
    let edge_name = edge.named_type().name.value.clone();
    let node = schema.field_type(&edge_name, "node");
    match node {
        Some(node) => Some((node.named_type().name.value.clone(), true)),
        None => Some((edge_name, true)),
    }
}

/// Parses a type reference string (`[Species!]!`) into an AST type node.
pub fn parse_type_ref(text: &str) -> TypeNode {
    fn parse(text: &[u8], at: &mut usize) -> TypeNode {
        let mut node = if text.get(*at) == Some(&b'[') {
            *at += 1;
            let inner = parse(text, at);
            if text.get(*at) == Some(&b']') {
                *at += 1;
            }
            TypeNode::List(crate::graphql::ast::ListType {
                type_node: Box::new(inner),
                loc: None,
            })
        } else {
            let start = *at;
            while matches!(text.get(*at), Some(byte) if byte.is_ascii_alphanumeric() || *byte == b'_') {
                *at += 1;
            }
            named_node(&String::from_utf8_lossy(&text[start..*at]))
        };
        if text.get(*at) == Some(&b'!') {
            *at += 1;
            node = TypeNode::NonNull(crate::graphql::ast::NonNullType {
                type_node: Box::new(node),
                loc: None,
            });
        }
        node
    }
    let mut at = 0usize;
    parse(text.as_bytes(), &mut at)
}

/// The `{ list, action }` a `<List>_<action>` fragment name encodes.
///
/// Houdini generates `<List>_insert`, `<List>_remove`, `<List>_toggle` and `<List>_upsert` as real
/// internal fragments, and `<List>_update` as one that records **no** artifact operation
/// (`insertOperations.go:285-335`, `artifacts/selection.go:1649-1669`). `<Type>_delete` is a generated
/// *directive*, not a fragment, so neither `_update` nor `_delete` is a list-operation spread.
pub fn list_fragment_action(name: &str) -> Option<(String, String)> {
    let (list, action) = name.rsplit_once('_')?;
    if list.is_empty() || !matches!(action, "insert" | "remove" | "toggle" | "upsert") {
        return None;
    }
    Some((list.to_string(), action.to_string()))
}

/// The selections of a selection set, in source order.
pub fn selections_of(set: &SelectionSet) -> &[crate::graphql::ast::Selection] {
    &set.selections
}

/// The response key of a field node.
pub fn field_response_key(field: &Field) -> &str {
    field.response_key()
}

// ---------------------------------------------------------------------------
// Indexing (§4.4b, §4.4c)
// ---------------------------------------------------------------------------

/// Builds the fragment/list index and reports FLM1004, FLM1010 and FLM1020.
fn index_project(
    documents: &[RawDocument],
    _schema: &SchemaIndex,
    diagnostics: &mut Vec<Diagnostic>,
    exempt_documents: &[String],
) -> DocumentIndex {
    let mut operations: Vec<usize> = Vec::new();
    let mut fragments: HashMap<String, FragmentDefinition> = HashMap::new();
    let mut fragment_files: HashMap<String, usize> = HashMap::new();
    let mut spread_graph: HashMap<String, Vec<String>> = HashMap::new();

    for (position, document) in documents.iter().enumerate() {
        let Some(definition) = document.ast.definitions.first() else {
            continue;
        };
        if let Definition::Fragment(node) = definition {
            let name = node.name.value.clone();
            if let Some(existing) = fragment_files.get(&name) {
                let existing = &documents[*existing];
                let first = location_at(
                    &existing.source,
                    &existing.relative_path,
                    existing.offset,
                    1,
                );
                let second =
                    location_at(&document.source, &document.relative_path, document.offset, 1);
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM1004",
                        format!(
                            "Duplicate document name \"{name}\": first declared at {}:{}:{}, redeclared at {}:{}:{}.",
                            existing.relative_path, first.line, first.column, document.relative_path, second.line, second.column
                        ),
                        second,
                    )
                    .with_related(vec![RelatedInformation {
                        message: "first declared here".to_string(),
                        location: first,
                    }])
                    .build(),
                );
                continue;
            }
            fragment_files.insert(name.clone(), position);
            fragments.insert(
                name.clone(),
                FragmentDefinition {
                    name: name.clone(),
                    type_condition: node.type_condition.name.value.clone(),
                    document: position,
                    definition: 0,
                },
            );
            spread_graph.insert(name, collect_spread_names(&node.selection_set));
            continue;
        }
        operations.push(position);
    }

    let mut operation_names: HashMap<String, usize> = HashMap::new();
    let mut operation_order: Vec<String> = Vec::new();
    for position in &operations {
        let document = &documents[*position];
        let Some(definition) = document.ast.definitions.first() else {
            continue;
        };
        if !matches!(definition, Definition::Operation(_)) {
            continue;
        }
        // The *document's* name, which is the artifact name.
        let name = document.name.clone();
        if name.is_empty() {
            continue;
        }
        if let Some(existing) = operation_names.get(&name) {
            let existing = &documents[*existing];
            let first =
                location_at(&existing.source, &existing.relative_path, existing.offset, 1);
            let second = location_at(&document.source, &document.relative_path, document.offset, 1);
            diagnostics.push(
                DiagnosticInput::error(
                    "FLM1004",
                    format!(
                        "Duplicate document name \"{name}\": first declared at {}:{}:{}, redeclared at {}:{}:{}.",
                        existing.relative_path, first.line, first.column, document.relative_path, second.line, second.column
                    ),
                    second,
                )
                .with_related(vec![RelatedInformation {
                    message: "first declared here".to_string(),
                    location: first,
                }])
                .build(),
            );
            continue;
        }
        operation_names.insert(name.clone(), *position);
        operation_order.push(name);
    }

    // FLM1020: an operation and a fragment may legally share a name in GraphQL, but
    // they are two artifacts.
    for name in &operation_order {
        let Some(position) = operation_names.get(name) else { continue };
        let Some(fragment) = fragments.get(name) else { continue };
        let operation = &documents[*position];
        let fragment_document = &documents[fragment.document];
        diagnostics.push(
            DiagnosticInput::error(
                "FLM1020",
                format!(
                    "Operation \"{name}\" and fragment \"{name}\" collide onto one artifact name; rename one of them (they are separate documents)."
                ),
                location_at(&operation.source, &operation.relative_path, operation.offset, 1),
            )
            .with_related(vec![RelatedInformation {
                message: "the fragment with the same name".to_string(),
                location: location_at(
                    &fragment_document.source,
                    &fragment_document.relative_path,
                    fragment_document.offset,
                    1,
                ),
            }])
            .build(),
        );
    }

    // FLM1010: two standalone documents share a basename.
    let mut by_basename: HashMap<String, usize> = HashMap::new();
    for (position, document) in documents.iter().enumerate() {
        // A composed document is synthetic: its name is unique by construction and it is never
        // imported as `./<basename>`, so the basename rule has nothing to say about it.
        if document.surface != DocumentSurface::File
            || document.surface == DocumentSurface::Composed
            || is_routing_document(document, exempt_documents)
        {
            continue;
        }
        let basename = document
            .relative_path
            .rsplit('/')
            .next()
            .unwrap_or(document.relative_path.as_str())
            .to_string();
        if let Some(existing) = by_basename.get(&basename) {
            let existing = &documents[*existing];
            diagnostics.push(
                DiagnosticInput::error(
                    "FLM1010",
                    format!(
                        "Ambiguous document filename \"{basename}\": {} and {} cannot both be imported as './{basename}'.",
                        existing.relative_path, document.relative_path
                    ),
                    location_at(&document.source, &document.relative_path, document.offset, 1),
                )
                .with_related(vec![RelatedInformation {
                    message: "the other document with this filename".to_string(),
                    location: location_at(
                        &existing.source,
                        &existing.relative_path,
                        existing.offset,
                        1,
                    ),
                }])
                .build(),
            );
            continue;
        }
        by_basename.insert(basename, position);
    }

    DocumentIndex {
        operations,
        fragments,
        lists: JsObject::new(),
        spread_graph,
    }
}

/// `true` when a document file is one of the routing convention's own.
fn is_routing_document(document: &RawDocument, document_files: &[String]) -> bool {
    let basename = document
        .relative_path
        .rsplit('/')
        .next()
        .unwrap_or(document.relative_path.as_str());
    document_files.iter().any(|name| {
        if basename == name {
            return true;
        }
        let at = name.rfind('.');
        let (stem, extension) = match at {
            Some(at) if at > 0 => (&name[..at], &name[at..]),
            _ => (name.as_str(), ""),
        };
        if !basename.starts_with(&format!("{stem}.")) || !basename.ends_with(extension) {
            return false;
        }
        let end = if extension.is_empty() {
            basename.len()
        } else {
            basename.len() - extension.len()
        };
        let handle = &basename[stem.len() + 1..end];
        !handle.is_empty()
            && handle.chars().all(|char| char.is_ascii_alphanumeric() || char == '_')
    })
}

/// Every fragment name a selection set spreads, in source order.
fn collect_spread_names(selection_set: &SelectionSet) -> Vec<String> {
    fn visit(set: &SelectionSet, names: &mut Vec<String>) {
        for selection in &set.selections {
            match selection {
                Selection::FragmentSpread(spread) => names.push(spread.name.value.clone()),
                Selection::InlineFragment(inline) => visit(&inline.selection_set, names),
                Selection::Field(field) => {
                    if let Some(set) = &field.selection_set {
                        visit(set, names);
                    }
                }
            }
        }
    }
    let mut names = Vec::new();
    visit(selection_set, &mut names);
    names
}

/// The spread names a definition's own selection set holds.
fn definition_spread_names(definition: &Definition) -> Vec<String> {
    match definition {
        Definition::Operation(node) => collect_spread_names(&node.selection_set),
        Definition::Fragment(node) => collect_spread_names(&node.selection_set),
        // A type system definition holds no spreads, and the extraction rejects such a
        // document before validation runs.
        Definition::TypeSystem(_) => Vec::new(),
    }
}

/// The first fragment cycle that starts at `name`, as a printable chain.
pub fn find_fragment_cycle(name: &str, index: &DocumentIndex) -> Option<Vec<String>> {
    fn visit(
        current: &str,
        index: &DocumentIndex,
        path: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        if let Some(at) = path.iter().position(|entry| entry == current) {
            let mut cycle = path[at..].to_vec();
            cycle.push(current.to_string());
            return Some(cycle);
        }
        path.push(current.to_string());
        if let Some(spreads) = index.spread_graph.get(current) {
            for spread in spreads {
                if let Some(found) = visit(spread, index, path) {
                    return Some(found);
                }
            }
        }
        path.pop();
        None
    }
    let mut path = Vec::new();
    match visit(name, index, &mut path) {
        Some(found) if found.len() >= 2 => Some(found),
        _ => None,
    }
}

/// The compiler's major version, used in the FLM1008 message (`0.x`).
pub fn compiler_version_major() -> &'static str {
    "0"
}

// ---------------------------------------------------------------------------
// Document validation (§4.5)
// ---------------------------------------------------------------------------

/// `@defer`/`@stream` inside a **fragment definition** is FLM1008 (§7.13).
fn check_defer_supported(
    document: &RawDocument,
    directive: &Directive,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if document.kind != ArtifactKind::Fragment {
        return;
    }
    diagnostics.push(DiagnosticInput::error(
        "FLM1008",
        format!(
            "Directive \"@{}\" is not supported inside a fragment definition; the directive belongs on the spread in the operation that requests the data.",
            directive.name.value
        ),
        document_location(document, directive.loc),
    ).build());
}

/// FLM1026: a `@defer`/`@stream` label must be unique within one document (§7.13).
fn check_defer_label(
    directive: &Directive,
    document: &RawDocument,
    diagnostics: &mut Vec<Diagnostic>,
    labels: &mut HashMap<String, SourceLocation>,
) {
    let Some(label) = directive_string_argument(Some(directive), "label") else {
        return;
    };
    let location = document_location(document, directive.loc);
    if let Some(first) = labels.get(&label) {
        diagnostics.push(
            DiagnosticInput::error(
                "FLM1026",
                format!(
                    "The @{} label \"{label}\" is used twice in \"{}\"; labels must be unique across a document so a patch can be attributed.",
                    directive.name.value, document.name
                ),
                location,
            )
            .with_related(vec![RelatedInformation {
                message: "the first use of this label".to_string(),
                location: first.clone(),
            }])
            .build(),
        );
        return;
    }
    labels.insert(label, location);
}

/// The state one document's validation pass carries.
struct DocCtx<'a> {
    document: &'a RawDocument,
    index: &'a DocumentIndex,
    view: &'a SchemaView<'a>,
    definition: &'a Definition,
    defer_labels: HashMap<String, SourceLocation>,
    declared_variables: HashMap<String, DeclaredVariable>,
    document_name: String,
    paginated: usize,
    first_paginated: Option<String>,
    /// `defaultPaginateMode`, for the checks that depend on the resolved mode.
    default_paginate_mode: &'a str,
    /// Every extracted document, so a rule can read a fragment's own selections.
    documents: &'a [RawDocument],
}

/// One variable definition of the document, as the pagination rules read it.
#[derive(Clone, Debug)]
struct DeclaredVariable {
    /// The declared type, printed (`Int`, `[String!]!`).
    type_name: String,
    /// Where the variable was declared.
    loc: Option<crate::graphql::ast::Loc>,
    /// True when the definition carries a default value.
    has_default: bool,
}

impl<'a> DocCtx<'a> {
    /// A location inside this document.
    fn at(&self, loc: Option<crate::graphql::ast::Loc>) -> SourceLocation {
        document_location(self.document, loc)
    }
}

fn validate_document(
    document: &RawDocument,
    documents: &[RawDocument],
    index: &DocumentIndex,
    view: &SchemaView,
    schema_errors: &[String],
    config: &RustConfig,
    diagnostics: &mut Vec<Diagnostic>,
    cycles: &mut HashSet<String>,
) {
    let Some(definition) = document.ast.definitions.first() else {
        return;
    };

    // FLM1019: a document name that cannot be a TypeScript type alias or a barrel binding. A
    // composed name is `Route<...>_<hash>` by construction, so the check cannot fire for it.
    if document.surface != DocumentSurface::Composed
        && !document.name.is_empty()
        && !is_usable_document_name(&document.name)
    {
        let where_ = document_location(document, definition.loc());
        diagnostics.push(
            DiagnosticInput::error(
                "FLM1019",
                format!(
                    "Document name \"{}\" ({}) cannot be used as a TypeScript identifier; rename the {}.",
                    document.name, document.relative_path, document.kind.as_str()
                ),
                where_,
            )
            .with_hint(format!("for example \"{}$doc\"", document.name))
            .build(),
        );
    }
    if let Definition::Operation(node) = definition {
        let ast_name = node.name.as_ref().map(|name| name.value.as_str()).unwrap_or("");
        if ast_name.is_empty() && document.name.is_empty() {
            let where_ = document_location(document, definition.loc());
            diagnostics.push(DiagnosticInput::error(
                "FLM1003",
                format!(
                    "Anonymous operations are not supported; name the {} at {}:{}:{}.",
                    document.kind.as_str(),
                    document.relative_path,
                    where_.line,
                    where_.column
                ),
                where_,
            ).build());
        }
    }

    // FLM2002: `graphql.validate` runs `assertValidSchema` first and throws when the
    // schema is invalid, so the oracle reports the thrown message at the document's
    // definition and skips every rule (and the deprecation pass) for that document.
    if !schema_errors.is_empty() {
        diagnostics.push(DiagnosticInput::error(
            "FLM2002",
            format!("Invalid schema: {}", schema_errors.join("\n\n")),
            document_location(document, definition.loc()),
        ).build());
        return;
    }

    // FLM1007: the reference implementation's own rules, run against the document
    // plus its transitively referenced fragments.
    let validation = document_with_fragments(document, documents, index);
    let conditional_variables = collect_conditional_variables(&validation);
    let outcome = run_validation(view, &validation);
    let (errors, deprecated) = match outcome {
        Ok(value) => value,
        Err(message) => {
            diagnostics.push(DiagnosticInput::error(
                "FLM2002",
                format!("Invalid schema: {message}"),
                document_location(document, definition.loc()),
            ).build());
            return;
        }
    };
    for error in &errors {
        if let Some(variable) = never_used_variable(&error.message) {
            if conditional_variables.contains(&variable) {
                continue;
            }
        }
        let location = match error.site {
            Some(site) => {
                let source = documents.get(site.source).unwrap_or(document);
                let (line, column) = line_column_of(source, site.offset);
                location_at(
                    &document.source,
                    &document.relative_path,
                    local_offset(document, line, column),
                    1,
                )
            }
            None => document_location(document, definition.loc()),
        };
        diagnostics.push(DiagnosticInput::error(
            "FLM1007",
            format!(
                "{}:{}:{} {}",
                document.relative_path, location.line, location.column, error.message
            ),
            location,
        ).build());
    }
    report_deprecations(
        document,
        documents,
        definition,
        validation.base_source,
        &deprecated,
        diagnostics,
    );

    let root_type = root_type_of(definition, view);
    let mut ctx = DocCtx {
        document,
        index,
        view,
        definition,
        defer_labels: HashMap::new(),
        declared_variables: HashMap::new(),
        document_name: document.name.clone(),
        paginated: 0,
        first_paginated: None,
        default_paginate_mode: &config.default_paginate_mode,
        documents,
    };
    if let Definition::Operation(node) = definition {
        for variable in &node.variable_definitions {
            ctx.declared_variables.insert(
                variable.variable.name.value.clone(),
                DeclaredVariable {
                    type_name: type_ref_string(&variable.type_node),
                    loc: variable.loc,
                    has_default: variable.default_value.is_some(),
                },
            );
        }
    }

    // Definition-level directives.
    for directive in definition_directives(definition) {
        let name = directive.name.value.as_str();
        if RESERVED_DIRECTIVES.contains(&name) || name == "key" {
            diagnostics.push(DiagnosticInput::error(
                "FLM1008",
                format!(
                    "Directive \"@{name}\" is not supported by flamme {}.x; it is reserved.",
                    compiler_version_major()
                ),
                ctx.at(directive.loc),
            ).build());
        }
        if name == "listTarget" || name == "optimisticKey" {
            diagnostics.push(DiagnosticInput::error(
                "FLM1008",
                if name == "listTarget" {
                    LIST_TARGET_LOCATION_MESSAGE
                } else {
                    OPTIMISTIC_KEY_LOCATION_MESSAGE
                },
                ctx.at(directive.loc),
            ).build());
        }
        if name == "cache" && document.kind == ArtifactKind::Fragment {
            diagnostics.push(DiagnosticInput::error(
                "FLM1008",
                "Directive \"@cache\" is only supported on operations; it is reserved for fragments.",
                ctx.at(directive.loc),
            ).build());
        }
        if name == "cache" && document.kind != ArtifactKind::Query {
            diagnostics.push(DiagnosticInput::warning(
                "FLM1011",
                format!(
                    "@cache on a {} has no effect; the policy applies to queries only.",
                    document.kind.as_str()
                ),
                ctx.at(directive.loc),
            ).build());
        }
    }

    let start_type = match definition {
        Definition::Fragment(node) => ctx.view.named_type_name(&node.type_condition.name.value),
        Definition::Operation(_) => root_type,
        // A type system definition never reaches validation: the extraction rejects the
        // document, so the root type is only a total value here.
        Definition::TypeSystem(_) => root_type,
    };
    let loading = has_document_loading(definition);
    walk_selections(
        &mut ctx,
        definition_selection_set(definition),
        start_type.as_deref(),
        loading,
        false,
        diagnostics,
    );

    // FLM1006: fragment spread cycles, reported once per document that takes part.
    let cycle = find_fragment_cycle(&document.name, index);
    let signature = cycle
        .as_ref()
        .map(|cycle| {
            let mut unique: Vec<String> = cycle.clone();
            unique.sort();
            unique.dedup();
            unique.join("|")
        })
        .unwrap_or_default();
    if let Some(cycle) = cycle {
        if !cycles.contains(&signature) {
            cycles.insert(signature);
            diagnostics.push(DiagnosticInput::error(
                "FLM1006",
                format!("Fragment cycle detected: {}.", cycle.join(" → ")),
                document_location(document, definition.loc()),
            ).build());
        }
    }
}

/// True when the document or fragment definition carries a document-level `@loading`.
fn has_document_loading(definition: &Definition) -> bool {
    find_directive(definition_directives(definition), "loading").is_some()
}

/// The root type of a fragment's type condition or an operation's operation type.
fn root_type_of(definition: &Definition, view: &SchemaView) -> Option<String> {
    match definition {
        Definition::Fragment(node) => view.named_type_name(&node.type_condition.name.value),
        Definition::Operation(node) => view.root_type(node.operation),
        // A type system definition selects against no root, and the extraction rejects
        // such a document before validation runs.
        Definition::TypeSystem(_) => None,
    }
}

/// True when nothing a spread can land on is addressable (§4.5.1, K1).
fn unaddressable_type(view: &SchemaView, type_name: &str) -> bool {
    let concrete = view.possible_types(type_name);
    !concrete.is_empty() && concrete.iter().all(|name| view.is_embedded(name))
}

/// FLM1005: a type that declares key fields the selection cannot provide.
fn validate_key_availability(
    ctx: &DocCtx<'_>,
    field: &Field,
    type_name: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let keys = ctx.view.key_fields_for_type(type_name);
    if keys.is_empty() {
        return;
    }
    let mut selected: HashSet<String> = HashSet::new();
    if let Some(selection) = &field.selection_set {
        for entry in &selection.selections {
            if let Selection::Field(entry) = entry {
                selected.insert(entry.response_key().to_string());
            }
        }
    }
    let missing: Vec<&String> = keys
        .iter()
        .filter(|key| {
            !selected.contains(key.as_str())
                && !ctx.view.field_type(type_name, key).is_some_and(|node| {
                    ctx.view.is_leaf(&node.named_type().name.value)
                })
        })
        .collect();
    if missing.is_empty() {
        return;
    }
    let response_key = field.response_key();
    diagnostics.push(DiagnosticInput::error(
        "FLM1005",
        format!(
            "Type \"{type_name}\" declares key fields [{}] but the selection for \"{response_key}\" provides none of them; select \"{}\" or fix types: {{ {type_name}: {{ keys: [...] }} }} in flamme.config.ts.",
            keys.join(", "),
            keys.first().map(String::as_str).unwrap_or("id")
        ),
        ctx.at(field.loc),
    ).build());
}

/// FLM1002 plus the "no operations at all" hint of §4.4b.
fn validate_reachability(
    index: &DocumentIndex,
    documents: &[RawDocument],
    diagnostics: &mut Vec<Diagnostic>,
) {
    let mut reachable: HashSet<String> = HashSet::new();
    fn walk(name: &str, index: &DocumentIndex, reachable: &mut HashSet<String>, seen: &mut HashSet<String>) {
        if !seen.insert(name.to_string()) {
            return;
        }
        reachable.insert(name.to_string());
        if let Some(spreads) = index.spread_graph.get(name) {
            for spread in spreads {
                walk(spread, index, reachable, seen);
            }
        }
    }
    for position in &index.operations {
        let Some(document) = documents.get(*position) else { continue };
        let Some(definition) = document.ast.definitions.first() else {
            continue;
        };
        for spread in definition_spread_names(definition) {
            walk(&spread, index, &mut reachable, &mut HashSet::new());
        }
    }
    let mut names: Vec<&String> = index.fragments.keys().collect();
    names.sort_by_key(|name| index.fragments[*name].document);
    for name in names {
        let fragment = &index.fragments[name];
        if reachable.contains(&fragment.name) {
            continue;
        }
        let document = &documents[fragment.document];
        let where_ = document_location(document, definition_loc(document, fragment.definition));
        let mut input = DiagnosticInput::error(
            "FLM1002",
            format!(
                "Fragment \"{}\" ({}:{}:{}) is never spread by an operation; add it to a query or delete it.",
                fragment.name, document.relative_path, where_.line, where_.column
            ),
            where_,
        );
        if index.operations.is_empty() {
            input = input.with_hint(
                "This project has no operations at all; check the \"include\" globs in flamme.config.ts.",
            );
        }
        diagnostics.push(input.build());
    }
}

/// The location of a definition at an index inside a document's AST.
fn definition_loc(document: &RawDocument, index: usize) -> Option<crate::graphql::ast::Loc> {
    document.ast.definitions.get(index).and_then(Definition::loc)
}

/// Registers every `@list(name:)` in the project before any document is validated.
fn register_lists(
    documents: &[RawDocument],
    schema: &SchemaIndex,
    index: &mut DocumentIndex,
    diagnostics: &mut Vec<Diagnostic>,
) {
    struct Registration {
        document: usize,
        name: String,
        element: String,
        connection: bool,
        offset: Offset,
    }

    fn register(
        registration: Registration,
        documents: &[RawDocument],
        index: &mut DocumentIndex,
        diagnostics: &mut Vec<Diagnostic>,
    ) {
        let document = &documents[registration.document];
        if let Some(existing) = index.lists.get(&registration.name) {
            if existing.type_name != registration.element {
                let existing_document = &documents[existing.document];
                let first = location_at(
                    &existing_document.source,
                    &existing_document.relative_path,
                    existing.offset,
                    1,
                );
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM1012",
                        format!(
                            "List \"{}\" is also declared on type \"{}\" at {}:{}:{}.",
                            registration.name,
                            existing.type_name,
                            existing_document.relative_path,
                            first.line,
                            first.column
                        ),
                        location_at(
                            &document.source,
                            &document.relative_path,
                            registration.offset,
                            1,
                        ),
                    )
                    .with_related(vec![RelatedInformation {
                        message: format!("first declared on \"{}\" here", existing.type_name),
                        location: first,
                    }])
                    .build(),
                );
                return;
            }
            return;
        }
        let connection = registration.connection;
        index.lists.insert(
            registration.name.clone(),
            ListRegistration {
                name: registration.name.clone(),
                type_name: registration.element.clone(),
                connection,
                document: registration.document,
                spec: ListSpec {
                    name: registration.name,
                    connection,
                    type_name: registration.element,
                    include_list_id: None,
                },
                offset: registration.offset,
            },
        );
    }

    fn visit(
        document: usize,
        selection_set: &SelectionSet,
        parent_type: Option<&str>,
        documents: &[RawDocument],
        schema: &SchemaIndex,
        index: &mut DocumentIndex,
        diagnostics: &mut Vec<Diagnostic>,
    ) {
        for selection in &selection_set.selections {
            match selection {
                Selection::FragmentSpread(_) => continue,
                Selection::InlineFragment(inline) => {
                    let condition = inline
                        .type_condition
                        .as_ref()
                        .map(|condition| condition.name.value.clone());
                    let next = condition
                        .as_deref()
                        .and_then(|condition| named_type_name(schema, condition))
                        .or_else(|| parent_type.map(str::to_string));
                    visit(
                        document,
                        &inline.selection_set,
                        next.as_deref(),
                        documents,
                        schema,
                        index,
                        diagnostics,
                    );
                    continue;
                }
                Selection::Field(field) => {
                    let field_type = parent_type
                        .and_then(|parent| schema.field_type(parent, &field.name.value));
                    if let Some(field_type) = field_type {
                        let directive = find_directive(&field.directives, "list");
                        let list_name = directive_string_argument(directive, "name");
                        // §7.10: `@paginate(name:)` names the paginated connection the same way
                        // `@list(name:)` names a list, so `...<Name>_insert` reaches it. The two
                        // share one namespace (Houdini's `discovered_lists`).
                        let paginate = find_directive(&field.directives, "paginate");
                        let paginate_name = directive_string_argument(paginate, "name");
                        if list_name.is_some() || paginate_name.is_some() {
                            let element = list_element_type(schema, &type_ref_string(field_type))
                                .unwrap_or_else(|| {
                                    (field_type.named_type().name.value.clone(), false)
                                });
                            if let (Some(directive), Some(name)) = (directive, list_name) {
                                if !name.is_empty() {
                                    let connection =
                                        directive_boolean_argument(Some(directive), "connection")
                                            .unwrap_or(element.1);
                                    register(
                                        Registration {
                                            document,
                                            name,
                                            element: element.0.clone(),
                                            connection,
                                            offset: file_offset_of(
                                                &documents[document],
                                                directive.loc.map(|loc| loc.start).unwrap_or(0),
                                            ),
                                        },
                                        documents,
                                        index,
                                        diagnostics,
                                    );
                                }
                            }
                            // The paginated connection's connection-ness comes from its value type
                            // (Houdini's `type_modifiers NOT LIKE '%]%'`), never from an argument.
                            if let (Some(directive), Some(name)) = (paginate, paginate_name) {
                                if !name.is_empty() {
                                    register(
                                        Registration {
                                            document,
                                            name,
                                            element: element.0,
                                            connection: element.1,
                                            offset: file_offset_of(
                                                &documents[document],
                                                directive.loc.map(|loc| loc.start).unwrap_or(0),
                                            ),
                                        },
                                        documents,
                                        index,
                                        diagnostics,
                                    );
                                }
                            }
                        }
                    }
                    if let Some(child) = &field.selection_set {
                        let named = field_type
                            .map(|node| node.named_type().name.value.clone());
                        let next = named.or_else(|| parent_type.map(str::to_string));
                        visit(
                            document,
                            child,
                            next.as_deref(),
                            documents,
                            schema,
                            index,
                            diagnostics,
                        );
                    }
                }
            }
        }
    }

    for (position, document) in documents.iter().enumerate() {
        let Some(definition) = document.ast.definitions.first() else {
            continue;
        };
        let start = match definition {
            Definition::Fragment(node) => named_type_name(schema, &node.type_condition.name.value),
            Definition::Operation(node) => root_name_of(schema, node.operation)
                .and_then(|name| named_type_name(schema, &name)),
            // Unreachable: the extraction rejects a document holding a type system
            // definition before this walk runs.
            Definition::TypeSystem(_) => None,
        };
        visit(
            position,
            definition_selection_set(definition),
            start.as_deref(),
            documents,
            schema,
            index,
            diagnostics,
        );
    }
}

/// The declared name of an operation's root type, when the schema has one.
fn root_name_of(schema: &SchemaIndex, operation: OperationType) -> Option<String> {
    let explicit = schema.document.definitions.iter().find_map(|definition| {
        if let crate::graphql::ast::TypeSystemDefinition::Schema(node) = definition {
            if node.is_extension {
                return None;
            }
            return node
                .operation_types
                .iter()
                .find(|entry| entry.operation == operation)
                .map(|entry| entry.type_name.value.clone());
        }
        None
    });
    if let Some(name) = explicit {
        return Some(name);
    }
    let has_schema_definition = schema.document.definitions.iter().any(|definition| {
        matches!(definition, crate::graphql::ast::TypeSystemDefinition::Schema(_))
    });
    if has_schema_definition {
        // An explicit `schema { … }` with no entry for this operation: extensions
        // may still declare one.
        let extension = schema.document.definitions.iter().find_map(|definition| {
            if let crate::graphql::ast::TypeSystemDefinition::Schema(node) = definition {
                if !node.is_extension {
                    return None;
                }
                return node
                    .operation_types
                    .iter()
                    .find(|entry| entry.operation == operation)
                    .map(|entry| entry.type_name.value.clone());
            }
            None
        });
        return extension;
    }
    let default = match operation {
        OperationType::Query => "Query",
        OperationType::Mutation => "Mutation",
        OperationType::Subscription => "Subscription",
    };
    named_type_name(schema, default)
}

/// A named type the schema knows, including the introspection types.
fn named_type_name(schema: &SchemaIndex, name: &str) -> Option<String> {
    if schema.named_type(name).is_some() || introspection_kind(name).is_some() {
        return Some(name.to_string());
    }
    if is_specified_scalar(name) {
        return Some(name.to_string());
    }
    None
}

// ---------------------------------------------------------------------------
// The schema view the validation rules read
// ---------------------------------------------------------------------------

/// One argument of a field or directive in the view.
#[derive(Clone, Debug)]
struct ArgDef {
    /// The argument name.
    name: String,
    /// The argument's declared type.
    type_node: TypeNode,
    /// The default value, when the declaration carries one.
    default_value: Option<Value>,
    /// The `@deprecated` reason, when the member is deprecated.
    deprecated: Option<String>,
}

/// One field of an object or interface in the view.
#[derive(Clone, Debug)]
struct FieldDef {
    /// The field name.
    name: String,
    /// The field's declared type.
    type_node: TypeNode,
    /// The field's arguments, in declaration order.
    args: Vec<ArgDef>,
    /// The `@deprecated` reason, when the field is deprecated.
    deprecated: Option<String>,
}

/// One field of an input object in the view.
#[derive(Clone, Debug)]
struct InputFieldDef {
    /// The field name.
    name: String,
    /// The field's declared type.
    type_node: TypeNode,
    /// The default value, when the declaration carries one.
    default_value: Option<Value>,
    /// The `@deprecated` reason, when the field is deprecated.
    deprecated: Option<String>,
}

/// One directive definition in the view.
#[derive(Clone, Debug)]
struct DirectiveDef {
    /// The directive name.
    name: String,
    /// The directive's arguments, in declaration order.
    args: Vec<ArgDef>,
    /// True for `repeatable`.
    repeatable: bool,
    /// The directive locations, uppercase as graphql-js spells them.
    locations: Vec<String>,
}

/// The compiler's read-only view of the schema, shaped for the validation rules.
struct SchemaView<'a> {
    schema: &'a SchemaIndex,
    kinds: HashMap<String, SchemaTypeKind>,
    fields: HashMap<String, Vec<FieldDef>>,
    input_fields: HashMap<String, Vec<InputFieldDef>>,
    enum_values: HashMap<String, Vec<String>>,
    interfaces: HashMap<String, Vec<String>>,
    unions: HashMap<String, Vec<String>>,
    directives: HashMap<String, DirectiveDef>,
    one_of: HashSet<String>,
    enum_deprecations: HashMap<(String, String), String>,
    type_names: Vec<String>,
    query_type: Option<String>,
    mutation_type: Option<String>,
    subscription_type: Option<String>,
}

impl<'a> SchemaView<'a> {
    /// Builds the view from the schema index and the parsed index SDL.
    fn build(schema: &'a SchemaIndex) -> Self {
        use crate::graphql::ast::{TypeDefinition, TypeSystemDefinition};

        let mut view = SchemaView {
            schema,
            kinds: HashMap::new(),
            fields: HashMap::new(),
            input_fields: HashMap::new(),
            enum_values: HashMap::new(),
            interfaces: HashMap::new(),
            unions: HashMap::new(),
            directives: HashMap::new(),
            one_of: HashSet::new(),
            enum_deprecations: HashMap::new(),
            type_names: Vec::new(),
            query_type: None,
            mutation_type: None,
            subscription_type: None,
        };

        // Base definitions first, extensions after, exactly like `buildSchema`.
        for extension_pass in [false, true] {
            for definition in &schema.document.definitions {
                let TypeSystemDefinition::Type(entry) = definition else {
                    continue;
                };
                if entry.is_extension() != extension_pass {
                    continue;
                }
                let name = entry.name().to_string();
                match entry {
                    TypeDefinition::Scalar(node) => {
                        view.kinds.insert(name, SchemaTypeKind::Scalar);
                        let _ = node;
                    }
                    TypeDefinition::Object(node) => {
                        view.kinds.insert(name.clone(), SchemaTypeKind::Object);
                        let fields = view.fields.entry(name.clone()).or_default();
                        for field in &node.fields {
                            fields.push(field_def(field));
                        }
                        let interfaces = view.interfaces.entry(name).or_default();
                        for entry in &node.interfaces {
                            interfaces.push(entry.name.value.clone());
                        }
                    }
                    TypeDefinition::Interface(node) => {
                        view.kinds.insert(name.clone(), SchemaTypeKind::Interface);
                        let fields = view.fields.entry(name.clone()).or_default();
                        for field in &node.fields {
                            fields.push(field_def(field));
                        }
                        let interfaces = view.interfaces.entry(name).or_default();
                        for entry in &node.interfaces {
                            interfaces.push(entry.name.value.clone());
                        }
                    }
                    TypeDefinition::Union(node) => {
                        view.kinds.insert(name.clone(), SchemaTypeKind::Union);
                        let members = view.unions.entry(name).or_default();
                        for entry in &node.types {
                            members.push(entry.name.value.clone());
                        }
                    }
                    TypeDefinition::Enum(node) => {
                        view.kinds.insert(name.clone(), SchemaTypeKind::Enum);
                        let values = view.enum_values.entry(name.clone()).or_default();
                        for value in &node.values {
                            values.push(value.name.value.clone());
                            if let Some(reason) = deprecation_reason(&value.directives) {
                                view.enum_deprecations
                                    .insert((name.clone(), value.name.value.clone()), reason);
                            }
                        }
                    }
                    TypeDefinition::InputObject(node) => {
                        view.kinds.insert(name.clone(), SchemaTypeKind::InputObject);
                        if find_directive(&node.directives, "oneOf").is_some() {
                            view.one_of.insert(name.clone());
                        }
                        let input = view.input_fields.entry(name).or_default();
                        for field in &node.fields {
                            input.push(input_field_def(field));
                        }
                    }
                }
            }
        }

        for definition in &schema.document.definitions {
            let TypeSystemDefinition::Directive(node) = definition else {
                continue;
            };
            view.directives.insert(node.name.value.clone(), directive_def(node));
        }
        for fallback in FALLBACK_DIRECTIVES.iter() {
            view.directives
                .entry(fallback.0.to_string())
                .or_insert_with(|| fallback.1.clone());
        }
        for (name, values) in FALLBACK_ENUMS {
            view.enum_values.entry((*name).to_string()).or_insert_with(|| {
                values.iter().map(|value| (*value).to_string()).collect()
            });
            view.kinds.entry((*name).to_string()).or_insert(SchemaTypeKind::Enum);
        }

        // The schema index's own view fills anything the SDL parse did not carry.
        for entry in &schema.types {
            view.kinds.entry(entry.name.clone()).or_insert(entry.kind);
            if matches!(entry.kind, SchemaTypeKind::Object | SchemaTypeKind::Interface)
                && !view.fields.contains_key(&entry.name)
            {
                let fields: Vec<FieldDef> = entry
                    .fields
                    .iter()
                    .map(|field| FieldDef {
                        name: field.name.clone(),
                        type_node: field.type_node.clone(),
                        args: field
                            .arguments
                            .iter()
                            .map(|argument| ArgDef {
                                name: argument.name.clone(),
                                type_node: argument.type_node.clone(),
                                default_value: argument.default_value.clone(),
                                deprecated: deprecation_reason(&argument.directives),
                            })
                            .collect(),
                        deprecated: deprecation_reason(&field.directives),
                    })
                    .collect();
                view.fields.insert(entry.name.clone(), fields);
            }
            if entry.kind == SchemaTypeKind::Enum && !view.enum_values.contains_key(&entry.name) {
                view.enum_values.insert(entry.name.clone(), entry.enum_values.clone());
            }
            if entry.kind == SchemaTypeKind::InputObject
                && find_directive(&entry.directives, "oneOf").is_some()
            {
                view.one_of.insert(entry.name.clone());
            }
            if entry.kind == SchemaTypeKind::InputObject
                && !view.input_fields.contains_key(&entry.name)
            {
                let input: Vec<InputFieldDef> = entry
                    .fields
                    .iter()
                    .map(|field| InputFieldDef {
                        name: field.name.clone(),
                        type_node: field.type_node.clone(),
                        default_value: None,
                        deprecated: deprecation_reason(&field.directives),
                    })
                    .collect();
                view.input_fields.insert(entry.name.clone(), input);
            }
            if entry.kind == SchemaTypeKind::Union && !view.unions.contains_key(&entry.name) {
                view.unions.insert(entry.name.clone(), entry.union_types.clone());
            }
            if matches!(entry.kind, SchemaTypeKind::Object | SchemaTypeKind::Interface)
                && !view.interfaces.contains_key(&entry.name)
            {
                view.interfaces.insert(entry.name.clone(), entry.interfaces.clone());
            }
        }

        // The specified scalars and the introspection types every schema carries.
        for name in SPECIFIED_SCALARS {
            view.kinds.entry((*name).to_string()).or_insert(SchemaTypeKind::Scalar);
        }
        for (name, kind, fields) in INTROSPECTION_TYPES {
            view.kinds.insert((*name).to_string(), *kind);
            let mut definitions = Vec::new();
            for (field_name, type_text, args) in *fields {
                definitions.push(FieldDef {
                    name: (*field_name).to_string(),
                    type_node: parse_type_ref(type_text),
                    args: args
                        .iter()
                        .map(|(argument, argument_type)| ArgDef {
                            name: (*argument).to_string(),
                            type_node: parse_type_ref(argument_type),
                            default_value: None,
                            deprecated: None,
                        })
                        .collect(),
                    deprecated: None,
                });
            }
            view.fields.insert((*name).to_string(), definitions);
        }
        for (name, values) in INTROSPECTION_ENUMS {
            view.kinds.insert((*name).to_string(), SchemaTypeKind::Enum);
            view.enum_values.insert(
                (*name).to_string(),
                values.iter().map(|value| (*value).to_string()).collect(),
            );
        }

        view.query_type = root_name_of(schema, OperationType::Query);
        view.mutation_type = root_name_of(schema, OperationType::Mutation);
        view.subscription_type = root_name_of(schema, OperationType::Subscription);

        let mut names: Vec<String> = view.kinds.keys().cloned().collect();
        names.sort();
        view.type_names = names;
        view
    }

    /// The schema index the view was built from.
    fn schema(&self) -> &'a SchemaIndex {
        self.schema
    }

    /// True when the named type is known to the schema (introspection included).
    fn named_type_name(&self, name: &str) -> Option<String> {
        if self.kinds.contains_key(name) {
            return Some(name.to_string());
        }
        named_type_name(self.schema, name)
    }

    /// The declared type of a field, introspection fields included.
    fn field_type(&self, parent: &str, field: &str) -> Option<TypeNode> {
        self.field_info(parent, field).map(|entry| entry.type_node)
    }

    /// The field definition of a type, introspection meta fields included.
    fn field_info(&self, parent: &str, field: &str) -> Option<FieldDef> {
        if field == "__typename" && self.is_composite(parent) {
            return Some(FieldDef {
                name: "__typename".to_string(),
                type_node: parse_type_ref("String!"),
                args: Vec::new(),
                deprecated: None,
            });
        }
        if field == "__schema" && self.query_type.as_deref() == Some(parent) {
            return Some(FieldDef {
                name: "__schema".to_string(),
                type_node: parse_type_ref("__Schema!"),
                args: Vec::new(),
                deprecated: None,
            });
        }
        if field == "__type" && self.query_type.as_deref() == Some(parent) {
            return Some(FieldDef {
                name: "__type".to_string(),
                type_node: parse_type_ref("__Type"),
                args: vec![ArgDef {
                    name: "name".to_string(),
                    type_node: parse_type_ref("String!"),
                    default_value: None,
                    deprecated: None,
                }],
                deprecated: None,
            });
        }
        self.field_def(parent, field).cloned()
    }

    /// The field definition of a type, when it has one.
    fn field_def(&self, parent: &str, field: &str) -> Option<&FieldDef> {
        self.fields.get(parent)?.iter().find(|entry| entry.name == field)
    }

    /// The input field definition of an input object, when it has one.
    fn input_field_def(&self, parent: &str, field: &str) -> Option<&InputFieldDef> {
        self.input_fields.get(parent)?.iter().find(|entry| entry.name == field)
    }

    /// The kind of a named type.
    fn kind(&self, name: &str) -> Option<SchemaTypeKind> {
        self.kinds.get(name).copied()
    }

    /// True for a scalar or an enum.
    fn is_leaf(&self, name: &str) -> bool {
        matches!(self.kind(name), Some(SchemaTypeKind::Scalar | SchemaTypeKind::Enum))
    }

    /// True for an object, interface or union.
    fn is_composite(&self, name: &str) -> bool {
        matches!(
            self.kind(name),
            Some(SchemaTypeKind::Object | SchemaTypeKind::Interface | SchemaTypeKind::Union)
        )
    }

    /// True for an abstract type.
    fn is_abstract(&self, name: &str) -> bool {
        matches!(self.kind(name), Some(SchemaTypeKind::Interface | SchemaTypeKind::Union))
    }

    /// True for an input object.
    fn is_input_object(&self, name: &str) -> bool {
        self.kind(name) == Some(SchemaTypeKind::InputObject)
    }

    /// True for a scalar, an enum or an input object.
    fn is_input_type(&self, node: &TypeNode) -> bool {
        matches!(
            self.kind(&node.named_type().name.value),
            Some(SchemaTypeKind::Scalar | SchemaTypeKind::Enum | SchemaTypeKind::InputObject)
        )
    }

    /// True for a scalar, an enum, an object, an interface or a union.
    fn is_output_type(&self, node: &TypeNode) -> bool {
        !matches!(self.kind(&node.named_type().name.value), Some(SchemaTypeKind::InputObject) | None)
    }

    /// The possible concrete types of a composite type.
    fn possible_types(&self, name: &str) -> Vec<String> {
        if let Some(entry) = self.schema.possible_types.get(name) {
            return entry.clone();
        }
        match self.kind(name) {
            Some(SchemaTypeKind::Object) => vec![name.to_string()],
            Some(SchemaTypeKind::Union) => self.unions.get(name).cloned().unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// True when `maybe` is a possible type of `abstract`.
    fn is_sub_type(&self, abstract_type: &str, maybe: &str) -> bool {
        if abstract_type == maybe {
            return true;
        }
        match self.kind(abstract_type) {
            Some(SchemaTypeKind::Union) => self
                .unions
                .get(abstract_type)
                .is_some_and(|members| members.iter().any(|member| member == maybe)),
            Some(SchemaTypeKind::Interface) => {
                if self.possible_types(abstract_type).iter().any(|entry| entry == maybe) {
                    return true;
                }
                self.implementing_interfaces(abstract_type).iter().any(|entry| entry == maybe)
            }
            _ => false,
        }
    }

    /// The interfaces that implement `name`, transitively.
    fn implementing_interfaces(&self, name: &str) -> Vec<String> {
        let mut found: Vec<String> = Vec::new();
        for (candidate, interfaces) in &self.interfaces {
            if candidate == name {
                continue;
            }
            if interfaces.iter().any(|entry| entry == name) {
                found.push(candidate.clone());
            }
        }
        // One transitive closure step is enough for the interface hierarchies a
        // schema may declare: repeat until stable.
        loop {
            let mut added = false;
            for (candidate, interfaces) in &self.interfaces {
                if candidate == name || found.contains(candidate) {
                    continue;
                }
                if interfaces.iter().any(|entry| found.contains(entry) || entry == name) {
                    found.push(candidate.clone());
                    added = true;
                }
            }
            if !added {
                break;
            }
        }
        found
    }

    /// The key fields used for a type.
    fn key_fields_for_type(&self, name: &str) -> &[String] {
        self.schema.key_fields_for_type(name)
    }

    /// True when a type is stored inline.
    fn is_embedded(&self, name: &str) -> bool {
        self.schema.is_embedded(name)
    }

    /// The root type name of an operation.
    fn root_type(&self, operation: OperationType) -> Option<String> {
        match operation {
            OperationType::Query => self.query_type.clone(),
            OperationType::Mutation => self.mutation_type.clone(),
            OperationType::Subscription => self.subscription_type.clone(),
        }
    }
}

/// The definition of one field in the parsed SDL.
fn field_def(field: &crate::graphql::ast::FieldDefinition) -> FieldDef {
    FieldDef {
        name: field.name.value.clone(),
        type_node: field.type_node.clone(),
        args: field.arguments.iter().map(input_value_def).collect(),
        deprecated: deprecation_reason(&field.directives),
    }
}

/// The definition of one input value in the parsed SDL.
fn input_value_def(value: &crate::graphql::ast::InputValueDefinition) -> ArgDef {
    ArgDef {
        name: value.name.value.clone(),
        type_node: value.type_node.clone(),
        default_value: value.default_value.clone(),
        deprecated: deprecation_reason(&value.directives),
    }
}

/// The definition of one input object field in the parsed SDL.
fn input_field_def(field: &crate::graphql::ast::InputValueDefinition) -> InputFieldDef {
    InputFieldDef {
        name: field.name.value.clone(),
        type_node: field.type_node.clone(),
        default_value: field.default_value.clone(),
        deprecated: deprecation_reason(&field.directives),
    }
}

/// The definition of one directive in the parsed SDL.
fn directive_def(node: &crate::graphql::ast::DirectiveDefinition) -> DirectiveDef {
    DirectiveDef {
        name: node.name.value.clone(),
        args: node.arguments.iter().map(input_value_def).collect(),
        repeatable: node.repeatable,
        locations: node.locations.iter().map(|entry| entry.value.clone()).collect(),
    }
}

/// The `@deprecated(reason:)` reason of a member, when it is deprecated.
fn deprecation_reason(directives: &[Directive]) -> Option<String> {
    let directive = find_directive(directives, "deprecated")?;
    Some(
        directive_string_argument(Some(directive), "reason")
            .unwrap_or_else(|| "No longer supported".to_string()),
    )
}

/// True for one of GraphQL's specified scalar types.
fn is_specified_scalar(name: &str) -> bool {
    SPECIFIED_SCALARS.contains(&name)
}

/// The kind of an introspection type, when `name` is one.
fn introspection_kind(name: &str) -> Option<SchemaTypeKind> {
    INTROSPECTION_TYPES
        .iter()
        .find(|entry| entry.0 == name)
        .map(|entry| entry.1)
        .or_else(|| {
            INTROSPECTION_ENUMS
                .iter()
                .find(|entry| entry.0 == name)
                .map(|_| SchemaTypeKind::Enum)
        })
}

/// GraphQL's specified scalars.
const SPECIFIED_SCALARS: &[&str] = &["String", "Int", "Float", "Boolean", "ID"];

/// The introspection object types, with their fields and field arguments.
type IntrospectionFields = &'static [(&'static str, &'static str, &'static [(&'static str, &'static str)])];
const INTROSPECTION_TYPES: &[(&str, SchemaTypeKind, IntrospectionFields)] = &[
    (
        "__Schema",
        SchemaTypeKind::Object,
        &[
            ("description", "String", &[]),
            ("types", "[__Type!]!", &[]),
            ("queryType", "__Type!", &[]),
            ("mutationType", "__Type", &[]),
            ("subscriptionType", "__Type", &[]),
            ("directives", "[__Directive!]!", &[]),
        ],
    ),
    (
        "__Type",
        SchemaTypeKind::Object,
        &[
            ("kind", "__TypeKind!", &[]),
            ("name", "String", &[]),
            ("description", "String", &[]),
            ("specifiedByURL", "String", &[]),
            ("fields", "[__Field!]", &[("includeDeprecated", "Boolean")]),
            ("interfaces", "[__Type!]", &[]),
            ("possibleTypes", "[__Type!]", &[]),
            ("enumValues", "[__EnumValue!]", &[("includeDeprecated", "Boolean")]),
            ("inputFields", "[__InputValue!]", &[("includeDeprecated", "Boolean")]),
            ("ofType", "__Type", &[]),
            ("isOneOf", "Boolean", &[]),
        ],
    ),
    (
        "__Field",
        SchemaTypeKind::Object,
        &[
            ("name", "String!", &[]),
            ("description", "String", &[]),
            ("args", "[__InputValue!]!", &[("includeDeprecated", "Boolean")]),
            ("type", "__Type!", &[]),
            ("isDeprecated", "Boolean!", &[]),
            ("deprecationReason", "String", &[]),
        ],
    ),
    (
        "__InputValue",
        SchemaTypeKind::Object,
        &[
            ("name", "String!", &[]),
            ("description", "String", &[]),
            ("type", "__Type!", &[]),
            ("defaultValue", "String", &[]),
            ("isDeprecated", "Boolean!", &[]),
            ("deprecationReason", "String", &[]),
        ],
    ),
    (
        "__EnumValue",
        SchemaTypeKind::Object,
        &[
            ("name", "String!", &[]),
            ("description", "String", &[]),
            ("isDeprecated", "Boolean!", &[]),
            ("deprecationReason", "String", &[]),
        ],
    ),
    (
        "__Directive",
        SchemaTypeKind::Object,
        &[
            ("name", "String!", &[]),
            ("description", "String", &[]),
            ("isRepeatable", "Boolean!", &[]),
            ("locations", "[__DirectiveLocation!]!", &[]),
            ("args", "[__InputValue!]!", &[("includeDeprecated", "Boolean")]),
        ],
    ),
];

/// The introspection enum types.
const INTROSPECTION_ENUMS: &[(&str, &[&str])] = &[
    (
        "__TypeKind",
        &["SCALAR", "OBJECT", "INTERFACE", "UNION", "ENUM", "INPUT_OBJECT", "LIST", "NON_NULL"],
    ),
    (
        "__DirectiveLocation",
        &[
            "QUERY",
            "MUTATION",
            "SUBSCRIPTION",
            "FIELD",
            "FRAGMENT_DEFINITION",
            "FRAGMENT_SPREAD",
            "INLINE_FRAGMENT",
            "VARIABLE_DEFINITION",
            "SCHEMA",
            "SCALAR",
            "OBJECT",
            "FIELD_DEFINITION",
            "ARGUMENT_DEFINITION",
            "INTERFACE",
            "UNION",
            "ENUM",
            "ENUM_VALUE",
            "INPUT_OBJECT",
            "INPUT_FIELD_DEFINITION",
        ],
    ),
];

/// The compiler's own directive definitions, used when the index SDL lacks them.
fn fallback_directives() -> Vec<(&'static str, DirectiveDef)> {
    fn arg(name: &str, type_text: &str, default: Option<Value>) -> ArgDef {
        ArgDef {
            name: name.to_string(),
            type_node: parse_type_ref(type_text),
            default_value: default,
            deprecated: None,
        }
    }
    fn directive(name: &str, args: Vec<ArgDef>, locations: &[&str]) -> DirectiveDef {
        DirectiveDef {
            name: name.to_string(),
            args,
            repeatable: false,
            locations: locations.iter().map(|entry| (*entry).to_string()).collect(),
        }
    }
    let boolean_true = Value::BooleanValue { value: true, loc: None };
    vec![
        (
            "loading",
            directive(
                "loading",
                vec![arg("count", "Int", None), arg("cascade", "Boolean", None)],
                &["QUERY", "MUTATION", "SUBSCRIPTION", "FIELD", "FRAGMENT_DEFINITION", "FRAGMENT_SPREAD"],
            ),
        ),
        (
            "paginate",
            directive(
                "paginate",
                vec![arg("mode", "PaginateMode", None), arg("name", "String", None)],
                &["FIELD"],
            ),
        ),
        (
            "list",
            directive("list", vec![arg("name", "String!", None), arg("connection", "Boolean", None)], &["FIELD"]),
        ),
        (
            "key",
            DirectiveDef {
                name: "key".to_string(),
                args: vec![arg("fields", "[String!]!", None)],
                repeatable: true,
                locations: vec!["OBJECT".to_string(), "INTERFACE".to_string()],
            },
        ),
        ("mask_enable", directive("mask_enable", vec![], &["FRAGMENT_SPREAD"])),
        ("mask_disable", directive("mask_disable", vec![], &["FRAGMENT_SPREAD"])),
        (
            "cache",
            directive(
                "cache",
                vec![arg("policy", "CachePolicy", None), arg("partial", "Boolean", None)],
                &["QUERY", "MUTATION", "SUBSCRIPTION"],
            ),
        ),
        (
            "dedupe",
            directive(
                "dedupe",
                vec![arg("cancelFirst", "Boolean", None), arg("match", "DedupeMatchMode", None)],
                &["QUERY", "MUTATION"],
            ),
        ),
        ("prepend", directive("prepend", vec![], &["FRAGMENT_SPREAD"])),
        ("append", directive("append", vec![], &["FRAGMENT_SPREAD"])),
        ("listTarget", directive("listTarget", vec![arg("name", "String!", None)], &["FRAGMENT_SPREAD"])),
        ("optimisticKey", directive("optimisticKey", vec![], &["FIELD"])),
        ("required", directive("required", vec![], &["FIELD", "FRAGMENT_SPREAD"])),
        ("when", directive("when", vec![arg("argument", "String!", None)], &["FRAGMENT_SPREAD"])),
        ("when_not", directive("when_not", vec![arg("argument", "String!", None)], &["FRAGMENT_SPREAD"])),
        (
            "defer",
            directive(
                "defer",
                vec![arg("if", "Boolean", Some(boolean_true.clone())), arg("label", "String", None)],
                &["FRAGMENT_SPREAD", "INLINE_FRAGMENT"],
            ),
        ),
        (
            "stream",
            directive(
                "stream",
                vec![
                    arg("if", "Boolean", Some(boolean_true)),
                    arg("label", "String", None),
                    arg("initialCount", "Int", Some(Value::IntValue { value: "0".to_string(), loc: None })),
                ],
                &["FIELD"],
            ),
        ),
        ("include", directive("include", vec![arg("if", "Boolean!", None)], &["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"])),
        ("skip", directive("skip", vec![arg("if", "Boolean!", None)], &["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"])),
        (
            "deprecated",
            directive(
                "deprecated",
                vec![arg("reason", "String", Some(Value::StringValue { value: "No longer supported".to_string(), block: false, loc: None }))],
                &["FIELD_DEFINITION", "ARGUMENT_DEFINITION", "INPUT_FIELD_DEFINITION", "ENUM_VALUE"],
            ),
        ),
        ("specifiedBy", directive("specifiedBy", vec![arg("url", "String!", None)], &["SCALAR"])),
        ("oneOf", directive("oneOf", vec![], &["INPUT_OBJECT"])),
    ]
}

/// A lazily built table of the fallback directive definitions.
static FALLBACK_DIRECTIVES: std::sync::LazyLock<Vec<(&'static str, DirectiveDef)>> =
    std::sync::LazyLock::new(fallback_directives);

/// The compiler's own enums, used when the index SDL lacks them.
const FALLBACK_ENUMS: &[(&str, &[&str])] = &[
    ("PaginateMode", &["SinglePage", "Infinite"]),
    ("CachePolicy", &["CacheOrNetwork", "NetworkOnly", "CacheAndNetwork", "CacheOnly"]),
    ("DedupeMatchMode", &["variables", "all"]),
];

// ---------------------------------------------------------------------------
// Suggestions (graphql-js `suggestionList` and `didYouMean`)
// ---------------------------------------------------------------------------

/// The names closest to `input`, sorted by distance then natural order.
fn suggestion_list(input: &str, options: &[String]) -> Vec<String> {
    let input_utf16: Vec<u16> = input.encode_utf16().collect();
    let threshold = ((input_utf16.len() as f64) * 0.4).floor() as usize + 1;
    let mut found: Vec<(usize, String)> = Vec::new();
    for option in options {
        if let Some(distance) = lexical_distance(&input_utf16, option, threshold) {
            found.push((distance, option.clone()));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| natural_compare(&a.1, &b.1)));
    found.into_iter().map(|(_, option)| option).collect()
}

/// The Levenshtein distance between `input` and `option`, when within `threshold`.
fn lexical_distance(input: &[u16], option: &str, threshold: usize) -> Option<usize> {
    let input_lower: Vec<u16> = String::from_utf16_lossy(input).to_lowercase().encode_utf16().collect();
    let option_lowered = option.to_lowercase();
    let option_units: Vec<u16> = option_lowered.encode_utf16().collect();
    if input == option_units.as_slice() {
        return Some(0);
    }
    if input_lower == option_units {
        return Some(1);
    }
    let (a, b) = if option_units.len() < input_lower.len() {
        (input_lower.as_slice(), option_units.as_slice())
    } else {
        (option_units.as_slice(), input_lower.as_slice())
    };
    let (a_length, b_length) = (a.len(), b.len());
    if a_length.saturating_sub(b_length) > threshold {
        return None;
    }
    // Damerau-Levenshtein with the same transposition rule as graphql-js.
    let mut previous: Vec<usize> = (0..=b_length).collect();
    let mut previous_two: Vec<usize> = vec![0; b_length + 1];
    for i in 1..=a_length {
        let mut current = vec![0usize; b_length + 1];
        current[0] = i;
        let mut smallest = current[0];
        for j in 1..=b_length {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            let mut cell = (previous[j] + 1).min(current[j - 1] + 1).min(previous[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                cell = cell.min(previous_two[j - 2] + 1);
            }
            if cell < smallest {
                smallest = cell;
            }
            current[j] = cell;
        }
        if smallest > threshold {
            return None;
        }
        previous_two = previous;
        previous = current;
    }
    let distance = previous[b_length];
    if distance <= threshold {
        Some(distance)
    } else {
        None
    }
}

/// graphql-js's `didYouMean`.
fn did_you_mean(sub_message: Option<&str>, suggestions: &[String]) -> String {
    let mut message = String::from(" Did you mean ");
    if let Some(sub_message) = sub_message {
        message.push_str(sub_message);
        message.push(' ');
    }
    let quoted: Vec<String> = suggestions.iter().map(|entry| format!("\"{entry}\"")).collect();
    match quoted.len() {
        0 => String::new(),
        1 => format!("{message}{}?", quoted[0]),
        2 => format!("{message}{} or {}?", quoted[0], quoted[1]),
        _ => {
            let selected = &quoted[..quoted.len().min(5)];
            let (last, rest) = selected.split_last().expect("non-empty");
            format!("{message}{}, or {last}?", rest.join(", "))
        }
    }
}

/// graphql-js's `naturalCompare`.
fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    let (mut a_index, mut b_index) = (0usize, 0usize);
    while a_index < a.len() && b_index < b.len() {
        let mut a_char = a[a_index];
        let mut b_char = b[b_index];
        if (48..=57).contains(&a_char) && (48..=57).contains(&b_char) {
            let mut a_num: i64 = 0;
            loop {
                a_index += 1;
                a_num = a_num * 10 + (a_char as i64 - 48);
                a_char = *a.get(a_index).unwrap_or(&0);
                if !((48..=57).contains(&a_char) && a_num > 0) {
                    break;
                }
            }
            let mut b_num: i64 = 0;
            loop {
                b_index += 1;
                b_num = b_num * 10 + (b_char as i64 - 48);
                b_char = *b.get(b_index).unwrap_or(&0);
                if !((48..=57).contains(&b_char) && b_num > 0) {
                    break;
                }
            }
            if a_num < b_num {
                return Ordering::Less;
            }
            if a_num > b_num {
                return Ordering::Greater;
            }
        } else {
            if a_char < b_char {
                return Ordering::Less;
            }
            if a_char > b_char {
                return Ordering::Greater;
            }
            a_index += 1;
            b_index += 1;
        }
    }
    (a.len() as i64).cmp(&(b.len() as i64))
}

// ---------------------------------------------------------------------------
// Literal printing, for the `ValuesOfCorrectType` messages
// ---------------------------------------------------------------------------

/// graphql-js's `print` for a value node.
fn print_literal(node: &Value) -> String {
    match node {
        Value::Variable(variable) => format!("${}", variable.name.value),
        Value::IntValue { value, .. }
        | Value::FloatValue { value, .. }
        | Value::EnumValue { value, .. } => value.clone(),
        Value::StringValue { value, block, .. } => {
            if *block {
                print_block_string(value)
            } else {
                json_string(value)
            }
        }
        Value::BooleanValue { value, .. } => if *value { "true" } else { "false" }.to_string(),
        Value::NullValue { .. } => "null".to_string(),
        Value::ListValue { values, .. } => format!(
            "[{}]",
            values.iter().map(print_literal).collect::<Vec<_>>().join(", ")
        ),
        Value::ObjectValue { fields, .. } => format!(
            "{{{}}}",
            fields
                .iter()
                .map(|field| format!("{}: {}", field.name.value, print_literal(&field.value)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// graphql-js's `printBlockString`.
fn print_block_string(value: &str) -> String {
    let escaped = value.replace("\"\"\"", "\\\"\"\"");
    let lines: Vec<&str> = escaped.split("\r\n").flat_map(|line| line.split(['\n', '\r'])).collect();
    let is_single_line = lines.len() == 1;
    let force_leading_new_line = lines.len() > 1
        && lines[1..].iter().all(|line| line.is_empty() || is_block_white_space(line));
    let has_trailing_triple_quotes = escaped.ends_with("\\\"\"\"");
    let has_trailing_quote = value.ends_with('"') && !has_trailing_triple_quotes;
    let has_trailing_slash = value.ends_with('\\');
    let force_trailing_newline = has_trailing_quote || has_trailing_slash;
    let print_as_multiple_lines = !is_single_line
        || value.encode_utf16().count() > 70
        || force_trailing_newline
        || force_leading_new_line
        || has_trailing_triple_quotes;
    let skip_leading_new_line = is_single_line && value.starts_with([' ', '\t']);
    let mut result = String::new();
    if (print_as_multiple_lines && !skip_leading_new_line) || force_leading_new_line {
        result.push('\n');
    }
    result.push_str(&escaped);
    if print_as_multiple_lines || force_trailing_newline {
        result.push('\n');
    }
    format!("\"\"\"{result}\"\"\"")
}

/// True when the line starts with a space or a tab.
fn is_block_white_space(line: &str) -> bool {
    line.starts_with([' ', '\t'])
}

// ---------------------------------------------------------------------------
// The per-document field walk (§7.1–§7.14)
// ---------------------------------------------------------------------------

/// True when the type reference has a list at its outermost position.
fn has_list(node: &TypeNode) -> bool {
    match node {
        TypeNode::NonNull(inner) => has_list(&inner.type_node),
        TypeNode::List(_) => true,
        TypeNode::Named(_) => false,
    }
}

/// The `mode` a `@paginate` field paginates in: the directive's own value, else
/// `defaultPaginateMode` (`Infinite` unless the project overrides it).
fn paginate_mode_of(directive: &Directive, default_mode: &str) -> String {
    match directive.argument("mode").map(|entry| &entry.value) {
        Some(Value::EnumValue { value, .. }) if value == "Infinite" || value == "SinglePage" => {
            value.clone()
        }
        _ => default_mode.to_string(),
    }
}

/// The named type of a field argument (`Int!` and `Int` both answer `Int`).
fn argument_type_name(
    schema: &SchemaIndex,
    parent: &str,
    field: &str,
    argument: &str,
) -> Option<String> {
    schema
        .argument_type(parent, field, argument)
        .map(|node| node.named_type().name.value.clone())
}

/// Houdini's "applied" test for a page argument: a literal, a variable with a
/// default, or a non-null variable (`validate.go:1247-1253`).
fn page_argument_applied(
    field: &Field,
    name: &str,
    declared: &HashMap<String, DeclaredVariable>,
) -> bool {
    let Some(argument) = field.arguments.iter().find(|argument| argument.name.value == name) else {
        return false;
    };
    match &argument.value {
        Value::Variable(variable) => match declared.get(&variable.name.value) {
            Some(entry) => entry.has_default || entry.type_name.ends_with('!'),
            None => false,
        },
        _ => true,
    }
}

/// The list name a bare `@paginate` could take: the response key with a capital first letter.
fn suggested_list_name(response_key: &str) -> String {
    let mut characters = response_key.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => "Items".to_string(),
    }
}

/// The four argument shapes Houdini rejects (`lists/validate.go:1402-1448`).
///
/// The strategy comes from the **schema's** argument definitions on the field, and
/// the checks run on the **applied** arguments. `SinglePage` exempts the cursor
/// requirements, exactly as Houdini's `paginateMode != "SinglePage"` guards do.
fn validate_pagination_arguments(
    ctx: &DocCtx<'_>,
    field: &Field,
    directive: &Directive,
    parent_type: Option<&str>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let schema = ctx.view.schema();
    let field_name = field.name.value.as_str();
    let Some(parent) = parent_type else {
        return;
    };
    let forward = argument_type_name(schema, parent, field_name, "first").as_deref()
        == Some("Int")
        && schema.argument_type(parent, field_name, "after").is_some();
    let backward = argument_type_name(schema, parent, field_name, "last").as_deref() == Some("Int")
        && schema.argument_type(parent, field_name, "before").is_some();
    let offset = argument_type_name(schema, parent, field_name, "offset").as_deref() == Some("Int")
        && argument_type_name(schema, parent, field_name, "limit").as_deref() == Some("Int");
    let mode = paginate_mode_of(directive, ctx.default_paginate_mode);
    let response_key = field.response_key();
    let document = ctx.document_name.as_str();

    if forward || backward {
        let first = page_argument_applied(field, "first", &ctx.declared_variables);
        let last = page_argument_applied(field, "last", &ctx.declared_variables);
        if !first && !last && mode != "SinglePage" {
            diagnostics.push(
                DiagnosticInput::error(
                    "FLM1034",
                    format!(
                        "Field \"{response_key}\" in document \"{document}\" with cursor-based pagination must have either a \"first\" or a \"last\" argument; add \"first: 10\" (or \"last: 10\"), or use @paginate(mode: SinglePage)."
                    ),
                    ctx.at(directive.loc),
                )
                .build(),
            );
        }
        if first && last && mode != "SinglePage" {
            diagnostics.push(
                DiagnosticInput::error(
                    "FLM1035",
                    format!(
                        "Field \"{response_key}\" in document \"{document}\" with cursor-based pagination cannot have both \"first\" and \"last\" in Infinite mode; keep one of them, or use @paginate(mode: SinglePage)."
                    ),
                    ctx.at(directive.loc),
                )
                .build(),
            );
        }
        return;
    }
    if offset {
        if !page_argument_applied(field, "limit", &ctx.declared_variables) {
            diagnostics.push(
                DiagnosticInput::error(
                    "FLM1036",
                    format!(
                        "Field \"{response_key}\" in document \"{document}\" with offset-based pagination must have a \"limit\" argument; add \"limit: 10\"."
                    ),
                    ctx.at(directive.loc),
                )
                .build(),
            );
        }
        return;
    }
    diagnostics.push(
        DiagnosticInput::error(
            "FLM1037",
            format!(
                "Field \"{response_key}\" in document \"{document}\" does not support a valid pagination mode (cursor-based or offset-based); give {parent}.{field_name} \"first\"/\"after\" or \"offset\"/\"limit\" arguments."
            ),
            ctx.at(directive.loc),
        )
        .build(),
    );
}

/// Walks one selection set, reporting the field and spread rules.
///
/// `in_list` is true once an ancestor field's value type is a list, which is what
/// makes a `@paginate` inside it an error (`lists/validate.go:1369-1379`).
fn walk_selections(
    ctx: &mut DocCtx<'_>,
    selection_set: &SelectionSet,
    parent_type: Option<&str>,
    loading_state: bool,
    in_list: bool,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for selection in &selection_set.selections {
        match selection {
            Selection::Field(field) => {
                walk_field(ctx, field, parent_type, loading_state, in_list, diagnostics)
            }
            Selection::FragmentSpread(spread) => {
                walk_spread(ctx, spread, parent_type, in_list, diagnostics)
            }
            Selection::InlineFragment(inline) => {
                walk_inline(ctx, inline, parent_type, loading_state, in_list, diagnostics)
            }
        }
    }
}

/// One field node of the walk.
fn walk_field(
    ctx: &mut DocCtx<'_>,
    field: &Field,
    parent_type: Option<&str>,
    loading_state: bool,
    in_list: bool,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let view = ctx.view;
    let response_key = field.response_key().to_string();
    let field_type = parent_type.and_then(|parent| view.field_type(parent, &field.name.value));
    let named = field_type.as_ref().map(|node| node.named_type().name.value.clone());

    // FLM1021: an alias that renames a different field to a key field name.
    if let (Some(parent), Some(alias)) = (parent_type, field.alias.as_ref()) {
        if alias.value != field.name.value
            && view.key_fields_for_type(parent).iter().any(|key| *key == alias.value)
        {
            diagnostics.push(DiagnosticInput::error(
                "FLM1021",
                format!(
                    "\"{}\" is aliased to \"{}\", which is a key field of \"{parent}\"; the cache would compute record ids from the alias. Select the real key field or rename the alias.",
                    field.name.value, alias.value
                ),
                ctx.at(field.loc),
            ).build());
        }
    }

    for directive in &field.directives {
        let name = directive.name.value.as_str();
        if RESERVED_DIRECTIVES.contains(&name) {
            diagnostics.push(DiagnosticInput::error(
                "FLM1008",
                format!(
                    "Directive \"@{name}\" is not supported by flamme {}.x; it is reserved.",
                    compiler_version_major()
                ),
                ctx.at(directive.loc),
            ).build());
            continue;
        }
        if !SUPPORTED_DIRECTIVES.contains(&name) && !PASS_THROUGH_DIRECTIVES.contains(&name) {
            continue; // unknown directives are FLM1007 through graphql.validate
        }
        if name == "listTarget" {
            diagnostics.push(DiagnosticInput::error(
                "FLM1008",
                LIST_TARGET_LOCATION_MESSAGE,
                ctx.at(directive.loc),
            ).build());
            continue;
        }
        if name == "allLists" {
            diagnostics.push(DiagnosticInput::error(
                "FLM1041",
                ALL_LISTS_LOCATION_MESSAGE,
                ctx.at(directive.loc),
            ).build());
            continue;
        }
        if name == "listID" {
            diagnostics.push(DiagnosticInput::error(
                "FLM1045",
                LIST_ID_LOCATION_MESSAGE,
                ctx.at(directive.loc),
            ).build());
            continue;
        }
        // §4: `@when`/`@when_not` filter a list operation spread; on a field they
        // have nothing to filter, and the boolean gate they used to spell is
        // `@include`/`@skip`.
        if name == "when" || name == "when_not" {
            if find_argument(directive, "argument").is_some() {
                diagnostics.push(old_when_diagnostic(directive, ctx));
            } else {
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM1040",
                        format!(
                            "Directive \"@{name}\" is only supported on a list operation spread (\"...<List>_insert\", \"...<List>_remove\", \"...<List>_toggle\", \"...<List>_upsert\"); it filters which @list instances the operation applies to."
                        ),
                        ctx.at(directive.loc),
                    )
                    .with_hint(
                        "use @include(if: $x) / @skip(if: $x) to gate a field on a boolean variable",
                    )
                    .build(),
                );
            }
            continue;
        }
        // §5: `@includeListID` puts an opaque `__id` on the list value, so the field
        // has to declare a list (`@list` or `@paginate(name:)`) to expose.
        if name == "includeListID" {
            if find_directive(&field.directives, "list").is_none()
                && find_directive(&field.directives, "paginate").is_none()
            {
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM1043",
                        format!(
                            "@includeListID can only be used on fields that also have @list or @paginate in document \"{}\".",
                            ctx.document_name
                        ),
                        ctx.at(directive.loc),
                    )
                    .with_hint("add @list(name: \"...\") or @paginate(name: \"...\") to the field")
                    .build(),
                );
            }
            continue;
        }
        if name == "required"
            && field_type.as_ref().is_some_and(|node| matches!(node, TypeNode::NonNull(_)))
        {
            diagnostics.push(
                DiagnosticInput::warning(
                    "FLM1011",
                    format!(
                        "@required has no effect on \"{response_key}\": {}.{} is already non-null.",
                        parent_type.unwrap_or("?"),
                        field.name.value
                    ),
                    ctx.at(directive.loc),
                )
                .with_hint("remove @required")
                .build(),
            );
        }
        if name == "paginate" {
            // §8: "Paginated fields cannot be inside of lists" (`lists/validate.go:1369-1379`).
            if in_list {
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM1046",
                        PAGINATED_IN_LIST_MESSAGE.to_string(),
                        ctx.at(directive.loc),
                    )
                    .with_hint(format!(
                        "move \"{response_key}\" out of the list field, or select it in a fragment the list does not spread"
                    ))
                    .build(),
                );
            }
            ctx.paginated += 1;
            if ctx.paginated == 1 {
                ctx.first_paginated = Some(response_key.clone());
            } else {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1009",
                    format!(
                        "Document \"{}\" paginates two fields (\"{}\", \"{response_key}\"); only one paginated field per document is supported.",
                        ctx.document_name,
                        ctx.first_paginated.clone().unwrap_or_default()
                    ),
                    ctx.at(directive.loc),
                ).build());
            }
        }
        if name == "loading" {
            let count = directive_int_argument(Some(directive), "count");
            let has_count = directive_has_argument(Some(directive), "count");
            if has_count && count.is_none() {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1011",
                    format!("{}: @loading(count:) requires an integer literal.", ctx.document.relative_path),
                    ctx.at(directive.loc),
                ).build());
            }
            if has_count && field_type.as_ref().is_some_and(|node| !has_list(node)) {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1013",
                    format!(
                        "@loading(count: {}) requires a list field; \"{response_key}\" is {}.{}.",
                        count.unwrap_or(0),
                        parent_type.unwrap_or("?"),
                        field.name.value
                    ),
                    ctx.at(directive.loc),
                ).build());
            }
        }
        if name == "stream" {
            if ctx.document.kind == ArtifactKind::Fragment {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1008",
                    "Directive \"@stream\" is not supported inside a fragment definition; a fragment has no request of its own, so the stream cannot be delivered. Put the field and its @stream in the operation.",
                    ctx.at(directive.loc),
                ).build());
            }
            let initial_count = directive_int_argument(Some(directive), "initialCount");
            if directive_has_argument(Some(directive), "initialCount")
                && (initial_count.is_none() || initial_count.is_some_and(|value| value < 0))
            {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1026",
                    format!(
                        "@stream(initialCount:) requires a non-negative integer literal; \"{response_key}\" has {}.",
                        match initial_count {
                            Some(value) => value.to_string(),
                            None => "a non-literal value".to_string(),
                        }
                    ),
                    ctx.at(directive.loc),
                ).build());
            }
            if let Some(field_type) = &field_type {
                if !has_list(field_type) {
                    diagnostics.push(
                        DiagnosticInput::error(
                            "FLM1026",
                            format!(
                                "@stream is only supported on list fields; \"{response_key}\" is {}.{}, whose type is {}.",
                                parent_type.unwrap_or("?"),
                                field.name.value,
                                type_ref_string(field_type)
                            ),
                            ctx.at(directive.loc),
                        )
                        .with_hint(
                            "wrap the field in an inline fragment with @defer instead, or remove @stream",
                        )
                        .build(),
                    );
                }
            }
            check_defer_label(directive, ctx.document, diagnostics, &mut ctx.defer_labels);
        }
        if name == "list" && field_type.is_some() {
            let field_type = field_type.clone().expect("checked");
            let named = field_type.named_type().name.value.clone();
            let element = list_element_type(view.schema(), &type_ref_string(&field_type))
                .unwrap_or_else(|| (named.clone(), false));
            let is_list = element.1 || has_list(&field_type);
            if !is_list {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1007",
                    format!(
                        "@list is only supported on list and connection fields; \"{response_key}\" is {named}."
                    ),
                    ctx.at(directive.loc),
                ).build());
            }
        }
        if name == "paginate" && field_type.is_some() {
            let field_type = field_type.clone().expect("checked");
            let named = field_type.named_type().name.value.clone();
            let connection = view.schema().field_type(&named, "edges").is_some();
            // §7.10: `@paginate(name:)` already enrols the field in the list system, so `@list`
            // on the same field is redundant. Houdini's own wording, and the same rule.
            if find_directive(&field.directives, "list").is_some() {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1033",
                    "@list is unnecessary on a field annotated with @paginate, simply use the 'name' parameter on @paginate instead",
                    ctx.at(directive.loc),
                ).build());
            } else if directive_string_argument(Some(directive), "name").is_none() {
                // Houdini declares `name: String!` but never enforces it, and a bare `@paginate`
                // pages perfectly well; the name is only needed to target the connection from a
                // mutation. Flamme keeps the document legal and names the missing piece.
                diagnostics.push(
                    DiagnosticInput::warning(
                        "FLM1032",
                        format!(
                            "@paginate on \"{response_key}\" has no \"name\"; without one a mutation cannot insert into it.",
                        ),
                        ctx.at(directive.loc),
                    )
                    .with_hint(format!(
                        "add name: \"{}\" to @paginate and spread ...{}_insert in the mutation",
                        suggested_list_name(&response_key),
                        suggested_list_name(&response_key)
                    ))
                    .build(),
                );
            }
            if !connection && !has_list(&field_type) {
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM1007",
                        format!(
                            "@paginate requires a connection field; \"{response_key}\" is {named} and has no \"pageInfo\" field."
                        ),
                        ctx.at(directive.loc),
                    )
                    .with_hint("select a field whose type has edges/pageInfo, or remove @paginate")
                    .build(),
                );
            } else {
                validate_pagination_arguments(ctx, field, directive, parent_type, diagnostics);
            }
            if matches!(ctx.definition, Definition::Operation(_)) {
                let plan = if connection {
                    cursor_argument_plan(field)
                } else {
                    offset_argument_plan(field)
                };
                let kind = if connection { "cursor" } else { "offset" };
                for binding in plan.bindings {
                    let Some(declared) = ctx.declared_variables.get(&binding.name) else {
                        continue;
                    };
                    if cursor_type_compatible(&declared.type_name, &binding.type_name) {
                        continue;
                    }
                    let declared_type = declared.type_name.clone();
                    let declared_loc = declared.loc;
                    diagnostics.push(DiagnosticInput::error(
                        "FLM1024",
                        format!(
                            "Cannot bind the {kind} variable \"${}\": the document declares it as {declared_type}, but @paginate sends {} for \"{}\". Rename the variable or remove @paginate.",
                            binding.name, binding.type_name, binding.name
                        ),
                        ctx.at(declared_loc),
                    ).build());
                }
            }
        }
    }

    let loading_directive = find_directive(&field.directives, "loading");
    let cascade = loading_state
        || loading_directive.is_some()
        || directive_boolean_argument(loading_directive, "cascade") == Some(true);

    if let (Some(selection), Some(named)) = (&field.selection_set, named) {
        if !view.is_leaf(&named) {
            validate_key_availability(ctx, field, &named, diagnostics);
        }
        // a list-typed field constrains everything under it: a `@paginate` there has
        // no single connection to page
        let child_in_list = in_list || field_type.as_ref().is_some_and(has_list);
        walk_selections(ctx, selection, Some(&named), cascade, child_in_list, diagnostics);
    }
}

/// One fragment spread node of the walk.
fn walk_spread(
    ctx: &mut DocCtx<'_>,
    spread: &FragmentSpread,
    parent_type: Option<&str>,
    in_list: bool,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let view = ctx.view;
    let name = spread.name.value.clone();
    let reserved = list_fragment_action(&name);
    let mask_enable = find_directive(&spread.directives, "mask_enable");
    let mask_disable = find_directive(&spread.directives, "mask_disable");
    if mask_enable.is_some() && mask_disable.is_some() {
        diagnostics.push(DiagnosticInput::error(
            "FLM1014",
            format!("Conflicting mask directives on the spread of \"{name}\"."),
            ctx.at(spread.loc),
        ).build());
    }
    for directive in &spread.directives {
        if directive.name.value == "optimisticKey" {
            diagnostics.push(DiagnosticInput::error(
                "FLM1008",
                OPTIMISTIC_KEY_LOCATION_MESSAGE,
                ctx.at(directive.loc),
            ).build());
        }
        if RESERVED_DIRECTIVES.contains(&directive.name.value.as_str()) {
            diagnostics.push(DiagnosticInput::error(
                "FLM1008",
                format!(
                    "Directive \"@{}\" is not supported by flamme {}.x; it is reserved.",
                    directive.name.value,
                    compiler_version_major()
                ),
                ctx.at(directive.loc),
            ).build());
        }
        if directive.name.value == "defer" {
            check_defer_supported(ctx.document, directive, diagnostics);
            check_defer_label(directive, ctx.document, diagnostics, &mut ctx.defer_labels);
        }
    }
    if reserved.is_none() {
        if let Some(misplaced) = find_directive(&spread.directives, "listTarget") {
            diagnostics.push(DiagnosticInput::error(
                "FLM1008",
                LIST_TARGET_LOCATION_MESSAGE,
                ctx.at(misplaced.loc),
            ).build());
        }
        for misplaced in &spread.directives {
            let name = misplaced.name.value.as_str();
            if name == "allLists" {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1041",
                    ALL_LISTS_LOCATION_MESSAGE,
                    ctx.at(misplaced.loc),
                ).build());
            }
            if name == "listID" {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1045",
                    LIST_ID_LOCATION_MESSAGE,
                    ctx.at(misplaced.loc),
                ).build());
            }
        }
        // §4: `@when`/`@when_not` are list filters, so a spread that is not a list
        // operation has nothing to filter. The old boolean-variable gate is diagnosed
        // by its `argument:` shape, wherever it appears.
        for directive in &spread.directives {
            let directive_name = directive.name.value.as_str();
            if directive_name != "when" && directive_name != "when_not" {
                continue;
            }
            if find_argument(directive, "argument").is_some() {
                diagnostics.push(old_when_diagnostic(directive, ctx));
                continue;
            }
            diagnostics.push(
                DiagnosticInput::error(
                    "FLM1040",
                    format!(
                        "Directive \"@{directive_name}\" is only supported on a list operation spread (\"...<List>_insert\", \"...<List>_remove\", \"...<List>_toggle\", \"...<List>_upsert\"); it filters which @list instances the operation applies to."
                    ),
                    ctx.at(directive.loc),
                )
                .with_hint(
                    "use @include(if: $x) / @skip(if: $x) to gate a spread on a boolean variable",
                )
                .build(),
            );
        }
    }
    if let Some((list_name, action)) = reserved {
        // §7.10: `@listTarget(name:)` pins the operation to a list some document declares.
        if let Some(list_target) = find_directive(&spread.directives, "listTarget") {
            match directive_string_argument(Some(list_target), "name") {
                None => diagnostics.push(DiagnosticInput::error(
                    "FLM1011",
                    format!(
                        "@listTarget requires a string literal naming a list: @listTarget(name: \"{action}\")."
                    ),
                    ctx.at(list_target.loc),
                ).build()),
                Some(target) => {
                    if !ctx.index.lists.contains_key(&target) {
                        diagnostics.push(DiagnosticInput::error(
                            "FLM1016",
                            format!(
                                "@listTarget(name: \"{target}\") names a list that no document declares; no @list(name: \"{target}\") exists."
                            ),
                            ctx.at(list_target.loc),
                        ).build());
                    }
                }
            }
        }
        // §4: `@allLists` selects every cached instance, so naming one instance beside
        // it is contradictory (Houdini's `@parentID cannot appear alongside @allLists`,
        // `lists/validate.go:115-163`).
        if find_directive(&spread.directives, "allLists").is_some()
            && find_directive(&spread.directives, "listTarget").is_some()
        {
            diagnostics.push(DiagnosticInput::error(
                "FLM1042",
                format!(
                    "\"@listTarget\" cannot appear alongside \"@allLists\" in document \"{}\"; @allLists already selects every instance of the list.",
                    ctx.document_name
                ),
                ctx.at(spread.loc),
            ).build());
        }
        // §5: `@listID(value:)` carries the opaque list id the runtime resolves back
        // to one instance, so it has to have a value.
        if let Some(list_id) = find_directive(&spread.directives, "listID") {
            if find_argument(list_id, "value").is_none() {
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM1044",
                        "@listID requires a value: a variable or a string literal naming the opaque list id (the \"__id\" an @includeListID field exposes on its value), as in @listID(value: $listId)."
                            .to_string(),
                        ctx.at(list_id.loc),
                    )
                    .with_hint("read the id from an @includeListID field and pass it as a variable")
                    .build(),
                );
            }
        }
        for directive in &spread.directives {
            let directive_name = directive.name.value.as_str();
            if directive_name == "required" {
                diagnostics.push(DiagnosticInput::error(
                    "FLM1008",
                    format!(
                        "Directive \"@{}\" is not supported on a list operation spread (\"...{name}\"); conditional list operations are reserved and the spread's fields are not selected.",
                        directive.name.value
                    ),
                    ctx.at(directive.loc),
                ).build());
            }
            // §4: the two polarities are complementary (`must` and `must_not`), so both
            // may appear on one spread; an empty one is a diagnostic, and the old
            // `argument:` gate points at the standard directives.
            if directive_name != "when" && directive_name != "when_not" {
                continue;
            }
            if find_argument(directive, "argument").is_some() {
                diagnostics.push(old_when_diagnostic(directive, ctx));
                continue;
            }
            if directive.arguments.is_empty() {
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM1038",
                        format!(
                            "@{directive_name}() requires at least one filter entry, as in {directive_name}(status: \"active\"); an empty filter matches every list, which is written by omitting the directive."
                        ),
                        ctx.at(directive.loc),
                    )
                    .with_hint(format!(
                        "write the key/value pair the @list field declares, or drop @{directive_name}"
                    ))
                    .build(),
                );
            }
        }
        if !ctx.index.lists.contains_key(&list_name) {
            diagnostics.push(DiagnosticInput::error(
                "FLM1016",
                format!("Unknown list fragment \"{name}\"; no @list(name: \"{list_name}\") exists."),
                ctx.at(spread.loc),
            ).build());
        }
        return;
    }
    // §8: a paginated field a fragment owns cannot be spread inside a list either:
    // the page request needs one connection per owner record, and a list element is
    // not addressable that way (`lists/validate.go:542-555, 1369-1379`).
    if in_list && fragment_paginates(ctx, &name, &mut Vec::new()) {
        diagnostics.push(
            DiagnosticInput::error(
                "FLM1046",
                format!(
                    "{} Fragment \"{name}\" is spread inside a list field, so its paginated field has no single owner record to page.",
                    PAGINATED_IN_LIST_MESSAGE
                ),
                ctx.at(spread.loc),
            )
            .with_hint(format!(
                "move the spread of \"{name}\" out of the list field, or remove @paginate from the fragment"
            ))
            .build(),
        );
    }
    if !ctx.index.fragments.contains_key(&name) {
        let where_ = ctx.at(spread.loc);
        diagnostics.push(DiagnosticInput::error(
            "FLM1001",
            format!(
                "Unknown fragment \"{name}\" spread by \"{}\" at {}:{}:{}.",
                ctx.document_name, ctx.document.relative_path, where_.line, where_.column
            ),
            where_,
        ).build());
    } else if let Some(parent) = parent_type {
        if unaddressable_type(view, parent) {
            diagnostics.push(
                DiagnosticInput::warning(
                    "FLM1023",
                    format!(
                        "Fragment \"{name}\" is spread on \"{parent}\", which has no key fields; fragment data on an embedded type is not addressable, so its fields are inlined into the parent's read instead and no \" $fragments\" reference is generated for it."
                    ),
                    ctx.at(spread.loc),
                )
                .with_hint(format!(
                    "give \"{parent}\" a key field (schema @key or types: {{ {parent}: {{ keys: [\"id\"] }} }}) to make the fragment addressable, or keep selecting its fields in the parent"
                ))
                .build(),
            );
        }
    }
}

/// One inline fragment node of the walk.
fn walk_inline(
    ctx: &mut DocCtx<'_>,
    inline: &InlineFragment,
    parent_type: Option<&str>,
    loading_state: bool,
    in_list: bool,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for directive in &inline.directives {
        if directive.name.value == "defer" {
            check_defer_supported(ctx.document, directive, diagnostics);
            check_defer_label(directive, ctx.document, diagnostics, &mut ctx.defer_labels);
        }
        if directive.name.value == "optimisticKey" || directive.name.value == "listTarget" {
            diagnostics.push(DiagnosticInput::error(
                "FLM1008",
                if directive.name.value == "optimisticKey" {
                    OPTIMISTIC_KEY_LOCATION_MESSAGE
                } else {
                    LIST_TARGET_LOCATION_MESSAGE
                },
                ctx.at(directive.loc),
            ).build());
        }
        if directive.name.value == "when" || directive.name.value == "when_not" {
            if find_argument(directive, "argument").is_some() {
                diagnostics.push(old_when_diagnostic(directive, ctx));
            } else {
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM1040",
                        format!(
                            "Directive \"@{}\" is only supported on a list operation spread (\"...<List>_insert\", \"...<List>_remove\", \"...<List>_toggle\", \"...<List>_upsert\"); it filters which @list instances the operation applies to.",
                            directive.name.value
                        ),
                        ctx.at(directive.loc),
                    )
                    .with_hint(
                        "use @include(if: $x) / @skip(if: $x) to gate an inline fragment on a boolean variable",
                    )
                    .build(),
                );
            }
        }
        if directive.name.value == "allLists" {
            diagnostics.push(DiagnosticInput::error(
                "FLM1041",
                ALL_LISTS_LOCATION_MESSAGE,
                ctx.at(directive.loc),
            ).build());
        }
        if directive.name.value == "listID" {
            diagnostics.push(DiagnosticInput::error(
                "FLM1045",
                LIST_ID_LOCATION_MESSAGE,
                ctx.at(directive.loc),
            ).build());
        }
    }
    let condition = inline
        .type_condition
        .as_ref()
        .map(|condition| condition.name.value.clone());
    let condition_type = match condition {
        Some(condition) => ctx.view.named_type_name(&condition),
        None => parent_type.map(str::to_string),
    };
    let next = condition_type.or_else(|| parent_type.map(str::to_string));
    walk_selections(
        ctx,
        &inline.selection_set,
        next.as_deref(),
        loading_state,
        in_list,
        diagnostics,
    );
}

// ---------------------------------------------------------------------------
// The document the reference validator sees
// ---------------------------------------------------------------------------

/// One definition of the validation document, with the document it came from.
struct ValidationDefinition<'a> {
    /// The definition node.
    node: &'a Definition,
    /// Index of the document the node was parsed from.
    source: usize,
}

/// The document `graphql.validate` runs over: the document plus its fragments.
struct ValidationDocument<'a> {
    /// The definitions, in the order the oracle builds them.
    definitions: Vec<ValidationDefinition<'a>>,
    /// Index of the document being validated in the project's document list; the
    /// fragment nodes carry their own, so an error's location can be resolved
    /// against the source it was parsed from.
    base_source: usize,
}

impl<'a> ValidationDocument<'a> {
    /// The fragment definitions of the document, keyed by name.
    fn fragments(&self) -> HashMap<String, (&'a FragmentNode, usize)> {
        let mut fragments = HashMap::new();
        for definition in &self.definitions {
            if let Definition::Fragment(node) = definition.node {
                fragments.insert(node.name.value.clone(), (node, definition.source));
            }
        }
        fragments
    }
}

/// The document's own definition plus every fragment it transitively spreads.
fn document_with_fragments<'a>(
    document: &'a RawDocument,
    documents: &'a [RawDocument],
    index: &'a DocumentIndex,
) -> ValidationDocument<'a> {
    let base_source = documents
        .iter()
        .position(|entry| std::ptr::eq(entry, document))
        .unwrap_or(0);
    let Some(definition) = document.ast.definitions.first() else {
        return ValidationDocument { definitions: Vec::new(), base_source };
    };
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    fn walk(
        name: &str,
        index: &DocumentIndex,
        names: &mut Vec<String>,
        seen: &mut HashSet<String>,
    ) {
        if !seen.insert(name.to_string()) {
            return;
        }
        names.push(name.to_string());
        if let Some(spreads) = index.spread_graph.get(name) {
            for spread in spreads {
                walk(spread, index, names, seen);
            }
        }
    }
    for spread in definition_spread_names(definition) {
        walk(&spread, index, &mut names, &mut seen);
    }
    // A fragment that takes part in a cycle reaches itself through its spreads.
    if let Definition::Fragment(node) = definition {
        names.retain(|name| name != &node.name.value);
        seen.remove(&node.name.value);
    }
    names.sort();
    let mut definitions = vec![ValidationDefinition { node: definition, source: base_source }];
    let source_of = |name: &str| -> Option<usize> {
        index.fragments.get(name).map(|fragment| fragment.document)
    };
    for name in names {
        let Some(fragment) = index.fragments.get(&name) else {
            continue;
        };
        let Some(fragment_document) = documents.get(fragment.document) else {
            continue;
        };
        let Some(node) = fragment_document.ast.definitions.get(fragment.definition) else {
            continue;
        };
        definitions.push(ValidationDefinition {
            node,
            source: source_of(&name).unwrap_or(0),
        });
    }
    ValidationDocument { definitions, base_source }
}

/// Every variable named by a `@when`/`@when_not` in the validation document.
fn collect_conditional_variables(document: &ValidationDocument<'_>) -> HashSet<String> {
    fn directives_of(selection_set: &SelectionSet, found: &mut HashSet<String>) {
        for selection in &selection_set.selections {
            let directives = match selection {
                Selection::Field(field) => {
                    if let Some(set) = &field.selection_set {
                        directives_of(set, found);
                    }
                    &field.directives
                }
                Selection::FragmentSpread(spread) => &spread.directives,
                Selection::InlineFragment(inline) => {
                    directives_of(&inline.selection_set, found);
                    &inline.directives
                }
            };
            for directive in directives {
                if directive.name.value != "when" && directive.name.value != "when_not" {
                    continue;
                }
                if let Some(variable) = directive_string_argument(Some(directive), "argument") {
                    found.insert(variable);
                }
            }
        }
    }
    let mut found = HashSet::new();
    for definition in &document.definitions {
        for directive in definition_directives(definition.node) {
            if directive.name.value != "when" && directive.name.value != "when_not" {
                continue;
            }
            if let Some(variable) = directive_string_argument(Some(directive), "argument") {
                found.insert(variable);
            }
        }
        directives_of(definition_selection_set(definition.node), &mut found);
    }
    found
}

/// The `$name` of a "Variable "$x" is never used in operation" message.
fn never_used_variable(message: &str) -> Option<String> {
    let rest = message.strip_prefix("Variable \"$")?;
    let at = rest.find('"')?;
    let name = &rest[..at];
    if name.is_empty()
        || !name.chars().all(|char| char.is_ascii_alphanumeric() || char == '_')
    {
        return None;
    }
    if !rest[at..].starts_with("\" is never used in operation") {
        return None;
    }
    Some(name.to_string())
}

/// FLM1031: the deprecations `NoDeprecatedCustomRule` found in **this** file.
fn report_deprecations(
    document: &RawDocument,
    documents: &[RawDocument],
    definition: &Definition,
    base_source: usize,
    errors: &[GqlError],
    diagnostics: &mut Vec<Diagnostic>,
) {
    let own_source = definition.loc().is_some();
    for error in errors {
        if own_source
            && error
                .first_node_source
                .is_some_and(|source| source != base_source)
        {
            continue; // declared in another document, which reports it at its own location
        }
        let location = match error.site {
            Some(site) => {
                let source = documents.get(site.source).unwrap_or(document);
                let (line, column) = line_column_of(source, site.offset);
                location_at(
                    &document.source,
                    &document.relative_path,
                    local_offset(document, line, column),
                    1,
                )
            }
            None => document_location(document, definition.loc()),
        };
        diagnostics.push(DiagnosticInput::warning(
            "FLM1031",
            error.message.clone(),
            location,
        ).build());
    }
}

/// The definition's directives.
///
/// A type system definition carries directives too; the extraction rejects such a
/// document before the reference validator runs, and the empty slice keeps the
/// function total.
fn definition_directives(definition: &Definition) -> &[Directive] {
    match definition {
        Definition::Operation(node) => &node.directives,
        Definition::Fragment(node) => &node.directives,
        Definition::TypeSystem(_) => &[],
    }
}

/// The definition's selection set.
fn definition_selection_set(definition: &Definition) -> &SelectionSet {
    static EMPTY: SelectionSet = SelectionSet { selections: Vec::new(), loc: None };
    match definition {
        Definition::Operation(node) => &node.selection_set,
        Definition::Fragment(node) => &node.selection_set,
        Definition::TypeSystem(_) => &EMPTY,
    }
}

// ---------------------------------------------------------------------------
// The reference validator (`graphql.validate`)
// ---------------------------------------------------------------------------

/// One error the reference validator reported.
#[derive(Clone, Debug)]
struct GqlError {
    /// `error.message`, verbatim.
    message: String,
    /// `error.nodes[0]`'s source, when that node carries a location.
    first_node_source: Option<usize>,
    /// `error.locations[0]`: the first node that carries a location.
    site: Option<NodeSite>,
}

/// One node location: the document it was parsed from and its offset.
#[derive(Clone, Copy, Debug)]
struct NodeSite {
    /// Index of the document the node was parsed from.
    source: usize,
    /// The node's start offset in that document's raw text.
    offset: Offset,
}

/// Which pass is walking the document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pass {
    /// `specifiedRules` (minus the two the compiler owns).
    Rules,
    /// `NoDeprecatedCustomRule`.
    Deprecations,
}

/// The rules whose own subtree traversal a node's handler pruned.
#[derive(Clone, Copy, Debug, Default)]
struct Prune {
    /// `ValuesOfCorrectType` bailed at a list or object literal.
    values: bool,
    /// `KnownArgumentNames` bailed inside a directive.
    known_args: bool,
    /// `MaxIntrospectionDepth` reported for an introspection field.
    max_depth: bool,
}

/// The shape of one AST node, for the `TypeInfo` state machine.
enum TiNode<'n> {
    SelectionSet,
    Field(&'n Field),
    Directive(&'n Directive),
    Operation(&'n OperationDefinition),
    InlineFragment(&'n InlineFragment),
    Fragment(&'n FragmentNode),
    VariableDefinition(&'n VariableDefinition),
    Argument(&'n crate::graphql::ast::Argument),
    ListValue,
    ObjectField(&'n ObjectField),
    Enum(&'n str),
    /// A node `TypeInfo` does not track.
    Other,
}

/// The kind of node a `leave` event carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TiKind {
    SelectionSet,
    Field,
    Directive,
    Operation,
    InlineFragment,
    Fragment,
    VariableDefinition,
    Argument,
    ListValue,
    ObjectField,
    Enum,
    /// A node kind `TypeInfo` does not track.
    Other,
}

/// The state graphql-js's `TypeInfo` keeps while walking a document.
#[derive(Default)]
struct TypeState {
    type_stack: Vec<Option<TypeNode>>,
    parent_type_stack: Vec<Option<String>>,
    input_type_stack: Vec<Option<TypeNode>>,
    field_def_stack: Vec<Option<FieldDef>>,
    default_value_stack: Vec<Option<Value>>,
    directive: Option<DirectiveDef>,
    argument: Option<ArgDef>,
    enum_value: Option<String>,
}

impl TypeState {
    /// The current output type.
    fn get_type(&self) -> Option<TypeNode> {
        self.type_stack.last().cloned().flatten()
    }

    /// The current parent composite type.
    fn parent_type(&self) -> Option<String> {
        self.parent_type_stack.last().cloned().flatten()
    }

    /// The current input type.
    fn input_type(&self) -> Option<TypeNode> {
        self.input_type_stack.last().cloned().flatten()
    }

    /// The input type outside the current one.
    fn parent_input_type(&self) -> Option<TypeNode> {
        if self.input_type_stack.len() < 2 {
            return None;
        }
        self.input_type_stack[self.input_type_stack.len() - 2].clone()
    }

    /// The current field definition.
    fn field_def(&self) -> Option<FieldDef> {
        self.field_def_stack.last().cloned().flatten()
    }

    /// The current default value.
    fn default_value(&self) -> Option<Value> {
        self.default_value_stack.last().cloned().flatten()
    }

    /// The `TypeInfo.enter` transition for one node.
    fn enter(&mut self, view: &SchemaView<'_>, node: TiNode<'_>) {
        match node {
            TiNode::SelectionSet => {
                let named = self.get_type().map(|node| node.named_type().name.value.clone());
                let parent = named.filter(|name| view.is_composite(name));
                self.parent_type_stack.push(parent);
            }
            TiNode::Field(field) => {
                let parent = self.parent_type();
                let field_def = parent.and_then(|parent| view.field_info(&parent, &field.name.value));
                let type_node = field_def.as_ref().map(|entry| entry.type_node.clone());
                self.field_def_stack.push(field_def);
                self.type_stack.push(
                    type_node.filter(|node| view.is_output_type(node)),
                );
            }
            TiNode::Directive(directive) => {
                self.directive = view.directives.get(&directive.name.value).cloned();
            }
            TiNode::Operation(operation) => {
                let root = view.root_type(operation.operation);
                let is_object = root
                    .as_deref()
                    .is_some_and(|name| view.kind(name) == Some(SchemaTypeKind::Object));
                self.type_stack.push(if is_object {
                    Some(named_node(root.as_deref().expect("checked")))
                } else {
                    None
                });
            }
            TiNode::InlineFragment(inline) => {
                let output = match &inline.type_condition {
                    Some(condition) => type_from_ast(view, &TypeNode::Named(condition.clone())),
                    None => self.get_type().map(|node| named_node(&node.named_type().name.value)),
                };
                self.type_stack.push(output.filter(|node| view.is_output_type(node)));
            }
            TiNode::Fragment(fragment) => {
                let output =
                    type_from_ast(view, &TypeNode::Named(fragment.type_condition.clone()));
                self.type_stack.push(output.filter(|node| view.is_output_type(node)));
            }
            TiNode::VariableDefinition(variable) => {
                let input = type_from_ast(view, &variable.type_node);
                self.input_type_stack.push(input.filter(|node| view.is_input_type(node)));
            }
            TiNode::Argument(argument) => {
                let args = match self.directive.clone() {
                    Some(directive) => directive.args,
                    None => self.field_def().map(|field| field.args).unwrap_or_default(),
                };
                let arg_def =
                    args.into_iter().find(|arg| arg.name == argument.name.value);
                let arg_type = arg_def.as_ref().map(|entry| entry.type_node.clone());
                self.default_value_stack.push(arg_def.as_ref().and_then(|entry| entry.default_value.clone()));
                self.argument = arg_def;
                self.input_type_stack.push(arg_type.filter(|node| view.is_input_type(node)));
            }
            TiNode::ListValue => {
                let list_type = self.input_type().map(nullable_type);
                let item = match list_type {
                    Some(TypeNode::List(list)) => Some(list.type_node.as_ref().clone()),
                    other => other,
                };
                self.default_value_stack.push(None);
                self.input_type_stack.push(item.filter(|node| view.is_input_type(node)));
            }
            TiNode::ObjectField(field) => {
                let object = self.input_type().map(|node| node.named_type().name.value.clone());
                let input_field = object
                    .as_deref()
                    .filter(|name| view.is_input_object(name))
                    .and_then(|name| view.input_field_def(name, &field.name.value).cloned());
                let field_type = input_field.as_ref().map(|entry| entry.type_node.clone());
                self.default_value_stack.push(input_field.as_ref().and_then(|entry| entry.default_value.clone()));
                self.input_type_stack.push(field_type.filter(|node| view.is_input_type(node)));
            }
            TiNode::Enum(name) => {
                let enum_type = self.input_type().map(|node| node.named_type().name.value.clone());
                self.enum_value = match enum_type {
                    Some(enum_type) if view.kind(&enum_type) == Some(SchemaTypeKind::Enum) => {
                        Some(name.to_string())
                    }
                    _ => None,
                };
            }
            TiNode::Other => {}
        }
    }

    /// The `TypeInfo.leave` transition for one node kind.
    fn leave(&mut self, kind: TiKind) {
        match kind {
            TiKind::SelectionSet => {
                self.parent_type_stack.pop();
            }
            TiKind::Field => {
                self.field_def_stack.pop();
                self.type_stack.pop();
            }
            TiKind::Directive => {
                self.directive = None;
            }
            TiKind::Operation | TiKind::InlineFragment | TiKind::Fragment => {
                self.type_stack.pop();
            }
            TiKind::VariableDefinition => {
                self.input_type_stack.pop();
            }
            TiKind::Argument => {
                self.argument = None;
                self.default_value_stack.pop();
                self.input_type_stack.pop();
            }
            TiKind::ListValue | TiKind::ObjectField => {
                self.default_value_stack.pop();
                self.input_type_stack.pop();
            }
            TiKind::Enum => {
                self.enum_value = None;
            }
            TiKind::Other => {}
        }
    }
}

/// A synthesized named type node.
fn named_node(name: &str) -> TypeNode {
    TypeNode::Named(NamedType {
        name: crate::graphql::ast::Name::synthetic(name),
        loc: None,
    })
}

/// The nullable form of a type reference.
fn nullable_type(node: TypeNode) -> TypeNode {
    match node {
        TypeNode::NonNull(inner) => inner.type_node.as_ref().clone(),
        other => other,
    }
}

/// `typeFromAST`: builds the schema type of a type reference, or `None`.
fn type_from_ast(view: &SchemaView<'_>, node: &TypeNode) -> Option<TypeNode> {
    match node {
        TypeNode::Named(named) => view
            .named_type_name(&named.name.value)
            .map(|name| named_node(&name)),
        TypeNode::List(list) => {
            type_from_ast(view, &list.type_node).map(|inner| {
                TypeNode::List(crate::graphql::ast::ListType {
                    type_node: Box::new(inner),
                    loc: None,
                })
            })
        }
        TypeNode::NonNull(inner) => {
            type_from_ast(view, &inner.type_node).map(|inner| {
                TypeNode::NonNull(crate::graphql::ast::NonNullType {
                    type_node: Box::new(inner),
                    loc: None,
                })
            })
        }
    }
}

/// The location a directive sits in.
#[derive(Clone, Copy, Debug)]
enum DirectiveParent {
    Query,
    Mutation,
    Subscription,
    Field,
    FragmentSpread,
    InlineFragment,
    FragmentDefinition,
    VariableDefinition,
}

impl DirectiveParent {
    /// The uppercase location graphql-js reports.
    fn location(self) -> &'static str {
        match self {
            DirectiveParent::Query => "QUERY",
            DirectiveParent::Mutation => "MUTATION",
            DirectiveParent::Subscription => "SUBSCRIPTION",
            DirectiveParent::Field => "FIELD",
            DirectiveParent::FragmentSpread => "FRAGMENT_SPREAD",
            DirectiveParent::InlineFragment => "INLINE_FRAGMENT",
            DirectiveParent::FragmentDefinition => "FRAGMENT_DEFINITION",
            DirectiveParent::VariableDefinition => "VARIABLE_DEFINITION",
        }
    }
}

/// One variable usage the reference validator collected.
#[derive(Clone, Debug)]
struct VariableUsage {
    /// The variable name.
    name: String,
    /// The variable node's source.
    source: usize,
    /// The variable node's start offset.
    offset: Option<Offset>,
    /// The input type the position expects.
    expected: Option<TypeNode>,
    /// The default value of the position.
    default_value: Option<Value>,
    /// The input type outside the position.
    parent_type: Option<TypeNode>,
}

/// The reference validator's state for one document.
struct Validator<'a> {
    view: &'a SchemaView<'a>,
    definitions: &'a ValidationDocument<'a>,
    fragments: HashMap<String, (&'a FragmentNode, usize)>,
    mode: Pass,
    errors: Vec<GqlError>,
    aborted: bool,
    current_source: usize,
    ti: TypeState,
    known_operation_names: HashMap<String, NodeSite>,
    operation_count: usize,
    known_fragment_names: HashMap<String, NodeSite>,
    directive_locations: HashMap<String, Vec<String>>,
    directive_args: HashMap<String, Vec<String>>,
    required_directive_args: HashMap<String, Vec<(String, String)>>,
    variable_name_defined: HashSet<String>,
    variable_defs: Vec<(&'a VariableDefinition, usize)>,
    var_def_map: HashMap<String, (&'a VariableDefinition, usize)>,
    visited_frags: HashSet<String>,
    spread_path: Vec<(&'a FragmentSpread, usize)>,
    spread_path_index: HashMap<String, usize>,
    known_names: HashMap<String, NodeSite>,
    known_name_stack: Vec<HashMap<String, NodeSite>>,
    /// `OverlappingFieldsCanBeMergedRule`'s memoization and field-map cache.
    overlap: OverlapState<'a>,
}

impl<'a> Validator<'a> {
    /// Builds a validator for one document and pass.
    fn new(
        view: &'a SchemaView<'a>,
        definitions: &'a ValidationDocument<'a>,
        mode: Pass,
    ) -> Self {
        let mut directive_locations: HashMap<String, Vec<String>> = HashMap::new();
        let mut directive_args: HashMap<String, Vec<String>> = HashMap::new();
        let mut required_directive_args: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for (name, directive) in &view.directives {
            directive_locations.insert(name.clone(), directive.locations.clone());
            directive_args.insert(
                name.clone(),
                directive.args.iter().map(|arg| arg.name.clone()).collect(),
            );
            required_directive_args.insert(
                name.clone(),
                directive
                    .args
                    .iter()
                    .filter(|arg| {
                        matches!(arg.type_node, TypeNode::NonNull(_)) && arg.default_value.is_none()
                    })
                    .map(|arg| (arg.name.clone(), type_ref_string(&arg.type_node)))
                    .collect(),
            );
        }
        let fragments = definitions.fragments();
        Validator {
            view,
            definitions,
            fragments,
            mode,
            errors: Vec::new(),
            aborted: false,
            current_source: 0,
            ti: TypeState::default(),
            known_operation_names: HashMap::new(),
            operation_count: 0,
            known_fragment_names: HashMap::new(),
            directive_locations,
            directive_args,
            required_directive_args,
            variable_name_defined: HashSet::new(),
            variable_defs: Vec::new(),
            var_def_map: HashMap::new(),
            visited_frags: HashSet::new(),
            spread_path: Vec::new(),
            spread_path_index: HashMap::new(),
            known_names: HashMap::new(),
            known_name_stack: Vec::new(),
            overlap: OverlapState::default(),
        }
    }

    /// Walks the whole validation document.
    fn run(&mut self) -> Result<(), String> {
        let definitions = self.definitions;
        if self.mode == Pass::Rules {
            // `ExecutableDefinitions`: this AST can only hold executable definitions.
            self.operation_count = definitions
                .definitions
                .iter()
                .filter(|entry| matches!(entry.node, Definition::Operation(_)))
                .count();
        }
        for entry in &definitions.definitions {
            if self.aborted {
                break;
            }
            self.current_source = entry.source;
            self.walk_definition(entry.node)?;
        }
        Ok(())
    }

    /// Walks one definition.
    fn walk_definition(&mut self, node: &'a Definition) -> Result<(), String> {
        match node {
            Definition::Operation(operation) => {
                if self.mode == Pass::Rules {
                    self.enter_operation(operation)?;
                }
                self.ti.enter(self.view, TiNode::Operation(operation));
                for variable in &operation.variable_definitions {
                    self.walk_variable_definition(variable);
                }
                for directive in &operation.directives {
                    self.walk_directive(directive, self.operation_parent(operation.operation), Prune::default())?;
                }
                self.walk_selection_set(&operation.selection_set, Prune::default())?;
                self.ti.leave(TiKind::Operation);
                if self.mode == Pass::Rules {
                    self.leave_operation(operation);
                }
            }
            Definition::Fragment(fragment) => {
                if self.mode == Pass::Rules {
                    self.enter_fragment(fragment);
                }
                self.ti.enter(self.view, TiNode::Fragment(fragment));
                for variable in &fragment.variable_definitions {
                    self.walk_variable_definition(variable);
                }
                self.walk_named_type(&fragment.type_condition);
                for directive in &fragment.directives {
                    self.walk_directive(directive, DirectiveParent::FragmentDefinition, Prune::default())?;
                }
                self.walk_selection_set(&fragment.selection_set, Prune::default())?;
                self.ti.leave(TiKind::Fragment);
            }
            // A type system definition is never walked: the extraction rejects such a
            // document before the reference validator runs.
            Definition::TypeSystem(_) => {}
        }
        Ok(())
    }

    /// The directive location of an operation definition.
    fn operation_parent(&self, operation: OperationType) -> DirectiveParent {
        match operation {
            OperationType::Query => DirectiveParent::Query,
            OperationType::Mutation => DirectiveParent::Mutation,
            OperationType::Subscription => DirectiveParent::Subscription,
        }
    }

    /// Walks one variable definition.
    fn walk_variable_definition(&mut self, node: &'a VariableDefinition) {
        self.ti.enter(self.view, TiNode::VariableDefinition(node));
        if self.mode == Pass::Rules {
            self.variables_are_input_types(node);
            self.variable_name_defined.insert(node.variable.name.value.clone());
            self.variable_defs.push((node, self.current_source));
            self.var_def_map.insert(node.variable.name.value.clone(), (node, self.current_source));
            self.unique_directives(&node.directives);
        }
        self.walk_type_node(&node.type_node);
        if let Some(default) = &node.default_value {
            self.walk_value(default, Prune::default());
        }
        for directive in &node.directives {
            let _ = self.walk_directive(directive, DirectiveParent::VariableDefinition, Prune::default());
        }
        self.ti.leave(TiKind::VariableDefinition);
    }

    /// Walks a type reference, reporting unknown type names.
    fn walk_type_node(&mut self, node: &'a TypeNode) {
        match node {
            TypeNode::Named(named) => self.walk_named_type(named),
            TypeNode::List(list) => {
                self.walk_type_node(&list.type_node);
            }
            TypeNode::NonNull(inner) => self.walk_type_node(&inner.type_node),
        }
    }

    /// Walks one named type node.
    fn walk_named_type(&mut self, node: &'a NamedType) {
        if self.mode != Pass::Rules || self.aborted {
            return;
        }
        let name = node.name.value.clone();
        if self.view.named_type_name(&name).is_some() {
            return;
        }
        let suggestions = suggestion_list(&name, &self.view.type_names.clone());
        self.report(format!("Unknown type \"{name}\".{}", did_you_mean(None, &suggestions)), &[node.loc]);
    }

    /// Walks one directive, with the location it applies to.
    fn walk_directive(
        &mut self,
        node: &'a Directive,
        parent: DirectiveParent,
        prune: Prune,
    ) -> Result<(), String> {
        self.ti.enter(self.view, TiNode::Directive(node));
        if self.mode == Pass::Rules {
            self.known_directives(node, parent);
            self.known_argument_names_directive(node);
            self.unique_argument_names(&node.arguments);
        }
        for argument in &node.arguments {
            self.walk_argument(argument, Prune { known_args: true, ..prune })?;
        }
        if self.mode == Pass::Rules {
            self.provided_required_arguments_directive(node);
        }
        self.ti.leave(TiKind::Directive);
        Ok(())
    }

    /// Walks one argument.
    fn walk_argument(
        &mut self,
        node: &'a crate::graphql::ast::Argument,
        prune: Prune,
    ) -> Result<(), String> {
        self.ti.enter(self.view, TiNode::Argument(node));
        if self.mode == Pass::Rules {
            if !prune.known_args {
                self.known_argument_names_argument(node);
            }
        } else {
            self.deprecated_argument(node);
        }
        self.walk_value(&node.value, prune);
        self.ti.leave(TiKind::Argument);
        Ok(())
    }

    /// Walks one value literal.
    fn walk_value(&mut self, node: &'a Value, prune: Prune) {
        if self.aborted {
            return;
        }
        match node {
            Value::Variable(_) => {}
            Value::IntValue { .. }
            | Value::FloatValue { .. }
            | Value::StringValue { .. }
            | Value::BooleanValue { .. }
            | Value::NullValue { .. }
            | Value::EnumValue { .. } => {
                self.ti.enter(self.view, TiNode::value(node));
                if self.mode == Pass::Rules {
                    if !prune.values {
                        self.values_of_correct_type(node);
                    }
                } else if let Value::EnumValue { .. } = node {
                    self.deprecated_enum_value(node);
                }
                self.ti.leave(TiKind::value_kind(node));
            }
            Value::ListValue { values, .. } => {
                self.ti.enter(self.view, TiNode::ListValue);
                let mut child = prune;
                if self.mode == Pass::Rules && !prune.values && !self.values_of_correct_type(node) {
                    child.values = true;
                }
                for value in values {
                    self.walk_value(value, child);
                }
                self.ti.leave(TiKind::ListValue);
            }
            Value::ObjectValue { fields, .. } => {
                let mut child = prune;
                let mut scoped = false;
                if self.mode == Pass::Rules {
                    if !prune.values && !self.values_of_correct_type(node) {
                        child.values = true;
                    }
                    self.unique_input_field_names_enter();
                    scoped = true;
                }
                for field in fields {
                    self.walk_object_field(field, child);
                }
                if scoped {
                    self.unique_input_field_names_leave();
                }
            }
        }
    }

    /// Walks one object literal field.
    fn walk_object_field(&mut self, node: &'a ObjectField, prune: Prune) {
        // `TypeInfo` has an `OBJECT_FIELD` transition but no node of its own.
        self.ti.enter(self.view, TiNode::ObjectField(node));
        if self.mode == Pass::Rules {
            if !prune.values {
                self.values_of_correct_type_object_field(node);
            }
            self.unique_input_field_names_field(node);
        } else {
            self.deprecated_object_field(node);
        }
        self.walk_value(&node.value, prune);
        self.ti.leave(TiKind::ObjectField);
    }

    /// Walks one selection set.
    fn walk_selection_set(&mut self, set: &'a SelectionSet, prune: Prune) -> Result<(), String> {
        self.ti.enter(self.view, TiNode::SelectionSet);
        if self.mode == Pass::Rules {
            self.overlapping_fields(set);
        }
        for selection in &set.selections {
            if self.aborted {
                break;
            }
            match selection {
                Selection::Field(field) => self.walk_field(field, prune)?,
                Selection::FragmentSpread(spread) => self.walk_spread(spread)?,
                Selection::InlineFragment(inline) => self.walk_inline(inline, prune)?,
            }
        }
        self.ti.leave(TiKind::SelectionSet);
        Ok(())
    }

    /// Walks one field.
    fn walk_field(&mut self, node: &'a Field, prune: Prune) -> Result<(), String> {
        self.ti.enter(self.view, TiNode::Field(node));
        let mut child = prune;
        if self.mode == Pass::Rules {
            self.scalar_leafs(node);
            self.fields_on_correct_type(node);
            self.unique_directives(&node.directives);
            self.unique_argument_names(&node.arguments);
            if !prune.max_depth && self.max_introspection_depth(node) {
                child.max_depth = true;
            }
        } else {
            self.deprecated_field(node);
        }
        for argument in &node.arguments {
            self.walk_argument(argument, prune)?;
        }
        for directive in &node.directives {
            self.walk_directive(directive, DirectiveParent::Field, prune)?;
        }
        if let Some(set) = &node.selection_set {
            self.walk_selection_set(set, child)?;
        }
        if self.mode == Pass::Rules {
            self.provided_required_arguments_field(node);
        }
        self.ti.leave(TiKind::Field);
        Ok(())
    }

    /// Walks one fragment spread.
    fn walk_spread(&mut self, node: &'a FragmentSpread) -> Result<(), String> {
        // `FragmentSpread` has no `TypeInfo` transition.
        if self.mode == Pass::Rules {
            self.possible_fragment_spreads_spread(node);
            self.unique_directives(&node.directives);
        }
        for directive in &node.directives {
            self.walk_directive(directive, DirectiveParent::FragmentSpread, Prune::default())?;
        }
        Ok(())
    }

    /// Walks one inline fragment.
    fn walk_inline(&mut self, node: &'a InlineFragment, prune: Prune) -> Result<(), String> {
        self.ti.enter(self.view, TiNode::InlineFragment(node));
        if self.mode == Pass::Rules {
            self.fragments_on_composite_types_inline(node);
            self.possible_fragment_spreads_inline(node);
            self.unique_directives(&node.directives);
        }
        if let Some(condition) = &node.type_condition {
            self.walk_named_type(condition);
        }
        for directive in &node.directives {
            self.walk_directive(directive, DirectiveParent::InlineFragment, prune)?;
        }
        self.walk_selection_set(&node.selection_set, prune)?;
        self.ti.leave(TiKind::InlineFragment);
        Ok(())
    }

    /// Rule: `OverlappingFieldsCanBeMerged`, at the `SelectionSet` enter event.
    fn overlapping_fields(&mut self, set: &'a SelectionSet) {
        let parent_type = self.ti.parent_type();
        let source = self.current_source;
        let conflicts = {
            let view = self.view;
            let fragments = &self.fragments;
            self.overlap.find_conflicts_within_selection_set(
                view, fragments, parent_type, set, source,
            )
        };
        for conflict in conflicts {
            let message = format!(
                "Fields \"{}\" conflict because {}. Use different aliases on the fields to fetch both if this was intentional.",
                conflict.response_name,
                overlap_reason_message(&conflict.reason)
            );
            // The node may live in a fragment's file, and `error.locations[0]` is
            // resolved against the source the node was parsed from.
            let site = conflict
                .node
                .loc
                .map(|loc| NodeSite { source: conflict.source, offset: loc.start });
            if !self.report_sites(message, &[site]) {
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The rules themselves, in `specifiedRules` order
// ---------------------------------------------------------------------------

// `OverlappingFieldsCanBeMergedRule` is ported below as [`OverlapState`]: the
// `SelectionSet` enter handler at the position the rule holds in `specifiedRules`
// (after `VariablesInAllowedPosition`, before `UniqueInputFieldNames`). It is the
// only `specifiedRules` member that visits a `SelectionSet`, so it reports before
// any error the fields of that set produce, exactly like the oracle's single
// `visitInParallel` traversal.

impl<'a> Validator<'a> {
    /// The node site of a location in the current definition.
    fn loc_site(&self, loc: Option<crate::graphql::ast::Loc>) -> Option<NodeSite> {
        loc.map(|loc| NodeSite { source: self.current_source, offset: loc.start })
    }

    /// Reports one error, with explicit sites.
    fn report_sites(&mut self, message: String, nodes: &[Option<NodeSite>]) -> bool {
        if self.errors.len() >= 100 {
            self.errors.push(GqlError {
                message: "Too many validation errors, error limit reached. Validation aborted."
                    .to_string(),
                first_node_source: None,
                site: None,
            });
            self.aborted = true;
            return false;
        }
        let site = nodes.iter().flatten().next().copied();
        let first_node_source = nodes.first().copied().flatten().map(|site| site.source);
        self.errors.push(GqlError { message, first_node_source, site });
        true
    }

    /// Reports one error at nodes of the current definition.
    fn report(&mut self, message: String, nodes: &[Option<crate::graphql::ast::Loc>]) -> bool {
        let sites: Vec<Option<NodeSite>> =
            nodes.iter().map(|loc| self.loc_site(*loc)).collect();
        self.report_sites(message, &sites)
    }

    /// Rule 2: `UniqueOperationNames`.
    fn unique_operation_names(&mut self, node: &'a OperationDefinition) {
        let Some(name) = &node.name else { return };
        match self.known_operation_names.get(&name.value).copied() {
            Some(existing) => {
                self.report_sites(
                    format!("There can be only one operation named \"{}\".", name.value),
                    &[Some(existing), self.loc_site(name.loc)],
                );
            }
            None => {
                if let Some(site) = self.loc_site(name.loc) {
                    self.known_operation_names.insert(name.value.clone(), site);
                }
            }
        }
    }

    /// Rule 3: `LoneAnonymousOperation`.
    fn lone_anonymous_operation(&mut self, node: &'a OperationDefinition) {
        if node.name.is_none() && self.operation_count > 1 {
            self.report(
                "This anonymous operation must be the only defined operation.".to_string(),
                &[node.loc],
            );
        }
    }

    /// Rule 4: `SingleFieldSubscriptions`.
    fn single_field_subscriptions(&mut self, node: &'a OperationDefinition) -> Result<(), String> {
        if node.operation != OperationType::Subscription {
            return Ok(());
        }
        let Some(subscription_type) = self.view.subscription_type.clone() else {
            return Ok(());
        };
        let operation_name = node.name.as_ref().map(|name| name.value.clone());
        let mut fields: Vec<(String, Vec<&'a Field>)> = Vec::new();
        let mut visited: HashSet<String> = HashSet::new();
        collect_fields(
            self.view,
            &self.fragments,
            &subscription_type,
            &node.selection_set,
            &mut fields,
            &mut visited,
        )?;
        if fields.len() > 1 {
            let extra: Vec<Option<crate::graphql::ast::Loc>> = fields
                .iter()
                .skip(1)
                .flat_map(|(_, nodes)| nodes.iter().map(|node| node.loc))
                .collect();
            let message = match &operation_name {
                Some(name) => {
                    format!("Subscription \"{name}\" must select only one top level field.")
                }
                None => "Anonymous Subscription must select only one top level field.".to_string(),
            };
            self.report(message, &extra);
        }
        for (_, nodes) in &fields {
            let Some(field) = nodes.first() else { continue };
            if field.name.value.starts_with("__") {
                let message = match &operation_name {
                    Some(name) => format!(
                        "Subscription \"{name}\" must not select an introspection top level field."
                    ),
                    None => "Anonymous Subscription must not select an introspection top level field."
                        .to_string(),
                };
                let sites: Vec<Option<crate::graphql::ast::Loc>> =
                    nodes.iter().map(|node| node.loc).collect();
                self.report(message, &sites);
            }
        }
        Ok(())
    }

    /// Rule 5: `KnownTypeNames` is reported by `walk_named_type`.

    /// Rule 6: `FragmentsOnCompositeTypes`, for an inline fragment.
    fn fragments_on_composite_types_inline(&mut self, node: &'a InlineFragment) {
        let Some(condition) = &node.type_condition else { return };
        let Some(ty) = type_from_ast(self.view, &TypeNode::Named(condition.clone())) else {
            return;
        };
        if !self.view.is_composite(&ty.named_type().name.value) {
            self.report(
                format!(
                    "Fragment cannot condition on non composite type \"{}\".",
                    condition.name.value
                ),
                &[condition.loc],
            );
        }
    }

    /// Rule 6: `FragmentsOnCompositeTypes`, for a fragment definition.
    fn fragments_on_composite_types_fragment(&mut self, node: &'a FragmentNode) {
        let Some(ty) = type_from_ast(self.view, &TypeNode::Named(node.type_condition.clone()))
        else {
            return;
        };
        if !self.view.is_composite(&ty.named_type().name.value) {
            self.report(
                format!(
                    "Fragment \"{}\" cannot condition on non composite type \"{}\".",
                    node.name.value, node.type_condition.name.value
                ),
                &[node.type_condition.loc],
            );
        }
    }

    /// Rule 7: `VariablesAreInputTypes`.
    fn variables_are_input_types(&mut self, node: &'a VariableDefinition) {
        let Some(ty) = type_from_ast(self.view, &node.type_node) else {
            return;
        };
        if !self.view.is_input_type(&ty) {
            self.report(
                format!(
                    "Variable \"${}\" cannot be non-input type \"{}\".",
                    node.variable.name.value,
                    type_ref_string(&node.type_node)
                ),
                &[node.type_node.loc()],
            );
        }
    }

    /// Rule 8: `ScalarLeafs`.
    fn scalar_leafs(&mut self, node: &'a Field) {
        let Some(ty) = self.ti.get_type() else { return };
        let is_leaf = self.view.is_leaf(&ty.named_type().name.value);
        if is_leaf {
            if let Some(selection) = &node.selection_set {
                self.report(
                    format!(
                        "Field \"{}\" must not have a selection since type \"{}\" has no subfields.",
                        node.name.value,
                        type_ref_string(&ty)
                    ),
                    &[selection.loc],
                );
            }
            return;
        }
        match &node.selection_set {
            None => {
                self.report(
                    format!(
                        "Field \"{}\" of type \"{}\" must have a selection of subfields. Did you mean \"{} {{ ... }}\"?",
                        node.name.value,
                        type_ref_string(&ty),
                        node.name.value
                    ),
                    &[node.loc],
                );
            }
            Some(selection) if selection.selections.is_empty() => {
                self.report(
                    format!(
                        "Field \"{}\" of type \"{}\" must have at least one field selected.",
                        node.name.value,
                        type_ref_string(&ty)
                    ),
                    &[node.loc],
                );
            }
            Some(_) => {}
        }
    }

    /// Rule 9: `FieldsOnCorrectType`.
    fn fields_on_correct_type(&mut self, node: &'a Field) {
        let Some(parent) = self.ti.parent_type() else { return };
        if self.ti.field_def().is_some() {
            return;
        }
        let field_name = node.name.value.clone();
        let mut suggestion = did_you_mean(
            Some("to use an inline fragment on"),
            &self.suggested_type_names(&parent, &field_name),
        );
        if suggestion.is_empty() {
            suggestion = did_you_mean(None, &self.suggested_field_names(&parent, &field_name));
        }
        self.report(
            format!("Cannot query field \"{field_name}\" on type \"{parent}\".{suggestion}"),
            &[node.loc],
        );
    }

    /// The types `FieldsOnCorrectType` suggests to condition an inline fragment on.
    fn suggested_type_names(&self, parent: &str, field_name: &str) -> Vec<String> {
        if !self.view.is_abstract(parent) {
            return Vec::new();
        }
        let mut suggested: Vec<String> = Vec::new();
        let mut usage_count: HashMap<String, usize> = HashMap::new();
        for possible in self.view.possible_types(parent) {
            if self.view.field_def(&possible, field_name).is_none() {
                continue;
            }
            if !suggested.contains(&possible) {
                suggested.push(possible.clone());
            }
            usage_count.insert(possible.clone(), 1);
            for interface in self.view.interfaces.get(&possible).cloned().unwrap_or_default() {
                if self.view.field_def(&interface, field_name).is_none() {
                    continue;
                }
                if !suggested.contains(&interface) {
                    suggested.push(interface.clone());
                }
                *usage_count.entry(interface).or_insert(0) += 1;
            }
        }
        suggested.sort_by(|a, b| {
            let count_a = usage_count.get(a).copied().unwrap_or(0);
            let count_b = usage_count.get(b).copied().unwrap_or(0);
            if count_a != count_b {
                return count_b.cmp(&count_a);
            }
            let a_interface = self.view.kind(a) == Some(SchemaTypeKind::Interface);
            let b_interface = self.view.kind(b) == Some(SchemaTypeKind::Interface);
            if a_interface && self.view.is_sub_type(a, b) {
                return std::cmp::Ordering::Less;
            }
            if b_interface && self.view.is_sub_type(b, a) {
                return std::cmp::Ordering::Greater;
            }
            natural_compare(a, b)
        });
        suggested
    }

    /// The field names `FieldsOnCorrectType` suggests for a typo.
    fn suggested_field_names(&self, parent: &str, field_name: &str) -> Vec<String> {
        if !matches!(
            self.view.kind(parent),
            Some(SchemaTypeKind::Object | SchemaTypeKind::Interface)
        ) {
            return Vec::new();
        }
        let names: Vec<String> = self
            .view
            .fields
            .get(parent)
            .map(|fields| fields.iter().map(|field| field.name.clone()).collect())
            .unwrap_or_default();
        suggestion_list(field_name, &names)
    }

    /// Rule 10: `UniqueFragmentNames`.
    fn unique_fragment_names(&mut self, node: &'a FragmentNode) {
        match self.known_fragment_names.get(&node.name.value).copied() {
            Some(existing) => {
                self.report_sites(
                    format!("There can be only one fragment named \"{}\".", node.name.value),
                    &[Some(existing), self.loc_site(node.name.loc)],
                );
            }
            None => {
                if let Some(site) = self.loc_site(node.name.loc) {
                    self.known_fragment_names.insert(node.name.value.clone(), site);
                }
            }
        }
    }

    /// Rule 13: `PossibleFragmentSpreads`, for an inline fragment.
    fn possible_fragment_spreads_inline(&mut self, node: &'a InlineFragment) {
        let frag_type = self.ti.get_type();
        let parent_type = self.ti.parent_type();
        if let (Some(frag), Some(parent)) = (frag_type, parent_type) {
            if self.view.is_composite(&frag.named_type().name.value)
                && self.view.is_composite(&parent)
                && !self.types_overlap(&frag.named_type().name.value, &parent)
            {
                self.report(
                    format!(
                        "Fragment cannot be spread here as objects of type \"{parent}\" can never be of type \"{}\".",
                        frag.named_type().name.value
                    ),
                    &[node.loc],
                );
            }
        }
    }

    /// Rule 13: `PossibleFragmentSpreads`, for a named spread.
    fn possible_fragment_spreads_spread(&mut self, node: &'a FragmentSpread) {
        let name = node.name.value.clone();
        let Some((fragment, _)) = self.fragments.get(&name).copied() else {
            return;
        };
        let Some(frag_type) =
            type_from_ast(self.view, &TypeNode::Named(fragment.type_condition.clone()))
        else {
            return;
        };
        if !self.view.is_composite(&frag_type.named_type().name.value) {
            return;
        }
        let Some(parent) = self.ti.parent_type() else { return };
        if !self.types_overlap(&frag_type.named_type().name.value, &parent) {
            self.report(
                format!(
                    "Fragment \"{name}\" cannot be spread here as objects of type \"{parent}\" can never be of type \"{}\".",
                    frag_type.named_type().name.value
                ),
                &[node.loc],
            );
        }
    }

    /// `doTypesOverlap`.
    fn types_overlap(&self, a: &str, b: &str) -> bool {
        if a == b {
            return true;
        }
        if self.view.is_abstract(a) {
            if self.view.is_abstract(b) {
                return self
                    .view
                    .possible_types(a)
                    .iter()
                    .any(|possible| self.view.is_sub_type(b, possible));
            }
            return self.view.is_sub_type(a, b);
        }
        if self.view.is_abstract(b) {
            return self.view.is_sub_type(b, a);
        }
        false
    }

    /// Rule 14: `NoFragmentCycles`.
    fn fragment_cycles(&mut self, fragment: &'a FragmentNode, source: usize) {
        let name = fragment.name.value.clone();
        if self.visited_frags.contains(&name) {
            return;
        }
        self.visited_frags.insert(name.clone());
        let spreads = fragment_spreads(&fragment.selection_set);
        if spreads.is_empty() {
            return;
        }
        self.spread_path_index.insert(name.clone(), self.spread_path.len());
        for spread in spreads {
            let spread_name = spread.name.value.clone();
            let cycle_index = self.spread_path_index.get(&spread_name).copied();
            self.spread_path.push((spread, source));
            match cycle_index {
                None => {
                    if let Some((next, next_source)) = self.fragments.get(&spread_name).copied() {
                        self.fragment_cycles(next, next_source);
                    }
                }
                Some(cycle_index) => {
                    let cycle_path: Vec<(&'a FragmentSpread, usize)> =
                        self.spread_path[cycle_index..].to_vec();
                    let via = cycle_path[..cycle_path.len().saturating_sub(1)]
                        .iter()
                        .map(|(node, _)| format!("\"{}\"", node.name.value))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let message = if via.is_empty() {
                        format!("Cannot spread fragment \"{spread_name}\" within itself.")
                    } else {
                        format!("Cannot spread fragment \"{spread_name}\" within itself via {via}.")
                    };
                    let sites: Vec<Option<NodeSite>> = cycle_path
                        .iter()
                        .map(|(node, node_source)| {
                            node.loc.map(|loc| NodeSite { source: *node_source, offset: loc.start })
                        })
                        .collect();
                    self.report_sites(message, &sites);
                }
            }
            self.spread_path.pop();
        }
        self.spread_path_index.remove(&name);
    }

    /// Rule 15: `UniqueVariableNames`.
    fn unique_variable_names(&mut self, node: &'a OperationDefinition) {
        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Vec<Option<crate::graphql::ast::Loc>>> = HashMap::new();
        for variable in &node.variable_definitions {
            let name = variable.variable.name.value.clone();
            if !groups.contains_key(&name) {
                order.push(name.clone());
            }
            groups.entry(name).or_default().push(variable.variable.name.loc);
        }
        for name in order {
            let nodes = groups.remove(&name).unwrap_or_default();
            if nodes.len() > 1 {
                self.report(
                    format!("There can be only one variable named \"${name}\"."),
                    &nodes,
                );
            }
        }
    }

    /// Rule 16: `NoUndefinedVariables`.
    fn no_undefined_variables(
        &mut self,
        node: &'a OperationDefinition,
        usages: &[VariableUsage],
    ) {
        for usage in usages {
            if self.variable_name_defined.contains(&usage.name) {
                continue;
            }
            let message = match &node.name {
                Some(name) => format!(
                    "Variable \"${}\" is not defined by operation \"{}\".",
                    usage.name, name.value
                ),
                None => format!("Variable \"${}\" is not defined.", usage.name),
            };
            self.report_sites(
                message,
                &[
                    Some(NodeSite { source: usage.source, offset: usage.offset.unwrap_or(0) }),
                    self.loc_site(node.loc),
                ],
            );
        }
    }

    /// Rule 17: `NoUnusedVariables`.
    fn no_unused_variables(
        &mut self,
        node: &'a OperationDefinition,
        usages: &[VariableUsage],
    ) {
        let mut used: HashSet<&str> = HashSet::new();
        for usage in usages {
            used.insert(usage.name.as_str());
        }
        let definitions = self.variable_defs.clone();
        for (definition, source) in definitions {
            let name = &definition.variable.name.value;
            if used.contains(name.as_str()) {
                continue;
            }
            let message = match &node.name {
                Some(operation_name) => format!(
                    "Variable \"${name}\" is never used in operation \"{}\".",
                    operation_name.value
                ),
                None => format!("Variable \"${name}\" is never used."),
            };
            let _ = source;
            self.report_sites(
                message,
                &[definition
                    .loc
                    .map(|loc| NodeSite { source, offset: loc.start })],
            );
        }
    }

    /// Rule 24: `VariablesInAllowedPosition`.
    fn variables_in_allowed_position(
        &mut self,
        _node: &'a OperationDefinition,
        usages: &[VariableUsage],
    ) {
        for usage in usages {
            let Some((definition, source)) = self.var_def_map.get(&usage.name).copied() else {
                continue;
            };
            let Some(expected) = usage.expected.clone() else {
                continue;
            };
            let Some(var_type) = type_from_ast(self.view, &definition.type_node) else {
                continue;
            };
            let definition_site = definition.loc.map(|loc| NodeSite { source, offset: loc.start });
            if !allowed_variable_usage(
                self.view,
                &var_type,
                definition.default_value.as_ref(),
                &expected,
                usage.default_value.as_ref(),
            ) {
                self.report_sites(
                    format!(
                        "Variable \"${}\" of type \"{}\" used in position expecting type \"{}\".",
                        usage.name,
                        type_ref_string(&var_type),
                        type_ref_string(&expected)
                    ),
                    &[
                        definition_site,
                        Some(NodeSite { source: usage.source, offset: usage.offset.unwrap_or(0) }),
                    ],
                );
            }
            if let Some(parent_type) = &usage.parent_type {
                let parent_name = parent_type.named_type().name.value.clone();
                if self.view.is_input_object(&parent_name)
                    && self.view.one_of.contains(&parent_name)
                    && !matches!(var_type, TypeNode::NonNull(_))
                {
                    self.report_sites(
                        format!(
                            "Variable \"${}\" is of type \"{}\" but must be non-nullable to be used for OneOf Input Object \"{parent_name}\".",
                            usage.name,
                            type_ref_string(&var_type)
                        ),
                        &[
                            definition_site,
                            Some(NodeSite { source: usage.source, offset: usage.offset.unwrap_or(0) }),
                        ],
                    );
                }
            }
        }
    }

    /// Rule 18: `KnownDirectives`.
    fn known_directives(&mut self, node: &'a Directive, parent: DirectiveParent) {
        let name = node.name.value.clone();
        match self.directive_locations.get(&name) {
            None => {
                self.report(format!("Unknown directive \"@{name}\"."), &[node.loc]);
            }
            Some(locations) => {
                let candidate = parent.location();
                if !locations.iter().any(|location| location == candidate) {
                    self.report(
                        format!("Directive \"@{name}\" may not be used on {candidate}."),
                        &[node.loc],
                    );
                }
            }
        }
    }

    /// Rule 19: `UniqueDirectivesPerLocation`.
    fn unique_directives(&mut self, directives: &'a [Directive]) {
        let mut seen: HashMap<String, Option<NodeSite>> = HashMap::new();
        for directive in directives {
            let name = directive.name.value.clone();
            let unique = self
                .view
                .directives
                .get(&name)
                .map(|definition| !definition.repeatable)
                .unwrap_or(false);
            if !unique {
                continue;
            }
            match seen.get(&name).copied() {
                Some(first) => {
                    self.report_sites(
                        format!(
                            "The directive \"@{name}\" can only be used once at this location."
                        ),
                        &[first, self.loc_site(directive.loc)],
                    );
                }
                None => {
                    let site = self.loc_site(directive.loc);
                    seen.insert(name, site);
                }
            }
        }
    }

    /// Rule 20: `KnownArgumentNames`, on a directive.
    ///
    /// `@when`/`@when_not` are the one exception: their arguments **are** the filter
    /// key/value pairs matched against the list field's own arguments, so no fixed
    /// declaration can enumerate them (Houdini declares none and reads them
    /// dynamically, `schema/generateDefinitions_test.go:96-100`,
    /// `documents/artifacts/selection.go:1572-1606`).
    fn known_argument_names_directive(&mut self, node: &'a Directive) {
        let directive_name = node.name.value.clone();
        if directive_name == "when" || directive_name == "when_not" {
            return;
        }
        let Some(known) = self.directive_args.get(&directive_name).cloned() else {
            return;
        };
        for argument in &node.arguments {
            if known.iter().any(|name| *name == argument.name.value) {
                continue;
            }
            let suggestions = suggestion_list(&argument.name.value, &known);
            self.report(
                format!(
                    "Unknown argument \"{}\" on directive \"@{directive_name}\".{}",
                    argument.name.value,
                    did_you_mean(None, &suggestions)
                ),
                &[argument.loc],
            );
        }
    }

    /// Rule 20: `KnownArgumentNames`, on a field argument.
    fn known_argument_names_argument(&mut self, node: &'a crate::graphql::ast::Argument) {
        if self.ti.argument.is_some() {
            return;
        }
        let Some(field_def) = self.ti.field_def() else { return };
        let Some(parent) = self.ti.parent_type() else { return };
        let known: Vec<String> = field_def.args.iter().map(|arg| arg.name.clone()).collect();
        let suggestions = suggestion_list(&node.name.value, &known);
        self.report(
            format!(
                "Unknown argument \"{}\" on field \"{parent}.{}\".{}",
                node.name.value,
                field_def.name,
                did_you_mean(None, &suggestions)
            ),
            &[node.loc],
        );
    }

    /// Rule 21: `UniqueArgumentNames`.
    fn unique_argument_names(&mut self, arguments: &'a [crate::graphql::ast::Argument]) {
        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Vec<Option<crate::graphql::ast::Loc>>> = HashMap::new();
        for argument in arguments {
            let name = argument.name.value.clone();
            if !groups.contains_key(&name) {
                order.push(name.clone());
            }
            groups.entry(name).or_default().push(argument.name.loc);
        }
        for name in order {
            let nodes = groups.remove(&name).unwrap_or_default();
            if nodes.len() > 1 {
                self.report(
                    format!("There can be only one argument named \"{name}\"."),
                    &nodes,
                );
            }
        }
    }

    /// Rule 22: `ValuesOfCorrectType`; `false` prunes the rule below the node.
    fn values_of_correct_type(&mut self, node: &'a Value) -> bool {
        match node {
            Value::ListValue { .. } => {
                let expected = self.ti.parent_input_type().map(nullable_type);
                if matches!(expected, Some(TypeNode::List(_))) {
                    return true;
                }
                self.is_valid_value_node(node);
                false
            }
            Value::ObjectValue { .. } => {
                let named = self.ti.input_type().map(|node| node.named_type().name.value.clone());
                let Some(named) = named.filter(|name| self.view.is_input_object(name)) else {
                    self.is_valid_value_node(node);
                    return false;
                };
                let present: Vec<String> = match node {
                    Value::ObjectValue { fields, .. } => {
                        fields.iter().map(|field| field.name.value.clone()).collect()
                    }
                    _ => Vec::new(),
                };
                let declared = self.view.input_fields.get(&named).cloned().unwrap_or_default();
                for field in &declared {
                    if !present.contains(&field.name) && is_required_input_field(field) {
                        self.report(
                            format!(
                                "Field \"{named}.{}\" of required type \"{}\" was not provided.",
                                field.name,
                                type_ref_string(&field.type_node)
                            ),
                            &[node.loc()],
                        );
                    }
                }
                if self.view.one_of.contains(&named) {
                    let keys: Vec<String> = match node {
                        Value::ObjectValue { fields, .. } => {
                            let mut keys: Vec<String> = Vec::new();
                            for field in fields {
                                if !keys.contains(&field.name.value) {
                                    keys.push(field.name.value.clone());
                                }
                            }
                            keys
                        }
                        _ => Vec::new(),
                    };
                    if keys.len() != 1 {
                        self.report(
                            format!("OneOf Input Object \"{named}\" must specify exactly one key."),
                            &[node.loc()],
                        );
                    } else {
                        let value = match node {
                            Value::ObjectValue { fields, .. } => fields
                                .iter()
                                .find(|field| field.name.value == keys[0])
                                .map(|field| &field.value),
                            _ => None,
                        };
                        let is_null = value.is_none()
                            || matches!(value, Some(Value::NullValue { .. }));
                        if is_null {
                            self.report(
                                format!("Field \"{named}.{}\" must be non-null.", keys[0]),
                                &[node.loc()],
                            );
                        }
                    }
                }
                true
            }
            Value::NullValue { .. } => {
                if let Some(expected) = self.ti.input_type() {
                    if matches!(expected, TypeNode::NonNull(_)) {
                        self.report(
                            format!(
                                "Expected value of type \"{}\", found {}.",
                                type_ref_string(&expected),
                                print_literal(node)
                            ),
                            &[node.loc()],
                        );
                    }
                }
                true
            }
            _ => {
                self.is_valid_value_node(node);
                true
            }
        }
    }

    /// Rule 22: the object-field half of `ValuesOfCorrectType`.
    fn values_of_correct_type_object_field(&mut self, node: &'a ObjectField) {
        let parent = self.ti.parent_input_type().map(|node| node.named_type().name.value.clone());
        if self.ti.input_type().is_some() {
            return;
        }
        let Some(parent) = parent.filter(|name| self.view.is_input_object(name)) else {
            return;
        };
        let names: Vec<String> = self
            .view
            .input_fields
            .get(&parent)
            .map(|fields| fields.iter().map(|field| field.name.clone()).collect())
            .unwrap_or_default();
        let suggestions = suggestion_list(&node.name.value, &names);
        self.report(
            format!(
                "Field \"{}\" is not defined by type \"{parent}\".{}",
                node.name.value,
                did_you_mean(None, &suggestions)
            ),
            &[node.loc],
        );
    }

    /// The leaf half of `ValuesOfCorrectType`.
    fn is_valid_value_node(&mut self, node: &'a Value) {
        let Some(location_type) = self.ti.input_type() else {
            return;
        };
        let named = location_type.named_type().name.value.clone();
        if !self.view.is_leaf(&named) {
            self.report(
                format!(
                    "Expected value of type \"{}\", found {}.",
                    type_ref_string(&location_type),
                    print_literal(node)
                ),
                &[node.loc()],
            );
            return;
        }
        match self.view.kind(&named) {
            Some(SchemaTypeKind::Enum) => {
                let values = self.view.enum_values.get(&named).cloned().unwrap_or_default();
                let Value::EnumValue { value, .. } = node else {
                    let printed = print_literal(node);
                    let suggestions = suggestion_list(&printed, &values);
                    self.report(
                        format!(
                            "Enum \"{named}\" cannot represent non-enum value: {printed}.{}",
                            did_you_mean(Some("the enum value"), &suggestions)
                        ),
                        &[node.loc()],
                    );
                    return;
                };
                if values.contains(value) {
                    return;
                }
                let printed = print_literal(node);
                let suggestions = suggestion_list(value, &values);
                self.report(
                    format!(
                        "Value \"{printed}\" does not exist in \"{named}\" enum.{}",
                        did_you_mean(Some("the enum value"), &suggestions)
                    ),
                    &[node.loc()],
                );
            }
            Some(SchemaTypeKind::Scalar) => {
                if let Some(message) = scalar_literal_error(&named, node) {
                    self.report(
                        message,
                        &[node.loc()],
                    );
                }
            }
            _ => {}
        }
    }

    /// Rule 23: `ProvidedRequiredArguments`, on a field.
    fn provided_required_arguments_field(&mut self, node: &'a Field) {
        let Some(field_def) = self.ti.field_def() else { return };
        let provided: Vec<String> =
            node.arguments.iter().map(|argument| argument.name.value.clone()).collect();
        for argument in &field_def.args {
            if provided.contains(&argument.name) {
                continue;
            }
            if !is_required_argument(argument) {
                continue;
            }
            self.report(
                format!(
                    "Field \"{}\" argument \"{}\" of type \"{}\" is required, but it was not provided.",
                    field_def.name,
                    argument.name,
                    type_ref_string(&argument.type_node)
                ),
                &[node.loc],
            );
        }
    }

    /// Rule 23: `ProvidedRequiredArguments`, on a directive.
    fn provided_required_arguments_directive(&mut self, node: &'a Directive) {
        let directive_name = node.name.value.clone();
        if directive_name == "when" || directive_name == "when_not" {
            // the filters are free-form; an empty one is FLM1038, not a missing-argument error
            return;
        }
        let Some(required) = self.required_directive_args.get(&directive_name).cloned() else {
            return;
        };
        let provided: Vec<String> =
            node.arguments.iter().map(|argument| argument.name.value.clone()).collect();
        for (name, type_string) in required {
            if provided.contains(&name) {
                continue;
            }
            self.report(
                format!(
                    "Directive \"@{directive_name}\" argument \"{name}\" of type \"{type_string}\" is required, but it was not provided."
                ),
                &[node.loc],
            );
        }
    }

    /// Rule 26: `UniqueInputFieldNames`, entering an object literal.
    fn unique_input_field_names_enter(&mut self) {
        let previous = std::mem::take(&mut self.known_names);
        self.known_name_stack.push(previous);
    }

    /// Rule 26: `UniqueInputFieldNames`, leaving an object literal.
    fn unique_input_field_names_leave(&mut self) {
        if let Some(previous) = self.known_name_stack.pop() {
            self.known_names = previous;
        }
    }

    /// Rule 26: `UniqueInputFieldNames`, one field of an object literal.
    fn unique_input_field_names_field(&mut self, node: &'a ObjectField) {
        let name = node.name.value.clone();
        match self.known_names.get(&name).copied() {
            Some(first) => {
                self.report_sites(
                    format!("There can be only one input field named \"{name}\"."),
                    &[Some(first), self.loc_site(node.name.loc)],
                );
            }
            None => {
                if let Some(site) = self.loc_site(node.name.loc) {
                    self.known_names.insert(name, site);
                }
            }
        }
    }

    /// Rule 27: `MaxIntrospectionDepth`; `true` prunes the rule below the field.
    fn max_introspection_depth(&mut self, node: &'a Field) -> bool {
        if node.name.value != "__schema" && node.name.value != "__type" {
            return false;
        }
        let mut visited: HashSet<String> = HashSet::new();
        let reached = match &node.selection_set {
            Some(set) => self.check_introspection_depth_set(set, &mut visited, 0),
            None => false,
        };
        if reached {
            self.report("Maximum introspection depth exceeded".to_string(), &[node.loc]);
        }
        reached
    }

    /// The recursive half of `MaxIntrospectionDepth`.
    fn check_introspection_depth_set(
        &self,
        set: &SelectionSet,
        visited: &mut HashSet<String>,
        depth: usize,
    ) -> bool {
        for selection in &set.selections {
            let reached = match selection {
                Selection::FragmentSpread(spread) => {
                    let name = spread.name.value.clone();
                    if visited.contains(&name) {
                        false
                    } else if let Some((fragment, _)) = self.fragments.get(&name).copied() {
                        visited.insert(name.clone());
                        let found = self.check_introspection_depth_set(
                            &fragment.selection_set,
                            visited,
                            depth,
                        );
                        visited.remove(&name);
                        found
                    } else {
                        false
                    }
                }
                Selection::Field(field) => {
                    let mut depth = depth;
                    if matches!(
                        field.name.value.as_str(),
                        "fields" | "interfaces" | "possibleTypes" | "inputFields"
                    ) {
                        depth += 1;
                        if depth >= 3 {
                            return true;
                        }
                    }
                    match &field.selection_set {
                        Some(set) => self.check_introspection_depth_set(set, visited, depth),
                        None => false,
                    }
                }
                Selection::InlineFragment(inline) => {
                    self.check_introspection_depth_set(&inline.selection_set, visited, depth)
                }
            };
            if reached {
                return true;
            }
        }
        false
    }

    /// `NoDeprecatedCustomRule`: a deprecated field.
    fn deprecated_field(&mut self, node: &'a Field) {
        let Some(field_def) = self.ti.field_def() else { return };
        let Some(reason) = field_def.deprecated.clone() else { return };
        let parent = self.ti.parent_type().unwrap_or_default();
        self.report(
            format!("The field {parent}.{} is deprecated. {reason}", field_def.name),
            &[node.loc],
        );
    }

    /// `NoDeprecatedCustomRule`: a deprecated argument.
    fn deprecated_argument(&mut self, node: &'a crate::graphql::ast::Argument) {
        let Some(argument) = self.ti.argument.clone() else { return };
        let Some(reason) = argument.deprecated.clone() else { return };
        if let Some(directive) = self.ti.directive.clone() {
            self.report(
                format!(
                    "Directive \"@{}\" argument \"{}\" is deprecated. {reason}",
                    directive.name, argument.name
                ),
                &[node.loc],
            );
            return;
        }
        let (Some(parent), Some(field_def)) = (self.ti.parent_type(), self.ti.field_def()) else {
            return;
        };
        self.report(
            format!(
                "Field \"{parent}.{}\" argument \"{}\" is deprecated. {reason}",
                field_def.name, argument.name
            ),
            &[node.loc],
        );
    }

    /// `NoDeprecatedCustomRule`: a deprecated input object field.
    fn deprecated_object_field(&mut self, node: &'a ObjectField) {
        let Some(parent) = self
            .ti
            .parent_input_type()
            .map(|node| node.named_type().name.value.clone())
        else {
            return;
        };
        if !self.view.is_input_object(&parent) {
            return;
        }
        let Some(field) = self.view.input_field_def(&parent, &node.name.value) else {
            return;
        };
        let Some(reason) = field.deprecated.clone() else { return };
        self.report(
            format!("The input field {parent}.{} is deprecated. {reason}", field.name),
            &[node.loc],
        );
    }

    /// `NoDeprecatedCustomRule`: a deprecated enum value.
    fn deprecated_enum_value(&mut self, node: &'a Value) {
        let Some(enum_value) = self.ti.enum_value.clone() else { return };
        let Some(enum_type) = self
            .ti
            .input_type()
            .map(|node| node.named_type().name.value.clone())
        else {
            return;
        };
        let Some(reason) = self
            .view
            .enum_deprecations
            .get(&(enum_type.clone(), enum_value.clone()))
            .cloned()
        else {
            return;
        };
        self.report(
            format!("The enum value \"{enum_type}.{enum_value}\" is deprecated. {reason}"),
            &[node.loc()],
        );
    }

    /// Rule 4's `collectFields` needs the fragments; kept here for the entry point.
    fn enter_operation(&mut self, node: &'a OperationDefinition) -> Result<(), String> {
        self.unique_operation_names(node);
        self.lone_anonymous_operation(node);
        self.single_field_subscriptions(node)?;
        self.unique_variable_names(node);
        self.unique_directives(&node.directives);
        self.variable_name_defined.clear();
        self.variable_defs.clear();
        self.var_def_map.clear();
        Ok(())
    }

    /// Rule 14's entry into a fragment definition.
    fn enter_fragment(&mut self, node: &'a FragmentNode) {
        self.fragments_on_composite_types_fragment(node);
        self.unique_fragment_names(node);
        let source = self.current_source;
        self.fragment_cycles(node, source);
        self.unique_directives(&node.directives);
    }

    /// The leave-phase rules of an operation definition.
    fn leave_operation(&mut self, node: &'a OperationDefinition) {
        let usages = self.recursive_variable_usages(node);
        self.no_undefined_variables(node, &usages);
        self.no_unused_variables(node, &usages);
        self.variables_in_allowed_position(node, &usages);
    }

    /// `getRecursiveVariableUsages`: the operation plus every fragment it reaches.
    fn recursive_variable_usages(&self, node: &'a OperationDefinition) -> Vec<VariableUsage> {
        let mut usages = collect_usages(self.view, UsageRoot::Operation(node), self.current_source);
        let fragments = self.recursively_referenced_fragments(&node.selection_set);
        for (fragment, source) in fragments {
            usages.extend(collect_usages(self.view, UsageRoot::Fragment(fragment), source));
        }
        usages
    }

    /// `getRecursivelyReferencedFragments`, in the reference implementation's order.
    fn recursively_referenced_fragments(
        &self,
        selection_set: &'a SelectionSet,
    ) -> Vec<(&'a FragmentNode, usize)> {
        let mut fragments: Vec<(&'a FragmentNode, usize)> = Vec::new();
        let mut collected: HashSet<String> = HashSet::new();
        let mut nodes_to_visit: Vec<&'a SelectionSet> = vec![selection_set];
        while let Some(node) = nodes_to_visit.pop() {
            for spread in fragment_spreads(node) {
                let name = spread.name.value.clone();
                if collected.contains(&name) {
                    continue;
                }
                collected.insert(name.clone());
                if let Some((fragment, source)) = self.fragments.get(&name).copied() {
                    fragments.push((fragment, source));
                    nodes_to_visit.push(&fragment.selection_set);
                }
            }
        }
        fragments
    }
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

impl<'n> TiNode<'n> {
    /// The `TypeInfo` node for a value literal.
    fn value(node: &'n Value) -> TiNode<'n> {
        match node {
            Value::EnumValue { value, .. } => TiNode::Enum(value),
            _ => TiNode::Other,
        }
    }
}

impl TiKind {
    /// The leave kind of a value literal.
    fn value_kind(node: &Value) -> TiKind {
        match node {
            Value::EnumValue { .. } => TiKind::Enum,
            _ => TiKind::Other,
        }
    }
}

/// True when an argument declaration has no default and is non-null.
fn is_required_argument(argument: &ArgDef) -> bool {
    matches!(argument.type_node, TypeNode::NonNull(_)) && argument.default_value.is_none()
}

/// True when an input field declaration has no default and is non-null.
fn is_required_input_field(field: &InputFieldDef) -> bool {
    matches!(field.type_node, TypeNode::NonNull(_)) && field.default_value.is_none()
}

/// The message a built-in scalar's `parseLiteral` throws for a literal.
fn scalar_literal_error(name: &str, node: &Value) -> Option<String> {
    match name {
        "Int" => match node {
            Value::IntValue { value, .. } => {
                let parsed = value.trim().parse::<i64>();
                let out_of_range = match parsed {
                    Ok(value) => value > 2_147_483_647 || value < -2_147_483_648,
                    Err(_) => true,
                };
                if out_of_range {
                    Some(format!(
                        "Int cannot represent non 32-bit signed integer value: {value}"
                    ))
                } else {
                    None
                }
            }
            _ => Some(format!(
                "Int cannot represent non-integer value: {}",
                print_literal(node)
            )),
        },
        "Float" => match node {
            Value::FloatValue { .. } | Value::IntValue { .. } => None,
            _ => Some(format!(
                "Float cannot represent non numeric value: {}",
                print_literal(node)
            )),
        },
        "String" => match node {
            Value::StringValue { .. } => None,
            _ => Some(format!(
                "String cannot represent a non string value: {}",
                print_literal(node)
            )),
        },
        "Boolean" => match node {
            Value::BooleanValue { .. } => None,
            _ => Some(format!(
                "Boolean cannot represent a non boolean value: {}",
                print_literal(node)
            )),
        },
        "ID" => match node {
            Value::StringValue { .. } | Value::IntValue { .. } => None,
            _ => Some(format!(
                "ID cannot represent a non-string and non-integer value: {}",
                print_literal(node)
            )),
        },
        _ => None,
    }
}

/// True when two type references name the same type with the same wrappers.
///
/// `TypeNode`'s derived equality compares `loc`, and a variable definition's type
/// node never shares a location with the schema's own: every schema lookup has to
/// compare the *reference*, not the source range.
fn same_type_ref(left: &TypeNode, right: &TypeNode) -> bool {
    match (left, right) {
        (TypeNode::Named(a), TypeNode::Named(b)) => a.name.value == b.name.value,
        (TypeNode::List(a), TypeNode::List(b)) => same_type_ref(&a.type_node, &b.type_node),
        (TypeNode::NonNull(a), TypeNode::NonNull(b)) => {
            same_type_ref(&a.type_node, &b.type_node)
        }
        _ => false,
    }
}

/// `isTypeSubTypeOf`.
fn is_type_sub_type_of(view: &SchemaView<'_>, maybe: &TypeNode, super_type: &TypeNode) -> bool {
    if same_type_ref(maybe, super_type) {
        return true;
    }
    match super_type {
        TypeNode::NonNull(outer) => match maybe {
            TypeNode::NonNull(inner) => {
                is_type_sub_type_of(view, &inner.type_node, &outer.type_node)
            }
            _ => false,
        },
        _ => match maybe {
            TypeNode::NonNull(inner) => is_type_sub_type_of(view, &inner.type_node, super_type),
            _ => match super_type {
                TypeNode::List(outer) => match maybe {
                    TypeNode::List(inner) => {
                        is_type_sub_type_of(view, &inner.type_node, &outer.type_node)
                    }
                    _ => false,
                },
                _ => match maybe {
                    TypeNode::List(_) => false,
                    TypeNode::Named(inner) => {
                        let outer = super_type.named_type();
                        view.is_abstract(&outer.name.value)
                            && matches!(
                                view.kind(&inner.name.value),
                                Some(SchemaTypeKind::Interface | SchemaTypeKind::Object)
                            )
                            && view.is_sub_type(&outer.name.value, &inner.name.value)
                    }
                    TypeNode::NonNull(_) => false,
                },
            },
        },
    }
}

/// `allowedVariableUsage`.
fn allowed_variable_usage(
    view: &SchemaView<'_>,
    var_type: &TypeNode,
    var_default: Option<&Value>,
    location_type: &TypeNode,
    location_default: Option<&Value>,
) -> bool {
    if let TypeNode::NonNull(outer) = location_type {
        if !matches!(var_type, TypeNode::NonNull(_)) {
            let has_non_null_variable_default =
                var_default.is_some_and(|value| !matches!(value, Value::NullValue { .. }));
            let has_location_default = location_default.is_some();
            if !has_non_null_variable_default && !has_location_default {
                return false;
            }
            return is_type_sub_type_of(view, var_type, &outer.type_node);
        }
    }
    is_type_sub_type_of(view, var_type, location_type)
}

/// Every fragment spread a selection set holds, in the reference implementation's order.
fn fragment_spreads(selection_set: &SelectionSet) -> Vec<&FragmentSpread> {
    let mut spreads: Vec<&FragmentSpread> = Vec::new();
    let mut sets_to_visit: Vec<&SelectionSet> = vec![selection_set];
    while let Some(set) = sets_to_visit.pop() {
        for selection in &set.selections {
            match selection {
                Selection::FragmentSpread(spread) => spreads.push(spread),
                Selection::Field(field) => {
                    if let Some(set) = &field.selection_set {
                        sets_to_visit.push(set);
                    }
                }
                Selection::InlineFragment(inline) => {
                    sets_to_visit.push(&inline.selection_set);
                }
            }
        }
    }
    spreads
}

/// The root of a variable-usage walk.
enum UsageRoot<'x> {
    /// An operation definition.
    Operation(&'x OperationDefinition),
    /// A fragment definition.
    Fragment(&'x FragmentNode),
}

/// `getVariableUsages`: every variable a definition reads, with the position's type.
fn collect_usages(
    view: &SchemaView<'_>,
    root: UsageRoot<'_>,
    source: usize,
) -> Vec<VariableUsage> {
    let mut state = TypeState::default();
    let mut usages: Vec<VariableUsage> = Vec::new();
    match root {
        UsageRoot::Operation(operation) => {
            state.enter(view, TiNode::Operation(operation));
            usage_selection_set(view, &mut state, &operation.selection_set, source, &mut usages);
            state.leave(TiKind::Operation);
        }
        UsageRoot::Fragment(fragment) => {
            state.enter(view, TiNode::Fragment(fragment));
            usage_selection_set(view, &mut state, &fragment.selection_set, source, &mut usages);
            state.leave(TiKind::Fragment);
        }
    }
    usages
}

/// The selection-set half of `getVariableUsages`.
fn usage_selection_set(
    view: &SchemaView<'_>,
    state: &mut TypeState,
    selection_set: &SelectionSet,
    source: usize,
    usages: &mut Vec<VariableUsage>,
) {
    state.enter(view, TiNode::SelectionSet);
    for selection in &selection_set.selections {
        match selection {
            Selection::Field(field) => {
                state.enter(view, TiNode::Field(field));
                for argument in &field.arguments {
                    state.enter(view, TiNode::Argument(argument));
                    usage_value(view, state, &argument.value, source, usages);
                    state.leave(TiKind::Argument);
                }
                for directive in &field.directives {
                    usage_directive(view, state, directive, source, usages);
                }
                if let Some(set) = &field.selection_set {
                    usage_selection_set(view, state, set, source, usages);
                }
                state.leave(TiKind::Field);
            }
            Selection::FragmentSpread(spread) => {
                for directive in &spread.directives {
                    usage_directive(view, state, directive, source, usages);
                }
            }
            Selection::InlineFragment(inline) => {
                state.enter(view, TiNode::InlineFragment(inline));
                for directive in &inline.directives {
                    usage_directive(view, state, directive, source, usages);
                }
                usage_selection_set(view, state, &inline.selection_set, source, usages);
                state.leave(TiKind::InlineFragment);
            }
        }
    }
    state.leave(TiKind::SelectionSet);
}

/// The directive half of `getVariableUsages`.
fn usage_directive(
    view: &SchemaView<'_>,
    state: &mut TypeState,
    directive: &Directive,
    source: usize,
    usages: &mut Vec<VariableUsage>,
) {
    state.enter(view, TiNode::Directive(directive));
    for argument in &directive.arguments {
        state.enter(view, TiNode::Argument(argument));
        usage_value(view, state, &argument.value, source, usages);
        state.leave(TiKind::Argument);
    }
    state.leave(TiKind::Directive);
}

/// The value half of `getVariableUsages`.
fn usage_value(
    view: &SchemaView<'_>,
    state: &mut TypeState,
    value: &Value,
    source: usize,
    usages: &mut Vec<VariableUsage>,
) {
    match value {
        Value::Variable(variable) => usages.push(VariableUsage {
            name: variable.name.value.clone(),
            source,
            offset: variable.loc.map(|loc| loc.start),
            expected: state.input_type(),
            default_value: state.default_value(),
            parent_type: state.parent_input_type(),
        }),
        Value::ListValue { values, .. } => {
            state.enter(view, TiNode::ListValue);
            for value in values {
                usage_value(view, state, value, source, usages);
            }
            state.leave(TiKind::ListValue);
        }
        Value::ObjectValue { fields, .. } => {
            for field in fields {
                state.enter(view, TiNode::ObjectField(field));
                usage_value(view, state, &field.value, source, usages);
                state.leave(TiKind::ObjectField);
            }
        }
        _ => {}
    }
}

/// `doesFragmentConditionMatch`.
fn fragment_condition_matches(
    view: &SchemaView<'_>,
    condition: Option<&str>,
    runtime_type: &str,
) -> bool {
    let Some(condition) = condition else {
        return true;
    };
    if condition == runtime_type {
        return true;
    }
    if view.is_abstract(condition) {
        return view.is_sub_type(condition, runtime_type);
    }
    false
}

/// `collectFields`, for `SingleFieldSubscriptions`.
fn collect_fields<'x>(
    view: &SchemaView<'_>,
    fragments: &HashMap<String, (&'x FragmentNode, usize)>,
    runtime_type: &str,
    selection_set: &'x SelectionSet,
    fields: &mut Vec<(String, Vec<&'x Field>)>,
    visited: &mut HashSet<String>,
) -> Result<(), String> {
    for selection in &selection_set.selections {
        match selection {
            Selection::Field(field) => {
                if !should_include_node(&field.directives)? {
                    continue;
                }
                let key = field.response_key().to_string();
                match fields.iter_mut().find(|(name, _)| *name == key) {
                    Some((_, list)) => list.push(field),
                    None => fields.push((key, vec![field])),
                }
            }
            Selection::InlineFragment(inline) => {
                if !should_include_node(&inline.directives)? {
                    continue;
                }
                let condition = inline
                    .type_condition
                    .as_ref()
                    .map(|condition| condition.name.value.as_str());
                if !fragment_condition_matches(view, condition, runtime_type) {
                    continue;
                }
                collect_fields(
                    view,
                    fragments,
                    runtime_type,
                    &inline.selection_set,
                    fields,
                    visited,
                )?;
            }
            Selection::FragmentSpread(spread) => {
                let name = spread.name.value.clone();
                if visited.contains(&name) || !should_include_node(&spread.directives)? {
                    continue;
                }
                visited.insert(name.clone());
                let Some((fragment, _)) = fragments.get(&name).copied() else {
                    continue;
                };
                if !fragment_condition_matches(
                    view,
                    Some(&fragment.type_condition.name.value),
                    runtime_type,
                ) {
                    continue;
                }
                collect_fields(view, fragments, runtime_type, &fragment.selection_set, fields, visited)?;
            }
        }
    }
    Ok(())
}

/// `shouldIncludeNode` with the empty runtime variable values the rule passes.
fn should_include_node(directives: &[Directive]) -> Result<bool, String> {
    if let Some(skip) = find_directive(directives, "skip") {
        if directive_if(skip)? == Some(true) {
            return Ok(false);
        }
    }
    if let Some(include) = find_directive(directives, "include") {
        if directive_if(include)? == Some(false) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The coerced `if:` argument of `@skip`/`@include` with no runtime values.
fn directive_if(directive: &Directive) -> Result<Option<bool>, String> {
    let Some(argument) = directive.argument("if") else {
        return Err("Argument \"if\" of required type \"Boolean!\" was not provided.".to_string());
    };
    match &argument.value {
        Value::BooleanValue { value, .. } => Ok(Some(*value)),
        Value::NullValue { .. } => {
            Err("Argument \"if\" of non-null type \"Boolean!\" must not be null.".to_string())
        }
        Value::Variable(variable) => Err(format!(
            "Argument \"if\" of required type \"Boolean!\" was provided the variable \"${}\" which was not provided a runtime value.",
            variable.name.value
        )),
        other => Err(format!(
            "Argument \"if\" has invalid value {}.",
            print_literal(other)
        )),
    }
}

// ---------------------------------------------------------------------------
// `OverlappingFieldsCanBeMergedRule`
// ---------------------------------------------------------------------------

/// One `[parentType, node, fieldDef]` entry of the rule's field map.
#[derive(Clone)]
struct OverlapField<'a> {
    /// The index of the document the field node was parsed from, so a conflict that
    /// crosses files still reports its own `loc.source`.
    source: usize,
    /// The composite type the field was collected under, when the rule knows one.
    parent_type: Option<String>,
    /// The field node.
    node: &'a Field,
    /// `parentType.getFields()[fieldName]`, absent for `__typename`, an unknown
    /// field and any parent the rule cannot resolve to an object or interface.
    def: Option<FieldDef>,
}

/// The fields and fragment names one selection set collects.
///
/// `order` is `Object.entries`' order: GraphQL names are never integer-like, so
/// JavaScript enumerates them in insertion order and the conflict order (and so the
/// diagnostic order) follows the source.
#[derive(Default)]
struct OverlapFieldMap<'a> {
    /// The response names, in first-seen order.
    order: Vec<String>,
    /// Response name to the fields that provide it, in source order.
    fields: HashMap<String, Vec<OverlapField<'a>>>,
    /// The fragment names spread in the set, in first-seen order.
    fragment_names: Vec<String>,
}

/// A conflict's reason: a message, or the subfield conflicts that produced it
/// (`reasonMessage`).
enum OverlapReason {
    /// A leaf message.
    Simple(String),
    /// `(response name, sub-reason)` pairs, in the order they were found.
    Subfields(Vec<(String, OverlapReason)>),
}

/// One conflict, with the first node it reported: `error.locations[0]` is always
/// `fields1[0]`, because every node in the list carries a location.
struct OverlapConflict<'a> {
    /// The response name the fields share.
    response_name: String,
    /// Why they conflict.
    reason: OverlapReason,
    /// The first field of the comparison.
    node: &'a Field,
    /// The document the first field was parsed from.
    source: usize,
}

/// `OverlappingFieldsCanBeMergedRule`'s state for one document: the field/fragment
/// cache (`cachedFieldsAndFragmentNames`) plus the two pair memos that make the
/// pairwise walk terminate on fragment cycles.
#[derive(Default)]
struct OverlapState<'a> {
    /// Selection set address to its index in `field_maps`.
    cached: HashMap<usize, usize>,
    /// The cached field maps, in creation order.
    field_maps: Vec<OverlapFieldMap<'a>>,
    /// `(field map, fragment name)` to the exclusivity it was compared with.
    compared_fields_and_fragment: HashMap<(usize, String), bool>,
    /// `(fragment name, fragment name)`, ordered, to the exclusivity it was
    /// compared with.
    compared_fragments: HashMap<(String, String), bool>,
}

impl<'a> OverlapState<'a> {
    /// `findConflictsWithinSelectionSet`: every conflict of one selection set,
    /// including the ones reached through its spread fragments.
    fn find_conflicts_within_selection_set(
        &mut self,
        view: &'a SchemaView<'a>,
        fragments: &HashMap<String, (&'a FragmentNode, usize)>,
        parent_type: Option<String>,
        set: &'a SelectionSet,
        source: usize,
    ) -> Vec<OverlapConflict<'a>> {
        let mut conflicts = Vec::new();
        let field_map = self.get_fields_and_fragment_names(view, parent_type, set, source);
        self.collect_conflicts_within(view, fragments, field_map, &mut conflicts);

        let names = self.field_maps[field_map].fragment_names.clone();
        if !names.is_empty() {
            for i in 0..names.len() {
                let name = names[i].clone();
                self.collect_conflicts_between_fields_and_fragment(
                    view,
                    fragments,
                    false,
                    field_map,
                    &name,
                    &mut conflicts,
                );
                for other in names.iter().skip(i + 1) {
                    self.collect_conflicts_between_fragments(
                        view,
                        fragments,
                        false,
                        &name,
                        other,
                        &mut conflicts,
                    );
                }
            }
        }
        conflicts
    }

    /// `collectConflictsBetweenFieldsAndFragment`.
    fn collect_conflicts_between_fields_and_fragment(
        &mut self,
        view: &'a SchemaView<'a>,
        fragments: &HashMap<String, (&'a FragmentNode, usize)>,
        exclusive: bool,
        field_map: usize,
        fragment_name: &str,
        conflicts: &mut Vec<OverlapConflict<'a>>,
    ) {
        if self.fields_and_fragment_compared(field_map, fragment_name, exclusive) {
            return;
        }
        self.compared_fields_and_fragment
            .insert((field_map, fragment_name.to_string()), exclusive);
        let Some((fragment, source)) = fragments.get(fragment_name).copied() else {
            return;
        };
        let other = self.get_referenced_fields_and_fragment_names(view, fragment, source);
        // Do not compare a fragment's field map to itself.
        if field_map == other {
            return;
        }
        self.collect_conflicts_between(view, fragments, exclusive, field_map, other, conflicts);
        let names = self.field_maps[other].fragment_names.clone();
        for name in names {
            self.collect_conflicts_between_fields_and_fragment(
                view,
                fragments,
                exclusive,
                field_map,
                &name,
                conflicts,
            );
        }
    }

    /// `collectConflictsBetweenFragments`.
    fn collect_conflicts_between_fragments(
        &mut self,
        view: &'a SchemaView<'a>,
        fragments: &HashMap<String, (&'a FragmentNode, usize)>,
        exclusive: bool,
        name1: &str,
        name2: &str,
        conflicts: &mut Vec<OverlapConflict<'a>>,
    ) {
        if name1 == name2 {
            return;
        }
        let key = if name1 < name2 {
            (name1.to_string(), name2.to_string())
        } else {
            (name2.to_string(), name1.to_string())
        };
        match self.compared_fragments.get(&key).copied() {
            Some(stored) if exclusive || !stored => return,
            _ => {}
        }
        self.compared_fragments.insert(key, exclusive);
        let Some((fragment1, source1)) = fragments.get(name1).copied() else {
            return;
        };
        let Some((fragment2, source2)) = fragments.get(name2).copied() else {
            return;
        };
        let map1 = self.get_referenced_fields_and_fragment_names(view, fragment1, source1);
        let map2 = self.get_referenced_fields_and_fragment_names(view, fragment2, source2);
        self.collect_conflicts_between(view, fragments, exclusive, map1, map2, conflicts);

        let names2 = self.field_maps[map2].fragment_names.clone();
        for name in names2 {
            self.collect_conflicts_between_fragments(view, fragments, exclusive, name1, &name, conflicts);
        }
        let names1 = self.field_maps[map1].fragment_names.clone();
        for name in names1 {
            self.collect_conflicts_between_fragments(view, fragments, exclusive, &name, name2, conflicts);
        }
    }

    /// `findConflictsBetweenSubSelectionSets`: the comparison of two overlapping
    /// fields' own selection sets.
    #[allow(clippy::too_many_arguments)]
    fn find_conflicts_between_sub_selection_sets(
        &mut self,
        view: &'a SchemaView<'a>,
        fragments: &HashMap<String, (&'a FragmentNode, usize)>,
        exclusive: bool,
        parent1: Option<String>,
        set1: &'a SelectionSet,
        source1: usize,
        parent2: Option<String>,
        set2: &'a SelectionSet,
        source2: usize,
    ) -> Vec<OverlapConflict<'a>> {
        let mut conflicts = Vec::new();
        let map1 = self.get_fields_and_fragment_names(view, parent1, set1, source1);
        let map2 = self.get_fields_and_fragment_names(view, parent2, set2, source2);
        self.collect_conflicts_between(view, fragments, exclusive, map1, map2, &mut conflicts);

        let names2 = self.field_maps[map2].fragment_names.clone();
        for name in &names2 {
            self.collect_conflicts_between_fields_and_fragment(
                view,
                fragments,
                exclusive,
                map1,
                name,
                &mut conflicts,
            );
        }
        let names1 = self.field_maps[map1].fragment_names.clone();
        for name in &names1 {
            self.collect_conflicts_between_fields_and_fragment(
                view,
                fragments,
                exclusive,
                map2,
                name,
                &mut conflicts,
            );
        }
        for name1 in &names1 {
            for name2 in &names2 {
                self.collect_conflicts_between_fragments(
                    view,
                    fragments,
                    exclusive,
                    name1,
                    name2,
                    &mut conflicts,
                );
            }
        }
        conflicts
    }

    /// `collectConflictsWithin`: every pair of fields that share a response name.
    fn collect_conflicts_within(
        &mut self,
        view: &'a SchemaView<'a>,
        fragments: &HashMap<String, (&'a FragmentNode, usize)>,
        field_map: usize,
        conflicts: &mut Vec<OverlapConflict<'a>>,
    ) {
        for response in self.field_maps[field_map].order.clone() {
            let fields = self.field_maps[field_map].fields.get(&response).cloned().unwrap_or_default();
            if fields.len() <= 1 {
                continue;
            }
            for i in 0..fields.len() {
                for j in (i + 1)..fields.len() {
                    if let Some(conflict) =
                        self.find_conflict(view, fragments, false, &response, &fields[i], &fields[j])
                    {
                        conflicts.push(conflict);
                    }
                }
            }
        }
    }

    /// `collectConflictsBetween`: the same comparison across two field maps.
    fn collect_conflicts_between(
        &mut self,
        view: &'a SchemaView<'a>,
        fragments: &HashMap<String, (&'a FragmentNode, usize)>,
        exclusive: bool,
        map1: usize,
        map2: usize,
        conflicts: &mut Vec<OverlapConflict<'a>>,
    ) {
        for response in self.field_maps[map1].order.clone() {
            let fields1 = self.field_maps[map1].fields.get(&response).cloned().unwrap_or_default();
            let Some(fields2) = self.field_maps[map2].fields.get(&response).cloned() else {
                continue;
            };
            for field1 in &fields1 {
                for field2 in &fields2 {
                    if let Some(conflict) =
                        self.find_conflict(view, fragments, exclusive, &response, field1, field2)
                    {
                        conflicts.push(conflict);
                    }
                }
            }
        }
    }

    /// `findConflict`: whether two fields that share a response name conflict.
    #[allow(clippy::too_many_arguments)]
    fn find_conflict(
        &mut self,
        view: &'a SchemaView<'a>,
        fragments: &HashMap<String, (&'a FragmentNode, usize)>,
        parent_exclusive: bool,
        response: &str,
        field1: &OverlapField<'a>,
        field2: &OverlapField<'a>,
    ) -> Option<OverlapConflict<'a>> {
        // Two parent types that can never apply at the same time may diverge in
        // field and arguments. Only two *object* types are known to be disjoint:
        // interfaces and unions may overlap in a future schema version.
        let exclusive = parent_exclusive
            || (field1.parent_type != field2.parent_type
                && field1
                    .parent_type
                    .as_deref()
                    .is_some_and(|name| view.kind(name) == Some(SchemaTypeKind::Object))
                && field2
                    .parent_type
                    .as_deref()
                    .is_some_and(|name| view.kind(name) == Some(SchemaTypeKind::Object)));

        if !exclusive {
            let name1 = &field1.node.name.value;
            let name2 = &field2.node.name.value;
            if name1 != name2 {
                return Some(OverlapConflict {
                    response_name: response.to_string(),
                    reason: OverlapReason::Simple(format!(
                        "\"{name1}\" and \"{name2}\" are different fields"
                    )),
                    node: field1.node,
                    source: field1.source,
                });
            }
            if !same_arguments(field1.node, field2.node) {
                return Some(OverlapConflict {
                    response_name: response.to_string(),
                    reason: OverlapReason::Simple("they have differing arguments".to_string()),
                    node: field1.node,
                    source: field1.source,
                });
            }
        }

        let type1 = field1.def.as_ref().map(|def| def.type_node.clone());
        let type2 = field2.def.as_ref().map(|def| def.type_node.clone());
        if let (Some(type1), Some(type2)) = (&type1, &type2) {
            if overlap_types_conflict(view, type1, type2) {
                return Some(OverlapConflict {
                    response_name: response.to_string(),
                    reason: OverlapReason::Simple(format!(
                        "they return conflicting types \"{}\" and \"{}\"",
                        type1.to_type_string(),
                        type2.to_type_string()
                    )),
                    node: field1.node,
                    source: field1.source,
                });
            }
        }

        let (Some(set1), Some(set2)) =
            (field1.node.selection_set.as_ref(), field2.node.selection_set.as_ref())
        else {
            return None;
        };
        let parent1 = type1.as_ref().map(|node| node.named_type().name.value.clone());
        let parent2 = type2.as_ref().map(|node| node.named_type().name.value.clone());
        let conflicts = self.find_conflicts_between_sub_selection_sets(
            view,
            fragments,
            exclusive,
            parent1,
            set1,
            field1.source,
            parent2,
            set2,
            field2.source,
        );
        subfield_conflicts(conflicts, response, field1.node, field1.source)
    }

    /// `getFieldsAndFragmentNames`, cached by selection set identity.
    fn get_fields_and_fragment_names(
        &mut self,
        view: &'a SchemaView<'a>,
        parent_type: Option<String>,
        set: &'a SelectionSet,
        source: usize,
    ) -> usize {
        let key = std::ptr::from_ref(set) as usize;
        if let Some(index) = self.cached.get(&key).copied() {
            return index;
        }
        let mut map = OverlapFieldMap::default();
        collect_overlap_fields(view, source, parent_type.as_deref(), set, &mut map);
        let index = self.field_maps.len();
        self.field_maps.push(map);
        self.cached.insert(key, index);
        index
    }

    /// `getReferencedFieldsAndFragmentNames`, cached by the fragment's selection set.
    fn get_referenced_fields_and_fragment_names(
        &mut self,
        view: &'a SchemaView<'a>,
        fragment: &'a FragmentNode,
        source: usize,
    ) -> usize {
        let key = std::ptr::from_ref(&fragment.selection_set) as usize;
        if let Some(index) = self.cached.get(&key).copied() {
            return index;
        }
        let parent_type = type_from_ast(view, &TypeNode::Named(fragment.type_condition.clone()))
            .map(|node| node.named_type().name.value.clone());
        self.get_fields_and_fragment_names(view, parent_type, &fragment.selection_set, source)
    }

    /// `OrderedPairSet.has(fieldMap, fragmentName, weaklyPresent)`.
    fn fields_and_fragment_compared(&self, field_map: usize, fragment: &str, weak: bool) -> bool {
        match self.compared_fields_and_fragment.get(&(field_map, fragment.to_string())) {
            None => false,
            Some(&stored) => weak || !stored,
        }
    }
}

/// `_collectFieldsAndFragmentNames`: the fields of a selection set, inline fragments
/// flattened into it, plus the fragment names it spreads.
fn collect_overlap_fields<'a>(
    view: &SchemaView<'_>,
    source: usize,
    parent_type: Option<&str>,
    set: &'a SelectionSet,
    map: &mut OverlapFieldMap<'a>,
) {
    for selection in &set.selections {
        match selection {
            Selection::Field(node) => {
                let def = parent_type
                    .filter(|name| {
                        matches!(
                            view.kind(name),
                            Some(SchemaTypeKind::Object | SchemaTypeKind::Interface)
                        )
                    })
                    .and_then(|name| view.field_def(name, &node.name.value).cloned());
                let response = node.response_key().to_string();
                if !map.fields.contains_key(&response) {
                    map.order.push(response.clone());
                }
                map.fields.entry(response).or_default().push(OverlapField {
                    source,
                    parent_type: parent_type.map(str::to_string),
                    node,
                    def,
                });
            }
            Selection::FragmentSpread(node) => {
                if !map.fragment_names.iter().any(|name| name == &node.name.value) {
                    map.fragment_names.push(node.name.value.clone());
                }
            }
            Selection::InlineFragment(node) => {
                let condition = match &node.type_condition {
                    Some(condition) => type_from_ast(view, &TypeNode::Named(condition.clone()))
                        .map(|node| node.named_type().name.value.clone()),
                    None => parent_type.map(str::to_string),
                };
                collect_overlap_fields(view, source, condition.as_deref(), &node.selection_set, map);
            }
        }
    }
}

/// `subfieldConflicts`.
fn subfield_conflicts<'a>(
    conflicts: Vec<OverlapConflict<'a>>,
    response: &str,
    node: &'a Field,
    source: usize,
) -> Option<OverlapConflict<'a>> {
    if conflicts.is_empty() {
        return None;
    }
    Some(OverlapConflict {
        response_name: response.to_string(),
        reason: OverlapReason::Subfields(
            conflicts.into_iter().map(|conflict| (conflict.response_name, conflict.reason)).collect(),
        ),
        node,
        source,
    })
}

/// `reasonMessage`.
fn overlap_reason_message(reason: &OverlapReason) -> String {
    match reason {
        OverlapReason::Simple(message) => message.clone(),
        OverlapReason::Subfields(entries) => entries
            .iter()
            .map(|(response, sub)| {
                format!("subfields \"{response}\" conflict because {}", overlap_reason_message(sub))
            })
            .collect::<Vec<String>>()
            .join(" and "),
    }
}

/// `sameArguments`: the two fields carry the same arguments, compared by their
/// sorted printed values (`sortValueNode` + `print`).
fn same_arguments(node1: &Field, node2: &Field) -> bool {
    let args1 = &node1.arguments;
    let args2 = &node2.arguments;
    if args1.is_empty() {
        return args2.is_empty();
    }
    if args2.is_empty() || args1.len() != args2.len() {
        return false;
    }
    // `new Map(args2.map(…))`: a duplicated argument name keeps its *last* value.
    let mut values2: HashMap<&str, &Value> = HashMap::new();
    for arg2 in args2 {
        values2.insert(arg2.name.value.as_str(), &arg2.value);
    }
    for arg1 in args1 {
        let Some(value2) = values2.get(arg1.name.value.as_str()) else {
            return false;
        };
        if stringify_value(&arg1.value) != stringify_value(value2) {
            return false;
        }
    }
    true
}

/// `stringifyValue`: `print(sortValueNode(value))`.
fn stringify_value(value: &Value) -> String {
    print_literal(&sort_value_node(value))
}

/// `sortValueNode`: object fields sorted by name (`naturalCompare`), recursively.
fn sort_value_node(value: &Value) -> Value {
    match value {
        Value::ObjectValue { fields, loc } => {
            let mut sorted: Vec<ObjectField> = fields
                .iter()
                .map(|field| ObjectField {
                    name: field.name.clone(),
                    value: sort_value_node(&field.value),
                    loc: field.loc,
                })
                .collect();
            sorted.sort_by(|left, right| natural_compare(&left.name.value, &right.name.value));
            Value::ObjectValue { fields: sorted, loc: *loc }
        }
        Value::ListValue { values, loc } => Value::ListValue {
            values: values.iter().map(sort_value_node).collect(),
            loc: *loc,
        },
        other => other.clone(),
    }
}

/// `doTypesConflict`: two types that cannot both apply to one value. Composite
/// types never conflict here; their fields are compared recursively instead.
fn overlap_types_conflict(view: &SchemaView<'_>, type1: &TypeNode, type2: &TypeNode) -> bool {
    match (type1, type2) {
        (TypeNode::List(inner1), TypeNode::List(inner2)) => {
            overlap_types_conflict(view, &inner1.type_node, &inner2.type_node)
        }
        (TypeNode::List(_), _) | (_, TypeNode::List(_)) => true,
        (TypeNode::NonNull(inner1), TypeNode::NonNull(inner2)) => {
            overlap_types_conflict(view, &inner1.type_node, &inner2.type_node)
        }
        (TypeNode::NonNull(_), _) | (_, TypeNode::NonNull(_)) => true,
        (TypeNode::Named(named1), TypeNode::Named(named2)) => {
            (view.is_leaf(&named1.name.value) || view.is_leaf(&named2.name.value))
                && named1.name.value != named2.name.value
        }
    }
}

// ---------------------------------------------------------------------------
// `assertValidSchema` (`graphql/type/validate.js`)
// ---------------------------------------------------------------------------

/// `Name "…" must not begin with "__", which is reserved by GraphQL introspection.`
fn reserved_name_message(name: &str) -> String {
    format!("Name \"{name}\" must not begin with \"__\", which is reserved by GraphQL introspection.")
}

/// `validateSchema(schema)`, as the list of messages `assertValidSchema` joins with
/// `\n\n` and throws.
///
/// `validate()` runs this before the rules, once per document; the oracle catches the
/// throw and reports `FLM2002 Invalid schema: <messages>` at the document's
/// definition. Only the messages are needed, so no node locations are tracked.
///
/// The type walk follows `getTypeMap()`'s order. Every SDL type is in the type map
/// and `collectReferencedTypes` never moves a type that is already collected, so
/// that order is the document's own type-definition order; the built-in scalars and
/// the introspection types are the only additions, and neither can produce an error.
fn schema_validation_errors(view: &SchemaView<'_>) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    validate_root_types(view, &mut errors);
    validate_directive_definitions(view, &mut errors);
    validate_schema_types(view, &mut errors);
    errors
}

/// `validateRootTypes`.
fn validate_root_types(view: &SchemaView<'_>, errors: &mut Vec<String>) {
    match &view.query_type {
        None => errors.push("Query root type must be provided.".to_string()),
        Some(name) if view.kind(name) != Some(SchemaTypeKind::Object) => errors.push(format!(
            "Query root type must be Object type, it cannot be {name}."
        )),
        Some(_) => {}
    }
    if let Some(name) = &view.mutation_type {
        if view.kind(name) != Some(SchemaTypeKind::Object) {
            errors.push(format!(
                "Mutation root type must be Object type if provided, it cannot be {name}."
            ));
        }
    }
    if let Some(name) = &view.subscription_type {
        if view.kind(name) != Some(SchemaTypeKind::Object) {
            errors.push(format!(
                "Subscription root type must be Object type if provided, it cannot be {name}."
            ));
        }
    }
}

/// `validateDirectives`, over the SDL's own directive definitions in document order
/// (the compiler's merged and specified directives cannot fail these checks, and
/// graphql-js keeps a user redefinition in place of a specified one).
fn validate_directive_definitions(view: &SchemaView<'_>, errors: &mut Vec<String>) {
    for definition in &view.schema.document.definitions {
        let crate::graphql::ast::TypeSystemDefinition::Directive(node) = definition else {
            continue;
        };
        if node.is_extension {
            continue;
        }
        let name = node.name.value.clone();
        if name.starts_with("__") {
            errors.push(reserved_name_message(&name));
        }
        let definition = directive_def(node);
        if definition.locations.is_empty() {
            errors.push(format!("Directive @{name} must include 1 or more locations."));
        }
        for arg in &definition.args {
            if arg.name.starts_with("__") {
                errors.push(reserved_name_message(&arg.name));
            }
            if !view.is_input_type(&arg.type_node) {
                errors.push(format!(
                    "The type of @{name}({}:) must be Input Type but got: {}.",
                    arg.name,
                    arg.type_node.to_type_string()
                ));
            }
            if is_required_argument(arg) && arg.deprecated.is_some() {
                errors.push(format!("Required argument @{name}({}:) cannot be deprecated.", arg.name));
            }
        }
    }
}

/// `validateTypes`, in type-map order.
fn validate_schema_types(view: &SchemaView<'_>, errors: &mut Vec<String>) {
    let mut circular = InputObjectCircularRefs::default();
    for definition in &view.schema.document.definitions {
        let crate::graphql::ast::TypeSystemDefinition::Type(node) = definition else {
            continue;
        };
        if node.is_extension() {
            continue;
        }
        let name = node.name().to_string();
        // A name `extendSchema` resolves through its `stdTypeMap` never becomes the
        // user's type, and introspection types opt out of `validateName`.
        if is_specified_scalar(&name) || introspection_kind(&name).is_some() {
            continue;
        }
        if name.starts_with("__") {
            errors.push(reserved_name_message(&name));
        }
        match view.kind(&name) {
            Some(SchemaTypeKind::Object | SchemaTypeKind::Interface) => {
                validate_fields(view, &name, errors);
                validate_interfaces(view, &name, errors);
            }
            Some(SchemaTypeKind::Union) => validate_union_members(view, &name, errors),
            Some(SchemaTypeKind::Enum) => validate_enum_values(view, &name, errors),
            Some(SchemaTypeKind::InputObject) => {
                validate_input_fields(view, &name, errors);
                circular.detect(view, &name, errors);
            }
            _ => {}
        }
    }
}

/// `validateFields`: objects and interfaces must define fields, and every field and
/// argument must be named and typed correctly.
fn validate_fields(view: &SchemaView<'_>, name: &str, errors: &mut Vec<String>) {
    let fields = view.fields.get(name).cloned().unwrap_or_default();
    if fields.is_empty() {
        errors.push(format!("Type {name} must define one or more fields."));
    }
    for field in &fields {
        if field.name.starts_with("__") {
            errors.push(reserved_name_message(&field.name));
        }
        if !view.is_output_type(&field.type_node) {
            errors.push(format!(
                "The type of {name}.{} must be Output Type but got: {}.",
                field.name,
                field.type_node.to_type_string()
            ));
        }
        for arg in &field.args {
            if arg.name.starts_with("__") {
                errors.push(reserved_name_message(&arg.name));
            }
            if !view.is_input_type(&arg.type_node) {
                errors.push(format!(
                    "The type of {name}.{}({}:) must be Input Type but got: {}.",
                    field.name,
                    arg.name,
                    arg.type_node.to_type_string()
                ));
            }
            if is_required_argument(arg) && arg.deprecated.is_some() {
                errors.push(format!(
                    "Required argument {name}.{}({}:) cannot be deprecated.",
                    field.name, arg.name
                ));
            }
        }
    }
}

/// `validateInterfaces`: an object or interface may only implement interfaces, once
/// each, with the ancestors and the fields the interface declares.
fn validate_interfaces(view: &SchemaView<'_>, name: &str, errors: &mut Vec<String>) {
    let interfaces = view.interfaces.get(name).cloned().unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    for iface in &interfaces {
        if view.kind(iface) != Some(SchemaTypeKind::Interface) {
            errors.push(format!(
                "Type {name} must only implement Interface types, it cannot implement {iface}."
            ));
            continue;
        }
        if iface == name {
            errors.push(format!(
                "Type {name} cannot implement itself because it would create a circular reference."
            ));
            continue;
        }
        if !seen.insert(iface.clone()) {
            errors.push(format!("Type {name} can only implement {iface} once."));
            continue;
        }
        // `validateTypeImplementsAncestors`.
        for transitive in view.interfaces.get(iface).cloned().unwrap_or_default() {
            if interfaces.contains(&transitive) {
                continue;
            }
            if transitive == name {
                errors.push(format!(
                    "Type {name} cannot implement {iface} because it would create a circular reference."
                ));
            } else {
                errors.push(format!(
                    "Type {name} must implement {transitive} because it is implemented by {iface}."
                ));
            }
        }
        validate_type_implements_interface(view, name, iface, errors);
    }
}

/// `validateTypeImplementsInterface`: field presence, covariant field types, argument
/// presence and invariant argument types, and no extra required arguments.
fn validate_type_implements_interface(
    view: &SchemaView<'_>,
    name: &str,
    iface: &str,
    errors: &mut Vec<String>,
) {
    let type_fields = view.fields.get(name).cloned().unwrap_or_default();
    let iface_fields = view.fields.get(iface).cloned().unwrap_or_default();
    for iface_field in &iface_fields {
        let field_name = &iface_field.name;
        let Some(type_field) = type_fields.iter().find(|field| &field.name == field_name) else {
            errors.push(format!(
                "Interface field {iface}.{field_name} expected but {name} does not provide it."
            ));
            continue;
        };
        if !is_type_sub_type_of(view, &type_field.type_node, &iface_field.type_node) {
            errors.push(format!(
                "Interface field {iface}.{field_name} expects type {} but {name}.{field_name} is type {}.",
                iface_field.type_node.to_type_string(),
                type_field.type_node.to_type_string()
            ));
        }
        for iface_arg in &iface_field.args {
            let arg_name = &iface_arg.name;
            let Some(type_arg) = type_field.args.iter().find(|arg| &arg.name == arg_name) else {
                errors.push(format!(
                    "Interface field argument {iface}.{field_name}({arg_name}:) expected but {name}.{field_name} does not provide it."
                ));
                continue;
            };
            if !same_type_ref(&iface_arg.type_node, &type_arg.type_node) {
                errors.push(format!(
                    "Interface field argument {iface}.{field_name}({arg_name}:) expects type {} but {name}.{field_name}({arg_name}:) is type {}.",
                    iface_arg.type_node.to_type_string(),
                    type_arg.type_node.to_type_string()
                ));
            }
        }
        for type_arg in &type_field.args {
            let arg_name = &type_arg.name;
            let iface_arg = iface_field.args.iter().find(|arg| &arg.name == arg_name);
            if iface_arg.is_none() && is_required_argument(type_arg) {
                errors.push(format!(
                    "Object field {name}.{field_name} includes required argument {arg_name} that is missing from the Interface field {iface}.{field_name}."
                ));
            }
        }
    }
}

/// `validateUnionMembers`.
fn validate_union_members(view: &SchemaView<'_>, name: &str, errors: &mut Vec<String>) {
    let members = view.unions.get(name).cloned().unwrap_or_default();
    if members.is_empty() {
        errors.push(format!("Union type {name} must define one or more member types."));
    }
    let mut seen: HashSet<String> = HashSet::new();
    for member in &members {
        if !seen.insert(member.clone()) {
            errors.push(format!("Union type {name} can only include type {member} once."));
            continue;
        }
        if view.kind(member) != Some(SchemaTypeKind::Object) {
            errors.push(format!(
                "Union type {name} can only include Object types, it cannot include {member}."
            ));
        }
    }
}

/// `validateEnumValues`.
fn validate_enum_values(view: &SchemaView<'_>, name: &str, errors: &mut Vec<String>) {
    let values = view.enum_values.get(name).cloned().unwrap_or_default();
    if values.is_empty() {
        errors.push(format!("Enum type {name} must define one or more values."));
    }
    for value in &values {
        if value.starts_with("__") {
            errors.push(reserved_name_message(value));
        }
    }
}

/// `validateInputFields`, including the `@oneOf` rules.
fn validate_input_fields(view: &SchemaView<'_>, name: &str, errors: &mut Vec<String>) {
    let fields = view.input_fields.get(name).cloned().unwrap_or_default();
    if fields.is_empty() {
        errors.push(format!("Input Object type {name} must define one or more fields."));
    }
    let one_of = view.one_of.contains(name);
    for field in &fields {
        if field.name.starts_with("__") {
            errors.push(reserved_name_message(&field.name));
        }
        if !view.is_input_type(&field.type_node) {
            errors.push(format!(
                "The type of {name}.{} must be Input Type but got: {}.",
                field.name,
                field.type_node.to_type_string()
            ));
        }
        if is_required_input_field(field) && field.deprecated.is_some() {
            errors.push(format!("Required input field {name}.{} cannot be deprecated.", field.name));
        }
        if one_of && matches!(field.type_node, TypeNode::NonNull(_)) {
            errors.push(format!("OneOf input field {name}.{} must be nullable.", field.name));
        }
        if one_of && field.default_value.is_some() {
            errors.push(format!(
                "OneOf input field {name}.{} cannot have a default value.",
                field.name
            ));
        }
    }
}

/// `createInputObjectCircularRefsValidator`: input objects that reach themselves
/// through a series of non-null fields. The state is shared across the whole type
/// walk, so a cycle is reported once, from the first member visited.
#[derive(Default)]
struct InputObjectCircularRefs {
    /// The input objects already walked.
    visited: HashSet<String>,
    /// The non-null field names on the current path.
    field_path: Vec<String>,
    /// The path position each input object on the path was entered at.
    path_index: HashMap<String, usize>,
}

impl InputObjectCircularRefs {
    /// `detectCycleRecursive`.
    fn detect(&mut self, view: &SchemaView<'_>, name: &str, errors: &mut Vec<String>) {
        if self.visited.contains(name) {
            return;
        }
        self.visited.insert(name.to_string());
        let index = self.field_path.len();
        self.path_index.insert(name.to_string(), index);
        for field in view.input_fields.get(name).cloned().unwrap_or_default() {
            let TypeNode::NonNull(inner) = &field.type_node else {
                continue;
            };
            let field_type = inner.type_node.named_type().name.value.clone();
            if view.kind(&field_type) != Some(SchemaTypeKind::InputObject) {
                continue;
            }
            let cycle_index = self.path_index.get(&field_type).copied();
            self.field_path.push(field.name.clone());
            match cycle_index {
                None => self.detect(view, &field_type, errors),
                Some(cycle_index) => {
                    let path = self.field_path[cycle_index..].join(".");
                    errors.push(format!(
                        "Cannot reference Input Object \"{field_type}\" within itself through a series of non-null fields: \"{path}\"."
                    ));
                }
            }
            self.field_path.pop();
        }
        self.path_index.remove(name);
    }
}

/// Runs both reference-validation passes over one document.
fn run_validation<'a>(
    view: &'a SchemaView<'a>,
    document: &'a ValidationDocument<'a>,
) -> Result<(Vec<GqlError>, Vec<GqlError>), String> {
    let mut rules = Validator::new(view, document, Pass::Rules);
    rules.run()?;
    let mut deprecations = Validator::new(view, document, Pass::Deprecations);
    deprecations.run()?;
    Ok((rules.errors, deprecations.errors))
}
