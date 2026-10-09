//! GraphQL lexer, a port of `graphql/language/lexer.js` (graphql 16.14.2).
//!
//! Transliterated from the JavaScript the oracle runs, so the token kinds, the
//! 1-based line/column of every token and every lexical error message are the same
//! strings at the same positions. The source is held as UTF-16 code units, exactly
//! like a JavaScript string, which is what the AST contract means by an offset: a
//! document with an astral character in it lexes and reports columns the way
//! `charCodeAt` does, not the way Rust byte or `char` indices do.
//!
//! `readNextToken` is lazy: the parser only lexes a token when it advances over it,
//! so a document whose tail is malformed fails at the same token as graphql-js.

use super::ast::Loc;
use super::SyntaxError;
use crate::offsets::Offset;

/// `TokenKind` in `language/tokenKind.js`.
///
/// `Dot` is listed because `isPunctuatorTokenKind` lists it, but only the schema
/// coordinate lexer (which the port does not have) can produce one: `readNextToken`
/// returns `Spread` for `...` and rejects a lone `.`.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TokenKind {
    /// `<SOF>`
    Sof,
    /// `<EOF>`
    Eof,
    /// `!`
    Bang,
    /// `$`
    Dollar,
    /// `&`
    Amp,
    /// `(`
    ParenL,
    /// `)`
    ParenR,
    /// `.`
    Dot,
    /// `...`
    Spread,
    /// `:`
    Colon,
    /// `=`
    Equals,
    /// `@`
    At,
    /// `[`
    BracketL,
    /// `]`
    BracketR,
    /// `{`
    BraceL,
    /// `|`
    Pipe,
    /// `}`
    BraceR,
    /// `Name`
    Name,
    /// `Int`
    Int,
    /// `Float`
    Float,
    /// `String`
    Str,
    /// `BlockString`
    BlockString,
    /// `Comment`
    Comment,
}

impl TokenKind {
    /// The token kind's value, which is the string the kind is described with.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TokenKind::Sof => "<SOF>",
            TokenKind::Eof => "<EOF>",
            TokenKind::Bang => "!",
            TokenKind::Dollar => "$",
            TokenKind::Amp => "&",
            TokenKind::ParenL => "(",
            TokenKind::ParenR => ")",
            TokenKind::Dot => ".",
            TokenKind::Spread => "...",
            TokenKind::Colon => ":",
            TokenKind::Equals => "=",
            TokenKind::At => "@",
            TokenKind::BracketL => "[",
            TokenKind::BracketR => "]",
            TokenKind::BraceL => "{",
            TokenKind::Pipe => "|",
            TokenKind::BraceR => "}",
            TokenKind::Name => "Name",
            TokenKind::Int => "Int",
            TokenKind::Float => "Float",
            TokenKind::Str => "String",
            TokenKind::BlockString => "BlockString",
            TokenKind::Comment => "Comment",
        }
    }

    /// `isPunctuatorTokenKind`: the kinds described with quotes in an error message.
    pub(crate) fn is_punctuator(self) -> bool {
        matches!(
            self,
            TokenKind::Bang
                | TokenKind::Dollar
                | TokenKind::Amp
                | TokenKind::ParenL
                | TokenKind::ParenR
                | TokenKind::Dot
                | TokenKind::Spread
                | TokenKind::Colon
                | TokenKind::Equals
                | TokenKind::At
                | TokenKind::BracketL
                | TokenKind::BracketR
                | TokenKind::BraceL
                | TokenKind::Pipe
                | TokenKind::BraceR
        )
    }

    /// `getTokenKindDesc(kind)`: punctuators are quoted, other kinds are not.
    pub(crate) fn desc(self) -> String {
        if self.is_punctuator() {
            format!("\"{}\"", self.as_str())
        } else {
            self.as_str().to_string()
        }
    }
}

/// A lexical token (`ast.js` `Token`).
///
/// `line` and `column` are the token's own 1-based position, kept because graphql-js
/// keeps them on the token; the port's syntax errors derive their line and column
/// from the offending position with `getLocation`, the way `GraphQLError` does.
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct Token {
    /// The token's kind.
    pub(crate) kind: TokenKind,
    /// Start offset in UTF-16 code units.
    pub(crate) start: Offset,
    /// End offset in UTF-16 code units.
    pub(crate) end: Offset,
    /// 1-based line the token starts on.
    pub(crate) line: u32,
    /// 1-based column the token starts at.
    pub(crate) column: u32,
    /// The interpreted value: `None` for punctuators, `Some` for the rest.
    pub(crate) value: Option<String>,
}

