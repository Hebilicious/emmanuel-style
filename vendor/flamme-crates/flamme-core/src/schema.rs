//! Schema parsing and indexing (`spec/spec.md` §9.1, §4.5.1).
//! Port of `packages/core/src/schema.ts`.
//!
//! The oracle builds a graphql-js `GraphQLSchema` with `buildSchema(indexSdl)` and
//! reads the type map back out. This port reproduces the content of that type map
//! (never the schema object itself: no resolvers, directives or introspection types
//! are needed) from the parsed SDL: the type definitions in document order with the
//! `extend` forms merged the way graphql-js's `extendSchema` merges them, plus the
//! built-in scalars. It also reproduces the SDL rules `buildSchema` runs through
//! `assertValidSDL` closely enough that a schema graphql-js rejects is rejected here
//! with the same `Invalid schema: …` message.

use std::collections::{HashMap, HashSet};

use crate::config::{RustConfig, ScalarConfig, TypeConfig};
use crate::diagnostics::{Diagnostic, DiagnosticInput, SchemaError, SourceLocation};
use crate::graphql::ast::{
    Directive, FieldDefinition, InputValueDefinition, Loc, NamedType, SchemaDocument,
    TypeDefinition, TypeNode, TypeSystemDefinition, Value,
};
use crate::hash::hash_document;
use crate::js::JsObject;
use crate::offsets::{Offset, SourceText, location_at};

/// The directive and enum definitions the compiler adds to the user's schema (§7).
pub const SCHEMA_DIRECTIVE_DEFINITIONS: &[&str] = &[
    "directive @loading(count: Int, cascade: Boolean) on QUERY | MUTATION | SUBSCRIPTION | FIELD | FRAGMENT_DEFINITION | FRAGMENT_SPREAD",
    "directive @paginate(mode: PaginateMode, name: String) on FIELD",
    "directive @list(name: String!, connection: Boolean) on FIELD",
    "directive @key(fields: [String!]!) on OBJECT | INTERFACE",
    "directive @mask_enable on FRAGMENT_SPREAD",
    "directive @mask_disable on FRAGMENT_SPREAD",
    "directive @cache(policy: CachePolicy, partial: Boolean) on QUERY | MUTATION | SUBSCRIPTION",
    "directive @dedupe(cancelFirst: Boolean, match: DedupeMatchMode) on QUERY | MUTATION",
    "directive @prepend on FRAGMENT_SPREAD",
    "directive @append on FRAGMENT_SPREAD",
    "directive @listTarget(name: String!) on FRAGMENT_SPREAD",
    "directive @optimisticKey on FIELD",
    "directive @required on FIELD | FRAGMENT_SPREAD",
    "directive @when on FRAGMENT_SPREAD",
    "directive @when_not on FRAGMENT_SPREAD",
    "directive @allLists on FRAGMENT_SPREAD",
    "directive @listID(value: ID!) on FRAGMENT_SPREAD",
    "directive @includeListID on FIELD",
    "directive @defer(if: Boolean = true, label: String) on FRAGMENT_SPREAD | INLINE_FRAGMENT",
    "directive @stream(if: Boolean = true, label: String, initialCount: Int = 0) on FIELD",
    "enum PaginateMode { SinglePage Infinite }",
    "enum CachePolicy { CacheOrNetwork NetworkOnly CacheAndNetwork CacheOnly }",
    "enum DedupeMatchMode { variables all }",
];

/// The `@key` declaration used while indexing (repeatable, so FLM1015 can be reported).
pub const INDEX_KEY_DIRECTIVE: &str =
    "directive @key(fields: [String!]!) repeatable on OBJECT | INTERFACE";

/// The `@key` declaration the compiler appends, which [`index_sdl_for`] replaces.
const PLAIN_KEY_DIRECTIVE: &str = "directive @key(fields: [String!]!) on OBJECT | INTERFACE";

/// The kind of a schema type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaTypeKind {
    /// `scalar`
    Scalar,
    /// `type`
    Object,
    /// `interface`
    Interface,
    /// `union`
    Union,
    /// `enum`
    Enum,
    /// `input`
    InputObject,
}

/// One field of an object or interface type.
#[derive(Clone, Debug)]
pub struct SchemaField {
    /// The field name.
    pub name: String,
    /// The declared type.
    pub type_node: TypeNode,
    /// The field's arguments.
    pub arguments: Vec<SchemaInputValue>,
    /// Directives.
    pub directives: Vec<Directive>,
}

/// One argument of a field or directive, or one field of an input object.
#[derive(Clone, Debug)]
pub struct SchemaInputValue {
    /// The name.
    pub name: String,
    /// The declared type.
    pub type_node: TypeNode,
    /// The default value.
    pub default_value: Option<crate::graphql::ast::Value>,
    /// Directives.
    pub directives: Vec<Directive>,
}

/// One type in the schema index.
#[derive(Clone, Debug)]
pub struct SchemaType {
    /// The type name.
    pub name: String,
    /// The kind.
    pub kind: SchemaTypeKind,
    /// Fields in definition order: object/interface fields, and an input object's
    /// fields (which have no arguments). Note that `field_type` only answers for an
    /// object or interface, exactly like the oracle's `fieldType`.
    pub fields: Vec<SchemaField>,
    /// Enum values.
    pub enum_values: Vec<String>,
    /// Implemented interfaces, for an object or interface.
    pub interfaces: Vec<String>,
    /// Union members, for a union.
    pub union_types: Vec<String>,
    /// Directives written on the definition, with the directives of every `extend`
    /// form appended. Key resolution does not read this field: the oracle reads
    /// `type.astNode.directives`, which holds the *base* definition's directives only.
    pub directives: Vec<Directive>,
    /// Location in the indexed SDL, of the base definition.
    pub loc: Option<crate::graphql::Loc>,
}

/// The compiler's read-only view of the schema (§9.1).
#[derive(Clone, Debug)]
pub struct SchemaIndex {
    /// Every type the index knows, in definition order, without `__` introspection types.
    pub types: Vec<SchemaType>,
    /// Type name to its position in [`SchemaIndex::types`].
    pub type_positions: HashMap<String, usize>,
    /// `possibleTypes` per composite type.
    pub possible_types: JsObject<Vec<String>>,
    /// Key fields per composite type, merged from schema `@key` and `config.types`.
    pub key_fields: JsObject<Vec<String>>,
    /// Key fields that came from the schema's `@key` directive.
    pub schema_key_fields: JsObject<Vec<String>>,
    /// Enum name to its values.
    pub enums: JsObject<Vec<String>>,
    /// Input object name to field name to type string.
    pub input_types: JsObject<JsObject<String>>,
    /// `sha256` of `mergeDirectiveDefinitions(sdl)`.
    pub hash: String,
    /// The user's SDL, verbatim.
    pub sdl: String,
    /// The SDL the index was built from (user SDL plus merged directives).
    pub index_sdl: String,
    /// The SDL file the index was built from, for diagnostics.
    pub file: String,
    /// `true` when the user's schema already defines `@key`.
    pub has_key_directive: bool,
    /// The parsed index SDL.
    pub document: SchemaDocument,
    /// Schema-level diagnostics (`FLM1015`, and `FLM2002` reported as an error).
    pub diagnostics: Vec<Diagnostic>,
}

impl SchemaIndex {
    /// The key fields used for a type: schema `@key`, then `config.types`, then `defaultKeys`.
    pub fn key_fields_for_type(&self, type_name: &str) -> &[String] {
        self.key_fields.get(type_name).map(Vec::as_slice).unwrap_or(&[])
    }

    /// `true` when the type has no available key field and is therefore stored inline.
    pub fn is_embedded(&self, type_name: &str) -> bool {
        self.key_fields_for_type(type_name).is_empty()
    }

    /// The indexed type, or `None` when the schema has no such type.
    pub fn named_type(&self, name: &str) -> Option<&SchemaType> {
        self.type_positions.get(name).map(|position| &self.types[*position])
    }

    /// The kind of a type, or `None` when it is unknown.
    pub fn type_kind(&self, name: &str) -> Option<SchemaTypeKind> {
        self.named_type(name).map(|entry| entry.kind)
    }

    /// The declared type of a field, or `None` when the type is not an object or
    /// interface, or the field is unknown (the oracle's `fieldType`).
    pub fn field_type(&self, type_name: &str, field: &str) -> Option<&TypeNode> {
        let entry = self.named_type(type_name)?;
        if !matches!(entry.kind, SchemaTypeKind::Object | SchemaTypeKind::Interface) {
            return None;
        }
        entry.fields.iter().find(|entry| entry.name == field).map(|entry| &entry.type_node)
    }

    /// The declared type of a field's argument.
    pub fn argument_type(&self, type_name: &str, field: &str, argument: &str) -> Option<&TypeNode> {
        let entry = self.named_type(type_name)?;
        if !matches!(entry.kind, SchemaTypeKind::Object | SchemaTypeKind::Interface) {
            return None;
        }
        let field = entry.fields.iter().find(|entry| entry.name == field)?;
        field.arguments.iter().find(|entry| entry.name == argument).map(|entry| &entry.type_node)
    }

    /// True when the named type is a scalar or an enum.
    pub fn is_leaf(&self, name: &str) -> bool {
        matches!(self.type_kind(name), Some(SchemaTypeKind::Scalar | SchemaTypeKind::Enum))
    }

    /// True when the named type is an object, interface or union.
    pub fn is_composite(&self, name: &str) -> bool {
        matches!(
            self.type_kind(name),
            Some(SchemaTypeKind::Object | SchemaTypeKind::Interface | SchemaTypeKind::Union)
        )
    }

