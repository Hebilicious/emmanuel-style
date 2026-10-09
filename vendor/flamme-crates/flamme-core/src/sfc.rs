//! Vue single-file-component block scanning.
//! Port of `packages/core/src/sfc.ts` (hand-rolled scanner, like `packages/vite/src/scan.ts`).
//!
//! OWNER: the extraction port.
//!
//! The TypeScript oracle calls `@vue/compiler-sfc`'s `parse()`, which is
//! `@vue/compiler-core`'s HTML tokenizer in `parseMode: 'sfc'`. This module
//! reproduces the observable half of that parse for the shapes the compiler
//! cares about: the root-level `<script>`/`<script setup>` blocks with their
//! content offsets and `lang`/`src` attributes, the empty-block skip, the
//! descriptor-level errors (duplicate blocks, `src` on `<script setup>`, a file
//! with no template or script) and the tokenizer's structural errors (missing
//! end tag, invalid end tag, `<?` outside XML, duplicate attribute, EOF in tag).

use crate::extract::Utf16Map;

/// One `<script>` block of an SFC.
#[derive(Clone, Debug)]
pub struct SfcScriptBlock {
    /// The block's text.
    pub content: String,
    /// Absolute offset of the block's content in the SFC source.
    pub offset: u32,
    /// The `lang` attribute, defaulting to `ts`.
    pub lang: String,
    /// `true` for `<script setup>`.
    pub setup: bool,
    /// The `src` attribute, when present.
    pub src: Option<String>,
}

/// What scanning an SFC produced.
#[derive(Clone, Debug, Default)]
pub struct SfcAnalysis {
    /// Every script block, in source order.
    pub scripts: Vec<SfcScriptBlock>,
}

/// The parse failure of an SFC with no usable script block.
#[derive(Clone, Debug)]
pub struct SfcParseError {
    /// The message.
    pub message: String,
    /// 1-based line of the offending tag in the `.vue` file.
    pub line: u32,
    /// 1-based column of the offending tag in the `.vue` file.
    pub column: u32,
}

/// The HTML void elements `@vue/compiler-core` closes on their own.
const VOID_TAGS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// One static attribute of a scanned tag.
#[derive(Clone, Debug)]
struct Attr {
    /// The attribute name as written.
    name: String,
    /// The attribute value text; `None` when the attribute has no value.
    value: Option<String>,
    /// Byte offset of the attribute name in the source.
    start: usize,
}

/// One root-level element the tokenizer closed.
#[derive(Clone, Debug)]
struct Element {
    /// The tag name as written.
    tag: String,
    /// Every static (non-directive) attribute.
    attrs: Vec<Attr>,
    /// Byte offset of `<` of the opening tag.
    tag_start: usize,
    /// Byte offset just past the `>` of the opening tag.
    content_start: usize,
    /// Byte offset of the end of the element's content.
    content_end: usize,
}

impl Element {
    /// The value of one static attribute, when it is present.
    fn attr(&self, name: &str) -> Option<&Attr> {
        self.attrs.iter().find(|attr| attr.name == name)
    }

    /// True when the element carries a `src` attribute (compiler-sfc's `hasSrc`).
    fn has_src(&self) -> bool {
        self.attr("src").is_some()
    }

    /// compiler-sfc's `isEmpty`: every child is whitespace-only text.
    fn is_empty(&self, source: &str) -> bool {
        source
            .get(self.content_start..self.content_end)
            .map(|content| content.trim().is_empty())
            .unwrap_or(true)
    }
}

/// The tokenizer's `isWhitespace`.
fn is_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r')
}

/// The tokenizer's `isTagStartChar`: a name-start character.
fn is_tag_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic()
}

/// The tokenizer's `isEndOfTagSection`.
fn is_end_of_tag_section(byte: u8) -> bool {
    byte == b'/' || byte == b'>' || is_whitespace(byte)
}

/// One open element of a root `<template>`, as the tokenizer tracks it.
struct OpenElement {
    /// The tag name as written.
    tag: String,
    /// Byte offset of the element's `<`, for `Element is missing end tag.`.
    start: usize,
    /// `@vue/compiler-dom`'s `getNamespace`: 0 HTML, 1 SVG, 2 MathML.
    ns: u8,
    /// `encoding="text/html"`/`"application/xhtml+xml"` on the element, which
    /// `getNamespace` reads back for an `<annotation-xml>` parent.
    html_encoding: bool,
}

