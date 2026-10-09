//! A graphql-js-compatible GraphQL AST.
//!
//! The port keeps graphql-js's node names, `loc` semantics and source positions so
//! every downstream module (validation, IR, printing) can be transliterated
//! without translating offsets. A [`Loc`] carries UTF-16 code unit offsets into
//! the document text, exactly like `node.loc.start` / `node.loc.end` in
//! graphql-js, and `Loc` is `Option` because a synthesized node has no location.
//!
//! Both the executable grammar ([`Document`]) and the type system grammar
//! ([`SchemaDocument`]) live here; the lexer and parser are in [`crate::graphql`].

use crate::offsets::Offset;

/// A source range in UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Loc {
    /// Start offset, inclusive.
    pub start: Offset,
    /// End offset, exclusive.
    pub end: Offset,
}

impl Loc {
    /// Builds a location.
    pub fn new(start: Offset, end: Offset) -> Self {
        Self { start, end }
    }
}

/// A `Name` node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name {
    /// The name text.
    pub value: String,
    /// Source location.
    pub loc: Option<Loc>,
}

impl Name {
    /// A synthesized name with no location.
    pub fn synthetic(value: impl Into<String>) -> Self {
        Self { value: value.into(), loc: None }
    }
}

/// The operation type of an operation definition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationType {
    /// `query`
    Query,
    /// `mutation`
    Mutation,
    /// `subscription`
    Subscription,
}

impl OperationType {
    /// The keyword, as `operation` holds it in graphql-js.
    pub fn as_str(self) -> &'static str {
        match self {
            OperationType::Query => "query",
            OperationType::Mutation => "mutation",
            OperationType::Subscription => "subscription",
        }
    }
}

/// `Document`: every definition a source holds, in source order.
///
/// graphql-js 16 has one `parse` for both grammars, so a document may hold a type
/// system definition. The compiler rejects such a document at extraction (`FLM1011`,
/// exactly like the oracle: one type definition alone is "only operations and
/// fragments can be compiled into artifacts.", and one beside an operation is "a
/// document must contain exactly one operation or fragment, found 2."), which is why
/// the variant is here: the definition has to be parsed and counted for the
/// diagnostic to name what graphql-js names, at the offset graphql-js reports.
#[derive(Clone, Debug, PartialEq)]
pub struct Document {
    /// The definitions, in source order.
    pub definitions: Vec<Definition>,
}

/// One parsed definition: executable, or the type system definition `parse` accepts
/// and the pipeline rejects.
#[derive(Clone, Debug, PartialEq)]
pub enum Definition {
    /// `query`/`mutation`/`subscription`
    Operation(OperationDefinition),
    /// `fragment X on Y`
    Fragment(FragmentDefinition),
    /// `schema`, `type`, `scalar`, `interface`, `union`, `enum`, `input`, `directive`
    /// or an `extend` of one. Never becomes an artifact.
    TypeSystem(TypeSystemDefinition),
}

impl Definition {
    /// The definition's location.
    pub fn loc(&self) -> Option<Loc> {
        match self {
            Definition::Operation(node) => node.loc,
            Definition::Fragment(node) => node.loc,
            Definition::TypeSystem(node) => node.loc(),
        }
    }
}

