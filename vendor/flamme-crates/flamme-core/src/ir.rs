//! The normalized artifact IR (`spec/spec.md` §3, §4.6).
//! Port of `packages/core/src/ir.ts`.
//!
//! One pass over a validated document produces the `selection` tree the artifact
//! literal stores, the printed `raw` string whose exact bytes the hash is taken
//! over, and the metadata the type generator needs.
//!
//! Two orderings coexist on purpose (§4.6): the artifact's maps are emitted sorted,
//! while the generated *types* follow insertion (source) order.

use crate::config::RustConfig;
use crate::contract::{
    ArtifactKind, CachePolicy, DeferredSpec, DirectiveSpec, FieldSpec, FragmentSpec, GraphQLValue,
    InputObject, IrDocument, ListOperation, ListSpec, ListWhen, LoadingListSpec, LoadingSpec,
    PaginationSpec, RefetchSpec, SubscriptionSelection, WhenCondition,
};
use crate::extract::RawDocument;
use crate::graphql::ast::{
    Argument, Definition, Directive, Field, FragmentDefinition, FragmentSpread, OperationDefinition,
    OperationType, Selection, SelectionSet, TypeNode, Value, VariableDefinition,
};
use crate::graphql::{print_type_node, print_value};
use crate::js::JsObject;
use crate::paginate::{page_argument_plan, CursorArgumentPlan, CURSOR_ARGUMENTS};
use crate::schema::{list_depth, type_ref_string, SchemaIndex};
use crate::validate::{
    directive_string_argument, find_directive, list_fragment_action, value_node_to_graphql_value,
    DocumentIndex, PASS_THROUGH_DIRECTIVES,
};

/// The `__typename` response key.
const TYPENAME: &str = "__typename";

/// The cursor-variable bindings a `@paginate` field needs, keyed by argument name.
///
/// A binding's `value` is the literal the user wrote for that cursor argument, kept
/// as the variable's default; `None` means the document wrote no literal, which is
/// the difference between `$after: String` and `$after: String = null` in `raw` and
/// between an absent and a `null` entry in `input.defaults`.
pub type InjectedVariables = Vec<(String, CursorBinding)>;

/// One injected cursor variable.
#[derive(Clone, Debug)]
pub struct CursorBinding {
    /// The argument the variable binds to (`first`, `after`, …).
    pub argument: String,
    /// The variable's declared type.
    pub type_name: String,
    /// The value the artifact stores, when the document declared one.
    pub value: Option<GraphQLValue>,
}

/// A paginated field the IR records.
#[derive(Clone, Debug)]
pub struct PaginatedField {
    /// Field path from the artifact root.
    pub path: Vec<String>,
    /// `SinglePage` or `Infinite`.
    pub mode: String,
    /// `cursor` for a connection, `offset` for a list (Houdini's `selection.go:1099-1104`).
    pub method: String,
    /// `both`, `forward` or `backward`, from the schema's directional support.
    pub direction: String,
    /// The parent type name.
    pub parent_type: String,
    /// Page size.
    pub page_size: i64,
    /// `true` when the paginated field lives in a fragment rather than in the
    /// document's own selection (Houdini's `documents.kind == 'fragment'`).
    pub embedded: bool,
}

/// The mutable state one `buildIr` call threads through the walk.
struct State<'a> {
    schema: &'a SchemaIndex,
    config: &'a RustConfig,
    index: &'a DocumentIndex,
    documents: &'a [RawDocument],
    is_fragment: bool,
    /// `<selection path>.<key field>` → the type whose key field was injected there.
    injected_keys: Vec<(String, String)>,
    /// Variable name → the cursor binding. A JavaScript `Map`: the last write wins
    /// and an existing key keeps its original position.
    injected_variables: InjectedVariables,
    /// The document's variable definitions (`$first: Int = 10`), for `pageSize`.
    variable_defaults: Vec<(String, Value)>,
    paginated: Vec<PaginatedField>,
    lists: Vec<String>,
    /// Selection path → the list operations a mutation spread produced there.
    operations: Vec<(String, Vec<ListOperation>)>,
    /// The `@defer`/`@stream` targets found while walking the document (§7.13).
    deferred: Vec<DeferredSpec>,
    /// Labels already handed out, so a derived label never collides with an explicit one.
    deferred_labels: Vec<String>,
    /// `true` once a field marked `@optimisticKey` was built (§7.14).
    optimistic_keys: bool,
}

/// The walk's context, mirroring `Context` in `ir.ts`.
#[derive(Clone)]
struct Context {
    parent_type: String,
    path: Vec<String>,
    cascade: bool,
    root: bool,
    /// The GraphQL field name whose selection this is (`myEdges` aliases `edges`).
    field_name: Option<String>,
    /// Fragments currently being inlined, so a cycle cannot recurse forever.
    inlining: Vec<String>,
}

/// Builds the IR for one validated document.
pub fn build_ir(
    document: &RawDocument,
    documents: &[RawDocument],
    index: &DocumentIndex,
    schema: &SchemaIndex,
    config: &RustConfig,
) -> IrDocument {
    let definition = match document.ast.definitions.first() {
        Some(definition) => definition,
        None => panic!("Document \"{}\" has no operation or fragment definition.", document.name),
    };
    let is_fragment = matches!(definition, Definition::Fragment(_));
    let mut state = State {
        schema,
        config,
        index,
        documents,
        is_fragment,
        injected_keys: Vec::new(),
        injected_variables: Vec::new(),
        variable_defaults: definition_variable_defaults(definition),
        paginated: Vec::new(),
        lists: Vec::new(),
        operations: Vec::new(),
        deferred: Vec::new(),
        deferred_labels: Vec::new(),
        optimistic_keys: false,
    };
    let root_type = if is_fragment {
        definition_type_condition(definition).to_string()
    } else {
        root_type_of(document.kind, schema)
    };
    let loading = document_loading(definition);
    let mut selection = state.build_selection(
        definition_selection_set(definition),
        &Context {
            parent_type: root_type.clone(),
            path: Vec::new(),
            cascade: loading == Some("global"),
            root: is_fragment,
            field_name: None,
            inlining: Vec::new(),
        },
    );
    if is_fragment {
        selection = state.inject_keys(&selection, &root_type, &[], loading == Some("global"));
    }

    let mut fragment_selections: Vec<(String, SubscriptionSelection)> = Vec::new();
    for name in transitive_spreads(definition, index) {
        let Some(fragment) = index.fragment_node(documents, &name) else {
            continue;
        };
        let built = state.build_selection(
            &fragment.selection_set,
            &Context {
                parent_type: fragment.type_condition.name.value.clone(),
                path: vec![name.clone()],
                cascade: false,
                root: true,
                field_name: None,
                inlining: Vec::new(),
            },
        );
        fragment_selections.push((name, built));
    }

    // Houdini emits one `refetch` block per paginated document, in either mode
    // (`selection.go:1087-1114`); at most one field can pair with it (`FLM1009`).
    let paginated = state.paginated.first().cloned();
    let raw = print_raw(
        document,
        definition,
        documents,
        index,
        schema,
        if state.paginated.is_empty() { &[] } else { &state.paginated },
        &state.injected_variables,
    );

    let paginated_paths: Vec<Vec<String>> =
        state.paginated.iter().map(|entry| entry.path.clone()).collect();
    let mut fragment_types: Vec<(String, String)> = Vec::new();
    for entry in documents {
        // `indexProject` only ever reads a document's first definition, and a
        // redeclared fragment keeps its first definition, so this walk reproduces
        // the index's own insertion order.
        if let Some(Definition::Fragment(node)) = entry.ast.definitions.first() {
            if index.fragments.contains_key(&node.name.value)
                && !fragment_types.iter().any(|(name, _)| name == &node.name.value)
            {
                fragment_types.push((
                    node.name.value.clone(),
                    node.type_condition.name.value.clone(),
                ));
            }
        }
    }

    let is_query = document.kind == ArtifactKind::Query;
    IrDocument {
        name: document.name.clone(),
        kind: document.kind,
        hash: crate::hash::hash_document(&raw),
        raw,
        file: document.file.clone(),
        source: document.relative_path.clone(),
        root_type,
        selection,
        input: build_input(definition, schema, &state.injected_variables),
        refetch: paginated.as_ref().map(|entry| refetch_of(entry, &document.name)),
        plugin_data: build_plugin_data(definition),
        enable_loading_state: loading.map(str::to_string),
        policy: if is_query { Some(policy_of(definition, config)) } else { None },
        partial: if is_query { Some(partial_of(definition, config)) } else { None },
        paginated: paginated_paths,
        lists: state.lists.clone(),
        deferred: if state.deferred.is_empty() { None } else { Some(state.deferred.clone()) },
        pagination_companion: None,
        optimistic_keys: if state.optimistic_keys { Some(true) } else { None },
        injected_keys: state.injected_keys.clone(),
        fragment_types,
        fragment_selections,
        document: document.clone(),
        strip_variables: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Document-level helpers
// ---------------------------------------------------------------------------

/// The directives of an operation or fragment definition.
fn definition_directives(definition: &Definition) -> &[Directive] {
    match definition {
        Definition::Operation(node) => &node.directives,
        Definition::Fragment(node) => &node.directives,
        // A type system definition carries directives too, but the extraction rejects
        // the document before the IR is built.
        Definition::TypeSystem(_) => &[],
    }
}

/// The document's variable definitions that carry a default, in declaration order.
///
/// Houdini's `pageSize` falls back from the applied page argument to the default of
/// the variable used there (`lists/validate.go:649`).
fn definition_variable_defaults(definition: &Definition) -> Vec<(String, Value)> {
    let Definition::Operation(node) = definition else {
        return Vec::new();
    };
    node.variable_definitions
        .iter()
        .filter_map(|variable| {
            variable
                .default_value
                .clone()
                .map(|value| (variable.variable.name.value.clone(), value))
        })
        .collect()
}

/// The selection set of an operation or fragment definition.
///
/// A type system definition has none; the extraction rejects such a document before
/// the IR is built, and the shared empty set keeps the signature total.
fn definition_selection_set(definition: &Definition) -> &SelectionSet {
    static EMPTY: SelectionSet = SelectionSet { selections: Vec::new(), loc: None };
    match definition {
        Definition::Operation(node) => &node.selection_set,
        Definition::Fragment(node) => &node.selection_set,
        Definition::TypeSystem(_) => &EMPTY,
    }
}

/// The type condition of a fragment definition; the caller knows it is one.
fn definition_type_condition(definition: &Definition) -> &str {
    match definition {
        Definition::Fragment(node) => &node.type_condition.name.value,
        Definition::Operation(_) | Definition::TypeSystem(_) => "",
    }
}

/// The root type name an artifact of this kind is selected against.
pub fn root_type_of(kind: ArtifactKind, schema: &SchemaIndex) -> String {
    let operation = match kind {
        ArtifactKind::Mutation => OperationType::Mutation,
        ArtifactKind::Subscription => OperationType::Subscription,
        ArtifactKind::Query | ArtifactKind::Fragment => OperationType::Query,
    };
    schema_root_type(schema, operation)
}

/// `schema.getQueryType()?.name ?? 'Query'`, and its mutation/subscription forms.
///
/// An explicit `schema { … }` definition wins; otherwise graphql-js falls back to
/// the conventional names, and the oracle answers `Query` for a root the schema
/// does not declare at all.
fn schema_root_type(schema: &SchemaIndex, operation: OperationType) -> String {
    for definition in &schema.document.definitions {
        if let crate::graphql::ast::TypeSystemDefinition::Schema(node) = definition {
            for entry in &node.operation_types {
                if entry.operation == operation {
                    return entry.type_name.value.clone();
                }
            }
        }
    }
    let default = match operation {
        OperationType::Query => "Query",
        OperationType::Mutation => "Mutation",
        OperationType::Subscription => "Subscription",
    };
    if schema.named_type(default).is_some() { default.to_string() } else { "Query".to_string() }
}

/// `documentLoading`: `@loading` on the definition, or on any nested selection.
fn document_loading(definition: &Definition) -> Option<&'static str> {
    if find_directive(definition_directives(definition), "loading").is_some() {
        return Some("global");
    }
    if has_loading(definition_selection_set(definition)) { Some("local") } else { None }
}

/// True when any selection of the set, at any depth, carries `@loading`.
fn has_loading(selection_set: &SelectionSet) -> bool {
    for selection in &selection_set.selections {
        if find_directive(selection_directives(selection), "loading").is_some() {
            return true;
        }
        let nested = match selection {
            Selection::Field(node) => node.selection_set.as_ref(),
            Selection::InlineFragment(node) => Some(&node.selection_set),
            Selection::FragmentSpread(_) => None,
        };
        if let Some(nested) = nested {
            if has_loading(nested) {
                return true;
            }
        }
    }
    false
}

/// The directives of one selection.
fn selection_directives(selection: &Selection) -> &[Directive] {
    match selection {
        Selection::Field(node) => &node.directives,
        Selection::FragmentSpread(node) => &node.directives,
        Selection::InlineFragment(node) => &node.directives,
    }
}

/// The cache policy a query artifact carries.
fn policy_of(definition: &Definition, config: &RustConfig) -> CachePolicy {
    let directive = find_directive(definition_directives(definition), "cache");
    let value = directive.and_then(|directive| directive.argument("policy")).map(|entry| &entry.value);
    let text = match value {
        Some(Value::EnumValue { value, .. }) => Some(value.as_str()),
        _ => None,
    };
    match text {
        Some("CacheOrNetwork") => CachePolicy::CacheOrNetwork,
        Some("NetworkOnly") => CachePolicy::NetworkOnly,
        Some("CacheAndNetwork") => CachePolicy::CacheAndNetwork,
        Some("CacheOnly") => CachePolicy::CacheOnly,
        _ => config.default_cache_policy,
    }
}

/// The `partial` flag a query artifact carries.
fn partial_of(definition: &Definition, config: &RustConfig) -> bool {
    let directive = find_directive(definition_directives(definition), "cache");
    let value = directive.and_then(|directive| directive.argument("partial")).map(|entry| &entry.value);
    match value {
        Some(Value::BooleanValue { value, .. }) => *value,
        _ => config.default_partial,
    }
}

/// The plugin data a `@dedupe` definition contributes.
fn build_plugin_data(definition: &Definition) -> JsObject<serde_json::Value> {
    let mut data = JsObject::new();
    let Some(directive) = find_directive(definition_directives(definition), "dedupe") else {
        return data;
    };
    let cancel_first = directive.argument("cancelFirst").map(|entry| &entry.value);
    let match_mode = directive.argument("match").map(|entry| &entry.value);
    let mut dedupe = serde_json::Map::new();
    dedupe.insert(
        "cancelFirst".to_string(),
        serde_json::Value::Bool(matches!(
            cancel_first,
            Some(Value::BooleanValue { value: true, .. })
        )),
    );
    dedupe.insert(
        "match".to_string(),
        serde_json::Value::String(
            match match_mode {
                Some(Value::EnumValue { value, .. }) if value == "all" => "all",
                _ => "variables",
            }
            .to_string(),
        ),
    );
    data.insert("dedupe", serde_json::Value::Object(dedupe));
    data
}

/// Every fragment a definition reaches through spreads, sorted by name.
pub fn transitive_spreads(definition: &Definition, index: &DocumentIndex) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    fn walk(index: &DocumentIndex, name: &str, found: &mut Vec<String>) {
        if found.iter().any(|entry| entry == name) {
            return;
        }
        found.push(name.to_string());
        if let Some(spreads) = index.spread_graph.get(name) {
            for spread in spreads {
                walk(index, spread, found);
            }
        }
    }
    for spread in spread_names(definition_selection_set(definition)) {
        walk(index, &spread, &mut found);
    }
    if let Definition::Fragment(node) = definition {
        found.retain(|name| name != &node.name.value);
    }
    found.sort();
    found
}