/// `@vue/compiler-dom`'s `getNamespace(tag, parent, 0)`.
fn get_namespace(tag: &str, parent: &OpenElement) -> u8 {
    let mut ns = parent.ns;
    if parent.ns == 2 {
        if parent.tag == "annotation-xml" {
            if tag == "svg" {
                return 1;
            }
            if parent.html_encoding {
                ns = 0;
            }
        } else if matches!(parent.tag.as_str(), "mi" | "mo" | "mn" | "ms" | "mtext")
            && tag != "mglyph"
            && tag != "malignmark"
        {
            ns = 0;
        }
    } else if parent.ns == 1
        && matches!(parent.tag.as_str(), "foreignObject" | "desc" | "title")
    {
        ns = 0;
    }
    if ns == 0 {
        if tag == "svg" {
            return 1;
        }
        if tag == "math" {
            return 2;
        }
    }
    ns
}

/// A byte search from `from` (inclusive).
fn find_byte(bytes: &[u8], needle: u8, from: usize) -> Option<usize> {
    if from >= bytes.len() {
        return None;
    }
    bytes[from..].iter().position(|byte| *byte == needle).map(|at| from + at)
}

/// A byte search for `needle` from `from` (inclusive).
fn find_bytes(bytes: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= bytes.len() || bytes.len() - from < needle.len() {
        return None;
    }
    bytes[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| from + at)
}

/// The scanner state for one SFC source.
struct Scanner<'a> {
    source: &'a str,
    bytes: &'a [u8],
    /// The source's byte to UTF-16 offset conversion.
    map: Utf16Map,
}

impl<'a> Scanner<'a> {
    /// Builds one error at a byte offset, in the tokenizer's line/column form.
    fn error(&self, message: impl Into<String>, byte_offset: usize) -> SfcParseError {
        let (line, column) = self.position(byte_offset);
        SfcParseError { message: message.into(), line, column }
    }

    /// The tokenizer's `getPos`: only `\n` starts a line, and a position on a
    /// newline itself still belongs to the line it ends.
    fn position(&self, byte_offset: usize) -> (u32, u32) {
        let mut line = 1u32;
        let mut column = 1u32;
        for (at, character) in self.source.char_indices() {
            if at >= byte_offset {
                break;
            }
            if character == '\n' {
                line += 1;
                column = 1;
            } else {
                column += character.len_utf16() as u32;
            }
        }
        (line, column)
    }

    /// UTF-16 offset of a byte offset in the SFC source.
    fn utf16(&self, byte_offset: usize) -> u32 {
        self.map.to_utf16(byte_offset)
    }

    /// The tokenizer's CDATA error, when `<![CDATA[` starts here in an HTML namespace.
    ///
    /// `@vue/compiler-core` reads `<![CDATA[` in a text state and reports error 1 at
    /// the `<` unless the enclosing namespace is SVG or MathML (`oncdata`). The
    /// sequence is case-sensitive and must be complete: `<![CDATA` falls back to a
    /// declaration, which the caller skips to `>`.
    fn cdata_error(&self, lt: usize, ns: u8) -> Option<SfcParseError> {
        if ns == 0 && self.bytes[lt..].starts_with(b"<![CDATA[") {
            return Some(self.error("CDATA section is allowed only in XML context.", lt));
        }
        None
    }