    /// The possible concrete types of a composite type.
    pub fn possible_types_of(&self, name: &str) -> &[String] {
        self.possible_types.get(name).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The values of an enum.
    pub fn enum_values(&self, name: &str) -> &[String] {
        self.enums.get(name).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The fields of an input object.
    pub fn input_fields(&self, name: &str) -> Option<&JsObject<String>> {
        self.input_types.get(name)
    }

    /// The interface names a type implements.
    pub fn interfaces_of(&self, name: &str) -> &[String] {
        self.named_type(name).map(|entry| entry.interfaces.as_slice()).unwrap_or(&[])
    }
}

/// Options accepted by [`build_schema_index`].
#[derive(Clone, Debug)]
pub struct SchemaIndexOptions {
    /// Custom scalar mapping.
    pub scalars: JsObject<ScalarConfig>,
    /// Per-type key configuration.
    pub types: JsObject<TypeConfig>,
    /// Fallback key fields. Default `['id']`.
    pub default_keys: Vec<String>,
}

impl Default for SchemaIndexOptions {
    /// What `buildSchemaIndex(sdl)` uses when it is called without options:
    /// no scalars, no per-type keys, and `defaultKeys: ['id']`.
    fn default() -> Self {
        Self { scalars: JsObject::new(), types: JsObject::new(), default_keys: vec!["id".into()] }
    }
}

impl SchemaIndexOptions {
    /// The options a resolved config carries.
    pub fn from_config(config: &RustConfig) -> Self {
        Self {
            scalars: config.scalars.clone(),
            types: config.types.clone(),
            default_keys: config.default_keys.clone(),
        }
    }
}

/// True when the SDL already declares the named directive.
pub fn has_directive_definition(sdl: &str, name: &str) -> bool {
    // `new RegExp('(^|\\n)\\s*directive\\s+@' + name + '\\b').test(sdl)`
    for_each_line_start(sdl, |text| matches_directive_declaration(text, name))
}

/// True when the SDL already declares the named enum (`(^|\n)\s*enum\s+name\b`).
fn has_enum_definition(sdl: &str, name: &str) -> bool {
    for_each_line_start(sdl, |text| matches_enum_declaration(text, name))
}

/// Calls `test` with the text at every position `(^|\n)` matches.
fn for_each_line_start(sdl: &str, test: impl Fn(&str) -> bool) -> bool {
    let mut start = 0usize;
    loop {
        if test(&sdl[start..]) {
            return true;
        }
        match sdl[start..].find('\n') {
            Some(index) => start += index + 1,
            None => return false,
        }
    }
}

/// Matches `\s*directive\s+@name\b` at the start of `text`.
fn matches_directive_declaration(text: &str, name: &str) -> bool {
    let rest = text.trim_start_matches(is_js_space);
    let Some(rest) = rest.strip_prefix("directive") else {
        return false;
    };
    let Some(rest) = strip_required_space(rest) else {
        return false;
    };
    let Some(rest) = rest.strip_prefix('@') else {
        return false;
    };
    matches_name(rest, name)
}

/// Matches `\s*enum\s+name\b` at the start of `text`.
fn matches_enum_declaration(text: &str, name: &str) -> bool {
    let rest = text.trim_start_matches(is_js_space);
    let Some(rest) = rest.strip_prefix("enum") else {
        return false;
    };
    let Some(rest) = strip_required_space(rest) else {
        return false;
    };
    matches_name(rest, name)
}

/// `\s+`: removes at least one whitespace character, or fails.
fn strip_required_space(text: &str) -> Option<&str> {
    let rest = text.trim_start_matches(is_js_space);
    (rest.len() < text.len()).then_some(rest)
}

/// `name\b`: the text starts with `name` and the next character is not a word character.
fn matches_name(text: &str, name: &str) -> bool {
    let Some(rest) = text.strip_prefix(name) else {
        return false;
    };
    !rest.chars().next().is_some_and(is_word_character)
}

/// True for the characters JavaScript's `\s` matches.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        ' ' | '\t'
            | '\n'
            | '\u{000b}'
            | '\u{000c}'
            | '\r'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// True for `[A-Za-z0-9_]`, the characters JavaScript's `\w` matches.
fn is_word_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

/// Adds only the compiler's directive/enum definitions the schema does not already declare.
pub fn merge_directive_definitions(sdl: &str) -> String {
    let text = if sdl.ends_with('\n') { sdl.to_string() } else { format!("{sdl}\n") };
    let missing: Vec<&str> = SCHEMA_DIRECTIVE_DEFINITIONS
        .iter()
        .copied()
        .filter(|definition| {
            let name = definition_name(definition);
            if name.is_empty() {
                return false;
            }
            let declaration = if definition.starts_with("directive") {
                has_directive_definition(&text, &name)
            } else {
                has_enum_definition(&text, &name)
            };
            !declaration
        })
        .collect();
    if missing.is_empty() {
        return text;
    }
    format!("{text}\n{}\n", missing.join("\n"))
}

/// The name a compiler definition declares: the `(?:directive\s+@|enum\s+)(\w+)` match.
fn definition_name(definition: &str) -> String {
    for (index, _) in definition.char_indices() {
        let rest = &definition[index..];
        let after = if let Some(rest) = rest.strip_prefix("directive") {
            match strip_required_space(rest).and_then(|rest| rest.strip_prefix('@')) {
                Some(after) => after,
                None => continue,
            }
        } else if let Some(rest) = rest.strip_prefix("enum") {
            match strip_required_space(rest) {
                Some(after) => after,
                None => continue,
            }
        } else {
            continue;
        };
        let name: String =
            after.chars().take_while(|character| is_word_character(*character)).collect();
        if !name.is_empty() {
            return name;
        }
    }
    String::new()
}

/// The SDL the index is built from (user SDL plus merged directives, `@key` repeatable).
pub fn index_sdl_for(sdl: &str) -> String {
    if has_directive_definition(sdl, "key") {
        return merge_directive_definitions(sdl);
    }
    let merged = merge_directive_definitions(sdl);
    // `String.prototype.replace` with a string pattern replaces the first occurrence.
    match merged.find(PLAIN_KEY_DIRECTIVE) {
        Some(index) => {
            let mut replaced = String::with_capacity(merged.len());
            replaced.push_str(&merged[..index]);
            replaced.push_str(INDEX_KEY_DIRECTIVE);
            replaced.push_str(&merged[index + PLAIN_KEY_DIRECTIVE.len()..]);
            replaced
        }
        None => merged,
    }
}

/// Builds a [`SchemaIndex`] from SDL. `file` is the SDL's project-relative posix path
/// (or `<inline>`), used for FLM1015's location.
pub fn build_schema_index(
    sdl: &str,
    options: &SchemaIndexOptions,
    file: &str,
) -> Result<SchemaIndex, SchemaError> {
    let index_sdl = index_sdl_for(sdl);
    let document = crate::graphql::parse_type_system_document(&index_sdl)
        .map_err(|error| SchemaError::new(format!("Invalid schema: {}", error.message)))?;
    index_document(sdl, &index_sdl, &document, options, file)
}

/// Builds a [`SchemaIndex`] from an already parsed index SDL. Private so the unit
/// tests can index a hand-built document independently of the parser port.
fn index_document(
    sdl: &str,
    index_sdl: &str,
    document: &SchemaDocument,
    options: &SchemaIndexOptions,
    file: &str,
) -> Result<SchemaIndex, SchemaError> {
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let text = SourceText::new(index_sdl);
    let (slots, positions) = build_type_map(document)?;

    let mut schema_key_fields: JsObject<Vec<String>> = JsObject::new();
    let mut key_fields: JsObject<Vec<String>> = JsObject::new();
    for slot in &slots {
        let entry = &slot.schema_type;
        if !matches!(entry.kind, SchemaTypeKind::Object | SchemaTypeKind::Interface) {
            continue;
        }
        let from_schema =
            schema_keys_of(entry, &slot.base_directives, &mut diagnostics, &text, file)?;
        schema_key_fields.insert(entry.name.clone(), from_schema.clone());
        let leaf = |name: &str| {
            entry
                .fields
                .iter()
                .find(|field| field.name == name)
                .is_some_and(|field| is_leaf_named_type(&field.type_node, &slots, &positions))
        };
        // A schema `@key` naming a field the type cannot offer is FLM1015 and is dropped;
        // a configured key naming a composite field stays, so a selection can report
        // FLM1005 ("configured with keys the selection cannot provide"). Default keys
        // are always filtered to leaf fields, which is what keeps a type embedded.
        let invalid: Vec<&String> =
            from_schema.iter().filter(|name| !leaf(name.as_str())).collect();
        if !invalid.is_empty() {
            diagnostics.push(
                DiagnosticInput::error(
                    "FLM1015",
                    format!(
                        "@key on type \"{}\" names {}, which is not a scalar field of the type.",
                        entry.name,
                        invalid
                            .iter()
                            .map(|name| format!("\"{name}\""))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                    type_location(entry, &text, file),
                )
                .build(),
            );
        }
        let schema_leaf: Vec<String> =
            from_schema.iter().filter(|name| leaf(name.as_str())).cloned().collect();
        let configured_keys =
            options.types.get(&entry.name).and_then(|config| config.keys.as_ref());
        let candidate = if !schema_leaf.is_empty() {
            schema_leaf
        } else if let Some(configured_keys) = configured_keys {
            configured_keys
                .iter()
                .filter(|name| entry.fields.iter().any(|field| field.name == name.as_str()))
                .cloned()
                .collect()
        } else {
            options.default_keys.iter().filter(|name| leaf(name.as_str())).cloned().collect()
        };
        if !candidate.is_empty() {
            key_fields.insert(entry.name.clone(), candidate);
        }
    }

    let types: Vec<SchemaType> = slots.into_iter().map(|slot| slot.schema_type).collect();
    let mut possible_types: JsObject<Vec<String>> = JsObject::new();
    let mut enums: JsObject<Vec<String>> = JsObject::new();
    let mut input_types: JsObject<JsObject<String>> = JsObject::new();
    for entry in &types {
        match entry.kind {
            SchemaTypeKind::Object => {
                possible_types.insert(entry.name.clone(), vec![entry.name.clone()]);
            }
            SchemaTypeKind::Interface | SchemaTypeKind::Union => {
                possible_types.insert(entry.name.clone(), possible_types_of(entry, &types));
            }
            SchemaTypeKind::Enum => {
                enums.insert(entry.name.clone(), entry.enum_values.clone());
            }
            SchemaTypeKind::InputObject => {
                let mut fields: JsObject<String> = JsObject::new();
                for field in &entry.fields {
                    fields.insert(field.name.clone(), type_ref_string(&field.type_node));
                }
                input_types.insert(entry.name.clone(), fields);
            }
            SchemaTypeKind::Scalar => {}
        }
    }

    Ok(SchemaIndex {
        types,
        type_positions: positions,
        possible_types,
        key_fields,
        schema_key_fields,
        enums,
        input_types,
        hash: hash_document(&merge_directive_definitions(sdl)),
        sdl: sdl.to_string(),
        index_sdl: index_sdl.to_string(),
        file: file.to_string(),
        has_key_directive: has_directive_definition(sdl, "key"),
        document: document.clone(),
        diagnostics,
    })
}

/// Builds a [`SchemaIndex`] from a source text, for callers that already split the SDL.
pub fn source_text_of(sdl: &str) -> SourceText {
    SourceText::new(sdl)
}

/// The compact type string of a type node (`[Species!]!`).
pub fn type_ref_string(node: &TypeNode) -> String {
    node.to_type_string()
}

/// Number of list levels in a type (`[Species!]!` → 1).
pub fn list_depth(node: &TypeNode) -> usize {
    match node {
        TypeNode::Named(_) => 0,
        TypeNode::List(inner) => 1 + list_depth(&inner.type_node),
        TypeNode::NonNull(inner) => list_depth(&inner.type_node),
    }
}

/// `true` when the outermost modifier is not `!`.
pub fn is_nullable_type(node: &TypeNode) -> bool {
    !matches!(node, TypeNode::NonNull(_))
}

// ---------------------------------------------------------------------------
// Type map construction
// ---------------------------------------------------------------------------

/// One type while the index is built: the merged definition, the base definition's
/// directives (what graphql-js exposes as `type.astNode.directives`, and the only
/// place `@key` is read from) and the position of the type in the type map.
struct TypeSlot {
    schema_type: SchemaType,
    base_directives: Vec<Directive>,
}

/// The five scalars `buildSchema` knows without a definition.
const STANDARD_SCALAR_NAMES: &[&str] = &["String", "Int", "Float", "Boolean", "ID"];

/// The type map the oracle's `schema.getTypeMap()` returns, as far as the index
/// reads it: the SDL types (extensions merged in) in `GraphQLSchema`'s collected
/// order, plus the built-in scalars.
fn build_type_map(
    document: &SchemaDocument,
) -> Result<(Vec<TypeSlot>, HashMap<String, usize>), SchemaError> {
    validate_sdl(document)?;

    let mut slots: Vec<TypeSlot> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();

    // Definitions first, in document order. A name `extendSchema` resolves through
    // its `stdTypeMap` (a built-in scalar or an introspection type) is substituted,
    // and an introspection type is filtered out of every read anyway.
    for definition in &document.definitions {
        let TypeSystemDefinition::Type(node) = definition else {
            continue;
        };
        if node.is_extension() || is_reserved_type_name(node.name()) {
            continue;
        }
        let (schema_type, base_directives) = describe_type(node);
        positions.insert(schema_type.name.clone(), slots.len());
        slots.push(TypeSlot { schema_type, base_directives });
    }

    // Extensions, in document order: fields/values/members/interfaces appended,
    // directives appended.
    for definition in &document.definitions {
        let TypeSystemDefinition::Type(node) = definition else {
            continue;
        };
        if !node.is_extension() {
            continue;
        }
        let Some(position) = positions.get(node.name()).copied() else {
            continue;
        };
        merge_extension(&mut slots[position].schema_type, node);
        slots[position].schema_type.directives.extend(directives_of(node).iter().cloned());
    }

    let sdl_names: Vec<String> =
        slots.iter().map(|slot| slot.schema_type.name.clone()).collect();

    // The built-in scalars. graphql-js pulls String and Boolean in through the
    // introspection types and the rest when the SDL references them; the index
    // knows all five so `is_leaf` answers for a scalar the SDL never names.
    for name in STANDARD_SCALAR_NAMES {
        if positions.contains_key(*name) {
            continue;
        }
        positions.insert((*name).to_string(), slots.len());
        slots.push(TypeSlot {
            schema_type: SchemaType {
                name: (*name).to_string(),
                kind: SchemaTypeKind::Scalar,
                fields: Vec::new(),
                enum_values: Vec::new(),
                interfaces: Vec::new(),
                union_types: Vec::new(),
                directives: Vec::new(),
                loc: None,
            },
            base_directives: Vec::new(),
        });
    }

    // `GraphQLSchema`'s `collectReferencedTypes` order: each type is removed from
    // the collected set and re-added together with everything it references, so a
    // type lands where it was first referenced.
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (index, slot) in slots.iter().enumerate() {
        by_name.insert(slot.schema_type.name.clone(), index);
    }
    let mut order: Vec<String> = Vec::new();
    let mut present: HashSet<String> = HashSet::new();
    for name in &sdl_names {
        order.push(name.clone());
        present.insert(name.clone());
    }
    for name in &sdl_names {
        present.remove(name);
        order.retain(|entry| entry != name);
        collect_referenced(name, &slots, &by_name, &mut order, &mut present);
    }
    for name in STANDARD_SCALAR_NAMES {
        if present.insert((*name).to_string()) {
            order.push((*name).to_string());
        }
    }

    let mut remaining: Vec<Option<TypeSlot>> = slots.into_iter().map(Some).collect();
    let mut reordered: Vec<TypeSlot> = Vec::with_capacity(remaining.len());
    let mut collected: HashMap<String, usize> = HashMap::new();
    for name in &order {
        let Some(index) = by_name.get(name).copied() else {
            continue;
        };
        let Some(slot) = remaining[index].take() else {
            continue;
        };
        collected.insert(name.clone(), reordered.len());
        reordered.push(slot);
    }

    Ok((reordered, collected))
}

/// `collectReferencedTypes(type, typeSet)`: adds a type and, depth first, every
/// type it references, in the order graphql-js walks them.
fn collect_referenced(
    name: &str,
    slots: &[TypeSlot],
    by_name: &HashMap<String, usize>,
    order: &mut Vec<String>,
    present: &mut HashSet<String>,
) {
    if !present.insert(name.to_string()) {
        return;
    }
    order.push(name.to_string());
    let Some(index) = by_name.get(name).copied() else {
        return;
    };
    for referenced in referenced_type_names(&slots[index].schema_type) {
        collect_referenced(&referenced, slots, by_name, order, present);
    }
}

/// The named types `collectReferencedTypes` walks from one type.
fn referenced_type_names(entry: &SchemaType) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    match entry.kind {
        SchemaTypeKind::Union => found.extend(entry.union_types.iter().cloned()),
        SchemaTypeKind::Object | SchemaTypeKind::Interface => {
            found.extend(entry.interfaces.iter().cloned());
            for field in &entry.fields {
                found.push(field.type_node.named_type().name.value.clone());
                for argument in &field.arguments {
                    found.push(argument.type_node.named_type().name.value.clone());
                }
            }
        }
        SchemaTypeKind::InputObject => {
            for field in &entry.fields {
                found.push(field.type_node.named_type().name.value.clone());
            }
        }
        SchemaTypeKind::Scalar | SchemaTypeKind::Enum => {}
    }
    found
}

/// True for a name `extendSchema` resolves through `stdTypeMap`.
fn is_reserved_type_name(name: &str) -> bool {
    STANDARD_SCALAR_NAMES.contains(&name) || name.starts_with("__")
}

/// True when a declared type resolves to a scalar or an enum.
fn is_leaf_named_type(
    node: &TypeNode,
    slots: &[TypeSlot],
    positions: &HashMap<String, usize>,
) -> bool {
    let name = &node.named_type().name.value;
    positions.get(name).is_some_and(|position| {
        matches!(
            slots[*position].schema_type.kind,
            SchemaTypeKind::Scalar | SchemaTypeKind::Enum
        )
    })
}

/// The `SchemaType` a definition describes, plus its base directives.
fn describe_type(node: &TypeDefinition) -> (SchemaType, Vec<Directive>) {
    let base_directives = directives_of(node).to_vec();
    let mut schema_type = SchemaType {
        name: node.name().to_string(),
        kind: SchemaTypeKind::Scalar,
        fields: Vec::new(),
        enum_values: Vec::new(),
        interfaces: Vec::new(),
        union_types: Vec::new(),
        directives: base_directives.clone(),
        loc: node.loc(),
    };
    match node {
        TypeDefinition::Scalar(_) => {}
        TypeDefinition::Object(node) => {
            schema_type.kind = SchemaTypeKind::Object;
            schema_type.interfaces = interface_names(&node.interfaces);
            schema_type.fields = node.fields.iter().map(schema_field_of).collect();
        }
        TypeDefinition::Interface(node) => {
            schema_type.kind = SchemaTypeKind::Interface;
            schema_type.interfaces = interface_names(&node.interfaces);
            schema_type.fields = node.fields.iter().map(schema_field_of).collect();
        }
        TypeDefinition::Union(node) => {
            schema_type.kind = SchemaTypeKind::Union;
            schema_type.union_types =
                node.types.iter().map(|entry| entry.name.value.clone()).collect();
        }
        TypeDefinition::Enum(node) => {
            schema_type.kind = SchemaTypeKind::Enum;
            schema_type.enum_values =
                node.values.iter().map(|entry| entry.name.value.clone()).collect();
        }
        TypeDefinition::InputObject(node) => {
            schema_type.kind = SchemaTypeKind::InputObject;
            schema_type.fields = node.fields.iter().map(input_field_of).collect();
        }
    }
    (schema_type, base_directives)
}

/// Appends an extension's contents to the base type, in `extendSchema`'s order.
fn merge_extension(target: &mut SchemaType, node: &TypeDefinition) {
    match node {
        TypeDefinition::Scalar(_) => {}
        TypeDefinition::Object(node) => {
            target.interfaces.extend(interface_names(&node.interfaces));
            target.fields.extend(node.fields.iter().map(schema_field_of));
        }
        TypeDefinition::Interface(node) => {
            target.interfaces.extend(interface_names(&node.interfaces));
            target.fields.extend(node.fields.iter().map(schema_field_of));
        }
        TypeDefinition::Union(node) => {
            target.union_types.extend(node.types.iter().map(|entry| entry.name.value.clone()));
        }
        TypeDefinition::Enum(node) => {
            target.enum_values.extend(node.values.iter().map(|entry| entry.name.value.clone()));
        }
        TypeDefinition::InputObject(node) => {
            target.fields.extend(node.fields.iter().map(input_field_of));
        }
    }
}

/// The names of an implemented-interfaces list.
fn interface_names(interfaces: &[NamedType]) -> Vec<String> {
    interfaces.iter().map(|entry| entry.name.value.clone()).collect()
}

/// The directives of a type definition, whatever its kind.
fn directives_of(node: &TypeDefinition) -> &[Directive] {
    match node {
        TypeDefinition::Scalar(node) => &node.directives,
        TypeDefinition::Object(node) => &node.directives,
        TypeDefinition::Interface(node) => &node.directives,
        TypeDefinition::Union(node) => &node.directives,
        TypeDefinition::Enum(node) => &node.directives,
        TypeDefinition::InputObject(node) => &node.directives,
    }
}

/// The keyword a type definition uses, for a kind-mismatched extension.
fn definition_kind_name(node: &TypeDefinition) -> &'static str {
    match node {
        TypeDefinition::Scalar(_) => "scalar",
        TypeDefinition::Object(_) => "object",
        TypeDefinition::Interface(_) => "interface",
        TypeDefinition::Union(_) => "union",
        TypeDefinition::Enum(_) => "enum",
        TypeDefinition::InputObject(_) => "input object",
    }
}

/// One `SchemaField` from a field definition.
fn schema_field_of(node: &FieldDefinition) -> SchemaField {
    SchemaField {
        name: node.name.value.clone(),
        type_node: node.type_node.clone(),
        arguments: node.arguments.iter().map(schema_input_value_of).collect(),
        directives: node.directives.clone(),
    }
}

/// One `SchemaField` from an input object field.
fn input_field_of(node: &InputValueDefinition) -> SchemaField {
    SchemaField {
        name: node.name.value.clone(),
        type_node: node.type_node.clone(),
        arguments: Vec::new(),
        directives: node.directives.clone(),
    }
}

/// One `SchemaInputValue` from an input value definition.
fn schema_input_value_of(node: &InputValueDefinition) -> SchemaInputValue {
    SchemaInputValue {
        name: node.name.value.clone(),
        type_node: node.type_node.clone(),
        default_value: node.default_value.clone(),
        directives: node.directives.clone(),
    }
}

/// The concrete types of a composite type, the way `schema.getPossibleTypes` sees them.
fn possible_types_of(entry: &SchemaType, types: &[SchemaType]) -> Vec<String> {
    match entry.kind {
        SchemaTypeKind::Union => entry.union_types.clone(),
        SchemaTypeKind::Interface => types
            .iter()
            .filter(|candidate| {
                candidate.kind == SchemaTypeKind::Object
                    && candidate.interfaces.iter().any(|name| name == &entry.name)
            })
            .map(|candidate| candidate.name.clone())
            .collect(),
        _ => vec![entry.name.clone()],
    }
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/// The key fields a type declares with `@key`, reporting FLM1015 like `schemaKeysOf`.
fn schema_keys_of(
    entry: &SchemaType,
    base_directives: &[Directive],
    diagnostics: &mut Vec<Diagnostic>,
    text: &SourceText,
    file: &str,
) -> Result<Vec<String>, SchemaError> {
    let directives: Vec<&Directive> =
        base_directives.iter().filter(|directive| directive.name.value == "key").collect();
    if directives.is_empty() {
        return Ok(Vec::new());
    }
    if directives.len() > 1 {
        diagnostics.push(
            DiagnosticInput::error(
                "FLM1015",
                format!(
                    "Type \"{}\" has more than one @key directive; declare the key fields once.",
                    entry.name
                ),
                type_location(entry, text, file),
            )
            .build(),
        );
        return Ok(Vec::new());
    }
    let value = directives[0]
        .arguments
        .iter()
        .find(|argument| argument.name.value == "fields")
        .map(|argument| &argument.value);
    match value {
        Some(Value::ListValue { values, .. }) => Ok(values
            .iter()
            .filter_map(|value| match value {
                Value::StringValue { value, .. } => Some(value.clone()),
                _ => None,
            })
            .collect()),
        Some(Value::StringValue { value, .. }) => Ok(value
            .split(|character: char| is_js_space(character) || character == ',')
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect()),
        _ => Err(SchemaError::new(format!(
            "@key on type \"{}\" must take a list of field names or a whitespace-separated \
             string; use `types: {{ {}: {{ keys: [...] }} }}` in flamme.config.ts instead.",
            entry.name, entry.name
        ))),
    }
}

/// The FLM1015 location: the base type definition's start, with the type name's length.
fn type_location(entry: &SchemaType, text: &SourceText, file: &str) -> SourceLocation {
    let offset = entry.loc.map(|loc| loc.start).unwrap_or(0);
    location_at(text, file, offset, entry.name.encode_utf16().count() as u32)
}

// ---------------------------------------------------------------------------
// SDL validation (`buildSchema`'s `assertValidSDL`)
// ---------------------------------------------------------------------------

/// The position `specifiedSDLRules` runs each rule at, for ordering a report that
/// several rules contribute to.
const RULE_LONE_SCHEMA_DEFINITION: usize = 1;
const RULE_UNIQUE_TYPE_NAMES: usize = 3;
const RULE_KNOWN_TYPE_NAMES: usize = 8;
const RULE_KNOWN_DIRECTIVES: usize = 9;
const RULE_UNIQUE_DIRECTIVES_PER_LOCATION: usize = 10;
const RULE_POSSIBLE_TYPE_EXTENSIONS: usize = 11;

/// The names graphql-js knows without a definition: the built-in scalars and the
/// introspection types.
const STANDARD_TYPE_NAMES: &[&str] = &[
    "String",
    "Int",
    "Float",
    "Boolean",
    "ID",
    "__Schema",
    "__Type",
    "__TypeKind",
    "__Field",
    "__InputValue",
    "__EnumValue",
    "__Directive",
    "__DirectiveLocation",
];

/// Runs the subset of `specifiedSDLRules` `buildSchema` enforces and joins the
/// messages the way `assertValidSDL` does. Rules outside the subset (duplicate
/// field/enum value/argument names, directive locations and arguments) are not
/// reproduced; a document that trips one of those is indexed instead of rejected.
fn validate_sdl(document: &SchemaDocument) -> Result<(), SchemaError> {
    let mut errors: Vec<(Offset, usize, String)> = Vec::new();

    let mut defined_order: Vec<&str> = Vec::new();
    let mut defined_kinds: HashMap<&str, &'static str> = HashMap::new();
    let mut directive_repeatable: HashMap<String, bool> = specified_directives();
    for definition in &document.definitions {
        if let TypeSystemDefinition::Directive(node) = definition {
            if !node.is_extension {
                directive_repeatable.insert(node.name.value.clone(), node.repeatable);
            }
        }
    }

    // LoneSchemaDefinitionRule and UniqueTypeNamesRule.
    let mut schema_definitions = 0usize;
    for definition in &document.definitions {
        match definition {
            TypeSystemDefinition::Schema(node) => {
                if node.is_extension {
                    continue;
                }
                if schema_definitions > 0 {
                    errors.push((
                        node.loc.map(|loc| loc.start).unwrap_or(Offset::MAX),
                        RULE_LONE_SCHEMA_DEFINITION,
                        "Must provide only one schema definition.".to_string(),
                    ));
                }
                schema_definitions += 1;
            }
            TypeSystemDefinition::Type(node) => {
                if node.is_extension() {
                    continue;
                }
                let name = node.name();
                let offset = node.loc().map(|loc| loc.start).unwrap_or(Offset::MAX);
                if defined_kinds.contains_key(name) {
                    errors.push((
                        offset,
                        RULE_UNIQUE_TYPE_NAMES,
                        format!("There can be only one type named \"{name}\"."),
                    ));
                } else {
                    defined_kinds.insert(name, definition_kind_name(node));
                    defined_order.push(name);
                }
            }
            TypeSystemDefinition::Directive(_) => {}
        }
    }

    // PossibleTypeExtensionsRule.
    for definition in &document.definitions {
        let TypeSystemDefinition::Type(node) = definition else {
            continue;
        };
        if !node.is_extension() {
            continue;
        }
        let name = node.name();
        let offset = node.loc().map(|loc| loc.start).unwrap_or(Offset::MAX);
        match defined_kinds.get(name) {
            None => {
                let candidates: Vec<String> =
                    defined_order.iter().map(|name| (*name).to_string()).collect();
                errors.push((
                    offset,
                    RULE_POSSIBLE_TYPE_EXTENSIONS,
                    format!(
                        "Cannot extend type \"{name}\" because it is not defined.{}",
                        did_you_mean(&suggestion_list(name, &candidates))
                    ),
                ));
            }
            Some(expected) => {
                let actual = definition_kind_name(node);
                if *expected != actual {
                    errors.push((
                        offset,
                        RULE_POSSIBLE_TYPE_EXTENSIONS,
                        format!("Cannot extend non-{actual} type \"{name}\"."),
                    ));
                }
            }
        }
    }

    // KnownDirectivesRule: every applied directive must be declared, and must be
    // declared for the location it is applied at.
    let mut directive_locations: HashMap<String, Vec<String>> = specified_directive_locations();
    for definition in &document.definitions {
        if let TypeSystemDefinition::Directive(node) = definition {
            if !node.is_extension {
                directive_locations.insert(
                    node.name.value.clone(),
                    node.locations.iter().map(|location| location.value.clone()).collect(),
                );
            }
        }
    }
    for definition in &document.definitions {
        for (location, directive) in directive_sites(definition) {
            let offset = directive.loc.map(|loc| loc.start).unwrap_or(Offset::MAX);
            match directive_locations.get(&directive.name.value) {
                None => errors.push((
                    offset,
                    RULE_KNOWN_DIRECTIVES,
                    format!("Unknown directive \"@{}\".", directive.name.value),
                )),
                Some(locations) => {
                    if !locations.iter().any(|entry| entry == location) {
                        errors.push((
                            offset,
                            RULE_KNOWN_DIRECTIVES,
                            format!(
                                "Directive \"@{}\" may not be used on {location}.",
                                directive.name.value
                            ),
                        ));
                    }
                }
            }
        }
    }

    // UniqueDirectivesPerLocationRule.
    let mut type_directives: HashMap<String, Vec<String>> = HashMap::new();
    let mut schema_directives: Vec<String> = Vec::new();
    for definition in &document.definitions {
        match definition {
            TypeSystemDefinition::Schema(node) => {
                check_unique_directives(
                    &node.directives,
                    &mut schema_directives,
                    &directive_repeatable,
                    node.loc,
                    &mut errors,
                );
            }
            TypeSystemDefinition::Type(node) => {
                let seen = type_directives.entry(node.name().to_string()).or_default();
                check_unique_directives(
                    directives_of(node),
                    seen,
                    &directive_repeatable,
                    node.loc(),
                    &mut errors,
                );
            }
            TypeSystemDefinition::Directive(_) => {
                // The AST has no `directives` on a directive definition, which the
                // default parser options do not produce either.
            }
        }
    }

    // KnownTypeNamesRule: every type reference must resolve, unless it is one of
    // the names graphql-js knows without a definition.
    let mut type_names: Vec<String> =
        STANDARD_TYPE_NAMES.iter().map(|name| (*name).to_string()).collect();
    type_names.extend(defined_order.iter().map(|name| (*name).to_string()));
    for definition in &document.definitions {
        for (offset, name) in type_references(definition) {
            if STANDARD_TYPE_NAMES.contains(&name.as_str()) || defined_kinds.contains_key(name.as_str())
            {
                continue;
            }
            errors.push((
                offset,
                RULE_KNOWN_TYPE_NAMES,
                format!(
                    "Unknown type \"{name}\".{}",
                    did_you_mean(&suggestion_list(&name, &type_names))
                ),
            ));
        }
    }

    if errors.is_empty() {
        return Ok(());
    }
    errors.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let messages: Vec<String> = errors.into_iter().map(|(_, _, message)| message).collect();
    Err(SchemaError::new(format!("Invalid schema: {}", messages.join("\n\n"))))
}

/// The directives graphql-js declares itself, none of them repeatable.
fn specified_directives() -> HashMap<String, bool> {
    ["include", "skip", "deprecated", "specifiedBy", "oneOf"]
        .iter()
        .map(|name| ((*name).to_string(), false))
        .collect()
}

/// The locations graphql-js declares its own directives for.
fn specified_directive_locations() -> HashMap<String, Vec<String>> {
    let locations: [(&str, &[&str]); 5] = [
        ("include", &["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"]),
        ("skip", &["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"]),
        (
            "deprecated",
            &["FIELD_DEFINITION", "ARGUMENT_DEFINITION", "INPUT_FIELD_DEFINITION", "ENUM_VALUE", "DIRECTIVE_DEFINITION"],
        ),
        ("specifiedBy", &["SCALAR"]),
        ("oneOf", &["INPUT_OBJECT"]),
    ];
    locations
        .into_iter()
        .map(|(name, entries)| {
            (name.to_string(), entries.iter().map(|entry| (*entry).to_string()).collect())
        })
        .collect()
}

/// Every directive application in a definition, with its `DirectiveLocation`.
fn directive_sites<'a>(definition: &'a TypeSystemDefinition) -> Vec<(&'static str, &'a Directive)> {
    let mut sites: Vec<(&'static str, &'a Directive)> = Vec::new();
    match definition {
        TypeSystemDefinition::Schema(node) => {
            push_directive_sites(&node.directives, "SCHEMA", &mut sites);
        }
        TypeSystemDefinition::Directive(node) => {
            for argument in &node.arguments {
                push_directive_sites(&argument.directives, "ARGUMENT_DEFINITION", &mut sites);
            }
        }
        TypeSystemDefinition::Type(node) => match node {
            TypeDefinition::Scalar(node) => {
                push_directive_sites(&node.directives, "SCALAR", &mut sites);
            }
            TypeDefinition::Object(node) => {
                push_directive_sites(&node.directives, "OBJECT", &mut sites);
                push_field_sites(&node.fields, &mut sites);
            }
            TypeDefinition::Interface(node) => {
                push_directive_sites(&node.directives, "INTERFACE", &mut sites);
                push_field_sites(&node.fields, &mut sites);
            }
            TypeDefinition::Union(node) => {
                push_directive_sites(&node.directives, "UNION", &mut sites);
            }
            TypeDefinition::Enum(node) => {
                push_directive_sites(&node.directives, "ENUM", &mut sites);
                for value in &node.values {
                    push_directive_sites(&value.directives, "ENUM_VALUE", &mut sites);
                }
            }
            TypeDefinition::InputObject(node) => {
                push_directive_sites(&node.directives, "INPUT_OBJECT", &mut sites);
                for field in &node.fields {
                    push_directive_sites(&field.directives, "INPUT_FIELD_DEFINITION", &mut sites);
                }
            }
        },
    }
    sites
}

/// The directive applications of a field list and its arguments.
fn push_field_sites<'a>(
    fields: &'a [FieldDefinition],
    sites: &mut Vec<(&'static str, &'a Directive)>,
) {
    for field in fields {
        push_directive_sites(&field.directives, "FIELD_DEFINITION", sites);
        for argument in &field.arguments {
            push_directive_sites(&argument.directives, "ARGUMENT_DEFINITION", sites);
        }
    }
}