/// Every fragment name spread anywhere in a selection set, in source order.
fn spread_names(selection_set: &SelectionSet) -> Vec<String> {
    let mut names = Vec::new();
    for selection in &selection_set.selections {
        match selection {
            Selection::FragmentSpread(node) => names.push(node.name.value.clone()),
            Selection::InlineFragment(node) => names.extend(spread_names(&node.selection_set)),
            Selection::Field(node) => {
                if let Some(nested) = &node.selection_set {
                    names.extend(spread_names(nested));
                }
            }
        }
    }
    names
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/// The variables spec of one document (`input` in the artifact literal).
fn build_input(
    definition: &Definition,
    schema: &SchemaIndex,
    injected: &InjectedVariables,
) -> InputObject {
    let mut fields: JsObject<String> = JsObject::new();
    let mut defaults: JsObject<serde_json::Value> = JsObject::new();
    let mut types: JsObject<JsObject<String>> = JsObject::new();
    if let Definition::Operation(operation) = definition {
        for variable in &operation.variable_definitions {
            let name = variable.variable.name.value.clone();
            fields.insert(name.clone(), print_type_node(&variable.type_node));
            if let Some(default) = &variable.default_value {
                defaults.insert(name.clone(), value_from_ast(default));
            }
            collect_input_types(&variable.type_node, schema, &mut types);
        }
        // §6.8/§7.3: the page variables the runtime sends are part of the document's
        // input, so a user may pass them and `marshalInputs` applies a literal's default.
        for name in injected_variable_order_from(injected) {
            let Some(variable) = map_get(injected, name) else {
                continue;
            };
            if fields.contains_key(name) {
                continue;
            }
            fields.insert(name.to_string(), variable.type_name.clone());
            if let Some(value) = &variable.value {
                defaults.insert(name.to_string(), json_from_graphql_value(value));
            }
        }
    }
    InputObject { fields, types, defaults, runtime_scalars: JsObject::new() }
}

/// Records the input object type a variable's type names, once.
fn collect_input_types(
    node: &TypeNode,
    schema: &SchemaIndex,
    types: &mut JsObject<JsObject<String>>,
) {
    let mut current = node;
    loop {
        match current {
            TypeNode::Named(named) => {
                if let Some(fields) = schema.input_fields(&named.name.value) {
                    if !types.contains_key(&named.name.value) {
                        types.insert(named.name.value.clone(), fields.clone());
                    }
                }
                return;
            }
            TypeNode::List(list) => current = &list.type_node,
            TypeNode::NonNull(non_null) => current = &non_null.type_node,
        }
    }
}

/// `valueFromAst`: a value node as plain JSON, with JavaScript number semantics.
fn value_from_ast(node: &Value) -> serde_json::Value {
    match node {
        Value::IntValue { value, .. } => {
            serde_json::Value::Number(js_number(parse_js_number(value)))
        }
        Value::FloatValue { value, .. } => {
            serde_json::Value::Number(js_number(parse_js_number(value)))
        }
        Value::StringValue { value, .. } | Value::EnumValue { value, .. } => {
            serde_json::Value::String(value.clone())
        }
        Value::BooleanValue { value, .. } => serde_json::Value::Bool(*value),
        Value::NullValue { .. } | Value::Variable(_) => serde_json::Value::Null,
        Value::ListValue { values, .. } => {
            serde_json::Value::Array(values.iter().map(value_from_ast).collect())
        }
        Value::ObjectValue { fields, .. } => {
            let mut result = serde_json::Map::new();
            for field in fields {
                result.insert(field.name.value.clone(), value_from_ast(&field.value));
            }
            serde_json::Value::Object(result)
        }
    }
}

/// The plain-JSON form of an already-normalized GraphQL value (a cursor default).
fn json_from_graphql_value(value: &GraphQLValue) -> serde_json::Value {
    match value {
        GraphQLValue::IntValue { value } | GraphQLValue::FloatValue { value } => {
            serde_json::Value::Number(js_number(parse_js_number(value)))
        }
        GraphQLValue::StringValue { value } | GraphQLValue::EnumValue { value } => {
            serde_json::Value::String(value.clone())
        }
        GraphQLValue::BooleanValue { value } => serde_json::Value::Bool(*value),
        GraphQLValue::NullValue | GraphQLValue::Variable { .. } => serde_json::Value::Null,
        GraphQLValue::ListValue { values } => {
            serde_json::Value::Array(values.iter().map(json_from_graphql_value).collect())
        }
        GraphQLValue::ObjectValue { fields } => serde_json::Value::Object(
            fields
                .iter()
                .map(|(key, entry)| (key.to_string(), json_from_graphql_value(entry)))
                .collect(),
        ),
    }
}

/// `Number.parseInt`/`Number.parseFloat`: the text as a JavaScript number.
fn parse_js_number(text: &str) -> f64 {
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// A JavaScript number as a JSON number, integral values kept integral.
fn js_number(value: f64) -> serde_json::Number {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        serde_json::Number::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).unwrap_or_else(|| serde_json::Number::from(0))
    }
}

// ---------------------------------------------------------------------------
// Selection building
// ---------------------------------------------------------------------------

/// The shared `__typename` spec: `{ type: 'String', modifiers: 'String!', keyRaw: '__typename' }`.
fn typename_spec() -> FieldSpec {
    FieldSpec {
        type_name: "String".to_string(),
        modifiers: "String!".to_string(),
        key_raw: TYPENAME.to_string(),
        ..Default::default()
    }
}

/// The concat key of a selection path, `path.join('.')`.
fn key(path: &[String]) -> String {
    path.join(".")
}

/// `keyOf`: the concat key of a path plus one more segment.
fn key_of(path: &[String], name: &str) -> String {
    let mut joined = path.join(".");
    if !joined.is_empty() {
        joined.push('.');
    }
    joined.push_str(name);
    joined
}

/// A JavaScript `Map.get` over an association list.
fn map_get<'a, T>(entries: &'a [(String, T)], key: &str) -> Option<&'a T> {
    entries.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

/// A JavaScript `Map.set`: an existing key keeps its position, a new one appends.
fn map_set<T>(entries: &mut Vec<(String, T)>, key: String, value: T) {
    if let Some(entry) = entries.iter_mut().find(|(name, _)| *name == key) {
        entry.1 = value;
        return;
    }
    entries.push((key, value));
}

/// A JavaScript `new Map(pairs)`: the first position wins, the last value wins.
fn dedupe_by<T>(items: impl IntoIterator<Item = T>, key: impl Fn(&T) -> String) -> Vec<T> {
    let mut result: Vec<T> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for item in items {
        let item_key = key(&item);
        match keys.iter().position(|entry| *entry == item_key) {
            Some(position) => result[position] = item,
            None => {
                keys.push(item_key);
                result.push(item);
            }
        }
    }
    result
}

/// `getNamedType(node).name`.
fn named_type_of(node: &TypeNode) -> &str {
    &node.named_type().name.value
}

/// `isNonNullType(node)`.
fn is_non_null_type(node: &TypeNode) -> bool {
    matches!(node, TypeNode::NonNull(_))
}