    /// Scans the root-level elements of the SFC, in source order.
    fn scan_root(&self) -> Result<Vec<Element>, SfcParseError> {
        let mut elements = Vec::new();
        let mut pos = 0usize;
        while let Some(lt) = find_byte(self.bytes, b'<', pos) {
            if self.bytes[lt..].starts_with(b"<!--") {
                match find_bytes(self.bytes, b"-->", lt + 4) {
                    Some(end) => pos = end + 3,
                    None => return Err(self.error("Unexpected EOF in comment.", self.bytes.len())),
                }
                continue;
            }
            // The SFC root is the HTML namespace, so a CDATA section is reported here.
            if let Some(error) = self.cdata_error(lt, 0) {
                return Err(error);
            }
            if self.bytes[lt..].starts_with(b"<!") {
                match find_byte(self.bytes, b'>', lt + 2) {
                    Some(end) => pos = end + 1,
                    None => {
                        return Err(self.error("Unexpected EOF in tag.", self.bytes.len()));
                    }
                }
                continue;
            }
            if self.bytes[lt..].starts_with(b"<?") {
                return Err(self.error("'<?' is allowed only in XML context.", lt + 1));
            }
            if self.bytes[lt..].starts_with(b"</") {
                return Err(self.error("Invalid end tag.", lt));
            }
            if !self.bytes.get(lt + 1).copied().is_some_and(is_tag_start) {
                pos = lt + 1;
                continue;
            }
            let Some(tag) = self.parse_open_tag(lt)? else {
                // The file ends inside the tag name: the tokenizer never closes the
                // element and never reports it either.
                break;
            };
            pos = tag.next;
            if tag.self_closing {
                elements.push(Element {
                    tag: tag.name,
                    attrs: tag.attrs,
                    tag_start: lt,
                    content_start: tag.next,
                    content_end: tag.next,
                });
                continue;
            }
            if tag.name == "template" {
                let (content_end, next) = self.scan_children(lt, tag.next)?;
                elements.push(Element {
                    tag: tag.name,
                    attrs: tag.attrs,
                    tag_start: lt,
                    content_start: tag.next,
                    content_end,
                });
                pos = next;
                continue;
            }
            // Every other root tag is RCDATA: its content runs to `</tag` and is
            // never scanned for elements.
            let (content_end, next) = self.scan_rcdata(&tag.name, tag.next, lt)?;
            elements.push(Element {
                tag: tag.name,
                attrs: tag.attrs,
                tag_start: lt,
                content_start: tag.next,
                content_end,
            });
            pos = next;
        }
        Ok(elements)
    }

    /// Finds the `</tag` sequence that ends an RCDATA block.
    ///
    /// The tokenizer compares `(input | 0x20)` against the sequence built from the
    /// tag as written, so a lowercase tag matches its close tag case-insensitively
    /// while an uppercase one does not match at all.
    fn find_rcdata_sequence(&self, sequence: &[u8], from: usize) -> Option<(usize, usize)> {
        let mut at = from;
        while let Some(lt) = find_byte(self.bytes, b'<', at) {
            if lt + sequence.len() <= self.bytes.len()
                && (0..sequence.len()).all(|index| (self.bytes[lt + index] | 0x20) == sequence[index])
            {
                return Some((lt, lt + sequence.len()));
            }
            at = lt + 1;
        }
        None
    }

    /// Scans one RCDATA element's content, returning `(content_end, next)`.
    fn scan_rcdata(
        &self,
        tag: &str,
        content_start: usize,
        tag_start: usize,
    ) -> Result<(usize, usize), SfcParseError> {
        let sequence = format!("</{tag}").into_bytes();
        let mut from = content_start;
        loop {
            let Some((sequence_start, sequence_end)) = self.find_rcdata_sequence(&sequence, from)
            else {
                return Err(self.error("Element is missing end tag.", tag_start));
            };
            match self.bytes.get(sequence_end).copied() {
                Some(delimiter) if delimiter == b'>' || is_whitespace(delimiter) => {
                    let next = find_byte(self.bytes, b'>', sequence_end)
                        .map(|end| end + 1)
                        .unwrap_or(self.bytes.len());
                    return Ok((sequence_start, next));
                }
                Some(_) => from = sequence_start + 1,
                // A sequence at the very end of the file never gets the delimiter
                // check the tokenizer performs on the next character.
                None => return Err(self.error("Element is missing end tag.", tag_start)),
            }
        }
    }