impl Token {
    /// `getTokenDesc(token)`: the kind description plus the value, when it has one.
    pub(crate) fn desc(&self) -> String {
        match &self.value {
            Some(value) => format!("{} \"{value}\"", self.kind.desc()),
            None => self.kind.desc(),
        }
    }
}

/// `syntaxError(source, position, description)` from `error/syntaxError.js`.
///
/// graphql-js reports the position as `positions: [position]` and derives line and
/// column with `getLocation`; `loc` is that single position as an empty range,
/// because a syntax error has no node to point at.
pub(crate) fn syntax_error(
    body: &[u16],
    position: Offset,
    description: impl Into<String>,
) -> SyntaxError {
    let position = position.min(body.len() as u32);
    let (line, column) = get_location(body, position);
    SyntaxError::new(
        format!("Syntax Error: {}", description.into()),
        line,
        column,
        Some(Loc::new(position, position)),
    )
}

/// `getLocation(source, position)` from `language/location.js`: line terminators are
/// `\r\n`, `\n` and `\r`, and one whose index is at or past `position` is not counted.
pub(crate) fn get_location(body: &[u16], position: Offset) -> (u32, u32) {
    let length = body.len();
    let mut last_line_start: u32 = 0;
    let mut line: u32 = 1;
    let mut index = 0usize;
    while index < length {
        let code = body[index];
        let matched = if code == 0x000d {
            if index + 1 < length && body[index + 1] == 0x000a { 2 } else { 1 }
        } else if code == 0x000a {
            1
        } else {
            index += 1;
            continue;
        };
        if index as u32 >= position {
            break;
        }
        index += matched;
        last_line_start = index as u32;
        line += 1;
    }
    (line, position + 1 - last_line_start)
}

/// `Lexer` in `language/lexer.js`.
pub(crate) struct Lexer {
    /// The source text as UTF-16 code units, `source.body` in JavaScript.
    body: Vec<u16>,
    /// Every token lexed so far, starting with `<SOF>`; the `token.next` chain.
    tokens: Vec<Token>,
    /// Index of the current token, `lexer.token`.
    cursor: usize,
    /// Index of the most recent token `advance` returned, `lexer.lastToken`.
    last: usize,
    /// The 1-based line containing the scan position, `lexer.line`.
    line: u32,
    /// The offset the current line starts at, `lexer.lineStart`.
    line_start: Offset,
}

impl Lexer {
    /// `new Lexer(source)`.
    pub(crate) fn new(source: &str) -> Self {
        Self::from_units(source.encode_utf16().collect())
    }

    /// `new Lexer(source)` over code units the caller already holds.
    ///
    /// A cooked template can hold a lone surrogate (`\uD83D`), which no Rust `String`
    /// can represent. The lexer reads its body as code units only, so such a document
    /// is lexed from its units and reported the way JavaScript reports it
    /// (`Invalid character within String: U+D83D.`).
    pub(crate) fn from_units(body: Vec<u16>) -> Self {
        // `new Token(TokenKind.SOF, 0, 0, 0, 0)`: the start-of-file token has line
        // and column 0, because it is not derived from a character.
        let start_of_file =
            Token { kind: TokenKind::Sof, start: 0, end: 0, line: 0, column: 0, value: None };
        Self { body, tokens: vec![start_of_file], cursor: 0, last: 0, line: 1, line_start: 0 }
    }

    /// The source as UTF-16 code units, for building error locations.
    pub(crate) fn body(&self) -> &[u16] {
        &self.body
    }

    /// The current token, `lexer.token`.
    pub(crate) fn token(&self) -> &Token {
        &self.tokens[self.cursor]
    }

    /// The most recent token `advance` returned, `lexer.lastToken`.
    pub(crate) fn last_token(&self) -> &Token {
        &self.tokens[self.last]
    }

    /// `lexer.advance()`: moves to the next non-ignored token and returns it.
    pub(crate) fn advance(&mut self) -> Result<Token, SyntaxError> {
        self.last = self.cursor;
        self.cursor = self.lookahead_index()?;
        Ok(self.tokens[self.cursor].clone())
    }