impl State<'_> {
    /// Builds one selection set; insertion order is the source order (§4.6).
    fn build_selection(
        &mut self,
        selection_set: &SelectionSet,
        context: &Context,
    ) -> SubscriptionSelection {
        let mut fields: JsObject<FieldSpec> = JsObject::new();
        let mut fragments: JsObject<FragmentSpec> = JsObject::new();
        let mut injections: JsObject<FieldSpec> = JsObject::new();
        // Fields every possible type of the parent has, i.e. everything not
        // contributed by an inline fragment: the `%other` branch of the §9.2 union
        // and the common part of every concrete branch.
        let mut common: JsObject<FieldSpec> = JsObject::new();
        let mut branches: JsObject<SubscriptionSelection> = JsObject::new();
        if context.root || !context.path.is_empty() {
            fields.insert(TYPENAME, typename_spec());
            common.insert(TYPENAME, typename_spec());
        }

        for selection in &selection_set.selections {
            match selection {
                Selection::Field(node) => {
                    let response_key = node.response_key().to_string();
                    let spec = self.build_field(node, context, &response_key);
                    if let Some(spec) = spec {
                        // A repeated response key merges its sub-selection instead of
                        // replacing it (two mergeable selections are one response key, §9.2).
                        let merged = merge_field_spec(fields.get(&response_key), &spec);
                        fields.insert(response_key.clone(), merged);
                        let merged = merge_field_spec(common.get(&response_key), &spec);
                        common.insert(response_key.clone(), merged);
                    }
                }
                Selection::FragmentSpread(node) => {
                    let name = node.name.value.clone();
                    if let Some((list, action)) = list_fragment_action(&name) {
                        let path_key = key(&context.path);
                        let mut operations =
                            map_get(&self.operations, &path_key).cloned().unwrap_or_default();
                        // §7.10: the spread's own `@append`/`@prepend` decides the
                        // position (the configured default only fills in when neither
                        // is present), and `@listTarget(name:)` names the list the
                        // operation lands in. A named list is exactly one list, so the
                        // target is `single` whatever `defaultListTarget` says.
                        let list_target = directive_string_argument(
                            find_directive(&node.directives, "listTarget"),
                            "name",
                        );
                        // §4: `@allLists` overrides the configured target and applies the
                        // operation to every cached instance of the list
                        // (`artifacts/selection.go:1677-1686`); naming one list with
                        // `@listTarget` is the opposite, so it stays `single`.
                        let all_lists = find_directive(&node.directives, "allLists").is_some();
                        operations.push(ListOperation {
                            action: action.clone(),
                            list: list_target.clone().unwrap_or(list),
                            position: Some(list_position_of(node, self.config)),
                            target: Some(if all_lists {
                                "all".to_string()
                            } else if list_target.is_some() {
                                "single".to_string()
                            } else {
                                self.config.default_list_target.clone()
                            }),
                            path: None,
                            // §4: the `@when`/`@when_not` pairs the operation applies under.
                            when: list_when_of(node),
                            // §5: the opaque list instance the operation targets.
                            list_id: find_directive(&node.directives, "listID")
                                .and_then(|directive| directive.argument("value"))
                                .map(|argument| value_node_to_graphql_value(&argument.value)),
                        });
                        map_set(&mut self.operations, path_key, operations);
                        continue;
                    }
                    let Some(fragment) = self.index.fragment_node(self.documents, &name) else {
                        continue;
                    };
                    let fragment = fragment.clone();
                    let loading =
                        context.cascade || find_directive(&node.directives, "loading").is_some();
                    let masked = spread_is_masked(node, self.config);
                    let when = when_directives_of(node);
                    let required = find_directive(&node.directives, "required").is_some();
                    // §7.13: `@defer` on the spread. The directive stays in `raw` (the
                    // server must apply it), and the artifact records the target so the
                    // runtime can merge the patch at `path`.
                    let defer = find_directive(&node.directives, "defer").map(|directive| {
                        fragment_defer_spec(self, directive, &context.path, Some(&name))
                    });
                    if let Some(spec) = &defer {
                        self.deferred.push(spec.clone());
                    }
                    // §7.12: an unmasked spread contributes its fields as the parent's
                    // own and gets **no** `$fragments` entry.
                    if masked {
                        let spec = FragmentSpec {
                            arguments: JsObject::new(),
                            loading: if loading { Some(true) } else { None },
                            when: if when.is_empty() { None } else { Some(when_conditions(&when)) },
                            defer: defer.clone(),
                        };
                        let merged = merge_fragment_spec(fragments.get(&name), &spec);
                        fragments.insert(name.clone(), merged);
                    }
                    // The spread's fields are inlined into this selection; masking is a
                    // read-time concern expressed by the `visible` flag (D3, §3.5).
                    if !context.inlining.contains(&fragment.name.value) {
                        let mut inlining = context.inlining.clone();
                        inlining.push(fragment.name.value.clone());
                        let inline_context = Context {
                            parent_type: fragment.type_condition.name.value.clone(),
                            path: context.path.clone(),
                            cascade: loading,
                            root: false,
                            field_name: context.field_name.clone(),
                            inlining,
                        };
                        inline_fragment(
                            &mut fields,
                            &mut fragments,
                            &mut common,
                            &fragment,
                            self,
                            &inline_context,
                            masked,
                            &when,
                            required,
                            defer.clone(),
                        );
                    }
                }
                Selection::InlineFragment(node) => {
                    // An inline fragment: its type condition becomes the parent type of
                    // the nested selection, so a field that exists only on the concrete
                    // type is kept (A1), and the branch is recorded for the §9.2
                    // discriminated union.
                    let condition = node.type_condition.as_ref().map(|entry| entry.name.value.clone());
                    // §7.13: `@defer` on an inline fragment.
                    let inline_defer = find_directive(&node.directives, "defer")
                        .map(|directive| fragment_defer_spec(self, directive, &context.path, None));
                    if let Some(spec) = &inline_defer {
                        self.deferred.push(spec.clone());
                    }
                    let raw = self.build_selection(
                        &node.selection_set,
                        &Context {
                            parent_type: condition
                                .clone()
                                .unwrap_or_else(|| context.parent_type.clone()),
                            ..context.clone()
                        },
                    );
                    // The mark has to sit on the branch selection too, not only on the
                    // parent's flattened fields.
                    let nested = match &inline_defer {
                        None => raw,
                        Some(spec) => mark_deferred_selection(&raw, spec),
                    };
                    for (name, spec) in nested.fields.iter() {
                        if name == TYPENAME {
                            continue;
                        }
                        let merged = merge_field_spec(fields.get(name), spec);
                        fields.insert(name.to_string(), merged);
                        if condition.is_none() {
                            let merged = merge_field_spec(common.get(name), spec);
                            common.insert(name.to_string(), merged);
                        }
                    }
                    for (name, spec) in nested.fragments.iter() {
                        if !fragments.contains_key(name) {
                            fragments.insert(name.to_string(), spec.clone());
                        }
                    }
                    if let Some(condition) = &condition {
                        let base = branches.get(condition).cloned().unwrap_or_default();
                        let merged = merge_selection(&base, &without_typename(&nested));
                        branches.insert(condition.clone(), merged);
                    }
                }
            }
        }

        // Injections sit directly after `__typename` (§3.5, and the golden layout).
        let parent_path: Vec<String> = if context.path.is_empty() {
            Vec::new()
        } else {
            context.path[..context.path.len() - 1].to_vec()
        };
        let field_name = context.field_name.clone().unwrap_or_default();
        if field_name == "edges" && is_paginated(self, &parent_path) {
            let cursor = self.schema.field_type(&context.parent_type, "cursor");
            injections.insert(
                "cursor",
                FieldSpec {
                    type_name: match cursor {
                        None => "String".to_string(),
                        Some(node) => named_type_of(node).to_string(),
                    },
                    modifiers: match cursor {
                        None => "String".to_string(),
                        Some(node) => type_ref_string(node),
                    },
                    key_raw: "cursor".to_string(),
                    nullable: match cursor {
                        None => None,
                        Some(node) if is_non_null_type(node) => None,
                        Some(_) => Some(true),
                    },
                    loading: if context.cascade {
                        Some(LoadingSpec { kind: "value".to_string(), list: None })
                    } else {
                        None
                    },
                    visible: Some(false),
                    ..Default::default()
                },
            );
        }
        if field_name == "pageInfo" && is_paginated(self, &parent_path) {
            let mut ordered: JsObject<FieldSpec> = JsObject::new();
            ordered.insert(TYPENAME, typename_spec());
            for name in ["endCursor", "hasNextPage", "hasPreviousPage", "startCursor"] {
                let spec = page_info_field(
                    self,
                    name,
                    fields.get(name),
                    context.cascade,
                    self.is_fragment,
                );
                ordered.insert(name, spec);
            }
            let mut result = SubscriptionSelection { fields: ordered, ..Default::default() };
            if !fragments.is_empty() {
                result.fragments = fragments;
            }
            return result;
        }

        let common_with_injections = with_injections(&common, &injections);
        let abstract_fields = abstract_fields_of(&common_with_injections, &branches);
        let mut result =
            SubscriptionSelection { fields: with_injections(&fields, &injections), ..Default::default() };
        if !fragments.is_empty() {
            result.fragments = fragments;
        }
        if let Some(abstract_fields) = abstract_fields {
            result.abstract_fields = abstract_fields;
        }
        result
    }

    /// One field of a selection set.
    fn build_field(&mut self, node: &Field, context: &Context, response_key: &str) -> Option<FieldSpec> {
        let schema = self.schema;
        // `__typename` is a meta field: it is not in the schema's field map, but it
        // is selectable (and aliasable) like any other field (A15). The unaliased
        // form keeps the shared constant, which is how the emitter recognises the
        // injected field.
        if node.name.value == TYPENAME {
            return Some(if response_key == TYPENAME {
                typename_spec()
            } else {
                FieldSpec {
                    type_name: "String".to_string(),
                    modifiers: "String!".to_string(),
                    key_raw: TYPENAME.to_string(),
                    visible: Some(true),
                    ..Default::default()
                }
            });
        }
        let field_type = schema.field_type(&context.parent_type, &node.name.value)?.clone();
        let named = named_type_of(&field_type).to_string();
        let path: Vec<String> =
            context.path.iter().cloned().chain([response_key.to_string()]).collect();
        let loading_directive = find_directive(&node.directives, "loading");
        let paginate_directive = find_directive(&node.directives, "paginate");
        let list_directive = find_directive(&node.directives, "list");
        let cascade = context.cascade || loading_directive.is_some();

        let pagination = paginate_directive
            .and_then(|_| self.register_pagination(node, &named, &path, &context.parent_type));
        // §6.8/§7.3: a paginated field's page arguments must be variables, because the
        // runtime sends the page's cursors (or `limit`/`offset`) per request; frozen
        // literals would make every page request identical. The bindings are recorded
        // once per document, and which arguments they are follows the field's value
        // type: the four cursors for a connection, `limit`/`offset` for a list.
        let cursor_plan = pagination
            .as_ref()
            .map(|spec| page_argument_plan(node, &spec.method));
        if let Some(plan) = &cursor_plan {
            for binding in &plan.bindings {
                let value = plan
                    .literals
                    .iter()
                    .find(|(name, _)| name == &binding.name)
                    .map(|(_, value)| value.clone());
                map_set(
                    &mut self.injected_variables,
                    binding.name.clone(),
                    CursorBinding {
                        argument: binding.argument.clone(),
                        type_name: binding.type_name.clone(),
                        value,
                    },
                );
            }
        }

        let mut child = node.selection_set.as_ref().map(|selection_set| {
            self.build_selection(
                selection_set,
                &Context {
                    parent_type: named.clone(),
                    path: path.clone(),
                    cascade,
                    root: false,
                    field_name: Some(node.name.value.clone()),
                    inlining: Vec::new(),
                },
            )
        });
        if let Some(current) = child.as_ref() {
            if !schema.is_leaf(&named) {
                child = Some(self.inject_keys(current, &named, &path, cascade));
            }
        }
        if let Some(current) = child.as_ref() {
            // Houdini injects `pageInfo` for a connection only (`addFields.go:191-206`); an
            // offset-paginated list has no page info at all.
            if pagination.as_ref().is_some_and(|spec| spec.paginated)
                && current.fields.get("pageInfo").is_none()
            {
                let mut ordered: JsObject<FieldSpec> = JsObject::new();
                ordered.insert(TYPENAME, typename_spec());
                // A paginated **fragment**'s handle reads `pageInfo` out of the
                // fragment's own (masked) data, so the injected page info is visible
                // there; in a document the unmasked connection read serves the page
                // helpers and masked reads keep the injection out of the user's view.
                let page_info_visible = self.is_fragment;
                for name in ["endCursor", "hasNextPage", "hasPreviousPage", "startCursor"] {
                    let spec = page_info_field(self, name, None, cascade, page_info_visible);
                    ordered.insert(name, spec);
                }
                let mut fields = current.fields.clone();
                fields.insert(
                    "pageInfo",
                    FieldSpec {
                        type_name: "PageInfo".to_string(),
                        modifiers: "PageInfo!".to_string(),
                        key_raw: "pageInfo".to_string(),
                        selection: Some(SubscriptionSelection {
                            fields: ordered,
                            ..Default::default()
                        }),
                        loading: if cascade {
                            Some(LoadingSpec { kind: "continue".to_string(), list: None })
                        } else {
                            None
                        },
                        visible: Some(self.is_fragment),
                        ..Default::default()
                    },
                );
                child = Some(SubscriptionSelection {
                    fields,
                    fragments: current.fragments.clone(),
                    abstract_fields: current.abstract_fields.clone(),
                });
            }
        }

        if let Some(current) = child.as_ref() {
            // A `@paginate` connection whose document selects only `nodes` still needs `edges`:
            // the runtime hangs the edge a local insert synthesizes on it, and a page write has
            // nowhere to land without it. The reference repairs the selection the same way
            // (`lists/validate.go:953-1020`, `review-f3`).
            if pagination.as_ref().is_some_and(|spec| spec.paginated)
                && current.fields.get("edges").is_none()
            {
                if let Some(edges) = injected_edges(self, &named, &path, cascade) {
                    let mut fields = current.fields.clone();
                    fields.insert("edges", edges);
                    child = Some(SubscriptionSelection {
                        fields,
                        fragments: current.fragments.clone(),
                        abstract_fields: current.abstract_fields.clone(),
                    });
                }
            }
        }

        // §7.10: `@paginate(name:)` enrols the connection in the list system, so the field
        // carries the same `list` spec `@list(name:)` would write (Houdini's
        // `discovered_lists.name`). `@list` wins when both are present, which validation
        // rejects anyway.
        let include_list_id = find_directive(&node.directives, "includeListID").is_some();
        let list = list_directive
            .or(paginate_directive)
            .and_then(|directive| build_list(self, directive, &field_type, include_list_id));
        let loading = loading_spec(loading_directive, cascade, child.is_some(), &field_type);
        // The recorded `@paginate` names the **resolved** mode: a bare `@paginate` takes the
        // configured default, so the artifact's `directives` entry and its `pagination` spec
        // never disagree about the same field.
        let resolved_mode = paginate_directive.map(|_| {
            pagination
                .as_ref()
                .map(|spec| spec.mode.clone())
                .unwrap_or_else(|| paginate_mode(node, self.config))
        });
        let directives = recorded_directives(node, resolved_mode.as_deref());
        let updates =
            updates_for(self, &path, child.as_ref(), &node.name.value, pagination.as_ref());
        let args = node.arguments.clone();
        let operations = map_get(&self.operations, &key(&path)).cloned();
        let abstract_field = !schema.possible_types_of(&named).is_empty();
        // `@required` on this field makes it non-null; a required *child* makes this
        // field the nearest nullable ancestor the child's null bubbles to, so the
        // compiler marks it nullable even when the schema calls it non-null.
        let required = find_directive(&node.directives, "required").is_some();
        let child_has_required = child.as_ref().is_some_and(selection_has_required_child);
        // §7.14: the field that will hold a created record's server id.
        let optimistic_key = find_directive(&node.directives, "optimisticKey").is_some();
        if optimistic_key {
            self.optimistic_keys = true;
        }
        // §7.13: `@stream` is real GraphQL the server applies, so it stays in `raw`.
        let stream = find_directive(&node.directives, "stream")
            .map(|directive| stream_defer_spec(self, directive, &path));
        if let Some(spec) = &stream {
            self.deferred.push(spec.clone());
        }

        let mut spec = FieldSpec {
            type_name: named.clone(),
            modifiers: type_ref_string(&field_type),
            // §3.2: `keyRaw` is the **field name** plus arguments, never the response key.
            key_raw: key_raw_for(&node.name.value, pagination.as_ref(), &args, cursor_plan.as_ref()),
            selection: child,
            visible: Some(true),
            loading,
            list,
            pagination,
            updates,
            operations,
            ..Default::default()
        };
        if !required {
            if !is_non_null_type(&field_type) || child_has_required {
                spec.nullable = Some(true);
            } else if spec.pagination.is_some() {
                spec.nullable = Some(false);
            }
        } else {
            spec.required = Some(true);
        }
        if optimistic_key {
            spec.optimistic_key = Some(true);
        }
        if spec.list.is_some() && !args.is_empty() {
            spec.filters = Some(JsObject::from_pairs(args.iter().map(|argument| {
                (argument.name.value.clone(), value_node_to_graphql_value(&argument.value))
            })));
        }
        if !directives.is_empty() {
            spec.directives = Some(directives);
        }
        if let Some(stream) = stream {
            spec.defer = Some(stream);
        }
        if abstract_field {
            if let Some(abstract_fields) =
                spec.selection.as_ref().map(|child| child.abstract_fields.clone()).filter(|fields| !fields.is_empty())
            {
                spec.abstract_ = Some(true);
                spec.abstract_fields = Some(abstract_fields);
                if child_has_required {
                    spec.abstract_has_required = Some(true);
                }
            }
        }
        Some(spec)
    }

    /// Registers a `@paginate` field and returns its spec.
    ///
    /// The spec follows Houdini's two independent rules (`lists/validate.go:1382-1388`,
    /// `artifacts/selection.go:1099-1113`):
    ///
    /// - **method** is the connection-ness of the field's *value type*: an object type
    ///   (`edges`/`pageInfo`) paginates by cursor, a list type by offset;
    /// - **direction** and `supportsForward`/`supportsBackward` come from the **schema's**
    ///   argument definitions on the field (`first`/`after`, `last`/`before`), never from
    ///   the arguments the document happens to apply. Offset pagination is forward-only.
    ///
    /// A field that is neither a connection nor a list is `FLM1007`; the spec is `None` so
    /// nothing downstream treats it as paginated.
    fn register_pagination(
        &mut self,
        node: &Field,
        type_name: &str,
        path: &[String],
        parent_type: &str,
    ) -> Option<PaginationSpec> {
        let schema = self.schema;
        let mode = paginate_mode(node, self.config);
        let connection = schema.field_type(type_name, "edges").is_some();
        let list = schema
            .field_type(parent_type, &node.name.value)
            .is_some_and(|node| crate::schema::list_depth(node) > 0);
        if !connection && !list {
            return None;
        }
        let page_size = self.page_size_of(node);
        let argument_int = |name: &str| {
            schema
                .argument_type(parent_type, &node.name.value, name)
                .map(|node| node.named_type().name.value.as_str())
                == Some("Int")
        };
        let has_argument =
            |name: &str| schema.argument_type(parent_type, &node.name.value, name).is_some();
        let (method, supports_forward, supports_backward) = if connection {
            (
                "cursor",
                argument_int("first") && has_argument("after"),
                argument_int("last") && has_argument("before"),
            )
        } else {
            // Houdini: an offset page is always forward (`validate.go:1469-1475`).
            ("offset", true, false)
        };
        let direction = if supports_forward && supports_backward {
            "both"
        } else if supports_backward {
            "backward"
        } else {
            "forward"
        };
        self.paginated.push(PaginatedField {
            path: path.to_vec(),
            mode: mode.clone(),
            method: method.to_string(),
            direction: direction.to_string(),
            parent_type: parent_type.to_string(),
            page_size,
            embedded: self.is_fragment,
        });
        let mut element = schema.field_type(type_name, "edges");
        while let Some(node) = element {
            match node {
                TypeNode::List(inner) => element = Some(&inner.type_node),
                TypeNode::NonNull(inner) => element = Some(&inner.type_node),
                TypeNode::Named(_) => break,
            }
        }
        let cursor =
            element.and_then(|node| schema.field_type(named_type_of(node), "cursor"));
        Some(PaginationSpec {
            path: path.to_vec(),
            method: method.to_string(),
            mode,
            page_size,
            embedded: self.is_fragment,
            target_type: parent_type.to_string(),
            paginated: connection,
            direction: direction.to_string(),
            supports_forward,
            supports_backward,
            cursor_type: if connection {
                cursor.map(|node| named_type_of(node).to_string())
            } else {
                None
            },
        })
    }

    /// The page size of a `@paginate` field: the literal applied to `first`, `last` or
    /// `limit`, else the default of the variable applied there, else Flamme's 10
    /// (Houdini's `discovered_lists.page_size`, `validate.go:649`).
    fn page_size_of(&self, node: &Field) -> i64 {
        for argument in &node.arguments {
            let name = argument.name.value.as_str();
            if name != "first" && name != "last" && name != "limit" {
                continue;
            }
            let literal = match &argument.value {
                Value::IntValue { value, .. } => Some(value.as_str()),
                Value::Variable(variable) => self
                    .variable_defaults
                    .iter()
                    .find(|(name, _)| name == &variable.name.value)
                    .and_then(|(_, value)| match value {
                        Value::IntValue { value, .. } => Some(value.as_str()),
                        _ => None,
                    }),
                _ => None,
            };
            if let Some(literal) = literal {
                return parse_js_number(literal) as i64;
            }
        }
        10
    }

    /// Injects the key field of a composite type right after `__typename` (§3.5).
    fn inject_keys(
        &mut self,
        selection: &SubscriptionSelection,
        type_name: &str,
        path: &[String],
        cascade: bool,
    ) -> SubscriptionSelection {
        let schema = self.schema;
        let mut injections: JsObject<FieldSpec> = JsObject::new();
        for name in schema.key_fields_for_type(type_name) {
            if selection.fields.contains_key(name) {
                continue;
            }
            let Some(field_type) = schema.field_type(type_name, name) else {
                continue;
            };
            if !schema.is_leaf(named_type_of(field_type)) {
                continue;
            }
            injections.insert(
                name.clone(),
                FieldSpec {
                    type_name: if name == "id" {
                        "ID".to_string()
                    } else {
                        named_type_of(field_type).to_string()
                    },
                    modifiers: type_ref_string(field_type),
                    key_raw: name.clone(),
                    nullable: if is_non_null_type(field_type) { None } else { Some(true) },
                    loading: if cascade {
                        Some(LoadingSpec { kind: "value".to_string(), list: None })
                    } else {
                        None
                    },
                    visible: Some(true),
                    ..Default::default()
                },
            );
            map_set(&mut self.injected_keys, key_of(path, name), type_name.to_string());
        }
        SubscriptionSelection {
            fields: with_injections(&selection.fields, &injections),
            fragments: selection.fragments.clone(),
            abstract_fields: selection.abstract_fields.clone(),
        }
    }
}

