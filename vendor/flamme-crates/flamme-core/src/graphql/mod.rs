//! The GraphQL front end: a graphql-js-compatible lexer, parser and printer.
//!
//! `graphql/mod.rs` fixes the public surface; [`lexer`], [`parser`] and [`printer`]
//! hold the implementation. The parser reproduces graphql-js syntax-error messages
//! (`Syntax Error: Expected Name, found "}".`) and UTF-16 locations, because a
//! document that fails to parse is reported with the oracle's exact text.

pub mod ast;
pub mod lexer;
pub mod parser;
pub mod printer;
pub mod visit;

pub use ast::{
    Argument, Definition, Directive, Document, Field, FragmentDefinition, FragmentSpread,
    InlineFragment, Loc, Name, NamedType, NonNullType, ObjectField, OperationDefinition,
    OperationType, SchemaDocument, Selection, SelectionSet, TypeDefinition, TypeNode, TypeSystemDefinition,
    Value, Variable, VariableDefinition,
};

/// A GraphQL syntax error, shaped like the `GraphQLError` the oracle reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxError {
    /// `error.message`: `Syntax Error: …` without any location suffix.
    pub message: String,
    /// 1-based line of the offending token.
    pub line: u32,
    /// 1-based column of the offending token.
    pub column: u32,
    /// The offending range in UTF-16 units, when the parser has one.
    pub loc: Option<Loc>,
}

impl SyntaxError {
    /// Builds a syntax error.
    pub fn new(message: impl Into<String>, line: u32, column: u32, loc: Option<Loc>) -> Self {
        Self { message: message.into(), line, column, loc }
    }
}

impl std::fmt::Display for SyntaxError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SyntaxError {}

/// Parses an executable document (`parse` in graphql-js).
pub fn parse_document(source: &str) -> Result<Document, SyntaxError> {
    parser::parse_document(source)
}

/// Parses an executable document from cooked UTF-16 code units.
///
/// The template cooker can produce a lone surrogate, which a Rust `String` cannot
/// hold; the lexer reads code units anyway, so such a document is parsed from them
/// and fails to lex exactly where the oracle's does. `text` is the lossy decode of
/// `units`, used only for the parser's depth guard.
pub fn parse_document_units(units: &[u16], text: &str) -> Result<Document, SyntaxError> {
    parser::parse_document_units(units, text)
}

/// Parses a type system document (`parse` in graphql-js, used by `buildSchema`).
pub fn parse_type_system_document(source: &str) -> Result<SchemaDocument, SyntaxError> {
    parser::parse_type_system_document(source)
}

/// Parses one type reference (`parseType` in graphql-js).
pub fn parse_type(source: &str) -> Result<TypeNode, SyntaxError> {
    parser::parse_type(source)
}

/// Prints a document exactly as graphql-js's `print` does.
pub fn print_document(document: &Document) -> String {
    printer::print_document(document)
}

/// Prints one value exactly as graphql-js's `print` does.
pub fn print_value(value: &Value) -> String {
    printer::print_value(value)
}

/// Prints one type reference exactly as graphql-js's `print` does.
pub fn print_type_node(node: &TypeNode) -> String {
    printer::print_type_node(node)
}
