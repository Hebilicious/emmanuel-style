//! GraphQL printer, a port of `graphql/language/printer.js` (graphql 16.14.2).
//!
//! `print` in graphql-js is `visit(ast, printDocASTReducer)`, a reducer that walks
//! the tree bottom-up and replaces every node with its printed string. This port
//! recurses the same way, with the same `join`/`wrap`/`block`/`indent` helpers, so
//! the output is byte-identical: two-space indentation, `(a: 1, b: 2)` argument
//! joins, the anonymous-operation shorthand, and the 80-column argument line break.

use super::ast::{
    Definition, Document, OperationDefinition, Selection, SelectionSet, TypeNode, Value,
};

/// Prints a document, `print(document)`.
pub fn print_document(document: &Document) -> String {
    let definitions: Vec<String> =
        document.definitions.iter().map(print_definition).collect();
    join(&definitions, "\n\n")
}

/// Prints one value, `print(value)`.
pub fn print_value(value: &Value) -> String {
    match value {
        Value::Variable(node) => format!("${}", node.name.value),
        Value::IntValue { value, .. } | Value::FloatValue { value, .. } => value.clone(),
        Value::StringValue { value, block, .. } => {
            if *block { print_block_string(value) } else { print_string(value) }
        }
        Value::BooleanValue { value, .. } => if *value { "true" } else { "false" }.to_string(),
        Value::NullValue { .. } => "null".to_string(),
        Value::EnumValue { value, .. } => value.clone(),
        Value::ListValue { values, .. } => {
            let values: Vec<String> = values.iter().map(print_value).collect();
            format!("[{}]", join(&values, ", "))
        }
        Value::ObjectValue { fields, .. } => {
            let fields: Vec<String> = fields
                .iter()
                .map(|field| format!("{}: {}", field.name.value, print_value(&field.value)))
                .collect();
            format!("{{{}}}", join(&fields, ", "))
        }
    }
}

/// Prints one type reference, `print(typeNode)`.
pub fn print_type_node(node: &TypeNode) -> String {
    node.to_type_string()
}

/// Prints one definition.
///
/// A type system definition prints as the empty string: `parse` accepts one because
/// graphql-js's `parse` does, but the compiler rejects such a document at extraction
/// (`FLM1011`) and this build has no SDL printer, so no caller ever prints one. The
/// arm exists so the AST can hold what `parse` accepts.
fn print_definition(definition: &Definition) -> String {
    match definition {
        Definition::Operation(node) => print_operation_definition(node),
        Definition::TypeSystem(_) => String::new(),
        Definition::Fragment(node) => {
            let name = &node.name.value;
            let type_condition = print_type_node(&TypeNode::Named(node.type_condition.clone()));
            let variable_definitions: Vec<String> =
                node.variable_definitions.iter().map(print_variable_definition).collect();
            let directives: Vec<String> = node.directives.iter().map(print_directive).collect();
            let selection_set = print_selection_set(&node.selection_set);
            // Note: fragment variable definitions are experimental, and this build
            // prints them on one line even when one of them is multiline.
            let mut out = String::new();
            out.push_str(&wrap("", node.description.as_deref().unwrap_or_default(), "\n"));
            out.push_str(&format!(
                "fragment {name}{}",
                wrap("(", &join(&variable_definitions, ", "), ")")
            ));
            out.push(' ');
            out.push_str(&format!(
                "on {type_condition} {}",
                wrap("", &join(&directives, " "), " ")
            ));
            out.push_str(&selection_set);
            out
        }
    }
}