/// True when a path is a registered `@paginate` path.
fn is_paginated(state: &State, path: &[String]) -> bool {
    state.paginated.iter().any(|entry| entry.path == path)
}

/// The `edges { __typename node { __typename } }` selection a paginated connection needs when the
/// document selects only `nodes`.
///
/// The injection is the reference's repair of a connection without `edges { node }`
/// (`lists/validate.go:953-1020`): the field is internal (`visible: false`, like the injected
/// `pageInfo` cursors), and the node's `__typename` is what tells the writer which concrete type an
/// edge's node has. A connection whose edge type declares no `node` gets no `node` selection, and a
/// schema with no `edges` field on the connection gets no injection at all (`review-f3`).
fn injected_edges(
    state: &mut State,
    connection_type: &str,
    path: &[String],
    cascade: bool,
) -> Option<FieldSpec> {
    let schema = state.schema;
    let edges_type = schema.field_type(connection_type, "edges")?;
    // the edge type: the element type of `[Edge!]!`
    let mut element = edges_type;
    loop {
        match element {
            TypeNode::List(inner) => element = &inner.type_node,
            TypeNode::NonNull(inner) => element = &inner.type_node,
            TypeNode::Named(_) => break,
        }
    }
    let edge_name = named_type_of(element).to_string();
    let mut fields: JsObject<FieldSpec> = JsObject::new();
    fields.insert(TYPENAME, typename_spec());
    if let Some(node_type) = schema.field_type(&edge_name, "node") {
        let node_name = named_type_of(node_type).to_string();
        let mut node_fields: JsObject<FieldSpec> = JsObject::new();
        node_fields.insert(TYPENAME, typename_spec());
        // The node's key fields go in beside `__typename`, exactly as they do for a node the user
        // selected themselves (§3.5): the connection's membership ids are the node records the
        // selection can compute, and a node without its keys would list as the connection record.
        let mut node_path: Vec<String> = path.to_vec();
        node_path.push("edges".to_string());
        node_path.push("node".to_string());
        let node_selection = state.inject_keys(
            &SubscriptionSelection { fields: node_fields, ..Default::default() },
            &node_name,
            &node_path,
            cascade,
        );
        fields.insert(
            "node",
            FieldSpec {
                type_name: node_name,
                modifiers: type_ref_string(node_type),
                key_raw: "node".to_string(),
                nullable: if is_non_null_type(node_type) { None } else { Some(true) },
                selection: Some(node_selection),
                visible: Some(false),
                ..Default::default()
            },
        );
    }
    Some(FieldSpec {
        type_name: edge_name,
        modifiers: type_ref_string(edges_type),
        key_raw: "edges".to_string(),
        nullable: if is_non_null_type(edges_type) { None } else { Some(true) },
        selection: Some(SubscriptionSelection { fields, ..Default::default() }),
        loading: if cascade {
            Some(LoadingSpec { kind: "continue".to_string(), list: None })
        } else {
            None
        },
        visible: Some(false),
        ..Default::default()
    })
}