    /// Scans the children of a root `<template>` element.
    ///
    /// `@vue/compiler-sfc` parses template content as HTML, so a `<script>` inside
    /// it is not a block; only the structural errors are reproduced here.
    fn scan_children(
        &self,
        template_start: usize,
        content_start: usize,
    ) -> Result<(usize, usize), SfcParseError> {
        let mut stack: Vec<OpenElement> = vec![OpenElement {
            tag: "template".to_string(),
            start: template_start,
            ns: 0,
            html_encoding: false,
        }];
        let mut pos = content_start;
        while let Some(lt) = find_byte(self.bytes, b'<', pos) {
            if self.bytes[lt..].starts_with(b"<!--") {
                match find_bytes(self.bytes, b"-->", lt + 4) {
                    Some(end) => pos = end + 3,
                    None => return Err(self.error("Unexpected EOF in comment.", self.bytes.len())),
                }
                continue;
            }
            // SVG and MathML content is an XML context, where the tokenizer accepts a
            // CDATA section instead of reporting it.
            if let Some(error) = self.cdata_error(lt, stack[0].ns) {
                return Err(error);
            }
            if self.bytes[lt..].starts_with(b"<!") {
                match find_byte(self.bytes, b'>', lt + 2) {
                    Some(end) => pos = end + 1,
                    None => {
                        return Err(self.error("Unexpected EOF in tag.", self.bytes.len()));
                    }
                }
                continue;
            }
            if self.bytes[lt..].starts_with(b"<?") {
                return Err(self.error("'<?' is allowed only in XML context.", lt + 1));
            }
            if self.bytes[lt..].starts_with(b"</") {
                let name_start = lt + 2;
                let mut end = name_start;
                while end < self.bytes.len() && !is_end_of_tag_section(self.bytes[end]) {
                    end += 1;
                }
                let name = self.source[name_start..end].to_ascii_lowercase();
                let Some(index) =
                    stack.iter().position(|open| open.tag.to_ascii_lowercase() == name)
                else {
                    return Err(self.error("Invalid end tag.", lt));
                };
                if index > 0 {
                    return Err(self.error("Element is missing end tag.", stack[0].start));
                }
                if stack.len() == 1 {
                    let next = find_byte(self.bytes, b'>', end)
                        .map(|close| close + 1)
                        .unwrap_or(self.bytes.len());
                    return Ok((lt, next));
                }
                stack.remove(0);
                pos = find_byte(self.bytes, b'>', end).map(|close| close + 1).unwrap_or(self.bytes.len());
                continue;
            }
            if !self.bytes.get(lt + 1).copied().is_some_and(is_tag_start) {
                pos = lt + 1;
                continue;
            }
            let Some(tag) = self.parse_open_tag(lt)? else {
                break;
            };
            if tag.self_closing || VOID_TAGS.contains(&tag.name.as_str()) {
                pos = tag.next;
                continue;
            }
            if matches!(tag.name.as_str(), "script" | "style" | "title" | "textarea") {
                pos = self.scan_rcdata(&tag.name, tag.next, lt)?.1;
                continue;
            }
            let ns = get_namespace(&tag.name, &stack[0]);
            let html_encoding = tag.attrs.iter().any(|attr| {
                attr.name == "encoding"
                    && attr.value.as_deref().is_some_and(|value| {
                        value == "text/html" || value == "application/xhtml+xml"
                    })
            });
            stack.insert(0, OpenElement { tag: tag.name, start: lt, ns, html_encoding });
            pos = tag.next;
        }
        // EOF with an open element: the parser reports the innermost one.
        Err(self.error("Element is missing end tag.", stack[0].start))
    }

