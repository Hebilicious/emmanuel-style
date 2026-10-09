//! Extraction: finding documents in `.vue`/`.ts`/`.tsx`/`.gql` files.
//! Port of `packages/core/src/extract.ts`, `sfc.ts` and `page-module.ts`.
//!
//! OWNER: the extraction port. A file's contribution is assembled per file
//! (`FileResidue`), which is what lets an incremental run re-use the files a
//! change set does not name (see `session.rs`).

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrayAssignmentTarget, ArrayExpressionElement,
    ArrowFunctionExpression, AssignmentTarget, AssignmentTargetMaybeDefault,
    AssignmentTargetProperty, BindingPattern, BindingProperty, BindingRestElement, BlockStatement,
    CallExpression, ChainElement, Class, ClassElement, Declaration, ExportDefaultDeclaration,
    ExportDefaultDeclarationKind, ExportNamedDeclaration, Expression, FormalParameters,
    ForStatementInit, ForStatementLeft, Function, FunctionBody, ImportDeclaration,
    ImportDeclarationSpecifier, JSXAttributeItem, JSXAttributeValue, JSXChild, JSXElement,
    JSXExpression, JSXFragment, ModuleExportName, ObjectAssignmentTarget, ObjectExpression,
    ObjectPropertyKind, Program, PropertyKey, SimpleAssignmentTarget, Statement,
    TaggedTemplateExpression, TemplateLiteral, TSEnumDeclaration, TSGlobalDeclaration,
    TSImportEqualsDeclaration, TSIndexSignature, TSLiteral, TSMethodSignature, TSModuleDeclaration,
    TSModuleDeclarationBody, TSModuleDeclarationName, TSModuleReference, TSPropertySignature,
    TSSignature, TSTupleElement, TSType, TSTypeAliasDeclaration, TSTypeName,
    TSTypeParameterDeclaration, TSTypeParameterInstantiation, TSTypeQueryExprName,
    VariableDeclaration, VariableDeclarator,
};

use oxc_parser::{ParseOptions, Parser};
use oxc_span::{GetSpan, SourceType};

use crate::config::RustConfig;
use crate::contract::ArtifactKind;
use crate::diagnostics::{Diagnostic, DiagnosticInput, SourceLocation, create_diagnostic};
use crate::graphql::ast::{Definition, Document, OperationType};
use crate::offsets::{Offset, SourceText, location_at, to_posix};
use crate::sfc::analyze_vue_sfc;

/// Which surface a document was extracted from (`spec/spec.md` §4.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentSurface {
    /// A `.gql`/`.graphql` file.
    File,
    /// A `graphql\`…\`` tag in a `.vue`/`.ts`/`.tsx` file.
    Tag,
    /// A `graphql("…")` call.
    Script,
    /// A `+page.ts`/`+layout.ts` module's `Page` export.
    Module,
    /// A synthetic composed route document: no file on disk, delivered with the request.
    ///
    /// It is a real artifact (validated, IR'd, emitted, manifested) but not app API: the barrel and
    /// the ambient declarations skip it (`research/route-composition-design.md` §1.5).
    Composed,
}

/// One source file handed to extraction by the TypeScript side.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    /// Posix path relative to `projectDir`.
    pub relative: String,
    /// Absolute path on disk.
    pub absolute: String,
    /// The file's text.
    pub text: String,
    /// Size in bytes as read, for cache fingerprints (unused by the port's pass).
    pub size: u64,
    /// Modification time in milliseconds as read (unused by the port's pass).
    pub mtime_ms: f64,
}

/// One extracted document surface, after parsing and naming (§4.1.1).
#[derive(Clone, Debug)]
pub struct RawDocument {
    /// Operation or fragment name; the empty string only for an anonymous operation.
    pub name: String,
    /// The document's kind.
    pub kind: ArtifactKind,
    /// The document text as written.
    pub raw: String,
    /// Absolute path of the file the document came from.
    pub file: String,
    /// Posix path relative to `projectDir`.
    pub relative_path: String,
    /// Which surface it came from.
    pub surface: DocumentSurface,
    /// Absolute offset of `raw[0]` in the file.
    pub offset: Offset,
    /// Absolute offset of the document's first source byte.
    pub start: Offset,
    /// Absolute offset just past the document's last source byte.
    pub end: Offset,
    /// `source_offsets[i]` is the absolute file offset of `raw[i]`; the last entry is `end`.
    pub source_offsets: Vec<Offset>,
    /// The parsed document.
    pub ast: Document,
    /// The full text of the file the document came from.
    pub source: SourceText,
}

impl RawDocument {
    /// The `file:line:column` location of an offset in the document's own text.
    pub fn location(&self, offset: Offset, length: u32) -> crate::diagnostics::SourceLocation {
        crate::offsets::location_at(&self.source, &self.relative_path, offset, length)
    }
}

/// A `.gql`/`.graphql` import found in a code file, used for FLM1017.
#[derive(Clone, Debug)]
pub struct GqlImport {
    /// Absolute path of the importing file.
    pub file: String,
    /// Posix path of the importing file, relative to `projectDir`.
    pub relative_path: String,
    /// The specifier as written.
    pub specifier: String,
    /// Absolute path the specifier resolves to, or `None` when it does not resolve.
    pub resolved: Option<String>,
    /// Absolute offset of the import declaration in the importing file.
    pub offset: Offset,
    /// The importing file's text.
    pub source: SourceText,
}

/// One file discovered by the walk, as the extraction reports it.
#[derive(Clone, Debug)]
pub struct DiscoveredFile {
    /// Absolute path on disk.
    pub absolute: String,
    /// Posix path relative to the walk root.
    pub relative: String,
    /// Size in bytes as read.
    pub size: u64,
    /// Modification time in milliseconds as read.
    pub mtime_ms: f64,
}

/// Everything extraction produces.
#[derive(Clone, Debug, Default)]
pub struct ExtractResult {
    /// Every document found, sorted by `(relativePath, offset)`.
    pub documents: Vec<RawDocument>,
    /// Extraction diagnostics (FLM1011, FLM1017 and the unbound-tag warning).
    pub diagnostics: Vec<Diagnostic>,
    /// Every `.gql`/`.graphql` import found in a code file.
    pub imports: Vec<GqlImport>,
    /// Every name imported from `$flamme` anywhere in the project (for FLM1018).
    pub imported_names: Vec<String>,
    /// The files the walk discovered, sorted by relative path.
    pub files: Vec<DiscoveredFile>,
}

// ---------------------------------------------------------------------------
// Path arithmetic (`node:path`, posix flavour)
// ---------------------------------------------------------------------------

/// `path.isAbsolute`.
pub(crate) fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
}

/// `path.basename`.
fn basename(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => &path[at + 1..],
        None => path,
    }
}

/// `path.dirname`.
pub(crate) fn dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let bytes = path.as_bytes();
    let has_root = bytes[0] == b'/';
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    let mut index = path.len();
    while index > 1 {
        index -= 1;
        if bytes[index] == b'/' {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None => {
            if has_root {
                "/".to_string()
            } else {
                ".".to_string()
            }
        }
        Some(1) if has_root => "//".to_string(),
        Some(at) => path[..at].to_string(),
    }
}

/// `path.normalize` for the absolute paths the compiler works with.
fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => match segments.last() {
                Some(last) if *last != ".." => {
                    segments.pop();
                }
                Some(_) => {}
                None => {
                    if !absolute {
                        segments.push("..");
                    }
                }
            },
            other => segments.push(other),
        }
    }
    let joined = segments.join("/");
    if absolute { format!("/{joined}") } else { joined }
}

/// `path.resolve(base, specifier)`; `base` is always absolute here.
pub(crate) fn resolve_path(base: &str, specifier: &str) -> String {
    if is_absolute(specifier) {
        return normalize(specifier);
    }
    normalize(&format!("{base}/{specifier}"))
}

/// `path.extname`.
pub(crate) fn extname(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let bytes = path.as_bytes();
    let mut start_dot: Option<usize> = None;
    let mut start_part = 0usize;
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    let mut pre_dot_state = 0i32;
    let mut index = path.len();
    while index > 0 {
        index -= 1;
        let code = bytes[index];
        if code == b'/' {
            if !matched_slash {
                start_part = index + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(index + 1);
        }
        if code == b'.' {
            match start_dot {
                None => start_dot = Some(index),
                Some(_) if pre_dot_state != 1 => pre_dot_state = 1,
                Some(_) => {}
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    let (Some(start_dot), Some(end)) = (start_dot, end) else {
        return String::new();
    };
    if pre_dot_state == 0 || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)
    {
        return String::new();
    }
    path[start_dot..end].to_string()
}

/// `path.relative(from, to)`; both are absolute posix paths.
fn relative_path(from: &str, to: &str) -> String {
    let from = normalize(from);
    let to = normalize(to);
    if from == to {
        return String::new();
    }
    let from_bytes = from.as_bytes();
    let to_bytes = to.as_bytes();
    let from_start = 1usize;
    let from_end = from.len();
    let from_len = from_end - from_start;
    let to_start = 1usize;
    let to_len = to.len() - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: i64 = -1;
    let mut index = 0usize;
    while index < length {
        let from_code = from_bytes[from_start + index];
        if from_code != to_bytes[to_start + index] {
            break;
        }
        if from_code == b'/' {
            last_common_sep = index as i64;
        }
        index += 1;
    }
    if index == length {
        if to_len > length {
            if to_bytes[to_start + index] == b'/' {
                return to[to_start + index + 1..].to_string();
            } else if index == 0 {
                return to[to_start + index..].to_string();
            }
        } else if from_len > length {
            if from_bytes[from_start + index] == b'/' {
                last_common_sep = index as i64;
            } else if index == 0 {
                last_common_sep = 0;
            }
        }
    }
    if last_common_sep == -1 {
        last_common_sep = 0;
    }
    let mut out = String::new();
    let mut at = from_start + last_common_sep as usize + 1;
    while at <= from_end {
        if at == from_end || from_bytes[at] == b'/' {
            if out.is_empty() {
                out.push_str("..");
            } else {
                out.push_str("/..");
            }
        }
        at += 1;
    }
    out.push_str(&to[to_start + last_common_sep as usize..]);
    out
}

/// Byte ↔ UTF-16 offset conversion for one text.
///
/// [`crate::offsets::SourceText`]'s own conversion subtracts the *number* of astral
/// characters, but each of them costs two bytes over its two UTF-16 code units, so
/// it lands one unit early per astral character (and `to_byte`/`slice_utf16` mirror
/// that). Extraction needs the exact JavaScript string indices, so it converts with
/// this map; it can go away once the shared conversion is fixed.
pub(crate) struct Utf16Map {
    /// Byte offsets of every astral character, ascending.
    astral: Vec<usize>,
}

impl Utf16Map {
    /// Builds the map for one text.
    pub(crate) fn new(text: &str) -> Self {
        Self {
            astral: text
                .char_indices()
                .filter(|(_, character)| character.len_utf16() == 2)
                .map(|(at, _)| at)
                .collect(),
        }
    }

    /// The UTF-16 offset of a byte offset.
    pub(crate) fn to_utf16(&self, byte: usize) -> Offset {
        (byte - 2 * self.astral.partition_point(|at| *at < byte)) as Offset
    }

    /// The byte offset of a UTF-16 offset; an offset inside a surrogate pair
    /// rounds down to the pair's first byte.
    pub(crate) fn to_byte(&self, text_length: usize, offset: Offset) -> usize {
        let mut passed = 0usize;
        for (index, at) in self.astral.iter().enumerate() {
            let utf16_start = at - 2 * index;
            if offset as usize <= utf16_start {
                break;
            }
            if (offset as usize) < utf16_start + 2 {
                return *at;
            }
            passed = index + 1;
        }
        (offset as usize + 2 * passed).min(text_length)
    }

    /// `text.slice(start, end)` in UTF-16 units.
    pub(crate) fn slice(&self, text: &str, start: Offset, end: Offset) -> String {
        let start_byte = self.to_byte(text.len(), start);
        let end_byte = self.to_byte(text.len(), end.max(start)).max(start_byte);
        text[start_byte..end_byte].to_string()
    }
}

// ---------------------------------------------------------------------------
// Template cooking
// ---------------------------------------------------------------------------

/// One string literal discovered by the scanner, before parsing.
#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    /// The document text, with JavaScript escape sequences resolved.
    ///
    /// `String::from_utf16_lossy` of [`Candidate::units`]: identical unless the
    /// template cooked a lone surrogate, which a `String` cannot hold.
    pub(crate) text: String,
    /// The cooked document as UTF-16 code units, the sequence the oracle's `parse`
    /// reads. A lone surrogate escape survives here, so the document still fails to
    /// lex exactly where the oracle's does.
    pub(crate) units: Vec<u16>,
    /// Absolute offset of the text's first character in the file.
    pub(crate) offset: Offset,
    /// `source_offsets[i]` is the absolute file offset of `text[i]`; the last entry is `end`.
    pub(crate) source_offsets: Vec<Offset>,
}

/// The cooked text of a template quasi (or string literal) plus the per-character map.
struct Cooked {
    /// `String::from_utf16_lossy` of `units`.
    text: String,
    /// The cooked text as UTF-16 code units.
    units: Vec<u16>,
    source_offsets: Vec<Offset>,
}

impl Cooked {
    /// The candidate this cooked text makes, at `offset`.
    fn into_candidate(self, offset: Offset) -> Candidate {
        Candidate { text: self.text, units: self.units, offset, source_offsets: self.source_offsets }
    }
}

/// The text a simple `\x` escape stands for, in JavaScript's semantics.
fn simple_escape(unit: u16) -> Option<&'static str> {
    match unit {
        0x6e => Some("\n"),
        0x72 => Some("\r"),
        0x74 => Some("\t"),
        0x62 => Some("\u{8}"),
        0x66 => Some("\u{c}"),
        0x76 => Some("\u{b}"),
        0x30 => Some("\0"),
        0x60 => Some("`"),
        0x5c => Some("\\"),
        0x24 => Some("$"),
        0x27 => Some("'"),
        0x22 => Some("\""),
        _ => None,
    }
}

/// `Number.parseInt(raw, 16)`: leading whitespace and sign, then hex digits.
///
/// The value is wider than a code point on purpose: a `\u{…}` escape past U+10FFFF
/// is one the oracle throws on, and a negative or oversized value has to be told
/// apart from a malformed one (`\u{ZZ}` parses to `NaN` there and cooks to `u{ZZ}`).
/// A digit run past `i64` saturates, because all that matters about it is that it is
/// larger than any code point.
fn parse_int_hex(raw: &str) -> Option<i64> {
    let bytes = raw.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    let mut negative = false;
    if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
        negative = bytes[index] == b'-';
        index += 1;
    }
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_hexdigit() {
        index += 1;
    }
    if start == index {
        return None;
    }
    let magnitude = u64::from_str_radix(&raw[start..index], 16)
        .unwrap_or(u64::MAX)
        .min(i64::MAX as u64) as i64;
    Some(if negative { -magnitude } else { magnitude })
}