/// One of the four `pageInfo` fields of a paginated connection.
fn page_info_field(
    state: &State,
    name: &str,
    existing: Option<&FieldSpec>,
    cascade: bool,
    visible: bool,
) -> FieldSpec {
    if let Some(existing) = existing {
        return existing.clone();
    }
    let field_type = state.schema.field_type("PageInfo", name);
    FieldSpec {
        type_name: match field_type {
            None => "String".to_string(),
            Some(node) => named_type_of(node).to_string(),
        },
        modifiers: match field_type {
            None => "String".to_string(),
            Some(node) => type_ref_string(node),
        },
        key_raw: name.to_string(),
        nullable: match field_type {
            Some(node) if is_non_null_type(node) => None,
            _ => Some(true),
        },
        loading: if cascade {
            Some(LoadingSpec { kind: "value".to_string(), list: None })
        } else {
            None
        },
        visible: Some(visible),
        ..Default::default()
    }
}

/// True when one of the selection's own fields carries `@required`.
///
/// Only the direct children count: the required field's null bubbles exactly one
/// level, to the field that holds the selection, and that field is the one marked
/// nullable.
fn selection_has_required_child(selection: &SubscriptionSelection) -> bool {
    if selection.fields.values().any(|spec| spec.required == Some(true)) {
        return true;
    }
    selection
        .abstract_fields
        .values()
        .any(|branch| branch.fields.values().any(|spec| spec.required == Some(true)))
}

/// True when the spread's fields stay hidden from the parent's own result (D3).
fn spread_is_masked(node: &FragmentSpread, config: &RustConfig) -> bool {
    if find_directive(&node.directives, "mask_disable").is_some() {
        return false;
    }
    if find_directive(&node.directives, "mask_enable").is_some() {
        return true;
    }
    config.default_fragment_masking == "enable"
}

/// Inlines one spread's fields into the enclosing selection.
#[allow(clippy::too_many_arguments)]
fn inline_fragment(
    fields: &mut JsObject<FieldSpec>,
    fragments: &mut JsObject<FragmentSpec>,
    common: &mut JsObject<FieldSpec>,
    fragment: &FragmentDefinition,
    state: &mut State,
    context: &Context,
    masked: bool,
    when: &[DirectiveSpec],
    required: bool,
    defer: Option<DeferredSpec>,
) {
    let raw = state.build_selection(&fragment.selection_set, context);
    // Masking is recursive: every field the spread contributes, at every depth,
    // stays out of the parent's own result.
    let built = if masked { hide_selection(&raw) } else { raw };
    for (name, spec) in built.fields.iter() {
        let contributed = mark_spread(spec, when, required, defer.as_ref());
        if name == TYPENAME {
            if !fields.contains_key(name) {
                fields.insert(name.to_string(), contributed);
            }
            continue;
        }
        let merged = merge_field_spec(fields.get(name), &contributed);
        fields.insert(name.to_string(), merged);
        let merged = merge_field_spec(common.get(name), &contributed);
        common.insert(name.to_string(), merged);
    }
    for (name, spec) in built.fragments.iter() {
        let merged = merge_fragment_spec(fragments.get(name), spec);
        fragments.insert(name.to_string(), merged);
    }
}

/// The marks one spread puts on the fields it contributes: its conditions,
/// `@required` and `@defer`.
fn mark_spread(
    spec: &FieldSpec,
    when: &[DirectiveSpec],
    required: bool,
    defer: Option<&DeferredSpec>,
) -> FieldSpec {
    let mut with_when = spec.clone();
    if !when.is_empty() {
        let mut directives = spec.directives.clone().unwrap_or_default();
        directives.extend(when.iter().cloned());
        with_when.directives = Some(directives);
    }
    let mut marked = if required { as_required(&with_when) } else { with_when };
    if let Some(defer) = defer {
        marked.defer = Some(defer.clone());
    }
    marked
}

/// The `@when`/`@when_not` directives of a spread, as the artifact records them.
fn when_directives_of(node: &FragmentSpread) -> Vec<DirectiveSpec> {
    let mut result = Vec::new();
    for directive in &node.directives {
        let name = directive.name.value.as_str();
        if name != "when" && name != "when_not" {
            continue;
        }
        let argument = directive.argument("argument").map(|entry| &entry.value);
        // FLM1011 already reported a non-string argument; the IR records nothing it
        // cannot evaluate.
        let Some(Value::StringValue { value, .. }) = argument else {
            continue;
        };
        let mut arguments = JsObject::new();
        arguments.insert("argument", GraphQLValue::StringValue { value: value.clone() });
        result.push(DirectiveSpec { name: name.to_string(), arguments });
    }
    result
}

/// The `when` metadata of a spread's `fragments` entry.
fn when_conditions(directives: &[DirectiveSpec]) -> Vec<WhenCondition> {
    let mut conditions = Vec::new();
    for directive in directives {
        let Some(GraphQLValue::StringValue { value }) = directive.arguments.get("argument") else {
            continue;
        };
        conditions.push(WhenCondition {
            variable: value.clone(),
            polarity: directive.name == "when",
        });
    }
    conditions
}

/// The `@when` / `@when_not` filters of a list-operation spread (§4).
///
/// Houdini records the two polarities separately and compares each entry, resolved
/// against the mutation's variables, with the list's own stored filters
/// (`documents/artifacts/selection.go:1572-1606`).
fn list_when_of(node: &FragmentSpread) -> Option<ListWhen> {
    let mut when = ListWhen::default();
    for directive in &node.directives {
        let must = match directive.name.value.as_str() {
            "when" => true,
            "when_not" => false,
            _ => continue,
        };
        for argument in &directive.arguments {
            let value = value_node_to_graphql_value(&argument.value);
            if must {
                when.must.insert(argument.name.value.clone(), value);
            } else {
                when.must_not.insert(argument.name.value.clone(), value);
            }
        }
    }
    if when.is_empty() {
        None
    } else {
        Some(when)
    }
}

/// The position of a generated list insert (§7.10).
fn list_position_of(node: &FragmentSpread, config: &RustConfig) -> String {
    if find_directive(&node.directives, "prepend").is_some() {
        return "first".to_string();
    }
    if find_directive(&node.directives, "append").is_some() {
        return "last".to_string();
    }
    config.default_list_position.clone()
}

/// Merge directions for the fields of an Infinite connection, and for an offset field itself (§6.8).
fn updates_for(
    state: &State,
    path: &[String],
    child: Option<&SubscriptionSelection>,
    field_name: &str,
    pagination: Option<&PaginationSpec>,
) -> Option<Vec<String>> {
    child?;
    // An offset-paginated field is its own merge target: the pages are array elements of the
    // field, not edges of a connection, so the `append` sits on the field (`selection.go:1373-1394`).
    // A `SinglePage` offset list replaces its window, so it carries no direction at all, exactly
    // like a `SinglePage` connection.
    if let Some(pagination) = pagination {
        if pagination.method == "offset" {
            return if pagination.mode == "Infinite" {
                Some(vec!["append".to_string()])
            } else {
                None
            };
        }
    }
    let parent: &[String] =
        if path.is_empty() { &[] } else { &path[..path.len() - 1] };
    let infinite = state
        .paginated
        .iter()
        .any(|entry| entry.path == parent && entry.mode == "Infinite");
    if !infinite {
        return None;
    }
    match field_name {
        "edges" | "endCursor" | "hasNextPage" => Some(vec!["append".to_string()]),
        "startCursor" | "hasPreviousPage" => Some(vec!["prepend".to_string()]),
        _ => None,
    }
}

/// `SinglePage` or `Infinite` for a `@paginate` field.
fn paginate_mode(node: &Field, config: &RustConfig) -> String {
    let value = find_directive(&node.directives, "paginate")
        .and_then(|directive| directive.argument("mode"))
        .map(|entry| &entry.value);
    let text = match value {
        Some(Value::EnumValue { value, .. }) => Some(value.as_str()),
        _ => None,
    };
    match text {
        Some("Infinite") => "Infinite".to_string(),
        Some("SinglePage") => "SinglePage".to_string(),
        _ => config.default_paginate_mode.clone(),
    }
}

/// The `keyRaw` of one field: the field name plus its arguments.
fn key_raw_for(
    response_key: &str,
    pagination: Option<&PaginationSpec>,
    args: &[Argument],
    cursor_plan: Option<&CursorArgumentPlan>,
) -> String {
    // SinglePage keys carry all four cursor arguments in canonical order, now bound
    // to the page variables (§7.3); evaluating them yields the same literal key the
    // old `after: null` form did, so the page cache is unchanged (§6.8).
    let printed: Vec<String> = match (pagination, cursor_plan) {
        (Some(pagination), Some(plan)) if pagination.mode == "SinglePage" => {
            plan.arguments.clone()
        }
        _ => args.iter().map(print_argument).collect(),
    };
    if pagination.is_some_and(|pagination| pagination.mode == "Infinite") {
        return if printed.is_empty() {
            format!("{response_key}::paginated")
        } else {
            format!("{response_key}({})::paginated", printed.join(", "))
        };
    }
    if printed.is_empty() {
        response_key.to_string()
    } else {
        format!("{response_key}({})", printed.join(", "))
    }
}

/// `@list(name:)` on a field, or `@paginate(name:)`, which enrols the connection in
/// the same system (§7.10). `@includeListID` on the field exposes the opaque id.
fn build_list(
    state: &State,
    directive: &Directive,
    field_type: &TypeNode,
    include_list_id: bool,
) -> Option<ListSpec> {
    let name = directive_string_argument(Some(directive), "name")?;
    if name.is_empty() {
        return None;
    }
    let registered = state.index.lists.get(&name);
    Some(ListSpec {
        name: name.clone(),
        connection: registered.map(|entry| entry.connection).unwrap_or(false),
        type_name: match registered {
            Some(entry) => entry.type_name.clone(),
            None => named_type_of(field_type).to_string(),
        },
        include_list_id: if include_list_id { Some(true) } else { None },
    })
}

/// The refetch spec the runtime's page handlers consume (§6.8).
///
/// Every value is the planner's: `method` from the field's value type, `direction` from
/// the schema's directional support. Nothing here is guessed from the applied arguments.
fn refetch_of(paginated: &PaginatedField, document: &str) -> RefetchSpec {
    // §3: a companion query wraps the fragment in a resolve field (`node(id: $id)`),
    // and the fragment's own data has no such wrapper, so the first path element is
    // dropped from the **refetch** path (`artifacts/selection.go:366-375`). The strip
    // is name-based in Houdini, and it is here too.
    let path = if document.ends_with(crate::companion::PAGINATION_QUERY_SUFFIX)
        && paginated.path.len() > 1
    {
        paginated.path[1..].to_vec()
    } else {
        paginated.path.clone()
    };
    RefetchSpec {
        path,
        method: paginated.method.clone(),
        mode: paginated.mode.clone(),
        page_size: paginated.page_size,
        embedded: paginated.embedded,
        target_type: paginated.parent_type.clone(),
        paginated: true,
        direction: paginated.direction.clone(),
    }
}

