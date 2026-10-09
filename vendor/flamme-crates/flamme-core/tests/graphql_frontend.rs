//! The GraphQL front end against graphql-js.
//!
//! `tests/fixtures/frozen/graphql_frontend.json` is the verbatim report the
//! repository's installed `graphql` package produced over the fixtures in
//! `tests/fixtures/graphql/`, captured before `packages/core/src` was deleted; this
//! test runs the Rust port over the same fixtures and compares:
//!
//!   1. `print_document(&parse_document(text)?)` with `print(parse(text))`, byte for
//!      byte, plus the round trip `print(parse(print(parse(text))))`.
//!   2. the type system AST with a structural summary of `parse(text)`, and
//!      `print_type_node(&parse_type(text)?)` with `print(parseType(text))`.
//!   3. `SyntaxError.message`/`line`/`column` with `error.message` and
//!      `error.locations[0]` for documents both sides reject.
//!   4. every node location the report carries, which is where UTF-16 offsets show.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use flamme_core::graphql::ast;
use flamme_core::graphql::{
    parse_document, parse_type, parse_type_system_document, print_document, print_type_node,
    print_value, Definition,
};
use serde_json::{json, Value};

/// The fixture directory.
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/graphql")
}

/// One fixture: its file name and its text.
struct Fixture {
    name: String,
    text: String,
}

/// Reads one fixture directory, sorted by file name, the way the report does.
fn fixture_dir(directory: &str) -> Vec<Fixture> {
    let path = fixtures().join(directory);
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
        .map(|entry| entry.expect("directory entry").path())
        .collect();
    entries.sort();
    entries
        .into_iter()
        .map(|entry| Fixture {
            name: entry.file_name().expect("file name").to_string_lossy().into_owned(),
            text: std::fs::read_to_string(&entry)
                .unwrap_or_else(|error| panic!("read {}: {error}", entry.display())),
        })
        .collect()
}

/// The frozen graphql-js report, read once per test binary.
fn report() -> &'static Value {
    static REPORT: OnceLock<Value> = OnceLock::new();
    REPORT.get_or_init(|| {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/frozen/graphql_frontend.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{} is missing: {error}", path.display()));
        serde_json::from_str(&text).expect("the frozen report is JSON")
    })
}

/// One report section, keyed by fixture name.
fn section(name: &str) -> &'static serde_json::Map<String, Value> {
    report().get(name).and_then(Value::as_object).unwrap_or_else(|| panic!("report section {name}"))
}

/// The section's entry for a fixture, failing loudly when the names disagree.
fn entry(section_name: &str, fixture: &Fixture) -> &'static Value {
    section(section_name).get(&fixture.name).unwrap_or_else(|| {
        panic!("the frozen report has no {section_name} entry for {}", fixture.name)
    })
}

/// The fixtures of one directory paired with their frozen entry. The counts have to
/// agree, so a fixture the report stopped covering cannot silently go unchecked.
fn fixture_entries(section_name: &str, directory: &str) -> Vec<(Fixture, &'static Value)> {
    let fixtures = fixture_dir(directory);
    assert_eq!(
        fixtures.len(),
        section(section_name).len(),
        "{section_name}: the frozen report covers a different number of fixtures"
    );
    assert!(!fixtures.is_empty(), "{section_name}: no fixtures");
    fixtures
        .into_iter()
        .map(|fixture| {
            let value = entry(section_name, &fixture);
            (fixture, value)
        })
        .collect()
}

/// `{ message, line, column }` of a frozen syntax error.
fn frozen_error(value: &Value) -> (String, i64, i64) {
    let error = value.get("error").expect("an error field");
    assert!(!error.is_null(), "graphql-js accepted a fixture this test expects it to reject");
    (
        error["message"].as_str().expect("message").to_string(),
        error["line"].as_i64().expect("line"),
        error["column"].as_i64().expect("column"),
    )
}

// ---------------------------------------------------------------------------
// 1. Valid executable documents print byte for byte.
// ---------------------------------------------------------------------------