/// `OperationDefinition` in the reducer, description prefix included.
fn print_operation_definition(node: &OperationDefinition) -> String {
    let variable_definitions: Vec<String> =
        node.variable_definitions.iter().map(print_variable_definition).collect();
    let var_defs = if has_multiline_items(&variable_definitions) {
        wrap("(\n", &join(&variable_definitions, "\n"), "\n)")
    } else {
        wrap("(", &join(&variable_definitions, ", "), ")")
    };
    let directives: Vec<String> = node.directives.iter().map(print_directive).collect();
    let prefix = join(
        &[
            node.operation.as_str().to_string(),
            join(
                &[node.name.as_ref().map(|name| name.value.clone()).unwrap_or_default(), var_defs],
                "",
            ),
            join(&directives, " "),
        ],
        " ",
    );
    let selection_set = print_selection_set(&node.selection_set);
    let description = wrap("", node.description.as_deref().unwrap_or_default(), "\n");
    // Anonymous queries with no directives or variable definitions can use the
    // query short form.
    let mut out = String::new();
    out.push_str(&description);
    if prefix != "query" {
        out.push_str(&prefix);
        out.push(' ');
    }
    out.push_str(&selection_set);
    out
}

/// `VariableDefinition` in the reducer, description prefix included.
fn print_variable_definition(node: &super::ast::VariableDefinition) -> String {
    let variable = format!("${}", node.variable.name.value);
    let type_node = print_type_node(&node.type_node);
    let default_value = node.default_value.as_ref().map(print_value).unwrap_or_default();
    let directives: Vec<String> = node.directives.iter().map(print_directive).collect();
    format!(
        "{}{variable}: {type_node}{}{}",
        wrap("", node.description.as_deref().unwrap_or_default(), "\n"),
        wrap(" = ", &default_value, ""),
        wrap(" ", &join(&directives, " "), "")
    )
}

/// `SelectionSet` in the reducer.
fn print_selection_set(node: &SelectionSet) -> String {
    let selections: Vec<String> = node.selections.iter().map(print_selection).collect();
    block(&selections)
}

/// `Field`, `FragmentSpread` and `InlineFragment` in the reducer.
fn print_selection(selection: &Selection) -> String {
    match selection {
        Selection::Field(node) => {
            let prefix = wrap(
                "",
                &node.alias.as_ref().map(|alias| alias.value.clone()).unwrap_or_default(),
                ": ",
            ) + &node.name.value;
            let arguments: Vec<String> = node.arguments.iter().map(print_argument).collect();
            let mut args_line = prefix.clone() + &wrap("(", &join(&arguments, ", "), ")");
            if js_len(&args_line) > MAX_LINE_LENGTH {
                args_line = prefix + &wrap("(\n", &indent(&join(&arguments, "\n")), "\n)");
            }
            let directives: Vec<String> = node.directives.iter().map(print_directive).collect();
            let selection_set =
                node.selection_set.as_ref().map(print_selection_set).unwrap_or_default();
            join(&[args_line, join(&directives, " "), selection_set], " ")
        }
        Selection::FragmentSpread(node) => {
            let directives: Vec<String> = node.directives.iter().map(print_directive).collect();
            format!("...{}{}", node.name.value, wrap(" ", &join(&directives, " "), ""))
        }
        Selection::InlineFragment(node) => {
            let type_condition = node
                .type_condition
                .as_ref()
                .map(|condition| print_type_node(&TypeNode::Named(condition.clone())))
                .unwrap_or_default();
            let directives: Vec<String> = node.directives.iter().map(print_directive).collect();
            join(
                &[
                    "...".to_string(),
                    wrap("on ", &type_condition, ""),
                    join(&directives, " "),
                    print_selection_set(&node.selection_set),
                ],
                " ",
            )
        }
    }
}

/// `Argument` in the reducer.
fn print_argument(node: &super::ast::Argument) -> String {
    format!("{}: {}", node.name.value, print_value(&node.value))
}

/// `Directive` in the reducer.
fn print_directive(node: &super::ast::Directive) -> String {
    let arguments: Vec<String> = node.arguments.iter().map(print_argument).collect();
    format!("@{}{}", node.name.value, wrap("(", &join(&arguments, ", "), ")"))
}

/// `join(maybeArray, separator)`: falsy items are dropped.
fn join(items: &[String], separator: &str) -> String {
    let present: Vec<&str> =
        items.iter().filter(|item| !item.is_empty()).map(String::as_str).collect();
    present.join(separator)
}