/// `OperationDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct OperationDefinition {
    /// The description, in the form `print` emits it: a quoted string or a block
    /// string. graphql-js 16 parses a description on an operation definition and
    /// `print` stringifies it, so the port keeps the printed text to stay
    /// byte-identical.
    pub description: Option<String>,
    /// The operation type.
    pub operation: OperationType,
    /// The operation name, absent for the anonymous shorthand.
    pub name: Option<Name>,
    /// Variable definitions.
    pub variable_definitions: Vec<VariableDefinition>,
    /// Directives.
    pub directives: Vec<Directive>,
    /// The selection set.
    pub selection_set: SelectionSet,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `VariableDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct VariableDefinition {
    /// The description, in the form `print` emits it.
    pub description: Option<String>,
    /// The variable.
    pub variable: Variable,
    /// The declared type.
    pub type_node: TypeNode,
    /// The default value.
    pub default_value: Option<Value>,
    /// Directives.
    pub directives: Vec<Directive>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `Variable`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Variable {
    /// The variable name.
    pub name: Name,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `SelectionSet`.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectionSet {
    /// The selections, in source order.
    pub selections: Vec<Selection>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// One selection.
#[derive(Clone, Debug, PartialEq)]
pub enum Selection {
    /// A field.
    Field(Field),
    /// `...Name`
    FragmentSpread(FragmentSpread),
    /// `... on Type { }` or `... { }`
    InlineFragment(InlineFragment),
}

impl Selection {
    /// The selection's location.
    pub fn loc(&self) -> Option<Loc> {
        match self {
            Selection::Field(node) => node.loc,
            Selection::FragmentSpread(node) => node.loc,
            Selection::InlineFragment(node) => node.loc,
        }
    }
}

/// `Field`.
#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    /// The alias, when written.
    pub alias: Option<Name>,
    /// The field name.
    pub name: Name,
    /// Arguments.
    pub arguments: Vec<Argument>,
    /// Directives.
    pub directives: Vec<Directive>,
    /// The nested selection set.
    pub selection_set: Option<SelectionSet>,
    /// Source location.
    pub loc: Option<Loc>,
}

impl Field {
    /// The response key: the alias when present, the field name otherwise.
    pub fn response_key(&self) -> &str {
        match &self.alias {
            Some(alias) => &alias.value,
            None => &self.name.value,
        }
    }
}

/// `Argument`.
#[derive(Clone, Debug, PartialEq)]
pub struct Argument {
    /// The argument name.
    pub name: Name,
    /// The argument value.
    pub value: Value,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `FragmentSpread`.
#[derive(Clone, Debug, PartialEq)]
pub struct FragmentSpread {
    /// The fragment name.
    pub name: Name,
    /// Directives.
    pub directives: Vec<Directive>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `InlineFragment`.
#[derive(Clone, Debug, PartialEq)]
pub struct InlineFragment {
    /// The type condition, when written.
    pub type_condition: Option<NamedType>,
    /// Directives.
    pub directives: Vec<Directive>,
    /// The selection set.
    pub selection_set: SelectionSet,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `FragmentDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct FragmentDefinition {
    /// The description, in the form `print` emits it.
    pub description: Option<String>,
    /// The fragment name.
    pub name: Name,
    /// Fragment variable definitions (the fragment-arguments experiment).
    pub variable_definitions: Vec<VariableDefinition>,
    /// The type condition.
    pub type_condition: NamedType,
    /// Directives.
    pub directives: Vec<Directive>,
    /// The selection set.
    pub selection_set: SelectionSet,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `Directive`.
#[derive(Clone, Debug, PartialEq)]
pub struct Directive {
    /// The directive name, without `@`.
    pub name: Name,
    /// Arguments.
    pub arguments: Vec<Argument>,
    /// Source location.
    pub loc: Option<Loc>,
}

impl Directive {
    /// The argument with this name.
    pub fn argument(&self, name: &str) -> Option<&Argument> {
        self.arguments.iter().find(|argument| argument.name.value == name)
    }
}

/// `ObjectField`.
#[derive(Clone, Debug, PartialEq)]
pub struct ObjectField {
    /// The field name.
    pub name: Name,
    /// The field value.
    pub value: Value,
    /// Source location.
    pub loc: Option<Loc>,
}

/// A GraphQL value literal.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// `$name`
    Variable(Variable),
    /// An integer literal; `value` is the source text.
    IntValue {
        /// The literal text.
        value: String,
        /// Source location.
        loc: Option<Loc>,
    },
    /// A float literal; `value` is the source text.
    FloatValue {
        /// The literal text.
        value: String,
        /// Source location.
        loc: Option<Loc>,
    },
    /// A string literal, `block` for `"""…"""`.
    StringValue {
        /// The decoded value.
        value: String,
        /// True for a block string.
        block: bool,
        /// Source location.
        loc: Option<Loc>,
    },
    /// `true`/`false`.
    BooleanValue {
        /// The value.
        value: bool,
        /// Source location.
        loc: Option<Loc>,
    },
    /// `null`.
    NullValue {
        /// Source location.
        loc: Option<Loc>,
    },
    /// An enum literal.
    EnumValue {
        /// The literal text.
        value: String,
        /// Source location.
        loc: Option<Loc>,
    },
    /// A list literal.
    ListValue {
        /// The values.
        values: Vec<Value>,
        /// Source location.
        loc: Option<Loc>,
    },
    /// An object literal.
    ObjectValue {
        /// The fields, in source order.
        fields: Vec<ObjectField>,
        /// Source location.
        loc: Option<Loc>,
    },
}

impl Value {
    /// The value's location.
    pub fn loc(&self) -> Option<Loc> {
        match self {
            Value::Variable(node) => node.loc,
            Value::IntValue { loc, .. }
            | Value::FloatValue { loc, .. }
            | Value::StringValue { loc, .. }
            | Value::BooleanValue { loc, .. }
            | Value::NullValue { loc }
            | Value::EnumValue { loc, .. }
            | Value::ListValue { loc, .. }
            | Value::ObjectValue { loc, .. } => *loc,
        }
    }

