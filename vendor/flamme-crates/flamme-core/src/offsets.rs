//! Offset arithmetic. Port of `packages/core/src/offsets.ts`.
//!
//! Every offset in the compiler is a JavaScript string index, which counts UTF-16
//! code units. The Rust port keeps that convention: an [`Offset`] is a UTF-16 code
//! unit index, [`SourceText`] converts a byte offset (what the Rust lexers and
//! parsers produce) into one, and the line index is built in the same units. A
//! source with any non-ASCII character (an accent, a CJK glyph, an emoji) therefore
//! reports exactly the line/column the TypeScript compiler reports.
//!
//! The conversion is not a constant shift: a character's UTF-8 length and its
//! UTF-16 length differ in three ways (`é` is 2 bytes and 1 unit, `漢` is 3 and 1,
//! `😀` is 4 and 2), so [`SourceText`] keeps one entry per character whose lengths
//! differ and a running sum of the difference.

use crate::diagnostics::SourceLocation;

/// A UTF-16 code unit index, the unit every diagnostic offset uses.
pub type Offset = u32;

/// Converts a possibly-win32 path to posix separators.
pub fn to_posix(path: &str) -> String {
    path.replace('\\', "/")
}

/// One character whose UTF-8 length differs from its UTF-16 length.
#[derive(Clone, Copy, Debug)]
struct Irregular {
    /// Byte offset of the character.
    byte_start: u32,
    /// UTF-16 offset of the character.
    utf16_start: u32,
    /// UTF-8 length in bytes.
    byte_len: u32,
    /// UTF-16 length in code units.
    utf16_len: u32,
    /// Sum of `byte_len - utf16_len` for this character and every earlier one.
    delta_through: u32,
}

/// A source text with the byte↔UTF-16 conversion the port needs.
#[derive(Clone, Debug)]
pub struct SourceText {
    text: String,
    /// Every character whose byte length differs from its UTF-16 length.
    irregular: Vec<Irregular>,
    utf16_len: u32,
}

impl SourceText {
    /// Wraps `text`.
    pub fn new(text: impl Into<String>) -> Self {
        let text = text.into();
        let mut irregular = Vec::new();
        let mut utf16_len = 0u32;
        let mut delta_through = 0u32;
        for (byte_offset, character) in text.char_indices() {
            let byte_len = character.len_utf8() as u32;
            let units = character.len_utf16() as u32;
            if byte_len != units {
                delta_through += byte_len - units;
                irregular.push(Irregular {
                    byte_start: byte_offset as u32,
                    utf16_start: utf16_len,
                    byte_len,
                    utf16_len: units,
                    delta_through,
                });
            }
            utf16_len += units;
        }
        Self { text, irregular, utf16_len }
    }

    /// The text.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// The length in UTF-16 code units, which is `text.length` in JavaScript.
    pub fn utf16_len(&self) -> u32 {
        self.utf16_len
    }

    /// Converts a byte offset into a UTF-16 offset.
    pub fn to_utf16(&self, byte_offset: usize) -> Offset {
        let byte_offset = byte_offset.min(self.text.len()) as u32;
        // Characters that start before the byte offset contribute their difference.
        let count = self.irregular.partition_point(|entry| entry.byte_start < byte_offset);
        let extra = if count == 0 { 0 } else { self.irregular[count - 1].delta_through };
        byte_offset - extra
    }

    /// Converts a UTF-16 offset back into a byte offset. An offset that lands in
    /// the middle of a surrogate pair or between a multi-byte character's bytes
    /// rounds down to that character's first byte, which is the only representable
    /// boundary; JavaScript would slice a lone surrogate there, and no compiler
    /// offset does.
    pub fn to_byte(&self, offset: Offset) -> usize {
        let mut extra: u32 = 0;
        for entry in &self.irregular {
            if entry.utf16_start + entry.utf16_len <= offset {
                extra = entry.delta_through;
            } else if entry.utf16_start < offset {
                // Inside the character: round down to its first byte.
                return entry.byte_start as usize;
            } else {
                break;
            }
        }
        ((offset + extra) as usize).min(self.text.len())
    }

    /// Slices by UTF-16 offsets, the way `text.slice(start, end)` does for
    /// boundaries that fall between characters.
    pub fn slice_utf16(&self, start: Offset, end: Offset) -> String {
        let start_byte = self.to_byte(start);
        let end_byte = self.to_byte(end.max(start)).max(start_byte);
        self.text[start_byte..end_byte].to_string()
    }