/// `block(array)`: each item on its own line, inside an indented `{ }`.
fn block(items: &[String]) -> String {
    wrap("{\n", &indent(&join(items, "\n")), "\n}")
}

/// `wrap(start, maybeString, end)`: empty strings stay empty.
fn wrap(start: &str, maybe_string: &str, end: &str) -> String {
    if maybe_string.is_empty() {
        String::new()
    } else {
        format!("{start}{maybe_string}{end}")
    }
}

/// `indent(str)`: two spaces in front of every line.
fn indent(text: &str) -> String {
    wrap("  ", &text.replace('\n', "\n  "), "")
}

/// `hasMultilineItems(maybeArray)`.
fn has_multiline_items(items: &[String]) -> bool {
    items.iter().any(|item| item.contains('\n'))
}

/// `MAX_LINE_LENGTH` in printer.js.
const MAX_LINE_LENGTH: usize = 80;

/// `string.length` in JavaScript: the number of UTF-16 code units.
fn js_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `printString(str)` from `language/printString.js`: control characters, `"` and
/// `\` become escape sequences, everything else is copied through.
fn print_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        let code = character as u32;
        match code {
            0x0008 => out.push_str("\\b"),
            0x0009 => out.push_str("\\t"),
            0x000a => out.push_str("\\n"),
            0x000c => out.push_str("\\f"),
            0x000d => out.push_str("\\r"),
            0x0022 => out.push_str("\\\""),
            0x005c => out.push_str("\\\\"),
            0x0000..=0x001f | 0x007f..=0x009f => out.push_str(&format!("\\u{code:04X}")),
            _ => out.push(character),
        }
    }
    out.push('"');
    out
}

/// `printBlockString(value)` from `language/blockString.js`, with no options: the
/// minimize option is never set by `print`.
fn print_block_string(value: &str) -> String {
    let escaped_value = value.replace("\"\"\"", "\\\"\"\"");
    let lines = split_lines(&escaped_value);
    let is_single_line = lines.len() == 1;
    let force_leading_new_line = lines.len() > 1
        && lines[1..].iter().all(|line| line.is_empty() || is_white_space(first_code_unit(line)));
    let has_trailing_triple_quotes = escaped_value.ends_with("\\\"\"\"");
    let has_trailing_quote = value.ends_with('"') && !has_trailing_triple_quotes;
    let has_trailing_slash = value.ends_with('\\');
    let force_trailing_newline = has_trailing_quote || has_trailing_slash;
    let print_as_multiple_lines = !is_single_line
        || js_len(value) > 70
        || force_trailing_newline
        || force_leading_new_line
        || has_trailing_triple_quotes;
    let mut result = String::new();
    let skip_leading_new_line = is_single_line && is_white_space(first_code_unit(value));
    if (print_as_multiple_lines && !skip_leading_new_line) || force_leading_new_line {
        result.push('\n');
    }
    result.push_str(&escaped_value);
    if print_as_multiple_lines || force_trailing_newline {
        result.push('\n');
    }
    format!("\"\"\"{result}\"\"\"")
}

/// `escapedValue.split(/\r\n|[\n\r]/g)`.
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    let bytes = text.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                lines.push(&text[start..index]);
                index += if index + 1 < bytes.len() && bytes[index + 1] == b'\n' { 2 } else { 1 };
                start = index;
            }
            b'\n' => {
                lines.push(&text[start..index]);
                index += 1;
                start = index;
            }
            _ => index += 1,
        }
    }
    lines.push(&text[start..]);
    lines
}

/// `string.charCodeAt(0)`, with `u32::MAX` standing in for the `NaN` an empty string
/// reads. No whitespace character equals it, which is what `NaN` does there too.
fn first_code_unit(text: &str) -> u32 {
    text.chars().next().map_or(u32::MAX, |character| character as u32)
}

/// `isWhiteSpace(code)`: tab or space.
fn is_white_space(code: u32) -> bool {
    code == 0x0009 || code == 0x0020
}