    /// Parses one opening tag, returning `None` when the file ends inside the tag name.
    fn parse_open_tag(&self, lt: usize) -> Result<Option<OpenTag>, SfcParseError> {
        let mut index = lt + 1;
        let name_start = index;
        while index < self.bytes.len() && !is_end_of_tag_section(self.bytes[index]) {
            index += 1;
        }
        let name = self.source[name_start..index].to_string();
        let mut attrs: Vec<Attr> = Vec::new();
        let mut saw_section = false;
        loop {
            while index < self.bytes.len() && is_whitespace(self.bytes[index]) {
                index += 1;
                saw_section = true;
            }
            let Some(byte) = self.bytes.get(index).copied() else {
                if !saw_section {
                    return Ok(None);
                }
                return Err(self.error("Unexpected EOF in tag.", self.bytes.len()));
            };
            if byte == b'>' {
                return Ok(Some(OpenTag { name, attrs, self_closing: false, next: index + 1 }));
            }
            if byte == b'/' {
                if self.bytes.get(index + 1) == Some(&b'>') {
                    return Ok(Some(OpenTag { name, attrs, self_closing: true, next: index + 2 }));
                }
                return Err(self.error("Illegal '/' in tags.", index));
            }
            if byte == b'=' {
                return Err(self.error("Attribute name cannot start with '='.", index));
            }
            saw_section = true;
            let attr_start = index;
            while index < self.bytes.len() && !is_end_of_tag_section(self.bytes[index]) {
                let current = self.bytes[index];
                if current == b'=' {
                    break;
                }
                if current == b'"' || current == b'\'' || current == b'<' {
                    return Err(self.error(
                        "Attribute name cannot contain U+0022 (\"), U+0027 ('), and U+003C (<).",
                        index,
                    ));
                }
                index += 1;
            }
            let attr_name = self.source[attr_start..index].to_string();
            let mut value: Option<String> = None;
            if self.bytes.get(index) == Some(&b'=') {
                index += 1;
                while index < self.bytes.len() && is_whitespace(self.bytes[index]) {
                    index += 1;
                }
                match self.bytes.get(index).copied() {
                    Some(quote @ (b'"' | b'\'')) => {
                        let value_start = index + 1;
                        let Some(close) = find_byte(self.bytes, quote, value_start) else {
                            return Err(self.error("Unexpected EOF in tag.", self.bytes.len()));
                        };
                        value = Some(self.source[value_start..close].to_string());
                        index = close + 1;
                    }
                    Some(b'>') => {
                        return Err(self.error("Attribute value was expected.", index));
                    }
                    Some(_) => {
                        let value_start = index;
                        while index < self.bytes.len() && !is_end_of_tag_section(self.bytes[index]) {
                            if matches!(self.bytes[index], b'"' | b'\'' | b'<' | b'=' | b'`') {
                                return Err(self.error(
                                    "Unquoted attribute value cannot contain U+0022 (\"), U+0027 ('), U+003C (<), U+003D (=), and U+0060 (`).",
                                    index,
                                ));
                            }
                            index += 1;
                        }
                        value = Some(self.source[value_start..index].to_string());
                    }
                    None => {
                        return Err(self.error("Unexpected EOF in tag.", self.bytes.len()));
                    }
                }
            }
            // Directive props are not static attributes (`:src`, `@click`, `v-bind`).
            let directive = attr_name.starts_with(':')
                || attr_name.starts_with('@')
                || attr_name.starts_with('#')
                || attr_name.starts_with('.')
                || attr_name.starts_with("v-");
            if !directive {
                if attrs.iter().any(|attr| attr.name == attr_name) {
                    return Err(self.error("Duplicate attribute.", attr_start));
                }
                attrs.push(Attr { name: attr_name, value, start: attr_start });
            }
        }
    }
}

/// One parsed opening tag.
struct OpenTag {
    name: String,
    attrs: Vec<Attr>,
    self_closing: bool,
    /// Byte offset just past the tag's `>` (or `/>`).
    next: usize,
}

/// The compiler's `blockLang`: only the four known languages are kept.
fn block_lang(attrs: &[Attr]) -> String {
    match attrs.iter().find(|attr| attr.name == "lang").and_then(|attr| attr.value.as_deref()) {
        Some("ts") => "ts".to_string(),
        Some("tsx") => "tsx".to_string(),
        Some("js") => "js".to_string(),
        Some("jsx") => "jsx".to_string(),
        _ => "js".to_string(),
    }
}

