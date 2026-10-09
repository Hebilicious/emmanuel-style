//! Cursor pagination planning (`spec/spec.md` §6.8, §7.3).
//! Port of `packages/core/src/paginate.ts`.
//!
//! A paginated connection cannot be paged from a compiled document whose cursor
//! arguments are literals: the compiled `raw` is sent again for every page, so the
//! endpoint sees the same `after: null` on every request. The runtime already sends
//! the page values as **variables** (`cursorHandlers` → `pageRequestVariables`:
//! `{ first, after, last, before }`), so the compiler binds each cursor argument to
//! the variable of the same name. A user-written literal survives as that variable's
//! default, which keeps the first page's request and its evaluated cache key exactly
//! as they were.
//!
//! OWNER: the validation port (used by both validation and the IR).

use std::collections::HashMap;

use crate::graphql::ast::{Argument, Field, Value};
use crate::graphql::print_value;
use crate::validate::value_node_to_graphql_value;

/// The cursor arguments a connection field accepts, in check order.
pub const CURSOR_ARGUMENTS: &[&str] = &["first", "after", "last", "before"];

/// The GraphQL type each cursor argument takes.
pub const CURSOR_TYPES: &[(&str, &str)] = &[
    ("first", "Int"),
    ("after", "String"),
    ("last", "Int"),
    ("before", "String"),
];

/// The offset arguments a list field accepts, in the runtime's canonical order
/// (Houdini's `determinePaginationArguments` injects `limit` then `offset`).
pub const OFFSET_ARGUMENTS: &[&str] = &["limit", "offset"];

/// The GraphQL type each offset argument takes.
pub const OFFSET_TYPES: &[(&str, &str)] = &[("limit", "Int"), ("offset", "Int")];

/// One cursor variable binding.
#[derive(Clone, Debug)]
pub struct CursorVariableBinding {
    /// The variable name. It is always one of [`CURSOR_ARGUMENTS`], because the
    /// runtime's `pageRequestVariables` sends exactly those names.
    pub name: String,
    /// The argument it binds to, the same name.
    pub argument: String,
    /// The declared type (`Int` or `String`).
    pub type_name: String,
}

/// What a paginated field's arguments resolved to.
///
/// The same shape carries both strategies: a cursor connection's four cursor
/// arguments, or an offset list's `limit`/`offset` pair.
#[derive(Clone, Debug, Default)]
pub struct CursorArgumentPlan {
    /// The field's arguments as graphql-js prints them in `raw`, in the oracle's
    /// order: the user's other arguments first (source order), then the page
    /// arguments in canonical order.
    pub arguments: Vec<String>,
    /// The variables the operation must declare, in the order the oracle pushes
    /// them: the page arguments the user wrote as literals first (source order),
    /// then the absent ones in canonical order. An argument the user already wrote
    /// as a variable is their own binding and has no entry here.
    pub bindings: Vec<CursorVariableBinding>,
    /// The literal each binding defaults to, keyed by argument name, in binding
    /// order. A binding with no entry here has no default.
    pub literals: Vec<(String, crate::contract::GraphQLValue)>,
}

/// True when `name` is a cursor argument.
pub fn is_cursor_argument(name: &str) -> bool {
    CURSOR_ARGUMENTS.contains(&name)
}

/// True when `name` is an argument of the pagination strategy `method`.
pub fn is_page_argument(name: &str, method: &str) -> bool {
    if method == "offset" {
        OFFSET_ARGUMENTS.contains(&name)
    } else {
        CURSOR_ARGUMENTS.contains(&name)
    }
}

/// The GraphQL type a page argument takes.
pub fn page_argument_type(name: &str) -> &'static str {
    CURSOR_TYPES
        .iter()
        .chain(OFFSET_TYPES.iter())
        .find(|(argument, _)| *argument == name)
        .map(|(_, type_name)| *type_name)
        .expect("a page argument has a declared type")
}

/// One argument as graphql-js's `print` renders it: `name: value`.
fn print_argument(argument: &Argument) -> String {
    format!("{}: {}", argument.name.value, print_value(&argument.value))
}

/// The stage-argument plan of one field.
///
/// - an argument the user already wrote as a variable (`first: $limit`) is their own
///   binding and is left untouched;
/// - a literal (`first: 1`, `after: "c"`) is bound to the canonical variable and kept
///   as that variable's default, so the first page sends the same value;
/// - an absent argument is bound to the canonical variable with no default, so the
///   runtime's per-page value is the only value it can have.
pub fn cursor_argument_plan(field: &Field) -> CursorArgumentPlan {
    stage_argument_plan(field, CURSOR_ARGUMENTS)
}

/// The offset plan of one field: `limit` and `offset` bound the same way, so the
/// runtime's `offsetHandlers` can advance the window with `limit: <pageSize>,
/// offset: <loaded so far>`.
pub fn offset_argument_plan(field: &Field) -> CursorArgumentPlan {
    stage_argument_plan(field, OFFSET_ARGUMENTS)
}