/// The UTF-16 code units one code point encodes to, a surrogate included.
///
/// `String.fromCodePoint` accepts a surrogate code point and produces the lone
/// surrogate unit; `char::from_u32` refuses it, which is why this exists.
fn code_point_units(code: u32) -> Vec<u16> {
    match char::from_u32(code) {
        Some(character) => character.to_string().encode_utf16().collect(),
        None => vec![code as u16],
    }
}

/// One escape sequence as written, for the escapes `String.fromCodePoint` refuses.
fn escape_units(braced: bool, raw: &str) -> Vec<u16> {
    let mut out: Vec<u16> = vec![u16::from(b'\\'), u16::from(b'u')];
    if braced {
        out.push(u16::from(b'{'));
    }
    out.extend(raw.encode_utf16());
    if braced {
        out.push(u16::from(b'}'));
    }
    out
}

/// Appends the code units of one cooked value, recording the offset it came from.
///
/// Mirrors `push(value, at)` in the oracle: `text += value` records **one** offset
/// per call, even when the value is an astral character that contributes two units
/// (`\u{1F600}`). A literal character is pushed one unit at a time instead, so its
/// two units keep two offsets, as `text += slice[index]` does in JavaScript.
fn push_units(units: &mut Vec<u16>, offsets: &mut Vec<Offset>, value: &[u16], at: Offset) {
    units.extend_from_slice(value);
    offsets.push(at);
}

/// The code units one `String` value contributes.
fn units_of(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

/// Resolves the JavaScript escape sequences of a template quasi, mapping each
/// produced character back to the file offset it came from (`cookTemplate`).
///
/// The result is kept as UTF-16 code units, because a `\uD83D` escape cooks to a
/// lone surrogate: JavaScript holds it, a Rust `String` cannot, and the GraphQL
/// lexer reads code units. `text` is the lossy decode, used as the document's `raw`
/// (a document that contains a lone surrogate never parses, so it never gets one).
fn cook_template(slice: &str, start: Offset) -> Cooked {
    let source: Vec<u16> = slice.encode_utf16().collect();
    let mut units: Vec<u16> = Vec::new();
    let mut offsets: Vec<Offset> = Vec::new();
    let mut index = 0usize;
    while index < source.len() {
        let unit = source[index];
        if unit != u16::from(b'\\') {
            // A line terminator cooks to LF: CRLF, and a lone CR as well.
            if unit == u16::from(b'\r') {
                let crlf = source.get(index + 1) == Some(&u16::from(b'\n'));
                let at = start + if crlf { index as u32 + 1 } else { index as u32 };
                push_units(&mut units, &mut offsets, &[u16::from(b'\n')], at);
                index += if crlf { 2 } else { 1 };
                continue;
            }
            // One unit per push: a surrogate pair is two pushes, one offset each.
            push_units(&mut units, &mut offsets, &[unit], start + index as u32);
            index += 1;
            continue;
        }
        let at = start + index as u32;
        let Some(next) = source.get(index + 1).copied() else {
            index += 1;
            continue;
        };
        // A line continuation produces nothing.
        if next == u16::from(b'\n') {
            index += 2;
            continue;
        }
        if next == u16::from(b'\r') && source.get(index + 2) == Some(&u16::from(b'\n')) {
            index += 3;
            continue;
        }
        if let Some(replacement) = simple_escape(next) {
            push_units(&mut units, &mut offsets, &units_of(replacement), at);
            index += 2;
            continue;
        }
        if next == u16::from(b'x') || next == u16::from(b'u') {
            let braced = next == u16::from(b'u') && source.get(index + 2) == Some(&u16::from(b'{'));
            let raw: String = if braced {
                source[index + 3..]
                    .iter()
                    .take_while(|unit| **unit != u16::from(b'}'))
                    .map(|unit| char::from_u32(u32::from(*unit)).unwrap_or('\u{fffd}'))
                    .collect()
            } else {
                let length = if next == u16::from(b'x') { 2 } else { 4 };
                let from = (index + 2).min(source.len());
                let to = (index + 2 + length).min(source.len());
                source[from..to]
                    .iter()
                    .map(|unit| char::from_u32(u32::from(*unit)).unwrap_or('\u{fffd}'))
                    .collect()
            };
            if !raw.is_empty()
                && let Some(code) = parse_int_hex(&raw)
            {
                let width = if braced { 4 + raw.len() } else { 2 + raw.len() };
                let value = u32::try_from(code).ok().filter(|code| *code <= 0x10ffff);
                match value {
                    Some(code) => {
                        push_units(&mut units, &mut offsets, &code_point_units(code), at);
                    }
                    None => {
                        // `String.fromCodePoint` throws past U+10FFFF (and for a
                        // negative value); the port keeps the escape as written
                        // instead of aborting the run, so the document fails to lex
                        // rather than silently compiling to a different document.
                        for (step, unit) in escape_units(braced, &raw).iter().enumerate() {
                            push_units(&mut units, &mut offsets, &[*unit], at + step as u32);
                        }
                    }
                }
                index += width;
                continue;
            }
        }
        // An unrecognised escape is the escaped character itself.
        push_units(&mut units, &mut offsets, &[next], at);
        index += 2;
    }
    offsets.push(start + source.len() as u32);
    Cooked { text: String::from_utf16_lossy(&units), units, source_offsets: offsets }
}

/// Unescapes a template quasi the way the reference implementation does.
pub fn unescape_template(raw: &str) -> String {
    raw.replace("\\`", "`")
}

// ---------------------------------------------------------------------------
// The code scanner
// ---------------------------------------------------------------------------

/// What one local name in a scanned module is bound to (`+page.ts` Page resolution).
#[derive(Clone, Debug)]
pub(crate) enum ScanBinding {
    /// A `graphql` tag declared in this module, by candidate index.
    Document(usize),
    /// An alias of another local name.
    Alias(String),
    /// An import: the specifier, the imported name (`default`/`*` included), and
    /// the absolute path it resolves to.
    Import {
        /// The specifier as written.
        specifier: String,
        /// The imported name; `default` for a default import, `*` for a namespace.
        imported: String,
        /// Absolute path the specifier resolves to. The reference implementation
        /// records it too, but only the specifier is ever read back.
        #[allow(dead_code)]
        resolved: Option<String>,
    },
    /// Anything else.
    Other,
}

/// One name a scanned module exports, and the local binding it names.
#[derive(Clone, Debug)]
pub(crate) struct ScanExport {
    /// The exported name; `default` for `export default …`.
    pub(crate) name: String,
    /// The local binding the export refers to.
    pub(crate) local: String,
    /// Absolute offset of the export declaration, for diagnostics.
    pub(crate) offset: Offset,
}

/// What a scan of one script block found.
pub(crate) struct ScanResult {
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) imports: Vec<GqlImport>,
    pub(crate) imported_names: Vec<String>,
    /// Offsets of `graphql` identifiers seen but not bound to a `$flamme` import.
    pub(crate) unbound: Vec<Offset>,
    /// What each local name of the block is bound to; the last binding wins.
    pub(crate) bindings: Vec<(String, ScanBinding)>,
    /// Every name the block exports, with the local binding it names.
    pub(crate) exports: Vec<ScanExport>,
}

impl ScanResult {
    fn new() -> Self {
        Self {
            candidates: Vec::new(),
            diagnostics: Vec::new(),
            imports: Vec::new(),
            imported_names: Vec::new(),
            unbound: Vec::new(),
            bindings: Vec::new(),
            exports: Vec::new(),
        }
    }

    /// The binding of one local name, the last write winning.
    pub(crate) fn binding(&self, name: &str) -> Option<&ScanBinding> {
        self.bindings.iter().rev().find(|(key, _)| key == name).map(|(_, value)| value)
    }

    fn set_binding(&mut self, name: &str, binding: ScanBinding) {
        if let Some(entry) = self.bindings.iter_mut().find(|(key, _)| key == name) {
            entry.1 = binding;
        } else {
            self.bindings.push((name.to_string(), binding));
        }
    }
}

/// One `const`/`let`/`var` declaration the binder pass found.
struct DocDeclaration {
    name: String,
    /// Absolute offset of the initializer, or `-1` for a declaration without one.
    init_start: i64,
    /// The identifier the initializer names, when it is one.
    alias: Option<String>,
    /// `true` when the initializer is a `graphql()` document candidate.
    document: bool,
}

/// Which half of `scanCode` a traversal is running.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pass {
    /// Pass 1: bindings, exports and declared names.
    Bindings,
    /// Pass 2: document candidates and their diagnostics.
    Candidates,
}

/// The scanner state for one code block.
struct CodeScanner<'a> {
    /// The block's byte to UTF-16 conversion.
    code_map: Utf16Map,
    /// Absolute offset of the block's first character in the file.
    base: Offset,
    /// Absolute path of the file the block came from.
    file: &'a str,
    /// Project-relative posix path of that file.
    relative_path: &'a str,
    /// The file's full text, for diagnostics and for the candidates' source slices.
    source: &'a SourceText,
    /// The file's byte to UTF-16 conversion.
    source_map: Utf16Map,
    result: ScanResult,
    bound: HashSet<String>,
    declarations: Vec<DocDeclaration>,
    candidate_at: HashMap<Offset, usize>,
    pass: Pass,
    /// The document extensions in effect, or an empty slice for the default pair.
    document_extensions: &'a [String],
}

/// The body of [`CodeScanner::walk_expression`], reused for every enum that
/// inherits `Expression`'s variants (Rust has no structural enum inheritance).
macro_rules! inherited_expression_arms {
    ($scanner:ident, $enum:ident, $value:ident) => {
        match $value {
            $enum::BooleanLiteral(_)
            | $enum::NullLiteral(_)
            | $enum::NumericLiteral(_)
            | $enum::BigIntLiteral(_)
            | $enum::RegExpLiteral(_)
            | $enum::StringLiteral(_)
            | $enum::Identifier(_)
            | $enum::MetaProperty(_)
            | $enum::Super(_)
            | $enum::ThisExpression(_) => {}
            $enum::TemplateLiteral(node) => {
                for expression in &node.expressions {
                    $scanner.walk_expression(expression);
                }
            }
            $enum::ArrayExpression(node) => {
                for element in &node.elements {
                    $scanner.walk_array_element(element);
                }
            }
            $enum::ArrowFunctionExpression(node) => $scanner.walk_arrow(node),
            $enum::AssignmentExpression(node) => {
                $scanner.walk_assignment_target(&node.left);
                $scanner.walk_expression(&node.right);
            }
            $enum::AwaitExpression(node) => $scanner.walk_expression(&node.argument),
            $enum::BinaryExpression(node) => {
                $scanner.walk_expression(&node.left);
                $scanner.walk_expression(&node.right);
            }
            $enum::CallExpression(node) => {
                if $scanner.pass == Pass::Candidates {
                    $scanner.visit_call_expression(node);
                }
                $scanner.walk_expression(&node.callee);
                for argument in &node.arguments {
                    $scanner.walk_argument(argument);
                }
            }
            $enum::ChainExpression(node) => match &node.expression {
                ChainElement::CallExpression(call) => {
                    if $scanner.pass == Pass::Candidates {
                        $scanner.visit_call_expression(call);
                    }
                    $scanner.walk_expression(&call.callee);
                    for argument in &call.arguments {
                        $scanner.walk_argument(argument);
                    }
                }
                ChainElement::TSNonNullExpression(inner) => $scanner.walk_expression(&inner.expression),
                ChainElement::ComputedMemberExpression(member) => {
                    $scanner.walk_expression(&member.object);
                    $scanner.walk_expression(&member.expression);
                }
                ChainElement::StaticMemberExpression(member) => {
                    $scanner.walk_expression(&member.object)
                }
                ChainElement::PrivateFieldExpression(member) => {
                    $scanner.walk_expression(&member.object)
                }
            },
            $enum::ClassExpression(node) => $scanner.walk_class(node),
            $enum::ConditionalExpression(node) => {
                $scanner.walk_expression(&node.test);
                $scanner.walk_expression(&node.consequent);
                $scanner.walk_expression(&node.alternate);
            }
            $enum::FunctionExpression(node) => $scanner.walk_function(node),
            $enum::ImportExpression(node) => {
                $scanner.walk_expression(&node.source);
                if let Some(options) = &node.options {
                    $scanner.walk_expression(options);
                }
            }
            $enum::LogicalExpression(node) => {
                $scanner.walk_expression(&node.left);
                $scanner.walk_expression(&node.right);
            }
            $enum::NewExpression(node) => {
                $scanner.walk_expression(&node.callee);
                for argument in &node.arguments {
                    $scanner.walk_argument(argument);
                }
            }
            $enum::ObjectExpression(node) => $scanner.walk_object(node),
            $enum::ParenthesizedExpression(node) => $scanner.walk_expression(&node.expression),
            $enum::SequenceExpression(node) => {
                for expression in &node.expressions {
                    $scanner.walk_expression(expression);
                }
            }
            $enum::TaggedTemplateExpression(node) => {
                if $scanner.pass == Pass::Candidates {
                    $scanner.visit_tagged_template(node);
                }
                $scanner.walk_expression(&node.tag);
                for expression in &node.quasi.expressions {
                    $scanner.walk_expression(expression);
                }
            }
            $enum::UnaryExpression(node) => $scanner.walk_expression(&node.argument),
            $enum::UpdateExpression(node) => $scanner.walk_simple_target(&node.argument),
            $enum::YieldExpression(node) => {
                if let Some(argument) = &node.argument {
                    $scanner.walk_expression(argument);
                }
            }
            $enum::PrivateInExpression(node) => $scanner.walk_expression(&node.right),
            $enum::JSXElement(node) => $scanner.walk_jsx_element(node),
            $enum::JSXFragment(node) => $scanner.walk_jsx_fragment(node),
            $enum::TSAsExpression(node) => {
                $scanner.walk_expression(&node.expression);
                $scanner.walk_ts_type(&node.type_annotation);
            }
            $enum::TSSatisfiesExpression(node) => {
                $scanner.walk_expression(&node.expression);
                $scanner.walk_ts_type(&node.type_annotation);
            }
            $enum::TSTypeAssertion(node) => {
                $scanner.walk_expression(&node.expression);
                $scanner.walk_ts_type(&node.type_annotation);
            }
            $enum::TSNonNullExpression(node) => $scanner.walk_expression(&node.expression),
            $enum::TSInstantiationExpression(node) => $scanner.walk_expression(&node.expression),
            $enum::V8IntrinsicExpression(node) => {
                for argument in &node.arguments {
                    $scanner.walk_argument(argument);
                }
            }
            $enum::ComputedMemberExpression(node) => {
                $scanner.walk_expression(&node.object);
                $scanner.walk_expression(&node.expression);
            }
            $enum::StaticMemberExpression(node) => $scanner.walk_expression(&node.object),
            $enum::PrivateFieldExpression(node) => $scanner.walk_expression(&node.object),
            #[allow(unreachable_patterns)]
            _ => {}
        }
    };
}