/// Appends `(location, directive)` for every directive in a list.
fn push_directive_sites<'a>(
    directives: &'a [Directive],
    location: &'static str,
    sites: &mut Vec<(&'static str, &'a Directive)>,
) {
    for directive in directives {
        sites.push((location, directive));
    }
}

/// Reports a directive used twice at one location, unless it is repeatable.
fn check_unique_directives(
    directives: &[Directive],
    seen: &mut Vec<String>,
    repeatable: &HashMap<String, bool>,
    loc: Option<Loc>,
    errors: &mut Vec<(Offset, usize, String)>,
) {
    for directive in directives {
        let name = &directive.name.value;
        if repeatable.get(name).copied().unwrap_or(false) {
            continue;
        }
        if seen.contains(name) {
            errors.push((
                directive
                    .loc
                    .map(|loc| loc.start)
                    .or(loc.map(|loc| loc.start))
                    .unwrap_or(Offset::MAX),
                RULE_UNIQUE_DIRECTIVES_PER_LOCATION,
                format!("The directive \"@{name}\" can only be used once at this location."),
            ));
        } else {
            seen.push(name.clone());
        }
    }
}

/// Every named type a definition references, with the offset of the reference.
fn type_references(definition: &TypeSystemDefinition) -> Vec<(Offset, String)> {
    let mut found: Vec<(Offset, String)> = Vec::new();
    let mut push = |node: &NamedType| {
        found.push((node.loc.map(|loc| loc.start).unwrap_or(Offset::MAX), node.name.value.clone()));
    };
    match definition {
        TypeSystemDefinition::Schema(node) => {
            for operation in &node.operation_types {
                push(&NamedType {
                    name: operation.type_name.clone(),
                    loc: operation.type_name.loc,
                });
            }
        }
        TypeSystemDefinition::Directive(node) => {
            for argument in &node.arguments {
                push(argument.type_node.named_type());
            }
        }
        TypeSystemDefinition::Type(node) => match node {
            TypeDefinition::Scalar(_) | TypeDefinition::Enum(_) => {}
            TypeDefinition::Object(node) => {
                push_fields(&node.interfaces, &node.fields, &mut push);
            }
            TypeDefinition::Interface(node) => {
                push_fields(&node.interfaces, &node.fields, &mut push);
            }
            TypeDefinition::Union(node) => {
                for member in &node.types {
                    push(member);
                }
            }
            TypeDefinition::InputObject(node) => {
                for field in &node.fields {
                    push(field.type_node.named_type());
                }
            }
        },
    }
    found
}

