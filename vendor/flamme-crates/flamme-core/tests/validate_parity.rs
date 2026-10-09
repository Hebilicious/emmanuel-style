//! Validation tests for the port (`crates/flamme-core/src/validate.rs`).
//!
//! Every fixture project under `tests/fixtures/validate_*` is compiled by the Rust
//! port running exactly the stages the compiler runs before the IR:
//!
//! ```text
//! build_schema_index -> extract_project -> prepare_project -> validate_project
//! ```
//!
//! The diagnostics of the TypeScript compiler for each fixture are frozen in
//! `<fixture>/expected.json` (captured before `packages/core/src` was deleted). The
//! test compares the port's diagnostics against that snapshot **as whole
//! diagnostics, in order** - code, severity, message, file, line, column, length,
//! related locations and hint - because that order is the validation order (schema,
//! extraction, prepare, validate) and the related locations are part of the
//! contract.
//!
//! The same frozen run also supplies the *inputs* of the comparison (the resolved
//! config, the schema SDL and the discovered files), captured verbatim in
//! `<fixture>/oracle.json`; `expected.json` holds the diagnostics of that exact
//! document. There is no live oracle any more: the frozen snapshot is the contract.
//!
//! ## What this corpus proves
//!
//! * the FLM1001-FLM1016 table the validator owns, FLM1019-FLM1021, FLM1023,
//!   FLM1024, FLM1026, FLM1031, plus the extraction-side FLM1011 (a document
//!   that does not parse), FLM1015 (schema `@key`) and FLM1027 (an inline query in
//!   a component), see [`COVERED_CODES`];
//! * `FLM2002` for a schema `buildSchema` accepts and `assertValidSchema` rejects
//!   (the `validate_invalid_schema*` fixtures): one diagnostic per document, whose
//!   message is graphql-js's own, joined with `\n\n` in `validateSchema`'s order;
//! * the `graphql.validate` rules the corpus can reach, see
//!   [`COVERED_GRAPHQL_RULES`], `OverlappingFieldsCanBeMergedRule` included.
//!   `ExecutableDefinitionsRule`, `UniqueOperationNamesRule`,
//!   `UniqueFragmentNamesRule` and `LoneAnonymousOperationRule` are structurally
//!   unreachable in this pipeline (one definition per document, and the validation
//!   document holds one operation plus name-keyed fragments; FLM1003 owns the
//!   anonymous-operation case);
//! * `prepare_project`'s facts: fragment type conditions, list registrations and
//!   the spread graph (asserted directly, below).

mod support;

use flamme_core::diagnostics::Diagnostic;
use flamme_core::extract::extract_project;
use flamme_core::schema::{SchemaIndexOptions, build_schema_index};
use flamme_core::validate::{DocumentIndex, ValidateOptions, prepare_project, validate_project};
use support::fixture;

/// The FLM codes this corpus proves byte-identical.
const COVERED_CODES: &[&str] = &[
    "FLM1001", "FLM1002", "FLM1003", "FLM1004", "FLM1005", "FLM1006", "FLM1007", "FLM1008",
    "FLM1009", "FLM1010", "FLM1011", "FLM1012", "FLM1013", "FLM1014", "FLM1015", "FLM1016",
    "FLM1019", "FLM1020", "FLM1021", "FLM1023", "FLM1024", "FLM1026", "FLM1027", "FLM1031",
    "FLM2002",
];