/// The directives of a field the artifact keeps.
///
/// `resolved_mode` is the mode a `@paginate` actually paginates with, which is the configured
/// default when the document spelled none; recording the raw spelling made a bare `@paginate`
/// claim `SinglePage` beside an `Infinite` pagination spec.
fn recorded_directives(node: &Field, resolved_mode: Option<&str>) -> Vec<DirectiveSpec> {
    let mut result = Vec::new();
    for directive in &node.directives {
        let name = directive.name.value.as_str();
        if name == "paginate" {
            let mut arguments = JsObject::new();
            arguments.insert(
                "mode",
                GraphQLValue::EnumValue {
                    value: resolved_mode.unwrap_or("SinglePage").to_string(),
                },
            );
            result.push(DirectiveSpec { name: name.to_string(), arguments });
        } else if name == "include" || name == "skip" || name == "stream" {
            let arguments = JsObject::from_pairs(directive.arguments.iter().map(|argument| {
                (argument.name.value.clone(), value_node_to_graphql_value(&argument.value))
            }));
            result.push(DirectiveSpec { name: name.to_string(), arguments });
        }
    }
    result
}

/// `@loading`: the frame kind and, for a counted list, its depth and count.
fn loading_spec(
    directive: Option<&Directive>,
    cascade: bool,
    composite: bool,
    field_type: &TypeNode,
) -> Option<LoadingSpec> {
    if !cascade && directive.is_none() {
        return None;
    }
    let count = directive.and_then(|directive| directive.argument("count")).map(|entry| &entry.value);
    let literal = match count {
        Some(Value::IntValue { value, .. }) => Some(parse_js_number(value) as i64),
        _ => None,
    };
    // §7.2: `@loading(count: n)` is what turns a list field into `n` placeholder
    // entries; without it a list is a single `Pending`, exactly like a leaf.
    let list = list_depth(field_type) > 0;
    let kind = if list && literal.is_none() {
        "value"
    } else if composite {
        "continue"
    } else {
        "value"
    };
    Some(LoadingSpec {
        kind: kind.to_string(),
        list: literal.map(|count| LoadingListSpec { depth: list_depth(field_type) as i64, count }),
    })
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/// Merges two specs for the same response key, deep-merging their selections (A6).
fn merge_field_spec(existing: Option<&FieldSpec>, spec: &FieldSpec) -> FieldSpec {
    let Some(existing) = existing else {
        return spec.clone();
    };
    // Visibility is a union, not a race: a field selected directly (visible) and
    // again through a masked spread (invisible) is the parent's own visible field.
    let base = if existing.visible == Some(true) || spec.visible != Some(true) {
        existing
    } else {
        spec
    };
    let directives = merge_field_directives(existing, spec);
    let mut merged = match directives {
        None => without_directives(base),
        Some(directives) => {
            let mut merged = base.clone();
            merged.directives = Some(directives);
            merged
        }
    };
    // `@required` is a claim about the response key, so it survives a merge with a
    // nullable occurrence of the same key.
    if existing.required == Some(true) || spec.required == Some(true) {
        merged = as_required(&merged);
    }
    // `@defer`/`@stream` is a claim about the response key too.
    if let Some(defer) = existing.defer.clone().or_else(|| spec.defer.clone()) {
        merged.defer = Some(defer);
    }
    let left = existing.selection.as_ref();
    let right = spec.selection.as_ref();
    match (left, right) {
        (None, None) => merged,
        (None, Some(right)) => {
            merged.selection = Some(right.clone());
            merged
        }
        (Some(left), None) => {
            merged.selection = Some(left.clone());
            merged
        }
        (Some(left), Some(right)) => {
            merged.selection = Some(merge_selection(left, right));
            merged
        }
    }
}

/// A copy of `spec` marked `@required`: non-null, so no `nullable` flag.
fn as_required(spec: &FieldSpec) -> FieldSpec {
    let mut required = spec.clone();
    required.nullable = None;
    required.required = Some(true);
    required
}

/// A copy of `spec` without its `directives` member.
fn without_directives(spec: &FieldSpec) -> FieldSpec {
    let mut copy = spec.clone();
    copy.directives = None;
    copy
}

/// `true` for the compiler-only conditional-selection directives.
fn is_when_directive(directive: &DirectiveSpec) -> bool {
    directive.name == "when" || directive.name == "when_not"
}

/// The identity of one condition, so two spreads with the same one merge.
fn when_directive_key(directive: &DirectiveSpec) -> String {
    let argument = directive.arguments.get("argument");
    let value = match argument {
        Some(GraphQLValue::StringValue { value }) => value.as_str(),
        _ => "",
    };
    format!("{}:{}", directive.name, value)
}

/// The directive list of a merged field.
fn merge_field_directives(existing: &FieldSpec, spec: &FieldSpec) -> Option<Vec<DirectiveSpec>> {
    let left = existing.directives.clone().unwrap_or_default();
    let right = spec.directives.clone().unwrap_or_default();
    let base = if existing.visible == Some(true) || spec.visible != Some(true) {
        &left
    } else {
        &right
    };
    let passthrough: Vec<DirectiveSpec> =
        base.iter().filter(|directive| !is_when_directive(directive)).cloned().collect();
    let left_when: Vec<&DirectiveSpec> =
        left.iter().filter(|directive| is_when_directive(directive)).collect();
    let right_when: Vec<&DirectiveSpec> =
        right.iter().filter(|directive| is_when_directive(directive)).collect();
    // A side with no conditional entry is an unconditional selection, which clears
    // them all.
    let when: Vec<DirectiveSpec> = if left_when.is_empty() || right_when.is_empty() {
        Vec::new()
    } else {
        dedupe_by(left_when.into_iter().chain(right_when).cloned(), when_directive_key)
    };
    if passthrough.is_empty() && when.is_empty() {
        return None;
    }
    Some(passthrough.into_iter().chain(when).collect())
}

/// Merges two `fragments` map entries for one fragment name.
fn merge_fragment_spec(existing: Option<&FragmentSpec>, spec: &FragmentSpec) -> FragmentSpec {
    let Some(existing) = existing else {
        return spec.clone();
    };
    let loading = existing.loading == Some(true) || spec.loading == Some(true);
    let when = match (&existing.when, &spec.when) {
        (Some(left), Some(right)) => Some(dedupe_by(left.iter().chain(right.iter()).cloned(), |entry| {
            format!("{}:{}", entry.polarity, entry.variable)
        })),
        _ => None,
    };
    FragmentSpec {
        arguments: spec.arguments.clone(),
        loading: if loading { Some(true) } else { None },
        when,
        // The spread is deferred when any occurrence of it is: the patch still has
        // to be awaited.
        defer: existing.defer.clone().or_else(|| spec.defer.clone()),
    }
}

/// Merges `source` into `target` keeping the target's own entries first.
fn merge_selection(
    target: &SubscriptionSelection,
    source: &SubscriptionSelection,
) -> SubscriptionSelection {
    let mut fields = target.fields.clone();
    let mut fragments = target.fragments.clone();
    for (name, spec) in source.fields.iter() {
        if name == TYPENAME {
            if !fields.contains_key(name) {
                fields.insert(name.to_string(), spec.clone());
            }
            continue;
        }
        let Some(existing) = fields.get(name) else {
            fields.insert(name.to_string(), spec.clone());
            continue;
        };
        if let (Some(left), Some(right)) = (&existing.selection, &spec.selection) {
            let mut merged = existing.clone();
            merged.selection = Some(merge_selection(left, right));
            fields.insert(name.to_string(), merged);
        }
    }
    for (name, spec) in source.fragments.iter() {
        if !fragments.contains_key(name) {
            fragments.insert(name.to_string(), spec.clone());
        }
    }
    SubscriptionSelection { fields, fragments, abstract_fields: JsObject::new() }
}

/// The §9.2 abstract union: one branch per inline-fragment condition, each the
/// parent's own fields plus that branch's, and an explicit `%other` fallback.
fn abstract_fields_of(
    common: &JsObject<FieldSpec>,
    branches: &JsObject<SubscriptionSelection>,
) -> Option<JsObject<SubscriptionSelection>> {
    let conditions = branches.keys();
    if conditions.is_empty() {
        return None;
    }
    let mut result: JsObject<SubscriptionSelection> = JsObject::new();
    let base = SubscriptionSelection { fields: common.clone(), ..Default::default() };
    for condition in conditions {
        let branch = branches.get(condition).cloned().unwrap_or_default();
        let merged = merge_selection(&base, &without_typename(&branch));
        result.insert(condition.to_string(), merged);
    }
    result.insert("%other", base);
    Some(result)
}

/// A copy of a selection without its `__typename` field.
fn without_typename(selection: &SubscriptionSelection) -> SubscriptionSelection {
    let mut fields: JsObject<FieldSpec> = JsObject::new();
    for (name, spec) in selection.fields.iter() {
        if name != TYPENAME {
            fields.insert(name.to_string(), spec.clone());
        }
    }
    SubscriptionSelection {
        fields,
        fragments: selection.fragments.clone(),
        abstract_fields: selection.abstract_fields.clone(),
    }
}

/// A copy of `selection` with every field hidden from the parent's masked read.
fn hide_selection(selection: &SubscriptionSelection) -> SubscriptionSelection {
    let mut fields: JsObject<FieldSpec> = JsObject::new();
    for (name, spec) in selection.fields.iter() {
        let mut copy = spec.clone();
        copy.visible = Some(false);
        if let Some(nested) = &spec.selection {
            copy.selection = Some(hide_selection(nested));
        }
        fields.insert(name.to_string(), copy);
    }
    SubscriptionSelection {
        fields,
        fragments: selection.fragments.clone(),
        abstract_fields: JsObject::new(),
    }
}

/// Places injections directly after `__typename` in a field record.
fn with_injections(
    fields: &JsObject<FieldSpec>,
    injections: &JsObject<FieldSpec>,
) -> JsObject<FieldSpec> {
    if injections.is_empty() {
        return fields.clone();
    }
    let mut result: JsObject<FieldSpec> = JsObject::new();
    if let Some(spec) = fields.get(TYPENAME) {
        // Keep the selection's own spec: a user field aliased *to* `__typename` is a
        // normal selected field and must stay `visible` (A15).
        result.insert(TYPENAME, spec.clone());
    }
    for (name, spec) in injections.iter() {
        result.insert(name.to_string(), spec.clone());
    }
    for (name, spec) in fields.iter() {
        if name != TYPENAME && !result.contains_key(name) {
            result.insert(name.to_string(), spec.clone());
        }
    }
    result
}

// ---------------------------------------------------------------------------
// `@defer` / `@stream` (§7.13)
// ---------------------------------------------------------------------------

/// The `if:` argument of a `@defer`/`@stream`, serialized; absent means `true`.
fn defer_if_argument(directive: &Directive) -> Option<GraphQLValue> {
    directive.argument("if").map(|entry| value_node_to_graphql_value(&entry.value))
}

/// The explicit `label:` of a `@defer`/`@stream`.
fn defer_label_argument(directive: &Directive) -> Option<String> {
    directive_string_argument(Some(directive), "label")
}

/// The label a patch will carry.
fn defer_label(state: &mut State, directive: &Directive, fallback: &str) -> String {
    if let Some(explicit) = defer_label_argument(directive) {
        if !state.deferred_labels.contains(&explicit) {
            state.deferred_labels.push(explicit.clone());
        }
        return explicit;
    }
    let mut label = fallback.to_string();
    let mut suffix = 2;
    while state.deferred_labels.contains(&label) {
        label = format!("{fallback}_{suffix}");
        suffix += 1;
    }
    state.deferred_labels.push(label.clone());
    label
}

/// The `@defer` metadata of a spread or inline fragment at `path`.
fn fragment_defer_spec(
    state: &mut State,
    directive: &Directive,
    path: &[String],
    fragment: Option<&str>,
) -> DeferredSpec {
    let fallback = match fragment {
        Some(name) => name.to_string(),
        None => {
            if path.is_empty() {
                "defer_root".to_string()
            } else {
                format!("defer_{}", path.join("_"))
            }
        }
    };
    let if_argument = defer_if_argument(directive);
    DeferredSpec {
        label: defer_label(state, directive, &fallback),
        path: path.to_vec(),
        kind: "fragment".to_string(),
        if_value: if_argument,
        fragment: fragment.map(str::to_string),
        initial_count: None,
    }
}

/// The `@stream` metadata of a list field at `path`.
fn stream_defer_spec(state: &mut State, directive: &Directive, path: &[String]) -> DeferredSpec {
    let count = directive.argument("initialCount").map(|entry| &entry.value);
    let initial_count = match count {
        Some(Value::IntValue { value, .. }) => parse_js_number(value) as i64,
        _ => 0,
    };
    let if_argument = defer_if_argument(directive);
    DeferredSpec {
        label: defer_label(state, directive, &format!("stream_{}", path.join("_"))),
        path: path.to_vec(),
        kind: "list".to_string(),
        if_value: if_argument,
        fragment: None,
        initial_count: Some(initial_count),
    }
}

/// A copy of `spec` marked as delivered by the defer `metadata`.
fn as_deferred(spec: &FieldSpec, metadata: &DeferredSpec) -> FieldSpec {
    let mut copy = spec.clone();
    copy.defer = Some(metadata.clone());
    copy
}

/// [`as_deferred`] over every field of a selection.
fn mark_deferred_selection(
    selection: &SubscriptionSelection,
    metadata: &DeferredSpec,
) -> SubscriptionSelection {
    let mut fields: JsObject<FieldSpec> = JsObject::new();
    for (name, spec) in selection.fields.iter() {
        let spec = if name == TYPENAME { spec.clone() } else { as_deferred(spec, metadata) };
        fields.insert(name.to_string(), spec);
    }
    SubscriptionSelection {
        fields,
        fragments: selection.fragments.clone(),
        abstract_fields: selection.abstract_fields.clone(),
    }
}

// ---------------------------------------------------------------------------
// Raw printing
// ---------------------------------------------------------------------------

/// The immutable state one `printRaw` call threads through the printer.
struct PrintState<'a> {
    schema: &'a SchemaIndex,
    paginated: &'a [PaginatedField],
    list_fragments: Vec<String>,
    /// The cursor variables the operation has to declare for its `@paginate` field.
    injected_variables: &'a InjectedVariables,
    /// Keep the compiler's own directives (`@paginate`, `@list`, …) in the printed
    /// text. `true` only while the companion clone is being generated: its **text** is
    /// re-parsed to build the companion's IR, so the directives have to survive, while
    /// the artifact's final `raw` still strips them.
    keep_compiler_directives: bool,
}