/// Pushes the interfaces, field types and argument types of an object/interface.
fn push_fields(
    interfaces: &[NamedType],
    fields: &[FieldDefinition],
    push: &mut impl FnMut(&NamedType),
) {
    for interface in interfaces {
        push(interface);
    }
    for field in fields {
        push(field.type_node.named_type());
        for argument in &field.arguments {
            push(argument.type_node.named_type());
        }
    }
}

// ---------------------------------------------------------------------------
// `didYouMean` (`graphql/jsutils`)
// ---------------------------------------------------------------------------

/// `didYouMean(suggestions)`: ` Did you mean "A", "B", or "C"?`, or the empty string.
fn did_you_mean(suggestions: &[String]) -> String {
    let quoted: Vec<String> = suggestions.iter().map(|entry| format!("\"{entry}\"")).collect();
    match quoted.len() {
        0 => String::new(),
        1 => format!(" Did you mean {}?", quoted[0]),
        2 => format!(" Did you mean {} or {}?", quoted[0], quoted[1]),
        _ => {
            let selected = &quoted[..quoted.len().min(MAX_SUGGESTIONS)];
            let (last, rest) = selected.split_last().expect("non-empty");
            format!(" Did you mean {}, or {}?", rest.join(", "), last)
        }
    }
}

/// `MAX_SUGGESTIONS` in `graphql/jsutils/didYouMean`.
const MAX_SUGGESTIONS: usize = 5;

