//! Fragment pagination documents (research §3).
//!
//! A fragment that owns a `@paginate` field cannot page itself: a fragment has no
//! request of its own. Houdini therefore generates two things for it
//! (`packages/houdini-core/plugin/lists/paginationDocuments.go:566-713, 856-864`):
//!
//! - an internal clone of the fragment, `<FragmentName>_paginated`, whose paginated
//!   field carries the page arguments as the canonical page **variables**; and
//! - a companion **query**, `<FragmentName>_Pagination_Query`, that re-resolves the
//!   fragment's owner record by key (`node(id: $id) { ... on T { ... } }` for a
//!   `Node` type) and spreads the clone, so that query is what a page request sends.
//!
//! The clone is `internal`: it gets no artifact of its own, and its printed text is
//! folded into the companion's `raw`. The companion's `refetch.path` drops its first
//! element, because the fragment's own data has no wrapper field
//! (`documents/artifacts/selection.go:366-375`).
//!
//! The companion is generated for every fragment with a `@paginate` field, spread or
//! not, and its name depends only on the fragment's name, so several spreads of one
//! fragment share one companion.

use crate::config::RustConfig;
use crate::contract::ArtifactKind;
use crate::diagnostics::{Diagnostic, DiagnosticInput, Severity, SourceLocation};
use crate::extract::{DocumentSurface, RawDocument};
use crate::graphql::ast::{
    Argument, Definition, Field, FragmentDefinition, Name, Selection, SelectionSet, Value, Variable,
};
use crate::graphql::print_value;
use crate::ir::{print_companion_clone, PaginatedField};
use crate::offsets::{Offset, SourceText};
use crate::paginate::{is_page_argument, page_argument_type, CURSOR_ARGUMENTS, OFFSET_ARGUMENTS};
use crate::schema::{type_ref_string, SchemaIndex};
use crate::validate::{DocumentIndex, FragmentDefinition as IndexedFragment};

/// The companion query's name suffix (`graphql.PaginationQuerySuffix`).
pub const PAGINATION_QUERY_SUFFIX: &str = "_Pagination_Query";

/// The internal clone's name suffix.
pub const PAGINATED_SUFFIX: &str = "_paginated";

/// The wrapper field a non-operation type condition is resolved through.
pub const NODE_FIELD: &str = "node";

/// One synthesized companion: the fragment it belongs to, the clone's name and the
/// query document itself.
#[derive(Clone)]
pub struct Companion {
    /// The fragment whose `@paginate` field the companion pages.
    pub fragment: String,
    /// The internal clone's name (`<fragment>_paginated`).
    pub clone: String,
    /// The companion query document.
    pub document: RawDocument,
}

/// What one fragment pagination pass produced: the companions, the index extended
/// with their clones, and the companion documents in generation order.
pub struct CompanionSet {
    /// One entry per paginated fragment.
    pub companions: Vec<Companion>,
    /// The project index plus one fragment entry per clone.
    pub index: DocumentIndex,
    /// The companion documents, in the order `companions` holds them.
    pub documents: Vec<RawDocument>,
}

/// Builds one companion per fragment that owns a `@paginate` field.
pub fn build_companions(
    documents: &[RawDocument],
    index: &DocumentIndex,
    schema: &SchemaIndex,
    config: &RustConfig,
    diagnostics: &mut Vec<Diagnostic>,
) -> CompanionSet {
    let mut companions: Vec<Companion> = Vec::new();
    let mut extended = index.clone();
    let mut generated: Vec<RawDocument> = Vec::new();
    let list_fragments = crate::ir::list_fragment_names(extended.lists.keys().into_iter());
    for document in documents {
        if document.kind != ArtifactKind::Fragment {
            continue;
        }
        let Some(Definition::Fragment(node)) = document.ast.definitions.first() else {
            continue;
        };
        let pagination = paginated_fields(schema, config, node);
        if pagination.fields.is_empty() {
            continue;
        }
        let condition = node.type_condition.name.value.clone();
        let Some(entity) = resolve_entity(schema, &condition) else {
            diagnostics.push(companion_unresolvable(document, &condition, node));
            continue;
        };
        let clone = format!("{}{PAGINATED_SUFFIX}", node.name.value);
        let companion_name = format!("{}{PAGINATION_QUERY_SUFFIX}", node.name.value);
        let clone_node = clone_definition(node, &clone, &pagination.fields);
        let clone_text =
            print_companion_clone(&clone_node, schema, &pagination.specs, &list_fragments);
        let raw = companion_text(
            &companion_name,
            &clone,
            &condition,
            &entity,
            &pagination,
            &clone_text,
        );
        let ast = match crate::graphql::parse_document(&raw) {
            Ok(ast) => ast,
            Err(error) => {
                // a bug in the synthesis, not in the user's project: report it rather
                // than emit a document nobody can parse
                diagnostics.push(
                    DiagnosticInput::error(
                        "FLM2002",
                        format!(
                            "The generated pagination companion \"{companion_name}\" does not parse: {error}"
                        ),
                        SourceLocation::config(),
                    )
                    .build(),
                );
                continue;
            }
        };
        // The clone lives in the companion's own document, so the index entry points
        // there; the synthetic document list is `documents` plus `generated`.
        extended.fragments.insert(
            clone.clone(),
            IndexedFragment {
                name: clone.clone(),
                type_condition: condition.clone(),
                document: documents.len() + generated.len(),
                definition: 1,
            },
        );
        extended
            .spread_graph
            .insert(clone.clone(), spread_names(&clone_node.selection_set));
        let synthesized = RawDocument {
            name: companion_name,
            kind: ArtifactKind::Query,
            raw,
            file: document.file.clone(),
            // not a page document: route planning must never treat it as one
            relative_path: format!("{}{PAGINATION_QUERY_SUFFIX}", document.relative_path),
            surface: DocumentSurface::File,
            offset: 0,
            start: 0,
            end: 0 as Offset,
            source_offsets: Vec::new(),
            ast,
            source: SourceText::new(""),
        };
        generated.push(synthesized.clone());
        companions.push(Companion {
            fragment: node.name.value.clone(),
            clone,
            document: synthesized,
        });
    }
    CompanionSet {
        companions,
        index: extended,
        documents: generated,
    }
}