/// The `graphql.validate` rules the port implements, in `specifiedRules` order.
/// `KnownFragmentNamesRule` and `NoUnusedFragmentsRule` are excluded by the frozen
/// compiler itself (FLM1001 and FLM1002 own those cases).
const COVERED_GRAPHQL_RULES: &[&str] = &[
    "ExecutableDefinitionsRule",
    "UniqueOperationNamesRule",
    "LoneAnonymousOperationRule",
    "SingleFieldSubscriptionsRule",
    "KnownTypeNamesRule",
    "FragmentsOnCompositeTypesRule",
    "VariablesAreInputTypesRule",
    "ScalarLeafsRule",
    "FieldsOnCorrectTypeRule",
    "UniqueFragmentNamesRule",
    "PossibleFragmentSpreadsRule",
    "NoFragmentCyclesRule",
    "UniqueVariableNamesRule",
    "NoUndefinedVariablesRule",
    "NoUnusedVariablesRule",
    "KnownDirectivesRule",
    "UniqueDirectivesPerLocationRule",
    "KnownArgumentNamesRule",
    "UniqueArgumentNamesRule",
    "ValuesOfCorrectTypeRule",
    "ProvidedRequiredArgumentsRule",
    "VariablesInAllowedPositionRule",
    "OverlappingFieldsCanBeMergedRule",
    "UniqueInputFieldNamesRule",
    "MaxIntrospectionDepthRule",
    "NoDeprecatedCustomRule",
];

/// The rules this port does **not** implement. Empty: every reachable
/// `specifiedRules` member is ported, `OverlappingFieldsCanBeMergedRule` included.
const UNPORTED_GRAPHQL_RULES: &[&str] = &[];

/// Every fixture the parity assertions cover.
const FIXTURES: &[&str] = &[
    "validate_ok",
    "validate_rules",
    "validate_overlap",
    "validate_invalid_schema",
    "validate_invalid_schema_types",
    "validate_invalid_schema_input",
    "validate_invalid_schema_root",
    "validate_invalid_schema_more",
];

/// One fixture compiled by the port's four pre-IR stages.
struct Validated {
    index: DocumentIndex,
    diagnostics: Vec<Diagnostic>,
    expected: Vec<Diagnostic>,
}

/// The frozen TypeScript diagnostics of one fixture.
fn expected_diagnostics(name: &str) -> Vec<Diagnostic> {
    let path = fixture(name).join("expected.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("{} is missing: {error}", path.display())
    });
    serde_json::from_str(&text).expect("expected.json deserializes into diagnostics")
}

/// The TypeScript run frozen next to one fixture, whose diagnostics
/// `expected.json` holds.
fn frozen_oracle_json(name: &str) -> serde_json::Value {
    let path = fixture(name).join("oracle.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("{} is missing: {error}", path.display())
    });
    let mut value: serde_json::Value =
        serde_json::from_str(&text).expect("oracle.json is valid JSON");
    // The snapshot was taken in this checkout; point it at the checkout running the
    // test so a moved repository still resolves its fixtures.
    let dir = fixture(name).to_string_lossy().replace('\\', "/");
    let marker = format!("/{name}/");
    let rewrite = |text: &str| match text.find(&marker) {
        Some(at) => format!("{dir}/{}", &text[at + marker.len()..]),
        None => text.to_string(),
    };
    let schema_file = value["schema"]["file"].as_str().map(rewrite);
    if let Some(schema_file) = schema_file {
        value["schema"]["file"] = serde_json::Value::String(schema_file);
    }
    if let Some(inputs) = value["inputs"].as_array_mut() {
        for input in inputs {
            let absolute = input["absolute"].as_str().map(rewrite);
            if let Some(absolute) = absolute {
                input["absolute"] = serde_json::Value::String(absolute);
            }
        }
    }
    value
}

/// The frozen compiler run for one fixture: its inputs and the diagnostics
/// `expected.json` holds.
fn oracle(name: &str) -> (support::Frozen, Vec<Diagnostic>) {
    let value = frozen_oracle_json(name);
    let diagnostics: Vec<Diagnostic> =
        serde_json::from_value(value["diagnostics"].clone()).expect("diagnostics deserialize");
    (support::Frozen::from_json(&fixture(name), &value), diagnostics)
}

