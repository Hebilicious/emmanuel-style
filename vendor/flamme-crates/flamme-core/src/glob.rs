//! Glob matching for the document discovery rules. Port of `packages/core/src/glob.ts`
//! (the pattern half; the directory walk stays in TypeScript).

use crate::offsets::to_posix;

/// Expands the first `{a,b}` group in `pattern` into one pattern per alternative.
/// Nested groups are not supported (the config schema does not use them).
pub fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(open) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let Some(close) = pattern[open..].find('}').map(|offset| open + offset) else {
        return vec![pattern.to_string()];
    };
    let prefix = &pattern[..open];
    let suffix = &pattern[close + 1..];
    // `slice(open + 1, close)` counts UTF-16 units in JavaScript; `{` and `}` are
    // ASCII, so byte indices agree.
    pattern[open + 1..close]
        .split(',')
        .flat_map(|alternative| expand_braces(&format!("{prefix}{alternative}{suffix}")))
        .collect()
}

/// Escapes one pattern character for a regular expression.
fn escape_reg_exp(char: char) -> String {
    if "\\^$.*+?()[]{}|/".contains(char) {
        format!("\\{char}")
    } else {
        char.to_string()
    }
}

/// Translates one expanded glob into a regular expression source string.
/// `**\/` matches zero or more directories, `*` and `?` never cross a `/`.
pub fn glob_to_regexp(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut source = String::new();
    let mut index = 0usize;
    while index < chars.len() {
        let char = chars[index];
        if char == '*' {
            let is_double = chars.get(index + 1) == Some(&'*');
            if is_double {
                index += 1;
                if chars.get(index + 1) == Some(&'/') {
                    index += 1;
                    source.push_str("(?:.*/)?");
                } else {
                    source.push_str(".*");
                }
            } else {
                source.push_str("[^/]*");
            }
        } else if char == '?' {
            source.push_str("[^/]");
        } else {
            source.push_str(&escape_reg_exp(char));
        }
        index += 1;
    }
    format!("^{source}$")
}

/// True when the posix path `path` matches the glob `pattern`.
pub fn matches_glob(pattern: &str, path: &str) -> bool {
    let candidate = to_posix(path);
    if let Some(rest) = pattern.strip_prefix('!') {
        return !expand_braces(rest).iter().any(|one| regexp_matches(one, &candidate));
    }
    expand_braces(pattern).iter().any(|one| regexp_matches(one, &candidate))
}

/// Matches `candidate` against one expanded glob.
fn regexp_matches(pattern: &str, candidate: &str) -> bool {
    match compile(pattern) {
        Some(regex) => regex.is_match(candidate),
        None => false,
    }
}

/// Compiles a glob to a [`regex`]-free matcher.
fn compile(pattern: &str) -> Option<SimpleRegex> {
    SimpleRegex::new(&glob_to_regexp(pattern))
}

/// True when any pattern matches; negated patterns subtract from the set.
pub fn matches_any<S: AsRef<str>>(patterns: &[S], path: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        let pattern = pattern.as_ref();
        if let Some(rest) = pattern.strip_prefix('!') {
            if matches_glob(rest, path) {
                matched = false;
            }
        } else if matches_glob(pattern, path) {
            matched = true;
        }
    }
    matched
}

/// A tiny backtracking matcher for the restricted regexp language
/// [`glob_to_regexp`] produces: literals, `.`, character classes `[^/]`,
/// `[^/]*`, `.*`, `(?:.*/)?` and anchors.
#[derive(Debug, Clone)]
pub struct SimpleRegex {
    nodes: Vec<Node>,
}

#[derive(Debug, Clone)]
enum Node {
    /// A literal character.
    Char(char),
    /// Any character.
    Any,
    /// Any character except `/`.
    NotSlash,
    /// Zero or more of any character.
    AnyStar,
    /// Zero or more characters that are not `/`.
    NotSlashStar,
    /// Zero or more directories, including none.
    OptionalDirs,
}