    /// `lexer.lookahead()`: the next non-ignored token, without moving the cursor.
    pub(crate) fn lookahead(&mut self) -> Result<Token, SyntaxError> {
        let index = self.lookahead_index()?;
        Ok(self.tokens[index].clone())
    }

    /// Forms the token chain up to the next non-comment token and returns its index.
    /// Comments are lexed and skipped on the way, as `lookahead` does.
    fn lookahead_index(&mut self) -> Result<usize, SyntaxError> {
        let mut index = self.cursor;
        if self.tokens[index].kind != TokenKind::Eof {
            loop {
                if index + 1 < self.tokens.len() {
                    index += 1;
                } else {
                    let start = self.tokens[index].end;
                    let next = self.read_next_token(start)?;
                    self.tokens.push(next);
                    index += 1;
                }
                if self.tokens[index].kind != TokenKind::Comment {
                    break;
                }
            }
        }
        Ok(index)
    }

    /// `body.charCodeAt(position)`, with `u32::MAX` standing in for the `NaN` a
    /// JavaScript out-of-range index reads. No character class or comparison in the
    /// lexer matches it, which is what `NaN` does there too.
    fn code_at(&self, position: Offset) -> u32 {
        self.body.get(position as usize).map_or(u32::MAX, |unit| u32::from(*unit))
    }

    /// `body.slice(start, end)` over UTF-16 code units.
    ///
    /// Every slice taken for a token's value lands on a character boundary. The
    /// exception is an error message: `read_escaped_unicode_variable_width` and
    /// `read_escaped_unicode_fixed_width` quote a fixed number of units of malformed
    /// escape text, which a JavaScript string can cut through a surrogate pair while a
    /// Rust `String` cannot hold the lone surrogate that leaves behind. Such a slice
    /// decodes to U+FFFD here.
    fn slice(&self, start: Offset, end: Offset) -> String {
        let start = (start as usize).min(self.body.len());
        let end = (end as usize).clamp(start, self.body.len());
        String::from_utf16_lossy(&self.body[start..end])
    }