/// The plan of the strategy the field's value type selects (`cursor` or `offset`).
pub fn page_argument_plan(field: &Field, method: &str) -> CursorArgumentPlan {
    if method == "offset" {
        offset_argument_plan(field)
    } else {
        cursor_argument_plan(field)
    }
}

/// One strategy's argument plan.
fn stage_argument_plan(field: &Field, accepted: &[&str]) -> CursorArgumentPlan {
    let mut bound: HashMap<&str, String> = HashMap::new();
    let mut plan = CursorArgumentPlan::default();
    for argument in &field.arguments {
        let name = argument.name.value.as_str();
        if !accepted.contains(&name) {
            plan.arguments.push(print_argument(argument));
            continue;
        }
        if matches!(argument.value, Value::Variable(_)) {
            // the user's own binding wins: `first: $limit` stays `first: $limit`
            bound.insert(name, print_argument(argument));
            continue;
        }
        bound.insert(name, format!("{name}: ${name}"));
        plan.bindings.push(CursorVariableBinding {
            name: name.to_string(),
            argument: name.to_string(),
            type_name: page_argument_type(name).to_string(),
        });
        plan.literals.push((name.to_string(), value_node_to_graphql_value(&argument.value)));
    }
    // the strategy's arguments, in the runtime's canonical order, after the user's other args
    for name in accepted {
        match bound.get(name) {
            Some(existing) => plan.arguments.push(existing.clone()),
            None => {
                plan.arguments.push(format!("{name}: ${name}"));
                plan.bindings.push(CursorVariableBinding {
                    name: (*name).to_string(),
                    argument: (*name).to_string(),
                    type_name: page_argument_type(name).to_string(),
                });
            }
        }
    }
    plan
}

/// True when a declared cursor type is compatible with the expected one.
pub fn cursor_type_compatible(declared: &str, expected: &str) -> bool {
    declared == expected || declared == format!("{expected}!")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graphql::ast::{Name, Value};

    fn name(value: &str) -> Name {
        Name::synthetic(value)
    }

    fn variable(value: &str) -> Value {
        Value::Variable(crate::graphql::ast::Variable { name: name(value), loc: None })
    }

    fn int(value: &str) -> Value {
        Value::IntValue { value: value.to_string(), loc: None }
    }

    fn field(arguments: Vec<Argument>) -> Field {
        Field {
            alias: None,
            name: name("moves"),
            arguments,
            directives: Vec::new(),
            selection_set: None,
            loc: None,
        }
    }

    fn argument(name_value: &str, value: Value) -> Argument {
        Argument { name: name(name_value), value, loc: None }
    }

    fn binding_names(plan: &CursorArgumentPlan) -> Vec<&str> {
        plan.bindings.iter().map(|binding| binding.name.as_str()).collect()
    }

    #[test]
    fn a_bare_field_binds_every_cursor_argument() {
        let plan = cursor_argument_plan(&field(Vec::new()));
        assert_eq!(
            plan.arguments,
            ["first: $first", "after: $after", "last: $last", "before: $before"]
        );
        assert_eq!(binding_names(&plan), ["first", "after", "last", "before"]);
        assert_eq!(
            plan.bindings.iter().map(|binding| binding.type_name.as_str()).collect::<Vec<_>>(),
            ["Int", "String", "Int", "String"]
        );
        assert!(plan.literals.is_empty());
    }

    #[test]
    fn a_literal_becomes_a_variable_with_a_default() {
        let plan = cursor_argument_plan(&field(vec![
            argument("delay", int("500")),
            argument("first", int("1")),
        ]));
        assert_eq!(plan.arguments.len(), 5);
        assert_eq!(plan.arguments[4], "before: $before");
        assert_eq!(binding_names(&plan), ["first", "after", "last", "before"]);
        assert_eq!(plan.literals.len(), 1);
        assert_eq!(plan.literals[0].0, "first");
        assert_eq!(
            plan.literals[0].1,
            crate::contract::GraphQLValue::IntValue { value: "1".into() }
        );
    }

    #[test]
    fn the_users_own_variable_binding_is_kept() {
        let plan = cursor_argument_plan(&field(vec![argument("first", variable("limit"))]));
        assert_eq!(binding_names(&plan), ["after", "last", "before"]);
        assert!(plan.literals.is_empty());
        assert_eq!(plan.arguments.len(), 4);
    }

    #[test]
    fn cursor_arguments_are_recognised() {
        assert!(is_cursor_argument("first"));
        assert!(is_cursor_argument("before"));
        assert!(!is_cursor_argument("limit"));
        assert!(!is_cursor_argument(""));
    }

    #[test]
    fn a_declared_type_is_compatible_with_itself_and_its_non_null_form() {
        assert!(cursor_type_compatible("String", "String"));
        assert!(cursor_type_compatible("String!", "String"));
        assert!(!cursor_type_compatible("Int", "String"));
        assert!(!cursor_type_compatible("String", "String!"));
        assert!(!cursor_type_compatible("[String]", "String"));
    }
}