    /// Offsets of every line start, with a leading `0`, in UTF-16 units.
    pub fn build_line_index(&self) -> Vec<Offset> {
        let mut starts: Vec<Offset> = vec![0];
        let mut position: Offset = 0;
        let mut chars = self.text.chars().peekable();
        while let Some(character) = chars.next() {
            if character == '\r' {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                    position += 1;
                }
                position += 1;
                starts.push(position);
            } else if character == '\n' {
                position += 1;
                starts.push(position);
            } else {
                position += character.len_utf16() as u32;
            }
        }
        starts
    }
}

/// The 1-based line containing `offset`. Offsets past the end clamp to the last line.
pub fn line_at(line_index: &[Offset], offset: Offset) -> u32 {
    let mut low = 0usize;
    let mut high = line_index.len().saturating_sub(1);
    while low < high {
        let middle = (low + high).div_ceil(2);
        let start = line_index.get(middle).copied().unwrap_or(0);
        if start <= offset {
            low = middle;
        } else {
            high = middle.saturating_sub(1);
        }
    }
    low as u32 + 1
}

/// The 1-based column of `offset` within the line that contains it.
pub fn column_at(line_index: &[Offset], offset: Offset) -> u32 {
    let line = line_at(line_index, offset);
    let start = line_index.get(line as usize - 1).copied().unwrap_or(0);
    offset.saturating_sub(start) + 1
}

/// Maps an absolute UTF-16 offset in `text` to a [`SourceLocation`].
pub fn location_at(text: &SourceText, file: &str, offset: Offset, length: u32) -> SourceLocation {
    let line_index = text.build_line_index();
    location_at_indexed(&line_index, text.utf16_len(), file, offset, length)
}

/// Maps an absolute UTF-16 offset to a location, reusing a prebuilt line index.
pub fn location_at_indexed(
    line_index: &[Offset],
    utf16_len: u32,
    file: &str,
    offset: Offset,
    length: u32,
) -> SourceLocation {
    let safe_offset = offset.min(utf16_len);
    SourceLocation {
        file: file.to_string(),
        line: line_at(line_index, safe_offset),
        column: column_at(line_index, safe_offset),
        length: length.max(1),
    }
}

/// Start/end of a GraphQL AST node inside `text`, clamped to `text`.
pub fn node_range(start: Offset, end: Option<Offset>, utf16_len: u32) -> (Offset, Offset) {
    let start = start.min(utf16_len);
    (start, end.unwrap_or(start).max(start).min(utf16_len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_index_handles_crlf_and_lone_cr() {
        let text = SourceText::new("a\nb\r\nc\rd");
        assert_eq!(text.build_line_index(), vec![0, 2, 5, 7]);
        assert_eq!(line_at(&text.build_line_index(), 6), 3);
        assert_eq!(column_at(&text.build_line_index(), 6), 2);
    }

    /// The expected values are `String.prototype.length` and the byte offsets node
    /// reports for the same text.
    #[test]
    fn astral_characters_count_as_two_units() {
        let text = SourceText::new("a\u{1F600}b");
        assert_eq!(text.utf16_len(), 4);
        assert_eq!(text.to_utf16(0), 0);
        assert_eq!(text.to_utf16(1), 1);
        assert_eq!(text.to_utf16(5), 3);
        assert_eq!(text.to_utf16(6), 4);
        assert_eq!(text.to_byte(0), 0);
        assert_eq!(text.to_byte(1), 1);
        assert_eq!(text.to_byte(3), 5);
        assert_eq!(text.to_byte(4), 6);
        assert_eq!(text.slice_utf16(0, 3), "a\u{1F600}");
        assert_eq!(text.slice_utf16(3, 4), "b");
        assert_eq!(location_at(&text, "x.gql", 3, 1).column, 4);
    }

    #[test]
    fn multibyte_bmp_characters_shift_by_two_bytes() {
        let text = SourceText::new("héllo");
        assert_eq!(text.utf16_len(), 5);
        assert_eq!(text.to_utf16(1), 1);
        assert_eq!(text.to_utf16(3), 2);
        assert_eq!(text.to_utf16(5), 4);
        assert_eq!(text.to_byte(2), 3);
        assert_eq!(text.slice_utf16(1, 2), "é");

        let text = SourceText::new("漢字x");
        assert_eq!(text.utf16_len(), 3);
        assert_eq!(text.to_utf16(3), 1);
        assert_eq!(text.to_utf16(6), 2);
        assert_eq!(text.to_byte(1), 3);
        assert_eq!(text.slice_utf16(0, 1), "漢");
    }

    #[test]
    fn an_offset_inside_a_character_rounds_down() {
        let text = SourceText::new("a\u{1F600}b");
        assert_eq!(text.to_byte(2), 1);
        assert_eq!(text.slice_utf16(1, 3), "\u{1F600}");
    }
}