#[test]
fn valid_documents_print_like_graphql_js() {
    for (fixture, expected) in fixture_entries("valid", "valid") {
        assert!(
            expected["error"].is_null(),
            "{}: graphql-js rejected the fixture: {}",
            fixture.name,
            expected["error"]
        );
        let document = parse_document(&fixture.text)
            .unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
        assert_eq!(
            print_document(&document),
            expected["printed"].as_str().expect("printed"),
            "{} prints differently",
            fixture.name
        );
    }
}

// ---------------------------------------------------------------------------
// 4. Round trip: parse, print, parse, print is stable.
// ---------------------------------------------------------------------------

#[test]
fn printed_documents_round_trip() {
    for (fixture, expected) in fixture_entries("valid", "valid") {
        let first = print_document(&parse_document(&fixture.text).expect("the fixture parses"));
        let document = parse_document(&first)
            .unwrap_or_else(|error| panic!("{}: reparse: {error}", fixture.name));
        let second = print_document(&document);
        assert_eq!(first, second, "{} is not stable under a round trip", fixture.name);
        assert_eq!(
            second,
            expected["reprinted"].as_str().expect("reprinted"),
            "{} reparses differently from graphql-js",
            fixture.name
        );
    }
}

// ---------------------------------------------------------------------------
// 2. Type system documents and type references.
// ---------------------------------------------------------------------------

#[test]
fn type_system_documents_match_the_frozen_report() {
    for (fixture, expected) in fixture_entries("sdl", "sdl") {
        assert!(
            expected["error"].is_null(),
            "{}: graphql-js rejected the fixture: {}",
            fixture.name,
            expected["error"]
        );
        let document = parse_type_system_document(&fixture.text)
            .unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
        let shapes: Vec<Value> = document.definitions.iter().map(definition_shape).collect();
        assert_eq!(
            Value::Array(shapes),
            expected["shapes"],
            "{} parses into a different AST",
            fixture.name
        );
    }
}

#[test]
fn type_references_print_like_graphql_js() {
    for (fixture, expected) in fixture_entries("types", "types") {
        assert!(
            expected["error"].is_null(),
            "{}: graphql-js rejected the fixture: {}",
            fixture.name,
            expected["error"]
        );
        let type_node = parse_type(&fixture.text)
            .unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
        assert_eq!(
            print_type_node(&type_node),
            expected["printed"].as_str().expect("printed"),
            "{} prints differently",
            fixture.name
        );
    }
}

/// `descriptionOf(node)`: the description's text, or null.
fn description_of(description: &Option<String>) -> Value {
    json!(description.as_deref())
}

/// `directivesOf(node)`: names with their arguments' printed values.
fn directives_of(directives: &[ast::Directive]) -> Value {
    Value::Array(
        directives
            .iter()
            .map(|directive| {
                json!({
                    "name": directive.name.value,
                    "arguments": directive
                        .arguments
                        .iter()
                        .map(|argument| json!([argument.name.value, print_value(&argument.value)]))
                        .collect::<Vec<Value>>(),
                })
            })
            .collect(),
    )
}

/// `inputValueShape(node)`.
fn input_value_shape(node: &ast::InputValueDefinition) -> Value {
    json!({
        "description": description_of(&node.description),
        "name": node.name.value,
        "type": print_type_node(&node.type_node),
        "defaultValue": node.default_value.as_ref().map(print_value),
        "directives": directives_of(&node.directives),
    })
}

/// `fieldShape(node)`.
fn field_shape(node: &ast::FieldDefinition) -> Value {
    json!({
        "description": description_of(&node.description),
        "name": node.name.value,
        "arguments": node.arguments.iter().map(input_value_shape).collect::<Vec<Value>>(),
        "type": print_type_node(&node.type_node),
        "directives": directives_of(&node.directives),
    })
}

/// `enumValueShape(node)`.
fn enum_value_shape(node: &ast::EnumValueDefinition) -> Value {
    json!({
        "description": description_of(&node.description),
        "name": node.name.value,
        "directives": directives_of(&node.directives),
    })
}

/// `operationTypes` of a schema definition or extension.
fn operation_types(operation_types: &[ast::OperationTypeDefinition]) -> Value {
    Value::Array(
        operation_types
            .iter()
            .map(|node| json!([node.operation.as_str(), node.type_name.value]))
            .collect(),
    )
}