/// The diagnostic for a fragment whose owner record cannot be re-resolved.
///
/// Houdini's wording (`lists/validate.go:244-261`): the type condition must
/// implement `Node` or carry a `resolve_query`.
fn companion_unresolvable(
    document: &RawDocument,
    condition: &str,
    node: &FragmentDefinition,
) -> Diagnostic {
    DiagnosticInput {
        code: "FLM1047".into(),
        severity: Some(Severity::Error),
        message: format!(
            "Document \"{}\" uses @paginate but its type condition \"{condition}\" is invalid. It must either implement Node or have a type_configs entry with a valid resolve_query.",
            node.name.value
        ),
        location: SourceLocation {
            file: document.relative_path.clone(),
            line: 1,
            column: 1,
            length: 1,
        },
        related: None,
        hint: Some(format!(
            "make \"{condition}\" implement Node with an `id: ID!` field, or remove @paginate from the fragment"
        )),
    }
    .build()
}

/// The owner type's key field and the wrapper field that resolves it.
struct Entity {
    /// The wrapper field's name (`node`).
    field: String,
    /// The key field, which is also the variable name (`id`).
    key: String,
    /// The key field's GraphQL type, printed (`ID!`).
    key_type: String,
}

/// The entity resolution of a fragment's type condition, or `None` when the type
/// cannot be re-resolved from its keys alone.
fn resolve_entity(schema: &SchemaIndex, condition: &str) -> Option<Entity> {
    let keys = schema.key_fields_for_type(condition);
    if keys.len() != 1 || keys[0] != "id" {
        return None;
    }
    // Houdini: the condition is legal when it is a possible type of `Node`
    // (`lists/validate.go:210-266`); a configured `resolve_query` is the other half,
    // which Flamme's config does not carry yet.
    if !schema
        .possible_types_of("Node")
        .iter()
        .any(|name| name == condition)
    {
        return None;
    }
    // the wrapper has to be selectable, or the companion would be a document the
    // server rejects (`node(id: ID!): Node` on the query root)
    let query_type = crate::ir::root_type_of(ArtifactKind::Query, schema);
    schema.field_type(&query_type, NODE_FIELD)?;
    let field_type = schema.field_type(condition, "id")?;
    Some(Entity {
        field: NODE_FIELD.to_string(),
        key: "id".to_string(),
        key_type: type_ref_string(field_type),
    })
}

/// One paginated field of a fragment: its root-relative path, its strategy, and the
/// AST node the clone rewrites.
struct PaginatedInFragment<'a> {
    path: Vec<String>,
    method: &'static str,
    node: &'a Field,
}

/// The paginated fields of a fragment, with the specs the printer needs.
struct FragmentPagination<'a> {
    fields: Vec<PaginatedInFragment<'a>>,
    specs: Vec<PaginatedField>,
}

