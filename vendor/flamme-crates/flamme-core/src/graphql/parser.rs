//! GraphQL parser, a port of `graphql/language/parser.js` (graphql 16.14.2).
//!
//! Transliterated from the JavaScript the oracle runs: the same grammar, the same
//! error messages (including punctuation and quoting), and the same node locations.
//! A node's `loc` is `(start of the token the parse began at, end of the last token
//! consumed)`, exactly what `Parser.node(startToken, node)` builds from
//! `this._lexer.token` and `this._lexer.lastToken`, in UTF-16 code units.
//!
//! graphql-js 16 has one `parse` for both grammars; the frozen Rust API splits it in
//! two, so [`parse_document`] keeps the executable definitions and rejects a type
//! system definition with `Unexpected Name "type".`, while
//! [`parse_type_system_document`] keeps the type system definitions and rejects an
//! executable one.

use super::ast::{
    Argument, Definition, Directive, DirectiveDefinition, Document, EnumTypeDefinition,
    EnumValueDefinition, Field, FieldDefinition, FragmentDefinition, FragmentSpread, InlineFragment,
    InputObjectTypeDefinition, InputValueDefinition, InterfaceTypeDefinition, ListType, Loc, Name,
    NamedType, NonNullType, ObjectField, ObjectTypeDefinition, OperationDefinition, OperationType,
    OperationTypeDefinition, ScalarTypeDefinition, SchemaDefinition, SchemaDocument, Selection,
    SelectionSet, TypeDefinition, TypeNode, TypeSystemDefinition, UnionTypeDefinition, Value,
    Variable, VariableDefinition,
};
use super::lexer::{syntax_error, Lexer, Token, TokenKind};
use super::SyntaxError;
use crate::offsets::Offset;

/// Which half of `parseDefinition` a parser accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// Operations, fragments and values: `parse_document`.
    Executable,
    /// Schema, type, directive definitions and extensions: `parse_type_system_document`.
    TypeSystem,
}

/// The union of both grammars' definitions, so one `parse_definition` can serve both
/// entry points; each entry point keeps the half its AST can hold.
enum AnyDefinition {
    /// An operation or fragment definition.
    Executable(Definition),
    /// A schema, type or directive definition.
    TypeSystem(TypeSystemDefinition),
}

/// Parses an executable document (`parse` in graphql-js, executable definitions only).
pub fn parse_document(source: &str) -> Result<Document, SyntaxError> {
    guard_nesting(source)?;
    parse_executable(Parser::new(source, Mode::Executable))
}

/// Parses an executable document from cooked UTF-16 code units.
///
/// A `graphql` template that escapes a lone surrogate (`\uD83D`) cooks to a code unit
/// no Rust `String` can hold, and the oracle's `parse` sees that unit. `text` is the
/// same sequence decoded lossily, used only by the depth guard, which looks for
/// nesting outside strings and comments (a replacement character is neither).
pub fn parse_document_units(units: &[u16], text: &str) -> Result<Document, SyntaxError> {
    guard_nesting(text)?;
    parse_executable(Parser::new_units(units, Mode::Executable))
}

/// The `parse` loop shared by both entry points: definitions until end of file.
fn parse_executable(mut parser: Parser) -> Result<Document, SyntaxError> {
    parser.expect_token(TokenKind::Sof)?;
    let mut definitions: Vec<Definition> = Vec::new();
    loop {
        match parser.parse_definition()? {
            AnyDefinition::Executable(definition) => definitions.push(definition),
            AnyDefinition::TypeSystem(_) => {
                unreachable!("type system definitions are rejected in executable mode")
            }
        }
        if parser.expect_optional_token(TokenKind::Eof)? {
            break;
        }
    }
    Ok(Document { definitions })
}

/// Parses a type system document (`parse` in graphql-js, type system definitions only).
pub fn parse_type_system_document(source: &str) -> Result<SchemaDocument, SyntaxError> {
    guard_nesting(source)?;
    let mut parser = Parser::new(source, Mode::TypeSystem);
    parser.expect_token(TokenKind::Sof)?;
    let mut definitions: Vec<TypeSystemDefinition> = Vec::new();
    loop {
        match parser.parse_definition()? {
            AnyDefinition::TypeSystem(definition) => definitions.push(definition),
            AnyDefinition::Executable(_) => {
                unreachable!("executable definitions are rejected in type system mode")
            }
        }
        if parser.expect_optional_token(TokenKind::Eof)? {
            break;
        }
    }
    Ok(SchemaDocument { definitions })
}

/// Parses one type reference (`parseType` in graphql-js).
pub fn parse_type(source: &str) -> Result<TypeNode, SyntaxError> {
    guard_nesting(source)?;
    let mut parser = Parser::new(source, Mode::TypeSystem);
    parser.expect_token(TokenKind::Sof)?;
    let type_node = parser.parse_type_reference()?;
    parser.expect_token(TokenKind::Eof)?;
    Ok(type_node)
}

/// Refuses a source whose lexical nesting passes the parser's ceiling.
///
/// The parser has to recurse before any tree exists to measure, so the one bound it
/// can check first is [`crate::depth::MAX_PARSE_NESTING`], over the raw text: the
/// scan is iterative and skips strings and comments, so a brace inside a string
/// literal is not nesting. A source past the ceiling is a syntax error, reported at
/// the character that crossed it, and no recursive call is ever made on it. The
/// limit a *document* is held to (`FLM1049`) is lower and is enforced on the parsed
/// tree by the session, which is where the diagnostic can name the document.
fn guard_nesting(source: &str) -> Result<(), SyntaxError> {
    let Some((_, byte)) = crate::depth::scan_nesting(source, crate::depth::MAX_PARSE_NESTING)
    else {
        return Ok(());
    };
    let position = crate::offsets::SourceText::new(source).to_utf16(byte);
    let body: Vec<u16> = source.encode_utf16().collect();
    Err(syntax_error(
        &body,
        position,
        format!(
            "the source nests deeper than {} levels; the compiler cannot parse it.",
            crate::depth::MAX_PARSE_NESTING
        ),
    ))
}