    /// `body.codePointAt(location)`: the code point at an offset, or `None` past the
    /// end. A leading surrogate joins the trailing surrogate that follows it.
    fn code_point_at(&self, location: Offset) -> Option<u32> {
        let first = u32::from(*self.body.get(location as usize)?);
        if is_leading_surrogate(first as i32)
            && let Some(second) = self.body.get(location as usize + 1)
            && is_trailing_surrogate(i32::from(*second))
        {
            let second = u32::from(*second);
            return Some(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
        }
        Some(first)
    }

    /// `printCodePointAt(lexer, location)`: `<EOF>`, a quoted printable ASCII
    /// character, or a `U+XXXX` code point.
    fn print_code_point_at(&self, location: Offset) -> String {
        match self.code_point_at(location) {
            None => TokenKind::Eof.as_str().to_string(),
            Some(code) if (0x0020..=0x007e).contains(&code) => {
                let character = char::from_u32(code).unwrap_or('\u{fffd}');
                if character == '"' { "'\"'".to_string() } else { format!("\"{character}\"") }
            }
            Some(code) => format!("U+{code:04X}"),
        }
    }

    /// `isSupplementaryCodePoint(body, location)`.
    fn is_supplementary_code_point(&self, location: Offset) -> bool {
        is_leading_surrogate(self.code_at(location) as i32)
            && is_trailing_surrogate(self.code_at(location + 1) as i32)
    }

    /// `createToken(lexer, kind, start, end, value)`.
    fn create_token(
        &self,
        kind: TokenKind,
        start: Offset,
        end: Offset,
        value: Option<String>,
    ) -> Token {
        let line = self.line;
        let column = 1 + start - self.line_start;
        Token { kind, start, end, line, column, value }
    }

    /// `readNextToken(lexer, start)`.
    fn read_next_token(&mut self, start: Offset) -> Result<Token, SyntaxError> {
        let body_length = self.body.len() as u32;
        let mut position = start;
        while position < body_length {
            let code = self.code_at(position);
            match code {
                // Ignored: BOM, tab, space and comma.
                0xfeff | 0x0009 | 0x0020 | 0x002c => {
                    position += 1;
                    continue;
                }
                // LineTerminator: \n
                0x000a => {
                    position += 1;
                    self.line += 1;
                    self.line_start = position;
                    continue;
                }
                // LineTerminator: \r or \r\n
                0x000d => {
                    position += if self.code_at(position + 1) == 0x000a { 2 } else { 1 };
                    self.line += 1;
                    self.line_start = position;
                    continue;
                }
                // Comment
                0x0023 => return self.read_comment(position),
                // Punctuators
                0x0021 => {
                    return Ok(self.create_token(TokenKind::Bang, position, position + 1, None));
                }
                0x0024 => {
                    return Ok(self.create_token(TokenKind::Dollar, position, position + 1, None));
                }
                0x0026 => {
                    return Ok(self.create_token(TokenKind::Amp, position, position + 1, None));
                }
                0x0028 => {
                    return Ok(self.create_token(TokenKind::ParenL, position, position + 1, None));
                }
                0x0029 => {
                    return Ok(self.create_token(TokenKind::ParenR, position, position + 1, None));
                }
                0x002e => {
                    if self.code_at(position + 1) == 0x002e
                        && self.code_at(position + 2) == 0x002e
                    {
                        return Ok(self.create_token(
                            TokenKind::Spread,
                            position,
                            position + 3,
                            None,
                        ));
                    }
                }
                0x003a => {
                    return Ok(self.create_token(TokenKind::Colon, position, position + 1, None));
                }
                0x003d => {
                    return Ok(self.create_token(TokenKind::Equals, position, position + 1, None));
                }
                0x0040 => {
                    return Ok(self.create_token(TokenKind::At, position, position + 1, None));
                }
                0x005b => {
                    return Ok(self.create_token(TokenKind::BracketL, position, position + 1, None));
                }
                0x005d => {
                    return Ok(self.create_token(TokenKind::BracketR, position, position + 1, None));
                }
                0x007b => {
                    return Ok(self.create_token(TokenKind::BraceL, position, position + 1, None));
                }
                0x007c => {
                    return Ok(self.create_token(TokenKind::Pipe, position, position + 1, None));
                }
                0x007d => {
                    return Ok(self.create_token(TokenKind::BraceR, position, position + 1, None));
                }
                // StringValue
                0x0022 => {
                    if self.code_at(position + 1) == 0x0022
                        && self.code_at(position + 2) == 0x0022
                    {
                        return self.read_block_string(position);
                    }
                    return self.read_string(position);
                }
                _ => {}
            }

            // IntValue | FloatValue (Digit | -)
            if is_digit(code) || code == 0x002d {
                return self.read_number(position, code);
            }
            // Name
            if is_name_start(code) {
                return self.read_name(position);
            }

            let description = if code == 0x0027 {
                "Unexpected single quote character ('), did you mean to use a double quote (\")?"
                    .to_string()
            } else if is_unicode_scalar_value(code) || self.is_supplementary_code_point(position) {
                format!("Unexpected character: {}.", self.print_code_point_at(position))
            } else {
                format!("Invalid character: {}.", self.print_code_point_at(position))
            };
            return Err(syntax_error(&self.body, position, description));
        }

        Ok(self.create_token(TokenKind::Eof, body_length, body_length, None))
    }

    /// `readComment(lexer, start)`.
    fn read_comment(&mut self, start: Offset) -> Result<Token, SyntaxError> {
        let body_length = self.body.len() as u32;
        let mut position = start + 1;
        while position < body_length {
            let code = self.code_at(position);
            if code == 0x000a || code == 0x000d {
                break;
            }
            if is_unicode_scalar_value(code) {
                position += 1;
            } else if self.is_supplementary_code_point(position) {
                position += 2;
            } else {
                break;
            }
        }
        let value = self.slice(start + 1, position);
        Ok(self.create_token(TokenKind::Comment, start, position, Some(value)))
    }

    /// `readNumber(lexer, start, firstCode)`.
    fn read_number(&mut self, start: Offset, first_code: u32) -> Result<Token, SyntaxError> {
        let mut position = start;
        let mut code = first_code;
        let mut is_float = false;

        // NegativeSign (-)
        if code == 0x002d {
            position += 1;
            code = self.code_at(position);
        }

        // Zero (0)
        if code == 0x0030 {
            position += 1;
            code = self.code_at(position);
            if is_digit(code) {
                return Err(syntax_error(
                    &self.body,
                    position,
                    format!(
                        "Invalid number, unexpected digit after 0: {}.",
                        self.print_code_point_at(position)
                    ),
                ));
            }
        } else {
            position = self.read_digits(position, code)?;
            code = self.code_at(position);
        }

        // Full stop (.)
        if code == 0x002e {
            is_float = true;
            position += 1;
            code = self.code_at(position);
            position = self.read_digits(position, code)?;
            code = self.code_at(position);
        }

        // E e
        if code == 0x0045 || code == 0x0065 {
            is_float = true;
            position += 1;
            code = self.code_at(position);
            // + -
            if code == 0x002b || code == 0x002d {
                position += 1;
                code = self.code_at(position);
            }
            position = self.read_digits(position, code)?;
            code = self.code_at(position);
        }

        // Numbers cannot be followed by . or NameStart
        if code == 0x002e || is_name_start(code) {
            return Err(syntax_error(
                &self.body,
                position,
                format!(
                    "Invalid number, expected digit but got: {}.",
                    self.print_code_point_at(position)
                ),
            ));
        }

        let value = self.slice(start, position);
        let kind = if is_float { TokenKind::Float } else { TokenKind::Int };
        Ok(self.create_token(kind, start, position, Some(value)))
    }

    /// `readDigits(lexer, start, firstCode)`.
    fn read_digits(&self, start: Offset, first_code: u32) -> Result<Offset, SyntaxError> {
        if !is_digit(first_code) {
            return Err(syntax_error(
                &self.body,
                start,
                format!(
                    "Invalid number, expected digit but got: {}.",
                    self.print_code_point_at(start)
                ),
            ));
        }
        let mut position = start + 1;
        while is_digit(self.code_at(position)) {
            position += 1;
        }
        Ok(position)
    }

    /// `readString(lexer, start)`.
    fn read_string(&mut self, start: Offset) -> Result<Token, SyntaxError> {
        let body_length = self.body.len() as u32;
        let mut position = start + 1;
        let mut chunk_start = position;
        let mut value = String::new();

        while position < body_length {
            let code = self.code_at(position);

            // Closing Quote (")
            if code == 0x0022 {
                value.push_str(&self.slice(chunk_start, position));
                return Ok(self.create_token(TokenKind::Str, start, position + 1, Some(value)));
            }

            // Escape Sequence (\)
            if code == 0x005c {
                value.push_str(&self.slice(chunk_start, position));
                let (escaped, size) = if self.code_at(position + 1) == 0x0075 {
                    if self.code_at(position + 2) == 0x007b {
                        self.read_escaped_unicode_variable_width(position)?
                    } else {
                        self.read_escaped_unicode_fixed_width(position)?
                    }
                } else {
                    self.read_escaped_character(position)?
                };
                value.push_str(&escaped);
                position += size;
                chunk_start = position;
                continue;
            }

            // LineTerminator (\n | \r)
            if code == 0x000a || code == 0x000d {
                break;
            }

            // SourceCharacter
            if is_unicode_scalar_value(code) {
                position += 1;
            } else if self.is_supplementary_code_point(position) {
                position += 2;
            } else {
                return Err(syntax_error(
                    &self.body,
                    position,
                    format!(
                        "Invalid character within String: {}.",
                        self.print_code_point_at(position)
                    ),
                ));
            }
        }

        Err(syntax_error(&self.body, position, "Unterminated string."))
    }

    /// `readEscapedUnicodeVariableWidth(lexer, position)`: `\u{…}`.
    fn read_escaped_unicode_variable_width(
        &self,
        position: Offset,
    ) -> Result<(String, Offset), SyntaxError> {
        let mut point: i32 = 0;
        // Cannot be larger than 12 chars (\u{00000000}).
        let mut size: Offset = 3;

        while size < 12 {
            let code = self.code_at(position + size);
            size += 1;

            // Closing Brace (})
            if code == 0x007d {
                // Must be at least 5 chars (\u{0}) and encode a Unicode scalar value.
                if size < 5 || !is_unicode_scalar_value_i32(point) {
                    break;
                }
                return Ok((scalar_to_string(point), size));
            }

            // Append this hex digit to the code point.
            point = (point << 4) | read_hex_digit(code);
            if point < 0 {
                break;
            }
        }

        Err(syntax_error(
            &self.body,
            position,
            format!(
                "Invalid Unicode escape sequence: \"{}\".",
                self.slice(position, position + size)
            ),
        ))
    }

    /// `readEscapedUnicodeFixedWidth(lexer, position)`: `\uXXXX` and surrogate pairs.
    fn read_escaped_unicode_fixed_width(
        &self,
        position: Offset,
    ) -> Result<(String, Offset), SyntaxError> {
        let code = self.read_16_bit_hex_code(position + 2);

        if is_unicode_scalar_value_i32(code) {
            return Ok((scalar_to_string(code), 6));
        }

        // GraphQL allows JSON-style surrogate pair escape sequences, but only when a
        // valid pair is formed.
        if is_leading_surrogate(code)
            && self.code_at(position + 6) == 0x005c
            && self.code_at(position + 7) == 0x0075
        {
            let trailing_code = self.read_16_bit_hex_code(position + 8);
            if is_trailing_surrogate(trailing_code) {
                // JavaScript encodes the pair as two code units; Rust has one
                // character for it.
                let combined = 0x10000 + ((code - 0xd800) << 10) + (trailing_code - 0xdc00);
                return Ok((scalar_to_string(combined), 12));
            }
        }

        Err(syntax_error(
            &self.body,
            position,
            format!(
                "Invalid Unicode escape sequence: \"{}\".",
                self.slice(position, position + 6)
            ),
        ))
    }

    /// `read16BitHexCode(body, position)`; negative when a character is not a hex digit.
    fn read_16_bit_hex_code(&self, position: Offset) -> i32 {
        (read_hex_digit(self.code_at(position)) << 12)
            | (read_hex_digit(self.code_at(position + 1)) << 8)
            | (read_hex_digit(self.code_at(position + 2)) << 4)
            | read_hex_digit(self.code_at(position + 3))
    }

    /// `readEscapedCharacter(lexer, position)`.
    fn read_escaped_character(&self, position: Offset) -> Result<(String, Offset), SyntaxError> {
        let character = match self.code_at(position + 1) {
            0x0022 => '\u{0022}',
            0x005c => '\u{005c}',
            0x002f => '\u{002f}',
            0x0062 => '\u{0008}',
            0x0066 => '\u{000c}',
            0x006e => '\u{000a}',
            0x0072 => '\u{000d}',
            0x0074 => '\u{0009}',
            _ => {
                return Err(syntax_error(
                    &self.body,
                    position,
                    format!(
                        "Invalid character escape sequence: \"{}\".",
                        self.slice(position, position + 2)
                    ),
                ));
            }
        };
        Ok((character.to_string(), 2))
    }

    /// `readBlockString(lexer, start)`.
    fn read_block_string(&mut self, start: Offset) -> Result<Token, SyntaxError> {
        let body_length = self.body.len() as u32;
        let mut line_start = self.line_start;
        let mut position = start + 3;
        let mut chunk_start = position;
        let mut current_line = String::new();
        let mut block_lines: Vec<String> = Vec::new();

        while position < body_length {
            let code = self.code_at(position);

            // Closing Triple-Quote (""")
            if code == 0x0022
                && self.code_at(position + 1) == 0x0022
                && self.code_at(position + 2) == 0x0022
            {
                current_line.push_str(&self.slice(chunk_start, position));
                block_lines.push(std::mem::take(&mut current_line));
                let value = dedent_block_string_lines(&block_lines).join("\n");
                let token =
                    self.create_token(TokenKind::BlockString, start, position + 3, Some(value));
                self.line += block_lines.len() as u32 - 1;
                self.line_start = line_start;
                return Ok(token);
            }

            // Escaped Triple-Quote (\""")
            if code == 0x005c
                && self.code_at(position + 1) == 0x0022
                && self.code_at(position + 2) == 0x0022
                && self.code_at(position + 3) == 0x0022
            {
                current_line.push_str(&self.slice(chunk_start, position));
                chunk_start = position + 1; // skip only slash
                position += 4;
                continue;
            }

            // LineTerminator
            if code == 0x000a || code == 0x000d {
                current_line.push_str(&self.slice(chunk_start, position));
                block_lines.push(std::mem::take(&mut current_line));
                position +=
                    if code == 0x000d && self.code_at(position + 1) == 0x000a { 2 } else { 1 };
                chunk_start = position;
                line_start = position;
                continue;
            }

            // SourceCharacter
            if is_unicode_scalar_value(code) {
                position += 1;
            } else if self.is_supplementary_code_point(position) {
                position += 2;
            } else {
                return Err(syntax_error(
                    &self.body,
                    position,
                    format!(
                        "Invalid character within String: {}.",
                        self.print_code_point_at(position)
                    ),
                ));
            }
        }

        Err(syntax_error(&self.body, position, "Unterminated string."))
    }

    /// `readName(lexer, start)`.
    fn read_name(&mut self, start: Offset) -> Result<Token, SyntaxError> {
        let body_length = self.body.len() as u32;
        let mut position = start + 1;
        while position < body_length {
            if is_name_continue(self.code_at(position)) {
                position += 1;
            } else {
                break;
            }
        }
        let value = self.slice(start, position);
        Ok(self.create_token(TokenKind::Name, start, position, Some(value)))
    }
}

/// `dedentBlockStringLines(lines)` from `language/blockString.js`.
fn dedent_block_string_lines(lines: &[String]) -> Vec<String> {
    let mut common_indent = usize::MAX; // Number.MAX_SAFE_INTEGER
    let mut first_non_empty_line: Option<usize> = None;
    let mut last_non_empty_line: i64 = -1;

    for (index, line) in lines.iter().enumerate() {
        let indent = leading_whitespace(line);
        if indent == js_len(line) {
            continue; // skip empty lines
        }
        if first_non_empty_line.is_none() {
            first_non_empty_line = Some(index);
        }
        last_non_empty_line = index as i64;
        if index != 0 && indent < common_indent {
            common_indent = indent;
        }
    }

    // Remove common indentation from all lines but the first, then drop the leading
    // and trailing blank lines.
    let start = first_non_empty_line.unwrap_or(0);
    let end = (last_non_empty_line + 1).max(0) as usize;
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if index == 0 { line.clone() } else { slice_from_utf16(line, common_indent) }
        })
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}