/// `suggestionList(input, options)`: the options within the lexical-distance
/// threshold, ordered by distance and then natural order.
fn suggestion_list(input: &str, options: &[String]) -> Vec<String> {
    let distance = LexicalDistance::new(input);
    let threshold = (utf16_len(input) as i64 * 4) / 10 + 1;
    let mut found: Vec<(String, i64)> = Vec::new();
    for option in options {
        let Some(distance) = distance.measure(option, threshold) else {
            continue;
        };
        if !found.iter().any(|(name, _)| name == option) {
            found.push((option.clone(), distance));
        }
    }
    found.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| natural_compare(&left.0, &right.0)));
    found.into_iter().map(|(name, _)| name).collect()
}

/// The UTF-16 length of `text`, which is `text.length` in JavaScript.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `stringToArray` in `graphql/jsutils/suggestionList`.
fn string_to_array(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `LexicalDistance` in `graphql/jsutils/suggestionList`.
struct LexicalDistance {
    input: String,
    input_lower_case: String,
    input_array: Vec<u16>,
}

impl LexicalDistance {
    fn new(input: &str) -> Self {
        let input_lower_case = input.to_lowercase();
        let input_array = string_to_array(&input_lower_case);
        Self { input: input.to_string(), input_lower_case, input_array }
    }

    fn measure(&self, option: &str, threshold: i64) -> Option<i64> {
        if self.input == option {
            return Some(0);
        }
        let option_lower_case = option.to_lowercase();
        if self.input_lower_case == option_lower_case {
            return Some(1);
        }
        let mut a = string_to_array(&option_lower_case);
        let mut b = self.input_array.clone();
        if a.len() < b.len() {
            std::mem::swap(&mut a, &mut b);
        }
        let a_length = a.len();
        let b_length = b.len();
        if a_length as i64 - b_length as i64 > threshold {
            return None;
        }
        let mut rows: [Vec<i64>; 3] =
            [vec![0; b_length + 1], vec![0; b_length + 1], vec![0; b_length + 1]];
        for (index, cell) in rows[0].iter_mut().enumerate() {
            *cell = index as i64;
        }
        for i in 1..=a_length {
            let up_row = rows[(i - 1) % 3].clone();
            let double_row = rows[(i + 1) % 3].clone();
            let current_row = &mut rows[i % 3];
            current_row[0] = i as i64;
            let mut smallest_cell = current_row[0];
            for j in 1..=b_length {
                let cost = i64::from(a[i - 1] != b[j - 1]);
                let mut current_cell =
                    (up_row[j] + 1).min(current_row[j - 1] + 1).min(up_row[j - 1] + cost);
                if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                    current_cell = current_cell.min(double_row[j - 2] + 1);
                }
                if current_cell < smallest_cell {
                    smallest_cell = current_cell;
                }
                current_row[j] = current_cell;
            }
            if smallest_cell > threshold {
                return None;
            }
        }
        let distance = rows[a_length % 3][b_length];
        (distance <= threshold).then_some(distance)
    }
}