/// `Parser` in `language/parser.js`.
struct Parser {
    /// The lexer.
    lexer: Lexer,
    /// Which half of `parseDefinition` this parser accepts.
    mode: Mode,
}

impl Parser {
    /// `new Parser(source)`; the options object is always empty in this port.
    fn new(source: &str, mode: Mode) -> Self {
        Self { lexer: Lexer::new(source), mode }
    }

    /// `new Parser(source)` over code units the caller already holds (see
    /// [`parse_document_units`]).
    fn new_units(units: &[u16], mode: Mode) -> Self {
        Self { lexer: Lexer::from_units(units.to_vec()), mode }
    }

    /// `syntaxError(this._lexer.source, position, description)`.
    fn error(&self, position: Offset, description: impl Into<String>) -> SyntaxError {
        syntax_error(self.lexer.body(), position, description)
    }

    /// `this.unexpected(atToken)`: `Unexpected <token>.` at the token's start.
    fn unexpected(&self, token: &Token) -> SyntaxError {
        self.error(token.start, format!("Unexpected {}.", token.desc()))
    }

    /// `this.unexpected()`: the same, at the current token.
    fn unexpected_current(&self) -> SyntaxError {
        self.unexpected(self.lexer.token())
    }

    /// `this.node(startToken, node).loc`: from `start` to the last consumed token.
    fn loc(&self, start: Offset) -> Option<Loc> {
        Some(Loc::new(start, self.lexer.last_token().end))
    }

    /// `this.peek(kind)`.
    fn peek(&self, kind: TokenKind) -> bool {
        self.lexer.token().kind == kind
    }

    /// `this.expectToken(kind)`.
    fn expect_token(&mut self, kind: TokenKind) -> Result<Token, SyntaxError> {
        let token = self.lexer.token().clone();
        if token.kind == kind {
            self.lexer.advance()?;
            return Ok(token);
        }
        Err(self.error(token.start, format!("Expected {}, found {}.", kind.desc(), token.desc())))
    }

    /// `this.expectOptionalToken(kind)`.
    fn expect_optional_token(&mut self, kind: TokenKind) -> Result<bool, SyntaxError> {
        if self.lexer.token().kind == kind {
            self.lexer.advance()?;
            return Ok(true);
        }
        Ok(false)
    }

    /// `this.expectKeyword(value)`.
    fn expect_keyword(&mut self, value: &str) -> Result<(), SyntaxError> {
        let token = self.lexer.token().clone();
        if token.kind == TokenKind::Name && token.value.as_deref() == Some(value) {
            self.lexer.advance()?;
            return Ok(());
        }
        Err(self.error(token.start, format!("Expected \"{value}\", found {}.", token.desc())))
    }

    /// `this.expectOptionalKeyword(value)`.
    fn expect_optional_keyword(&mut self, value: &str) -> Result<bool, SyntaxError> {
        let token = self.lexer.token().clone();
        if token.kind == TokenKind::Name && token.value.as_deref() == Some(value) {
            self.lexer.advance()?;
            return Ok(true);
        }
        Ok(false)
    }

    /// `this.any(openKind, parseFn, closeKind)`.
    fn any<T>(
        &mut self,
        open: TokenKind,
        parse: impl Fn(&mut Self) -> Result<T, SyntaxError>,
        close: TokenKind,
    ) -> Result<Vec<T>, SyntaxError> {
        self.expect_token(open)?;
        let mut nodes = Vec::new();
        while !self.expect_optional_token(close)? {
            nodes.push(parse(self)?);
        }
        Ok(nodes)
    }

    /// `this.optionalMany(openKind, parseFn, closeKind)`.
    fn optional_many<T>(
        &mut self,
        open: TokenKind,
        parse: impl Fn(&mut Self) -> Result<T, SyntaxError>,
        close: TokenKind,
    ) -> Result<Vec<T>, SyntaxError> {
        if self.expect_optional_token(open)? {
            let mut nodes = Vec::new();
            loop {
                nodes.push(parse(self)?);
                if self.expect_optional_token(close)? {
                    break;
                }
            }
            return Ok(nodes);
        }
        Ok(Vec::new())
    }

    /// `this.many(openKind, parseFn, closeKind)`.
    fn many<T>(
        &mut self,
        open: TokenKind,
        parse: impl Fn(&mut Self) -> Result<T, SyntaxError>,
        close: TokenKind,
    ) -> Result<Vec<T>, SyntaxError> {
        self.expect_token(open)?;
        let mut nodes = Vec::new();
        loop {
            nodes.push(parse(self)?);
            if self.expect_optional_token(close)? {
                break;
            }
        }
        Ok(nodes)
    }

    /// `this.delimitedMany(delimiterKind, parseFn)`.
    fn delimited_many<T>(
        &mut self,
        delimiter: TokenKind,
        parse: impl Fn(&mut Self) -> Result<T, SyntaxError>,
    ) -> Result<Vec<T>, SyntaxError> {
        self.expect_optional_token(delimiter)?;
        let mut nodes = Vec::new();
        loop {
            nodes.push(parse(self)?);
            if !self.expect_optional_token(delimiter)? {
                break;
            }
        }
        Ok(nodes)
    }

    // -----------------------------------------------------------------------
    // Document
    // -----------------------------------------------------------------------