/// Walks a fragment's own selections for `@paginate` fields.
fn paginated_fields<'a>(
    schema: &SchemaIndex,
    config: &RustConfig,
    fragment: &'a FragmentDefinition,
) -> FragmentPagination<'a> {
    let mut fields: Vec<PaginatedInFragment<'a>> = Vec::new();
    collect_paginated(
        schema,
        config,
        &fragment.selection_set,
        &fragment.type_condition.name.value,
        &mut Vec::new(),
        &mut fields,
    );
    let specs = fields
        .iter()
        .map(|entry| PaginatedField {
            path: entry.path.clone(),
            mode: paginate_mode(entry.node, config),
            method: entry.method.to_string(),
            direction: "forward".to_string(),
            parent_type: fragment.type_condition.name.value.clone(),
            page_size: page_size_of(entry.node),
            // a fragment's pagination is embedded in whatever document reads it
            embedded: true,
        })
        .collect();
    FragmentPagination { fields, specs }
}

/// The recursive half of [`paginated_fields`].
fn collect_paginated<'a>(
    schema: &SchemaIndex,
    config: &RustConfig,
    selection_set: &'a SelectionSet,
    parent_type: &str,
    path: &mut Vec<String>,
    out: &mut Vec<PaginatedInFragment<'a>>,
) {
    for selection in &selection_set.selections {
        match selection {
            Selection::Field(field) => {
                let key = field.response_key().to_string();
                let named = schema
                    .field_type(parent_type, &field.name.value)
                    .map(|node| node.named_type().name.value.clone())
                    .unwrap_or_default();
                path.push(key);
                if field
                    .directives
                    .iter()
                    .any(|directive| directive.name.value == "paginate")
                {
                    out.push(PaginatedInFragment {
                        path: path.clone(),
                        method: if schema.field_type(&named, "edges").is_some() {
                            "cursor"
                        } else {
                            "offset"
                        },
                        node: field,
                    });
                }
                if let Some(nested) = &field.selection_set {
                    collect_paginated(schema, config, nested, &named, path, out);
                }
                path.pop();
            }
            Selection::InlineFragment(inline) => {
                let condition = inline
                    .type_condition
                    .as_ref()
                    .map(|condition| condition.name.value.clone())
                    .unwrap_or_else(|| parent_type.to_string());
                collect_paginated(schema, config, &inline.selection_set, &condition, path, out);
            }
            // a spread's own `@paginate` belongs to the fragment it names, which has
            // its own companion
            Selection::FragmentSpread(_) => {}
        }
    }
}

/// The mode a `@paginate` field resolves to.
fn paginate_mode(field: &Field, config: &RustConfig) -> String {
    field
        .directives
        .iter()
        .find(|directive| directive.name.value == "paginate")
        .and_then(|directive| directive.argument("mode"))
        .and_then(|argument| match &argument.value {
            Value::EnumValue { value, .. } => Some(value.clone()),
            _ => None,
        })
        .unwrap_or_else(|| config.default_paginate_mode.clone())
}

/// The page size a field applies: the `first`/`last`/`limit` literal, else 10.
fn page_size_of(field: &Field) -> i64 {
    for argument in &field.arguments {
        if !matches!(argument.name.value.as_str(), "first" | "last" | "limit") {
            continue;
        }
        if let Value::IntValue { value, .. } = &argument.value {
            return value.trim().parse::<i64>().unwrap_or(10);
        }
    }
    10
}