/// The body of [`CodeScanner::walk_ts_type`], reused for `TSTupleElement`.
macro_rules! ts_type_arms {
    ($scanner:ident, $enum:ident, $value:ident) => {
        match $value {
            $enum::TSAnyKeyword(_)
            | $enum::TSBigIntKeyword(_)
            | $enum::TSBooleanKeyword(_)
            | $enum::TSIntrinsicKeyword(_)
            | $enum::TSNeverKeyword(_)
            | $enum::TSNullKeyword(_)
            | $enum::TSNumberKeyword(_)
            | $enum::TSObjectKeyword(_)
            | $enum::TSStringKeyword(_)
            | $enum::TSSymbolKeyword(_)
            | $enum::TSUndefinedKeyword(_)
            | $enum::TSUnknownKeyword(_)
            | $enum::TSVoidKeyword(_)
            | $enum::TSThisType(_)
            | $enum::JSDocUnknownType(_) => {}
            $enum::TSArrayType(node) => $scanner.walk_ts_type(&node.element_type),
            $enum::TSConditionalType(node) => {
                $scanner.walk_ts_type(&node.check_type);
                $scanner.walk_ts_type(&node.extends_type);
                $scanner.walk_ts_type(&node.true_type);
                $scanner.walk_ts_type(&node.false_type);
            }
            $enum::TSConstructorType(node) => {
                $scanner.walk_type_parameters(node.type_parameters.as_deref());
                $scanner.walk_parameters(&node.params);
                $scanner.walk_ts_type(&node.return_type.type_annotation);
            }
            $enum::TSFunctionType(node) => {
                $scanner.walk_type_parameters(node.type_parameters.as_deref());
                $scanner.walk_parameters(&node.params);
                $scanner.walk_ts_type(&node.return_type.type_annotation);
            }
            $enum::TSImportType(node) => {
                if let Some(options) = &node.options {
                    $scanner.walk_object(options);
                }
                $scanner.walk_type_arguments(node.type_arguments.as_deref());
            }
            $enum::TSIndexedAccessType(node) => {
                $scanner.walk_ts_type(&node.object_type);
                $scanner.walk_ts_type(&node.index_type);
            }
            $enum::TSInferType(node) => {
                if let Some(constraint) = &node.type_parameter.constraint {
                    $scanner.walk_ts_type(constraint);
                }
                if let Some(default) = &node.type_parameter.default {
                    $scanner.walk_ts_type(default);
                }
            }
            $enum::TSIntersectionType(node) => {
                for member in &node.types {
                    $scanner.walk_ts_type(member);
                }
            }
            $enum::TSUnionType(node) => {
                for member in &node.types {
                    $scanner.walk_ts_type(member);
                }
            }
            $enum::TSLiteralType(node) => match &node.literal {
                TSLiteral::TemplateLiteral(literal) => {
                    for expression in &literal.expressions {
                        $scanner.walk_expression(expression);
                    }
                }
                TSLiteral::UnaryExpression(expression) => $scanner.walk_expression(&expression.argument),
                _ => {}
            },
            $enum::TSMappedType(node) => {
                if let Some(name_type) = &node.name_type {
                    $scanner.walk_ts_type(name_type);
                }
                $scanner.walk_ts_type(&node.constraint);
                if let Some(annotation) = &node.type_annotation {
                    $scanner.walk_ts_type(annotation);
                }
            }
            $enum::TSNamedTupleMember(node) => $scanner.walk_tuple_element(&node.element_type),
            $enum::TSTemplateLiteralType(node) => {
                for member in &node.types {
                    $scanner.walk_ts_type(member);
                }
            }
            $enum::TSTupleType(node) => {
                for element in &node.element_types {
                    $scanner.walk_tuple_element(element);
                }
            }
            $enum::TSTypeLiteral(node) => $scanner.walk_ts_signatures(&node.members),
            $enum::TSTypeOperatorType(node) => $scanner.walk_ts_type(&node.type_annotation),
            $enum::TSTypePredicate(node) => {
                if let Some(annotation) = &node.type_annotation {
                    $scanner.walk_ts_type(&annotation.type_annotation);
                }
            }
            $enum::TSTypeQuery(node) => {
                if let TSTypeQueryExprName::TSImportType(import) = &node.expr_name {
                    if let Some(options) = &import.options {
                        $scanner.walk_object(options);
                    }
                    $scanner.walk_type_arguments(import.type_arguments.as_deref());
                }
                $scanner.walk_type_arguments(node.type_arguments.as_deref());
            }
            $enum::TSTypeReference(node) => $scanner.walk_type_arguments(node.type_arguments.as_deref()),
            $enum::TSParenthesizedType(node) => $scanner.walk_ts_type(&node.type_annotation),
            $enum::JSDocNullableType(node) => $scanner.walk_ts_type(&node.type_annotation),
            $enum::JSDocNonNullableType(node) => $scanner.walk_ts_type(&node.type_annotation),
            #[allow(unreachable_patterns)]
            _ => {}
        }
    };
}

/// The body of [`CodeScanner::walk_assignment_target`], reused for the enums that
/// inherit `AssignmentTarget`'s variants.
macro_rules! assignment_target_arms {
    ($scanner:ident, $enum:ident, $value:ident) => {
        match $value {
            $enum::AssignmentTargetIdentifier(_) => {}
            $enum::TSAsExpression(node) => {
                $scanner.walk_expression(&node.expression);
                $scanner.walk_ts_type(&node.type_annotation);
            }
            $enum::TSSatisfiesExpression(node) => {
                $scanner.walk_expression(&node.expression);
                $scanner.walk_ts_type(&node.type_annotation);
            }
            $enum::TSNonNullExpression(node) => {
                $scanner.walk_expression(&node.expression)
            }
            $enum::TSTypeAssertion(node) => {
                $scanner.walk_expression(&node.expression);
                $scanner.walk_ts_type(&node.type_annotation);
            }
            $enum::ComputedMemberExpression(node) => {
                $scanner.walk_expression(&node.object);
                $scanner.walk_expression(&node.expression);
            }
            $enum::StaticMemberExpression(node) => {
                $scanner.walk_expression(&node.object)
            }
            $enum::PrivateFieldExpression(node) => {
                $scanner.walk_expression(&node.object)
            }
            $enum::ArrayAssignmentTarget(node) => $scanner.walk_array_assignment(node),
            $enum::ObjectAssignmentTarget(node) => $scanner.walk_object_assignment(node),
            #[allow(unreachable_patterns)]
            _ => {}
        }
    };
}

impl<'a> CodeScanner<'a> {
    /// The absolute file offset of a byte offset inside the block.
    fn at(&self, byte: u32) -> Offset {
        self.base + self.code_map.to_utf16(byte as usize)
    }

    /// The absolute file offset of a node's start.
    fn start_of(&self, node: &impl GetSpan) -> Offset {
        self.at(node.span().start)
    }

    fn push_error(&mut self, code: &str, message: String, offset: Offset) {
        self.result.diagnostics.push(create_diagnostic(DiagnosticInput::error(
            code,
            message,
            location_at(self.source, self.relative_path, offset, 1),
        )));
    }

    // -- pass 1: bindings ---------------------------------------------------