/// One entry of `parse_definition`'s shape, empty for a schema extension.
fn named(kind: &str, description: &Option<String>, name: Option<&str>) -> Value {
    json!({
        "kind": kind,
        "description": description_of(description),
        "name": name,
    })
}

/// `definitionShape(node)`.
fn definition_shape(definition: &ast::TypeSystemDefinition) -> Value {
    match definition {
        ast::TypeSystemDefinition::Schema(node) => {
            let kind = if node.is_extension { "SchemaExtension" } else { "SchemaDefinition" };
            // A schema extension has no name in graphql-js either.
            json!({
                "kind": kind,
                "description": description_of(&node.description),
                "directives": directives_of(&node.directives),
                "operationTypes": operation_types(&node.operation_types),
            })
        }
        ast::TypeSystemDefinition::Directive(node) => json!({
            "kind": "DirectiveDefinition",
            "description": description_of(&node.description),
            "name": node.name.value,
            "arguments": node.arguments.iter().map(input_value_shape).collect::<Vec<Value>>(),
            "repeatable": node.repeatable,
            "locations": node.locations.iter().map(|location| &location.value).collect::<Vec<_>>(),
        }),
        ast::TypeSystemDefinition::Type(node) => {
            let (kind, description, name, interfaces, directives, fields) = match node {
                ast::TypeDefinition::Scalar(node) => (
                    if node.is_extension { "ScalarTypeExtension" } else { "ScalarTypeDefinition" },
                    &node.description,
                    &node.name,
                    None,
                    &node.directives,
                    None,
                ),
                ast::TypeDefinition::Object(node) => (
                    if node.is_extension { "ObjectTypeExtension" } else { "ObjectTypeDefinition" },
                    &node.description,
                    &node.name,
                    Some(&node.interfaces),
                    &node.directives,
                    Some(FieldList::Fields(&node.fields)),
                ),
                ast::TypeDefinition::Interface(node) => (
                    if node.is_extension {
                        "InterfaceTypeExtension"
                    } else {
                        "InterfaceTypeDefinition"
                    },
                    &node.description,
                    &node.name,
                    Some(&node.interfaces),
                    &node.directives,
                    Some(FieldList::Fields(&node.fields)),
                ),
                ast::TypeDefinition::Union(node) => (
                    if node.is_extension { "UnionTypeExtension" } else { "UnionTypeDefinition" },
                    &node.description,
                    &node.name,
                    None,
                    &node.directives,
                    Some(FieldList::UnionTypes(&node.types)),
                ),
                ast::TypeDefinition::Enum(node) => (
                    if node.is_extension { "EnumTypeExtension" } else { "EnumTypeDefinition" },
                    &node.description,
                    &node.name,
                    None,
                    &node.directives,
                    Some(FieldList::EnumValues(&node.values)),
                ),
                ast::TypeDefinition::InputObject(node) => (
                    if node.is_extension {
                        "InputObjectTypeExtension"
                    } else {
                        "InputObjectTypeDefinition"
                    },
                    &node.description,
                    &node.name,
                    None,
                    &node.directives,
                    Some(FieldList::InputFields(&node.fields)),
                ),
            };
            let mut shape = named(kind, description, Some(&name.value));
            if let Some(interfaces) = interfaces {
                shape["interfaces"] =
                    json!(interfaces.iter().map(|node| &node.name.value).collect::<Vec<_>>());
            }
            shape["directives"] = directives_of(directives);
            match fields {
                Some(FieldList::Fields(fields)) => {
                    shape["fields"] =
                        Value::Array(fields.iter().map(field_shape).collect::<Vec<Value>>());
                }
                Some(FieldList::UnionTypes(types)) => {
                    shape["types"] =
                        json!(types.iter().map(|node| &node.name.value).collect::<Vec<_>>());
                }
                Some(FieldList::EnumValues(values)) => {
                    shape["values"] =
                        Value::Array(values.iter().map(enum_value_shape).collect::<Vec<Value>>());
                }
                Some(FieldList::InputFields(fields)) => {
                    shape["fields"] = Value::Array(
                        fields.iter().map(input_value_shape).collect::<Vec<Value>>(),
                    );
                }
                None => {}
            }
            shape
        }
    }
}