/// Runs `build_schema_index -> extract_project -> prepare_project -> validate_project`.
fn validate(name: &str) -> Validated {
    let expected = expected_diagnostics(name);
    let (oracle, _snapshot_diagnostics) = oracle(name);
    let options = SchemaIndexOptions::from_config(&oracle.config);
    let schema = build_schema_index(&oracle.schema.sdl, &options, &oracle.schema.file)
        .unwrap_or_else(|error| panic!("{name}: the schema did not index: {}", error.message));
    let extraction = extract_project(&oracle.config, &oracle.inputs);
    let prepared = prepare_project(&oracle.config, &schema, &extraction.documents);
    let validated = validate_project(&ValidateOptions {
        config: &oracle.config,
        schema: &schema,
        documents: &extraction.documents,
        imports: &extraction.imports,
        imported_names: &extraction.imported_names,
        index: &prepared.index,
    });
    // The order `generate.ts` assembles diagnostics in: schema, extraction, prepare, validate.
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    diagnostics.extend(schema.diagnostics.iter().cloned());
    diagnostics.extend(extraction.diagnostics.iter().cloned());
    diagnostics.extend(prepared.diagnostics.iter().cloned());
    diagnostics.extend(validated);
    Validated { index: prepared.index, diagnostics, expected }
}

/// Asserts two diagnostic lists are equal, reporting the first difference instead
/// of dumping both lists.
fn assert_diagnostics(expected: &[Diagnostic], actual: &[Diagnostic], context: &str) {
    if expected == actual {
        return;
    }
    let limit = expected.len().max(actual.len());
    for index in 0..limit {
        match (expected.get(index), actual.get(index)) {
            (Some(left), Some(right)) if left == right => {}
            (left, right) => panic!(
                "{context}: first difference at diagnostic #{index}\n  frozen: {left:?}\n  rust:   {right:?}"
            ),
        }
    }
    panic!("{context}: lists differ in length");
}

/// The codes a diagnostic list reports, in order.
fn codes_of(diagnostics: &[Diagnostic]) -> Vec<&str> {
    diagnostics.iter().map(|diagnostic| diagnostic.code.as_str()).collect()
}

/// A valid multi-document project: no diagnostics, and the index facts the IR needs.
#[test]
fn validate_ok_matches_the_frozen_expectation() {
    let validated = validate("validate_ok");
    assert_diagnostics(&validated.expected, &validated.diagnostics, "validate_ok");
    assert!(
        validated.diagnostics.is_empty(),
        "validate_ok is the clean fixture, but the port reported {:?}",
        codes_of(&validated.diagnostics)
    );

    let index = &validated.index;
    assert_eq!(index.operations.len(), 3, "three operations in validate_ok");
    assert_eq!(index.fragments.len(), 2, "SpeciesCard and SpeciesHeader");
    assert_eq!(
        index.fragments["SpeciesCard"].type_condition, "Species",
        "fragment type condition"
    );
    assert_eq!(index.fragments["SpeciesHeader"].type_condition, "Species");

    // The spread graph: neither fragment spreads another.
    let mut spread_names: Vec<&str> = index.spread_graph.keys().map(String::as_str).collect();
    spread_names.sort_unstable();
    assert_eq!(spread_names, vec!["SpeciesCard", "SpeciesHeader"]);
    assert!(index.spread_graph["SpeciesCard"].is_empty());
    assert!(index.spread_graph["SpeciesHeader"].is_empty());

    // The list registry, with its element type, connection flag and spec.
    let list = index.lists.get("AllSpecies").expect("AllSpecies is registered");
    assert_eq!(list.name, "AllSpecies");
    assert_eq!(list.type_name, "Species");
    assert!(list.connection, "AllSpecies is a connection");
    assert_eq!(list.spec.name, "AllSpecies");
    assert_eq!(list.spec.type_name, "Species");
    assert!(list.spec.connection);
    assert_ne!(list.offset, 0, "the @list directive has an absolute offset");

    // No cycle in a clean project.
    assert!(flamme_core::validate::find_fragment_cycle("SpeciesCard", index).is_none());
}