    /// The graphql-js `Kind` string of the value.
    pub fn kind(&self) -> &'static str {
        match self {
            Value::Variable(_) => "Variable",
            Value::IntValue { .. } => "IntValue",
            Value::FloatValue { .. } => "FloatValue",
            Value::StringValue { .. } => "StringValue",
            Value::BooleanValue { .. } => "BooleanValue",
            Value::NullValue { .. } => "NullValue",
            Value::EnumValue { .. } => "EnumValue",
            Value::ListValue { .. } => "ListValue",
            Value::ObjectValue { .. } => "ObjectValue",
        }
    }
}

/// A type reference: `NamedType`, `ListType` or `NonNullType`.
#[derive(Clone, Debug, PartialEq)]
pub enum TypeNode {
    /// A named type.
    Named(NamedType),
    /// `[Type]`
    List(ListType),
    /// `Type!`
    NonNull(NonNullType),
}

impl TypeNode {
    /// The node's location.
    pub fn loc(&self) -> Option<Loc> {
        match self {
            TypeNode::Named(node) => node.loc,
            TypeNode::List(node) => node.loc,
            TypeNode::NonNull(node) => node.loc,
        }
    }

    /// The graphql-js `Kind` string.
    pub fn kind(&self) -> &'static str {
        match self {
            TypeNode::Named(_) => "NamedType",
            TypeNode::List(_) => "ListType",
            TypeNode::NonNull(_) => "NonNullType",
        }
    }

    /// The compact type string (`[Species!]!`), the compiler's `modifiers`.
    pub fn to_type_string(&self) -> String {
        match self {
            TypeNode::Named(node) => node.name.value.clone(),
            TypeNode::List(node) => format!("[{}]", node.type_node.to_type_string()),
            TypeNode::NonNull(node) => format!("{}!", node.type_node.to_type_string()),
        }
    }

    /// The innermost named type.
    pub fn named_type(&self) -> &NamedType {
        match self {
            TypeNode::Named(node) => node,
            TypeNode::List(node) => node.type_node.named_type(),
            TypeNode::NonNull(node) => node.type_node.named_type(),
        }
    }
}