    /// `this.parseDefinition()`: the keywords of this parser's mode, then the
    /// description checks, in the order graphql-js checks them.
    fn parse_definition(&mut self) -> Result<AnyDefinition, SyntaxError> {
        if self.peek(TokenKind::BraceL) {
            let brace_token = self.lexer.token().clone();
            let definition = self.parse_operation_definition()?;
            if self.mode == Mode::Executable {
                return Ok(AnyDefinition::Executable(Definition::Operation(definition)));
            }
            // A shorthand query has no place in the type system grammar. The `{` is the
            // offending token, reported after the selection set parses, so a malformed
            // one keeps graphql-js's message.
            return Err(self.unexpected(&brace_token));
        }

        // Many definitions begin with a description and require a lookahead.
        let has_description = self.peek_description();
        let keyword_token =
            if has_description { self.lexer.lookahead()? } else { self.lexer.token().clone() };

        if has_description && keyword_token.kind == TokenKind::BraceL {
            return Err(self.error(
                self.lexer.token().start,
                "Unexpected description, descriptions are not supported on shorthand queries.",
            ));
        }

        if keyword_token.kind == TokenKind::Name {
            let value = keyword_token.value.clone().unwrap_or_default();

            match self.mode {
                Mode::TypeSystem => {
                    let definition = match value.as_str() {
                        "schema" => {
                            Some(TypeSystemDefinition::Schema(self.parse_schema_definition()?))
                        }
                        "scalar" => Some(TypeSystemDefinition::Type(TypeDefinition::Scalar(
                            self.parse_scalar_type_definition()?,
                        ))),
                        "type" => Some(TypeSystemDefinition::Type(TypeDefinition::Object(
                            self.parse_object_type_definition()?,
                        ))),
                        "interface" => Some(TypeSystemDefinition::Type(TypeDefinition::Interface(
                            self.parse_interface_type_definition()?,
                        ))),
                        "union" => Some(TypeSystemDefinition::Type(TypeDefinition::Union(
                            self.parse_union_type_definition()?,
                        ))),
                        "enum" => Some(TypeSystemDefinition::Type(TypeDefinition::Enum(
                            self.parse_enum_type_definition()?,
                        ))),
                        "input" => Some(TypeSystemDefinition::Type(TypeDefinition::InputObject(
                            self.parse_input_object_type_definition()?,
                        ))),
                        "directive" => Some(TypeSystemDefinition::Directive(
                            self.parse_directive_definition()?,
                        )),
                        // An executable definition parses here in graphql-js, which this
                        // AST cannot hold; parsing it first keeps a malformed one's
                        // message identical, and the keyword is what gets rejected.
                        "query" | "mutation" | "subscription" => {
                            self.parse_operation_definition()?;
                            return Err(self.unexpected(&keyword_token));
                        }
                        "fragment" => {
                            self.parse_fragment_definition()?;
                            return Err(self.unexpected(&keyword_token));
                        }
                        _ => None,
                    };
                    if let Some(definition) = definition {
                        return Ok(AnyDefinition::TypeSystem(definition));
                    }
                }
                Mode::Executable => match value.as_str() {
                    "query" | "mutation" | "subscription" => {
                        let definition = self.parse_operation_definition()?;
                        return Ok(AnyDefinition::Executable(Definition::Operation(definition)));
                    }
                    "fragment" => {
                        let definition = self.parse_fragment_definition()?;
                        return Ok(AnyDefinition::Executable(Definition::Fragment(definition)));
                    }
                    // graphql-js parses a type system definition here, and so does this
                    // port: a document holding one is rejected at extraction (`FLM1011`)
                    // with the oracle's message and location, which is only possible if
                    // the definition reaches `Document::definitions` and is counted.
                    "schema" => {
                        let definition = TypeSystemDefinition::Schema(self.parse_schema_definition()?);
                        return Ok(AnyDefinition::Executable(Definition::TypeSystem(definition)));
                    }
                    "scalar" => {
                        let definition = TypeSystemDefinition::Type(TypeDefinition::Scalar(
                            self.parse_scalar_type_definition()?,
                        ));
                        return Ok(AnyDefinition::Executable(Definition::TypeSystem(definition)));
                    }
                    "type" => {
                        let definition = TypeSystemDefinition::Type(TypeDefinition::Object(
                            self.parse_object_type_definition()?,
                        ));
                        return Ok(AnyDefinition::Executable(Definition::TypeSystem(definition)));
                    }
                    "interface" => {
                        let definition = TypeSystemDefinition::Type(TypeDefinition::Interface(
                            self.parse_interface_type_definition()?,
                        ));
                        return Ok(AnyDefinition::Executable(Definition::TypeSystem(definition)));
                    }
                    "union" => {
                        let definition = TypeSystemDefinition::Type(TypeDefinition::Union(
                            self.parse_union_type_definition()?,
                        ));
                        return Ok(AnyDefinition::Executable(Definition::TypeSystem(definition)));
                    }
                    "enum" => {
                        let definition = TypeSystemDefinition::Type(TypeDefinition::Enum(
                            self.parse_enum_type_definition()?,
                        ));
                        return Ok(AnyDefinition::Executable(Definition::TypeSystem(definition)));
                    }
                    "input" => {
                        let definition = TypeSystemDefinition::Type(TypeDefinition::InputObject(
                            self.parse_input_object_type_definition()?,
                        ));
                        return Ok(AnyDefinition::Executable(Definition::TypeSystem(definition)));
                    }
                    "directive" => {
                        let definition = TypeSystemDefinition::Directive(
                            self.parse_directive_definition()?,
                        );
                        return Ok(AnyDefinition::Executable(Definition::TypeSystem(definition)));
                    }
                    _ => {}
                },
            }

            if has_description {
                return Err(self.error(
                    self.lexer.token().start,
                    "Unexpected description, only GraphQL definitions support descriptions.",
                ));
            }

            if self.mode == Mode::TypeSystem && value == "extend" {
                return self.parse_type_system_extension();
            }

            if self.mode == Mode::Executable && value == "extend" {
                // graphql-js reads the extension keyword and parses an extension here.
                // A malformed one is reported at that keyword by
                // `parseTypeSystemExtension`, and a well-formed one is a type system
                // definition the extraction rejects, exactly like the oracle: the
                // document it belongs to never becomes an artifact.
                let extension = self.parse_type_system_extension()?;
                let AnyDefinition::TypeSystem(definition) = extension else {
                    unreachable!("an extension is a type system definition")
                };
                return Ok(AnyDefinition::Executable(Definition::TypeSystem(definition)));
            }
        }

        Err(self.unexpected(&keyword_token))
    }