/// Scans one `.vue` file into its script blocks.
pub fn analyze_vue_sfc(source: &str, filename: &str) -> Result<SfcAnalysis, SfcParseError> {
    let scanner = Scanner { source, bytes: source.as_bytes(), map: Utf16Map::new(source) };
    let elements = scanner.scan_root()?;

    let mut has_template = false;
    let mut script: Option<&Element> = None;
    let mut script_setup: Option<&Element> = None;
    let mut descriptor_error: Option<SfcParseError> = None;
    for element in &elements {
        if element.tag != "template" && element.is_empty(source) && !element.has_src() {
            continue;
        }
        match element.tag.as_str() {
            "template" => {
                if !has_template {
                    has_template = true;
                    if let Some(functional) = element.attr("functional") {
                        descriptor_error = Some(scanner.error(
                            "<template functional> is no longer supported in Vue 3, since functional components no longer have significant performance difference from stateful ones. Just use a normal <template> instead.",
                            functional.start,
                        ));
                    }
                }
            }
            "script" => {
                let is_setup = element.attr("setup").is_some();
                if is_setup && script_setup.is_none() {
                    script_setup = Some(element);
                } else if !is_setup && script.is_none() {
                    script = Some(element);
                } else if descriptor_error.is_none() {
                    descriptor_error = Some(scanner.error(
                        format!(
                            "Single file component can contain only one <script{}> element",
                            if is_setup { " setup" } else { "" }
                        ),
                        element.tag_start,
                    ));
                }
            }
            "style" => {
                if element.attr("vars").is_some() && descriptor_error.is_none() {
                    descriptor_error = Some(scanner.error(
                        "<style vars> has been replaced by a new proposal: https://github.com/vuejs/rfcs/pull/231",
                        0,
                    ));
                }
            }
            _ => {}
        }
    }

    let mut script = script;
    let mut script_setup = script_setup;
    if !has_template && script.is_none() && script_setup.is_none() && descriptor_error.is_none() {
        descriptor_error = Some(scanner.error(
            format!(
                "At least one <template> or <script> is required in a single file component. {filename}"
            ),
            0,
        ));
    }
    if let Some(setup) = script_setup {
        if setup.has_src() {
            if descriptor_error.is_none() {
                descriptor_error = Some(scanner.error(
                    "<script setup> cannot use the \"src\" attribute because its syntax will be ambiguous outside of the component.",
                    0,
                ));
            }
            script_setup = None;
        } else if script.is_some_and(Element::has_src) {
            if descriptor_error.is_none() {
                descriptor_error = Some(scanner.error(
                    "<script> cannot use the \"src\" attribute when <script setup> is also present because they must be processed together.",
                    0,
                ));
            }
            script = None;
        }
    }
    if let Some(error) = descriptor_error {
        return Err(error);
    }

    let mut scripts = Vec::new();
    for (kind_setup, element) in [(true, script_setup), (false, script)] {
        let Some(element) = element else {
            continue;
        };
        let start = scanner.utf16(element.content_start);
        let end = scanner.utf16(element.content_end);
        scripts.push(SfcScriptBlock {
            content: scanner.map.slice(source, start, end),
            offset: start,
            lang: block_lang(&element.attrs),
            setup: kind_setup,
            src: element
                .attr("src")
                .and_then(|attr| attr.value.as_ref())
                .map(|value| value.to_string()),
        });
    }
    Ok(SfcAnalysis { scripts })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The error one SFC reports, if it reports one.
    fn error_of(source: &str) -> Option<SfcParseError> {
        analyze_vue_sfc(source, "src/Comp.vue").err()
    }

    /// The SFC a case compiles, with the script block the compiler needs.
    fn with_script(body: &str) -> String {
        format!(
            "<script setup lang=\"ts\">\nimport {{ graphql }} from '$flamme'\nconst frag = graphql`fragment C on Species {{ id }}`\n</script>\n{body}"
        )
    }

    #[test]
    fn cdata_in_template_content_is_reported_at_its_angle_bracket() {
        let error = error_of("<template>\n  <![CDATA[ x ]]>\n</template>\n").expect("an error");
        assert_eq!(error.message, "CDATA section is allowed only in XML context.");
        assert_eq!((error.line, error.column), (2, 3));
    }

    #[test]
    fn cdata_outside_a_template_is_reported() {
        let error = error_of(&with_script("<![CDATA[ y ]]>\n")).expect("an error");
        assert_eq!(error.message, "CDATA section is allowed only in XML context.");
        assert_eq!((error.line, error.column), (5, 1));
    }

    #[test]
    fn cdata_at_the_very_start_of_the_file_is_reported() {
        let error = error_of("<![CDATA[ z ]]>\n<script setup lang=\"ts\"></script>\n")
            .expect("an error");
        assert_eq!((error.line, error.column), (1, 1));
    }

    #[test]
    fn cdata_inside_rcdata_is_raw_text() {
        // `<script>`, `<style>`, `<title>` and `<textarea>` content is never scanned
        // for elements, so a CDATA sequence in it is text, exactly as in the oracle.
        let script = with_script("");
        assert!(analyze_vue_sfc(&script, "src/Comp.vue").is_ok());
        let title = "<script setup lang=\"ts\"></script>\n<template>\n<title><![CDATA[ x ]]></title>\n</template>\n";
        assert!(analyze_vue_sfc(title, "src/Comp.vue").is_ok());
        let style = "<template>\n<style><![CDATA[ x ]]></style>\n</template>\n";
        assert!(analyze_vue_sfc(style, "src/Comp.vue").is_ok());
    }

    #[test]
    fn cdata_that_is_not_closed_is_reported_at_the_sequence() {
        let error = error_of("<template>\n  <![CDATA[ x\n</template>\n").expect("an error");
        assert_eq!(error.message, "CDATA section is allowed only in XML context.");
        assert_eq!((error.line, error.column), (2, 3));
    }

    #[test]
    fn a_partial_or_lowercase_sequence_is_a_declaration() {
        // The tokenizer compares the sequence case-sensitively and only after the `[`.
        assert!(analyze_vue_sfc("<template>\n  <![cdata[ x ]]>\n</template>\n", "C.vue").is_ok());
        assert!(analyze_vue_sfc("<template>\n  <![CDATA x ]]>\n</template>\n", "C.vue").is_ok());
        assert!(analyze_vue_sfc("<template>\n  <![CDATAx]]>\n</template>\n", "C.vue").is_ok());
    }

    #[test]
    fn cdata_is_accepted_in_an_xml_namespace() {
        let ok = [
            "<svg><![CDATA[ x ]]></svg>",
            "<div><svg><![CDATA[ x ]]></svg></div>",
            "<svg><desc><![CDATA[ x ]]></desc></svg>",
            "<svg><title><![CDATA[ x ]]></title></svg>",
            "<svg><foreignObject><![CDATA[ x ]]></foreignObject></svg>",
            "<math><![CDATA[ x ]]></math>",
            "<math><mtext><![CDATA[ x ]]></mtext></math>",
            "<math><annotation-xml><![CDATA[ x ]]></annotation-xml></math>",
            "<math><annotation-xml><div><![CDATA[ x ]]></div></annotation-xml></math>",
            "<math><annotation-xml><svg><![CDATA[ x ]]></svg></annotation-xml></math>",
        ];
        for body in ok {
            let source = format!("<template>\n  {body}\n</template>\n");
            assert!(
                analyze_vue_sfc(&source, "src/Comp.vue").is_ok(),
                "{body} is an XML context"
            );
        }
    }

    #[test]
    fn cdata_is_reported_where_the_namespace_returns_to_html() {
        let failing = [
            "<foreignObject><![CDATA[ x ]]></foreignObject>",
            "<svg><foreignObject><div><![CDATA[ x ]]></div></foreignObject></svg>",
            "<svg><desc><div><![CDATA[ x ]]></div></desc></svg>",
            "<math><mtext><div><![CDATA[ x ]]></div></mtext></math>",
            "<math><annotation-xml encoding=\"text/html\"><div><![CDATA[ x ]]></div></annotation-xml></math>",
        ];
        for body in failing {
            let source = format!("<template>\n  {body}\n</template>\n");
            let error = analyze_vue_sfc(&source, "src/Comp.vue")
                .err()
                .unwrap_or_else(|| panic!("{body} is an HTML context"));
            assert_eq!(error.message, "CDATA section is allowed only in XML context.", "{body}");
        }
    }

    #[test]
    fn cdata_inside_a_comment_or_an_attribute_is_not_reported() {
        assert!(
            analyze_vue_sfc("<template><!-- <![CDATA[ --></template>\n", "C.vue").is_ok()
        );
        assert!(
            analyze_vue_sfc(
                "<template><div title=\"<![CDATA[\">ok</div></template>\n",
                "C.vue"
            )
            .is_ok()
        );
    }
}