/// The per-selection-set options of the printer.
struct PrintOptions {
    parent_type: String,
    path: Vec<String>,
    depth: usize,
    source_order: bool,
    fragment_definition: bool,
}

/// One entry of a printed selection set.
struct Entry {
    name: String,
    text: String,
    spread: bool,
}

/// Prints a document's `raw`: the definition plus every transitively referenced
/// fragment, joined by a blank line with a trailing newline (§4.4a).
pub fn print_raw(
    document: &RawDocument,
    definition: &Definition,
    documents: &[RawDocument],
    index: &DocumentIndex,
    schema: &SchemaIndex,
    paginated: &[PaginatedField],
    injected_variables: &InjectedVariables,
) -> String {
    let _ = document;
    let state = PrintState {
        schema,
        paginated,
        list_fragments: list_fragment_names(index.lists.keys().into_iter()),
        injected_variables,
        keep_compiler_directives: false,
    };
    let source_order = matches!(definition, Definition::Fragment(_));
    let mut parts = vec![print_definition(definition, &state, source_order)];
    for name in transitive_spreads(definition, index) {
        if let Some(fragment) = index.fragment_node(documents, &name) {
            parts.push(print_definition(
                &Definition::Fragment(fragment.clone()),
                &state,
                false,
            ));
        }
    }
    format!("{}\n", parts.join("\n\n"))
}

/// Every `<list>_<action>` fragment name the project's lists generate.
pub fn list_fragment_names<'a>(lists: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut names = Vec::new();
    for name in lists {
        for action in ["insert", "remove", "toggle", "upsert"] {
            names.push(format!("{name}_{action}"));
        }
    }
    names
}

/// Prints a paginated fragment's internal clone (§3): the fragment's own text with
/// every `@paginate` field binding the canonical page variables and its connection
/// carrying the injected `pageInfo`.
pub fn print_companion_clone(
    node: &FragmentDefinition,
    schema: &SchemaIndex,
    paginated: &[PaginatedField],
    list_fragments: &[String],
) -> String {
    let empty = InjectedVariables::new();
    let state = PrintState {
        schema,
        paginated,
        list_fragments: list_fragments.to_vec(),
        injected_variables: &empty,
        keep_compiler_directives: true,
    };
    print_definition(&Definition::Fragment(node.clone()), &state, true)
}

/// One definition plus its (sorted or source-ordered) selection set.
///
/// A type system definition has no root selection; the extraction rejects such a
/// document before any IR is printed, and the shared empty set keeps the match total.
fn print_definition(definition: &Definition, state: &PrintState, source_order: bool) -> String {
    static EMPTY: SelectionSet = SelectionSet { selections: Vec::new(), loc: None };
    let (header, root, selection_set, is_fragment) = match definition {
        Definition::Fragment(node) => (
            format!("fragment {} on {}", node.name.value, node.type_condition.name.value),
            node.type_condition.name.value.clone(),
            &node.selection_set,
            true,
        ),
        Definition::Operation(node) => (
            format!(
                "{}{}{}",
                node.operation.as_str(),
                match &node.name {
                    Some(name) => format!(" {}", name.value),
                    None => String::new(),
                },
                print_variables(node, state),
            ),
            root_type_of(operation_kind(node.operation), state.schema),
            &node.selection_set,
            false,
        ),
        Definition::TypeSystem(_) => (String::new(), String::new(), &EMPTY, false),
    };
    let body = print_selections(
        selection_set,
        state,
        &PrintOptions {
            parent_type: root,
            path: Vec::new(),
            depth: 1,
            source_order,
            fragment_definition: is_fragment,
        },
    );
    format!("{header} {{\n{body}\n}}")
}

/// The artifact kind of an operation type.
fn operation_kind(operation: OperationType) -> ArtifactKind {
    match operation {
        OperationType::Query => ArtifactKind::Query,
        OperationType::Mutation => ArtifactKind::Mutation,
        OperationType::Subscription => ArtifactKind::Subscription,
    }
}

/// The declared order of the injected page variables: the four cursors canonically, then any
/// other binding (an offset field's `limit`/`offset`) in the order the plan recorded it.
fn injected_variable_order<'a>(state: &'a PrintState) -> Vec<&'a str> {
    injected_variable_order_from(state.injected_variables)
}

/// [`injected_variable_order`] over a bare binding list.
fn injected_variable_order_from<'a>(injected: &'a InjectedVariables) -> Vec<&'a str> {
    let mut names: Vec<&str> = CURSOR_ARGUMENTS
        .iter()
        .copied()
        .filter(|name| map_get(injected, name).is_some())
        .collect();
    for (name, _) in injected {
        if !names.contains(&name.as_str()) {
            names.push(name.as_str());
        }
    }
    names
}

/// `($a: Int = 1, $b: String)`, with the injected cursor variables appended.
fn print_variables(definition: &OperationDefinition, state: &PrintState) -> String {
    let variables = &definition.variable_definitions;
    let mut parts: Vec<String> = variables.iter().map(print_variable_definition).collect();
    // The page variables a `@paginate` field binds are declared after the user's own,
    // unless the document already declares that name. The four cursors come first, in the
    // runtime's canonical order; an offset field's `limit`/`offset` follow in the order the
    // plan bound them.
    for name in injected_variable_order(state) {
        let Some(variable) = map_get(state.injected_variables, name) else {
            continue;
        };
        if variables.iter().any(|entry| entry.variable.name.value == *name) {
            continue;
        }
        let value = match &variable.value {
            None => String::new(),
            Some(value) => format!(" = {}", print_graphql_value(value)),
        };
        parts.push(format!("${name}: {}{value}", variable.type_name));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("({})", parts.join(", "))
    }
}

/// One variable definition, as graphql-js prints it.
fn print_variable_definition(node: &VariableDefinition) -> String {
    let mut text = format!("${}: {}", node.variable.name.value, print_type_node(&node.type_node));
    if let Some(default) = &node.default_value {
        text.push_str(&format!(" = {}", print_value(default)));
    }
    if !node.directives.is_empty() {
        let directives: Vec<String> = node.directives.iter().map(print_directive).collect();
        text.push(' ');
        text.push_str(&directives.join(" "));
    }
    text
}

/// One directive, as graphql-js prints it: `@name(a: 1)`.
fn print_directive(node: &Directive) -> String {
    let arguments: Vec<String> = node.arguments.iter().map(print_argument).collect();
    if arguments.is_empty() {
        format!("@{}", node.name.value)
    } else {
        format!("@{}({})", node.name.value, arguments.join(", "))
    }
}

/// One argument, as graphql-js prints it: `name: value`.
fn print_argument(node: &Argument) -> String {
    format!("{}: {}", node.name.value, print_value(&node.value))
}

/// One already-normalized GraphQL value, as graphql-js prints a value node.
///
/// The block-string form cannot be recovered from a [`GraphQLValue`], which stores
/// the decoded string; a block-string cursor default therefore prints quoted.
fn print_graphql_value(value: &GraphQLValue) -> String {
    match value {
        GraphQLValue::Variable { name } => format!("${name}"),
        GraphQLValue::IntValue { value }
        | GraphQLValue::FloatValue { value }
        | GraphQLValue::EnumValue { value } => value.clone(),
        GraphQLValue::StringValue { value } => print_string(value),
        GraphQLValue::BooleanValue { value } => if *value { "true" } else { "false" }.to_string(),
        GraphQLValue::NullValue => "null".to_string(),
        GraphQLValue::ListValue { values } => {
            let values: Vec<String> = values.iter().map(print_graphql_value).collect();
            format!("[{}]", values.join(", "))
        }
        GraphQLValue::ObjectValue { fields } => {
            let fields: Vec<String> = fields
                .iter()
                .map(|(name, value)| format!("{name}: {}", print_graphql_value(value)))
                .collect();
            format!("{{{}}}", fields.join(", "))
        }
    }
}

/// `printString` from `language/printString.js`: control characters and
/// `"`/`\`/DEL/C1 escaped, everything else literal.
fn print_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        let code = character as u32;
        match code {
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0a => out.push_str("\\n"),
            0x0c => out.push_str("\\f"),
            0x0d => out.push_str("\\r"),
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            _ if code <= 0x1f || (0x7f..=0x9f).contains(&code) => {
                out.push_str(&format!("\\u{code:04X}"))
            }
            _ => out.push(character),
        }
    }
    out.push('"');
    out
}