/// `leadingWhitespace(str)`: the count of leading `WhiteSpace` characters.
fn leading_whitespace(text: &str) -> usize {
    text.chars().take_while(|character| is_white_space(*character as u32)).count()
}

/// `str.slice(start)` over UTF-16 code units.
fn slice_from_utf16(text: &str, start: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if start >= units.len() {
        return String::new();
    }
    String::from_utf16_lossy(&units[start..])
}

/// `str.length` in JavaScript: the number of UTF-16 code units.
fn js_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `String.fromCodePoint(point)` for a code point already known to be a scalar value.
fn scalar_to_string(point: i32) -> String {
    char::from_u32(point as u32).unwrap_or('\u{fffd}').to_string()
}

/// `isWhiteSpace(code)`: tab or space.
fn is_white_space(code: u32) -> bool {
    code == 0x0009 || code == 0x0020
}

/// `isDigit(code)`.
fn is_digit(code: u32) -> bool {
    (0x0030..=0x0039).contains(&code)
}

/// `isLetter(code)`.
fn is_letter(code: u32) -> bool {
    (0x0061..=0x007a).contains(&code) || (0x0041..=0x005a).contains(&code)
}

/// `isNameStart(code)`.
fn is_name_start(code: u32) -> bool {
    is_letter(code) || code == 0x005f
}