    // -----------------------------------------------------------------------
    // Operations
    // -----------------------------------------------------------------------

    /// `this.parseOperationDefinition()`.
    fn parse_operation_definition(&mut self) -> Result<OperationDefinition, SyntaxError> {
        let start = self.lexer.token().start;

        if self.peek(TokenKind::BraceL) {
            let selection_set = self.parse_selection_set()?;
            return Ok(OperationDefinition {
                description: None,
                operation: OperationType::Query,
                name: None,
                variable_definitions: Vec::new(),
                directives: Vec::new(),
                selection_set,
                loc: self.loc(start),
            });
        }

        // `description: this.parseDescription()`: this build of graphql-js parses one
        // on an operation definition and `print` emits it, so it is kept.
        let description = self.parse_description_printed()?;
        let operation = self.parse_operation_type()?;
        let name = if self.peek(TokenKind::Name) { Some(self.parse_name()?) } else { None };
        let variable_definitions = self.parse_variable_definitions()?;
        let directives = self.parse_directives(false)?;
        let selection_set = self.parse_selection_set()?;

        Ok(OperationDefinition {
            description,
            operation,
            name,
            variable_definitions,
            directives,
            selection_set,
            loc: self.loc(start),
        })
    }

    /// `this.parseOperationType()`.
    fn parse_operation_type(&mut self) -> Result<OperationType, SyntaxError> {
        let operation_token = self.expect_token(TokenKind::Name)?;
        match operation_token.value.as_deref() {
            Some("query") => Ok(OperationType::Query),
            Some("mutation") => Ok(OperationType::Mutation),
            Some("subscription") => Ok(OperationType::Subscription),
            _ => Err(self.unexpected(&operation_token)),
        }
    }

    /// `this.parseVariableDefinitions()`.
    fn parse_variable_definitions(&mut self) -> Result<Vec<VariableDefinition>, SyntaxError> {
        self.optional_many(TokenKind::ParenL, Self::parse_variable_definition, TokenKind::ParenR)
    }