/// The rule corpus: every FLM code and every `graphql.validate` message.
#[test]
fn validate_rules_matches_the_frozen_expectation() {
    let validated = validate("validate_rules");
    assert_diagnostics(&validated.expected, &validated.diagnostics, "validate_rules");

    // A cycle is a printable chain, and `findFragmentCycle` reports the frozen one.
    let cycle = flamme_core::validate::find_fragment_cycle("CycleA", &validated.index)
        .expect("CycleA takes part in a cycle");
    assert_eq!(cycle, vec!["CycleA", "CycleB", "CycleA"]);

    // The spread graph is per fragment, in source order.
    assert_eq!(validated.index.spread_graph["CycleA"], vec!["CycleB"]);
    assert_eq!(validated.index.spread_graph["CycleB"], vec!["CycleA"]);
    assert!(validated.index.spread_graph["SpeciesId"].is_empty());

    // Fragment type conditions survive the index, unknown conditions included.
    assert_eq!(validated.index.fragments["SpeciesId"].type_condition, "Species");
    assert_eq!(validated.index.fragments["PageInfoFields"].type_condition, "PageInfo");
    assert_eq!(validated.index.fragments["UnknownThing"].type_condition, "Missing");

    // `@list` registrations: the first declaration wins, and the conflict is reported.
    let bad = validated.index.lists.get("Bad").expect("Bad is registered");
    assert_eq!(bad.type_name, "Species", "the first @list(name: \"Bad\") wins");
    assert!(!bad.connection);
    let species = validated.index.lists.get("Species").expect("Species is registered");
    assert_eq!(species.type_name, "Species");
    assert!(!species.connection);

    // The conflict is reported twice: `prepareProject` registers, then
    // `validateProject` re-registers into the index it was handed, exactly like the
    // frozen compiler (which mutates the same map twice).
    let conflicts = validated
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "FLM1012")
        .count();
    assert_eq!(conflicts, 2, "FLM1012 is reported by prepare and again by validate");
}

/// `OverlappingFieldsCanBeMergedRule`: every conflict class the rule reports, with
/// the message graphql-js builds for it.
#[test]
fn validate_overlap_matches_the_frozen_expectation() {
    let validated = validate("validate_overlap");
    assert_diagnostics(&validated.expected, &validated.diagnostics, "validate_overlap");

    let codes = codes_of(&validated.diagnostics);
    assert_eq!(
        codes,
        vec!["FLM1007"; 9],
        "the overlap corpus is nine FLM1007 diagnostics and nothing else"
    );
    for diagnostic in &validated.diagnostics {
        assert_eq!(diagnostic.location.length, 1, "a conflict points at one field");
        assert_eq!(diagnostic.severity, flamme_core::diagnostics::Severity::Error);
    }

    // Every reason `reasonMessage` can build, verbatim.
    let messages: Vec<&str> =
        validated.diagnostics.iter().map(|diagnostic| diagnostic.message.as_str()).collect();
    for needle in [
        // two aliases of different fields
        "Fields \"name\" conflict because \"name\" and \"id\" are different fields.",
        // the same field name with different arguments
        "Fields \"species\" conflict because they have differing arguments.",
        // the same field name on two parent types with conflicting return types
        "Fields \"d\" conflict because they return conflicting types \"String\" and \"String!\".",
        // one level of subfields
        "Fields \"a\" conflict because subfields \"name\" conflict because \"name\" and \"id\" are different fields.",
        // two levels of subfields
        "Fields \"a\" conflict because subfields \"b\" conflict because subfields \"name\" conflict because \"name\" and \"id\" are different fields.",
        // a field def the rule cannot resolve still compares by name
        "Fields \"x\" conflict because \"name\" and \"__typename\" are different fields.",
        // a fragment spread against a sibling field, and two fragments against
        // each other: the first node may come from the fragment's own file
        "conflict because \"name\" and \"id\" are different fields.",
    ] {
        assert!(
            messages.iter().any(|message| message.contains(needle)),
            "the corpus stopped covering the conflict {needle:?}"
        );
    }

    // The two clean documents: same arguments in a different object-field order,
    // and the same response name under two mutually exclusive object types. The
    // rule is not allowed to report either.
    for file in ["SameArgs", "ExclusiveArgs"] {
        assert!(
            !messages.iter().any(|message| message.contains(file)),
            "{file}.gql must not conflict; the port reported {messages:?}"
        );
    }
}