/// `naturalCompare` in `graphql/jsutils/naturalCompare`.
fn natural_compare(a_str: &str, b_str: &str) -> std::cmp::Ordering {
    let a = string_to_array(a_str);
    let b = string_to_array(b_str);
    let mut a_index = 0usize;
    let mut b_index = 0usize;
    while a_index < a.len() && b_index < b.len() {
        let mut a_char = a[a_index];
        let mut b_char = b[b_index];
        if is_digit(a_char) && is_digit(b_char) {
            let mut a_num = 0i64;
            loop {
                a_index += 1;
                a_num = a_num * 10 + i64::from(a_char) - 48;
                a_char = a.get(a_index).copied().unwrap_or(u16::MAX);
                if !(is_digit(a_char) && a_num > 0) {
                    break;
                }
            }
            let mut b_num = 0i64;
            loop {
                b_index += 1;
                b_num = b_num * 10 + i64::from(b_char) - 48;
                b_char = b.get(b_index).copied().unwrap_or(u16::MAX);
                if !(is_digit(b_char) && b_num > 0) {
                    break;
                }
            }
            if a_num < b_num {
                return std::cmp::Ordering::Less;
            }
            if a_num > b_num {
                return std::cmp::Ordering::Greater;
            }
        } else {
            if a_char < b_char {
                return std::cmp::Ordering::Less;
            }
            if a_char > b_char {
                return std::cmp::Ordering::Greater;
            }
            a_index += 1;
            b_index += 1;
        }
    }
    (a.len() as i64 - b.len() as i64).cmp(&0)
}