/// A copy of a fragment under a new name whose paginated fields bind the canonical
/// page variables (`paginationDocuments.go:647-672`).
fn clone_definition(
    fragment: &FragmentDefinition,
    clone: &str,
    fields: &[PaginatedInFragment<'_>],
) -> FragmentDefinition {
    let mut cloned = fragment.clone();
    cloned.name = Name::synthetic(clone);
    cloned.selection_set = rewrite_selection(&fragment.selection_set, &mut Vec::new(), fields);
    cloned
}

/// Rewrites the paginated fields of a cloned selection set to bind the page variables.
fn rewrite_selection(
    selection_set: &SelectionSet,
    path: &mut Vec<String>,
    fields: &[PaginatedInFragment<'_>],
) -> SelectionSet {
    let mut rewritten = selection_set.clone();
    for selection in &mut rewritten.selections {
        match selection {
            Selection::Field(field) => {
                path.push(field.response_key().to_string());
                if let Some(entry) = fields.iter().find(|entry| entry.path == *path) {
                    field.arguments = page_arguments(entry);
                }
                if let Some(nested) = &field.selection_set {
                    field.selection_set = Some(rewrite_selection(nested, path, fields));
                }
                path.pop();
            }
            Selection::InlineFragment(inline) => {
                inline.selection_set = rewrite_selection(&inline.selection_set, path, fields);
            }
            Selection::FragmentSpread(_) => {}
        }
    }
    rewritten
}

/// A paginated field's arguments with the page arguments bound to the canonical
/// page variables; every other argument is untouched.
fn page_arguments(entry: &PaginatedInFragment<'_>) -> Vec<Argument> {
    let mut arguments: Vec<Argument> = entry
        .node
        .arguments
        .iter()
        .filter(|argument| !is_page_argument(&argument.name.value, entry.method))
        .cloned()
        .collect();
    for name in page_variable_names(entry.method) {
        arguments.push(Argument {
            name: Name::synthetic(*name),
            value: Value::Variable(Variable {
                name: Name::synthetic(*name),
                loc: None,
            }),
            loc: None,
        });
    }
    arguments
}

/// The companion's text: the wrapper query plus the internal clone.
fn companion_text(
    name: &str,
    clone: &str,
    condition: &str,
    entity: &Entity,
    pagination: &FragmentPagination<'_>,
    clone_text: &str,
) -> String {
    let mut variables = vec![format!("${}: {}", entity.key, entity.key_type)];
    for entry in &pagination.fields {
        for variable in page_variable_names(entry.method) {
            variables.push(format!(
                "${variable}: {}{}",
                page_argument_type(variable),
                page_default(entry, variable)
            ));
        }
    }
    format!(
        "query {name}({}) {{\n\t{}({}: ${}) {{\n\t\t... on {condition} {{\n\t\t\t...{clone} @mask_disable\n\t\t}}\n\t}}\n}}\n\n{clone_text}\n",
        variables.join(", "),
        entity.field,
        entity.key,
        entity.key,
    )
}

/// The `keyRaw` of the paginated field one document reads, following its `refetch.path`.
pub fn paginated_field_key(document: &crate::contract::IrDocument) -> Option<String> {
    let path = document
        .refetch
        .as_ref()
        .map(|refetch| refetch.path.clone())?;
    let mut selection = &document.selection;
    let mut spec = None;
    for (index, name) in path.iter().enumerate() {
        let field = selection.fields.get(name)?;
        if index == path.len() - 1 {
            spec = Some(field);
            break;
        }
        selection = field.selection.as_ref()?;
    }
    spec.map(|field| field.key_raw.clone())
}

/// Overrides the `keyRaw` of the paginated field at `path` (a document's own
/// `paginated` entry), so a companion writes the key the fragment reads.
pub fn set_paginated_field_key(
    document: &mut crate::contract::IrDocument,
    path: &[String],
    key: &str,
) {
    fn descend(selection: &mut crate::contract::SubscriptionSelection, path: &[String], key: &str) {
        let Some((name, rest)) = path.split_first() else {
            return;
        };
        let Some(field) = selection.fields.get(name).cloned() else {
            return;
        };
        let mut field = field;
        if rest.is_empty() {
            field.key_raw = key.to_string();
            selection.fields.insert(name.clone(), field);
            return;
        }
        if let Some(nested) = field.selection.as_mut() {
            descend(nested, rest, key);
        }
        // A fragment on an interface is re-resolved through an **abstract** wrapper
        // (`node(id: $id) { ... on User { … } }`), so the path continues inside every concrete
        // branch. The branch is what the writer reads (`selectionForWrite` merges it over the
        // base), so a branch left with the clone's spelling stores the page under a second key
        // and the fragment's read never gains it (`review-f8`).
        if let Some(branches) = field.abstract_fields.as_mut() {
            // `keys()` borrows the map, so the names are collected before the rewrite
            let names: Vec<String> =
                branches.keys().into_iter().map(str::to_string).collect();
            for branch_name in names {
                let mut branch = branches.get(&branch_name).cloned().unwrap_or_default();
                descend(&mut branch, rest, key);
                branches.insert(branch_name, branch);
            }
        }
        selection.fields.insert(name.clone(), field);
    }
    descend(&mut document.selection, path, key);
}

/// The page variables a strategy uses, in the runtime's canonical order.
fn page_variable_names(method: &str) -> &'static [&'static str] {
    if method == "offset" {
        OFFSET_ARGUMENTS
    } else {
        CURSOR_ARGUMENTS
    }
}

/// The literal default of one page variable, when the fragment's field applies one.
fn page_default(entry: &PaginatedInFragment<'_>, name: &str) -> String {
    let literal = entry
        .node
        .arguments
        .iter()
        .find(|argument| argument.name.value == name);
    match literal.map(|argument| &argument.value) {
        Some(Value::Variable(_)) | None => String::new(),
        Some(value) => format!(" = {}", print_value(value)),
    }
}

/// Every fragment name spread anywhere in a selection set.
fn spread_names(selection_set: &SelectionSet) -> Vec<String> {
    let mut names = Vec::new();
    for selection in &selection_set.selections {
        match selection {
            Selection::FragmentSpread(spread) => names.push(spread.name.value.clone()),
            Selection::InlineFragment(inline) => names.extend(spread_names(&inline.selection_set)),
            Selection::Field(field) => {
                if let Some(nested) = &field.selection_set {
                    names.extend(spread_names(nested));
                }
            }
        }
    }
    names
}