/// `NamedType`.
#[derive(Clone, Debug, PartialEq)]
pub struct NamedType {
    /// The type name.
    pub name: Name,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `ListType`.
#[derive(Clone, Debug, PartialEq)]
pub struct ListType {
    /// The element type.
    pub type_node: Box<TypeNode>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `NonNullType`.
#[derive(Clone, Debug, PartialEq)]
pub struct NonNullType {
    /// The wrapped type.
    pub type_node: Box<TypeNode>,
    /// Source location.
    pub loc: Option<Loc>,
}

// ---------------------------------------------------------------------------
// Type system (SDL)
// ---------------------------------------------------------------------------

/// The type system document `buildSchema` consumes.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct SchemaDocument {
    /// The definitions, in source order.
    pub definitions: Vec<TypeSystemDefinition>,
}

/// One type system definition.
#[derive(Clone, Debug, PartialEq)]
pub enum TypeSystemDefinition {
    /// `schema { … }`
    Schema(SchemaDefinition),
    /// A type, interface, union, enum, scalar or input definition (or extension).
    Type(TypeDefinition),
    /// `directive @x on …`
    Directive(DirectiveDefinition),
}

impl TypeSystemDefinition {
    /// The definition's location.
    pub fn loc(&self) -> Option<Loc> {
        match self {
            TypeSystemDefinition::Schema(node) => node.loc,
            TypeSystemDefinition::Type(node) => node.loc(),
            TypeSystemDefinition::Directive(node) => node.loc,
        }
    }
}

/// `SchemaDefinition`, or a `extend schema` extension.
#[derive(Clone, Debug, PartialEq)]
pub struct SchemaDefinition {
    /// True for `extend schema`.
    pub is_extension: bool,
    /// The `description` string, when written.
    pub description: Option<String>,
    /// Directives.
    pub directives: Vec<Directive>,
    /// The root operation types.
    pub operation_types: Vec<OperationTypeDefinition>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `OperationTypeDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct OperationTypeDefinition {
    /// The operation.
    pub operation: OperationType,
    /// The root type name.
    pub type_name: Name,
    /// Source location.
    pub loc: Option<Loc>,
}

/// One type definition.
#[derive(Clone, Debug, PartialEq)]
pub enum TypeDefinition {
    /// `scalar`
    Scalar(ScalarTypeDefinition),
    /// `type`
    Object(ObjectTypeDefinition),
    /// `interface`
    Interface(InterfaceTypeDefinition),
    /// `union`
    Union(UnionTypeDefinition),
    /// `enum`
    Enum(EnumTypeDefinition),
    /// `input`
    InputObject(InputObjectTypeDefinition),
}

impl TypeDefinition {
    /// The defined type's name.
    pub fn name(&self) -> &str {
        match self {
            TypeDefinition::Scalar(node) => &node.name.value,
            TypeDefinition::Object(node) => &node.name.value,
            TypeDefinition::Interface(node) => &node.name.value,
            TypeDefinition::Union(node) => &node.name.value,
            TypeDefinition::Enum(node) => &node.name.value,
            TypeDefinition::InputObject(node) => &node.name.value,
        }
    }

    /// True for an `extend` form.
    pub fn is_extension(&self) -> bool {
        match self {
            TypeDefinition::Scalar(node) => node.is_extension,
            TypeDefinition::Object(node) => node.is_extension,
            TypeDefinition::Interface(node) => node.is_extension,
            TypeDefinition::Union(node) => node.is_extension,
            TypeDefinition::Enum(node) => node.is_extension,
            TypeDefinition::InputObject(node) => node.is_extension,
        }
    }

    /// The definition's location.
    pub fn loc(&self) -> Option<Loc> {
        match self {
            TypeDefinition::Scalar(node) => node.loc,
            TypeDefinition::Object(node) => node.loc,
            TypeDefinition::Interface(node) => node.loc,
            TypeDefinition::Union(node) => node.loc,
            TypeDefinition::Enum(node) => node.loc,
            TypeDefinition::InputObject(node) => node.loc,
        }
    }
}

/// `ScalarTypeDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct ScalarTypeDefinition {
    /// True for `extend scalar`.
    pub is_extension: bool,
    /// The description.
    pub description: Option<String>,
    /// The type name.
    pub name: Name,
    /// Directives.
    pub directives: Vec<Directive>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `ObjectTypeDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct ObjectTypeDefinition {
    /// True for `extend type`.
    pub is_extension: bool,
    /// The description.
    pub description: Option<String>,
    /// The type name.
    pub name: Name,
    /// Implemented interfaces.
    pub interfaces: Vec<NamedType>,
    /// Directives.
    pub directives: Vec<Directive>,
    /// Fields.
    pub fields: Vec<FieldDefinition>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `InterfaceTypeDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct InterfaceTypeDefinition {
    /// True for `extend interface`.
    pub is_extension: bool,
    /// The description.
    pub description: Option<String>,
    /// The type name.
    pub name: Name,
    /// Implemented interfaces.
    pub interfaces: Vec<NamedType>,
    /// Directives.
    pub directives: Vec<Directive>,
    /// Fields.
    pub fields: Vec<FieldDefinition>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `UnionTypeDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct UnionTypeDefinition {
    /// True for `extend union`.
    pub is_extension: bool,
    /// The description.
    pub description: Option<String>,
    /// The type name.
    pub name: Name,
    /// Directives.
    pub directives: Vec<Directive>,
    /// The member types.
    pub types: Vec<NamedType>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `EnumTypeDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct EnumTypeDefinition {
    /// True for `extend enum`.
    pub is_extension: bool,
    /// The description.
    pub description: Option<String>,
    /// The type name.
    pub name: Name,
    /// Directives.
    pub directives: Vec<Directive>,
    /// The values.
    pub values: Vec<EnumValueDefinition>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `EnumValueDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct EnumValueDefinition {
    /// The description.
    pub description: Option<String>,
    /// The value name.
    pub name: Name,
    /// Directives.
    pub directives: Vec<Directive>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `InputObjectTypeDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct InputObjectTypeDefinition {
    /// True for `extend input`.
    pub is_extension: bool,
    /// The description.
    pub description: Option<String>,
    /// The type name.
    pub name: Name,
    /// Directives.
    pub directives: Vec<Directive>,
    /// Fields.
    pub fields: Vec<InputValueDefinition>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `FieldDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldDefinition {
    /// The description.
    pub description: Option<String>,
    /// The field name.
    pub name: Name,
    /// Arguments.
    pub arguments: Vec<InputValueDefinition>,
    /// The field type.
    pub type_node: TypeNode,
    /// Directives.
    pub directives: Vec<Directive>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `InputValueDefinition`.
#[derive(Clone, Debug, PartialEq)]
pub struct InputValueDefinition {
    /// The description.
    pub description: Option<String>,
    /// The name.
    pub name: Name,
    /// The declared type.
    pub type_node: TypeNode,
    /// The default value.
    pub default_value: Option<Value>,
    /// Directives.
    pub directives: Vec<Directive>,
    /// Source location.
    pub loc: Option<Loc>,
}

/// `DirectiveDefinition`, or an `extend directive` extension.
#[derive(Clone, Debug, PartialEq)]
pub struct DirectiveDefinition {
    /// True for `extend directive`.
    pub is_extension: bool,
    /// The description.
    pub description: Option<String>,
    /// The directive name, without `@`.
    pub name: Name,
    /// Arguments.
    pub arguments: Vec<InputValueDefinition>,
    /// True for `repeatable`.
    pub repeatable: bool,
    /// The locations.
    pub locations: Vec<Name>,
    /// Source location.
    pub loc: Option<Loc>,
}