/// `isDigit` in `naturalCompare`.
fn is_digit(code: u16) -> bool {
    (48..=57).contains(&code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graphql::ast::{
        Argument, DirectiveDefinition, EnumTypeDefinition, EnumValueDefinition, FieldDefinition,
        InputObjectTypeDefinition, InputValueDefinition, InterfaceTypeDefinition, Name,
        ObjectTypeDefinition,
    };

    const POC_SCHEMA: &str = include_str!("../tests/fixtures/poc/server/schema.graphql");

    fn named(name: &str) -> TypeNode {
        TypeNode::Named(NamedType { name: Name::synthetic(name), loc: None })
    }

    fn non_null(inner: TypeNode) -> TypeNode {
        TypeNode::NonNull(crate::graphql::ast::NonNullType {
            type_node: Box::new(inner),
            loc: None,
        })
    }

    fn field(name: &str, type_node: TypeNode) -> FieldDefinition {
        FieldDefinition {
            description: None,
            name: Name::synthetic(name),
            arguments: Vec::new(),
            type_node,
            directives: Vec::new(),
            loc: None,
        }
    }

    fn object(
        name: &str,
        interfaces: Vec<NamedType>,
        directives: Vec<Directive>,
        fields: Vec<FieldDefinition>,
    ) -> TypeDefinition {
        TypeDefinition::Object(ObjectTypeDefinition {
            is_extension: false,
            description: None,
            name: Name::synthetic(name),
            interfaces,
            directives,
            fields,
            loc: None,
        })
    }

    fn key_directive(fields: Value) -> Directive {
        Directive {
            name: Name::synthetic("key"),
            arguments: vec![Argument {
                name: Name::synthetic("fields"),
                value: fields,
                loc: None,
            }],
            loc: None,
        }
    }

    /// The `@key` definition the merged index SDL always carries.
    fn key_definition() -> TypeSystemDefinition {
        TypeSystemDefinition::Directive(DirectiveDefinition {
            is_extension: false,
            description: None,
            name: Name::synthetic("key"),
            arguments: Vec::new(),
            repeatable: true,
            locations: vec![Name::synthetic("OBJECT"), Name::synthetic("INTERFACE")],
            loc: None,
        })
    }

    fn string_values(values: &[&str]) -> Value {
        Value::ListValue {
            values: values
                .iter()
                .map(|value| Value::StringValue {
                    value: (*value).to_string(),
                    block: false,
                    loc: None,
                })
                .collect(),
            loc: None,
        }
    }

    fn empty_type(name: &str, kind: SchemaTypeKind) -> SchemaType {
        SchemaType {
            name: name.to_string(),
            kind,
            fields: Vec::new(),
            enum_values: Vec::new(),
            interfaces: Vec::new(),
            union_types: Vec::new(),
            directives: Vec::new(),
            loc: None,
        }
    }

    fn document(definitions: Vec<TypeSystemDefinition>) -> SchemaDocument {
        SchemaDocument { definitions }
    }

    fn index(schema: &SchemaDocument, options: &SchemaIndexOptions) -> SchemaIndex {
        index_document("sdl", "sdl", schema, options, "schema.graphql").expect("index builds")
    }

    fn build(schema: &SchemaDocument) -> SchemaIndex {
        index(schema, &SchemaIndexOptions::default())
    }

    fn rejects(schema: &SchemaDocument) -> String {
        index_document("sdl", "sdl", schema, &SchemaIndexOptions::default(), "schema.graphql")
            .expect_err("invalid schema")
            .message
    }

    #[test]
    fn merge_appends_every_definition_to_a_bare_schema() {
        let merged = merge_directive_definitions(POC_SCHEMA);
        assert!(POC_SCHEMA.ends_with('\n'));
        let expected = format!("{POC_SCHEMA}\n{}\n", SCHEMA_DIRECTIVE_DEFINITIONS.join("\n"));
        assert_eq!(merged, expected);
        assert!(merged.contains(PLAIN_KEY_DIRECTIVE));
        assert!(!has_directive_definition(POC_SCHEMA, "key"));
        assert!(!has_directive_definition(POC_SCHEMA, "cache"));
    }

    #[test]
    fn merge_adds_a_missing_newline_first() {
        let merged = merge_directive_definitions("type Query { a: Int }");
        assert!(merged.starts_with("type Query { a: Int }\n\n"));
        assert!(merged.ends_with('\n'));
        assert_eq!(merged.matches("directive @key").count(), 1);
    }

    #[test]
    fn merge_keeps_a_schema_that_declares_key_verbatim() {
        let sdl =
            "directive @key(fields: [String!]!) on OBJECT | INTERFACE\n\ntype Query { id: ID! }\n";
        assert!(has_directive_definition(sdl, "key"));
        let merged = merge_directive_definitions(sdl);
        assert_eq!(merged.matches("directive @key").count(), 1);
        assert!(merged.starts_with(sdl));
        assert_eq!(index_sdl_for(sdl), merged);
        assert!(!merged.contains(INDEX_KEY_DIRECTIVE));
    }

    #[test]
    fn merge_skips_a_schema_that_declares_cache() {
        let sdl = "directive @cache(policy: CachePolicy, partial: Boolean) on QUERY\n\ntype Query { id: ID! }\n";
        let merged = merge_directive_definitions(sdl);
        assert!(!merged.contains(
            "directive @cache(policy: CachePolicy, partial: Boolean) on QUERY | MUTATION | SUBSCRIPTION"
        ));
        assert!(merged
            .contains("enum CachePolicy { CacheOrNetwork NetworkOnly CacheAndNetwork CacheOnly }"));
    }

    #[test]
    fn merge_skips_a_declared_enum() {
        let sdl = "enum CachePolicy { Only }\n\ntype Query { id: ID! }\n";
        let merged = merge_directive_definitions(sdl);
        assert!(!merged.contains("enum CachePolicy { CacheOrNetwork"));
        assert_eq!(merged.matches("enum CachePolicy").count(), 1);
    }

    #[test]
    fn index_sdl_replaces_the_key_directive_with_the_repeatable_one() {
        let indexed = index_sdl_for(POC_SCHEMA);
        assert!(indexed.contains(INDEX_KEY_DIRECTIVE));
        assert!(!indexed.contains(&format!("{PLAIN_KEY_DIRECTIVE}\n")));
        assert!(index_sdl_for("type Query { id: ID! }\n").contains(INDEX_KEY_DIRECTIVE));
    }

    #[test]
    fn directive_declarations_are_matched_at_line_starts_only() {
        assert!(has_directive_definition("directive @key on OBJECT", "key"));
        assert!(has_directive_definition(
            "\n  directive   @key(fields: [String!]!) on OBJECT",
            "key"
        ));
        assert!(!has_directive_definition("# directive @key on OBJECT", "key"));
        assert!(!has_directive_definition("type A { b: String }", "key"));
        assert!(!has_directive_definition("directive @keys on OBJECT", "key"));
    }

    #[test]
    fn type_helpers_wrap_and_unwrap() {
        let list = TypeNode::List(crate::graphql::ast::ListType {
            type_node: Box::new(non_null(named("Species"))),
            loc: None,
        });
        let wrapped = non_null(list);
        assert_eq!(type_ref_string(&wrapped), "[Species!]!");
        assert_eq!(list_depth(&wrapped), 1);
        assert!(!is_nullable_type(&wrapped));
        assert!(is_nullable_type(&named("Species")));
    }

    #[test]
    fn schema_keys_accept_a_list_and_a_string() {
        let entry = empty_type("Species", SchemaTypeKind::Object);
        let text = SourceText::new("");
        let mut diagnostics = Vec::new();
        let list = key_directive(string_values(&["id", "name"]));
        assert_eq!(
            schema_keys_of(&entry, &[list], &mut diagnostics, &text, "schema.graphql").unwrap(),
            vec!["id".to_string(), "name".to_string()]
        );
        let string = key_directive(Value::StringValue {
            value: "id, name  pokedexNumber".into(),
            block: false,
            loc: None,
        });
        assert_eq!(
            schema_keys_of(&entry, &[string], &mut diagnostics, &text, "schema.graphql").unwrap(),
            vec!["id".to_string(), "name".to_string(), "pokedexNumber".to_string()]
        );
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn schema_keys_drop_list_entries_that_are_not_strings() {
        // `value.values.flatMap((entry) => (entry.kind === Kind.STRING ? [entry.value] : []))`
        let mixed = Value::ListValue {
            values: vec![
                Value::IntValue { value: "1".into(), loc: None },
                Value::StringValue { value: "id".into(), block: false, loc: None },
            ],
            loc: None,
        };
        let entry = empty_type("Species", SchemaTypeKind::Object);
        let text = SourceText::new("");
        let mut diagnostics = Vec::new();
        let keys = schema_keys_of(
            &entry,
            &[key_directive(mixed)],
            &mut diagnostics,
            &text,
            "schema.graphql",
        )
        .unwrap();
        assert_eq!(keys, ["id"]);
    }

    #[test]
    fn schema_keys_report_more_than_one_directive() {
        let entry = empty_type("Species", SchemaTypeKind::Object);
        let directives =
            vec![key_directive(string_values(&["id"])), key_directive(string_values(&["name"]))];
        let text = SourceText::new("");
        let mut diagnostics = Vec::new();
        let keys =
            schema_keys_of(&entry, &directives, &mut diagnostics, &text, "schema.graphql").unwrap();
        assert!(keys.is_empty());
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, "FLM1015");
        assert_eq!(
            diagnostics[0].message,
            "Type \"Species\" has more than one @key directive; declare the key fields once."
        );
    }

    #[test]
    fn schema_keys_reject_a_non_string_argument() {
        let entry = empty_type("Species", SchemaTypeKind::Object);
        let directive = key_directive(Value::IntValue { value: "1".into(), loc: None });
        let text = SourceText::new("");
        let mut diagnostics = Vec::new();
        let error = schema_keys_of(&entry, &[directive], &mut diagnostics, &text, "schema.graphql")
            .expect_err("throws");
        assert_eq!(
            error.message,
            "@key on type \"Species\" must take a list of field names or a whitespace-separated \
             string; use `types: { Species: { keys: [...] } }` in flamme.config.ts instead."
        );
    }

    #[test]
    fn keys_follow_schema_then_config_then_defaults() {
        let query =
            object("Query", Vec::new(), Vec::new(), vec![field("id", non_null(named("ID")))]);
        let item = object(
            "Item",
            Vec::new(),
            vec![key_directive(string_values(&["id"]))],
            vec![field("id", non_null(named("ID"))), field("name", named("String"))],
        );
        let configured = object(
            "Configured",
            Vec::new(),
            Vec::new(),
            vec![field("id", non_null(named("ID"))), field("slug", named("String"))],
        );
        let plain =
            object("Plain", Vec::new(), Vec::new(), vec![field("id", non_null(named("ID")))]);
        let schema = document(vec![
            key_definition(),
            TypeSystemDefinition::Type(query),
            TypeSystemDefinition::Type(item),
            TypeSystemDefinition::Type(configured),
            TypeSystemDefinition::Type(plain),
        ]);
        let mut options = SchemaIndexOptions::default();
        options
            .types
            .insert("Configured", TypeConfig { keys: Some(vec!["slug".into()]) });
        let indexed = index(&schema, &options);
        assert_eq!(indexed.key_fields_for_type("Item"), ["id"]);
        assert_eq!(indexed.key_fields_for_type("Configured"), ["slug"]);
        assert_eq!(indexed.key_fields_for_type("Plain"), ["id"]);
        assert_eq!(
            indexed.schema_key_fields.get("Item").map(Vec::as_slice),
            Some(&["id".to_string()][..])
        );
        assert_eq!(indexed.schema_key_fields.get("Plain").map(Vec::len), Some(0));
        assert!(indexed.diagnostics.is_empty());
    }

    #[test]
    fn a_schema_key_naming_a_composite_field_is_flm1015() {
        let child =
            object("Child", Vec::new(), Vec::new(), vec![field("id", non_null(named("ID")))]);
        let parent = object(
            "Parent",
            Vec::new(),
            vec![key_directive(string_values(&["child"]))],
            vec![field("child", named("Child")), field("id", non_null(named("ID")))],
        );
        let schema = document(vec![
            key_definition(),
            TypeSystemDefinition::Type(child),
            TypeSystemDefinition::Type(parent),
        ]);
        let indexed = build(&schema);
        assert_eq!(indexed.diagnostics.len(), 1);
        assert_eq!(indexed.diagnostics[0].code, "FLM1015");
        assert_eq!(
            indexed.diagnostics[0].message,
            "@key on type \"Parent\" names \"child\", which is not a scalar field of the type."
        );
        // the default key still applies to the type
        assert_eq!(indexed.key_fields_for_type("Parent"), ["id"]);
    }

    #[test]
    fn a_key_naming_a_list_of_scalars_is_a_key() {
        // `isLeafType(getNamedType(field.type))` unwraps the list wrappers.
        let tags = TypeNode::List(crate::graphql::ast::ListType {
            type_node: Box::new(non_null(named("String"))),
            loc: None,
        });
        let item = object(
            "Item",
            Vec::new(),
            vec![key_directive(string_values(&["tags"]))],
            vec![field("tags", tags), field("id", non_null(named("ID")))],
        );
        let schema =
            document(vec![key_definition(), TypeSystemDefinition::Type(item)]);
        let indexed = build(&schema);
        assert!(indexed.diagnostics.is_empty(), "{:?}", indexed.diagnostics);
        assert_eq!(indexed.key_fields_for_type("Item"), ["tags"]);
    }

    #[test]
    fn possible_types_and_inputs_match_the_type_map() {
        let node = TypeSystemDefinition::Type(TypeDefinition::Interface(InterfaceTypeDefinition {
            is_extension: false,
            description: None,
            name: Name::synthetic("Node"),
            interfaces: Vec::new(),
            directives: Vec::new(),
            fields: vec![field("id", non_null(named("ID")))],
            loc: None,
        }));
        let species = object(
            "Species",
            vec![NamedType { name: Name::synthetic("Node"), loc: None }],
            Vec::new(),
            vec![field("id", non_null(named("ID")))],
        );
        let kind = TypeSystemDefinition::Type(TypeDefinition::Enum(EnumTypeDefinition {
            is_extension: false,
            description: None,
            name: Name::synthetic("Kind"),
            directives: Vec::new(),
            values: vec![
                EnumValueDefinition {
                    description: None,
                    name: Name::synthetic("Fire"),
                    directives: Vec::new(),
                    loc: None,
                },
                EnumValueDefinition {
                    description: None,
                    name: Name::synthetic("Water"),
                    directives: Vec::new(),
                    loc: None,
                },
            ],
            loc: None,
        }));
        let filter =
            TypeSystemDefinition::Type(TypeDefinition::InputObject(InputObjectTypeDefinition {
                is_extension: false,
                description: None,
                name: Name::synthetic("Filter"),
                directives: Vec::new(),
                fields: vec![
                    InputValueDefinition {
                        description: None,
                        name: Name::synthetic("kind"),
                        type_node: named("Kind"),
                        default_value: None,
                        directives: Vec::new(),
                        loc: None,
                    },
                    InputValueDefinition {
                        description: None,
                        name: Name::synthetic("limit"),
                        type_node: named("Int"),
                        default_value: None,
                        directives: Vec::new(),
                        loc: None,
                    },
                ],
                loc: None,
            }));
        let union =
            TypeSystemDefinition::Type(TypeDefinition::Union(crate::graphql::ast::UnionTypeDefinition {
                is_extension: false,
                description: None,
                name: Name::synthetic("Result"),
                directives: Vec::new(),
                types: vec![NamedType { name: Name::synthetic("Species"), loc: None }],
                loc: None,
            }));
        let schema = document(vec![node, TypeSystemDefinition::Type(species), kind, filter, union]);
        let indexed = build(&schema);
        assert_eq!(indexed.possible_types_of("Species"), ["Species"]);
        assert_eq!(indexed.possible_types_of("Node"), ["Species"]);
        assert_eq!(indexed.possible_types_of("Result"), ["Species"]);
        assert_eq!(indexed.enum_values("Kind"), ["Fire", "Water"]);
        let fields = indexed.input_fields("Filter").expect("input object");
        assert_eq!(fields.get("kind").map(String::as_str), Some("Kind"));
        assert_eq!(fields.get("limit").map(String::as_str), Some("Int"));
        assert_eq!(indexed.named_type("Int").map(|entry| entry.kind), Some(SchemaTypeKind::Scalar));
        assert!(indexed.is_leaf("Kind"));
        assert!(indexed.is_composite("Result"));
        assert!(!indexed.is_composite("Filter"));
        assert!(indexed.field_type("Filter", "kind").is_none());
    }

    #[test]
    fn extensions_merge_into_the_base_type() {
        let base =
            object("Species", Vec::new(), Vec::new(), vec![field("id", non_null(named("ID")))]);
        let extension = TypeDefinition::Object(ObjectTypeDefinition {
            is_extension: true,
            description: None,
            name: Name::synthetic("Species"),
            interfaces: vec![NamedType { name: Name::synthetic("Node"), loc: None }],
            directives: Vec::new(),
            fields: vec![field("name", named("String"))],
            loc: None,
        });
        let node = TypeSystemDefinition::Type(TypeDefinition::Interface(InterfaceTypeDefinition {
            is_extension: false,
            description: None,
            name: Name::synthetic("Node"),
            interfaces: Vec::new(),
            directives: Vec::new(),
            fields: Vec::new(),
            loc: None,
        }));
        let schema = document(vec![
            TypeSystemDefinition::Type(base),
            node,
            TypeSystemDefinition::Type(extension),
        ]);
        let indexed = build(&schema);
        let species = indexed.named_type("Species").expect("Species");
        assert_eq!(
            species.fields.iter().map(|field| field.name.as_str()).collect::<Vec<_>>(),
            ["id", "name"]
        );
        assert_eq!(indexed.interfaces_of("Species"), ["Node"]);
        assert_eq!(indexed.possible_types_of("Node"), ["Species"]);
    }

    #[test]
    fn an_unknown_type_reference_is_rejected() {
        let query = object("Query", Vec::new(), Vec::new(), vec![field("a", named("Missing"))]);
        let schema = document(vec![TypeSystemDefinition::Type(query)]);
        assert_eq!(rejects(&schema), "Invalid schema: Unknown type \"Missing\".");
    }

    #[test]
    fn a_typo_suggests_the_close_type() {
        let query = object("Query", Vec::new(), Vec::new(), vec![field("a", named("Strng"))]);
        let schema = document(vec![TypeSystemDefinition::Type(query)]);
        assert_eq!(
            rejects(&schema),
            "Invalid schema: Unknown type \"Strng\". Did you mean \"String\"?"
        );
    }

    #[test]
    fn duplicate_type_names_and_broken_extensions_are_rejected() {
        let first = object("Query", Vec::new(), Vec::new(), vec![field("a", named("Int"))]);
        let second = object("Query", Vec::new(), Vec::new(), vec![field("b", named("Int"))]);
        let schema =
            document(vec![TypeSystemDefinition::Type(first), TypeSystemDefinition::Type(second)]);
        assert_eq!(
            rejects(&schema),
            "Invalid schema: There can be only one type named \"Query\"."
        );

        let extension = TypeDefinition::Object(ObjectTypeDefinition {
            is_extension: true,
            description: None,
            name: Name::synthetic("Missing"),
            interfaces: Vec::new(),
            directives: Vec::new(),
            fields: Vec::new(),
            loc: None,
        });
        let schema = document(vec![TypeSystemDefinition::Type(extension)]);
        assert_eq!(
            rejects(&schema),
            "Invalid schema: Cannot extend type \"Missing\" because it is not defined."
        );
    }

    #[test]
    fn a_non_repeatable_directive_cannot_be_used_twice() {
        let directive = DirectiveDefinition {
            is_extension: false,
            description: None,
            name: Name::synthetic("key"),
            arguments: Vec::new(),
            repeatable: false,
            locations: vec![Name::synthetic("OBJECT"), Name::synthetic("INTERFACE")],
            loc: None,
        };
        let query = object(
            "Query",
            Vec::new(),
            vec![key_directive(string_values(&["id"])), key_directive(string_values(&["name"]))],
            vec![field("id", non_null(named("ID")))],
        );
        let schema = document(vec![
            TypeSystemDefinition::Directive(directive),
            TypeSystemDefinition::Type(query),
        ]);
        assert_eq!(
            rejects(&schema),
            "Invalid schema: The directive \"@key\" can only be used once at this location."
        );
    }

    #[test]
    fn an_unknown_directive_is_rejected() {
        let unknown =
            Directive { name: Name::synthetic("nope"), arguments: Vec::new(), loc: None };
        let query = object(
            "Query",
            Vec::new(),
            vec![unknown],
            vec![field("id", non_null(named("ID")))],
        );
        let schema = document(vec![TypeSystemDefinition::Type(query)]);
        assert_eq!(rejects(&schema), "Invalid schema: Unknown directive \"@nope\".");
    }

    #[test]
    fn a_directive_used_at_the_wrong_location_is_rejected() {
        let mut marked = field("id", non_null(named("ID")));
        marked.directives = vec![key_directive(string_values(&["id"]))];
        let query = object("Query", Vec::new(), Vec::new(), vec![marked]);
        let schema = document(vec![key_definition(), TypeSystemDefinition::Type(query)]);
        assert_eq!(
            rejects(&schema),
            "Invalid schema: Directive \"@key\" may not be used on FIELD_DEFINITION."
        );
    }

    #[test]
    fn the_specified_directives_are_accepted_at_their_locations() {
        let deprecated =
            || Directive { name: Name::synthetic("deprecated"), arguments: Vec::new(), loc: None };
        let mut marked = field("id", non_null(named("ID")));
        marked.directives = vec![deprecated()];
        let query = object("Query", Vec::new(), Vec::new(), vec![marked]);
        let kind = TypeSystemDefinition::Type(TypeDefinition::Enum(EnumTypeDefinition {
            is_extension: false,
            description: None,
            name: Name::synthetic("Kind"),
            directives: Vec::new(),
            values: vec![EnumValueDefinition {
                description: None,
                name: Name::synthetic("A"),
                directives: vec![deprecated()],
                loc: None,
            }],
            loc: None,
        }));
        let schema = document(vec![TypeSystemDefinition::Type(query), kind]);
        let indexed = build(&schema);
        assert!(indexed.diagnostics.is_empty());
        assert_eq!(indexed.enum_values("Kind"), ["A"]);
    }

    #[test]
    fn natural_compare_and_suggestions_follow_graphql_js() {
        assert_eq!(natural_compare("a2", "a10"), std::cmp::Ordering::Less);
        assert_eq!(natural_compare("a", "b"), std::cmp::Ordering::Less);
        assert_eq!(natural_compare("a", "a"), std::cmp::Ordering::Equal);
        assert_eq!(did_you_mean(&[]), "");
        assert_eq!(did_you_mean(&["A".to_string()]), " Did you mean \"A\"?");
        assert_eq!(
            did_you_mean(&["A".to_string(), "B".to_string()]),
            " Did you mean \"A\" or \"B\"?"
        );
        assert_eq!(
            did_you_mean(&["A".to_string(), "B".to_string(), "C".to_string()]),
            " Did you mean \"A\", \"B\", or \"C\"?"
        );
        assert_eq!(
            suggestion_list("Strin", &["String".to_string(), "Int".to_string()]),
            ["String"]
        );
    }

    #[test]
    fn default_options_carry_the_id_default_key() {
        assert_eq!(SchemaIndexOptions::default().default_keys, ["id"]);
    }
}