/// The list a type definition carries, so one arm can build every shape.
enum FieldList<'a> {
    /// Object and interface definitions.
    Fields(&'a [ast::FieldDefinition]),
    /// Union definitions.
    UnionTypes(&'a [ast::NamedType]),
    /// Enum definitions.
    EnumValues(&'a [ast::EnumValueDefinition]),
    /// Input object definitions.
    InputFields(&'a [ast::InputValueDefinition]),
}

// ---------------------------------------------------------------------------
// 3. Syntax errors.
// ---------------------------------------------------------------------------

#[test]
fn invalid_documents_report_the_frozen_error() {
    for (fixture, value) in fixture_entries("invalid", "invalid") {
        let expected = frozen_error(value);
        let error = parse_document(&fixture.text)
            .err()
            .unwrap_or_else(|| panic!("{}: the port accepted an invalid document", fixture.name));
        assert_eq!(error.message, expected.0, "{}: message", fixture.name);
        assert_eq!(error.line as i64, expected.1, "{}: line", fixture.name);
        assert_eq!(error.column as i64, expected.2, "{}: column", fixture.name);
    }
}

#[test]
fn invalid_type_system_documents_report_the_frozen_error() {
    for (fixture, value) in fixture_entries("invalidSdl", "invalid-sdl") {
        let expected = frozen_error(value);
        let error = parse_type_system_document(&fixture.text)
            .err()
            .unwrap_or_else(|| panic!("{}: the port accepted an invalid document", fixture.name));
        assert_eq!(error.message, expected.0, "{}: message", fixture.name);
        assert_eq!(error.line as i64, expected.1, "{}: line", fixture.name);
        assert_eq!(error.column as i64, expected.2, "{}: column", fixture.name);
    }
}

// ---------------------------------------------------------------------------
// UTF-16 locations.
// ---------------------------------------------------------------------------

#[test]
fn locations_match_the_frozen_report_in_utf16_units() {
    for (fixture, expected) in fixture_entries("offsets", "offsets") {
        assert!(
            expected["error"].is_null(),
            "{}: graphql-js rejected the fixture: {}",
            fixture.name,
            expected["error"]
        );
        let document = parse_document(&fixture.text)
            .unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
        let locs = collect_locs(&document);
        assert_eq!(Value::Array(locs), expected["locs"], "{}: locations", fixture.name);
        assert_eq!(
            print_document(&document),
            expected["printed"].as_str().expect("printed"),
            "{} prints differently",
            fixture.name
        );
    }
}

/// The walker `collectLocs` that produced the frozen report mirrors: every node's
/// kind, its label and its UTF-16 range, in depth-first source order.
fn collect_locs(document: &ast::Document) -> Vec<Value> {
    let mut out = Vec::new();
    for definition in &document.definitions {
        match definition {
            ast::Definition::Operation(node) => {
                push_loc(
                    &mut out,
                    "OperationDefinition",
                    node.name.as_ref().map(|name| name.value.clone()).unwrap_or_default(),
                    node.loc,
                );
                for variable_definition in &node.variable_definitions {
                    collect_variable_definition(variable_definition, &mut out);
                }
                for directive in &node.directives {
                    push_loc(&mut out, "Directive", directive.name.value.clone(), directive.loc);
                }
                collect_selection_set(&node.selection_set, &mut out);
            }
            ast::Definition::Fragment(node) => {
                push_loc(&mut out, "FragmentDefinition", node.name.value.clone(), node.loc);
                push_loc(
                    &mut out,
                    "NamedType",
                    node.type_condition.name.value.clone(),
                    node.type_condition.loc,
                );
                for directive in &node.directives {
                    push_loc(&mut out, "Directive", directive.name.value.clone(), directive.loc);
                }
                collect_selection_set(&node.selection_set, &mut out);
            }
            // A type system definition is not part of any corpus fixture: the pipeline
            // rejects such a document at extraction, so the report's walker and this one
            // never see the same one. `the_executable_entry_point_parses_what_the_pipeline_rejects`
            // covers the parse, and the node is named rather than skipped so a fixture
            // added later fails loudly here instead of silently comparing less.
            ast::Definition::TypeSystem(node) => {
                push_loc(&mut out, "TypeSystemDefinition", String::new(), node.loc())
            }
        }
    }
    out
}

/// One `VariableDefinition` and everything under it.
fn collect_variable_definition(node: &ast::VariableDefinition, out: &mut Vec<Value>) {
    push_loc(out, "VariableDefinition", String::new(), node.loc);
    push_loc(out, "Variable", node.variable.name.value.clone(), node.variable.loc);
    push_loc(out, node.type_node.kind(), print_type_node(&node.type_node), node.type_node.loc());
    if let Some(default_value) = &node.default_value {
        collect_value(default_value, out);
    }
    for directive in &node.directives {
        push_loc(out, "Directive", directive.name.value.clone(), directive.loc);
    }
}

/// Every selection of a selection set, in source order.
fn collect_selection_set(node: &ast::SelectionSet, out: &mut Vec<Value>) {
    for selection in &node.selections {
        match selection {
            ast::Selection::Field(node) => {
                push_loc(out, "Field", node.response_key().to_string(), node.loc);
                push_loc(out, "FieldName", node.name.value.clone(), node.name.loc);
                for argument in &node.arguments {
                    push_loc(out, "Argument", argument.name.value.clone(), argument.loc);
                    collect_value(&argument.value, out);
                }
                for directive in &node.directives {
                    push_loc(out, "Directive", directive.name.value.clone(), directive.loc);
                }
                if let Some(selection_set) = &node.selection_set {
                    collect_selection_set(selection_set, out);
                }
            }
            ast::Selection::FragmentSpread(node) => {
                push_loc(out, "FragmentSpread", node.name.value.clone(), node.loc);
                for directive in &node.directives {
                    push_loc(out, "Directive", directive.name.value.clone(), directive.loc);
                }
            }
            ast::Selection::InlineFragment(node) => {
                let label = node
                    .type_condition
                    .as_ref()
                    .map(|condition| print_type_node(&ast::TypeNode::Named(condition.clone())))
                    .unwrap_or_default();
                push_loc(out, "InlineFragment", label, node.loc);
                for directive in &node.directives {
                    push_loc(out, "Directive", directive.name.value.clone(), directive.loc);
                }
                collect_selection_set(&node.selection_set, out);
            }
        }
    }
}

/// One value literal and everything under it.
fn collect_value(value: &ast::Value, out: &mut Vec<Value>) {
    match value {
        ast::Value::Variable(node) => push_loc(out, "Variable", node.name.value.clone(), node.loc),
        ast::Value::IntValue { value, loc } => push_loc(out, "IntValue", value.clone(), *loc),
        ast::Value::FloatValue { value, loc } => push_loc(out, "FloatValue", value.clone(), *loc),
        ast::Value::StringValue { value, loc, .. } => {
            push_loc(out, "StringValue", value.clone(), *loc);
        }
        ast::Value::BooleanValue { value, loc } => {
            push_loc(out, "BooleanValue", if *value { "true" } else { "false" }.to_string(), *loc);
        }
        ast::Value::NullValue { loc } => push_loc(out, "NullValue", String::new(), *loc),
        ast::Value::EnumValue { value, loc } => push_loc(out, "EnumValue", value.clone(), *loc),
        ast::Value::ListValue { values, loc } => {
            push_loc(out, "ListValue", String::new(), *loc);
            for item in values {
                collect_value(item, out);
            }
        }
        ast::Value::ObjectValue { fields, loc } => {
            push_loc(out, "ObjectValue", String::new(), *loc);
            for field in fields {
                push_loc(out, "ObjectField", field.name.value.clone(), field.loc);
                collect_value(&field.value, out);
            }
        }
    }
}

/// Appends one `[kind, label, start, end]` entry.
fn push_loc(out: &mut Vec<Value>, kind: &str, label: String, loc: Option<ast::Loc>) {
    let loc = loc.unwrap_or_else(|| panic!("{kind} has no location"));
    out.push(json!([kind, label, loc.start, loc.end]));
}

// ---------------------------------------------------------------------------
// The split between the two grammars.
// ---------------------------------------------------------------------------

/// graphql-js 16 has a single `parse`, so the executable entry point accepts a type
/// system definition and the pipeline rejects the document at extraction with the
/// frozen compiler's `FLM1011`. `SchemaDocument` is a different type that cannot hold an
/// executable definition, so the type system entry point still rejects one with the
/// message `parseDefinition` gives an unknown keyword.
#[test]
fn the_executable_entry_point_parses_what_the_pipeline_rejects() {
    let document = parse_document("type Foo { a: Int }").expect("graphql-js parses a definition");
    assert_eq!(document.definitions.len(), 1);
    assert!(matches!(document.definitions[0], Definition::TypeSystem(_)));

    // An extension is a type system definition too, and it parses the same way.
    let document = parse_document("extend type Foo @dir").expect("graphql-js parses an extension");
    assert_eq!(document.definitions.len(), 1);
    assert!(matches!(document.definitions[0], Definition::TypeSystem(_)));

    // A malformed extension, and a malformed definition, report what graphql-js
    // reports for them.
    let error = parse_document("extend}").expect_err("malformed extension");
    assert_eq!(error.message, "Syntax Error: Unexpected \"}\".");
    assert_eq!(error.column, 7);
    let error = parse_document("type{").expect_err("malformed definition");
    assert_eq!(error.message, "Syntax Error: Expected Name, found \"{\".");

    let error =
        parse_type_system_document("query Q { a }").expect_err("type system mode rejects queries");
    assert_eq!(error.message, "Syntax Error: Unexpected Name \"query\".");

    // The shorthand form is rejected at its `{`, after the selection set parses, so a
    // malformed selection set still reports what graphql-js reports for it.
    let error =
        parse_type_system_document("{ a }").expect_err("type system mode rejects the shorthand");
    assert_eq!(error.message, "Syntax Error: Unexpected \"{\".");
    assert_eq!((error.line, error.column), (1, 1));
    let error = parse_type_system_document("{ a").expect_err("malformed shorthand");
    assert_eq!(error.message, "Syntax Error: Expected Name, found <EOF>.");

    // A description still takes the description error first, as `parseDefinition`
    // checks it before the `extend` keyword.
    let error =
        parse_document("\"d\" extend schema @dir").expect_err("descriptions on SDL are rejected");
    assert_eq!(
        error.message,
        "Syntax Error: Unexpected description, only GraphQL definitions support descriptions."
    );
}

/// The frozen AST has no `description` on an operation, fragment or variable
/// definition, but this build of graphql-js parses one and its printer emits it, so
/// a described definition is the one documented place where the two prints differ:
/// graphql-js prints `"a described query"\nquery Q {\n  a\n}` and
/// `query Q(\n$doc: String = a\n"""desc"""\n$y: Int = 1\n) {\n  a\n}` for the two
/// sources below, the port drops the description. This test pins the port's
/// behaviour so a change to the AST shows up here.
#[test]
fn descriptions_on_executable_definitions_round_trip() {
    // graphql-js 16 parses a description on an operation, a fragment and a variable
    // definition, and `print` emits it; the frozen bytes (and therefore the
    // document hash) depend on keeping it.
    // The expected strings are graphql-js 16.14.2 `print(parse(source))` output.
    let source = "\"a described query\" query Q { a }";
    let document = parse_document(source).expect("parses");
    assert_eq!(print_document(&document), "\"a described query\"\nquery Q {\n  a\n}");

    let source = "query Q($doc: String = a \"\"\"\n  desc\n\"\"\" $y: Int = 1) { a }";
    let document = parse_document(source).expect("parses");
    assert_eq!(
        print_document(&document),
        "query Q(\n$doc: String = a\n\"\"\"desc\"\"\"\n$y: Int = 1\n) {\n  a\n}"
    );

    let source = "\"about a species\" fragment F on Species { name }";
    let document = parse_document(source).expect("parses");
    assert_eq!(
        print_document(&document),
        "\"about a species\"\nfragment F on Species {\n  name\n}"
    );
}