    fn visit_import(&mut self, node: &ImportDeclaration<'_>) {
        let specifier = node.source.value.as_str().to_string();
        let Some(specifiers) = &node.specifiers else {
            return;
        };
        for entry in specifiers {
            let (imported_name, local_name) = match entry {
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => (
                    match &specifier.imported {
                        ModuleExportName::IdentifierName(name) => name.name.as_str().to_string(),
                        ModuleExportName::IdentifierReference(name) => {
                            name.name.as_str().to_string()
                        }
                        ModuleExportName::StringLiteral(_) => String::new(),
                    },
                    specifier.local.name.as_str().to_string(),
                ),
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                    ("default".to_string(), specifier.local.name.as_str().to_string())
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                    ("*".to_string(), specifier.local.name.as_str().to_string())
                }
            };
            if specifier == "$flamme" {
                for name in [&imported_name, &local_name] {
                    if !name.is_empty() {
                        self.result.imported_names.push(name.clone());
                    }
                }
                if imported_name == "graphql" && !local_name.is_empty() {
                    self.bound.insert(local_name.clone());
                }
            }
            if local_name.is_empty() {
                continue;
            }
            let resolved = if is_absolute(&specifier) {
                specifier.clone()
            } else {
                resolve_path(&dirname(self.file), &specifier)
            };
            self.result.set_binding(
                &local_name,
                ScanBinding::Import {
                    specifier: specifier.clone(),
                    imported: imported_name,
                    resolved: Some(resolved.clone()),
                },
            );
            if specifier_is_document(&self.document_extensions, &specifier) {
                self.result.imports.push(GqlImport {
                    file: self.file.to_string(),
                    relative_path: self.relative_path.to_string(),
                    specifier: specifier.clone(),
                    resolved: Some(resolved),
                    offset: self.start_of(node),
                    source: self.source.clone(),
                });
            }
        }
        // The reference implementation also carries a re-export block here, but an
        // `ImportDeclaration` never has an `exported` specifier, so it is dead code:
        // `export { X } from './y'` is an ExportNamedDeclaration.
    }

    fn visit_export_named(&mut self, node: &ExportNamedDeclaration<'_>) {
        let at = self.start_of(node);
        if let Some(declaration) = &node.declaration {
            for name in declared_names(declaration) {
                self.result.exports.push(ScanExport {
                    name: name.clone(),
                    local: name,
                    offset: at,
                });
            }
        }
        for entry in &node.specifiers {
            let exported = module_export_name(&entry.exported);
            let local = module_export_name(&entry.local);
            if !exported.is_empty() && !local.is_empty() {
                self.result.exports.push(ScanExport { name: exported, local, offset: at });
            }
        }
    }

    fn visit_export_default(&mut self, node: &ExportDefaultDeclaration<'_>) {
        let at = self.start_of(node);
        // `declaredNames` reads an `id` field, so an expression default
        // (`export default Page`) declares nothing at all.
        let name = match &node.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                function.id.as_ref().map(|id| id.name.as_str().to_string())
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                class.id.as_ref().map(|id| id.name.as_str().to_string())
            }
            ExportDefaultDeclarationKind::TSInterfaceDeclaration(interface) => {
                Some(interface.id.name.as_str().to_string())
            }
            _ => None,
        };
        if let Some(name) = name {
            self.result.exports.push(ScanExport {
                name: "default".to_string(),
                local: name,
                offset: at,
            });
        }
    }

    fn visit_variable_declarator(&mut self, node: &VariableDeclarator<'_>) {
        let init = node.init.as_ref();
        let id = &node.id;
        // `const { graphql } = require('$flamme')`
        if matches!(init, Some(Expression::CallExpression(_)))
            && matches!(id, BindingPattern::ObjectPattern(_))
        {
            let BindingPattern::ObjectPattern(pattern) = id else {
                return;
            };
            if let Some(Expression::CallExpression(call)) = init {
                let callee = match &call.callee {
                    Expression::Identifier(identifier) => identifier.name.as_str(),
                    _ => "",
                };
                let argument = match call.arguments.first() {
                    Some(Argument::StringLiteral(literal)) => literal.value.as_str(),
                    _ => "",
                };
                if callee == "require" && argument == "$flamme" {
                    for property in &pattern.properties {
                        let key = match &property.key {
                            PropertyKey::StaticIdentifier(name) => name.name.as_str(),
                            _ => "",
                        };
                        let value = match &property.value {
                            BindingPattern::BindingIdentifier(identifier) => {
                                identifier.name.as_str()
                            }
                            _ => "",
                        };
                        if key == "graphql" && !value.is_empty() {
                            self.bound.insert(value.to_string());
                        }
                    }
                }
            }
            return;
        }
        let BindingPattern::BindingIdentifier(identifier) = id else {
            return;
        };
        let name = identifier.name.as_str().to_string();
        let alias = match init {
            Some(Expression::Identifier(identifier)) if !identifier.name.is_empty() => {
                Some(identifier.name.as_str().to_string())
            }
            _ => None,
        };
        let document = match init {
            Some(Expression::TaggedTemplateExpression(tagged)) => match &tagged.tag {
                Expression::Identifier(identifier) => self.bound.contains(identifier.name.as_str()),
                _ => false,
            },
            Some(Expression::CallExpression(call)) => match &call.callee {
                Expression::Identifier(identifier) => self.bound.contains(identifier.name.as_str()),
                _ => false,
            },
            _ => false,
        };
        self.declarations.push(DocDeclaration {
            name,
            init_start: init.map(|init| i64::from(self.start_of(init))).unwrap_or(-1),
            alias,
            document,
        });
    }

    // -- pass 2: candidates -------------------------------------------------

    fn visit_tagged_template(&mut self, node: &TaggedTemplateExpression<'_>) {
        let Expression::Identifier(identifier) = &node.tag else {
            return;
        };
        let name = identifier.name.as_str();
        if name.is_empty() {
            return;
        }
        if !self.bound.contains(name) {
            if name == "graphql" {
                self.result.unbound.push(self.start_of(node));
            }
            return;
        }
        if let Some(candidate) = self.read_template_literal(&node.quasi) {
            let at = self.start_of(node);
            self.candidate_at.insert(at, self.result.candidates.len());
            self.result.candidates.push(candidate);
        }
    }

    fn visit_call_expression(&mut self, node: &CallExpression<'_>) {
        let Expression::Identifier(identifier) = &node.callee else {
            return;
        };
        let name = identifier.name.as_str();
        if name.is_empty() {
            return;
        }
        if !self.bound.contains(name) {
            if name == "graphql" {
                self.result.unbound.push(self.start_of(node));
            }
            return;
        }
        let arguments = &node.arguments;
        if arguments.len() == 1 {
            match &arguments[0] {
                Argument::TemplateLiteral(literal) => {
                    if let Some(candidate) = self.read_template_literal(literal) {
                        let at = self.start_of(node);
                        self.candidate_at.insert(at, self.result.candidates.len());
                        self.result.candidates.push(candidate);
                    }
                    return;
                }
                Argument::StringLiteral(literal) => {
                    let start = self.at(literal.span.start) + 1;
                    let end = self.at(literal.span.end) - 1;
                    let cooked = cook_template(
                        &self.source_map.slice(self.source.as_str(), start, end),
                        start,
                    );
                    let at = self.start_of(node);
                    self.candidate_at.insert(at, self.result.candidates.len());
                    self.result.candidates.push(cooked.into_candidate(start));
                    return;
                }
                _ => {}
            }
        }
        let at = self.start_of(node);
        self.push_error(
            "FLM1011",
            format!("{}: graphql(…) must be called with exactly one static string.", self.relative_path),
            at,
        );
    }

    fn read_template_literal(&mut self, quasi: &TemplateLiteral<'_>) -> Option<Candidate> {
        if quasi.quasis.len() != 1 || !quasi.expressions.is_empty() {
            let at = self.start_of(quasi);
            self.push_error(
                "FLM1011",
                format!(
                    "{}: graphql`…` must be a static string; interpolation is not supported.",
                    self.relative_path
                ),
                at,
            );
            return None;
        }
        // The enclosing `TemplateLiteral` is backtick-inclusive, so the document's
        // source span is one character narrower on each side.
        let start = self.at(quasi.span.start) + 1;
        let end = self.at(quasi.span.end) - 1;
        let cooked =
            cook_template(&self.source_map.slice(self.source.as_str(), start, end), start);
        Some(cooked.into_candidate(start))
    }

    fn visit_graphql_type_alias(&mut self, node: &TSTypeAliasDeclaration<'_>) {
        self.report_graphql_type(&node.type_annotation, self.start_of(node));
    }

    fn visit_graphql_property_signature(&mut self, node: &TSPropertySignature<'_>) {
        let Some(annotation) = &node.type_annotation else {
            return;
        };
        self.report_graphql_type(&annotation.type_annotation, self.start_of(node));
    }

    /// FLM1022: `GraphQL<…>` is never a document surface.
    fn report_graphql_type(&mut self, annotation: &TSType<'_>, at: Offset) {
        let TSType::TSTypeReference(reference) = annotation else {
            return;
        };
        let name = match &reference.type_name {
            TSTypeName::IdentifierReference(identifier) => identifier.name.as_str(),
            _ => "",
        };
        if name != "GraphQL" {
            return;
        }
        if reference.type_arguments.is_none() {
            // A bare `GraphQL` reference is not a document surface at all.
            return;
        }
        let where_ = location_at(self.source, self.relative_path, at, 1);
        self.result.diagnostics.push(create_diagnostic(DiagnosticInput::error(
            "FLM1022",
            format!(
                "{}:{}:{} GraphQL<…> is not a supported document surface; use a .graphql/.gql file, a graphql`…` tag, or the Page export of a +page.ts.",
                where_.file, where_.line, where_.column
            ),
            where_,
        )));
    }

    // -- the traversal ------------------------------------------------------

    fn walk_program(&mut self, program: &Program<'_>) {
        for statement in &program.body {
            self.walk_statement(statement);
        }
    }

    fn walk_block(&mut self, block: &BlockStatement<'_>) {
        for statement in &block.body {
            self.walk_statement(statement);
        }
    }

    fn walk_function_body(&mut self, body: &FunctionBody<'_>) {
        for statement in &body.statements {
            self.walk_statement(statement);
        }
    }

    fn walk_statement(&mut self, statement: &Statement<'_>) {
        match statement {
            Statement::BlockStatement(node) => self.walk_block(node),
            Statement::BreakStatement(_)
            | Statement::ContinueStatement(_)
            | Statement::DebuggerStatement(_)
            | Statement::EmptyStatement(_) => {}
            Statement::DoWhileStatement(node) => {
                self.walk_statement(&node.body);
                self.walk_expression(&node.test);
            }
            Statement::ExpressionStatement(node) => self.walk_expression(&node.expression),
            Statement::ForInStatement(node) => {
                self.walk_for_left(&node.left);
                self.walk_expression(&node.right);
                self.walk_statement(&node.body);
            }
            Statement::ForOfStatement(node) => {
                self.walk_for_left(&node.left);
                self.walk_expression(&node.right);
                self.walk_statement(&node.body);
            }
            Statement::ForStatement(node) => {
                if let Some(init) = &node.init {
                    match init {
                        ForStatementInit::VariableDeclaration(declaration) => {
                            self.walk_variable_declaration(declaration)
                        }
                        other => inherited_expression_arms!(self, ForStatementInit, other),
                    }
                }
                if let Some(test) = &node.test {
                    self.walk_expression(test);
                }
                if let Some(update) = &node.update {
                    self.walk_expression(update);
                }
                self.walk_statement(&node.body);
            }
            Statement::IfStatement(node) => {
                self.walk_expression(&node.test);
                self.walk_statement(&node.consequent);
                if let Some(alternate) = &node.alternate {
                    self.walk_statement(alternate);
                }
            }
            Statement::LabeledStatement(node) => self.walk_statement(&node.body),
            Statement::ReturnStatement(node) => {
                if let Some(argument) = &node.argument {
                    self.walk_expression(argument);
                }
            }
            Statement::SwitchStatement(node) => {
                self.walk_expression(&node.discriminant);
                for case in &node.cases {
                    if let Some(test) = &case.test {
                        self.walk_expression(test);
                    }
                    for statement in &case.consequent {
                        self.walk_statement(statement);
                    }
                }
            }
            Statement::ThrowStatement(node) => self.walk_expression(&node.argument),
            Statement::TryStatement(node) => {
                self.walk_block(&node.block);
                if let Some(handler) = &node.handler {
                    if let Some(param) = &handler.param {
                        self.walk_pattern(&param.pattern);
                        if let Some(annotation) = &param.type_annotation {
                            self.walk_ts_type(&annotation.type_annotation);
                        }
                    }
                    self.walk_block(&handler.body);
                }
                if let Some(finalizer) = &node.finalizer {
                    self.walk_block(finalizer);
                }
            }
            Statement::WhileStatement(node) => {
                self.walk_expression(&node.test);
                self.walk_statement(&node.body);
            }
            Statement::WithStatement(node) => {
                self.walk_expression(&node.object);
                self.walk_statement(&node.body);
            }
            Statement::VariableDeclaration(node) => self.walk_variable_declaration(node),
            Statement::FunctionDeclaration(node) => self.walk_function(node),
            Statement::ClassDeclaration(node) => self.walk_class(node),
            Statement::TSTypeAliasDeclaration(node) => self.walk_type_alias(node),
            Statement::TSInterfaceDeclaration(node) => {
                self.walk_type_parameters(node.type_parameters.as_deref());
                for heritage in &node.extends {
                    self.walk_expression(&heritage.expression);
                    self.walk_type_arguments(heritage.type_arguments.as_deref());
                }
                self.walk_ts_signatures(&node.body.body);
            }
            Statement::TSEnumDeclaration(node) => self.walk_enum(node),
            Statement::TSModuleDeclaration(node) => self.walk_module(node),
            Statement::TSGlobalDeclaration(node) => self.walk_global(node),
            Statement::TSImportEqualsDeclaration(node) => self.walk_import_equals(node),
            Statement::ImportDeclaration(node) => {
                if self.pass == Pass::Bindings {
                    self.visit_import(node);
                }
            }
            Statement::ExportAllDeclaration(_) => {}
            Statement::ExportDefaultDeclaration(node) => {
                if self.pass == Pass::Bindings {
                    self.visit_export_default(node);
                }
                match &node.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        self.walk_function(function)
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => self.walk_class(class),
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(interface) => {
                        self.walk_ts_signatures(&interface.body.body)
                    }
                    other => {
                        inherited_expression_arms!(self, ExportDefaultDeclarationKind, other)
                    }
                }
            }
            Statement::ExportNamedDeclaration(node) => {
                if self.pass == Pass::Bindings {
                    self.visit_export_named(node);
                }
                if let Some(declaration) = &node.declaration {
                    self.walk_declaration(declaration);
                }
            }
            Statement::TSExportAssignment(node) => self.walk_expression(&node.expression),
            Statement::TSNamespaceExportDeclaration(_) => {}
        }
    }

    fn walk_declaration(&mut self, declaration: &Declaration<'_>) {
        match declaration {
            Declaration::VariableDeclaration(node) => self.walk_variable_declaration(node),
            Declaration::FunctionDeclaration(node) => self.walk_function(node),
            Declaration::ClassDeclaration(node) => self.walk_class(node),
            Declaration::TSTypeAliasDeclaration(node) => self.walk_type_alias(node),
            Declaration::TSInterfaceDeclaration(node) => {
                self.walk_type_parameters(node.type_parameters.as_deref());
                self.walk_ts_signatures(&node.body.body);
            }
            Declaration::TSEnumDeclaration(node) => self.walk_enum(node),
            Declaration::TSModuleDeclaration(node) => self.walk_module(node),
            Declaration::TSGlobalDeclaration(node) => self.walk_global(node),
            Declaration::TSImportEqualsDeclaration(node) => self.walk_import_equals(node),
        }
    }

    fn walk_type_alias(&mut self, node: &TSTypeAliasDeclaration<'_>) {
        self.walk_type_parameters(node.type_parameters.as_deref());
        if self.pass == Pass::Candidates {
            self.visit_graphql_type_alias(node);
        }
        self.walk_ts_type(&node.type_annotation);
    }

    fn walk_variable_declaration(&mut self, node: &VariableDeclaration<'_>) {
        for declarator in &node.declarations {
            if self.pass == Pass::Bindings {
                self.visit_variable_declarator(declarator);
            }
            if let Some(annotation) = &declarator.type_annotation {
                self.walk_ts_type(&annotation.type_annotation);
            }
            if let Some(init) = &declarator.init {
                self.walk_expression(init);
            }
        }
    }

    fn walk_function(&mut self, node: &Function<'_>) {
        self.walk_type_parameters(node.type_parameters.as_deref());
        if let Some(this_param) = &node.this_param {
            if let Some(annotation) = &this_param.type_annotation {
                self.walk_ts_type(&annotation.type_annotation);
            }
        }
        self.walk_parameters(&node.params);
        if let Some(annotation) = &node.return_type {
            self.walk_ts_type(&annotation.type_annotation);
        }
        if let Some(body) = &node.body {
            self.walk_function_body(body);
        }
    }

    fn walk_arrow(&mut self, node: &ArrowFunctionExpression<'_>) {
        self.walk_type_parameters(node.type_parameters.as_deref());
        self.walk_parameters(&node.params);
        if let Some(annotation) = &node.return_type {
            self.walk_ts_type(&annotation.type_annotation);
        }
        self.walk_function_body(&node.body);
    }

    fn walk_parameters(&mut self, node: &FormalParameters<'_>) {
        for parameter in &node.items {
            for decorator in &parameter.decorators {
                self.walk_expression(&decorator.expression);
            }
            self.walk_pattern(&parameter.pattern);
            if let Some(annotation) = &parameter.type_annotation {
                self.walk_ts_type(&annotation.type_annotation);
            }
            if let Some(initializer) = &parameter.initializer {
                self.walk_expression(initializer);
            }
        }
        if let Some(rest) = &node.rest {
            for decorator in &rest.decorators {
                self.walk_expression(&decorator.expression);
            }
            self.walk_rest_element(&rest.rest);
            if let Some(annotation) = &rest.type_annotation {
                self.walk_ts_type(&annotation.type_annotation);
            }
        }
    }

    fn walk_class(&mut self, node: &Class<'_>) {
        for decorator in &node.decorators {
            self.walk_expression(&decorator.expression);
        }
        self.walk_type_parameters(node.type_parameters.as_deref());
        if let Some(super_class) = &node.super_class {
            self.walk_expression(super_class);
        }
        for element in &node.body.body {
            match element {
                ClassElement::StaticBlock(block) => {
                    for statement in &block.body {
                        self.walk_statement(statement);
                    }
                }
                ClassElement::MethodDefinition(method) => {
                    for decorator in &method.decorators {
                        self.walk_expression(&decorator.expression);
                    }
                    self.walk_property_key(&method.key);
                    self.walk_function(&method.value);
                }
                ClassElement::PropertyDefinition(property) => {
                    for decorator in &property.decorators {
                        self.walk_expression(&decorator.expression);
                    }
                    self.walk_property_key(&property.key);
                    if let Some(annotation) = &property.type_annotation {
                        self.walk_ts_type(&annotation.type_annotation);
                    }
                    if let Some(value) = &property.value {
                        self.walk_expression(value);
                    }
                }
                ClassElement::AccessorProperty(property) => {
                    for decorator in &property.decorators {
                        self.walk_expression(&decorator.expression);
                    }
                    self.walk_property_key(&property.key);
                    if let Some(annotation) = &property.type_annotation {
                        self.walk_ts_type(&annotation.type_annotation);
                    }
                    if let Some(value) = &property.value {
                        self.walk_expression(value);
                    }
                }
                ClassElement::TSIndexSignature(signature) => self.walk_index_signature(signature),
            }
        }
    }

    fn walk_enum(&mut self, node: &TSEnumDeclaration<'_>) {
        for member in &node.body.members {
            if let Some(initializer) = &member.initializer {
                self.walk_expression(initializer);
            }
        }
    }

    fn walk_module(&mut self, node: &TSModuleDeclaration<'_>) {
        match &node.body {
            Some(TSModuleDeclarationBody::TSModuleBlock(block)) => {
                for statement in &block.body {
                    self.walk_statement(statement);
                }
            }
            Some(TSModuleDeclarationBody::TSModuleDeclaration(inner)) => self.walk_module(inner),
            None => {}
        }
    }

    fn walk_global(&mut self, node: &TSGlobalDeclaration<'_>) {
        for statement in &node.body.body {
            self.walk_statement(statement);
        }
    }

    fn walk_import_equals(&mut self, node: &TSImportEqualsDeclaration<'_>) {
        match &node.module_reference {
            TSModuleReference::ExternalModuleReference(_) => {}
            TSModuleReference::IdentifierReference(_) | TSModuleReference::QualifiedName(_) => {}
        }
    }

    fn walk_expression(&mut self, expression: &Expression<'_>) {
        inherited_expression_arms!(self, Expression, expression);
    }


    fn walk_array_element(&mut self, element: &ArrayExpressionElement<'_>) {
        match element {
            ArrayExpressionElement::SpreadElement(spread) => {
                self.walk_expression(&spread.argument)
            }
            ArrayExpressionElement::Elision(_) => {}
            other => inherited_expression_arms!(self, ArrayExpressionElement, other),
        }
    }

    fn walk_argument(&mut self, argument: &Argument<'_>) {
        match argument {
            Argument::SpreadElement(spread) => self.walk_expression(&spread.argument),
            other => inherited_expression_arms!(self, Argument, other),
        }
    }

    fn walk_object(&mut self, node: &ObjectExpression<'_>) {
        for property in &node.properties {
            match property {
                ObjectPropertyKind::ObjectProperty(property) => {
                    self.walk_property_key(&property.key);
                    self.walk_expression(&property.value);
                }
                ObjectPropertyKind::SpreadProperty(spread) => {
                    self.walk_expression(&spread.argument)
                }
            }
        }
    }

    fn walk_property_key(&mut self, key: &PropertyKey<'_>) {
        match key {
            PropertyKey::StaticIdentifier(_) | PropertyKey::PrivateIdentifier(_) => {}
            other => inherited_expression_arms!(self, PropertyKey, other),
        }
    }

    fn walk_jsx_element(&mut self, node: &JSXElement<'_>) {
        for attribute in &node.opening_element.attributes {
            match attribute {
                JSXAttributeItem::Attribute(attribute) => match &attribute.value {
                    Some(JSXAttributeValue::StringLiteral(_)) | None => {}
                    Some(JSXAttributeValue::ExpressionContainer(container)) => {
                        self.walk_jsx_expression(&container.expression);
                    }
                    Some(JSXAttributeValue::Element(element)) => self.walk_jsx_element(element),
                    Some(JSXAttributeValue::Fragment(fragment)) => {
                        self.walk_jsx_fragment(fragment)
                    }
                },
                JSXAttributeItem::SpreadAttribute(attribute) => {
                    self.walk_expression(&attribute.argument)
                }
            }
        }
        for child in &node.children {
            self.walk_jsx_child(child);
        }
    }

    fn walk_jsx_fragment(&mut self, node: &JSXFragment<'_>) {
        for child in &node.children {
            self.walk_jsx_child(child);
        }
    }

    fn walk_jsx_child(&mut self, child: &JSXChild<'_>) {
        match child {
            JSXChild::Text(_) => {}
            JSXChild::Element(element) => self.walk_jsx_element(element),
            JSXChild::Fragment(fragment) => self.walk_jsx_fragment(fragment),
            JSXChild::ExpressionContainer(container) => {
                self.walk_jsx_expression(&container.expression)
            }
            JSXChild::Spread(spread) => self.walk_expression(&spread.expression),
        }
    }

    fn walk_jsx_expression(&mut self, expression: &JSXExpression<'_>) {
        match expression {
            JSXExpression::EmptyExpression(_) => {}
            other => inherited_expression_arms!(self, JSXExpression, other),
        }
    }

    fn walk_pattern(&mut self, pattern: &BindingPattern<'_>) {
        match pattern {
            BindingPattern::BindingIdentifier(_) => {}
            BindingPattern::ObjectPattern(object) => {
                for property in &object.properties {
                    self.walk_binding_property(property);
                }
                if let Some(rest) = &object.rest {
                    self.walk_rest_element(rest);
                }
            }
            BindingPattern::ArrayPattern(array) => {
                for element in array.elements.iter().flatten() {
                    self.walk_pattern(element);
                }
                if let Some(rest) = &array.rest {
                    self.walk_rest_element(rest);
                }
            }
            BindingPattern::AssignmentPattern(assignment) => {
                self.walk_pattern(&assignment.left);
                self.walk_expression(&assignment.right);
            }
        }
    }

    fn walk_binding_property(&mut self, node: &BindingProperty<'_>) {
        self.walk_property_key(&node.key);
        self.walk_pattern(&node.value);
    }

    fn walk_rest_element(&mut self, node: &BindingRestElement<'_>) {
        self.walk_pattern(&node.argument);
    }

    fn walk_assignment_target(&mut self, target: &AssignmentTarget<'_>) {
        assignment_target_arms!(self, AssignmentTarget, target);
    }

    fn walk_simple_target(&mut self, target: &SimpleAssignmentTarget<'_>) {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(_) => {}
            SimpleAssignmentTarget::TSAsExpression(node) => {
                self.walk_expression(&node.expression);
                self.walk_ts_type(&node.type_annotation);
            }
            SimpleAssignmentTarget::TSSatisfiesExpression(node) => {
                self.walk_expression(&node.expression);
                self.walk_ts_type(&node.type_annotation);
            }
            SimpleAssignmentTarget::TSNonNullExpression(node) => {
                self.walk_expression(&node.expression)
            }
            SimpleAssignmentTarget::TSTypeAssertion(node) => {
                self.walk_expression(&node.expression);
                self.walk_ts_type(&node.type_annotation);
            }
            SimpleAssignmentTarget::ComputedMemberExpression(node) => {
                self.walk_expression(&node.object);
                self.walk_expression(&node.expression);
            }
            SimpleAssignmentTarget::StaticMemberExpression(node) => {
                self.walk_expression(&node.object)
            }
            SimpleAssignmentTarget::PrivateFieldExpression(node) => {
                self.walk_expression(&node.object)
            }
        }
    }

    fn walk_array_assignment(&mut self, node: &ArrayAssignmentTarget<'_>) {
        for element in node.elements.iter().flatten() {
            self.walk_maybe_default(element);
        }
        if let Some(rest) = &node.rest {
            self.walk_assignment_target(&rest.target);
        }
    }

    fn walk_object_assignment(&mut self, node: &ObjectAssignmentTarget<'_>) {
        for property in &node.properties {
            match property {
                AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(identifier) => {
                    if let Some(init) = &identifier.init {
                        self.walk_expression(init);
                    }
                }
                AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                    self.walk_property_key(&property.name);
                    self.walk_maybe_default(&property.binding);
                }
            }
        }
        if let Some(rest) = &node.rest {
            self.walk_assignment_target(&rest.target);
        }
    }

    fn walk_maybe_default(&mut self, target: &AssignmentTargetMaybeDefault<'_>) {
        match target {
            AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) => {
                self.walk_assignment_target(&default.binding);
                self.walk_expression(&default.init);
            }
            other => assignment_target_arms!(self, AssignmentTargetMaybeDefault, other),
        }
    }

    fn walk_ts_signatures(&mut self, signatures: &[TSSignature<'_>]) {
        for signature in signatures {
            match signature {
                TSSignature::TSPropertySignature(property) => {
                    self.walk_property_key(&property.key);
                    if self.pass == Pass::Candidates {
                        self.visit_graphql_property_signature(property);
                    }
                    if let Some(annotation) = &property.type_annotation {
                        self.walk_ts_type(&annotation.type_annotation);
                    }
                }
                TSSignature::TSIndexSignature(signature) => self.walk_index_signature(signature),
                TSSignature::TSCallSignatureDeclaration(signature) => {
                    self.walk_type_parameters(signature.type_parameters.as_deref());
                    self.walk_parameters(&signature.params);
                    if let Some(annotation) = &signature.return_type {
                        self.walk_ts_type(&annotation.type_annotation);
                    }
                }
                TSSignature::TSConstructSignatureDeclaration(signature) => {
                    self.walk_type_parameters(signature.type_parameters.as_deref());
                    self.walk_parameters(&signature.params);
                    if let Some(annotation) = &signature.return_type {
                        self.walk_ts_type(&annotation.type_annotation);
                    }
                }
                TSSignature::TSMethodSignature(signature) => self.walk_method_signature(signature),
            }
        }
    }

    fn walk_index_signature(&mut self, node: &TSIndexSignature<'_>) {
        for parameter in &node.parameters {
            self.walk_ts_type(&parameter.type_annotation.type_annotation);
        }
        self.walk_ts_type(&node.type_annotation.type_annotation);
    }

    fn walk_method_signature(&mut self, node: &TSMethodSignature<'_>) {
        self.walk_property_key(&node.key);
        self.walk_type_parameters(node.type_parameters.as_deref());
        self.walk_parameters(&node.params);
        if let Some(annotation) = &node.return_type {
            self.walk_ts_type(&annotation.type_annotation);
        }
    }

    fn walk_type_parameters(&mut self, parameters: Option<&TSTypeParameterDeclaration<'_>>) {
        for parameter in parameters.iter().flat_map(|parameters| &parameters.params) {
            if let Some(constraint) = &parameter.constraint {
                self.walk_ts_type(constraint);
            }
            if let Some(default) = &parameter.default {
                self.walk_ts_type(default);
            }
        }
    }

    fn walk_type_arguments(&mut self, arguments: Option<&TSTypeParameterInstantiation<'_>>) {
        for argument in arguments.iter().flat_map(|arguments| &arguments.params) {
            self.walk_ts_type(argument);
        }
    }

    fn walk_ts_type(&mut self, node: &TSType<'_>) {
        ts_type_arms!(self, TSType, node);
    }


    fn walk_tuple_element(&mut self, element: &TSTupleElement<'_>) {
        match element {
            TSTupleElement::TSOptionalType(optional) => {
                self.walk_ts_type(&optional.type_annotation)
            }
            TSTupleElement::TSRestType(rest) => self.walk_ts_type(&rest.type_annotation),
            other => ts_type_arms!(self, TSTupleElement, other),
        }
    }

    /// The `left` half of a `for-in`/`for-of` statement.
    fn walk_for_left(&mut self, left: &ForStatementLeft<'_>) {
        match left {
            ForStatementLeft::VariableDeclaration(declaration) => {
                self.walk_variable_declaration(declaration)
            }
            other => assignment_target_arms!(self, ForStatementLeft, other),
        }
    }
}

