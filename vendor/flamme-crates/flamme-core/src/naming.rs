//! Naming rules for generated files. Port of `packages/core/src/naming.ts`.

use crate::contract::GraphQLValue;

const FNV_OFFSET_BASIS: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;

/// FNV-1a 32-bit hash of a string, as an unsigned integer.
///
/// The TypeScript version multiplies in doubles and takes the low 32 bits; wrapping
/// multiplication is the same value modulo 2^32, and the input is hashed by UTF-16
/// code unit, which is what `charCodeAt` reads.
pub fn fnv1a32(input: &str) -> u32 {
    let mut hash = FNV_OFFSET_BASIS;
    for unit in input.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Base-36 rendering of a 32-bit hash, left-padded to `length` characters.
pub fn base36(value: u32, length: usize) -> String {
    let text = to_base36(value);
    if text.len() >= length {
        return text[text.len() - length..].to_string();
    }
    format!("{}{}", "0".repeat(length - text.len()), text)
}

/// Lowercase base-36, the JavaScript `Number.prototype.toString(36)` output.
fn to_base36(mut value: u32) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}

/// Canonical JSON for a resolved fragment-argument map: keys sorted, no whitespace.
pub fn canonical_json(value: &CanonicalInput) -> String {
    match value {
        CanonicalInput::Value(value) => canonical_value(value),
        CanonicalInput::Fields(fields) => canonical_fields(fields),
    }
}

/// The two shapes `canonicalJson` accepts.
pub enum CanonicalInput<'a> {
    /// One GraphQL value.
    Value(&'a GraphQLValue),
    /// A fragment-argument record.
    Fields(&'a crate::js::JsObject<GraphQLValue>),
}

/// Canonical JSON of a value record, keys sorted by code-unit order.
fn canonical_fields(fields: &crate::js::JsObject<GraphQLValue>) -> String {
    let mut keys: Vec<&str> = fields.keys();
    keys.sort_unstable();
    let parts: Vec<String> = keys
        .into_iter()
        .map(|key| {
            let value = fields.get(key).cloned().unwrap_or(GraphQLValue::NullValue);
            format!("{}:{}", json_string(key), canonical_value(&value))
        })
        .collect();
    format!("{{{}}}", parts.join(","))
}

/// Canonical JSON of one value.
pub fn canonical_value(value: &GraphQLValue) -> String {
    match value {
        GraphQLValue::Variable { name } => {
            format!("{{\"kind\":\"Variable\",\"name\":{}}}", json_string(name))
        }
        GraphQLValue::IntValue { value } => scalar("IntValue", value),
        GraphQLValue::FloatValue { value } => scalar("FloatValue", value),
        GraphQLValue::StringValue { value } => scalar("StringValue", value),
        GraphQLValue::EnumValue { value } => scalar("EnumValue", value),
        GraphQLValue::BooleanValue { value } => {
            format!("{{\"kind\":\"BooleanValue\",\"value\":{value}}}")
        }
        GraphQLValue::NullValue => "{\"kind\":\"NullValue\"}".into(),
        GraphQLValue::ListValue { values } => format!(
            "{{\"kind\":\"ListValue\",\"values\":[{}]}}",
            values.iter().map(canonical_value).collect::<Vec<_>>().join(",")
        ),
        GraphQLValue::ObjectValue { fields } => canonical_fields(fields),
    }
}

/// One scalar value in canonical form.
fn scalar(kind: &str, value: &str) -> String {
    format!("{{\"kind\":{},\"value\":{}}}", json_string(kind), json_string(value))
}

/// JSON string escaping identical to `JSON.stringify` for the characters that can
/// appear in a GraphQL name or value.
pub fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for char in text.chars() {
        match char {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            char if (char as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", char as u32)),
            char => out.push(char),
        }
    }
    out.push('"');
    out
}

/// The artifact name of a fragment-argument clone (`<Name>_<6 base36 chars>`).
pub fn clone_fragment_name(name: &str, args: &crate::js::JsObject<GraphQLValue>) -> String {
    format!("{name}_{}", base36(fnv1a32(&canonical_json(&CanonicalInput::Fields(args))), 6))
}

/// The artifact module path relative to the generated directory (`artifacts/<Name>.ts`).
pub fn artifact_module_path(name: &str) -> String {
    format!("artifacts/{name}.ts")
}

/// True when `name` is a legal TypeScript identifier and can be emitted unquoted.
pub fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' || first == '$' => {}
        _ => return false,
    }
    chars.all(|char| char.is_ascii_alphanumeric() || char == '_' || char == '$')
}

/// A locale-independent string comparison (code-unit order).
pub fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    a.cmp(b)
}

/// Reserved words and contextual names `export type X` / `export { default as X }` reject.
const RESERVED_TYPE_NAMES: &[&str] = &[
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
    "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
    "typeof", "var", "void", "while", "with", "let", "static", "yield", "await", "implements",
    "interface", "package", "private", "protected", "public", "arguments", "eval",
];

/// True when `name` is safe to emit verbatim as an exported type alias and binding.
pub fn is_usable_document_name(name: &str) -> bool {
    is_identifier(name) && !RESERVED_TYPE_NAMES.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_matches_javascript() {
        // Computed by the TypeScript compiler's `fnv1a32` for the same input.
        assert_eq!(fnv1a32(""), 0x811c_9dc5);
        assert_eq!(fnv1a32("a"), 0xe40c_292c);
        assert_eq!(fnv1a32("Info"), 0x8fe1_e625);
    }

    #[test]
    fn base36_pads_and_truncates() {
        assert_eq!(base36(0, 6), "000000");
        assert_eq!(base36(35, 2), "0z");
    }

    #[test]
    fn identifiers_and_reserved_words() {
        assert!(is_identifier("Info"));
        assert!(!is_identifier("1Info"));
        assert!(is_usable_document_name("Info"));
        assert!(!is_usable_document_name("default"));
    }
}