/// `assertValidSchema`: a schema `buildSchema` accepts and the type validator
/// rejects makes `validate()` throw, which the frozen compiler reports as `FLM2002`
/// once per document with graphql-js's own message.
#[test]
fn validate_invalid_schemas_match_the_frozen_expectation() {
    for name in [
        "validate_invalid_schema",
        "validate_invalid_schema_types",
        "validate_invalid_schema_input",
        "validate_invalid_schema_root",
        "validate_invalid_schema_more",
    ] {
        let validated = validate(name);
        assert_diagnostics(&validated.expected, &validated.diagnostics, name);
        assert!(!validated.diagnostics.is_empty(), "{name} must report the invalid schema");
        assert!(
            !validated.diagnostics.iter().any(|entry| entry.code != "FLM2002"),
            "{name}: an invalid schema short-circuits every rule"
        );
        for diagnostic in &validated.diagnostics {
            assert_eq!(diagnostic.code, "FLM2002", "{name}: {diagnostic:?}");
            assert_eq!(diagnostic.severity, flamme_core::diagnostics::Severity::Error);
            assert!(diagnostic.message.starts_with("Invalid schema: "));
        }
    }

    // A root type that is not an object, then the empty shapes, in the order
    // `validateRootTypes` and `validateTypes` report them.
    let invalid = validate("validate_invalid_schema");
    assert_eq!(invalid.diagnostics.len(), 2, "one FLM2002 per document");
    assert_eq!(
        invalid.diagnostics[0].message,
        "Invalid schema: Query root type must be Object type, it cannot be NotAnObject.\n\n\
         Type Empty must define one or more fields.\n\n\
         Union type EmptyUnion must define one or more member types.\n\n\
         Enum type EmptyEnum must define one or more values.\n\n\
         Input Object type EmptyInput must define one or more fields."
    );
    assert_eq!(invalid.diagnostics[0].location.file, "src/First.gql");
    assert_eq!(invalid.diagnostics[1].location.file, "src/Second.gql");

    // Field/argument types, interface implementations and unions.
    let types = validate("validate_invalid_schema_types");
    assert_eq!(types.diagnostics.len(), 1);
    let message = types.diagnostics[0].message.as_str();
    assert_eq!(message.matches("\n\n").count(), 10, "eleven messages, joined: {message}");
    for part in [
        "The type of Query.a must be Output Type but got: Filter.",
        "The type of Query.b(x:) must be Input Type but got: Query.",
        "Interface field I1.x expected but T1 does not provide it.",
        "Interface field I2.x expects type Int but T2.x is type String.",
        "Interface field argument I3.x(y:) expected but T3.x does not provide it.",
        "Object field T4.x includes required argument y that is missing from the Interface field I4.x.",
        "Type T5 must implement I5 because it is implemented by I6.",
        "Type I7 cannot implement itself because it would create a circular reference.",
        "Type T6 can only implement I8 once.",
        "Type T7 must only implement Interface types, it cannot implement U1.",
        "Union type U2 can only include Object types, it cannot include Int.",
    ] {
        assert!(message.contains(part), "missing {part:?} in {message}");
    }

    // Directives, reserved names, input objects (circular non-null references and
    // `@oneOf`) and deprecation of a required input field.
    let input = validate("validate_invalid_schema_input");
    assert_eq!(input.diagnostics.len(), 1);
    let message = input.diagnostics[0].message.as_str();
    assert_eq!(message.matches("\n\n").count(), 7, "eight messages, joined: {message}");
    for part in [
        "The type of @bad(x:) must be Input Type but got: Query.",
        "Name \"__alsoBad\" must not begin with \"__\", which is reserved by GraphQL introspection.",
        "Cannot reference Input Object \"C1\" within itself through a series of non-null fields: \"b.a\".",
        "Required input field D1.a cannot be deprecated.",
        "OneOf input field O1.a must be nullable.",
        "OneOf input field O2.a cannot have a default value.",
        "Name \"__Foo\" must not begin with \"__\", which is reserved by GraphQL introspection.",
        "Name \"__a\" must not begin with \"__\", which is reserved by GraphQL introspection.",
    ] {
        assert!(message.contains(part), "missing {part:?} in {message}");
    }
    // The messages are in `validateDirectives`, then `validateTypes`, order.
    let positions: Vec<usize> = [
        "The type of @bad(x:)",
        "Name \"__alsoBad\"",
        "Cannot reference Input Object",
    ]
    .iter()
    .map(|part| message.find(part).expect("present"))
    .collect();
    assert!(positions[0] < positions[1] && positions[1] < positions[2], "{message}");

    // A schema with no query root at all.
    let root = validate("validate_invalid_schema_root");
    assert_eq!(root.diagnostics.len(), 1);
    assert_eq!(root.diagnostics[0].message, "Invalid schema: Query root type must be provided.");

    // The remaining branches: a non-object subscription root, a deprecated required
    // directive argument, a required field argument, reserved names on an argument,
    // an input field and an enum value, an input field that is not an input type, a
    // duplicated union member, list and non-null covariance for an interface field,
    // and an interface pair that would be circular.
    let more = validate("validate_invalid_schema_more");
    assert_eq!(more.diagnostics.len(), 1);
    let message = more.diagnostics[0].message.as_str();
    assert_eq!(message.matches("\n\n").count(), 11, "twelve messages, joined: {message}");
    for part in [
        "Subscription root type must be Object type if provided, it cannot be NotAnObject.",
        "Required argument @badArg(x:) cannot be deprecated.",
        "Required argument Query.a(x:) cannot be deprecated.",
        "Name \"__a\" must not begin with \"__\", which is reserved by GraphQL introspection.",
        "The type of BadInput.f must be Input Type but got: Query.",
        "Name \"__b\" must not begin with \"__\", which is reserved by GraphQL introspection.",
        "Union type Dup can only include type Query once.",
        "Interface field L.xs expects type [Int] but LT.xs is type [String].",
        "Interface field L.x expects type Int! but LT.x is type Int.",
        "Type A1 cannot implement A2 because it would create a circular reference.",
        "Type A2 cannot implement A1 because it would create a circular reference.",
    ] {
        assert!(message.contains(part), "missing {part:?} in {message}");
    }
}