/// Every identifier a declaration node binds (a `const` pattern's names included).
fn declared_names(declaration: &Declaration<'_>) -> Vec<String> {
    match declaration {
        Declaration::VariableDeclaration(node) => node
            .declarations
            .iter()
            .filter_map(|declarator| match &declarator.id {
                BindingPattern::BindingIdentifier(identifier) => {
                    Some(identifier.name.as_str().to_string())
                }
                _ => None,
            })
            .filter(|name| !name.is_empty())
            .collect(),
        Declaration::FunctionDeclaration(node) => {
            node.id.as_ref().map(|id| id.name.as_str().to_string()).into_iter().collect()
        }
        Declaration::ClassDeclaration(node) => {
            node.id.as_ref().map(|id| id.name.as_str().to_string()).into_iter().collect()
        }
        Declaration::TSTypeAliasDeclaration(node) => vec![node.id.name.as_str().to_string()],
        Declaration::TSInterfaceDeclaration(node) => vec![node.id.name.as_str().to_string()],
        Declaration::TSEnumDeclaration(node) => vec![node.id.name.as_str().to_string()],
        Declaration::TSModuleDeclaration(node) => match &node.id {
            TSModuleDeclarationName::Identifier(identifier) => {
                vec![identifier.name.as_str().to_string()]
            }
            TSModuleDeclarationName::StringLiteral(_) => Vec::new(),
        },
        Declaration::TSGlobalDeclaration(_) => Vec::new(),
        Declaration::TSImportEqualsDeclaration(node) => vec![node.id.name.as_str().to_string()],
    }
}

/// `stringField(childNode(node, 'exported'), 'name')` for one module export name.
fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.as_str().to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.as_str().to_string(),
        ModuleExportName::StringLiteral(_) => String::new(),
    }
}

/// True when an Oxc diagnostic carries the error severity.
fn is_error_severity(severity: &impl std::fmt::Debug) -> bool {
    format!("{severity:?}") == "Error"
}

/// Scans one code block for `graphql` tagged templates, `graphql(…)` calls and
/// `GraphQL<\`…\`>` type signatures (`scanCode` in `extract.ts`).
pub(crate) fn scan_code(
    code: &str,
    file: &str,
    relative_path: &str,
    offset: Offset,
    source: &SourceText,
    lang: &str,
) -> ScanResult {
    scan_code_with_extensions(code, file, relative_path, offset, source, lang, &[])
}