/// `isNameContinue(code)`.
fn is_name_continue(code: u32) -> bool {
    is_letter(code) || is_digit(code) || code == 0x005f
}

/// `isUnicodeScalarValue(code)`.
fn is_unicode_scalar_value(code: u32) -> bool {
    code <= 0xd7ff || (0xe000..=0x10ffff).contains(&code)
}

/// `isUnicodeScalarValue` over a signed accumulator, which also rejects the `-1` a
/// bad hex digit produces.
fn is_unicode_scalar_value_i32(code: i32) -> bool {
    (0..=0xd7ff).contains(&code) || (0xe000..=0x10ffff).contains(&code)
}

/// `isLeadingSurrogate(code)`.
fn is_leading_surrogate(code: i32) -> bool {
    (0xd800..=0xdbff).contains(&code)
}

/// `isTrailingSurrogate(code)`.
fn is_trailing_surrogate(code: i32) -> bool {
    (0xdc00..=0xdfff).contains(&code)
}

/// `readHexDigit(code)`: 0-15, or -1 when the character is not a hex digit.
fn read_hex_digit(code: u32) -> i32 {
    if (0x0030..=0x0039).contains(&code) {
        (code - 0x0030) as i32
    } else if (0x0041..=0x0046).contains(&code) {
        (code - 0x0037) as i32
    } else if (0x0061..=0x0066).contains(&code) {
        (code - 0x0057) as i32
    } else {
        -1
    }
}