/// One printed selection set, one entry per line.
fn print_selections(
    selection_set: &SelectionSet,
    state: &PrintState,
    options: &PrintOptions,
) -> String {
    let indent = "    ".repeat(options.depth);
    let mut entries: Vec<Entry> = Vec::new();
    let mut present: Vec<String> = Vec::new();
    // `pageInfo` is a connection's field: the raw printer injects it for a cursor connection only
    // (`addFields.go:191-206`), never for an offset-paginated list.
    let paginated_here = state
        .paginated
        .iter()
        .any(|entry| entry.path == options.path && entry.method == "cursor");
    let parent_path: &[String] = if options.path.is_empty() {
        &[]
    } else {
        &options.path[..options.path.len() - 1]
    };
    let is_edge = options.path.last().is_some_and(|name| name == "edges")
        && state
            .paginated
            .iter()
            .any(|entry| entry.path == parent_path && entry.mode == "SinglePage");
    let is_page_info = options.path.last().is_some_and(|name| name == "pageInfo")
        && state.paginated.iter().any(|entry| entry.path == parent_path);

    for selection in &selection_set.selections {
        match selection {
            Selection::FragmentSpread(node) => {
                if state.list_fragments.iter().any(|name| name == &node.name.value) {
                    continue;
                }
                entries.push(Entry {
                    name: node.name.value.clone(),
                    text: print_spread(node),
                    spread: true,
                });
            }
            Selection::InlineFragment(node) => {
                let condition = node.type_condition.as_ref().map(|entry| entry.name.value.clone());
                let inner = print_selections(
                    &node.selection_set,
                    state,
                    &PrintOptions {
                        parent_type: condition
                            .clone()
                            .unwrap_or_else(|| options.parent_type.clone()),
                        path: options.path.clone(),
                        depth: options.depth + 1,
                        source_order: options.source_order,
                        fragment_definition: false,
                    },
                );
                let head = format!(
                    "...{}{}",
                    match &condition {
                        Some(condition) => format!(" on {condition}"),
                        None => String::new(),
                    },
                    print_pass_through_directives(&node.directives),
                );
                entries.push(Entry {
                    name: condition.unwrap_or_default(),
                    text: format!("{head} {{\n{inner}\n{indent}}}"),
                    spread: true,
                });
            }
            Selection::Field(node) => {
                let response_key = node.response_key().to_string();
                present.push(response_key.clone());
                let text = print_field(node, state, options, &response_key);
                entries.push(Entry { name: response_key, text, spread: false });
            }
        }
    }

    if is_edge && !present.iter().any(|name| name == "cursor") {
        entries.push(Entry { name: "cursor".to_string(), text: "cursor".to_string(), spread: false });
    }
    if is_page_info {
        for name in ["endCursor", "hasNextPage", "hasPreviousPage", "startCursor"] {
            if !present.iter().any(|present_name| present_name == name) {
                entries.push(Entry {
                    name: name.to_string(),
                    text: name.to_string(),
                    spread: false,
                });
            }
        }
    }
    if paginated_here && !present.iter().any(|name| name == "pageInfo") {
        let inner = ["__typename", "endCursor", "hasNextPage", "hasPreviousPage", "startCursor"]
            .iter()
            .map(|name| format!("{}{}", "    ".repeat(options.depth + 1), name))
            .collect::<Vec<String>>()
            .join("\n");
        entries.push(Entry {
            name: "pageInfo".to_string(),
            text: format!("pageInfo {{\n{inner}\n{indent}}}"),
            spread: false,
        });
    }
    if paginated_here && !present.iter().any(|name| name == "edges") {
        // The document selected only `nodes`: the connection still has to carry `edges`, or the
        // runtime has nowhere to write a locally inserted edge and no page snapshot to read
        // (`review-f3`). Injected here rather than in the IR because `raw` is printed from the
        // AST; the shape matches `injected_edges`.
        if let Some(edges_type) = state.schema.field_type(&options.parent_type, "edges") {
            let mut element = edges_type;
            loop {
                match element {
                    TypeNode::List(inner) => element = &inner.type_node,
                    TypeNode::NonNull(inner) => element = &inner.type_node,
                    TypeNode::Named(_) => break,
                }
            }
            let one = "    ".repeat(options.depth + 1);
            let two = "    ".repeat(options.depth + 2);
            let node_type = state.schema.field_type(named_type_of(element), "node");
            let node = match node_type {
                None => String::new(),
                Some(node_type) => {
                    // the node's own key fields, which `injected_edges` injects beside
                    // `__typename` so the connection's membership ids are node records
                    let node_name = named_type_of(node_type);
                    let keys = state
                        .schema
                        .key_fields_for_type(node_name)
                        .iter()
                        .filter(|name| state.schema.field_type(node_name, name).is_some())
                        .cloned()
                        .collect::<Vec<String>>();
                    let mut inner: Vec<String> = vec![TYPENAME.to_string()];
                    inner.extend(keys);
                    let body = inner
                        .iter()
                        .map(|name| format!("{two}{name}"))
                        .collect::<Vec<String>>()
                        .join("\n");
                    format!("\n{one}node {{\n{body}\n{one}}}")
                }
            };
            entries.push(Entry {
                name: "edges".to_string(),
                text: format!("edges {{\n{one}{TYPENAME}{node}\n{indent}}}"),
                spread: false,
            });
        }
    }
    if !present.iter().any(|name| name == TYPENAME)
        && (!options.path.is_empty() || options.source_order || options.fragment_definition)
    {
        entries.push(Entry {
            name: TYPENAME.to_string(),
            text: TYPENAME.to_string(),
            spread: false,
        });
    }

    let ordered = if options.source_order { entries } else { sort_entries(entries) };
    ordered.iter().map(|entry| format!("{indent}{}", entry.text)).collect::<Vec<String>>().join("\n")
}

/// Operations print sorted with `__typename` first and spreads last (§4.6).
fn sort_entries(entries: Vec<Entry>) -> Vec<Entry> {
    let mut typename: Vec<Entry> = Vec::new();
    let mut fields: Vec<Entry> = Vec::new();
    let mut spreads: Vec<Entry> = Vec::new();
    for entry in entries {
        if entry.spread {
            spreads.push(entry);
        } else if entry.name == TYPENAME {
            typename.push(entry);
        } else {
            fields.push(entry);
        }
    }
    fields.sort_by(|a, b| crate::naming::compare_names(&a.name, &b.name));
    spreads.sort_by(|a, b| crate::naming::compare_names(&a.name, &b.name));
    typename.into_iter().chain(fields).chain(spreads).collect()
}

/// One field, with its arguments, directives and nested selection.
fn print_field(
    node: &Field,
    state: &PrintState,
    options: &PrintOptions,
    response_key: &str,
) -> String {
    let path: Vec<String> = options.path.iter().cloned().chain([response_key.to_string()]).collect();
    let paginated_here = state.paginated.iter().find(|entry| entry.path == path);
    // A paginated field prints its page arguments as the page variables in both
    // modes: the runtime varies them per request, so a literal could never advance a
    // page (§7.3). Which arguments those are follows the field's value type.
    let args: Vec<String> = match paginated_here {
        Some(entry) => page_argument_plan(node, &entry.method).arguments,
        None => node.arguments.iter().map(print_argument).collect(),
    };
    let alias = match &node.alias {
        Some(alias) => format!("{}: ", alias.value),
        None => String::new(),
    };
    let directives = if state.keep_compiler_directives {
        print_compiler_directives(&node.directives)
    } else {
        print_pass_through_directives(&node.directives)
    };
    let head = format!(
        "{alias}{}{}{}",
        node.name.value,
        if args.is_empty() { String::new() } else { format!("({})", args.join(", ")) },
        directives,
    );
    let Some(selection_set) = &node.selection_set else {
        return head;
    };
    let named = state.schema.field_type(&options.parent_type, &node.name.value);
    let inner = print_selections(
        selection_set,
        state,
        &PrintOptions {
            parent_type: match named {
                Some(node) => named_type_of(node).to_string(),
                None => options.parent_type.clone(),
            },
            path,
            depth: options.depth + 1,
            source_order: options.source_order,
            fragment_definition: false,
        },
    );
    format!("{head} {{\n{inner}\n{}}}", "    ".repeat(options.depth))
}

/// A fragment spread without its compiler-only directives.
fn print_spread(node: &FragmentSpread) -> String {
    format!(
        "...{}{}{}",
        node.name.value,
        print_pass_through_directives(&node.directives),
        print_when_condition(node),
    )
}

/// `@when(argument: "x")` → `@include(if: $x)`, `@when_not(argument: "x")` → `@skip(if: $x)`.
fn print_when_condition(node: &FragmentSpread) -> String {
    let mut parts: Vec<String> = Vec::new();
    for directive in &node.directives {
        let name = directive.name.value.as_str();
        if name != "when" && name != "when_not" {
            continue;
        }
        let Some(variable) = directive_string_argument(Some(directive), "argument") else {
            continue;
        };
        parts.push(if name == "when" {
            format!(" @include(if: ${variable})")
        } else {
            format!(" @skip(if: ${variable})")
        });
    }
    parts.join("")
}

/// The `@include`/`@skip` directives of a node, printed for `raw`.
fn print_pass_through_directives(directives: &[Directive]) -> String {
    directives
        .iter()
        .filter(|directive| PASS_THROUGH_DIRECTIVES.contains(&directive.name.value.as_str()))
        .map(|directive| format!(" {}", print_directive(directive)))
        .collect::<Vec<String>>()
        .join("")
}

/// Every directive the compiler owns, as written (`@paginate`, `@list`, `@includeListID`).
fn print_compiler_directives(directives: &[Directive]) -> String {
    directives
        .iter()
        .filter(|directive| !PASS_THROUGH_DIRECTIVES.contains(&directive.name.value.as_str()))
        .map(|directive| format!(" {}", print_directive(directive)))
        .collect::<Vec<String>>()
        .join("")
}

/// The operation type of a definition, for the IR's root selection.
pub fn operation_type_of(definition: &Definition) -> Option<OperationType> {
    match definition {
        Definition::Operation(node) => Some(node.operation),
        Definition::Fragment(_) => None,
        Definition::TypeSystem(_) => None,
    }
}

/// `true` when a field spec is the injected `__typename`.
///
/// True for the compiler-injected `__typename` spec (by identity). A user field the
/// document aliases *to* `__typename` looks the same structurally but is a normal
/// selected field, so it must keep its `visible: true` in the artifact.
pub fn is_injected_typename(spec: &FieldSpec) -> bool {
    spec.key_raw == TYPENAME && spec.visible != Some(true) && spec.selection.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_typename_needs_the_invisible_shape() {
        assert!(is_injected_typename(&typename_spec()));
        let mut masked = typename_spec();
        masked.visible = Some(false);
        assert!(is_injected_typename(&masked));
        let aliased = FieldSpec {
            type_name: "String".to_string(),
            modifiers: "String!".to_string(),
            key_raw: TYPENAME.to_string(),
            visible: Some(true),
            ..Default::default()
        };
        assert!(!is_injected_typename(&aliased));
    }

    #[test]
    fn print_string_matches_graphql_js() {
        assert_eq!(print_string("abc"), "\"abc\"");
        assert_eq!(print_string("a\nb"), "\"a\\nb\"");
        assert_eq!(print_string("\u{7f}"), "\"\\u007F\"");
        assert_eq!(print_string("\u{1}"), "\"\\u0001\"");
        assert_eq!(print_string("é"), "\"é\"");
    }

    #[test]
    fn joining_paths_uses_dots() {
        assert_eq!(key(&[]), "");
        assert_eq!(key(&["a".to_string(), "b".to_string()]), "a.b");
        assert_eq!(key_of(&[], "id"), "id");
        assert_eq!(key_of(&["a".to_string()], "id"), "a.id");
    }

    #[test]
    fn map_set_keeps_the_first_position() {
        let mut entries: Vec<(String, i32)> = Vec::new();
        map_set(&mut entries, "a".to_string(), 1);
        map_set(&mut entries, "b".to_string(), 2);
        map_set(&mut entries, "a".to_string(), 3);
        assert_eq!(entries, vec![("a".to_string(), 3), ("b".to_string(), 2)]);
    }

    #[test]
    fn dedupe_is_first_position_last_value() {
        let deduped =
            dedupe_by(vec![("a", 1), ("b", 2), ("a", 3)], |entry| entry.0.to_string());
        assert_eq!(deduped, vec![("a", 3), ("b", 2)]);
    }
}