/// [`scan_code`] with the project's document extensions: an import whose specifier ends with one of
/// them is a document import (FLM1017), which is what `routing.documentExtensions` decides.
pub(crate) fn scan_code_with_extensions(
    code: &str,
    file: &str,
    relative_path: &str,
    offset: Offset,
    source: &SourceText,
    lang: &str,
    document_extensions: &[String],
) -> ScanResult {
    let mut scanner = CodeScanner {
        code_map: Utf16Map::new(code),
        base: offset,
        file,
        relative_path,
        source,
        source_map: Utf16Map::new(source.as_str()),
        result: ScanResult::new(),
        bound: HashSet::new(),
        declarations: Vec::new(),
        candidate_at: HashMap::new(),
        pass: Pass::Bindings,
        document_extensions,
    };
    let allocator = Allocator::default();
    let source_type = match lang {
        "ts" => SourceType::ts(),
        "tsx" => SourceType::tsx(),
        // Babel's `jsx` plugin was enabled for `.js` too.
        _ => SourceType::jsx(),
    };
    let parsed = Parser::new(&allocator, code, source_type)
        .with_options(ParseOptions { preserve_parens: false, ..ParseOptions::default() })
        .parse();
    // Oxc's parser does not perform the early-error checks Babel did while parsing
    // (duplicate lexical declarations, `break` outside a loop, …), so the oracle turns
    // `showSemanticErrors` on and oxc's semantic pass reports them. The parser's own
    // errors come first; the semantic ones are the tail of the same list there.
    let failure = parsed
        .errors
        .iter()
        .find(|entry| is_error_severity(&entry.severity))
        .cloned()
        .or_else(|| {
            oxc_semantic::SemanticBuilder::new()
                .with_check_syntax_error(true)
                .build(&parsed.program)
                .errors
                .into_iter()
                .find(|entry| is_error_severity(&entry.severity))
        });
    if let Some(failure) = failure {
        let message = match failure.labels.as_ref().and_then(|labels| labels.first()) {
            Some(label) => {
                let code_map = Utf16Map::new(code);
                let code_text = SourceText::new(code);
                let where_ =
                    location_at(&code_text, relative_path, code_map.to_utf16(label.offset()), 1);
                format!("{} ({}:{})", failure.message, where_.line, where_.column)
            }
            None => failure.message.to_string(),
        };
        scanner.result.diagnostics.push(create_diagnostic(DiagnosticInput::error(
            "FLM1011",
            format!("{relative_path}: cannot parse the script block: {message}"),
            location_at(source, relative_path, offset, 1),
        )));
        return scanner.result;
    }

    scanner.walk_program(&parsed.program);
    scanner.pass = Pass::Candidates;
    scanner.walk_program(&parsed.program);

    // Pass 3: name bindings, now that every candidate has an index.
    let declarations = std::mem::take(&mut scanner.declarations);
    for declaration in declarations {
        if declaration.document {
            let index = scanner.candidate_at.get(&(declaration.init_start as Offset)).copied();
            scanner.result.set_binding(
                &declaration.name,
                match index {
                    Some(index) => ScanBinding::Document(index),
                    None => ScanBinding::Other,
                },
            );
            continue;
        }
        scanner.result.set_binding(
            &declaration.name,
            match declaration.alias {
                Some(alias) => ScanBinding::Alias(alias),
                None => ScanBinding::Other,
            },
        );
    }

    scanner.result
}

/// A candidate whose text is already the source text (a `.gql` file).
fn plain_candidate(text: &str, start: Offset) -> Candidate {
    let units: Vec<u16> = text.encode_utf16().collect();
    let source_offsets = (0..=units.len() as u32).map(|index| start + index).collect();
    Candidate { text: text.to_string(), units, offset: start, source_offsets }
}

/// The document name of one candidate's cooked code units, or the empty string when
/// it does not parse. A lone surrogate never parses, so it has no name.
pub(crate) fn document_name_of(units: &[u16], text: &str) -> String {
    match crate::graphql::parse_document_units(units, text) {
        Ok(document) => match document.definitions.first() {
            Some(Definition::Operation(operation)) => {
                operation.name.as_ref().map(|name| name.value.clone()).unwrap_or_default()
            }
            Some(Definition::Fragment(fragment)) => fragment.name.value.clone(),
            // A type system definition names a type, not an artifact, so it has no
            // document name; the extraction rejects the document before it is named.
            Some(Definition::TypeSystem(_)) | None => String::new(),
        },
        Err(_) => String::new(),
    }
}

/// The kind of one parsed definition, or `None` when it cannot become an artifact.
fn kind_of(definition: &Definition) -> Option<ArtifactKind> {
    match definition {
        Definition::Operation(operation) => match operation.operation {
            OperationType::Query => Some(ArtifactKind::Query),
            OperationType::Mutation => Some(ArtifactKind::Mutation),
            OperationType::Subscription => Some(ArtifactKind::Subscription),
        },
        Definition::Fragment(_) => Some(ArtifactKind::Fragment),
        // graphql-js parses a type system definition in a document and the oracle
        // rejects it at extraction with `only operations and fragments can be compiled
        // into artifacts.`, which is exactly this `None`.
        Definition::TypeSystem(_) => None,
    }
}

/// The name of one parsed definition.
fn name_of(definition: &Definition) -> String {
    match definition {
        Definition::Operation(operation) => {
            operation.name.as_ref().map(|name| name.value.clone()).unwrap_or_default()
        }
        Definition::Fragment(fragment) => fragment.name.value.clone(),
        Definition::TypeSystem(_) => String::new(),
    }
}

/// The file offset of the character at `line`/`column` (1-based) of a document.
///
/// Positions are counted in UTF-16 code units, which is what the parser reports and
/// what a lone surrogate occupies exactly one of.
fn local_index(candidate: &Candidate, line: u32, column: u32) -> u32 {
    let mut current_line = 1u32;
    let mut index = 0usize;
    while index < candidate.units.len() {
        if current_line == line {
            break;
        }
        if candidate.units[index] == u16::from(b'\n') {
            current_line += 1;
        }
        index += 1;
    }
    (index as u32 + column.saturating_sub(1)).min(candidate.units.len() as u32)
}

/// The absolute file offset of the document's character at `index`.
fn absolute_at(candidate: &Candidate, index: u32) -> Offset {
    let clamped = index.min(candidate.units.len() as u32) as usize;
    match candidate.source_offsets.get(clamped) {
        Some(offset) => *offset,
        None => candidate.offset,
    }
}

/// Parses one candidate into a `RawDocument`, reporting FLM1011 when malformed.
fn document_from_candidate(
    candidate: &Candidate,
    file: &str,
    relative_path: &str,
    source: &SourceText,
    surface: DocumentSurface,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<RawDocument> {
    // The code units, not `candidate.text`: a cooked lone surrogate has to reach the
    // lexer to produce the error the oracle produces.
    let ast = match crate::graphql::parse_document_units(&candidate.units, &candidate.text) {
        Ok(ast) => ast,
        Err(error) => {
            // The parser's own position is the offending character, so map it back
            // to the file instead of reporting the document start.
            let local = local_index(candidate, error.line, error.column);
            let where_ = location_at(source, relative_path, absolute_at(candidate, local), 1);
            diagnostics.push(create_diagnostic(DiagnosticInput::error(
                "FLM1011",
                format!(
                    "{}:{}:{} cannot parse the document: {}",
                    where_.file, where_.line, where_.column, error.message
                ),
                where_,
            )));
            return None;
        }
    };
    if ast.definitions.len() != 1 {
        let where_ = location_at(source, relative_path, candidate.offset, 1);
        diagnostics.push(create_diagnostic(DiagnosticInput::error(
            "FLM1011",
            format!(
                "{}:{}:{} a document must contain exactly one operation or fragment, found {}.",
                where_.file,
                where_.line,
                where_.column,
                ast.definitions.len()
            ),
            where_,
        )));
        return None;
    }
    let definition = ast.definitions.first()?;
    let Some(kind) = kind_of(definition) else {
        let where_ = location_at(source, relative_path, candidate.offset, 1);
        diagnostics.push(create_diagnostic(DiagnosticInput::error(
            "FLM1011",
            format!(
                "{}:{}:{} only operations and fragments can be compiled into artifacts.",
                where_.file, where_.line, where_.column
            ),
            where_,
        )));
        return None;
    };
    let name = name_of(definition);
    let text_length = SourceText::new(&candidate.text).utf16_len() as usize;
    let start = candidate.source_offsets.first().copied().unwrap_or(candidate.offset);
    let end = candidate.source_offsets.get(text_length).copied().unwrap_or(candidate.offset);
    Some(RawDocument {
        name,
        kind,
        raw: candidate.text.clone(),
        file: file.to_string(),
        relative_path: relative_path.to_string(),
        surface,
        offset: candidate.offset,
        start,
        end,
        source_offsets: candidate.source_offsets.clone(),
        ast,
        source: source.clone(),
    })
}

// ---------------------------------------------------------------------------
// Per-file extraction
// ---------------------------------------------------------------------------

/// One file's contribution to an extraction.
#[derive(Clone, Debug, Default)]
pub struct FileResidue {
    /// The documents the file declares.
    pub documents: Vec<RawDocument>,
    /// The diagnostics extraction reported for it.
    pub diagnostics: Vec<Diagnostic>,
    /// The `.gql` imports it carries.
    pub imports: Vec<GqlImport>,
    /// The `$flamme` names it imports.
    pub imported_names: Vec<String>,
    /// The `<script src="…">` targets its extraction read from another file.
    pub dependencies: Vec<String>,
    /// The file's text, for the page-module pass; `None` when it cannot be used.
    pub source: Option<SourceText>,
}

/// One file's contribution, in the serializable form the incremental cache holds.
///
/// Every member is plain data: a document's parsed AST is rebuilt from its `raw`
/// on the way back in, and `text` carries the file so a reused file never has to
/// be read again (the `<script src>` and page-module passes read it).
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFileResidue {
    /// The file's exact text.
    pub text: String,
    /// `true` when the extraction could use the file as a source. A file it could
    /// not parse (an invalid component) reports `false`, and the page-module pass
    /// skips it exactly as a fresh extraction does.
    #[serde(default)]
    pub usable: bool,
    /// The documents the file declares.
    pub documents: Vec<CachedDocument>,
    /// The diagnostics extraction reported for it.
    pub diagnostics: Vec<Diagnostic>,
    /// The `.gql` imports it carries.
    pub imports: Vec<CachedImport>,
    /// The `$flamme` names it imports.
    pub imported_names: Vec<String>,
    /// The `<script src="…">` targets its extraction read from another file.
    pub dependencies: Vec<String>,
}

/// One extracted document, without its parsed AST or source text.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedDocument {
    /// The document name.
    pub name: String,
    /// The document's kind.
    pub kind: ArtifactKind,
    /// The document text as written.
    pub raw: String,
    /// Absolute path of the file the document came from.
    pub file: String,
    /// Posix path relative to `projectDir`.
    pub relative_path: String,
    /// `file`, `tag`, `script` or `module`.
    pub surface: String,
    /// Absolute offset of `raw[0]` in the file.
    pub offset: Offset,
    /// Absolute offset of the document's first source byte.
    pub start: Offset,
    /// Absolute offset just past the document's last source byte.
    pub end: Offset,
    /// `source_offsets[i]` is the absolute file offset of `raw[i]`.
    pub source_offsets: Vec<Offset>,
}

/// One `.gql` import, in the serializable form the incremental cache holds.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedImport {
    /// Absolute path of the importing file.
    pub file: String,
    /// Posix path of the importing file, relative to `projectDir`.
    pub relative_path: String,
    /// The specifier as written.
    pub specifier: String,
    /// Absolute path the specifier resolves to.
    pub resolved: Option<String>,
    /// Absolute offset of the import declaration.
    pub offset: Offset,
}

/// The surface spelling of one cached document, back as its enum.
fn surface_of(value: &str) -> DocumentSurface {
    match value {
        "tag" => DocumentSurface::Tag,
        "script" => DocumentSurface::Script,
        "module" => DocumentSurface::Module,
        "composed" => DocumentSurface::Composed,
        _ => DocumentSurface::File,
    }
}

/// The surface's spelling, as [`CachedDocument`] stores it.
fn surface_name(surface: DocumentSurface) -> &'static str {
    match surface {
        DocumentSurface::File => "file",
        DocumentSurface::Tag => "tag",
        DocumentSurface::Script => "script",
        DocumentSurface::Module => "module",
        DocumentSurface::Composed => "composed",
    }
}

/// The AST of a cached document: its `raw` re-parsed, which reproduces the tree
/// the original parse produced (`raw` is the printer's output for the parsed AST).
fn cached_ast(raw: &str) -> crate::graphql::ast::Document {
    crate::graphql::parse_document(raw)
        .unwrap_or(crate::graphql::ast::Document { definitions: Vec::new() })
}

impl FileResidue {
    /// This residue in the form the cache stores. `text` is the file's text as
    /// read: a file the extraction could not use still carries it, because a
    /// `<script src>` in another file may read it.
    pub fn to_cache(&self, text: &str) -> CachedFileResidue {
        CachedFileResidue {
            text: text.to_string(),
            usable: self.source.is_some(),
            documents: self
                .documents
                .iter()
                .map(|document| CachedDocument {
                    name: document.name.clone(),
                    kind: document.kind,
                    raw: document.raw.clone(),
                    file: document.file.clone(),
                    relative_path: document.relative_path.clone(),
                    surface: surface_name(document.surface).to_string(),
                    offset: document.offset,
                    start: document.start,
                    end: document.end,
                    source_offsets: document.source_offsets.clone(),
                })
                .collect(),
            diagnostics: self.diagnostics.clone(),
            imports: self
                .imports
                .iter()
                .map(|entry| CachedImport {
                    file: entry.file.clone(),
                    relative_path: entry.relative_path.clone(),
                    specifier: entry.specifier.clone(),
                    resolved: entry.resolved.clone(),
                    offset: entry.offset,
                })
                .collect(),
            imported_names: self.imported_names.clone(),
            dependencies: self.dependencies.clone(),
        }
    }
}

impl CachedFileResidue {
    /// The residue back, with every document's AST and source text rebuilt.
    pub fn to_residue(&self) -> FileResidue {
        let source = SourceText::new(self.text.clone());
        FileResidue {
            documents: self
                .documents
                .iter()
                .map(|document| RawDocument {
                    name: document.name.clone(),
                    kind: document.kind,
                    raw: document.raw.clone(),
                    file: document.file.clone(),
                    relative_path: document.relative_path.clone(),
                    surface: surface_of(&document.surface),
                    offset: document.offset,
                    start: document.start,
                    end: document.end,
                    source_offsets: document.source_offsets.clone(),
                    ast: cached_ast(&document.raw),
                    source: source.clone(),
                })
                .collect(),
            diagnostics: self.diagnostics.clone(),
            imports: self
                .imports
                .iter()
                .map(|entry| GqlImport {
                    file: entry.file.clone(),
                    relative_path: entry.relative_path.clone(),
                    specifier: entry.specifier.clone(),
                    resolved: entry.resolved.clone(),
                    offset: entry.offset,
                    source: source.clone(),
                })
                .collect(),
            imported_names: self.imported_names.clone(),
            dependencies: self.dependencies.clone(),
            source: if self.usable { Some(SourceText::new(self.text.clone())) } else { None },
        }
    }
}