/// Coverage guard: every code the corpus claims has to keep appearing somewhere in
/// it, or the parity assertions above would pass while proving nothing.
#[test]
fn corpus_covers_every_declared_code() {
    let mut produced: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in FIXTURES {
        produced.extend(validate(name).diagnostics.into_iter().map(|entry| entry.code));
    }
    for code in COVERED_CODES {
        assert!(
            produced.contains(*code),
            "the corpus stopped covering {code}; the parity assertions no longer prove it"
        );
    }
}

/// The rules this port does not implement, asserted as a list so a future port has
/// to update this test rather than leave the gap unmentioned.
#[test]
fn unported_rules_are_named() {
    assert!(UNPORTED_GRAPHQL_RULES.is_empty(), "every reachable rule is ported");
    assert!(COVERED_GRAPHQL_RULES.contains(&"OverlappingFieldsCanBeMergedRule"));
    assert!(COVERED_GRAPHQL_RULES.contains(&"MaxIntrospectionDepthRule"));
    // `specifiedRules` order, minus the two the frozen compiler drops.
    let overlap = COVERED_GRAPHQL_RULES
        .iter()
        .position(|rule| *rule == "OverlappingFieldsCanBeMergedRule")
        .expect("ported");
    assert_eq!(COVERED_GRAPHQL_RULES[overlap - 1], "VariablesInAllowedPositionRule");
    assert_eq!(COVERED_GRAPHQL_RULES[overlap + 1], "UniqueInputFieldNamesRule");
}