    /// `this.parseVariableDefinition()`.
    fn parse_variable_definition(&mut self) -> Result<VariableDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description_printed()?;
        let variable = self.parse_variable()?;
        self.expect_token(TokenKind::Colon)?;
        let type_node = self.parse_type_reference()?;
        let default_value = if self.expect_optional_token(TokenKind::Equals)? {
            Some(self.parse_const_value_literal()?)
        } else {
            None
        };
        let directives = self.parse_const_directives()?;
        Ok(VariableDefinition {
            description,
            variable,
            type_node,
            default_value,
            directives,
            loc: self.loc(start),
        })
    }

    /// `this.parseVariable()`.
    fn parse_variable(&mut self) -> Result<Variable, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_token(TokenKind::Dollar)?;
        let name = self.parse_name()?;
        Ok(Variable { name, loc: self.loc(start) })
    }

    /// `this.parseSelectionSet()`.
    fn parse_selection_set(&mut self) -> Result<SelectionSet, SyntaxError> {
        let start = self.lexer.token().start;
        let selections = self.many(TokenKind::BraceL, Self::parse_selection, TokenKind::BraceR)?;
        Ok(SelectionSet { selections, loc: self.loc(start) })
    }

    /// `this.parseSelection()`.
    fn parse_selection(&mut self) -> Result<Selection, SyntaxError> {
        if self.peek(TokenKind::Spread) { self.parse_fragment() } else { self.parse_field() }
    }

    /// `this.parseField()`.
    fn parse_field(&mut self) -> Result<Selection, SyntaxError> {
        let start = self.lexer.token().start;
        let name_or_alias = self.parse_name()?;
        let (alias, name) = if self.expect_optional_token(TokenKind::Colon)? {
            (Some(name_or_alias), self.parse_name()?)
        } else {
            (None, name_or_alias)
        };
        let arguments = self.parse_arguments(false)?;
        let directives = self.parse_directives(false)?;
        let selection_set =
            if self.peek(TokenKind::BraceL) { Some(self.parse_selection_set()?) } else { None };
        Ok(Selection::Field(Field {
            alias,
            name,
            arguments,
            directives,
            selection_set,
            loc: self.loc(start),
        }))
    }

    /// `this.parseArguments(isConst)`.
    fn parse_arguments(&mut self, is_const: bool) -> Result<Vec<Argument>, SyntaxError> {
        if is_const {
            self.optional_many(TokenKind::ParenL, Self::parse_const_argument, TokenKind::ParenR)
        } else {
            self.optional_many(TokenKind::ParenL, Self::parse_argument, TokenKind::ParenR)
        }
    }

    /// `this.parseArgument(false)`.
    fn parse_argument(&mut self) -> Result<Argument, SyntaxError> {
        self.parse_argument_with(false)
    }

    /// `this.parseConstArgument()`.
    fn parse_const_argument(&mut self) -> Result<Argument, SyntaxError> {
        self.parse_argument_with(true)
    }

    /// `this.parseArgument(isConst)` with the flag spelled out.
    fn parse_argument_with(&mut self, is_const: bool) -> Result<Argument, SyntaxError> {
        let start = self.lexer.token().start;
        let name = self.parse_name()?;
        self.expect_token(TokenKind::Colon)?;
        let value = self.parse_value_literal(is_const)?;
        Ok(Argument { name, value, loc: self.loc(start) })
    }

    // -----------------------------------------------------------------------
    // Fragments
    // -----------------------------------------------------------------------

    /// `this.parseFragment()`: both `FragmentSpread` and `InlineFragment`.
    fn parse_fragment(&mut self) -> Result<Selection, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_token(TokenKind::Spread)?;
        let has_type_condition = self.expect_optional_keyword("on")?;

        if !has_type_condition && self.peek(TokenKind::Name) {
            let name = self.parse_fragment_name()?;
            let directives = self.parse_directives(false)?;
            return Ok(Selection::FragmentSpread(FragmentSpread {
                name,
                directives,
                loc: self.loc(start),
            }));
        }

        let type_condition = if has_type_condition { Some(self.parse_named_type()?) } else { None };
        let directives = self.parse_directives(false)?;
        let selection_set = self.parse_selection_set()?;
        Ok(Selection::InlineFragment(InlineFragment {
            type_condition,
            directives,
            selection_set,
            loc: self.loc(start),
        }))
    }

    /// `this.parseFragmentDefinition()`; `allowLegacyFragmentVariables` is off.
    fn parse_fragment_definition(&mut self) -> Result<FragmentDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description_printed()?;
        self.expect_keyword("fragment")?;
        let name = self.parse_fragment_name()?;
        self.expect_keyword("on")?;
        let type_condition = self.parse_named_type()?;
        let directives = self.parse_directives(false)?;
        let selection_set = self.parse_selection_set()?;
        Ok(FragmentDefinition {
            description,
            name,
            variable_definitions: Vec::new(),
            type_condition,
            directives,
            selection_set,
            loc: self.loc(start),
        })
    }

    /// `this.parseFragmentName()`: a `Name` but not `on`.
    fn parse_fragment_name(&mut self) -> Result<Name, SyntaxError> {
        if self.lexer.token().value.as_deref() == Some("on") {
            return Err(self.unexpected_current());
        }
        self.parse_name()
    }

    // -----------------------------------------------------------------------
    // Values
    // -----------------------------------------------------------------------

    /// `this.parseValueLiteral(isConst)`.
    fn parse_value_literal(&mut self, is_const: bool) -> Result<Value, SyntaxError> {
        let token = self.lexer.token().clone();

        match token.kind {
            TokenKind::BracketL => self.parse_list(is_const),
            TokenKind::BraceL => self.parse_object(is_const),
            TokenKind::Int => {
                self.lexer.advance()?;
                Ok(Value::IntValue {
                    value: token.value.unwrap_or_default(),
                    loc: self.loc(token.start),
                })
            }
            TokenKind::Float => {
                self.lexer.advance()?;
                Ok(Value::FloatValue {
                    value: token.value.unwrap_or_default(),
                    loc: self.loc(token.start),
                })
            }
            TokenKind::Str | TokenKind::BlockString => self.parse_string_literal(),
            TokenKind::Name => {
                self.lexer.advance()?;
                let value = token.value.clone().unwrap_or_default();
                Ok(match value.as_str() {
                    "true" => Value::BooleanValue { value: true, loc: self.loc(token.start) },
                    "false" => Value::BooleanValue { value: false, loc: self.loc(token.start) },
                    "null" => Value::NullValue { loc: self.loc(token.start) },
                    _ => Value::EnumValue { value, loc: self.loc(token.start) },
                })
            }
            TokenKind::Dollar => {
                if is_const {
                    self.expect_token(TokenKind::Dollar)?;
                    if self.lexer.token().kind == TokenKind::Name {
                        let var_name = self.lexer.token().value.clone().unwrap_or_default();
                        return Err(self.error(
                            token.start,
                            format!("Unexpected variable \"${var_name}\" in constant value."),
                        ));
                    }
                    return Err(self.unexpected(&token));
                }
                Ok(Value::Variable(self.parse_variable()?))
            }
            _ => Err(self.unexpected_current()),
        }
    }

    /// `this.parseConstValueLiteral()`.
    fn parse_const_value_literal(&mut self) -> Result<Value, SyntaxError> {
        self.parse_value_literal(true)
    }

    /// `this.parseStringLiteral()`.
    fn parse_string_literal(&mut self) -> Result<Value, SyntaxError> {
        let token = self.lexer.token().clone();
        self.lexer.advance()?;
        Ok(Value::StringValue {
            value: token.value.unwrap_or_default(),
            block: token.kind == TokenKind::BlockString,
            loc: self.loc(token.start),
        })
    }

    /// `this.parseList(isConst)`.
    fn parse_list(&mut self, is_const: bool) -> Result<Value, SyntaxError> {
        let start = self.lexer.token().start;
        let values = self.any(
            TokenKind::BracketL,
            |parser| parser.parse_value_literal(is_const),
            TokenKind::BracketR,
        )?;
        Ok(Value::ListValue { values, loc: self.loc(start) })
    }

    /// `this.parseObject(isConst)`.
    fn parse_object(&mut self, is_const: bool) -> Result<Value, SyntaxError> {
        let start = self.lexer.token().start;
        let fields = self.any(
            TokenKind::BraceL,
            |parser| parser.parse_object_field(is_const),
            TokenKind::BraceR,
        )?;
        Ok(Value::ObjectValue { fields, loc: self.loc(start) })
    }

    /// `this.parseObjectField(isConst)`.
    fn parse_object_field(&mut self, is_const: bool) -> Result<ObjectField, SyntaxError> {
        let start = self.lexer.token().start;
        let name = self.parse_name()?;
        self.expect_token(TokenKind::Colon)?;
        let value = self.parse_value_literal(is_const)?;
        Ok(ObjectField { name, value, loc: self.loc(start) })
    }

    // -----------------------------------------------------------------------
    // Directives
    // -----------------------------------------------------------------------

    /// `this.parseDirectives(isConst)`.
    fn parse_directives(&mut self, is_const: bool) -> Result<Vec<Directive>, SyntaxError> {
        let mut directives = Vec::new();
        while self.peek(TokenKind::At) {
            directives.push(self.parse_directive(is_const)?);
        }
        Ok(directives)
    }

    /// `this.parseConstDirectives()`.
    fn parse_const_directives(&mut self) -> Result<Vec<Directive>, SyntaxError> {
        self.parse_directives(true)
    }

    /// `this.parseDirective(isConst)`.
    fn parse_directive(&mut self, is_const: bool) -> Result<Directive, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_token(TokenKind::At)?;
        let name = self.parse_name()?;
        let arguments = self.parse_arguments(is_const)?;
        Ok(Directive { name, arguments, loc: self.loc(start) })
    }

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    /// `this.parseTypeReference()`.
    fn parse_type_reference(&mut self) -> Result<TypeNode, SyntaxError> {
        let start = self.lexer.token().start;
        let type_node = if self.expect_optional_token(TokenKind::BracketL)? {
            let inner_type = self.parse_type_reference()?;
            self.expect_token(TokenKind::BracketR)?;
            TypeNode::List(ListType { type_node: Box::new(inner_type), loc: self.loc(start) })
        } else {
            TypeNode::Named(self.parse_named_type()?)
        };

        if self.expect_optional_token(TokenKind::Bang)? {
            return Ok(TypeNode::NonNull(NonNullType {
                type_node: Box::new(type_node),
                loc: self.loc(start),
            }));
        }

        Ok(type_node)
    }

    /// `this.parseNamedType()`.
    fn parse_named_type(&mut self) -> Result<NamedType, SyntaxError> {
        let start = self.lexer.token().start;
        let name = self.parse_name()?;
        Ok(NamedType { name, loc: self.loc(start) })
    }

    /// `this.parseName()`.
    fn parse_name(&mut self) -> Result<Name, SyntaxError> {
        let token = self.expect_token(TokenKind::Name)?;
        Ok(Name { value: token.value.unwrap_or_default(), loc: self.loc(token.start) })
    }

    // -----------------------------------------------------------------------
    // Type system definitions
    // -----------------------------------------------------------------------

    /// `this.peekDescription()`.
    fn peek_description(&self) -> bool {
        self.peek(TokenKind::Str) || self.peek(TokenKind::BlockString)
    }

    /// `this.parseDescription()`: the description's decoded value, or `None`.
    fn parse_description(&mut self) -> Result<Option<String>, SyntaxError> {
        if self.peek_description() {
            return match self.parse_string_literal()? {
                Value::StringValue { value, .. } => Ok(Some(value)),
                _ => unreachable!("parseStringLiteral returns a StringValue"),
            };
        }
        Ok(None)
    }

    /// `this.parseDescription()` for an executable definition, in the form the
    /// printer emits: graphql-js keeps a `StringValue` node there and `print`
    /// stringifies it, so a block description prints as a block string and a plain
    /// one is quoted. The AST holds the printed text.
    fn parse_description_printed(&mut self) -> Result<Option<String>, SyntaxError> {
        if !self.peek_description() {
            return Ok(None);
        }
        let value = self.parse_string_literal()?;
        Ok(Some(crate::graphql::print_value(&value)))
    }

    /// `this.parseSchemaDefinition()`.
    fn parse_schema_definition(&mut self) -> Result<SchemaDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        self.expect_keyword("schema")?;
        let directives = self.parse_const_directives()?;
        let operation_types =
            self.many(TokenKind::BraceL, Self::parse_operation_type_definition, TokenKind::BraceR)?;
        Ok(SchemaDefinition {
            is_extension: false,
            description,
            directives,
            operation_types,
            loc: self.loc(start),
        })
    }

    /// `this.parseOperationTypeDefinition()`.
    fn parse_operation_type_definition(&mut self) -> Result<OperationTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let operation = self.parse_operation_type()?;
        self.expect_token(TokenKind::Colon)?;
        let type_name = self.parse_named_type()?.name;
        Ok(OperationTypeDefinition { operation, type_name, loc: self.loc(start) })
    }

    /// `this.parseScalarTypeDefinition()`.
    fn parse_scalar_type_definition(&mut self) -> Result<ScalarTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        self.expect_keyword("scalar")?;
        let name = self.parse_name()?;
        let directives = self.parse_const_directives()?;
        Ok(ScalarTypeDefinition {
            is_extension: false,
            description,
            name,
            directives,
            loc: self.loc(start),
        })
    }

    /// `this.parseObjectTypeDefinition()`.
    fn parse_object_type_definition(&mut self) -> Result<ObjectTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        self.expect_keyword("type")?;
        let name = self.parse_name()?;
        let interfaces = self.parse_implements_interfaces()?;
        let directives = self.parse_const_directives()?;
        let fields = self.parse_fields_definition()?;
        Ok(ObjectTypeDefinition {
            is_extension: false,
            description,
            name,
            interfaces,
            directives,
            fields,
            loc: self.loc(start),
        })
    }

    /// `this.parseImplementsInterfaces()`.
    fn parse_implements_interfaces(&mut self) -> Result<Vec<NamedType>, SyntaxError> {
        if self.expect_optional_keyword("implements")? {
            return self.delimited_many(TokenKind::Amp, Self::parse_named_type);
        }
        Ok(Vec::new())
    }

    /// `this.parseFieldsDefinition()`.
    fn parse_fields_definition(&mut self) -> Result<Vec<FieldDefinition>, SyntaxError> {
        self.optional_many(TokenKind::BraceL, Self::parse_field_definition, TokenKind::BraceR)
    }

    /// `this.parseFieldDefinition()`.
    fn parse_field_definition(&mut self) -> Result<FieldDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        let name = self.parse_name()?;
        let arguments = self.parse_argument_defs()?;
        self.expect_token(TokenKind::Colon)?;
        let type_node = self.parse_type_reference()?;
        let directives = self.parse_const_directives()?;
        Ok(FieldDefinition {
            description,
            name,
            arguments,
            type_node,
            directives,
            loc: self.loc(start),
        })
    }

    /// `this.parseArgumentDefs()`.
    fn parse_argument_defs(&mut self) -> Result<Vec<InputValueDefinition>, SyntaxError> {
        self.optional_many(TokenKind::ParenL, Self::parse_input_value_def, TokenKind::ParenR)
    }

    /// `this.parseInputValueDef()`.
    fn parse_input_value_def(&mut self) -> Result<InputValueDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        let name = self.parse_name()?;
        self.expect_token(TokenKind::Colon)?;
        let type_node = self.parse_type_reference()?;
        let default_value = if self.expect_optional_token(TokenKind::Equals)? {
            Some(self.parse_const_value_literal()?)
        } else {
            None
        };
        let directives = self.parse_const_directives()?;
        Ok(InputValueDefinition {
            description,
            name,
            type_node,
            default_value,
            directives,
            loc: self.loc(start),
        })
    }

    /// `this.parseInterfaceTypeDefinition()`.
    fn parse_interface_type_definition(&mut self) -> Result<InterfaceTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        self.expect_keyword("interface")?;
        let name = self.parse_name()?;
        let interfaces = self.parse_implements_interfaces()?;
        let directives = self.parse_const_directives()?;
        let fields = self.parse_fields_definition()?;
        Ok(InterfaceTypeDefinition {
            is_extension: false,
            description,
            name,
            interfaces,
            directives,
            fields,
            loc: self.loc(start),
        })
    }

    /// `this.parseUnionTypeDefinition()`.
    fn parse_union_type_definition(&mut self) -> Result<UnionTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        self.expect_keyword("union")?;
        let name = self.parse_name()?;
        let directives = self.parse_const_directives()?;
        let types = self.parse_union_member_types()?;
        Ok(UnionTypeDefinition {
            is_extension: false,
            description,
            name,
            directives,
            types,
            loc: self.loc(start),
        })
    }

    /// `this.parseUnionMemberTypes()`.
    fn parse_union_member_types(&mut self) -> Result<Vec<NamedType>, SyntaxError> {
        if self.expect_optional_token(TokenKind::Equals)? {
            return self.delimited_many(TokenKind::Pipe, Self::parse_named_type);
        }
        Ok(Vec::new())
    }

    /// `this.parseEnumTypeDefinition()`.
    fn parse_enum_type_definition(&mut self) -> Result<EnumTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        self.expect_keyword("enum")?;
        let name = self.parse_name()?;
        let directives = self.parse_const_directives()?;
        let values = self.parse_enum_values_definition()?;
        Ok(EnumTypeDefinition {
            is_extension: false,
            description,
            name,
            directives,
            values,
            loc: self.loc(start),
        })
    }

    /// `this.parseEnumValuesDefinition()`.
    fn parse_enum_values_definition(&mut self) -> Result<Vec<EnumValueDefinition>, SyntaxError> {
        self.optional_many(
            TokenKind::BraceL,
            Self::parse_enum_value_definition,
            TokenKind::BraceR,
        )
    }

    /// `this.parseEnumValueDefinition()`.
    fn parse_enum_value_definition(&mut self) -> Result<EnumValueDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        let name = self.parse_enum_value_name()?;
        let directives = self.parse_const_directives()?;
        Ok(EnumValueDefinition { description, name, directives, loc: self.loc(start) })
    }

    /// `this.parseEnumValueName()`: a `Name` but not `true`, `false` or `null`.
    fn parse_enum_value_name(&mut self) -> Result<Name, SyntaxError> {
        let token = self.lexer.token().clone();
        if matches!(token.value.as_deref(), Some("true") | Some("false") | Some("null")) {
            return Err(self.error(
                token.start,
                format!("{} is reserved and cannot be used for an enum value.", token.desc()),
            ));
        }
        self.parse_name()
    }

    /// `this.parseInputObjectTypeDefinition()`.
    fn parse_input_object_type_definition(
        &mut self,
    ) -> Result<InputObjectTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        self.expect_keyword("input")?;
        let name = self.parse_name()?;
        let directives = self.parse_const_directives()?;
        let fields = self.parse_input_fields_definition()?;
        Ok(InputObjectTypeDefinition {
            is_extension: false,
            description,
            name,
            directives,
            fields,
            loc: self.loc(start),
        })
    }

    /// `this.parseInputFieldsDefinition()`.
    fn parse_input_fields_definition(&mut self) -> Result<Vec<InputValueDefinition>, SyntaxError> {
        self.optional_many(TokenKind::BraceL, Self::parse_input_value_def, TokenKind::BraceR)
    }

    /// `this.parseTypeSystemExtension()`; `experimentalDirectivesOnDirectiveDefinitions`
    /// is off, so `extend directive` is not accepted.
    fn parse_type_system_extension(&mut self) -> Result<AnyDefinition, SyntaxError> {
        let keyword_token = self.lexer.lookahead()?;

        if keyword_token.kind == TokenKind::Name {
            let definition = match keyword_token.value.as_deref().unwrap_or_default() {
                "schema" => Some(TypeSystemDefinition::Schema(self.parse_schema_extension()?)),
                "scalar" => Some(TypeSystemDefinition::Type(TypeDefinition::Scalar(
                    self.parse_scalar_type_extension()?,
                ))),
                "type" => Some(TypeSystemDefinition::Type(TypeDefinition::Object(
                    self.parse_object_type_extension()?,
                ))),
                "interface" => Some(TypeSystemDefinition::Type(TypeDefinition::Interface(
                    self.parse_interface_type_extension()?,
                ))),
                "union" => Some(TypeSystemDefinition::Type(TypeDefinition::Union(
                    self.parse_union_type_extension()?,
                ))),
                "enum" => Some(TypeSystemDefinition::Type(TypeDefinition::Enum(
                    self.parse_enum_type_extension()?,
                ))),
                "input" => Some(TypeSystemDefinition::Type(TypeDefinition::InputObject(
                    self.parse_input_object_type_extension()?,
                ))),
                _ => None,
            };
            if let Some(definition) = definition {
                return Ok(AnyDefinition::TypeSystem(definition));
            }
        }

        Err(self.unexpected(&keyword_token))
    }

    /// `this.parseSchemaExtension()`.
    fn parse_schema_extension(&mut self) -> Result<SchemaDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_keyword("extend")?;
        self.expect_keyword("schema")?;
        let directives = self.parse_const_directives()?;
        let operation_types = self.optional_many(
            TokenKind::BraceL,
            Self::parse_operation_type_definition,
            TokenKind::BraceR,
        )?;
        if directives.is_empty() && operation_types.is_empty() {
            return Err(self.unexpected_current());
        }
        Ok(SchemaDefinition {
            is_extension: true,
            description: None,
            directives,
            operation_types,
            loc: self.loc(start),
        })
    }

    /// `this.parseScalarTypeExtension()`.
    fn parse_scalar_type_extension(&mut self) -> Result<ScalarTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_keyword("extend")?;
        self.expect_keyword("scalar")?;
        let name = self.parse_name()?;
        let directives = self.parse_const_directives()?;
        if directives.is_empty() {
            return Err(self.unexpected_current());
        }
        Ok(ScalarTypeDefinition {
            is_extension: true,
            description: None,
            name,
            directives,
            loc: self.loc(start),
        })
    }

    /// `this.parseObjectTypeExtension()`.
    fn parse_object_type_extension(&mut self) -> Result<ObjectTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_keyword("extend")?;
        self.expect_keyword("type")?;
        let name = self.parse_name()?;
        let interfaces = self.parse_implements_interfaces()?;
        let directives = self.parse_const_directives()?;
        let fields = self.parse_fields_definition()?;
        if interfaces.is_empty() && directives.is_empty() && fields.is_empty() {
            return Err(self.unexpected_current());
        }
        Ok(ObjectTypeDefinition {
            is_extension: true,
            description: None,
            name,
            interfaces,
            directives,
            fields,
            loc: self.loc(start),
        })
    }

    /// `this.parseInterfaceTypeExtension()`.
    fn parse_interface_type_extension(&mut self) -> Result<InterfaceTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_keyword("extend")?;
        self.expect_keyword("interface")?;
        let name = self.parse_name()?;
        let interfaces = self.parse_implements_interfaces()?;
        let directives = self.parse_const_directives()?;
        let fields = self.parse_fields_definition()?;
        if interfaces.is_empty() && directives.is_empty() && fields.is_empty() {
            return Err(self.unexpected_current());
        }
        Ok(InterfaceTypeDefinition {
            is_extension: true,
            description: None,
            name,
            interfaces,
            directives,
            fields,
            loc: self.loc(start),
        })
    }

    /// `this.parseUnionTypeExtension()`.
    fn parse_union_type_extension(&mut self) -> Result<UnionTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_keyword("extend")?;
        self.expect_keyword("union")?;
        let name = self.parse_name()?;
        let directives = self.parse_const_directives()?;
        let types = self.parse_union_member_types()?;
        if directives.is_empty() && types.is_empty() {
            return Err(self.unexpected_current());
        }
        Ok(UnionTypeDefinition {
            is_extension: true,
            description: None,
            name,
            directives,
            types,
            loc: self.loc(start),
        })
    }

    /// `this.parseEnumTypeExtension()`.
    fn parse_enum_type_extension(&mut self) -> Result<EnumTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_keyword("extend")?;
        self.expect_keyword("enum")?;
        let name = self.parse_name()?;
        let directives = self.parse_const_directives()?;
        let values = self.parse_enum_values_definition()?;
        if directives.is_empty() && values.is_empty() {
            return Err(self.unexpected_current());
        }
        Ok(EnumTypeDefinition {
            is_extension: true,
            description: None,
            name,
            directives,
            values,
            loc: self.loc(start),
        })
    }

    /// `this.parseInputObjectTypeExtension()`.
    fn parse_input_object_type_extension(
        &mut self,
    ) -> Result<InputObjectTypeDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        self.expect_keyword("extend")?;
        self.expect_keyword("input")?;
        let name = self.parse_name()?;
        let directives = self.parse_const_directives()?;
        let fields = self.parse_input_fields_definition()?;
        if directives.is_empty() && fields.is_empty() {
            return Err(self.unexpected_current());
        }
        Ok(InputObjectTypeDefinition {
            is_extension: true,
            description: None,
            name,
            directives,
            fields,
            loc: self.loc(start),
        })
    }

    /// `this.parseDirectiveDefinition()`; the directives-on-directive-definitions
    /// option is off, so `directives` is always empty.
    fn parse_directive_definition(&mut self) -> Result<DirectiveDefinition, SyntaxError> {
        let start = self.lexer.token().start;
        let description = self.parse_description()?;
        self.expect_keyword("directive")?;
        self.expect_token(TokenKind::At)?;
        let name = self.parse_name()?;
        let arguments = self.parse_argument_defs()?;
        let repeatable = self.expect_optional_keyword("repeatable")?;
        self.expect_keyword("on")?;
        let locations = self.parse_directive_locations()?;
        Ok(DirectiveDefinition {
            is_extension: false,
            description,
            name,
            arguments,
            repeatable,
            locations,
            loc: self.loc(start),
        })
    }

    /// `this.parseDirectiveLocations()`.
    fn parse_directive_locations(&mut self) -> Result<Vec<Name>, SyntaxError> {
        self.delimited_many(TokenKind::Pipe, Self::parse_directive_location)
    }

    /// `this.parseDirectiveLocation()`: a `Name` in `DirectiveLocation`.
    fn parse_directive_location(&mut self) -> Result<Name, SyntaxError> {
        let start = self.lexer.token().clone();
        let name = self.parse_name()?;
        if DIRECTIVE_LOCATIONS.contains(&name.value.as_str()) {
            return Ok(name);
        }
        Err(self.unexpected(&start))
    }
}

/// `DirectiveLocation` in `language/directiveLocation.js`: its keys decide whether
/// `parseDirectiveLocation` accepts a name.
const DIRECTIVE_LOCATIONS: [&str; 20] = [
    "QUERY",
    "MUTATION",
    "SUBSCRIPTION",
    "FIELD",
    "FRAGMENT_DEFINITION",
    "FRAGMENT_SPREAD",
    "INLINE_FRAGMENT",
    "VARIABLE_DEFINITION",
    "SCHEMA",
    "SCALAR",
    "OBJECT",
    "FIELD_DEFINITION",
    "ARGUMENT_DEFINITION",
    "INTERFACE",
    "UNION",
    "ENUM",
    "ENUM_VALUE",
    "INPUT_OBJECT",
    "INPUT_FIELD_DEFINITION",
    "DIRECTIVE_DEFINITION",
];