/// Appends a document unless it is absent, keeping declaration order.
fn push_document(documents: &mut Vec<RawDocument>, document: Option<RawDocument>) {
    if let Some(document) = document {
        documents.push(document);
    }
}

/// The colocated document of a page module, as a project-relative posix path.
/// `true` when an import specifier names a document file under the configured extensions.
fn specifier_is_document(extensions: &[String], specifier: &str) -> bool {
    let lower = specifier.to_ascii_lowercase();
    let candidates: Vec<String> = if extensions.is_empty() {
        crate::config::default_document_extensions()
    } else {
        extensions.to_vec()
    };
    candidates.iter().any(|extension| lower.ends_with(extension.as_str()))
}

/// The existing sibling path of any document file name (`+page.gql`, `+page.graphql`).
fn colocated_document_any(relative_path: &str, file_names: &[String]) -> Option<String> {
    file_names.iter().find_map(|name| colocated_document(relative_path, name))
}

fn colocated_document(relative_path: &str, file_name: &str) -> Option<String> {
    if file_name.is_empty() || file_name.contains('/') {
        return None;
    }
    match relative_path.rfind('/') {
        Some(at) => Some(format!("{}/{}", &relative_path[..at], file_name)),
        None => Some(file_name.to_string()),
    }
}

/// Resolves one `<script src="…">` target to an in-project path, or reports FLM1011.
fn resolve_script_target(
    src: &str,
    entry: &SourceFile,
    source: &SourceText,
    offset: Offset,
    config: &RustConfig,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<(String, String)> {
    let absolute = if is_absolute(src) {
        src.to_string()
    } else {
        resolve_path(&dirname(&entry.absolute), src)
    };
    let relative = to_posix(&relative_path(&config.project_dir, &absolute));
    if relative.starts_with("..") || is_absolute(&relative) {
        diagnostics.push(create_diagnostic(DiagnosticInput::error(
            "FLM1011",
            format!("{}: src=\"{src}\" resolves outside the project.", entry.relative),
            location_at(source, &entry.relative, offset, 1),
        )));
        return None;
    }
    Some((absolute, relative))
}

/// The message Node's `fs.readFile` reports for this error, as closely as Rust can.
///
/// The oracle prints `errorMessage(error)` from `node:fs`, whose text starts with the
/// errno symbol; the port writes the same shape for the two failures a `<script src>`
/// target really produces, and falls back to Rust's own text for anything else.
fn read_error_message(error: &std::io::Error, absolute: &str) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => {
            format!("ENOENT: no such file or directory, open '{absolute}'")
        }
        std::io::ErrorKind::PermissionDenied => {
            format!("EACCES: permission denied, open '{absolute}'")
        }
        _ => error.to_string(),
    }
}

/// Extracts one prepared file: the per-file half of extraction.
fn extract_file(config: &RustConfig, entry: &SourceFile, files: &[SourceFile]) -> FileResidue {
    let mut residue = FileResidue {
        documents: Vec::new(),
        diagnostics: Vec::new(),
        imports: Vec::new(),
        imported_names: Vec::new(),
        dependencies: Vec::new(),
        source: None,
    };
    let source = SourceText::new(&entry.text);
    let extension = extname(&entry.relative).to_lowercase();

    if config.routing.has_document_extension(&extension) {
        if !entry.text.trim().is_empty() {
            let document = document_from_candidate(
                &plain_candidate(&entry.text, 0),
                &entry.absolute,
                &entry.relative,
                &source,
                DocumentSurface::File,
                &mut residue.diagnostics,
            );
            push_document(&mut residue.documents, document);
        }
        residue.source = Some(source);
        return residue;
    }

    if extension == ".vue" {
        let analysis = match analyze_vue_sfc(&entry.text, &entry.absolute) {
            Ok(analysis) => analysis,
            Err(error) => {
                residue.diagnostics.push(create_diagnostic(DiagnosticInput::error(
                    "FLM1011",
                    format!(
                        "{}: cannot parse the single file component: {}",
                        entry.relative, error.message
                    ),
                    SourceLocation {
                        file: entry.relative.clone(),
                        line: error.line,
                        column: error.column,
                        length: 1,
                    },
                )));
                return residue;
            }
        };
        residue.source = Some(source.clone());
        for block in &analysis.scripts {
            let mut target_file = entry.absolute.clone();
            let mut target_relative = entry.relative.clone();
            let mut content = block.content.clone();
            let mut target_source = source.clone();
            let mut target_offset = block.offset;
            if let Some(src) = &block.src {
                // The dependency pass ignores a target that leaves the project; the
                // read below reports it.
                let _ = resolve_script_target(src, entry, &source, 0, config, &mut Vec::new());
                let resolved = resolve_script_target(
                    src,
                    entry,
                    &source,
                    block.offset,
                    config,
                    &mut residue.diagnostics,
                );
                let Some((absolute, relative)) = resolved else {
                    continue;
                };
                // The oracle reads every `<script src>` target from disk, whether or
                // not the walk discovered it: a target the project's `include` globs
                // exclude still compiles. The walk's own text wins when it has the
                // file, so a caller's view of it is not read twice.
                let read = match files.iter().find(|file| file.relative == relative) {
                    Some(prepared) => Ok(prepared.text.clone()),
                    // `readFile(_, 'utf8')`: an invalid sequence is replaced, so only a
                    // real I/O failure is an error.
                    None => std::fs::read(&absolute)
                        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                        .map_err(|error| read_error_message(&error, &absolute)),
                };
                let text = match read {
                    Ok(text) => text,
                    Err(message) => {
                        residue.diagnostics.push(create_diagnostic(DiagnosticInput::error(
                            "FLM1011",
                            format!(
                                "{}: cannot read <script src=\"{src}\">: {message}",
                                entry.relative
                            ),
                            location_at(&source, &entry.relative, block.offset, 1),
                        )));
                        continue;
                    }
                };
                target_file = absolute;
                target_relative = relative;
                content = text.clone();
                target_source = SourceText::new(&text);
                target_offset = 0;
                // The incremental cache re-extracts this file when its target changed.
                // The oracle records the target even when the read failed.
                residue.dependencies.push(target_relative.clone());
            }
            let scanned = scan_code_with_extensions(
                &content,
                &target_file,
                &target_relative,
                target_offset,
                &target_source,
                &block.lang,
                &config.routing.document_extensions(),
            );
            residue.diagnostics.extend(scanned.diagnostics.iter().cloned());
            residue.imports.extend(scanned.imports.iter().cloned());
            residue.imported_names.extend(scanned.imported_names.iter().cloned());
            for candidate in &scanned.candidates {
                let document = document_from_candidate(
                    candidate,
                    &target_file,
                    &target_relative,
                    &target_source,
                    DocumentSurface::Script,
                    &mut residue.diagnostics,
                );
                let Some(document) = document else {
                    continue;
                };
                // A **query** in a `.vue` is a removed surface (FLM1027): the page's
                // query belongs to `+page.gql` or to the `Page` export of `+page.ts`.
                if document.kind == ArtifactKind::Query {
                    residue
                        .diagnostics
                        .push(inline_query_diagnostic(&document, config, &target_source));
                    continue;
                }
                residue.documents.push(document);
            }
            for offset in &scanned.unbound {
                residue.diagnostics.push(unbound_tag_diagnostic(
                    &target_relative,
                    &target_source,
                    *offset,
                ));
            }
        }
        return residue;
    }

    if extension == ".ts" || extension == ".tsx" || extension == ".js" || extension == ".jsx" {
        let lang = match extension.as_str() {
            ".tsx" => "tsx",
            ".ts" => "ts",
            _ => "jsx",
        };
        let scanned = scan_code_with_extensions(
            &entry.text,
            &entry.absolute,
            &entry.relative,
            0,
            &source,
            lang,
            &config.routing.document_extensions(),
        );
        residue.diagnostics.extend(scanned.diagnostics.iter().cloned());
        residue.imports.extend(scanned.imports.iter().cloned());
        residue.imported_names.extend(scanned.imported_names.iter().cloned());
        for candidate in &scanned.candidates {
            let document = document_from_candidate(
                candidate,
                &entry.absolute,
                &entry.relative,
                &source,
                DocumentSurface::Tag,
                &mut residue.diagnostics,
            );
            push_document(&mut residue.documents, document);
        }
        for offset in &scanned.unbound {
            residue.diagnostics.push(unbound_tag_diagnostic(&entry.relative, &source, *offset));
        }
    }

    residue.source = Some(source);
    residue
}

/// FLM1027: a **query** declared inline in a component is a removed surface.
fn inline_query_diagnostic(
    document: &RawDocument,
    config: &RustConfig,
    source: &SourceText,
) -> Diagnostic {
    let where_ = location_at(source, &document.relative_path, document.offset, 1);
    create_diagnostic(DiagnosticInput::error(
        "FLM1027",
        format!(
            "{}:{}:{} \"{}\" declares the query \"{}\" (operation \"{}\") in a component; move it to a colocated \"{}\" document or a \"{}\" Page export.",
            where_.file,
            where_.line,
            where_.column,
            where_.file,
            document.name,
            document.name,
            crate::page_module::routing_document_name(config, "page"),
            crate::page_module::PAGE_MODULE_FILE
        ),
        where_,
    ))
}

/// The unbound-tag warning: a `graphql` tag that is not ours.
fn unbound_tag_diagnostic(relative_path: &str, source: &SourceText, offset: Offset) -> Diagnostic {
    create_diagnostic(
        DiagnosticInput::warning(
            "FLM1011",
            format!(
                "{relative_path}: a graphql`…` tag is not bound to an import from '$flamme' and was ignored."
            ),
            location_at(source, relative_path, offset, 1),
        )
        .with_hint("import { graphql } from '$flamme'"),
    )
}

// ---------------------------------------------------------------------------
// Project extraction
// ---------------------------------------------------------------------------

/// Runs extraction over the files the TypeScript side discovered and read.
pub fn extract_project(config: &RustConfig, files: &[SourceFile]) -> ExtractResult {
    let stale: HashSet<String> = files.iter().map(|file| file.relative.clone()).collect();
    extract_project_cached(config, files, &stale, &HashMap::new()).0
}

/// Runs extraction over `files`, re-using the cached residue of every file whose
/// relative path is not in `stale`.
///
/// The assembly is identical either way: a reused residue replaces work, never a
/// decision, so an incremental extraction is byte-identical to a cold one. The
/// second half of the return value is the per-file record of every file this run
/// covered, for the next run's cache.
pub fn extract_project_cached(
    config: &RustConfig,
    files: &[SourceFile],
    stale: &HashSet<String>,
    cached: &HashMap<String, CachedFileResidue>,
) -> (ExtractResult, HashMap<String, CachedFileResidue>) {
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut documents: Vec<RawDocument> = Vec::new();
    let mut imports: Vec<GqlImport> = Vec::new();
    let mut imported_names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let residues: Vec<FileResidue> = files
        .iter()
        .map(|entry| {
            if !stale.contains(&entry.relative) {
                if let Some(record) = cached.get(&entry.relative) {
                    return record.to_residue();
                }
            }
            extract_file(config, entry, files)
        })
        .collect();

    // The record of this run, for the next one's cache. Only files the run covered:
    // a file without a residue was never read, so nothing may be claimed about it.
    let records: HashMap<String, CachedFileResidue> = files
        .iter()
        .zip(residues.iter())
        .map(|(entry, residue)| (entry.relative.clone(), residue.to_cache(&entry.text)))
        .collect();

    // Assembly runs over the walk's order, so the assembled result cannot depend on
    // which files a cache happened to hold: every document passes the same
    // project-wide de-duplication.
    for residue in &residues {
        diagnostics.extend(residue.diagnostics.iter().cloned());
        imports.extend(residue.imports.iter().cloned());
        imported_names.extend(residue.imported_names.iter().cloned());
        for document in &residue.documents {
            let key = format!("{}#{}#{}", document.relative_path, document.offset, document.name);
            if !seen.insert(key) {
                continue;
            }
            documents.push(document.clone());
        }
    }

    // The programmatic page-query surface: the `Page` export of a `+page.ts`/
    // `+layout.ts` inside the pages directory.
    let file_set: HashSet<&str> = files.iter().map(|file| file.relative.as_str()).collect();
    let pages_prefix = crate::page_module::routing_pages_prefix(config);
    for (index, entry) in files.iter().enumerate() {
        let Some(module_source) = residues[index].source.as_ref() else {
            continue;
        };
        if !entry.relative.starts_with(&pages_prefix) {
            continue;
        }
        let Some(role) = crate::page_module::page_module_role(&entry.relative) else {
            continue;
        };
        let sibling =
            colocated_document_any(&entry.relative, &config.routing.document_file_names(role));
        if let Some(sibling) = sibling {
            if file_set.contains(sibling.as_str()) {
                diagnostics.push(create_diagnostic(DiagnosticInput::error(
                    "FLM1030",
                    format!(
                        "{}: this directory declares both \"{}\" and \"{}\"; \"{}\" is the {}'s loader. Delete one of them.",
                        entry.relative,
                        basename(&sibling),
                        basename(&entry.relative),
                        basename(&sibling),
                        role
                    ),
                    location_at(module_source, &entry.relative, 0, 1),
                )));
                continue;
            }
        }
        let resolution = resolve_page_module(config, entry, &documents);
        if let Some(diagnostic) = resolution.diagnostic {
            diagnostics.push(diagnostic);
        }
    }

    // FLM1017: an imported `.gql` file that `include` does not match, or that has no
    // document.
    for entry in &imports {
        let relative_target = match &entry.resolved {
            Some(resolved) => to_posix(&relative_path(&config.project_dir, resolved)),
            None => entry.specifier.clone(),
        };
        let lexical = relative_target.starts_with("..") || is_absolute(&relative_target);
        let included = !lexical
            && crate::glob::matches_any(&config.include, &relative_target)
            && !crate::glob::matches_any(&config.exclude, &relative_target);
        let has_document =
            documents.iter().any(|document| document.relative_path == relative_target);
        if included && has_document {
            continue;
        }
        diagnostics.push(create_diagnostic(DiagnosticInput::error(
            "FLM1017",
            format!(
                "{relative_target} is imported by {} but is not matched by include; add it to flamme.config.ts.",
                entry.relative_path
            ),
            location_at(&entry.source, &entry.relative_path, entry.offset, 1),
        )));
    }

    documents.sort_by(|a, b| {
        crate::naming::compare_names(&a.relative_path, &b.relative_path)
            .then(a.offset.cmp(&b.offset))
    });

    let mut unique_names: Vec<String> = Vec::new();
    for name in imported_names {
        if !unique_names.contains(&name) {
            unique_names.push(name);
        }
    }

    (
        ExtractResult {
            documents,
            diagnostics,
            imports,
            imported_names: unique_names,
            files: files
                .iter()
                .map(|file| DiscoveredFile {
                    absolute: file.absolute.clone(),
                    relative: file.relative.clone(),
                    size: file.size,
                    mtime_ms: file.mtime_ms,
                })
                .collect(),
        },
        records,
    )
}