impl SimpleRegex {
    /// Parses the source string [`glob_to_regexp`] produced.
    pub fn new(source: &str) -> Option<Self> {
        let text = source.strip_prefix('^')?.strip_suffix('$')?;
        let chars: Vec<char> = text.chars().collect();
        let mut nodes = Vec::new();
        let mut index = 0usize;
        while index < chars.len() {
            match chars[index] {
                '\\' => {
                    index += 1;
                    nodes.push(Node::Char(*chars.get(index)?));
                }
                '.' => {
                    if chars.get(index + 1) == Some(&'*') {
                        nodes.push(Node::AnyStar);
                        index += 1;
                    } else {
                        nodes.push(Node::Any);
                    }
                }
                '[' => {
                    // The only classes produced are `[^/]` and `[^/]*`.
                    if chars.get(index + 1) == Some(&'^') && chars.get(index + 2) == Some(&'/') {
                        if chars.get(index + 3) == Some(&']') {
                            if chars.get(index + 4) == Some(&'*') {
                                nodes.push(Node::NotSlashStar);
                                index += 4;
                            } else {
                                nodes.push(Node::NotSlash);
                                index += 3;
                            }
                        } else {
                            return None;
                        }
                    } else {
                        return None;
                    }
                }
                '(' => {
                    let rest: String = chars[index..].iter().collect();
                    if rest.starts_with("(?:.*/)?") {
                        nodes.push(Node::OptionalDirs);
                        index += 8;
                        continue;
                    }
                    return None;
                }
                char => nodes.push(Node::Char(char)),
            }
            index += 1;
        }
        Some(Self { nodes })
    }

    /// True when the whole `text` matches.
    pub fn is_match(&self, text: &str) -> bool {
        let chars: Vec<char> = text.chars().collect();
        matches_from(&self.nodes, &chars, 0, 0)
    }
}

/// Backtracking matcher over a node list and an input.
fn matches_from(nodes: &[Node], input: &[char], node_index: usize, input_index: usize) -> bool {
    if node_index == nodes.len() {
        return input_index == input.len();
    }
    match &nodes[node_index] {
        Node::Char(expected) => {
            input.get(input_index) == Some(expected)
                && matches_from(nodes, input, node_index + 1, input_index + 1)
        }
        Node::Any => {
            input_index < input.len() && matches_from(nodes, input, node_index + 1, input_index + 1)
        }
        Node::NotSlash => {
            input.get(input_index).is_some_and(|char| *char != '/')
                && matches_from(nodes, input, node_index + 1, input_index + 1)
        }
        Node::AnyStar => {
            for next in input_index..=input.len() {
                if matches_from(nodes, input, node_index + 1, next) {
                    return true;
                }
            }
            false
        }
        Node::NotSlashStar => {
            let mut next = input_index;
            loop {
                if matches_from(nodes, input, node_index + 1, next) {
                    return true;
                }
                if input.get(next).is_some_and(|char| *char != '/') {
                    next += 1;
                } else {
                    return false;
                }
            }
        }
        Node::OptionalDirs => {
            // `(?:.*/)?`: try consuming nothing, then any prefix that ends in `/`.
            if matches_from(nodes, input, node_index + 1, input_index) {
                return true;
            }
            let mut next = input_index;
            while next < input.len() {
                if input[next] == '/' && matches_from(nodes, input, node_index + 1, next + 1) {
                    return true;
                }
                next += 1;
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn braces_expand() {
        assert_eq!(expand_braces("a/{b,c}.ts"), vec!["a/b.ts", "a/c.ts"]);
    }

    #[test]
    fn glob_star_does_not_cross_slash() {
        assert!(matches_glob("src/*.ts", "src/a.ts"));
        assert!(!matches_glob("src/*.ts", "src/nested/a.ts"));
        assert!(matches_glob("src/**/*.ts", "src/nested/a.ts"));
        assert!(matches_glob("src/**/*.ts", "src/a.ts"));
    }

    #[test]
    fn negated_patterns_subtract() {
        assert!(!matches_any(&["src/**/*.ts", "!src/skip/**"], "src/skip/a.ts"));
        assert!(matches_any(&["src/**/*.ts", "!src/skip/**"], "src/keep/a.ts"));
    }
}