/// The document a page module resolves to, or the diagnostic that explains its absence.
#[derive(Clone, Debug, Default)]
pub struct PageModuleResolution {
    /// The resolved document index into the extraction's document list.
    pub document: Option<usize>,
    /// The error to report when no document resolved.
    pub diagnostic: Option<Diagnostic>,
}

/// Resolves the `Page` export of one `+page.ts`/`+layout.ts` module.
///
/// `config` is the resolved project config: `routing.documentExtensions` decides
/// which extensions an extensionless import specifier is probed with.
pub fn resolve_page_module(
    config: &RustConfig,
    file: &SourceFile,
    documents: &[RawDocument],
) -> PageModuleResolution {
    crate::page_module::resolve_page_module_source(
        &file.text,
        &file.absolute,
        &file.relative,
        documents,
        &config.routing.document_extensions(),
    )
}

/// True when `path` is matched by `include` and not by `exclude`.
pub fn is_included(config: &RustConfig, path: &str) -> bool {
    crate::config::is_included(config, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One input file, as the TypeScript side hands it over.
    fn input(root: &std::path::Path, relative: &str, text: &str) -> SourceFile {
        let absolute = root.join(relative);
        if let Some(parent) = absolute.parent() {
            std::fs::create_dir_all(parent).expect("create the fixture directory");
        }
        std::fs::write(&absolute, text).expect("write the fixture file");
        SourceFile {
            relative: relative.to_string(),
            absolute: to_posix(&absolute.to_string_lossy()),
            text: text.to_string(),
            size: text.len() as u64,
            mtime_ms: 0.0,
        }
    }

    /// A project directory under the system temp dir, unique per test.
    fn scratch(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("flamme-gap-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create the fixture root");
        root
    }

    /// The config `resolveConfig` would produce for one of these projects.
    fn config(root: &std::path::Path, include: &[&str]) -> RustConfig {
        RustConfig {
            project_dir: to_posix(&root.to_string_lossy()),
            include: include.iter().map(|entry| (*entry).to_string()).collect(),
            ..RustConfig::default()
        }
    }

    /// The cooked code units of one template body, read back as a `String` where the
    /// decode is lossless.
    fn cooked(body: &str) -> Cooked {
        cook_template(body, 0)
    }

    /// A code-unit slice as text, for assertions (U+FFFD stands in for a lone surrogate).
    fn text_of(units: &[u16]) -> String {
        String::from_utf16_lossy(units)
    }

    #[test]
    fn a_lone_surrogate_escape_cooks_to_its_code_unit() {
        let body = "query A { species(id: 1) { name(arg: \"\\uD83D\") } }";
        let result = cooked(body);
        // The cooked sequence is the oracle's `String`, unit for unit: the escape is
        // one lone surrogate, and `text` (which cannot hold one) decodes it lossily.
        assert_eq!(result.units.len(), body.encode_utf16().count() - 5);
        assert!(result.units.contains(&0xd83d), "the lone surrogate survives as a unit");
        assert_eq!(result.text, text_of(&result.units));
        assert_eq!(result.text.matches('\u{fffd}').count(), 1);
        // One offset per cooked unit, plus the end of the span.
        assert_eq!(result.source_offsets.len(), result.units.len() + 1);
        // The document reaches the lexer and fails exactly where the oracle's does.
        let error = crate::graphql::parse_document_units(&result.units, &result.text)
            .expect_err("a lone surrogate cannot lex");
        assert_eq!(error.message, "Syntax Error: Invalid character within String: U+D83D.");
        assert_eq!((error.line, error.column), (1, 39), "the lexer reports the surrogate's own position");
        // A lone *trailing* surrogate cooks the same way and is reported by name too.
        let trailing = cooked("query A { f(arg: \"\\uDE00\") }");
        let error = crate::graphql::parse_document_units(&trailing.units, &trailing.text)
            .expect_err("a lone trailing surrogate cannot lex");
        assert_eq!(error.message, "Syntax Error: Invalid character within String: U+DE00.");
    }

    #[test]
    fn a_surrogate_pair_written_as_two_escapes_cooks_to_one_character() {
        let result = cooked("query A { f(arg: \"\\uD83D\\uDE00\") }");
        assert_eq!(result.text, "query A { f(arg: \"😀\") }");
        assert_eq!(result.units.len(), result.text.encode_utf16().count());
        assert!(crate::graphql::parse_document_units(&result.units, &result.text).is_ok());
    }

    #[test]
    fn a_braced_surrogate_escape_cooks_to_its_code_unit() {
        let result = cooked("query A { f(arg: \"\\u{D83D}\") }");
        assert_eq!(result.units.iter().filter(|unit| **unit == 0xd83d).count(), 1);
        assert_eq!(result.text.matches('\u{fffd}').count(), 1);
        let error = crate::graphql::parse_document_units(&result.units, &result.text)
            .expect_err("a lone surrogate cannot lex");
        assert_eq!(error.message, "Syntax Error: Invalid character within String: U+D83D.");
    }

    #[test]
    fn an_escape_past_the_unicode_range_keeps_its_backslash() {
        // `String.fromCodePoint` throws for each of these, so the oracle aborts the
        // whole compilation; the port keeps the escape as written, which makes the
        // document fail to lex instead of compiling to a different document.
        // The lexer quotes the escape it read, which is not the whole written sequence
        // for a value it stops on (`-`, or a digit run past its own ceiling).
        let cases = [
            ("\\u{110000}", "Syntax Error: Invalid Unicode escape sequence: \"\\u{110000}\"."),
            ("\\u{-1}", "Syntax Error: Invalid Unicode escape sequence: \"\\u{-\"."),
            (
                "\\u{FFFFFFFFFF}",
                "Syntax Error: Invalid Unicode escape sequence: \"\\u{FFFFFFFF\".",
            ),
        ];
        for (body, message) in cases {
            let result = cooked(&format!("query A {{ f(arg: \"{body}\") }}"));
            assert_eq!(result.text, format!("query A {{ f(arg: \"{body}\") }}"));
            assert_eq!(result.units.len(), result.text.encode_utf16().count());
            let error = crate::graphql::parse_document_units(&result.units, &result.text)
                .expect_err("the preserved escape cannot lex");
            assert_eq!(error.message, message);
        }
    }

    #[test]
    fn a_malformed_braced_escape_still_cooks_the_way_javascript_does() {
        // `Number.parseInt('', 16)` and `Number.parseInt('ZZ', 16)` are `NaN`, so the
        // oracle falls through to its unrecognised-escape case: the backslash is
        // dropped. That is what the port does too, and it is not the range case above.
        assert_eq!(cooked("\\u{}").text, "u{}");
        assert_eq!(cooked("\\u{ZZ}").text, "u{ZZ}");
    }

    #[test]
    fn the_semantic_pass_reports_a_duplicate_declaration() {
        let code = "import { graphql } from '$flamme'\nconst a = 1;\nconst a = 2;\n";
        let result = scan_code(code, "/p/src/A.ts", "src/A.ts", 0, &SourceText::new(code), "ts");
        assert_eq!(result.diagnostics.len(), 1);
        let diagnostic = &result.diagnostics[0];
        assert_eq!(diagnostic.code, "FLM1011");
        assert_eq!(
            diagnostic.message,
            "src/A.ts: cannot parse the script block: Identifier `a` has already been declared (2:7)"
        );
        // The label is at the *first* declaration, and the diagnostic itself is the
        // block's own location, which is what the oracle reports.
        assert_eq!((diagnostic.location.line, diagnostic.location.column), (1, 1));
    }

    #[test]
    fn the_semantic_pass_reports_a_top_level_break() {
        let code = "break;\n";
        let result = scan_code(code, "/p/src/A.ts", "src/A.ts", 0, &SourceText::new(code), "ts");
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(
            result.diagnostics[0].message,
            "src/A.ts: cannot parse the script block: Illegal break statement (1:1)"
        );
    }

    #[test]
    fn a_script_block_that_only_the_semantic_pass_can_reject_extracts_nothing() {
        let root = scratch("semantic");
        let file = input(
            &root,
            "src/A.ts",
            "import { graphql } from '$flamme'\nconst a = 1;\nconst a = 2;\nexport const q = graphql`query A { a }`\n",
        );
        let result = extract_project(&config(&root, &["src/**/*.ts"]), &[file]);
        assert!(result.documents.is_empty(), "the document must not be extracted");
        assert_eq!(
            result.diagnostics.first().map(|entry| entry.message.as_str()),
            Some("src/A.ts: cannot parse the script block: Identifier `a` has already been declared (2:7)")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_lone_surrogate_in_a_template_is_reported_where_the_lexer_fails() {
        let root = scratch("lone");
        let text = "import { graphql } from '$flamme'\nexport const q = graphql`query A { species(id: 1) { name(arg: \"\\uD83D\") } }`\n";
        let file = input(&root, "src/A.ts", text);
        let result = extract_project(&config(&root, &["src/**/*.ts"]), &[file]);
        assert!(result.documents.is_empty());
        let diagnostic = result.diagnostics.first().expect("one diagnostic");
        assert_eq!(
            diagnostic.message,
            "src/A.ts:2:64 cannot parse the document: Syntax Error: Invalid character within String: U+D83D."
        );
        assert_eq!((diagnostic.location.line, diagnostic.location.column), (2, 64));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_escape_past_the_unicode_range_is_reported_instead_of_compiling() {
        let root = scratch("beyond");
        let text = "import { graphql } from '$flamme'\nexport const q = graphql`query A { species(id: 1) { name(arg: \"\\u{110000}\") } }`\n";
        let file = input(&root, "src/A.ts", text);
        let result = extract_project(&config(&root, &["src/**/*.ts"]), &[file]);
        assert!(result.documents.is_empty());
        let diagnostic = result.diagnostics.first().expect("one diagnostic");
        assert_eq!(
            diagnostic.message,
            "src/A.ts:2:64 cannot parse the document: Syntax Error: Invalid Unicode escape sequence: \"\\u{110000}\"."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_script_src_target_outside_the_walk_is_read_from_disk() {
        let root = scratch("script-src");
        // `src/Comp.ts` is not matched by `include`, so the walk never discovers it.
        let vue = input(
            &root,
            "src/Comp.vue",
            "<script lang=\"ts\" src=\"./Comp.ts\"></script>\n<template><div /></template>\n",
        );
        input(
            &root,
            "src/Comp.ts",
            "import { graphql } from '$flamme'\nexport const frag = graphql`fragment CompFields on Species { id }`\n",
        );
        let config = config(&root, &["src/**/*.vue"]);
        let result = extract_project(&config, &[vue]);
        assert_eq!(
            result.documents.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            vec!["CompFields"]
        );
        assert_eq!(
            result.documents[0].relative_path, "src/Comp.ts",
            "the document belongs to the target file"
        );
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        // The target is a dependency of the component, so an incremental run re-reads it.
        assert!(result.files.is_empty() || result.files[0].relative == "src/Comp.vue");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_script_src_target_is_read_the_way_node_reads_it() {
        let root = scratch("script-src-bytes");
        let vue = input(
            &root,
            "src/Comp.vue",
            "<script lang=\"ts\" src=\"./Comp.ts\"></script>\n<template><div /></template>\n",
        );
        // One invalid byte, as `readFile(_, 'utf8')` reads it: replaced, not an error.
        let source = b"import { graphql } from '$flamme'\nexport const frag = graphql`fragment CompFields on Species { id }`\n// \x80\n";
        std::fs::write(root.join("src/Comp.ts"), source).expect("write the target");
        let result = extract_project(&config(&root, &["src/**/*.vue"]), &[vue]);
        assert_eq!(
            result.documents.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            vec!["CompFields"]
        );
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_script_src_target_is_reported_the_way_node_reports_it() {
        let root = scratch("script-src-missing");
        let vue = input(
            &root,
            "src/Comp.vue",
            "<script lang=\"ts\" src=\"./Nope.ts\"></script>\n<template><div /></template>\n",
        );
        let result = extract_project(&config(&root, &["src/**/*.vue"]), &[vue]);
        let diagnostic = result.diagnostics.first().expect("one diagnostic");
        assert_eq!(
            diagnostic.message,
            format!(
                "src/Comp.vue: cannot read <script src=\"./Nope.ts\">: ENOENT: no such file or directory, open '{}/src/Nope.ts'",
                to_posix(&root.to_string_lossy())
            )
        );
        assert_eq!((diagnostic.location.line, diagnostic.location.column), (1, 35));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_page_module_import_reaches_a_configured_document_extension() {
        let root = scratch("page-extension");
        let module = input(
            &root,
            "src/pages/index/+page.ts",
            "import Q from './Q'\nexport const Page = Q\n",
        );
        let document = input(&root, "src/pages/index/Q.gqlx", "query Index { species(id: 1) { id } }\n");
        let mut config = config(&root, &["src/**/*.{ts,gqlx}"]);
        config.routing.document_extensions = vec![".gql".into(), ".graphql".into(), ".gqlx".into()];
        let result = extract_project(&config, &[module, document]);
        assert_eq!(result.documents.len(), 1);
        assert_eq!(result.documents[0].name, "Index");
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        let _ = std::fs::remove_dir_all(&root);
    }
}
